import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `qrcode` 1.5.4 is already a dependency of this app and already drives the entry fallback
 * (`attendee/enter/Qr.tsx`), so nothing was added and nothing was hand-rolled. It is mocked
 * here for the same reason that screen mocks it: jsdom has no canvas that encodes.
 */
const toDataURL = vi.fn<(text: string) => Promise<string>>();
vi.mock('qrcode', () => ({ default: { toDataURL } }));

/** The two writes the retry button runs, and the draft it is holding open until they land. */
const saveEventArt = vi.fn(async (_args: unknown) => ({ ok: true as const }));
const setEventPrivate = vi.fn(async (_args: unknown) => ({ ok: true as const }));
vi.mock('../../shared/api/functions', async (orig) => ({
  ...(await orig<typeof import('../../shared/api/functions')>()),
  api: { saveEventArt, setEventPrivate },
}));
const deleteEventDraft = vi.fn(async () => undefined);
vi.mock('../../shared/api/firestore', () => ({
  deleteEventDraft,
  listEventDrafts: vi.fn(async () => []),
  saveEventDraft: vi.fn(async () => undefined),
}));

vi.mock('../../shared/config', async (orig) => ({
  ...(await orig<typeof import('../../shared/config')>()),
  getConfig: () => ({ ipfsGateway: 'https://gw.test/' }),
}));

const { Created } = await import('./Created');
const { organizerCopy } = await import('../copy');
const copy = organizerCopy.en.scene.done;
const LINK = `${window.location.origin}/events/12`;

function open(state: unknown = { posterCid: 'bafkposter', title: '재즈 나이트', followUpFailed: false }): void {
  render(
    <MemoryRouter initialEntries={[{ pathname: '/org/new/done/12', state }]}>
      <Routes>
        <Route path="/org/new/done/:eventId" element={<Created />} />
      </Routes>
    </MemoryRouter>,
  );
}

/** What the publish path hands over when `saveEventArt` was refused and the venue was written. */
const UNFINISHED = {
  posterCid: '', title: '재즈 나이트', followUpFailed: true, draftId: 'd-42',
  plan: { eventId: '12', tiers: [{ preset: 'c' }], venue: '서울 용산구 한남동' },
  done: { artSaved: false, venueSaved: true },
};

beforeEach(() => {
  localStorage.clear();
  toDataURL.mockReset().mockResolvedValue('data:image/png;base64,QQ==');
  saveEventArt.mockReset().mockResolvedValue({ ok: true });
  setEventPrivate.mockReset().mockResolvedValue({ ok: true });
  deleteEventDraft.mockReset().mockResolvedValue(undefined);
});

/** v2: the single publish write made the event public, so this screen is the shareable state. */
describe('the done screen — public on arrival', () => {
  it('shows the share link and the QR from the first paint, with no publish button', async () => {
    open();
    expect(screen.getByText(LINK)).toBeInTheDocument();
    expect(await screen.findByAltText(copy.qr)).toHaveAttribute('src', 'data:image/png;base64,QQ==');
    expect(screen.getByText(copy.nowPublic)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: copy.title, level: 1 })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Publish/ })).toBeNull();
  });

  it('shows the two-step header with both steps done', () => {
    open();
    expect(document.querySelectorAll('.steps__step--done')).toHaveLength(2);
    expect(document.querySelector('.steps__step--current')).toBeNull();
  });

  it('shows the poster and the title that were handed over', () => {
    open();
    expect(screen.getByRole('heading', { name: '재즈 나이트' })).toBeInTheDocument();
    expect(document.querySelector('.poster-card__filled img'))
      .toHaveAttribute('src', 'https://gw.test/bafkposter');
  });

  it('copies the address, and says so', async () => {
    const user = userEvent.setup();
    open();
    await user.click(screen.getByRole('button', { name: copy.copy }));
    await expect(navigator.clipboard.readText()).resolves.toBe(LINK);
    expect(await screen.findByText(copy.copied)).toBeInTheDocument();
  });

  it('says so rather than pretending, when the browser refuses the clipboard', async () => {
    const user = userEvent.setup();
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'));
    open();
    await user.click(screen.getByRole('button', { name: copy.copy }));
    expect(await screen.findByText(copy.copyFailed)).toBeInTheDocument();
  });

  it('keeps the address when the QR will not draw', async () => {
    toDataURL.mockRejectedValue(new Error('no canvas'));
    open();
    expect(screen.getByText(LINK)).toBeInTheDocument();
    await waitFor(() => expect(toDataURL).toHaveBeenCalled());
    expect(screen.queryByAltText(copy.qr)).toBeNull();
  });

  it('stands up with nothing handed over at all', () => {
    open(null);
    expect(screen.getByRole('heading', { name: copy.untitled })).toBeInTheDocument();
    expect(screen.getByText(LINK)).toBeInTheDocument();
  });

  it('anchors the copy button in the bottom sticky bar (visual R1-5)', () => {
    open();
    expect(screen.getByRole('button', { name: copy.copy }).closest('.sticky-bar')).not.toBeNull();
  });
});

describe('the done screen — the follow-up retry', () => {
  it('offers the organiser home, the event screen and the event page', () => {
    open();
    expect(screen.getByRole('link', { name: copy.manage })).toHaveAttribute('href', '/org/events/12');
    expect(screen.getByRole('link', { name: copy.home })).toHaveAttribute('href', '/org');
    expect(screen.getByRole('link', { name: copy.view })).toHaveAttribute('href', '/events/12');
  });

  it('says which part did not save, when the event itself did', () => {
    open(UNFINISHED);
    expect(screen.getByText(copy.artFailed)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: copy.retry })).toBeInTheDocument();
  });

  /**
   * The retry the copy names, on this screen. Both callables replace their document rather than
   * merging, so running one again is the same as running it once.
   */
  it('runs only the write that is still missing, and lets the draft go once it lands', async () => {
    const user = userEvent.setup();
    open(UNFINISHED);
    await user.click(screen.getByRole('button', { name: copy.retry }));

    await waitFor(() => expect(saveEventArt)
      .toHaveBeenCalledWith({ eventId: '12', tiers: [{ preset: 'c' }] }));
    // The venue already landed, so it is not written a second time.
    expect(setEventPrivate).not.toHaveBeenCalled();
    await waitFor(() => expect(deleteEventDraft).toHaveBeenCalledWith('d-42'));
    expect(await screen.findByText(copy.retryDone)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: copy.retry })).toBeNull();
  });

  it('keeps the draft and the button when the retry is refused again', async () => {
    const user = userEvent.setup();
    saveEventArt.mockRejectedValue(new Error('offline'));
    open(UNFINISHED);
    await user.click(screen.getByRole('button', { name: copy.retry }));

    await waitFor(() => expect(saveEventArt).toHaveBeenCalled());
    expect(deleteEventDraft).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: copy.retry })).toBeInTheDocument();
    expect(screen.getByText(copy.artFailed)).toBeInTheDocument();
  });

  it('writes the hidden venue too when that is the half that was refused', async () => {
    const user = userEvent.setup();
    open({ ...UNFINISHED, done: { artSaved: true, venueSaved: false } });
    await user.click(screen.getByRole('button', { name: copy.retry }));

    await waitFor(() => expect(setEventPrivate)
      .toHaveBeenCalledWith({ eventId: '12', venue: '서울 용산구 한남동' }));
    expect(saveEventArt).not.toHaveBeenCalled();
  });

  it('offers no retry when nothing was missing', () => {
    open();
    expect(screen.queryByRole('button', { name: copy.retry })).toBeNull();
    expect(screen.queryByText(copy.artFailed)).toBeNull();
  });
});
