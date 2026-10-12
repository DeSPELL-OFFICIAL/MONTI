import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { keccak256, toBytes } from 'viem';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadEventArt } from '../../../test/mocks/eventArt';

// The indexer is not deployed yet, so both sides of the data path are mocked: the GraphQL
// transport and the gateway read. Every assertion below is about what the screen does with
// the rows, never about how they arrive.
const gql = vi.fn();
const fetchEventMetadata = vi.fn();
vi.mock('../../shared/envio/client', () => ({ gql }));
vi.mock('../../shared/envio/ipfs', () => ({ fetchEventMetadata }));

/**
 * The organiser side is mocked one level higher than the transport: `organizer/myOrgs.test.tsx`
 * already proves what the indexer's rows fold into, and `me/profile.test.tsx` drives the real
 * hook end to end. What is under test here is the routing table on top of that answer, so it is
 * the answer that is handed in — otherwise every row would need its own indexer round trip to
 * settle before the button could be tapped, and the table would be tested through the timing of
 * two queries rather than through itself.
 */
const useMyOrgs = vi.fn();
vi.mock('../../organizer/useMyOrgs', () => ({ useMyOrgs }));

// A signed-in session makes `useKycLevel` ask the server for real; only that one call is stubbed.
const getSignupStatus = vi.fn(async () => ({ status: 'active', kycLevel: 0 }));
/** The chain-checked read behind a hidden venue. A rejection is the ordinary "no ticket" case. */
const getEventPrivate = vi.fn<(args: { eventId: string }) => Promise<{ venue?: string }>>();
vi.mock('../../shared/api/functions', async (orig) => ({
  ...(await orig<typeof import('../../shared/api/functions')>()),
  api: { getSignupStatus, getEventPrivate },
}));

// The detail screen draws a ticket-art hero, which reads `eventArt/{eventId}` through `loadEventArt`
// — real Firestore in jsdom. One shared mock (test/mocks/eventArt.ts) stands in for every
// EventDetail test: it answers "no stored art" by default, so the hero falls back the way most
// events do, and a test that wants a picture arms it with `mockResolvedValueOnce`.
/** The settlement mirror a priced event's per-kind price comes from. `null` is a free event. */
const getSettlement = vi.fn(async (_eventId: string): Promise<unknown> => null);
vi.mock('../../shared/api/firestore', async (orig) => ({
  ...(await orig<typeof import('../../shared/api/firestore')>()),
  loadEventArt,
  getSettlement,
}));

const { setSession } = await import('../../shared/session');
const { Discover } = await import('./Discover');
const { EventDetail } = await import('./EventDetail');
const { DEFAULT_FILTERS, METADATA_CONCURRENCY, listableItems, loadFilters, mapWithPool, saveFilters } =
  await import('./useEvents');
const { THEME_CODES, themeLabels } = await import('../../shared/eventThemes');
const { en } = await import('../../shared/copy/index');

const NOW_SECONDS = Math.floor(Date.now() / 1000);
const IN_TWO_DAYS = String(NOW_SECONDS + 2 * 86_400);
const IN_TWENTY_DAYS = String(NOW_SECONDS + 20 * 86_400);

// EventMeta.regionCode is keccak256(<ISO region>) on chain, so a fixture hashes the same way
// the picker does — computed here with viem directly rather than through the code under test.
const EVENT_ONE = {
  id: '1', orgId: '1', imageCid: 'cid-a', startsAt: IN_TWO_DAYS, endsAt: String(Number(IN_TWO_DAYS) + 3_600),
  saleStart: '1780000000', saleEnd: IN_TWO_DAYS, transferable: true, transferCutoffSeconds: '3600',
  maxTransfers: 3, category: 0, regionCode: keccak256(toBytes('KR-11')), status: 'Published', requireKyc: true,
};
const EVENT_TWO = {
  ...EVENT_ONE, id: '2', imageCid: 'cid-b', startsAt: IN_TWENTY_DAYS,
  endsAt: String(Number(IN_TWENTY_DAYS) + 3_600), category: 1,
  regionCode: keccak256(toBytes('KR-26')), requireKyc: false,
};

const PUBLIC = { tags: [] as string[], venueHidden: false, timeHidden: false };
const META_A = { title: '재즈 나이트', description: '한남동의 밤', image: '', venue: '한남', category: 0, region: 'KR-11', ...PUBLIC };
const META_B = { title: '개발자 모임', description: '', image: '', venue: '해운대', category: 1, region: 'KR-26', ...PUBLIC };

const TIERS = [
  { id: '1-0', eventId: '1', idx: 0, name: 'General', priceUsdCents: '0', supply: '100', minted: '40', maxPerWallet: '2', seated: false },
];

/**
 * What `gql` rejects with. Built here rather than imported, because the module `EnvioError`
 * lives in is mocked at the top of this file — which is exactly why `describeFailure` reads
 * the shape (`name` + `kind`) instead of the class.
 */
function indexerFailure(kind: 'network' | 'http' | 'graphql' | 'empty', message: string): Error {
  return Object.assign(new Error(message), { name: 'EnvioError', kind });
}

function metadataByCid(cid: string) {
  if (cid === 'cid-a') return Promise.resolve(META_A);
  if (cid === 'cid-b') return Promise.resolve(META_B);
  return Promise.reject(new Error('IPFS_504'));
}

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function renderDiscover() {
  return render(
    <QueryClientProvider client={client()}>
      <MemoryRouter>
        <Discover />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Pushes every address the router visits, so a tap is read off the router, not guessed at. */
function renderDiscoverTracked(): string[] {
  const seen: string[] = [];
  function Probe() {
    seen.push(useLocation().pathname);
    return null;
  }
  render(
    <QueryClientProvider client={client()}>
      <MemoryRouter>
        <Probe />
        <Discover />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return seen;
}

/** What the indexer said about this person as an organiser, in the shape `useMyOrgs` answers. */
function myOrgs(over: Partial<{
  orgs: Array<{ orgId: string; name: string; role: string; bits: number; canCreateEvent: boolean }>;
  canCreateEvent: boolean;
  isLoading: boolean;
  isError: boolean;
}> = {}): void {
  useMyOrgs.mockReturnValue({
    orgs: [], canCreateEvent: false, isLoading: false, isError: false,
    error: null, refetch: () => undefined, ...over,
  });
}

const ORG = { orgId: '3', name: '재즈 컴퍼니', role: 'owner', bits: 0, canCreateEvent: true };
const ORG_NO_PERMISSION = { ...ORG, role: 'manager', bits: 0, canCreateEvent: false };
const ME = `0x${'ab'.repeat(20)}` as const;

async function tapCreate(): Promise<void> {
  await userEvent.click(await screen.findByRole('button', { name: 'Create an event' }));
}

function renderDetail(eventId = '1') {
  return render(
    <QueryClientProvider client={client()}>
      <MemoryRouter initialEntries={[`/events/${eventId}`]}>
        <Routes>
          <Route path="/events/:eventId" element={<EventDetail />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Records every address the router visits, so a route hop (or the absence of one) is read off it. */
function renderDetailTracked(eventId = '1'): string[] {
  const seen: string[] = [];
  function Probe() {
    seen.push(useLocation().pathname);
    return null;
  }
  render(
    <QueryClientProvider client={client()}>
      <MemoryRouter initialEntries={[`/events/${eventId}`]}>
        <Probe />
        <Routes>
          <Route path="/events/:eventId" element={<EventDetail />} />
          {/* The claim route still exists (plan B1) — a hop here would show up in `seen`. */}
          <Route path="/claim/:eventId" element={<div>claim route</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return seen;
}

beforeEach(() => {
  localStorage.clear();
  gql.mockReset();
  fetchEventMetadata.mockReset();
  useMyOrgs.mockReset();
  // The state every screen in this file starts in: nobody is signed in and nothing is known.
  setSession({ status: 'loading' });
  myOrgs();
  gql.mockResolvedValue({ Event: [EVENT_ONE, EVENT_TWO] });
  fetchEventMetadata.mockImplementation(metadataByCid);
  getEventPrivate.mockReset().mockRejectedValue({ code: 'permission-denied', message: 'NOT_HOLDER' });
});

describe('Discover', () => {
  it('lists the published page and badges only the events that need verification', async () => {
    renderDiscover();
    expect(await screen.findByText('재즈 나이트')).toBeInTheDocument();
    expect(screen.getByText('개발자 모임')).toBeInTheDocument();
    expect(screen.getAllByText('Verification required')).toHaveLength(1);
    expect(screen.getByRole('link', { name: /재즈 나이트/ })).toHaveAttribute('href', '/events/1');
  });

  it('keeps the events listed in VITE_HIDDEN_EVENT_IDS off the list, without fetching their metadata', async () => {
    vi.stubEnv('VITE_HIDDEN_EVENT_IDS', ' 1 , 1003');
    try {
      renderDiscover();
      expect(await screen.findByText('개발자 모임')).toBeInTheDocument();
      expect(screen.queryByText('재즈 나이트')).toBeNull();
      expect(fetchEventMetadata).not.toHaveBeenCalledWith('cid-a');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('filters the loaded page by the title search box', async () => {
    renderDiscover();
    expect(await screen.findByText('재즈 나이트')).toBeInTheDocument();
    await userEvent.type(screen.getByPlaceholderText('Search events'), '개발자');
    expect(screen.queryByText('재즈 나이트')).toBeNull();
    expect(screen.getByText('개발자 모임')).toBeInTheDocument();
    expect(screen.queryByText('Verification required')).toBeNull();
  });

  it('narrows by date, region and theme', async () => {
    renderDiscover();
    expect(await screen.findByText('재즈 나이트')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'This week' }));
    expect(screen.queryByText('개발자 모임')).toBeNull();
    expect(screen.getByText('재즈 나이트')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'All' }));
    await userEvent.selectOptions(screen.getByLabelText('Region'), 'KR-26');
    expect(screen.queryByText('재즈 나이트')).toBeNull();
    expect(screen.getByText('개발자 모임')).toBeInTheDocument();

    await userEvent.selectOptions(screen.getByLabelText('Region'), '');
    await userEvent.selectOptions(screen.getByLabelText('Theme'), '0');
    expect(screen.getByText('재즈 나이트')).toBeInTheDocument();
    expect(screen.queryByText('개발자 모임')).toBeNull();
  });

  /**
   * The organiser's dropdown and this one read `shared/eventThemes.ts`. They held their own
   * copies of `[0, 1, 2, 3]` until the list grew to twelve, and widening one alone would have
   * hidden every 페스티벌 from the only screen that can find one (plan section A-4).
   */
  it('offers every theme an organiser can pick, plus 전체', async () => {
    renderDiscover();
    expect(await screen.findByText('재즈 나이트')).toBeInTheDocument();
    const theme = screen.getByLabelText('Theme') as HTMLSelectElement;
    expect([...theme.options].map((option) => option.value))
      .toEqual(['all', ...THEME_CODES.map(String)]);
    expect([...theme.options].map((option) => option.textContent))
      .toEqual(['All', ...THEME_CODES.map((code) => themeLabels(en)[code])]);
  });

  /**
   * The stored filter is the one place a theme number arrives from outside the twelve: a
   * device that kept a filter from a build with a different list, or a hand-edited
   * `localStorage`. A number nothing matches would open 탐색 on an empty screen with a theme
   * box showing nothing selected, and no way to tell that the filter — not the city — is why.
   */
  it('keeps a stored theme only while it is one of the twelve', () => {
    for (const category of THEME_CODES) {
      saveFilters({ ...DEFAULT_FILTERS, category });
      expect(loadFilters().category, String(category)).toBe(category);
    }
    // 12 is the first number past the list, and a negative one is what a bad edit looks like.
    for (const bad of [12, -1, 99]) {
      saveFilters({ ...DEFAULT_FILTERS, category: bad });
      expect(loadFilters().category, String(bad)).toBe('all');
    }
  });

  it('remembers the last filter across mounts', async () => {
    const first = renderDiscover();
    expect(await screen.findByText('재즈 나이트')).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText('Region'), 'KR-26');
    first.unmount();

    renderDiscover();
    expect(await screen.findByText('개발자 모임')).toBeInTheDocument();
    expect(screen.queryByText('재즈 나이트')).toBeNull();
  });

  it('leaves off the home list an event whose title never arrives, and keeps the rest', async () => {
    fetchEventMetadata.mockImplementation((cid: string) =>
      cid === 'cid-a' ? Promise.resolve(META_A) : Promise.reject(new Error('IPFS_504')),
    );
    renderDiscover();
    expect(await screen.findByText('재즈 나이트')).toBeInTheDocument();
    expect(screen.queryByText('Title unavailable')).toBeNull();
  });

  // A slow or down gateway fails every document at once. Hiding untitled cards then would empty
  // the home page, so with no title anywhere the cards stay, under the placeholder.
  it('keeps every card under the placeholder when no title arrives at all', async () => {
    fetchEventMetadata.mockRejectedValue(new Error('IPFS_TIMEOUT'));
    renderDiscover();
    const links = await screen.findAllByRole('link', { name: 'Title unavailable' });
    expect(links.length).toBeGreaterThan(0);
    expect(screen.queryByText('No events match your filters.')).toBeNull();
  });

  /**
   * Two failures, two sentences. The request that never arrived is worth pressing 다시 시도 on;
   * the answer that came back broken is not, so it says "not right now" instead — which is the
   * whole reason `describeFailure` exists rather than one line for both.
   */
  it('says the page did not arrive when the request never got there', async () => {
    gql.mockRejectedValue(indexerFailure('network', 'REQUEST_FAILED'));
    renderDiscover();
    expect(await screen.findByRole('alert')).toHaveTextContent('We could not load that. Please try again in a moment.');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('says the information is not available right now when the indexer answers badly', async () => {
    gql.mockRejectedValue(indexerFailure('http', 'HTTP_500'));
    renderDiscover();
    expect(await screen.findByRole('alert')).toHaveTextContent('That information is not available right now. Please try again in a moment.');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('keeps the general line for a failure that is nobody\u2019s named cause', async () => {
    gql.mockRejectedValue(new Error('boom'));
    renderDiscover();
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong. Please try again in a moment.');
  });
});

/**
 * T-UX3-P0-1 · plan §2a. The three states the list used to fold into one spinner and one line:
 * loading, empty and the indexer being down. Empty splits again by who is looking at it.
 */
describe('Discover · loading and empty states', () => {
  it('shows skeleton cards while the page loads, never a lone spinner', () => {
    gql.mockReturnValue(new Promise(() => undefined));
    const { container } = renderDiscover();
    expect(container.querySelectorAll('.event-card--skeleton')).toHaveLength(3);
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('invites a signed-in visitor with no events to make the first one', async () => {
    gql.mockResolvedValue({ Event: [] });
    setSession({ status: 'signedIn', account: ME });
    myOrgs({ orgs: [], canCreateEvent: false });
    const seen = renderDiscoverTracked();
    expect(await screen.findByText('Create your first event')).toBeInTheDocument();
    // The empty-state CTA and the FAB both read 만들기; press the one in the empty state.
    const cta = within(document.querySelector('.empty-state') as HTMLElement)
      .getByRole('button', { name: 'Create an event' });
    await userEvent.click(cta);
    expect(seen.at(-1)).toBe('/org/new');
  });

  it('reassures a signed-out visitor that events are on the way, with no button', async () => {
    gql.mockResolvedValue({ Event: [] });
    renderDiscover();
    expect(await screen.findByText('Events are coming soon')).toBeInTheDocument();
    expect(screen.queryByText('Create your first event')).toBeNull();
    expect(document.querySelector('.empty-state')).toBeNull();
  });

  it('offers to clear the filters when they hide every event, apart from having none at all', async () => {
    renderDiscover();
    expect(await screen.findByText('재즈 나이트')).toBeInTheDocument();
    await userEvent.type(screen.getByPlaceholderText('Search events'), '없는행사');
    expect(screen.getByText('No events match your filters.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(await screen.findByText('재즈 나이트')).toBeInTheDocument();
  });

  it('sets the indexer being down apart from an empty list', async () => {
    gql.mockRejectedValue(indexerFailure('http', 'HTTP_500'));
    renderDiscover();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('That information is not available right now. Please try again in a moment.');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    // A down indexer is not "no events": neither empty-state line appears.
    expect(screen.queryByText('Events are coming soon')).toBeNull();
    expect(screen.queryByText('Create your first event')).toBeNull();
  });
});

/**
 * One button, three answers: make an event for anybody signed in, sign up for anybody who is
 * not, and nothing at all while the session is still re-hydrating. 만들기 means "make an event",
 * so it always opens the creation scene — the indexer no longer diverts it to `/org` depending
 * on which organisations the person runs (the old `to`≠`profileTo` split, now gone).
 */
describe('Discover · 만들기', () => {
  it('holds the button while the session is still re-hydrating, rather than guessing (S5)', async () => {
    // The beforeEach state is 'loading': a tap here must not read an unresolved session and send a
    // signed-in organiser to /signup/phone.
    const seen = renderDiscoverTracked();
    expect(await screen.findByRole('button', { name: 'Create an event' })).toBeDisabled();
    await tapCreate();
    expect(seen.at(-1)).toBe('/');
  });

  it('shows the button to a visitor who is not signed in, rather than hiding the way in', async () => {
    setSession({ status: 'anonymous' });
    renderDiscoverTracked();
    const fab = await screen.findByRole('button', { name: 'Create an event' });
    expect(fab).toBeEnabled();
    // Portaled out of the screen (and so out of the route transform) so it never rides the slide (R1).
    expect(fab.closest('.screen')).toBeNull();
  });

  it('sends a visitor who is not signed in to signing up', async () => {
    setSession({ status: 'anonymous' });
    const seen = renderDiscoverTracked();
    await tapCreate();
    expect(seen.at(-1)).toBe('/signup/phone');
  });

  it('goes straight to creating for somebody who may create an event', async () => {
    setSession({ status: 'signedIn', account: ME });
    myOrgs({ orgs: [ORG], canCreateEvent: true });
    const seen = renderDiscoverTracked();
    await tapCreate();
    expect(seen.at(-1)).toBe('/org/new');
  });

  /**
   * The founder's second tap (plan section B-4). Somebody with no organisation is not sent to a
   * screen about organisations first: `만들기` means "make an event", and the scene asks for the
   * organiser name inline on the way.
   */
  it('goes straight to creating for somebody who belongs to no organisation', async () => {
    setSession({ status: 'signedIn', account: ME });
    myOrgs({ orgs: [], canCreateEvent: false });
    const seen = renderDiscoverTracked();
    await tapCreate();
    expect(seen.at(-1)).toBe('/org/new');
  });

  it('opens the creation scene even for somebody who belongs but may not create', async () => {
    setSession({ status: 'signedIn', account: ME });
    myOrgs({ orgs: [ORG_NO_PERMISSION], canCreateEvent: false });
    const seen = renderDiscoverTracked();
    await tapCreate();
    // 만들기 is not a permission check: it opens the scene, which is where any "행사를 만들 권한이
    // 없어요…" belongs. Whether this person may create is not asked before the tap.
    expect(seen.at(-1)).toBe('/org/new');
  });

  it('opens the creation scene while the indexer has not answered', async () => {
    setSession({ status: 'signedIn', account: ME });
    myOrgs({ isLoading: true });
    const seen = renderDiscoverTracked();
    await tapCreate();
    // The FAB no longer consults the indexer, so a slow one never holds up making an event.
    expect(seen.at(-1)).toBe('/org/new');
  });

  it('opens the creation scene when the indexer will not answer at all', async () => {
    setSession({ status: 'signedIn', account: ME });
    myOrgs({ isError: true });
    const seen = renderDiscoverTracked();
    await tapCreate();
    // A down indexer does not divert the FAB either — it still opens the scene.
    expect(seen.at(-1)).toBe('/org/new');
  });
});

describe('gateway fan-out', () => {
  const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  it('runs at most the pool width at once and still answers in input order', async () => {
    const waiting: Array<() => void> = [];
    let inFlight = 0;
    let peak = 0;
    let settled = false;

    const doubled = mapWithPool([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 4, async (value: number) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise<void>((resolve) => waiting.push(resolve));
      inFlight -= 1;
      return value * 2;
    });
    void doubled.then(() => {
      settled = true;
    });

    await tick();
    expect(waiting).toHaveLength(4);
    expect(peak).toBe(4);

    // Finish the started work newest-first, so completion order never matches input order.
    for (let round = 0; round < 20 && !settled; round += 1) {
      for (const resolve of waiting.splice(0, waiting.length).reverse()) resolve();
      await tick();
    }

    await expect(doubled).resolves.toEqual([2, 4, 6, 8, 10, 12, 14, 16, 18, 20]);
    expect(peak).toBe(4);
  });

  it('never opens the whole page of gateway reads at once', async () => {
    const page = Array.from({ length: 12 }, (_, index) => ({
      ...EVENT_ONE,
      id: String(index + 1),
      imageCid: `cid-${index}`,
    }));
    gql.mockResolvedValue({ Event: page });

    let inFlight = 0;
    let peak = 0;
    fetchEventMetadata.mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return META_A;
    });

    renderDiscover();
    expect(await screen.findAllByRole('link')).toHaveLength(12);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(METADATA_CONCURRENCY);
  });
});

describe('listableItems', () => {
  const meta = { ...META_A, imageCid: '' };
  const titled = { event: EVENT_ONE, metadata: meta };
  const failed = { event: { ...EVENT_ONE, id: '9' }, metadata: null };
  const blank = { event: { ...EVENT_ONE, id: '10' }, metadata: { ...meta, title: '' } };

  it('drops untitled cards while at least one card has a title', () => {
    expect(listableItems([titled, failed, blank])).toEqual([titled]);
  });

  it('keeps every card when none has a title, rather than an empty list', () => {
    expect(listableItems([failed, blank])).toEqual([failed, blank]);
  });

  it('keeps an empty page empty', () => {
    expect(listableItems([])).toEqual([]);
  });
});

describe('metadata pool sizing', () => {
  // Every read can wait out the 12 s gateway timeout (shared/envio/ipfs.ts) and the page renders
  // once the whole pool drains, so ~20 events must finish in two rounds.
  it('keeps the worst case for twenty events near thirty seconds', () => {
    expect(Math.ceil(20 / METADATA_CONCURRENCY) * 12_000).toBeLessThanOrEqual(30_000);
  });
});

describe('EventDetail', () => {
  it('shows the gateway metadata and the tiers', async () => {
    gql.mockResolvedValue({ Event: [EVENT_ONE], Tier: TIERS });
    renderDetail();
    expect(await screen.findByRole('heading', { name: '재즈 나이트' })).toBeInTheDocument();
    expect(screen.getByText('한남동의 밤')).toBeInTheDocument();
    expect(screen.getByText('General')).toBeInTheDocument();
    expect(screen.getByText('60 left')).toBeInTheDocument();
    expect(screen.getByText('Verification required')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Get a ticket' })).toHaveAttribute('href', '/claim/1');
  });

  it('asks the indexer for the numeric event id', async () => {
    gql.mockResolvedValue({ Event: [EVENT_ONE], Tier: TIERS });
    renderDetail();
    await screen.findByRole('heading', { name: '재즈 나이트' });
    expect(gql).toHaveBeenCalledWith(expect.stringContaining('$eventId: numeric!'), { id: '1', eventId: '1' });
  });

  it('replaces the call to action when the event was called off', async () => {
    gql.mockResolvedValue({ Event: [{ ...EVENT_ONE, status: 'Cancelled' }], Tier: TIERS });
    renderDetail();
    expect(await screen.findByText('This event was cancelled.')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Get a ticket' })).toBeNull();
  });

  it('hides the share button where the phone has no share sheet', async () => {
    gql.mockResolvedValue({ Event: [EVENT_ONE], Tier: TIERS });
    renderDetail();
    await screen.findByRole('heading', { name: '재즈 나이트' });
    expect(screen.queryByRole('button', { name: 'Share' })).toBeNull();
  });

  it('swallows the rejection a dismissed share sheet throws', async () => {
    const share = vi.fn(async () => {
      throw Object.assign(new Error('dismissed'), { name: 'AbortError' });
    });
    Object.defineProperty(navigator, 'share', { value: share, configurable: true, writable: true });
    try {
      gql.mockResolvedValue({ Event: [EVENT_ONE], Tier: TIERS });
      renderDetail();
      await screen.findByRole('heading', { name: '재즈 나이트' });
      await userEvent.click(screen.getByRole('button', { name: 'Share' }));
      expect(share).toHaveBeenCalledWith({ url: window.location.href });
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    } finally {
      Reflect.deleteProperty(navigator, 'share');
    }
  });

  it('shows an error state when the event cannot be read', async () => {
    gql.mockRejectedValue(indexerFailure('graphql', 'QUERY_FAILED'));
    renderDetail();
    expect(await screen.findByRole('alert')).toHaveTextContent('That information is not available right now. Please try again in a moment.');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  /**
   * The indexer answered and simply has no such event. That is this screen's own `Error`, not
   * an indexer kind, so it keeps the general line rather than blaming the indexer.
   */
  it('keeps the general line for an event id the indexer does not know', async () => {
    gql.mockResolvedValue({ Event: [], Tier: [] });
    renderDetail('404');
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong. Please try again in a moment.');
  });
});

/**
 * plan B1 / T-SIMP-5 — the claim was absorbed into an inline sheet on the detail screen. A
 * signed-in visitor gets it in one tap with no route hop; the `/claim/:id` route survives for the
 * deep-link and identity-check return, so a signed-out visitor is still sent there to sign in.
 */
describe('EventDetail · 받기 시트 (B1)', () => {
  /** Clean answers for the claim engine's own reads, so opening the sheet paints its claimable state. */
  function claimIndexer() {
    gql.mockImplementation(async (query: string) => {
      if (query.includes('OwnedTickets')) return { Ticket: [], Offer: [] };
      if (query.includes('TicketContext')) return { CheckIn: [], Event: [], Tier: [], Ticket: [] };
      if (query.includes('MyRequests')) return { ClaimRequest: [] };
      return { Event: [EVENT_ONE], Tier: TIERS };
    });
  }

  it('opens the claim as an inline sheet in one tap, with no hop to /claim', async () => {
    claimIndexer();
    setSession({ status: 'signedIn', account: ME });
    const seen = renderDetailTracked();
    await userEvent.click(await screen.findByRole('button', { name: 'Get a ticket' }));
    // The claim runs on this same screen: a dialog with the engine's own claim button in it.
    const sheet = await screen.findByRole('dialog', { name: 'Get a ticket' });
    expect(within(sheet).getByRole('button', { name: 'Get a ticket' })).toBeInTheDocument();
    // The address never left the event page — the tap opened a sheet, it did not navigate.
    expect(seen).not.toContain('/claim/1');
    expect(seen.at(-1)).toBe('/events/1');
  });

  it('reassures in the sheet that it is free, by the claim button', async () => {
    claimIndexer();
    setSession({ status: 'signedIn', account: ME });
    renderDetail();
    await userEvent.click(await screen.findByRole('button', { name: 'Get a ticket' }));
    const sheet = await screen.findByRole('dialog', { name: 'Get a ticket' });
    expect(within(sheet).getByText("It's free")).toBeInTheDocument();
  });

  it('keeps the /claim route as the entry for a visitor who is not signed in yet', async () => {
    gql.mockResolvedValue({ Event: [EVENT_ONE], Tier: TIERS });
    setSession({ status: 'anonymous' });
    renderDetail();
    await screen.findByRole('heading', { name: '재즈 나이트' });
    // No inline sheet before sign-in: the link sends them to /claim, where the session guard and
    // then the surviving route take over (deep-link / resume path, plan B1).
    expect(screen.getByRole('link', { name: 'Get a ticket' })).toHaveAttribute('href', '/claim/1');
    expect(screen.queryByRole('button', { name: 'Get a ticket' })).toBeNull();
  });
});

/**
 * T-EV-W8 — what an event's own organiser chose to tell only the people who hold a ticket.
 *
 * There is one authorisation for both halves and it is the callable: it asks the chain on
 * every call, so an answer means a ticket (or this organiser's own event) and a refusal means
 * neither — including for somebody who handed their ticket on a minute ago. The time needs no
 * storage of its own, because the chain already carries the real one.
 */
/**
 * The list screen keeps the same rule as the detail screen. It is the screen the founder's
 * demo opens on, so a start time leaking here would undo the switch where it is most visible.
 */
describe('Discover · a hidden start time', () => {
  it('prints the day and no clock on a card whose organiser hid the time', async () => {
    gql.mockResolvedValue({ Event: [EVENT_ONE] });
    fetchEventMetadata.mockResolvedValue({ ...META_A, timeHidden: true });
    renderDiscover();
    await screen.findByRole('link', { name: '재즈 나이트' });

    const at = new Date(Number(EVENT_ONE.startsAt) * 1000);
    expect(screen.getByText(at.toLocaleDateString('en', { dateStyle: 'medium' }))).toBeInTheDocument();
    // Not merely a different string: no card carries a clock at all.
    expect(screen.queryByText(/\d{1,2}:\d{2}/)).toBeNull();
    expect(screen.queryByText(at.toLocaleString('en', { dateStyle: 'medium', timeStyle: 'short' }))).toBeNull();
  });

  it('still prints the full time for an event that hid nothing', async () => {
    gql.mockResolvedValue({ Event: [EVENT_ONE] });
    fetchEventMetadata.mockResolvedValue(META_A);
    renderDiscover();
    await screen.findByRole('link', { name: '재즈 나이트' });
    const at = new Date(Number(EVENT_ONE.startsAt) * 1000);
    expect(screen.getByText(at.toLocaleString('en', { dateStyle: 'medium', timeStyle: 'short' })))
      .toBeInTheDocument();
  });
});

describe('EventDetail · a venue left blank', () => {
  it('reads a public event without a venue as the default label 장소 미정', async () => {
    gql.mockResolvedValue({ Event: [EVENT_ONE], Tier: TIERS });
    fetchEventMetadata.mockResolvedValue({ ...META_A, venue: '' });
    renderDetail();
    await screen.findByRole('heading', { name: '재즈 나이트' });
    // 장소는 선택이다: 빈 공개 장소는 지역과 함께 'Venue TBD'으로 읽히고, 지도 링크는 없다.
    expect(await screen.findByText(/Seoul · Venue TBD/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Open in maps/ })).toBeNull();
  });
});

describe('EventDetail · what only ticket holders see', () => {
  const HIDDEN = {
    ...META_A, venue: '', region: 'KR-11', venueHidden: true, timeHidden: true,
    tags: ['재즈', '라이브'],
  };

  function hiddenEvent() {
    gql.mockResolvedValue({ Event: [EVENT_ONE], Tier: TIERS });
    fetchEventMetadata.mockResolvedValue(HIDDEN);
  }

  it('offers the region and a promise instead of the venue, to somebody without a ticket', async () => {
    hiddenEvent();
    setSession({ status: 'signedIn', account: ME });
    renderDetail();
    await screen.findByRole('heading', { name: '재즈 나이트' });
    expect(await screen.findByText(/Seoul · The venue is shown once you have a ticket/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Open in maps/ })).toBeNull();
  });

  it('shows the day and says the time comes with the ticket', async () => {
    hiddenEvent();
    setSession({ status: 'signedIn', account: ME });
    renderDetail();
    expect(await screen.findByText(/The start time is shown once you have a ticket/)).toBeInTheDocument();
    // The day itself stays public: an event nobody can date is one nobody can plan around.
    const day = new Date(Number(EVENT_ONE.startsAt) * 1000).toLocaleDateString('en', { dateStyle: 'medium' });
    expect(screen.getByText(new RegExp(day.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))).toBeInTheDocument();
  });

  it('gives a holder the real venue, the map link and the full time', async () => {
    hiddenEvent();
    getEventPrivate.mockResolvedValue({ venue: '서울 용산구 한남동 12' });
    setSession({ status: 'signedIn', account: ME });
    renderDetail();

    expect(await screen.findByRole('link', { name: /서울 용산구 한남동 12 · Open in maps/ }))
      .toHaveAttribute('href', expect.stringContaining('maps.google.com'));
    expect(getEventPrivate).toHaveBeenCalledWith({ eventId: '1' });
    expect(screen.queryByText(/The venue is shown once you have a ticket/)).toBeNull();
    expect(screen.queryByText(/The start time is shown once you have a ticket/)).toBeNull();
    // Two badges, because both halves were hidden and both are now this person's alone.
    expect(screen.getAllByText('Only you can see this')).toHaveLength(2);
  });

  it('never asks at all when nobody is signed in', async () => {
    hiddenEvent();
    renderDetail();
    expect(await screen.findByText(/The venue is shown once you have a ticket/)).toBeInTheDocument();
    expect(getEventPrivate).not.toHaveBeenCalled();
  });

  it('leaves the rest of the screen alone while the callable is still cold', async () => {
    hiddenEvent();
    getEventPrivate.mockReturnValue(new Promise(() => undefined));
    setSession({ status: 'signedIn', account: ME });
    renderDetail();
    // The tiers and the call to action are already there; only the venue line is waiting. For a
    // signed-in visitor the claim is the inline-sheet opener (a button), not the /claim link (B1).
    expect(await screen.findByRole('button', { name: 'Get a ticket' })).toBeInTheDocument();
    expect(screen.getByText(/Seoul · Checking/)).toBeInTheDocument();
  });

  it('asks nothing for an event whose organiser hid neither half', async () => {
    gql.mockResolvedValue({ Event: [EVENT_ONE], Tier: TIERS });
    setSession({ status: 'signedIn', account: ME });
    renderDetail();
    expect(await screen.findByRole('link', { name: /한남 · Open in maps/ })).toBeInTheDocument();
    expect(getEventPrivate).not.toHaveBeenCalled();
  });

  it('shows every tag the event carries', async () => {
    hiddenEvent();
    renderDetail();
    await screen.findByRole('heading', { name: '재즈 나이트' });
    expect(screen.getByText('재즈')).toBeInTheDocument();
    expect(screen.getByText('라이브')).toBeInTheDocument();
  });
});

/** T-EV-W11 · plan section B-2: two on a card, all of them on the detail screen, no filter. */
describe('Discover · tags on a card', () => {
  const FIVE = ['재즈', '라이브', '한남동', '심야', 'Free'];

  it('shows the first two and counts the rest into one chip', async () => {
    gql.mockResolvedValue({ Event: [EVENT_ONE] });
    fetchEventMetadata.mockResolvedValue({ ...META_A, tags: FIVE });
    renderDiscover();
    await screen.findByRole('link', { name: '재즈 나이트' });

    expect(screen.getByText('재즈')).toBeInTheDocument();
    expect(screen.getByText('라이브')).toBeInTheDocument();
    expect(screen.getByText('+3')).toBeInTheDocument();
    for (const tag of FIVE.slice(2)) expect(screen.queryByText(tag)).toBeNull();
  });

  it('counts nothing when they all fit', async () => {
    gql.mockResolvedValue({ Event: [EVENT_ONE] });
    fetchEventMetadata.mockResolvedValue({ ...META_A, tags: ['재즈', '라이브'] });
    renderDiscover();
    await screen.findByRole('link', { name: '재즈 나이트' });

    expect(screen.getByText('라이브')).toBeInTheDocument();
    expect(screen.queryByText(/^\+\d+$/)).toBeNull();
  });

  /**
   * Reading only. The indexer has no column for tags, so a tag filter would have to fetch
   * every event's document before the first card could be drawn — which is why none exists
   * and why a tag on a card is not pressable.
   */
  it('draws no row at all for an event with no tags, and never a pressable one', async () => {
    gql.mockResolvedValue({ Event: [EVENT_ONE] });
    fetchEventMetadata.mockResolvedValue({ ...META_A, tags: ['재즈'] });
    renderDiscover();
    await screen.findByRole('link', { name: '재즈 나이트' });

    expect(screen.getByText('재즈').tagName).toBe('LI');
    expect(screen.queryByRole('button', { name: '재즈' })).toBeNull();
    expect(screen.queryByRole('link', { name: '재즈' })).toBeNull();
  });
});

/**
 * visual R1-5 — the one primary action now lives in the bottom sticky bar, and which action it is
 * depends on the state: a holder is sent back to their ticket, and a non-holder is offered 받기 or
 * 신청 by whether the event needs approval. The ticket reads go through the same mocked `gql` the
 * claim sheet already uses, so `useMyTickets` sees this address holding token 42.
 */
describe('EventDetail · the sticky primary (visual R1-5)', () => {
  const HELD = { id: '42', eventId: '1', tier: 0, owner: ME.toLowerCase(), revoked: false };

  function heldIndexer() {
    gql.mockImplementation(async (query: string) => {
      if (query.includes('OwnedTickets')) return { Ticket: [HELD], Offer: [] };
      if (query.includes('TicketContext')) {
        return {
          CheckIn: [], Ticket: [HELD],
          Event: [{ id: '1', status: 'Published', startsAt: IN_TWO_DAYS, imageCid: 'cid-a' }],
          Tier: [{ eventId: '1', idx: 0, name: 'General' }],
        };
      }
      return { Event: [EVENT_ONE], Tier: TIERS };
    });
  }

  it('sends a holder back to their ticket, in the sticky bar', async () => {
    heldIndexer();
    setSession({ status: 'signedIn', account: ME });
    renderDetail();
    const link = await screen.findByRole('link', { name: 'View my ticket' });
    expect(link).toHaveAttribute('href', '/tickets/42');
    expect(link.closest('.sticky-bar')).not.toBeNull();
    // A holder is not offered the claim at all.
    expect(screen.queryByRole('button', { name: 'Get a ticket' })).toBeNull();
  });

  it('shows each kind with its price and puts the price on the button of a paid event', async () => {
    vi.stubEnv('VITE_ADDR_SETTLEMENT_VAULT', `0x${'11'.repeat(20)}`);
    vi.stubEnv('VITE_ADDR_USDC', `0x${'22'.repeat(20)}`);
    getSettlement.mockResolvedValueOnce({ priceUsdCentsByTier: { '0': 3000 } });
    try {
      gql.mockResolvedValue({ Event: [EVENT_ONE], Tier: TIERS });
      renderDetail();
      expect(await screen.findByText('General · $30')).toBeInTheDocument();
      expect(screen.getByText('60 left')).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Buy for $30' })).toHaveAttribute('href', '/claim/1');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('offers 신청하기 in the sticky bar for a non-holder when the event needs approval', async () => {
    gql.mockResolvedValue({ Event: [{ ...EVENT_ONE, approvalRequired: true }], Tier: TIERS });
    setSession({ status: 'anonymous' });
    renderDetail();
    const link = await screen.findByRole('link', { name: 'Request a ticket' });
    expect(link).toHaveAttribute('href', '/claim/1');
    expect(link.closest('.sticky-bar')).not.toBeNull();
  });

  it('offers 티켓 받기 in the sticky bar for a non-holder when no approval is needed', async () => {
    gql.mockResolvedValue({ Event: [EVENT_ONE], Tier: TIERS });
    setSession({ status: 'anonymous' });
    renderDetail();
    const link = await screen.findByRole('link', { name: 'Get a ticket' });
    expect(link).toHaveAttribute('href', '/claim/1');
    expect(link.closest('.sticky-bar')).not.toBeNull();
  });
});

/**
 * visual R1-7 — the detail screen leads with the event's face instead of text on white. The hero
 * is the ticket art an organiser chose (`eventArt/{eventId}`) first, the pinned poster next, and a
 * plain brand-colour block last. `loadEventArt` is the shared mock (test/mocks/eventArt.ts), so
 * only the test that wants a picture arms it.
 */
describe('EventDetail · the ticket art hero (visual R1-7)', () => {
  it('leads with the ticket art when the event has some, the title laid over it', async () => {
    gql.mockResolvedValue({ Event: [EVENT_ONE], Tier: TIERS });
    loadEventArt.mockResolvedValueOnce([{ preset: 'b' }]);
    const { container } = renderDetail();
    await screen.findByRole('heading', { name: '재즈 나이트' });
    const art = await screen.findByRole('img', { name: /재즈 나이트/ });
    expect(container.querySelector('.event-hero-art')).toContainElement(art);
    // The ticket art stands in for the poster, so no <img> hero is drawn beside it.
    expect(container.querySelector('img.event-hero')).toBeNull();
  });

  it('falls back to a brand-colour placeholder when there is neither art nor poster', async () => {
    gql.mockResolvedValue({ Event: [EVENT_ONE], Tier: TIERS });
    // META_A carries no image and the shared mock answers no stored art.
    const { container } = renderDetail();
    await screen.findByRole('heading', { name: '재즈 나이트' });
    expect(container.querySelector('.event-hero--placeholder')).not.toBeNull();
    expect(container.querySelector('img.event-hero')).toBeNull();
  });

  it('shows the pinned poster when there is one but no ticket art', async () => {
    gql.mockResolvedValue({ Event: [EVENT_ONE], Tier: TIERS });
    fetchEventMetadata.mockResolvedValue({ ...META_A, image: 'https://cdn.example/poster.jpg' });
    const { container } = renderDetail();
    await screen.findByRole('heading', { name: '재즈 나이트' });
    const poster = container.querySelector('img.event-hero') as HTMLImageElement | null;
    expect(poster?.getAttribute('src')).toBe('https://cdn.example/poster.jpg');
    expect(container.querySelector('.event-hero--placeholder')).toBeNull();
  });
});
