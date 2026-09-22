import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { MemoryRouter, useLocation } from 'react-router-dom';
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
// `navigate` is only read when the screen calls `useNavigate()`, well after this module is
// initialised, so the factory never touches it too early. `useSearchParams` stays real: the
// resume latch is about what it does to the address.
const navigate = vi.fn();
vi.mock('react-router-dom', async (orig) => ({
  ...(await orig<typeof import('react-router-dom')>()), useParams: () => ({ eventId: '5' }), useNavigate: () => navigate,
}));

const EVENT = { id: '5', orgId: '9', requireKyc: true };
const TIER = { id: '5-0', eventId: '5', idx: 0, name: '일반', supply: 100, minted: 1, maxPerWallet: 2, seated: false };
const TIER_TWO = { ...TIER, id: '5-1', idx: 1, name: 'VIP' };
/** The address the identity check sends back, exactly as the sheet writes it. */
const RESUME = '/claim/5?intent=claim&tier=0';
// The indexer is not deployed: one mock answers every document this screen sends, by name.
const ownedTickets: { rows: Array<Record<string, unknown>> } = { rows: [] };
const tiers: { rows: Array<Record<string, unknown>> } = { rows: [TIER] };
const event: { row: Record<string, unknown> } = { row: EVENT };
const gql = vi.fn(async (query: string) => {
  if (query.includes('OwnedTickets')) return { Ticket: ownedTickets.rows, Offer: [] };
  if (query.includes('TicketContext')) return { CheckIn: [], Event: [], Ticket: [] };
  if (query.includes('EventStates')) return { Event: [] };
  return { Event: [event.row], Tier: tiers.rows };
});
vi.mock('../../shared/envio/client', () => ({ gql }));
const kycLevel = { value: 1, loading: false };
vi.mock('../me/useKycLevel', () => ({
  useKycLevel: () => ({ kycLevel: kycLevel.value, isLoading: kycLevel.loading, refetch: vi.fn() }),
}));

const { Claim } = await import('./Claim');
const { OpReverted } = await import('../../shared/chain/ops');

/** `setSearchParams` navigates for real under MemoryRouter, so the address is read back here. */
function Address() {
  const location = useLocation();
  return <span data-testid="address">{location.pathname + location.search}</span>;
}

function claimTree(entry: string) {
  return (
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[entry]}>
        <Claim />
        <Address />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

function renderClaim(entry = '/claim/5') {
  return render(claimTree(entry));
}

beforeEach(() => {
  kycLevel.value = 1;
  kycLevel.loading = false;
  ownedTickets.rows = [];
  tiers.rows = [TIER];
  event.row = EVENT;
  navigate.mockReset();
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

  it('leaves a sold-out type unclaimable with the reason on the screen', async () => {
    tiers.rows = [{ ...TIER, supply: 100, minted: 100 }];
    renderClaim();
    expect(await screen.findByText('이 종류는 마감됐어요. 다른 종류를 골라 주세요.')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: '티켓 받기' })).toBeDisabled();
  });

  it('leaves a called-off event unclaimable with the reason on the screen', async () => {
    event.row = { ...EVENT, status: 'Cancelled' };
    renderClaim();
    expect(await screen.findByText('취소된 행사예요.')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: '티켓 받기' })).toBeDisabled();
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

/**
 * G1: before this, the sheet sent the person to the event page, which has no claim in it — so a
 * verified person came back and had to find their way through two more taps, with the type they
 * had chosen gone. The address carries both the intent and the type now.
 */
describe('Claim · resuming after the identity check', () => {
  it('sends the sheet back to this screen, carrying the chosen type', async () => {
    kycLevel.value = 0;
    tiers.rows = [TIER, TIER_TWO];
    renderClaim();
    await userEvent.selectOptions(await screen.findByLabelText('티켓 종류'), '1');
    await userEvent.click(screen.getByRole('button', { name: '티켓 받기' }));
    await userEvent.click(await screen.findByRole('button', { name: '본인인증 하기' }));
    expect(navigate).toHaveBeenCalledWith(
      `/me/verify?returnTo=${encodeURIComponent('/claim/5?intent=claim&tier=1')}`,
    );
  });

  it('hands the verification screen a returnTo that survives the round trip', async () => {
    kycLevel.value = 0;
    tiers.rows = [TIER, TIER_TWO];
    renderClaim();
    await userEvent.selectOptions(await screen.findByLabelText('티켓 종류'), '1');
    await userEvent.click(screen.getByRole('button', { name: '티켓 받기' }));
    await userEvent.click(await screen.findByRole('button', { name: '본인인증 하기' }));

    // What the verification screen reads back out of its own address when it is done.
    const [sentTo] = navigate.mock.calls[0] as [string];
    const returnTo = new URLSearchParams(sentTo.slice(sentTo.indexOf('?'))).get('returnTo');
    expect(returnTo).toBe('/claim/5?intent=claim&tier=1');
    const resumed = new URLSearchParams(returnTo!.slice(returnTo!.indexOf('?')));
    expect(resumed.get('intent')).toBe('claim');
    expect(resumed.get('tier')).toBe('1');
  });

  it('picks the type the address asks for rather than the first one', async () => {
    tiers.rows = [TIER, TIER_TWO];
    renderClaim('/claim/5?tier=1');
    expect(await screen.findByLabelText('티켓 종류')).toHaveValue('1');
  });

  it('finishes the claim by itself, and clears the address before it starts', async () => {
    renderClaim(RESUME);
    await waitFor(() => expect(ticketOp).toHaveBeenCalledTimes(1));
    expect(ticketOp).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: 9n, functionName: 'claim', args: [5n, 0, '0x'] }),
    );
    // Stripped first, so a refresh in the middle of the claim cannot start a second one.
    expect(screen.getByTestId('address')).toHaveTextContent('/claim/5');
    expect(screen.getByTestId('address').textContent).not.toContain('intent');
    expect(screen.getByTestId('address').textContent).not.toContain('tier');
  });

  it('claims once and once only, through the double effect run of StrictMode', async () => {
    render(<StrictMode>{claimTree(RESUME)}</StrictMode>);
    await waitFor(() => expect(ticketOp).toHaveBeenCalledTimes(1));
    expect(ticketOp).toHaveBeenCalledTimes(1);
  });

  it('does not claim again when the screen re-renders', async () => {
    const tree = claimTree(RESUME);
    const { rerender } = render(tree);
    await waitFor(() => expect(ticketOp).toHaveBeenCalledTimes(1));
    rerender(tree);
    rerender(tree);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ticketOp).toHaveBeenCalledTimes(1);
  });

  it('never claims while one is still on its way', async () => {
    // The first op never settles, so the screen stays busy: a second claim here is a second ticket.
    ticketOp.mockImplementation(() => new Promise(() => undefined));
    const tree = claimTree(RESUME);
    const { rerender } = render(tree);
    await waitFor(() => expect(ticketOp).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole('button', { name: '받는 중이에요' })).toBeDisabled();
    rerender(tree);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ticketOp).toHaveBeenCalledTimes(1);
  });

  it('claims nothing without the intent, however the person arrived', async () => {
    renderClaim('/claim/5?tier=0');
    expect(await screen.findByRole('button', { name: '티켓 받기' })).toBeEnabled();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ticketOp).not.toHaveBeenCalled();
  });

  it('claims nothing for somebody the check has not passed yet', async () => {
    kycLevel.value = 0;
    renderClaim(RESUME);
    await screen.findByRole('button', { name: '티켓 받기' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ticketOp).not.toHaveBeenCalled();
    // The sheet is not thrown up either: nobody tapped anything.
    expect(screen.queryByText('이 행사는 본인인증이 필요해요')).toBeNull();
  });

  it('waits for the verification level instead of reading the "still asking" zero as a no', async () => {
    kycLevel.loading = true;
    renderClaim(RESUME);
    await screen.findByRole('button', { name: '티켓 받기' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ticketOp).not.toHaveBeenCalled();
    // The address is untouched, so the claim still resumes once the answer lands.
    expect(screen.getByTestId('address').textContent).toContain('intent=claim');
  });

  it('claims nothing when this person already holds every ticket the event allows', async () => {
    tiers.rows = [{ ...TIER, maxPerWallet: 0 }];
    renderClaim(RESUME);
    expect(await screen.findByText('이 행사에서 받을 수 있는 티켓을 이미 다 받았어요.')).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ticketOp).not.toHaveBeenCalled();
  });

  it('claims nothing when the type sold out while the person was verifying', async () => {
    tiers.rows = [{ ...TIER, supply: 100, minted: 100 }];
    renderClaim(RESUME);
    expect(await screen.findByText('이 종류는 마감됐어요. 다른 종류를 골라 주세요.')).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ticketOp).not.toHaveBeenCalled();
  });

  it('claims nothing when the event was called off while the person was verifying', async () => {
    event.row = { ...EVENT, status: 'Cancelled' };
    renderClaim(RESUME);
    expect(await screen.findByText('취소된 행사예요.')).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ticketOp).not.toHaveBeenCalled();
  });
});
