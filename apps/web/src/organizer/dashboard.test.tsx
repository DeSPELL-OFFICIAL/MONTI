import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LifecycleResult } from './lifecycle';

interface SentOp { functionName: string; orgId: bigint; args: readonly unknown[] }
const ticketOp = vi.fn(async (_options: SentOp) => ({ success: true }));
vi.mock('../shared/chain/ops', async (orig) => ({
  ...(await orig<typeof import('../shared/chain/ops')>()),
  ticketOp,
}));

const ACCOUNT = `0x${'ab'.repeat(20)}` as const;
vi.mock('../shared/chain/accounts', () => ({ getStaffAccount: async () => ({ address: ACCOUNT }) }));

// The relayed lifecycle writes are mocked at the module seam; lifecycle.test.ts covers the
// transport (sendAction), so here the dashboard is judged on how it consumes the result.
const publishEvent = vi.fn<(eventId: bigint, orgId: bigint) => Promise<LifecycleResult>>(async () => ({ state: 'done' }));
const cancelEvent = vi.fn<(eventId: bigint, orgId: bigint) => Promise<LifecycleResult>>(async () => ({ state: 'done' }));
vi.mock('./lifecycle', () => ({ publishEvent, cancelEvent }));

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
// The notice section this screen embeds reads the notices already pinned as soon as it renders.
// It is stubbed empty here rather than left out: an absent mock is a `TypeError` inside an
// effect, which vitest reports as an unhandled rejection long after the assertion it broke.
const listPinned = vi.fn(async () => []);
// The ticket-picture section below the table writes through this one; its own screen is tested
// in `eventArt.test.tsx`, so here it only has to exist.
const saveEventArt = vi.fn(async () => ({ ok: true as const }));
vi.mock('../shared/api/functions', async (orig) => ({
  ...(await orig<typeof import('../shared/api/functions')>()),
  api: { listAttendees, pinMessage, listPinned, saveEventArt },
}));

// Two reads the picture section makes on its own. Stubbed rather than left out: both swallow
// their own failures, so an unmocked one would be a real network call inside a unit test.
const loadEventArt = vi.fn(async () => [{ preset: 'c' as const }]);
/** The ticket preview prints whose ticket it is, so this screen reads the profile too. */
const loadMyProfile = vi.fn(async () => ({ displayName: '박주최' }));
vi.mock('../shared/api/firestore', () => ({ loadEventArt, loadMyProfile }));

const fetchEventMetadata = vi.fn(async (): Promise<Record<string, unknown>> => ({ title: '재즈 나이트', tags: [] }));
vi.mock('../shared/envio/ipfs', async (orig) => ({
  ...(await orig<typeof import('../shared/envio/ipfs')>()),
  fetchEventMetadata,
}));

const DRAFT_EVENT = {
  id: '5', orgId: '9', imageCid: 'bafy', startsAt: '1', endsAt: '2', saleStart: '1', saleEnd: '2',
  transferable: true, transferCutoffSeconds: '0', maxTransfers: 3, category: 0, regionCode: '0x00',
  status: 'Draft', requireKyc: false,
};
const TIERS = [
  { id: '5-0', eventId: '5', idx: 0, name: '일반', priceUsdCents: '0', supply: '100', minted: '40', maxPerWallet: '2', seated: false },
];

// The resolved shape is widened so a test can also stand in a `ClaimRequest` array — the same mock
// answers both the event read and the pending-count read the 신청 관리 link makes.
const gql = vi.fn(async (): Promise<Record<string, unknown>> => ({ Event: [DRAFT_EVENT], Tier: TIERS }));
vi.mock('../shared/envio/client', () => ({ gql }));

const { organizerCopy } = await import('./copy');
const { Dashboard } = await import('./Dashboard');
const dash = organizerCopy.ko.dashboard;
const life = organizerCopy.ko.lifecycle;

function open() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={['/org/events/5']}>
        <Routes>
          <Route path="/org/events/:eventId" element={<Dashboard />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  gql.mockResolvedValue({ Event: [DRAFT_EVENT], Tier: TIERS });
  eventOrg.mockResolvedValue(9n);
  ticketOp.mockResolvedValue({ success: true });
  publishEvent.mockReset().mockResolvedValue({ state: 'done' });
  cancelEvent.mockReset().mockResolvedValue({ state: 'done' });
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
    expect(publishEvent).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: life.confirm }));
    await waitFor(() => expect(publishEvent).toHaveBeenCalledWith(5n, 9n));
  });

  /** Plan §2b: the summary sheet shows what goes public, and confirming publishes exactly once. */
  it('summarises the event in a sheet and publishes exactly once', async () => {
    const user = userEvent.setup();
    fetchEventMetadata.mockResolvedValue({
      title: '재즈 나이트', venue: '한남동 클럽', region: 'KR-11', venueHidden: false, timeHidden: false, tags: [],
    });
    gql.mockResolvedValue({ Event: [{ ...DRAFT_EVENT, requireKyc: true }], Tier: TIERS });
    open();
    await user.click(await screen.findByRole('button', { name: life.publish }));

    // The summary: place, the ticket-kind count and the identity check, then the confirmation.
    expect(await screen.findByText('한남동 클럽')).toBeInTheDocument();
    expect(screen.getByText(life.summary.kycOn)).toBeInTheDocument();
    expect(screen.getByText('1종')).toBeInTheDocument();
    expect(screen.getByText(life.publishConfirm)).toBeInTheDocument();
    expect(publishEvent).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: life.confirm }));
    await waitFor(() => expect(publishEvent).toHaveBeenCalledWith(5n, 9n));
    expect(publishEvent).toHaveBeenCalledTimes(1);
  });

  /** Ruling 3: after sub-plan 01b a cancelled event blocks hand-overs — say so beforehand. */
  it('warns that cancelling is final and stops hand-overs before it sends anything', async () => {
    const user = userEvent.setup();
    open();
    await user.click(await screen.findByRole('button', { name: life.cancel }));

    expect(screen.getByText(life.cancelConfirm)).toBeInTheDocument();
    expect(cancelEvent).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: life.confirm }));
    await waitFor(() => expect(cancelEvent).toHaveBeenCalledWith(5n, 9n));
  });

  it('lets the organiser back out of the confirmation', async () => {
    const user = userEvent.setup();
    open();
    await user.click(await screen.findByRole('button', { name: life.cancel }));
    await user.click(screen.getByRole('button', { name: life.back }));
    expect(screen.queryByText(life.cancelConfirm)).not.toBeInTheDocument();
    expect(cancelEvent).not.toHaveBeenCalled();
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
    publishEvent.mockResolvedValueOnce({ state: 'refused', problem: 'notDraft' });
    open();
    await user.click(await screen.findByRole('button', { name: life.publish }));
    await user.click(screen.getByRole('button', { name: life.confirm }));
    expect(await screen.findByText(life.notDraft)).toBeInTheDocument();
  });

  /** Plan §2c: a timed-out publish shows determinate progress and resolves itself — no refresh. */
  it('turns a timed-out publish into progress that auto-resolves when the indexer catches up', async () => {
    const user = userEvent.setup();
    publishEvent.mockResolvedValueOnce({ state: 'confirming' });
    open();
    await user.click(await screen.findByRole('button', { name: life.publish }));
    await user.click(screen.getByRole('button', { name: life.confirm }));

    // The determinate wait, not the old "reopen this screen" alert — and nothing to refresh by hand.
    await waitFor(() => expect(document.querySelector('.op-progress')).not.toBeNull());
    expect(screen.queryByText(life.confirming)).toBeNull();

    // The indexer catches up; the background poll turns the screen to 발행했어요 on its own.
    gql.mockResolvedValue({ Event: [{ ...DRAFT_EVENT, status: 'Published' }], Tier: TIERS });
    expect(await screen.findByText(life.published, {}, { timeout: 5_000 })).toBeInTheDocument();
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

  /**
   * T-EV-W13. The founder's requirement is that the picture can be changed later, so the
   * section is on this screen and not only in the creation scene — and it is here for a Draft
   * event just as it is for a published one, because `saveEventArt` never closes.
   */
  it('offers the ticket pictures, named by the event the indexer and the document agree on', async () => {
    open();
    expect(await screen.findByRole('heading', { name: dash.art.title })).toBeInTheDocument();
    expect(await screen.findByRole('img', { name: /재즈 나이트 · 일반/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: dash.art.change })).toBeInTheDocument();
    expect(loadEventArt).toHaveBeenCalledWith('5');
    expect(fetchEventMetadata).toHaveBeenCalledWith('bafy');
  });
});

describe('the 신청 관리 link', () => {
  it('appears with the pending count on an approvalRequired event', async () => {
    // One resolved value serves both reads: the event (approvalRequired) and the pending list.
    gql.mockResolvedValue({
      Event: [{ ...DRAFT_EVENT, approvalRequired: true }],
      Tier: TIERS,
      ClaimRequest: [{ requestId: '1' }, { requestId: '2' }],
    });
    open();
    const link = await screen.findByRole('link', { name: /신청 관리/ });
    expect(link).toHaveAttribute('href', '/org/events/5/requests');
    expect(link.textContent).toContain('2');
  });

  it('is absent on an ordinary event', async () => {
    open();
    await screen.findByRole('heading', { name: dash.art.title });
    expect(screen.queryByRole('link', { name: /신청 관리/ })).not.toBeInTheDocument();
  });
});
