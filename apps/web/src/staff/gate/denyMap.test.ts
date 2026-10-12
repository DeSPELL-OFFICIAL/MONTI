import { toFunctionSelector, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';

import { ticketAbi } from '@monti/shared';

import { CHECK_IN_ERRORS, DENY_CODES, type DenyCode } from '../types';
import {
  CHECK_IN_DENY,
  DENY_BY_NAME,
  DENY_LABELS,
  MAPPED_SELECTORS,
  mapCallableDeny,
  mapRevertToDenyCode,
} from './denyMap';

/** The selector of a zero-argument custom error, spelled the way the chain returns it. */
const revert = (signature: string, tail = '00'.repeat(32)) =>
  `${toFunctionSelector(signature as `${string}()`)}${tail}` as const;

describe('revert to DENY mapping (spec §13)', () => {
  it.each([
    ['AlreadyCheckedIn()', 'ALREADY_USED'],
    ['WrongEvent()', 'WRONG_EVENT'],
    ['TicketRevoked()', 'REVOKED'],
    ['CodeExpired()', 'EXPIRED_CODE'],
    ['NoSuchTicket()', 'NO_TICKET'],
    ['GateNotOpen()', 'GATE_CLOSED'],
    ['GateMismatch()', 'GATE_MISMATCH'],
    ['DeviceLocked()', 'DEVICE_LOCKED'],
    ['BadDeviceSignature()', 'DEVICE_MISMATCH'],
    ['EventEnded()', 'EVENT_ENDED'],
    ['EventCancelled()', 'EVENT_CANCELLED'],
  ])('%s becomes %s', (signature, expected) => {
    expect(mapRevertToDenyCode(revert(signature)).code).toBe(expected);
  });

  it('reads a reason with no trailing data, which is what a zero-arg error returns', () => {
    expect(mapRevertToDenyCode(revert('AlreadyCheckedIn()', '')).code).toBe('ALREADY_USED');
  });

  /**
   * Not a bad ticket and nothing the attendee can do about it, so it gets the generic failure
   * screen with a sentence that points at the person who can fix it.
   */
  it('EventNotPublished is a TX_FAILED with its own detail, not its own screen', () => {
    const result = mapRevertToDenyCode(revert('EventNotPublished()'));
    expect(result.code).toBe('TX_FAILED');
    expect(result.detail).toContain('published');
    expect(result.detail).not.toBe(DENY_LABELS.TX_FAILED);
  });

  it('gives GateMismatch a sentence about the terminal, not about the ticket', () => {
    expect(mapRevertToDenyCode(revert('GateMismatch()')).detail).toContain('gate device');
  });
});

describe('a reason this build cannot read', () => {
  it('is UNKNOWN_REVERT, and keeps the raw selector visible to staff', () => {
    const result = mapRevertToDenyCode('0xdeadbeef', 'AA23 reverted (or OOG)');
    expect(result.code).toBe('UNKNOWN_REVERT');
    expect(result.detail).toContain('0xdeadbeef');
    expect(result.detail).toContain('AA23');
  });

  it('is told apart from a send that produced no reason at all', () => {
    expect(mapRevertToDenyCode(undefined, undefined).code).toBe('TX_FAILED');
    expect(mapRevertToDenyCode(undefined, 'AA23 reverted (or OOG)')).toEqual({
      code: 'TX_FAILED',
      detail: 'AA23 reverted (or OOG)',
    });
  });

  /**
   * `sendSponsoredOp` answers with this sentinel when `wait` gave up before the op landed. It
   * is NOT a failure — Task 23 keeps the gate confirming and a late `CheckedIn` still admits —
   * so it must never be mapped. If it arrives anyway it degrades to the generic failure rather
   * than inventing a refusal with a reason.
   */
  it('never turns the TIMEOUT sentinel into a reason-shaped refusal', () => {
    expect(mapRevertToDenyCode('TIMEOUT').code).toBe('TX_FAILED');
    expect(mapRevertToDenyCode('TIMEOUT').detail).toBe('Unknown cause');
  });

  it('never invents an admit — every path out of here is a DENY', () => {
    const inputs = [
      undefined,
      '0x' as const,
      '0xdeadbeef' as const,
      'TIMEOUT' as const,
      revert('AlreadyCheckedIn()'),
    ];
    for (const input of inputs) {
      expect(DENY_CODES).toContain(mapRevertToDenyCode(input).code);
      expect(mapRevertToDenyCode(input).detail.length).toBeGreaterThan(0);
    }
  });
});

/**
 * The guard the whole file exists for. Selectors are derived from the generated ABI, so a
 * rename in `Ticket.sol` cannot silently turn a DENY screen into a generic failure — it turns
 * these red instead.
 */
describe('the map is pinned to the generated ABI and covers every screen', () => {
  /**
   * Both directions, and each one is a different bug. A name in `CHECK_IN_ERRORS` with no entry
   * here is an error the contracts raise and this build has no screen for — the gap Task 34
   * found. An entry here with no name in the ABI is a screen nobody can reach, which is how a
   * rename hides: the old key keeps compiling and the new selector matches nothing.
   */
  it('has exactly one screen per derived error name', () => {
    expect(Object.keys(CHECK_IN_DENY).sort()).toEqual([...CHECK_IN_ERRORS].sort());
    expect(MAPPED_SELECTORS).toHaveLength(CHECK_IN_ERRORS.length);
  });

  /**
   * The two the frozen twelve never had. Neither is about the attendee: one says this terminal
   * is not on the organizer's team, the other that it may not make this call. Both are
   * `TX_FAILED` with a sentence pointing at whoever can fix it, exactly like `EventNotPublished`
   * — showing a ticket-holder a red refusal for somebody else's setup sends a paying customer
   * away while the fix is one action on another phone.
   */
  it.each([['NotMember()'], ['Unauthorized()']])('%s is a TX_FAILED about the terminal', (signature) => {
    const result = mapRevertToDenyCode(revert(signature));
    expect(result.code).toBe('TX_FAILED');
    expect(result.detail).toContain('gate device');
    expect(result.detail).toContain('organizer');
    expect(result.detail).not.toBe(DENY_LABELS.TX_FAILED);
  });

  it('derives each selector from the ABI’s own parameter types', () => {
    const abiErrors = new Map(
      ticketAbi.flatMap((entry) =>
        entry.type === 'error'
          ? [[entry.name, `${entry.name}(${entry.inputs.map((input) => input.type).join(',')})`] as const]
          : [],
      ),
    );
    for (const name of CHECK_IN_ERRORS) {
      const signature = abiErrors.get(name);
      expect(signature, `${name} is missing from the generated ABI`).toBeDefined();
      const selector = toFunctionSelector(signature as `${string}(${string})`).toLowerCase() as Hex;
      expect(MAPPED_SELECTORS).toContain(selector);
      expect(mapRevertToDenyCode(`${selector}${'00'.repeat(32)}`).code).toBe(CHECK_IN_DENY[name]);
    }
  });

  it('gives every DENY code a label and a way to be reached', () => {
    expect(Object.keys(DENY_LABELS).sort()).toEqual([...DENY_CODES].sort());
    expect(Object.keys(DENY_LABELS)).toHaveLength(13);

    // Every code is reachable through this map alone: eleven from a contract error, plus the
    // two fallbacks. (`EXPIRED_CODE` and `DEVICE_MISMATCH` are also raised locally by Task 19,
    // before a transaction is paid for, but they are `CodeExpired` and `BadDeviceSignature`
    // here too — so nothing has to be added by hand for the set to be complete.)
    const reachable = new Set<DenyCode>(Object.values(CHECK_IN_DENY));
    reachable.add(mapRevertToDenyCode('0xdeadbeef').code);
    reachable.add(mapRevertToDenyCode(undefined).code);

    expect([...DENY_CODES].filter((code) => !reachable.has(code))).toEqual([]);
  });

  it('leaves the offer errors out — no tap can raise them', () => {
    for (const signature of ['OfferExpired()', 'BadAttesterSig(bytes)']) {
      expect(MAPPED_SELECTORS).not.toContain(toFunctionSelector(signature as `${string}(${string})`).toLowerCase());
    }
  });
});

/**
 * The relay path's mapper. The relayer runs the `eth_call` simulation and maps the contract's revert
 * to a `details.code` before it ever charges gas, so this side reads a name, not a selector — but it
 * ends at the same screens, and never at an admit.
 */
describe('the relayer’s refusal to a DENY (relayCheckIn)', () => {
  /** A `CallableError` as `shared/api/functions` builds one: a status `code` and a `details.code`. */
  const failure = (detailsCode?: string, message = 'REASON') =>
    ({ code: 'failed-precondition', message, details: detailsCode ? { code: detailsCode } : undefined }) as const;

  it('takes a DENY code the backend already speaks and shows its label', () => {
    for (const code of ['GATE_CLOSED', 'EXPIRED_CODE', 'DEVICE_LOCKED', 'WRONG_EVENT', 'REVOKED'] as const) {
      expect(mapCallableDeny(failure(code))).toEqual({ code, detail: DENY_LABELS[code] });
    }
  });

  /**
   * And a contract error **name**, mapped through the same table the selector map uses, so this
   * survives whichever spelling the backend settles on. These are the names design §5 lists.
   */
  it.each([
    ['GateNotOpen', 'GATE_CLOSED'],
    ['CodeExpired', 'EXPIRED_CODE'],
    ['DeviceLocked', 'DEVICE_LOCKED'],
    ['BadDeviceSignature', 'DEVICE_MISMATCH'],
    ['TicketRevoked', 'REVOKED'],
    ['WrongEvent', 'WRONG_EVENT'],
  ])('maps the contract name %s to %s', (name, expected) => {
    expect(mapCallableDeny(failure(name)).code).toBe(expected);
    expect(mapCallableDeny(failure(name))).toEqual(DENY_BY_NAME[name]);
  });

  it('is UNKNOWN_REVERT for a code this build has no screen for, and shows it', () => {
    const result = mapCallableDeny(failure('SomethingNew'));
    expect(result.code).toBe('UNKNOWN_REVERT');
    expect(result.detail).toContain('SomethingNew');
  });

  it('is TX_FAILED for a transport failure that carries no details.code', () => {
    // The opaque rejection `shared/api/functions` builds for a dropped connection.
    expect(mapCallableDeny({ code: 'internal', message: 'UNKNOWN' })).toEqual({
      code: 'TX_FAILED',
      detail: DENY_LABELS.TX_FAILED,
    });
    expect(mapCallableDeny(new Error('Failed to fetch')).code).toBe('TX_FAILED');
    expect(mapCallableDeny(undefined).code).toBe('TX_FAILED');
  });

  it('never invents an admit — every path out is a DENY with a sentence', () => {
    const inputs = [undefined, null, 'boom', new Error('x'), failure(), failure('GATE_CLOSED'), failure('Nope')];
    for (const input of inputs) {
      const result = mapCallableDeny(input);
      expect(DENY_CODES).toContain(result.code);
      expect(result.detail.length).toBeGreaterThan(0);
    }
  });
});
