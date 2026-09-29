import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Hex } from 'viem';
import { clearSession, setSession } from '../../shared/session';

// Approval mode's ClaimRequest row can lag the transaction by minutes in the indexer, so the screen
// re-polls until it appears and then until it flips. These tests drive that with fake timers; the
// relayer callable and the indexer transport are mocked, everything else is the real screen. The
// relayer answers `confirmed`, which is what starts the appearance wait.
const ACCOUNT = `0x${'ab'.repeat(20)}` as Hex;
const AUTH = { eventId: '5', tier: 0, account: ACCOUNT, nonce: '0', deadline: '1799999999' };
const DEVICE_SIG = `0x${'cd'.repeat(64)}` as Hex;
vi.mock('./buildClaimAuth', () => ({ buildClaimAuth: vi.fn(async () => ({ auth: AUTH, deviceSig: DEVICE_SIG })) }));

const relayClaim = vi.fn();
vi.mock('../../shared/api/functions', () => ({ api: { relayClaim } }));
vi.mock('../../shared/api/firestore', () => ({ watchRelay: vi.fn(() => () => undefined) }));

vi.mock('../../shared/chain/accounts', () => ({ getAttendeeAccount: async () => ({ address: ACCOUNT }) }));
const navigate = vi.fn();
vi.mock('react-router-dom', async (orig) => ({
  ...(await orig<typeof import('react-router-dom')>()), useParams: () => ({ eventId: '5' }), useNavigate: () => navigate,
}));

const EVENT = { id: '5', orgId: '9', requireKyc: false, approvalRequired: true };
const TIER = { id: '5-0', eventId: '5', idx: 0, name: '일반', supply: 100, minted: 1, maxPerWallet: 2, seated: false };
/** The one dial these tests turn: what the indexer currently holds for this person's request. */
const requests: { rows: Array<Record<string, unknown>> } = { rows: [] };
async function answerIndexer(query: string) {
  if (query.includes('OwnedTickets')) return { Ticket: [], Offer: [] };
  if (query.includes('TicketContext')) return { CheckIn: [], Event: [], Tier: [], Ticket: [] };
  if (query.includes('EventStates')) return { Event: [], Tier: [] };
  if (query.includes('MyRequests')) return { ClaimRequest: requests.rows };
  return { Event: [EVENT], Tier: [TIER] };
}
const gql = vi.fn(answerIndexer);
vi.mock('../../shared/envio/client', () => ({ gql }));
vi.mock('../me/useKycLevel', () => ({
  useKycLevel: () => ({ kycLevel: 1, isLoading: false, refetch: vi.fn() }),
}));

const { Claim } = await import('./Claim');

const ME = `0x${'cd'.repeat(20)}` as `0x${string}`;
const REQUEST = {
  id: '5-3', eventId: '5', requestId: '3', requester: ME.toLowerCase(),
  tier: 0, status: 'Pending', tokenId: null, requestedAt: '1', decidedAt: null, txHash: '0x1',
};

function renderClaim() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={['/claim/5']}>
        <Claim />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Pretend the tab is hidden (or not); the polls read `document.hidden`. */
function setHidden(is: boolean): void {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => is });
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (is ? 'hidden' : 'visible') });
}

const myRequestCalls = (): number =>
  gql.mock.calls.filter(([query]) => String(query).includes('MyRequests')).length;

/** Let the mocked queries settle without advancing any of the poll timers. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await vi.advanceTimersByTimeAsync(0);
}

/** Advance the fake clock in 1s steps, flushing each time, until `text` shows or the cap is hit. */
async function advanceUntil(text: string, capMs: number): Promise<void> {
  for (let waited = 0; waited < capMs && screen.queryByText(text) === null; waited += 1_000) {
    await vi.advanceTimersByTimeAsync(1_000);
    await flush();
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  requests.rows = [];
  navigate.mockReset();
  gql.mockImplementation(answerIndexer);
  relayClaim.mockReset();
  // The relayer already saw the receipt; the request's own row is what the poll then waits for.
  relayClaim.mockResolvedValue({ relayId: 'r1', status: 'confirmed' });
  setSession({ status: 'signedIn', account: ME });
  setHidden(false);
});

afterEach(() => {
  cleanup();
  clearSession();
  vi.useRealTimers();
});

describe('Claim · approval mode re-polls the indexer', () => {
  it('shows 확인 중 after a request lands, then pending, then approved — one submission only', async () => {
    renderClaim();
    await flush();

    fireEvent.click(screen.getByRole('button', { name: '신청하기' }));
    await flush();
    // The request landed but the row has not surfaced yet: a reassuring "받았어요 · 확인 중", not nothing.
    expect(screen.getByText('신청을 접수했어요 · 확인 중')).toBeInTheDocument();
    expect(relayClaim).toHaveBeenCalledTimes(1);

    // The row appears on the first backoff poll.
    requests.rows = [REQUEST];
    await vi.advanceTimersByTimeAsync(2_000);
    await flush();
    expect(screen.getByText('신청 완료 · 승인을 기다리고 있어요')).toBeInTheDocument();

    // While Pending it keeps looking; an approval flips it live without a reload.
    const pendingPollBefore = myRequestCalls();
    requests.rows = [{ ...REQUEST, status: 'Approved', tokenId: '77' }];
    await advanceUntil('승인됐어요. 티켓을 받았어요', 30_000);
    expect(myRequestCalls()).toBeGreaterThan(pendingPollBefore); // the pending poll fired
    expect(screen.getByText('승인됐어요. 티켓을 받았어요')).toBeInTheDocument();
    expect(relayClaim).toHaveBeenCalledTimes(1);
  });

  it('pauses polling while the tab is hidden and resumes when it comes back', async () => {
    renderClaim();
    await flush();
    fireEvent.click(screen.getByRole('button', { name: '신청하기' }));
    await flush();
    expect(screen.getByText('신청을 접수했어요 · 확인 중')).toBeInTheDocument();

    // Hidden: even a minute of ticks asks the indexer nothing.
    setHidden(true);
    const before = myRequestCalls();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(myRequestCalls()).toBe(before);

    // Back in view: it resumes, finds the row, and shows it.
    requests.rows = [REQUEST];
    setHidden(false);
    document.dispatchEvent(new Event('visibilitychange'));
    await flush();
    expect(screen.getByText('신청 완료 · 승인을 기다리고 있어요')).toBeInTheDocument();
  });
});
