import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LifecycleResult } from '../lifecycle';

/**
 * `qrcode` 1.5.4 is already a dependency of this app and already drives the entry fallback
 * (`attendee/enter/Qr.tsx`), so nothing was added and nothing was hand-rolled. It is mocked
 * here for the same reason that screen mocks it: jsdom has no canvas that encodes.
 */
const toDataURL = vi.fn<(text: string) => Promise<string>>();
vi.mock('qrcode', () => ({ default: { toDataURL } }));

/**
 * The publish (Draft → Published) this screen now runs in place (T-SIMP-6). It is mocked at the
 * same seam the dashboard test uses — the op sender, the staff account, the org read off chain,
 * and the indexer — so `publishEvent` itself runs for real.
 */
vi.mock('../../shared/chain/accounts', () => ({ getStaffAccount: async () => ({ address: `0x${'ab'.repeat(20)}` }) }));

// The relayed publish is mocked at the module seam; lifecycle.test.ts covers the transport.
const publishEvent = vi.fn<(eventId: bigint, orgId: bigint) => Promise<LifecycleResult>>(async () => ({ state: 'done' }));
vi.mock('../lifecycle', () => ({ publishEvent }));
const eventOrg = vi.fn(async () => 9n);
// The status hook reads `eventStatus` (0 = Draft) as its chain fallback; a just-created event is a
// Draft, so this screen offers 지금 공개하기 until a publish moves it on.
const eventStatus = vi.fn(async () => 0);
vi.mock('../../shared/chain/reads', async (orig) => ({
  ...(await orig<typeof import('../../shared/chain/reads')>()),
  readTicket: () => ({ eventOrg, eventStatus }),
}));
const gql = vi.fn(async (): Promise<Record<string, unknown>> => ({ Event: [{ status: 'Draft' }] }));
vi.mock('../../shared/envio/client', () => ({ gql }));

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
const { ko } = await import('../../shared/copy');
const copy = organizerCopy.ko.scene.done;
const life = organizerCopy.ko.lifecycle;
const common = ko.common;
const LINK = `${window.location.origin}/events/12`;

function open(state: unknown = { posterCid: 'bafkposter', title: '재즈 나이트', followUpFailed: false }): void {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[{ pathname: '/org/new/done/12', state }]}>
        <Routes>
          <Route path="/org/new/done/:eventId" element={<Created />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** What SCENE 2 hands over when `saveEventArt` was refused and the venue was written. */
const UNFINISHED = {
  posterCid: '', title: '재즈 나이트', followUpFailed: true, draftId: 'd-42',
  plan: { eventId: '12', tiers: [{ preset: 'c' }], venue: '서울 용산구 한남동' },
  done: { artSaved: false, venueSaved: true },
};

beforeEach(() => {
  localStorage.clear();
  toDataURL.mockReset().mockResolvedValue('data:image/png;base64,QQ==');
  publishEvent.mockReset().mockResolvedValue({ state: 'done' });
  eventOrg.mockReset().mockResolvedValue(9n);
  eventStatus.mockReset().mockResolvedValue(0);
  gql.mockReset().mockResolvedValue({ Event: [{ status: 'Draft' }] });
  saveEventArt.mockReset().mockResolvedValue({ ok: true });
  setEventPrivate.mockReset().mockResolvedValue({ ok: true });
  deleteEventDraft.mockReset().mockResolvedValue(undefined);
});

describe('the done screen — before it is public', () => {
  /**
   * `createEvent` makes a Draft and `claim` refuses anything that is not Published, so an
   * address nobody can open yet is a false promise: the link and the QR stay hidden, and the
   * one thing offered is the publish itself (T-SIMP-6).
   */
  it('hides the share link and the QR until it is public, and offers 지금 공개하기', () => {
    open();
    expect(screen.queryByText(LINK)).toBeNull();
    expect(screen.queryByAltText(copy.qr)).toBeNull();
    expect(screen.getByText(copy.notYetPublic)).toHaveClass('badge');
    expect(screen.getByRole('button', { name: copy.publishNow })).toBeInTheDocument();
  });

  /** The reassurance beside the button: publishing is free and MONTI does the hard part. */
  it('reassures that going public is free and handled for them', () => {
    open();
    expect(screen.getByText('공개 비용은 없어요 · MONTI가 대신 처리해요')).toBeInTheDocument();
  });

  /** Plan §2b: the two-step header, at step 2 — going public is what is still to come. */
  it('shows the two-step header with the publish step as the one still to come', () => {
    open();
    expect(document.querySelector('.steps')).toBeInTheDocument();
    expect(document.querySelector('.steps__step--current .steps__label')?.textContent)
      .toBe(organizerCopy.ko.scene.stepPublish);
  });

  it('shows the poster and the title that were handed over', () => {
    open();
    expect(screen.getByRole('heading', { name: '재즈 나이트' })).toBeInTheDocument();
    // Decorative, so it carries an empty alt and has no role: the title beside it is the name.
    expect(document.querySelector('.poster-card__filled img'))
      .toHaveAttribute('src', 'https://gw.test/bafkposter');
  });
});

describe('the done screen — an event that is already public', () => {
  /**
   * Reopened from history, or published in another tab: the status hook reads Published, so the
   * shareable state is shown straight away rather than offering a 지금 공개하기 the chain would
   * only revert with NotDraft.
   */
  it('shows the share link directly and offers no re-publish', async () => {
    gql.mockResolvedValue({ Event: [{ status: 'Published' }] });
    open();
    expect(await screen.findByText(LINK)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: copy.publishNow })).toBeNull();
    expect(publishEvent).not.toHaveBeenCalled();
  });
});

describe('the done screen — going public in place', () => {
  /**
   * The whole of T-SIMP-6: pressing 지금 공개하기 publishes on this screen, and the share link and
   * the QR appear where the button was — no navigation, no back button to reach the shareable state.
   */
  it('publishes in place and reveals the link and the QR on the same screen', async () => {
    const user = userEvent.setup();
    open();
    await user.click(screen.getByRole('button', { name: copy.publishNow }));

    await waitFor(() => expect(publishEvent).toHaveBeenCalledWith(12n, 9n));
    expect(await screen.findByText(LINK)).toBeInTheDocument();
    expect(await screen.findByAltText(copy.qr)).toHaveAttribute('src', 'data:image/png;base64,QQ==');
    expect(screen.getByText(copy.nowPublic)).toBeInTheDocument();
    // 되돌아가기 0: still the same completion screen, reached without any back navigation.
    expect(screen.getByRole('heading', { name: '재즈 나이트' })).toBeInTheDocument();
  });

  it('names the rule and keeps 지금 공개하기 when the chain refuses the publish', async () => {
    const user = userEvent.setup();
    publishEvent.mockResolvedValueOnce({ state: 'refused', problem: 'notDraft' });
    open();
    await user.click(screen.getByRole('button', { name: copy.publishNow }));

    expect(await screen.findByText(life.notDraft)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: copy.publishNow })).toBeInTheDocument();
    expect(screen.queryByText(LINK)).toBeNull();
  });

  it('copies the address once it is public, and says so', async () => {
    const user = userEvent.setup();
    open();
    await user.click(screen.getByRole('button', { name: copy.publishNow }));
    await user.click(await screen.findByRole('button', { name: copy.copy }));
    await expect(navigator.clipboard.readText()).resolves.toBe(LINK);
    expect(await screen.findByText(copy.copied)).toBeInTheDocument();
  });

  it('says so rather than pretending, when the browser refuses the clipboard', async () => {
    const user = userEvent.setup();
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'));
    open();
    await user.click(screen.getByRole('button', { name: copy.publishNow }));
    await user.click(await screen.findByRole('button', { name: copy.copy }));
    expect(await screen.findByText(copy.copyFailed)).toBeInTheDocument();
  });

  /** A QR that would not draw costs the picture; the address is the answer either way. */
  it('keeps the address when the QR will not draw', async () => {
    const user = userEvent.setup();
    toDataURL.mockRejectedValue(new Error('no canvas'));
    open();
    await user.click(screen.getByRole('button', { name: copy.publishNow }));
    expect(await screen.findByText(LINK)).toBeInTheDocument();
    expect(screen.queryByAltText(copy.qr)).toBeNull();
  });

  /** Opened straight from history or a bookmark: the publish still works and the link follows. */
  it('stands up with nothing handed over at all', async () => {
    const user = userEvent.setup();
    open(null);
    expect(screen.getByRole('heading', { name: copy.untitled })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: copy.publishNow }));
    expect(await screen.findByText(LINK)).toBeInTheDocument();
  });

  /** visual R1-5 — the primary anchors the bottom sticky bar: 지금 공개하기 before, 링크 복사 after. */
  it('anchors the primary in the bottom sticky bar (visual R1-5)', async () => {
    const user = userEvent.setup();
    open();
    expect(screen.getByRole('button', { name: copy.publishNow }).closest('.sticky-bar')).not.toBeNull();
    await user.click(screen.getByRole('button', { name: copy.publishNow }));
    const copyBtn = await screen.findByRole('button', { name: copy.copy });
    expect(copyBtn.closest('.sticky-bar')).not.toBeNull();
  });
});

describe('the done screen — the follow-up retry', () => {
  it('offers the organiser home and the event screen, and the event page once public', async () => {
    const user = userEvent.setup();
    open();
    expect(screen.getByRole('link', { name: copy.manage })).toHaveAttribute('href', '/org/events/12');
    expect(screen.getByRole('link', { name: copy.home })).toHaveAttribute('href', '/org');
    expect(screen.queryByRole('link', { name: copy.view })).toBeNull();

    await user.click(screen.getByRole('button', { name: copy.publishNow }));
    expect(await screen.findByRole('link', { name: copy.view })).toHaveAttribute('href', '/events/12');
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
