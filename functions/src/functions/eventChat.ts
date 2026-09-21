import { FieldValue } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { CHAT_CLOSE_SCHEDULE, EVENT_STATUS_BY_CODE, ticketAbi } from '@monti/shared';
import { resolveCallerAccount } from '../lib/auth.js';
import { deployment, publicClient } from '../lib/chain.js';
import { EVENT_CHATS, db } from '../lib/db.js';

/**
 * 채팅 입장권은 티켓이다. 세 조건 모두 체인에서 직접 읽는다 — 인덱서는 인가에 쓰지 않는다.
 *
 * 저장하는 것은 `account` 와 입장 시각뿐이다. 표시 이름은 클라이언트가
 * `users/{uid}.nickname` 과 인덱서에서 가져온다. 전화번호는 여기 어디에도 없다.
 */
export const joinEventChat = onCall(async (request): Promise<{ ok: true }> => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'AUTH_REQUIRED');
  const { eventId } = (request.data ?? {}) as { eventId?: string };
  if (!eventId || !/^[0-9]+$/.test(eventId)) throw new HttpsError('invalid-argument', 'BAD_EVENT_ID');

  const account = await resolveCallerAccount(request);
  const contracts = deployment();
  const pc = publicClient();

  const [balance, statusCode, meta] = await Promise.all([
    pc.readContract({
      address: contracts.ticket,
      abi: ticketAbi,
      functionName: 'balanceOfEvent',
      args: [account, BigInt(eventId)],
    }),
    pc.readContract({
      address: contracts.ticket,
      abi: ticketAbi,
      functionName: 'eventStatus',
      args: [BigInt(eventId)],
    }),
    pc.readContract({
      address: contracts.ticket,
      abi: ticketAbi,
      functionName: 'eventMeta',
      args: [BigInt(eventId)],
    }),
  ]);

  if ((balance as bigint) === 0n) throw new HttpsError('permission-denied', 'NO_TICKET_FOR_EVENT');
  if (EVENT_STATUS_BY_CODE[Number(statusCode)] !== 'Published') {
    throw new HttpsError('failed-precondition', 'EVENT_NOT_PUBLISHED');
  }
  const endsAt = Number((meta as { endsAt: bigint }).endsAt);
  if (endsAt <= Math.floor(Date.now() / 1000)) throw new HttpsError('failed-precondition', 'EVENT_ENDED');

  // `closeEndedChats` 가 닫은 방은 다시 열지 않는다. 이 확인이 없으면 아래의
  // `closed: false` 병합이 닫힌 방을 조용히 되살린다(규칙은 닫힌 방의 쓰기를 막는다).
  const chatRef = db.collection(EVENT_CHATS).doc(eventId);
  const chat = await chatRef.get();
  if (chat.get('closed') === true) throw new HttpsError('failed-precondition', 'CHAT_CLOSED');

  await chatRef.set(
    { closed: false, endsAt, orgId: String((meta as { orgId: bigint }).orgId) },
    { merge: true },
  );
  await db.doc(`${EVENT_CHATS}/${eventId}/members/${uid}`).set({
    account,
    joinedAt: FieldValue.serverTimestamp(),
  });

  return { ok: true };
});

/**
 * 신고는 숫자 하나만 올린다. 신고자·사유 같은 개인정보는 남기지 않는다.
 * 규칙이 `messages` 의 update 를 전부 막아 두므로 이 카운터는 서버만 올릴 수 있다.
 */
export const reportMessage = onCall(async (request): Promise<{ reported: number }> => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'AUTH_REQUIRED');
  const { eventId, msgId } = (request.data ?? {}) as { eventId?: string; msgId?: string };
  if (!eventId || !msgId) throw new HttpsError('invalid-argument', 'BAD_ARGS');

  const member = await db.doc(`${EVENT_CHATS}/${eventId}/members/${uid}`).get();
  if (!member.exists) throw new HttpsError('permission-denied', 'NOT_A_MEMBER');

  const messageRef = db.doc(`${EVENT_CHATS}/${eventId}/messages/${msgId}`);
  return db.runTransaction(async (tx) => {
    const message = await tx.get(messageRef);
    if (!message.exists) throw new HttpsError('not-found', 'MESSAGE_NOT_FOUND');
    const reported = ((message.get('reported') as number) ?? 0) + 1;
    tx.update(messageRef, { reported });
    return { reported };
  });
});

/**
 * 공연이 끝나면 채팅도 닫는다. 규칙의 `chatOpen()` 이 `closed` 를 보고 쓰기를 막는다.
 * 체인에 쓰는 것은 없다 — `endsAt` 은 입장할 때 체인에서 읽어 둔 값이다.
 */
export const closeEndedChats = onSchedule(
  { schedule: CHAT_CLOSE_SCHEDULE, timeZone: 'Asia/Seoul' },
  async () => {
    const now = Math.floor(Date.now() / 1000);
    const snapshot = await db
      .collection(EVENT_CHATS)
      .where('closed', '==', false)
      .where('endsAt', '<', now)
      .limit(200)
      .get();
    await Promise.all(snapshot.docs.map((doc) => doc.ref.update({ closed: true })));
  },
);
