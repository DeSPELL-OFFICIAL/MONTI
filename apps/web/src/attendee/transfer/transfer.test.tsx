import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { toFunctionSelector } from 'viem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearSession, setSession } from '../../shared/session';

const ME = `0x${'aa'.repeat(20)}` as const;
const YOU = `0x${'bb'.repeat(20)}` as const;

// The callable is mocked; `callableFailure` stays real, because reading the server's reason
// code out of a rejection is exactly what the screen is being tested on.
const resolveRecipient = vi.fn();
vi.mock('../../shared/api/functions', async (orig) => ({
  ...(await orig<typeof import('../../shared/api/functions')>()),
  api: { resolveRecipient },
}));

// The operation layer is mocked, but the real OpReverted class is kept: the screen tells a
// revert from a "still confirming" timeout by the sentinel reason that class carries.
const ticketOp = vi.fn();
vi.mock('../../shared/chain/ops', async (orig) => ({
  ...(await orig<typeof import('../../shared/chain/ops')>()),
  ticketOp,
}));
vi.mock('../../shared/chain/accounts', () => ({ getAttendeeAccount: async () => ({ address: ME }) }));

const identity = { isMember: vi.fn(), isLocked: vi.fn(), kycLevelOf: vi.fn() };
const ticket = {
  eventOf: vi.fn(), tierOf: vi.fn(), tiers: vi.fn(), eventMeta: vi.fn(), eventStatus: vi.fn(),
  isRevoked: vi.fn(), checkInOf: vi.fn(), transfersOf: vi.fn(), balanceOfEvent: vi.fn(),
};
// Partial mock: the reads are stubs, but `EventStatus` stays the real module's.
vi.mock('../../shared/chain/reads', async (orig) => ({
  ...(await orig<typeof import('../../shared/chain/reads')>()),
  readIdentity: () => identity,
  readTicket: () => ticket,
}));

const { TransferRecipient } = await import('./Recipient');
const { TransferConfirm } = await import('./Confirm');
const { CallableError } = await import('../../shared/api/functions');
const { OpReverted } = await import('../../shared/chain/ops');

const NOW = Math.floor(Date.now() / 1000);
const TIER = { name: '일반', priceUsdCents: 0n, supply: 100, minted: 1, maxPerWallet: 2, seated: false };

function Address() {
  const location = useLocation();
  return <span data-testid="address">{location.pathname}</span>;
}

function renderFlow(entry: string | { pathname: string; state?: unknown }) {
  return render(
    <MemoryRouter initialEntries={[entry as string]}>
      <Routes>
        <Route path="/tickets" element={<span>내 티켓 목록</span>} />
        <Route path="/tickets/:tokenId/transfer" element={<TransferRecipient />} />
        <Route path="/tickets/:tokenId/transfer/confirm" element={<TransferConfirm />} />
      </Routes>
      <Address />
    </MemoryRouter>,
  );
}

const CONFIRM = { pathname: '/tickets/1/transfer/confirm', state: { account: YOU, nickname: 'bob' } };

beforeEach(() => {
  setSession({ status: 'signedIn', account: ME });
  resolveRecipient.mockReset();
  ticketOp.mockReset();
  ticketOp.mockResolvedValue({ success: true, txHash: '0x2', blockNumber: 1n });
  identity.isMember.mockResolvedValue(true);
  identity.isLocked.mockResolvedValue(false);
  identity.kycLevelOf.mockResolvedValue(1);
  ticket.eventOf.mockResolvedValue(5n);
  ticket.tierOf.mockResolvedValue(0);
  ticket.tiers.mockResolvedValue([TIER]);
  ticket.eventStatus.mockResolvedValue(1);
  ticket.isRevoked.mockResolvedValue(false);
  ticket.checkInOf.mockResolvedValue({ gateId: 0n, ts: 0n, nonceHash: `0x${'00'.repeat(32)}`, manual: false });
  ticket.transfersOf.mockResolvedValue(0);
  ticket.balanceOfEvent.mockResolvedValue(0n);
  ticket.eventMeta.mockResolvedValue({
    orgId: 9n, startsAt: BigInt(NOW + 86_400), transferCutoffSeconds: 3600,
    maxTransfers: 3, transferable: true, requireKyc: false,
  });
});

afterEach(() => {
  // Unmount first: a session change with the screens still mounted is a React update
  // outside act(), which is noise rather than anything the attendee would see.
  cleanup();
  clearSession();
});

async function find(label: string, value: string) {
  await userEvent.click(screen.getByRole('tab', { name: label }));
  await userEvent.type(screen.getByRole('textbox'), value);
  await userEvent.click(screen.getByRole('button', { name: '찾기' }));
}

describe('TransferRecipient', () => {
  it('finds a member by nickname and carries the name to the confirm screen', async () => {
    resolveRecipient.mockResolvedValue({ member: true, account: YOU, nickname: 'bob' });
    renderFlow('/tickets/1/transfer');
    await find('별명', 'Bob');
    expect(resolveRecipient).toHaveBeenCalledWith({ type: 'nickname', value: 'Bob' });
    expect(await screen.findByRole('heading', { name: '이 분에게 양도할까요?' })).toBeInTheDocument();
    expect(screen.getByText('bob')).toBeInTheDocument();
  });

  it('finds a member by account address', async () => {
    resolveRecipient.mockResolvedValue({ member: true, account: YOU });
    renderFlow('/tickets/1/transfer');
    await find('주소', YOU);
    expect(resolveRecipient).toHaveBeenCalledWith({ type: 'address', value: YOU });
    expect(await screen.findByText(YOU)).toBeInTheDocument();
  });

  it('sends the phone number in E.164 and confirms a member', async () => {
    resolveRecipient.mockResolvedValue({ member: true, account: YOU, commitment: `0x${'cc'.repeat(32)}` });
    renderFlow('/tickets/1/transfer');
    await find('전화번호', '01012345678');
    expect(resolveRecipient).toHaveBeenCalledWith({ type: 'phone', value: '+821012345678' });
    expect(await screen.findByRole('heading', { name: '이 분에게 양도할까요?' })).toBeInTheDocument();
  });

  it('hands a number that belongs to nobody over to the invite path', async () => {
    resolveRecipient.mockResolvedValue({ member: false, commitment: `0x${'cc'.repeat(32)}` });
    renderFlow('/tickets/1/transfer');
    await find('전화번호', '01012345678');
    expect(await screen.findByRole('heading', { name: '아직 가입하지 않은 번호예요' })).toBeInTheDocument();
    expect(screen.getByTestId('address')).toHaveTextContent('/tickets/1/transfer');
  });

  it('says so when the nickname belongs to nobody', async () => {
    resolveRecipient.mockRejectedValue(new CallableError('not-found', 'NICKNAME_UNKNOWN'));
    renderFlow('/tickets/1/transfer');
    await find('별명', 'ghost');
    expect(await screen.findByText('찾을 수 없어요.')).toBeInTheDocument();
  });

  it('turns the server refusals into their own sentences', async () => {
    resolveRecipient.mockRejectedValue(new CallableError('failed-precondition', 'NOT_A_MEMBER'));
    const view = renderFlow('/tickets/1/transfer');
    await find('주소', YOU);
    expect(await screen.findByText('받는 분이 아직 가입하지 않았어요.')).toBeInTheDocument();
    view.unmount();

    resolveRecipient.mockRejectedValue(new CallableError('invalid-argument', 'SELF_TRANSFER'));
    renderFlow('/tickets/1/transfer');
    await find('별명', 'me');
    expect(await screen.findByText('본인에게는 양도할 수 없어요.')).toBeInTheDocument();
  });
});

describe('TransferConfirm', () => {
  it('runs the pre-check and sends one sponsored handover', async () => {
    renderFlow(CONFIRM);
    await userEvent.click(screen.getByRole('button', { name: '양도하기' }));
    expect(ticketOp).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: 9n, functionName: 'safeTransferFrom', args: [ME, YOU, 1n] }),
    );
    expect(await screen.findByText('내 티켓 목록')).toBeInTheDocument();
  });

  it('blocks on a failing pre-check instead of spending an operation', async () => {
    identity.isMember.mockResolvedValue(false);
    renderFlow(CONFIRM);
    await userEvent.click(screen.getByRole('button', { name: '양도하기' }));
    expect(await screen.findByText('받는 분이 아직 가입하지 않았어요.')).toBeInTheDocument();
    expect(ticketOp).not.toHaveBeenCalled();
  });

  it('blocks an unverified recipient on an event that requires verification', async () => {
    ticket.eventMeta.mockResolvedValue({
      orgId: 9n, startsAt: BigInt(NOW + 86_400), transferCutoffSeconds: 3600,
      maxTransfers: 3, transferable: true, requireKyc: true,
    });
    identity.kycLevelOf.mockResolvedValue(0);
    renderFlow(CONFIRM);
    await userEvent.click(screen.getByRole('button', { name: '양도하기' }));
    expect(await screen.findByText('받는 사람이 본인인증을 하지 않았어요.')).toBeInTheDocument();
    expect(ticketOp).not.toHaveBeenCalled();
  });

  it('reads a timed-out operation as still confirming, not as a failure', async () => {
    ticketOp.mockRejectedValueOnce(new OpReverted('safeTransferFrom', 'TIMEOUT'));
    renderFlow(CONFIRM);
    const cta = screen.getByRole('button', { name: '양도하기' });
    await userEvent.click(cta);
    expect(await screen.findByText('아직 확인 중이에요. 잠시 뒤 내 티켓에서 확인해 주세요.')).toBeInTheDocument();
    expect(screen.queryByText('양도하지 못했어요. 잠시 뒤 다시 시도해 주세요.')).not.toBeInTheDocument();
    expect(cta).toBeDisabled();
    await userEvent.click(cta);
    expect(ticketOp).toHaveBeenCalledTimes(1);
  });

  it('shows the failure sentence when the handover reverts', async () => {
    ticketOp.mockRejectedValueOnce(new OpReverted('safeTransferFrom', '0xdeadbeef'));
    renderFlow(CONFIRM);
    await userEvent.click(screen.getByRole('button', { name: '양도하기' }));
    expect(await screen.findByText('양도하지 못했어요. 잠시 뒤 다시 시도해 주세요.')).toBeInTheDocument();
  });

  it('offers the way back when the screen is opened without a recipient', async () => {
    renderFlow('/tickets/1/transfer/confirm');
    // Its own sentence: nothing was searched for here, so "not found" would not be true.
    expect(await screen.findByText('받는 분을 먼저 골라 주세요.')).toBeInTheDocument();
    expect(ticketOp).not.toHaveBeenCalled();
  });
});

/**
 * The pre-check reads a moment before the operation runs, so a rule can flip underneath it.
 * The chain then names the rule it refused on in the first four bytes of the revert data, and
 * every one of those rules already owns a sentence — signatures written out here rather than
 * read back from the ABI, so this pins the selectors independently.
 */
const REVERT_SENTENCES: ReadonlyArray<readonly [string, string]> = [
  ['TicketRevoked()', '취소된 티켓이라 양도할 수 없어요.'],
  ['TransfersDisabled()', '이 행사는 양도할 수 없어요.'],
  ['AlreadyCheckedIn()', '이미 입장한 티켓이에요.'],
  ['TransferCutoffPassed()', '양도 마감 시간이 지났어요.'],
  ['NotMember()', '받는 분이 아직 가입하지 않았어요.'],
  ['KycRequired()', '받는 사람이 본인인증을 하지 않았어요.'],
  ['TransferLimitReached()', '이 티켓은 더 이상 양도할 수 없어요.'],
  ['MaxPerWalletExceeded()', '받는 분이 이 행사 티켓을 이미 최대 수만큼 갖고 있어요.'],
];

const GENERIC = '양도하지 못했어요. 잠시 뒤 다시 시도해 주세요.';

describe('a handover the contract refuses', () => {
  for (const [signature, sentence] of REVERT_SENTENCES) {
    it(`says which rule ${signature} is`, async () => {
      ticketOp.mockRejectedValueOnce(new OpReverted('safeTransferFrom', toFunctionSelector(signature)));
      renderFlow(CONFIRM);
      await userEvent.click(screen.getByRole('button', { name: '양도하기' }));
      expect(await screen.findByText(sentence)).toBeInTheDocument();
      expect(screen.queryByText(GENERIC)).not.toBeInTheDocument();
    });
  }

  it('reads the rule out of a reason that carries data after the selector', async () => {
    const padded = `${toFunctionSelector('TicketRevoked()')}${'00'.repeat(32)}` as const;
    ticketOp.mockRejectedValueOnce(new OpReverted('safeTransferFrom', padded));
    renderFlow(CONFIRM);
    await userEvent.click(screen.getByRole('button', { name: '양도하기' }));
    expect(await screen.findByText('취소된 티켓이라 양도할 수 없어요.')).toBeInTheDocument();
  });

  it('keeps the generic sentence for a selector nothing here knows', async () => {
    ticketOp.mockRejectedValueOnce(new OpReverted('safeTransferFrom', '0xdeadbeef'));
    renderFlow(CONFIRM);
    await userEvent.click(screen.getByRole('button', { name: '양도하기' }));
    expect(await screen.findByText(GENERIC)).toBeInTheDocument();
  });

  it('still reads a timeout as confirming, never as a refusal', async () => {
    ticketOp.mockRejectedValueOnce(new OpReverted('safeTransferFrom', 'TIMEOUT'));
    renderFlow(CONFIRM);
    await userEvent.click(screen.getByRole('button', { name: '양도하기' }));
    expect(await screen.findByText('아직 확인 중이에요. 잠시 뒤 내 티켓에서 확인해 주세요.')).toBeInTheDocument();
    expect(screen.queryByText(GENERIC)).not.toBeInTheDocument();
  });
});
