import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Hex } from 'viem';
import { clearSession, setSession } from '../../shared/session';
import type { RelayView } from '../../shared/api/firestore';

// The claim submission is the relayer callable now, not a sponsored op. The authorization builder
// (device-key signing + chain nonce read) is mocked to a fixed value, the callable and the relay
// doc subscription are mocked, and everything else is the real screen. `ticketOp` stays mocked for
// the one op the attendee still sends themselves — the approval-mode cancel.
const ACCOUNT = `0x${'ab'.repeat(20)}` as Hex;
const AUTH = { eventId: '5', tier: 0, account: ACCOUNT, nonce: '0', deadline: '1799999999' };
const DEVICE_SIG = `0x${'cd'.repeat(64)}` as Hex;
const buildClaimAuth = vi.fn(async () => ({ auth: AUTH, deviceSig: DEVICE_SIG }));
vi.mock('./buildClaimAuth', () => ({ buildClaimAuth }));

const relayClaim = vi.fn();
vi.mock('../../shared/api/functions', () => ({ api: { relayClaim } }));

// The relay-doc subscription: keep the callback so a test can push doc states through it.
let relayListener: ((relay: RelayView | null) => void) | null = null;
const watchRelay = vi.fn((_relayId: string, onChange: (relay: RelayView | null) => void) => {
  relayListener = onChange;
  return () => {
    relayListener = null;
  };
});
vi.mock('../../shared/api/firestore', () => ({ watchRelay }));
async function emitRelay(relay: RelayView): Promise<void> {
  await act(async () => {
    relayListener?.(relay);
  });
}

const ticketOp = vi.fn();
vi.mock('../../shared/chain/ops', async (orig) => ({
  ...(await orig<typeof import('../../shared/chain/ops')>()),
  ticketOp,
}));
vi.mock('../../shared/chain/accounts', () => ({ getAttendeeAccount: async () => ({ address: ACCOUNT }) }));
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
const requests: { rows: Array<Record<string, unknown>> } = { rows: [] };
async function answerIndexer(query: string) {
  if (query.includes('OwnedTickets')) return { Ticket: ownedTickets.rows, Offer: [] };
  // The 내 티켓 documents select tiers too, so an answer without the key is one no indexer
  // would ever give — and the ticket list reads it as an empty answer, not as a missing one.
  if (query.includes('TicketContext')) return { CheckIn: [], Event: [], Tier: [], Ticket: [] };
  if (query.includes('EventStates')) return { Event: [], Tier: [] };
  if (query.includes('MyRequests')) return { ClaimRequest: requests.rows };
  return { Event: [event.row], Tier: tiers.rows };
}
const gql = vi.fn(answerIndexer);
vi.mock('../../shared/envio/client', () => ({ gql }));
const kycLevel = { value: 1, loading: false };
vi.mock('../me/useKycLevel', () => ({
  useKycLevel: () => ({ kycLevel: kycLevel.value, isLoading: kycLevel.loading, refetch: vi.fn() }),
}));

const { Claim } = await import('./Claim');
const { MAX_WAIT_TIMEOUT_MS } = await import('../../shared/chain/sendSponsoredOp');

/** A callable rejection shaped like the frozen HttpsError: the code (and nonce) live in details. */
function callableError(code: string, extra: Record<string, unknown> = {}) {
  return Object.assign(new Error(code), { code: 'failed-precondition', details: { code, ...extra } });
}

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
  requests.rows = [];
  navigate.mockReset();
  gql.mockImplementation(answerIndexer);
  buildClaimAuth.mockClear();
  buildClaimAuth.mockResolvedValue({ auth: AUTH, deviceSig: DEVICE_SIG });
  relayClaim.mockReset();
  // The default: the relayer already saw the receipt, so the claim confirms without a wait.
  relayClaim.mockResolvedValue({ relayId: 'r1', status: 'confirmed', tokenId: '77' });
  watchRelay.mockClear();
  relayListener = null;
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
    expect(relayClaim).not.toHaveBeenCalled();
  });

  it('submits a relayed claim for the selected tier in claim mode', async () => {
    renderClaim();
    await userEvent.click(await screen.findByRole('button', { name: '티켓 받기' }));
    await waitFor(() => expect(relayClaim).toHaveBeenCalled());
    expect(buildClaimAuth).toHaveBeenCalledWith(expect.objectContaining({ eventId: '5', tier: 0, account: ACCOUNT }));
    expect(relayClaim).toHaveBeenCalledWith({ mode: 'claim', auth: AUTH, deviceSig: DEVICE_SIG });
  });

  it('confirms a claim the callable already saw land, with a real 완료 state', async () => {
    renderClaim();
    await userEvent.click(await screen.findByRole('button', { name: '티켓 받기' }));
    expect(await screen.findByText('티켓을 받았어요 · 내 티켓에 있어요')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '내 티켓 보기' })).toHaveAttribute('href', '/tickets');
    // The relayer answered `confirmed`, so no relay-doc wait was needed.
    expect(watchRelay).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalledWith('/tickets');
  });

  it('follows the relay doc to 완료 when the callable only accepts the claim', async () => {
    relayClaim.mockResolvedValue({ relayId: 'r1', status: 'sent' });
    renderClaim();
    await userEvent.click(await screen.findByRole('button', { name: '티켓 받기' }));
    await waitFor(() => expect(watchRelay).toHaveBeenCalledWith('r1', expect.any(Function), expect.any(Function)));
    await emitRelay({ status: 'confirmed', tokenId: '77' });
    expect(await screen.findByText('티켓을 받았어요 · 내 티켓에 있어요')).toBeInTheDocument();
  });

  it('reassures near the button that it is free and MONTI handles it', async () => {
    renderClaim();
    await screen.findByRole('button', { name: '티켓 받기' });
    expect(screen.getByText('무료예요 · MONTI가 대신 처리해요')).toBeInTheDocument();
  });

  it('shows the generic failure sentence when the relay fails with an unknown code', async () => {
    relayClaim.mockResolvedValue({ relayId: 'r1', status: 'sent' });
    renderClaim();
    await userEvent.click(await screen.findByRole('button', { name: '티켓 받기' }));
    await waitFor(() => expect(watchRelay).toHaveBeenCalled());
    await emitRelay({ status: 'failed', error: { code: 'INTERNAL', message: 'boom' } });
    expect(await screen.findByText('티켓을 받지 못했어요. 잠시 뒤 다시 시도해 주세요.')).toBeInTheDocument();
  });

  it('maps a known relay failure code to its own sentence', async () => {
    relayClaim.mockResolvedValue({ relayId: 'r1', status: 'sent' });
    renderClaim();
    await userEvent.click(await screen.findByRole('button', { name: '티켓 받기' }));
    await waitFor(() => expect(watchRelay).toHaveBeenCalled());
    await emitRelay({ status: 'failed', error: { code: 'SOLD_OUT', message: 'gone' } });
    expect(await screen.findByText('이 종류는 마감됐어요. 다른 종류를 골라 주세요.')).toBeInTheDocument();
  });

  it('rebuilds with the current nonce and retries once on BAD_NONCE', async () => {
    relayClaim
      .mockRejectedValueOnce(callableError('BAD_NONCE', { nonce: '7' }))
      .mockResolvedValueOnce({ relayId: 'r2', status: 'confirmed', tokenId: '78' });
    renderClaim();
    await userEvent.click(await screen.findByRole('button', { name: '티켓 받기' }));
    expect(await screen.findByText('티켓을 받았어요 · 내 티켓에 있어요')).toBeInTheDocument();
    expect(relayClaim).toHaveBeenCalledTimes(2);
    // The rebuild carried the nonce the server reported, and only one retry ever fires.
    expect(buildClaimAuth).toHaveBeenLastCalledWith(expect.objectContaining({ nonce: 7n }));
  });

  it('keeps the button down while a claim is still confirming, so a second tap cannot claim twice', async () => {
    relayClaim.mockResolvedValue({ relayId: 'r1', status: 'sent' });
    renderClaim();
    const cta = await screen.findByRole('button', { name: '티켓 받기' });
    await userEvent.click(cta);
    const busy = await screen.findByRole('button', { name: '받는 중이에요' });
    expect(busy).toBeDisabled();
    await userEvent.click(busy);
    expect(relayClaim).toHaveBeenCalledTimes(1);
  });

  /**
   * The swap T-UX-8 made on this screen. The event read failing is not "문제가 생겼어요": the
   * indexer said which way it failed, and the sentence says the same thing back.
   */
  it('names the cause when the event cannot be read', async () => {
    gql.mockImplementation(async (query: string) => {
      if (query.includes('OwnedTickets')) return { Ticket: [], Offer: [] };
      if (query.includes('TicketContext')) return { CheckIn: [], Event: [], Tier: [], Ticket: [] };
      if (query.includes('EventStates')) return { Event: [], Tier: [] };
      // Shaped, not constructed: `shared/envio/client` is mocked above, so the class is gone
      // and `describeFailure` has only `name` and `kind` to read — which is the design.
      throw Object.assign(new Error('REQUEST_FAILED'), { name: 'EnvioError', kind: 'network' });
    });
    renderClaim();
    expect(await screen.findByRole('alert')).toHaveTextContent('정보를 가져오지 못했어요. 잠시 뒤 다시 시도해 주세요.');
    expect(screen.getByRole('button', { name: '다시 시도' })).toBeInTheDocument();
  });

  it('claims nothing on a tier nobody may hold, the way the contract reads maxPerWallet 0', async () => {
    tiers.rows = [{ ...TIER, maxPerWallet: 0 }];
    renderClaim();
    expect(await screen.findByText('이 행사에서 받을 수 있는 티켓을 이미 다 받았어요.')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: '티켓 받기' })).toBeDisabled();
    expect(relayClaim).not.toHaveBeenCalled();
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

  it('blocks the button and points at 내 티켓 once the per-wallet limit is reached', async () => {
    const owner = `0x${'cd'.repeat(20)}`;
    setSession({ status: 'signedIn', account: owner as `0x${string}` });
    ownedTickets.rows = [
      { id: '11', eventId: '5', tier: 0, owner, transfers: 0, revoked: false },
      { id: '12', eventId: '5', tier: 0, owner, transfers: 0, revoked: false },
    ];
    renderClaim();
    // held (2) >= maxPerWallet (2): the pre-block fires before a 받기 the chain would only revert.
    expect(await screen.findByText('이미 받았어요 · 내 티켓에서 확인하세요')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '내 티켓 보기' })).toHaveAttribute('href', '/tickets');
    expect(await screen.findByRole('button', { name: '티켓 받기' })).toBeDisabled();
    expect(relayClaim).not.toHaveBeenCalled();
  });

  it('keeps the claim button enabled while still under the per-wallet limit', async () => {
    const owner = `0x${'cd'.repeat(20)}`;
    setSession({ status: 'signedIn', account: owner as `0x${string}` });
    // One held, maxPerWallet 2: under the cap, so no pre-block and the button still acts.
    ownedTickets.rows = [{ id: '11', eventId: '5', tier: 0, owner, transfers: 0, revoked: false }];
    renderClaim();
    expect(await screen.findByRole('button', { name: '티켓 받기' })).toBeEnabled();
    expect(screen.queryByText('이미 받았어요 · 내 티켓에서 확인하세요')).toBeNull();
  });

  /**
   * Cold load, first paint after login: the held-ticket count has not answered yet, so `held`
   * still reads 0. The button must not let a fast tap through before the count lands — it would
   * only send a claim the chain reverts (live check e). It waits, disabled, showing 확인 중….
   */
  it('holds the claim button disabled with 확인 중 until the held-ticket count resolves', async () => {
    const owner = `0x${'cd'.repeat(20)}`;
    setSession({ status: 'signedIn', account: owner as `0x${string}` });
    let releaseHeld: () => void = () => undefined;
    const heldGate = new Promise<void>((resolve) => {
      releaseHeld = resolve;
    });
    gql.mockImplementation(async (query: string) => {
      if (query.includes('OwnedTickets')) {
        await heldGate;
        return { Ticket: [], Offer: [] };
      }
      return answerIndexer(query);
    });
    renderClaim();
    // Event loaded, count still in flight: the primary button reads 확인 중… and cannot be tapped.
    const waiting = await screen.findByRole('button', { name: '확인 중…' });
    expect(waiting).toBeDisabled();
    releaseHeld();
    // Count landed below the cap: the button becomes the real 받기 and acts again.
    expect(await screen.findByRole('button', { name: '티켓 받기' })).toBeEnabled();
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
    await waitFor(() => expect(relayClaim).toHaveBeenCalledTimes(1));
    expect(relayClaim).toHaveBeenCalledWith({ mode: 'claim', auth: AUTH, deviceSig: DEVICE_SIG });
    // Stripped first, so a refresh in the middle of the claim cannot start a second one.
    await waitFor(() => expect(screen.getByTestId('address')).toHaveTextContent('/claim/5'));
    expect(screen.getByTestId('address').textContent).not.toContain('intent');
    expect(screen.getByTestId('address').textContent).not.toContain('tier');
  });

  it('claims once and once only, through the double effect run of StrictMode', async () => {
    render(<StrictMode>{claimTree(RESUME)}</StrictMode>);
    await waitFor(() => expect(relayClaim).toHaveBeenCalledTimes(1));
    expect(relayClaim).toHaveBeenCalledTimes(1);
  });

  it('does not claim again when the screen re-renders', async () => {
    const tree = claimTree(RESUME);
    const { rerender } = render(tree);
    await waitFor(() => expect(relayClaim).toHaveBeenCalledTimes(1));
    rerender(tree);
    rerender(tree);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(relayClaim).toHaveBeenCalledTimes(1);
  });

  it('never claims while one is still on its way', async () => {
    // The first submission never settles, so the screen stays busy: a second claim here is a second ticket.
    relayClaim.mockImplementation(() => new Promise(() => undefined));
    const tree = claimTree(RESUME);
    const { rerender } = render(tree);
    await waitFor(() => expect(relayClaim).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole('button', { name: '받는 중이에요' })).toBeDisabled();
    rerender(tree);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(relayClaim).toHaveBeenCalledTimes(1);
  });

  it('claims nothing without the intent, however the person arrived', async () => {
    renderClaim('/claim/5?tier=0');
    expect(await screen.findByRole('button', { name: '티켓 받기' })).toBeEnabled();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(relayClaim).not.toHaveBeenCalled();
  });

  it('claims nothing for somebody the check has not passed yet', async () => {
    kycLevel.value = 0;
    renderClaim(RESUME);
    await screen.findByRole('button', { name: '티켓 받기' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(relayClaim).not.toHaveBeenCalled();
    // The sheet is not thrown up either: nobody tapped anything.
    expect(screen.queryByText('이 행사는 본인인증이 필요해요')).toBeNull();
  });

  it('waits for the verification level instead of reading the "still asking" zero as a no', async () => {
    kycLevel.loading = true;
    renderClaim(RESUME);
    await screen.findByRole('button', { name: '티켓 받기' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(relayClaim).not.toHaveBeenCalled();
    // The address is untouched, so the claim still resumes once the answer lands.
    expect(screen.getByTestId('address').textContent).toContain('intent=claim');
  });

  it('claims nothing when this person already holds every ticket the event allows', async () => {
    tiers.rows = [{ ...TIER, maxPerWallet: 0 }];
    renderClaim(RESUME);
    expect(await screen.findByText('이 행사에서 받을 수 있는 티켓을 이미 다 받았어요.')).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(relayClaim).not.toHaveBeenCalled();
  });

  it('claims nothing when the type sold out while the person was verifying', async () => {
    tiers.rows = [{ ...TIER, supply: 100, minted: 100 }];
    renderClaim(RESUME);
    expect(await screen.findByText('이 종류는 마감됐어요. 다른 종류를 골라 주세요.')).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(relayClaim).not.toHaveBeenCalled();
  });

  it('claims nothing when the event was called off while the person was verifying', async () => {
    event.row = { ...EVENT, status: 'Cancelled' };
    renderClaim(RESUME);
    expect(await screen.findByText('취소된 행사예요.')).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(relayClaim).not.toHaveBeenCalled();
  });
});

describe('Claim · approval mode', () => {
  const ME = `0x${'cd'.repeat(20)}` as `0x${string}`;
  const REQUEST = {
    id: '5-3', eventId: '5', requestId: '3', requester: ME.toLowerCase(),
    tier: 0, status: 'Pending', tokenId: null, requestedAt: '1', decidedAt: null, txHash: '0x1',
  };

  beforeEach(() => {
    // useMyRequest asks the indexer for the signed-in address; approval mode is the event's flag.
    setSession({ status: 'signedIn', account: ME });
    event.row = { ...EVENT, requireKyc: false, approvalRequired: true };
  });

  it('asks with request mode instead of claiming, and stays to show the request', async () => {
    // The request lands (confirmed) but the indexer row has not surfaced yet: 접수 · 확인 중.
    renderClaim();
    await userEvent.click(await screen.findByRole('button', { name: '신청하기' }));
    await waitFor(() => expect(relayClaim).toHaveBeenCalled());
    expect(relayClaim).toHaveBeenCalledWith({ mode: 'request', auth: AUTH, deviceSig: DEVICE_SIG });
    // The request landed but its row has not surfaced yet: a reassuring 접수 · 확인 중, not nothing.
    expect(await screen.findByText('신청을 접수했어요 · 확인 중')).toBeInTheDocument();
    // A request is not a claim: approval decides the ticket later, so it never leaves for /tickets.
    expect(navigate).not.toHaveBeenCalledWith('/tickets');
  });

  it('shows the pending state and takes it back with the request id', async () => {
    requests.rows = [REQUEST];
    renderClaim();
    expect(await screen.findByText('신청 완료 · 승인을 기다리고 있어요')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '신청 취소' }));
    await waitFor(() => expect(ticketOp).toHaveBeenCalled());
    // The cancel is the attendee's own sponsored op, unchanged by the relay switch.
    expect(ticketOp).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: 'cancelRequest', args: [5n, 3n], maxTimeoutMs: MAX_WAIT_TIMEOUT_MS }),
    );
    expect(relayClaim).not.toHaveBeenCalled();
  });

  it('sends the approved attendee to their issued ticket', async () => {
    requests.rows = [{ ...REQUEST, status: 'Approved', tokenId: '77' }];
    renderClaim();
    expect(await screen.findByText('승인됐어요. 티켓을 받았어요')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '내 티켓 보기' })).toHaveAttribute('href', '/tickets');
    expect(screen.queryByRole('button', { name: '신청하기' })).not.toBeInTheDocument();
  });

  it('lets a rejected or self-cancelled attendee ask again', async () => {
    requests.rows = [{ ...REQUEST, status: 'Rejected' }];
    renderClaim();
    expect(await screen.findByText('이번엔 승인되지 않았어요')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '신청하기' })).toBeInTheDocument();
  });

  it('names the approval-only refusal rather than the generic sentence', async () => {
    relayClaim.mockRejectedValue(callableError('APPROVAL_REQUIRED'));
    renderClaim();
    await userEvent.click(await screen.findByRole('button', { name: '신청하기' }));
    expect(await screen.findByText('이 행사는 주최자 승인 후 받을 수 있어요.')).toBeInTheDocument();
  });

  it('opens the verification sheet before requesting when the event needs kyc', async () => {
    event.row = { ...EVENT, requireKyc: true, approvalRequired: true };
    kycLevel.value = 0;
    renderClaim();
    await userEvent.click(await screen.findByRole('button', { name: '신청하기' }));
    expect(await screen.findByText('이 행사는 본인인증이 필요해요')).toBeInTheDocument();
    expect(relayClaim).not.toHaveBeenCalled();
  });
});
