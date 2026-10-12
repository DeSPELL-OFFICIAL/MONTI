import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventDraft, StoredEventDraft } from '../../shared/api/firestore';

/**
 * The poster after the founder's phone test: one modal, and then an upload that runs behind a
 * scene nobody is waiting on (plan section D). Every test here is about that handover — the
 * bytes on screen, the modal closing, the scene staying usable, a refusal that keeps the bytes
 * and `다음` waiting rather than refusing.
 *
 * `다음` only moves to the publish screen (v2: the scene never touches the chain). What is under
 * test is whether that move is reached and what the draft looked like when it was.
 */
let store: StoredEventDraft[] = [];
const listEventDrafts = vi.fn(async () => [...store].sort((a, b) => b.updatedAt - a.updatedAt));
const saveEventDraft = vi.fn(async (_id: string, _draft: EventDraft) => undefined);
const deleteEventDraft = vi.fn(async (_id: string) => undefined);
const loadMyProfile = vi.fn(async () => ({ displayName: '김태완' }));
vi.mock('../../shared/api/firestore', () => ({
  listEventDrafts, saveEventDraft, deleteEventDraft, loadMyProfile,
}));

vi.mock('../useMyOrgs', () => ({
  useMyOrgs: () => ({
    orgs: [], canCreateEvent: false, isLoading: false, isError: false,
    error: null, refetch: vi.fn(async () => []),
  }),
}));

/** Every pin is held open so a test decides, to the line, when the server answers. */
interface Pending { resolve: (cid: string) => void; reject: (cause: unknown) => void }
let pending: Pending[] = [];
const pinEventImage = vi.fn(
  (_args: { bytesBase64: string; kind: string }) => new Promise<{ cid: string }>((resolve, reject) => {
    pending.push({ resolve: (cid) => resolve({ cid }), reject });
  }),
);
vi.mock('../../shared/api/functions', async (orig) => ({
  ...(await orig<typeof import('../../shared/api/functions')>()),
  api: { pinEventImage },
}));

// jsdom has neither `createImageBitmap` nor a canvas that encodes; the pixel arithmetic has
// its own tests. What is under test here is the wiring from the crop to the pin.
vi.mock('../../shared/ui/a4Crop', async (orig) => ({
  ...(await orig<typeof import('../../shared/ui/a4Crop')>()),
  cropToA4: vi.fn(async () => ({
    blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' }),
    base64: 'AQID', width: 1240, height: 1754,
  })),
}));

/** Where `다음` landed, and the poster the draft mirror carried at that moment. */
let landedPoster: string | null = null;
function PublishProbe() {
  const path = useLocation().pathname;
  const mirror = JSON.parse(localStorage.getItem('monti.eventDraft') ?? '{}') as { draft?: EventDraft };
  landedPoster = mirror.draft?.posterCid ?? null;
  return <p>{`landed:${path}`}</p>;
}

vi.mock('../../shared/config', async (orig) => ({
  ...(await orig<typeof import('../../shared/config')>()),
  getConfig: () => ({ ipfsGateway: 'https://gw.test/' }),
}));

const { CreateEvent } = await import('./CreateEvent');
const { posterUrl } = await import('../../shared/ui');
const { emptyEventDraft } = await import('../useEventDraft');
const { organizerCopy } = await import('../copy');
const { ko: sharedCopy } = await import('../../shared/copy/index');
const copy = organizerCopy.ko.scene;

/** Everything an event needs except the picture — so the poster is the only thing left. */
const ALMOST: EventDraft = {
  ...emptyEventDraft,
  orgId: '9',
  title: '재즈 나이트',
  description: '한남동 재즈 라이브 공연',
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
        <Route path="/org/new/:draftId/publish" element={<PublishProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

async function crop(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByRole('button', { name: copy.posterAdd }));
  const file = new File([new Uint8Array([1, 2, 3])], 'poster.jpg', { type: 'image/jpeg' });
  await user.upload(screen.getByLabelText(sharedCopy.poster.pick), file);
  await user.click(await screen.findByRole('button', { name: sharedCopy.poster.crop }));
}

async function land(cid = 'bafkposter'): Promise<void> {
  const next = pending.shift();
  await act(async () => next?.resolve(cid));
}

async function refuse(message: string): Promise<void> {
  const next = pending.shift();
  await act(async () => next?.reject({ code: 'invalid-argument', message }));
}

function card(): HTMLImageElement {
  return screen.getByAltText(copy.posterAlt) as HTMLImageElement;
}

let made = 0;
beforeAll(() => {
  // Distinct every time, so the card's picture can be told from the cropper's own preview.
  URL.createObjectURL = () => `blob:poster-${(made += 1)}`;
  URL.revokeObjectURL = () => undefined;
});

beforeEach(() => {
  localStorage.clear();
  store = [];
  pending = [];
  landedPoster = null;
  pinEventImage.mockImplementation(
    () => new Promise<{ cid: string }>((resolve, reject) => {
      pending.push({ resolve: (cid) => resolve({ cid }), reject });
    }),
  );
});

describe('the poster modal', () => {
  it('opens the picker in the browser top layer with showModal, above the sticky bar (S4b)', async () => {
    // jsdom has no dialog methods; stand them in so the call the modal makes can be observed.
    const dialogProto = HTMLDialogElement.prototype as unknown as {
      showModal?: () => void;
      close?: () => void;
    };
    const showModal = vi.fn(function openTop(this: HTMLDialogElement) {
      this.setAttribute('open', '');
    });
    dialogProto.showModal = showModal;
    dialogProto.close = function closeTop(this: HTMLDialogElement) {
      this.removeAttribute('open');
    };
    try {
      const user = userEvent.setup();
      open();
      await waitFor(() => expect(listEventDrafts).toHaveBeenCalled());
      await user.click(screen.getByRole('button', { name: copy.posterAdd }));
      // showModal, not the open attribute — the top layer is what lifts the confirm button above
      // the `.route-view` transform and the sticky bar so the tap lands.
      expect(showModal).toHaveBeenCalledTimes(1);
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    } finally {
      delete dialogProto.showModal;
      delete dialogProto.close;
    }
  });

  it('closes on 이 사진으로 정하기 while the upload is still in flight', async () => {
    const user = userEvent.setup();
    open();
    await waitFor(() => expect(listEventDrafts).toHaveBeenCalled());
    await crop(user);

    // Gone, and the pin it started has not answered.
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(pinEventImage).toHaveBeenCalledWith({ bytesBase64: 'AQID', kind: 'poster' });
    expect(pending).toHaveLength(1);
    expect(screen.getByText(copy.posterWorking)).toBeInTheDocument();
  });

  /**
   * The regression this whole change exists for. Swapping the picture for `gatewayUrl(cid)`
   * threw away bytes already decoded in this tab and asked a public gateway for them again
   * (plan section D-2, suspect 2).
   */
  it('shows the bytes just cropped, and still shows them after the pin lands', async () => {
    const user = userEvent.setup();
    open();
    await waitFor(() => expect(listEventDrafts).toHaveBeenCalled());
    await crop(user);

    const shown = card().getAttribute('src') ?? '';
    expect(shown.startsWith('blob:')).toBe(true);

    await land();
    expect(card()).toHaveAttribute('src', shown);
    expect(card().getAttribute('src')).not.toContain('gw.test');
    // And every other screen that is handed this CID resolves to the same local bytes.
    expect(posterUrl('bafkposter')).toBe(shown);
    expect(posterUrl('bafkneverseen')).toBe('https://gw.test/bafkneverseen');
  });

  /**
   * T-UX2-10's one line, and one is what it is: the measurement is only useful if three real
   * photos give three readable lines. The figures themselves are `posterTimings`'s own tests.
   */
  it('says where the poster seconds went once the pin lands, and only once', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const user = userEvent.setup();
    open();
    await waitFor(() => expect(listEventDrafts).toHaveBeenCalled());
    await crop(user);
    expect(info).not.toHaveBeenCalled();

    await land();
    const lines = info.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.startsWith('poster '));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('upload ');
  });

  it('leaves the rest of the scene usable while the upload runs', async () => {
    const user = userEvent.setup();
    open();
    await waitFor(() => expect(listEventDrafts).toHaveBeenCalled());
    await crop(user);

    await user.type(screen.getByLabelText(copy.titleLabel), '재즈 나이트');
    expect(screen.getByLabelText(copy.titleLabel)).toHaveValue('재즈 나이트');
    expect(screen.getByText(copy.posterWorking)).toBeInTheDocument();
  });

  it('keeps the bytes when the server refuses them, and sends the same ones again', async () => {
    const user = userEvent.setup();
    open();
    await waitFor(() => expect(listEventDrafts).toHaveBeenCalled());
    await crop(user);
    const shown = card().getAttribute('src');

    await refuse('BAD_IMAGE_FORMAT');
    expect(screen.getByText(copy.imageProblems.format)).toBeInTheDocument();
    // The picture is still there — nothing was thrown away, so there is something to re-send.
    expect(card()).toHaveAttribute('src', shown as string);

    await user.click(screen.getByRole('button', { name: copy.posterRetry }));
    expect(pinEventImage).toHaveBeenCalledTimes(2);
    expect(pinEventImage.mock.calls[1]?.[0]).toEqual({ bytesBase64: 'AQID', kind: 'poster' });
    // The same bytes, not a second crop.
    expect(card()).toHaveAttribute('src', shown as string);
  });
});

describe('다음 while the poster is still going up', () => {
  it('waits for the upload and then moves on, rather than asking for a poster', async () => {
    const user = userEvent.setup();
    store = [{ id: 'd-1', updatedAt: 1_000, data: ALMOST }];
    open('/org/new/d-1');
    await waitFor(() => expect(screen.getByLabelText(copy.titleLabel)).toHaveValue(ALMOST.title));
    await crop(user);

    await user.click(screen.getByRole('button', { name: copy.tiers.next }));
    expect(screen.getByText(copy.posterWaiting)).toBeInTheDocument();
    expect(screen.queryByText(/^landed:/)).toBeNull();

    await land();
    expect(await screen.findByText('landed:/org/new/d-1/publish')).toBeInTheDocument();
    // And the draft it moved on with carries the CID that landed.
    expect(landedPoster).toBe('bafkposter');
  });

  it('moves on without a poster — the default is generated at publish (T-SIMP-9)', async () => {
    const user = userEvent.setup();
    store = [{ id: 'd-2', updatedAt: 1_000, data: ALMOST }];
    open('/org/new/d-2');
    await waitFor(() => expect(screen.getByLabelText(copy.titleLabel)).toHaveValue(ALMOST.title));
    await user.click(screen.getByRole('button', { name: copy.tiers.next }));
    expect(await screen.findByText('landed:/org/new/d-2/publish')).toBeInTheDocument();
  });

  it('does not move on behind a refusal — the chip is the way on', async () => {
    const user = userEvent.setup();
    store = [{ id: 'd-3', updatedAt: 1_000, data: ALMOST }];
    open('/org/new/d-3');
    await waitFor(() => expect(screen.getByLabelText(copy.titleLabel)).toHaveValue(ALMOST.title));
    await crop(user);

    await user.click(screen.getByRole('button', { name: copy.tiers.next }));
    expect(screen.getByText(copy.posterWaiting)).toBeInTheDocument();

    await refuse('PIN_QUOTA');
    expect(screen.getByText(copy.imageProblems.quota)).toBeInTheDocument();
    expect(screen.queryByText(/^landed:/)).toBeNull();
    expect(screen.getByRole('button', { name: copy.posterRetry })).toBeInTheDocument();
  });
});
