import { describe, expect, it } from 'vitest';
import { buildSegments } from './segments';
import { settlementCopy as t } from './copy';

const sum = (segments: { bps: number }[]): number => segments.reduce((acc, s) => acc + s.bps, 0);

describe('buildSegments', () => {
  it('does not add a second platform row when the saved recipients already carry it', () => {
    const recipients = [
      { account: '0x01', bps: 500, reason: 'MONTI 플랫폼', tag: 'platform' },
      { account: '0x02', bps: 7000, reason: '공연팀', tag: 'artist' },
      { account: '0x03', bps: 1500, reason: '장소', tag: 'venue' },
      { account: '0x04', bps: 1000, reason: '스태프', tag: 'staff' },
    ];
    const segments = buildSegments({ recipients: recipients as never, platformBps: 500 }, recipients, 3000);
    expect(segments).toHaveLength(4);
    expect(sum(segments)).toBe(10000);
    expect(segments.filter((s) => s.label === 'MONTI 플랫폼')).toHaveLength(1);
  });

  it('appends the platform share for a legacy policy whose recipients leave it out', () => {
    const recipients = [
      { account: '0x02', bps: 7000, reason: '공연팀', tag: 'artist' },
      { account: '0x03', bps: 2500, reason: '장소', tag: 'venue' },
    ];
    const segments = buildSegments({ recipients: recipients as never, platformBps: 500 }, recipients, 3000);
    expect(segments).toHaveLength(3);
    expect(segments[2]?.label).toBe(t.platformLabel);
    expect(sum(segments)).toBe(10000);
  });

  it('fills an unassigned remainder with the reserve so the bar still totals 100%', () => {
    const recipients = [
      { account: '0x01', bps: 500, reason: 'MONTI 플랫폼', tag: 'platform' },
      { account: '0x02', bps: 7000, reason: '공연팀', tag: 'artist' },
    ];
    const segments = buildSegments({ recipients: recipients as never, platformBps: 500 }, recipients, 3000);
    expect(segments.at(-1)?.label).toBe(t.reserveLabel);
    expect(segments.at(-1)?.bps).toBe(2500);
    expect(sum(segments)).toBe(10000);
  });
});
