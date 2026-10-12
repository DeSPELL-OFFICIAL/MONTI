import { HttpsError, onCall } from 'firebase-functions/v2/https';
import type { Hex, PersonStatus } from '@monti/shared';
import { ALLOWED_TRANSITIONS, PASSKEYS, PERSONS, USERS, db } from '../lib/db.js';
import type { KycDeclineReason } from '../lib/didit.js';
import { authMode, type AuthMode } from '../config.js';

/** 닫힌 네 값. `lib/didit.ts` 의 `declineReason` 이 쓴 것만 여기로 나간다. */
const DECLINE_REASONS: readonly string[] = [
  'declined',
  'duplicate_face',
  'face_search_missing',
  'face_search_not_clear',
];

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
  /**
   * 지난 본인인증 시도가 왜 막혔는지. 통과했거나(`kycLevel === 1`) 시도한 적이 없으면 없다.
   * 관객 화면은 이 코드마다 다른 안내를 그린다 — 그래서 `persons` 를 직접 못 읽는 웹에게
   * 이 창구로 내보낸다. 개인정보가 아니다(닫힌 네 값 중 하나).
   */
  kycReason?: KycDeclineReason;
  /**
   * 티켓에 찍히는 표시 이름(`users/{uid}.displayName`). 없으면 **칸 자체가 없다** —
   * `이름 없음` 같은 자리표시자를 만들지 않는다(티켓에는 아무것도 그리지 않는다).
   *
   * 여기에 실어 보내는 이유는 하나다: 가입 직후 화면이 이미 이 호출을 폴링하고 있어서,
   * 이름 하나 때문에 `users/{uid}` 를 한 번 더 읽지 않게 하려는 것이다. 개인정보가 아니다 —
   * 사용자가 직접 적어 티켓에 인쇄되는 값이다(체인 닉네임과는 다른 칸이다).
   */
  displayName?: string;
  personId?: Hex;
  /**
   * 서버의 가입 방식(`AUTH_MODE`). 웹은 이 값으로 전화번호·패스키 단계를 그릴지 고른다 —
   * `open` 이면 익명 로그인 → `startSignup` → `registerIdentity` 로 끝난다.
   */
  authMode: AuthMode;
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
 * 표시 이름의 자는 `firestore.rules` 의 `users` 검사와 같다: 앞뒤 공백을 지우고 1~24 자.
 * 규칙이 이미 그 자로 막지만, 규칙보다 먼저 쓰인 문서나 서버가 넣은 값이 섞일 수 있어
 * 나가는 쪽에서도 한 번 더 좁힌다 — 웹은 이 값을 그대로 티켓에 그린다.
 */
function narrowDisplayName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length >= 1 && trimmed.length <= 24 ? trimmed : undefined;
}

/** 표에 없는 값은 내보내지 않는다 — 웹이 모르는 코드를 받으면 그릴 화면이 없다. */
function narrowKycReason(value: unknown): KycDeclineReason | undefined {
  return typeof value === 'string' && DECLINE_REASONS.includes(value)
    ? (value as KycDeclineReason)
    : undefined;
}

/**
 * 가입 진행 화면이 폴링하는 유일한 읽기 경로. 클라이언트는 `persons` 를 직접 읽지 못하므로
 * (보안 규칙의 포괄 거부) 이 함수가 창구다.
 *
 * 돌려주는 것은 **가입을 이어 붙이는 데 필요한 것뿐**이다 — 어느 단계까지 왔는지(`status`),
 * 패스키를 붙였는지, 계정 주소가 정해졌는지, 본인인증 레벨, 그리고 `registerPasskey` 에
 * 다시 실어 보낼 `personId`. 전화번호·이름·사진·KYC 세션 링크 같은 개인정보는 절대 나가지 않는다.
 *
 * 호출자는 **Firebase 전화 사용자**(open 모드에서는 익명 사용자도)다. 가입 도중이라 아직 패스키 세션(`account` 클레임)이 없어서
 * `resolveCallerAccount` 를 쓸 수 없고, 읽는 문서는 언제나 그 uid 의 것뿐이다.
 */
export const getSignupStatus = onCall(async (request): Promise<SignupStatusResult> => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'AUTH_REQUIRED');

  // 사용자 문서는 한 번만 읽는다 — `personId` 와 표시 이름이 같은 문서에 있다.
  const user = await db.collection(USERS).doc(uid).get();
  const personId = user.get('personId') as Hex | undefined;
  const displayName = narrowDisplayName(user.get('displayName'));
  const named = displayName ? { displayName } : {};

  if (!personId) return { ...NOT_STARTED, ...named, authMode: authMode() };

  const person = await db.collection(PERSONS).doc(personId).get();
  if (!person.exists) return { ...NOT_STARTED, ...named, authMode: authMode() };

  // 패스키는 사람 문서가 아니라 `passkeys` 에 있다. `account` 와 따로 읽는 이유는,
  // 둘이 어긋난 상태(계정 주소만 남고 자격증명이 지워진 기기 교체 도중)가 실제로 있기 때문이다.
  const passkeys = await db.collection(PASSKEYS).where('personId', '==', personId).limit(1).get();
  const account = person.get('account') as string | undefined;
  const kycLevel = narrowKycLevel(person.get('kycLevel'));
  const kycReason = kycLevel === 1 ? undefined : narrowKycReason(person.get('kyc.lastReason'));

  return {
    status: narrowStatus(person.get('status')),
    hasPasskey: !passkeys.empty,
    hasAccount: typeof account === 'string' && account.length > 0,
    kycLevel,
    ...(kycReason ? { kycReason } : {}),
    ...named,
    personId,
    authMode: authMode(),
  };
});
