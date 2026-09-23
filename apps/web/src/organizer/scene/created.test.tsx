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

vi.mock('../../shared/config', async (orig) => ({
  ...(await orig<typeof import('../../shared/config')>()),
  getConfig: () => ({ ipfsGateway: 'https://gw.test/' }),
}));

const { Created } = await import('./Created');
const { organizerCopy } = await import('../copy');
const copy = organizerCopy.ko.scene.done;

function open(state: unknown = { posterCid: 'bafkposter', title: '재즈 나이트', followUpFailed: false }): void {
  render(
    <MemoryRouter initialEntries={[{ pathname: '/org/new/done/12', state }]}>
      <Routes>
        <Route path="/org/new/done/:eventId" element={<Created />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  toDataURL.mockReset().mockResolvedValue('data:image/png;base64,QQ==');
});

describe('the done screen', () => {
  it('gives the address an attendee would open, absolutely and in full', async () => {
    open();
    const link = `${window.location.origin}/events/12`;
    expect(screen.getByText(link)).toBeInTheDocument();
    await waitFor(() => expect(toDataURL).toHaveBeenCalledWith(link, expect.anything()));
    expect(await screen.findByAltText(copy.qr)).toHaveAttribute('src', 'data:image/png;base64,QQ==');
  });

  it('copies the address and says so', async () => {
    const user = userEvent.setup();
    open();
    await user.click(screen.getByRole('button', { name: copy.copy }));
    await expect(navigator.clipboard.readText()).resolves.toBe(`${window.location.origin}/events/12`);
    expect(await screen.findByText(copy.copied)).toBeInTheDocument();
  });

  it('says so rather than pretending, when the browser refuses the clipboard', async () => {
    const user = userEvent.setup();
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'));
    open();
    await user.click(screen.getByRole('button', { name: copy.copy }));
    expect(await screen.findByText(copy.copyFailed)).toBeInTheDocument();
  });

  /**
   * `createEvent` makes a Draft and `claim` refuses anything that is not Published, so an
   * organiser who walked away here would have an event nobody can get a ticket for.
   */
  it('says out loud that nobody can see it yet, and where to publish it', () => {
    open();
    expect(screen.getByText(copy.notYetPublic)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: copy.manage })).toHaveAttribute('href', '/org/events/12');
  });

  it('offers the event and the organiser home', () => {
    open();
    expect(screen.getByRole('link', { name: copy.view })).toHaveAttribute('href', '/events/12');
    expect(screen.getByRole('link', { name: copy.home })).toHaveAttribute('href', '/org');
  });

  it('shows the poster and the title that were handed over', () => {
    open();
    expect(screen.getByRole('heading', { name: '재즈 나이트' })).toBeInTheDocument();
    // Decorative, so it carries an empty alt and has no role: the title beside it is the name.
    expect(document.querySelector('.poster-card__filled img'))
      .toHaveAttribute('src', 'https://gw.test/bafkposter');
  });

  it('says which part did not save, when the event itself did', () => {
    open({ posterCid: '', title: '재즈 나이트', followUpFailed: true });
    expect(screen.getByText(copy.artFailed)).toBeInTheDocument();
  });

  /** Opened straight from history or a bookmark: the link and the QR still have to work. */
  it('stands up with nothing handed over at all', async () => {
    open(null);
    expect(screen.getByRole('heading', { name: copy.untitled })).toBeInTheDocument();
    expect(screen.getByText(`${window.location.origin}/events/12`)).toBeInTheDocument();
    await waitFor(() => expect(toDataURL).toHaveBeenCalled());
  });

  /** A QR that would not draw costs the picture; the address is the answer either way. */
  it('keeps the address when the QR will not draw', async () => {
    toDataURL.mockRejectedValue(new Error('no canvas'));
    open();
    await waitFor(() => expect(toDataURL).toHaveBeenCalled());
    expect(screen.queryByAltText(copy.qr)).toBeNull();
    expect(screen.getByText(`${window.location.origin}/events/12`)).toBeInTheDocument();
  });
});
