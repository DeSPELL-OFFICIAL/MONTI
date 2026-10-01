import { describe, expect, it } from 'vitest';
import { keccak256, toBytes } from 'viem';
import {
  buildReasonLookup,
  percentFromBps,
  reasonForPayout,
  shortHex,
  usdFromBaseUnits,
  usdFromCents,
} from './format';

describe('settlement amount formatting', () => {
  it('renders 6-dp USDC base units as two-decimal dollars', () => {
    expect(usdFromBaseUnits('30000000')).toBe('$30.00');
    expect(usdFromBaseUnits('21500000')).toBe('$21.50');
    expect(usdFromBaseUnits(0n)).toBe('$0.00');
    expect(usdFromBaseUnits('')).toBe('$0.00');
  });

  it('renders stored cents as dollars', () => {
    expect(usdFromCents(3000)).toBe('$30.00');
    expect(usdFromCents(450)).toBe('$4.50');
  });

  it('turns basis points into a percentage a person reads', () => {
    expect(percentFromBps(7000)).toBe('70%');
    expect(percentFromBps(500)).toBe('5%');
    expect(percentFromBps(1250)).toBe('12.5%');
  });

  it('shortens long hex and leaves short values alone', () => {
    expect(shortHex(`0x${'ab'.repeat(20)}`)).toBe('0xabab…abab');
    expect(shortHex('0x1234')).toBe('0x1234');
  });
});

describe('payout reason mapping', () => {
  const recipients = [
    { account: `0x${'aa'.repeat(20)}`, bps: 7000, reason: '공연팀', tag: '아티스트' },
    { account: `0x${'bb'.repeat(20)}`, bps: 2000, reason: '', tag: '장소' },
  ];

  it('matches the on-chain reasonHash back to the human reason', () => {
    const lookup = buildReasonLookup(recipients);
    const hash = keccak256(toBytes('공연팀'));
    expect(reasonForPayout({ recipient: '0xZZZ', reasonHash: hash }, lookup, 0)).toBe('공연팀');
  });

  it('falls back to the recipient tag by address when there is no reason hash', () => {
    const lookup = buildReasonLookup(recipients);
    expect(reasonForPayout({ recipient: `0x${'BB'.repeat(20)}`, reasonHash: '0xdead' }, lookup, 1)).toBe('장소');
  });

  it('falls back to a numbered placeholder when nothing matches', () => {
    const lookup = buildReasonLookup(recipients);
    expect(reasonForPayout({ recipient: '0xunknown', reasonHash: '0xdead' }, lookup, 4)).toBe('수령인 5');
  });
});
