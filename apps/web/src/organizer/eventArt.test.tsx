import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TicketArtSource } from '../shared/ui';

let stored: TicketArtSource[] = [];
const loadEventArt = vi.fn(async () => stored);
vi.mock('../shared/api/firestore', () => ({ loadEventArt }));

const saveEventArt = vi.fn(async (_args: { eventId: string; tiers: TicketArtSource[] }) => ({ ok: true as const }));
const pinEventImage = vi.fn(async (_args: { bytesBase64: string; kind: string }) => ({ cid: 'bafkmine' }));
vi.mock('../shared/api/functions', async (orig) => ({
  ...(await orig<typeof import('../shared/api/functions')>()),
  api: { saveEventArt, pinEventImage },
}));

vi.mock('../shared/ui/a4Crop', async (orig) => ({
  ...(await orig<typeof import('../shared/ui/a4Crop')>()),
  cropToA4: vi.fn(async () => ({ blob: new Blob(), base64: 'AQID', width: 1240, height: 1754 })),
}));

vi.mock('../shared/config', async (orig) => ({
  ...(await orig<typeof import('../shared/config')>()),
  getConfig: () => ({ ipfsGateway: 'https://gw.test/' }),
}));

const { EventArt } = await import('./EventArt');
const { organizerCopy } = await import('./copy');
const { ko: sharedCopy } = await import('../shared/copy/index');
const copy = organizerCopy.ko.dashboard.art;
const tierCopy = organizerCopy.ko.scene.tiers;

const TIERS = [{ name: '일반' }, { name: '학생' }];

function open(tiers = TIERS): void {
  render(<EventArt eventId="5" tiers={tiers} title="재즈 나이트" />);
}

/** The second kind's card, so a change to the first is provably not a change to this one. */
function card(name: string): HTMLElement {
  return screen.getByRole('heading', { name, level: 3 }).closest('li') as HTMLElement;
}

beforeAll(() => {
  URL.createObjectURL = () => 'blob:art';
  URL.revokeObjectURL = () => undefined;
});

beforeEach(() => {
  stored = [];
  saveEventArt.mockResolvedValue({ ok: true as const });
  pinEventImage.mockResolvedValue({ cid: 'bafkmine' });
});

describe('the ticket pictures of an event that already exists', () => {
  it('shows what each kind carries now, read from the document and not from a callable', async () => {
    stored = [{ preset: 'c' }, { imageCid: 'bafkold' }];
    open();
    await waitFor(() => expect(loadEventArt).toHaveBeenCalledWith('5'));
    // Both pictures name the event and the kind, which is what an attendee will be handed.
    expect(await screen.findByRole('img', { name: /재즈 나이트 · 일반/ })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /재즈 나이트 · 학생/ })).toBeInTheDocument();
    // The picker is closed until 바꾸기 is pressed.
    expect(screen.queryByRole('button', { name: tierCopy.artNames.c })).toBeNull();
  });

  /** Controller ruling 1: the founder's "이미지는 나중에 수정 가능". */
  it('sends the whole list when a preset is picked, so the other kinds keep their pictures', async () => {
    stored = [{ preset: 'a' }, { imageCid: 'bafkkept' }];
    const user = userEvent.setup();
    open();
    await waitFor(() => expect(loadEventArt).toHaveBeenCalled());

    await user.click(within(card('일반')).getByRole('button', { name: copy.change }));
    await user.click(await screen.findByRole('button', { name: tierCopy.artNames.c }));

    await waitFor(() =>
      expect(saveEventArt).toHaveBeenCalledWith({
        eventId: '5',
        tiers: [{ preset: 'c' }, { imageCid: 'bafkkept' }],
      }));
    expect(await screen.findByText(copy.saved)).toBeInTheDocument();
    // The picker closes on a save that landed, and the new picture is on screen.
    expect(screen.queryByRole('button', { name: tierCopy.artNames.c })).toBeNull();
  });

  it('uploads a picture of their own through the same cropper and sends the whole list', async () => {
    stored = [{ preset: 'b' }, { preset: 'd' }];
    const user = userEvent.setup();
    open();
    await waitFor(() => expect(loadEventArt).toHaveBeenCalled());

    await user.click(within(card('학생')).getByRole('button', { name: copy.change }));
    await user.click(await screen.findByRole('button', { name: tierCopy.artUpload }));
    const file = new File([new Uint8Array([1, 2, 3])], 'art.jpg', { type: 'image/jpeg' });
    await user.upload(screen.getByLabelText(sharedCopy.poster.pick), file);
    await user.click(await screen.findByRole('button', { name: sharedCopy.poster.crop }));

    // A ticket picture, never a poster: the server's size cap is the smaller of the two.
    await waitFor(() => expect(pinEventImage).toHaveBeenCalledWith({ bytesBase64: 'AQID', kind: 'ticket' }));
    await waitFor(() =>
      expect(saveEventArt).toHaveBeenCalledWith({
        eventId: '5',
        tiers: [{ preset: 'b' }, { imageCid: 'bafkmine' }],
      }));
  });

  it('fills a list shorter than the kinds with the first preset rather than sending a hole', async () => {
    stored = [];
    const user = userEvent.setup();
    open();
    await waitFor(() => expect(loadEventArt).toHaveBeenCalled());

    await user.click(within(card('학생')).getByRole('button', { name: copy.change }));
    await user.click(await screen.findByRole('button', { name: tierCopy.artNames.d }));

    await waitFor(() =>
      expect(saveEventArt).toHaveBeenCalledWith({
        eventId: '5',
        tiers: [{ preset: 'a' }, { preset: 'd' }],
      }));
  });

  it('says so and keeps the choice on screen when the save is refused', async () => {
    saveEventArt.mockRejectedValue(Object.assign(new Error('NOT_ORGANIZER'), { code: 'permission-denied' }));
    const user = userEvent.setup();
    open();
    await waitFor(() => expect(loadEventArt).toHaveBeenCalled());

    await user.click(within(card('일반')).getByRole('button', { name: copy.change }));
    await user.click(await screen.findByRole('button', { name: tierCopy.artNames.b }));

    expect(await screen.findByText(copy.notAllowed)).toBeInTheDocument();
    // Still open, so pressing again is the retry — the call replaces the document either way.
    expect(screen.getByRole('button', { name: tierCopy.artNames.b })).toHaveAttribute('aria-pressed', 'true');
  });
});
