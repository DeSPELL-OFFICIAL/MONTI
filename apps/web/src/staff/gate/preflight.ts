// What the signed snapshot alone can say about a tap, before any chain call is made.
//
// This exists to spend fewer transactions and to put a refusal on screen in milliseconds rather
// than seconds (spec §7.2-5). It is **not** a verdict. Nothing here turns a tap green: only the
// chain (Task 24) or the offline path (Task 27) admits anybody, and a preflight that passed is
// only a check-in worth sending.
//
// The asymmetry is deliberate and is the whole design. A snapshot that says "denied" is trusted
// — it was signed by the attester and the facts it carries (this ticket is already used, this
// is another event's ticket) do not become false while the gate holds it. A snapshot that says
// "I have never heard of this token" is NOT trusted, because it may simply be stale: the
// attendee could have been issued the ticket after the last sync. So an unknown token is sent
// to the chain anyway and the chain decides. Offline there is no chain to ask and no device key
// to verify against, so there the same answer is a refusal — see `isUnknownToSnapshot`.
import type { GateCodeWire, GateResponseWire, SnapshotWire } from '@monti/shared';

import type { PreflightResult, SnapshotTicket } from '../types';

/**
 * The slice of Task 25's snapshot store this module needs, declared here so preflight can be
 * written and tested before that store exists. Task 25 implements it; nothing else about the
 * store — refresh, signature verification, IndexedDB — belongs in this interface, because
 * nothing else about it changes what a preflight answers.
 */
export interface SnapshotStore {
  /** The snapshot this gate is running on, or `undefined` before the first sync lands. */
  current(): SnapshotWire | undefined;
}

/**
 * The stub until Task 25 lands. A gate built on this one has no snapshot unless a test hands it
 * one, which is exactly the state a gate boots in — so the "no snapshot yet" branch below is
 * the branch that runs first in real life, not an edge case.
 */
export function stubSnapshotStore(snapshot?: SnapshotWire): SnapshotStore {
  return { current: () => snapshot };
}

/** The 32 zero bytes a snapshot carries for a ticket whose device key has been cleared. */
const ZERO_WORD = `0x${'00'.repeat(32)}`;

export interface PreflightParams {
  /** `SnapshotStore.current()`. `undefined` is a gate that has not synced yet, not an error. */
  snapshot: SnapshotWire | undefined;
  /** The code this answer names — `matchIssuedCode` (Task 19) resolved it from the nonce. */
  code: GateCodeWire;
  response: GateResponseWire;
}

/**
 * Mirrors the checks `Ticket.checkIn` makes on chain (spec §7.2-6 ①~⑤) against the local
 * snapshot. The clock checks are not repeated here: Task 19's `matchIssuedCode` already applied
 * `isGateCodeFresh`, which is the chain's own window, and a second reading of it in a second
 * place is how the gate and the chain come to disagree about who may walk in.
 */
export function preflight({ snapshot, code, response }: PreflightParams): PreflightResult {
  // No snapshot yet. Refusing everyone would close the door on the gate's first minutes; the
  // chain is reachable or the offline path will refuse, and neither needs help from here.
  if (!snapshot) return { ok: true };

  // The gate's own code and the gate's own snapshot disagree about which event this door is.
  // That is a setup mistake rather than a bad ticket, but it is still a refusal: a check-in
  // sent from here could only revert `WrongEvent`, and staff need to see the same word twice.
  if (snapshot.eventId !== code.eventId) return { ok: false, deny: 'WRONG_EVENT' };

  const ticket = snapshot.tickets.find((entry) => entry.tokenId === response.tokenId);

  // Not in the snapshot. Possibly revoked, possibly another event's, possibly issued since the
  // last sync — the snapshot carries no `revoked` flag, so all three look identical here. The
  // chain can tell them apart (`TicketRevoked`, `WrongEvent`, or an admit) and this cannot.
  if (!ticket) return { ok: true };

  if (ticket.checkedIn) return { ok: false, deny: 'ALREADY_USED', ticket };
  if (ticket.deviceX === ZERO_WORD || ticket.deviceY === ZERO_WORD) {
    return { ok: false, deny: 'DEVICE_LOCKED', ticket };
  }

  return { ok: true, ticket };
}

/**
 * The third answer, spelled out: the snapshot passed the tap on without recognising it.
 *
 * Online that means "send it, the chain decides". Offline it means a refusal, and not because
 * of a policy choice — there is literally nothing to check the `deviceSig` against, so an
 * offline admit here would be an admit on the attendee's word alone.
 */
export function isUnknownToSnapshot(result: PreflightResult): boolean {
  return result.ok && result.ticket === undefined;
}

/** The ticket a passed preflight recognised, for the screen to draw. `undefined` if unknown. */
export function recognisedTicket(result: PreflightResult): SnapshotTicket | undefined {
  return result.ok ? result.ticket : undefined;
}
