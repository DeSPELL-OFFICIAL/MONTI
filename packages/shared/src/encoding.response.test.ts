import { describe, expect, it } from 'vitest';
import {
  base64UrlDecode,
  base64UrlEncode,
  decodeGateResponse,
  encodeGateResponse,
  fromQrPayload,
  toQrPayload,
} from './encoding.js';
import type { GateResponseWire, Hex } from './types.js';

const wire: GateResponseWire = {
  v: 1,
  tokenId: '7',
  deviceSig: ('0x' + '22'.repeat(64)) as Hex,
};

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

  it('stays inside the 400-byte NDEF write budget', () => {
    expect(encodeGateResponse(wire).byteLength).toBeLessThanOrEqual(400);
  });

  it('refuses a 32-byte deviceSig', () => {
    expect(() =>
      encodeGateResponse({ ...wire, deviceSig: ('0x' + '22'.repeat(32)) as Hex }),
    ).toThrow('BAD_GATE_RESPONSE');
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
