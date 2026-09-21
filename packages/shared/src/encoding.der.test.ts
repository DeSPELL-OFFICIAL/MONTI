import { describe, expect, it } from 'vitest';
import { derToRs, joinRs, rsToDer, splitRs } from './encoding.js';
import type { Hex } from './types.js';

const R1 = ('0x' + '11'.repeat(32)) as Hex;
const S1 = ('0x' + '22'.repeat(32)) as Hex;

describe('splitRs / joinRs', () => {
  it('splits a 64-byte signature in half', () => {
    expect(splitRs(joinRs(R1, S1))).toEqual({ r: R1, s: S1 });
  });

  it('rejects a signature that is not 64 bytes', () => {
    expect(() => splitRs(R1)).toThrow('BAD_RS_LENGTH');
    expect(() => joinRs(R1, ('0x' + '22'.repeat(31)) as Hex)).toThrow('BAD_RS_LENGTH');
  });
});

describe('rsToDer', () => {
  it('encodes a signature whose high bits are clear', () => {
    expect(rsToDer(joinRs(R1, S1))).toBe(
      '0x30440220' + '11'.repeat(32) + '0220' + '22'.repeat(32),
    );
  });

  it('prepends 0x00 when the high bit of r is set', () => {
    const r = '0xd47ce4c025c35ec440bc81d99834a624875161a26bf56ef7fdc0f5d52f843ad1' as Hex;
    const s = '0x44a8bcd0d3f9b1f6b8c65d5b3d8b5c4e2a1f0e9d8c7b6a594837261504f3e2d1' as Hex;
    expect(rsToDer(joinRs(r, s))).toBe(
      '0x3045022100d47ce4c025c35ec440bc81d99834a624875161a26bf56ef7fdc0f5d52f843ad1022044a8bcd0d3f9b1f6b8c65d5b3d8b5c4e2a1f0e9d8c7b6a594837261504f3e2d1',
    );
  });

  it('strips leading zero bytes', () => {
    const r = '0x00000000000000000000000000000000000000000000000000000000000000ff' as Hex;
    const s = '0x007f000000000000000000000000000000000000000000000000000000000001' as Hex;
    expect(rsToDer(joinRs(r, s))).toBe(
      '0x3025020200ff021f7f000000000000000000000000000000000000000000000000000000000001',
    );
  });
});

describe('derToRs', () => {
  it('reverses each rsToDer vector', () => {
    const pairs: Array<[Hex, Hex]> = [
      [R1, S1],
      [
        '0xd47ce4c025c35ec440bc81d99834a624875161a26bf56ef7fdc0f5d52f843ad1' as Hex,
        '0x44a8bcd0d3f9b1f6b8c65d5b3d8b5c4e2a1f0e9d8c7b6a594837261504f3e2d1' as Hex,
      ],
      [
        '0x00000000000000000000000000000000000000000000000000000000000000ff' as Hex,
        '0x007f000000000000000000000000000000000000000000000000000000000001' as Hex,
      ],
    ];
    for (const [r, s] of pairs) {
      expect(derToRs(rsToDer(joinRs(r, s)))).toBe(joinRs(r, s));
    }
  });

  it('rejects a non-SEQUENCE', () => {
    expect(() => derToRs('0x3144' as Hex)).toThrow('BAD_DER');
  });

  it('rejects a truncated body', () => {
    expect(() => derToRs('0x30440220' as Hex)).toThrow('BAD_DER');
  });
});
