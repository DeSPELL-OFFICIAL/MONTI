import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearSession, setSession } from '../../shared/session';

// The indexer is not deployed, so the transport is mocked and answers each document by name.
// Every assertion below is about what the screens do with the rows, never about how they arrive.
const gql = vi.fn();
vi.mock('../../shared/envio/client', () => ({ gql }));

const { TicketList } = await import('./List');
const { TicketDetail } = await import('./Detail');

const OWNER = `0x${'cd'.repeat(20)}`;
const OTHER = `0x${'ef'.repeat(20)}`;
const NOW = Math.floor(Date.now() / 1000);

function ticket(id: string, extra: Record<string, unknown> = {}) {
  return { id, eventId: '7', tier: 0, owner: OWNER, transfers: 0, revoked: false, ...extra };
}

// One row per state: 입장 전, 입장 완료, 양도 대기, 취소됨(회수), 취소됨(행사 취소), 양도됨.
const OWNED = [ticket('1'), ticket('2'), ticket('3'), ticket('4', { revoked: true }), ticket('6', { eventId: '9' })];
const OFFERS = [
  { id: '3', from: OWNER, commitment: '0x01', expiresAt: String(NOW + 3_600), status: 'open' },
  { id: '5', from: OWNER, commitment: '0x02', expiresAt: String(NOW - 3_600), status: 'accepted' },
];
const CONTEXT = {
  CheckIn: [{ id: '2', gateId: '1', ts: String(NOW - 600), manual: false, txHash: '0xaa', block: '10' }],
  Event: [{ id: '7', status: 'Published' }, { id: '9', status: 'Cancelled' }],
  Ticket: [ticket('5', { owner: OTHER })],
};

beforeEach(() => {
  setSession({ status: 'signedIn', account: OWNER as `0x${string}` });
  gql.mockReset();
  gql.mockImplementation(async (query: string) => {
    if (query.includes('OwnedTickets')) return { Ticket: OWNED, Offer: OFFERS };
    return CONTEXT;
  });
});

afterEach(() => {
  // Unmount first: a session change with the screens still mounted is a React update
  // outside act(), which is noise rather than anything the attendee would see.
  cleanup();
  clearSession();
});

function renderList() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter><TicketList /></MemoryRouter>
    </QueryClientProvider>,
  );
}

function renderDetail(tokenId: string) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[`/tickets/${tokenId}`]}>
        <Routes><Route path="/tickets/:tokenId" element={<TicketDetail />} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('TicketList', () => {
  it('shows every derived state', async () => {
    renderList();
    expect(await screen.findByRole('link', { name: '#1 · 입장 전' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '#2 · 입장 완료' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '#3 · 양도 대기' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '#5 · 양도됨' })).toBeInTheDocument();
    // A revoked ticket and a ticket on a called-off event read the same word.
    expect(screen.getAllByRole('link', { name: /취소됨/ })).toHaveLength(2);
  });

  it('asks the indexer only for the check-ins, events and handovers its own rows name', async () => {
    renderList();
    await screen.findByRole('link', { name: '#1 · 입장 전' });
    expect(gql).toHaveBeenLastCalledWith(expect.stringContaining('TicketContext'), {
      tokenIds: ['1', '2', '3', '4', '6'],
      eventIds: ['7', '9'],
      handedOverIds: ['5'],
    });
  });

  it('shows the empty sentence when nothing is owned', async () => {
    gql.mockImplementation(async () => ({ Ticket: [], Offer: [] }));
    renderList();
    expect(await screen.findByText('아직 티켓이 없어요.')).toBeInTheDocument();
  });
});

describe('TicketDetail', () => {
  it('shows the state, the door guide and the entry button before entry', async () => {
    renderDetail('1');
    expect(await screen.findByText('입장 전')).toBeInTheDocument();
    expect(screen.getByText('입구에서 입장하기를 누르고 60초 안에 단말기에 휴대폰을 대세요.')).toBeInTheDocument();
    expect(screen.getByText('보여줄 코드는 없어요.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '입장하기' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '양도' })).toBeInTheDocument();
  });

  it('drops the entry and handover buttons once the ticket is used', async () => {
    renderDetail('2');
    expect(await screen.findByText('입장 완료')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '입장하기' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '양도' })).not.toBeInTheDocument();
  });
});
