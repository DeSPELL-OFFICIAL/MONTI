import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearSession, setSession } from '../session';

// Only the indexer transport is mocked; every assertion is about what the hooks send and what
// they do with the rows, never about how they travel.
const gql = vi.fn();
vi.mock('./client', () => ({ gql }));

const { useEventRequests, useMyRequest } = await import('./claimRequests');
const { EVENT_REQUESTS_QUERY, MY_REQUESTS_QUERY } = await import('./queries');

/** The session carries a checksummed address; the indexer only ever holds the lowercase one. */
const ME = `0x${'Ab'.repeat(20)}` as `0x${string}`;
const ME_LOWER = ME.toLowerCase();

function request(overrides: Record<string, unknown> = {}) {
  return {
    id: '11-1', eventId: '11', requestId: '1', requester: ME_LOWER, tier: 0,
    status: 'Pending', tokenId: null, requestedAt: '1800000000', decidedAt: null, txHash: '0xabc',
    ...overrides,
  };
}

/** One client per render, so a cached answer never leaks from one assertion into the next. */
function wrap() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

beforeEach(() => {
  setSession({ status: 'signedIn', account: ME });
  gql.mockReset();
  gql.mockResolvedValue({ ClaimRequest: [] });
});

afterEach(() => {
  clearSession();
});

describe('the request documents', () => {
  it('declares eventId as numeric and requester/status as String', () => {
    expect(MY_REQUESTS_QUERY).toContain('$eventId: numeric!');
    expect(MY_REQUESTS_QUERY).toContain('$requester: String!');
    expect(MY_REQUESTS_QUERY).not.toMatch(/\$eventId:\s*String!/);
    expect(EVENT_REQUESTS_QUERY).toContain('$eventId: numeric!');
    expect(EVENT_REQUESTS_QUERY).toContain('$status: String!');
    // The status is a variable, not baked in — the screen chooses which set it wants.
    expect(EVENT_REQUESTS_QUERY).toContain('status: { _eq: $status }');
    expect(EVENT_REQUESTS_QUERY).not.toMatch(/status:\s*\{\s*_eq:\s*"Pending"/);
  });

  it('selects only columns the indexer schema declares', () => {
    const fields = 'id eventId requestId requester tier status tokenId requestedAt decidedAt txHash';
    expect(MY_REQUESTS_QUERY).toContain(fields);
    expect(EVENT_REQUESTS_QUERY).toContain(fields);
  });

  it('reads mine newest-first and the event list oldest-first', () => {
    expect(MY_REQUESTS_QUERY).toContain('order_by: { requestedAt: desc }');
    expect(EVENT_REQUESTS_QUERY).toContain('order_by: { requestedAt: asc }');
  });
});

describe('useMyRequest', () => {
  it('asks for the lowercase address and returns the newest row', async () => {
    gql.mockResolvedValue({ ClaimRequest: [request({ requestId: '2', status: 'Approved', tokenId: '77' })] });
    const { result } = renderHook(() => useMyRequest('11'), { wrapper: wrap() });

    await waitFor(() => expect(result.current.request?.requestId).toBe('2'));
    expect(gql).toHaveBeenCalledWith(MY_REQUESTS_QUERY, { eventId: '11', requester: ME_LOWER });
    expect(result.current.request?.status).toBe('Approved');
    expect(result.current.request?.tokenId).toBe('77');
    // The guard is the point: the session address is not lowercase to begin with.
    expect(ME_LOWER).not.toBe(ME);
  });

  it('answers null when the attendee has never asked', async () => {
    const { result } = renderHook(() => useMyRequest('11'), { wrapper: wrap() });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.request).toBeNull();
  });

  it('asks the indexer nothing on behalf of a signed-out visitor', async () => {
    clearSession();
    const { result } = renderHook(() => useMyRequest('11'), { wrapper: wrap() });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.request).toBeNull();
    expect(gql).not.toHaveBeenCalled();
  });
});

describe('useEventRequests', () => {
  it('defaults to the pending set and keeps the indexer order', async () => {
    gql.mockResolvedValue({ ClaimRequest: [request({ requestId: '1' }), request({ requestId: '2' })] });
    const { result } = renderHook(() => useEventRequests('11'), { wrapper: wrap() });

    await waitFor(() => expect(result.current.requests).toHaveLength(2));
    expect(gql).toHaveBeenCalledWith(EVENT_REQUESTS_QUERY, { eventId: '11', status: 'Pending' });
    expect(result.current.requests.map((row) => row.requestId)).toEqual(['1', '2']);
  });

  it('asks for another status when told to', async () => {
    renderHook(() => useEventRequests('11', 'Approved'), { wrapper: wrap() });
    await waitFor(() =>
      expect(gql).toHaveBeenCalledWith(EVENT_REQUESTS_QUERY, { eventId: '11', status: 'Approved' }),
    );
  });

  it('asks nothing without an event to ask about', async () => {
    const { result } = renderHook(() => useEventRequests(''), { wrapper: wrap() });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(gql).not.toHaveBeenCalled();
  });
});
