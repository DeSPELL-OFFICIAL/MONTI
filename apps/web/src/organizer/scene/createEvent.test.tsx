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
const { fmt } = await import('../../shared/i18n');
const { THEME_CODES } = await import('../../shared/eventThemes');
const { toLocalInput } = await import('./datetime');
const { en: sharedCopy } = await import('../../shared/copy/index');
const { EVENT_DRAFT_KEY, emptyEventDraft, emptyEventDraftTier, nextWeekendStart } = await import('../useEventDraft');
const { organizerCopy } = await import('../copy');
const { PROBLEM_SECTION, MAX_BODY_CHARS, MAX_TAG_CHARS } = await import('./draftRules');
const copy = organizerCopy.en.scene;

/** Where a navigation landed, so the route SCENE 1 hands over to is checked and not guessed. */
function Probe() {
  return <p>{`landed:${useLocation().pathname}`}</p>;
}

const READY: EventDraft = {
  ...emptyEventDraft,
  orgId: '9',
  title: '재즈 나이트',
  description: '한남동 재즈 라이브 공연',
  posterCid: 'bafkposter',
  regionCode: 'KR-11',
  venue: '서울 용산구 한남동',
  startsAt: 1_900_000_000,
  endsAt: 1_900_010_000,
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

/**
 * The scene's own `더 설정하기`. It is the only fold that carries that word now: the ticket
 * kind's card lost its own to the always-visible 무료 | 유료 segment (plan section A-1).
 */
function fold(): HTMLDetailsElement {
  const summaries = screen.getAllByText(copy.more);
  const details = summaries.at(-1)?.closest('details');
  if (!details) throw new Error('no fold on screen');
  return details;
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
  /** Plan §2b: the two-step header, at step 1 — 만들기 now, 발행 still to come on the done screen. */
  it('shows the two-step header with 만들기 as the current step', async () => {
    open();
    await waitFor(() => expect(listEventDrafts).toHaveBeenCalled());
    expect(document.querySelector('.steps')).toBeInTheDocument();
    expect(document.querySelector('.steps__step--current .steps__label')?.textContent)
      .toBe(copy.stepCreate);
  });

  /**
   * Five fields and one button (plan section B-2). The poster, the title, the start, the place
   * and the one ticket kind are what an event needs; everything else waits behind the fold.
   */
  it('shows five fields and folds the rest away', async () => {
    open();
    await waitFor(() => expect(listEventDrafts).toHaveBeenCalled());
    // One fold carries the word now: the scene's. The kind card lost its own fold to the
    // always-visible 무료 | 유료 segment (plan section A-1).
    const folds = screen.getAllByText(copy.more);
    expect(folds).toHaveLength(1);
    expect(folds.every((summary) => (summary.closest('details') as HTMLDetailsElement).open)).toBe(false);

    for (const field of [copy.titleLabel, copy.bodyLabel, copy.startsAt, copy.regionLabel, copy.placeLabel, copy.tiers.name]) {
      expect(screen.getByLabelText(field).closest('details')).toBeNull();
    }
    // The poster card and the ticket kind are the two that are not plain boxes.
    expect(screen.getByRole('heading', { level: 2, name: copy.poster }).closest('details')).toBeNull();
    expect(screen.getByLabelText(copy.tiers.supply).closest('details')).toBeNull();

    // And everything the founder never has to see again.
    for (const folded of [copy.themeLabel, copy.tagAdd, copy.endsAt]) {
      expect(screen.getByLabelText(folded).closest('details')).not.toBeNull();
    }
  });

  it('keeps the tickets in the same scroll as the event', async () => {
    open();
    await waitFor(() => expect(listEventDrafts).toHaveBeenCalled());
    // The ticket screen is gone: its one kind is a section here (plan section B-1), and it
    // starts named, so nothing on this screen is a required box that opens empty.
    expect(screen.getByLabelText(copy.tiers.name)).toHaveValue('General');
    expect(screen.getByLabelText(copy.tiers.supply)).toHaveValue('100');
  });

  /**
   * Plan T-SIMP-8: the start opens on the next-Saturday default, so the ordinary case is a
   * confirm rather than a fill, and `min` blocks a past time in the picker rather than at 만들기.
   */
  it('opens the start on the next-Saturday default and floors the picker at now', async () => {
    open();
    await waitFor(() => expect(listEventDrafts).toHaveBeenCalled());
    const start = screen.getByLabelText(copy.startsAt) as HTMLInputElement;
    // Seeded, not blank: the default is on screen before anything is typed.
    expect(start.value).not.toBe('');
    expect(start.value).toBe(toLocalInput(nextWeekendStart()));
    // `min` is now, so the box refuses a time already gone inline.
    expect(start.getAttribute('min')).toBeTruthy();
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
    expect(screen.getByRole('button', { name: copy.tiers.next })).toBeEnabled();
    expect(screen.queryByText(copy.problems.title)).toBeNull();

    await user.click(screen.getByRole('button', { name: copy.tiers.next }));
    expect(screen.getByText(copy.problems.title)).toBeInTheDocument();
    // 장소는 이제 선택이라 빈 장소는 더 이상 막지 않는다 — 남은 건 제목뿐.
    // Still here: an unfinished field is a message, not a wall — and never a second screen.
    expect(screen.queryByText(/^landed:/)).toBeNull();
  });

  /** v2: 다음 never touches the chain — it saves the draft and moves to that draft's publish screen. */
  it('moves to the draft\'s publish screen, sending nothing', async () => {
    const user = userEvent.setup();
    seed('d-42', READY);
    open('/org/new/d-42');
    await waitFor(() => expect(screen.getByLabelText(copy.titleLabel)).toHaveValue(READY.title));
    await user.click(screen.getByRole('button', { name: copy.tiers.next }));
    expect(await screen.findByText('landed:/org/new/d-42/publish')).toBeInTheDocument();
  });

  /** A paid kind is allowed here now: its price goes on chain at publish. */
  it('lets a paid draft move on to the publish screen', async () => {
    const user = userEvent.setup();
    seed('d-42', { ...READY, tiers: [{ ...emptyEventDraftTier, currency: 'USDC', amount: 30 }] });
    open('/org/new/d-42');
    await waitFor(() => expect(screen.getByLabelText(copy.titleLabel)).toHaveValue(READY.title));
    expect(screen.getByRole('button', { name: copy.tiers.next })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: copy.tiers.next }));
    expect(await screen.findByText('landed:/org/new/d-42/publish')).toBeInTheDocument();
  });

  /**
   * The scroll targets are the one part of the layout other code depends on: `create()` jumps
   * to `scene-<section>` and `PROBLEM_SECTION` names them. A restyle that renamed or dropped
   * one would leave 만들기 scrolling nowhere at all, and nothing else would notice.
   */
  it('keeps every scroll target the problem table names, each as a pane of its own', async () => {
    open();
    await waitFor(() => expect(listEventDrafts).toHaveBeenCalled());
    for (const section of new Set(Object.values(PROBLEM_SECTION))) {
      const target = document.getElementById(`scene-${section}`);
      expect(target, section).not.toBeNull();
      // Inside the fold the sections stay plain: a pane drawn inside a pane is two edges
      // for one boundary. Everything above it is a card.
      if (!['tags'].includes(section)) expect(target, section).toHaveClass('card');
    }
    expect(document.getElementById('scene-tickets')).toHaveClass('card');
  });

  /** 소개는 항상 보이고(더 설정하기 밖), 카운터가 n/2000 을 실시간으로 보여준다(plan A-4). */
  it('shows the description outside the fold with a live counter', async () => {
    open();
    await waitFor(() => expect(listEventDrafts).toHaveBeenCalled());
    const body = screen.getByLabelText(copy.bodyLabel);
    expect(body.closest('details')).toBeNull();
    expect(screen.getByText(fmt(copy.count, { count: 0, max: MAX_BODY_CHARS }))).toBeInTheDocument();
    await userEvent.setup().type(body, '123456789');
    expect(screen.getByText(fmt(copy.count, { count: 9, max: MAX_BODY_CHARS }))).toBeInTheDocument();
  });

  /**
   * The draft the founder came back to two days later. Nothing on the screen was wrong, so the
   * sentence does not wait for a press — and 만들기 is held, because the estimate would refuse
   * it every single time (task-create-failure-2 report §0).
   */
  it('holds 만들기 on a draft whose end time has passed, and says so without a press', async () => {
    seed('d-old', { ...READY, startsAt: 1_700_000_000, endsAt: 1_700_003_600 });
    open('/org/new/d-old');
    await waitFor(() => expect(screen.getByLabelText(copy.titleLabel)).toHaveValue(READY.title));
    expect(screen.getByText(copy.problems.eventPast)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: copy.tiers.next })).toBeDisabled();
  });

  it('says the end has to come after the start', async () => {
    seed('d-1', { ...READY, endsAt: READY.startsAt });
    open('/org/new/d-1');
    await waitFor(() => expect(screen.getByLabelText(copy.titleLabel)).toHaveValue(READY.title));
    await userEvent.setup().click(screen.getByRole('button', { name: copy.tiers.next }));
    expect(screen.getByText(copy.problems.schedule)).toBeInTheDocument();
    // Both times live behind the fold, so the sentence is only a sentence once it is open.
    expect(fold().open).toBe(true);
  });

  /**
   * The half of `더 설정하기` nobody thought about: seven of the ten rules are about fields the
   * scene starts with hidden, and a sentence printed inside a closed `<details>` is a 만들기
   * that does nothing at all as far as the organiser can see. The fold opens first, and only
   * then is the section scrolled to.
   */
  it('opens the fold when what is wrong is hiding inside it', async () => {
    seed('d-1', { ...READY, tags: ['ㄱ'.repeat(MAX_TAG_CHARS + 1)] });
    open('/org/new/d-1');
    await waitFor(() => expect(screen.getByLabelText(copy.titleLabel)).toHaveValue(READY.title));
    expect(fold().open).toBe(false);

    await userEvent.setup().click(screen.getByRole('button', { name: copy.tiers.next }));
    expect(fold().open).toBe(true);
    expect(screen.getByText(copy.problems.tags)).toBeInTheDocument();
    // It is inside the fold and not beside it, which is the whole reason the fold had to open.
    expect(screen.getByText(copy.problems.tags).closest('details')).toBe(fold());
  });

  /** And it stays shut for a field that was on screen the whole time: nothing was hidden. */
  it('leaves the fold shut when the missing field was never in it', async () => {
    seed('d-1', { ...READY, title: '' });
    open('/org/new/d-1');
    await waitFor(() => expect(screen.getByLabelText(copy.titleLabel)).toHaveValue(''));
    await userEvent.setup().click(screen.getByRole('button', { name: copy.tiers.next }));
    expect(screen.getByText(copy.problems.title)).toBeInTheDocument();
    expect(fold().open).toBe(false);
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

    await user.click(screen.getByRole('button', { name: 'Remove 재즈' }));
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
    // The start now opens on the next-Saturday default (T-SIMP-8), so it is cleared before the
    // fixed value this case pins the derived end to is typed in.
    const start = screen.getByLabelText(copy.startsAt);
    await user.clear(start);
    await user.type(start, '2026-10-13T19:00');

    const startsAt = mirror().startsAt;
    // The draft keeps what was typed; the derived end is what the folded box shows.
    expect(mirror().endsAt).toBe(0);
    expect(screen.getByLabelText(copy.endsAt)).toHaveValue(toLocalInput(startsAt + 7_200));
  });
});

/**
 * Plan section F-3/F-4. The autosave was already doing every one of these things before the
 * founder's phone test and none of it showed, so what is under test here is entirely what the
 * organiser can see and press.
 */
describe('the resume sheet', () => {
  /** Old enough to be dated in minutes, so the sentence under test is not the 방금 one. */
  const FIVE_MINUTES_AGO = (): number => Date.now() - 5 * 60_000;

  it('asks which draft this is before carrying on with it', async () => {
    seed('kept', { title: '지난 초안' }, FIVE_MINUTES_AGO());
    open();

    expect(await screen.findByText(copy.resume.title)).toBeInTheDocument();
    // Which draft, and how stale it is: nobody with two abandoned drafts can answer without both.
    expect(screen.getByText(fmt(copy.resume.body, {
      title: '지난 초안', when: fmt(copy.agoMinutes, { count: 5 }),
    }))).toBeInTheDocument();

    await userEvent.setup().click(screen.getByRole('button', { name: copy.resume.keep }));
    expect(screen.queryByText(copy.resume.title)).toBeNull();
    // The same draft, still: 이어서 작성하기 changes nothing but the sheet being gone.
    expect(screen.getByLabelText(copy.titleLabel)).toHaveValue('지난 초안');
  });

  it('asks on the first paint from the device mirror, before any Firestore round-trip', () => {
    // The mirror is on the device synchronously, so the question is up before the list comes back —
    // no more sheet dropping over input a few seconds late (계획 §2d / S4a).
    localStorage.setItem(
      EVENT_DRAFT_KEY,
      JSON.stringify({ id: 'kept', draft: { ...emptyEventDraft, title: '미러 초안' }, at: FIVE_MINUTES_AGO() }),
    );
    open();
    // getByText, not findByText: it is already there on the first render.
    expect(screen.getByText(copy.resume.title)).toBeInTheDocument();
  });

  it('locks the scene until the resume question is answered', async () => {
    seed('kept', { title: '지난 초안' }, FIVE_MINUTES_AGO());
    open();
    await screen.findByText(copy.resume.title);

    // The scene is inert and 만들기 is disabled — nothing can be typed before the decision.
    const scene = document.querySelector('.scene');
    expect(scene).toHaveAttribute('inert');
    expect(screen.getByRole('button', { name: copy.tiers.next })).toBeDisabled();

    await userEvent.setup().click(screen.getByRole('button', { name: copy.resume.keep }));
    expect(scene).not.toHaveAttribute('inert');
    expect(screen.getByRole('button', { name: copy.tiers.next })).toBeEnabled();
  });

  it('calls a draft with no title what it is rather than showing a gap', async () => {
    seed('kept', { title: '' }, FIVE_MINUTES_AGO());
    open();
    expect(await screen.findByText(new RegExp(copy.resume.untitled))).toBeInTheDocument();
  });

  /** The core of F-4: 새로 만들기 is not 버리기. The old draft is still there afterwards. */
  it('starts a new draft without deleting the one that was left behind', async () => {
    seed('kept', { title: '지난 초안' }, FIVE_MINUTES_AGO());
    open();
    await userEvent.setup().click(await screen.findByRole('button', { name: copy.resume.fresh }));

    await waitFor(() => expect(screen.getByLabelText(copy.titleLabel)).toHaveValue(''));
    expect(screen.queryByText(copy.resume.title)).toBeNull();
    expect(deleteEventDraft).not.toHaveBeenCalled();
    expect(store.map((row) => row.id)).toEqual(['kept']);
  });

  it('never asks when the address already named the draft', async () => {
    seed('kept', { title: '지목한 초안' }, FIVE_MINUTES_AGO());
    open('/org/new/kept');
    await waitFor(() => expect(screen.getByLabelText(copy.titleLabel)).toHaveValue('지목한 초안'));
    expect(screen.queryByText(copy.resume.title)).toBeNull();
  });

  it('never asks when this account has nothing stored', async () => {
    open();
    await waitFor(() => expect(listEventDrafts).toHaveBeenCalled());
    expect(screen.queryByText(copy.resume.title)).toBeNull();
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
    expect(await screen.findByText(fmt(copy.savedAgo, { ago: copy.agoNow }))).toBeInTheDocument();
  }, 10_000);

  /** Plan section F-2: the button the autosave never had, and the sentence proving it ran. */
  it('writes the draft the moment 임시 저장 is pressed, and says 저장됨', async () => {
    const user = userEvent.setup();
    open();
    await waitFor(() => expect(listEventDrafts).toHaveBeenCalled());
    await user.type(screen.getByLabelText(copy.titleLabel), '재');
    saveEventDraft.mockClear();

    // Now, not two seconds from now: the press is what wrote it, and the debounce it overtook
    // does not write the same draft a second time afterwards.
    await user.click(screen.getByRole('button', { name: copy.saveDraft }));
    await waitFor(() => expect(saveEventDraft).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(copy.saved)).toBeInTheDocument();
  }, 10_000);
});
