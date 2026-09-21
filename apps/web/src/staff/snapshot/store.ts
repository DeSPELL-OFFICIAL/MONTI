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

import { SNAPSHOT_TTL_SECONDS, type SnapshotWire } from '@monti/shared';

import { getPhotoForGate, issueSnapshot } from '../../shared/api/functions';
import { SNAPSHOT_REFRESH_MS, STAFF_DB_NAME, STAFF_DB_VERSION } from '../constants';
import type { SnapshotStore } from '../gate/preflight';
import { deviceKeyIn, lookupIn, type DeviceKey, type SnapshotLookup } from './lookup';
import { SnapshotError, snapshotBody, snapshotFitsCaps, verifySnapshot } from './verify';

interface StoredSnapshot {
  eventId: string;
  snapshot: SnapshotWire;
  /** `Date.now()` at the moment it was verified. The status bar's "몇 분 전" reads this. */
  fetchedAt: number;
}

/**
 * One face, for a ticket the snapshot did not carry. Keyed by token, never by person.
 *
 * `expiresAt` is unix **seconds**, the same clock and the same meaning as `SnapshotWire.expiresAt`:
 * the attester put a twelve-hour life on the guest list it signed, and a face this terminal
 * fetched separately does not get to outlive it.
 */
interface StoredPhoto {
  tokenId: string;
  photoJpegB64: string;
  displayName: string;
  fetchedAt: number;
  expiresAt: number;
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

/**
 * Bumped by every clear. A fetch that was already in flight when the gate closed compares the
 * era it started in against this before it writes anything — otherwise a request made *before*
 * the teardown would quietly put the faces back milliseconds after they were erased, and no
 * test would ever catch it because the erase itself did happen.
 */
let era = 0;

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

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

/**
 * Reads the stored snapshot, and makes it the one the gate is running on.
 *
 * An expired one is **deleted rather than served**. `expiresAt` is what the attester signed, so
 * a snapshot past it is an expired credential: serving it would let a terminal that has been off
 * the network for half a day keep admitting people — and keep holding their faces — on a list
 * nobody has stood behind since yesterday.
 */
export async function loadSnapshot(eventId: string): Promise<SnapshotWire | undefined> {
  const started = era;
  const db = await staffDb();
  const row = (await db.get('snapshots', eventId)) as StoredSnapshot | undefined;
  if (!row) return undefined;
  if (row.snapshot.expiresAt <= nowSeconds()) {
    await db.delete('snapshots', eventId);
    return undefined;
  }
  if (started === era) held = row.snapshot;
  return row.snapshot;
}

/** How stale the guest list is. `Infinity` before the first sync — never `0`, which reads as fresh. */
export async function snapshotAgeMs(eventId: string, now = Date.now()): Promise<number> {
  const row = (await (await staffDb()).get('snapshots', eventId)) as StoredSnapshot | undefined;
  return row ? now - row.fetchedAt : Number.POSITIVE_INFINITY;
}

/**
 * Forgets every face and every guest list this device holds: the stored snapshots, the cached
 * photos and the one in memory. The queue is **not** touched — an entry in it is a person who
 * already walked through the door, and losing that is worse than keeping it.
 *
 * Called when the gate closes (`startSnapshotRefresh`'s disposer), which is the moment the
 * terminal stops needing other people's faces.
 */
export async function clearSnapshotData(): Promise<void> {
  held = undefined;
  era += 1;
  const db = await staffDb();
  await Promise.all([db.clear('snapshots'), db.clear('photos')]);
}

/**
 * Everything, queue and settings included. This is sign-out: a phone handed to the next shift,
 * or one being wiped.
 *
 * It drops unsent check-ins, so whatever wires this up flushes the queue first if there is any
 * signal at all — the alternative is a phone that keeps a stranger's face because a check-in
 * could not be sent.
 */
export async function clearAll(): Promise<void> {
  held = undefined;
  era += 1;
  const db = await staffDb();
  await Promise.all([
    db.clear('snapshots'),
    db.clear('photos'),
    db.clear('queue'),
    db.clear('settings'),
  ]);
}

/**
 * Faces and guest lists this terminal no longer has a reason to hold, dropped on every successful
 * refresh — the one moment it is provably safe to let go of a cached face.
 *
 * **Every** `photos` row goes, and the two cases are why. A token the fresh list now carries has
 * its face in the list itself, so the cached copy is a second place for it to rot. A token the
 * list still does not carry is revoked, transferred, or another event's — a face for someone who
 * is not coming through this door. Both answers are "delete", so the rule is simply: the photo
 * cache holds only what has been fetched since the last refresh, at most ten minutes of faces.
 *
 * Stored snapshots are dropped once past the `expiresAt` the attester signed. The one just
 * written is fresh by construction, so this only ever reaps other events and old sessions.
 */
async function prune(db: IDBPDatabase, now: number): Promise<void> {
  const snapshots = (await db.getAll('snapshots')) as StoredSnapshot[];
  await Promise.all([
    db.clear('photos'),
    ...snapshots
      .filter((row) => row.snapshot.expiresAt <= now)
      .map((row) => db.delete('snapshots', row.eventId)),
  ]);
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
  const started = era;
  const snapshot = await issueSnapshot({ eventId, gateAccount });
  // Measured on the unsigned body, which is what the issuer measured (`snapshot.ts`): including
  // the ~150 bytes of `attesterSig` would make this side stricter than the side that decides.
  if (!snapshotFitsCaps(snapshotBody(snapshot))) throw new SnapshotError('SNAPSHOT_TOO_LARGE');
  if (!(await verifySnapshot(snapshot))) throw new SnapshotError('SNAPSHOT_BAD_SIG');
  const db = await staffDb();
  // The gate closed while this was in the air. It is a valid snapshot for a door nobody is
  // standing at, so it is returned to the caller and written nowhere. Checked again after the
  // write, because the write itself is an await: a clear landing inside it would otherwise be
  // undone by the assignment on the next line, and the faces would be back.
  if (started !== era) return snapshot;
  await db.put('snapshots', {
    eventId,
    snapshot,
    fetchedAt: Date.now(),
  } satisfies StoredSnapshot);
  if (started !== era) {
    await db.delete('snapshots', eventId);
    return snapshot;
  }
  held = snapshot;
  // After the store, so a prune can never be what leaves the gate with nothing.
  await prune(db, nowSeconds());
  return snapshot;
}

/**
 * Once when the door opens, then every ten minutes (spec §12). The stored snapshot is loaded
 * first, so a gate reopened without signal is running on last session's guest list within a tick
 * rather than not at all.
 *
 * Every refresh's failure is swallowed **here and only here**: this is a background timer with
 * nobody to tell. What a staff member sees instead is the snapshot's age, which stops moving.
 *
 * **The disposer erases the faces.** Closing the gate is the end of the terminal's reason to hold
 * other people's photographs, and the guest list is where most of them are. The cost is real and
 * chosen: a gate closed and reopened with no signal has to wait for one. Nothing is lost that a
 * single successful refresh does not bring back, and a face kept past a shift is not recoverable.
 */
export function startSnapshotRefresh(eventId: string, gateAccount: Address): () => void {
  void loadSnapshot(eventId).catch(() => undefined);
  void refreshSnapshot(eventId, gateAccount).catch(() => undefined);
  const timer = setInterval(() => {
    void refreshSnapshot(eventId, gateAccount).catch(() => undefined);
  }, SNAPSHOT_REFRESH_MS);
  return () => {
    clearInterval(timer);
    void clearSnapshotData().catch(() => undefined);
  };
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
  const started = era;
  const known = lookup(tokenId);
  if (known.ticket?.photoJpegB64) {
    return { photoJpegB64: known.ticket.photoJpegB64, displayName: known.ticket.displayName };
  }
  const db = await staffDb();
  const now = nowSeconds();
  const cached = (await db.get('photos', tokenId)) as StoredPhoto | undefined;
  if (cached && cached.expiresAt > now) {
    return { photoJpegB64: cached.photoJpegB64, displayName: cached.displayName };
  }
  if (cached) await db.delete('photos', tokenId);

  const fetched = await getPhotoForGate({ tokenId, gateAccount });
  // The gate closed while this face was in the air. The staff member who asked for it is still
  // handed it — they may be mid-tap — but it is never written down: a request made before the
  // teardown must not be what puts a decrypted face back on a terminal that was just cleared.
  // Checked again after the write, because the write is itself an await.
  if (started !== era) return fetched;
  // The life of the guest list this face was fetched against. With no list to borrow from — the
  // very first tap of a session — it gets the attester's own TTL and no more.
  const expiresAt = held?.expiresAt ?? now + SNAPSHOT_TTL_SECONDS;
  await db.put('photos', {
    tokenId,
    ...fetched,
    fetchedAt: Date.now(),
    expiresAt,
  } satisfies StoredPhoto);
  if (started !== era) await db.delete('photos', tokenId);
  return fetched;
}
