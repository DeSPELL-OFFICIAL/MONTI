import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { toFunctionSelector } from 'viem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearSession, setSession } from '../../shared/session';

const ME = `0x${'aa'.repeat(20)}` as const;
const COMMITMENT = `0x${'cc'.repeat(32)}` as const;
const NO_OFFER = `0x${'00'.repeat(32)}` as const;
const ZERO_ADDRESS = `0x${'00'.repeat(20)}` as const;
const PHONE = '+821012345678';
const SMS_TEXT = '[MONTI] 티켓을 보냈습니다. 앱에서 받기를 눌러 주세요. https://monti.example/i/i1';
const SMS_URI = `sms:${PHONE}?body=${encodeURIComponent(SMS_TEXT)}`;
const NOW = Math.floor(Date.now() / 1000);
const EXPIRES_AT = NOW + 7 * 24 * 60 * 60;

const INVITE = {
  inviteId: 'i1',
  commitment: COMMITMENT,
  expiresAt: EXPIRES_AT,
  smsText: SMS_TEXT,
  smsUri: SMS_URI,
};

// The callable is mocked; `callableFailure` stays real, because reading the server's reason
// code out of a rejection is exactly what this screen is being tested on.
const createTransferInvite = vi.fn();
vi.mock('../../shared/api/functions', async (orig) => ({
  ...(await orig<typeof import('../../shared/api/functions')>()),
  api: { createTransferInvite },
}));

// The operation layer is mocked but the real OpReverted class is kept: a timed-out send and a
// refused one are told apart by the sentinel reason that class carries.
const ticketOp = vi.fn();
vi.mock('../../shared/chain/ops', async (orig) => ({
  ...(await orig<typeof import('../../shared/chain/ops')>()),
  ticketOp,
}));
vi.mock('../../shared/chain/accounts', () => ({ getAttendeeAccount: async () => ({ address: ME }) }));

const ticket = { eventOf: vi.fn(), eventMeta: vi.fn(), offerOf: vi.fn() };
vi.mock('../../shared/chain/reads', async (orig) => ({
  ...(await orig<typeof import('../../shared/chain/reads')>()),
  readTicket: () => ticket,
}));

const { TransferInvite } = await import('./Invite');
const { InviteLanding, INVITE_KEY } = await import('./InviteLanding');
const { CallableError } = await import('../../shared/api/functions');
const { OpReverted } = await import('../../shared/chain/ops');

function Address() {
  return <span data-testid="address">{useLocation().pathname}</span>;
}

function renderInvite(state: unknown = { phoneE164: PHONE }) {
  return render(
    <MemoryRouter initialEntries={[{ pathname: '/tickets/1/transfer/invite', state }]}>
      <Routes>
        <Route path="/tickets/:tokenId/transfer" element={<span>받는 분 고르기</span>} />
        <Route path="/tickets/:tokenId/transfer/invite" element={<TransferInvite />} />
      </Routes>
      <Address />
    </MemoryRouter>,
  );
}

function renderLanding() {
  return render(
    <MemoryRouter initialEntries={['/i/i1']}>
      <Routes>
        <Route path="/i/:inviteId" element={<InviteLanding />} />
        <Route path="/signup/phone" element={<span>가입 시작</span>} />
        <Route path="/tickets/inbox" element={<span>받은 티켓함</span>} />
      </Routes>
      <Address />
    </MemoryRouter>,
  );
}

const send = async () => userEvent.click(await screen.findByRole('button', { name: '초대 문자 보내기' }));

beforeEach(() => {
  setSession({ status: 'signedIn', account: ME });
  sessionStorage.clear();
  createTransferInvite.mockReset();
  createTransferInvite.mockResolvedValue(INVITE);
  ticketOp.mockReset();
  ticketOp.mockResolvedValue({ success: true, txHash: '0x2', blockNumber: 1n });
  ticket.eventOf.mockResolvedValue(5n);
  ticket.eventMeta.mockResolvedValue({ orgId: 9n, requireKyc: false });
  // Nothing open on chain: an absent offer reads back as the zero struct, not as a failure.
  ticket.offerOf.mockResolvedValue({ from: ZERO_ADDRESS, recipientCommitment: NO_OFFER, expiresAt: 0n });
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn(async () => undefined) },
    configurable: true,
  });
});

afterEach(() => {
  cleanup();
  clearSession();
});

describe('TransferInvite', () => {
  it('asks the server for the invite first and only then puts the offer on chain', async () => {
    renderInvite();
    await send();

    expect(createTransferInvite).toHaveBeenCalledWith({ tokenId: '1', phoneE164: PHONE });
    expect(ticketOp).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: 9n,
        functionName: 'createOffer',
        args: [1n, COMMITMENT, BigInt(EXPIRES_AT)],
      }),
    );
    // The commitment can only come from the server's answer, so the order is not optional.
    expect(createTransferInvite.mock.invocationCallOrder[0]).toBeLessThan(
      ticketOp.mock.invocationCallOrder[0]!,
    );
    expect(await screen.findByText('초대를 보냈어요. 상대가 가입하면 티켓이 자동으로 전달됩니다.')).toBeInTheDocument();
  });

  it('hands the sms link to the person to tap, unrewritten, with the text as the fallback', async () => {
    renderInvite();
    await send();

    const link = await screen.findByRole('link', { name: '문자 앱 열기' });
    expect(link).toHaveAttribute('href', SMS_URI);
    expect(screen.getByText(SMS_TEXT)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '문구 복사' }));
    expect(await screen.findByText('복사했어요')).toBeInTheDocument();
  });

  it('shows no sms link when the offer never landed', async () => {
    ticketOp.mockRejectedValueOnce(new OpReverted('createOffer', '0xdeadbeef'));
    renderInvite();
    await send();

    expect(await screen.findByText('초대를 보내지 못했어요. 잠시 뒤 다시 시도해 주세요.')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '문자 앱 열기' })).toBeNull();
  });

  it('reads a timed-out send as still confirming, and still shows no link', async () => {
    ticketOp.mockRejectedValueOnce(new OpReverted('createOffer', 'TIMEOUT'));
    renderInvite();
    await send();

    expect(await screen.findByText('아직 확인 중이에요. 잠시 뒤 내 티켓에서 확인해 주세요.')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '문자 앱 열기' })).toBeNull();
    expect(screen.queryByText('초대를 보내지 못했어요. 잠시 뒤 다시 시도해 주세요.')).toBeNull();
  });

  it('gives the number back when the screen is opened without one', async () => {
    renderInvite({});
    expect(await screen.findByText('초대할 번호를 먼저 골라 주세요.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '초대 문자 보내기' })).toBeNull();
  });

  it('shows an offer already open on chain, and cancels it', async () => {
    ticket.offerOf.mockResolvedValue({ from: ME, recipientCommitment: COMMITMENT, expiresAt: BigInt(EXPIRES_AT) });
    renderInvite();

    const cancel = await screen.findByRole('button', { name: '초대 취소' });
    expect(createTransferInvite).not.toHaveBeenCalled();
    await userEvent.click(cancel);
    expect(ticketOp).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: 9n, functionName: 'cancelOffer', args: [1n] }),
    );
    expect(await screen.findByText('초대를 취소했어요')).toBeInTheDocument();
  });
});

/** Every reason `createTransferInvite` can refuse with owns one sentence. */
const SERVER_REFUSALS: ReadonlyArray<readonly [string, string, string]> = [
  ['failed-precondition', 'OFFER_ALREADY_OPEN', '이 티켓은 이미 다른 분에게 보내는 중이에요.'],
  ['permission-denied', 'NOT_TOKEN_OWNER', '내 티켓이 아니에요.'],
  ['invalid-argument', 'SELF_TRANSFER', '본인에게는 양도할 수 없어요.'],
  ['invalid-argument', 'BAD_PHONE', '번호를 다시 확인해 주세요.'],
  ['invalid-argument', 'BAD_TOKEN_ID', '입력한 내용을 다시 확인해 주세요.'],
];

describe('an invite the server refuses', () => {
  for (const [code, reason, sentence] of SERVER_REFUSALS) {
    it(`says what ${reason} means`, async () => {
      createTransferInvite.mockRejectedValueOnce(new CallableError(code as 'internal', reason));
      renderInvite();
      await send();
      expect(await screen.findByText(sentence)).toBeInTheDocument();
      expect(ticketOp).not.toHaveBeenCalled();
    });
  }
});

/**
 * `createOffer` re-checks the handover rules itself, and its two own refusals — the ticket is
 * not mine, the deadline it was given is already behind us — are not in `_update`'s eight.
 */
const OFFER_REVERTS: ReadonlyArray<readonly [string, string]> = [
  ['Unauthorized()', '내 티켓이 아니에요.'],
  ['OfferExpired()', '초대가 만료됐어요. 다시 보내 달라고 해 주세요.'],
  ['TransfersDisabled()', '이 행사는 양도할 수 없어요.'],
  ['AlreadyCheckedIn()', '이미 입장한 티켓이에요.'],
  ['TransferLimitReached()', '이 티켓은 더 이상 양도할 수 없어요.'],
];

describe('an offer the contract refuses', () => {
  for (const [signature, sentence] of OFFER_REVERTS) {
    it(`names the rule ${signature} is`, async () => {
      ticketOp.mockRejectedValueOnce(new OpReverted('createOffer', toFunctionSelector(signature)));
      renderInvite();
      await send();
      expect(await screen.findByText(sentence)).toBeInTheDocument();
    });
  }
});

describe('InviteLanding', () => {
  it('sends a signed-in attendee straight to the received tickets', async () => {
    renderLanding();
    expect(await screen.findByText('받은 티켓함')).toBeInTheDocument();
    expect(sessionStorage.getItem(INVITE_KEY)).toBeNull();
  });

  it('keeps the invite id over signup when nobody is signed in', async () => {
    setSession({ status: 'anonymous' });
    renderLanding();
    expect(await screen.findByText('가입 시작')).toBeInTheDocument();
    // The id is opaque: it is carried, never read.
    expect(sessionStorage.getItem(INVITE_KEY)).toBe('i1');
  });

  it('waits while the session is still hydrating', async () => {
    setSession({ status: 'loading' });
    renderLanding();
    expect(screen.getByTestId('address')).toHaveTextContent('/i/i1');
  });
});
