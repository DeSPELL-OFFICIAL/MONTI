import { FieldValue } from 'firebase-admin/firestore';
import { error, info } from 'firebase-functions/logger';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import type { Hex, PersonStatus } from '@monti/shared';
import { DIDIT_API_KEY } from '../config.js';
import {
  DELETION_REQUESTS,
  DEVICES,
  PASSKEYS,
  PERSONS,
  PHONE_INDEX,
  USERS,
  assertStatusTransition,
  authAdmin,
  db,
} from '../lib/db.js';
import { deleteDiditSession } from '../lib/didit.js';

/** 유예 기간. 웹이 "7일 안에는 되돌릴 수 있습니다" 라고 적는 바로 그 숫자다. */
export const DELETION_GRACE_SECONDS = 7 * 24 * 60 * 60;
/**
 * 한 실행이 처리할 요청 수. 파기 한 건은 Didit 왕복 + 문서 여러 개라 느리다.
 * 넘친 요청은 다음 날 실행이 가져간다 — 기한이 지난 뒤에는 순서가 중요하지 않다.
 */
const MAX_PER_RUN = 50;
/** Didit 파기 시도 횟수(같은 실행 안에서). 그래도 안 되면 요청을 그대로 두고 다음 날 다시 한다. */
const DIDIT_ATTEMPTS = 2;

const SCHEDULE = '0 4 * * *';

type Doc = FirebaseFirestore.QueryDocumentSnapshot;

/**
 * 계정 파기 요청(개인정보 보호법 제36조 파기 요구).
 *
 * **체인은 지우지 않는다.** `Identity` 항목과 이미 발급된 티켓은 남는다 — `personId` 는 아무
 * 의미 없는 난수이고 계정 주소·기기 키에는 개인정보가 없다(스펙 §10.2). 웹 카피가 "전부
 * 지웁니다" 라고 말하지 않도록 그 사실을 응답(`onChainRetained`)에 실어 보낸다.
 *
 * 로그인은 **지금** 끊는다. 유예 기간은 마음을 바꿀 시간이지 계속 쓰라는 시간이 아니고,
 * 그 사이에 티켓을 더 받으면 파기 시점에 지울 것만 늘어난다. 되돌리려면 사람이 고객센터로
 * 온다(`disabled: false` + 요청 문서 삭제) — 그 경로를 여기에 만들지 않는 것이 요점이다.
 */
export const requestAccountDeletion = onCall(
  async (request): Promise<{ scheduledFor: number; onChainRetained: true }> => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError('unauthenticated', 'AUTH_REQUIRED');

    const personId = (await db.collection(USERS).doc(uid).get()).get('personId') as Hex | undefined;
    if (!personId) throw new HttpsError('failed-precondition', 'NO_PERSON');

    const requestRef = db.collection(DELETION_REQUESTS).doc(uid);
    // 요청을 **먼저** 남긴다. 순서가 뒤집히면 로그인만 끊기고 지워 줄 작업은 없는 계정이 생긴다.
    const scheduledFor = await db.runTransaction(async (tx) => {
      const current = await tx.get(requestRef);
      // 이미 접수돼 있으면 날짜를 미루지 않는다 — 반복 호출로 유예를 늘릴 수 없어야 한다.
      if (current.exists && current.get('status') === 'pending') {
        return current.get('scheduledFor') as number;
      }
      const next = Math.floor(Date.now() / 1000) + DELETION_GRACE_SECONDS;
      tx.set(requestRef, {
        personId,
        requestedAt: FieldValue.serverTimestamp(),
        scheduledFor: next,
        status: 'pending',
      });
      return next;
    });

    await authAdmin.updateUser(uid, { disabled: true });
    // `disabled` 는 새 로그인만 막는다. 이미 들고 있는 ID 토큰은 만료(1시간)까지 유효하므로
    // 갱신 토큰까지 무효화해야 진짜로 끊긴다.
    await authAdmin.revokeRefreshTokens(uid);

    return { scheduledFor, onChainRetained: true };
  },
);

/**
 * Didit 세션 파기. 실패하면 **던진다** — 부르는 쪽이 우리 DB 를 지우기 전에 멈춰야 한다.
 * 여기서 삼키면 Didit 에 얼굴 템플릿이 남은 채로 "파기 완료" 도장이 찍히고, 그때는
 * `sessionId` 를 들고 있던 사람 문서가 이미 없어 다시 시도할 방법도 사라진다.
 */
async function eraseDiditSession(sessionId: string): Promise<void> {
  for (let attempt = 1; attempt <= DIDIT_ATTEMPTS; attempt += 1) {
    try {
      await deleteDiditSession(sessionId, DIDIT_API_KEY.value());
      return;
    } catch (cause) {
      if (attempt === DIDIT_ATTEMPTS) throw cause;
      error('deletion.didit.retry', { attempt, reason: (cause as Error).message });
    }
  }
}

/**
 * 한 사람의 개인정보를 실제로 지운다. 순서에 뜻이 있다.
 *
 *  1. **Didit 이 먼저다.** 우리 문서를 먼저 지우면 `kyc.sessionId` 가 사라져 남의 서버에 남은
 *     얼굴 자료를 영영 못 지운다. 여기서 실패하면 아무것도 지우지 않은 채로 던지고, 요청은
 *     `pending` 그대로라 다음 날 실행이 같은 자리에서 다시 시도한다.
 *  2. 전화 색인 → 사용자 → 자격증명 → 기기. 색인을 먼저 지워야 같은 번호로 새로 가입할 수 있다.
 *  3. 사람 문서는 **남기고** 개인정보 필드만 턴다. 체인이 이 personId 를 가리키고 있다.
 *  4. Auth 사용자 삭제 → 요청에 완료 도장. 도장이 마지막이라 중간에 죽으면 통째로 다시 돈다
 *     (삭제는 전부 멱등이다).
 */
async function erase(request: Doc): Promise<void> {
  const uid = request.id;
  const personId = request.get('personId') as Hex;

  const personRef = db.collection(PERSONS).doc(personId);
  const person = await personRef.get();
  const sessionId = person.get('kyc.sessionId') as string | undefined;
  const account = person.get('account') as Hex | undefined;

  if (sessionId) await eraseDiditSession(sessionId);

  const user = await db.collection(USERS).doc(uid).get();
  const phoneHmac = user.get('phoneHmac') as string | undefined;
  if (phoneHmac) await db.collection(PHONE_INDEX).doc(phoneHmac).delete();
  if (user.exists) await user.ref.delete();

  const passkeys = await db.collection(PASSKEYS).where('personId', '==', personId).get();
  for (const passkey of passkeys.docs) await passkey.ref.delete();

  if (account) await db.collection(DEVICES).doc(account).delete();

  if (person.exists) {
    assertStatusTransition((person.get('status') as PersonStatus | undefined) ?? 'pending', 'deleted');
    await personRef.set(
      {
        status: 'deleted',
        // 개인정보 봉투는 전부 없앤다. 남는 것은 personId·계정 주소·체인 기록뿐이고,
        // 그 셋은 체인에도 같은 값이 있어 여기서 지운다고 사라지지 않는다.
        enc: FieldValue.delete(),
        photoEnc: FieldValue.delete(),
        kyc: FieldValue.delete(),
        deletedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  }

  await authAdmin.deleteUser(uid);
  await request.ref.update({ status: 'done', completedAt: FieldValue.serverTimestamp() });
  info('deletion.done', { uid });
}

/**
 * 매일 04:00(Asia/Seoul)에 도는 파기 작업. 유예가 끝난 요청만 집는다.
 *
 * 요청 하나가 터져도 나머지는 계속 간다. **스케줄러 밖으로는 절대 던지지 않는다** —
 * 여기서 던지면 Cloud Scheduler 가 같은 실행을 재시도해 이미 끝난 파기를 다시 훑는다.
 * 실패한 요청은 `pending` 그대로 남아 다음 날 실행이 가져간다.
 */
export const processDeletions = onSchedule(
  { schedule: SCHEDULE, timeZone: 'Asia/Seoul', timeoutSeconds: 540, secrets: [DIDIT_API_KEY] },
  async () => {
    const now = Math.floor(Date.now() / 1000);
    const due = await db
      .collection(DELETION_REQUESTS)
      .where('status', '==', 'pending')
      .where('scheduledFor', '<=', now)
      .limit(MAX_PER_RUN)
      .get();

    for (const request of due.docs) {
      try {
        await erase(request);
      } catch (cause) {
        error('deletion.failed', { uid: request.id, reason: (cause as Error).message });
      }
    }
  },
);
