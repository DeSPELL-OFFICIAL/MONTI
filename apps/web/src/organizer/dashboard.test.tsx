import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LifecycleResult } from './lifecycle';


const ACCOUNT = `0x${'ab'.repeat(20)}` as const;
vi.mock('../shared/chain/accounts', () => ({ getStaffAccount: async () => ({ address: ACCOUNT }) }));

// The relayed lifecycle writes are mocked at the module seam; lifecycle.test.ts covers the
// transport (sendAction), so here the dashboard is judged on how it consumes the result.
const cancelEvent = vi.fn<(eventId: bigint) => Promise<LifecycleResult>>(async () => ({ state: 'done' }));
vi.mock('./lifecycle', () => ({ cancelEvent }));

const eventOrg = vi.fn(async () => 9n);
// The chain fallback the status hook reads when the indexer has no row: `eventOrg` (0 means no such
// event) and `eventStatus` (0 = Draft). Both default to a real Draft event the indexer knows about.
const eventStatus = vi.fn(async () => 0);
vi.mock('../shared/chain/reads', async (orig) => ({
  ...(await orig<typeof import('../shared/chain/reads')>()),
  readTicket: () => ({ eventOrg, eventStatus }),
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
// The 정산 설정 section (Batch D) this screen now embeds reads these on mount. Stubbed to a
// no-policy event so the dashboard renders as before; settlement.test.tsx covers the section itself.
const getSettlement = vi.fn(async () => null);
const watchSettlement = vi.fn(() => () => undefined);
const watchRelayStatus = vi.fn(() => () => undefined);
vi.mock('../shared/api/firestore', () => ({ loadEventArt, loadMyProfile, getSettlement, watchSettlement, watchRelayStatus }));
vi.mock('../shared/chain/settlementReads', () => ({
  readChainPolicy: vi.fn(async () => ({ recipients: [], platformBps: 0, reserveBps: 0, noShowRefund: false, frozen: false, version: 0 })),
  readPolicyNonce: vi.fn(async () => 0n),
}));

const fetchEventMetadata = vi.fn(async (): Promise<Record<string, unknown>> => ({ title: '재즈 나이트', tags: [] }));
vi.mock('../shared/envio/ipfs', async (orig) => ({
  ...(await orig<typeof import('../shared/envio/ipfs')>()),
  fetchEventMetadata,
}));

const PUBLIC_EVENT = {
  id: '5', orgId: '9', imageCid: 'bafy', startsAt: '1', endsAt: '2', saleStart: '1', saleEnd: '2',
  transferable: true, transferCutoffSeconds: '0', maxTransfers: 3, category: 0, regionCode: '0x00',
  status: 'Published', requireKyc: false,
};
const TIERS = [
  { id: '5-0', eventId: '5', idx: 0, name: '일반', priceUsdCents: '0', supply: '100', minted: '40', maxPerWallet: '2', seated: false },
];

// The resolved shape is widened so a test can also stand in a `ClaimRequest` array — the same mock
// answers both the event read and the pending-count read the 신청 관리 link makes.
const gql = vi.fn(async (): Promise<Record<string, unknown>> => ({ Event: [PUBLIC_EVENT], Tier: TIERS }));
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
  gql.mockResolvedValue({ Event: [PUBLIC_EVENT], Tier: TIERS });
  eventOrg.mockResolvedValue(9n);
  eventStatus.mockResolvedValue(0);
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

  it('says the title is loading, not that the event is unnamed, while its document is on its way', async () => {
    fetchEventMetadata.mockReturnValueOnce(new Promise(() => undefined));
    open();
    await screen.findByText(`${dash.sold} 40`);
    await waitFor(() => expect(document.body.innerHTML).toContain(dash.art.titleLoading));
    expect(document.body.innerHTML).not.toContain(dash.art.untitled);
  });
});

describe('cancelling (publishing happens on the draft, never here)', () => {
  it('offers no publish or edit on the dashboard', async () => {
    open();
    await screen.findByText(dash.attendees);
    expect(screen.queryByRole('link', { name: /고치기/ })).not.toBeInTheDocument();
    expect(screen.getAllByRole('button').map((button) => button.textContent)).not.toContain('공개하기');
  });

  /** Ruling 3: after sub-plan 01b a cancelled event blocks hand-overs — say so beforehand. */
  it('warns that cancelling is final and stops hand-overs before it sends anything', async () => {
    const user = userEvent.setup();
    open();
    await user.click(await screen.findByRole('button', { name: life.cancel }));

    expect(screen.getByText(life.cancelConfirm)).toBeInTheDocument();
    expect(cancelEvent).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: life.confirm }));
    await waitFor(() => expect(cancelEvent).toHaveBeenCalledWith(5n));
    expect(await screen.findByText(life.cancelled)).toBeInTheDocument();
  });

  it('lets the organiser back out of the confirmation', async () => {
    const user = userEvent.setup();
    open();
    await user.click(await screen.findByRole('button', { name: life.cancel }));
    await user.click(screen.getByRole('button', { name: life.back }));
    expect(screen.queryByText(life.cancelConfirm)).not.toBeInTheDocument();
    expect(cancelEvent).not.toHaveBeenCalled();
  });

  it('offers no cancel on an event that is already cancelled', async () => {
    gql.mockResolvedValue({ Event: [{ ...PUBLIC_EVENT, status: 'Cancelled' }], Tier: TIERS });
    open();
    await screen.findByText(dash.attendees);
    expect(screen.queryByRole('button', { name: life.cancel })).not.toBeInTheDocument();
  });

  it('names the rule when the chain refuses the write', async () => {
    const user = userEvent.setup();
    cancelEvent.mockResolvedValueOnce({ state: 'refused', problem: 'closed' });
    open();
    await user.click(await screen.findByRole('button', { name: life.cancel }));
    await user.click(screen.getByRole('button', { name: life.confirm }));
    expect(await screen.findByText(life.closed)).toBeInTheDocument();
  });
});

describe('an event the indexer has no row for', () => {
  it('says the number is unknown when the chain has no such event either', async () => {
    gql.mockResolvedValue({ Event: [], Tier: [] });
    listAttendees.mockResolvedValue([]);
    eventOrg.mockResolvedValue(0n);
    open();
    expect(await screen.findByText(dash.notIndexed)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: life.cancel })).not.toBeInTheDocument();
  });

  /** A just-published event the hosted indexer has not caught up with: the chain status drives it. */
  it('offers 취소 from the chain status while the indexer has no row yet', async () => {
    gql.mockResolvedValue({ Event: [], Tier: [] });
    listAttendees.mockResolvedValue([]);
    eventOrg.mockResolvedValue(9n);
    eventStatus.mockResolvedValue(1); // Published on chain
    open();
    expect(await screen.findByRole('button', { name: life.cancel })).toBeInTheDocument();
    expect(screen.queryByText(dash.notIndexed)).not.toBeInTheDocument();
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
      Event: [{ ...PUBLIC_EVENT, approvalRequired: true }],
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
