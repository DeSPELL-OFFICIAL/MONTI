import { describe, expect, it } from 'vitest';
import {
  bpsToPercent,
  blankRow,
  exampleSplit,
  parseSplit,
  percentToBps,
  serializeSplit,
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

describe('validateRows — what the vault and the relayer refuse', () => {
  it('refuses more than ten recipients (the vault takes 1–10)', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ id: String(i), name: `r${i}`, account: ACCT_A, bps: 950, tag: 't' }));
    expect(validateRows([...many, { ...platformRow(PLATFORM), bps: 500 }]).error).toBe('TOO_MANY');
  });

  it('refuses a role name over 80 characters (the relayer caps each reason)', () => {
    const rows = validSplit();
    rows[0] = { ...(rows[0] as RecipientRow), name: 'ㄱ'.repeat(81) };
    expect(validateRows(rows).error).toBe('NAME_TOO_LONG');
  });

  it('refuses a tag that does not fit in 32 bytes', () => {
    const rows = validSplit();
    rows[0] = { ...(rows[0] as RecipientRow), tag: '가'.repeat(11) }; // 33 bytes of UTF-8
    expect(validateRows(rows).error).toBe('BAD_TAG');
  });
});

describe('splitJson — the draft carries the rows as one string', () => {
  it('round-trips the rows without their React ids', () => {
    const json = serializeSplit(validSplit());
    expect(JSON.parse(json)).toEqual([
      { name: '아티스트', account: ACCT_A, bps: 9000, tag: 'artist', platform: false },
      { name: 'MONTI platform', account: PLATFORM, bps: 1000, tag: 'platform', platform: true },
    ]);
    const back = parseSplit(json, PLATFORM);
    expect(back.map(({ id: _id, ...row }) => row)).toEqual([
      { name: '아티스트', account: ACCT_A, bps: 9000, tag: 'artist', platform: false },
      { name: 'MONTI platform', account: PLATFORM, bps: 1000, tag: 'platform', platform: true },
    ]);
    expect(new Set(back.map((row) => row.id)).size).toBe(2);
  });

  it('starts from the one locked 5% platform row when there is nothing stored', () => {
    for (const empty of ['', 'not json', '{"a":1}', '[]']) {
      const rows = parseSplit(empty, PLATFORM);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ platform: true, account: PLATFORM, bps: 500, tag: 'platform' });
    }
  });

  it('pins the platform row to the configured account, whatever the draft says', () => {
    const json = JSON.stringify([{ name: 'x', account: ACCT_B, bps: 600, tag: 'platform', platform: true }]);
    expect(parseSplit(json, PLATFORM)[0]).toMatchObject({ account: PLATFORM, bps: 600, platform: true });
  });

  it('fits the draft rule cap even at the largest split the editor accepts', () => {
    const widest = Array.from({ length: 10 }, (_, i) => ({
      id: String(i), name: 'ㄱ'.repeat(80), account: ACCT_A, bps: 1000, tag: 'x'.repeat(32),
    }));
    expect(validateRows(widest).ok).toBe(true);
    expect(serializeSplit(widest).length).toBeLessThanOrEqual(4_000);
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
