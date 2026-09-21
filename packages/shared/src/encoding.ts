import { Encoder } from 'cbor-x';
import { encodeAbiParameters, keccak256, parseAbiParameters, sha256, stringToBytes } from 'viem';
import { QR_PREFIX } from './constants.js';
import {
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

/** 게이트 단말기의 게이트 키가 서명하는 값. GateCodeWire.sig 가 이 해시에 대한 r||s 다. */
export function gateCodeHash(input: {
  gateId: bigint;
  eventId: bigint;
  issuedAt: bigint;
  nonce: Hex;
}): Hex {
  assertBytes32(input.nonce, 'BAD_NONCE');
  return sha256(
    encodeAbiParameters(
      parseAbiParameters('uint256 gateId, uint256 eventId, uint64 issuedAt, bytes32 nonce'),
      [input.gateId, input.eventId, input.issuedAt, input.nonce],
    ),
  );
}

/**
 * 관객 기기 키가 서명하는 값. Ticket.checkIn 이 체인 위에서
 * sha256(abi.encode(tokenId, g.gateId, g.eventId, g.nonce, g.issuedAt)) 로 다시 계산한다.
 * 인자 순서를 바꾸면 모든 체크인이 실패한다.
 */
export function deviceSigHash(input: {
  tokenId: bigint;
  gateId: bigint;
  eventId: bigint;
  nonce: Hex;
  issuedAt: bigint;
}): Hex {
  assertBytes32(input.nonce, 'BAD_NONCE');
  return sha256(
    encodeAbiParameters(
      parseAbiParameters('uint256 tokenId, uint256 gateId, uint256 eventId, bytes32 nonce, uint64 issuedAt'),
      [input.tokenId, input.gateId, input.eventId, input.nonce, input.issuedAt],
    ),
  );
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

export function encodeGateCode(wire: GateCodeWire): Uint8Array {
  if (!isGateCodeWire(wire)) throw new Error('BAD_GATE_CODE');
  return new Uint8Array(cbor.encode(wire));
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

export function encodeGateResponse(wire: GateResponseWire): Uint8Array {
  if (!isGateResponseWire(wire)) throw new Error('BAD_GATE_RESPONSE');
  return new Uint8Array(cbor.encode(wire));
}

export function decodeGateResponse(bytes: Uint8Array): GateResponseWire {
  let decoded: unknown;
  try {
    decoded = cbor.decode(bytes);
  } catch {
    throw new Error('BAD_GATE_RESPONSE');
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
