import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventDraft, StoredEventDraft } from '../../shared/api/firestore';

let store: StoredEventDraft[] = [];
const listEventDrafts = vi.fn(async () => [...store].sort((a, b) => b.updatedAt - a.updatedAt));
const saveEventDraft = vi.fn(async () => undefined);
const deleteEventDraft = vi.fn(async () => undefined);
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


const pinEventImage = vi.fn(async (_args: { bytesBase64: string; kind: string }) => ({ cid: 'bafkart' }));
vi.mock('../../shared/api/functions', async (orig) => ({
  ...(await orig<typeof import('../../shared/api/functions')>()),
  api: { pinEventImage },
}));

vi.mock('../../shared/ui/a4Crop', async (orig) => ({
  ...(await orig<typeof import('../../shared/ui/a4Crop')>()),
  cropToA4: vi.fn(async () => ({ blob: new Blob(), base64: 'AQID', width: 1240, height: 1754 })),
}));

vi.mock('../../shared/config', async (orig) => ({
  ...(await orig<typeof import('../../shared/config')>()),
  getConfig: () => ({ ipfsGateway: 'https://gw.test/' }),
}));

const { CreateEvent } = await import('./CreateEvent');
const { EVENT_DRAFT_KEY, emptyEventDraft, emptyEventDraftTier } = await import('../useEventDraft');
const { organizerCopy } = await import('../copy');
const { ko: sharedCopy } = await import('../../shared/copy/index');
const copy = organizerCopy.ko.scene;

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
  tiers: [{ ...emptyEventDraftTier, name: '일반' }],
};

function open(draft: EventDraft = READY, id = 'd-42'): void {
  store = [{ id, updatedAt: 1_000, data: draft }];
  render(
    <MemoryRouter initialEntries={[`/org/new/${id}`]}>
      <Routes>
        <Route path="/org/new/:draftId" element={<CreateEvent />} />
        <Route path="*" element={<Probe />} />
      </Routes>
    </MemoryRouter>,
  );
}

function mirror(): EventDraft {
  return JSON.parse(localStorage.getItem(EVENT_DRAFT_KEY) ?? '{}').draft as EventDraft;
}

async function ready(): Promise<void> {
  await waitFor(() => expect(screen.getByLabelText(copy.tiers.name)).toHaveValue('일반'));
}

beforeAll(() => {
  URL.createObjectURL = () => 'blob:art';
  URL.revokeObjectURL = () => undefined;
});

beforeEach(() => {
  localStorage.clear();
  store = [];
  pinEventImage.mockResolvedValue({ cid: 'bafkart' });
});

describe('the kinds', () => {
  it('starts with one, which cannot be removed, and adds up to eight', async () => {
    const user = userEvent.setup();
    open();
    await ready();
    expect(screen.getAllByRole('heading', { level: 3 })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: copy.tiers.remove })).toBeNull();

    await user.click(screen.getByRole('button', { name: copy.tiers.add }));
    expect(screen.getAllByRole('heading', { level: 3 })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: copy.tiers.remove })).toHaveLength(2);

    for (let added = 2; added < 8; added += 1) {
      await user.click(screen.getByRole('button', { name: copy.tiers.add }));
    }
    expect(screen.getAllByRole('heading', { level: 3 })).toHaveLength(8);
    // `Ticket.createEvent` refuses a ninth with InvalidTiers, so the button stops offering one.
    expect(screen.getByRole('button', { name: copy.tiers.add })).toBeDisabled();
  });

  /** The one field that had no cap. Past 40 the draft rule refuses the whole document. */
  it('stops the kind name at forty characters, where the draft rule does', async () => {
    const user = userEvent.setup();
    open();
    await ready();
    const name = screen.getByLabelText(copy.tiers.name);
    expect(name).toHaveAttribute('maxlength', '40');

    await user.clear(name);
    await user.type(name, 'ㄱ'.repeat(41));
    expect(mirror().tiers[0]?.name).toHaveLength(40);
  });

  it('removes the kind that was asked for and leaves the rest in order', async () => {
    const user = userEvent.setup();
    open({ ...READY, tiers: [
      { ...emptyEventDraftTier, name: '일반' },
      { ...emptyEventDraftTier, name: '학생' },
    ] });
    await waitFor(() => expect(screen.getAllByRole('heading', { level: 3 })).toHaveLength(2));
    const cards = screen.getAllByRole('listitem');
    await user.click(within(cards[0] as HTMLElement).getByRole('button', { name: copy.tiers.remove }));
    expect(mirror().tiers.map((tier) => tier.name)).toEqual(['학생']);
  });
});

describe('the price', () => {
  it('blocks the card the moment a currency other than free is chosen, and locks 만들기', async () => {
    const user = userEvent.setup();
    open();
    await ready();
    expect(screen.getByRole('button', { name: copy.tiers.create })).toBeEnabled();

    await user.click(screen.getByRole('button', { name: 'USDC' }));
    expect(screen.getByText(copy.tiers.paidBlocked)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: copy.tiers.create })).toBeDisabled();
    expect(screen.getByText(copy.tierProblems.paidTier)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: copy.tiers.free }));
    expect(screen.queryByText(copy.tiers.paidBlocked)).toBeNull();
    expect(screen.getByRole('button', { name: copy.tiers.create })).toBeEnabled();
  });

  it('keeps the amount out of anything but the draft', async () => {
    const user = userEvent.setup();
    open();
    await ready();
    await user.click(screen.getByRole('button', { name: 'MON' }));
    await user.clear(screen.getByLabelText(copy.tiers.amount));
    await user.type(screen.getByLabelText(copy.tiers.amount), '25');
    expect(mirror().tiers[0]).toMatchObject({ currency: 'MON', amount: 25 });
  });
});

describe('the picture', () => {
  it('stores the chosen preset as a letter, never as a name', async () => {
    const user = userEvent.setup();
    open();
    await ready();
    await user.click(screen.getByRole('button', { name: copy.tiers.artNames.c }));
    expect(mirror().tiers[0]?.design).toBe('c');
    expect(JSON.stringify(mirror())).not.toContain('aurora');
    expect(screen.getByRole('button', { name: copy.tiers.artNames.c })).toHaveAttribute('aria-pressed', 'true');
  });

  it('uploads one of their own through the same cropper, as a ticket and not a poster', async () => {
    const user = userEvent.setup();
    open();
    await ready();
    await user.click(screen.getByRole('button', { name: copy.tiers.artUpload }));
    const file = new File([new Uint8Array([1, 2, 3])], 'art.jpg', { type: 'image/jpeg' });
    await user.upload(screen.getByLabelText(sharedCopy.poster.pick), file);
    await user.click(await screen.findByRole('button', { name: sharedCopy.poster.crop }));

    await waitFor(() => expect(pinEventImage).toHaveBeenCalledWith({ bytesBase64: 'AQID', kind: 'ticket' }));
    expect(mirror().tiers[0]?.imageCid).toBe('bafkart');
  });

  it('shows the event title and the kind on the picture the attendee will get', async () => {
    open({ ...READY, tiers: [{ ...emptyEventDraftTier, name: '학생' }] });
    await waitFor(() => expect(screen.getByLabelText(copy.tiers.name)).toHaveValue('학생'));
    expect(screen.getByRole('img', { name: /재즈 나이트/ })).toBeInTheDocument();
  });
});

describe('the rules that belong to the event', () => {
  it('keeps the three of them out of the kind cards, one each', async () => {
    const user = userEvent.setup();
    open();
    await ready();
    await user.click(screen.getByRole('button', { name: copy.tiers.add }));

    // Two cards, and still exactly one of each switch.
    expect(screen.getAllByRole('heading', { level: 3 })).toHaveLength(2);
    expect(screen.getAllByRole('checkbox', { name: copy.tiers.transferable })).toHaveLength(1);
    expect(screen.getAllByRole('checkbox', { name: copy.tiers.requireKyc })).toHaveLength(1);
    expect(screen.getByText(copy.tiers.rulesHelp)).toBeInTheDocument();
  });

  it('asks for a hand-over deadline only while hand-over is allowed', async () => {
    const user = userEvent.setup();
    open();
    await ready();
    expect(screen.getByLabelText(copy.tiers.cutoff)).toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: copy.tiers.transferable }));
    expect(mirror().transferable).toBe(false);
    expect(screen.queryByLabelText(copy.tiers.cutoff)).toBeNull();
  });
});

describe('행사 만들기', () => {
  /** The event fields are in the same scroll now, so a missing one is named where it is. */
  it('names the missing event field rather than sending anybody to a second screen', async () => {
    open({ ...READY, title: '' });
    await ready();
    await userEvent.setup().click(screen.getByRole('button', { name: copy.tiers.create }));
    expect(screen.getByText(copy.problems.title)).toBeInTheDocument();
    expect(screen.queryByText(/^landed:/)).toBeNull();
  });

  it('names an unnamed kind under the cards', async () => {
    open({ ...READY, tiers: [{ ...emptyEventDraftTier, name: '' }] });
    await waitFor(() => expect(screen.getByLabelText(copy.tiers.name)).toHaveValue(''));
    await userEvent.setup().click(screen.getByRole('button', { name: copy.tiers.create }));
    expect(screen.getByText(copy.tierProblems.tierName)).toBeInTheDocument();
  });

  /** One scroll: the title box and the kind cards are on screen together. */
  it('keeps the event fields and the kinds on the same screen', async () => {
    open();
    await ready();
    expect(screen.getByLabelText(copy.titleLabel)).toHaveValue(READY.title);
    expect(screen.getByRole('link', { name: copy.leave })).toHaveAttribute('href', '/org');
  });
});
