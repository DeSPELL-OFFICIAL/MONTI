// What became of the check-ins the gate could not finish telling the chain about.
//
// Spec §12 accepts that two isolated terminals can both admit the same ticket, and asks for the
// honest record afterwards rather than a way to prevent it. This module is that record, and
// three rules shape every branch below.
//
// **The nonce decides whose check-in it is, never the ticket.** `checkInOf(tokenId)` answers
// with *a* check-in, not with *ours*. The one field that says which tap it was is
// `nonceHash = keccak256(abi.encode(g.nonce))` (`Ticket.sol:360`), and the queue row still
// carries the raw nonce it was built from. Matching hash → our op landed. A different hash →
// somebody else's gate got there first. Skipping that test would read our own success as a
// double-entry conflict, filing a clean check-in as a security incident.
//
// **A conflict is terminal.** Nothing is retried after one: the chain has let a person in on
// that ticket and no amount of resending changes it. The row keeps who won and when, and this
// module never reads the chain about it again.
//
// **Silence is not a verdict, but it is not forever either.** A read that *throws* is "nothing is
// known" and always leaves the row untouched — offline is not evidence. A read that *answers*
// `ts === 0n` is evidence: the chain has no record of this ticket at all. After
// {@link REARM_AFTER_MS} of that answer the operation is treated as lost and the row goes back to
// `pending` to be sent again — at most {@link MAX_REARMS} times, then it parks as
// `RESEND_EXHAUSTED` for a person. The nonce test above is what makes re-sending safe: if the
// first op was not lost after all, the second one's `AlreadyCheckedIn` settles as `confirmed`.
//
// **The chain's answer is written onto the chain's row, not ours.** Every settlement is a
// compare-and-set inside one transaction: re-read, bail if the status moved, merge onto what is
// actually stored. The `eth_call` between the drain's snapshot and the write is long enough for a
// staff member's retry or a concurrent pass to land, and `{...snapshot}` would silently undo it.
import { readTicket, type CheckInStruct } from '../../shared/chain/reads';
import { mapRevertToDenyCode } from '../gate/denyMap';
import { nonceHashOf } from '../gate/verdict';
import { staffDb } from '../snapshot/store';
import { RESEND_EXHAUSTED, type DenyCode, type Hex } from '../types';
import {
  QUEUE_STORE,
  drainQueue,
  type DrainParams,
  type StoredQueueEntry,
} from './opQueue';

/**
 * How long the chain has to say "nothing here" before a `sent` operation counts as lost. Ten
 * minutes is far past the bundler's own life for an operation and past any Monad finality, so an
 * op still in flight is not what this is looking at.
 */
export const REARM_AFTER_MS = 10 * 60_000;

/**
 * How many times one row may be re-armed. Three is enough to ride out a bundler having a bad
 * afternoon; past it, something is wrong that another send will not fix, and cycling forever
 * would hide the ticket from the only thing that can help — a person reading the screen.
 */
export const MAX_REARMS = 3;

/**
 * A queue row with what reconciliation learned about it.
 *
 * The three fields are additive on Task 28's stored shape rather than a change to
 * `staff/types.ts`, for the same reason `StoredQueueEntry` added `seq` there: the row is written
 * by this module and read by the screen, and nothing between them needs to know. They are set
 * together and only on a settled row — `firstGateId`/`firstTs` are the chain's own answer, and
 * `deny` is the staff vocabulary for it (`ALREADY_USED`, and today nothing else).
 */
export interface ReconciledEntry extends StoredQueueEntry {
  /** `checkInOf(tokenId).gateId` — the gate whose check-in the chain kept. */
  firstGateId?: string;
  /** `checkInOf(tokenId).ts`, unix **seconds**: when that tap was recorded. */
  firstTs?: number;
  /** Why this row is a conflict, in the DENY vocabulary both apps read. */
  deny?: DenyCode;
  /**
   * `checkInOf(tokenId).manual` — an organizer let this ticket in by hand
   * (`Ticket.manualOverride`, `Ticket.sol:394-416`). Still terminal for the queue, and still not
   * another gate having tapped, so the screen must not say one gate beat another.
   */
  manual?: boolean;
}

/** One ticket two gates admitted, and which of them the chain kept. */
export interface QueueConflict {
  tokenId: string;
  firstGateId: string;
  firstTs: number;
  /** The ticket was admitted by an organizer's manual override, not by another gate's tap. */
  manual?: boolean;
}

export interface ReconcileReport {
  /** Rows the chain has confirmed — settled this pass or already settled. */
  confirmed: number;
  /** Every standing conflict in the queue, not just the ones found this pass. */
  conflicts: QueueConflict[];
  /**
   * Rows that are parked and are **not** a conflict: a revert with another reason, a deadline
   * that passed, a send that never got an answer. They wait for a staff member's retry.
   */
  failed: number;
}

/**
 * Drain what can still be sent, then settle everything the drain cannot: `sent` entries whose
 * receipt never arrived, and parked entries that reverted `AlreadyCheckedIn`.
 *
 * Safe to run again. Every branch either writes a terminal state or leaves the row untouched,
 * so a pass made while the gate is offline costs one failed `eth_call` per unsettled entry and
 * changes nothing.
 */
export async function reconcileQueue(params: DrainParams): Promise<ReconcileReport> {
  const entries = (await drainQueue(params)) as ReconciledEntry[];
  const now = params.now ?? Date.now();
  const report: ReconcileReport = { confirmed: 0, conflicts: [], failed: 0 };

  for (const entry of entries) {
    switch (entry.status) {
      case 'confirmed':
        report.confirmed += 1;
        break;
      case 'conflict':
        // Settled means settled: no second read, no retry, and it stays on the screen.
        report.conflicts.push(conflictOf(entry));
        break;
      case 'sent':
        await settleSent(entry, report, now);
        break;
      case 'failed':
        await settleParked(entry, report);
        break;
      default:
        // `pending` — still on its way. The drain owns it.
        break;
    }
  }

  return report;
}

/**
 * An op that was sent and never answered (Task 28 keeps it as `sent` and never re-sends it on its
 * own, so this is the only thing that can end it). The chain is the one place that knows.
 */
async function settleSent(entry: ReconciledEntry, report: ReconcileReport, now: number): Promise<void> {
  const onChain = await checkInOnChain(entry.tokenId);
  // The read failed. Offline is not evidence of anything, least of all of a lost operation.
  if (onChain === undefined) return;
  if (onChain.ts === 0n) {
    await rearm(entry, report, now);
    return;
  }

  switch (whose(entry, onChain)) {
    case 'ours':
      if (await confirm(entry, onChain)) report.confirmed += 1;
      return;
    // A nonce this build cannot hash. We cannot say the check-in on chain is ours, and we
    // certainly cannot say it is somebody else's — naming a gate on a guess is the one thing a
    // conflict record must never do. Leave it for the next pass, and for a person.
    case 'unknown':
      return;
    default: {
      const conflict = await recordConflict(entry, onChain);
      if (conflict) report.conflicts.push(conflict);
    }
  }
}

/**
 * The chain answered that this ticket has no check-in at all. Either the operation is still on
 * its way, or it was dropped somewhere and nobody will ever hear about it again — and the only
 * way to tell the two apart is to wait, then send it once more and see.
 *
 * It parks rather than cycling forever, because a row that has been re-armed three times is not
 * having a bad minute: something about this operation does not work, and the person reading the
 * screen is the one who can do something about it.
 */
async function rearm(entry: ReconciledEntry, report: ReconcileReport, now: number): Promise<void> {
  // `sentAt` is when the operation went out (`opQueue.settled`). `createdAt` is the fallback for
  // a row written before that field existed, and errs towards waiting longer, never shorter.
  if (now - (entry.sentAt ?? entry.createdAt) < REARM_AFTER_MS) return;

  const rearms = entry.rearms ?? 0;
  if (rearms >= MAX_REARMS) {
    if (await write(entry, { status: 'failed', lastError: RESEND_EXHAUSTED })) report.failed += 1;
    return;
  }
  await write(entry, {
    status: 'pending',
    attempts: 0,
    nextAttemptAt: now,
    lastError: undefined,
    rearms: rearms + 1,
  });
}

/**
 * A parked entry. Only an `AlreadyCheckedIn` revert asks the chain anything: every other reason
 * is a send that never reached `Ticket.checkInLate`, so there is nothing on chain to read and a
 * staff member's retry is the next step.
 */
async function settleParked(entry: ReconciledEntry, report: ReconcileReport): Promise<void> {
  const { code } = mapRevertToDenyCode(revertBytesOf(entry.lastError));
  if (code !== 'ALREADY_USED') {
    report.failed += 1;
    return;
  }

  const onChain = await checkInOnChain(entry.tokenId);
  // The revert says somebody is in, the read cannot yet say who. Leave it parked and ask again:
  // a conflict written without the winning gate would be a record that names nobody.
  if (onChain === undefined || onChain.ts === 0n) {
    report.failed += 1;
    return;
  }

  switch (whose(entry, onChain)) {
    // Our own tap, refused on a second send of it — a re-armed row whose first operation landed
    // after all. Not a double entry.
    case 'ours':
      if (await confirm(entry, onChain)) report.confirmed += 1;
      return;
    case 'unknown':
      report.failed += 1;
      return;
    default: {
      const conflict = await recordConflict(entry, onChain);
      if (conflict) report.conflicts.push(conflict);
    }
  }
}

/**
 * `Ticket.checkInOf`, through Task 24's reader — the same one-shot read the gate's verdict uses,
 * so there is one spelling of this call and one place its struct shape is pinned
 * (`reads.ts`'s `CHECK_IN_FIELDS`, which the 01b redeploy reorders).
 *
 * A throw is not an answer: no signal, or a node that refused. `undefined` says so.
 */
async function checkInOnChain(tokenId: string): Promise<CheckInStruct | undefined> {
  try {
    return await readTicket().checkInOf(BigInt(tokenId));
  } catch {
    return undefined;
  }
}

/** Whose check-in the chain kept — and `'unknown'` when this build cannot tell. */
type Whose = 'ours' | 'theirs' | 'manual' | 'unknown';

/**
 * Which of those the stored check-in is.
 *
 * `manual` comes first and never reaches the hash. `Ticket.manualOverride` writes
 * `nonceHash = bytes32(0)` with `manual = true` (`Ticket.sol:416`) — an organizer admitted this
 * ticket by hand, naming a gate that did not tap. Falling through to the hash would file it as
 * "another gate got there first", which is a sentence about an event that did not happen.
 *
 * `nonceHashOf` is Task 24's, hash and length check included: a nonce that is not 32 bytes
 * throws rather than being padded into a hash no gate ever served. That is `'unknown'` and its
 * own answer, never a quiet `'theirs'`: both callers leave such a row alone rather than record a
 * conflict against a gate the evidence does not name.
 */
function whose(entry: ReconciledEntry, onChain: CheckInStruct): Whose {
  if (onChain.manual) return 'manual';
  let expected: string;
  try {
    expected = nonceHashOf(entry.gateCode.nonce as Hex).toLowerCase();
  } catch {
    return 'unknown';
  }
  return onChain.nonceHash.toLowerCase() === expected ? 'ours' : 'theirs';
}

/** Our op landed after all. The timeout sentinel goes with it — it was never a failure. */
async function confirm(entry: ReconciledEntry, onChain: CheckInStruct): Promise<boolean> {
  return write(entry, {
    status: 'confirmed',
    lastError: undefined,
    deny: undefined,
    firstGateId: onChain.gateId.toString(),
    firstTs: Number(onChain.ts),
  });
}

/**
 * This ticket was admitted without us: another gate's tap, or an organizer's manual override.
 * The person we let in is already inside and nothing here tries to undo that; what is written
 * down is what the chain kept and when — and **which of the two it was**, because "another gate
 * got there first" and "someone let them in by hand" are different things to say to a staff
 * member, and only one of them names a gate that tapped.
 *
 * `undefined` when the row moved under us, so the report does not name a conflict that was not
 * written.
 */
async function recordConflict(
  entry: ReconciledEntry,
  onChain: CheckInStruct,
): Promise<QueueConflict | undefined> {
  const settlement = {
    status: 'conflict',
    deny: 'ALREADY_USED',
    manual: onChain.manual,
    firstGateId: onChain.gateId.toString(),
    firstTs: Number(onChain.ts),
  } as const satisfies Partial<ReconciledEntry>;
  if (!(await write(entry, settlement))) return undefined;
  return conflictOf({ ...entry, ...settlement });
}

/**
 * The defaults are unreachable for a row this module wrote — both fields are set with the
 * status — and exist so a row from an older build cannot crash the screen that lists it.
 */
function conflictOf(entry: ReconciledEntry): QueueConflict {
  return {
    tokenId: entry.tokenId,
    firstGateId: entry.firstGateId ?? '0',
    firstTs: entry.firstTs ?? 0,
    manual: entry.manual,
  };
}

/**
 * `lastError` holds either reason bytes from a receipt or one of the queue's own marks
 * (`LATE_WINDOW_ELAPSED`, `CHECK_IN_LATE_UNAVAILABLE`, a thrown `Error.message`). Only the first
 * is a revert, and handing a mark to the selector table would be asking what `'LATE_WINDO'`
 * means.
 */
function revertBytesOf(lastError: string | undefined): Hex | undefined {
  return lastError !== undefined && /^0x[0-9a-fA-F]{8,}$/.test(lastError) ? (lastError as Hex) : undefined;
}

/**
 * Merges a settlement onto the row **as the store holds it now**, in one transaction, and only
 * while nothing has moved it since the drain handed us the snapshot.
 *
 * The compare is on `status` because that is what every writer here changes: a staff member's
 * `retryEntry` tap or a concurrent drain lands inside the `eth_call` this settlement waited on,
 * and writing `{...snapshot}` back would undo it — losing `attempts`, `nextAttemptAt`,
 * `userOpHash`, or putting a re-armed row back into the state it was rescued from. Merging onto
 * `current` keeps whatever the other writer set and changes only the fields this answer is about.
 *
 * `false` means the row moved; the caller reports nothing and the next pass reads the new state.
 */
async function write(entry: ReconciledEntry, changes: Partial<ReconciledEntry>): Promise<boolean> {
  const db = await staffDb();
  const tx = db.transaction(QUEUE_STORE, 'readwrite');
  const current = (await tx.store.get(entry.id)) as ReconciledEntry | undefined;
  if (current === undefined || current.status !== entry.status) {
    await tx.done;
    return false;
  }
  await tx.store.put({ ...current, ...changes });
  await tx.done;
  return true;
}
