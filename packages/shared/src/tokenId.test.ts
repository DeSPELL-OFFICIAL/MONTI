import { describe, expect, it } from 'vitest';
import { decodeTokenId, encodeTokenId, type TokenIdParts } from './tokenId.js';

/**
 * 고정 벡터. id 값·eventOf·tierOf 는 실제 컨트랙트(MONTI-01b eee7660)의 `_encodeTokenId` 조립과
 * `eventOf`/`tierOf` 게터를 forge 스크립트로 호출해 대조했다.
 */
const VECTORS: { label: string; parts: TokenIdParts; id: bigint }[] = [
  { label: 'T1 serial=1', parts: { eventId: 0n, tier: 0, serial: 1n }, id: 1n },
  { label: 'T2 mid', parts: { eventId: 42n, tier: 3, serial: 12345n }, id: 3328511280628566214135020269625n },
  {
    label: 'T3 all bits set',
    parts: { eventId: (1n << 160n) - 1n, tier: 255, serial: (1n << 88n) - 1n },
    id: (1n << 256n) - 1n,
  },
];

describe('encodeTokenId / decodeTokenId', () => {
  for (const v of VECTORS) {
    it(`encodes the contract-derived id: ${v.label}`, () => {
      expect(encodeTokenId(v.parts)).toBe(v.id);
    });
    it(`round-trips: ${v.label}`, () => {
      expect(decodeTokenId(encodeTokenId(v.parts))).toEqual(v.parts);
    });
  }

  it('boundary serial (max) and serial 0 round-trip', () => {
    const maxSerial = (1n << 88n) - 1n;
    expect(decodeTokenId(encodeTokenId({ eventId: 7n, tier: 9, serial: maxSerial }))).toEqual({
      eventId: 7n,
      tier: 9,
      serial: maxSerial,
    });
    expect(decodeTokenId(encodeTokenId({ eventId: 7n, tier: 9, serial: 0n }))).toEqual({
      eventId: 7n,
      tier: 9,
      serial: 0n,
    });
  });

  it('every uint256 is a valid tokenId (no unused bits)', () => {
    const id = (1n << 200n) | (1n << 90n) | 12345n;
    expect(encodeTokenId(decodeTokenId(id))).toBe(id);
  });
});

describe('encodeTokenId range guards', () => {
  it('rejects serial > 2^88-1 (SerialOverflow)', () => {
    expect(() => encodeTokenId({ eventId: 1n, tier: 0, serial: 1n << 88n })).toThrow('SERIAL_OVERFLOW');
  });

  it('rejects eventId > 2^160-1 (EventIdOverflow)', () => {
    expect(() => encodeTokenId({ eventId: 1n << 160n, tier: 0, serial: 1n })).toThrow('EVENT_ID_OVERFLOW');
  });

  it('rejects tier outside uint8', () => {
    expect(() => encodeTokenId({ eventId: 1n, tier: 256, serial: 1n })).toThrow('BAD_TIER');
    expect(() => encodeTokenId({ eventId: 1n, tier: -1, serial: 1n })).toThrow('BAD_TIER');
  });
});

describe('decodeTokenId range guards', () => {
  it('rejects a value outside uint256', () => {
    expect(() => decodeTokenId(1n << 256n)).toThrow('BAD_TOKEN_ID');
    expect(() => decodeTokenId(-1n)).toThrow('BAD_TOKEN_ID');
  });
});
