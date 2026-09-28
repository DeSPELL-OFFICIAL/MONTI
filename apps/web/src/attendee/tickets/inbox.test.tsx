import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { toFunctionSelector } from 'viem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearSession, setSession } from '../../shared/session';

const ME = `0x${'aa'.repeat(20)}` as const;
const SIG = `0x${'dd'.repeat(65)}` as const;

const pendingOffers = vi.fn();
vi.mock('../../shared/api/functions', async (orig) => ({
  ...(await orig<typeof import('../../shared/api/functions')>()),
  api: { pendingOffers },
}));

// The real OpReverted stays: the inbox tells a refusal from a send still on its way by it.
const ticketOp = vi.fn();
vi.mock('../../shared/chain/ops', async (orig) => ({
  ...(await orig<typeof import('../../shared/chain/ops')>()),
  ticketOp,
}));
vi.mock('../../shared/chain/accounts', () => ({ getAttendeeAccount: async () => ({ address: ME }) }));

// The readable half of an event lives in one IPFS document; the row asks for it by the CID
// `eventMeta` already handed over, so naming the event costs no extra chain read.
const fetchEventMetadata = vi.fn();
vi.mock('../../shared/envio/ipfs', async (orig) => ({
  ...(await orig<typeof import('../../shared/envio/ipfs')>()),
  fetchEventMetadata,
}));

const ticket = { eventOf: vi.fn(), eventMeta: vi.fn() };
const identity = { kycLevelOf: vi.fn() };
vi.mock('../../shared/chain/reads', async (orig) => ({
  ...(await orig<typeof import('../../shared/chain/reads')>()),
  readTicket: () => ticket,
  readIdentity: () => identity,
}));

const { Inbox, acceptPendingOffers } = await import('./Inbox');
const { OpReverted } = await import('../../shared/chain/ops');

function renderInbox() {
  // Its own client per render: a cached answer from the test before would decide this one.
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/tickets/inbox']}>
        <Routes>
          <Route path="/tickets/inbox" element={<Inbox />} />
          <Route path="/me/verify" element={<span>본인인증 화면</span>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const accept = async () => userEvent.click((await screen.findAllByRole('button', { name: '받기' }))[0]!);

beforeEach(() => {
  setSession({ status: 'signedIn', account: ME });
  pendingOffers.mockReset();
  pendingOffers.mockResolvedValue([{ tokenId: '1', attesterSig: SIG, inviteId: 'i1' }]);
  ticketOp.mockReset();
  ticketOp.mockResolvedValue({ success: true, txHash: '0x2', blockNumber: 1n });
  ticket.eventOf.mockResolvedValue(5n);
  ticket.eventMeta.mockResolvedValue({ orgId: 9n, requireKyc: false, imageCid: 'bafkcid' });
  identity.kycLevelOf.mockResolvedValue(0);
  fetchEventMetadata.mockReset();
  fetchEventMetadata.mockResolvedValue({ title: '한여름 밤의 재즈', description: '', image: '', venue: '', category: 0, region: '' });
});

afterEach(() => {
  cleanup();
  clearSession();
});

describe('Inbox', () => {
  it('says so when nothing is waiting', async () => {
    pendingOffers.mockResolvedValue([]);
    renderInbox();
    expect(await screen.findByText('친구가 보낸 티켓이 없어요.')).toBeInTheDocument();
  });

  it('names the event, because its reader has never seen it', async () => {
    renderInbox();
    expect(await screen.findByText('한여름 밤의 재즈')).toBeInTheDocument();
    expect(fetchEventMetadata).toHaveBeenCalledWith('bafkcid');
    expect(screen.queryByText('#1')).toBeNull();
  });

  it('falls back to the ticket number when the document will not load', async () => {
    fetchEventMetadata.mockRejectedValue(new Error('IPFS_404'));
    renderInbox();
    // A document nobody can load is not a reason to hide an invite.
    expect(await screen.findByText('#1')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: '받기' })).toBeInTheDocument();
  });

  it('keeps every row answering for itself', async () => {
    pendingOffers.mockResolvedValue([
      { tokenId: '1', attesterSig: SIG, inviteId: 'i1' },
      { tokenId: '7', attesterSig: SIG, inviteId: 'i2' },
    ]);
    ticketOp.mockRejectedValueOnce(new OpReverted('acceptOffer', toFunctionSelector('OfferExpired()')));
    renderInbox();
    const rows = await screen.findAllByRole('listitem');
    const expired = '초대가 만료됐어요. 다시 보내 달라고 해 주세요.';

    await userEvent.click(within(rows[0]!).getByRole('button', { name: '받기' }));
    expect(await within(rows[0]!).findByText(expired)).toBeInTheDocument();
    // One refusal says nothing about the row next to it, and does not disable its button.
    expect(within(rows[1]!).queryByText(expired)).toBeNull();
    expect(within(rows[1]!).getByRole('button', { name: '받기' })).toBeEnabled();

    await userEvent.click(within(rows[1]!).getByRole('button', { name: '받기' }));
    expect(await within(rows[1]!).findByText('티켓을 받았어요')).toBeInTheDocument();
    expect(within(rows[0]!).queryByText('티켓을 받았어요')).toBeNull();
  });

  it('lists what is waiting and takes one', async () => {
    pendingOffers.mockResolvedValue([
      { tokenId: '1', attesterSig: SIG, inviteId: 'i1' },
      { tokenId: '7', attesterSig: SIG, inviteId: 'i2' },
    ]);
    renderInbox();
    expect(await screen.findByText('2장이 기다리고 있어요')).toBeInTheDocument();

    await accept();
    expect(ticketOp).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: 9n, functionName: 'acceptOffer', args: [1n, SIG] }),
    );
    expect(await screen.findByText('티켓을 받았어요')).toBeInTheDocument();
  });

  it('sends an unverified attendee to verify instead of offering the button', async () => {
    ticket.eventMeta.mockResolvedValue({ orgId: 9n, requireKyc: true });
    renderInbox();

    expect(await screen.findByText('본인인증 후 받을 수 있어요')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '받기' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: '본인인증 하기' }));
    expect(await screen.findByText('본인인증 화면')).toBeInTheDocument();
    expect(ticketOp).not.toHaveBeenCalled();
  });

  it('keeps the button for a verified attendee on an event that asks for it', async () => {
    ticket.eventMeta.mockResolvedValue({ orgId: 9n, requireKyc: true });
    identity.kycLevelOf.mockResolvedValue(1);
    renderInbox();
    await accept();
    expect(ticketOp).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: 'acceptOffer', args: [1n, SIG] }),
    );
  });

  it('reads a timed-out accept as still confirming, never as a refusal', async () => {
    ticketOp.mockRejectedValueOnce(new OpReverted('acceptOffer', 'TIMEOUT'));
    renderInbox();
    await accept();
    expect(await screen.findByText('아직 확인 중이에요. 잠시 뒤 내 티켓에서 확인해 주세요.')).toBeInTheDocument();
    expect(screen.queryByText('티켓을 받지 못했어요. 잠시 뒤 다시 시도해 주세요.')).toBeNull();
  });
});

/** `acceptOffer` has its own refusals on top of the eight `_update` shares with a handover. */
const ACCEPT_REVERTS: ReadonlyArray<readonly [string, string]> = [
  ['NoOffer()', '이 초대는 더 이상 남아 있지 않아요.'],
  ['OfferExpired()', '초대가 만료됐어요. 다시 보내 달라고 해 주세요.'],
  ['BadAttesterSig()', '이 초대는 다른 분에게 온 거예요.'],
  ['KycRequired()', '본인인증 후 받을 수 있어요'],
  ['NotMember()', '가입을 먼저 마쳐 주세요.'],
  ['MaxPerWalletExceeded()', '이 행사 티켓을 이미 최대 수만큼 갖고 있어요.'],
];

describe('an accept the contract refuses', () => {
  for (const [signature, sentence] of ACCEPT_REVERTS) {
    it(`says what ${signature} means`, async () => {
      ticketOp.mockRejectedValueOnce(new OpReverted('acceptOffer', toFunctionSelector(signature)));
      renderInbox();
      await accept();
      expect(await screen.findByText(sentence)).toBeInTheDocument();
    });
  }

  it('keeps the generic sentence for a refusal nothing here knows', async () => {
    ticketOp.mockRejectedValueOnce(new OpReverted('acceptOffer', '0xdeadbeef'));
    renderInbox();
    await accept();
    expect(await screen.findByText('티켓을 받지 못했어요. 잠시 뒤 다시 시도해 주세요.')).toBeInTheDocument();
  });
});

describe('acceptPendingOffers', () => {
  it('takes every row it can and counts them', async () => {
    pendingOffers.mockResolvedValue([
      { tokenId: '1', attesterSig: SIG, inviteId: 'i1' },
      { tokenId: '2', attesterSig: SIG, inviteId: 'i2' },
      { tokenId: '3', attesterSig: SIG, inviteId: 'i3' },
    ]);
    // The middle one is gated on a verification this attendee has not done.
    ticketOp.mockResolvedValueOnce({ success: true, txHash: '0x1', blockNumber: 1n });
    ticketOp.mockRejectedValueOnce(new OpReverted('acceptOffer', toFunctionSelector('KycRequired()')));
    ticketOp.mockResolvedValueOnce({ success: true, txHash: '0x3', blockNumber: 1n });

    // One reverting row must not abort the rest of the inbox.
    expect(await acceptPendingOffers()).toBe(2);
    expect(ticketOp).toHaveBeenCalledTimes(3);
  });

  it('counts nothing, and asks the chain nothing, when the inbox is empty', async () => {
    pendingOffers.mockResolvedValue([]);
    expect(await acceptPendingOffers()).toBe(0);
    expect(ticketOp).not.toHaveBeenCalled();
  });

  it('takes the org the operation is sponsored by from the caller when it is given one', async () => {
    const orgIdOf = vi.fn(async () => 42n);
    expect(await acceptPendingOffers(orgIdOf)).toBe(1);
    expect(orgIdOf).toHaveBeenCalledWith(1n);
    expect(ticketOp).toHaveBeenCalledWith(expect.objectContaining({ orgId: 42n }));
    expect(ticket.eventOf).not.toHaveBeenCalled();
  });
});
