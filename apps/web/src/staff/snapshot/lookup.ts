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

/**
 * How many rows a search may put on the phone at once.
 *
 * It is a cap rather than a scroll on purpose. A one-character query over a ten-thousand-row
 * guest list matches most of it, and a staff member who has to scroll past forty faces to find
 * a name is slower than one who is told to type another letter — and the whole point of this
 * path is the attendee standing there with a phone that will not open.
 */
export const SEARCH_LIMIT = 8;

/**
 * Finding somebody in the guest list by what a staff member can actually read off them: the
 * name on the ticket, or the ticket number they can read aloud.
 *
 * It lives here rather than in the dialog for the same reason `lookupIn` does — one place
 * decides what a snapshot row means. The dialog is handed the answer.
 *
 * The two matches are deliberately different. A **name** matches as a substring, because a staff
 * member types what they hear and Korean names are short. A **number** matches by suffix, because
 * the console masks all but the last two digits (`Console.tsx`'s `maskTicketId`), so the digits a
 * staff member can see are the trailing ones — and an exact full number still matches, since a
 * string is a suffix of itself.
 *
 * A row the list already refuses (`snapshotDeny`) is **not** filtered out. An `ALREADY_USED`
 * ticket is exactly the kind of case that gets escalated to a manual approval, and hiding it
 * would leave the staff member unable to name the person they are standing in front of.
 */
export function searchIn(
  snapshot: SnapshotWire | undefined,
  query: string,
  limit = SEARCH_LIMIT,
): readonly SnapshotTicket[] {
  const needle = query.trim().toLowerCase();
  if (needle === '' || !snapshot) return [];
  const digits = /^[0-9]+$/.test(needle);
  const out: SnapshotTicket[] = [];
  for (const ticket of snapshot.tickets) {
    const hit = digits
      ? ticket.tokenId.endsWith(needle)
      : ticket.displayName.toLowerCase().includes(needle);
    if (!hit) continue;
    out.push(ticket);
    if (out.length >= limit) break;
  }
  return out;
}
