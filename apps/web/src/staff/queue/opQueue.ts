// The durable check-in queue: what happens to a tap the chain could not be told about yet.
//
// Three rules hold this together, and each one is a way someone gets wronged if it is dropped.
//
// **Persist, then show.** `enqueueCheckIn` resolves only after IndexedDB has *committed* the
// row. The offline card is shown from that resolution, so a phone that dies between the green
// screen and the write cannot exist: either the attendee was not told they are in, or the
// record of them being in survived. Anything cheaper (an in-memory list, a resolved put
// request) admits people the chain never hears about.
//
// **Flush in the order the taps happened.** The entries carry a monotonic {@link
// StoredQueueEntry.seq} because the store is keyed by id and `getAll` returns *key* order —
// which is lexicographic on `${tokenId}-${nonce}` and has nothing to do with who walked in
// first. Order matters at reconciliation: when two isolated gates admit the same ticket, the
// earlier submission is the one the chain keeps, and the queue must not shuffle that.
//
// **Never send an op twice.** A `wait()` timeout is not a failure (Task 21): the operation may
// still land. Such an entry becomes `sent`, not `pending`, and is left for Task 29 to settle
// against the chain. Re-sending it would revert `AlreadyCheckedIn` and Task 29 would read our
// own success as a double-entry conflict — a clean check-in recorded as a security incident.
import { ticketAbi } from '../../shared/chain/abis';
import type { SponsoredOpReceipt } from '../../shared/chain/sendSponsoredOp';
import { sendCheckIn, type CheckInFunction } from '../gate/checkInOp';
import { warn } from '../log';
import { staffDb } from '../snapshot/store';
import type { GateCodeWire, GateResponseWire, Hex, QueueEntry } from '../types';

/**
 * The object store one queued check-in lives in, keyed by {@link QueueEntry.id}. The database
 * itself is opened by Task 25's `staffDb()` and nowhere else: two openers at one version means
 * two `upgrade` callbacks, only the first of which ever runs, and the store the loser declared
 * is simply missing — at a door, months later.
 */
export const QUEUE_STORE = 'queue';

/** First retry after a second. */
export const BACKOFF_BASE_MS = 1000;
/**
 * And never longer than a minute. The cap is low on purpose: the queue drains when the gate
 * comes back online, and a venue's network returns in seconds-to-minutes, so an hour-long
 * backoff would leave a door's worth of check-ins parked behind one dead bundler call.
 */
export const BACKOFF_CAP_MS = 60_000;

/**
 * How many sends one entry gets before the queue stops trying. Twenty attempts is about
 * nineteen minutes of a capped backoff — long past "the network blipped" and well into "this
 * one will never succeed on its own". The entry is not dropped: it is parked as `failed` for
 * Task 29, which asks the chain what actually happened to that ticket.
 */
export const MAX_ATTEMPTS = 20;

/**
 * `Ticket.LATE_WINDOW()` — 43,200 s, 12 h (`abi-delta-01b.md:48`).
 *
 * Read the contract for what it bounds, because the obvious reading is wrong. It is **not** a
 * rolling twelve hours from the tap:
 *
 * - `Ticket.sol:437` — `g.issuedAt + LATE_WINDOW < m.startsAt` refuses a code issued more than
 *   the window **before doors**. It is anchored on the event's start, so a code issued at or
 *   after doors never ages out of this check, however late the flush.
 * - `Ticket.sol:419` — `block.timestamp > m.endsAt + LATE_WINDOW` refuses the submission. This
 *   is the only deadline the queue can be sure of: **event end + 12 h**.
 *
 * A gate that parked on `now - issuedAt > 12 h` would throw away work the chain still accepts —
 * taps at 20:00 for an event that ends at 23:00 are good until 11:00 the next morning.
 */
export const LATE_WINDOW_SECONDS = 43_200;

/**
 * How long the drain waits on one op before moving to the next entry. Longer than the online
 * path's 15 s default because nobody is standing at the door for a queued entry, and every
 * second of waiting here is a second of *not* leaving the entry in the `sent` limbo that only
 * Task 29 can resolve.
 */
export const QUEUE_WAIT_TIMEOUT_MS = 20_000;

/** The 01b entry point the queue drains through. */
export const LATE_CHECK_IN_FUNCTION = 'checkInLate' as const;

/** `lastError` on an entry the drain declined to send because the ABI has no `checkInLate`. */
export const DRY_RUN_MARK = 'CHECK_IN_LATE_UNAVAILABLE';
/** `lastError` on an entry parked because the event's deadline passed. See {@link DrainParams.endsAt}. */
export const LATE_WINDOW_ELAPSED = 'LATE_WINDOW_ELAPSED';

/**
 * The name, typed for `sendCheckIn`. `USED_ABI.Ticket` (the app's usage manifest) does not list
 * `checkInLate` yet, so `CheckInFunction` resolves to `'checkIn'` alone and this cast is the
 * marker for that gap — not a way around it. {@link hasLateCheckIn} guards it at runtime: the
 * value never reaches `encodeFunctionData` while the generated ABI lacks the function.
 *
 * The day sub-plan 01b redeploys: add `checkInLate: 3` to `USED_ABI.Ticket` and delete the cast.
 */
const CHECK_IN_LATE = LATE_CHECK_IN_FUNCTION as unknown as CheckInFunction;

/**
 * One queued entry as it is stored. `seq` is the only addition to Task 14's {@link QueueEntry}:
 * the tap order, assigned inside the enqueue transaction so two taps in the same millisecond
 * still come out in the order they were taken — `createdAt` cannot do that, and at a gate the
 * two taps that collide are exactly the ones a reconciliation has to order.
 */
export interface StoredQueueEntry extends QueueEntry {
  seq: number;
}

/** `1 s, 2 s, 4 s …` up to {@link BACKOFF_CAP_MS}. `attempts` is the count *already* made. */
export function backoffMs(attempts: number): number {
  return Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempts);
}

/**
 * Whether the ABI this build was compiled against carries `checkInLate`.
 *
 * It is read from the generated ABI rather than a feature flag for the same reason
 * `eventTopic()` is: a flag can be right while the deployment is not, and then the queue sends
 * an op the contract cannot decode. Until sub-plan 01b redeploys this answers `false` and the
 * drain is a dry run that keeps every entry.
 */
export function hasLateCheckIn(): boolean {
  return ticketAbi.some((entry) => entry.type === 'function' && entry.name === LATE_CHECK_IN_FUNCTION);
}

export interface EnqueueParams {
  code: GateCodeWire;
  response: GateResponseWire;
  /**
   * `Ticket.eventOrg(eventId)`. Taken for symmetry with the online path and deliberately not
   * stored: a gate device serves one event for its whole session, and `drainQueue` is given the
   * org by the screen that owns it. A copy on every row would be one more thing to disagree.
   */
  orgId: bigint;
}

/**
 * Writes the tap down. Resolves **after the commit**, never before — see the note at the top of
 * this file.
 *
 * The id is `${tokenId}-${nonce}`, so the same tap enqueued twice (a double read of one NFC
 * presentation) is one row rather than two check-ins.
 */
export async function enqueueCheckIn(params: EnqueueParams): Promise<StoredQueueEntry> {
  const now = Date.now();
  const db = await staffDb();
  const tx = db.transaction(QUEUE_STORE, 'readwrite');
  const rows = (await tx.store.getAll()) as StoredQueueEntry[];
  const entry: StoredQueueEntry = {
    id: `${params.response.tokenId}-${params.code.nonce}`,
    tokenId: params.response.tokenId,
    gateCode: params.code,
    response: params.response,
    createdAt: now,
    attempts: 0,
    nextAttemptAt: now,
    status: 'pending',
    seq: rows.reduce((max, row) => Math.max(max, row.seq ?? 0), 0) + 1,
  };
  await tx.store.put(entry);
  await tx.done;
  return entry;
}

/** Every entry, oldest tap first. The order is the flush order, and Task 29 reads it too. */
export async function allEntries(): Promise<StoredQueueEntry[]> {
  const rows = (await (await staffDb()).getAll(QUEUE_STORE)) as StoredQueueEntry[];
  return rows.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
}

/**
 * How many check-ins are **still on their way to the chain**: `pending` (waiting for a send) and
 * `sent` (sent, receipt never seen). An op whose receipt never arrived is as unaccounted for as
 * one that has not left, and counting only `pending` would quietly tell a staff member the
 * queue is empty while someone is still missing from it.
 *
 * Parked entries are deliberately **not** in this number — {@link parkedCount} has them. The two
 * ask different things of a staff member: this one drains by itself, that one does not.
 */
export async function pendingCount(): Promise<number> {
  return (await allEntries()).filter((entry) => entry.status === 'pending' || entry.status === 'sent').length;
}

/**
 * How many entries the queue has stopped trying: the attempt limit, or the event's deadline.
 * They are still people who walked through the door — nothing is deleted, and Task 29 settles
 * each of them against the chain.
 */
export async function parkedCount(): Promise<number> {
  return (await allEntries()).filter((entry) => entry.status === 'failed').length;
}

export interface DrainParams {
  orgId: bigint;
  now?: number;
  /**
   * Task 26's `createOnlineWatcher().online` plugs straight in. Injected rather than imported
   * so the queue has no opinion about how "online" is decided — and so this module does not
   * import a file another task owns.
   */
  isOnline?: () => boolean;
  /**
   * `Ticket.eventMeta(eventId).endsAt`, in **seconds**. Past `endsAt + LATE_WINDOW` every entry
   * reverts `EventEnded` for good ({@link LATE_WINDOW_SECONDS}), so the queue parks them rather
   * than spending twenty sponsored sends each on a certain revert.
   *
   * Omitted — today's snapshot does not carry the event's end — **nothing is parked early** and
   * the attempt limit decides. That is the safe direction to be wrong in: a queue that parks
   * eagerly throws away check-ins the chain would still have taken.
   */
  endsAt?: number;
}

/**
 * One pass over the queue, run when the gate comes back online.
 *
 * Sequential on purpose: entries go out in tap order, and one entry's failure only pushes that
 * entry's next attempt out — the rest of the queue keeps going.
 *
 * Every op carries the attendee device's signature over the digest the chain recomputes, so a
 * terminal cannot manufacture an entry here (spec T15); what it can do is fail to send one,
 * which is why nothing in this function ever deletes a row.
 */
export async function drainQueue(params: DrainParams): Promise<StoredQueueEntry[]> {
  const now = params.now ?? Date.now();
  if (params.isOnline && !params.isOnline()) return allEntries();

  const db = await staffDb();
  const lateAvailable = hasLateCheckIn();
  const pastDeadline = params.endsAt !== undefined && now > (params.endsAt + LATE_WINDOW_SECONDS) * 1000;
  let announced = false;

  for (const entry of await allEntries()) {
    if (entry.status !== 'pending') continue;

    // The deadline is the event's, not the entry's, so it parks the whole queue at once —
    // including entries whose backoff has not elapsed, which are just as dead.
    if (pastDeadline) {
      await db.put(QUEUE_STORE, { ...entry, status: 'failed', lastError: LATE_WINDOW_ELAPSED });
      continue;
    }

    if (entry.nextAttemptAt > now) continue;

    if (!lateAvailable) {
      if (!announced) {
        announced = true;
        warn(
          'queue',
          `${DRY_RUN_MARK}: the deployed Ticket ABI has no ${LATE_CHECK_IN_FUNCTION}; ` +
            'entries are kept and will flush after the 01b redeploy.',
        );
      }
      // Marked once. Re-writing an unchanged row on every drain is a whole queue rewritten per
      // pass for no state change.
      if (entry.lastError !== DRY_RUN_MARK) await db.put(QUEUE_STORE, { ...entry, lastError: DRY_RUN_MARK });
      continue;
    }

    try {
      const handle = await sendCheckIn({
        code: entry.gateCode,
        response: entry.response,
        orgId: params.orgId,
        functionName: CHECK_IN_LATE,
      });
      const receipt = await handle.wait(QUEUE_WAIT_TIMEOUT_MS);
      await db.put(QUEUE_STORE, settled(entry, handle.userOpHash, receipt));
    } catch (cause) {
      await db.put(QUEUE_STORE, retried(entry, cause, now));
    }
  }

  return allEntries();
}

/**
 * What one answered send does to the entry.
 *
 * The `'TIMEOUT'` sentinel is the branch worth reading twice: it is a `success: false` that is
 * **not** a verdict — `wait()` stopped looking, the op did not stop existing. It becomes `sent`
 * so nothing re-sends it, and Task 29 asks the chain what became of it.
 */
function settled(entry: StoredQueueEntry, userOpHash: Hex, receipt: SponsoredOpReceipt): StoredQueueEntry {
  const attempts = entry.attempts + 1;
  if (receipt.success) return { ...entry, attempts, userOpHash, status: 'confirmed', lastError: undefined };
  if (receipt.revertReason === 'TIMEOUT') return { ...entry, attempts, userOpHash, status: 'sent', lastError: 'TIMEOUT' };
  return { ...entry, attempts, userOpHash, status: 'failed', lastError: receipt.revertReason };
}

/**
 * A send that never got as far as an answer: back off, or park once {@link MAX_ATTEMPTS} sends
 * have failed. Parked is `failed`, which is where Task 29 looks — never deleted, because the
 * person it records walked through the door whatever the bundler thinks.
 */
function retried(entry: StoredQueueEntry, cause: unknown, now: number): StoredQueueEntry {
  const attempts = entry.attempts + 1;
  const lastError = cause instanceof Error ? cause.message : String(cause);
  if (attempts >= MAX_ATTEMPTS) return { ...entry, attempts, status: 'failed', lastError };
  return { ...entry, attempts, nextAttemptAt: now + backoffMs(attempts), lastError };
}
