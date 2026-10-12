import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { keccak256, toBytes } from 'viem';

// Only the two transports and the one config read are mocked: the indexer POST, the Firestore
// policy read, the pinned-metadata fetch and `getConfig` (no chain env in a unit test). Everything
// else is the real page.
const gql = vi.fn();
vi.mock('../../shared/envio/client', () => ({ gql }));

const getSettlement = vi.fn();
vi.mock('../../shared/api/firestore', () => ({ getSettlement }));

const fetchEventMetadata = vi.fn();
vi.mock('../../shared/envio/ipfs', () => ({ fetchEventMetadata }));

vi.mock('../../shared/config', () => ({
  getConfig: () => ({
    explorerUrl: 'https://testnet.monadexplorer.com',
    addresses: { settlementVault: `0x${'11'.repeat(20)}` },
  }),
}));

const { Settlement } = await import('./Settlement');

const EVENT_ID = '5';
const ACC_A = `0x${'aa'.repeat(20)}`;
const ACC_B = `0x${'bb'.repeat(20)}`;

const SETTLEMENT = {
  policy: {
    recipients: [
      { account: ACC_A, bps: 7000, reason: '공연팀', tag: '아티스트' },
      { account: ACC_B, bps: 2000, reason: '대관료', tag: 'Where' },
    ],
    platformBps: 500,
  },
  policyHash: `0x${'cd'.repeat(32)}`,
  priceUsdCentsByTier: { '0': 3000 },
  txHash: `0x${'ef'.repeat(32)}`,
};

const EVENT_ROW = {
  id: EVENT_ID,
  orgId: '9',
  imageCid: 'cid',
  startsAt: '1760000000',
  endsAt: '1760100000',
  status: 'Published',
};

interface TestPayout {
  id: string;
  tokenId: string;
  recipient: string;
  amount: string;
  reasonHash: string;
  at: string;
  txHash: string;
}

function liveWith(payouts: TestPayout[]) {
  return {
    EventSettlement: [
      { totalDeposited: '90000000', totalReleased: '30000000', totalRefunded: '30000000', payoutCount: payouts.length },
    ],
    Escrow: [
      { id: 't1', status: 'Released', amount: '30000000' },
      { id: 't2', status: 'Deposited', amount: '30000000' },
      { id: 't3', status: 'Refunded', amount: '30000000' },
    ],
    Payout: payouts,
  };
}

function payout(id: string, recipient: string, reason: string, amount: string, at: string): TestPayout {
  return { id, tokenId: id, recipient, amount, reasonHash: keccak256(toBytes(reason)), at, txHash: `0x${id.repeat(8)}` };
}

function renderPage(): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/settlement/${EVENT_ID}`]}>
        <Routes>
          <Route path="/settlement/:eventId" element={<Settlement />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return client;
}

beforeEach(() => {
  getSettlement.mockReset().mockResolvedValue(SETTLEMENT);
  fetchEventMetadata.mockReset().mockResolvedValue({ title: '테스트 콘서트' });
  gql.mockReset();
});

describe('public settlement page', () => {
  it('renders the split rules, the platform row and the live totals', async () => {
    gql.mockImplementation(async (query: string) =>
      query.includes('SettlementLive') ? liveWith([]) : { Event: [EVENT_ROW], Tier: [] },
    );
    renderPage();

    expect(await screen.findByText('테스트 콘서트')).toBeInTheDocument();
    expect(screen.getByText('How this event’s revenue is split')).toBeInTheDocument();
    // recipients, platform and the leftover reserve each read as a percentage
    expect(screen.getByText('70%')).toBeInTheDocument();
    expect(screen.getByText('공연팀')).toBeInTheDocument();
    expect(screen.getByText('MONTI platform')).toBeInTheDocument();
    expect(screen.getByText('Reserve')).toBeInTheDocument();
    // live tiles are present with their counts summed by status from the escrow rows
    expect(screen.getByText('Paid out after check-in')).toBeInTheDocument();
    expect(screen.getByText('No-show payouts')).toBeInTheDocument();
  });

  it('labels a payout by the human reason behind its on-chain hash', async () => {
    const paid = payout('1', ACC_A, '공연팀', '25000000', '1760000500');
    gql.mockImplementation(async (query: string) =>
      query.includes('SettlementLive') ? liveWith([paid]) : { Event: [EVENT_ROW], Tier: [] },
    );
    renderPage();

    expect(await screen.findByText('$25')).toBeInTheDocument();
    // '공연팀' appears both as a rule row and as this payout's role.
    expect(screen.getAllByText('공연팀').length).toBeGreaterThanOrEqual(2);
  });

  it('shows the not-yet-set state when no policy exists', async () => {
    getSettlement.mockResolvedValue(null);
    gql.mockImplementation(async (query: string) =>
      query.includes('SettlementLive') ? liveWith([]) : { Event: [EVENT_ROW], Tier: [] },
    );
    renderPage();

    expect(await screen.findByText('The organizer hasn’t locked in the payout rules yet')).toBeInTheDocument();
  });

  it('appends a new payout and highlights only the arrival on the next poll', async () => {
    const first = payout('1', ACC_A, '공연팀', '25000000', '1760000500');
    const second = payout('2', ACC_B, '대관료', '7500000', '1760000600');
    let live = liveWith([first]);
    gql.mockImplementation(async (query: string) =>
      query.includes('SettlementLive') ? live : { Event: [EVENT_ROW], Tier: [] },
    );
    const client = renderPage();

    await screen.findByText('$25');
    // nothing on the initial batch is highlighted
    expect(document.querySelector('.payout-row.is-new')).toBeNull();

    // the indexer now returns a newer payout at the top of the list
    live = liveWith([second, first]);
    await act(async () => {
      await client.refetchQueries({ queryKey: ['settlementLive', EVENT_ID] });
    });

    expect(await screen.findByText('$7.50')).toBeInTheDocument();
    const fresh = document.querySelector('.payout-row.is-new');
    expect(fresh).not.toBeNull();
    expect(fresh?.textContent).toContain('$7.50');
  });

  it('shows the error state when the header query fails', async () => {
    gql.mockImplementation(async (query: string) => {
      if (query.includes('SettlementLive')) return liveWith([]);
      throw new Error('indexer down');
    });
    renderPage();

    await waitFor(() => expect(screen.getByText('Can’t load the live numbers right now')).toBeInTheDocument());
  });
});
