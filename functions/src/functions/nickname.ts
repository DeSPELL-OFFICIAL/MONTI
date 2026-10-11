import { FieldValue } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { resolveCallerAccount, resolveCallerPersonId } from '../lib/auth.js';
import { NICKNAMES, USERS, db } from '../lib/db.js';
import { nicknamesByAccount, parseNickname } from '../lib/nicknames.js';

/**
 * 닉네임(v2 설계 §7, P5). v1 은 `Identity.setNickname` 트랜잭션 1건이었지만 체인이 한 일은
 * "유일성 확인"뿐이었다 — Firestore 트랜잭션으로 충분하고, 회전 때 계정 이동도 personId 로 풀린다.
 * 그래서 v2 의 닉네임 tx 는 0건이다.
 */

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
/** `resolveNicknames` 한 번에 묻는 계정 상한(채팅 한 화면·신청 목록 한 쪽). */
const RESOLVE_MAX = 100;

export const setNickname = onCall(async (request): Promise<{ nickname: string }> => {
  if (!request.auth?.uid) throw new HttpsError('unauthenticated', 'AUTH_REQUIRED');
  const parsed = parseNickname((request.data as { nickname?: unknown } | undefined)?.nickname);
  if (!parsed) throw new HttpsError('invalid-argument', 'NICKNAME_INVALID', { code: 'NICKNAME_INVALID' });
  // personId 가 먼저다 — 사람이 없는 세션은 NO_PERSON 으로 분명히 거절한다.
  const personId = await resolveCallerPersonId(request);
  const account = (await resolveCallerAccount(request)).toLowerCase();
  const uid = request.auth.uid;

  const target = db.collection(NICKNAMES).doc(parsed.key);
  await db.runTransaction(async (tx) => {
    // 트랜잭션은 읽기가 먼저다: 대상 이름 + 내가 지금 가진 이름(들).
    const [current, mine] = await Promise.all([
      tx.get(target),
      tx.get(db.collection(NICKNAMES).where('personId', '==', personId)),
    ]);
    const holder = current.exists ? (current.get('personId') as string | undefined) : undefined;
    if (holder !== undefined && holder !== personId) {
      throw new HttpsError('already-exists', 'NICKNAME_TAKEN', { code: 'NICKNAME_TAKEN' });
    }
    // 이전 이름은 **내 것일 때만** 놓아준다 — 질의가 personId 로 걸렀으므로 남의 문서는 없다.
    for (const doc of mine.docs) {
      if (doc.id !== parsed.key) tx.delete(db.collection(NICKNAMES).doc(doc.id));
    }
    tx.set(target, { personId, account, display: parsed.display, updatedAt: FieldValue.serverTimestamp() });
    // 채팅 표시용 거울. 규칙상 클라이언트도 쓸 수 있는 칸이라(전환 기간, 설계 §7) 원본은 위 문서다.
    tx.set(db.collection(USERS).doc(uid), { nickname: parsed.display }, { merge: true });
  });
  return { nickname: parsed.display };
});

export const resolveNicknames = onCall(async (request): Promise<{ names: Record<string, string> }> => {
  if (!request.auth?.uid) throw new HttpsError('unauthenticated', 'AUTH_REQUIRED');
  const accounts = (request.data as { accounts?: unknown } | undefined)?.accounts;
  if (
    !Array.isArray(accounts) ||
    accounts.length > RESOLVE_MAX ||
    !accounts.every((account) => typeof account === 'string' && ADDRESS_RE.test(account))
  ) {
    throw new HttpsError('invalid-argument', 'BAD_ACCOUNTS');
  }
  const names = await nicknamesByAccount(accounts as string[]);
  return { names: Object.fromEntries(names) };
});
