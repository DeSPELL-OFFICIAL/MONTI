export type Hex = `0x${string}`;

/** Firestore `persons/{personId}.status`. 전이는 pending → kyc_ok → active 만 허용된다. */
export type PersonStatus = 'pending' | 'kyc_ok' | 'active' | 'rotated' | 'rejected' | 'deleted';

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

export interface GateResponseWire {
  v: 1;
  tokenId: string;
  /** r||s 64B over sha256(abi.encode(chainid,ticket,tokenId,gateId,eventId,nonce,issuedAt)) — Ticket.deviceDigest(...) */
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

/** Ticket.EventStatusChanged 의 uint8 코드 순서. 인덱스가 곧 체인의 코드다. */
export const EVENT_STATUS_BY_CODE = ['Draft', 'Published', 'Cancelled', 'Ended'] as const;
export type EventStatus = (typeof EVENT_STATUS_BY_CODE)[number];

/** Firestore `transferInvites/{inviteId}.status` */
export type TransferInviteStatus = 'sent' | 'accepted' | 'expired';

/**
 * 입장 완료 푸시(FCM)의 `data` 페이로드. 서버(`tenderlyWebhook`)가 보내고
 * 관객 화면이 받는 **한 가지** 모양이라 여기 한 곳에만 둔다.
 *
 * FCM 의 `data` 는 값이 전부 문자열이다 — `late` 가 `boolean` 이 아니라 `'1'` 인 이유고,
 * "지각 아님"은 `late: '0'` 이 아니라 **키가 없는 것**으로 나타낸다.
 * 01b 의 `CheckedInLate`(오프라인 큐가 복구 뒤 밀어 넣은 입장)일 때만 `late: '1'` 이 붙는다.
 */
export interface CheckInPush {
  tokenId: string;
  late?: '1';
}

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
  return v.v === 1 && isDecimalString(v.tokenId) && isHex64(v.deviceSig);
}
