export type Hex = `0x${string}`;

/** Firestore `persons/{personId}.status`. 전이는 pending → kyc_ok → active 만 허용된다. */
export type PersonStatus = 'pending' | 'kyc_ok' | 'active' | 'rotated' | 'rejected';

export interface GateCodeWire {
  v: 1;
  gateId: string;
  eventId: string;
  issuedAt: number;
  nonce: Hex;
  kx: Hex;
  ky: Hex;
  /** r||s 64B by gate device key over sha256(abi.encode(gateId,eventId,issuedAt,nonce)) */
  sig: Hex;
}

/**
 * 이 빌드가 말하는 게이트 응답 형식. 기기에 나간 v1 은 없으므로 하위 호환 경로도 없다 —
 * v1 페이로드는 {@link GateResponseVersionError} 로 끊는다.
 */
export const GATE_RESPONSE_VERSION = 2;

/**
 * 관객 기기가 게이트에 돌려주는 답. **키 순서가 계약이다** — 스태프 앱(04)이 같은 바이트열을
 * 재현한다. 다만 그 순서를 실제로 정하는 곳은 이 선언이 아니라 `encodeGateResponse` 안의
 * 표준 순서 literal 이다(이 선언과 같은 순서로 적혀 있다). 순서를 바꾸려면 그 literal 과
 * 고정 벡터를 함께 바꿔야 한다.
 */
export interface GateResponseWire {
  v: typeof GATE_RESPONSE_VERSION;
  tokenId: string;
  /**
   * 관객이 서명한 **그 게이트 코드의 nonce**. 스태프 단말기가 자기가 방금 발급한 코드와
   * 돌아온 답을 맞춰보는 유일한 열쇠다 — 한 화면에 여러 관객이 겹칠 때 어느 답이 어느
   * 코드의 것인지 알아야 한다.
   */
  nonce: Hex;
  /** r||s 64B over sha256(abi.encode(tokenId,gateId,eventId,nonce,issuedAt)) */
  deviceSig: Hex;
}

export interface SnapshotTicket {
  tokenId: string;
  account: Hex;
  deviceX: Hex;
  deviceY: Hex;
  /** requireKyc 가 false 인 공연에서는 빈 문자열 — 스태프 화면이 아바타를 그린다 */
  photoJpegB64: string;
  /** 닉네임. 없으면 빈 문자열. 실명은 절대 들어가지 않는다 */
  displayName: string;
  tier: number;
  /** 티어 이름(예: "일반", "VIP"). Ticket.tiers(eventId)[tier].name */
  tierName: string;
  /** 좌석 표기. 좌석 지정이 아닌 티어는 빈 문자열 */
  seat: string;
  checkedIn: boolean;
}

export interface SnapshotWire {
  v: 1;
  eventId: string;
  /** IPFS 메타데이터(imageCid)에서 읽은 평문 공연 제목. 체인에는 해시만 있다 */
  eventTitle: string;
  /** eventMeta.requireKyc. false 면 tickets[].photoJpegB64 가 전부 빈 문자열이다 */
  requireKyc: boolean;
  epoch: number;
  expiresAt: number;
  tickets: SnapshotTicket[];
  /** secp256k1 over keccak256(canonical JSON without attesterSig) */
  attesterSig: Hex;
}

/**
 * 스태프 화면이 입장을 거절할 때 말하는 코드(스펙 §13 DENY 행). 스태프 앱(04)과 관객 앱(03)이
 * 같은 값을 쓰게 하려고 여기 한 번만 적는다 — 한쪽에만 있는 코드는 반대쪽에서 빈 문장이 된다.
 *
 * 01 의 T20/T21 이후 `Ticket` 커스텀 에러 이름이 `GateMismatch → GATE_MISMATCH`,
 * `EventCancelled → EVENT_CANCELLED` 로 정리됐고, 이 목록이 그 셀렉터 맵의 키다.
 *
 * `TIMEOUT` 은 **여기 없다.** 쓰기가 시간 안에 답을 못 받은 것은 "아직 확인 중"이지 거절이
 * 아니다. 관객 화면은 그것을 기다림으로 다루고, 거절 문장으로 번역하지 않는다.
 */
export const GATE_DENY_CODES = [
  'ALREADY_USED',
  'WRONG_EVENT',
  'REVOKED',
  'EXPIRED_CODE',
  'NO_TICKET',
  'GATE_CLOSED',
  'DEVICE_LOCKED',
  'DEVICE_MISMATCH',
  'GATE_MISMATCH',
  'EVENT_ENDED',
  'EVENT_CANCELLED',
  'TX_FAILED',
] as const;

export type GateDenyCode = (typeof GATE_DENY_CODES)[number];

/** 푸시 페이로드처럼 밖에서 들어온 문자열을 DENY 코드로 좁힌다. */
export function isGateDenyCode(value: unknown): value is GateDenyCode {
  return typeof value === 'string' && (GATE_DENY_CODES as readonly string[]).includes(value);
}

/** Ticket.EventStatusChanged 의 uint8 코드 순서. 인덱스가 곧 체인의 코드다. */
export const EVENT_STATUS_BY_CODE = ['Draft', 'Published', 'Cancelled', 'Ended'] as const;
export type EventStatus = (typeof EVENT_STATUS_BY_CODE)[number];

/** Firestore `transferInvites/{inviteId}.status` */
export type TransferInviteStatus = 'sent' | 'accepted' | 'expired';

/** Firestore `users/{uid}.locale` */
export const SUPPORTED_LOCALES = ['en', 'ko'] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

/** `resolveRecipient` callable 의 반환. 회원이 아니면 member=false 하나만 온다. */
export interface ResolveRecipientResult {
  member: boolean;
  account?: Hex;
  nickname?: string;
  /** keccak256(hmacPhone). 전화번호 초대용 커밋먼트. phone 조회에서만 채워진다. */
  commitment?: Hex;
}

/** `listAttendees` callable 의 행. 전화번호·실명은 절대 포함하지 않는다. */
export interface AttendeeRow {
  tokenId: string;
  nickname: string;
  checkedIn: boolean;
  tier: number;
  /** 0 = 전화번호만 확인된 계정, 1 = 신분증·얼굴 확인 완료 */
  kycLevel: 0 | 1;
}

const HEX_RE = /^0x[0-9a-fA-F]*$/;

function isHexOfBytes(value: unknown, bytes: number): value is Hex {
  return typeof value === 'string' && HEX_RE.test(value) && value.length === 2 + bytes * 2;
}

export function isHex32(value: unknown): value is Hex {
  return isHexOfBytes(value, 32);
}

export function isHex64(value: unknown): value is Hex {
  return isHexOfBytes(value, 64);
}

export function isAddressHex(value: unknown): value is Hex {
  return isHexOfBytes(value, 20);
}

function isDecimalString(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9]+$/.test(value);
}

export function isGateCodeWire(value: unknown): value is GateCodeWire {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.v === 1 &&
    isDecimalString(v.gateId) &&
    isDecimalString(v.eventId) &&
    typeof v.issuedAt === 'number' &&
    Number.isInteger(v.issuedAt) &&
    v.issuedAt > 0 &&
    isHex32(v.nonce) &&
    isHex32(v.kx) &&
    isHex32(v.ky) &&
    isHex64(v.sig)
  );
}

export function isGateResponseWire(value: unknown): value is GateResponseWire {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.v === GATE_RESPONSE_VERSION && isDecimalString(v.tokenId) && isHex32(v.nonce) && isHex64(v.deviceSig)
  );
}
