import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
const { TicketSection } = await import('./TicketSection');
const { EVENT_DRAFT_KEY, emptyEventDraft, emptyEventDraftTier } = await import('../useEventDraft');
const { organizerCopy } = await import('../copy');
const { TICKET_ART_PRESETS, UNLIMITED_SUPPLY } = await import('./draftRules');
const { ko: sharedCopy } = await import('../../shared/copy/index');
const copy = organizerCopy.ko.scene;

/**
 * The one big preview above the carousel, told apart from the twelve live tiles inside it: these
 * tests are about the ticket the attendee is handed, which is the big one. The tiles draw the
 * same strings on purpose (they are real previews too), so a bare `getByText` would find many.
 */
function preview(): HTMLElement {
  return document.querySelector('.tier-card__art') as HTMLElement;
}

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
  startsAt: 1_900_000_000,
  endsAt: 1_900_010_000,
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
  loadMyProfile.mockResolvedValue({ displayName: '김태완' });
  pinEventImage.mockResolvedValue({ cid: 'bafkart' });
});

afterEach(() => {
  vi.unstubAllEnvs();
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
    // Scope to the ticket cards: the scene's two-step header (plan §2b) is a list too.
    const cards = within(document.querySelector('.tier-list-cards') as HTMLElement).getAllByRole('listitem');
    await user.click(within(cards[0] as HTMLElement).getByRole('button', { name: copy.tiers.remove }));
    expect(mirror().tiers.map((tier) => tier.name)).toEqual(['학생']);
  });
});

describe('the 무료 | 유료 segment', () => {
  it('blocks the card the moment 유료 is chosen, and locks 만들기', async () => {
    const user = userEvent.setup();
    open();
    await ready();
    expect(screen.getByRole('button', { name: copy.tiers.create })).toBeEnabled();

    // 유료 is the segment's paid half; choosing it defaults the currency to MON, which the
    // deployed contract still refuses — so the card blocks on the spot, as it did before.
    await user.click(screen.getByRole('button', { name: copy.tiers.paid }));
    expect(mirror().tiers[0]?.currency).toBe('MON');
    expect(screen.getByText(copy.tiers.paidBlocked)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: copy.tiers.create })).toBeDisabled();
    expect(screen.getByText(copy.tierProblems.paidTier)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: copy.tiers.free }));
    expect(mirror().tiers[0]?.currency).toBe('free');
    expect(screen.queryByText(copy.tiers.paidBlocked)).toBeNull();
    expect(screen.getByRole('button', { name: copy.tiers.create })).toBeEnabled();
  });

  it('shows the price, the currencies, the limit and its tooltip only for 유료', async () => {
    const user = userEvent.setup();
    open();
    await ready();
    // 무료 to begin with: none of the paid-only boxes, and no currency chips.
    expect(screen.queryByLabelText(copy.tiers.amount)).toBeNull();
    expect(screen.queryByLabelText(copy.tiers.maxPerWallet)).toBeNull();
    expect(screen.queryByText(copy.tiers.limitTip)).toBeNull();
    for (const currency of ['MON', 'USDT', 'USDC']) {
      expect(screen.queryByRole('button', { name: currency })).toBeNull();
    }

    await user.click(screen.getByRole('button', { name: copy.tiers.paid }));
    expect(screen.getByLabelText(copy.tiers.amount)).toBeInTheDocument();
    expect(screen.getByLabelText(copy.tiers.maxPerWallet)).toBeInTheDocument();
    // The (i) tooltip beside the limit, in the exact words the founder asked for.
    expect(screen.getByText(copy.tiers.limitTip)).toBeInTheDocument();
    for (const currency of ['MON', 'USDT', 'USDC']) {
      expect(screen.getByRole('button', { name: currency })).toBeInTheDocument();
    }
    // The receiving method belongs to a free event, so it is gone once the kind is paid.
    expect(screen.queryByText(copy.tiers.receiveMethod)).toBeNull();
  });

  it('keeps the amount and the currency out of anything but the draft', async () => {
    const user = userEvent.setup();
    open();
    await ready();
    await user.click(screen.getByRole('button', { name: copy.tiers.paid }));
    await user.click(screen.getByRole('button', { name: 'USDC' }));
    await user.clear(screen.getByLabelText(copy.tiers.amount));
    await user.type(screen.getByLabelText(copy.tiers.amount), '25');
    expect(mirror().tiers[0]).toMatchObject({ currency: 'USDC', amount: 25 });
  });
});

describe('받는 방식 — how a free event issues tickets', () => {
  it('picks 선착순 by default and holds 관리자 승인 behind the flag when it is off', async () => {
    vi.stubEnv('VITE_APPROVAL_MODES', 'off');
    open();
    await ready();
    // 선착순 자동 승인 is the default, so approvalRequired stays false.
    expect(screen.getByRole('button', { name: copy.tiers.receiveAuto }))
      .toHaveAttribute('aria-pressed', 'true');
    // The deployed contract still rejects approvalRequired:true, so the option is not offered yet.
    const approval = screen.getByRole('button', { name: copy.tiers.receiveApproval });
    expect(approval).toBeDisabled();
    expect(screen.getByText(copy.tiers.approvalSoon)).toBeInTheDocument();
    expect(mirror().approvalRequired).toBe(false);
  });

  it('lets 관리자 승인 be chosen when the flag is on, and writes it to the draft', async () => {
    vi.stubEnv('VITE_APPROVAL_MODES', 'on');
    const user = userEvent.setup();
    open();
    await ready();
    const approval = screen.getByRole('button', { name: copy.tiers.receiveApproval });
    expect(approval).toBeEnabled();
    expect(screen.queryByText(copy.tiers.approvalSoon)).toBeNull();
    await user.click(approval);
    expect(mirror().approvalRequired).toBe(true);
  });

  it('draws the receiving method once, on the first kind only', async () => {
    const user = userEvent.setup();
    open();
    await ready();
    await user.click(screen.getByRole('button', { name: copy.tiers.add }));
    // Two kinds, one receiving-method control: approvalRequired is one per event.
    expect(screen.getAllByText(copy.tiers.receiveMethod)).toHaveLength(1);
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

  /**
   * Twelve drawings and the upload, on the card where the choice is made. The row and the
   * names are driven off the one alphabet (`TICKET_ART_PRESETS`) and a record typed by it, so
   * a thirteenth drawing added without a name would fail the build — but a drawing the row
   * silently stopped offering would not, and nobody could pick it.
   */
  it('offers every one of the twelve drawings, each under its own name', async () => {
    open();
    await ready();
    for (const preset of TICKET_ART_PRESETS) {
      expect(
        screen.getByRole('button', { name: copy.tiers.artNames[preset] }),
        preset,
      ).toBeInTheDocument();
    }
    // The upload chip sits at the end of the same row and is not one of the twelve.
    expect(new Set(TICKET_ART_PRESETS).size).toBe(12);
    expect(screen.getByRole('button', { name: copy.tiers.artUpload })).toBeInTheDocument();
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

  /**
   * The preview is the ticket, not a picture of one: the same four strings, the organiser's
   * own name out of the same profile field an attendee's ticket reads, and the draft's own
   * start time through the same formatter (plan section E-3).
   */
  it('draws all four strings on the draft preview', async () => {
    open({ ...READY, tiers: [{ ...emptyEventDraftTier, name: '학생' }] });
    await waitFor(() => expect(screen.getByLabelText(copy.tiers.name)).toHaveValue('학생'));
    const day = new Date(READY.startsAt * 1000).toLocaleDateString('ko', { dateStyle: 'medium' });
    await waitFor(() => expect(within(preview()).getByText('김태완')).toBeInTheDocument());
    for (const text of ['재즈 나이트', '학생', day]) {
      expect(within(preview()).getByText(text)).toBeInTheDocument();
    }
  });

  /** A draft nobody has given a start time draws no date at all, rather than inventing one. */
  it('draws no date on a draft with no start time yet', async () => {
    const day = new Date(READY.startsAt * 1000).toLocaleDateString('ko', { dateStyle: 'medium' });
    open({ ...READY, startsAt: 0 });
    await ready();
    await waitFor(() => expect(within(preview()).getByText('김태완')).toBeInTheDocument());
    expect(within(preview()).queryByText(day)).toBeNull();
  });

  it('falls back to the attendee word when the organiser gave no name either', async () => {
    loadMyProfile.mockResolvedValue({ displayName: '' });
    open();
    await ready();
    await waitFor(() => expect(within(preview()).getByText(sharedCopy.tickets.artGuest)).toBeInTheDocument());
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

describe('the quick-start presets', () => {
  it('무료 선착순 makes the first kind free, first come, in one tap', async () => {
    const user = userEvent.setup();
    open();
    await ready();
    await user.click(screen.getByRole('button', { name: copy.tiers.quickFree }));
    expect(mirror().tiers[0]).toMatchObject({ currency: 'free', maxPerWallet: 1 });
    expect(mirror().approvalRequired).toBe(false);
  });

  it('무료 관리자 승인 turns the approval flag on when it is open', async () => {
    vi.stubEnv('VITE_APPROVAL_MODES', 'on');
    const user = userEvent.setup();
    open();
    await ready();
    await user.click(screen.getByRole('button', { name: copy.tiers.quickApproval }));
    expect(mirror().tiers[0]).toMatchObject({ currency: 'free', maxPerWallet: 1 });
    expect(mirror().approvalRequired).toBe(true);
  });

  it('holds 무료 관리자 승인 behind the flag when it is off', async () => {
    vi.stubEnv('VITE_APPROVAL_MODES', 'off');
    open();
    await ready();
    expect(screen.getByRole('button', { name: copy.tiers.quickApproval })).toBeDisabled();
  });

  it('유료 일반 sets the first kind paid, and the honest block still lands', async () => {
    const user = userEvent.setup();
    open();
    await ready();
    await user.click(screen.getByRole('button', { name: copy.tiers.quickPaid }));
    expect(mirror().tiers[0]).toMatchObject({ currency: 'MON', maxPerWallet: 1 });
    expect(screen.getByText(copy.tiers.paidBlocked)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: copy.tiers.create })).toBeDisabled();
  });
});

describe('the preview is the form', () => {
  it('taps the kind region and the name box takes focus', async () => {
    const user = userEvent.setup();
    open();
    await ready();
    await user.click(screen.getByRole('button', { name: copy.tiers.editKind }));
    expect(screen.getByLabelText(copy.tiers.name)).toHaveFocus();
  });

  it('taps the picture region and a picture tile takes focus', async () => {
    const user = userEvent.setup();
    open();
    await ready();
    await user.click(screen.getByRole('button', { name: copy.tiers.editArt }));
    expect(document.activeElement).toHaveClass('art-tile');
  });

  it('taps the price badge and the 무료 | 유료 chips take focus', async () => {
    const user = userEvent.setup();
    open();
    await ready();
    await user.click(screen.getByRole('button', { name: copy.tiers.editPrice }));
    expect(screen.getByRole('button', { name: copy.tiers.free })).toHaveFocus();
  });

  it('taps the title region and asks the scene to edit the title', async () => {
    const user = userEvent.setup();
    const onEditTitle = vi.fn();
    render(
      <TicketSection
        draft={{ ...emptyEventDraft, title: '재즈 나이트', tiers: [{ ...emptyEventDraftTier, name: '일반' }] }}
        patch={vi.fn()}
        problems={[]}
        blocked={false}
        onEditTitle={onEditTitle}
      />,
    );
    await user.click(screen.getByRole('button', { name: copy.tiers.editTitle }));
    expect(onEditTitle).toHaveBeenCalledTimes(1);
  });
});

describe('the quantity — quick chips and the edit buffer', () => {
  it('starts at 100 and does not stamp a leading zero when cleared and re-typed', async () => {
    const user = userEvent.setup();
    open();
    await ready();
    const box = screen.getByLabelText(copy.tiers.supply);
    expect(box).toHaveValue('100');

    // The '030' bug: clearing used to leave a 0 the next digit jammed against.
    await user.clear(box);
    await user.type(box, '30');
    expect(box).toHaveValue('30');
    expect(mirror().tiers[0]?.supply).toBe(30);
  });

  it('allows an empty box while editing and settles it to 0 on blur', async () => {
    const user = userEvent.setup();
    open();
    await ready();
    const box = screen.getByLabelText(copy.tiers.supply);
    await user.clear(box);
    // Empty is allowed mid-edit — the draft is only asked to hold a number for a non-empty box.
    expect(box).toHaveValue('');
    await user.tab();
    expect(box).toHaveValue('0');
  });

  it('sets the quantity from a quick chip, 무제한 included', async () => {
    const user = userEvent.setup();
    open();
    await ready();
    await user.click(screen.getByRole('button', { name: '30' }));
    expect(mirror().tiers[0]?.supply).toBe(30);
    // The box follows the chip, since it is not the thing being edited.
    expect(screen.getByLabelText(copy.tiers.supply)).toHaveValue('30');

    await user.click(screen.getByRole('button', { name: copy.tiers.supplyUnlimited }));
    expect(mirror().tiers[0]?.supply).toBe(UNLIMITED_SUPPLY);
    expect(screen.getByRole('button', { name: copy.tiers.supplyUnlimited }))
      .toHaveAttribute('aria-pressed', 'true');
  });
});
