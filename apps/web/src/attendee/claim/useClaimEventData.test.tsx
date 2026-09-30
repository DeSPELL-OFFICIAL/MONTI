import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Hex } from 'viem';

// Only the two transports are mocked: the indexer POST and the chain reads. Every assertion is
// about which answer the hook shapes and hands back, never about how either one travels.
const gql = vi.fn();
vi.mock('../../shared/envio/client', () => ({ gql }));

const ACCOUNT = `0x${'ab'.repeat(20)}` as Hex;

const eventMeta = vi.fn();
const eventStatus = vi.fn(async () => 1); // Published
const tiers = vi.fn();
const balanceOfEvent = vi.fn(async () => 0n);
vi.mock('../../shared/chain/reads', () => ({
  readTicket: () => ({ eventMeta, eventStatus, tiers, balanceOfEvent }),
}));

// A signed-in wallet, so the held-count chain read is enabled in the direct path.
vi.mock('../../shared/session', () => ({ useSession: () => ({ status: 'signedIn', account: ACCOUNT }) }));

const { useClaimEventData } = await import('./useClaimEventData');

/** One event's chain metadata, shaped like `EventMetaStruct` — only the fields the hook reads. */
const META = {
  orgId: 9n,
  imageCid: 'cid',
  startsAt: 100n,
  endsAt: 200n,
  saleStart: 50n,
  saleEnd: 150n,
  transferable: true,
  transferCutoffSeconds: 0,
  maxTransfers: 0,
  category: 1,
  regionCode: `0x${'00'.repeat(32)}` as Hex,
  requireKyc: false,
  approvalRequired: false,
};
/** One ticket kind on chain, shaped like `TierStruct`. */
const CHAIN_TIER = {
  name: '체인일반', priceUsdCents: 0n, supply: 100, minted: 1, maxPerWallet: 2, seated: false,
};

/** One client per render, so a cached answer never leaks from one assertion into the next. */
function wrap() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

beforeEach(() => {
  gql.mockReset().mockResolvedValue({ Event: [], Tier: [] });
  eventMeta.mockReset().mockResolvedValue(META);
  eventStatus.mockReset().mockResolvedValue(1);
  tiers.mockReset().mockResolvedValue([CHAIN_TIER]);
  balanceOfEvent.mockReset().mockResolvedValue(0n);
});

describe('useClaimEventData', () => {
  it('uses the indexer event and never touches the chain when the row is present', async () => {
    gql.mockResolvedValue({
      Event: [{ id: '5', orgId: '9', status: 'Published', requireKyc: false }],
      Tier: [{ id: '5-0', eventId: '5', idx: 0, name: '색인일반', supply: '100', minted: '1', maxPerWallet: '2', seated: false }],
    });
    const { result } = renderHook(() => useClaimEventData('5'), { wrapper: wrap() });
    await waitFor(() => expect(result.current.source).toBe('indexer'));
    expect(result.current.event?.status).toBe('Published');
    expect(result.current.tiers[0]?.name).toBe('색인일반');
    // The indexer answered, so the chain fallback query is never enabled.
    expect(eventMeta).not.toHaveBeenCalled();
  });

  it('shapes a Published event from the chain when the indexer has no row', async () => {
    gql.mockResolvedValue({ Event: [], Tier: [] });
    eventStatus.mockResolvedValue(1); // Published
    const { result } = renderHook(() => useClaimEventData('5'), { wrapper: wrap() });
    await waitFor(() => expect(result.current.source).toBe('direct'));
    expect(result.current.event?.status).toBe('Published');
    expect(result.current.event?.id).toBe('5');
    expect(result.current.tiers).toHaveLength(1);
    expect(result.current.tiers[0]?.name).toBe('체인일반');
    expect(result.current.tiers[0]?.maxPerWallet).toBe('2');
  });

  it('reads the held count from the chain balance in the direct path', async () => {
    gql.mockResolvedValue({ Event: [], Tier: [] });
    balanceOfEvent.mockResolvedValue(2n);
    const { result } = renderHook(() => useClaimEventData('5'), { wrapper: wrap() });
    await waitFor(() => expect(result.current.chainHeld).toBe(2));
    expect(balanceOfEvent).toHaveBeenCalledWith(ACCOUNT, 5n);
  });

  it('is "none" when neither the indexer nor the chain has the event', async () => {
    gql.mockResolvedValue({ Event: [], Tier: [] });
    eventMeta.mockResolvedValue({ ...META, orgId: 0n }); // no such event
    const { result } = renderHook(() => useClaimEventData('5'), { wrapper: wrap() });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.source).toBe('none');
    expect(result.current.event).toBeUndefined();
  });
});
