import { describe, expect, it } from 'vitest';
import { decodeGateCode, encodeGateCode } from './encoding.js';
import type { GateCodeWire, Hex } from './types.js';

const B32 = ('0x' + '11'.repeat(32)) as Hex;
const B64 = ('0x' + '22'.repeat(64)) as Hex;

const wire: GateCodeWire = {
  v: 1,
  gateId: '3',
  eventId: '11',
  issuedAt: 1_789_862_400,
  nonce: B32,
  kx: B32,
  ky: ('0x' + '33'.repeat(32)) as Hex,
  sig: B64,
};

describe('GateCodeWire CBOR', () => {
  it('round-trips every field', () => {
    expect(decodeGateCode(encodeGateCode(wire))).toEqual(wire);
  });

  it('fits in a Type 4 NDEF payload', () => {
    expect(encodeGateCode(wire).byteLength).toBeLessThanOrEqual(400);
  });

  it('is deterministic for the same input', () => {
    expect(Buffer.from(encodeGateCode(wire)).toString('hex')).toBe(
      Buffer.from(encodeGateCode(wire)).toString('hex'),
    );
  });

  it('refuses to encode a wire with a wrong version', () => {
    expect(() => encodeGateCode({ ...wire, v: 2 } as unknown as GateCodeWire)).toThrow('BAD_GATE_CODE');
  });

  it('refuses to decode garbage', () => {
    expect(() => decodeGateCode(new Uint8Array([0x00, 0x01, 0x02]))).toThrow('BAD_GATE_CODE');
  });

  it('refuses to decode a CBOR map that is not a gate code', () => {
    const notAGateCode = encodeGateCode(wire);
    const last = notAGateCode.length - 1;
    notAGateCode[last] = (notAGateCode[last] ?? 0) ^ 0xff;
    expect(() => decodeGateCode(notAGateCode)).toThrow('BAD_GATE_CODE');
  });
});
