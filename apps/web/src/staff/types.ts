// The staff console's state vocabulary: the words every screen from the gate to the queue
// reads its meaning from. Nothing here is a second spelling of something that already exists.
//
// The wire formats (`GateCodeWire`, `GateResponseWire`, `SnapshotTicket`) belong to
// `@monti/shared`, which the attendee phone, the indexer and the contracts also read; they are
// re-exported rather than restated so a field added there cannot be missed here. The names in
// `CHECK_IN_ERRORS` belong to `Ticket.sol` and are pinned against its exported ABI by the test
// beside this file. What this module *owns* is the two vocabularies that exist only on the
// staff device: the DENY codes a refusal is shown as, and the states a gate moves through.
import type { GateCodeWire, GateResponseWire, Hex, SnapshotTicket } from '@monti/shared';

export type { GateCodeWire, GateResponseWire, Hex, SnapshotTicket };

/**
 * Spec §13's nine refusal rows, plus `EVENT_ENDED` — the tenth, which the spec table leaves
 * implicit because the door is normally shut by then, and which `Ticket.checkIn` reverts with
 * all the same.
 *
 * The order is the table's and is load-bearing only in that a diff against the spec should read
 * as a diff. Every one of these is a screen the attendee is shown and a staff member has to be
 * able to explain, which is why a revert with no row here becomes `TX_FAILED` rather than a new
 * code invented at the door.
 */
export const DENY_CODES = [
  'ALREADY_USED',
  'WRONG_EVENT',
  'REVOKED',
  'EXPIRED_CODE',
  'NO_TICKET',
  'GATE_CLOSED',
  'EVENT_ENDED',
  'DEVICE_LOCKED',
  'DEVICE_MISMATCH',
  'TX_FAILED',
] as const;

export type DenyCode = (typeof DENY_CODES)[number];

/**
 * `Ticket.sol`'s custom errors on the check-in surface, frozen by the master plan so the staff
 * DENY map can key off their selectors. The list is names only: the selectors are derived, and
 * deriving them from a name that no longer exists is exactly the silent failure the test
 * beside this file exists to catch — an unmatched selector falls through to `TX_FAILED`, so a
 * renamed error shows the wrong screen rather than crashing.
 *
 * `EventNotPublished` is here although `checkIn` cannot raise it today (only `mint` does): the
 * master plan froze it in this set, and Task 22 maps it to `TX_FAILED` with its own sentence,
 * because a gate opened against a draft event is a configuration mistake the staff must be able
 * to read. The offer errors (`OfferExpired`, `BadAttesterSig`) are deliberately absent — no tap
 * can reach them.
 */
export const CHECK_IN_ERRORS = [
  'AlreadyCheckedIn',
  'WrongEvent',
  'TicketRevoked',
  'CodeExpired',
  'NoSuchTicket',
  'GateNotOpen',
  'GateMismatch',
  'DeviceLocked',
  'BadDeviceSignature',
  'EventNotPublished',
  'EventEnded',
  'EventCancelled',
] as const;

export type CheckInError = (typeof CHECK_IN_ERRORS)[number];

/**
 * The gate screen's states. `admit` and `offlineAdmit` are separate on purpose: the second is a
 * ticket the chain has not yet accepted, and a screen that cannot tell the two apart is a
 * screen that lets a staff member believe a queued entry is settled.
 *
 * There is no "soft admit" — nothing between `confirming` and a verdict. Spec §7.2.
 */
export const GATE_STATES = [
  'idle',
  'ready',
  'received',
  'confirming',
  'admit',
  'offlineAdmit',
  'deny',
  'override',
] as const;

export type GateState = (typeof GATE_STATES)[number];

/**
 * The answer the signed snapshot alone can give, before any chain call. `ok: false` always
 * carries the `deny` that says why, so a refusal never reaches the screen without a reason.
 */
export interface PreflightResult {
  ok: boolean;
  deny?: DenyCode;
  ticket?: SnapshotTicket;
}

/**
 * One check-in waiting to reach the chain. It is a record of a person who already walked in,
 * so it is durable (IndexedDB, Task 28) and is never dropped on a failure the gate cannot
 * explain: `status` distinguishes "not sent yet" from "the chain refused it", and `conflict`
 * from both, because a `ALREADY_USED` on a resend is a reconciliation note rather than an error.
 */
export interface QueueEntry {
  id: string;
  tokenId: string;
  gateCode: GateCodeWire;
  response: GateResponseWire;
  createdAt: number;
  attempts: number;
  nextAttemptAt: number;
  status: 'pending' | 'sent' | 'confirmed' | 'conflict' | 'failed';
  lastError?: string;
  userOpHash?: Hex;
}

/**
 * Everything the gate screen renders from, in one object. `finalized`, `pendingCount`,
 * `snapshotAgeMs` and `online` are here rather than in a separate status bar model because a
 * staff member reads them together with the verdict — "admitted, but nothing has reached the
 * chain in ten minutes" is one fact, not two.
 */
export interface GateContext {
  state: GateState;
  gateId: bigint;
  eventId: bigint;
  orgId: bigint;
  deny?: DenyCode;
  denyDetail?: string;
  ticket?: SnapshotTicket;
  blockNumber?: bigint;
  finalized: boolean;
  pendingCount: number;
  snapshotAgeMs: number;
  online: boolean;
}
