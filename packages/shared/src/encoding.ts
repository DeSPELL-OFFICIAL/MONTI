import { Encoder } from 'cbor-x';
import { encodeAbiParameters, keccak256, parseAbiParameters, sha256, stringToBytes } from 'viem';
import { DEVICE_DIGEST_FORM, QR_PREFIX } from './constants.js';
import {
  GATE_RESPONSE_VERSION,
  isGateCodeWire,
  isGateResponseWire,
  type GateCodeWire,
  type GateResponseWire,
  type Hex,
  type SnapshotWire,
} from './types.js';

function assertBytes32(value: Hex, label: string): void {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error(label);
}

export interface GateCodeDigestInput {
  gateId: bigint;
  eventId: bigint;
  issuedAt: bigint;
  nonce: Hex;
}

/**
 * 게이트 키가 **서명하는 대상 바이트열**. `gateCodeHash` 는 이걸 sha256 한 값이다.
 *
 * 따로 내보내는 이유는 하나다: WebCrypto 의 `ECDSA`/`SHA-256` 검증은 다이제스트가 아니라
 * 원문을 받아 자기가 해싱한다. 원문 정의가 두 군데 생기면 서명은 조용히 어긋나므로,
 * 해시와 원문 모두 이 함수 하나에서 나온다.
 */
export function gateCodePreimage(input: GateCodeDigestInput): Hex {
  assertBytes32(input.nonce, 'BAD_NONCE');
  return encodeAbiParameters(
    parseAbiParameters('uint256 gateId, uint256 eventId, uint64 issuedAt, bytes32 nonce'),
    [input.gateId, input.eventId, input.issuedAt, input.nonce],
  );
}

/** 게이트 단말기의 게이트 키가 서명하는 값. GateCodeWire.sig 가 이 해시에 대한 r||s 다. */
export function gateCodeHash(input: GateCodeDigestInput): Hex {
  return sha256(gateCodePreimage(input));
}

/**
 * 관객 기기 키가 서명하는 값의 입력. 두 형식이 같은 입력을 받는다 — v1 은 앞의 두 워드를
 * 그냥 쓰지 않는다. 호출부가 형식에 따라 인자를 바꿔 넣지 않아도 되도록 일부러 하나로 뒀다.
 */
export interface DeviceDigestInput {
  /** `block.chainid`. v1 에서는 쓰이지 않는다. */
  chainId: bigint;
  /** 배포된 Ticket 주소(`address(this)`). v1 에서는 쓰이지 않는다. */
  ticket: Hex;
  tokenId: bigint;
  gateId: bigint;
  eventId: bigint;
  nonce: Hex;
  issuedAt: bigint;
}

function assertTicket(value: Hex): void {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error('BAD_TICKET_ADDRESS');
}

/**
 * v1 서명 원문. 5개 워드뿐이라 체인도 배포본도 가리키지 않았다.
 * @deprecated 이 원문을 검증하던 배포본(Ticket `0xE9686503c4d675B0B1Ec9DE19AbEC51Fc59F1113`)은
 *             2026-09-23 01b 재배포로 은퇴했다. 지금 맞는 것은 {@link deviceDigestPreimageV2} 다.
 *             남겨 둔 이유는 하나뿐이다 — 테스트가 v2 와 다르다는 것을 보이는 음성 대조군으로
 *             아직 부른다.
 */
export function deviceSigPreimage(input: Omit<DeviceDigestInput, 'chainId' | 'ticket'>): Hex {
  assertBytes32(input.nonce, 'BAD_NONCE');
  return encodeAbiParameters(
    parseAbiParameters('uint256 tokenId, uint256 gateId, uint256 eventId, bytes32 nonce, uint64 issuedAt'),
    [input.tokenId, input.gateId, input.eventId, input.nonce, input.issuedAt],
  );
}

/**
 * 관객 기기 키가 서명하던 값(v1). 은퇴한 배포본(Ticket
 * `0xE9686503c4d675B0B1Ec9DE19AbEC51Fc59F1113`)의 `Ticket.checkIn` 이 체인 위에서
 * sha256(abi.encode(tokenId, g.gateId, g.eventId, g.nonce, g.issuedAt)) 로 다시 계산했다.
 * @deprecated 이 형식을 검증하던 배포본은 2026-09-23 01b 재배포로 은퇴했고, 지금 맞는 것은
 *             {@link deviceDigestV2} 다. 형식 선택은 {@link DEVICE_DIGEST_FORM} 한 줄이고,
 *             화면은 {@link deviceDigest} 를 부른다. 이 함수가 남아 있는 것은 죽은 형식이
 *             살아 있는 형식과 다르다는 것을 테스트가 음성 대조군으로 보이기 때문이다.
 */
export function deviceSigHash(input: Omit<DeviceDigestInput, 'chainId' | 'ticket'>): Hex {
  return sha256(deviceSigPreimage(input));
}

/**
 * v2 서명 원문. 01b 의 `Ticket._deviceDigest` 가 그대로 이 7개 워드를 abi.encode 한다:
 * `(uint256 chainId, address ticket, uint256 tokenId, uint256 gateId, uint256 eventId,
 * bytes32 nonce, uint64 issuedAt)`. 앞의 두 워드가 있어야 한 체인·한 배포본에서 거둔 서명이
 * 다른 곳에서 재생되지 않는다.
 */
export function deviceDigestPreimageV2(input: DeviceDigestInput): Hex {
  assertBytes32(input.nonce, 'BAD_NONCE');
  assertTicket(input.ticket);
  return encodeAbiParameters(
    parseAbiParameters(
      'uint256 chainId, address ticket, uint256 tokenId, uint256 gateId, uint256 eventId, bytes32 nonce, uint64 issuedAt',
    ),
    [input.chainId, input.ticket, input.tokenId, input.gateId, input.eventId, input.nonce, input.issuedAt],
  );
}

export function deviceDigestV2(input: DeviceDigestInput): Hex {
  return sha256(deviceDigestPreimageV2(input));
}

/**
 * 이 빌드가 실제로 서명하는 원문. WebCrypto 는 다이제스트가 아니라 원문을 받아 자기가
 * 해싱하므로, 로컬 검증은 이걸 쓴다 — `gateCodePreimage` 가 있는 이유와 같다.
 */
export function deviceDigestPreimage(input: DeviceDigestInput): Hex {
  return DEVICE_DIGEST_FORM === 'v2-domainSeparated' ? deviceDigestPreimageV2(input) : deviceSigPreimage(input);
}

/** 이 빌드가 실제로 서명하는 32바이트. 형식은 {@link DEVICE_DIGEST_FORM} 한 줄이 정한다. */
export function deviceDigest(input: DeviceDigestInput): Hex {
  return sha256(deviceDigestPreimage(input));
}

/** 닉네임 비교는 항상 이 정규형으로 한다. 웹·서버·인덱서가 같은 함수를 쓴다. */
export function normalizeNickname(raw: string): string {
  return raw.normalize('NFKC').trim().toLowerCase();
}

export function nicknameHash(raw: string): Hex {
  const normalized = normalizeNickname(raw);
  if (normalized.length === 0) throw new Error('EMPTY_NICKNAME');
  return keccak256(stringToBytes(normalized));
}

/**
 * hmacPhone = HMAC-SHA256(PHONE_INDEX_KEY, phoneE164) 의 32바이트를 그대로 keccak 한다.
 * 0x 접두사 유무는 무시한다. 결과가 Ticket.createOffer 의 recipientCommitment 다.
 */
export function recipientCommitment(hmacPhoneHex: string): Hex {
  const bare = hmacPhoneHex.startsWith('0x') ? hmacPhoneHex.slice(2) : hmacPhoneHex;
  if (!/^[0-9a-fA-F]{64}$/.test(bare)) throw new Error('BAD_HMAC_PHONE');
  return keccak256(`0x${bare.toLowerCase()}` as Hex);
}

/** 어테스터가 acceptOffer 용으로 서명하는 다이제스트. */
export function offerDigest(input: {
  tokenId: bigint;
  recipientCommitment: Hex;
  recipientAccount: Hex;
}): Hex {
  assertBytes32(input.recipientCommitment, 'BAD_COMMITMENT');
  if (!/^0x[0-9a-fA-F]{40}$/.test(input.recipientAccount)) throw new Error('BAD_ACCOUNT');
  return keccak256(
    encodeAbiParameters(
      parseAbiParameters('uint256 tokenId, bytes32 recipientCommitment, address recipientAccount'),
      [input.tokenId, input.recipientCommitment, input.recipientAccount],
    ),
  );
}

/**
 * NFC로 오가는 바이트라서 옵션을 고정한다.
 * - useRecords: false  → 레코드 확장 태그를 쓰지 않는다(다른 구현이 못 읽는다)
 * - mapsAsObjects: true → 디코드 결과가 일반 객체
 * - variableMapSize: true → 길이 프리픽스를 최소 크기로
 */
const cbor = new Encoder({
  useRecords: false,
  mapsAsObjects: true,
  variableMapSize: true,
  tagUint8Array: false,
  useFloat32: 0,
});

/**
 * 와이어에 표준 순서 바깥의 키가 붙어 있으면 거절한다. 조용히 버리면 보낸 쪽은 자기가 넣은
 * 필드가 건너갔다고 믿고 받는 쪽은 그런 필드를 본 적이 없다 — 어느 쪽도 틀린 줄 모른다.
 */
export class UnknownWireKeyError extends Error {
  /** 어느 와이어인지 — 'GateCodeWire' | 'GateResponseWire' */
  readonly wire: string;
  /** 표준 순서에 없는 키들 */
  readonly keys: readonly string[];

  constructor(wire: string, keys: readonly string[]) {
    super('UNKNOWN_WIRE_KEY');
    this.name = 'UnknownWireKeyError';
    this.wire = wire;
    this.keys = keys;
  }
}

/** 표준 순서 맵이 곧 아는 키의 전부다. 목록을 따로 두면 언젠가 literal 과 어긋난다. */
function assertOnlyCanonicalKeys(source: object, canonical: Record<string, unknown>, wire: string): void {
  const known = new Set(Object.keys(canonical));
  const extra = Object.keys(source).filter((key) => !known.has(key));
  if (extra.length > 0) throw new UnknownWireKeyError(wire, extra);
}

/**
 * 키 순서는 **호출부의 객체가 아니라 아래 literal** 이 정한다. 두 브랜치가 같은 값을 다른
 * 순서로 담아도 바이트열은 하나다 — `cbor.encode(wire)` 였을 때는 아니었다.
 * 순서: v, gateId, eventId, issuedAt, nonce, kx, ky, sig.
 */
export function encodeGateCode(wire: GateCodeWire): Uint8Array {
  if (!isGateCodeWire(wire)) throw new Error('BAD_GATE_CODE');
  const map = {
    v: wire.v,
    gateId: wire.gateId,
    eventId: wire.eventId,
    issuedAt: wire.issuedAt,
    nonce: wire.nonce,
    kx: wire.kx,
    ky: wire.ky,
    sig: wire.sig,
  };
  assertOnlyCanonicalKeys(wire, map, 'GateCodeWire');
  return new Uint8Array(cbor.encode(map));
}

export function decodeGateCode(bytes: Uint8Array): GateCodeWire {
  let decoded: unknown;
  try {
    decoded = cbor.decode(bytes);
  } catch {
    throw new Error('BAD_GATE_CODE');
  }
  if (!isGateCodeWire(decoded)) throw new Error('BAD_GATE_CODE');
  return decoded;
}

/**
 * 버전이 다른 게이트 응답. `BAD_GATE_RESPONSE`(못 읽는 바이트열)와 구분되는 이유는 하나다 —
 * 스태프 화면이 "읽을 수 없는 코드"가 아니라 "앱을 업데이트하세요"라고 말해야 하기 때문이다.
 * v1 은 기기에 나간 적이 없으므로 해석하지 않고 여기서 끊는다.
 */
export class GateResponseVersionError extends Error {
  readonly version: unknown;

  constructor(version: unknown) {
    super('GATE_RESPONSE_VERSION');
    this.name = 'GateResponseVersionError';
    this.version = version;
  }
}

/**
 * 키 순서는 **호출부의 객체가 아니라 아래 literal** 이 정한다: v, tokenId, nonce, deviceSig.
 * 고정 벡터가 그 순서를 못 박고 있으니, 순서를 바꾸려면 벡터부터 바꿔야 한다. 호출부가 같은
 * 값을 다른 순서로 적어도 나가는 바이트열은 하나다.
 */
export function encodeGateResponse(wire: GateResponseWire): Uint8Array {
  if (!isGateResponseWire(wire)) throw new Error('BAD_GATE_RESPONSE');
  const map = { v: wire.v, tokenId: wire.tokenId, nonce: wire.nonce, deviceSig: wire.deviceSig };
  assertOnlyCanonicalKeys(wire, map, 'GateResponseWire');
  return new Uint8Array(cbor.encode(map));
}

export function decodeGateResponse(bytes: Uint8Array): GateResponseWire {
  let decoded: unknown;
  try {
    decoded = cbor.decode(bytes);
  } catch {
    throw new Error('BAD_GATE_RESPONSE');
  }
  if (typeof decoded === 'object' && decoded !== null) {
    const version = (decoded as Record<string, unknown>).v;
    if (typeof version === 'number' && version !== GATE_RESPONSE_VERSION) throw new GateResponseVersionError(version);
  }
  if (!isGateResponseWire(decoded)) throw new Error('BAD_GATE_RESPONSE');
  return decoded;
}

/** 브라우저(atob/btoa)와 Node 22 양쪽에서 같은 결과를 낸다. Buffer를 쓰지 않는다. */
export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i] as number);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlDecode(text: string): Uint8Array {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(text.length / 4) * 4, '=');
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    throw new Error('BAD_BASE64URL');
  }
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/** NFC 쓰기가 실패하는 기기(아이폰 브라우저 접속자)용 QR 문자열. */
export function toQrPayload(wire: GateResponseWire): string {
  return `${QR_PREFIX}${base64UrlEncode(encodeGateResponse(wire))}`;
}

export function fromQrPayload(text: string): GateResponseWire {
  if (!text.startsWith(QR_PREFIX)) throw new Error('BAD_QR_PREFIX');
  return decodeGateResponse(base64UrlDecode(text.slice(QR_PREFIX.length)));
}

function hexToBytes(hex: Hex): Uint8Array {
  const bare = hex.slice(2);
  const out = new Uint8Array(bare.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(bare.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(bytes: Uint8Array): Hex {
  let out = '0x';
  for (let i = 0; i < bytes.length; i += 1) out += (bytes[i] as number).toString(16).padStart(2, '0');
  return out as Hex;
}

export function splitRs(sig: Hex): { r: Hex; s: Hex } {
  if (!/^0x[0-9a-fA-F]{128}$/.test(sig)) throw new Error('BAD_RS_LENGTH');
  return { r: `0x${sig.slice(2, 66)}` as Hex, s: `0x${sig.slice(66)}` as Hex };
}

export function joinRs(r: Hex, s: Hex): Hex {
  if (!/^0x[0-9a-fA-F]{64}$/.test(r) || !/^0x[0-9a-fA-F]{64}$/.test(s)) throw new Error('BAD_RS_LENGTH');
  return `0x${r.slice(2)}${s.slice(2)}` as Hex;
}

/** DER INTEGER 는 최소 길이 + 양수 표현이라 선행 0을 버리고 최상위 비트가 1이면 0x00을 붙인다. */
function toDerInteger(value: Uint8Array): Uint8Array {
  let start = 0;
  while (start < value.length - 1 && value[start] === 0) start += 1;
  const trimmed = value.subarray(start);
  const needsPad = ((trimmed[0] as number) & 0x80) !== 0;
  const body = needsPad ? new Uint8Array([0, ...trimmed]) : trimmed;
  return new Uint8Array([0x02, body.length, ...body]);
}

export function rsToDer(sig: Hex): Hex {
  const { r, s } = splitRs(sig);
  const rDer = toDerInteger(hexToBytes(r));
  const sDer = toDerInteger(hexToBytes(s));
  const body = new Uint8Array([...rDer, ...sDer]);
  return bytesToHex(new Uint8Array([0x30, body.length, ...body]));
}

function readDerInteger(bytes: Uint8Array, offset: number): { value: Uint8Array; next: number } {
  if (bytes[offset] !== 0x02) throw new Error('BAD_DER');
  const length = bytes[offset + 1];
  if (length === undefined || offset + 2 + length > bytes.length) throw new Error('BAD_DER');
  let value = bytes.subarray(offset + 2, offset + 2 + length);
  while (value.length > 32 && value[0] === 0) value = value.subarray(1);
  if (value.length > 32) throw new Error('BAD_DER');
  const padded = new Uint8Array(32);
  padded.set(value, 32 - value.length);
  return { value: padded, next: offset + 2 + length };
}

export function derToRs(der: Hex): Hex {
  if (!/^0x([0-9a-fA-F]{2})+$/.test(der)) throw new Error('BAD_DER');
  const bytes = hexToBytes(der);
  if (bytes[0] !== 0x30) throw new Error('BAD_DER');
  if (bytes[1] !== bytes.length - 2) throw new Error('BAD_DER');
  const r = readDerInteger(bytes, 2);
  const s = readDerInteger(bytes, r.next);
  if (s.next !== bytes.length) throw new Error('BAD_DER');
  return joinRs(bytesToHex(r.value), bytesToHex(s.value));
}

const HEX_STRING_RE = /^0x[0-9a-fA-F]+$/;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) out[key] = canonicalize(source[key]);
    return out;
  }
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new Error('NON_INTEGER_NUMBER');
  if (typeof value === 'string' && HEX_STRING_RE.test(value)) return value.toLowerCase();
  return value;
}

/**
 * 키 재귀 사전순, 공백 없음, 숫자는 안전 정수만, 0x 문자열은 소문자.
 * 02(서명)와 04(검증)가 같은 바이트열을 만들기 위한 유일한 정의다.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export type UnsignedSnapshot = Omit<SnapshotWire, 'attesterSig'>;

/** attesterSig 가 서명하는 대상. raw secp256k1 65바이트 r||s||v, EIP-191 접두사 없음. */
export function snapshotDigest(snapshot: UnsignedSnapshot): Hex {
  if ('attesterSig' in (snapshot as Record<string, unknown>)) throw new Error('SNAPSHOT_ALREADY_SIGNED');
  return keccak256(stringToBytes(canonicalJson(snapshot)));
}
