import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { decodeFunctionData } from 'viem';
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

// The relay client is mocked. A determinate refusal carries the contract error name in
// `details.code`, exactly as `sendAction` rejects on a failed relay doc; an unknown outcome — a
// dropped relay listener — carries none, and the screen reads that as still confirming.
const sendAction = vi.fn();
vi.mock('../../shared/relay/sendAction', () => ({ sendAction }));

const ticket = { eventOf: vi.fn(), eventMeta: vi.fn(), offerOf: vi.fn() };
vi.mock('../../shared/chain/reads', async (orig) => ({
  ...(await orig<typeof import('../../shared/chain/reads')>()),
  readTicket: () => ticket,
}));

const { TransferInvite } = await import('./Invite');
const { InviteLanding, INVITE_KEY } = await import('./InviteLanding');
const { CallableError } = await import('../../shared/api/functions');
const { ticketAbi } = await import('../../shared/chain/abis');

/** A relay refusal that names the contract error, the way `sendAction` rejects on a failed doc. */
const reverted = (code: string) => new CallableError('failed-precondition', code, { code });
/** An unknown outcome: a dropped relay listener rejects with no `details.code`. */
const dropped = () => new Error('relay listener dropped');

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

const send = async () => userEvent.click(await screen.findByRole('button', { name: 'Send invite by text' }));

beforeEach(() => {
  setSession({ status: 'signedIn', account: ME });
  sessionStorage.clear();
  createTransferInvite.mockReset();
  createTransferInvite.mockResolvedValue(INVITE);
  sendAction.mockReset();
  sendAction.mockResolvedValue(undefined);
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
    const [kind, target, data] = sendAction.mock.calls[0]!;
    expect([kind, target]).toEqual(['createOffer', 'ticket']);
    expect(decodeFunctionData({ abi: ticketAbi, data })).toEqual({
      functionName: 'createOffer',
      args: [1n, COMMITMENT, BigInt(EXPIRES_AT)],
    });
    // The commitment can only come from the server's answer, so the order is not optional.
    expect(createTransferInvite.mock.invocationCallOrder[0]).toBeLessThan(
      sendAction.mock.invocationCallOrder[0]!,
    );
    expect(await screen.findByText('Invite sent. The ticket moves automatically once they sign up.')).toBeInTheDocument();
  });

  it('hands the sms link to the person to tap, unrewritten, with the text as the fallback', async () => {
    renderInvite();
    await send();

    const link = await screen.findByRole('link', { name: 'Open my texts' });
    expect(link).toHaveAttribute('href', SMS_URI);
    expect(screen.getByText(SMS_TEXT)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Copy the message' }));
    expect(await screen.findByText('Copied')).toBeInTheDocument();
  });

  it('shows no sms link when the offer never landed', async () => {
    sendAction.mockRejectedValueOnce(reverted('SomethingUnmapped'));
    renderInvite();
    await send();

    expect(await screen.findByText('Could not send the invite. Please try again in a moment.')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Open my texts' })).toBeNull();
  });

  it('reads a timed-out send as still confirming, and still shows no link', async () => {
    sendAction.mockRejectedValueOnce(dropped());
    renderInvite();
    await send();

    expect(await screen.findByText('Still confirming. Please check My tickets in a moment.')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Open my texts' })).toBeNull();
    expect(screen.queryByText('Could not send the invite. Please try again in a moment.')).toBeNull();
    // Never a dead screen: the send stays visible but disabled, and there is a way forward.
    expect(screen.getByRole('button', { name: 'Send invite by text' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('asks the chain again after a timeout and finds the offer landed', async () => {
    sendAction.mockRejectedValueOnce(dropped());
    renderInvite();
    await send();
    await screen.findByText('Still confirming. Please check My tickets in a moment.');

    ticket.offerOf.mockResolvedValue({ from: ME, recipientCommitment: COMMITMENT, expiresAt: BigInt(EXPIRES_AT) });
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('button', { name: 'Cancel invite' })).toBeInTheDocument();
  });

  it('never opens the message itself — the person taps the link', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign } as unknown as Location);
    renderInvite();
    await send();

    expect(await screen.findByRole('link', { name: 'Open my texts' })).toBeInTheDocument();
    expect(assign).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('mentions the verification only on an event that asks for it', async () => {
    const note = 'After signing up they must verify their ID to receive the ticket.';
    renderInvite();
    await screen.findByRole('button', { name: 'Send invite by text' });
    expect(screen.queryByText(note)).toBeNull();

    cleanup();
    ticket.eventMeta.mockResolvedValue({ orgId: 9n, requireKyc: true });
    renderInvite();
    expect(await screen.findByText(note)).toBeInTheDocument();
  });

  it('gives the number back when the screen is opened without one', async () => {
    renderInvite({});
    expect(await screen.findByText('Choose the number to invite first.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send invite by text' })).toBeNull();
  });

  it('hands the message back for an offer that is already on chain', async () => {
    // A reload, or a send whose receipt timed out: the offer is live and the message is gone.
    ticket.offerOf.mockResolvedValue({ from: ME, recipientCommitment: COMMITMENT, expiresAt: BigInt(EXPIRES_AT) });
    renderInvite();

    expect(await screen.findByText('This invite is already out. You can get the message again.')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Open my texts' })).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Get the message again' }));
    expect(createTransferInvite).toHaveBeenCalledWith({ tokenId: '1', phoneE164: PHONE });
    // The offer is already there, so nothing new goes on chain.
    expect(sendAction).not.toHaveBeenCalled();
    expect(await screen.findByRole('link', { name: 'Open my texts' })).toHaveAttribute('href', SMS_URI);
  });

  it('says so when the ticket is already on its way to somebody else', async () => {
    ticket.offerOf.mockResolvedValue({ from: ME, recipientCommitment: COMMITMENT, expiresAt: BigInt(EXPIRES_AT) });
    createTransferInvite.mockRejectedValueOnce(new CallableError('failed-precondition', 'OFFER_ALREADY_OPEN'));
    renderInvite();

    await userEvent.click(await screen.findByRole('button', { name: 'Get the message again' }));
    expect(await screen.findByText('This ticket is already on its way to someone else.')).toBeInTheDocument();
  });

  it('shows an offer already open on chain, and cancels it', async () => {
    ticket.offerOf.mockResolvedValue({ from: ME, recipientCommitment: COMMITMENT, expiresAt: BigInt(EXPIRES_AT) });
    renderInvite();

    const cancel = await screen.findByRole('button', { name: 'Cancel invite' });
    expect(createTransferInvite).not.toHaveBeenCalled();
    await userEvent.click(cancel);
    const [kind, target, data] = sendAction.mock.calls[0]!;
    expect([kind, target]).toEqual(['cancelOffer', 'ticket']);
    expect(decodeFunctionData({ abi: ticketAbi, data })).toEqual({ functionName: 'cancelOffer', args: [1n] });
    expect(await screen.findByText('Invite cancelled')).toBeInTheDocument();
  });
});

/** Every reason `createTransferInvite` can refuse with owns one sentence. */
const SERVER_REFUSALS: ReadonlyArray<readonly [string, string, string]> = [
  ['failed-precondition', 'OFFER_ALREADY_OPEN', 'This ticket is already on its way to someone else.'],
  ['permission-denied', 'NOT_TOKEN_OWNER', 'This ticket is not yours.'],
  ['invalid-argument', 'SELF_TRANSFER', 'You cannot give it to yourself.'],
  ['invalid-argument', 'BAD_PHONE', 'Please check that number.'],
  ['invalid-argument', 'BAD_TOKEN_ID', 'Please check what you entered.'],
];

describe('an invite the server refuses', () => {
  for (const [code, reason, sentence] of SERVER_REFUSALS) {
    it(`says what ${reason} means`, async () => {
      createTransferInvite.mockRejectedValueOnce(new CallableError(code as 'internal', reason));
      renderInvite();
      await send();
      expect(await screen.findByText(sentence)).toBeInTheDocument();
      expect(sendAction).not.toHaveBeenCalled();
    });
  }
});

/**
 * `createOffer` re-checks the handover rules itself, and its two own refusals — the ticket is
 * not mine, the deadline it was given is already behind us — are not in `_update`'s eight.
 */
const OFFER_REVERTS: ReadonlyArray<readonly [string, string]> = [
  ['Unauthorized', 'This ticket is not yours.'],
  ['OfferExpired', 'The invite expired. Ask them to send a new one.'],
  ['TransfersDisabled', 'This event does not allow giving tickets away.'],
  ['AlreadyCheckedIn', 'This ticket has already been used.'],
  ['TransferLimitReached', 'This ticket cannot be given away again.'],
];

describe('an offer the contract refuses', () => {
  for (const [name, sentence] of OFFER_REVERTS) {
    it(`names the rule ${name} is`, async () => {
      sendAction.mockRejectedValueOnce(reverted(name));
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
