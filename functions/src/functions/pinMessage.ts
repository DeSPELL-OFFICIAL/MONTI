import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { organizersAbi, ticketAbi, type Hex } from '@monti/shared';
import { PERM_CREATE_EVENT, resolveCallerAccount } from '../lib/auth.js';
import { deployment, publicClient } from '../lib/chain.js';
import { EVENT_CHATS, db } from '../lib/db.js';

const DIGITS_RE = /^[0-9]+$/;
/** 문서 id 한 조각. 경로가 id 자리에 들어와 다른 컬렉션으로 새는 것을 막는다. */
const MSG_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * 공지를 고정할 수 있는 사람인지 **체인에서** 판정한다. 우리 DB 에는 역할이 없다(스펙 §9.4).
 * 공연 주최 조직의 **오너**이거나 `PERM_CREATE_EVENT` 비트를 가진 **관리자**면 통과다.
 * 인덱서는 이 판정에 쓰지 않는다 — 인덱싱이 밀리는 동안 권한이 뒤처지면 그대로 인가 구멍이 된다.
 */
async function requireOrganizerAdmin(eventId: bigint, caller: Hex): Promise<void> {
  const pc = publicClient();
  const contracts = deployment();

  const orgId = (await pc.readContract({
    address: contracts.ticket,
    abi: ticketAbi,
    functionName: 'eventOrg',
    args: [eventId],
  })) as bigint;

  // 두 질문을 각각 던진다. 오너에게 모든 비트를 주는 것은 컨트랙트의 약속이지만,
  // 그 약속 하나에 인가를 걸어 두면 컨트랙트가 바뀌는 날 오너가 자기 공연에서 잠긴다.
  const [owner, canCreateEvent] = await Promise.all([
    pc.readContract({
      address: contracts.organizers,
      abi: organizersAbi,
      functionName: 'ownerOf',
      args: [orgId],
    }) as Promise<Hex>,
    pc.readContract({
      address: contracts.organizers,
      abi: organizersAbi,
      functionName: 'hasPermission',
      args: [orgId, caller, PERM_CREATE_EVENT],
    }) as Promise<boolean>,
  ]);

  if (owner.toLowerCase() !== caller.toLowerCase() && !canCreateEvent) {
    throw new HttpsError('permission-denied', 'NOT_ORGANIZER_ADMIN');
  }
}

/**
 * 주최자 공지 고정.
 *
 * `pinned` 는 "주최자가 고정한 공지"라는 **권한 표현**이다. 권한은 체인에만 있고(스펙 §9.4),
 * 규칙은 그것을 알 수 없다. 그래서 규칙은 클라이언트의 `pinned` 를 통째로 막고
 * (생성은 `keys().hasOnly`, 수정은 전면 금지), 서버가 eth_call 로 확인하는 이 길 하나만 남는다.
 */
export const pinMessage = onCall(async (request): Promise<{ ok: true }> => {
  // 인증이 먼저다. 인가는 `eventOrg(eventId)` 로 조직을 찾아야 해서 값 검증 뒤에 온다.
  const caller = await resolveCallerAccount(request);
  const { eventId, msgId, pinned } = (request.data ?? {}) as {
    eventId?: unknown;
    msgId?: unknown;
    pinned?: unknown;
  };
  if (typeof eventId !== 'string' || !DIGITS_RE.test(eventId)) {
    throw new HttpsError('invalid-argument', 'BAD_EVENT_ID');
  }
  if (typeof msgId !== 'string' || !MSG_ID_RE.test(msgId)) {
    throw new HttpsError('invalid-argument', 'BAD_MSG_ID');
  }
  if (typeof pinned !== 'boolean') throw new HttpsError('invalid-argument', 'BAD_PINNED');

  await requireOrganizerAdmin(BigInt(eventId), caller);

  // 끝난 방은 읽기 전용이다. `closeEndedChats` 가 닫은 뒤에 고정을 바꾸면
  // 아무도 새 글을 쓸 수 없는 방의 맨 위가 조용히 달라진다.
  const chat = await db.collection(EVENT_CHATS).doc(eventId).get();
  if (chat.get('closed') === true) throw new HttpsError('failed-precondition', 'CHAT_CLOSED');

  const messageRef = db.doc(`${EVENT_CHATS}/${eventId}/messages/${msgId}`);
  const message = await messageRef.get();
  if (!message.exists) throw new HttpsError('not-found', 'MESSAGE_NOT_FOUND');

  // `update` 라서 `pinned` 한 칸만 바뀐다 — 본문도 신고 수도 서버가 덮어쓰지 않는다.
  await messageRef.update({ pinned });
  return { ok: true };
});
