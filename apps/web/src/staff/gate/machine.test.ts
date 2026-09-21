import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SnapshotTicket } from '@monti/shared';

import { CHECKING_LABEL_MS, RETAP_PROMPT_MS } from '../constants';
import { GATE_STATES, type Hex } from '../types';
import { createGateMachine } from './machine';

const deps = { gateId: 7n, eventId: 42n, orgId: 5n };

/** Two taps, two codes. The nonce is what tells them apart everywhere below. */
const A = `0x${'aa'.repeat(32)}` as Hex;
const B = `0x${'bb'.repeat(32)}` as Hex;

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

const otherTicket: SnapshotTicket = { ...ticket, tokenId: '456', displayName: '이입장' };

/** A machine that has had a tap decoded, preflighted and sent — the state §7.3 is about. */
function inFlight(nonce: Hex = A) {
  const machine = createGateMachine(deps);
  machine.onReady();
  machine.onResponse({ nonce });
  machine.onPreflight({ ok: true, ticket });
  machine.onSent({ nonce, userOpHash: `0x${'11'.repeat(32)}` });
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
    expect(machine.onResponse({ nonce: A })).toBe(true);
    expect(machine.state()).toBe('received');
    machine.onPreflight({ ok: true, ticket });
    // A passed preflight is not a state change: it only says this is worth sending.
    expect(machine.state()).toBe('received');
    expect(machine.snapshot().ticket).toBe(ticket);
    machine.onSent({ nonce: A });
    expect(machine.state()).toBe('confirming');
    machine.onVerdict({ kind: 'admit', nonce: A, blockNumber: 99n, finalized: false });
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
    machine.onVerdict({ kind: 'admit', nonce: A, blockNumber: 99n, finalized: false });
    machine.onVerdict({ kind: 'admit', nonce: A, blockNumber: 99n, finalized: true });
    expect(machine.state()).toBe('admit');
    expect(machine.snapshot().finalized).toBe(true);
  });

  /** The one-shot `checkInOf` read (Task 24) admits from storage and cannot name a block. */
  it('admits without a block number, for a verdict read out of storage', () => {
    const machine = inFlight();
    machine.onVerdict({ kind: 'admit', nonce: A, finalized: true });
    expect(machine.state()).toBe('admit');
    expect(machine.snapshot().blockNumber).toBeUndefined();
    expect(machine.snapshot().finalized).toBe(true);
  });

  it('notifies subscribers and stops when they unsubscribe', () => {
    const machine = createGateMachine(deps);
    const seen: string[] = [];
    const unsubscribe = machine.subscribe((context) => seen.push(context.state));
    machine.onReady();
    machine.onResponse({ nonce: A });
    unsubscribe();
    machine.onSent({ nonce: A });
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
    vi.advanceTimersByTime(CHECKING_LABEL_MS - 1);
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
    machine.onVerdict({ kind: 'admit', nonce: A, blockNumber: 101n, finalized: true });
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
    machine.onTimeout(A);
    expect(machine.state()).toBe('confirming');
    expect(machine.snapshot().retapHint).toBe(true);
    expect(machine.snapshot().deny).toBeUndefined();
    // And the verdict that arrives after it still decides.
    machine.onVerdict({ kind: 'admit', nonce: A, blockNumber: 7n, finalized: false });
    expect(machine.state()).toBe('admit');
  });

  it('drops the clocks once a verdict lands, so they cannot fire over it', () => {
    const machine = inFlight();
    machine.onVerdict({ kind: 'admit', nonce: A, blockNumber: 99n, finalized: true });
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
    machine.onResponse({ nonce: A });
    machine.onPreflight({ ok: false, deny: 'ALREADY_USED', ticket });
    expect(machine.state()).toBe('deny');
    expect(machine.snapshot().deny).toBe('ALREADY_USED');
    // The row still comes through: the screen shows who was already let in.
    expect(machine.snapshot().ticket).toBe(ticket);
  });

  it('a chain revert carries its code and the sentence staff reads', () => {
    const machine = inFlight();
    machine.onVerdict({ kind: 'deny', nonce: A, code: 'DEVICE_MISMATCH', detail: '등록된 기기가 아님' });
    expect(machine.state()).toBe('deny');
    expect(machine.snapshot().deny).toBe('DEVICE_MISMATCH');
    expect(machine.snapshot().denyDetail).toBe('등록된 기기가 아님');
  });

  it('keeps the ticket a passed preflight found when the chain then refuses', () => {
    const machine = inFlight();
    machine.onVerdict({ kind: 'deny', nonce: A, code: 'ALREADY_USED' });
    expect(machine.snapshot().ticket).toBe(ticket);
  });
});

/**
 * Tasks 19–23 review, I1 and I2. Two ways one attendee's answer could land on another's screen,
 * and both of them turn a green the staff member has not read into something else.
 */
describe('one tap at a time, and the answer that belongs to it', () => {
  it('a double tap keeps the first verdict (T12) and says so', () => {
    const machine = inFlight();
    machine.onVerdict({ kind: 'admit', nonce: A, blockNumber: 99n, finalized: true });
    expect(machine.onResponse({ nonce: B })).toBe(false);
    expect(machine.state()).toBe('admit');
    expect(machine.snapshot().blockNumber).toBe(99n);
  });

  it('keeps a refusal on screen through a second tap too', () => {
    const machine = inFlight();
    machine.onVerdict({ kind: 'deny', nonce: A, code: 'REVOKED' });
    expect(machine.onResponse({ nonce: B })).toBe(false);
    machine.onPreflight({ ok: true, ticket });
    machine.onSent({ nonce: B });
    expect(machine.state()).toBe('deny');
    expect(machine.snapshot().deny).toBe('REVOKED');
  });

  /**
   * I1. The caller honoured nothing, sent the check-in anyway, and the chain answered
   * `AlreadyCheckedIn`. That refusal is a fact about the second send — the person in front of
   * the phone is already inside — so it must not turn the screen red.
   */
  it('a duplicate send’s AlreadyCheckedIn does not wipe an admit', () => {
    const machine = inFlight();
    machine.onVerdict({ kind: 'admit', nonce: A, blockNumber: 99n, finalized: true });
    machine.onVerdict({ kind: 'deny', nonce: A, code: 'ALREADY_USED', detail: '이미 입장' });
    expect(machine.state()).toBe('admit');
    expect(machine.snapshot().deny).toBeUndefined();
    expect(machine.snapshot().blockNumber).toBe(99n);
  });

  it('nor an offlineAdmit, which is also somebody already through the door', () => {
    const machine = inFlight();
    machine.onOfflineAdmit(2);
    machine.onVerdict({ kind: 'deny', nonce: A, code: 'ALREADY_USED' });
    expect(machine.state()).toBe('offlineAdmit');
  });

  /**
   * I2. The gate keeps serving codes, so attendee B can tap while A is still confirming. A's
   * `CheckedIn` then arrives against B's photo and name — and is dropped, because it does not
   * name the tap on screen.
   */
  it('does not paint attendee A’s admit over attendee B’s tap', () => {
    const machine = createGateMachine(deps);
    machine.onReady();
    machine.onResponse({ nonce: A });
    machine.onPreflight({ ok: true, ticket });
    machine.onSent({ nonce: A });

    // B taps 1.5 s later; nothing is settled, so the slot is theirs.
    vi.advanceTimersByTime(1_500);
    expect(machine.onResponse({ nonce: B })).toBe(true);
    machine.onPreflight({ ok: true, ticket: otherTicket });
    machine.onSent({ nonce: B });
    expect(machine.snapshot().ticket).toBe(otherTicket);

    machine.onVerdict({ kind: 'admit', nonce: A, blockNumber: 99n, finalized: true });
    expect(machine.state()).toBe('confirming');
    expect(machine.snapshot().ticket).toBe(otherTicket);

    machine.onVerdict({ kind: 'admit', nonce: B, blockNumber: 100n, finalized: true });
    expect(machine.state()).toBe('admit');
    expect(machine.snapshot().blockNumber).toBe(100n);
  });

  it('drops a stale refusal the same way', () => {
    const machine = inFlight(A);
    machine.onResponse({ nonce: B });
    machine.onVerdict({ kind: 'deny', nonce: A, code: 'EXPIRED_CODE' });
    expect(machine.state()).toBe('received');
    expect(machine.snapshot().deny).toBeUndefined();
  });

  it('ignores a verdict that arrives with no tap on screen at all', () => {
    const machine = createGateMachine(deps);
    machine.onReady();
    machine.onVerdict({ kind: 'admit', nonce: A, blockNumber: 99n, finalized: true });
    expect(machine.state()).toBe('ready');
  });

  it('does not let a stale send or timeout restart the clocks for the tap on screen', () => {
    const machine = createGateMachine(deps);
    machine.onReady();
    machine.onResponse({ nonce: A });
    machine.onResponse({ nonce: B });
    machine.onSent({ nonce: A });
    expect(machine.state()).toBe('received');

    machine.onSent({ nonce: B });
    machine.onTimeout(A);
    expect(machine.snapshot().retapHint).toBe(false);
    machine.onTimeout(B);
    expect(machine.snapshot().retapHint).toBe(true);
  });

  it('carries the userOpHash the send learned without matching on it', () => {
    const machine = createGateMachine(deps);
    machine.onReady();
    machine.onResponse({ nonce: A });
    machine.onSent({ nonce: A, userOpHash: `0x${'fe'.repeat(32)}` });
    // The chain log names the nonce and nothing else, so that is what a verdict is matched on.
    machine.onVerdict({ kind: 'admit', nonce: A, blockNumber: 5n, finalized: false });
    expect(machine.state()).toBe('admit');
  });
});

describe('the states that are not admit', () => {
  it('offlineAdmit is a state of its own, never admit', () => {
    const machine = createGateMachine(deps);
    machine.onReady();
    machine.onResponse({ nonce: A });
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
    machine.onVerdict({ kind: 'deny', nonce: A, code: 'ALREADY_USED', detail: '이미 입장' });
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

  /** The tap goes with the verdict: a log that arrives after the reset has nobody to admit. */
  it('forgets which tap it was about, so a late verdict cannot reopen it', () => {
    const machine = inFlight();
    machine.onVerdict({ kind: 'admit', nonce: A, blockNumber: 99n, finalized: true });
    machine.reset();
    machine.onVerdict({ kind: 'admit', nonce: A, blockNumber: 99n, finalized: true });
    expect(machine.state()).toBe('ready');
  });

  it('onReady after a verdict is the same clean slate', () => {
    const machine = inFlight();
    machine.onVerdict({ kind: 'admit', nonce: A, blockNumber: 99n, finalized: true });
    machine.onReady();
    expect(machine.state()).toBe('ready');
    expect(machine.snapshot().blockNumber).toBeUndefined();
    // And a tap is accepted again, which a stuck `settled()` would have blocked.
    expect(machine.onResponse({ nonce: B })).toBe(true);
    expect(machine.state()).toBe('received');
  });

  it('keeps the offline queue depth across a reset — it is not this tap’s business', () => {
    const machine = createGateMachine(deps);
    machine.onReady();
    machine.onResponse({ nonce: A });
    machine.onOfflineAdmit(4);
    machine.reset();
    expect(machine.snapshot().pendingCount).toBe(4);
    expect(machine.snapshot().online).toBe(false);
  });
});
