import { FieldValue } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { organizersAbi, ticketAbi, type Hex } from '@monti/shared';
import { PERM_CREATE_EVENT, resolveCallerAccount } from '../lib/auth.js';
import { deployment, publicClient } from '../lib/chain.js';
import { EVENT_CHATS, db } from '../lib/db.js';

const DIGITS_RE = /^[0-9]+$/;
/** 문서 id 한 조각. 경로가 id 자리에 들어와 다른 컬렉션으로 새는 것을 막는다. */
const MSG_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * 공지 한 줄의 상한. 규칙이 클라이언트 글에 거는 것과 같은 500자다
 * (서버 쓰기는 규칙을 지나지 않으므로 여기서 직접 지킨다).
 */
export const MAX_ANNOUNCEMENT_CHARS = 500;

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

/** 새 공지의 본문. 앞뒤 공백을 떼고 나서 재는 것이 사람이 보는 길이다. */
function requireText(value: unknown): string {
  if (typeof value !== 'string') throw new HttpsError('invalid-argument', 'BAD_TEXT');
  const text = value.trim();
  if (text.length === 0 || text.length > MAX_ANNOUNCEMENT_CHARS) {
    throw new HttpsError('invalid-argument', 'BAD_TEXT');
  }
  return text;
}

/**
 * 주최자 공지.
 *
 * `pinned` 는 "주최자가 고정한 공지"라는 **권한 표현**이다. 권한은 체인에만 있고(스펙 §9.4),
 * 규칙은 그것을 알 수 없다. 그래서 규칙은 클라이언트의 `pinned` 를 통째로 막고
 * (생성은 `keys().hasOnly`, 수정은 전면 금지), 서버가 eth_call 로 확인하는 이 길 하나만 남는다.
 *
 * 두 갈래가 있고, 둘 중 **정확히 하나**를 부른다.
 *  - `messageId` — 이미 방에 있는 글의 고정을 켜고 끈다(`pinned` 필수).
 *  - `text` — 서버가 공지를 **직접 써서** 고정한다. 주최자는 자기 공연 표를 사지 않으므로
 *    `joinEventChat`(표 보유가 조건)을 통과할 수 없다. 그 길만 남겨 두면 주최자는 자기 방에
 *    공지 한 줄을 남기지 못한다. 여기서의 인가는 멤버십이 아니라 위의 체인 읽기다.
 */
export const pinMessage = onCall(
  async (request): Promise<{ ok: true; messageId: string }> => {
    // 인증이 먼저다. 인가는 `eventOrg(eventId)` 로 조직을 찾아야 해서 값 검증 뒤에 온다.
    const caller = await resolveCallerAccount(request);
    const uid = request.auth?.uid as string;
    const { eventId, messageId, text, pinned } = (request.data ?? {}) as {
      eventId?: unknown;
      messageId?: unknown;
      text?: unknown;
      pinned?: unknown;
    };
    if (typeof eventId !== 'string' || !DIGITS_RE.test(eventId)) {
      throw new HttpsError('invalid-argument', 'BAD_EVENT_ID');
    }

    // 정확히 하나. 둘 다 오면 무엇을 고정하라는 것인지 서버가 고를 수 없고,
    // 둘 다 없으면 고정할 대상이 없다 — 어느 쪽도 조용히 넘기지 않는다.
    const authoring = text !== undefined;
    const pinning = messageId !== undefined;
    if (authoring === pinning) throw new HttpsError('invalid-argument', 'BAD_PIN_TARGET');

    // 값 검증이 체인 읽기보다 먼저다 — 모양이 틀린 요청에 eth_call 을 쓰지 않는다.
    if (authoring && pinned !== undefined) {
      // 새 공지는 정의상 고정된 글이다. `pinned` 를 함께 받으면 무시하지 말고 거절한다.
      throw new HttpsError('invalid-argument', 'BAD_PINNED');
    }
    const body = authoring ? requireText(text) : '';
    if (pinning) {
      if (typeof messageId !== 'string' || !MSG_ID_RE.test(messageId)) {
        throw new HttpsError('invalid-argument', 'BAD_MSG_ID');
      }
      if (typeof pinned !== 'boolean') throw new HttpsError('invalid-argument', 'BAD_PINNED');
    }

    await requireOrganizerAdmin(BigInt(eventId), caller);

    // 끝난 방은 읽기 전용이다. `closeEndedChats` 가 닫은 뒤에 고정을 바꾸거나 공지를 더하면
    // 아무도 새 글을 쓸 수 없는 방의 맨 위가 조용히 달라진다.
    const chat = await db.collection(EVENT_CHATS).doc(eventId).get();
    if (chat.get('closed') === true) throw new HttpsError('failed-precondition', 'CHAT_CLOSED');

    if (authoring) {
      const ref = db.collection(`${EVENT_CHATS}/${eventId}/messages`).doc();
      // 규칙이 클라이언트에게 허락한 네 칸(`uid`·`text`·`createdAt`·`reported`)에
      // 서버만 쓸 수 있는 두 칸을 더한다. `senderUid` 는 "서버가 이 주최자를 대신해 썼다"는
      // 표시다 — 클라이언트는 `hasOnly` 때문에 이 칸을 영원히 쓸 수 없다.
      await ref.set({
        uid,
        senderUid: uid,
        text: body,
        createdAt: FieldValue.serverTimestamp(),
        reported: 0,
        pinned: true,
      });
      return { ok: true, messageId: ref.id };
    }

    // 위의 `pinning` 검증을 지난 값이다 — 한 조각짜리 id 와 boolean.
    const target = messageId as string;
    const messageRef = db.doc(`${EVENT_CHATS}/${eventId}/messages/${target}`);
    const message = await messageRef.get();
    if (!message.exists) throw new HttpsError('not-found', 'MESSAGE_NOT_FOUND');

    // `update` 라서 `pinned` 한 칸만 바뀐다 — 본문도 신고 수도 서버가 덮어쓰지 않는다.
    await messageRef.update({ pinned: pinned as boolean });
    return { ok: true, messageId: target };
  },
);
