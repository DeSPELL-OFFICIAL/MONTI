// The gate's copy of the guest list: fetched while there is signal, verified before it is
// believed, and kept on the device so the door still works when there is none.
//
// Two rules the rest of the gate rests on:
//
//  * **Nothing unverified is ever stored.** A snapshot is checked against the caps and the
//    attester's signature before `put`, so anything read back out of IndexedDB — this session or
//    next month's — is something the attester signed. There is no "verify on read" path to
//    forget to call.
//  * **A failed refresh changes nothing.** The stored snapshot is the one the gate keeps
//    working on; a dropped connection must not empty the guest list. Failures are thrown, not
//    swallowed, because `permission-denied` (this staff member is not on this event) and
//    `unavailable` (no signal) look identical from the door and mean opposite things.
//
// `current()`, `lookup()` and `deviceKeyOf()` are synchronous on purpose. They are read while an
// attendee's phone is held against the terminal, and an `await` there is a pause a queue feels.
import { openDB, type IDBPDatabase } from 'idb';
import type { Address } from 'viem';

import type { SnapshotWire } from '@monti/shared';

import { getPhotoForGate, issueSnapshot } from '../../shared/api/functions';
import { SNAPSHOT_REFRESH_MS, STAFF_DB_NAME, STAFF_DB_VERSION } from '../constants';
import type { SnapshotStore } from '../gate/preflight';
import { deviceKeyIn, lookupIn, type DeviceKey, type SnapshotLookup } from './lookup';
import { SnapshotError, snapshotFitsCaps, verifySnapshot } from './verify';

interface StoredSnapshot {
  eventId: string;
  snapshot: SnapshotWire;
  /** `Date.now()` at the moment it was verified. The status bar's "몇 분 전" reads this. */
  fetchedAt: number;
}

/** One face, for a ticket the snapshot did not carry. Keyed by token, never by person. */
interface StoredPhoto {
  tokenId: string;
  photoJpegB64: string;
  displayName: string;
  fetchedAt: number;
}

let dbPromise: Promise<IDBPDatabase> | null = null;

/**
 * The staff device's own database, and the **one place it is opened**. Every store is created
 * in the same version, because two modules opening `STAFF_DB_NAME` at the same version with
 * different `upgrade` callbacks is a schema that depends on which one ran first: the second
 * upgrade never fires and its store is simply missing, at a door, months later.
 *
 * `snapshots` and `photos` are this task's. `queue` is Task 28's durable check-ins and
 * `settings` is the gate's own — declared here for that reason, not used from this file.
 *
 * The handle is memoised rather than opened per call: two `openDB` calls at the same version
 * are two connections, and a second connection blocks the first one's upgrade.
 */
export function staffDb(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(STAFF_DB_NAME, STAFF_DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('snapshots')) db.createObjectStore('snapshots', { keyPath: 'eventId' });
        if (!db.objectStoreNames.contains('photos')) db.createObjectStore('photos', { keyPath: 'tokenId' });
        if (!db.objectStoreNames.contains('queue')) db.createObjectStore('queue', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'key' });
      },
    });
  }
  return dbPromise;
}

/**
 * The snapshot the door is running on right now. Held in memory as well as in IndexedDB because
 * every tap reads it and IndexedDB cannot be read synchronously.
 */
let held: SnapshotWire | undefined;

/** The snapshot every tap is judged against, or `undefined` before the first one lands. */
export function current(): SnapshotWire | undefined {
  return held;
}

/** What this gate knows about one token. See `lookup.ts` for why "unknown" is not a refusal. */
export function lookup(tokenId: string): SnapshotLookup {
  return lookupIn(held, tokenId);
}

/** The attendee's active device key, for Task 27 to check an offline `deviceSig` against. */
export function deviceKeyOf(tokenId: string): DeviceKey | undefined {
  return deviceKeyIn(held, tokenId);
}

/**
 * The real implementation of the interface Task 20's `preflight` reads through, replacing the
 * `stubSnapshotStore` it was written against. Declared with `satisfies` so that the day that
 * interface grows a member, this file stops compiling rather than the gate stopping at a door.
 */
export function snapshotStore(): SnapshotStore {
  return { current } satisfies SnapshotStore;
}

/** Reads the stored snapshot, and makes it the one the gate is running on. */
export async function loadSnapshot(eventId: string): Promise<SnapshotWire | undefined> {
  const row = (await (await staffDb()).get('snapshots', eventId)) as StoredSnapshot | undefined;
  if (row) held = row.snapshot;
  return row?.snapshot;
}

/** How stale the guest list is. `Infinity` before the first sync — never `0`, which reads as fresh. */
export async function snapshotAgeMs(eventId: string, now = Date.now()): Promise<number> {
  const row = (await (await staffDb()).get('snapshots', eventId)) as StoredSnapshot | undefined;
  return row ? now - row.fetchedAt : Number.POSITIVE_INFINITY;
}

/**
 * Forgets everything this device holds about any event: the stored snapshots, the cached faces
 * and the one in memory. What a sign-out does — the faces are other people's.
 */
export async function clearSnapshots(): Promise<void> {
  held = undefined;
  const db = await staffDb();
  await Promise.all([db.clear('snapshots'), db.clear('photos')]);
}

/**
 * Fetches one snapshot and stores it, or throws and leaves the stored one untouched.
 *
 * The authenticated party is **the staff member's Firebase session on this phone**, not the gate
 * device account. `gateAccount` is how the server checks that this terminal is a registered gate
 * of this event and what it writes into the PII access log; it grants nothing by itself.
 *
 * Caps are checked before the signature, so an oversized answer from somewhere that is not our
 * backend is refused without first hashing megabytes of it.
 */
export async function refreshSnapshot(eventId: string, gateAccount: Address): Promise<SnapshotWire> {
  const snapshot = (await issueSnapshot({ eventId, gateAccount })) as SnapshotWire;
  if (!snapshotFitsCaps(snapshot)) throw new SnapshotError('SNAPSHOT_TOO_LARGE');
  if (!(await verifySnapshot(snapshot))) throw new SnapshotError('SNAPSHOT_BAD_SIG');
  await (await staffDb()).put('snapshots', {
    eventId,
    snapshot,
    fetchedAt: Date.now(),
  } satisfies StoredSnapshot);
  held = snapshot;
  return snapshot;
}

/**
 * Once when the door opens, then every ten minutes (spec §12). The stored snapshot is loaded
 * first, so a gate reopened without signal is running on last session's guest list within a tick
 * rather than not at all.
 *
 * Every refresh's failure is swallowed **here and only here**: this is a background timer with
 * nobody to tell. What a staff member sees instead is the snapshot's age, which stops moving.
 */
export function startSnapshotRefresh(eventId: string, gateAccount: Address): () => void {
  void loadSnapshot(eventId).catch(() => undefined);
  void refreshSnapshot(eventId, gateAccount).catch(() => undefined);
  const timer = setInterval(() => {
    void refreshSnapshot(eventId, gateAccount).catch(() => undefined);
  }, SNAPSHOT_REFRESH_MS);
  return () => clearInterval(timer);
}

/**
 * The face to hold next to the person standing there.
 *
 * Almost always the snapshot's own — it was signed with the rest of the guest list. The callable
 * is for the ticket bought after the snapshot was taken, and its answer is cached, because the
 * alternative is one decryption on the backend per tap on a queue that is already moving.
 * An event with `requireKyc: false` carries no photos at all and the screen draws an avatar.
 */
export async function photoFor(
  tokenId: string,
  gateAccount: Address,
): Promise<{ photoJpegB64: string; displayName: string }> {
  const known = lookup(tokenId);
  if (known.ticket?.photoJpegB64) {
    return { photoJpegB64: known.ticket.photoJpegB64, displayName: known.ticket.displayName };
  }
  const db = await staffDb();
  const cached = (await db.get('photos', tokenId)) as StoredPhoto | undefined;
  if (cached) return { photoJpegB64: cached.photoJpegB64, displayName: cached.displayName };

  const fetched = await getPhotoForGate({ tokenId, gateAccount });
  await db.put('photos', { tokenId, ...fetched, fetchedAt: Date.now() } satisfies StoredPhoto);
  return fetched;
}
