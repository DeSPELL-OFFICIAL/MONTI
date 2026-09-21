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
} from './online';

/** jsdom puts `onLine` on `Navigator.prototype`; an own property shadows it and deletes clean. */
function stubNavigatorOnLine(value: boolean): void {
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => value });
}

describe('online watcher', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    request.mockReset().mockResolvedValue('0x279f');
  });

  afterEach(() => {
    Reflect.deleteProperty(window.navigator, 'onLine');
    vi.useRealTimers();
  });

  describe('the RPC health probe', () => {
    it('asks for eth_chainId and nothing more expensive', async () => {
      const watcher = createOnlineWatcher();
      await vi.advanceTimersByTimeAsync(PROBE_IDLE_MS);
      expect(request).toHaveBeenCalledTimes(1);
      expect(request.mock.calls[0]?.[0]).toEqual({ method: 'eth_chainId' });
      watcher.stop();
    });

    it('stays online after a single failure and goes offline on the second in a row', async () => {
      const watcher = createOnlineWatcher();
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
      const watcher = createOnlineWatcher();
      for (let i = 0; i < 3; i += 1) {
        request.mockRejectedValueOnce(new Error('flaky'));
        await vi.advanceTimersByTimeAsync(PROBE_IDLE_MS);
        await vi.advanceTimersByTimeAsync(PROBE_IDLE_MS);
      }
      expect(request).toHaveBeenCalledTimes(6);
      expect(watcher.online()).toBe(true);
      watcher.stop();
    });

    it('counts a probe that never answers as a failure once the timeout expires', async () => {
      // A hung socket is the venue-Wi-Fi failure mode: the request is accepted and never
      // answered, so without a deadline of our own the watcher would report online forever.
      request.mockReturnValue(new Promise<never>(() => {}));
      const watcher = createOnlineWatcher();

      await vi.advanceTimersByTimeAsync(PROBE_IDLE_MS + PROBE_TIMEOUT_MS);
      expect(request).toHaveBeenCalledTimes(1);
      expect(watcher.online()).toBe(true);

      await vi.advanceTimersByTimeAsync(PROBE_IDLE_MS);
      expect(request).toHaveBeenCalledTimes(2);
      expect(watcher.online()).toBe(false);
      watcher.stop();
    });

    it('takes two failures, whatever OFFLINE_AFTER_FAILURES says it takes', () => {
      expect(OFFLINE_AFTER_FAILURES).toBe(2);
    });
  });

  describe('cadence', () => {
    it('probes every 30 s while no tap is pending', async () => {
      const watcher = createOnlineWatcher();
      await vi.advanceTimersByTimeAsync(PROBE_IDLE_MS - 1);
      expect(request).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(request).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(PROBE_IDLE_MS);
      expect(request).toHaveBeenCalledTimes(2);
      watcher.stop();
    });

    it('tightens to 5 s the moment a tap goes pending, without waiting out the idle interval', async () => {
      const watcher = createOnlineWatcher();
      await vi.advanceTimersByTimeAsync(20_000);
      expect(request).not.toHaveBeenCalled();

      watcher.setTapPending(true);
      await vi.advanceTimersByTimeAsync(PROBE_ACTIVE_MS);
      expect(request).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(PROBE_ACTIVE_MS);
      expect(request).toHaveBeenCalledTimes(2);
      watcher.stop();
    });

    it('relaxes back to 30 s when the tap settles', async () => {
      const watcher = createOnlineWatcher();
      watcher.setTapPending(true);
      await vi.advanceTimersByTimeAsync(PROBE_ACTIVE_MS);
      expect(request).toHaveBeenCalledTimes(1);

      watcher.setTapPending(false);
      await vi.advanceTimersByTimeAsync(PROBE_ACTIVE_MS);
      expect(request).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(PROBE_IDLE_MS - PROBE_ACTIVE_MS);
      expect(request).toHaveBeenCalledTimes(2);
      watcher.stop();
    });

    it('does not restart the clock when the hint repeats the value it already holds', async () => {
      // The machine calls this per tap. If every call rescheduled, a busy gate would push the
      // probe past its own deadline forever and never notice the chain had gone away.
      const watcher = createOnlineWatcher();
      watcher.setTapPending(true);
      await vi.advanceTimersByTimeAsync(PROBE_ACTIVE_MS - 1);
      watcher.setTapPending(true);
      await vi.advanceTimersByTimeAsync(1);
      expect(request).toHaveBeenCalledTimes(1);
      watcher.stop();
    });
  });

  describe('navigator.onLine', () => {
    it('goes offline on the browser event without waiting for a probe', () => {
      const watcher = createOnlineWatcher();
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
      const watcher = createOnlineWatcher();
      expect(watcher.online()).toBe(false);
      watcher.stop();
    });

    it('does not let the radio coming back overrule an RPC that is still dead', async () => {
      request.mockRejectedValue(new Error('ECONNREFUSED'));
      const watcher = createOnlineWatcher();
      await vi.advanceTimersByTimeAsync(PROBE_IDLE_MS * OFFLINE_AFTER_FAILURES);
      expect(watcher.online()).toBe(false);

      window.dispatchEvent(new Event('online'));
      expect(watcher.online()).toBe(false);
      watcher.stop();
    });

    it('probes immediately when the radio returns, instead of sitting out the interval', async () => {
      request.mockRejectedValue(new Error('ECONNREFUSED'));
      const watcher = createOnlineWatcher();
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

  describe('subscription and stop', () => {
    it('publishes only changes, so a badge can bind straight to it', async () => {
      const watcher = createOnlineWatcher();
      const seen: boolean[] = [];
      watcher.subscribe((online) => seen.push(online));
      await vi.advanceTimersByTimeAsync(PROBE_IDLE_MS * 3);
      expect(request).toHaveBeenCalledTimes(3);
      expect(seen).toEqual([]);
      watcher.stop();
    });

    it('stops delivering to an unsubscribed listener but keeps the state current', () => {
      const watcher = createOnlineWatcher();
      const seen: boolean[] = [];
      const unsubscribe = watcher.subscribe((online) => seen.push(online));
      unsubscribe();
      window.dispatchEvent(new Event('offline'));
      expect(seen).toEqual([]);
      expect(watcher.online()).toBe(false);
      watcher.stop();
    });

    it('clears its timer and its window listeners on stop', async () => {
      const watcher = createOnlineWatcher();
      const seen: boolean[] = [];
      watcher.subscribe((online) => seen.push(online));

      watcher.stop();
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(PROBE_IDLE_MS * 3);
      expect(request).not.toHaveBeenCalled();

      window.dispatchEvent(new Event('offline'));
      expect(seen).toEqual([]);
      expect(watcher.online()).toBe(true);
    });
  });
});
