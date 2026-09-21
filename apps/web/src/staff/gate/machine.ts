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
import { CONFIRM_SPINNER_MS, RETAP_PROMPT_MS } from '../constants';
import type { DenyCode, GateContext, GateState, PreflightResult, SnapshotTicket } from '../types';

/**
 * The only two things that can settle a tap. `admit` carries the block it landed in and whether
 * that block is final — the screen shows the difference, because "admitted" and "admitted and
 * settled" are not the same promise to make to a staff member watching a queue.
 */
export type Verdict =
  | { kind: 'admit'; blockNumber: bigint; finalized: boolean }
  | { kind: 'deny'; code: DenyCode; detail?: string };

export interface GateMachine {
  state(): GateState;
  snapshot(): GateContext;
  subscribe(listener: (context: GateContext) => void): () => void;
  /** The emitter is running and the gate is serving codes. */
  onReady(): void;
  /** A tap decoded and matched to a live code (Task 19). */
  onResponse(): void;
  /** What the snapshot alone could say (Task 20). A refusal here never reaches the chain. */
  onPreflight(result: PreflightResult): void;
  /** The user operation is in flight (Task 21). Starts the two §7.3 clocks. */
  onSent(): void;
  onVerdict(verdict: Verdict): void;
  /** `wait()` gave up before the op landed. NOT a failure: the op is still out there. */
  onTimeout(): void;
  onOfflineAdmit(pendingCount: number): void;
  onOverride(): void;
  /** Clears the verdict and goes back to waiting for the next attendee. */
  reset(): void;
}

export interface GateMachineDeps {
  gateId: bigint;
  eventId: bigint;
  orgId: bigint;
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

  const emit = (patch: Partial<GateContext>): void => {
    context = { ...context, ...patch };
    for (const listener of listeners) listener(context);
  };

  const clearTimers = (): void => {
    for (const timer of timers) clearTimeout(timer);
    timers = [];
  };

  /** A tap that has already been answered. A second answer must not overwrite the first (T12). */
  const settled = (): boolean =>
    context.state === 'admit' || context.state === 'offlineAdmit' || context.state === 'deny';

  const refuse = (deny: DenyCode, denyDetail?: string, ticket?: SnapshotTicket): void => {
    clearTimers();
    emit({ state: 'deny', deny, denyDetail, ticket: ticket ?? context.ticket, checking: false, retapHint: false });
  };

  return {
    state: () => context.state,
    snapshot: () => context,

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    onReady() {
      clearTimers();
      emit({ state: 'ready', ...CLEARED });
    },

    onResponse() {
      // A double tap while the first verdict is still on screen keeps the first verdict (T12).
      // Without this the attendee's second tap would wipe an `admit` the staff has not yet read.
      if (settled()) return;
      clearTimers();
      emit({ state: 'received', checking: false, retapHint: false });
    },

    onPreflight(result: PreflightResult) {
      if (settled()) return;
      if (!result.ok) {
        refuse(result.deny, undefined, result.ticket);
        return;
      }
      // A pass is not an admit — it only means this is worth sending. The ticket comes along so
      // the screen can draw the photo and the name while the chain is still thinking.
      emit({ ticket: result.ticket });
    },

    onSent() {
      if (settled()) return;
      clearTimers();
      emit({ state: 'confirming', checking: false, retapHint: false });
      timers = [
        setTimeout(() => emit({ checking: true }), CONFIRM_SPINNER_MS),
        // Five seconds with no answer. The screen asks for another tap and the operation keeps
        // running: this is the line that would become a soft approval if it emitted a state.
        setTimeout(() => emit({ retapHint: true }), RETAP_PROMPT_MS),
      ];
    },

    onVerdict(verdict: Verdict) {
      // A late verdict is still the verdict. It may arrive after the re-tap hint went up, and
      // it still decides — that is the entire reason the hint is not a state.
      clearTimers();
      if (verdict.kind === 'admit') {
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
      refuse(verdict.code, verdict.detail);
    },

    onTimeout() {
      // `wait()` stopped watching; the operation did not stop existing. Staying in `confirming`
      // is the honest state, and the hint goes up because the attendee is standing there.
      if (settled()) return;
      clearTimers();
      emit({ state: 'confirming', checking: true, retapHint: true });
    },

    onOfflineAdmit(pendingCount: number) {
      // Its own state, never `admit`: this person walked in on a check-in the chain has not
      // accepted yet, and a screen that could not tell the two apart would let a staff member
      // believe a queued entry was settled.
      clearTimers();
      emit({ state: 'offlineAdmit', online: false, pendingCount, checking: false, retapHint: false });
    },

    onOverride() {
      clearTimers();
      emit({ state: 'override', checking: false, retapHint: false });
    },

    reset() {
      clearTimers();
      emit({ state: 'ready', ...CLEARED });
    },
  };
}
