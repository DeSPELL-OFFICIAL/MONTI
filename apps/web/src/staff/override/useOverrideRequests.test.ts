import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const listOverrideRequests = vi.fn();
vi.mock('../../shared/api/functions', () => ({ api: { listOverrideRequests } }));

const { OVERRIDE_REQUESTS_POLL_MS, useOverrideRequests } = await import('./useOverrideRequests');

const ROW = {
  id: 'req-1',
  tokenId: '1042',
  gateId: '9',
  reason: 2,
  note: '배터리 없음',
  requesterAccount: `0x${'bb'.repeat(20)}`,
  createdAt: 1_700_000_000_000,
};

const nameOf = (tokenId: string): string => (tokenId === '1042' ? '김입장' : '');

/** Lets the pending callable promise and the state update that follows it run. */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  listOverrideRequests.mockReset();
  listOverrideRequests.mockResolvedValue({ requests: [ROW] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useOverrideRequests', () => {
  it('asks nothing while inactive (no dialog, or no approval right)', async () => {
    const { result } = renderHook(() => useOverrideRequests(42n, false, nameOf));
    await flush();
    expect(listOverrideRequests).not.toHaveBeenCalled();
    expect(result.current).toEqual([]);
  });

  it('lists the open requests of this event at once, named from the guest list', async () => {
    const { result } = renderHook(() => useOverrideRequests(42n, true, nameOf));
    await flush();
    expect(listOverrideRequests).toHaveBeenCalledWith({ eventId: '42' });
    expect(result.current).toEqual([
      { id: 'req-1', tokenId: '1042', gateId: '9', reason: 2, note: '배터리 없음', displayName: '김입장' },
    ]);
  });

  it('polls every few seconds while active, and stops when it is not', async () => {
    const { rerender } = renderHook(({ active }) => useOverrideRequests(42n, active, nameOf), {
      initialProps: { active: true },
    });
    await flush();
    expect(listOverrideRequests).toHaveBeenCalledTimes(1);

    listOverrideRequests.mockResolvedValue({ requests: [] });
    await act(async () => {
      vi.advanceTimersByTime(OVERRIDE_REQUESTS_POLL_MS);
    });
    await flush();
    expect(listOverrideRequests).toHaveBeenCalledTimes(2);

    rerender({ active: false });
    await act(async () => {
      vi.advanceTimersByTime(OVERRIDE_REQUESTS_POLL_MS * 3);
    });
    expect(listOverrideRequests).toHaveBeenCalledTimes(2);
  });

  it('keeps the last list when one poll fails', async () => {
    const { result } = renderHook(() => useOverrideRequests(42n, true, nameOf));
    await flush();
    expect(result.current).toHaveLength(1);

    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    listOverrideRequests.mockRejectedValueOnce(new Error('offline'));
    await act(async () => {
      vi.advanceTimersByTime(OVERRIDE_REQUESTS_POLL_MS);
    });
    await flush();
    expect(result.current).toHaveLength(1);
  });
});
