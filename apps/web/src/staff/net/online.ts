// Whether this gate can still reach the chain — which is not the same question as whether the
// phone has a network.
//
// `navigator.onLine` answers "is there a link-layer connection", and at a venue the answer is
// almost always yes: the staff phone is on the house Wi-Fi, the captive portal is happy, the
// signal bars are full, and the RPC endpoint behind it is unreachable or hung (spec §12, T10).
// A gate that trusted `navigator.onLine` would keep every tap in `confirming` and never open the
// offline path, which is the one thing that keeps a door moving when the uplink dies.
//
// So this watcher asks the chain itself, on a cadence, and combines the two signals:
//
//   online  ==  the browser says there is a network  AND  the RPC answered recently
//
// Both halves are needed in that direction. `navigator.onLine === false` is believed instantly —
// the OS knows the radio is down before any request can time out. An RPC failure is not believed
// instantly: one miss is a dropped packet, so it takes two in a row, and a single success is
// enough to come back. The asymmetry is deliberate. Going offline costs a queued check-in that
// has to settle later; staying offline costs every attendee still in the queue.
//
// The probe is `eth_chainId`: no block to fetch, no state to read, no gas, and it goes out over
// the same fallback transport as every other read (`shared/chain/client`), so it exercises the
// URLs the gate actually uses instead of a second list that could drift out of sync.
//
// ## One request at a time
//
// The probe cannot be cancelled. viem's `buildRequest` would pass a `signal` down to `fetch`,
// but the **fallback** transport's request function takes only `{ method, params }` and drops
// the per-call options entirely — and the fallback is exactly what the no-second-URL-list rule
// requires. So an abandoned probe keeps running: worst case `3 URLs × 2 attempts × 8 s = 48 s`
// against a hung endpoint, which at the 5 s cadence would put ten dead sockets in flight and
// eat the browser's six-per-host budget out from under the snapshot and the check-in reads.
//
// The rule that fixes it without a second URL list: **never open a second request while the
// first is still out.** What such a tick *counts*, though, depends on how old that request is.
// `visibilitychange` and `online` tick immediately rather than on the cadence, so a tick can
// land microseconds after a probe was opened, and a probe that is 3 ms old has not been silent
// about anything yet: a tick that finds one still inside its own deadline opens nothing and
// counts nothing. Once the outstanding probe is past that deadline the silence is the reading
// again and the tick counts as a failure. A hung endpoint therefore still reaches offline on
// schedule (fire at 30 s → deadline at 32 s is failure one → the 60 s tick is failure two) with
// exactly one socket ever outstanding.
import { getPublicClient } from '../../shared/chain/client';

/** Probe cadence while a tap is waiting on the chain. A staff member is watching the screen. */
export const PROBE_ACTIVE_MS = 5_000;
/** Probe cadence between taps. Cheap, but not free — a gate runs for hours on one battery. */
export const PROBE_IDLE_MS = 30_000;
/** A probe that has not answered in this long has failed. Shorter than the transport's own 8 s
 *  timeout on purpose: the answer is only useful while the attendee is still standing there. */
export const PROBE_TIMEOUT_MS = 2_000;
/** One miss is noise. Two in a row is a network. */
export const OFFLINE_AFTER_FAILURES = 2;

export interface OnlineWatcher {
  /** The current answer. Safe to call from a render — it reads a field, it does not probe. */
  online(): boolean;
  /**
   * Fires on **changes only**, which is what `useSyncExternalStore` wants: the badge pairs this
   * with `online` and re-renders exactly when the answer moves. It does not replay the current
   * value, so a consumer that needs a starting point reads `online()` once on mount.
   */
  subscribe(listener: (online: boolean) => void): () => void;
  /**
   * The gate machine's hint that a tap is in flight, which tightens the cadence to 5 s.
   *
   * **It can pull a probe earlier; it can never push one out.** The machine toggles this on
   * every single tap — `onSent` to true, the verdict back to false — and a handler that
   * restarted the interval would make a busy door probe *less* than an idle one: at a tap every
   * 4 s with a 1.5 s verdict the clock never survives to its own deadline and the gate goes
   * blind for exactly as long as the queue lasts. So a change only ever takes the earlier of
   * the probe already due and one cadence from the last probe. Relaxing back to idle therefore
   * lets the armed 5 s probe fire first, and the 30 s rhythm starts from that probe.
   */
  setTapPending(pending: boolean): void;
  /** Releases every timer and listener this watcher owns. Nothing restarts after this. */
  stop(): void;
}

export interface OnlineWatcherParams {
  /** Overrides for tests and for a gate that wants a different rhythm. */
  activeProbeMs?: number;
  idleProbeMs?: number;
  probeTimeoutMs?: number;
}

class ProbeTimeout extends Error {
  constructor() {
    super('PROBE_TIMEOUT');
    this.name = 'ProbeTimeout';
  }
}

export function createOnlineWatcher(params: OnlineWatcherParams = {}): OnlineWatcher {
  const activeProbeMs = params.activeProbeMs ?? PROBE_ACTIVE_MS;
  const idleProbeMs = params.idleProbeMs ?? PROBE_IDLE_MS;
  const probeTimeoutMs = params.probeTimeoutMs ?? PROBE_TIMEOUT_MS;

  const listeners = new Set<(online: boolean) => void>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** The current probe's deadline, held here so `stop()` can clear it mid-flight. At most one
   *  probe is ever outstanding, so one slot is enough. */
  let deadline: ReturnType<typeof setTimeout> | undefined;
  /** The request on the wire, cleared whenever it finally answers — which can be long after its
   *  own deadline passed. Non-undefined means: do not open another one. */
  let pending: Promise<unknown> | undefined;
  /** When that request went out, so a tick can tell a probe that has merely not answered *yet*
   *  from one that has already missed its own deadline. Moves in lockstep with `pending`. */
  let pendingSince: number | undefined;
  let lastProbeAt = Date.now();
  /** When the next probe is owed, as a clock time rather than a delay — a cadence change has to
   *  compare against it, and a delay left in a `setTimeout` cannot be read back. */
  let dueAt = lastProbeAt;
  let stopped = false;
  let tapPending = false;
  let failures = 0;

  // The staff build only ever runs in a WebView, but a module that throws at import time takes a
  // whole screen with it, so the DOM is reached for defensively rather than assumed.
  const dom = typeof window !== 'undefined' ? window : undefined;
  const doc = typeof document !== 'undefined' ? document : undefined;
  const radioDown = (): boolean => typeof navigator !== 'undefined' && navigator.onLine === false;

  // The two halves of the answer, kept apart so neither can silently overwrite the other.
  let radioUp = !radioDown();
  let rpcUp = true;
  let published = radioUp && rpcUp;

  const publish = (): void => {
    const next = radioUp && rpcUp;
    if (next === published) return;
    published = next;
    // Copied, because a listener is allowed to unsubscribe itself while being told.
    for (const listener of [...listeners]) listener(published);
  };

  const succeed = (): void => {
    failures = 0;
    rpcUp = true;
    publish();
  };

  const fail = (): void => {
    failures += 1;
    if (failures >= OFFLINE_AFTER_FAILURES) rpcUp = false;
    publish();
  };

  const cadenceMs = (): number => (tapPending ? activeProbeMs : idleProbeMs);

  const armAt = (at: number): void => {
    if (stopped) return;
    dueAt = at;
    if (timer !== undefined) clearTimeout(timer);
    // A due time already in the past fires on the next turn of the loop rather than never.
    timer = setTimeout(tick, Math.max(0, at - Date.now()));
  };

  /** After a probe the next one is a full cadence away, measured from the probe that just ran. */
  const armNext = (): void => armAt(lastProbeAt + cadenceMs());

  /**
   * A cadence change takes the **earlier** of what is already due and one new cadence from the
   * last probe. The `min` is the whole fix: without it, a hint that flips on every tap resets
   * the clock forever and the gate never probes at all.
   */
  const rearm = (): void => armAt(Math.min(dueAt, lastProbeAt + cadenceMs()));

  // The next probe is scheduled *before* this one runs, so a slow answer shifts nothing: the
  // cadence is a metronome, not a chain of retries.
  function tick(): void {
    lastProbeAt = Date.now();
    armNext();
    void probe();
  }

  /** Rejects at `probeTimeoutMs` whether or not the wire ever answers. */
  const withDeadline = async <T>(work: Promise<T>): Promise<T> => {
    const expiry = new Promise<never>((_resolve, reject) => {
      deadline = setTimeout(() => reject(new ProbeTimeout()), probeTimeoutMs);
    });
    try {
      return await Promise.race([work, expiry]);
    } finally {
      if (deadline !== undefined) {
        clearTimeout(deadline);
        deadline = undefined;
      }
    }
  };

  const probe = async (): Promise<void> => {
    if (stopped) return;
    if (pending !== undefined) {
      // A request is still out there, so this tick opens nothing either way: stacking sockets on
      // an endpoint that has not answered would only spend the browser's six-per-host budget on
      // something nothing downstream can abort. Whether it also *counts* is the age question.
      // `visibilitychange` and `online` tick the moment they fire, so this can be microseconds
      // after the probe went out — charging a failure to a request that has not yet had its own
      // deadline to answer would let a staff member glancing at the phone talk a healthy gate
      // onto the offline path. Past that deadline the silence is the reading again.
      if (pendingSince !== undefined && Date.now() - pendingSince < probeTimeoutMs) return;
      fail();
      return;
    }
    // No per-call options: the fallback transport drops them, so `retryCount` and `signal` here
    // would be decoration. The probe inherits the shared transport's retry policy; the deadline
    // below is what actually bounds it.
    const inflight = getPublicClient().request({ method: 'eth_chainId' });
    pending = inflight;
    pendingSince = Date.now();
    const release = (): void => {
      if (pending === inflight) {
        pending = undefined;
        pendingSince = undefined;
      }
    };
    // Both arms, so a late rejection is handled here rather than surfacing as unhandled.
    inflight.then(release, release);

    try {
      await withDeadline(inflight);
    } catch {
      if (!stopped) fail();
      return;
    }
    if (!stopped) succeed();
  };

  const onOffline = (): void => {
    radioUp = false;
    publish();
  };

  const onOnline = (): void => {
    radioUp = true;
    publish();
    // The radio is back, but the RPC has not said so yet. Ask now rather than leave the badge
    // red for up to 30 s after the network has visibly returned.
    if (failures > 0) tick();
  };

  const onVisibility = (): void => {
    if (stopped || doc?.visibilityState !== 'visible') return;
    // Android throttles background timers to once a minute and then freezes them outright, so
    // the cadence above is a promise the OS only keeps while the screen is on. Whatever the
    // badge is showing when the staff member looks back at it was decided before the screen
    // went dark; ask again now instead of letting a stale `online: true` stand for 30 s.
    tick();
  };

  dom?.addEventListener('offline', onOffline);
  dom?.addEventListener('online', onOnline);
  doc?.addEventListener('visibilitychange', onVisibility);
  armNext();

  return {
    online: () => published,

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    setTapPending(pending_) {
      if (stopped || pending_ === tapPending) return;
      tapPending = pending_;
      rearm();
    },

    stop() {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      if (deadline !== undefined) clearTimeout(deadline);
      timer = undefined;
      deadline = undefined;
      pending = undefined;
      pendingSince = undefined;
      dom?.removeEventListener('offline', onOffline);
      dom?.removeEventListener('online', onOnline);
      doc?.removeEventListener('visibilitychange', onVisibility);
      listeners.clear();
    },
  };
}
