import { Encoder } from 'cbor-x';
import { encodeAbiParameters, keccak256, parseAbiParameters, sha256, stringToBytes } from 'viem';
import { QR_PREFIX } from './constants.js';
import {
  isGateCodeWire,
  isGateResponseWire,
  type GateCodeWire,
  type GateResponseWire,
  type Hex,
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
