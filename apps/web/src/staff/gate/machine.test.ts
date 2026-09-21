import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SnapshotTicket } from '@monti/shared';

import { CONFIRM_SPINNER_MS, RETAP_PROMPT_MS } from '../constants';
import { GATE_STATES } from '../types';
import { createGateMachine } from './machine';

const deps = { gateId: 7n, eventId: 42n, orgId: 5n };

const ticket: SnapshotTicket = {
  tokenId: '123',
  account: `0x${'aa'.repeat(20)}`,
  deviceX: `0x${'11'.repeat(32)}`,
  deviceY: `0x${'22'.repeat(32)}`,
  photoJpegB64: 'x',
  displayName: '김입장',
  tier: 0,
  tierName: '일반',
  seat: '',
  checkedIn: false,
};

/** A machine that has had a tap decoded, preflighted and sent — the state §7.3 is about. */
function inFlight() {
  const machine = createGateMachine(deps);
  machine.onReady();
  machine.onResponse();
  machine.onPreflight({ ok: true, ticket });
  machine.onSent();
  return machine;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('the happy path', () => {
  it('idle → ready → received → confirming → admit', () => {
    const machine = createGateMachine(deps);
    expect(machine.state()).toBe('idle');
    machine.onReady();
    expect(machine.state()).toBe('ready');
    machine.onResponse();
    expect(machine.state()).toBe('received');
    machine.onPreflight({ ok: true, ticket });
    // A passed preflight is not a state change: it only says this is worth sending.
    expect(machine.state()).toBe('received');
    expect(machine.snapshot().ticket).toBe(ticket);
    machine.onSent();
    expect(machine.state()).toBe('confirming');
    machine.onVerdict({ kind: 'admit', blockNumber: 99n, finalized: false });
    expect(machine.state()).toBe('admit');
    expect(machine.snapshot().finalized).toBe(false);
    expect(machine.snapshot().blockNumber).toBe(99n);
  });

  it('carries the event identity every screen reads from the same object', () => {
    expect(createGateMachine(deps).snapshot()).toMatchObject(deps);
    expect(GATE_STATES).toContain(createGateMachine(deps).state());
  });

  it('upgrades an admit to finalized without leaving the admit state', () => {
    const machine = inFlight();
    machine.onVerdict({ kind: 'admit', blockNumber: 99n, finalized: false });
    machine.onVerdict({ kind: 'admit', blockNumber: 99n, finalized: true });
    expect(machine.state()).toBe('admit');
    expect(machine.snapshot().finalized).toBe(true);
  });

  it('notifies subscribers and stops when they unsubscribe', () => {
    const machine = createGateMachine(deps);
    const seen: string[] = [];
    const unsubscribe = machine.subscribe((context) => seen.push(context.state));
    machine.onReady();
    machine.onResponse();
    unsubscribe();
    machine.onSent();
    expect(seen).toEqual(['ready', 'received']);
  });
});

/**
 * Spec §7.3, and the invariant this file exists to hold. Both thresholds change what the screen
 * says and neither changes what is true: the operation is still in flight at both of them.
 */
describe('the two clocks, and the soft approval that must never happen', () => {
  it('says nothing for two seconds, then "확인 중"', () => {
    const machine = inFlight();
    expect(machine.snapshot().checking).toBe(false);
    vi.advanceTimersByTime(CONFIRM_SPINNER_MS - 1);
    expect(machine.snapshot().checking).toBe(false);
    vi.advanceTimersByTime(1);
    expect(machine.snapshot().checking).toBe(true);
    expect(machine.state()).toBe('confirming');
    expect(machine.snapshot().retapHint).toBe(false);
  });

  it('asks for another tap at five seconds and stays confirming — no state, no verdict', () => {
    const machine = inFlight();
    vi.advanceTimersByTime(RETAP_PROMPT_MS);
    expect(machine.snapshot().retapHint).toBe(true);
    expect(machine.state()).toBe('confirming');
    expect(machine.snapshot().deny).toBeUndefined();
    expect(machine.snapshot().denyDetail).toBeUndefined();
  });

  it('never soft-admits: an hour of silence is still confirming, never admit', () => {
    const machine = inFlight();
    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(machine.state()).toBe('confirming');
    expect(machine.state()).not.toBe('admit');
    expect(machine.snapshot().blockNumber).toBeUndefined();
  });

  /** The reason the hint is a flag and not a state: the chain can still answer, and it decides. */
  it('a late CheckedIn after the hint still turns the tap green', () => {
    const machine = inFlight();
    vi.advanceTimersByTime(RETAP_PROMPT_MS + 3_000);
    expect(machine.snapshot().retapHint).toBe(true);
    machine.onVerdict({ kind: 'admit', blockNumber: 101n, finalized: true });
    expect(machine.state()).toBe('admit');
    expect(machine.snapshot().retapHint).toBe(false);
    expect(machine.snapshot().checking).toBe(false);
  });

  /**
   * `sendSponsoredOp.wait()` answers with a TIMEOUT sentinel when it stops watching. It stopped
   * watching; the operation did not stop existing, so this is not a DENY (Task 21 ruling 3).
   */
  it('a TIMEOUT receipt keeps the machine confirming with the same hint', () => {
    const machine = inFlight();
    machine.onTimeout();
    expect(machine.state()).toBe('confirming');
    expect(machine.snapshot().retapHint).toBe(true);
    expect(machine.snapshot().deny).toBeUndefined();
    // And the verdict that arrives after it still decides.
    machine.onVerdict({ kind: 'admit', blockNumber: 7n, finalized: false });
    expect(machine.state()).toBe('admit');
  });

  it('drops the clocks once a verdict lands, so they cannot fire over it', () => {
    const machine = inFlight();
    machine.onVerdict({ kind: 'admit', blockNumber: 99n, finalized: true });
    vi.advanceTimersByTime(RETAP_PROMPT_MS * 2);
    expect(machine.snapshot().checking).toBe(false);
    expect(machine.snapshot().retapHint).toBe(false);
    expect(machine.state()).toBe('admit');
  });
});

describe('refusals', () => {
  it('a failed preflight denies without ever sending', () => {
    const machine = createGateMachine(deps);
    machine.onReady();
    machine.onResponse();
    machine.onPreflight({ ok: false, deny: 'ALREADY_USED', ticket });
    expect(machine.state()).toBe('deny');
    expect(machine.snapshot().deny).toBe('ALREADY_USED');
    // The row still comes through: the screen shows who was already let in.
    expect(machine.snapshot().ticket).toBe(ticket);
  });

  it('a chain revert carries its code and the sentence staff reads', () => {
    const machine = inFlight();
    machine.onVerdict({ kind: 'deny', code: 'DEVICE_MISMATCH', detail: '등록된 기기가 아님' });
    expect(machine.state()).toBe('deny');
    expect(machine.snapshot().deny).toBe('DEVICE_MISMATCH');
    expect(machine.snapshot().denyDetail).toBe('등록된 기기가 아님');
  });

  it('keeps the ticket a passed preflight found when the chain then refuses', () => {
    const machine = inFlight();
    machine.onVerdict({ kind: 'deny', code: 'ALREADY_USED' });
    expect(machine.snapshot().ticket).toBe(ticket);
  });
});

describe('a second tap, and the states that are not admit', () => {
  it('a double tap keeps the first verdict (T12)', () => {
    const machine = inFlight();
    machine.onVerdict({ kind: 'admit', blockNumber: 99n, finalized: true });
    machine.onResponse();
    expect(machine.state()).toBe('admit');
    expect(machine.snapshot().blockNumber).toBe(99n);
  });

  it('keeps a refusal on screen through a second tap too', () => {
    const machine = inFlight();
    machine.onVerdict({ kind: 'deny', code: 'REVOKED' });
    machine.onResponse();
    machine.onPreflight({ ok: true, ticket });
    machine.onSent();
    expect(machine.state()).toBe('deny');
    expect(machine.snapshot().deny).toBe('REVOKED');
  });

  it('offlineAdmit is a state of its own, never admit', () => {
    const machine = createGateMachine(deps);
    machine.onReady();
    machine.onResponse();
    machine.onPreflight({ ok: true, ticket });
    machine.onOfflineAdmit(3);
    expect(machine.state()).toBe('offlineAdmit');
    expect(machine.state()).not.toBe('admit');
    expect(machine.snapshot().pendingCount).toBe(3);
    expect(machine.snapshot().online).toBe(false);
  });

  it('override is its own state as well', () => {
    const machine = inFlight();
    machine.onOverride();
    expect(machine.state()).toBe('override');
  });
});

describe('going back to waiting', () => {
  it('reset clears the verdict, the ticket and both hints', () => {
    const machine = inFlight();
    vi.advanceTimersByTime(RETAP_PROMPT_MS);
    machine.onVerdict({ kind: 'deny', code: 'ALREADY_USED', detail: '이미 입장' });
    machine.reset();

    expect(machine.state()).toBe('ready');
    expect(machine.snapshot()).toMatchObject({
      deny: undefined,
      denyDetail: undefined,
      ticket: undefined,
      blockNumber: undefined,
      finalized: false,
      checking: false,
      retapHint: false,
    });
  });

  it('onReady after a verdict is the same clean slate', () => {
    const machine = inFlight();
    machine.onVerdict({ kind: 'admit', blockNumber: 99n, finalized: true });
    machine.onReady();
    expect(machine.state()).toBe('ready');
    expect(machine.snapshot().blockNumber).toBeUndefined();
    // And a tap is accepted again, which a stuck `settled()` would have blocked.
    machine.onResponse();
    expect(machine.state()).toBe('received');
  });

  it('keeps the offline queue depth across a reset — it is not this tap’s business', () => {
    const machine = createGateMachine(deps);
    machine.onReady();
    machine.onResponse();
    machine.onOfflineAdmit(4);
    machine.reset();
    expect(machine.snapshot().pendingCount).toBe(4);
    expect(machine.snapshot().online).toBe(false);
  });
});
