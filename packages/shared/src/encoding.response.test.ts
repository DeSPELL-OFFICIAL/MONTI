import { describe, expect, it } from 'vitest';
import {
  base64UrlDecode,
  base64UrlEncode,
  decodeGateResponse,
  encodeGateResponse,
  fromQrPayload,
  toQrPayload,
} from './encoding.js';
import { BAD_GATE_RESPONSE_VERSION, GATE_RESPONSE_VERSION } from './types.js';
import type { GateResponseWire, Hex } from './types.js';

const NONCE = ('0x' + '11'.repeat(32)) as Hex;

/**
 * The cross-branch vector. These exact bytes are what the attendee phone writes, what the staff
 * gate reads out of its HCE file, and what sub-plan 04's APDU write vectors carry — so they are
 * pinned here, in the one package all three import, rather than re-derived on either side.
 */
const wire: GateResponseWire = {
  v: 2,
  tokenId: '7',
  nonce: NONCE,
  deviceSig: ('0x' + '22'.repeat(64)) as Hex,
};

/** `a4` = a 4-entry map, then `v`, `tokenId`, `nonce`, `deviceSig` in that fixed order. */
const VECTOR_HEX =
  'a461760267746f6b656e49646137656e6f6e63657842307831313131313131313131313131313131' +
  '31313131313131313131313131313131313131313131313131313131313131313131313131313131' +
  '31313131313131316964657669636553696778823078323232323232323232323232323232323232' +
  '32323232323232323232323232323232323232323232323232323232323232323232323232323232' +
  '32323232323232323232323232323232323232323232323232323232323232323232323232323232' +
  '323232323232323232323232323232323232323232323232323232323232';

const hex = (bytes: Uint8Array): string =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');

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

  it('is the 230-byte vector both branches pin, byte for byte', () => {
    const bytes = encodeGateResponse(wire);
    expect(bytes.byteLength).toBe(230);
    expect(hex(bytes)).toBe(VECTOR_HEX);
  });

  /**
   * CBOR maps keep insertion order, so an answer spelled in a different order would otherwise
   * be different bytes. The encoder fixes the order; this is what says so.
   */
  it('is the same bytes however the caller spelled the object', () => {
    const shuffled = {
      deviceSig: wire.deviceSig,
      nonce: wire.nonce,
      tokenId: wire.tokenId,
      v: wire.v,
    } as GateResponseWire;
    expect(hex(encodeGateResponse(shuffled))).toBe(VECTOR_HEX);
  });

  it('stays inside the 400-byte NDEF write budget', () => {
    expect(encodeGateResponse(wire).byteLength).toBeLessThanOrEqual(400);
  });

  it('refuses a 32-byte deviceSig and a nonce that is not 32 bytes', () => {
    expect(() =>
      encodeGateResponse({ ...wire, deviceSig: ('0x' + '22'.repeat(32)) as Hex }),
    ).toThrow('BAD_GATE_RESPONSE');
    expect(() => encodeGateResponse({ ...wire, nonce: ('0x' + '11'.repeat(16)) as Hex })).toThrow(
      'BAD_GATE_RESPONSE',
    );
  });

  /**
   * v1 had no nonce. Nothing is on a device yet, so it is refused rather than migrated — but it
   * is refused with its own message, because "that build predates the nonce" is a different
   * field report from "that was not a MONTI tag".
   */
  it('tells a v1 payload apart from something that is not a response at all', () => {
    expect(GATE_RESPONSE_VERSION).toBe(2);
    const v1 = encodeV1Response();
    expect(() => decodeGateResponse(v1)).toThrow(BAD_GATE_RESPONSE_VERSION);
    expect(() => decodeGateResponse(new Uint8Array([0x00, 0x01, 0x02]))).toThrow('BAD_GATE_RESPONSE');
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

  it('is the QR string both branches pin', () => {
    expect(toQrPayload(wire)).toBe(
      'MONTI1:pGF2Amd0b2tlbklkYTdlbm9uY2V4QjB4MTExMTExMTExMTExMTExMTExMTExMTExMTExMTExM' +
      'TExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMWlkZXZpY2VTaWd4gjB4MjIyMjIyMjIyMjIyM' +
      'jIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyM' +
      'jIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjI',
    );
  });
});

/**
 * The pre-nonce answer, built by hand because no encoder in this package will produce one any
 * more. Deliberately the same three fields v1 carried, so the refusal below is about the
 * version and not about a malformed map.
 */
function encodeV1Response(): Uint8Array {
  // Hand-rolled CBOR: a3 (3-entry map) + the three key/value pairs, definite-length text.
  const text = (value: string): number[] => {
    const bytes = [...new TextEncoder().encode(value)];
    const head = bytes.length < 24 ? [0x60 + bytes.length] : [0x78, bytes.length];
    return [...head, ...bytes];
  };
  return new Uint8Array([
    0xa3,
    ...text('v'),
    0x01,
    ...text('tokenId'),
    ...text('7'),
    ...text('deviceSig'),
    ...text(wire.deviceSig),
  ]);
}
