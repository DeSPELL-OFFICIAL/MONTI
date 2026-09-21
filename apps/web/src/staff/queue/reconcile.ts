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
// **Silence is not a verdict.** A ticket with no check-in in storage (`ts === 0n`) and a read
// that throws are both "nothing is known yet", and both leave the row exactly as it was. The
// alternative — marking an unanswered op failed — would file people who are already inside as
// people who never got in.
import { readTicket, type CheckInStruct } from '../../shared/chain/reads';
import { mapRevertToDenyCode } from '../gate/denyMap';
import { nonceHashOf } from '../gate/verdict';
import { staffDb } from '../snapshot/store';
import type { DenyCode, Hex } from '../types';
import { QUEUE_STORE, drainQueue, type DrainParams, type StoredQueueEntry } from './opQueue';

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
}

/** One ticket two gates admitted, and which of them the chain kept. */
export interface QueueConflict {
  tokenId: string;
  firstGateId: string;
  firstTs: number;
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
        await settleSent(entry, report);
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
 * An op that was sent and never answered (Task 28 keeps it as `sent` and never re-sends it, so
 * this is the only thing that can end it). The chain is the one place that knows.
 */
async function settleSent(entry: ReconciledEntry, report: ReconcileReport): Promise<void> {
  const onChain = await checkInOnChain(entry.tokenId);
  if (!onChain || onChain.ts === 0n) return;
  if (isOurs(entry, onChain)) {
    await confirm(entry, onChain);
    report.confirmed += 1;
    return;
  }
  report.conflicts.push(await recordConflict(entry, onChain));
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
  if (!onChain || onChain.ts === 0n) {
    report.failed += 1;
    return;
  }
  // Our own tap, refused on a second send of it. The queue does not re-send a `sent` entry, so
  // this is the drain having answered twice — not a double entry.
  if (isOurs(entry, onChain)) {
    await confirm(entry, onChain);
    report.confirmed += 1;
    return;
  }
  report.conflicts.push(await recordConflict(entry, onChain));
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

/**
 * Whether the check-in the chain kept is the one this row was built from.
 *
 * `nonceHashOf` is Task 24's, hash and length check included: a nonce that is not 32 bytes
 * throws rather than being padded into a hash no gate ever served, and a row we cannot hash is
 * simply not provably ours — which is the safe side to be wrong on for the `sent` path (it stays
 * unsettled) but would be the wrong side for a conflict, so the parked path reaches here only
 * after the chain has already said someone is in.
 */
function isOurs(entry: ReconciledEntry, onChain: CheckInStruct): boolean {
  try {
    return onChain.nonceHash.toLowerCase() === nonceHashOf(entry.gateCode.nonce as Hex).toLowerCase();
  } catch {
    return false;
  }
}

/** Our op landed after all. The timeout sentinel goes with it — it was never a failure. */
async function confirm(entry: ReconciledEntry, onChain: CheckInStruct): Promise<void> {
  await put({
    ...entry,
    status: 'confirmed',
    lastError: undefined,
    deny: undefined,
    firstGateId: onChain.gateId.toString(),
    firstTs: Number(onChain.ts),
  });
}

/**
 * Somebody else's gate admitted this ticket first. The person we let in is already inside and
 * nothing here tries to undo that; what is written down is who the chain kept and when.
 */
async function recordConflict(entry: ReconciledEntry, onChain: CheckInStruct): Promise<QueueConflict> {
  const settled: ReconciledEntry = {
    ...entry,
    status: 'conflict',
    deny: 'ALREADY_USED',
    firstGateId: onChain.gateId.toString(),
    firstTs: Number(onChain.ts),
  };
  await put(settled);
  return conflictOf(settled);
}

/**
 * The defaults are unreachable for a row this module wrote — both fields are set with the
 * status — and exist so a row from an older build cannot crash the screen that lists it.
 */
function conflictOf(entry: ReconciledEntry): QueueConflict {
  return { tokenId: entry.tokenId, firstGateId: entry.firstGateId ?? '0', firstTs: entry.firstTs ?? 0 };
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

async function put(entry: ReconciledEntry): Promise<void> {
  await (await staffDb()).put(QUEUE_STORE, entry);
}
