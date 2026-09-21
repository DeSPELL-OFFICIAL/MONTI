import { describe, expect, it } from 'vitest';
import {
  EVENT_STATUS_BY_CODE,
  GATE_DENY_CODES,
  GATE_RESPONSE_VERSION,
  SUPPORTED_LOCALES,
  isGateCodeWire,
  isGateDenyCode,
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

  it('isGateResponseWire requires the gate code nonce, which is what matches answer to code', () => {
    const { nonce: _nonce, ...withoutNonce } = validResponse;
    expect(isGateResponseWire(withoutNonce)).toBe(false);
    expect(isGateResponseWire({ ...validResponse, nonce: B64 })).toBe(false);
  });

  it('isGateResponseWire rejects the v1 shape outright — no device ever carried one', () => {
    expect(isGateResponseWire({ v: 1, tokenId: '7', deviceSig: B64 })).toBe(false);
    expect(isGateResponseWire({ ...validResponse, v: 1 })).toBe(false);
    expect(isGateResponseWire({ ...validResponse, v: 3 })).toBe(false);
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

  it('pins the gate response wire version the staff app must speak', () => {
    expect(GATE_RESPONSE_VERSION).toBe(2);
  });

  it('supports exactly the two locales the app ships', () => {
    expect([...SUPPORTED_LOCALES]).toEqual(['en', 'ko']);
  });
});

describe('gate DENY codes', () => {
  it('freezes the spec §13 list, in the order the spec prints it', () => {
    // 스태프 화면과 관객 화면이 같은 코드를 말해야 한다. 한쪽에만 있는 코드는 관객에게
    // 빈 문장이 되고, 순서가 아니라 값이 계약이므로 목록 전체를 그대로 못 박는다.
    expect([...GATE_DENY_CODES]).toEqual([
      'ALREADY_USED', 'WRONG_EVENT', 'REVOKED', 'EXPIRED_CODE', 'NO_TICKET', 'GATE_CLOSED',
      'DEVICE_LOCKED', 'DEVICE_MISMATCH', 'GATE_MISMATCH', 'EVENT_ENDED', 'EVENT_CANCELLED',
      'TX_FAILED',
    ]);
  });

  it('isGateDenyCode accepts every frozen code and nothing else', () => {
    for (const code of GATE_DENY_CODES) expect(isGateDenyCode(code)).toBe(true);
    expect(isGateDenyCode('already_used')).toBe(false);
    expect(isGateDenyCode('')).toBe(false);
    expect(isGateDenyCode(undefined)).toBe(false);
  });

  it('does not count TIMEOUT as a refusal', () => {
    // 스펙 §13 의 DENY 표에 TIMEOUT 은 없다. 쓰기 결과의 'TIMEOUT' 은 "아직 확인 중"이지
    // 거절이 아니므로, 관객 화면이 이것을 거절 문장으로 번역하면 안 된다.
    expect(isGateDenyCode('TIMEOUT')).toBe(false);
  });
});
