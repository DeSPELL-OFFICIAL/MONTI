// The gate screen's state, and the one invariant the whole door rests on: **no soft approval**.
//
// Nothing in this file turns a tap green except a verdict that came from somewhere that can
// actually know — the chain (Task 24) or the offline path (Task 27). No timer, no timeout, no
// elapsed-time heuristic ever reaches `admit`. That is worth stating this loudly because the
// pressure to break it is real and arrives at the worst moment: a queue is backing up, the
// network is slow, and "it has been five seconds, just let them in" is the obvious thing to do.
// It is also how a revoked ticket walks through a door.
//
// So the five-second mark is advice, not a decision. The operation stays alive, the state stays
// `confirming`, and a `CheckedIn` that arrives at six seconds still admits (spec §7.3). What
// changes at two and five seconds is only what the screen says — `checking`, then `retapHint`.
//
// The second invariant, added after the Task 24 review: **one tap at a time, start to finish.**
// A physical gate admits one person at a time, and the machine now says so — a tap arriving
// while another is confirming is refused rather than allowed to displace it. Everything about
// identity below exists because the alternative is an answer landing on the wrong attendee.
import { CHECKING_LABEL_MS, RETAP_PROMPT_MS } from '../constants';
import type { DenyCode, GateContext, GateState, Hex, PreflightResult, SnapshotTicket } from '../types';

/**
 * What names one tap for its whole life.
 *
 * The gate keeps serving codes while a tap is confirming, so a second attendee can tap 1.5 s
 * after the first. Without a name on each operation the first attendee's `CheckedIn` lands on
 * the second attendee's photo — the same class of mix-up the v2 wire's `nonce` fixed one layer
 * down, and the reason every entry point below carries one.
 *
 * The `nonce` is the identity, because it is the only one the chain gives back: `CheckedIn`
 * carries `keccak256(abi.encode(nonce))` and knows nothing about user operations. `tokenId` is
 * here so the machine can open the chain watch for the tap it owns, and `userOpHash` rides along
 * from `onSent` for the queue and for field reports. Neither is ever matched on.
 */
export interface TapId {
  tokenId: bigint;
  nonce: Hex;
  userOpHash?: Hex;
}

/**
 * The only two things that can settle a tap, each naming the tap it settles.
 *
 * `admit` carries the block it landed in and whether that block is final — the screen shows the
 * difference, because "admitted" and "admitted and settled" are not the same promise to make to
 * a staff member watching a queue. `blockNumber` is optional because one admit cannot name a
 * block: the one-shot `checkInOf` read (Task 24) finds a check-in already in storage, which is
 * a recorded fact with no log to say which block recorded it.
 */
export type Verdict =
  | { kind: 'admit'; nonce: Hex; blockNumber?: bigint; finalized: boolean }
  | { kind: 'deny'; nonce: Hex; code: DenyCode; detail?: string };

/**
 * Why a tap was not taken. Exported so the wiring renders a sentence rather than inventing one
 * from a bare `false` — the two cases are different things to say to the person holding the
 * phone, and only one of them is about the attendee in front of it.
 */
export const TAP_REFUSAL = {
  /** A verdict is on screen and nobody has cleared it yet. Read it, then `reset()`. */
  showingVerdict: 'SHOWING_VERDICT',
  /** Someone else's check-in is still in flight. "잠시만 기다려 주세요." */
  confirming: 'CONFIRMING',
} as const;

export type TapRefusal = (typeof TAP_REFUSAL)[keyof typeof TAP_REFUSAL];

/**
 * The previous tap's final result, kept so the screen can still show "직전 탭" once the next
 * attendee is being processed. Without it a gate quietly loses the record of an entry it has
 * already paid for the moment the staff member presses on.
 */
export interface SettledTap {
  tap: TapId;
  state: Extract<GateState, 'admit' | 'offlineAdmit' | 'deny'>;
  ticket?: SnapshotTicket;
  blockNumber?: bigint;
  finalized: boolean;
  deny?: DenyCode;
  denyDetail?: string;
}

/** Stop listening. What `watchCheckedIn`/`subscribeLogs` hand back. */
export type StopWatching = () => void;

/**
 * Opens the chain watch for one tap — `watchCheckedIn` in production. The machine owns the
 * handle it gets back: nothing else can know when the tap is done with it.
 */
export type WatchFactory = (tap: TapId, onVerdict: (verdict: Verdict) => void) => StopWatching;

export interface GateMachine {
  state(): GateState;
  snapshot(): GateContext;
  subscribe(listener: (context: GateContext) => void): () => void;
  /** Why the last {@link GateMachine.onResponse} answered `false`. */
  refusal(): TapRefusal | undefined;
  /** The tap before this one, with the result it settled on. */
  lastSettled(): SettledTap | undefined;
  /** The emitter is running and the gate is serving codes. */
  onReady(): void;
  /**
   * A tap decoded and matched to a live code (Task 19). **Answers whether it was taken.**
   *
   * `false` means the gate is busy with another tap and this one was refused; {@link
   * GateMachine.refusal} says which of the two reasons it was. The caller must honour it — a
   * caller that sends the check-in anyway gets an `AlreadyCheckedIn` back, and that DENY would
   * wipe an admit the staff member has not read yet.
   */
  onResponse(tap: TapId): boolean;
  /** What the snapshot alone could say (Task 20). A refusal here never reaches the chain. */
  onPreflight(result: PreflightResult): void;
  /** The user operation is in flight (Task 21). Starts the two §7.3 clocks and the chain watch. */
  onSent(op: TapId): void;
  onVerdict(verdict: Verdict): void;
  /** `wait()` gave up before the op landed. NOT a failure: the op is still out there. */
  onTimeout(nonce: Hex): void;
  /** Task 27's offline path let this tap through. Carries its tap for the same reason a
   *  verdict does: an admit landing on the wrong attendee is a person through the wrong door. */
  onOfflineAdmit(tap: TapId, pendingCount: number): void;
  onOverride(): void;
  /** Clears the verdict and goes back to waiting for the next attendee. */
  reset(): void;
  /** The gate screen is going away. Closes the chain watch and the clocks. */
  stop(): void;
}

export interface GateMachineDeps {
  gateId: bigint;
  eventId: bigint;
  orgId: bigint;
  /**
   * How the machine watches the chain for the tap it is holding. Injected rather than imported
   * so this file stays free of chain code and a test can hand over a stub; production passes
   * `watchCheckedIn` from `./verdict`. Omitted, the machine simply never opens a watch and the
   * caller feeds `onVerdict` itself.
   */
  watch?: WatchFactory;
}

/** The fields a settled tap leaves behind, cleared on the way to waiting for the next one. */
const CLEARED = {
  deny: undefined,
  denyDetail: undefined,
  ticket: undefined,
  blockNumber: undefined,
  finalized: false,
  checking: false,
  retapHint: false,
} as const;

export function createGateMachine(deps: GateMachineDeps): GateMachine {
  let context: GateContext = {
    state: 'idle',
    gateId: deps.gateId,
    eventId: deps.eventId,
    orgId: deps.orgId,
    ...CLEARED,
    pendingCount: 0,
    snapshotAgeMs: 0,
    online: true,
  };

  const listeners = new Set<(context: GateContext) => void>();
  let timers: Array<ReturnType<typeof setTimeout>> = [];
  /** The tap the machine is currently about. Everything with a `nonce` is matched against it. */
  let tap: TapId | undefined;
  let stopWatching: StopWatching | undefined;
  let refusal: TapRefusal | undefined;
  let settledTap: SettledTap | undefined;

  const emit = (patch: Partial<GateContext>): void => {
    context = { ...context, ...patch };
    for (const listener of listeners) listener(context);
  };

  const clearTimers = (): void => {
    for (const timer of timers) clearTimeout(timer);
    timers = [];
  };

  const closeWatch = (): void => {
    stopWatching?.();
    stopWatching = undefined;
  };

  /** A tap that has already been answered. A second answer must not overwrite the first (T12). */
  const settled = (): boolean =>
    context.state === 'admit' || context.state === 'offlineAdmit' || context.state === 'deny';

  /** Somebody walked in on this tap. A later refusal may not take that back. */
  const admitted = (): boolean => context.state === 'admit' || context.state === 'offlineAdmit';

  /**
   * Whether an operation event is about the tap on screen. A nonce that does not match belongs
   * to an attendee who is no longer in front of the phone, and the honest thing is to drop it:
   * the machine shows one tap and cannot show a verdict for somebody who has moved on.
   */
  const isCurrentTap = (nonce: Hex): boolean =>
    tap !== undefined && tap.nonce.toLowerCase() === nonce.toLowerCase();

  /** Moves the tap on screen into the "직전 탭" slot on the way back to waiting. */
  const keepAsLastSettled = (): void => {
    if (!settled() || !tap) return;
    settledTap = {
      tap,
      state: context.state as SettledTap['state'],
      ticket: context.ticket,
      blockNumber: context.blockNumber,
      finalized: context.finalized,
      deny: context.deny,
      denyDetail: context.denyDetail,
    };
  };

  /** Back to waiting: the tap is over, so its clocks, its watch and its name all go with it. */
  const toWaiting = (): void => {
    clearTimers();
    closeWatch();
    keepAsLastSettled();
    tap = undefined;
    refusal = undefined;
    emit({ state: 'ready', ...CLEARED });
  };

  const refuseTap = (deny: DenyCode, denyDetail?: string, ticket?: SnapshotTicket): void => {
    clearTimers();
    // A refusal is final — there is no second stage to wait for, unlike a speculative admit.
    closeWatch();
    emit({ state: 'deny', deny, denyDetail, ticket: ticket ?? context.ticket, checking: false, retapHint: false });
  };

  const applyVerdict = (verdict: Verdict): void => {
    // A verdict for a tap that is no longer on screen is somebody else's answer. Dropping it
    // is the point of `TapId`: op A's admit must never land on attendee B's photo.
    if (!isCurrentTap(verdict.nonce)) return;
    // Somebody already walked in. A refusal arriving afterwards — an `AlreadyCheckedIn` from
    // a duplicate send, most often — is a fact about the second attempt, not about the person
    // who is already inside, and it must not wipe a green the staff has not read.
    if (verdict.kind === 'deny' && admitted()) return;
    // A late verdict is still the verdict. It may arrive after the re-tap hint went up, and
    // it still decides — that is the entire reason the hint is not a state.
    clearTimers();
    if (verdict.kind === 'admit') {
      // The watch stays open on a speculative admit and only on that: the same log comes back
      // `finalized` about half a second later and that upgrade is the whole of spec §7.2-8.
      if (verdict.finalized) closeWatch();
      emit({
        state: 'admit',
        blockNumber: verdict.blockNumber,
        finalized: verdict.finalized,
        deny: undefined,
        denyDetail: undefined,
        checking: false,
        retapHint: false,
      });
      return;
    }
    refuseTap(verdict.code, verdict.detail);
  };

  return {
    state: () => context.state,
    snapshot: () => context,
    refusal: () => refusal,
    lastSettled: () => settledTap,

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    onReady() {
      toWaiting();
    },

    onResponse(next: TapId) {
      // One tap at a time, start to finish (Task 24 review V2).
      //
      // A verdict still on screen keeps its screen (T12): the attendee's second tap must not
      // wipe an `admit` the staff has not yet read. And a tap arriving while another is still
      // `confirming` is refused too, which is the half that matters more — taking the slot
      // would leave the first attendee's `CheckedIn` with nowhere to land, and that attendee is
      // admitted on chain, paid for, and standing at a door that never said anything.
      //
      // The answer is returned rather than swallowed so the caller does not send a check-in for
      // a tap this machine refused; `refusal()` says which sentence to show.
      if (settled()) {
        refusal = TAP_REFUSAL.showingVerdict;
        return false;
      }
      if (context.state === 'confirming') {
        refusal = TAP_REFUSAL.confirming;
        return false;
      }
      clearTimers();
      refusal = undefined;
      tap = next;
      emit({ state: 'received', checking: false, retapHint: false });
      return true;
    },

    onPreflight(result: PreflightResult) {
      if (settled()) return;
      if (!result.ok) {
        refuseTap(result.deny, undefined, result.ticket);
        return;
      }
      // A pass is not an admit — it only means this is worth sending. The ticket comes along so
      // the screen can draw the photo and the name while the chain is still thinking.
      emit({ ticket: result.ticket });
    },

    onSent(op: TapId) {
      if (settled()) return;
      // A send that resolved after the next attendee already tapped must not restart the clocks
      // on their behalf.
      if (!isCurrentTap(op.nonce)) return;
      tap = { ...op };
      clearTimers();
      // One watch per tap, owned here: the screen that opened it cannot know when it is done,
      // and a gate that leaks one subscription per attendee runs out of socket long before the
      // queue does.
      closeWatch();
      stopWatching = deps.watch?.(tap, applyVerdict);
      emit({ state: 'confirming', checking: false, retapHint: false });
      timers = [
        setTimeout(() => emit({ checking: true }), CHECKING_LABEL_MS),
        // Five seconds with no answer. The screen asks for another tap and the operation keeps
        // running: this is the line that would become a soft approval if it emitted a state.
        setTimeout(() => emit({ retapHint: true }), RETAP_PROMPT_MS),
      ];
    },

    onVerdict(verdict: Verdict) {
      applyVerdict(verdict);
    },

    onTimeout(nonce: Hex) {
      // `wait()` stopped watching; the operation did not stop existing. Staying in `confirming`
      // is the honest state, and the hint goes up because the attendee is standing there.
      if (settled()) return;
      if (!isCurrentTap(nonce)) return;
      clearTimers();
      emit({ state: 'confirming', checking: true, retapHint: true });
    },

    onOfflineAdmit(next: TapId, pendingCount: number) {
      // Its own state, never `admit`: this person walked in on a check-in the chain has not
      // accepted yet, and a screen that could not tell the two apart would let a staff member
      // believe a queued entry was settled.
      //
      // It names its tap for the same reason a verdict does, and the stakes here are higher:
      // the offline path resolves asynchronously at exactly the venue where taps pile up, and
      // an `offlineAdmit` on the wrong row is a person through the door on someone else's
      // ticket. Wifi being bad is not a reason to relax the check.
      if (!isCurrentTap(next.nonce)) return;
      clearTimers();
      closeWatch();
      emit({ state: 'offlineAdmit', online: false, pendingCount, checking: false, retapHint: false });
    },

    onOverride() {
      // A staff button press. It is inherently about whoever is on screen, so it names no tap.
      clearTimers();
      closeWatch();
      emit({ state: 'override', checking: false, retapHint: false });
    },

    reset() {
      toWaiting();
    },

    stop() {
      clearTimers();
      closeWatch();
      keepAsLastSettled();
      tap = undefined;
    },
  };
}
