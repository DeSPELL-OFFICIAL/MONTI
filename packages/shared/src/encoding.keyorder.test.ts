import { describe, expect, it } from 'vitest';
import {
  UnknownWireKeyError,
  decodeGateCode,
  decodeGateResponse,
  encodeGateCode,
  encodeGateResponse,
  toQrPayload,
} from './encoding.js';
import type { GateCodeWire, GateResponseWire, Hex } from './types.js';

const NONCE = ('0x' + '11'.repeat(32)) as Hex;
const KX = ('0x' + 'aa'.repeat(32)) as Hex;
const KY = ('0x' + 'bb'.repeat(32)) as Hex;
const SIG = ('0x' + 'cc'.repeat(64)) as Hex;

/** The key orders the wire format is: the encoder's own literals, not any caller's object. */
const GATE_CODE_ORDER = ['v', 'gateId', 'eventId', 'issuedAt', 'nonce', 'kx', 'ky', 'sig'];
const GATE_RESPONSE_ORDER = ['v', 'tokenId', 'nonce', 'deviceSig'];

const gateCode: GateCodeWire = {
  v: 1,
  gateId: '7',
  eventId: '3',
  issuedAt: 1_790_000_000,
  nonce: NONCE,
  kx: KX,
  ky: KY,
  sig: SIG,
};

const response: GateResponseWire = {
  v: 2,
  tokenId: '7',
  nonce: NONCE,
  deviceSig: ('0x' + '22'.repeat(32) + '33'.repeat(32)) as Hex,
};

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * 같은 값을 다른 순서로 적은 literal. TypeScript 의 객체 literal 은 순서를 자유롭게 쓸 수
 * 있으므로, 두 브랜치가 이런 식으로 갈라지는 일은 리뷰에 걸리지 않는다 — 바이트열이 갈라지면
 * 그때서야 게이트 앞에서 드러난다. 그래서 여기서 못 박는다.
 */
const shuffledGateCode: GateCodeWire = {
  sig: SIG,
  ky: KY,
  kx: KX,
  nonce: NONCE,
  issuedAt: 1_790_000_000,
  eventId: '3',
  gateId: '7',
  v: 1,
};

const shuffledResponse: GateResponseWire = {
  deviceSig: ('0x' + '22'.repeat(32) + '33'.repeat(32)) as Hex,
  nonce: NONCE,
  tokenId: '7',
  v: 2,
};

describe('gate wires encode in canonical key order', () => {
  it('encodes a gate code the same however the caller ordered the keys', () => {
    expect(hex(encodeGateCode(shuffledGateCode))).toBe(hex(encodeGateCode(gateCode)));
    expect(Object.keys(shuffledGateCode)).not.toEqual(Object.keys(gateCode));
  });

  it('encodes a gate response the same however the caller ordered the keys', () => {
    expect(hex(encodeGateResponse(shuffledResponse))).toBe(hex(encodeGateResponse(response)));
    expect(Object.keys(shuffledResponse)).not.toEqual(Object.keys(response));
    // The frozen v2 record is 230 bytes; a reordered caller must not move that by a byte.
    expect(encodeGateResponse(shuffledResponse).byteLength).toBe(230);
  });

  it('puts the keys on the wire in the one documented order, whatever came in', () => {
    expect(Object.keys(decodeGateCode(encodeGateCode(shuffledGateCode)))).toEqual(GATE_CODE_ORDER);
    expect(Object.keys(decodeGateResponse(encodeGateResponse(shuffledResponse)))).toEqual(GATE_RESPONSE_ORDER);
  });

  it('carries the same values through a reordered encode', () => {
    expect(decodeGateCode(encodeGateCode(shuffledGateCode))).toEqual(gateCode);
    expect(decodeGateResponse(encodeGateResponse(shuffledResponse))).toEqual(response);
  });

  it('is unchanged for a caller who already writes the canonical order', () => {
    // Task 25b's vector lives in encoding.response.test.ts; this only pins that the ordering
    // work did not move the canonical path even one byte.
    expect(hex(encodeGateResponse(response)).startsWith('a4617602')).toBe(true);
    expect(hex(encodeGateCode(gateCode)).startsWith('a8617601')).toBe(true);
  });
});

describe('keys the wire format does not have', () => {
  it('refuses an extra key on a gate code rather than dropping it', () => {
    const extra = { ...gateCode, gateName: 'Main' } as unknown as GateCodeWire;
    expect(() => encodeGateCode(extra)).toThrow(UnknownWireKeyError);
    try {
      encodeGateCode(extra);
      expect.unreachable('an unknown key must not encode');
    } catch (cause) {
      expect(cause).toBeInstanceOf(UnknownWireKeyError);
      expect((cause as Error).message).toBe('UNKNOWN_WIRE_KEY');
      expect((cause as UnknownWireKeyError).wire).toBe('GateCodeWire');
      expect([...(cause as UnknownWireKeyError).keys]).toEqual(['gateName']);
    }
  });

  it('refuses an extra key on a gate response rather than dropping it', () => {
    const extra = { ...response, seat: 'A12', tier: 1 } as unknown as GateResponseWire;
    expect(() => encodeGateResponse(extra)).toThrow(UnknownWireKeyError);
    try {
      encodeGateResponse(extra);
      expect.unreachable('an unknown key must not encode');
    } catch (cause) {
      expect(cause).toBeInstanceOf(UnknownWireKeyError);
      expect((cause as UnknownWireKeyError).wire).toBe('GateResponseWire');
      expect([...(cause as UnknownWireKeyError).keys]).toEqual(['seat', 'tier']);
    }
  });

  it('refuses it on the QR path too, which is the same encoder', () => {
    const extra = { ...response, seat: 'A12' } as unknown as GateResponseWire;
    expect(() => toQrPayload(extra)).toThrow(UnknownWireKeyError);
  });

  it('does not quietly produce the canonical bytes for a wire carrying more than it says', () => {
    // The failure this rules out: the extra field is dropped, the sender believes it went over,
    // the reader never saw it, and the bytes look perfectly valid to both.
    const extra = { ...response, deviceModel: 'Pixel 9' } as unknown as GateResponseWire;
    expect(() => encodeGateResponse(extra)).toThrow('UNKNOWN_WIRE_KEY');
  });

  it('still calls a malformed wire malformed, extra key or not', () => {
    const bad = { ...response, deviceSig: NONCE, seat: 'A12' } as unknown as GateResponseWire;
    expect(() => encodeGateResponse(bad)).toThrow('BAD_GATE_RESPONSE');
  });
});
