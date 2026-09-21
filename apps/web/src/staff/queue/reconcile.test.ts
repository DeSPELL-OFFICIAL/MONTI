// `fake-indexeddb/auto` installs the IndexedDB globals before anything opens a database; it has
// to be the first import in the file.
import 'fake-indexeddb/auto';

import { keccak256, toFunctionSelector, type Hex } from 'viem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The drain is stubbed, the **store is real**. Reconciliation is a read of the chain followed by
 * a write to IndexedDB, and the write is the half that matters: every assertion below reads the
 * row back through the queue's own `allEntries()` rather than trusting the report.
 */
const drainQueue = vi.fn();
const checkInOf = vi.fn();

vi.mock('./opQueue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./opQueue')>()),
  drainQueue,
}));

// Task 24's one-shot read, and the only chain call this module makes.
vi.mock('../../shared/chain/reads', () => ({ readTicket: () => ({ checkInOf }) }));

// The database comes from Task 25's store, which reaches the network to refresh snapshots.
// Only that reach is replaced — `staffDb()` below is the real IndexedDB the gate uses.
vi.mock('../../shared/api/functions', () => ({ issueSnapshot: vi.fn(), getPhotoForGate: vi.fn() }));

// Imported after the mocks, as the rest of this sub-plan's tests do: a static import would be
// hoisted above the `vi.fn()`s the factories close over.
const { reconcileQueue } = await import('./reconcile');
const { QUEUE_STORE, allEntries, retryEntry } = await import('./opQueue');
const { staffDb } = await import('../snapshot/store');

type ReconciledEntry = Awaited<ReturnType<typeof allEntries>>[number] & {
  firstGateId?: string;
  firstTs?: number;
  deny?: string;
};

const NOW = 1_700_000_000_000;
/** The chain's clock is in seconds; this is half a minute before {@link NOW}. */
const CHAIN_TS = 1_700_000_000n - 30n;

const ALREADY_CHECKED_IN = toFunctionSelector('AlreadyCheckedIn()');
/** A revert this build has a screen for, but which is not `ALREADY_USED`. */
const EVENT_ENDED = toFunctionSelector('EventEnded()');

const nonce = (mark: string) => `0x${mark.repeat(32)}` as Hex;
/** Our tap's nonce, and the one another gate's code would have carried. */
const OURS = nonce('a1');
const THEIRS = nonce('b2');

/** `Ticket.sol:360` — `keccak256(abi.encode(g.nonce))`, which for a `bytes32` is the value itself. */
const hashOf = (value: Hex) => keccak256(value);

const checkIn = (over: Partial<{ gateId: bigint; ts: bigint; nonceHash: Hex; manual: boolean }> = {}) => ({
  gateId: 9n,
  ts: CHAIN_TS,
  nonceHash: hashOf(THEIRS),
  manual: false,
  ...over,
});

/** The zero struct an unchecked ticket reads back as (`reads.ts`: `ts === 0n` is "nobody came in"). */
const NO_CHECK_IN = { gateId: 0n, ts: 0n, nonceHash: `0x${'00'.repeat(32)}` as Hex, manual: false };

let seq = 0;

interface SeedRow {
  id: string;
  tokenId: string;
  status: ReconciledEntry['status'];
  nonce?: Hex;
  lastError?: string;
  attempts?: number;
  firstGateId?: string;
  firstTs?: number;
}

/** One row straight into the store, at whatever state the drain would have left it in. */
async function seed(row: SeedRow): Promise<ReconciledEntry> {
  seq += 1;
  const taken = row.nonce ?? OURS;
  const entry = {
    id: row.id,
    tokenId: row.tokenId,
    gateCode: {
      v: 1 as const,
      gateId: '7',
      eventId: '42',
      issuedAt: NOW / 1000 - 60,
      nonce: taken,
      kx: `0x${'11'.repeat(32)}` as Hex,
      ky: `0x${'22'.repeat(32)}` as Hex,
      sig: `0x${'33'.repeat(64)}` as Hex,
    },
    response: { v: 2 as const, tokenId: row.tokenId, nonce: taken, deviceSig: `0x${'ef'.repeat(64)}` as Hex },
    createdAt: NOW,
    attempts: row.attempts ?? 1,
    nextAttemptAt: NOW,
    status: row.status,
    lastError: row.lastError,
    seq,
    firstGateId: row.firstGateId,
    firstTs: row.firstTs,
  } as ReconciledEntry;
  await (await staffDb()).put(QUEUE_STORE, entry);
  return entry;
}

const rowOf = async (id: string): Promise<ReconciledEntry | undefined> =>
  (await allEntries()).find((row) => row.id === id) as ReconciledEntry | undefined;

describe('queue reconciliation', () => {
  beforeEach(async () => {
    // Only `Date` is faked. `fake-indexeddb` schedules its request callbacks on `setImmediate`,
    // so faking the timer wheel would stop every read and write from ever settling.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    seq = 0;
    checkInOf.mockReset();
    drainQueue.mockReset();
    await (await staffDb()).clear(QUEUE_STORE);
    // The real ordering the screen sees: reconciliation drains first, then settles what is left.
    drainQueue.mockImplementation(() => allEntries());
  });

  afterEach(() => vi.useRealTimers());

  describe('a replay another gate won', () => {
    it('reports an ALREADY_USED revert as a conflict with the winning check-in', async () => {
      await seed({ id: 'a', tokenId: '123', status: 'failed', lastError: ALREADY_CHECKED_IN });
      await seed({ id: 'b', tokenId: '124', status: 'confirmed' });
      checkInOf.mockResolvedValue(checkIn({ gateId: 9n }));

      const report = await reconcileQueue({ orgId: 5n });

      expect(report.confirmed).toBe(1);
      expect(report.conflicts).toEqual([
        { tokenId: '123', firstGateId: '9', firstTs: Number(CHAIN_TS) },
      ]);
      expect(report.failed).toBe(0);
      expect(checkInOf).toHaveBeenCalledWith(123n);
    });

    it('writes the winning gate and tap time onto the row, as ALREADY_USED', async () => {
      await seed({ id: 'a', tokenId: '123', status: 'failed', lastError: ALREADY_CHECKED_IN });
      checkInOf.mockResolvedValue(checkIn({ gateId: 4n }));

      await reconcileQueue({ orgId: 5n });

      const row = await rowOf('a');
      expect(row?.status).toBe('conflict');
      expect(row?.deny).toBe('ALREADY_USED');
      expect(row?.firstGateId).toBe('4');
      expect(row?.firstTs).toBe(Number(CHAIN_TS));
    });

    it('never asks the chain about a conflict twice, and keeps reporting it', async () => {
      await seed({ id: 'a', tokenId: '123', status: 'failed', lastError: ALREADY_CHECKED_IN });
      checkInOf.mockResolvedValue(checkIn({ gateId: 9n }));
      const first = await reconcileQueue({ orgId: 5n });
      checkInOf.mockClear();

      const second = await reconcileQueue({ orgId: 5n });

      expect(checkInOf).not.toHaveBeenCalled();
      expect(second.conflicts).toEqual(first.conflicts);
      expect((await rowOf('a'))?.attempts).toBe(1);
    });

    it('counts any other failure as failed, never as admitted', async () => {
      await seed({ id: 'c', tokenId: '125', status: 'failed', lastError: EVENT_ENDED });
      await seed({ id: 'd', tokenId: '126', status: 'failed', lastError: 'LATE_WINDOW_ELAPSED' });

      const report = await reconcileQueue({ orgId: 5n });

      expect(report.failed).toBe(2);
      expect(report.conflicts).toEqual([]);
      expect(report.confirmed).toBe(0);
      // A parked entry the chain was never asked about stays parked, ready for a manual retry.
      expect(checkInOf).not.toHaveBeenCalled();
      expect((await rowOf('d'))?.status).toBe('failed');
    });

    it('settles our own op as confirmed when the revert was a second send of the same tap', async () => {
      await seed({ id: 'a', tokenId: '123', status: 'failed', lastError: ALREADY_CHECKED_IN });
      checkInOf.mockResolvedValue(checkIn({ gateId: 7n, nonceHash: hashOf(OURS) }));

      const report = await reconcileQueue({ orgId: 5n });

      expect(report.confirmed).toBe(1);
      expect(report.conflicts).toEqual([]);
      expect((await rowOf('a'))?.status).toBe('confirmed');
    });

    it('leaves the row parked when the chain cannot be read, so the next pass names the winner', async () => {
      await seed({ id: 'a', tokenId: '123', status: 'failed', lastError: ALREADY_CHECKED_IN });
      checkInOf.mockRejectedValue(new Error('offline'));

      const report = await reconcileQueue({ orgId: 5n });

      expect(report.failed).toBe(1);
      expect(report.conflicts).toEqual([]);
      expect((await rowOf('a'))?.status).toBe('failed');
    });
  });

  describe('an op whose receipt never arrived', () => {
    it('confirms a sent entry whose nonce the chain recorded', async () => {
      await seed({ id: 's', tokenId: '200', status: 'sent', lastError: 'TIMEOUT' });
      checkInOf.mockResolvedValue(checkIn({ gateId: 7n, nonceHash: hashOf(OURS), ts: CHAIN_TS }));

      const report = await reconcileQueue({ orgId: 5n });

      expect(report.confirmed).toBe(1);
      const row = await rowOf('s');
      expect(row?.status).toBe('confirmed');
      expect(row?.firstGateId).toBe('7');
      expect(row?.firstTs).toBe(Number(CHAIN_TS));
      // The timeout sentinel is not a failure and must not survive the settlement.
      expect(row?.lastError).toBeUndefined();
    });

    it('records a conflict when the chain kept a different tap on that ticket', async () => {
      await seed({ id: 's', tokenId: '200', status: 'sent', lastError: 'TIMEOUT' });
      checkInOf.mockResolvedValue(checkIn({ gateId: 3n, nonceHash: hashOf(THEIRS) }));

      const report = await reconcileQueue({ orgId: 5n });

      expect(report.conflicts).toEqual([{ tokenId: '200', firstGateId: '3', firstTs: Number(CHAIN_TS) }]);
      expect(report.confirmed).toBe(0);
      const row = await rowOf('s');
      expect(row?.status).toBe('conflict');
      expect(row?.deny).toBe('ALREADY_USED');
    });

    it('leaves a sent entry alone while the chain has nothing on that ticket', async () => {
      await seed({ id: 's', tokenId: '200', status: 'sent', lastError: 'TIMEOUT' });
      checkInOf.mockResolvedValue(NO_CHECK_IN);

      const report = await reconcileQueue({ orgId: 5n });

      // Not confirmed, not a conflict, and above all not failed: the op has not answered yet.
      expect(report).toEqual({ confirmed: 0, conflicts: [], failed: 0 });
      expect((await rowOf('s'))?.status).toBe('sent');
    });

    it('leaves a sent entry alone when the chain cannot be read', async () => {
      await seed({ id: 's', tokenId: '200', status: 'sent', lastError: 'TIMEOUT' });
      checkInOf.mockRejectedValue(new Error('offline'));

      const report = await reconcileQueue({ orgId: 5n });

      expect(report).toEqual({ confirmed: 0, conflicts: [], failed: 0 });
      expect((await rowOf('s'))?.status).toBe('sent');
    });
  });

  it('says nothing about entries still on their way', async () => {
    await seed({ id: 'p', tokenId: '300', status: 'pending' });

    const report = await reconcileQueue({ orgId: 5n });

    expect(report).toEqual({ confirmed: 0, conflicts: [], failed: 0 });
    expect(checkInOf).not.toHaveBeenCalled();
  });

  it('drains before it settles, and hands the drain its parameters', async () => {
    const isOnline = () => true;
    await reconcileQueue({ orgId: 5n, endsAt: 1_700_000_500, isOnline });

    expect(drainQueue).toHaveBeenCalledWith({ orgId: 5n, endsAt: 1_700_000_500, isOnline });
  });

  describe('manual retry', () => {
    it('re-arms a parked entry with its attempts reset', async () => {
      await seed({ id: 'd', tokenId: '126', status: 'failed', lastError: 'LATE_WINDOW_ELAPSED', attempts: 20 });

      const retried = await retryEntry('d');

      expect(retried?.status).toBe('pending');
      expect(retried?.attempts).toBe(0);
      expect(retried?.nextAttemptAt).toBe(NOW);
      expect(retried?.lastError).toBeUndefined();
      expect((await rowOf('d'))?.status).toBe('pending');
    });

    it('refuses to re-arm anything the chain has already answered', async () => {
      await seed({ id: 'x', tokenId: '127', status: 'conflict', firstGateId: '9', firstTs: 1 });
      await seed({ id: 'y', tokenId: '128', status: 'confirmed' });
      await seed({ id: 'z', tokenId: '129', status: 'sent', lastError: 'TIMEOUT' });

      expect(await retryEntry('x')).toBeUndefined();
      expect(await retryEntry('y')).toBeUndefined();
      expect(await retryEntry('z')).toBeUndefined();
      expect(await retryEntry('nobody')).toBeUndefined();
      expect((await rowOf('z'))?.status).toBe('sent');
    });
  });
});
