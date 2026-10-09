import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EnvioTier } from '../shared/envio/queries';

// Only the chain read is mocked. The indexer's rows are passed straight in — exactly as the
// dashboard passes the rows its EVENT_QUERY already returned — so every assertion is about which
// answer the hook trusts, never about how either one travels. The TierStruct -> EnvioTier mapping
// (shared/chain/tiers) runs for real, so this also pins that shape.
const tiers = vi.fn();
vi.mock('../shared/chain/reads', () => ({ readTicket: () => ({ tiers }) }));

const { useEventTiersWithFallback } = await import('./useEventTiersWithFallback');

/** One client per render, so a cached answer never leaks from one assertion into the next. */
function wrap() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

/** A chain `Ticket.tiers` row: numeric fields are bigint/number, as viem decodes them. */
const chainTier = { name: 'GA', priceUsdCents: 3000n, supply: 100, minted: 0, maxPerWallet: 4, seated: false };
const indexerRow: EnvioTier = {
  id: 't1', eventId: '5', idx: 0, name: 'VIP', priceUsdCents: '5000',
  supply: '10', minted: '1', maxPerWallet: '2', seated: true,
};

beforeEach(() => {
  tiers.mockReset().mockResolvedValue([chainTier]);
});

describe('useEventTiersWithFallback', () => {
  it('uses the indexer rows when it has them, and never asks the chain', async () => {
    const { result } = renderHook(() => useEventTiersWithFallback('5', [indexerRow]), { wrapper: wrap() });
    await waitFor(() => expect(result.current.source).toBe('indexer'));
    expect(result.current.tiers).toEqual([indexerRow]);
    expect(tiers).not.toHaveBeenCalled();
  });

  it('reads the tiers from the chain when the indexer has no rows yet', async () => {
    const { result } = renderHook(() => useEventTiersWithFallback('5', []), { wrapper: wrap() });
    await waitFor(() => expect(result.current.source).toBe('direct'));
    expect(result.current.tiers).toEqual([
      {
        id: '5-0', eventId: '5', idx: 0, name: 'GA', priceUsdCents: '3000',
        supply: '100', minted: '0', maxPerWallet: '4', seated: false,
      },
    ]);
  });

  it('is "none" when the chain read fails', async () => {
    tiers.mockRejectedValue(new Error('rpc down'));
    const { result } = renderHook(() => useEventTiersWithFallback('5', []), { wrapper: wrap() });
    await waitFor(() => expect(tiers).toHaveBeenCalled());
    expect(result.current.source).toBe('none');
    expect(result.current.tiers).toEqual([]);
  });

  it('asks nothing while the indexer is still loading', () => {
    const { result } = renderHook(() => useEventTiersWithFallback('5', undefined), { wrapper: wrap() });
    expect(result.current.source).toBe('none');
    expect(result.current.tiers).toEqual([]);
    expect(tiers).not.toHaveBeenCalled();
  });
});
