import { describe, expect, it } from 'vitest';
import {
  GateResponseVersionError,
  base64UrlDecode,
  base64UrlEncode,
  decodeGateResponse,
  encodeGateResponse,
  fromQrPayload,
  toQrPayload,
} from './encoding.js';
import type { GateResponseWire, Hex } from './types.js';

const NONCE = ('0x' + '11'.repeat(32)) as Hex;

const wire: GateResponseWire = {
  v: 2,
  tokenId: '7',
  nonce: NONCE,
  deviceSig: ('0x' + '22'.repeat(32) + '33'.repeat(32)) as Hex,
};

/**
 * The frozen vector. Sub-plan 04's staff app writes its own encoder from these bytes, so this
 * string — not the code above it — is the contract: tokenId 7, nonce 0x11×32, r 0x22×32,
 * s 0x33×32, fields in declaration order (v, tokenId, nonce, deviceSig).
 */
const VECTOR =
  '0xa461760267746f6b656e49646137656e6f6e63657842307831313131313131313131313131313131313131313131313131' +
  '3131313131313131313131313131313131313131313131313131313131313131313131313131316964657669636553696778' +
  '8230783232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232' +
  '3232323232323232323232323232323232333333333333333333333333333333333333333333333333333333333333333333' +
  '33333333333333333333333333333333333333333333333333333333333333';

/** The shape that never shipped. Kept only so the refusal below is tested against real bytes. */
const V1_BYTES =
  '0xa361760167746f6b656e496461376964657669636553696778823078323232323232323232323232323232323232323232' +
  '3232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232' +
  '3232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232' +
  '32323232323232';

function toBytes(hex: string): Uint8Array {
  const bare = hex.slice(2);
  return Uint8Array.from({ length: bare.length / 2 }, (_, i) => Number.parseInt(bare.slice(i * 2, i * 2 + 2), 16));
}

function toHex(bytes: Uint8Array): string {
  return '0x' + [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

describe('base64url', () => {
  it('encodes without padding and without + or /', () => {
    expect(base64UrlEncode(new Uint8Array([0xa2, 0x61, 0x76, 0x01, 0xff, 0xfe, 0x00, 0x10]))).toBe('omF2Af_-ABA');
    expect(base64UrlEncode(new Uint8Array([0xfb, 0xff, 0xbf, 0x3e, 0x3f]))).toBe('-_-_Pj8');
  });

  it('round-trips arbitrary bytes', () => {
    const bytes = new Uint8Array(256).map((_, i) => i);
    expect(Array.from(base64UrlDecode(base64UrlEncode(bytes)))).toEqual(Array.from(bytes));
  });
});

describe('GateResponseWire CBOR', () => {
  it('round-trips', () => {
    expect(decodeGateResponse(encodeGateResponse(wire))).toEqual(wire);
  });

  it('encodes the frozen vector byte for byte', () => {
    // Two independent implementations have to agree on these bytes — this one and sub-plan 04's.
    // A field reordered, a key renamed or a CBOR option changed all show up here first.
    expect(toHex(encodeGateResponse(wire))).toBe(VECTOR);
    expect(decodeGateResponse(toBytes(VECTOR))).toEqual(wire);
  });

  it('keeps the fields in declaration order, which is what the vector pins', () => {
    expect(Object.keys(decodeGateResponse(encodeGateResponse(wire)))).toEqual([
      'v',
      'tokenId',
      'nonce',
      'deviceSig',
    ]);
  });

  it('stays inside the 255-byte NDEF short-record bound at the largest signature', () => {
    // Everything but `tokenId` is fixed width — a hex string is 66 or 130 characters whatever it
    // holds — so the only thing that can push the record past a short record is a long token id,
    // and 25 decimal digits is where it lands exactly on the bound. Token ids are a sequential
    // ERC-721 counter, so the real payload is the 230 bytes above.
    const widest: GateResponseWire = {
      v: 2,
      tokenId: '9'.repeat(25),
      nonce: ('0x' + 'ff'.repeat(32)) as Hex,
      deviceSig: ('0x' + 'ff'.repeat(64)) as Hex,
    };
    expect(encodeGateResponse(widest).byteLength).toBe(255);
    expect(encodeGateResponse(wire).byteLength).toBe(230);
  });

  it('refuses a 32-byte deviceSig', () => {
    expect(() => encodeGateResponse({ ...wire, deviceSig: ('0x' + '22'.repeat(32)) as Hex })).toThrow(
      'BAD_GATE_RESPONSE',
    );
  });

  it('refuses a wire without the gate code nonce', () => {
    const { nonce: _nonce, ...withoutNonce } = wire;
    expect(() => encodeGateResponse(withoutNonce as GateResponseWire)).toThrow('BAD_GATE_RESPONSE');
    expect(() => encodeGateResponse({ ...wire, nonce: ('0x' + '11'.repeat(31)) as Hex })).toThrow(
      'BAD_GATE_RESPONSE',
    );
  });
});

describe('the v1 wire, which no device ever carried', () => {
  it('is refused by name rather than decoded', () => {
    // Not `BAD_GATE_RESPONSE`: unreadable bytes and a build one version behind are different
    // things to say, and only one of them is fixed by updating the app.
    expect(() => decodeGateResponse(toBytes(V1_BYTES))).toThrow(GateResponseVersionError);
    try {
      decodeGateResponse(toBytes(V1_BYTES));
      expect.unreachable('a v1 payload must not decode');
    } catch (cause) {
      expect(cause).toBeInstanceOf(GateResponseVersionError);
      expect((cause as GateResponseVersionError).version).toBe(1);
      expect((cause as Error).message).toBe('GATE_RESPONSE_VERSION');
    }
  });

  it('is refused through the QR path too', () => {
    expect(() => fromQrPayload(`MONTI1:${base64UrlEncode(toBytes(V1_BYTES))}`)).toThrow(GateResponseVersionError);
  });
});

describe('QR fallback', () => {
  it('prefixes MONTI1: and stays URL safe', () => {
    const payload = toQrPayload(wire);
    expect(payload.startsWith('MONTI1:')).toBe(true);
    expect(payload).not.toMatch(/[+/=]/);
  });

  it('round-trips through the QR payload', () => {
    expect(fromQrPayload(toQrPayload(wire))).toEqual(wire);
  });

  it('rejects a payload without the prefix', () => {
    expect(() => fromQrPayload('MONTI2:abc')).toThrow('BAD_QR_PREFIX');
    expect(() => fromQrPayload('https://example.com')).toThrow('BAD_QR_PREFIX');
  });

  it('rejects a well-prefixed payload whose body is not a gate response', () => {
    expect(() => fromQrPayload('MONTI1:AAEC')).toThrow('BAD_GATE_RESPONSE');
  });
});
