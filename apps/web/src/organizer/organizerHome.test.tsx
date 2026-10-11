import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EnvioEvent } from '../shared/envio/queries';

/**
 * Both hooks are mocked rather than the transport underneath them: `myOrgs.test.tsx` already
 * proves what the indexer's rows fold into, and every assertion here is about what the home
 * screen does with that answer — which organisation is chosen, which events follow it, and
 * what stays usable when the indexer says nothing at all.
 */
const useMyOrgs = vi.fn();
const useOrgEvents = vi.fn();
vi.mock('./useMyOrgs', () => ({ useMyOrgs, useOrgEvents }));

// Only `useNavigate` is stubbed; `MemoryRouter` and `useSearchParams` stay real, so the
// address the picker writes is read off the router rather than guessed at.
const navigate = vi.fn();
vi.mock('react-router-dom', async (orig) => ({
  ...(await orig<typeof import('react-router-dom')>()),
  useNavigate: () => navigate,
}));

const { OrganizerRoutes } = await import('./Layout');
const { organizerCopy } = await import('./copy');
const { setSession } = await import('../shared/session');
const { formatEventDate } = await import('../attendee/discover/useEvents');
const copy = organizerCopy.ko.home;

interface Org {
  orgId: string;
  name: string;
  role: 'owner' | 'admin' | 'manager';
  bits: number;
  canCreateEvent: boolean;
}

const ORG_A: Org = { orgId: '3', name: '재즈 컴퍼니', role: 'owner', bits: 0, canCreateEvent: true };
const ORG_B: Org = { orgId: '7', name: '한남 라이브', role: 'admin', bits: 1, canCreateEvent: true };
const ORG_NONE: Org = { orgId: '9', name: '구경만 하는 곳', role: 'manager', bits: 0, canCreateEvent: false };

const EVENT_A: EnvioEvent = {
  id: '11', orgId: '3', imageCid: 'cid-a', startsAt: '1800000000', endsAt: '1800003600',
  saleStart: '1700000000', saleEnd: '1800000000', transferable: true, transferCutoffSeconds: '3600',
  maxTransfers: 3, category: 0, regionCode: '0x00', status: 'Draft', requireKyc: false,
};
const EVENT_B: EnvioEvent = { ...EVENT_A, id: '22', orgId: '7', status: 'Published' };

const refetchOrgs = vi.fn();
const refetchEvents = vi.fn();

function withOrgs(orgs: Org[], over: Record<string, unknown> = {}) {
  useMyOrgs.mockReturnValue({
    orgs,
    canCreateEvent: orgs.some((org) => org.canCreateEvent),
    isLoading: false,
    isError: false,
    error: null,
    refetch: refetchOrgs,
    ...over,
  });
}

function withEvents(events: EnvioEvent[], over: Record<string, unknown> = {}) {
  useOrgEvents.mockReturnValue({
    events,
    isLoading: false,
    isError: false,
    error: null,
    refetch: refetchEvents,
    ...over,
  });
}

/** Renders the home screen and hands back the addresses the router has been through. */
function open(entry = '/org'): string[] {
  const seen: string[] = [];
  function Probe() {
    const location = useLocation();
    seen.push(`${location.pathname}${location.search}`);
    return null;
  }
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[entry]}>
        <Probe />
        <Routes>
          <Route path="/org/*" element={<OrganizerRoutes />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return seen;
}

/** The two number boxes sit in a fold, so every test that uses them has to open it first. */
async function openFold(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  const summary = screen.getByText(copy.manual);
  expect(summary.tagName).toBe('SUMMARY');
  const details = summary.closest('details');
  expect(details).not.toBeNull();
  await user.click(summary);
  // jsdom does not implement summary's activation behaviour; the fold is opened by hand so
  // the boxes are reached the way a person reaches them.
  if (details !== null && !details.open) details.open = true;
  return details as HTMLElement;
}

beforeEach(() => {
  navigate.mockReset();
  refetchOrgs.mockReset();
  refetchEvents.mockReset();
  // The home is a signed-in screen; the session is the one source the FAB reads (S5).
  setSession({ status: 'signedIn' });
  withOrgs([ORG_A]);
  withEvents([]);
});

describe('organiser home', () => {
  it('links back to explore, since /org is not a tab', () => {
    open();
    expect(screen.getByRole('link', { name: copy.backToDiscover })).toHaveAttribute('href', '/');
  });

  it('collapses a single organisation to its name, with no picker', () => {
    open();
    expect(screen.getByText(ORG_A.name)).toBeInTheDocument();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.getByRole('link', { name: copy.team })).toHaveAttribute('href', `/org/team/${ORG_A.orgId}`);
  });

  it('offers a picker once there are two organisations', () => {
    withOrgs([ORG_A, ORG_B]);
    open();
    expect(screen.getByLabelText(copy.org)).toHaveValue(ORG_A.orgId);
  });

  it('writes the chosen organisation into the address and follows it with the events', async () => {
    const user = userEvent.setup();
    withOrgs([ORG_A, ORG_B]);
    withEvents([EVENT_A, EVENT_B]);
    const seen = open();

    expect(screen.getByRole('link', { name: '행사 #11' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '행사 #22' })).toBeNull();

    await user.selectOptions(screen.getByLabelText(copy.org), ORG_B.orgId);

    expect(seen.at(-1)).toBe(`/org?org=${ORG_B.orgId}`);
    expect(screen.getByRole('link', { name: '행사 #22' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '행사 #11' })).toBeNull();
  });

  it('starts on the organisation the address names', () => {
    withOrgs([ORG_A, ORG_B]);
    withEvents([EVENT_A, EVENT_B]);
    open(`/org?org=${ORG_B.orgId}`);
    expect(screen.getByLabelText(copy.org)).toHaveValue(ORG_B.orgId);
    expect(screen.getByRole('link', { name: '행사 #22' })).toBeInTheDocument();
  });

  it('sends somebody who organises for nobody to the create-an-organiser screen', () => {
    withOrgs([]);
    open();
    expect(screen.getByText(copy.orgsEmpty)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: copy.become })).toHaveAttribute('href', '/org/become');
  });

  /** T-UX-7 lands here straight after `createOrganizer`, a second or two ahead of the indexer. */
  it('explains an organisation the indexer has not listed yet, and retries on demand', async () => {
    const user = userEvent.setup();
    withOrgs([]);
    open('/org?org=42');

    expect(screen.getByText(copy.orgPending)).toBeInTheDocument();
    expect(screen.queryByText(copy.orgsEmpty)).toBeNull();

    await user.click(screen.getByRole('button', { name: copy.retry }));
    expect(refetchOrgs).toHaveBeenCalled();
  });

  it('says so when the chosen organisation has put nothing on yet', () => {
    open();
    expect(screen.getByText(copy.eventsEmpty)).toBeInTheDocument();
  });

  it('lists an event with its number, its start and the indexer word for its state', () => {
    withEvents([EVENT_A]);
    open();
    expect(screen.getByRole('link', { name: '행사 #11' })).toHaveAttribute('href', '/org/events/11');
    expect(screen.getByText(copy.status.Draft)).toBeInTheDocument();
    expect(screen.getByText(formatEventDate(EVENT_A.startsAt, 'ko'))).toBeInTheDocument();
  });

  it('shows a state the indexer invents exactly as it came', () => {
    withEvents([{ ...EVENT_A, status: 'Ended' }]);
    open();
    expect(screen.getByText('Ended')).toBeInTheDocument();
  });

  it('keeps the number box working while the events list is failing', async () => {
    const user = userEvent.setup();
    withEvents([], { isError: true });
    open();

    expect(screen.getByText(copy.eventsFailed)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: copy.retry }));
    expect(refetchEvents).toHaveBeenCalled();

    await openFold(user);
    await user.type(screen.getByLabelText(copy.eventId), '12');
    await user.click(screen.getByRole('button', { name: copy.open }));
    expect(navigate).toHaveBeenCalledWith('/org/events/12');
  });

  it('folds the two number boxes away and still refuses anything but a number', async () => {
    const user = userEvent.setup();
    open();
    await openFold(user);

    await user.type(screen.getByLabelText(copy.eventId), '12a');
    expect(screen.getByRole('button', { name: copy.open })).toBeDisabled();

    await user.type(screen.getByLabelText(copy.orgId), 'nine');
    expect(screen.getByRole('button', { name: copy.team })).toBeDisabled();

    await user.clear(screen.getByLabelText(copy.orgId));
    await user.type(screen.getByLabelText(copy.orgId), '9');
    await user.click(screen.getByRole('button', { name: copy.team }));
    expect(navigate).toHaveBeenCalledWith('/org/team/9');
  });

  it('carries the chosen organisation into the creation scene from one floating action', async () => {
    const user = userEvent.setup();
    withOrgs([ORG_A, ORG_B]);
    open(`/org?org=${ORG_B.orgId}`);

    await user.click(screen.getByRole('button', { name: copy.create }));
    expect(navigate).toHaveBeenCalledWith(`/org/new?org=${ORG_B.orgId}`);
  });

  /**
   * Where that address actually lands. `/org/new` is the creation scene (T-EV-W3) and, since
   * T-EV-W10, the only creation screen there is — the entry points from T-UX-5 and T-UX-6 both
   * point here and neither had to change, so this is what proves they open it.
   */
  it('opens the creation scene at `/org/new`, which is the only creation screen there is', () => {
    withOrgs([ORG_A]);
    open('/org/new?org=3');
    expect(screen.getByRole('heading', { name: organizerCopy.ko.scene.title, level: 1 }))
      .toBeInTheDocument();
    expect(screen.getByRole('heading', { name: organizerCopy.ko.scene.poster, level: 2 }))
      .toBeInTheDocument();
    // T-EV-W10 deleted the six-step wizard; nothing answers at its old address any more.
    expect(screen.queryByText(/1단계/)).toBeNull();
  });

  /**
   * The ticket screen the scene absorbed (plan section B-1). Addresses to `/org/new/<id>/tickets`
   * are already out there — an organiser's own Back button, a draft opened in another tab — and
   * a dead route would answer them with the catch-all, which is the explore tab and a lost draft.
   * The draft id has to survive the hop, or the person lands on somebody's newest draft instead
   * of the one they were filling in.
   */
  it('lands the ticket screen it absorbed on the same draft, not on a new one', () => {
    withOrgs([ORG_A]);
    const seen = open('/org/new/d-42/tickets');
    expect(seen.at(-1)).toBe('/org/new/d-42');
    expect(screen.getByRole('heading', { name: organizerCopy.ko.scene.title, level: 1 }))
      .toBeInTheDocument();
    // The kinds are a section of that one scroll now, so there is no second screen to land on.
    expect(screen.getByLabelText(organizerCopy.ko.scene.tiers.supply)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: organizerCopy.ko.scene.tiers.next })).toBeInTheDocument();
  });

  /** v2: the draft's publish screen is a route of its own, against the real route table. */
  it('opens a draft\'s publish screen at `/org/new/<id>/publish`', () => {
    withOrgs([ORG_A]);
    const seen = open('/org/new/d-42/publish');
    expect(seen.at(-1)).toBe('/org/new/d-42/publish');
    expect(screen.getByRole('heading', { name: organizerCopy.ko.scene.publishScreen.title, level: 1 }))
      .toBeInTheDocument();
  });

  it('has no edit route for a published event any more', () => {
    withOrgs([ORG_A]);
    open('/org/events/7/edit');
    expect(screen.queryByRole('heading', { name: organizerCopy.ko.scene.title, level: 1 })).toBeNull();
  });

  it('refuses the floating action to somebody who may not create events, and says why', () => {
    withOrgs([ORG_NONE]);
    open();
    expect(screen.getByRole('button', { name: copy.create })).toBeDisabled();
    expect(screen.getByText(copy.noPermission)).toBeInTheDocument();
  });

  it('refuses the floating action when there is no organisation at all', () => {
    withOrgs([]);
    open();
    expect(screen.getByRole('button', { name: copy.create })).toBeDisabled();
  });

  it('keeps the create action live while the organisations are still loading (visual R1-8)', () => {
    // A signed-in reload whose organisations have not landed yet: the FAB stays enabled rather
    // than greying out over the spinner, which read as a permission refusal.
    withOrgs([], { isLoading: true });
    open();
    expect(screen.getByRole('button', { name: copy.create })).toBeEnabled();
  });

  it('holds the create action while the session is still re-hydrating (S5)', () => {
    // Even with an organisation to hand, a reload's unresolved session keeps 만들기 disabled until
    // the session is known, rather than offering it as if nobody were signed in.
    setSession({ status: 'loading' });
    withOrgs([ORG_A]);
    open();
    expect(screen.getByRole('button', { name: copy.create })).toBeDisabled();
  });
});

