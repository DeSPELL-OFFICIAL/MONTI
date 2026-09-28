import { FieldValue } from 'firebase-admin/firestore';
import { error, info } from 'firebase-functions/logger';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import type { Hex } from '@monti/shared';
import { DIDIT_API_KEY } from '../config.js';
import { DELETION_REQUESTS, USERS, authAdmin, db } from '../lib/db.js';
import { DiditErasureFailed, erasePerson } from '../lib/erasePerson.js';

/** 유예 기간. 웹이 "7일 안에는 되돌릴 수 있습니다" 라고 적는 바로 그 숫자다. */
export const DELETION_GRACE_SECONDS = 7 * 24 * 60 * 60;
/**
 * 한 실행이 처리할 요청 수. 파기 한 건은 Didit 왕복 + 문서 여러 개라 느리다.
 * 넘친 요청은 다음 날 실행이 가져간다 — 기한이 지난 뒤에는 순서가 중요하지 않다.
 */
const MAX_PER_RUN = 50;
/**
 * 며칠째 Didit 파기가 막혔을 때 사람을 부르는 선. 하루 한 번 도는 일정이라 연속 실행이 곧
 * 연속 일수다. 사흘이면 일시적인 장애가 아니라 설정이 틀렸다는 뜻이고(대개 `DIDIT_API_KEY`),
 * 그동안 이 계정의 파기는 법정 기한을 넘긴 채 멈춰 있다 — 운영 잡음이 아니라 법적 노출이다.
 */
const DIDIT_STALL_RUNS = 3;

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

    try {
      await authAdmin.updateUser(uid, { disabled: true });
      // `disabled` 는 새 로그인만 막는다. 이미 들고 있는 ID 토큰은 만료(1시간)까지 유효하므로
      // 갱신 토큰까지 무효화해야 진짜로 끊긴다.
      await authAdmin.revokeRefreshTokens(uid);
    } catch (cause) {
      // 요청은 이미 커밋됐다. 여기서 던지면 사람은 불투명한 `internal` 을 보고 "실패했구나"
      // 하고 다시 누르는데, 파기는 이미 예약돼 있다. 약속한 것(7일 뒤 파기)은 지켜지므로
      // 성공으로 답하고 로그만 남긴다 — 로그인 차단은 매일 도는 작업이 다시 시도한다.
      error('deletion.disable.failed', { uid, reason: (cause as Error).message });
    }

    return { scheduledFor, onChainRetained: true };
  },
);

/**
 * 요청 하나를 끝까지 지운다. 지우는 일 자체는 `lib/erasePerson.ts` 한 곳에 있다 —
 * 운영 스크립트(`scripts/reset-persons.ts`)도 같은 함수를 부르므로 여기에 사본이 없어야 한다.
 *
 * 완료 도장이 마지막이라 중간에 죽으면 통째로 다시 돈다(삭제는 전부 멱등이다).
 */
async function erase(request: Doc): Promise<void> {
  const uid = request.id;

  await erasePerson({
    uid,
    personId: request.get('personId') as Hex,
    diditApiKey: DIDIT_API_KEY.value(),
    // Didit 을 넘겼다. 며칠째 막혀 있었다면 그 기록은 여기서 지운다 — 다음에 또 막히면 그때부터
    // 다시 센다. 남겨 두면 지난 장애의 횟수가 새 장애에 더해져 경보가 하루 일찍 운다.
    afterDidit: async () => {
      if (request.get('diditFailures') !== undefined) {
        await request.ref.update({ diditFailures: FieldValue.delete() });
      }
    },
  });

  await request.ref.update({ status: 'done', completedAt: FieldValue.serverTimestamp() });
  info('deletion.done', { uid });
}

/**
 * Didit 파기가 며칠째 막혀 있는지 센다. **절대 던지지 않는다** — 세다가 터져 스케줄러 밖으로
 * 나가면 이미 끝난 파기까지 다시 훑는다. 선을 넘긴 뒤에는 매번 운다: 키가 틀렸다면 사람이
 * 손대기 전까지 낫지 않고, 한 번 울고 조용해지면 아무도 보지 않는다.
 */
async function countDiditFailure(request: Doc): Promise<void> {
  try {
    const runs = ((request.get('diditFailures') as number | undefined) ?? 0) + 1;
    await request.ref.update({ diditFailures: runs });
    if (runs >= DIDIT_STALL_RUNS) error('deletion.didit.stalled', { uid: request.id, runs });
  } catch (cause) {
    error('deletion.didit.count', { uid: request.id, reason: (cause as Error).message });
  }
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
        if (cause instanceof DiditErasureFailed) await countDiditFailure(request);
      }
    }
  },
);
