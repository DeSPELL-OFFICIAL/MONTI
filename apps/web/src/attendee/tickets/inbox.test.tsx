import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { decodeFunctionData } from 'viem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearSession, setSession } from '../../shared/session';

const ME = `0x${'aa'.repeat(20)}` as const;
const SIG = `0x${'dd'.repeat(65)}` as const;

const pendingOffers = vi.fn();
vi.mock('../../shared/api/functions', async (orig) => ({
  ...(await orig<typeof import('../../shared/api/functions')>()),
  api: { pendingOffers },
}));

// The relay client is mocked. A determinate refusal carries the contract error name in
// `details.code`; an unknown outcome (a dropped relay listener) carries none, and the inbox reads
// that as still confirming rather than as a refusal.
const sendAction = vi.fn();
vi.mock('../../shared/relay/sendAction', () => ({ sendAction }));

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
const { CallableError } = await import('../../shared/api/functions');
const { ticketAbi } = await import('../../shared/chain/abis');

/** A relay refusal that names the contract error, the way `sendAction` rejects on a failed doc. */
const reverted = (code: string) => new CallableError('failed-precondition', code, { code });
/** An unknown outcome: a dropped relay listener rejects with no `details.code`. */
const dropped = () => new Error('relay listener dropped');

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

const accept = async () => userEvent.click((await screen.findAllByRole('button', { name: 'Accept' }))[0]!);

beforeEach(() => {
  setSession({ status: 'signedIn', account: ME });
  pendingOffers.mockReset();
  pendingOffers.mockResolvedValue([{ tokenId: '1', attesterSig: SIG, inviteId: 'i1' }]);
  sendAction.mockReset();
  sendAction.mockResolvedValue(undefined);
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
    expect(await screen.findByText('No tickets from friends yet.')).toBeInTheDocument();
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
    expect(await screen.findByRole('button', { name: 'Accept' })).toBeInTheDocument();
  });

  it('keeps every row answering for itself', async () => {
    pendingOffers.mockResolvedValue([
      { tokenId: '1', attesterSig: SIG, inviteId: 'i1' },
      { tokenId: '7', attesterSig: SIG, inviteId: 'i2' },
    ]);
    sendAction.mockRejectedValueOnce(reverted('OfferExpired'));
    renderInbox();
    const rows = await screen.findAllByRole('listitem');
    const expired = 'The invite expired. Ask them to send a new one.';

    await userEvent.click(within(rows[0]!).getByRole('button', { name: 'Accept' }));
    expect(await within(rows[0]!).findByText(expired)).toBeInTheDocument();
    // One refusal says nothing about the row next to it, and does not disable its button.
    expect(within(rows[1]!).queryByText(expired)).toBeNull();
    expect(within(rows[1]!).getByRole('button', { name: 'Accept' })).toBeEnabled();

    await userEvent.click(within(rows[1]!).getByRole('button', { name: 'Accept' }));
    expect(await within(rows[1]!).findByText('Ticket received')).toBeInTheDocument();
    expect(within(rows[0]!).queryByText('Ticket received')).toBeNull();
  });

  it('lists what is waiting and takes one', async () => {
    pendingOffers.mockResolvedValue([
      { tokenId: '1', attesterSig: SIG, inviteId: 'i1' },
      { tokenId: '7', attesterSig: SIG, inviteId: 'i2' },
    ]);
    renderInbox();
    expect(await screen.findByText('2 waiting for you')).toBeInTheDocument();

    await accept();
    const [kind, target, data] = sendAction.mock.calls[0]!;
    expect([kind, target]).toEqual(['acceptOffer', 'ticket']);
    expect(decodeFunctionData({ abi: ticketAbi, data })).toEqual({ functionName: 'acceptOffer', args: [1n, SIG] });
    expect(await screen.findByText('Ticket received')).toBeInTheDocument();
  });

  it('sends an unverified attendee to verify instead of offering the button', async () => {
    ticket.eventMeta.mockResolvedValue({ orgId: 9n, requireKyc: true });
    renderInbox();

    expect(await screen.findByText('Verify your identity to accept')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Accept' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Verify my identity' }));
    expect(await screen.findByText('본인인증 화면')).toBeInTheDocument();
    expect(sendAction).not.toHaveBeenCalled();
  });

  it('keeps the button for a verified attendee on an event that asks for it', async () => {
    ticket.eventMeta.mockResolvedValue({ orgId: 9n, requireKyc: true });
    identity.kycLevelOf.mockResolvedValue(1);
    renderInbox();
    await accept();
    const [kind, target, data] = sendAction.mock.calls[0]!;
    expect([kind, target]).toEqual(['acceptOffer', 'ticket']);
    expect(decodeFunctionData({ abi: ticketAbi, data })).toEqual({ functionName: 'acceptOffer', args: [1n, SIG] });
  });

  it('reads a timed-out accept as still confirming, never as a refusal', async () => {
    sendAction.mockRejectedValueOnce(dropped());
    renderInbox();
    await accept();
    expect(await screen.findByText('Still confirming. Please check My tickets in a moment.')).toBeInTheDocument();
    expect(screen.queryByText('Could not accept the ticket. Please try again in a moment.')).toBeNull();
  });
});

/** `acceptOffer` has its own refusals on top of the eight `_update` shares with a handover. */
const ACCEPT_REVERTS: ReadonlyArray<readonly [string, string]> = [
  ['NoOffer', 'This invite is no longer there.'],
  ['OfferExpired', 'The invite expired. Ask them to send a new one.'],
  ['BadAttesterSig', 'This invite was sent to someone else.'],
  ['KycRequired', 'Verify your identity to accept'],
  ['NotMember', 'Please finish signing up first.'],
  ['MaxPerWalletExceeded', 'You already hold the maximum number of tickets for this event.'],
];

describe('an accept the contract refuses', () => {
  for (const [name, sentence] of ACCEPT_REVERTS) {
    it(`says what ${name} means`, async () => {
      sendAction.mockRejectedValueOnce(reverted(name));
      renderInbox();
      await accept();
      expect(await screen.findByText(sentence)).toBeInTheDocument();
    });
  }

  it('keeps the generic sentence for a refusal nothing here knows', async () => {
    sendAction.mockRejectedValueOnce(reverted('SomethingUnmapped'));
    renderInbox();
    await accept();
    expect(await screen.findByText('Could not accept the ticket. Please try again in a moment.')).toBeInTheDocument();
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
    sendAction.mockResolvedValueOnce(undefined);
    sendAction.mockRejectedValueOnce(reverted('KycRequired'));
    sendAction.mockResolvedValueOnce(undefined);

    // One reverting row must not abort the rest of the inbox.
    expect(await acceptPendingOffers()).toBe(2);
    expect(sendAction).toHaveBeenCalledTimes(3);
  });

  it('counts nothing, and asks the chain nothing, when the inbox is empty', async () => {
    pendingOffers.mockResolvedValue([]);
    expect(await acceptPendingOffers()).toBe(0);
    expect(sendAction).not.toHaveBeenCalled();
  });

  it('relays one acceptOffer per row without deriving the event organisation', async () => {
    // The relayer sponsors the collect, so nothing here reads the chain for an orgId.
    expect(await acceptPendingOffers()).toBe(1);
    expect(sendAction).toHaveBeenCalledTimes(1);
    const [kind, target] = sendAction.mock.calls[0]!;
    expect([kind, target]).toEqual(['acceptOffer', 'ticket']);
    expect(ticket.eventOf).not.toHaveBeenCalled();
  });
});
