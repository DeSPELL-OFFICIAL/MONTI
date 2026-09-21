import { describe, expect, it } from 'vitest';
import {
  EVENT_STATUS_BY_CODE,
  SUPPORTED_LOCALES,
  isGateCodeWire,
  isGateResponseWire,
  isHex32,
  isHex64,
  type GateCodeWire,
  type GateResponseWire,
} from './types.js';

const B32 = ('0x' + '11'.repeat(32)) as `0x${string}`;
const B64 = ('0x' + '22'.repeat(64)) as `0x${string}`;

const validGateCode: GateCodeWire = {
  v: 1,
  gateId: '3',
  eventId: '11',
  issuedAt: 1789862400,
  nonce: B32,
  kx: B32,
  ky: B32,
  sig: B64,
};

const validResponse: GateResponseWire = { v: 2, tokenId: '7', nonce: B32, deviceSig: B64 };

describe('hex guards', () => {
  it('isHex32 accepts 32-byte hex and rejects the rest', () => {
    expect(isHex32(B32)).toBe(true);
    expect(isHex32(B64)).toBe(false);
    expect(isHex32('0x11')).toBe(false);
    expect(isHex32('11'.repeat(32))).toBe(false);
    expect(isHex32(null)).toBe(false);
  });

  it('isHex64 accepts 64-byte hex only', () => {
    expect(isHex64(B64)).toBe(true);
    expect(isHex64(B32)).toBe(false);
    expect(isHex64('0xZZ')).toBe(false);
  });
});

describe('wire guards', () => {
  it('isGateCodeWire accepts the master-plan shape', () => {
    expect(isGateCodeWire(validGateCode)).toBe(true);
  });

  it('isGateCodeWire rejects a wrong version', () => {
    expect(isGateCodeWire({ ...validGateCode, v: 2 })).toBe(false);
  });

  it('isGateCodeWire rejects a numeric gateId', () => {
    expect(isGateCodeWire({ ...validGateCode, gateId: 3 })).toBe(false);
  });

  it('isGateCodeWire rejects a short signature', () => {
    expect(isGateCodeWire({ ...validGateCode, sig: B32 })).toBe(false);
  });

  it('isGateResponseWire accepts the master-plan shape and rejects a bad deviceSig', () => {
    expect(isGateResponseWire(validResponse)).toBe(true);
    expect(isGateResponseWire({ ...validResponse, deviceSig: B32 })).toBe(false);
  });

  /**
   * The nonce is what makes an answer traceable to the code it answers. A response missing it
   * is the pre-v2 shape, and accepting one would put the gate back to guessing which of its
   * rotating codes a tap belongs to.
   */
  it('isGateResponseWire refuses the v1 shape and a nonce that is not 32 bytes', () => {
    expect(isGateResponseWire({ v: 1, tokenId: '7', deviceSig: B64 })).toBe(false);
    expect(isGateResponseWire({ v: 1, tokenId: '7', nonce: B32, deviceSig: B64 })).toBe(false);
    const { nonce: _nonce, ...withoutNonce } = validResponse;
    expect(isGateResponseWire(withoutNonce)).toBe(false);
    expect(isGateResponseWire({ ...validResponse, nonce: B64 })).toBe(false);
  });
});

describe('enumerations', () => {
  it('maps EventStatusChanged uint8 codes to names in chain order', () => {
    expect(EVENT_STATUS_BY_CODE[0]).toBe('Draft');
    expect(EVENT_STATUS_BY_CODE[1]).toBe('Published');
    expect(EVENT_STATUS_BY_CODE[2]).toBe('Cancelled');
    expect(EVENT_STATUS_BY_CODE[3]).toBe('Ended');
    expect(EVENT_STATUS_BY_CODE).toHaveLength(4);
  });

  it('supports exactly the two locales the app ships', () => {
    expect([...SUPPORTED_LOCALES]).toEqual(['en', 'ko']);
  });
});
