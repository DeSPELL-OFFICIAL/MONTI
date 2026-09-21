import { describe, expect, it } from 'vitest';
import { deriveTicketState } from './ticketState';

const base = { ownerIsMe: true, revoked: false, checkIn: null, offer: null, now: 1_790_000_000 };

describe('deriveTicketState', () => {
  it('maps every spec state', () => {
    expect(deriveTicketState(base)).toBe('before');
    expect(deriveTicketState({ ...base, revoked: true })).toBe('cancelled');
    expect(deriveTicketState({ ...base, ownerIsMe: false })).toBe('transferred');
    expect(deriveTicketState({ ...base, checkIn: { ts: 1 } })).toBe('entered');
    expect(deriveTicketState({ ...base, offer: { expiresAt: 1_790_000_100, status: 'open' } })).toBe('pendingOffer');
  });

  it('ignores an expired or cancelled offer', () => {
    expect(deriveTicketState({ ...base, offer: { expiresAt: 1_789_999_000, status: 'open' } })).toBe('before');
    expect(deriveTicketState({ ...base, offer: { expiresAt: 1_790_000_100, status: 'cancelled' } })).toBe('before');
  });

  // A called-off event shows the same 취소됨 badge as a revoked ticket: the chain says so in two
  // different places (Ticket.Revoked and EventStatusChanged), the attendee sees one word.
  it('marks a ticket on a cancelled event as cancelled', () => {
    expect(deriveTicketState({ ...base, eventCancelled: true })).toBe('cancelled');
    expect(deriveTicketState({ ...base, eventCancelled: true, checkIn: { ts: 1 } })).toBe('cancelled');
  });
});
