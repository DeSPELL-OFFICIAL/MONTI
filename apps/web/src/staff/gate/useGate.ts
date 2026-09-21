// The gate, wired end to end: one tap in, one verdict out, and nothing in between that can
// invent an answer.
//
// Everything this file reaches for already exists and is already tested on its own. What is new
// here is the **order**, and the order is the whole task — every one of these steps is cheap,
// local and revocable until the one that is not, and doing them in any other sequence either
// spends a sponsored operation on an answer the phone already had, or admits somebody on
// evidence nobody checked:
//
//   emitter write  (T17)  the attendee's phone answered a code this gate served
//     -> decode    (T19)  is it ours, and does it answer a code still live?   — free, local
//     -> machine   (T23)  is this gate free to take a tap at all?             — free, local
//     -> preflight (T20)  does the signed guest list already refuse it?       — free, local
//     -> online?   (T26)  read ONCE, here, and never again for this tap
//         yes -> check-in op (T21) + the `CheckedIn` watch (T24)  — the chain decides
//         no  -> local device-signature verify + durable queue (T27, T28)
//     -> machine   (T23)  the verdict, and only from one of those two places
//     -> the cards (03 T31) via `Console.tsx`
//
// Three of those arrows are load-bearing enough to say out loud.
//
// **The machine is asked before anything is sent.** `onResponse` answers whether the tap was
// taken. A gate is one door and admits one person at a time, so a tap arriving while another is
// confirming is refused — and a caller that sent the check-in anyway would get an
// `AlreadyCheckedIn` back, which would wipe an admit the staff member has not read yet.
//
// **Online is read once per tap.** Not at the top of the effect, not again before the send: at
// the single point the branch is taken. A connection that drops while an operation is in flight
// does not retroactively turn a sent check-in into a queued one, and a connection that returns
// does not turn a queued one into a send.
//
// **A door that may not admit anybody does not run.** `enabled` is the registration's answer
// (`open && !revoked`) and `isOpenGate` is the chain's, re-read every minute; until both say yes
// the effect below never starts, and the moment either stops saying it the emitter, the watcher
// and the guest-list refresh are torn down. A blocking screen that left the gate rotating codes
// behind it would spend one sponsored operation per attendee on a revert the gate already knew
// about — or, offline, write durable rows for a door that will never be allowed to send them.
//
// **Success is not a verdict here.** A receipt with `success: true` turns nothing green. The
// green comes from `CheckedIn` (Task 24) through the watch the machine opened on `onSent`,
// because the log is the only thing that carries the nonce that says *which tap* was admitted.
// The one thing a receipt can do is refuse, and a timeout cannot even do that.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Address } from 'viem';

import type { GateResponseWire, SnapshotWire } from '@monti/shared';

import { readIdentity, readOrganizers, readTicket } from '../../shared/chain/reads';
import {
  CHECK_IN_WAIT_MS,
  DEVICE_CHANGE_WINDOW_MS,
  GATE_OPEN_RECHECK_MS,
  GATE_STATUS_POLL_MS,
} from '../constants';
import { warn } from '../log';
import { createOnlineWatcher } from '../net/online';
import { offlineAdmit } from '../offline/offlineAdmit';
import { drainQueue, parkedCount, pendingCount } from '../queue/opQueue';
import {
  current as currentSnapshot,
  photoFor,
  snapshotAgeMs,
  startSnapshotRefresh,
} from '../snapshot/store';
import type { GateContext, PreflightResult } from '../types';
import { sendCheckIn } from './checkInOp';
import { matchIssuedCode } from './decodeResponse';
import { DENY_LABELS, mapRevertToDenyCode } from './denyMap';
import { startGateEmitter, type GateEmitter, type GateTap } from './emitter';
import {
  createGateMachine,
  type GateMachine,
  type SettledTap,
  type TapId,
  type TapRefusal,
} from './machine';
import { preflight } from './preflight';
import { watchCheckedIn } from './verdict';

export interface UseGateParams {
  gateId: bigint;
  eventId: bigint;
  orgId: bigint;
  /**
   * The gate's smart account address. It goes to both callables so the server can check that
   * this terminal really is a registered gate of this event — it grants nothing by itself; the
   * authenticated party is the staff member's own Firebase session.
   */
  gateAccount: Address;
  /**
   * Whether this device is allowed to take taps at all, as the **registration** sees it:
   * `gateInfo(gateId).open && !revoked`. The chain's minute-by-minute `isOpenGate` answer is the
   * other half and is read inside this hook; the gate runs only while both agree.
   *
   * It is a parameter rather than something read here because a revoked gate must not even poll:
   * the answer cannot change, and a screen that keeps asking is a screen that looks busy.
   */
  enabled: boolean;
}

/**
 * Everything one gate screen renders from. The machine's `GateContext` is the spine; the rest
 * are facts that sit *beside* a verdict rather than inside one, which is why they are not in the
 * machine: an entry number, a face, a guest-list age and a queue depth are all still true when
 * the verdict changes, and a machine that owned them would clear them on every reset.
 */
export type UseGateResult = GateContext & {
  /** The face for the admit card: the snapshot's, or the one fetched for a ticket minted since. */
  photo?: string;
  /** What the guest list alone could say. `undefined` before the first tap of a session. */
  precheck?: PreflightResult;
  /** Milliseconds since the operation went out, for the confirming card's own clock. */
  elapsedMs: number;
  entriesCount: number;
  /** When the person on screen was let in. Not a verdict — the record of one. */
  admittedAt?: number;
  deviceChangedRecently: boolean;
  /** The snapshot's `requireKyc` (first), or `Ticket.eventMeta` (fallback). `false` = no photos. */
  requireKyc: boolean;
  /** The snapshot's `eventTitle`. Empty until the first guest list lands. */
  eventTitle: string;
  /** `machine.lastSettled()` — the previous tap, still readable while the next one runs. */
  lastTap?: SettledTap;
  /** `machine.refusal()` — why the last tap was not taken. Never about the attendee. */
  refusal?: TapRefusal;
  parkedCount: number;
  /** The queue's own last mark, for the banner. */
  queueError?: string;
  /**
   * `Organizers.isOpenGate`, re-read every minute. `undefined` until the first answer:
   * a gate that has not been told is not a gate that has been told "no".
   */
  gateOpen?: boolean;
  /** The one receiving path NFC and the QR fallback (Task 31) share. */
  handleResponse(response: GateResponseWire): Promise<void>;
  /** Clear the verdict and wait for the next attendee. The only thing that clears one. */
  retry(): void;
};

/** A DENY the gate decided locally, in the shape the machine takes. */
const localDeny = (tap: TapId, code: GateContext['deny'] & string, detail?: string) =>
  ({ kind: 'deny', nonce: tap.nonce, code, detail: detail ?? DENY_LABELS[code] }) as const;

export function useGate(params: UseGateParams): UseGateResult {
  const { gateId, eventId, orgId, gateAccount, enabled } = params;

  // One machine for the life of the screen. It is created lazily rather than in an effect
  // because the first render already reads its snapshot, and it is never recreated: the
  // parameters come from a registration that cannot change under a running gate (the screen is
  // not mounted until `gateOf` has answered), so a machine keyed on them is a machine keyed on
  // nothing that moves.
  const machineRef = useRef<GateMachine | null>(null);
  machineRef.current ??= createGateMachine({ gateId, eventId, orgId, watch: watchCheckedIn });
  const machine = machineRef.current;

  const [context, setContext] = useState<GateContext>(() => machine.snapshot());
  const [photo, setPhoto] = useState<string>();
  const [precheck, setPrecheck] = useState<PreflightResult>();
  const [elapsedMs, setElapsedMs] = useState(0);
  const [entriesCount, setEntriesCount] = useState(0);
  const [admittedAt, setAdmittedAt] = useState<number>();
  const [deviceChangedRecently, setDeviceChangedRecently] = useState(false);
  const [requireKyc, setRequireKyc] = useState(true);
  const [eventTitle, setEventTitle] = useState('');
  const [lastTap, setLastTap] = useState<SettledTap>();
  const [refusal, setRefusal] = useState<TapRefusal>();
  const [gateOpen, setGateOpen] = useState<boolean>();
  const [queueError, setQueueError] = useState<string>();
  // Held here rather than read off the machine: the machine learns the queue depth only when it
  // admits somebody offline, and the header has to show it after a drain too.
  const [queueDepth, setQueueDepth] = useState({ pending: 0, parked: 0 });
  const [listAgeMs, setListAgeMs] = useState(Number.POSITIVE_INFINITY);

  /** The QR fallback's way in, and `retry`'s way to the watcher, across renders. */
  const handlerRef = useRef<(response: GateResponseWire) => Promise<void>>(async () => {});
  const clearTapPendingRef = useRef<() => void>(() => {});

  /**
   * Both halves of the permission. `gateOpen === undefined` is "not told", not "told no", so the
   * gate waits rather than running — a terminal that started serving codes on a question it had
   * not yet had answered would be admitting people on an assumption.
   */
  const running = enabled && gateOpen === true;

  useEffect(() => {
    if (!running) return;
    const key = eventId.toString();
    let emitter: GateEmitter | undefined;
    let alive = true;

    const unsubscribe = machine.subscribe((next) => {
      setContext(next);
      // Both are pulled rather than pushed because the machine writes them beside the context
      // and an event that carried them would be a second copy that can go stale.
      setRefusal(machine.refusal());
      setLastTap(machine.lastSettled());
    });

    // **One watcher, owned here.** Task 26's watcher is deliberately not a singleton, and the
    // gate screen is the root that owns it: the queue drain below reads *this* watcher's answer
    // rather than opening a probe loop of its own, because two loops disagreeing about whether
    // the door is online is a gate that sends a check-in on one tap and queues the next.
    const watcher = createOnlineWatcher();
    machine.setOnline(watcher.online());
    clearTapPendingRef.current = () => watcher.setTapPending(false);

    /** `Ticket.eventMeta(eventId).endsAt`, seconds. Read once; the queue parks against it. */
    let endsAt: number | undefined;

    const refreshStatus = async (): Promise<void> => {
      const [age, pending, parked] = await Promise.all([
        snapshotAgeMs(key).catch(() => Number.POSITIVE_INFINITY),
        pendingCount().catch(() => 0),
        parkedCount().catch(() => 0),
      ]);
      if (!alive) return;
      setListAgeMs(age);
      setQueueDepth({ pending, parked });
      // The guest list is refreshed on its own ten-minute timer, so the event's name and whether
      // it carries photographs are re-read here rather than once at mount: a gate that booted
      // before its first snapshot landed would otherwise keep an empty title all shift.
      const held = currentSnapshot();
      if (held) {
        setEventTitle(held.eventTitle);
        setRequireKyc(held.requireKyc);
      }
    };

    /**
     * Everything the gate owes the chain, sent in the order it was taken.
     *
     * Run on three occasions, and the first is the one that was missing: **at mount**, because a
     * terminal restarted after a signal drop boots with rows already on disk and no edge left to
     * fire — they would have sat there for the rest of the shift. Then on every status tick, so a
     * row written while the drain was busy is not waiting for the next disconnection. Then on the
     * watcher's rising edge, which is the moment they can suddenly go out.
     *
     * Cheap to repeat: `drainQueue` returns immediately while the watcher says the gate is
     * offline, and it serialises itself (Task 29), so a pass already running is joined rather
     * than doubled.
     */
    const drain = async (): Promise<void> => {
      try {
        const rows = await drainQueue({ orgId, isOnline: () => watcher.online(), endsAt });
        if (!alive) return;
        // The banner speaks for the queue, so it shows the queue's own last mark and nothing
        // invented: a row that is simply waiting for signal has no sentence and needs none.
        setQueueError(rows.find((row) => row.status === 'failed')?.lastError);
      } catch (error) {
        warn('gate', 'queue drain failed', error);
      }
      await refreshStatus();
    };

    const unsubscribeOnline = watcher.subscribe((online) => {
      machine.setOnline(online);
      if (online) void drain();
    });

    const stopRefresh = startSnapshotRefresh(key, gateAccount);

    // The event's end, for the queue's park predicate (Task 28), and the fallback answer to
    // "does this event carry photographs" for the first minutes before a guest list lands.
    void readTicket()
      .eventMeta(eventId)
      .then((meta) => {
        endsAt = Number(meta.endsAt);
        if (alive && !currentSnapshot()) setRequireKyc(meta.requireKyc);
      })
      .catch(() => {
        // Unreadable: the gate stays conservative. `requireKyc` already defaults to `true`, and
        // an absent `endsAt` means the queue parks on its attempt limit instead — the safe way
        // to be wrong, because a queue that parks eagerly throws away real check-ins.
      });

    /**
     * One tap, start to finish. The order is the file's header comment, and every early return
     * is a refusal that cost nothing.
     */
    const runTap = async ({ response, code }: GateTap): Promise<void> => {
      const tap: TapId = { tokenId: BigInt(response.tokenId), nonce: code.nonce };

      // The machine decides whether this gate is free to take the tap at all. `false` is not an
      // error and not the attendee's fault — the toast says which of the two reasons it was —
      // and nothing may be sent for a tap that was refused here.
      //
      // The refusal is read across explicitly because a refused tap changes **nothing** about the
      // context: the machine emits no patch, so the subscription below never runs, and a toast
      // that waited for one would never appear. The staff member would watch an attendee tap a
      // phone that is listening perfectly well and says nothing.
      if (!machine.onResponse(tap)) {
        setRefusal(machine.refusal());
        return;
      }

      setPhoto(undefined);
      setDeviceChangedRecently(false);

      try {
        const snapshot: SnapshotWire | undefined = currentSnapshot();
        const result = preflight({ snapshot, code, response });
        setPrecheck(result);
        machine.onPreflight(result);
        // A refusal the guest list could make is already on screen, in milliseconds, having
        // spent nothing. `ok` with no ticket is not a pass: it means the list did not recognise
        // the token, which online is "send it, the chain decides".
        if (!result.ok) return;
        if (result.ticket) setPhoto(result.ticket.photoJpegB64);

        // The branch, read once (see the header).
        if (!watcher.online()) {
          // Task 27 verifies the device signature against the key the snapshot holds and writes
          // the durable row — and it is awaited *before* the machine admits, so a phone that
          // dies in between cannot have told somebody they are in without a record of it.
          const decision = await offlineAdmit({ snapshot, code, response, orgId });
          await refreshStatus();
          if (!alive) return;
          if (decision.outcome === 'deny') {
            machine.onVerdict(localDeny(tap, decision.deny));
            return;
          }
          machine.onOfflineAdmit(tap, await pendingCount().catch(() => 0));
          return;
        }

        const handle = await sendCheckIn({ code, response, orgId });
        if (!alive) return;
        // Opens the chain watch for this tap and starts the two §7.3 clocks. Nothing green.
        machine.onSent({ ...tap, userOpHash: handle.userOpHash });
        watcher.setTapPending(true);

        const receipt = await handle.wait(CHECK_IN_WAIT_MS);
        if (!alive) return;
        if (receipt.revertReason === 'TIMEOUT') {
          // Not a failure. The operation is still out there and the watch is still open, so a
          // `CheckedIn` at thirty seconds still admits; the screen only stops promising speed.
          machine.onTimeout(tap.nonce);
          return;
        }
        if (!receipt.success) {
          const mapped = mapRevertToDenyCode(receipt.revertReason);
          machine.onVerdict({ kind: 'deny', nonce: tap.nonce, code: mapped.code, detail: mapped.detail });
          return;
        }
        // Landed. The verdict is the `CheckedIn` log, not this receipt: only the log carries the
        // nonce that says which tap was admitted, and a screen that turned green here would turn
        // green for whoever happens to be standing in front of the phone.
      } catch (error) {
        warn('gate', 'check-in failed', error);
        if (!alive) return;
        const mapped = mapRevertToDenyCode(undefined, (error as Error).message);
        machine.onVerdict({ kind: 'deny', nonce: tap.nonce, code: mapped.code, detail: mapped.detail });
      } finally {
        if (alive) watcher.setTapPending(false);
      }
    };

    /**
     * The QR fallback's entry point (Task 31). A camera produces the answer and nothing else, so
     * the code it answers is looked up here — against the emitter's whole ring, because at one
     * rotation every three seconds the code on the wire is rarely still the one that was
     * photographed. Everything after this line is identical to a tap, deliberately: one
     * receiving path, one set of rules.
     */
    handlerRef.current = async (response: GateResponseWire): Promise<void> => {
      const codes = emitter?.liveCodes() ?? [];
      let code;
      try {
        code = matchIssuedCode({ response, codes });
      } catch (error) {
        warn('gate', 'scanned answer matched no live code', error);
        return;
      }
      await runTap({ response, code });
    };

    void startGateEmitter({
      gateId,
      eventId,
      onTap: (tap) => void runTap(tap),
      // A write that was not one of our answers. The gate stays ready and says nothing to the
      // attendee: flashing a refusal at whoever waved a transit card past the phone is a queue
      // the gate made for itself.
      onError: (error) => warn('gate', 'tap not taken', error),
    })
      .then(async (started) => {
        emitter = started;
        if (!alive) {
          await started.stop();
          return;
        }
        machine.onReady();
        await refreshStatus();
      })
      .catch((error) => {
        // The AID was refused, so this phone is not emulating a card and no tap will ever
        // arrive. There is no degraded mode — the screen stays `idle` and says nothing green.
        warn('gate', 'the gate could not claim the tag', error);
      });

    // Mount, while the connection is already up: the rows on disk have no edge coming.
    if (watcher.online()) void drain();

    const status = setInterval(() => void drain(), GATE_STATUS_POLL_MS);

    return () => {
      alive = false;
      clearInterval(status);
      unsubscribeOnline();
      watcher.stop();
      void emitter?.stop();
      stopRefresh();
      machine.stop();
      unsubscribe();
    };
  }, [machine, running, gateId, eventId, orgId, gateAccount]);

  /**
   * Registration is permanent; permission is not. An organizer closes a gate when a door shuts
   * and revokes one when a phone goes missing, and neither emits anything this device listens
   * for — so it is asked, on mount and every minute after (Task 15 carry).
   */
  useEffect(() => {
    // A revoked gate is not coming back, and a registration that says the door is shut is already
    // an answer. Neither is worth an `eth_call` a minute.
    if (!enabled) {
      setGateOpen(false);
      return;
    }
    let alive = true;
    const ask = async (): Promise<void> => {
      try {
        const open = await readOrganizers().isOpenGate(eventId, gateAccount);
        if (alive) setGateOpen(open);
      } catch {
        // A read that did not arrive is not a closed gate. The last answer stands, which for a
        // gate that has never had one is `undefined` — "not told", not "told no".
      }
    };
    void ask();
    const timer = setInterval(() => void ask(), GATE_OPEN_RECHECK_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [enabled, eventId, gateAccount]);

  /**
   * The face, and the one case the guest list cannot answer: a ticket minted since the last
   * refresh. `photoFor` reads the list first and only then asks the server, so the common tap
   * costs nothing. An event with `requireKyc: false` carries no photographs at all, and the
   * empty string is what tells the card to draw an avatar and the nickname instead.
   */
  useEffect(() => {
    if (context.state !== 'admit' && context.state !== 'offlineAdmit') return;
    const ticket = context.ticket;
    if (!ticket) return;
    if (!requireKyc) {
      setPhoto('');
      return;
    }
    if (photo) return;
    let alive = true;
    void photoFor(ticket.tokenId, gateAccount)
      .then((found) => {
        if (alive) setPhoto(found.photoJpegB64);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [context.state, context.ticket, photo, requireKyc, gateAccount]);

  /**
   * Spec §13's amber note. A handed-over ticket and a genuinely new phone are the same fact on
   * chain, so the gate does not refuse on it — it tells the one person who can look at the
   * attendee and decide.
   */
  useEffect(() => {
    if (context.state !== 'admit') return;
    const account = context.ticket?.account;
    if (!account) return;
    let alive = true;
    void readIdentity()
      .deviceUpdatedAt(account)
      .then((at) => {
        if (alive) setDeviceChangedRecently(at > 0n && Date.now() - Number(at) * 1000 < DEVICE_CHANGE_WINDOW_MS);
      })
      .catch(() => {
        if (alive) setDeviceChangedRecently(false);
      });
    return () => {
      alive = false;
    };
  }, [context.state, context.ticket]);

  /** One entry per settled admit. `admit` → `admit` (speculative to final) is one entry, not two. */
  useEffect(() => {
    if (context.state !== 'admit' && context.state !== 'offlineAdmit') return;
    setEntriesCount((count) => count + 1);
    setAdmittedAt(Date.now());
  }, [context.state]);

  useEffect(() => {
    if (context.state !== 'confirming') {
      setElapsedMs(0);
      return;
    }
    const started = Date.now();
    const timer = setInterval(() => setElapsedMs(Date.now() - started), 100);
    return () => clearInterval(timer);
  }, [context.state]);

  const handleResponse = useCallback(
    (response: GateResponseWire) => handlerRef.current(response),
    [],
  );

  const retry = useCallback(() => {
    setPhoto(undefined);
    setPrecheck(undefined);
    setDeviceChangedRecently(false);
    clearTapPendingRef.current();
    machine.reset();
  }, [machine]);

  return {
    ...context,
    // The two the screen reads from here rather than from the machine: the machine is told the
    // queue depth only when it admits somebody offline, and it is never told the list's age.
    pendingCount: queueDepth.pending,
    snapshotAgeMs: listAgeMs,
    photo,
    precheck,
    elapsedMs,
    entriesCount,
    admittedAt,
    deviceChangedRecently,
    requireKyc,
    eventTitle,
    lastTap,
    refusal,
    parkedCount: queueDepth.parked,
    queueError,
    gateOpen,
    handleResponse,
    retry,
  };
}
