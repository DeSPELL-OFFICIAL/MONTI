import { toFunctionSelector, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';

import { ticketAbi } from '@monti/shared';

import { CHECK_IN_ERRORS, DENY_CODES, type DenyCode } from '../types';
import { CHECK_IN_DENY, DENY_LABELS, MAPPED_SELECTORS, mapRevertToDenyCode } from './denyMap';

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
    expect(result.detail).toContain('공개');
    expect(result.detail).not.toBe(DENY_LABELS.TX_FAILED);
  });

  it('gives GateMismatch a sentence about the terminal, not about the ticket', () => {
    expect(mapRevertToDenyCode(revert('GateMismatch()')).detail).toContain('단말기');
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
    expect(mapRevertToDenyCode('TIMEOUT').detail).toBe('원인 미상');
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
  it('maps every one of the twelve frozen check-in error names', () => {
    expect(Object.keys(CHECK_IN_DENY).sort()).toEqual([...CHECK_IN_ERRORS].sort());
    expect(MAPPED_SELECTORS).toHaveLength(CHECK_IN_ERRORS.length);
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

    const reachable = new Set<DenyCode>(Object.values(CHECK_IN_DENY));
    reachable.add(mapRevertToDenyCode('0xdeadbeef').code);
    reachable.add(mapRevertToDenyCode(undefined).code);
    // The three the chain cannot revert with reach the screen from the tap path instead:
    // Task 19 refuses a stale code and a signature the chain would reject before sending.
    for (const local of ['EXPIRED_CODE', 'DEVICE_MISMATCH'] as const) reachable.add(local);

    expect([...DENY_CODES].filter((code) => !reachable.has(code))).toEqual([]);
  });

  it('leaves the offer errors out — no tap can raise them', () => {
    for (const signature of ['OfferExpired()', 'BadAttesterSig(bytes)']) {
      expect(MAPPED_SELECTORS).not.toContain(toFunctionSelector(signature as `${string}(${string})`).toLowerCase());
    }
  });
});
