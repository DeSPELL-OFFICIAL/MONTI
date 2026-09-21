// `fake-indexeddb/auto` installs the IndexedDB globals before anything opens a database; it has
// to be the first import in the file.
import 'fake-indexeddb/auto';

import type { Abi } from 'viem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sendCheckIn = vi.fn();
vi.mock('../gate/checkInOp', () => ({ sendCheckIn }));

// The database comes from Task 25's store, which reaches the network to refresh snapshots.
// Only that reach is replaced — `staffDb()` below is the real IndexedDB the gate uses.
vi.mock('../../shared/api/functions', () => ({ issueSnapshot: vi.fn(), getPhotoForGate: vi.fn() }));

/**
 * The ABI the queue's gate reads, made mutable so both branches can be exercised in one file.
 * The array identity never changes — the module under test reads `ticketAbi` at drain time, so
 * pushing the fragment in turns the real send path on and emptying it turns the dry run on.
 */
const ticketAbi: unknown[] = [];
vi.mock('../../shared/chain/abis', () => ({ ticketAbi }));

// Imported after the mocks, as the rest of this sub-plan's tests do: a static import would be
// hoisted above the `vi.fn()`s the factories close over.
const {
  BACKOFF_CAP_MS,
  DRY_RUN_MARK,
  LATE_WINDOW_ELAPSED,
  MAX_ATTEMPTS,
  QUEUE_STORE,
  allEntries,
  backoffMs,
  drainQueue,
  enqueueCheckIn,
  hasLateCheckIn,
  pendingCount,
} = await import('./opQueue');
const { staffDb } = await import('../snapshot/store');

/** 01b's `checkInLate(uint256,(uint256,uint256,uint64,bytes32),bytes)`, name only — the gate
 *  looks the name up and nothing else. */
const CHECK_IN_LATE_FRAGMENT = {
  type: 'function',
  name: 'checkInLate',
  stateMutability: 'nonpayable',
  inputs: [],
  outputs: [],
};

const NOW = 1_700_000_000_000;
/** Codes are issued in seconds; this one is one minute old at {@link NOW}. */
const ISSUED_AT = NOW / 1000 - 60;

const code = (nonce: string) => ({
  v: 1 as const,
  gateId: '7',
  eventId: '42',
  issuedAt: ISSUED_AT,
  nonce: `0x${nonce.repeat(32)}` as const,
  kx: `0x${'11'.repeat(32)}` as const,
  ky: `0x${'22'.repeat(32)}` as const,
  sig: `0x${'33'.repeat(64)}` as const,
});

const response = (tokenId: string, nonce: string) => ({
  v: 2 as const,
  tokenId,
  nonce: `0x${nonce.repeat(32)}` as const,
  deviceSig: `0x${'ef'.repeat(64)}` as const,
});

const tap = (tokenId: string, nonce: string) =>
  enqueueCheckIn({ code: code(nonce), response: response(tokenId, nonce), orgId: 5n });

const landed = () => ({
  userOpHash: '0xfeed' as const,
  wait: async () => ({ success: true, blockNumber: 9n, txHash: '0xabc' as const }),
});

describe('durable check-in queue', () => {
  beforeEach(async () => {
    // Only `Date` is faked. `fake-indexeddb` schedules its request callbacks on `setImmediate`,
    // so faking the timer wheel would stop every read and write from ever settling — the clock
    // is what these tests need deterministic, not the event loop.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    sendCheckIn.mockReset();
    ticketAbi.length = 0;
    ticketAbi.push(CHECK_IN_LATE_FRAGMENT);
    await (await staffDb()).clear(QUEUE_STORE);
  });

  afterEach(() => vi.useRealTimers());

  describe('backoff', () => {
    it('doubles from a second and caps at a minute', () => {
      expect(backoffMs(0)).toBe(1000);
      expect(backoffMs(1)).toBe(2000);
      expect(backoffMs(3)).toBe(8000);
      expect(backoffMs(6)).toBe(BACKOFF_CAP_MS);
      expect(backoffMs(20)).toBe(BACKOFF_CAP_MS);
    });
  });

  describe('persisting', () => {
    it('resolves only after the write has committed, so the offline card cannot show first', async () => {
      // Count `complete` events, which is the only thing that says the data is durable: a
      // resolved `put` request is still inside an open transaction and dies with the process.
      const originalTransaction = IDBDatabase.prototype.transaction;
      let commits = 0;
      IDBDatabase.prototype.transaction = function patched(
        this: IDBDatabase,
        ...args: Parameters<IDBDatabase['transaction']>
      ) {
        const tx = originalTransaction.apply(this, args);
        tx.addEventListener('complete', () => {
          commits += 1;
        });
        return tx;
      } as IDBDatabase['transaction'];

      let entry;
      try {
        entry = await enqueueCheckIn({ code: code('ab'), response: response('123', 'ab'), orgId: 5n });
        expect(commits).toBeGreaterThan(0);
      } finally {
        IDBDatabase.prototype.transaction = originalTransaction;
      }

      // And a second connection — which only ever sees committed data — finds the row.
      const committed = await new Promise<unknown>((resolve, reject) => {
        const open = indexedDB.open('monti-staff');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const get = db.transaction(QUEUE_STORE, 'readonly').objectStore(QUEUE_STORE).get(entry.id);
          get.onsuccess = () => {
            db.close();
            resolve(get.result);
          };
          get.onerror = () => reject(get.error);
        };
      });

      expect(committed).toMatchObject({ id: entry.id, tokenId: '123', status: 'pending', attempts: 0 });
      expect(await pendingCount()).toBe(1);
    });

    it('keeps the tap order the taps happened in, not the order the ids sort in', async () => {
      const first = await tap('900', 'ff');
      const second = await tap('100', 'aa');

      expect(first.id > second.id).toBe(true);
      expect((await allEntries()).map((e) => e.tokenId)).toEqual(['900', '100']);
    });
  });

  describe('draining', () => {
    it('flushes in tap order through checkInLate', async () => {
      await tap('900', 'ff');
      await tap('100', 'aa');
      sendCheckIn.mockResolvedValue(landed());

      await drainQueue({ orgId: 5n });

      expect(sendCheckIn.mock.calls.map(([p]) => p.response.tokenId)).toEqual(['900', '100']);
      expect(sendCheckIn.mock.calls.every(([p]) => p.functionName === 'checkInLate')).toBe(true);
      expect(sendCheckIn.mock.calls.every(([p]) => p.orgId === 5n)).toBe(true);
    });

    it('marks an entry confirmed when the op lands', async () => {
      const entry = await tap('777', 'cc');
      sendCheckIn.mockResolvedValueOnce(landed());

      const after = await drainQueue({ orgId: 5n, now: entry.nextAttemptAt });

      const row = after.find((e) => e.id === entry.id);
      expect(row?.status).toBe('confirmed');
      expect(row?.userOpHash).toBe('0xfeed');
      expect(await pendingCount()).toBe(0);
    });

    it('leaves a send failure pending with a longer wait', async () => {
      const entry = await tap('778', 'dd');
      sendCheckIn.mockRejectedValueOnce(new Error('bundler unreachable'));

      const after = await drainQueue({ orgId: 5n, now: entry.nextAttemptAt });

      const row = after.find((e) => e.id === entry.id);
      expect(row?.status).toBe('pending');
      expect(row?.attempts).toBe(1);
      expect(row?.lastError).toBe('bundler unreachable');
      expect(row?.nextAttemptAt).toBe(entry.nextAttemptAt + 2000);
    });

    it('does not retry before the backoff has elapsed', async () => {
      const entry = await tap('779', 'ee');
      sendCheckIn.mockRejectedValueOnce(new Error('bundler unreachable'));
      await drainQueue({ orgId: 5n, now: entry.nextAttemptAt });

      await drainQueue({ orgId: 5n, now: entry.nextAttemptAt + 1999 });

      expect(sendCheckIn).toHaveBeenCalledTimes(1);
    });

    it('records a revert as failed, with the reason Task 29 reconciles on', async () => {
      const entry = await tap('780', 'bb');
      sendCheckIn.mockResolvedValueOnce({
        userOpHash: '0xfeed',
        wait: async () => ({ success: false, blockNumber: 9n, txHash: '0xabc', revertReason: '0xdeadbeef' }),
      });

      const after = await drainQueue({ orgId: 5n, now: entry.nextAttemptAt });

      expect(after.find((e) => e.id === entry.id)).toMatchObject({ status: 'failed', lastError: '0xdeadbeef' });
    });

    it('treats a wait timeout as sent, never as a failure to re-send', async () => {
      const entry = await tap('781', '1a');
      sendCheckIn.mockResolvedValueOnce({
        userOpHash: '0xbeef',
        wait: async () => ({ success: false, blockNumber: 0n, txHash: '0x', revertReason: 'TIMEOUT' }),
      });

      const after = await drainQueue({ orgId: 5n, now: entry.nextAttemptAt });
      expect(after.find((e) => e.id === entry.id)).toMatchObject({ status: 'sent', userOpHash: '0xbeef' });

      // An op that may still land is never sent twice: a resend would revert `AlreadyCheckedIn`
      // and Task 29 would read our own success as a double-entry conflict.
      await drainQueue({ orgId: 5n, now: entry.nextAttemptAt + BACKOFF_CAP_MS });
      expect(sendCheckIn).toHaveBeenCalledTimes(1);

      // Still counted: nothing has reached the chain yet.
      expect(await pendingCount()).toBe(1);
    });

    it('does not send while the caller says the device is offline', async () => {
      await tap('782', '2b');

      const after = await drainQueue({ orgId: 5n, isOnline: () => false });

      expect(sendCheckIn).not.toHaveBeenCalled();
      expect(after[0]?.status).toBe('pending');
    });
  });

  describe('parking', () => {
    it('stops retrying after the attempt limit and leaves the entry for reconciliation', async () => {
      const entry = await tap('783', '3c');
      sendCheckIn.mockRejectedValue(new Error('bundler unreachable'));

      let at = entry.nextAttemptAt;
      for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
        const after = await drainQueue({ orgId: 5n, now: at });
        at = (after.find((e) => e.id === entry.id)?.nextAttemptAt ?? at) + 1;
      }

      expect(sendCheckIn).toHaveBeenCalledTimes(MAX_ATTEMPTS);
      const parked = (await allEntries()).find((e) => e.id === entry.id);
      expect(parked).toMatchObject({ status: 'failed', attempts: MAX_ATTEMPTS });

      await drainQueue({ orgId: 5n, now: at + BACKOFF_CAP_MS });
      expect(sendCheckIn).toHaveBeenCalledTimes(MAX_ATTEMPTS);
    });

    it('parks a code older than the 12 h late window instead of spending gas on a certain revert', async () => {
      const entry = await tap('784', '4d');

      const after = await drainQueue({ orgId: 5n, now: entry.createdAt + 43_200_001 });

      expect(sendCheckIn).not.toHaveBeenCalled();
      expect(after.find((e) => e.id === entry.id)).toMatchObject({ status: 'failed', lastError: LATE_WINDOW_ELAPSED });
    });
  });

  describe('the ABI gate', () => {
    it('dry-runs and keeps the entry while the deployed ABI has no checkInLate', async () => {
      ticketAbi.length = 0;
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const entry = await tap('785', '5e');

      const after = await drainQueue({ orgId: 5n, now: entry.nextAttemptAt });

      expect(hasLateCheckIn()).toBe(false);
      expect(sendCheckIn).not.toHaveBeenCalled();
      expect(after.find((e) => e.id === entry.id)).toMatchObject({
        status: 'pending',
        attempts: 0,
        lastError: DRY_RUN_MARK,
      });
      expect(warn).toHaveBeenCalledTimes(1);
      warn.mockRestore();
    });

    it('is the generated ABI and not a flag: this fails the day 01b redeploys', async () => {
      const shared = await vi.importActual<{ ticketAbi: Abi }>('@monti/shared');
      expect(shared.ticketAbi.some((e) => e.type === 'function' && e.name === 'checkInLate')).toBe(false);
    });
  });
});
