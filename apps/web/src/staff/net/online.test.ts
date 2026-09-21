import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The probe goes through the shared public client, so the mock replaces exactly one thing: the
 * EIP-1193 `request` the fallback transport would have put on the wire. Nothing here knows an
 * RPC URL — that list lives in `shared/config` and must keep living in only one place.
 */
const request = vi.fn<(args: { method: string }, options?: unknown) => Promise<unknown>>();
vi.mock('../../shared/chain/client', () => ({
  getPublicClient: () => ({ request }),
}));

import {
  createOnlineWatcher,
  OFFLINE_AFTER_FAILURES,
  PROBE_ACTIVE_MS,
  PROBE_IDLE_MS,
  PROBE_TIMEOUT_MS,
  type OnlineWatcher,
  type OnlineWatcherParams,
} from './online';

/**
 * Every watcher goes through here so `afterEach` can stop it. A watcher owns `window` and
 * `document` listeners, so one left running by a failed assertion answers the *next* test's
 * events too — which turns a single red test into a cascade that reads like a real bug.
 */
const running: OnlineWatcher[] = [];
function watch(params?: OnlineWatcherParams): OnlineWatcher {
  const watcher = createOnlineWatcher(params);
  running.push(watcher);
  return watcher;
}

/** jsdom puts these on the prototype; an own property shadows one and deletes clean. */
function stubNavigatorOnLine(value: boolean): void {
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => value });
}

function stubVisibility(value: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => value });
}

/** A probe that is accepted and never answered — the venue-Wi-Fi failure this module exists for. */
const hang = (): Promise<never> => new Promise<never>(() => {});

describe('online watcher', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    request.mockReset().mockResolvedValue('0x279f');
  });

  afterEach(() => {
    for (const watcher of running.splice(0)) watcher.stop();
    Reflect.deleteProperty(window.navigator, 'onLine');
    Reflect.deleteProperty(document, 'visibilityState');
    vi.useRealTimers();
  });

  describe('the RPC health probe', () => {
    it('asks for eth_chainId and nothing more expensive', async () => {
      const watcher = watch();
      await vi.advanceTimersByTimeAsync(PROBE_IDLE_MS);
      expect(request).toHaveBeenCalledTimes(1);
      expect(request.mock.calls[0]?.[0]).toEqual({ method: 'eth_chainId' });
      // No per-call options: the fallback transport drops them, so passing any would be a lie
      // told to the next reader of this file.
      expect(request.mock.calls[0]?.[1]).toBeUndefined();
      watcher.stop();
    });

    it('stays online after a single failure and goes offline on the second in a row', async () => {
      const watcher = watch();
      const seen: boolean[] = [];
      watcher.subscribe((online) => seen.push(online));

      request.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      await vi.advanceTimersByTimeAsync(PROBE_IDLE_MS);
      // One miss is a dropped packet, not a dead venue. The badge must not blink on it.
      expect(watcher.online()).toBe(true);
      expect(seen).toEqual([]);

      request.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      await vi.advanceTimersByTimeAsync(PROBE_IDLE_MS);
      expect(watcher.online()).toBe(false);

      await vi.advanceTimersByTimeAsync(PROBE_IDLE_MS);
      expect(watcher.online()).toBe(true);
      expect(seen).toEqual([false, true]);
      watcher.stop();
    });

    it('needs the failures consecutive, not merely frequent', async () => {
      const watcher = watch();
      for (let i = 0; i < 3; i += 1) {
        request.mockRejectedValueOnce(new Error('flaky'));
        await vi.advanceTimersByTimeAsync(PROBE_IDLE_MS);
        await vi.advanceTimersByTimeAsync(PROBE_IDLE_MS);
      }
      expect(request).toHaveBeenCalledTimes(6);
      expect(watcher.online()).toBe(true);
      watcher.stop();
    });

    it('counts a probe that never answers as a failure once the deadline expires', async () => {
      request.mockReturnValue(hang());
      const watcher = watch();

      await vi.advanceTimersByTimeAsync(PROBE_IDLE_MS + PROBE_TIMEOUT_MS);
      expect(request).toHaveBeenCalledTimes(1);
      expect(watcher.online()).toBe(true);
      watcher.stop();
    });

    it('never opens a second request while the first is still out, and counts that tick as a failure', async () => {
      // Nothing downstream can be aborted — the fallback transport drops the `signal` — so an
      // abandoned probe can live 48 s against a hung endpoint. Opening one per tick would put
      // ten dead sockets in flight and starve the snapshot reads of the browser's six per host.
      request.mockReturnValue(hang());
      const watcher = watch();

      await vi.advanceTimersByTimeAsync(PROBE_IDLE_MS + PROBE_TIMEOUT_MS);
      expect(watcher.online()).toBe(true);

      await vi.advanceTimersByTimeAsync(PROBE_IDLE_MS);
      // Offline on schedule, with exactly one socket ever outstanding.
      expect(watcher.online()).toBe(false);
      expect(request).toHaveBeenCalledTimes(1);
      watcher.stop();
    });

    it('opens a fresh request once the hung one finally answers', async () => {
      let answer: ((value: unknown) => void) | undefined;
      request.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
      const watcher = watch();

      await vi.advanceTimersByTimeAsync(PROBE_IDLE_MS + PROBE_TIMEOUT_MS);
      expect(request).toHaveBeenCalledTimes(1);

      answer?.('0x279f');
      await vi.advanceTimersByTimeAsync(PROBE_IDLE_MS);
      expect(request).toHaveBeenCalledTimes(2);
      expect(watcher.online()).toBe(true);
      watcher.stop();
    });

    it('takes two failures, whatever OFFLINE_AFTER_FAILURES says it takes', () => {
      expect(OFFLINE_AFTER_FAILURES).toBe(2);
    });
  });

  describe('cadence', () => {
    it('probes every 30 s while no tap is pending', async () => {
      const watcher = watch();
      await vi.advanceTimersByTimeAsync(PROBE_IDLE_MS - 1);
      expect(request).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(request).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(PROBE_IDLE_MS);
      expect(request).toHaveBeenCalledTimes(2);
      watcher.stop();
    });

    it('tightens to 5 s from the last probe, not from the hint', async () => {
      const watcher = watch();
      await vi.advanceTimersByTimeAsync(3_000);
      watcher.setTapPending(true);

      await vi.advanceTimersByTimeAsync(PROBE_ACTIVE_MS - 3_000 - 1);
      expect(request).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(request).toHaveBeenCalledTimes(1);
      watcher.stop();
    });

    it('fires at once when the tap arrives and the probe is already overdue', async () => {
      const watcher = watch();
      await vi.advanceTimersByTimeAsync(20_000);
      expect(request).not.toHaveBeenCalled();

      watcher.setTapPending(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(request).toHaveBeenCalledTimes(1);
      watcher.stop();
    });

    it('lets the armed probe fire before the idle rhythm resumes', async () => {
      const watcher = watch();
      watcher.setTapPending(true);
      await vi.advanceTimersByTimeAsync(PROBE_ACTIVE_MS);
      expect(request).toHaveBeenCalledTimes(1);

      // Relaxing must not push out the probe already due at 10 s...
      watcher.setTapPending(false);
      await vi.advanceTimersByTimeAsync(PROBE_ACTIVE_MS);
      expect(request).toHaveBeenCalledTimes(2);

      // ...and the 30 s rhythm then runs from that probe.
      await vi.advanceTimersByTimeAsync(PROBE_IDLE_MS - 1);
      expect(request).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(request).toHaveBeenCalledTimes(3);
      watcher.stop();
    });

    it('does not restart the clock when the hint repeats the value it already holds', async () => {
      const watcher = watch();
      watcher.setTapPending(true);
      await vi.advanceTimersByTimeAsync(PROBE_ACTIVE_MS - 1);
      watcher.setTapPending(true);
      await vi.advanceTimersByTimeAsync(1);
      expect(request).toHaveBeenCalledTimes(1);
      watcher.stop();
    });

    it('holds the 5 s rhythm through 200 s of a gate toggling the hint on every tap', async () => {
      // The regression. The machine calls `setTapPending(true)` on `onSent` and `false` on the
      // verdict, so a moving queue flips it constantly — and a handler that restarted the
      // interval on each flip measured **zero** probes across this exact stretch: the gate went
      // blind for as long as people kept tapping, which is when it can least afford to.
      const at: number[] = [];
      request.mockImplementation(() => {
        at.push(Date.now());
        return Promise.resolve('0x279f');
      });

      const watcher = watch();
      for (let tap = 0; tap < 50; tap += 1) {
        watcher.setTapPending(true);
        await vi.advanceTimersByTimeAsync(1_500);
        watcher.setTapPending(false);
        await vi.advanceTimersByTimeAsync(2_500);
      }

      expect(at.length).toBeGreaterThanOrEqual(38);
      const gaps = at.slice(1).map((time, i) => time - (at[i] ?? 0));
      expect(Math.max(...gaps)).toBeLessThanOrEqual(PROBE_ACTIVE_MS);
      watcher.stop();
    });
  });

  describe('navigator.onLine', () => {
    it('goes offline on the browser event without waiting for a probe', () => {
      const watcher = watch();
      const seen: boolean[] = [];
      watcher.subscribe((online) => seen.push(online));

      window.dispatchEvent(new Event('offline'));
      expect(watcher.online()).toBe(false);
      expect(request).not.toHaveBeenCalled();

      window.dispatchEvent(new Event('online'));
      expect(watcher.online()).toBe(true);
      expect(seen).toEqual([false, true]);
      watcher.stop();
    });

    it('starts offline when the radio is already down', () => {
      stubNavigatorOnLine(false);
      const watcher = watch();
      expect(watcher.online()).toBe(false);
      watcher.stop();
    });

    it('does not let the radio coming back overrule an RPC that is still dead', async () => {
      request.mockRejectedValue(new Error('ECONNREFUSED'));
      const watcher = watch();
      await vi.advanceTimersByTimeAsync(PROBE_IDLE_MS * OFFLINE_AFTER_FAILURES);
      expect(watcher.online()).toBe(false);

      window.dispatchEvent(new Event('online'));
      expect(watcher.online()).toBe(false);
      watcher.stop();
    });

    it('probes immediately when the radio returns, instead of sitting out the interval', async () => {
      request.mockRejectedValue(new Error('ECONNREFUSED'));
      const watcher = watch();
      await vi.advanceTimersByTimeAsync(PROBE_IDLE_MS * OFFLINE_AFTER_FAILURES);
      expect(watcher.online()).toBe(false);
      expect(request).toHaveBeenCalledTimes(2);

      request.mockReset().mockResolvedValue('0x279f');
      window.dispatchEvent(new Event('online'));
      await vi.advanceTimersByTimeAsync(1);
      expect(request).toHaveBeenCalledTimes(1);
      expect(watcher.online()).toBe(true);
      watcher.stop();
    });
  });

  describe('visibility', () => {
    it('probes as soon as the screen comes back', async () => {
      // Android throttles background timers to once a minute and then freezes them, so the
      // cadence is a promise the OS keeps only while the screen is on.
      const watcher = watch();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(request).not.toHaveBeenCalled();

      stubVisibility('visible');
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(0);
      expect(request).toHaveBeenCalledTimes(1);
      watcher.stop();
    });

    it('ignores the event when the screen is going the other way', async () => {
      const watcher = watch();
      stubVisibility('hidden');
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(0);
      expect(request).not.toHaveBeenCalled();
      watcher.stop();
    });

    it('restarts the 30 s rhythm from the probe the screen triggered', async () => {
      const watcher = watch();
      await vi.advanceTimersByTimeAsync(10_000);
      stubVisibility('visible');
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(0);
      expect(request).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(PROBE_IDLE_MS - 1);
      expect(request).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(request).toHaveBeenCalledTimes(2);
      watcher.stop();
    });
  });

  describe('subscription and stop', () => {
    it('publishes only changes, so a badge can bind straight to it', async () => {
      const watcher = watch();
      const seen: boolean[] = [];
      watcher.subscribe((online) => seen.push(online));
      await vi.advanceTimersByTimeAsync(PROBE_IDLE_MS * 3);
      expect(request).toHaveBeenCalledTimes(3);
      expect(seen).toEqual([]);
      watcher.stop();
    });

    it('stops delivering to an unsubscribed listener but keeps the state current', () => {
      const watcher = watch();
      const seen: boolean[] = [];
      const unsubscribe = watcher.subscribe((online) => seen.push(online));
      unsubscribe();
      window.dispatchEvent(new Event('offline'));
      expect(seen).toEqual([]);
      expect(watcher.online()).toBe(false);
      watcher.stop();
    });

    it('clears the cadence timer and every window listener on stop', async () => {
      const watcher = watch();
      const seen: boolean[] = [];
      watcher.subscribe((online) => seen.push(online));

      watcher.stop();
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(PROBE_IDLE_MS * 3);
      expect(request).not.toHaveBeenCalled();

      window.dispatchEvent(new Event('offline'));
      stubVisibility('visible');
      document.dispatchEvent(new Event('visibilitychange'));
      expect(seen).toEqual([]);
      expect(watcher.online()).toBe(true);
    });

    it('clears an in-flight probe deadline too, not just the cadence timer', async () => {
      request.mockReturnValue(hang());
      const watcher = watch();
      await vi.advanceTimersByTimeAsync(PROBE_IDLE_MS);
      // Cadence timer plus the 2 s deadline of the probe now on the wire.
      expect(vi.getTimerCount()).toBeGreaterThan(1);

      watcher.stop();
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});
