// `fake-indexeddb/auto` installs the IndexedDB globals before anything opens a database; it has
// to be the first import in the file.
import 'fake-indexeddb/auto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Only the relayer callable is replaced. `relayCheckIn` (checkInOp) is what the queue drains
// through since the 01b relay switch — no bundler, no gate account, no on-device `checkInLate` ABI.
const relayCheckIn = vi.fn();
vi.mock('../gate/checkInOp', () => ({ relayCheckIn }));

// The database comes from Task 25's store, which reaches the network to refresh snapshots.
// Only that reach is replaced — `staffDb()` below is the real IndexedDB the gate uses.
vi.mock('../../shared/api/functions', () => ({ issueSnapshot: vi.fn(), getPhotoForGate: vi.fn() }));

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
  parkedCount,
  pendingCount,
} = await import('./opQueue');
const { staffDb } = await import('../snapshot/store');
const { LATE_WINDOW_ELAPSED } = await import('../types');

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

/** A relayer answer that mined. `sent` is the other one and the queue treats it differently. */
const confirmed = () => ({ relayId: '42:x', status: 'confirmed' as const });

/** A `CallableError` the relayer's simulation produced — deterministic, so the row parks at once. */
const reverted = (detailsCode: string) =>
  Object.assign(new Error(detailsCode), { code: 'failed-precondition', details: { code: detailsCode } });

describe('durable check-in queue', () => {
  beforeEach(async () => {
    // Only `Date` is faked. `fake-indexeddb` schedules its request callbacks on `setImmediate`,
    // so faking the timer wheel would stop every read and write from ever settling — the clock
    // is what these tests need deterministic, not the event loop.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    relayCheckIn.mockReset();
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
    it('flushes in tap order, each as a late relay submission', async () => {
      await tap('900', 'ff');
      await tap('100', 'aa');
      relayCheckIn.mockResolvedValue(confirmed());

      await drainQueue({ orgId: 5n });

      expect(relayCheckIn.mock.calls.map(([p]) => p.response.tokenId)).toEqual(['900', '100']);
      // Every drain is a late submission: the relayer submits `checkInForLate`.
      expect(relayCheckIn.mock.calls.every(([p]) => p.late === true)).toBe(true);
    });

    it('marks an entry confirmed when the relayer mined it', async () => {
      const entry = await tap('777', 'cc');
      relayCheckIn.mockResolvedValueOnce(confirmed());

      const after = await drainQueue({ orgId: 5n, now: entry.nextAttemptAt });

      expect(after.find((e) => e.id === entry.id)?.status).toBe('confirmed');
      expect(await pendingCount()).toBe(0);
    });

    it('leaves a transport failure pending with a longer wait', async () => {
      const entry = await tap('778', 'dd');
      relayCheckIn.mockRejectedValueOnce(new Error('relayer unreachable'));

      const after = await drainQueue({ orgId: 5n, now: entry.nextAttemptAt });

      const row = after.find((e) => e.id === entry.id);
      expect(row?.status).toBe('pending');
      expect(row?.attempts).toBe(1);
      expect(row?.lastError).toBe('relayer unreachable');
      expect(row?.nextAttemptAt).toBe(entry.nextAttemptAt + 2000);
    });

    it('does not retry before the backoff has elapsed', async () => {
      const entry = await tap('779', 'ee');
      relayCheckIn.mockRejectedValueOnce(new Error('relayer unreachable'));
      await drainQueue({ orgId: 5n, now: entry.nextAttemptAt });

      await drainQueue({ orgId: 5n, now: entry.nextAttemptAt + 1999 });

      expect(relayCheckIn).toHaveBeenCalledTimes(1);
    });

    it('parks a simulated revert at once, with the reason the queue screen reads', async () => {
      const entry = await tap('780', 'bb');
      // The relayer caught the revert in its `eth_call`; retrying it twenty times cannot change it.
      relayCheckIn.mockRejectedValueOnce(reverted('GATE_CLOSED'));

      const after = await drainQueue({ orgId: 5n, now: entry.nextAttemptAt });

      expect(after.find((e) => e.id === entry.id)).toMatchObject({ status: 'failed', lastError: 'GATE_CLOSED', attempts: 1 });
    });

    it('counts an AlreadyCheckedIn as done — the relayer answers it as confirmed', async () => {
      const entry = await tap('791', '9a');
      // The backend maps `AlreadyCheckedIn` to success, so a late replay of a tap another gate (or
      // an earlier drain) already landed comes back confirmed, not as a revert.
      relayCheckIn.mockResolvedValueOnce({ relayId: '42:791', status: 'confirmed', usedAt: NOW / 1000 });

      const after = await drainQueue({ orgId: 5n, now: entry.nextAttemptAt });

      expect(after.find((e) => e.id === entry.id)?.status).toBe('confirmed');
    });

    it('runs one pass at a time, so two callers cannot send the same op twice', async () => {
      const entry = await tap('782', '2b');
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      relayCheckIn.mockImplementationOnce(async () => {
        await held;
        return confirmed();
      });

      const first = drainQueue({ orgId: 5n, now: entry.nextAttemptAt });
      const second = drainQueue({ orgId: 5n, now: entry.nextAttemptAt });
      release();
      const [a, b] = await Promise.all([first, second]);

      expect(relayCheckIn).toHaveBeenCalledTimes(1);
      expect(b).toEqual(a);
      expect(a.find((e) => e.id === entry.id)).toMatchObject({ status: 'confirmed' });
    });

    it('lets the next pass run after one throws', async () => {
      const entry = await tap('783', '3c');
      const originalGetAll = IDBObjectStore.prototype.getAll;
      IDBObjectStore.prototype.getAll = function throwing(this: IDBObjectStore) {
        throw new Error('store gone');
      } as IDBObjectStore['getAll'];
      await expect(drainQueue({ orgId: 5n, now: entry.nextAttemptAt })).rejects.toThrow('store gone');
      IDBObjectStore.prototype.getAll = originalGetAll;

      relayCheckIn.mockResolvedValueOnce(confirmed());
      await expect(drainQueue({ orgId: 5n, now: entry.nextAttemptAt })).resolves.toHaveLength(1);
      expect(relayCheckIn).toHaveBeenCalledTimes(1);
    });

    it('treats a broadcast without a receipt as sent, never as a failure to re-send', async () => {
      const entry = await tap('781', '1a');
      // `status: 'sent'` — the relayer broadcast but did not wait for the receipt.
      relayCheckIn.mockResolvedValueOnce({ relayId: '42:781', status: 'sent' });

      const after = await drainQueue({ orgId: 5n, now: entry.nextAttemptAt });
      expect(after.find((e) => e.id === entry.id)).toMatchObject({
        status: 'sent',
        // Stamped here and nowhere else — Task 29 measures its ten minutes of silence from it.
        sentAt: entry.nextAttemptAt,
      });

      // This loop never sends it again on its own. Only Task 29 may, and only after the chain
      // has answered that nothing is recorded for ten minutes.
      await drainQueue({ orgId: 5n, now: entry.nextAttemptAt + BACKOFF_CAP_MS });
      expect(relayCheckIn).toHaveBeenCalledTimes(1);

      // Still counted: nothing has reached the chain yet.
      expect(await pendingCount()).toBe(1);
    });

    it('does not send while the caller says the device is offline', async () => {
      await tap('782', '2b');

      const after = await drainQueue({ orgId: 5n, isOnline: () => false });

      expect(relayCheckIn).not.toHaveBeenCalled();
      expect(after[0]?.status).toBe('pending');
    });
  });

  describe('parking', () => {
    it('stops retrying after the attempt limit and leaves the entry for reconciliation', async () => {
      const entry = await tap('783', '3c');
      relayCheckIn.mockRejectedValue(new Error('relayer unreachable'));

      let at = entry.nextAttemptAt;
      for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
        const after = await drainQueue({ orgId: 5n, now: at });
        at = (after.find((e) => e.id === entry.id)?.nextAttemptAt ?? at) + 1;
      }

      expect(relayCheckIn).toHaveBeenCalledTimes(MAX_ATTEMPTS);
      const parked = (await allEntries()).find((e) => e.id === entry.id);
      expect(parked).toMatchObject({ status: 'failed', attempts: MAX_ATTEMPTS });

      await drainQueue({ orgId: 5n, now: at + BACKOFF_CAP_MS });
      expect(relayCheckIn).toHaveBeenCalledTimes(MAX_ATTEMPTS);
    });

    it("parks the whole queue once the chain's deadline — event end + 12 h — has passed", async () => {
      const endsAt = NOW / 1000;
      const due = await tap('784', '4d');
      const notDue = await tap('785', '4e');
      relayCheckIn.mockRejectedValueOnce(new Error('relayer unreachable'));
      await drainQueue({ orgId: 5n, now: due.nextAttemptAt });
      relayCheckIn.mockReset();

      const after = await drainQueue({ orgId: 5n, now: NOW + 12 * HOUR + 1, endsAt });

      expect(relayCheckIn).not.toHaveBeenCalled();
      for (const id of [due.id, notDue.id]) {
        expect(after.find((e) => e.id === id)).toMatchObject({ status: 'failed', lastError: LATE_WINDOW_ELAPSED });
      }
      expect(await parkedCount()).toBe(2);
      expect(await pendingCount()).toBe(0);
    });

    it('still flushes a code far older than 12 h while that deadline has not passed', async () => {
      const endsAt = NOW / 1000 + 3 * 3600;
      const entry = await tap('786', '5f');
      relayCheckIn.mockResolvedValueOnce(confirmed());

      const after = await drainQueue({ orgId: 5n, now: NOW + 13 * HOUR, endsAt });

      expect(relayCheckIn).toHaveBeenCalledTimes(1);
      expect(after.find((e) => e.id === entry.id)?.status).toBe('confirmed');
    });

    it('parks nothing pre-emptively when the event end is not known', async () => {
      const entry = await tap('787', '6a');
      relayCheckIn.mockResolvedValueOnce(confirmed());

      const after = await drainQueue({ orgId: 5n, now: NOW + 100 * 24 * HOUR });

      expect(relayCheckIn).toHaveBeenCalledTimes(1);
      expect(after.find((e) => e.id === entry.id)?.status).toBe('confirmed');
    });

    it('counts parked entries separately from the ones still on their way', async () => {
      const parked = await tap('788', '6b');
      relayCheckIn.mockRejectedValue(new Error('relayer unreachable'));
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
});
