import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PinnedMessage } from '../shared/api/functions';

const pinMessage = vi.fn(async () => ({ ok: true as const, messageId: 'm1' }));
const listPinned = vi.fn<(args: { eventId: string }) => Promise<PinnedMessage[]>>(async () => []);
vi.mock('../shared/api/functions', async (orig) => ({
  ...(await orig<typeof import('../shared/api/functions')>()),
  api: { pinMessage, listPinned },
}));

// Nothing here may reach Firestore: `pinned` is a permission claim and the rules refuse it
// from every client, so a direct write would be a silent permission error, not a notice.
const firestore = vi.fn();
vi.mock('../shared/api/firestore', () => ({ sendChatMessage: firestore }));

const { organizerCopy } = await import('./copy');
const { Announce } = await import('./Announce');
const copy = organizerCopy.ko.announce;

beforeEach(() => {
  pinMessage.mockResolvedValue({ ok: true, messageId: 'm1' });
  listPinned.mockResolvedValue([]);
});

describe('the organiser notice', () => {
  it('posts through the callable by its text argument, and never writes the room itself', async () => {
    const user = userEvent.setup();
    render(<Announce eventId="5" />);
    await user.type(screen.getByRole('textbox'), '  문 앞에서 만나요  ');
    await user.click(screen.getByRole('button', { name: copy.post }));

    await waitFor(() => expect(pinMessage).toHaveBeenCalledWith({ eventId: '5', text: '문 앞에서 만나요' }));
    expect(firestore).not.toHaveBeenCalled();
  });

  /**
   * The organiser holds no ticket, so the room itself is closed to them; `listPinned` is the
   * only way a notice posted before this browser was opened can appear at all.
   */
  it('lists the notices pinned in an earlier session, asking by the event it was given', async () => {
    listPinned.mockResolvedValueOnce([
      { messageId: 'm2', text: '어제 올린 공지', createdAt: 200 },
      { messageId: 'm1', text: '그제 올린 공지', createdAt: 100 },
    ]);
    render(<Announce eventId="5" />);

    expect(await screen.findByText('어제 올린 공지')).toBeInTheDocument();
    expect(screen.getByText('그제 올린 공지')).toBeInTheDocument();
    expect(listPinned).toHaveBeenCalledWith({ eventId: '5' });
  });

  it('keeps the order the server gave and puts what it just posted above it', async () => {
    const user = userEvent.setup();
    listPinned.mockResolvedValueOnce([
      { messageId: 'm2', text: '어제 올린 공지', createdAt: 200 },
      { messageId: 'm1', text: '그제 올린 공지', createdAt: 100 },
    ]);
    pinMessage.mockResolvedValueOnce({ ok: true, messageId: 'm9' });
    render(<Announce eventId="5" />);
    await screen.findByText('어제 올린 공지');

    await user.type(screen.getByRole('textbox'), '방금 올린 공지');
    await user.click(screen.getByRole('button', { name: copy.post }));

    expect(await screen.findByText('방금 올린 공지')).toBeInTheDocument();
    expect(screen.getAllByRole('listitem').map((row) => row.textContent)).toEqual([
      '방금 올린 공지',
      '어제 올린 공지',
      '그제 올린 공지',
    ]);
    expect(screen.getByRole('textbox')).toHaveValue('');
  });

  /** The same notice arrives twice — once from `pinMessage`, once inside the page it lands in. */
  it('lists a notice once when the load catches up with what was just posted', async () => {
    const user = userEvent.setup();
    let answer: (rows: PinnedMessage[]) => void = () => {};
    listPinned.mockReturnValueOnce(
      new Promise<PinnedMessage[]>((resolve) => {
        answer = resolve;
      }),
    );
    pinMessage.mockResolvedValueOnce({ ok: true, messageId: 'm9' });
    render(<Announce eventId="5" />);
    await user.type(screen.getByRole('textbox'), '방금 올린 공지');
    await user.click(screen.getByRole('button', { name: copy.post }));
    expect(await screen.findByText('방금 올린 공지')).toBeInTheDocument();

    answer([
      { messageId: 'm9', text: '방금 올린 공지', createdAt: 300 },
      { messageId: 'm1', text: '어제 올린 공지', createdAt: 100 },
    ]);

    expect(await screen.findByText('어제 올린 공지')).toBeInTheDocument();
    expect(screen.getAllByText('방금 올린 공지')).toHaveLength(1);
  });

  it('says there is no notice yet rather than showing an empty list', async () => {
    render(<Announce eventId="5" />);
    expect(await screen.findByText(copy.none)).toBeInTheDocument();
  });

  /** A history nobody could read is not a refusal to post, and must not be dressed as one. */
  it('says the load failed on its own line, and posts anyway', async () => {
    const user = userEvent.setup();
    listPinned.mockRejectedValueOnce(
      Object.assign(new Error('NOT_ORGANIZER_ADMIN'), { code: 'permission-denied' }),
    );
    pinMessage.mockResolvedValueOnce({ ok: true, messageId: 'm9' });
    render(<Announce eventId="5" />);

    expect(await screen.findByText(copy.loadFailed)).toBeInTheDocument();
    expect(screen.queryByText(copy.notAllowed)).not.toBeInTheDocument();
    expect(screen.queryByText(copy.failed)).not.toBeInTheDocument();

    await user.type(screen.getByRole('textbox'), '그래도 올린 공지');
    await user.click(screen.getByRole('button', { name: copy.post }));

    expect(await screen.findByText('그래도 올린 공지')).toBeInTheDocument();
    expect(screen.getByText(copy.loadFailed)).toBeInTheDocument();
  });

  it('says who may post rather than "try again" when the server refuses this caller', async () => {
    const user = userEvent.setup();
    pinMessage.mockRejectedValueOnce(
      Object.assign(new Error('NOT_ORGANIZER_ADMIN'), { code: 'permission-denied' }),
    );
    render(<Announce eventId="5" />);
    await user.type(screen.getByRole('textbox'), '공지');
    await user.click(screen.getByRole('button', { name: copy.post }));
    expect(await screen.findByText(copy.notAllowed)).toBeInTheDocument();
  });

  it('says the room is closed when the event is over', async () => {
    const user = userEvent.setup();
    pinMessage.mockRejectedValueOnce(
      Object.assign(new Error('CHAT_CLOSED'), { code: 'failed-precondition' }),
    );
    render(<Announce eventId="5" />);
    await user.type(screen.getByRole('textbox'), '공지');
    await user.click(screen.getByRole('button', { name: copy.post }));
    expect(await screen.findByText(copy.chatClosed)).toBeInTheDocument();
  });

  it('sends nothing for an empty box', async () => {
    const user = userEvent.setup();
    render(<Announce eventId="5" />);
    await user.type(screen.getByRole('textbox'), '   ');
    expect(screen.getByRole('button', { name: copy.post })).toBeDisabled();
    expect(pinMessage).not.toHaveBeenCalled();
  });
});
