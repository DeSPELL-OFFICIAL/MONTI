import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Only the two transports are mocked: the indexer POST and the chain reads. Every assertion is
// about which answer the hook trusts, never about how either one travels.
const gql = vi.fn();
vi.mock('../shared/envio/client', () => ({ gql }));

const eventOrg = vi.fn(async () => 9n);
const eventStatus = vi.fn(async () => 0);
vi.mock('../shared/chain/reads', () => ({ readTicket: () => ({ eventOrg, eventStatus }) }));

const { useEventStatusWithFallback, preferStatus } = await import('./useEventStatusWithFallback');

/** One client per render, so a cached answer never leaks from one assertion into the next. */
function wrap() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

beforeEach(() => {
  gql.mockReset().mockResolvedValue({ Event: [] });
  eventOrg.mockReset().mockResolvedValue(9n);
  eventStatus.mockReset().mockResolvedValue(0);
});

describe('preferStatus', () => {
  it('trusts the indexer once its row is not older than the chain', () => {
    expect(preferStatus('Published', 'Published')).toEqual({ status: 'Published', source: 'indexer' });
    expect(preferStatus('Cancelled', 'Published')).toEqual({ status: 'Cancelled', source: 'indexer' });
  });

  it('falls back to the chain when the indexer is behind or has no row', () => {
    // The chain is ahead (a publish that landed): it wins over a stale Draft row.
    expect(preferStatus('Draft', 'Published')).toEqual({ status: 'Published', source: 'direct' });
    // No indexer row at all: the chain answers.
    expect(preferStatus(null, 'Draft')).toEqual({ status: 'Draft', source: 'direct' });
  });

  it('is "none" when neither side has a usable answer', () => {
    expect(preferStatus(null, null)).toEqual({ status: '', source: 'none' });
    expect(preferStatus(undefined, '')).toEqual({ status: '', source: 'none' });
  });
});

describe('useEventStatusWithFallback', () => {
  it('uses the indexer status when it has the row', async () => {
    gql.mockResolvedValue({ Event: [{ status: 'Draft' }] });
    const { result } = renderHook(() => useEventStatusWithFallback('5'), { wrapper: wrap() });
    await waitFor(() => expect(result.current.status).toBe('Draft'));
    expect(result.current.source).toBe('indexer');
  });

  it('reads the chain status when the indexer has no row yet', async () => {
    gql.mockResolvedValue({ Event: [] });
    eventOrg.mockResolvedValue(9n);
    eventStatus.mockResolvedValue(0); // Draft
    const { result } = renderHook(() => useEventStatusWithFallback('5'), { wrapper: wrap() });
    await waitFor(() => expect(result.current.status).toBe('Draft'));
    expect(result.current.source).toBe('direct');
  });

  it('is "none" when the chain has no such event either', async () => {
    gql.mockResolvedValue({ Event: [] });
    eventOrg.mockResolvedValue(0n); // no such event
    const { result } = renderHook(() => useEventStatusWithFallback('5'), { wrapper: wrap() });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.source).toBe('none');
    expect(result.current.status).toBe('');
  });

  it('lets the chain win when it is ahead of a stale indexer row', async () => {
    gql.mockResolvedValue({ Event: [{ status: 'Draft' }] });
    eventStatus.mockResolvedValue(1); // Published on chain
    const { result } = renderHook(() => useEventStatusWithFallback('5'), { wrapper: wrap() });
    await waitFor(() => expect(result.current.status).toBe('Published'));
    expect(result.current.source).toBe('direct');
  });
});
