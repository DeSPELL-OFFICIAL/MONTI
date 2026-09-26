import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The op layer is mocked; the sponsor account is a stub. Every assertion is about which ids go out.
const ticketOp = vi.fn();
vi.mock('../../shared/chain/ops', async (orig) => ({
  ...(await orig<typeof import('../../shared/chain/ops')>()),
  ticketOp,
}));
vi.mock('../../shared/chain/accounts', () => ({ getStaffAccount: async () => ({ address: `0x${'ab'.repeat(20)}` }) }));
vi.mock('react-router-dom', async (orig) => ({
  ...(await orig<typeof import('react-router-dom')>()), useParams: () => ({ eventId: '5' }),
}));

// The gate is what these tests drive most, so the roles hook is mocked to a controllable answer.
const orgsState: { orgs: Array<Record<string, unknown>>; isLoading: boolean } = { orgs: [], isLoading: false };
vi.mock('../useMyOrgs', () => ({
  useMyOrgs: () => ({
    orgs: orgsState.orgs, canCreateEvent: false, isLoading: orgsState.isLoading, isError: false, error: null, refetch: vi.fn(),
  }),
}));

const eventRow: { row: Record<string, unknown> } = { row: { id: '5', orgId: '9', approvalRequired: true } };
const requests: { rows: Array<Record<string, unknown>> } = { rows: [] };
const names: { rows: Array<Record<string, unknown>> } = { rows: [] };
async function answerIndexer(query: string) {
  if (query.includes('IdentityNames')) return { IdentityAccount: names.rows };
  if (query.includes('EventRequests')) return { ClaimRequest: requests.rows };
  return { Event: [eventRow.row], Tier: [] };
}
const gql = vi.fn(answerIndexer);
vi.mock('../../shared/envio/client', () => ({ gql }));

const { Requests } = await import('./Requests');

function approver(orgId = '9') {
  return { orgId, name: 'x', role: 'owner', bits: 0, canCreateEvent: true, canApprove: true };
}
function bystander(orgId = '9') {
  return { orgId, name: 'x', role: 'manager', bits: 0, canCreateEvent: false, canApprove: false };
}
function req(requestId: string, requester = `0x${'11'.repeat(20)}`) {
  return {
    id: `5-${requestId}`, eventId: '5', requestId, requester, tier: 0,
    status: 'Pending', tokenId: null, requestedAt: requestId, decidedAt: null, txHash: '0x1',
  };
}

function renderRequests() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={['/org/events/5/requests']}>
        <Requests />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  orgsState.orgs = [approver()];
  orgsState.isLoading = false;
  eventRow.row = { id: '5', orgId: '9', approvalRequired: true };
  requests.rows = [];
  names.rows = [];
  gql.mockImplementation(answerIndexer);
  ticketOp.mockReset();
  ticketOp.mockResolvedValue({ success: true, txHash: '0x2', blockNumber: 1n });
});

afterEach(() => cleanup());

describe('Requests · gating', () => {
  it('refuses somebody who cannot approve for the event organisation', async () => {
    orgsState.orgs = [bystander()];
    requests.rows = [req('1')];
    renderRequests();
    expect(await screen.findByText('이 행사의 신청을 처리할 권한이 없어요')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '전체 승인' })).not.toBeInTheDocument();
    expect(ticketOp).not.toHaveBeenCalled();
  });

  it('refuses when the event belongs to an organisation this person does not act for', async () => {
    orgsState.orgs = [approver('7')]; // approver, but for a different org than the event's 9
    renderRequests();
    expect(await screen.findByText('이 행사의 신청을 처리할 권한이 없어요')).toBeInTheDocument();
  });

  it('lets an approver see the pending list and its actions', async () => {
    requests.rows = [req('1'), req('2')];
    renderRequests();
    expect(await screen.findByRole('button', { name: '전체 승인' })).toBeInTheDocument();
    expect(screen.getAllByRole('checkbox')).toHaveLength(2);
  });
});

describe('Requests · names', () => {
  it('shows a nickname when the index has one, else a masked account', async () => {
    const named = `0x${'aa'.repeat(20)}`;
    const anon = `0x${'bb'.repeat(20)}`;
    requests.rows = [req('1', named), req('2', anon)];
    names.rows = [{ id: named, nickname: '민수' }];
    renderRequests();
    expect(await screen.findByText(/민수/)).toBeInTheDocument();
    // The account with no nickname is shown masked, never in full.
    expect(screen.getByText(new RegExp(`${anon.slice(0, 6)}`))).toBeInTheDocument();
    expect(screen.queryByText(new RegExp(anon))).not.toBeInTheDocument();
  });
});

describe('Requests · actions', () => {
  it('approves only the selected requests, by id', async () => {
    requests.rows = [req('3'), req('4')];
    renderRequests();
    await screen.findByRole('button', { name: '선택 승인' });
    await userEvent.click(screen.getAllByRole('checkbox')[0]!);
    await userEvent.click(screen.getByRole('button', { name: '선택 승인' }));
    await waitFor(() => expect(ticketOp).toHaveBeenCalled());
    expect(ticketOp).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: 9n, functionName: 'approveClaims', args: [5n, [3n]] }),
    );
  });

  it('rejects the selected requests', async () => {
    requests.rows = [req('3')];
    renderRequests();
    await userEvent.click((await screen.findAllByRole('checkbox'))[0]!);
    await userEvent.click(screen.getByRole('button', { name: '거절' }));
    await waitFor(() =>
      expect(ticketOp).toHaveBeenCalledWith(
        expect.objectContaining({ functionName: 'rejectClaims', args: [5n, [3n]] }),
      ),
    );
  });

  it('chunks a big 전체 승인 into ops of at most twenty ids', async () => {
    requests.rows = Array.from({ length: 25 }, (_, index) => req(String(index + 1)));
    renderRequests();
    await userEvent.click(await screen.findByRole('button', { name: '전체 승인' }));
    await waitFor(() => expect(ticketOp).toHaveBeenCalledTimes(2));
    const [first] = ticketOp.mock.calls[0] as [{ functionName: string; args: [bigint, bigint[]] }];
    const [second] = ticketOp.mock.calls[1] as [{ functionName: string; args: [bigint, bigint[]] }];
    expect(first.functionName).toBe('approveClaims');
    expect(first.args[1]).toHaveLength(20);
    expect(second.args[1]).toHaveLength(5);
    // Every id is a bigint and the two chunks together cover all twenty-five.
    expect(first.args[1].concat(second.args[1]).every((id) => typeof id === 'bigint')).toBe(true);
    expect(first.args[1].length + second.args[1].length).toBe(25);
  });
});
