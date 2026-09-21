import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SnapshotTicket } from '@monti/shared';

import { CHECKING_LABEL_MS, WAIT_HINT_MS } from '../constants';
import { GATE_STATES, type Hex } from '../types';
import { TAP_REFUSAL, createGateMachine, type TapId, type Verdict } from './machine';

const deps = { gateId: 7n, eventId: 42n, orgId: 5n };

/** Two taps, two codes. The nonce is what tells them apart everywhere below. */
const A: TapId = { tokenId: 123n, nonce: `0x${'aa'.repeat(32)}` as Hex };
const B: TapId = { tokenId: 456n, nonce: `0x${'bb'.repeat(32)}` as Hex };

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
function inFlight(tap: TapId = A, extra: Partial<Parameters<typeof createGateMachine>[0]> = {}) {
  const machine = createGateMachine({ ...deps, ...extra });
  machine.onReady();
  machine.onResponse(tap);
  machine.onPreflight({ ok: true, ticket });
  machine.onSent({ ...tap, userOpHash: `0x${'11'.repeat(32)}` });
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
    expect(machine.onResponse(A)).toBe(true);
    expect(machine.state()).toBe('received');
    machine.onPreflight({ ok: true, ticket });
    // A passed preflight is not a state change: it only says this is worth sending.
    expect(machine.state()).toBe('received');
    expect(machine.snapshot().ticket).toBe(ticket);
    machine.onSent(A);
    expect(machine.state()).toBe('confirming');
    machine.onVerdict({ kind: 'admit', nonce: A.nonce, blockNumber: 99n, finalized: false });
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
    machine.onVerdict({ kind: 'admit', nonce: A.nonce, blockNumber: 99n, finalized: false });
    machine.onVerdict({ kind: 'admit', nonce: A.nonce, blockNumber: 99n, finalized: true });
    expect(machine.state()).toBe('admit');
    expect(machine.snapshot().finalized).toBe(true);
  });

  /** The one-shot `checkInOf` read (Task 24) admits from storage and cannot name a block. */
  it('admits without a block number, for a verdict read out of storage', () => {
    const machine = inFlight();
    machine.onVerdict({ kind: 'admit', nonce: A.nonce, finalized: true });
    expect(machine.state()).toBe('admit');
    expect(machine.snapshot().blockNumber).toBeUndefined();
    expect(machine.snapshot().finalized).toBe(true);
  });

  it('notifies subscribers and stops when they unsubscribe', () => {
    const machine = createGateMachine(deps);
    const seen: string[] = [];
    const unsubscribe = machine.subscribe((context) => seen.push(context.state));
    machine.onReady();
    machine.onResponse(A);
    unsubscribe();
    machine.onSent(A);
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
    expect(machine.snapshot().waitHint).toBe(false);
  });

  it('asks for another tap at five seconds and stays confirming — no state, no verdict', () => {
    const machine = inFlight();
    vi.advanceTimersByTime(WAIT_HINT_MS);
    expect(machine.snapshot().waitHint).toBe(true);
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
    vi.advanceTimersByTime(WAIT_HINT_MS + 3_000);
    expect(machine.snapshot().waitHint).toBe(true);
    machine.onVerdict({ kind: 'admit', nonce: A.nonce, blockNumber: 101n, finalized: true });
    expect(machine.state()).toBe('admit');
    expect(machine.snapshot().waitHint).toBe(false);
    expect(machine.snapshot().checking).toBe(false);
  });

  /**
   * `sendSponsoredOp.wait()` answers with a TIMEOUT sentinel when it stops watching. It stopped
   * watching; the operation did not stop existing, so this is not a DENY (Task 21 ruling 3).
   */
  it('a TIMEOUT receipt keeps the machine confirming with the same hint', () => {
    const machine = inFlight();
    machine.onTimeout(A.nonce);
    expect(machine.state()).toBe('confirming');
    expect(machine.snapshot().waitHint).toBe(true);
    expect(machine.snapshot().deny).toBeUndefined();
    // And the verdict that arrives after it still decides.
    machine.onVerdict({ kind: 'admit', nonce: A.nonce, blockNumber: 7n, finalized: false });
    expect(machine.state()).toBe('admit');
  });

  it('drops the clocks once a verdict lands, so they cannot fire over it', () => {
    const machine = inFlight();
    machine.onVerdict({ kind: 'admit', nonce: A.nonce, blockNumber: 99n, finalized: true });
    vi.advanceTimersByTime(WAIT_HINT_MS * 2);
    expect(machine.snapshot().checking).toBe(false);
    expect(machine.snapshot().waitHint).toBe(false);
    expect(machine.state()).toBe('admit');
  });
});

describe('refusals', () => {
  it('a failed preflight denies without ever sending', () => {
    const machine = createGateMachine(deps);
    machine.onReady();
    machine.onResponse(A);
    machine.onPreflight({ ok: false, deny: 'ALREADY_USED', ticket });
    expect(machine.state()).toBe('deny');
    expect(machine.snapshot().deny).toBe('ALREADY_USED');
    // The row still comes through: the screen shows who was already let in.
    expect(machine.snapshot().ticket).toBe(ticket);
  });

  it('a chain revert carries its code and the sentence staff reads', () => {
    const machine = inFlight();
    machine.onVerdict({ kind: 'deny', nonce: A.nonce, code: 'DEVICE_MISMATCH', detail: '등록된 기기가 아님' });
    expect(machine.state()).toBe('deny');
    expect(machine.snapshot().deny).toBe('DEVICE_MISMATCH');
    expect(machine.snapshot().denyDetail).toBe('등록된 기기가 아님');
  });

  it('keeps the ticket a passed preflight found when the chain then refuses', () => {
    const machine = inFlight();
    machine.onVerdict({ kind: 'deny', nonce: A.nonce, code: 'ALREADY_USED' });
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
    machine.onVerdict({ kind: 'admit', nonce: A.nonce, blockNumber: 99n, finalized: true });
    expect(machine.onResponse(B)).toBe(false);
    expect(machine.refusal()).toBe(TAP_REFUSAL.showingVerdict);
    expect(machine.state()).toBe('admit');
    expect(machine.snapshot().blockNumber).toBe(99n);
  });

  it('keeps a refusal on screen through a second tap too', () => {
    const machine = inFlight();
    machine.onVerdict({ kind: 'deny', nonce: A.nonce, code: 'REVOKED' });
    expect(machine.onResponse(B)).toBe(false);
    machine.onPreflight({ ok: true, ticket });
    machine.onSent(B);
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
    machine.onVerdict({ kind: 'admit', nonce: A.nonce, blockNumber: 99n, finalized: true });
    machine.onVerdict({ kind: 'deny', nonce: A.nonce, code: 'ALREADY_USED', detail: '이미 입장' });
    expect(machine.state()).toBe('admit');
    expect(machine.snapshot().deny).toBeUndefined();
    expect(machine.snapshot().blockNumber).toBe(99n);
  });

  it('nor an offlineAdmit, which is also somebody already through the door', () => {
    const machine = inFlight();
    machine.onOfflineAdmit(A, 2);
    machine.onVerdict({ kind: 'deny', nonce: A.nonce, code: 'ALREADY_USED' });
    expect(machine.state()).toBe('offlineAdmit');
  });

  /**
   * Task 24 review V2, the half that matters most. The gate keeps serving codes, so attendee B
   * can tap while A is still confirming — and the machine refuses. Taking the slot would leave
   * A's `CheckedIn` with nowhere to land, and A is admitted on chain, paid for, and standing at
   * a door that never said anything.
   */
  it('refuses attendee B while attendee A is still confirming, and A still turns green', () => {
    const machine = createGateMachine(deps);
    machine.onReady();
    machine.onResponse(A);
    machine.onPreflight({ ok: true, ticket });
    machine.onSent(A);

    vi.advanceTimersByTime(1_500);
    expect(machine.onResponse(B)).toBe(false);
    expect(machine.refusal()).toBe(TAP_REFUSAL.confirming);
    // Nothing about B reached the screen: it is still A's tap, A's photo, A's clocks.
    expect(machine.state()).toBe('confirming');
    expect(machine.snapshot().ticket).toBe(ticket);

    machine.onVerdict({ kind: 'admit', nonce: A.nonce, blockNumber: 99n, finalized: true });
    expect(machine.state()).toBe('admit');
    expect(machine.snapshot().blockNumber).toBe(99n);
  });

  /** I2's guard is still there for the events a refused tap cannot stop: a verdict is dropped
   *  whenever it names a tap that is not the one on screen. */
  it('drops a verdict that names a tap the machine is no longer about', () => {
    const machine = inFlight();
    machine.onVerdict({ kind: 'admit', nonce: A.nonce, blockNumber: 99n, finalized: true });
    machine.reset();
    machine.onResponse(B);
    machine.onSent(B);

    machine.onVerdict({ kind: 'admit', nonce: A.nonce, blockNumber: 99n, finalized: true });
    expect(machine.state()).toBe('confirming');

    machine.onVerdict({ kind: 'admit', nonce: B.nonce, blockNumber: 100n, finalized: true });
    expect(machine.state()).toBe('admit');
    expect(machine.snapshot().blockNumber).toBe(100n);
  });

  it('drops a stale refusal the same way', () => {
    const machine = createGateMachine(deps);
    machine.onReady();
    machine.onResponse(A);
    machine.onResponse(B);
    machine.onVerdict({ kind: 'deny', nonce: A.nonce, code: 'EXPIRED_CODE' });
    expect(machine.state()).toBe('received');
    expect(machine.snapshot().deny).toBeUndefined();
  });

  it('ignores a verdict that arrives with no tap on screen at all', () => {
    const machine = createGateMachine(deps);
    machine.onReady();
    machine.onVerdict({ kind: 'admit', nonce: A.nonce, blockNumber: 99n, finalized: true });
    expect(machine.state()).toBe('ready');
  });

  it('does not let a stale send or timeout restart the clocks for the tap on screen', () => {
    const machine = createGateMachine(deps);
    machine.onReady();
    machine.onResponse(A);
    // Still `received`, so B is taken — the refusal above is about `confirming`, not about
    // a tap that has not been sent yet.
    expect(machine.onResponse(B)).toBe(true);
    machine.onSent(A);
    expect(machine.state()).toBe('received');

    machine.onSent(B);
    machine.onTimeout(A.nonce);
    expect(machine.snapshot().waitHint).toBe(false);
    machine.onTimeout(B.nonce);
    expect(machine.snapshot().waitHint).toBe(true);
  });

  it('carries the userOpHash the send learned without matching on it', () => {
    const machine = createGateMachine(deps);
    machine.onReady();
    machine.onResponse(A);
    machine.onSent({ ...A, userOpHash: `0x${'fe'.repeat(32)}` });
    // The chain log names the nonce and nothing else, so that is what a verdict is matched on.
    machine.onVerdict({ kind: 'admit', nonce: A.nonce, blockNumber: 5n, finalized: false });
    expect(machine.state()).toBe('admit');
  });
});

describe('the states that are not admit', () => {
  it('offlineAdmit is a state of its own, never admit', () => {
    const machine = createGateMachine(deps);
    machine.onReady();
    machine.onResponse(A);
    machine.onPreflight({ ok: true, ticket });
    machine.onOfflineAdmit(A, 3);
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
    vi.advanceTimersByTime(WAIT_HINT_MS);
    machine.onVerdict({ kind: 'deny', nonce: A.nonce, code: 'ALREADY_USED', detail: '이미 입장' });
    machine.reset();

    expect(machine.state()).toBe('ready');
    expect(machine.snapshot()).toMatchObject({
      deny: undefined,
      denyDetail: undefined,
      ticket: undefined,
      blockNumber: undefined,
      finalized: false,
      checking: false,
      waitHint: false,
    });
  });

  /** The tap goes with the verdict: a log that arrives after the reset has nobody to admit. */
  it('forgets which tap it was about, so a late verdict cannot reopen it', () => {
    const machine = inFlight();
    machine.onVerdict({ kind: 'admit', nonce: A.nonce, blockNumber: 99n, finalized: true });
    machine.reset();
    machine.onVerdict({ kind: 'admit', nonce: A.nonce, blockNumber: 99n, finalized: true });
    expect(machine.state()).toBe('ready');
  });

  it('onReady after a verdict is the same clean slate', () => {
    const machine = inFlight();
    machine.onVerdict({ kind: 'admit', nonce: A.nonce, blockNumber: 99n, finalized: true });
    machine.onReady();
    expect(machine.state()).toBe('ready');
    expect(machine.snapshot().blockNumber).toBeUndefined();
    // And a tap is accepted again, which a stuck `settled()` would have blocked.
    expect(machine.onResponse(B)).toBe(true);
    expect(machine.state()).toBe('received');
  });

  it('keeps the offline queue depth across a reset — it is not this tap’s business', () => {
    const machine = createGateMachine(deps);
    machine.onReady();
    machine.onResponse(A);
    machine.onOfflineAdmit(A, 4);
    machine.reset();
    expect(machine.snapshot().pendingCount).toBe(4);
    expect(machine.snapshot().online).toBe(false);
  });
});

/**
 * Task 26's connectivity watcher, pushed in. There is one watcher on the device, owned by the
 * wiring and shared with the queue drain, so the machine is told rather than asking — a second
 * probe loop would be a second opinion about whether the door is online.
 */
describe('what the header says about the connection', () => {
  it('starts online and takes the watcher’s answer', () => {
    const machine = createGateMachine(deps);
    expect(machine.snapshot().online).toBe(true);
    machine.setOnline(false);
    expect(machine.snapshot().online).toBe(false);
    machine.setOnline(true);
    expect(machine.snapshot().online).toBe(true);
  });

  it('tells its listeners, once per change and not once per call', () => {
    const machine = createGateMachine(deps);
    const seen: boolean[] = [];
    machine.subscribe((context) => seen.push(context.online));
    machine.setOnline(true); // already true
    machine.setOnline(false);
    machine.setOnline(false);
    machine.setOnline(true);
    expect(seen).toEqual([false, true]);
  });

  /**
   * The line that matters: it is a label, not a decision. A watcher answering mid-operation must
   * not settle, cancel or reroute the tap that is already in flight — the online/offline branch
   * was taken when the tap was accepted, and a check-in already handed to the bundler does not
   * become a queued one because the badge turned red.
   */
  it('moves no state and settles nothing', () => {
    const machine = inFlight();
    machine.setOnline(false);
    expect(machine.state()).toBe('confirming');
    machine.setOnline(true);
    expect(machine.state()).toBe('confirming');

    // And the verdict for that tap still lands, on the tap it was always about.
    machine.onVerdict({ kind: 'admit', nonce: A.nonce, blockNumber: 99n, finalized: true });
    expect(machine.state()).toBe('admit');
    expect(machine.snapshot().online).toBe(true);
  });

  /** A verdict on screen is not wiped by the radio coming back. */
  it('does not clear a verdict the staff member has not read', () => {
    const machine = inFlight();
    machine.onVerdict({ kind: 'deny', nonce: A.nonce, code: 'ALREADY_USED' });
    machine.setOnline(false);
    expect(machine.state()).toBe('deny');
    expect(machine.snapshot().deny).toBe('ALREADY_USED');
  });

  /**
   * `onOfflineAdmit` sets the flag itself, because that card is *about* the connection being
   * gone. The watcher may then say the signal is back while the card is still up — which is
   * true, and the queued entry is still queued: the card is driven by the state, not the badge.
   */
  it('lets the watcher correct an offline admit’s badge without touching the card', () => {
    const machine = createGateMachine(deps);
    machine.onReady();
    machine.onResponse(A);
    machine.onOfflineAdmit(A, 2);
    expect(machine.snapshot().online).toBe(false);
    machine.setOnline(true);
    expect(machine.state()).toBe('offlineAdmit');
    expect(machine.snapshot().pendingCount).toBe(2);
  });
});

/**
 * Task 24 review V1/V2. The machine owns the chain watch, because the screen that opened one
 * cannot know when the tap is done with it — and it keeps the previous tap's result, because a
 * gate that presses on to the next attendee would otherwise lose the record of an entry it has
 * already paid for.
 */
describe('the watch the machine owns, and the tap before this one', () => {
  /** A stub `WatchFactory`: records what it was opened for and whether it was closed. */
  function stubWatch() {
    const opened: TapId[] = [];
    const stop = vi.fn();
    let answer: ((verdict: Verdict) => void) | undefined;
    const watch = vi.fn((tap: TapId, onVerdict: (verdict: Verdict) => void) => {
      opened.push(tap);
      answer = onVerdict;
      return stop;
    });
    return { watch, stop, opened, say: (verdict: Verdict) => answer?.(verdict) };
  }

  it('opens one watch per send, for the tap that was sent', () => {
    const w = stubWatch();
    inFlight(A, { watch: w.watch });
    expect(w.watch).toHaveBeenCalledTimes(1);
    expect(w.opened[0]).toMatchObject({ tokenId: A.tokenId, nonce: A.nonce });
  });

  it('routes the watch’s verdict through the same door as onVerdict', () => {
    const w = stubWatch();
    const machine = inFlight(A, { watch: w.watch });
    w.say({ kind: 'admit', nonce: A.nonce, blockNumber: 99n, finalized: false });
    expect(machine.state()).toBe('admit');
    expect(machine.snapshot().finalized).toBe(false);
  });

  /** Spec §7.2-8: the same log comes back `finalized`, so a speculative admit keeps listening. */
  it('keeps the watch open on a speculative admit and closes it on the finalized one', () => {
    const w = stubWatch();
    const machine = inFlight(A, { watch: w.watch });
    machine.onVerdict({ kind: 'admit', nonce: A.nonce, blockNumber: 99n, finalized: false });
    expect(w.stop).not.toHaveBeenCalled();
    machine.onVerdict({ kind: 'admit', nonce: A.nonce, blockNumber: 99n, finalized: true });
    expect(w.stop).toHaveBeenCalledTimes(1);
  });

  it('closes it on a refusal, which has no second stage to wait for', () => {
    const w = stubWatch();
    const machine = inFlight(A, { watch: w.watch });
    machine.onVerdict({ kind: 'deny', nonce: A.nonce, code: 'ALREADY_USED' });
    expect(w.stop).toHaveBeenCalledTimes(1);
  });

  it('closes it on reset, on an offline admit, on an override and on stop', () => {
    for (const settle of [
      (m: ReturnType<typeof createGateMachine>) => m.reset(),
      (m: ReturnType<typeof createGateMachine>) => m.onOfflineAdmit(A, 1),
      (m: ReturnType<typeof createGateMachine>) => m.onOverride(),
      (m: ReturnType<typeof createGateMachine>) => m.stop(),
    ]) {
      const w = stubWatch();
      settle(inFlight(A, { watch: w.watch }));
      expect(w.stop).toHaveBeenCalledTimes(1);
    }
  });

  it('never leaves two watches open across taps', () => {
    const w = stubWatch();
    const machine = inFlight(A, { watch: w.watch });
    machine.onVerdict({ kind: 'admit', nonce: A.nonce, blockNumber: 99n, finalized: true });
    machine.reset();
    machine.onResponse(B);
    machine.onSent(B);
    expect(w.watch).toHaveBeenCalledTimes(2);
    // The first one was closed before the second opened, and closing it twice is not a leak.
    expect(w.stop).toHaveBeenCalled();
  });

  it('keeps the settled tap as 직전 탭 once the gate goes back to waiting', () => {
    const machine = inFlight();
    expect(machine.lastSettled()).toBeUndefined();
    machine.onVerdict({ kind: 'admit', nonce: A.nonce, blockNumber: 99n, finalized: true });
    // Still the live verdict — nothing is "previous" while it is on screen.
    expect(machine.lastSettled()).toBeUndefined();

    machine.reset();
    expect(machine.lastSettled()).toMatchObject({
      state: 'admit',
      blockNumber: 99n,
      finalized: true,
      ticket,
    });
    expect(machine.lastSettled()?.tap.nonce).toBe(A.nonce);

    // And the next tap does not disturb it until it settles in turn.
    machine.onResponse(B);
    expect(machine.lastSettled()?.tap.nonce).toBe(A.nonce);
  });

  it('keeps a refusal as 직전 탭 too, with the reason it was refused for', () => {
    const machine = inFlight();
    machine.onVerdict({ kind: 'deny', nonce: A.nonce, code: 'REVOKED', detail: '취소된 티켓' });
    machine.onReady();
    expect(machine.lastSettled()).toMatchObject({ state: 'deny', deny: 'REVOKED', denyDetail: '취소된 티켓' });
  });

  it('does not keep a tap that never settled', () => {
    const machine = inFlight();
    machine.onTimeout(A.nonce);
    machine.reset();
    expect(machine.lastSettled()).toBeUndefined();
  });
});

/**
 * V1. The offline path resolves asynchronously at exactly the venue where taps pile up, and an
 * `offlineAdmit` on the wrong row is a person through the door on someone else's ticket.
 */
describe('the offline admit names its tap', () => {
  it('admits the tap on screen', () => {
    const machine = inFlight();
    machine.onOfflineAdmit(A, 3);
    expect(machine.state()).toBe('offlineAdmit');
    expect(machine.snapshot().pendingCount).toBe(3);
    expect(machine.snapshot().online).toBe(false);
  });

  it('drops one that names the attendee before this one', () => {
    const machine = createGateMachine(deps);
    machine.onReady();
    machine.onResponse(A);
    machine.reset();
    machine.onResponse(B);
    machine.onPreflight({ ok: true, ticket: otherTicket });

    machine.onOfflineAdmit(A, 3);
    expect(machine.state()).toBe('received');
    expect(machine.snapshot().online).toBe(true);
    expect(machine.snapshot().pendingCount).toBe(0);

    machine.onOfflineAdmit(B, 3);
    expect(machine.state()).toBe('offlineAdmit');
  });

  it('drops one that arrives with no tap on screen at all', () => {
    const machine = createGateMachine(deps);
    machine.onReady();
    machine.onOfflineAdmit(A, 1);
    expect(machine.state()).toBe('ready');
  });
});
