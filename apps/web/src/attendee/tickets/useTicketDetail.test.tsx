import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MyTicket } from './useTickets';

// Three seams are mocked: the indexer list the screen already reads, the session that names who
// is asking, and the chain reads. `deriveTicketState` runs for real, so this also pins the shape
// the detail screen renders from — the whole point is which source the hook trusts for one id.
const useMyTickets = vi.fn();
const useSession = vi.fn();
const ownerOf = vi.fn();
const eventOf = vi.fn();
const tierOf = vi.fn();
const checkInOf = vi.fn();
const isRevoked = vi.fn();
const eventMeta = vi.fn();
const eventStatus = vi.fn();
const tiers = vi.fn();

vi.mock('./useTickets', () => ({ useMyTickets }));
vi.mock('../../shared/session', () => ({ useSession }));
vi.mock('../../shared/chain/reads', () => ({
  EventStatus: { Draft: 0, Published: 1, Cancelled: 2, Ended: 3 },
  readTicket: () => ({ ownerOf, eventOf, tierOf, checkInOf, isRevoked, eventMeta, eventStatus, tiers }),
}));

const { useTicketDetail } = await import('./useTicketDetail');

/** One client per render, so a cached answer never leaks from one assertion into the next. */
function wrap() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

const ME = `0x${'ab'.repeat(20)}`;
const ZERO_WORD = `0x${'00'.repeat(32)}`;

/** A settled, empty indexer list — the list arrived and does not carry this id. */
function indexerEmpty() {
  return { data: [] as MyTicket[], isSuccess: true, isLoading: false, isError: false, error: null, refetch: vi.fn() };
}

beforeEach(() => {
  useSession.mockReturnValue({ account: ME });
  useMyTickets.mockReturnValue(indexerEmpty());
  ownerOf.mockReset().mockResolvedValue(ME);
  eventOf.mockReset().mockResolvedValue(5n);
  tierOf.mockReset().mockResolvedValue(1);
  checkInOf.mockReset().mockResolvedValue({ gateId: 0n, nonceHash: ZERO_WORD, ts: 0n, manual: false, late: false });
  isRevoked.mockReset().mockResolvedValue(false);
  eventMeta.mockReset().mockResolvedValue({ imageCid: 'cidA', startsAt: 1800000000n });
  eventStatus.mockReset().mockResolvedValue(1);
  tiers.mockReset().mockResolvedValue([{ name: 'GA' }, { name: 'VIP' }]);
});

describe('useTicketDetail', () => {
  it('builds the ticket from the chain when the indexer list has no row and the owner matches', async () => {
    const { result } = renderHook(() => useTicketDetail('42'), { wrapper: wrap() });
    await waitFor(() => expect(result.current.source).toBe('direct'));
    expect(ownerOf).toHaveBeenCalledWith(42n);
    expect(result.current.ticket).toEqual({
      tokenId: '42',
      eventId: '5',
      tier: 1,
      checkInTs: null,
      used: false,
      imageCid: 'cidA',
      tierName: 'VIP',
      startsAt: 1800000000,
      state: 'before',
    });
  });

  it('stays "not found" when the token is held by someone else', async () => {
    ownerOf.mockResolvedValue(`0x${'cd'.repeat(20)}`);
    const { result } = renderHook(() => useTicketDetail('42'), { wrapper: wrap() });
    await waitFor(() => expect(ownerOf).toHaveBeenCalled());
    await waitFor(() => expect(result.current.source).toBe('none'));
    expect(result.current.ticket).toBeUndefined();
  });

  it('uses the indexer row when it has one, and never asks the chain', async () => {
    const row: MyTicket = {
      tokenId: '42', eventId: '5', tier: 0, state: 'before',
      checkInTs: null, used: false, imageCid: 'cidX', tierName: 'GA', startsAt: 123,
    };
    useMyTickets.mockReturnValue({
      data: [row], isSuccess: true, isLoading: false, isError: false, error: null, refetch: vi.fn(),
    });
    const { result } = renderHook(() => useTicketDetail('42'), { wrapper: wrap() });
    await waitFor(() => expect(result.current.source).toBe('indexer'));
    expect(result.current.ticket).toBe(row);
    expect(ownerOf).not.toHaveBeenCalled();
  });
});
