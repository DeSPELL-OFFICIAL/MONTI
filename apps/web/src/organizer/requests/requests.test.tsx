import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeFunctionData, encodeFunctionData } from 'viem';
import { ticketAbi } from '../../shared/chain/abis';

// The op layer is mocked; the sponsor account is a stub. Every assertion is about which ids go out.
const sendAction = vi.fn<(kind: string, to: string, data: `0x${string}`) => Promise<undefined>>(async () => undefined);
vi.mock('../../shared/relay/sendAction', () => ({ sendAction }));
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
/** v2 (P5): nicknames come from the `resolveNicknames` callable, not the indexer. */
const resolveNicknames = vi.fn(async (accounts: readonly string[]) => Object.fromEntries(
  names.rows
    .filter((row) => accounts.map((a) => a.toLowerCase()).includes(String(row.id).toLowerCase()))
    .map((row) => [String(row.id).toLowerCase(), String(row.nickname)]),
));
vi.mock('../../shared/api/nicknames', () => ({ resolveNicknames }));
async function answerIndexer(query: string) {
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
  sendAction.mockReset();
  sendAction.mockResolvedValue(undefined);
});

afterEach(() => cleanup());

const data = (functionName: 'approveClaims' | 'rejectClaims', args: readonly unknown[]) =>
  encodeFunctionData({ abi: ticketAbi, functionName, args });
const argsOf = (index: number): readonly unknown[] =>
  decodeFunctionData({ abi: ticketAbi, data: sendAction.mock.calls[index]![2] }).args as readonly unknown[];

describe('Requests · gating', () => {
  it('refuses somebody who cannot approve for the event organisation', async () => {
    orgsState.orgs = [bystander()];
    requests.rows = [req('1')];
    renderRequests();
    expect(await screen.findByText('이 행사의 신청을 처리할 권한이 없어요')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '전체 승인' })).not.toBeInTheDocument();
    expect(sendAction).not.toHaveBeenCalled();
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
  it('shows a nickname when the server has one, else a masked account', async () => {
    const named = `0x${'aa'.repeat(20)}`;
    const anon = `0x${'bb'.repeat(20)}`;
    requests.rows = [req('1', named), req('2', anon)];
    names.rows = [{ id: named, nickname: '민수' }];
    renderRequests();
    expect(await screen.findByText(/민수/)).toBeInTheDocument();
    // The account with no nickname is shown masked, never in full.
    expect(screen.getByText(new RegExp(`${anon.slice(0, 6)}`))).toBeInTheDocument();
    expect(screen.queryByText(new RegExp(anon))).not.toBeInTheDocument();
    expect(resolveNicknames).toHaveBeenCalledWith([named, anon]);
    expect(gql.mock.calls.some(([query]) => String(query).includes('IdentityNames'))).toBe(false);
  });
});

describe('Requests · actions', () => {
  it('approves only the selected requests, by id', async () => {
    requests.rows = [req('3'), req('4')];
    renderRequests();
    await screen.findByRole('button', { name: '선택 승인' });
    await userEvent.click(screen.getAllByRole('checkbox')[0]!);
    await userEvent.click(screen.getByRole('button', { name: '선택 승인' }));
    await waitFor(() => expect(sendAction).toHaveBeenCalled());
    expect(sendAction).toHaveBeenCalledWith('approveClaims', 'ticket', data('approveClaims', [5n, [3n]]));
  });

  it('rejects the selected requests', async () => {
    requests.rows = [req('3')];
    renderRequests();
    await userEvent.click((await screen.findAllByRole('checkbox'))[0]!);
    await userEvent.click(screen.getByRole('button', { name: '거절' }));
    await waitFor(() =>
      expect(sendAction).toHaveBeenCalledWith('rejectClaims', 'ticket', data('rejectClaims', [5n, [3n]])),
    );
  });

  it('chunks a big 전체 승인 into ops of at most twenty ids', async () => {
    requests.rows = Array.from({ length: 25 }, (_, index) => req(String(index + 1)));
    renderRequests();
    await userEvent.click(await screen.findByRole('button', { name: '전체 승인' }));
    await waitFor(() => expect(sendAction).toHaveBeenCalledTimes(2));
    expect(sendAction.mock.calls[0]![0]).toBe('approveClaims');
    const firstIds = argsOf(0)[1] as bigint[];
    const secondIds = argsOf(1)[1] as bigint[];
    expect(firstIds).toHaveLength(20);
    expect(secondIds).toHaveLength(5);
    // Every id is a bigint and the two chunks together cover all twenty-five.
    expect(firstIds.concat(secondIds).every((id) => typeof id === 'bigint')).toBe(true);
    expect(firstIds.length + secondIds.length).toBe(25);
  });
});

describe('Requests · re-polling the pending list', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const flush = async (): Promise<void> => {
    for (let i = 0; i < 10; i += 1) await vi.advanceTimersByTimeAsync(0);
  };
  const advanceUntil = async (ok: () => boolean, capMs: number): Promise<void> => {
    for (let waited = 0; waited < capMs && !ok(); waited += 1_000) {
      await vi.advanceTimersByTimeAsync(1_000);
      await flush();
    }
  };
  const eventReqCalls = (): number =>
    gql.mock.calls.filter(([query]) => String(query).includes('EventRequests')).length;

  it('re-reads the pending list every ~10s and shows the checking hint', async () => {
    requests.rows = [req('1')];
    renderRequests();
    await flush();
    // The hint the plan asks for, and the one request the indexer holds so far.
    expect(screen.getByText('새 신청 확인 중')).toBeInTheDocument();
    expect(screen.queryAllByRole('checkbox')).toHaveLength(1);

    // A second request lands in the indexer; the open screen surfaces it on its own poll — no reload.
    const before = eventReqCalls();
    requests.rows = [req('1'), req('2')];
    await advanceUntil(() => screen.queryAllByRole('checkbox').length === 2, 20_000);
    expect(eventReqCalls()).toBeGreaterThan(before);
    expect(screen.queryAllByRole('checkbox')).toHaveLength(2);
  });

  it('keeps an approved row hidden across a poll while the indexer still lists it pending', async () => {
    const AA = `0x${'aa'.repeat(20)}`;
    const BB = `0x${'bb'.repeat(20)}`;
    requests.rows = [req('3', AA), req('4', BB)];
    names.rows = [{ id: AA, nickname: '민수' }, { id: BB, nickname: '지현' }];
    renderRequests();
    await flush();
    expect(screen.queryAllByRole('checkbox')).toHaveLength(2);

    // Approve 민수's request (the first row).
    fireEvent.click(screen.getAllByRole('checkbox')[0]!);
    fireEvent.click(screen.getByRole('button', { name: '선택 승인' }));
    await flush();
    expect(sendAction).toHaveBeenCalledWith('approveClaims', 'ticket', data('approveClaims', [5n, [3n]]));
    // Hidden the moment it is sent.
    expect(screen.queryByText(/민수/)).toBeNull();
    expect(screen.queryByText(/지현/)).toBeInTheDocument();

    // The indexer LAGS the approval and still lists 민수 as pending. The old single refetch would
    // un-hide the row here; the reconcile must keep it hidden until the flip actually shows.
    requests.rows = [req('3', AA), req('4', BB)];
    await vi.advanceTimersByTimeAsync(10_000);
    await flush();
    expect(screen.queryByText(/민수/)).toBeNull();
    expect(screen.queryByText(/지현/)).toBeInTheDocument();

    // Once the indexer catches up (민수 leaves the pending set), the list settles to just 지현.
    requests.rows = [req('4', BB)];
    await advanceUntil(() => screen.queryAllByRole('checkbox').length === 1, 20_000);
    expect(screen.queryByText(/지현/)).toBeInTheDocument();
    expect(screen.queryByText(/민수/)).toBeNull();
  });
});
