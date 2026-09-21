import { HttpsError, onCall } from 'firebase-functions/v2/https';
import type { Hex, PersonStatus } from '@monti/shared';
import { ALLOWED_TRANSITIONS, PASSKEYS, PERSONS, USERS, db } from '../lib/db.js';

/**
 * 가입을 아직 시작하지 않은 uid 의 답. `persons` 표에 없는 유일한 값이라 따로 둔다 —
 * 오류가 아니다. 로그인은 했지만 `startSignup` 을 부른 적 없는 uid 는 정상적인 첫 화면이고,
 * 여기서 던지면 클라이언트가 "고칠 수 없는 실패"와 "처음부터 시작"을 구별하지 못한다.
 */
export type SignupStatus = PersonStatus | 'none';

export interface SignupStatusResult {
  status: SignupStatus;
  hasPasskey: boolean;
  hasAccount: boolean;
  kycLevel?: 0 | 1;
  personId?: Hex;
}

const NOT_STARTED = { status: 'none', hasPasskey: false, hasAccount: false } as const;

/**
 * 진행 단계는 `lib/db.ts` 의 전이표가 원본이다(`assertStatusTransition` 이 쓰는 그 표).
 * 표에 없는 값은 이 빌드가 모르는 상태다 — 가입 재개 화면에 넘길 수 있는 가장 안전한 답은
 * 처음 단계인 `pending` 이다. 필드가 없는 옛 문서도 같다(`startSignup` 이 쓰는 초기값).
 */
function narrowStatus(value: unknown): PersonStatus {
  return typeof value === 'string' && value in ALLOWED_TRANSITIONS ? (value as PersonStatus) : 'pending';
}

/** 본인인증 통과 여부의 원본은 `kycLevel`(0/1)이다. 0 도 1 도 아닌 값은 통과로 읽지 않는다. */
function narrowKycLevel(value: unknown): 0 | 1 {
  return value === 1 ? 1 : 0;
}

/**
 * 가입 진행 화면이 폴링하는 유일한 읽기 경로. 클라이언트는 `persons` 를 직접 읽지 못하므로
 * (보안 규칙의 포괄 거부) 이 함수가 창구다.
 *
 * 돌려주는 것은 **가입을 이어 붙이는 데 필요한 것뿐**이다 — 어느 단계까지 왔는지(`status`),
 * 패스키를 붙였는지, 계정 주소가 정해졌는지, 본인인증 레벨, 그리고 `registerPasskey` 에
 * 다시 실어 보낼 `personId`. 전화번호·이름·사진·KYC 세션 링크 같은 개인정보는 절대 나가지 않는다.
 *
 * 호출자는 **Firebase 전화 사용자**다. 가입 도중이라 아직 패스키 세션(`account` 클레임)이 없어서
 * `resolveCallerAccount` 를 쓸 수 없고, 읽는 문서는 언제나 그 uid 의 것뿐이다.
 */
export const getSignupStatus = onCall(async (request): Promise<SignupStatusResult> => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'AUTH_REQUIRED');

  const personId = (await db.collection(USERS).doc(uid).get()).get('personId') as Hex | undefined;
  if (!personId) return { ...NOT_STARTED };

  const person = await db.collection(PERSONS).doc(personId).get();
  if (!person.exists) return { ...NOT_STARTED };

  // 패스키는 사람 문서가 아니라 `passkeys` 에 있다. `account` 와 따로 읽는 이유는,
  // 둘이 어긋난 상태(계정 주소만 남고 자격증명이 지워진 기기 교체 도중)가 실제로 있기 때문이다.
  const passkeys = await db.collection(PASSKEYS).where('personId', '==', personId).limit(1).get();
  const account = person.get('account') as string | undefined;

  return {
    status: narrowStatus(person.get('status')),
    hasPasskey: !passkeys.empty,
    hasAccount: typeof account === 'string' && account.length > 0,
    kycLevel: narrowKycLevel(person.get('kycLevel')),
    personId,
  };
});
