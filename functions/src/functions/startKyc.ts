import { HttpsError, onCall } from 'firebase-functions/v2/https';
import type { Hex, PersonStatus } from '@monti/shared';
import { DIDIT_API_KEY, DIDIT_WORKFLOW_ID } from '../config.js';
import { PERSONS, USERS, db } from '../lib/db.js';
import { assertCallbackUrl, defaultCallbackUrl, ensureKycSession } from '../lib/kycSession.js';
import type { KycSession } from '../lib/kycSession.js';

/**
 * 지금 본인인증을 시작할 수 있는 상태.
 *  - `active`   계정이 체인에 등록된 평상시 상태.
 *  - `rejected` 지난 시도가 거절됐다. **다시 해 볼 수 있어야 한다** — 한 번 거절이 영구
 *               차단이 되면 사진이 흔들렸던 사람이 영영 티켓을 못 받는다.
 * 나머지는 여기서 세션을 열 이유가 없다: `pending` 은 계정이 아직 체인에 없고,
 * `kyc_ok` 는 승인이 체인 확정을 기다리는 중이며(또 열면 돈만 나간다), `rotated` 는 버려진 계정,
 * `deleted` 는 파기 요청이 끝난 계정이다.
 */
const CAN_START: readonly PersonStatus[] = ['active', 'rejected'];

/**
 * 본인인증은 **가입이 아니라 필요한 공연을 만났을 때** 시작한다(창업자 델타).
 * 관객이 `requireKyc === true` 인 공연의 티켓을 받으려 할 때 03이 이 함수를 부르고,
 * 돌아온 `kycUrl` 을 시스템 브라우저로 연다. 복귀는 `callbackUrl` 딥링크로 한다.
 *
 * 이 함수가 하는 일은 세션을 여는 것뿐이다. 레벨을 올리는 것도, 체인에 쓰는 것도
 * `diditWebhook` 이고, 03은 `getSignupStatus` 로 `kycLevel` 을 폴링한다.
 */
export const startKyc = onCall(
  { secrets: [DIDIT_API_KEY, DIDIT_WORKFLOW_ID] },
  async (request): Promise<KycSession> => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError('unauthenticated', 'AUTH_REQUIRED');

    const { callbackUrl } = (request.data ?? {}) as { callbackUrl?: unknown };
    const callback =
      callbackUrl === undefined ? defaultCallbackUrl() : assertCallbackUrl(callbackUrl);

    const personId = (await db.collection(USERS).doc(uid).get()).get('personId') as Hex | undefined;
    if (!personId) throw new HttpsError('not-found', 'NO_SIGNUP');

    const person = await db.collection(PERSONS).doc(personId).get();
    if (!person.exists) throw new HttpsError('not-found', 'NO_SIGNUP');

    // 통과 여부의 원본은 언제나 `kycLevel` 이다. 이미 1이면 열 세션이 없다.
    if ((person.get('kycLevel') as number | undefined) === 1) {
      throw new HttpsError('already-exists', 'ALREADY_VERIFIED');
    }
    if (!CAN_START.includes(person.get('status') as PersonStatus)) {
      throw new HttpsError('failed-precondition', 'NOT_ACTIVE');
    }

    return ensureKycSession(personId, callback);
  },
);
