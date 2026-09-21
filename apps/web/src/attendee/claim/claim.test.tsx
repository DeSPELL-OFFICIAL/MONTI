import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearSession, setSession } from '../../shared/session';

// The op layer is mocked, but its real OpReverted class is kept: the screen tells a revert from
// a "still confirming" timeout by the sentinel reason that class carries.
const ticketOp = vi.fn();
vi.mock('../../shared/chain/ops', async (orig) => ({
  ...(await orig<typeof import('../../shared/chain/ops')>()),
  ticketOp,
}));
vi.mock('../../shared/chain/accounts', () => ({ getAttendeeAccount: async () => ({ address: `0x${'ab'.repeat(20)}` }) }));
vi.mock('react-router-dom', async (orig) => ({
  ...(await orig<typeof import('react-router-dom')>()), useParams: () => ({ eventId: '5' }), useNavigate: () => vi.fn(),
}));

const EVENT = { id: '5', orgId: '9', requireKyc: true };
const TIER = { id: '5-0', eventId: '5', idx: 0, name: '일반', supply: 100, minted: 1, maxPerWallet: 2, seated: false };
// The indexer is not deployed: one mock answers every document this screen sends, by name.
const ownedTickets: { rows: Array<Record<string, unknown>> } = { rows: [] };
const tiers: { rows: Array<Record<string, unknown>> } = { rows: [TIER] };
const gql = vi.fn(async (query: string) => {
  if (query.includes('OwnedTickets')) return { Ticket: ownedTickets.rows, Offer: [] };
  if (query.includes('TicketContext')) return { CheckIn: [], Event: [], Ticket: [] };
  if (query.includes('EventStates')) return { Event: [] };
  return { Event: [EVENT], Tier: tiers.rows };
});
vi.mock('../../shared/envio/client', () => ({ gql }));
const kycLevel = { value: 1 };
vi.mock('../me/useKycLevel', () => ({ useKycLevel: () => ({ kycLevel: kycLevel.value, isLoading: false, refetch: vi.fn() }) }));

const { Claim } = await import('./Claim');
const { OpReverted } = await import('../../shared/chain/ops');

function renderClaim() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter><Claim /></MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  kycLevel.value = 1;
  ownedTickets.rows = [];
  tiers.rows = [TIER];
  ticketOp.mockReset();
  ticketOp.mockResolvedValue({ success: true, txHash: '0x2', blockNumber: 1n });
});

afterEach(() => {
  // Unmount first: a session change with the screens still mounted is a React update
  // outside act(), which is noise rather than anything the attendee would see.
  cleanup();
  clearSession();
});

describe('Claim', () => {
  it('opens the verification sheet instead of claiming when the event requires kyc', async () => {
    kycLevel.value = 0;
    renderClaim();
    await userEvent.click(await screen.findByRole('button', { name: '티켓 받기' }));
    expect(await screen.findByText('이 행사는 본인인증이 필요해요')).toBeInTheDocument();
    expect(ticketOp).not.toHaveBeenCalled();
  });

  it('sends a sponsored claim for the selected tier with the event org id', async () => {
    renderClaim();
    await userEvent.click(await screen.findByRole('button', { name: '티켓 받기' }));
    expect(ticketOp).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: 9n, functionName: 'claim', args: [5n, 0, '0x'] }),
    );
  });

  it('reads a timed-out op as still confirming, not as a failure', async () => {
    ticketOp.mockRejectedValueOnce(new OpReverted('claim', 'TIMEOUT'));
    renderClaim();
    await userEvent.click(await screen.findByRole('button', { name: '티켓 받기' }));
    expect(await screen.findByText('아직 확인 중이에요. 잠시 뒤 내 티켓에서 확인해 주세요.')).toBeInTheDocument();
    expect(screen.queryByText('티켓을 받지 못했어요. 잠시 뒤 다시 시도해 주세요.')).not.toBeInTheDocument();
  });

  it('shows the failure sentence when the op reverts', async () => {
    ticketOp.mockRejectedValueOnce(new OpReverted('claim', '0xdeadbeef'));
    renderClaim();
    await userEvent.click(await screen.findByRole('button', { name: '티켓 받기' }));
    expect(await screen.findByText('티켓을 받지 못했어요. 잠시 뒤 다시 시도해 주세요.')).toBeInTheDocument();
  });

  it('keeps the button down while an op is still confirming, so a second tap cannot claim twice', async () => {
    ticketOp.mockRejectedValueOnce(new OpReverted('claim', 'TIMEOUT'));
    renderClaim();
    const cta = await screen.findByRole('button', { name: '티켓 받기' });
    await userEvent.click(cta);
    expect(await screen.findByText('아직 확인 중이에요. 잠시 뒤 내 티켓에서 확인해 주세요.')).toBeInTheDocument();
    expect(cta).toBeDisabled();
    await userEvent.click(cta);
    expect(ticketOp).toHaveBeenCalledTimes(1);
  });

  it('claims nothing on a tier nobody may hold, the way the contract reads maxPerWallet 0', async () => {
    tiers.rows = [{ ...TIER, maxPerWallet: 0 }];
    renderClaim();
    expect(await screen.findByText('이 행사에서 받을 수 있는 티켓을 이미 다 받았어요.')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: '티켓 받기' })).toBeDisabled();
    expect(ticketOp).not.toHaveBeenCalled();
  });

  it('blocks the button once the event-wide per-wallet limit is reached', async () => {
    const owner = `0x${'cd'.repeat(20)}`;
    setSession({ status: 'signedIn', account: owner as `0x${string}` });
    ownedTickets.rows = [
      { id: '11', eventId: '5', tier: 0, owner, transfers: 0, revoked: false },
      { id: '12', eventId: '5', tier: 0, owner, transfers: 0, revoked: false },
    ];
    renderClaim();
    expect(await screen.findByText('이 행사에서 받을 수 있는 티켓을 이미 다 받았어요.')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: '티켓 받기' })).toBeDisabled();
    expect(ticketOp).not.toHaveBeenCalled();
  });
});
