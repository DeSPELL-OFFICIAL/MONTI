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

import type { GateResponseWire, SnapshotTicket, SnapshotWire } from '@monti/shared';

import { getStaffAccount } from '../../shared/chain/accounts';
import { passkeyProblem } from '../../shared/passkey/errors';
import { readIdentity, readOrganizers, readTicket } from '../../shared/chain/reads';
import {
  DEVICE_CHANGE_WINDOW_MS,
  GATE_OPEN_RECHECK_MS,
  GATE_OPEN_STALE_MS,
  GATE_STATUS_POLL_MS,
} from '../constants';
import { useStaffCopy } from '../copy';
import { warn } from '../log';
import { checkPin } from '../override/pin';
import { OverrideDenied, readOverrideAuthority, submitOverride as sendOverride } from '../override/route';
import { useOverrideRequests, type OpenOverrideRequest } from '../override/useOverrideRequests';
import type { OverrideSubmitExtra } from '../components/OverrideDialog';
import { createOnlineWatcher } from '../net/online';
import { offlineAdmit } from '../offline/offlineAdmit';
import { drainQueue, parkedCount, pendingCount } from '../queue/opQueue';
import {
  current as currentSnapshot,
  lastGateOpen,
  photoFor,
  rememberGateOpen,
  search as searchSnapshot,
  snapshotAgeMs,
  startSnapshotRefresh,
} from '../snapshot/store';
import type { GateContext, OverrideOutcome, OverrideReason, PreflightResult } from '../types';
import { overrideNotice } from '../components/overrideText';
import { relayCheckIn } from './checkInOp';
import { matchIssuedCode } from './decodeResponse';
import { resolveTicketOnChain } from './overrideLookup';
import { DENY_LABELS, mapCallableDeny } from './denyMap';
import { isCardEmulationUnavailable, startGateEmitter, type GateEmitter, type GateTap } from './emitter';
import {
  createGateMachine,
  type GateMachine,
  type SettledTap,
  type TapId,
  type TapRefusal,
} from './machine';
import { admissionsDuplicate, preflight } from './preflight';
import { watchRelay } from './relayStatus';
import { watchManualOverride } from './verdict';

/**
 * The contract/forwarder code a relayed action's refusal carries in `details.code` — the same shape
 * `sendAction` rejects with on a failed relay doc, and `mapCallableDeny` maps to a DENY. `undefined`
 * for an unknown outcome (a dropped relay listener), which the override handler keeps in flight
 * rather than turning into a refusal a staff member would resend over.
 */
function relayRefusalCode(error: unknown): string | undefined {
  const details = (error as { details?: unknown } | null)?.details;
  if (typeof details !== 'object' || details === null) return undefined;
  const { code } = details as { code?: unknown };
  return typeof code === 'string' && code.length > 0 ? code : undefined;
}

export interface UseGateParams {
  gateId: bigint;
  eventId: bigint;
  orgId: bigint;
  /**
   * The gate's account address. It goes to the snapshot and photo callables so the server can check
   * that this terminal really is a registered gate of this event before it decrypts a face — it
   * grants nothing by itself; the authenticated party is the staff member's own Firebase session.
   * The relayed check-in does not take it: the gate's authority there is the P-256 signature on the
   * code, verified on chain against `Organizers.gateInfo`.
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
  /**
   * `gateOpen` came from this device's memory of the last session, not from the chain. True only
   * until the first successful read of this session, and only ever after one that failed.
   */
  gateOpenStale: boolean;
  /**
   * This device cannot emulate a card (a browser or an iPhone), so no tap will ever arrive. The
   * screen says so and leaves manual approval as the way in.
   */
  emulationUnavailable: boolean;
  /**
   * Whether the signed-in staff member may admit somebody outright, or only ask (Task 32).
   * Read from `Organizers` when the dialog opens and **never** cached across openings: rights
   * change inside a shift, and a stale `true` is a button that promises an operation the chain
   * will refuse. `false` until the read answers, which is the safe way to be wrong — it offers
   * to file a request, which every manager may do.
   */
  canApprove: boolean;
  /**
   * Opens the manual-approval dialog and asks who this staff member is. Answers `false` when the
   * gate refused to open it — today that is a check-in still confirming, and `refusal` says so.
   */
  openOverride(): boolean;
  /** Finds somebody in the held guest list by name or ticket number, for the dialog's search. */
  searchGuests(query: string): readonly SnapshotTicket[];
  /**
   * The fallback for a ticket number the snapshot does not carry — a just-minted ticket the
   * frozen indexer never listed. Reads the chain for that one number; resolves `undefined` when
   * it is not a number, not this event's, revoked, or unreadable.
   */
  searchGuestsOnChain(query: string): Promise<SnapshotTicket | undefined>;
  /**
   * The PIN, then the chain. `tokenId` is whoever the dialog picked; without one it falls back to
   * the tap on screen. Never throws: every outcome is a sentence in the dialog.
   */
  submitOverride(pin: string, reason: OverrideReason, tokenId?: string, extra?: OverrideSubmitExtra): Promise<void>;
  /**
   * The event's open approval requests (P4), polled while the dialog is open and this staff
   * member may approve; `[]` otherwise. Picking one approves it at the gate it was filed from.
   */
  overrideRequests: readonly OpenOverrideRequest[];
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
  // Manual approval is the one place this hook has a sentence to choose (a wrong PIN, a locked
  // one, a refused permission), and the machine carries that sentence because the dialog has
  // nowhere else to put it. The table is still the only place a sentence is written.
  const copy = useStaffCopy();

  // One machine for the life of the screen. It is created lazily rather than in an effect
  // because the first render already reads its snapshot, and it is never recreated: the
  // parameters come from a registration that cannot change under a running gate (the screen is
  // not mounted until `gateOf` has answered), so a machine keyed on them is a machine keyed on
  // nothing that moves.
  const machineRef = useRef<GateMachine | null>(null);
  machineRef.current ??= createGateMachine({
    gateId,
    eventId,
    orgId,
    // No `watch`: the check-in no longer confirms from an on-chain `CheckedIn` log this phone
    // reads. `onSent` only moves the screen to `confirming`; the verdict comes from `relayCheckIn`'s
    // own answer and, on `sent`, the `relays/{relayId}` document (design §7). The override watch
    // stays — `requestOverride` writes no check-in, so nothing else can answer a filed request.
    watchOverride: watchManualOverride,
  });
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
  const [canApprove, setCanApprove] = useState(false);
  const [gateOpenStale, setGateOpenStale] = useState(false);
  // Held here rather than read off the machine: the machine learns the queue depth only when it
  // admits somebody offline, and the header has to show it after a drain too.
  const [queueDepth, setQueueDepth] = useState({ pending: 0, parked: 0 });
  const [listAgeMs, setListAgeMs] = useState(Number.POSITIVE_INFINITY);
  const [emulationUnavailable, setEmulationUnavailable] = useState(false);

  /** The QR fallback's way in, and `retry`'s way to the watcher, across renders. */
  const handlerRef = useRef<(response: GateResponseWire) => Promise<void>>(async () => {});
  const clearTapPendingRef = useRef<() => void>(() => {});
  /**
   * The open `relays/{relayId}` subscription for the tap on screen, or a no-op. One at a time, the
   * same as the machine's chain watch used to be: it is replaced when the next tap opens its own,
   * stopped on `retry`, and torn down on unmount, so a settled answer can never land on a later tap.
   */
  const relayStopRef = useRef<() => void>(() => {});

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

        // The ~1 s cross-gate window (design §6): another online gate already admitting this ticket
        // is a duplicate the chain would refuse a second later, refused here now. A read that fails
        // is not a duplicate — the relayer's simulation is the authority, and this only saves the
        // round trip.
        const duplicate = await admissionsDuplicate({ eventId: eventId.toString(), tokenId: response.tokenId });
        if (!alive) return;
        if (duplicate) {
          machine.onVerdict(localDeny(tap, duplicate.deny));
          return;
        }

        // Into the relayer. The screen goes `confirming` and the two §7.3 clocks start; no chain
        // watch is opened (the machine has none), because the verdict is the callable's own answer
        // and, on `sent`, the `relays/{relayId}` document — not a log this phone reads.
        machine.onSent(tap);
        watcher.setTapPending(true);

        let relay;
        try {
          relay = await relayCheckIn({ code, response });
        } catch (error) {
          // A simulated revert is a DENY the relayer named (`details.code`); a dropped connection is
          // `TX_FAILED`. Either way it is decided here, before the screen ever turned green.
          if (!alive) return;
          const mapped = mapCallableDeny(error);
          machine.onVerdict({ kind: 'deny', nonce: tap.nonce, code: mapped.code, detail: mapped.detail });
          return;
        }
        if (!alive) return;

        if (relay.status === 'confirmed') {
          // Mined already, or an idempotent `AlreadyCheckedIn` the backend answers as success: a
          // settled PASS, no document to wait on.
          machine.onVerdict({ kind: 'admit', nonce: tap.nonce, finalized: true });
          return;
        }

        // `sent`: PASS now ("기록 중"), settled from the relayer's document. `confirmed` hardens the
        // card; a `failed` after PASS is dropped by the machine — a person who has walked in on a
        // simulation-checked broadcast is not un-admitted — which is the post-hoc behaviour a late
        // revert always had.
        machine.onVerdict({ kind: 'admit', nonce: tap.nonce, finalized: false });
        relayStopRef.current();
        relayStopRef.current = watchRelay(relay.relayId, (status) => {
          if (!alive) return;
          if (status === 'confirmed') {
            machine.onVerdict({ kind: 'admit', nonce: tap.nonce, finalized: true });
          } else {
            machine.onVerdict({ kind: 'deny', nonce: tap.nonce, code: 'TX_FAILED', detail: DENY_LABELS.TX_FAILED });
          }
          relayStopRef.current();
          relayStopRef.current = () => {};
        });
      } catch (error) {
        warn('gate', 'check-in failed', error);
        if (!alive) return;
        const mapped = mapCallableDeny(error);
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
        // A browser (or an iPhone) cannot emulate a card at all: say so on the screen and leave
        // manual approval as the way in, rather than an idle "tap here" nobody can answer.
        if (alive && isCardEmulationUnavailable(error)) setEmulationUnavailable(true);
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
      relayStopRef.current();
      relayStopRef.current = () => {};
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
      setGateOpenStale(false);
      return;
    }
    let alive = true;
    /** Whether this session has ever had the chain's own answer. Only the first failure falls back. */
    let answered = false;
    const ask = async (): Promise<void> => {
      try {
        const open = await readOrganizers().isOpenGate(eventId, gateAccount);
        if (!alive) return;
        answered = true;
        setGateOpen(open);
        setGateOpenStale(false);
        await rememberGateOpen(gateId, open);
      } catch {
        // A read that did not arrive is not a closed gate. The last answer of **this session**
        // stands; for a gate that has never had one, the last answer of the last session does —
        // otherwise a staff APK that cold-starts at a venue with no signal can never open the
        // door at all, which is the one failure a door cannot recover from by waiting.
        //
        // It is marked stale rather than passed off as fresh: a permission read an hour ago is
        // a fact about an hour ago, and the person holding the phone gets to know that.
        if (!alive || answered) return;
        const remembered = await lastGateOpen(gateId);
        if (!alive || answered || remembered === undefined) return;
        // And it expires. A remembered permission is one nobody has re-granted, and the case it
        // gets dangerous is the case it is for: a gate revoked while this phone was offline
        // would otherwise keep taking taps for the rest of the shift, every one of them a
        // durable row that can only ever revert. Past the window the screen goes back to
        // blocking, which is the honest state — this device does not know whether it may open.
        if (Date.now() - remembered.checkedAt > GATE_OPEN_STALE_MS) return;
        setGateOpen(remembered.open);
        setGateOpenStale(true);
      }
    };
    void ask();
    const timer = setInterval(() => void ask(), GATE_OPEN_RECHECK_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [enabled, eventId, gateAccount, gateId]);

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

  /**
   * A manual approval that landed is a person through the door too — `manualOverride` writes the
   * check-in and emits `CheckedIn` (Ticket.sol:420-427). It is counted here rather than with the
   * admits above because the machine deliberately does not call it `admit`: the chain watch
   * matches a tap by its nonce and this one carries `bytes32(0)`, so nothing will ever confirm
   * it the way a tap is confirmed. A filed request is not counted — nobody went in.
   */
  useEffect(() => {
    if (context.override?.status !== 'approved') return;
    setEntriesCount((count) => count + 1);
    setAdmittedAt(Date.now());
  }, [context.override?.status]);

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

  /**
   * Opens the dialog, and asks the chain who is holding the phone.
   *
   * The read is fired here rather than at mount for two reasons: it costs two `eth_call`s that
   * almost every shift never needs, and an answer read at 18:00 is not an answer about 22:00 —
   * an organizer can promote or demote a manager between doors. `canApprove` drops to `false`
   * first, so a second opening never shows the previous staff member's rights.
   */
  const openOverride = useCallback((): boolean => {
    // The machine may refuse — a check-in that is still confirming owns the screen, and taking
    // it would drop the watch for an operation that is running and already paid for.
    if (!machine.onOverride()) {
      setRefusal(machine.refusal());
      return false;
    }
    setCanApprove(false);
    void (async () => {
      try {
        const account = await getStaffAccount();
        const authority = await readOverrideAuthority({ orgId, account: account.address });
        setCanApprove(authority.route === 'manualOverride');
      } catch (error) {
        // Unreadable rights are not rights. The dialog then offers to file a request, which is
        // the smaller of the two claims and the one the chain is most likely to accept.
        warn('gate', 'could not read override rights', error);
        setCanApprove(false);
      }
    })();
    return true;
  }, [machine, orgId]);

  /** The dialog's search, bound to the snapshot this gate is running on. */
  const searchGuests = useCallback((query: string) => searchSnapshot(query), []);

  /** The guest-list name behind a ticket number, for the approver's request list. */
  const guestNameOf = useCallback(
    (tokenId: string) => searchSnapshot(tokenId).find((row) => row.tokenId === tokenId)?.displayName ?? '',
    [],
  );
  const overrideRequests = useOverrideRequests(eventId, context.state === 'override' && canApprove, guestNameOf);

  /**
   * The second path for when the snapshot cannot find them. The guest list is built from the
   * indexer's `Ticket` table, so a frozen indexer leaves a just-minted ticket off it — and the
   * dialog's search comes back empty for a ticket number that is on the chain. This asks the
   * chain for that one number (`overrideLookup`), kept async and separate so the sync search
   * above stays what existing callers and tests read.
   */
  const searchGuestsOnChain = useCallback(
    (query: string) => resolveTicketOnChain(query, eventId),
    [eventId],
  );

  /**
   * One manual approval, start to finish. Nothing here decides anything: the PIN decides whether
   * the dialog may act at all, and `Organizers` decides which call goes out and whether one goes
   * out. What this function owns is the **order**, and it is the same shape as a tap's — every
   * cheap local refusal happens before the operation, so a wrong PIN costs nothing, and the
   * passkey prompt (the moment a person rather than a terminal stands behind the door) is the
   * last thing that happens.
   *
   * It never throws. A dialog that swallowed an error would leave a staff member pressing a
   * button that does nothing in front of a queue, so every ending is a sentence.
   */
  const submitOverride = useCallback(
    async (pin: string, reason: OverrideReason, picked?: string, extra: OverrideSubmitExtra = {}): Promise<void> => {
      const fail = (detail: string, extra: Partial<OverrideOutcome> = {}): void =>
        machine.onOverrideResult({ status: 'failed', reason, detail, ...extra });

      // `manualOverride(tokenId, …)` has to be told who. The dialog's pick comes first — an
      // attendee whose phone produces nothing is the case this feature exists for — and the tap
      // on screen is the fallback for the ordinary case where somebody did manage to tap.
      const tokenId = picked ?? machine.snapshot().ticket?.tokenId;
      if (tokenId === undefined) {
        fail(copy.override.noTicket);
        return;
      }
      const displayName = searchSnapshot(tokenId).find((row) => row.tokenId === tokenId)?.displayName;

      machine.onOverrideResult({ status: 'sending', reason, tokenId, displayName });

      const verdict = await checkPin(pin);
      if (!verdict.ok) {
        if (verdict.reason === 'UNSET') fail(copy.override.pinUnset);
        else if (verdict.reason === 'LOCKED') fail(overrideNotice.pinLocked(copy, verdict.retryInMs));
        else fail(overrideNotice.pinWrong(copy, verdict.triesLeft));
        return;
      }

      let submission;
      try {
        submission = await sendOverride({
          orgId,
          eventId,
          // An approval picked from a request is recorded at the gate the requester stands at.
          gateId: extra.gateId !== undefined ? BigInt(extra.gateId) : gateId,
          tokenId: BigInt(tokenId),
          reason,
          note: extra.note,
        });
      } catch (error) {
        warn('gate', 'override was not sent', error);
        // Two endings the send helper raises before anything is signed: this account may not
        // approve (pressing again cannot change it), or the authority read did not come back.
        if (error instanceof OverrideDenied) fail(copy.override.denied);
        else fail(copy.override.failed);
        return;
      }

      // Who is approving, shown while the relay is still in flight — the passkey prompt and the
      // relay wait both live on `submission.settled`.
      const who = { route: submission.route, role: submission.role, approver: submission.approver };
      machine.onOverrideResult({ status: 'sending', reason, tokenId, displayName, ...who });

      try {
        await submission.settled;
      } catch (error) {
        warn('gate', 'override did not settle', error);
        // A dismissed biometric prompt did not fail — the sentence has to say what is missing.
        if (passkeyProblem(error) === 'cancelled') {
          fail(copy.override.cancelled, who);
          return;
        }
        // A named refusal → the same DENY mapping a relayed check-in uses. No code is lost contact
        // with the relayer (a dropped listener, a network drop): not a rule the door broke, but an
        // ending all the same — the staff member reads it and the retry lands in 직전 탭.
        if (relayRefusalCode(error) === undefined) {
          fail(copy.override.unreachable, who);
          return;
        }
        // The request callable's own refusal for an account that is not on the team (or lost its
        // place since the dialog opened) — the same sentence as a denied route.
        if (relayRefusalCode(error) === 'NOT_ALLOWED') {
          fail(copy.override.denied, who);
          return;
        }
        fail(mapCallableDeny(error).detail, who);
        return;
      }
      machine.onOverrideResult({
        status: submission.route === 'manualOverride' ? 'approved' : 'requested',
        reason,
        tokenId,
        displayName,
        ...who,
      });
    },
    [copy, eventId, gateId, machine, orgId],
  );

  const retry = useCallback(() => {
    setPhoto(undefined);
    setPrecheck(undefined);
    setDeviceChangedRecently(false);
    setCanApprove(false);
    clearTapPendingRef.current();
    relayStopRef.current();
    relayStopRef.current = () => {};
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
    gateOpenStale,
    emulationUnavailable,
    canApprove,
    overrideRequests,
    openOverride,
    searchGuests,
    searchGuestsOnChain,
    submitOverride,
    handleResponse,
    retry,
  };
}
