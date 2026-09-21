import { describe, expect, it } from 'vitest';
import { GATE_DENY_CODES, ticketAbi } from '@monti/shared';

import {
  CHECK_IN_ERRORS,
  DENY_CODES,
  DRY_RUN_MARK,
  GATE_STATES,
  LATE_WINDOW_ELAPSED,
  NON_GATE_ERRORS,
  RESEND_EXHAUSTED,
  isGateDenyCode,
} from './types';

/** Every custom error `Ticket.json` declares, by name. The ABI is 01's export, not a hand list. */
const ABI_ERRORS = new Set(
  ticketAbi.flatMap((entry) => (entry.type === 'error' ? [entry.name] : [])),
);

describe('staff types mirror spec §13', () => {
  it('lists the nine spec §13 DENY codes plus the four the table leaves implicit', () => {
    expect([...DENY_CODES]).toEqual([
      'ALREADY_USED',
      'WRONG_EVENT',
      'REVOKED',
      'EXPIRED_CODE',
      'NO_TICKET',
      'GATE_CLOSED',
      'DEVICE_LOCKED',
      'DEVICE_MISMATCH',
      'GATE_MISMATCH',
      'EVENT_ENDED',
      'EVENT_CANCELLED',
      'TX_FAILED',
      'UNKNOWN_REVERT',
    ]);
  });

  /**
   * One list, in the package both apps read. Two would mean the attendee phone silently
   * dropping a code the staff phone pushed at it — an empty screen at a door, and a merge that
   * looks clean.
   */
  it('does not declare the list, it re-exports @monti/shared’s', () => {
    expect(DENY_CODES).toBe(GATE_DENY_CODES);
    expect(isGateDenyCode('UNKNOWN_REVERT')).toBe(true);
    expect(isGateDenyCode('TIMEOUT')).toBe(false);
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
  /**
   * The list used to be twelve names typed into this repo, and Task 34's cross-branch diff
   * found what that costs: `Ticket.sol` grew `NotMember` and nothing here knew, so an
   * unmatched selector fell through to `TX_FAILED` and a permission problem of the terminal's
   * own was shown to the attendee as a send failure. Derivation inverts the default — an error
   * the contracts add is covered, and the way out is {@link NON_GATE_ERRORS}.
   */
  it('reads every name off the generated ABI rather than restating one', () => {
    for (const name of CHECK_IN_ERRORS) expect(ABI_ERRORS.has(name)).toBe(true);
    // No third category: every error the ABI declares is either a gate's or explicitly not.
    const accounted = new Set<string>([...CHECK_IN_ERRORS, ...NON_GATE_ERRORS]);
    expect([...ABI_ERRORS].filter((name) => !accounted.has(name))).toEqual([]);
  });

  it('covers NotMember and the other caller-identity errors the frozen list missed', () => {
    expect(CHECK_IN_ERRORS).toContain('NotMember');
    expect(CHECK_IN_ERRORS).toContain('Unauthorized');
  });

  /**
   * The assertion that survives a contract change in the other direction: an exclusion for an
   * error `Ticket.sol` no longer declares is excluding nothing, and whatever replaced it is
   * now silently a gate error nobody wrote a screen for.
   */
  it('excludes only names Ticket.json actually declares', () => {
    const stale = NON_GATE_ERRORS.filter((name) => !ABI_ERRORS.has(name));
    expect(stale, `no longer in Ticket.sol: ${stale.join(', ')}`).toEqual([]);
  });

  it('leaves out the offer errors, which no tap can raise', () => {
    // `OfferExpired` and `BadAttesterSig` are `acceptOffer`'s. They are in the ABI and must not
    // be in this list, or the gate would grow a DENY screen nobody can reach.
    for (const name of ['OfferExpired', 'BadAttesterSig']) {
      expect(ABI_ERRORS.has(name)).toBe(true);
      expect(CHECK_IN_ERRORS).not.toContain(name);
    }
  });

  it('leaves out the token internals and the sale desk', () => {
    for (const name of ['ERC721NonexistentToken', 'SoldOut', 'TransfersDisabled']) {
      expect(CHECK_IN_ERRORS).not.toContain(name);
    }
  });
});

describe('the marks the queue writes on its own rows', () => {
  /**
   * They live in this module and not in `queue/opQueue.ts` because the screens that turn them
   * into sentences are presentational: importing them from the queue dragged IndexedDB, viem
   * and the generated ABI into a barrel of pure cards.
   */
  it('are plain strings a presentational card can compare against', () => {
    expect([DRY_RUN_MARK, LATE_WINDOW_ELAPSED, RESEND_EXHAUSTED]).toEqual([
      'CHECK_IN_LATE_UNAVAILABLE',
      'LATE_WINDOW_ELAPSED',
      'RESEND_EXHAUSTED',
    ]);
  });

  /** None of the three is a refusal: nothing on chain said no — the operation never arrived. */
  it('are not DENY codes', () => {
    for (const mark of [DRY_RUN_MARK, LATE_WINDOW_ELAPSED, RESEND_EXHAUSTED]) {
      expect(isGateDenyCode(mark)).toBe(false);
    }
  });
});
