import { describe, expect, it } from 'vitest';
import {
  bpsToPercent,
  blankRow,
  exampleSplit,
  percentToBps,
  platformBpsOf,
  platformRow,
  toRecipients,
  validateRows,
  type RecipientRow,
} from './settlementModel';

const ACCT_A = `0x${'a1'.repeat(20)}`;
const ACCT_B = `0x${'b2'.repeat(20)}`;
const PLATFORM = `0x${'cc'.repeat(20)}`;

/** A valid 100% split: 90% to an artist, plus the fixed 10% platform row. */
function validSplit(): RecipientRow[] {
  return [
    { id: '1', name: '아티스트', account: ACCT_A, bps: 9000, tag: 'artist' },
    { ...platformRow(PLATFORM), bps: 1000 },
  ];
}

describe('validateRows', () => {
  it('accepts a split that sums to exactly 100%', () => {
    const v = validateRows(validSplit());
    expect(v.ok).toBe(true);
    expect(v.sumBps).toBe(10_000);
    expect(v.error).toBe('');
  });

  it('rejects a sum that is not 100%', () => {
    const rows: RecipientRow[] = [
      { id: '1', name: '아티스트', account: ACCT_A, bps: 8000, tag: 'artist' }, // 80% + 10% = 90%
      { ...platformRow(PLATFORM), bps: 1000 },
    ];
    const v = validateRows(rows);
    expect(v.ok).toBe(false);
    expect(v.error).toBe('BAD_SUM');
    expect(v.sumBps).toBe(9000);
  });

  it('rejects a malformed recipient account', () => {
    const rows: RecipientRow[] = [
      { id: '1', name: '아티스트', account: '0xnope', bps: 9000, tag: 'artist' },
      { ...platformRow(PLATFORM), bps: 1000 },
    ];
    expect(validateRows(rows).error).toBe('BAD_ACCOUNT');
  });

  it('rejects a zero or over-100% share', () => {
    const rows: RecipientRow[] = [
      { id: '1', name: '아티스트', account: ACCT_A, bps: 0, tag: 'artist' },
      { ...platformRow(PLATFORM), bps: 1000 },
    ];
    expect(validateRows(rows).error).toBe('BAD_BPS');
  });

  it('refuses a platform row below the 5% floor', () => {
    const rows: RecipientRow[] = [
      { id: '1', name: '아티스트', account: ACCT_A, bps: 9600, tag: 'artist' },
      { ...platformRow(PLATFORM), bps: 400 }, // 4% < 5%
    ];
    expect(validateRows(rows).error).toBe('PLATFORM_LOW');
  });

  it('treats an empty editor as invalid', () => {
    expect(validateRows([]).error).toBe('EMPTY');
  });
});

describe('platformBpsOf', () => {
  it('sums every platform-tagged row', () => {
    const rows: RecipientRow[] = [
      { id: '1', name: 'a', account: ACCT_A, bps: 5000, tag: 'artist' },
      { id: '2', name: 'b', account: ACCT_B, bps: 4500, tag: 'venue' },
      { ...platformRow(PLATFORM), bps: 500 },
    ];
    expect(platformBpsOf(rows)).toBe(500);
  });
});

describe('exampleSplit', () => {
  it('splits a $30 ticket by bps and routes rounding dust to the last row', () => {
    // 33.33% / 33.33% / 33.34% of 3000 cents — floors sum to 2999, last row gets the extra cent.
    const rows: RecipientRow[] = [
      { id: '1', name: 'a', account: ACCT_A, bps: 3333, tag: 'x' },
      { id: '2', name: 'b', account: ACCT_B, bps: 3333, tag: 'y' },
      { ...platformRow(PLATFORM), bps: 3334 },
    ];
    const split = exampleSplit(rows, 3000);
    expect(split.map((s) => s.cents)).toEqual([999, 999, 1002]);
    expect(split.reduce((a, s) => a + s.cents, 0)).toBe(3000);
  });

  it('gives a clean 90/10 split exact cents', () => {
    expect(exampleSplit(validSplit(), 3000).map((s) => s.cents)).toEqual([2700, 300]);
  });
});

describe('toRecipients', () => {
  it('maps the role label to the on-chain reason', () => {
    const [artist] = toRecipients(validSplit());
    expect(artist).toEqual({ account: ACCT_A, bps: 9000, reason: '아티스트', tag: 'artist' });
  });
});

describe('percent <-> bps', () => {
  it('round-trips whole and fractional percents', () => {
    expect(percentToBps('5')).toBe(500);
    expect(percentToBps('7.5')).toBe(750);
    expect(bpsToPercent(500)).toBe('5');
    expect(bpsToPercent(750)).toBe('7.5');
  });

  it('rejects out-of-range or non-numeric percents', () => {
    expect(percentToBps('0')).toBeNull();
    expect(percentToBps('101')).toBeNull();
    expect(percentToBps('abc')).toBeNull();
  });
});

describe('row factories', () => {
  it('builds a locked 5% platform row at the given account', () => {
    const row = platformRow(PLATFORM);
    expect(row.platform).toBe(true);
    expect(row.tag).toBe('platform');
    expect(row.bps).toBe(500);
    expect(row.account).toBe(PLATFORM);
  });

  it('gives fresh blank rows distinct ids', () => {
    expect(blankRow().id).not.toBe(blankRow().id);
  });
});
