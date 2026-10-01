import type { Timestamp } from 'firebase-admin/firestore';
import type { Hex } from '@monti/shared';

/**
 * 릴레이/대기 테이블의 **문서 모양 한 벌**. 서버(콜러블 C2·이 대사 함수)와 웹이 같은 정의를
 * 나눠 쓰라고 여기 둔다. 타입 import 만 쓰므로(런타임 값은 문자열 상수·순수 함수뿐) 웹이
 * 이 파일을 가져와도 firebase-admin 이 딸려오지 않는다.
 *
 * 컬렉션 이름 상수는 여기서 정의하고 `db.ts` 가 다시 내보낸다 — 정적 일관성 스캔
 * (`consistency.test.ts`)이 허용 목록을 `db.ts` 의 문자열 상수로 강제하기 때문이다.
 */

/** `relays/{relayId}` — 릴레이 한 건의 상태 문서. */
export const RELAYS = 'relays';
/** `admissions/{eventId}` — 게이트 대기 테이블의 루트. */
export const ADMISSIONS = 'admissions';
/** `admissions/{eventId}/tokens/{tokenId}` — 토큰별 대기 상태(이 이름에 TTL 을 건다). */
export const ADMISSION_TOKENS = 'tokens';

export type RelayKind = 'claim' | 'request' | 'checkIn' | 'checkInLate' | 'setPolicy';
export type RelayStatus = 'pending' | 'sent' | 'confirmed' | 'failed';

/** 결정적 거절/실패 사유. 코드는 기존 deny/limit 이름을, message 는 사람이 읽을 한 줄. */
export interface RelayError {
  code: string;
  message: string;
}

/**
 * `relays/{relayId}` — 릴레이 한 건의 수명. **relayId 는 멱등키에서 결정적으로 만든다**:
 *  - claim/request : `${account}:${eventId}:${nonce}`  (`claimRelayId`)
 *  - checkIn/checkInLate : `${eventId}:${tokenId}`      (`checkInRelayId`)
 * 같은 제출이 두 번 와도 같은 문서에 매핑돼 중복 전송을 막는다(멱등).
 *
 * 타임스탬프 칸의 타입은 **읽기 모양**(Timestamp)이다. 서버가 쓸 때는
 * `FieldValue.serverTimestamp()` 를 넣고, 읽을 때 Timestamp 로 돌아온다.
 */
export interface RelayDoc {
  kind: RelayKind;
  /** 제출자(=소유자). firestore.rules 가 이 값으로 읽기 권한을 판정한다. */
  personId: Hex;
  /** 제출자의 스마트 계정(EIP-55 체크섬). */
  account: Hex;
  /** 공연 id(십진 문자열). */
  eventId: string;
  /** 체크인에만 있다(십진 문자열). */
  tokenId?: string;
  /** relayId 를 만든 원본 멱등키. */
  idemKey: string;
  status: RelayStatus;
  txHash?: Hex;
  nonce?: number;
  /** Firestore 는 bigint 를 담지 못한다 — `Number(gasLimit)` 로 저장. */
  gasLimit?: number;
  error?: RelayError;
  createdAt: Timestamp;
  sentAt?: Timestamp;
  confirmedAt?: Timestamp;
  failedAt?: Timestamp;
  /** TTL(7일). `firestore.indexes.json` 의 fieldOverrides 가 지운다. */
  expireAt: Timestamp;
}

/**
 * `admissions/{eventId}/tokens/{tokenId}` — ~1초 창을 덮는 대기 테이블(설계 §6).
 * relayCheckIn 이 브로드캐스트 순간 `passing` 을 쓰고, 체인 확정 때 이 대사 함수가
 * `confirmed`/`failed` 로 바꾼다. 게이트 앱이 교차 게이트 이중입장 확인에 읽는다.
 * **보안 경계가 아니라 지연 최적화다** — 최종 권위는 언제나 체인의 1회 입장이다.
 */
export interface AdmissionDoc {
  status: 'passing' | 'confirmed' | 'failed';
  gateId: string;
  relayId: string;
  passedAt: Timestamp;
  confirmedAt?: Timestamp;
  usedAt?: Timestamp;
  /** TTL(3일). */
  expireAt: Timestamp;
}

/** claim/request 의 relayId. 계정 하나 + 공연 + nonce 가 곧 멱등키다. */
export function claimRelayId(account: Hex, eventId: string | bigint, nonce: number | bigint): string {
  return `${account}:${eventId}:${nonce}`;
}

/** checkIn 의 relayId. tokenId 하나에 입장 한 번(1회 입장 불변식과 같은 키). */
export function checkInRelayId(eventId: string | bigint, tokenId: string | bigint): string {
  return `${eventId}:${tokenId}`;
}

/** setPolicy 의 relayId. 주최자 + policyNonce 가 곧 멱등키다(nonce 는 설정 1회마다 체인에서 증가). */
export function setPolicyRelayId(organizer: Hex, nonce: number | bigint): string {
  return `setPolicy:${organizer}:${nonce}`;
}

/** 이 릴레이가 게이트 입장인가. 확정/실패 시 대기 테이블도 함께 옮겨야 하는지 가른다. */
export function isCheckInKind(kind: RelayKind): boolean {
  return kind === 'checkIn' || kind === 'checkInLate';
}
