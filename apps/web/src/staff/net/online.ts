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
// URLs the gate actually uses instead of a second list that could drift out of sync. It is
// capped by a deadline of its own, because the failure this module exists to catch is a socket
// that accepts the request and never answers.
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
   * with `online` and re-renders exactly when the answer moves.
   */
  subscribe(listener: (online: boolean) => void): () => void;
  /**
   * The gate machine's hint that a tap is in flight, which tightens the cadence to 5 s. Calling
   * it with the value it already holds is a no-op, so a busy door cannot starve its own probe by
   * restarting the clock on every tap.
   */
  setTapPending(pending: boolean): void;
  /** Releases the timer and the two window listeners. Nothing restarts after this. */
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

/**
 * Rejects at `ms` whether or not `work` ever settles. The abandoned request keeps running — we
 * cannot cancel an in-flight EIP-1193 call — but it can no longer hold the verdict hostage, and
 * the next probe is already scheduled, so nothing piles up: at most one probe is outstanding
 * from this module's point of view, because this deadline is shorter than the shortest cadence.
 */
async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new ProbeTimeout()), ms);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

export function createOnlineWatcher(params: OnlineWatcherParams = {}): OnlineWatcher {
  const activeProbeMs = params.activeProbeMs ?? PROBE_ACTIVE_MS;
  const idleProbeMs = params.idleProbeMs ?? PROBE_IDLE_MS;
  const probeTimeoutMs = params.probeTimeoutMs ?? PROBE_TIMEOUT_MS;

  const listeners = new Set<(online: boolean) => void>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let tapPending = false;
  let failures = 0;

  // The two halves of the answer, kept apart so neither can silently overwrite the other.
  let radioUp = navigator.onLine !== false;
  let rpcUp = true;
  let published = radioUp && rpcUp;

  const publish = (): void => {
    const next = radioUp && rpcUp;
    if (next === published) return;
    published = next;
    // Copied, because a listener is allowed to unsubscribe itself while being told.
    for (const listener of [...listeners]) listener(published);
  };

  const schedule = (): void => {
    if (stopped) return;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(tick, tapPending ? activeProbeMs : idleProbeMs);
  };

  // The next probe is scheduled *before* this one runs, so a slow answer shifts nothing: the
  // cadence is a metronome, not a chain of retries.
  function tick(): void {
    schedule();
    void probe();
  }

  const probe = async (): Promise<void> => {
    try {
      await withDeadline(
        getPublicClient().request({ method: 'eth_chainId' }, { retryCount: 0 }),
        probeTimeoutMs,
      );
      if (stopped) return;
      failures = 0;
      rpcUp = true;
    } catch {
      if (stopped) return;
      failures += 1;
      if (failures >= OFFLINE_AFTER_FAILURES) rpcUp = false;
    }
    publish();
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

  window.addEventListener('offline', onOffline);
  window.addEventListener('online', onOnline);
  schedule();

  return {
    online: () => published,

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    setTapPending(pending: boolean) {
      if (stopped || pending === tapPending) return;
      tapPending = pending;
      schedule();
    },

    stop() {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      window.removeEventListener('offline', onOffline);
      window.removeEventListener('online', onOnline);
      listeners.clear();
    },
  };
}
