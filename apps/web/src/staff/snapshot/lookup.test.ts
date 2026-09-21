import { describe, expect, it } from 'vitest';

import type { SnapshotWire } from '@monti/shared';

import { DENY_CODES, type Hex, type SnapshotTicket } from '../types';

import { deviceKeyIn, lookupIn, snapshotDeny } from './lookup';

const ticket: SnapshotTicket = {
  tokenId: '123',
  account: `0x${'aa'.repeat(20)}`,
  deviceX: `0x${'11'.repeat(32)}`,
  deviceY: `0x${'22'.repeat(32)}`,
  photoJpegB64: 'x',
  displayName: '김입장',
  tier: 0,
  tierName: '일반',
  seat: '',
  checkedIn: false,
};

const snapshot: SnapshotWire = {
  v: 1,
  eventId: '42',
  eventTitle: '가을 밤 콘서트',
  requireKyc: true,
  epoch: 1,
  expiresAt: 2_000_000_000,
  tickets: [ticket],
  attesterSig: `0x${'00'.repeat(65)}`,
};

const ZERO = `0x${'00'.repeat(32)}` as const;

describe('lookupIn', () => {
  it('hands back the row the snapshot carries', () => {
    expect(lookupIn(snapshot, '123')).toEqual({ known: true, ticket });
  });

  /**
   * The third answer, and the one that is easiest to get wrong. A token the snapshot has never
   * heard of is **not** a refusal: the snapshot is a photograph and the ticket may have been
   * issued after it was taken. Online the chain decides; offline Task 27 refuses, and it says
   * so there rather than here.
   */
  it('says "never heard of it" rather than refusing, because the snapshot may be stale', () => {
    expect(lookupIn(snapshot, '999')).toEqual({ known: false });
    expect(lookupIn(undefined, '123')).toEqual({ known: false });
  });

  it('carries the refusal the row alone justifies', () => {
    const used = { ...snapshot, tickets: [{ ...ticket, checkedIn: true }] };
    expect(lookupIn(used, '123')).toEqual({ known: true, ticket: used.tickets[0], deny: 'ALREADY_USED' });
  });
});

describe('snapshotDeny', () => {
  it('ALREADY_USED when the snapshot already carries the check-in', () => {
    expect(snapshotDeny({ ...ticket, checkedIn: true })).toBe('ALREADY_USED');
  });

  it('DEVICE_LOCKED when either half of the device key has been cleared', () => {
    expect(snapshotDeny({ ...ticket, deviceX: ZERO })).toBe('DEVICE_LOCKED');
    expect(snapshotDeny({ ...ticket, deviceY: ZERO })).toBe('DEVICE_LOCKED');
  });

  it('compares the cleared key case-insensitively — the hex casing is the attester’s choice', () => {
    // `0X00…` is still 32 cleared bytes. Slipping past here hands a locked device to the chain.
    expect(snapshotDeny({ ...ticket, deviceX: `0X${'00'.repeat(32)}` as Hex })).toBe('DEVICE_LOCKED');
  });

  it('nothing at all for a fresh, unused ticket', () => {
    expect(snapshotDeny(ticket)).toBeUndefined();
  });

  /**
   * The refusal vocabulary is `staff/types.ts`'s thirteen (Task 22), which is itself
   * `@monti/shared`'s list. A word invented here would be a screen the attendee never sees.
   */
  it('only ever names a code from the shared DENY list', () => {
    const codes = [
      snapshotDeny({ ...ticket, checkedIn: true }),
      snapshotDeny({ ...ticket, deviceX: ZERO }),
    ];
    for (const code of codes) expect(DENY_CODES).toContain(code);
  });
});

describe('deviceKeyIn', () => {
  it('gives Task 27 the key it checks an offline deviceSig against', () => {
    expect(deviceKeyIn(snapshot, '123')).toEqual({ x: ticket.deviceX, y: ticket.deviceY });
  });

  it('gives nothing for an unknown token', () => {
    expect(deviceKeyIn(snapshot, '999')).toBeUndefined();
    expect(deviceKeyIn(undefined, '123')).toBeUndefined();
  });

  /** A cleared key is not a key. Handing 32 zero bytes to a verifier is how it says "valid". */
  it('gives nothing for a locked device rather than 32 zero bytes', () => {
    expect(deviceKeyIn({ ...snapshot, tickets: [{ ...ticket, deviceX: ZERO }] }, '123')).toBeUndefined();
    expect(deviceKeyIn({ ...snapshot, tickets: [{ ...ticket, deviceY: ZERO }] }, '123')).toBeUndefined();
  });
});
