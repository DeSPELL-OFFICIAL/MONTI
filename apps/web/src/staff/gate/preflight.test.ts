import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { GateCodeWire, GateResponseWire, SnapshotTicket, SnapshotWire } from '@monti/shared';

// The pending-table read reaches Firestore. Only that reach is replaced; the rest of preflight is
// the shipped pure code.
const getDoc = vi.fn();
vi.mock('firebase/firestore', () => ({ doc: (...args: unknown[]) => args, getDoc }));
vi.mock('../../shared/api/firebase', () => ({ getDb: () => ({}) }));

const {
  ADMISSION_DUPLICATE_WINDOW_MS,
  admissionsDuplicate,
  isUnknownToSnapshot,
  preflight,
  recognisedTicket,
  stubSnapshotStore,
} = await import('./preflight');

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

const code: GateCodeWire = {
  v: 1,
  gateId: '7',
  eventId: '42',
  issuedAt: 1_700_000_000,
  nonce: `0x${'11'.repeat(32)}`,
  kx: `0x${'aa'.repeat(32)}`,
  ky: `0x${'bb'.repeat(32)}`,
  sig: `0x${'cc'.repeat(64)}`,
};

const response: GateResponseWire = {
  v: 2,
  tokenId: '123',
  nonce: code.nonce,
  deviceSig: `0x${'22'.repeat(64)}`,
};

describe('the snapshot store this reads through', () => {
  it('answers with the snapshot it was given, and with nothing before the first sync', () => {
    expect(stubSnapshotStore(snapshot).current()).toBe(snapshot);
    expect(stubSnapshotStore().current()).toBeUndefined();
  });
});

describe('preflight against the signed snapshot', () => {
  it('passes a fresh, unused ticket of this event and hands the screen its row', () => {
    const result = preflight({ snapshot, code, response });
    expect(result).toEqual({ ok: true, ticket });
    expect(recognisedTicket(result)).toBe(ticket);
    expect(isUnknownToSnapshot(result)).toBe(false);
  });

  it('ALREADY_USED when the snapshot already carries the check-in', () => {
    const used = { ...snapshot, tickets: [{ ...ticket, checkedIn: true }] };
    const result = preflight({ snapshot: used, code, response });
    expect(result.ok).toBe(false);
    expect(result.deny).toBe('ALREADY_USED');
    // The row still comes back: the staff screen shows who was already let in.
    expect(result.ticket?.tokenId).toBe('123');
  });

  it('WRONG_EVENT when the gate’s snapshot and the gate’s own code disagree', () => {
    const result = preflight({ snapshot: { ...snapshot, eventId: '43' }, code, response });
    expect(result).toEqual({ ok: false, deny: 'WRONG_EVENT' });
  });

  it('DEVICE_LOCKED when the snapshot carries no device key for the ticket', () => {
    const zero = `0x${'00'.repeat(32)}` as const;
    // Upper case too: the snapshot's hex casing is the attester's choice, and a missed match
    // here would hand a locked device to the chain as though nothing were wrong.
    const upper = `0x${'00'.repeat(32)}`.toUpperCase() as `0x${string}`;
    for (const cleared of [{ deviceX: zero }, { deviceY: zero }, { deviceX: upper }, { deviceY: upper }]) {
      const locked = { ...snapshot, tickets: [{ ...ticket, ...cleared }] };
      expect(preflight({ snapshot: locked, code, response }).deny).toBe('DEVICE_LOCKED');
    }
  });
});

/**
 * The third answer, and the one that is easiest to get wrong: `ok` with no ticket. The snapshot
 * did not recognise the token and said so by passing it on, because a snapshot is a photograph
 * and the ticket may have been issued after it was taken.
 */
describe('a token the snapshot has never heard of', () => {
  it('is passed to the chain rather than refused — the snapshot may be stale', () => {
    const result = preflight({ snapshot, code, response: { ...response, tokenId: '999' } });
    expect(result).toEqual({ ok: true });
    expect(isUnknownToSnapshot(result)).toBe(true);
    expect(recognisedTicket(result)).toBeUndefined();
  });

  it('reads the same way before the first sync lands', () => {
    const result = preflight({ snapshot: stubSnapshotStore().current(), code, response });
    expect(result).toEqual({ ok: true });
    expect(isUnknownToSnapshot(result)).toBe(true);
  });

  /**
   * A revoked ticket is simply absent from the snapshot — there is no `revoked` flag on a row —
   * so it is indistinguishable here from one issued since the last sync. The chain tells them
   * apart with `TicketRevoked`, which Task 22 maps to `REVOKED`.
   */
  it('is how a revoked ticket looks locally, which is why it is not a local DENY', () => {
    const revoked = { ...snapshot, tickets: [] };
    expect(preflight({ snapshot: revoked, code, response })).toEqual({ ok: true });
  });
});

describe('what preflight refuses to do', () => {
  it('never admits: a pass is a send, and carries no verdict of its own', () => {
    const result = preflight({ snapshot, code, response });
    expect(result.ok).toBe(true);
    expect(result.deny).toBeUndefined();
    expect(Object.keys(result).sort()).toEqual(['ok', 'ticket']);
  });

  it('every refusal names why, so nothing reaches the screen without a reason', () => {
    const cases = [
      preflight({ snapshot: { ...snapshot, eventId: '43' }, code, response }),
      preflight({ snapshot: { ...snapshot, tickets: [{ ...ticket, checkedIn: true }] }, code, response }),
    ];
    for (const result of cases) {
      expect(result.ok).toBe(false);
      expect(result.deny).toBeDefined();
    }
  });
});

/**
 * The ~1 s cross-gate window (design §6): the pending table read that refuses a ticket another
 * online gate is already admitting, before this gate spends the round trip.
 */
describe('the pending-admission read across gates', () => {
  const NOW = 1_700_000_000_000;
  const withDoc = (data: Record<string, unknown> | undefined) =>
    getDoc.mockResolvedValueOnce({ data: () => data });

  beforeEach(() => getDoc.mockReset());

  it('refuses a ticket a confirmed mark already carries', async () => {
    withDoc({ status: 'confirmed', gateId: '9' });
    expect(await admissionsDuplicate({ eventId: '42', tokenId: '123', now: NOW })).toEqual({ deny: 'ALREADY_USED' });
  });

  it('refuses a passing mark that is still inside the window', async () => {
    withDoc({ status: 'passing', gateId: '9', passedAt: { toMillis: () => NOW - 2_000 } });
    expect(await admissionsDuplicate({ eventId: '42', tokenId: '123', now: NOW })).toEqual({ deny: 'ALREADY_USED' });
  });

  it('lets a stale passing mark through — that check-in never landed', async () => {
    withDoc({ status: 'passing', gateId: '9', passedAt: { toMillis: () => NOW - ADMISSION_DUPLICATE_WINDOW_MS - 1 } });
    expect(await admissionsDuplicate({ eventId: '42', tokenId: '123', now: NOW })).toBeUndefined();
  });

  it('is not a duplicate for a failed mark, a missing document, or an unreadable one', async () => {
    withDoc({ status: 'failed' });
    expect(await admissionsDuplicate({ eventId: '42', tokenId: '123', now: NOW })).toBeUndefined();
    withDoc(undefined);
    expect(await admissionsDuplicate({ eventId: '42', tokenId: '123', now: NOW })).toBeUndefined();
    getDoc.mockRejectedValueOnce(new Error('offline'));
    expect(await admissionsDuplicate({ eventId: '42', tokenId: '123', now: NOW })).toBeUndefined();
  });
});
