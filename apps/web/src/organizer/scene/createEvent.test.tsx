import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventDraft, StoredEventDraft } from '../../shared/api/firestore';

/** The draft collection, in memory. The hook reads it on mount and writes to it on a debounce. */
let store: StoredEventDraft[] = [];
const listEventDrafts = vi.fn(async () => [...store].sort((a, b) => b.updatedAt - a.updatedAt));
const saveEventDraft = vi.fn(async (id: string, draft: EventDraft) => {
  store = [...store.filter((row) => row.id !== id), { id, updatedAt: Date.now(), data: draft }];
});
const deleteEventDraft = vi.fn(async (id: string) => {
  store = store.filter((row) => row.id !== id);
});
const loadMyProfile = vi.fn(async () => ({ displayName: '김태완' }));
vi.mock('../../shared/api/firestore', () => ({
  listEventDrafts, saveEventDraft, deleteEventDraft, loadMyProfile,
}));
/** The indexer's answer about this person as an organiser, which the scene now reads too. */
const orgRefetch = vi.fn(async () => [] as { orgId: string; canCreateEvent: boolean }[]);
const orgsListed = vi.fn(() => [] as { orgId: string; canCreateEvent: boolean }[]);
vi.mock('../useMyOrgs', () => ({
  useMyOrgs: () => ({
    orgs: orgsListed(), canCreateEvent: false, isLoading: false, isError: false,
    error: null, refetch: orgRefetch,
  }),
}));


const pinEventImage = vi.fn(async (_args: { bytesBase64: string; kind: string }) => ({ cid: 'bafkposter' }));
vi.mock('../../shared/api/functions', async (orig) => ({
  ...(await orig<typeof import('../../shared/api/functions')>()),
  api: { pinEventImage },
}));

// jsdom has neither `createImageBitmap` nor a canvas that encodes; the pixel arithmetic has
// its own tests (T-EV-W1). What is under test here is the wiring from the crop to the pin.
vi.mock('../../shared/ui/a4Crop', async (orig) => ({
  ...(await orig<typeof import('../../shared/ui/a4Crop')>()),
  cropToA4: vi.fn(async () => ({ blob: new Blob(), base64: 'AQID', width: 1240, height: 1754 })),
}));

vi.mock('../../shared/config', async (orig) => ({
  ...(await orig<typeof import('../../shared/config')>()),
  getConfig: () => ({ ipfsGateway: 'https://gw.test/' }),
}));

const { CreateEvent } = await import('./CreateEvent');
const { THEME_CODES } = await import('../../shared/eventThemes');
const { toLocalInput } = await import('./datetime');
const { ko: sharedCopy } = await import('../../shared/copy/index');
const { EVENT_DRAFT_KEY, emptyEventDraft } = await import('../useEventDraft');
const { organizerCopy } = await import('../copy');
const copy = organizerCopy.ko.scene;

/** Where a navigation landed, so the route SCENE 1 hands over to is checked and not guessed. */
function Probe() {
  return <p>{`landed:${useLocation().pathname}`}</p>;
}

const READY: EventDraft = {
  ...emptyEventDraft,
  orgId: '9',
  title: '재즈 나이트',
  description: '한남동 라이브',
  posterCid: 'bafkposter',
  regionCode: 'KR-11',
  venue: '서울 용산구 한남동',
  startsAt: 1_790_000_000,
  endsAt: 1_790_010_000,
};

function open(path = '/org/new'): void {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/org/new" element={<CreateEvent />} />
        <Route path="/org/new/:draftId" element={<CreateEvent />} />
        <Route path="*" element={<Probe />} />
      </Routes>
    </MemoryRouter>,
  );
}

/** The device copy is written synchronously on every change, so it is the live draft. */
function mirror(): EventDraft {
  const raw = localStorage.getItem(EVENT_DRAFT_KEY);
  return JSON.parse(raw ?? '{}').draft as EventDraft;
}

function seed(id: string, draft: Partial<EventDraft>, updatedAt = 1_000): void {
  store = [...store, { id, updatedAt, data: { ...emptyEventDraft, ...draft } }];
}

beforeAll(() => {
  // The cropper previews the chosen file through an object URL, which jsdom does not have.
  URL.createObjectURL = () => 'blob:poster';
  URL.revokeObjectURL = () => undefined;
});

beforeEach(() => {
  localStorage.clear();
  store = [];
  pinEventImage.mockResolvedValue({ cid: 'bafkposter' });
});

describe('the scene layout', () => {
  /**
   * Five fields and one button (plan section B-2). The poster, the title, the start, the place
   * and the one ticket kind are what an event needs; everything else waits behind the fold.
   */
  it('shows five fields and folds the rest away', async () => {
    open();
    await waitFor(() => expect(listEventDrafts).toHaveBeenCalled());
    // Two folds carry the same word: the kind card's own, and the scene's — this is the
    // scene's, which comes last.
    const folds = screen.getAllByText(copy.more);
    expect(folds).toHaveLength(2);
    expect(folds.every((summary) => (summary.closest('details') as HTMLDetailsElement).open)).toBe(false);

    for (const field of [copy.titleLabel, copy.startsAt, copy.regionLabel, copy.placeLabel, copy.tiers.name]) {
      expect(screen.getByLabelText(field).closest('details')).toBeNull();
    }
    // The poster card and the ticket kind are the two that are not plain boxes.
    expect(screen.getByRole('heading', { level: 2, name: copy.poster }).closest('details')).toBeNull();
    expect(screen.getByLabelText(copy.tiers.supply).closest('details')).toBeNull();

    // And everything the founder never has to see again.
    for (const folded of [copy.bodyLabel, copy.themeLabel, copy.tagAdd, copy.endsAt, copy.tiers.maxPerWallet]) {
      expect(screen.getByLabelText(folded).closest('details')).not.toBeNull();
    }
  });

  it('keeps the tickets in the same scroll as the event', async () => {
    open();
    await waitFor(() => expect(listEventDrafts).toHaveBeenCalled());
    // The ticket screen is gone: its one kind is a section here (plan section B-1), and it
    // starts named, so nothing on this screen is a required box that opens empty.
    expect(screen.getByLabelText(copy.tiers.name)).toHaveValue('일반');
    expect(screen.getByLabelText(copy.tiers.supply)).toHaveValue('100');
  });

  it('shows the organisation number nowhere: the address already carries it', async () => {
    open('/org/new?org=7');
    await waitFor(() => expect(listEventDrafts).toHaveBeenCalled());
    // Named rather than keyed off the deleted wizard's copy: no box asks for it at all.
    expect(screen.queryByLabelText(/조직/)).toBeNull();

    // It still reaches the draft, which is the only thing that needed it.
    await userEvent.setup().type(screen.getByLabelText(copy.titleLabel), '재');
    expect(mirror().orgId).toBe('7');
  });

  it('says a draft is being carried on, and can start over', async () => {
    seed('kept', { title: '지난 초안' });
    open();
    await waitFor(() => expect(screen.getByLabelText(copy.titleLabel)).toHaveValue('지난 초안'));
    expect(screen.getByText(new RegExp(copy.resumed))).toBeInTheDocument();

    await userEvent.setup().click(screen.getByRole('button', { name: copy.startOver }));
    await waitFor(() => expect(screen.getByLabelText(copy.titleLabel)).toHaveValue(''));
    expect(deleteEventDraft).toHaveBeenCalledWith('kept');
  });

  it('opens the draft the address names rather than the newest one', async () => {
    seed('older', { title: '지목한 초안' }, 500);
    seed('newest', { title: '가장 최근 초안' }, 2_000);
    open('/org/new/older');
    await waitFor(() => expect(screen.getByLabelText(copy.titleLabel)).toHaveValue('지목한 초안'));
  });
});

describe('the one button', () => {
  it('never blocks 만들기, and only names what is missing once it has been pressed', async () => {
    const user = userEvent.setup();
    open();
    await waitFor(() => expect(listEventDrafts).toHaveBeenCalled());
    expect(screen.getByRole('button', { name: copy.tiers.create })).toBeEnabled();
    expect(screen.queryByText(copy.problems.poster)).toBeNull();

    await user.click(screen.getByRole('button', { name: copy.tiers.create }));
    expect(screen.getByText(copy.problems.poster)).toBeInTheDocument();
    expect(screen.getByText(copy.problems.title)).toBeInTheDocument();
    expect(screen.getByText(copy.problems.venue)).toBeInTheDocument();
    // Still here: an unfinished field is a message, not a wall — and never a second screen.
    expect(screen.queryByText(/^landed:/)).toBeNull();
  });

  /** The founder's second tap: 다음 followed by 행사 만들기 was two for one intention. */
  it('is the only button in the bar, and there is no 다음 left to press', async () => {
    seed('d-42', READY);
    open('/org/new/d-42');
    await waitFor(() => expect(screen.getByLabelText(copy.titleLabel)).toHaveValue(READY.title));
    expect(screen.getByRole('button', { name: copy.tiers.create })).toBeEnabled();
    expect(screen.queryByText('landed:/org/new/d-42/tickets')).toBeNull();
  });

  it('says the end has to come after the start', async () => {
    seed('d-1', { ...READY, endsAt: READY.startsAt });
    open('/org/new/d-1');
    await waitFor(() => expect(screen.getByLabelText(copy.titleLabel)).toHaveValue(READY.title));
    await userEvent.setup().click(screen.getByRole('button', { name: copy.tiers.create }));
    expect(screen.getByText(copy.problems.schedule)).toBeInTheDocument();
  });
});

describe('the poster', () => {
  /** One full-screen modal: pick, frame, confirm — and it is gone (plan section D-1). */
  async function crop(user: ReturnType<typeof userEvent.setup>): Promise<void> {
    await user.click(screen.getByRole('button', { name: copy.posterAdd }));
    const file = new File([new Uint8Array([1, 2, 3])], 'poster.jpg', { type: 'image/jpeg' });
    await user.upload(screen.getByLabelText(sharedCopy.poster.pick), file);
    await user.click(await screen.findByRole('button', { name: sharedCopy.poster.crop }));
  }

  it('pins the crop straight away and keeps only the CID in the draft', async () => {
    const user = userEvent.setup();
    open();
    await waitFor(() => expect(listEventDrafts).toHaveBeenCalled());
    await crop(user);

    await waitFor(() => expect(pinEventImage).toHaveBeenCalledWith({ bytesBase64: 'AQID', kind: 'poster' }));
    await waitFor(() => expect(mirror().posterCid).toBe('bafkposter'));
    // The picture itself is never in the draft: a Firestore document stops at 1 MiB.
    expect(JSON.stringify(mirror())).not.toContain('AQID');
    // The bytes on the card are the ones just cropped, and they stay that way: the gateway is
    // never asked for a picture this tab already holds (plan section D-2, suspect 2).
    const preview = await screen.findByAltText(copy.posterAlt);
    expect(preview).toHaveAttribute('src', 'blob:poster');
    expect(preview.getAttribute('src')).not.toContain('gw.test');
  });

  it('says which photo to pick next when the server refuses this one', async () => {
    const user = userEvent.setup();
    pinEventImage.mockRejectedValue({ code: 'invalid-argument', message: 'BAD_IMAGE_FORMAT' });
    open();
    await waitFor(() => expect(listEventDrafts).toHaveBeenCalled());
    await crop(user);

    expect(await screen.findByText(copy.imageProblems.format)).toBeInTheDocument();
    // A refused pin changes nothing: no CID, and so nothing was written to the draft at all.
    expect(localStorage.getItem(EVENT_DRAFT_KEY)).toBeNull();
  });

  it('separates the daily limit from a failure worth retrying', async () => {
    const user = userEvent.setup();
    pinEventImage.mockRejectedValue({ code: 'resource-exhausted', message: 'PIN_QUOTA' });
    open();
    await waitFor(() => expect(listEventDrafts).toHaveBeenCalled());
    await crop(user);
    expect(await screen.findByText(copy.imageProblems.quota)).toBeInTheDocument();
  });
});

describe('tags and the two visibility switches', () => {
  it('normalises a tag on the way in and removes one on a tap', async () => {
    const user = userEvent.setup();
    open();
    await waitFor(() => expect(listEventDrafts).toHaveBeenCalled());

    await user.type(screen.getByLabelText(copy.tagAdd), '#재즈{Enter}');
    await user.type(screen.getByLabelText(copy.tagAdd), ' 라이브 {Enter}');
    // The same tag again is not a second chip.
    await user.type(screen.getByLabelText(copy.tagAdd), '재즈{Enter}');
    expect(mirror().tags).toEqual(['재즈', '라이브']);

    await user.click(screen.getByRole('button', { name: '재즈 빼기' }));
    expect(mirror().tags).toEqual(['라이브']);
  });

  it('stops at five tags', async () => {
    seed('d-1', { tags: ['a', 'b', 'c', 'd', 'e'] });
    open('/org/new/d-1');
    await waitFor(() => expect(screen.getByLabelText(copy.tagAdd)).toBeDisabled());
  });

  it('hides the venue and the time separately, and says the venue switch is one-way', async () => {
    const user = userEvent.setup();
    open();
    await waitFor(() => expect(listEventDrafts).toHaveBeenCalled());

    // Both live behind the fold now; the time comes first there, as it does above it.
    const switches = screen.getAllByRole('checkbox', { name: copy.holdersOnly });
    expect(switches).toHaveLength(2);
    await user.click(switches[0] as HTMLElement);
    expect(mirror()).toMatchObject({ venueHidden: false, timeHidden: true });
    await user.click(switches[1] as HTMLElement);
    expect(mirror()).toMatchObject({ venueHidden: true, timeHidden: true });

    expect(screen.getByText(new RegExp(copy.venueHiddenOneWay))).toBeInTheDocument();
  });

  /** Twelve themes now, so a row of chips is a wall of them: one dropdown instead. */
  it('picks a theme from the shared list rather than a row of chips', async () => {
    const user = userEvent.setup();
    open();
    await waitFor(() => expect(listEventDrafts).toHaveBeenCalled());
    const select = screen.getByLabelText(copy.themeLabel);
    expect(select.tagName).toBe('SELECT');

    await user.selectOptions(select, '4');
    expect(mirror().category).toBe(4);
    // Every theme an attendee can filter by is a theme an organiser can pick: one list.
    const offered = [...(select as HTMLSelectElement).options].map((option) => Number(option.value));
    expect(offered).toEqual([...THEME_CODES]);
  });

  it('starts the end time two hours after the start, without being asked', async () => {
    const user = userEvent.setup();
    open();
    await waitFor(() => expect(listEventDrafts).toHaveBeenCalled());
    await user.type(screen.getByLabelText(copy.startsAt), '2026-10-13T19:00');

    const startsAt = mirror().startsAt;
    // The draft keeps what was typed; the derived end is what the folded box shows.
    expect(mirror().endsAt).toBe(0);
    expect(screen.getByLabelText(copy.endsAt)).toHaveValue(toLocalInput(startsAt + 7_200));
  });
});

describe('the save state', () => {
  it('says nothing has been stored until something has been typed', async () => {
    open();
    await waitFor(() => expect(listEventDrafts).toHaveBeenCalled());
    expect(screen.getByText(copy.saveAuto)).toBeInTheDocument();
  });

  // Real timers, because the hook's own two-second debounce is what is being waited on.
  it('shows the draft as saved once the write has landed', async () => {
    open();
    await waitFor(() => expect(listEventDrafts).toHaveBeenCalled());
    await userEvent.setup().type(screen.getByLabelText(copy.titleLabel), '재');
    await waitFor(() => expect(saveEventDraft).toHaveBeenCalled(), { timeout: 4_000 });
    expect(await screen.findByText(copy.savedNow)).toBeInTheDocument();
  }, 10_000);
});
