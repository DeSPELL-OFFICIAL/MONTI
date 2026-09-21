import { describe, expect, it } from 'vitest';
import { ticketAbi } from '@monti/shared';

import { CHECK_IN_ERRORS, DENY_CODES, GATE_STATES } from './types';

/** Every custom error `Ticket.json` declares, by name. The ABI is 01's export, not a hand list. */
const ABI_ERRORS = new Set(
  ticketAbi.flatMap((entry) => (entry.type === 'error' ? [entry.name] : [])),
);

describe('staff types mirror spec §13', () => {
  it('lists the nine spec §13 DENY codes plus EVENT_ENDED', () => {
    expect([...DENY_CODES]).toEqual([
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
    ]);
  });

  it('lists exactly the eight gate states from the web module table', () => {
    expect([...GATE_STATES]).toEqual([
      'idle',
      'ready',
      'received',
      'confirming',
      'admit',
      'offlineAdmit',
      'deny',
      'override',
    ]);
  });

  it('names a distinct screen for every DENY code and state', () => {
    expect(new Set(DENY_CODES).size).toBe(DENY_CODES.length);
    expect(new Set(GATE_STATES).size).toBe(GATE_STATES.length);
  });
});

describe('the check-in error names are the ABI’s, not a copy of them', () => {
  it('pins the twelve the master plan froze for the DENY map', () => {
    expect([...CHECK_IN_ERRORS]).toEqual([
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
    ]);
  });

  /**
   * The one assertion that survives a contract change: 01 renaming an error silently turns a
   * DENY screen into `TX_FAILED` at the door, because a selector that matches nothing falls
   * through. Here it is a red test instead.
   */
  it('every name is an error Ticket.json actually declares', () => {
    const missing = CHECK_IN_ERRORS.filter((name) => !ABI_ERRORS.has(name));
    expect(missing, `renamed or removed in Ticket.sol: ${missing.join(', ')}`).toEqual([]);
  });

  it('leaves out the offer errors, which no tap can raise', () => {
    // `OfferExpired` and `BadAttesterSig` are `acceptOffer`'s. They are in the ABI and must not
    // be in this list, or the gate would grow a DENY screen nobody can reach.
    for (const name of ['OfferExpired', 'BadAttesterSig']) {
      expect(ABI_ERRORS.has(name)).toBe(true);
      expect(CHECK_IN_ERRORS).not.toContain(name);
    }
  });
});
