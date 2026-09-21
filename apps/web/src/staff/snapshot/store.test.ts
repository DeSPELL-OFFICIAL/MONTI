import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SnapshotTicket, SnapshotWire } from '@monti/shared';

import type { SnapshotStore } from '../gate/preflight';

const issueSnapshot = vi.fn();
const getPhotoForGate = vi.fn();
vi.mock('../../shared/api/functions', () => ({ issueSnapshot, getPhotoForGate }));
// The signature is `verify.test.ts`'s subject. Here it is a switch, so a store test that is
// about IndexedDB and timers does not silently become a test of secp256k1.
const verifySnapshot = vi.fn(async () => true);
vi.mock('./verify', async (orig) => ({ ...(await orig<Record<string, unknown>>()), verifySnapshot }));

const {
  clearSnapshots,
  current,
  deviceKeyOf,
  loadSnapshot,
  lookup,
  photoFor,
  refreshSnapshot,
  snapshotAgeMs,
  snapshotStore,
  staffDb,
  startSnapshotRefresh,
} = await import('./store');
const { SnapshotError } = await import('./verify');

const GATE = `0x${'aa'.repeat(20)}` as const;

const ticket: SnapshotTicket = {
  tokenId: '7',
  account: `0x${'bb'.repeat(20)}`,
  deviceX: `0x${'11'.repeat(32)}`,
  deviceY: `0x${'22'.repeat(32)}`,
  photoJpegB64: 'AAA=',
  displayName: '김입장',
  tier: 0,
  tierName: '일반',
  seat: '',
  checkedIn: false,
};

const snap: SnapshotWire = {
  v: 1,
  eventId: '42',
  eventTitle: '가을 밤 콘서트',
  requireKyc: true,
  epoch: 1,
  expiresAt: 2_000_000_000,
  tickets: [ticket],
  attesterSig: `0x${'00'.repeat(65)}`,
};

/**
 * `setImmediate` is deliberately left real. `fake-indexeddb` runs its transactions on it, so
 * faking it stops every database call from ever completing — the test would hang rather than
 * fail, which is the worst way to learn that the store is broken.
 */
const GATE_TIMERS = ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] as const;

/** Lets a refresh that was still in flight when the last test ended finish writing. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(async () => {
  vi.useRealTimers();
  await settle();
  await settle();
  await clearSnapshots();
  vi.useFakeTimers({ toFake: [...GATE_TIMERS] });
  issueSnapshot.mockReset().mockResolvedValue(snap);
  getPhotoForGate.mockReset().mockResolvedValue({ photoJpegB64: 'ZZZ=', displayName: '늦게 온 사람' });
  verifySnapshot.mockReset().mockResolvedValue(true);
});

afterEach(() => vi.useRealTimers());

describe('the staff database', () => {
  /**
   * The gate opens this database from one place. A second `openDB` at the same version with a
   * different `upgrade` would not fail — the later one simply never runs, and its store is
   * missing at a door. So the whole schema is declared here, including the two stores this
   * file never touches.
   */
  it('creates every store the staff device has, in one version', async () => {
    expect([...(await staffDb()).objectStoreNames].sort()).toEqual([
      'photos',
      'queue',
      'settings',
      'snapshots',
    ]);
  });
});

describe('fetching and keeping a snapshot', () => {
  it('fetches, verifies and persists, so a restart finds it offline', async () => {
    await refreshSnapshot('42', GATE);
    expect(verifySnapshot).toHaveBeenCalledWith(snap);
    expect(await loadSnapshot('42')).toEqual(snap);
  });

  it('sends both eventId and gateAccount so the backend can authorise the staff session', async () => {
    await refreshSnapshot('42', GATE);
    expect(issueSnapshot).toHaveBeenCalledWith({ eventId: '42', gateAccount: GATE });
  });

  it('keeps one row per event', async () => {
    await refreshSnapshot('42', GATE);
    issueSnapshot.mockResolvedValue({ ...snap, eventId: '43' });
    await refreshSnapshot('43', GATE);
    expect((await loadSnapshot('42'))?.eventId).toBe('42');
    expect((await loadSnapshot('43'))?.eventId).toBe('43');
  });

  it('ages from the moment it was fetched, and is infinitely old before the first one', async () => {
    expect(await snapshotAgeMs('42')).toBe(Number.POSITIVE_INFINITY);
    await refreshSnapshot('42', GATE);
    const fetchedAt = Date.now();
    expect(await snapshotAgeMs('42', fetchedAt + 60_000)).toBe(60_000);
  });
});

describe('what the store refuses to store', () => {
  it('rejects a snapshot the attester did not sign, and keeps the last good one', async () => {
    await refreshSnapshot('42', GATE);
    verifySnapshot.mockResolvedValueOnce(false);
    issueSnapshot.mockResolvedValueOnce({ ...snap, eventTitle: '바꿔치기' });
    await expect(refreshSnapshot('42', GATE)).rejects.toThrow('SNAPSHOT_BAD_SIG');
    expect((await loadSnapshot('42'))?.eventTitle).toBe('가을 밤 콘서트');
    expect(current()?.eventTitle).toBe('가을 밤 콘서트');
  });

  it('raises a typed SnapshotError, not a bare string', async () => {
    verifySnapshot.mockResolvedValueOnce(false);
    await expect(refreshSnapshot('42', GATE)).rejects.toBeInstanceOf(SnapshotError);
  });

  it('rejects a snapshot past the backend’s caps before it verifies anything', async () => {
    const tickets = Array.from({ length: 501 }, (_, i) => ({ ...ticket, tokenId: String(i) }));
    issueSnapshot.mockResolvedValueOnce({ ...snap, tickets });
    await expect(refreshSnapshot('42', GATE)).rejects.toThrow('SNAPSHOT_TOO_LARGE');
    expect(verifySnapshot).not.toHaveBeenCalled();
    expect(await loadSnapshot('42')).toBeUndefined();
  });

  it('keeps the last good snapshot when a refresh fails offline', async () => {
    await refreshSnapshot('42', GATE);
    issueSnapshot.mockRejectedValueOnce(new Error('offline'));
    await expect(refreshSnapshot('42', GATE)).rejects.toThrow('offline');
    expect(await loadSnapshot('42')).toEqual(snap);
  });

  it('propagates a permission-denied from the callable instead of pretending to be offline', async () => {
    issueSnapshot.mockRejectedValueOnce(
      Object.assign(new Error('permission-denied'), { code: 'functions/permission-denied' }),
    );
    await expect(refreshSnapshot('42', GATE)).rejects.toThrow('permission-denied');
  });
});

describe('the ten-minute refresh', () => {
  it('refreshes every 10 minutes and stops when disposed', async () => {
    const stop = startSnapshotRefresh('42', GATE);
    await vi.advanceTimersByTimeAsync(600_000 * 2);
    expect(issueSnapshot).toHaveBeenCalledTimes(3);
    stop();
    await vi.advanceTimersByTimeAsync(600_000 * 2);
    expect(issueSnapshot).toHaveBeenCalledTimes(3);
  });

  it('keeps running after a failed refresh — one dropped connection is not the end of the door', async () => {
    issueSnapshot.mockRejectedValueOnce(new Error('offline'));
    const stop = startSnapshotRefresh('42', GATE);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(issueSnapshot).toHaveBeenCalledTimes(2);
    expect(current()).toEqual(snap);
    stop();
  });

  it('serves the snapshot last session stored, before this session’s first fetch answers', async () => {
    // The gate is reopened in an aeroplane hangar with no signal. The row survived; memory did not.
    await (await staffDb()).put('snapshots', { eventId: '42', snapshot: snap, fetchedAt: Date.now() });
    expect(current()).toBeUndefined();

    issueSnapshot.mockRejectedValue(new Error('offline'));
    const stop = startSnapshotRefresh('42', GATE);
    await vi.advanceTimersByTimeAsync(0);
    expect(current()).toEqual(snap);
    stop();
  });
});

describe('what the gate asks the store', () => {
  beforeEach(async () => {
    await refreshSnapshot('42', GATE);
  });

  it('satisfies Task 20’s SnapshotStore, which is what preflight reads', () => {
    const store: SnapshotStore = snapshotStore();
    expect(store.current()).toEqual(snap);
  });

  it('lookup finds the row, and says so plainly when it does not', () => {
    expect(lookup('7')).toEqual({ known: true, ticket });
    expect(lookup('999')).toEqual({ known: false });
  });

  it('deviceKeyOf gives Task 27 the key an offline deviceSig is checked against', () => {
    expect(deviceKeyOf('7')).toEqual({ x: ticket.deviceX, y: ticket.deviceY });
    expect(deviceKeyOf('999')).toBeUndefined();
  });
});

describe('photos', () => {
  it('uses the one the signed snapshot already carries and asks the backend for nothing', async () => {
    await refreshSnapshot('42', GATE);
    expect(await photoFor('7', GATE)).toEqual({ photoJpegB64: 'AAA=', displayName: '김입장' });
    expect(getPhotoForGate).not.toHaveBeenCalled();
  });

  it('asks getPhotoForGate for a ticket issued since the snapshot was taken, then caches it', async () => {
    await refreshSnapshot('42', GATE);
    expect(await photoFor('999', GATE)).toEqual({ photoJpegB64: 'ZZZ=', displayName: '늦게 온 사람' });
    expect(getPhotoForGate).toHaveBeenCalledWith({ tokenId: '999', gateAccount: GATE });

    expect(await photoFor('999', GATE)).toEqual({ photoJpegB64: 'ZZZ=', displayName: '늦게 온 사람' });
    expect(getPhotoForGate).toHaveBeenCalledTimes(1);
    expect(await (await staffDb()).get('photos', '999')).toMatchObject({ tokenId: '999' });
  });
});
