import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { keccak256, toBytes } from 'viem';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

const { setSession } = await import('../../shared/session');
const { Discover } = await import('./Discover');
const { EventDetail } = await import('./EventDetail');
const { METADATA_CONCURRENCY, mapWithPool } = await import('./useEvents');

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
  { id: '1-0', eventId: '1', idx: 0, name: '일반', priceUsdCents: '0', supply: '100', minted: '40', maxPerWallet: '2', seated: false },
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
  await userEvent.click(await screen.findByRole('button', { name: '만들기' }));
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
    expect(screen.getAllByText('본인인증 필수')).toHaveLength(1);
    expect(screen.getByRole('link', { name: /재즈 나이트/ })).toHaveAttribute('href', '/events/1');
  });

  it('filters the loaded page by the title search box', async () => {
    renderDiscover();
    expect(await screen.findByText('재즈 나이트')).toBeInTheDocument();
    await userEvent.type(screen.getByPlaceholderText('행사 이름 검색'), '개발자');
    expect(screen.queryByText('재즈 나이트')).toBeNull();
    expect(screen.getByText('개발자 모임')).toBeInTheDocument();
    expect(screen.queryByText('본인인증 필수')).toBeNull();
  });

  it('narrows by date, region and theme', async () => {
    renderDiscover();
    expect(await screen.findByText('재즈 나이트')).toBeInTheDocument();

    await userEvent.selectOptions(screen.getByLabelText('날짜'), 'week');
    expect(screen.queryByText('개발자 모임')).toBeNull();
    expect(screen.getByText('재즈 나이트')).toBeInTheDocument();

    await userEvent.selectOptions(screen.getByLabelText('날짜'), 'all');
    await userEvent.selectOptions(screen.getByLabelText('지역'), 'KR-26');
    expect(screen.queryByText('재즈 나이트')).toBeNull();
    expect(screen.getByText('개발자 모임')).toBeInTheDocument();

    await userEvent.selectOptions(screen.getByLabelText('지역'), '');
    await userEvent.selectOptions(screen.getByLabelText('테마'), '0');
    expect(screen.getByText('재즈 나이트')).toBeInTheDocument();
    expect(screen.queryByText('개발자 모임')).toBeNull();
  });

  it('remembers the last filter across mounts', async () => {
    const first = renderDiscover();
    expect(await screen.findByText('재즈 나이트')).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText('지역'), 'KR-26');
    first.unmount();

    renderDiscover();
    expect(await screen.findByText('개발자 모임')).toBeInTheDocument();
    expect(screen.queryByText('재즈 나이트')).toBeNull();
  });

  it('keeps an event whose metadata never arrives, under a neutral placeholder', async () => {
    fetchEventMetadata.mockImplementation((cid: string) =>
      cid === 'cid-a' ? Promise.resolve(META_A) : Promise.reject(new Error('IPFS_504')),
    );
    renderDiscover();
    expect(await screen.findByText('재즈 나이트')).toBeInTheDocument();
    expect(screen.getByText('제목을 불러오지 못했어요')).toBeInTheDocument();
  });

  /**
   * Two failures, two sentences. The request that never arrived is worth pressing 다시 시도 on;
   * the answer that came back broken is not, so it says "not right now" instead — which is the
   * whole reason `describeFailure` exists rather than one line for both.
   */
  it('says the page did not arrive when the request never got there', async () => {
    gql.mockRejectedValue(indexerFailure('network', 'REQUEST_FAILED'));
    renderDiscover();
    expect(await screen.findByRole('alert')).toHaveTextContent('정보를 가져오지 못했어요. 잠시 뒤 다시 시도해 주세요.');
    expect(screen.getByRole('button', { name: '다시 시도' })).toBeInTheDocument();
  });

  it('says the information is not available right now when the indexer answers badly', async () => {
    gql.mockRejectedValue(indexerFailure('http', 'HTTP_500'));
    renderDiscover();
    expect(await screen.findByRole('alert')).toHaveTextContent('지금 정보를 가져올 수 없어요. 잠시 뒤 다시 시도해 주세요.');
    expect(screen.getByRole('button', { name: '다시 시도' })).toBeInTheDocument();
  });

  it('keeps the general line for a failure that is nobody\u2019s named cause', async () => {
    gql.mockRejectedValue(new Error('boom'));
    renderDiscover();
    expect(await screen.findByRole('alert')).toHaveTextContent('문제가 생겼어요. 잠시 뒤 다시 시도해 주세요.');
  });
});

/**
 * One button, five answers. The whole point of the table is that the person never has to know
 * which of them applies to them — so every row is checked here, through the router, rather
 * than through the hook that decides it.
 */
describe('Discover · 만들기', () => {
  it('shows the button to a visitor who is not signed in, rather than hiding the way in', async () => {
    renderDiscoverTracked();
    expect(await screen.findByRole('button', { name: '만들기' })).toBeEnabled();
  });

  it('sends a visitor who is not signed in to signing up', async () => {
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

  it('hands somebody who belongs but may not create to the screen that explains why', async () => {
    setSession({ status: 'signedIn', account: ME });
    myOrgs({ orgs: [ORG_NO_PERMISSION], canCreateEvent: false });
    const seen = renderDiscoverTracked();
    await tapCreate();
    // `/org` already carries `행사를 만들 권한이 없어요…`; no second sentence is written here.
    expect(seen.at(-1)).toBe('/org');
  });

  it('still leads somewhere while the indexer has not answered', async () => {
    setSession({ status: 'signedIn', account: ME });
    myOrgs({ isLoading: true });
    const seen = renderDiscoverTracked();
    await tapCreate();
    expect(seen.at(-1)).toBe('/org');
  });

  it('still leads somewhere when the indexer will not answer at all', async () => {
    setSession({ status: 'signedIn', account: ME });
    myOrgs({ isError: true });
    const seen = renderDiscoverTracked();
    await tapCreate();
    // The organiser home owns that failure and offers its own retry there.
    expect(seen.at(-1)).toBe('/org');
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

describe('EventDetail', () => {
  it('shows the gateway metadata and the tiers', async () => {
    gql.mockResolvedValue({ Event: [EVENT_ONE], Tier: TIERS });
    renderDetail();
    expect(await screen.findByRole('heading', { name: '재즈 나이트' })).toBeInTheDocument();
    expect(screen.getByText('한남동의 밤')).toBeInTheDocument();
    expect(screen.getByText('일반')).toBeInTheDocument();
    expect(screen.getByText('60자리 남음')).toBeInTheDocument();
    expect(screen.getByText('본인인증 필수')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '티켓 받기' })).toHaveAttribute('href', '/claim/1');
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
    expect(await screen.findByText('취소된 행사예요.')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '티켓 받기' })).toBeNull();
  });

  it('hides the share button where the phone has no share sheet', async () => {
    gql.mockResolvedValue({ Event: [EVENT_ONE], Tier: TIERS });
    renderDetail();
    await screen.findByRole('heading', { name: '재즈 나이트' });
    expect(screen.queryByRole('button', { name: '공유' })).toBeNull();
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
      await userEvent.click(screen.getByRole('button', { name: '공유' }));
      expect(share).toHaveBeenCalledWith({ url: window.location.href });
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    } finally {
      Reflect.deleteProperty(navigator, 'share');
    }
  });

  it('shows an error state when the event cannot be read', async () => {
    gql.mockRejectedValue(indexerFailure('graphql', 'QUERY_FAILED'));
    renderDetail();
    expect(await screen.findByRole('alert')).toHaveTextContent('지금 정보를 가져올 수 없어요. 잠시 뒤 다시 시도해 주세요.');
    expect(screen.getByRole('button', { name: '다시 시도' })).toBeInTheDocument();
  });

  /**
   * The indexer answered and simply has no such event. That is this screen's own `Error`, not
   * an indexer kind, so it keeps the general line rather than blaming the indexer.
   */
  it('keeps the general line for an event id the indexer does not know', async () => {
    gql.mockResolvedValue({ Event: [], Tier: [] });
    renderDetail('404');
    expect(await screen.findByRole('alert')).toHaveTextContent('문제가 생겼어요. 잠시 뒤 다시 시도해 주세요.');
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
    expect(screen.getByText(at.toLocaleDateString('ko', { dateStyle: 'medium' }))).toBeInTheDocument();
    // Not merely a different string: no card carries a clock at all.
    expect(screen.queryByText(/\d{1,2}:\d{2}/)).toBeNull();
    expect(screen.queryByText(at.toLocaleString('ko', { dateStyle: 'medium', timeStyle: 'short' }))).toBeNull();
  });

  it('still prints the full time for an event that hid nothing', async () => {
    gql.mockResolvedValue({ Event: [EVENT_ONE] });
    fetchEventMetadata.mockResolvedValue(META_A);
    renderDiscover();
    await screen.findByRole('link', { name: '재즈 나이트' });
    const at = new Date(Number(EVENT_ONE.startsAt) * 1000);
    expect(screen.getByText(at.toLocaleString('ko', { dateStyle: 'medium', timeStyle: 'short' })))
      .toBeInTheDocument();
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
    expect(await screen.findByText(/서울 · 장소는 티켓을 받으면 공개돼요/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /지도로 보기/ })).toBeNull();
  });

  it('shows the day and says the time comes with the ticket', async () => {
    hiddenEvent();
    setSession({ status: 'signedIn', account: ME });
    renderDetail();
    expect(await screen.findByText(/시작 시각은 티켓을 받으면 공개돼요/)).toBeInTheDocument();
    // The day itself stays public: an event nobody can date is one nobody can plan around.
    const day = new Date(Number(EVENT_ONE.startsAt) * 1000).toLocaleDateString('ko', { dateStyle: 'medium' });
    expect(screen.getByText(new RegExp(day.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))).toBeInTheDocument();
  });

  it('gives a holder the real venue, the map link and the full time', async () => {
    hiddenEvent();
    getEventPrivate.mockResolvedValue({ venue: '서울 용산구 한남동 12' });
    setSession({ status: 'signedIn', account: ME });
    renderDetail();

    expect(await screen.findByRole('link', { name: /서울 용산구 한남동 12 · 지도로 보기/ }))
      .toHaveAttribute('href', expect.stringContaining('maps.google.com'));
    expect(getEventPrivate).toHaveBeenCalledWith({ eventId: '1' });
    expect(screen.queryByText(/장소는 티켓을 받으면 공개돼요/)).toBeNull();
    expect(screen.queryByText(/시작 시각은 티켓을 받으면 공개돼요/)).toBeNull();
    // Two badges, because both halves were hidden and both are now this person's alone.
    expect(screen.getAllByText('나만 보여요')).toHaveLength(2);
  });

  it('never asks at all when nobody is signed in', async () => {
    hiddenEvent();
    renderDetail();
    expect(await screen.findByText(/장소는 티켓을 받으면 공개돼요/)).toBeInTheDocument();
    expect(getEventPrivate).not.toHaveBeenCalled();
  });

  it('leaves the rest of the screen alone while the callable is still cold', async () => {
    hiddenEvent();
    getEventPrivate.mockReturnValue(new Promise(() => undefined));
    setSession({ status: 'signedIn', account: ME });
    renderDetail();
    // The tiers and the call to action are already there; only the venue line is waiting.
    expect(await screen.findByRole('link', { name: '티켓 받기' })).toBeInTheDocument();
    expect(screen.getByText(/서울 · 확인하고 있어요/)).toBeInTheDocument();
  });

  it('asks nothing for an event whose organiser hid neither half', async () => {
    gql.mockResolvedValue({ Event: [EVENT_ONE], Tier: TIERS });
    setSession({ status: 'signedIn', account: ME });
    renderDetail();
    expect(await screen.findByRole('link', { name: /한남 · 지도로 보기/ })).toBeInTheDocument();
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
  const FIVE = ['재즈', '라이브', '한남동', '심야', '무료'];

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
