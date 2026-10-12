import { describe, expect, it } from 'vitest';
import { deriveDetailView, deriveTicketState, shortTicketNumber } from './ticketState';

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

describe('deriveDetailView', () => {
  it('offers the way in and the handover on a ticket waiting at the door', () => {
    expect(deriveDetailView('before', null)).toEqual({ canEnter: true, canTransfer: true, refunded: false, entered: false });
    expect(deriveDetailView('before', 'deposited')).toEqual({ canEnter: true, canTransfer: true, refunded: false, entered: false });
  });

  it('takes both actions away once the order is refunded', () => {
    expect(deriveDetailView('before', 'refunded')).toEqual({ canEnter: false, canTransfer: false, refunded: true, entered: false });
  });

  it('reads a used ticket as 입장 완료, with neither action', () => {
    expect(deriveDetailView('entered', null)).toEqual({ canEnter: false, canTransfer: false, refunded: false, entered: true });
    expect(deriveDetailView('entered', 'released')).toEqual({ canEnter: false, canTransfer: false, refunded: false, entered: true });
  });

  it('trusts a released order over an indexer that has not seen the check-in yet', () => {
    expect(deriveDetailView('before', 'released')).toEqual({ canEnter: false, canTransfer: false, refunded: false, entered: true });
  });

  it('offers neither on a ticket that is no longer waiting', () => {
    expect(deriveDetailView('cancelled', null)).toEqual({ canEnter: false, canTransfer: false, refunded: false, entered: false });
    expect(deriveDetailView('transferred', 'released')).toEqual({ canEnter: false, canTransfer: false, refunded: false, entered: false });
  });
});

describe('shortTicketNumber', () => {
  it('keeps two digits and the last four of a long number', () => {
    const id = '7930739067677860193113749428633';
    expect(shortTicketNumber(id)).toEqual({ lead: '42', tail: '8633' });
  });

  it('leaves a short number whole in the tail', () => {
    expect(shortTicketNumber('42')).toEqual({ lead: '', tail: '42' });
    expect(shortTicketNumber('12345')).toEqual({ lead: '1', tail: '2345' });
  });
});
