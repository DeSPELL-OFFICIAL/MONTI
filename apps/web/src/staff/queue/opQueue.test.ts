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
  MAX_ATTEMPTS,
  QUEUE_STORE,
  allEntries,
  backoffMs,
  drainQueue,
  enqueueCheckIn,
  hasLateCheckIn,
  parkedCount,
  pendingCount,
} = await import('./opQueue');
const { staffDb } = await import('../snapshot/store');
const { DRY_RUN_MARK, LATE_WINDOW_ELAPSED } = await import('../types');

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

const code = (nonce: string, issuedAt: number = ISSUED_AT) => ({
  v: 1 as const,
  gateId: '7',
  eventId: '42',
  issuedAt,
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

const tap = (tokenId: string, nonce: string, issuedAt?: number) =>
  enqueueCheckIn({ code: code(nonce, issuedAt), response: response(tokenId, nonce), orgId: 5n });

const HOUR = 3_600_000;

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

    it('runs one pass at a time, so two callers cannot send the same op twice', async () => {
      const entry = await tap('782', '2b');
      // The row stays `pending` in the store for the whole of this await, which is exactly the
      // window a second caller would read it as unsent in. The gate is built before the mock so
      // `release` exists whether or not the send has been reached yet.
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      sendCheckIn.mockImplementationOnce(async () => {
        await held;
        return landed();
      });

      const first = drainQueue({ orgId: 5n, now: entry.nextAttemptAt });
      const second = drainQueue({ orgId: 5n, now: entry.nextAttemptAt });
      release();
      const [a, b] = await Promise.all([first, second]);

      expect(sendCheckIn).toHaveBeenCalledTimes(1);
      // The joining caller gets the pass it joined, not a second answer.
      expect(b).toEqual(a);
      expect(a.find((e) => e.id === entry.id)).toMatchObject({ status: 'confirmed' });
    });

    it('lets the next pass run after one throws', async () => {
      const entry = await tap('783', '3c');
      // `allEntries()` is the first thing a pass does; failing its read fails the pass itself.
      const originalGetAll = IDBObjectStore.prototype.getAll;
      IDBObjectStore.prototype.getAll = function throwing(this: IDBObjectStore) {
        throw new Error('store gone');
      } as IDBObjectStore['getAll'];
      await expect(drainQueue({ orgId: 5n, now: entry.nextAttemptAt })).rejects.toThrow('store gone');
      IDBObjectStore.prototype.getAll = originalGetAll;

      await expect(drainQueue({ orgId: 5n, now: entry.nextAttemptAt })).resolves.toHaveLength(1);
      expect(sendCheckIn).toHaveBeenCalledTimes(1);
    });

    it('treats a wait timeout as sent, never as a failure to re-send', async () => {
      const entry = await tap('781', '1a');
      sendCheckIn.mockResolvedValueOnce({
        userOpHash: '0xbeef',
        wait: async () => ({ success: false, blockNumber: 0n, txHash: '0x', revertReason: 'TIMEOUT' }),
      });

      const after = await drainQueue({ orgId: 5n, now: entry.nextAttemptAt });
      expect(after.find((e) => e.id === entry.id)).toMatchObject({
        status: 'sent',
        userOpHash: '0xbeef',
        // Stamped here and nowhere else — Task 29 measures its ten minutes of silence from it.
        sentAt: entry.nextAttemptAt,
      });

      // This loop never sends it again on its own. Only Task 29 may, and only after the chain
      // has answered that nothing is recorded for ten minutes.
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

    it('parks the whole queue once the chain\'s deadline — event end + 12 h — has passed', async () => {
      const endsAt = NOW / 1000;
      const due = await tap('784', '4d');
      const notDue = await tap('785', '4e');
      // One of the two is not even due for a retry. The deadline is the event's, not the
      // entry's, so it is just as dead.
      sendCheckIn.mockRejectedValueOnce(new Error('bundler unreachable'));
      await drainQueue({ orgId: 5n, now: due.nextAttemptAt });
      sendCheckIn.mockReset();

      const after = await drainQueue({ orgId: 5n, now: NOW + 12 * HOUR + 1, endsAt });

      expect(sendCheckIn).not.toHaveBeenCalled();
      for (const id of [due.id, notDue.id]) {
        expect(after.find((e) => e.id === id)).toMatchObject({ status: 'failed', lastError: LATE_WINDOW_ELAPSED });
      }
      expect(await parkedCount()).toBe(2);
      expect(await pendingCount()).toBe(0);
    });

    it('still flushes a code far older than 12 h while that deadline has not passed', async () => {
      // Taps at 20:00, event ends at 23:00, the gate reconnects at 09:00 the next morning. The
      // code is thirteen hours old and `Ticket.sol:437` does not care — it anchors on the event
      // start — while `Ticket.sol:419` takes the submission until 11:00.
      const endsAt = NOW / 1000 + 3 * 3600;
      const entry = await tap('786', '5f');
      sendCheckIn.mockResolvedValueOnce(landed());

      const after = await drainQueue({ orgId: 5n, now: NOW + 13 * HOUR, endsAt });

      expect(sendCheckIn).toHaveBeenCalledTimes(1);
      expect(after.find((e) => e.id === entry.id)?.status).toBe('confirmed');
    });

    it('parks nothing pre-emptively when the event end is not known', async () => {
      const entry = await tap('787', '6a');
      sendCheckIn.mockResolvedValueOnce(landed());

      const after = await drainQueue({ orgId: 5n, now: NOW + 100 * 24 * HOUR });

      expect(sendCheckIn).toHaveBeenCalledTimes(1);
      expect(after.find((e) => e.id === entry.id)?.status).toBe('confirmed');
    });

    it('counts parked entries separately from the ones still on their way', async () => {
      const parked = await tap('788', '6b');
      sendCheckIn.mockRejectedValue(new Error('bundler unreachable'));
      let at = parked.nextAttemptAt;
      for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
        const after = await drainQueue({ orgId: 5n, now: at });
        at = (after.find((e) => e.id === parked.id)?.nextAttemptAt ?? at) + 1;
      }
      await tap('789', '6c');

      expect(await parkedCount()).toBe(1);
      expect(await pendingCount()).toBe(1);
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

    it('marks a dry run once instead of rewriting the queue on every drain', async () => {
      ticketAbi.length = 0;
      const warned = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const entry = await tap('790', '7f');

      const originalPut = IDBObjectStore.prototype.put;
      let puts = 0;
      IDBObjectStore.prototype.put = function patched(this: IDBObjectStore, ...args: Parameters<IDBObjectStore['put']>) {
        puts += 1;
        return originalPut.apply(this, args);
      } as IDBObjectStore['put'];
      try {
        await drainQueue({ orgId: 5n, now: entry.nextAttemptAt });
        expect(puts).toBe(1);
        // Nothing about the row changed, so nothing is written again.
        await drainQueue({ orgId: 5n, now: entry.nextAttemptAt + 1 });
        expect(puts).toBe(1);
      } finally {
        IDBObjectStore.prototype.put = originalPut;
      }

      expect(warned).toHaveBeenCalledTimes(2);
      warned.mockRestore();
    });

    /**
     * The gate is the generated ABI and never a flag, which is what let the drain switch itself
     * on: 01b redeployed on 2026-09-23, `checkInLate` is in `Ticket.json`, and the dry run above
     * is now reachable only by emptying the ABI the way those two tests do. It reads `false`
     * again the day somebody ships a bundle built against an older export — which is the case
     * the runtime guard is still there for.
     */
    it('is the generated ABI and not a flag: 01b redeployed, so this reads true', async () => {
      const shared = await vi.importActual<{ ticketAbi: Abi }>('@monti/shared');
      expect(shared.ticketAbi.some((e) => e.type === 'function' && e.name === 'checkInLate')).toBe(true);
    });
  });
});
