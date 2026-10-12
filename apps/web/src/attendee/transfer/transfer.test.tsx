import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { decodeFunctionData } from 'viem';
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

// The relay client is mocked. A determinate refusal carries the contract error name in
// `details.code`; an unknown outcome (a dropped relay listener) carries none, and the screen
// reads that as still confirming rather than as a refusal.
const sendAction = vi.fn();
vi.mock('../../shared/relay/sendAction', () => ({ sendAction }));

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
const { ticketAbi } = await import('../../shared/chain/abis');
const { matchByName, revertRuleByName } = await import('./useTransfer');
const { acceptFailure } = await import('./offers');
const { en } = await import('../../shared/copy/index');

/** A relay refusal that names the contract error, the way `sendAction` rejects on a failed doc. */
const reverted = (code: string) => new CallableError('failed-precondition', code, { code });
/** An unknown outcome: a dropped relay listener rejects with no `details.code`. */
const dropped = () => new Error('relay listener dropped');

const NOW = Math.floor(Date.now() / 1000);
const TIER = { name: 'General', priceUsdCents: 0n, supply: 100, minted: 1, maxPerWallet: 2, seated: false };

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
  sendAction.mockReset();
  sendAction.mockResolvedValue(undefined);
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
  await userEvent.click(screen.getByRole('button', { name: 'Find' }));
}

describe('TransferRecipient', () => {
  it('finds a member by nickname and carries the name to the confirm screen', async () => {
    resolveRecipient.mockResolvedValue({ member: true, account: YOU, nickname: 'bob' });
    renderFlow('/tickets/1/transfer');
    await find('Nickname', 'Bob');
    expect(resolveRecipient).toHaveBeenCalledWith({ type: 'nickname', value: 'Bob' });
    expect(await screen.findByRole('heading', { name: 'Give the ticket to this person?' })).toBeInTheDocument();
    expect(screen.getByText('bob')).toBeInTheDocument();
  });

  it('finds a member by account address', async () => {
    resolveRecipient.mockResolvedValue({ member: true, account: YOU });
    renderFlow('/tickets/1/transfer');
    await find('Address', YOU);
    expect(resolveRecipient).toHaveBeenCalledWith({ type: 'address', value: YOU });
    expect(await screen.findByText(YOU)).toBeInTheDocument();
  });

  it('sends the phone number in E.164 and confirms a member', async () => {
    resolveRecipient.mockResolvedValue({ member: true, account: YOU, commitment: `0x${'cc'.repeat(32)}` });
    renderFlow('/tickets/1/transfer');
    await find('Phone', '01012345678');
    expect(resolveRecipient).toHaveBeenCalledWith({ type: 'phone', value: '+821012345678' });
    expect(await screen.findByRole('heading', { name: 'Give the ticket to this person?' })).toBeInTheDocument();
  });

  it('hands a number that belongs to nobody over to the invite path', async () => {
    resolveRecipient.mockResolvedValue({ member: false, commitment: `0x${'cc'.repeat(32)}` });
    renderFlow('/tickets/1/transfer');
    await find('Phone', '01012345678');
    expect(await screen.findByRole('heading', { name: 'This number has not signed up yet' })).toBeInTheDocument();
    expect(screen.getByTestId('address')).toHaveTextContent('/tickets/1/transfer');
  });

  it('says so when the nickname belongs to nobody', async () => {
    resolveRecipient.mockRejectedValue(new CallableError('not-found', 'NICKNAME_UNKNOWN'));
    renderFlow('/tickets/1/transfer');
    await find('Nickname', 'ghost');
    expect(await screen.findByText('Not found.')).toBeInTheDocument();
  });

  it('turns the server refusals into their own sentences', async () => {
    resolveRecipient.mockRejectedValue(new CallableError('failed-precondition', 'NOT_A_MEMBER'));
    const view = renderFlow('/tickets/1/transfer');
    await find('Address', YOU);
    expect(await screen.findByText('They have not signed up yet.')).toBeInTheDocument();
    view.unmount();

    resolveRecipient.mockRejectedValue(new CallableError('invalid-argument', 'SELF_TRANSFER'));
    renderFlow('/tickets/1/transfer');
    await find('Nickname', 'me');
    expect(await screen.findByText('You cannot give it to yourself.')).toBeInTheDocument();
  });
});

describe('TransferConfirm', () => {
  it('runs the pre-check and sends one relayed handover', async () => {
    renderFlow(CONFIRM);
    await userEvent.click(screen.getByRole('button', { name: 'Give to a friend' }));
    const [kind, target, data] = sendAction.mock.calls[0]!;
    expect([kind, target]).toEqual(['safeTransferFrom', 'ticket']);
    const decoded = decodeFunctionData({ abi: ticketAbi, data });
    expect(decoded.functionName).toBe('safeTransferFrom');
    // `decodeFunctionData` checksums addresses; the fixtures are lower-case, so compare folded.
    expect(decoded.args?.map((a) => (typeof a === 'string' ? a.toLowerCase() : a))).toEqual([ME, YOU, 1n]);
    expect(await screen.findByText('내 티켓 목록')).toBeInTheDocument();
  });

  it('blocks on a failing pre-check instead of spending an operation', async () => {
    identity.isMember.mockResolvedValue(false);
    renderFlow(CONFIRM);
    await userEvent.click(screen.getByRole('button', { name: 'Give to a friend' }));
    expect(await screen.findByText('They have not signed up yet.')).toBeInTheDocument();
    expect(sendAction).not.toHaveBeenCalled();
  });

  it('blocks an unverified recipient on an event that requires verification', async () => {
    ticket.eventMeta.mockResolvedValue({
      orgId: 9n, startsAt: BigInt(NOW + 86_400), transferCutoffSeconds: 3600,
      maxTransfers: 3, transferable: true, requireKyc: true,
    });
    identity.kycLevelOf.mockResolvedValue(0);
    renderFlow(CONFIRM);
    await userEvent.click(screen.getByRole('button', { name: 'Give to a friend' }));
    expect(await screen.findByText('That person has not verified their identity.')).toBeInTheDocument();
    expect(sendAction).not.toHaveBeenCalled();
  });

  it('reads an unknown outcome as still confirming, not as a failure', async () => {
    sendAction.mockRejectedValueOnce(dropped());
    renderFlow(CONFIRM);
    const cta = screen.getByRole('button', { name: 'Give to a friend' });
    await userEvent.click(cta);
    expect(await screen.findByText('Still confirming. Please check My tickets in a moment.')).toBeInTheDocument();
    expect(screen.queryByText('Could not give the ticket away. Please try again in a moment.')).not.toBeInTheDocument();
    expect(cta).toBeDisabled();
    await userEvent.click(cta);
    expect(sendAction).toHaveBeenCalledTimes(1);
  });

  it('shows the failure sentence when the handover reverts', async () => {
    sendAction.mockRejectedValueOnce(reverted('SomethingUnmapped'));
    renderFlow(CONFIRM);
    await userEvent.click(screen.getByRole('button', { name: 'Give to a friend' }));
    expect(await screen.findByText('Could not give the ticket away. Please try again in a moment.')).toBeInTheDocument();
  });

  it('offers the way back when the screen is opened without a recipient', async () => {
    renderFlow('/tickets/1/transfer/confirm');
    // Its own sentence: nothing was searched for here, so "not found" would not be true.
    expect(await screen.findByText('Choose who gets the ticket first.')).toBeInTheDocument();
    expect(sendAction).not.toHaveBeenCalled();
  });
});

/**
 * The pre-check reads a moment before the operation runs, so a rule can flip underneath it.
 * The chain then names the rule it refused on in the first four bytes of the revert data, and
 * every one of those rules already owns a sentence — signatures written out here rather than
 * read back from the ABI, so this pins the selectors independently.
 */
const REVERT_SENTENCES: ReadonlyArray<readonly [string, string]> = [
  ['TicketRevoked', 'This ticket was voided, so it cannot be given away.'],
  ['TransfersDisabled', 'This event does not allow giving tickets away.'],
  ['AlreadyCheckedIn', 'This ticket has already been used.'],
  ['TransferCutoffPassed', 'The time to give it away has passed.'],
  ['NotMember', 'They have not signed up yet.'],
  ['KycRequired', 'That person has not verified their identity.'],
  ['TransferLimitReached', 'This ticket cannot be given away again.'],
  ['MaxPerWalletExceeded', 'They already hold the maximum number of tickets for this event.'],
];

const GENERIC = 'Could not give the ticket away. Please try again in a moment.';

describe('mapping a revert by name', () => {
  it('matches a screen table entry by the contract error name the relayer reported', () => {
    const table = [['TicketRevoked', 'x']] as const;
    expect(matchByName('TicketRevoked', table)).toBe('x');
    // A name no table entry carries is not a match, so the screen falls back to the generic one.
    expect(matchByName('AnErrorNoTableCarries', table)).toBeUndefined();
  });

  it('maps a handover rule name to the pre-check failure that owns its sentence', () => {
    expect(revertRuleByName('TicketRevoked')).toBe('revoked');
    expect(revertRuleByName('NotAHandoverRule')).toBeUndefined();
  });
});

describe('a handover the contract refuses', () => {
  for (const [name, sentence] of REVERT_SENTENCES) {
    it(`says which rule ${name} is`, async () => {
      sendAction.mockRejectedValueOnce(reverted(name));
      renderFlow(CONFIRM);
      await userEvent.click(screen.getByRole('button', { name: 'Give to a friend' }));
      expect(await screen.findByText(sentence)).toBeInTheDocument();
      expect(screen.queryByText(GENERIC)).not.toBeInTheDocument();
    });
  }

  it('keeps the generic sentence for a code nothing here knows', async () => {
    sendAction.mockRejectedValueOnce(reverted('SomethingUnmapped'));
    renderFlow(CONFIRM);
    await userEvent.click(screen.getByRole('button', { name: 'Give to a friend' }));
    expect(await screen.findByText(GENERIC)).toBeInTheDocument();
  });

  it('still reads an unknown outcome as confirming, never as a refusal', async () => {
    sendAction.mockRejectedValueOnce(dropped());
    renderFlow(CONFIRM);
    await userEvent.click(screen.getByRole('button', { name: 'Give to a friend' }));
    expect(await screen.findByText('Still confirming. Please check My tickets in a moment.')).toBeInTheDocument();
    expect(screen.queryByText(GENERIC)).not.toBeInTheDocument();
  });

  /**
   * 01b's rotation quarantine is read off the RECIPIENT's person, and the pre-check cannot ask
   * the same question — it would need `Identity.personOf`, which this app does not read — so it
   * is the one refusal here that arrives without a rule behind it.
   */
  it('names the move the recipient just made when the quarantine refuses a handover', async () => {
    sendAction.mockRejectedValueOnce(reverted('RotationPending'));
    renderFlow(CONFIRM);
    await userEvent.click(screen.getByRole('button', { name: 'Give to a friend' }));
    expect(await screen.findByText(en.transfer.alertRecipientMoved)).toBeInTheDocument();
    expect(screen.queryByText(GENERIC)).not.toBeInTheDocument();
  });

  it('keeps the generic sentence for a lock, rather than naming a phone it cannot know', async () => {
    // `_update` raises `DeviceLocked` for the sender and the recipient alike, and
    // `alertLocked` names the recipient's phone. Half the time that would be the wrong phone,
    // which is worse than saying less. The recipient's lock is caught before the send anyway.
    sendAction.mockRejectedValueOnce(reverted('DeviceLocked'));
    renderFlow(CONFIRM);
    await userEvent.click(screen.getByRole('button', { name: 'Give to a friend' }));
    expect(await screen.findByText(GENERIC)).toBeInTheDocument();
    expect(screen.queryByText(en.transfer.alertLocked)).not.toBeInTheDocument();
  });
});

/**
 * The same two reverts on the other side of a handover, where 01b made both newly reachable:
 * `_update`'s quarantine holds a freshly moved account at arm's length on mint and transfer
 * alike, and the device freeze became bidirectional, so a locked phone is now refused as the
 * RECIPIENT and not only as the sender.
 */
describe('an offer the contract refuses to hand over', () => {
  const ACCEPT_SENTENCES: ReadonlyArray<readonly [string, string]> = [
    ['RotationPending', en.transfer.offerRotationPending],
    ['DeviceLocked', en.transfer.offerDeviceLocked],
  ];

  for (const [name, sentence] of ACCEPT_SENTENCES) {
    it(`reads ${name} in the receiver's own voice`, () => {
      expect(acceptFailure(en, reverted(name))).toBe(sentence);
    });
  }

  it('keeps the generic sentence for a refusal nobody here knows', () => {
    expect(acceptFailure(en, reverted('SomethingUnmapped'))).toBe(en.transfer.acceptFailed);
  });
});
