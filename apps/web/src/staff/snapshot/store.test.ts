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
  clearAll,
  clearSnapshotData,
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

/**
 * Lets work that is mid-flight finish. `fake-indexeddb` commits on `setImmediate`, and a refresh
 * is several of those deep (callable → verify → open → put), so draining takes more than one
 * turn. Fake timers cannot help: the database does not run on them.
 */
const settle = async (turns = 8): Promise<void> => {
  for (let turn = 0; turn < turns; turn += 1) await new Promise((resolve) => setImmediate(resolve));
};

beforeEach(async () => {
  vi.useRealTimers();
  await settle();
  await clearAll();
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
    await settle();
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
    await settle();
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
  });

  it('gives a cached face no more life than the guest list it was fetched against', async () => {
    await refreshSnapshot('42', GATE);
    await photoFor('999', GATE);
    expect(await (await staffDb()).get('photos', '999')).toMatchObject({ expiresAt: snap.expiresAt });
  });

  /**
   * The point of the whole store: a plaintext JPEG of somebody's face does not outlive the
   * signed list it belongs to. Past `expiresAt` the row is dropped, not served.
   */
  it('refuses to serve a face past its expiry, and drops the row', async () => {
    await refreshSnapshot('42', GATE);
    const db = await staffDb();
    await db.put('photos', {
      tokenId: '999',
      photoJpegB64: 'OLD=',
      displayName: '어제 온 사람',
      fetchedAt: Date.now() - 1_000,
      expiresAt: Math.floor(Date.now() / 1000) - 1,
    });

    expect(await photoFor('999', GATE)).toEqual({ photoJpegB64: 'ZZZ=', displayName: '늦게 온 사람' });
    expect(getPhotoForGate).toHaveBeenCalledTimes(1);
  });
});

/**
 * Faces are the one thing on this terminal that the backend decrypts per call, writes a PII
 * audit row for, and cannot take back. Everything below is about them not outstaying their use.
 */
describe('how long a face stays on the phone', () => {
  const stalePhoto = {
    tokenId: '999',
    photoJpegB64: 'OLD=',
    displayName: '어제 온 사람',
    fetchedAt: Date.now(),
    expiresAt: 2_000_000_000,
  };

  it('prunes the photo cache on every successful refresh', async () => {
    await refreshSnapshot('42', GATE);
    await (await staffDb()).put('photos', stalePhoto);

    await refreshSnapshot('42', GATE);
    expect(await (await staffDb()).get('photos', '999')).toBeUndefined();
  });

  it('prunes nothing when the refresh failed — the gate keeps working on what it has', async () => {
    await refreshSnapshot('42', GATE);
    await (await staffDb()).put('photos', stalePhoto);

    issueSnapshot.mockRejectedValueOnce(new Error('offline'));
    await expect(refreshSnapshot('42', GATE)).rejects.toThrow('offline');
    expect(await (await staffDb()).get('photos', '999')).toMatchObject({ tokenId: '999' });
  });

  it('reaps another event’s snapshot once past the expiry the attester signed', async () => {
    const db = await staffDb();
    await db.put('snapshots', {
      eventId: '7',
      snapshot: { ...snap, eventId: '7', expiresAt: Math.floor(Date.now() / 1000) - 1 },
      fetchedAt: Date.now(),
    });

    await refreshSnapshot('42', GATE);
    expect(await db.get('snapshots', '7')).toBeUndefined();
    expect(await db.get('snapshots', '42')).toBeDefined();
  });

  it('will not serve an expired snapshot offline, and drops it', async () => {
    const db = await staffDb();
    await db.put('snapshots', {
      eventId: '42',
      snapshot: { ...snap, expiresAt: Math.floor(Date.now() / 1000) - 1 },
      fetchedAt: Date.now(),
    });

    expect(await loadSnapshot('42')).toBeUndefined();
    expect(current()).toBeUndefined();
    expect(await db.get('snapshots', '42')).toBeUndefined();
  });

  it('erases the faces when the gate closes, and keeps the queue', async () => {
    await refreshSnapshot('42', GATE);
    await photoFor('999', GATE);
    const db = await staffDb();
    await db.put('queue', { id: 'q1', tokenId: '7' });

    const stop = startSnapshotRefresh('42', GATE);
    await vi.advanceTimersByTimeAsync(0);
    stop();
    await settle();

    expect(await db.getAll('snapshots')).toEqual([]);

    expect(await db.getAll('photos')).toEqual([]);
    expect(current()).toBeUndefined();
    // A queued entry is a person who already walked in. Closing a screen does not unadmit them.
    expect(await db.get('queue', 'q1')).toMatchObject({ id: 'q1' });
  });

  it('clearAll empties every store — the phone handed to the next shift', async () => {
    const db = await staffDb();
    await refreshSnapshot('42', GATE);
    await photoFor('999', GATE);
    await db.put('queue', { id: 'q1', tokenId: '7' });
    await db.put('settings', { key: 'gateId', value: '7' });

    await clearAll();

    for (const store of ['snapshots', 'photos', 'queue', 'settings'] as const) {
      expect(await db.getAll(store)).toEqual([]);
    }
    expect(current()).toBeUndefined();
  });

  /**
   * The narrow window the whole `era` counter exists for, on the path that matters most: the
   * one that produces a plaintext JPEG. A tap resolves, the callable is decrypting a face on the
   * backend, and the staff member closes the gate before the answer lands. The answer still
   * reaches the caller — they may be looking at the person — but it is never written down.
   */
  it('never stores a face that arrived after the gate closed', async () => {
    await refreshSnapshot('42', GATE);
    const db = await staffDb();

    let answer: (value: { photoJpegB64: string; displayName: string }) => void = () => undefined;
    getPhotoForGate.mockReturnValueOnce(new Promise((resolve) => { answer = resolve; }));
    const inFlight = photoFor('999', GATE);
    await settle();

    await clearSnapshotData();
    answer({ photoJpegB64: 'LATE=', displayName: '문 닫은 뒤' });

    // The caller is still answered — they asked before the gate closed.
    expect(await inFlight).toEqual({ photoJpegB64: 'LATE=', displayName: '문 닫은 뒤' });
    await settle();
    expect(await db.getAll('photos')).toEqual([]);
  });

  it('clearSnapshotData is the same thing without touching the queue', async () => {
    const db = await staffDb();
    await refreshSnapshot('42', GATE);
    await db.put('queue', { id: 'q1', tokenId: '7' });

    await clearSnapshotData();

    expect(await db.getAll('snapshots')).toEqual([]);
    expect(await db.get('queue', 'q1')).toMatchObject({ id: 'q1' });
  });
});
