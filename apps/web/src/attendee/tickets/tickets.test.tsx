import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearSession, setSession } from '../../shared/session';

// The indexer is not deployed, so the transport is mocked and answers each document by name.
// Every assertion below is about what the screens do with the rows, never about how they arrive.
const gql = vi.fn();
vi.mock('../../shared/envio/client', () => ({ gql }));

// The gateway holding the readable half of an event, and the Firestore document holding its
// pictures. Both are mocked for the same reason: neither exists in a test run, and the screens
// are required to draw a ticket anyway when neither answers.
const fetchEventMetadata = vi.fn();
vi.mock('../../shared/envio/ipfs', () => ({
  fetchEventMetadata,
  gatewayUrl: (cid: string) => `https://gateway.test/${cid}`,
}));
/**
 * The art *document* is mocked, not the read of it: what `eventArt/{eventId}` holds is
 * whatever a callable, a hand edit or an older shape left there, and turning that into a
 * picture is the seam under test. Mocking `loadEventArt` itself would mock the seam away.
 */
const art: { docs: Map<string, unknown>; refuse: boolean } = { docs: new Map(), refuse: false };
/**
 * Who is signed in to Firebase, which is a different thing from the address in `setSession`:
 * `users/{uid}` is where the name printed on a ticket lives, and `uid` is what reads it.
 */
const me: { uid: string | null } = { uid: null };
vi.mock('../../shared/api/firebase', () => ({
  getDb: () => ({}),
  getFirebaseAuth: () => ({ currentUser: me.uid === null ? null : { uid: me.uid } }),
}));
vi.mock('firebase/firestore', () => ({
  doc: (_db: unknown, path: string, id: string) => ({ path, id }),
  getDoc: async (ref: { path: string; id: string }) => {
    if (art.refuse) throw new Error('permission-denied');
    const key = `${ref.path}/${ref.id}`;
    return { exists: () => art.docs.has(key), data: () => art.docs.get(key) };
  },
  addDoc: vi.fn(), collection: vi.fn(), deleteDoc: vi.fn(), getDocs: vi.fn(),
  limit: vi.fn(), onSnapshot: vi.fn(), orderBy: vi.fn(), query: vi.fn(),
  serverTimestamp: vi.fn(), setDoc: vi.fn(),
}));

const { TicketList } = await import('./List');
const { TicketDetail } = await import('./Detail');

const OWNER = `0x${'cd'.repeat(20)}`;
/** One fixed moment, so the date on the ticket is asserted against the same clock that drew it. */
const STARTS_AT = 1_790_000_000;
const STARTS_ON = new Date(STARTS_AT * 1000).toLocaleDateString('ko', { dateStyle: 'medium' });
const OTHER = `0x${'ef'.repeat(20)}`;
const NOW = Math.floor(Date.now() / 1000);

function ticket(id: string, extra: Record<string, unknown> = {}) {
  return { id, eventId: '7', tier: 0, owner: OWNER, transfers: 0, revoked: false, ...extra };
}

// One row per state: 입장 전, 입장 완료, 보내는 중, 취소됨(회수), 취소됨(행사 취소), 양도됨 —
// plus a handed-over ticket whose own event was called off, where 취소됨 has to win.
const OWNED = [ticket('1'), ticket('2'), ticket('3'), ticket('4', { revoked: true }), ticket('6', { eventId: '9' })];
const OFFERS = [
  { id: '3', from: OWNER, commitment: '0x01', expiresAt: String(NOW + 3_600), status: 'open' },
  { id: '5', from: OWNER, commitment: '0x02', expiresAt: String(NOW - 3_600), status: 'accepted' },
  { id: '10', from: OWNER, commitment: '0x03', expiresAt: String(NOW - 7_200), status: 'accepted' },
];
function checkIn(id: string) {
  return { id, gateId: '1', ts: String(NOW - 600), manual: false, txHash: '0xaa', block: '10' };
}

function tier(eventId: string, idx: number, name: string) {
  return { id: `${eventId}-${idx}`, eventId, idx, name };
}

const CONTEXT = {
  // #2 walked in and is 입장 완료. #4 walked in and was then revoked, so it reads 취소됨 and is
  // still a ticket that was used — the one row where the badge and the picture must disagree.
  CheckIn: [checkIn('2'), checkIn('4')],
  Event: [
    { id: '7', status: 'Published', imageCid: 'bafkevent7', startsAt: String(STARTS_AT) },
    { id: '9', status: 'Cancelled', imageCid: 'bafkevent9', startsAt: String(STARTS_AT) },
  ],
  Tier: [tier('7', 0, '일반'), tier('7', 1, '스탠딩'), tier('9', 0, '일반')],
  // Both handovers sit on events no held ticket names, so their status arrives one trip later.
  Ticket: [ticket('5', { owner: OTHER, eventId: '8' }), ticket('10', { owner: OTHER, eventId: '12' })],
};
const LATE_EVENTS = {
  Event: [
    { id: '8', status: 'Published', imageCid: 'bafkevent8', startsAt: String(STARTS_AT) },
    // An event the organiser never pinned a document for: there is no CID to even ask about,
    // and the index has no start time for it either — so its ticket carries no date.
    { id: '12', status: 'Cancelled', imageCid: '', startsAt: '0' },
  ],
  Tier: [tier('8', 0, '앞자리')],
};

/** The indexer answering every document by name — the state both screens start from. */
async function answerIndexer(query: string) {
  if (query.includes('OwnedTickets')) return { Ticket: OWNED, Offer: OFFERS };
  if (query.includes('TicketContext')) return CONTEXT;
  return LATE_EVENTS;
}

/** The gateway answering for the two events whose documents were pinned. */
async function answerGateway(cid: string) {
  const titles: Record<string, string> = { bafkevent7: '한여름 밤의 재즈', bafkevent9: '가을 페스티벌' };
  const title = titles[cid];
  if (!title) throw new Error('IPFS_404');
  return { title, description: '', image: '', venue: '', category: 0, region: '' };
}

/** One row of the list, found by the line that names it rather than by its position. */
function row(tokenId: string): HTMLElement {
  const link = document.querySelector(`a[href="/tickets/${tokenId}"]`);
  if (!(link instanceof HTMLElement)) throw new Error(`no ticket row #${tokenId}`);
  return link;
}

/**
 * The picture a row (or the whole detail screen) drew, as the preset letter it names.
 *
 * The backdrop is markup inside the ticket's own SVG now rather than a bundled file behind an
 * `<img src>`, and the letter is what a document stores — so this asserts the thing that was
 * read out of Firestore, not the file it happened to be bundled into.
 */
function presetIn(scope: HTMLElement | Document): string {
  return scope.querySelector('.ticket-art__svg')?.getAttribute('data-preset') ?? '';
}

/**
 * What `gql` rejects with. Built here rather than imported, because the module `EnvioError`
 * lives in is mocked at the top of this file — which is exactly why `describeFailure` reads
 * the shape (`name` + `kind`) instead of the class.
 */
function indexerFailure(kind: 'network' | 'http' | 'graphql' | 'empty', message: string): Error {
  return Object.assign(new Error(message), { name: 'EnvioError', kind });
}

const COULD_NOT_FETCH = '정보를 가져오지 못했어요. 잠시 뒤 다시 시도해 주세요.';
const NOT_RIGHT_NOW = '지금 정보를 가져올 수 없어요. 잠시 뒤 다시 시도해 주세요.';
const GENERIC = '문제가 생겼어요. 잠시 뒤 다시 시도해 주세요.';

beforeEach(() => {
  setSession({ status: 'signedIn', account: OWNER as `0x${string}` });
  gql.mockReset();
  gql.mockImplementation(answerIndexer);
  fetchEventMetadata.mockReset();
  fetchEventMetadata.mockImplementation(answerGateway);
  // No event has been through `saveEventArt` yet, which is the state the demo runs in today.
  art.docs.clear();
  art.refuse = false;
  me.uid = 'uid-1';
  art.docs.set('users/uid-1', { displayName: '김태완' });
});

afterEach(() => {
  // Unmount first: a session change with the screens still mounted is a React update
  // outside act(), which is noise rather than anything the attendee would see.
  cleanup();
  clearSession();
});

function renderList() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter><TicketList /></MemoryRouter>
    </QueryClientProvider>,
  );
}

function renderDetail(tokenId: string) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[`/tickets/${tokenId}`]}>
        <Routes><Route path="/tickets/:tokenId" element={<TicketDetail />} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('TicketList', () => {
  it('shows every derived state', async () => {
    renderList();
    await screen.findByRole('link', { name: /입장 전/ });
    expect(within(row('1')).getByText('입장 전')).toBeInTheDocument();
    expect(within(row('2')).getByText('입장 완료')).toBeInTheDocument();
    expect(within(row('3')).getByText('보내는 중')).toBeInTheDocument();
    expect(within(row('5')).getByText('친구에게 줌')).toBeInTheDocument();
    // A revoked ticket, a ticket on a called-off event and a ticket handed over out of one.
    expect(screen.getAllByRole('link', { name: /취소됨/ })).toHaveLength(3);
  });

  it('lets a called-off event outrank 양도됨 even when its status arrives a trip later', async () => {
    renderList();
    await screen.findAllByRole('link', { name: /취소됨/ });
    expect(within(row('10')).getByText('취소됨')).toBeInTheDocument();
    expect(within(row('10')).queryByText('친구에게 줌')).toBeNull();
  });

  it('asks the indexer only for the check-ins, events and handovers its own rows name', async () => {
    renderList();
    await screen.findByRole('link', { name: /입장 전/ });
    expect(gql).toHaveBeenNthCalledWith(2, expect.stringContaining('TicketContext'), {
      tokenIds: ['1', '2', '3', '4', '6'],
      eventIds: ['7', '9'],
      // The same ids a second time: `Tier` is filtered on a BigInt column, `Event` on its key.
      tierEventIds: ['7', '9'],
      handedOverIds: ['5', '10'],
    });
    // Only the events the second trip could not have named are asked for again.
    expect(gql).toHaveBeenNthCalledWith(3, expect.stringContaining('EventStates'), {
      eventIds: ['8', '12'],
      tierEventIds: ['8', '12'],
    });
    expect(gql).toHaveBeenCalledTimes(3);
  });

  it('shows the empty sentence when nothing is owned', async () => {
    gql.mockImplementation(async () => ({ Ticket: [], Offer: [] }));
    renderList();
    expect(await screen.findByText('아직 티켓이 없어요.')).toBeInTheDocument();
  });

  /** An indexer that answered badly is not the same thing as a phone with no connection. */
  it('names the cause when the list cannot be read', async () => {
    gql.mockReset();
    gql.mockRejectedValue(indexerFailure('http', 'HTTP_502'));
    renderList();
    expect(await screen.findByRole('alert')).toHaveTextContent(NOT_RIGHT_NOW);
    expect(screen.getByRole('button', { name: '다시 시도' })).toBeInTheDocument();
  });
});

describe('TicketDetail', () => {
  it('titles the screen with the event name rather than the token number', async () => {
    renderDetail('1');
    expect(await screen.findByRole('heading', { name: '한여름 밤의 재즈' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '#1' })).not.toBeInTheDocument();
  });

  it('shows the state, the door guide and the entry button before entry', async () => {
    renderDetail('1');
    expect(await screen.findByText('입장 전')).toBeInTheDocument();
    expect(screen.getByText('입구에서 입장하기를 누르고 60초 안에 단말기에 휴대폰을 대세요.')).toBeInTheDocument();
    expect(screen.getByText('보여줄 코드는 없어요.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '입장하기' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '친구에게 주기' })).toBeInTheDocument();
  });

  it('shows the ticket number staff search by, with a copy action', async () => {
    renderDetail('1');
    expect(await screen.findByText(/티켓 번호/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '번호 복사' })).toBeInTheDocument();
  });

  it('shows a short ticket number up front and keeps the full one under 상세', async () => {
    const tokenId = '7930739067677860193113749428633';
    gql.mockImplementation(async (query: string) =>
      query.includes('OwnedTickets') ? { Ticket: [...OWNED, ticket(tokenId)], Offer: OFFERS } : answerIndexer(query));
    renderDetail(tokenId);
    const line = await screen.findByText(/티켓 번호/);
    expect(line).toHaveTextContent('No. 42-8633');
    expect(line).not.toHaveTextContent(tokenId);
    const details = screen.getByText('상세').closest('details');
    expect(details).not.toBeNull();
    expect(details).toHaveTextContent(tokenId);
    expect(details).not.toHaveAttribute('open');
  });

  it('drops the entry and handover buttons once the ticket is used', async () => {
    renderDetail('2');
    expect(await screen.findByText('입장 완료')).toBeInTheDocument();
    expect(screen.queryByText('입구에서 입장하기를 누르고 60초 안에 단말기에 휴대폰을 대세요.')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '입장하기' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '친구에게 주기' })).not.toBeInTheDocument();
  });

  /**
   * The bug T-UX-8 fixed here: this screen looks its ticket up in a list it reads from the
   * indexer, so a read that never arrived used to render as "there is no such ticket" — the
   * owner of the ticket told they do not own it, with nothing to press. A failure and an
   * absence are now two different answers.
   */
  it('says the read failed, and retries it, rather than calling the ticket missing', async () => {
    gql.mockReset();
    gql.mockRejectedValueOnce(indexerFailure('network', 'REQUEST_FAILED'));
    gql.mockImplementation(answerIndexer);
    renderDetail('1');

    expect(await screen.findByRole('alert')).toHaveTextContent(COULD_NOT_FETCH);
    expect(screen.queryByText(GENERIC)).not.toBeInTheDocument();

    // The retry is the point of the branch: the second read succeeds and the ticket appears.
    await userEvent.click(screen.getByRole('button', { name: '다시 시도' }));
    expect(await screen.findByText('입장 전')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  /**
   * The other half of the same fix: the list really did arrive and really does not hold this
   * id. Nothing to retry, so the way out is the list itself — and the button says so.
   */
  it('keeps the not-found path for a ticket the list simply does not hold', async () => {
    renderDetail('999');
    expect(await screen.findByRole('alert')).toHaveTextContent(GENERIC);
    expect(screen.queryByRole('button', { name: '다시 시도' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '내 티켓' })).toBeInTheDocument();
  });
});

/**
 * T-EV-W9. The ticket tab had no picture at all before this — the whole app had one `<img>` —
 * so these say what the picture is for: which ticket wears the 사용됨 band, and that a ticket
 * always has a picture even when neither the gateway nor Firestore hands one over.
 */
describe('ticket art', () => {
  it('bands the ticket that was used, and only that one', async () => {
    renderList();
    await screen.findByRole('link', { name: /입장 전/ });
    expect(within(row('2')).getByText('사용됨')).toBeInTheDocument();
    expect(within(row('1')).queryByText('사용됨')).toBeNull();
    expect(within(row('3')).queryByText('사용됨')).toBeNull();
  });

  /**
   * The reason the picture reads the check-in itself and not the state word beside it: the
   * badge order puts 취소됨 above 입장 완료, so a ticket revoked after somebody had already
   * walked in on it shows 취소됨 — and is still, unchangeably, a ticket that was used.
   */
  it('keeps the used art on a ticket that was revoked after it was used', async () => {
    renderList();
    await screen.findAllByRole('link', { name: /취소됨/ });
    expect(within(row('4')).getByText('취소됨')).toBeInTheDocument();
    expect(within(row('4')).getByText('사용됨')).toBeInTheDocument();
  });

  it('draws the stored preset, and the bundled one where there is no document', async () => {
    art.docs.set('eventArt/7', { tiers: [{ design: 'c' }] });
    renderList();
    await screen.findByRole('link', { name: /입장 전/ });
    await waitFor(() => expect(presetIn(row('1'))).toBe('c'));
    // #5 belongs to an event `saveEventArt` has never been called for — the ordinary case.
    expect(presetIn(row('5'))).toBe('a');
  });

  /**
   * The seam this whole read exists behind: the draft screen still writes `design: 'aurora'`
   * from before the presets were named a–d, and a document can be hand-edited into anything at
   * all. A value the reader does not know becomes the first bundled preset rather than a hole.
   */
  it('falls back to the bundled preset for a design key it does not know', async () => {
    art.docs.set('eventArt/7', { tiers: [{ design: 'aurora' }] });
    art.docs.set('eventArt/8', { tiers: [{ design: 'c' }] });
    renderList();
    await screen.findByRole('link', { name: /입장 전/ });
    // The same render honours a key it does know, so this is a fallback and not a dead read.
    await waitFor(() => expect(presetIn(row('5'))).toBe('c'));
    expect(presetIn(row('1'))).toBe('a');
  });

  /** A picture nobody could read is a picture, never an error the list stops at. */
  it('still draws every row when the art document cannot be read at all', async () => {
    art.refuse = true;
    renderList();
    await screen.findByRole('link', { name: /입장 전/ });
    expect(presetIn(row('1'))).toBe('a');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('captions the picture with the event and the ticket kind', async () => {
    renderList();
    await screen.findByRole('link', { name: /입장 전/ });
    await waitFor(() => expect(within(row('1')).getAllByText('한여름 밤의 재즈').length).toBeGreaterThan(0));
    expect(within(row('1')).getByText('일반')).toBeInTheDocument();
  });

  /**
   * The name is `users/{uid}.displayName` and not the chain nickname: that one is
   * `^[a-z0-9_]{3,20}$` and cannot hold a Korean name at all (plan section E-3). It is read in
   * `useTicketArtProps` and nowhere else, so the list and the detail screen cannot disagree.
   */
  it('prints whose ticket it is, from the profile', async () => {
    renderList();
    await screen.findByRole('link', { name: /입장 전/ });
    await waitFor(() => expect(within(row('1')).getByText('김태완')).toBeInTheDocument());
    // Every row is the same person's, so every row carries the same name.
    expect(within(row('5')).getByText('김태완')).toBeInTheDocument();
  });

  it('falls back to a word for somebody who never gave a name', async () => {
    art.docs.set('users/uid-1', { displayName: '' });
    renderList();
    await screen.findByRole('link', { name: /입장 전/ });
    await waitFor(() => expect(within(row('1')).getByText('게스트')).toBeInTheDocument());
    expect(within(row('1')).queryByText('김태완')).toBeNull();
  });

  it('falls back to the same word when there is no profile document at all', async () => {
    me.uid = null;
    renderList();
    await screen.findByRole('link', { name: /입장 전/ });
    await waitFor(() => expect(within(row('1')).getByText('게스트')).toBeInTheDocument());
  });

  /** The start time comes off the indexer's `Event.startsAt`, formatted for the locale. */
  it('prints the day the event starts', async () => {
    renderList();
    await screen.findByRole('link', { name: /입장 전/ });
    await waitFor(() => expect(within(row('1')).getAllByText(STARTS_ON).length).toBeGreaterThan(0));
  });

  /** A ticket the index has no start time for carries no date — never a placeholder one. */
  it('draws no date for a ticket whose event named no start', async () => {
    renderList();
    await screen.findAllByRole('link', { name: /취소됨/ });
    await waitFor(() => expect(within(row('1')).getAllByText(STARTS_ON).length).toBeGreaterThan(0));
    expect(within(row('10')).queryByText(STARTS_ON)).toBeNull();
    // The stub is drawn all the same — the name is on it, the date line simply is not there.
    expect(within(row('10')).getByText('김태완')).toBeInTheDocument();
  });

  /** A gateway that will not answer costs the ticket its title, never its row. */
  it('names a ticket whose event nothing could describe', async () => {
    renderList();
    await screen.findByRole('link', { name: /입장 전/ });
    // #5's document 404s at the gateway; #10's event was never pinned one to ask about. Both fail.
    await waitFor(() => expect(within(row('5')).getAllByText('행사 이름을 불러오지 못했어요').length).toBeGreaterThan(0));
    expect(within(row('10')).getAllByText('행사 이름을 불러오지 못했어요').length).toBeGreaterThan(0);
    // And #10's event named no tier either, so the kind falls back to a word of its own.
    expect(within(row('10')).getByText('티켓')).toBeInTheDocument();
  });

  it('shows the same ticket, banded, on the detail screen', async () => {
    renderDetail('2');
    expect(await screen.findByText('입장 완료')).toBeInTheDocument();
    expect(screen.getByText('사용됨')).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByText('한여름 밤의 재즈').length).toBeGreaterThan(0));
    expect(presetIn(document)).toBe('a');
  });

  it('hands the detail screen the same name and the same date as the list', async () => {
    renderDetail('1');
    expect(await screen.findByText('입장 전')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('김태완')).toBeInTheDocument());
    expect(screen.getByText(STARTS_ON)).toBeInTheDocument();
  });

  it('leaves the band off a ticket the detail screen still lets you enter with', async () => {
    renderDetail('1');
    expect(await screen.findByText('입장 전')).toBeInTheDocument();
    expect(screen.queryByText('사용됨')).toBeNull();
    expect(screen.getByRole('button', { name: '입장하기' })).toBeInTheDocument();
  });
});

/**
 * The event name is read from IPFS a beat after the row itself, so the ticket art shows a shimmer
 * placeholder until it lands, the name once it has, and the fallback word only once the read failed.
 */
describe('ticket title', () => {
  it('shimmers a placeholder while the name is still loading', async () => {
    fetchEventMetadata.mockImplementation(() => new Promise<never>(() => {}));
    renderList();
    await screen.findByRole('link', { name: /입장 전/ });
    // The row is here off the indexer; the name is not, so its line shimmers — neither the name nor
    // the failure fallback is shown yet.
    await waitFor(() => expect(row('1').querySelector('.ticket-art__title-skeleton')).not.toBeNull());
    expect(within(row('1')).queryByText('한여름 밤의 재즈')).toBeNull();
    expect(within(row('1')).queryByText('행사 이름을 불러오지 못했어요')).toBeNull();
  });

  it('shows the name once it has loaded, and no shimmer', async () => {
    renderList();
    await screen.findByRole('link', { name: /입장 전/ });
    await waitFor(() => expect(within(row('1')).getAllByText('한여름 밤의 재즈').length).toBeGreaterThan(0));
    expect(row('1').querySelector('.ticket-art__title-skeleton')).toBeNull();
  });

  it('falls back to the word only once the read has failed', async () => {
    fetchEventMetadata.mockRejectedValue(new Error('IPFS_500'));
    renderList();
    await screen.findByRole('link', { name: /입장 전/ });
    await waitFor(() => expect(within(row('1')).getAllByText('행사 이름을 불러오지 못했어요').length).toBeGreaterThan(0));
    expect(row('1').querySelector('.ticket-art__title-skeleton')).toBeNull();
  });
});
