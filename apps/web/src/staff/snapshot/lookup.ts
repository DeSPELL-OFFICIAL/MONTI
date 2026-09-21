// Reading one token out of a snapshot — the three answers, and no fourth.
//
// A refusal named here is always one of `staff/types.ts`'s thirteen DENY codes (Task 22), which
// are `@monti/shared`'s list: the attendee's phone shows the sentence for the code the staff
// phone picked, so a word invented locally is a blank screen on the other side of the door.
//
// These are pure functions over a snapshot. The store binds them to the one it is holding; the
// gate screen and Task 27's offline path read them through the store, never by walking
// `snapshot.tickets` themselves — one place decides what a cleared device key means.
import type { SnapshotWire } from '@monti/shared';

import type { DenyCode, Hex, SnapshotTicket } from '../types';

/** The 32 zero bytes a snapshot carries for a ticket whose device key has been cleared. */
const ZERO_WORD = `0x${'00'.repeat(32)}`;

/**
 * Compared case-insensitively. The hex casing in a snapshot is the attester's choice, not this
 * module's, and an uppercase `0X00…` slipping past here would hand a locked device to a door.
 */
const isZeroWord = (word: string): boolean => word.toLowerCase() === ZERO_WORD;

/** The two halves of an attendee's active P-256 key, as Task 27 verifies a `deviceSig` with. */
export interface DeviceKey {
  x: Hex;
  y: Hex;
}

/**
 * `known: false` is **not** a refusal. The snapshot is a photograph taken up to ten minutes ago
 * and the ticket may have been issued since; online the chain decides, offline Task 27 refuses.
 * Conflating the two here is how a freshly bought ticket gets turned away.
 */
export type SnapshotLookup =
  | { known: false; ticket?: undefined; deny?: undefined }
  | { known: true; ticket: SnapshotTicket; deny?: DenyCode };

/**
 * What the row alone justifies refusing, and nothing that needs the tap, the gate code or the
 * chain — `WRONG_EVENT` needs the code the gate served, so `preflight` (Task 20) names that one.
 */
export function snapshotDeny(ticket: SnapshotTicket): DenyCode | undefined {
  if (ticket.checkedIn) return 'ALREADY_USED';
  if (isZeroWord(ticket.deviceX) || isZeroWord(ticket.deviceY)) return 'DEVICE_LOCKED';
  return undefined;
}

export function lookupIn(snapshot: SnapshotWire | undefined, tokenId: string): SnapshotLookup {
  const ticket = snapshot?.tickets.find((entry) => entry.tokenId === tokenId);
  if (!ticket) return { known: false };
  return { known: true, ticket, deny: snapshotDeny(ticket) };
}

/**
 * A cleared key is not a key: handing 32 zero bytes to a signature verifier is how it comes back
 * saying "valid". A locked device answers `undefined` here and `DEVICE_LOCKED` above.
 */
export function deviceKeyIn(snapshot: SnapshotWire | undefined, tokenId: string): DeviceKey | undefined {
  const ticket = snapshot?.tickets.find((entry) => entry.tokenId === tokenId);
  if (!ticket || isZeroWord(ticket.deviceX) || isZeroWord(ticket.deviceY)) return undefined;
  return { x: ticket.deviceX, y: ticket.deviceY };
}
