import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Hex } from 'viem';
import { clearSession, setSession } from '../../shared/session';

// The claim page reads the event from the indexer, or from the chain while the indexer lags. Here
// the indexer answers with *no* event row and the chain has a Published one, so these tests exercise
// the fallback: the normal screen must render and claim from chain data. The authorization builder,
// the relayer callable and the relay-doc subscription are mocked exactly as in claim.test.tsx; the
// new surface is the mocked chain reads (`readTicket`).
const ACCOUNT = `0x${'ab'.repeat(20)}` as Hex;
const AUTH = { eventId: '5', tier: 0, account: ACCOUNT, nonce: '0', deadline: '1799999999' };
const DEVICE_SIG = `0x${'cd'.repeat(64)}` as Hex;
const buildClaimAuth = vi.fn(async () => ({ auth: AUTH, deviceSig: DEVICE_SIG }));
vi.mock('./buildClaimAuth', () => ({ buildClaimAuth }));

const relayClaim = vi.fn();
vi.mock('../../shared/api/functions', () => ({ api: { relayClaim } }));
vi.mock('../../shared/api/firestore', () => ({ watchRelay: vi.fn(() => () => undefined), getSettlement: vi.fn(async () => null) }));
vi.mock('../../shared/relay/sendAction', () => ({ sendAction: vi.fn() }));
vi.mock('../../shared/chain/accounts', () => ({ getAttendeeAccount: async () => ({ address: ACCOUNT }) }));
vi.mock('react-router-dom', async (orig) => ({
  ...(await orig<typeof import('react-router-dom')>()), useParams: () => ({ eventId: '5' }), useNavigate: () => vi.fn(),
}));
vi.mock('../me/useKycLevel', () => ({
  useKycLevel: () => ({ kycLevel: 1, isLoading: false, refetch: vi.fn() }),
}));

// The indexer, with no event row by default: `eventRows` empty forces the chain fallback.
const eventRows: { rows: Array<Record<string, unknown>> } = { rows: [] };
const tierRows: { rows: Array<Record<string, unknown>> } = { rows: [] };
async function answerIndexer(query: string) {
  if (query.includes('OwnedTickets')) return { Ticket: [], Offer: [] };
  if (query.includes('TicketContext')) return { CheckIn: [], Event: [], Tier: [], Ticket: [] };
  if (query.includes('EventStates')) return { Event: [], Tier: [] };
  if (query.includes('MyRequests')) return { ClaimRequest: [] };
  return { Event: eventRows.rows, Tier: tierRows.rows };
}
const gql = vi.fn(answerIndexer);
vi.mock('../../shared/envio/client', () => ({ gql }));

// The chain reads behind the fallback. Mutable, so each test sets the event the chain reports.
const META = {
  orgId: 9n, imageCid: 'cid', startsAt: 100n, endsAt: 200n, saleStart: 50n, saleEnd: 150n,
  transferable: true, transferCutoffSeconds: 0, maxTransfers: 0, category: 1,
  regionCode: `0x${'00'.repeat(32)}`, requireKyc: false, approvalRequired: false,
};
const chainMeta: { value: Record<string, unknown> } = { value: META };
const chainStatus = { value: 1 }; // Published
const chainTiers: { rows: Array<Record<string, unknown>> } = { rows: [] };
const chainBalance = { value: 0n };
const eventMeta = vi.fn(async () => chainMeta.value);
const eventStatus = vi.fn(async () => chainStatus.value);
const tiers = vi.fn(async () => chainTiers.rows);
const balanceOfEvent = vi.fn(async () => chainBalance.value);
const eventOrg = vi.fn(async () => (chainMeta.value.orgId as bigint));
vi.mock('../../shared/chain/reads', () => ({
  readTicket: () => ({ eventMeta, eventStatus, tiers, balanceOfEvent, eventOrg }),
}));

const CHAIN_TIER = { name: '체인일반', priceUsdCents: 0n, supply: 100, minted: 1, maxPerWallet: 2, seated: false };

const { Claim } = await import('./Claim');

function renderClaim() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={['/claim/5']}>
        <Claim />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  setSession({ status: 'signedIn', account: ACCOUNT });
  eventRows.rows = [];
  tierRows.rows = [];
  chainMeta.value = META;
  chainStatus.value = 1;
  chainTiers.rows = [CHAIN_TIER];
  chainBalance.value = 0n;
  gql.mockImplementation(answerIndexer);
  buildClaimAuth.mockClear();
  relayClaim.mockReset().mockResolvedValue({ relayId: 'r1', status: 'confirmed', tokenId: '77' });
  eventMeta.mockClear();
});

afterEach(() => {
  cleanup();
  clearSession();
});

describe('claim page, indexer lagging', () => {
  it('renders the normal screen and claims from the chain when the indexer has no event row', async () => {
    renderClaim();
    // The enabled claim button only appears once the chain event + held balance have resolved — an
    // error screen or a permanent 확인 중 would fail this find.
    await userEvent.click(await screen.findByRole('button', { name: '티켓 받기' }));
    await waitFor(() => expect(relayClaim).toHaveBeenCalled());
    expect(relayClaim.mock.calls[0]?.[0]).toMatchObject({ mode: 'claim' });
    // The relayer confirmed, so the claim settles to 완료 and the button is gone — waiting on that
    // flushes the settle so no state update lands outside act after the test.
    await waitFor(() => expect(screen.queryByRole('button', { name: '티켓 받기' })).toBeNull());
  });

  it('prefers the indexer event over the chain when the indexer has the row', async () => {
    eventRows.rows = [{ id: '5', orgId: '9', status: 'Published', requireKyc: false }];
    tierRows.rows = [{ id: '5-0', eventId: '5', idx: 0, name: '색인일반', supply: '100', minted: '1', maxPerWallet: '2', seated: false }];
    renderClaim();
    expect(await screen.findByText(/색인일반/)).toBeInTheDocument();
    // The indexer answered, so the chain fallback read was never made.
    expect(eventMeta).not.toHaveBeenCalled();
  });

  it('pre-blocks a claim from the chain balance when the wallet already holds its allotment', async () => {
    chainBalance.value = 2n; // held 2 >= maxPerWallet 2
    renderClaim();
    expect(await screen.findByText('이미 받았어요 · 내 티켓에서 확인하세요')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: '티켓 받기' })).toBeDisabled();
    expect(relayClaim).not.toHaveBeenCalled();
  });
});
