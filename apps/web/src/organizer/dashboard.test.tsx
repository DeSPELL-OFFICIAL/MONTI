import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface SentOp { functionName: string; orgId: bigint; args: readonly unknown[] }
const ticketOp = vi.fn(async (_options: SentOp) => ({ success: true }));
vi.mock('../shared/chain/ops', async (orig) => ({
  ...(await orig<typeof import('../shared/chain/ops')>()),
  ticketOp,
}));

const ACCOUNT = `0x${'ab'.repeat(20)}` as const;
vi.mock('../shared/chain/accounts', () => ({ getStaffAccount: async () => ({ address: ACCOUNT }) }));

const eventOrg = vi.fn(async () => 9n);
vi.mock('../shared/chain/reads', async (orig) => ({
  ...(await orig<typeof import('../shared/chain/reads')>()),
  readTicket: () => ({ eventOrg }),
}));

const listAttendees = vi.fn(async () => [
  { tokenId: '1', nickname: 'alice', tier: 0, checkedIn: true, kycLevel: 1 as const },
  { tokenId: '2', nickname: 'bob', tier: 0, checkedIn: false, kycLevel: 0 as const },
]);
const pinMessage = vi.fn(async () => ({ ok: true as const, messageId: 'm1' }));
vi.mock('../shared/api/functions', async (orig) => ({
  ...(await orig<typeof import('../shared/api/functions')>()),
  api: { listAttendees, pinMessage },
}));

const DRAFT_EVENT = {
  id: '5', orgId: '9', imageCid: 'bafy', startsAt: '1', endsAt: '2', saleStart: '1', saleEnd: '2',
  transferable: true, transferCutoffSeconds: '0', maxTransfers: 3, category: 0, regionCode: '0x00',
  status: 'Draft', requireKyc: false,
};
const TIERS = [
  { id: '5-0', eventId: '5', idx: 0, name: '일반', priceUsdCents: '0', supply: '100', minted: '40', maxPerWallet: '2', seated: false },
];

const gql = vi.fn(async () => ({ Event: [DRAFT_EVENT], Tier: TIERS }));
vi.mock('../shared/envio/client', () => ({ gql }));

const { organizerCopy } = await import('./copy');
const { Dashboard } = await import('./Dashboard');
const dash = organizerCopy.ko.dashboard;
const life = organizerCopy.ko.lifecycle;

function open() {
  render(
    <MemoryRouter initialEntries={['/org/events/5']}>
      <Routes>
        <Route path="/org/events/:eventId" element={<Dashboard />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  gql.mockResolvedValue({ Event: [DRAFT_EVENT], Tier: TIERS });
  eventOrg.mockResolvedValue(9n);
  ticketOp.mockResolvedValue({ success: true });
});

describe('the organiser dashboard', () => {
  /** Ruling 5: every number is the indexer's, and no phone, legal name or photo is anywhere. */
  it('counts what went out and what came in from the indexer', async () => {
    open();
    expect(await screen.findByText(`${dash.sold} 40`)).toBeInTheDocument();
    expect(screen.getByText(`${dash.remaining} 60`)).toBeInTheDocument();
    expect(screen.getByText(`${dash.checkins} 1 / 2`)).toBeInTheDocument();
    expect(gql).toHaveBeenCalledWith(expect.stringContaining('Tier'), { id: '5', eventId: '5' });
  });

  it('lists attendees by the nickname they chose and nothing else about them', async () => {
    open();
    expect(await screen.findByText(/alice/)).toBeInTheDocument();
    expect(screen.getByText(/bob/)).toBeInTheDocument();
    expect(listAttendees).toHaveBeenCalledWith({ eventId: '5' });
  });
});

describe('publishing and cancelling', () => {
  it('asks before publishing and says what publishing costs the organiser', async () => {
    const user = userEvent.setup();
    open();
    await user.click(await screen.findByRole('button', { name: life.publish }));

    expect(screen.getByText(life.publishConfirm)).toBeInTheDocument();
    expect(ticketOp).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: life.confirm }));
    await waitFor(() =>
      expect(ticketOp).toHaveBeenCalledWith(
        expect.objectContaining({ orgId: 9n, functionName: 'publishEvent', args: [5n] }),
      ),
    );
  });

  /** Ruling 3: after sub-plan 01b a cancelled event blocks hand-overs — say so beforehand. */
  it('warns that cancelling is final and stops hand-overs before it sends anything', async () => {
    const user = userEvent.setup();
    open();
    await user.click(await screen.findByRole('button', { name: life.cancel }));

    expect(screen.getByText(life.cancelConfirm)).toBeInTheDocument();
    expect(ticketOp).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: life.confirm }));
    await waitFor(() =>
      expect(ticketOp).toHaveBeenCalledWith(expect.objectContaining({ functionName: 'cancelEvent', args: [5n] })),
    );
  });

  it('lets the organiser back out of the confirmation', async () => {
    const user = userEvent.setup();
    open();
    await user.click(await screen.findByRole('button', { name: life.cancel }));
    await user.click(screen.getByRole('button', { name: life.back }));
    expect(screen.queryByText(life.cancelConfirm)).not.toBeInTheDocument();
    expect(ticketOp).not.toHaveBeenCalled();
  });

  it('offers neither write on an event that is already cancelled', async () => {
    gql.mockResolvedValue({ Event: [{ ...DRAFT_EVENT, status: 'Cancelled' }], Tier: TIERS });
    open();
    await screen.findByText(dash.attendees);
    expect(screen.queryByRole('button', { name: life.publish })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: life.cancel })).not.toBeInTheDocument();
  });

  /**
   * The refetch that follows a write races the indexer's own `EventStatusChanged`. Choosing the
   * sentence off `status` meant an organiser who had just cancelled read 발행했어요 for as long
   * as the indexer was behind — wrong in exactly the moment they most need to be sure.
   */
  it('says what was just done, not what the indexer still thinks the event is', async () => {
    const user = userEvent.setup();
    open();
    await user.click(await screen.findByRole('button', { name: life.cancel }));
    await user.click(screen.getByRole('button', { name: life.confirm }));

    expect(await screen.findByText(life.cancelled)).toBeInTheDocument();
    expect(screen.queryByText(life.published)).not.toBeInTheDocument();
  });

  it('says 발행했어요 after a publish, for the same reason', async () => {
    const user = userEvent.setup();
    open();
    await user.click(await screen.findByRole('button', { name: life.publish }));
    await user.click(screen.getByRole('button', { name: life.confirm }));

    expect(await screen.findByText(life.published)).toBeInTheDocument();
    expect(screen.queryByText(life.cancelled)).not.toBeInTheDocument();
  });

  it('names the rule when the chain refuses the write', async () => {
    const user = userEvent.setup();
    const { OpReverted } = await import('../shared/chain/ops');
    const { encodeErrorResult } = await import('viem');
    const { ticketAbi } = await import('../shared/chain/abis');
    ticketOp.mockRejectedValueOnce(
      new OpReverted('publishEvent', encodeErrorResult({ abi: ticketAbi, errorName: 'NotDraft' })),
    );
    open();
    await user.click(await screen.findByRole('button', { name: life.publish }));
    await user.click(screen.getByRole('button', { name: life.confirm }));
    expect(await screen.findByText(life.notDraft)).toBeInTheDocument();
  });
});

describe('an event the indexer has no row for', () => {
  /**
   * A mistyped number on the home screen, or an event created a moment ago. Neither read
   * failed, so the old code showed a blank screen with no writes offered and no reason.
   */
  it('says the number is unknown or not indexed yet rather than rendering blank', async () => {
    gql.mockResolvedValue({ Event: [], Tier: [] });
    listAttendees.mockResolvedValue([]);
    open();
    expect(await screen.findByText(dash.notIndexed)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: life.publish })).not.toBeInTheDocument();
  });

  it('shows the load failure instead when both reads threw', async () => {
    gql.mockRejectedValue(new Error('offline'));
    listAttendees.mockRejectedValue(new Error('offline'));
    open();
    expect(await screen.findByText(dash.failed)).toBeInTheDocument();
    expect(screen.queryByText(dash.notIndexed)).not.toBeInTheDocument();
  });
});
