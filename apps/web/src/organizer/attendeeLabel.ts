import type { AttendeeRow } from '@monti/shared';
import { shortId } from '../shared/shortId';

/**
 * How one attendee is named on the organiser's list. The nickname is the only human-readable
 * thing `listAttendees` carries (no phone, no legal name), and most people never set one — so a
 * row without it falls back to the guest word and the ticket's own short number, which is what
 * tells two such rows apart. Never an empty cell.
 */
export function attendeeLabel(row: Pick<AttendeeRow, 'nickname' | 'tokenId'>, guest: string): string {
  const nickname = row.nickname.trim();
  if (nickname !== '') return nickname;
  return `${guest} · ${shortId(row.tokenId)}`;
}
