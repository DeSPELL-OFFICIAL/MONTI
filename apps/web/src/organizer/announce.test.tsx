import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const pinMessage = vi.fn(async () => ({ ok: true as const, messageId: 'm1' }));
vi.mock('../shared/api/functions', async (orig) => ({
  ...(await orig<typeof import('../shared/api/functions')>()),
  api: { pinMessage },
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

  /** The organiser holds no ticket, so there is no room to read back — only what was just sent. */
  it('lists what it posted this session and says that is all it can show', async () => {
    const user = userEvent.setup();
    render(<Announce eventId="5" />);
    await user.type(screen.getByRole('textbox'), '공지 하나');
    await user.click(screen.getByRole('button', { name: copy.post }));

    expect(await screen.findByText('공지 하나')).toBeInTheDocument();
    expect(screen.getByText(copy.sessionOnly)).toBeInTheDocument();
    expect(screen.getByRole('textbox')).toHaveValue('');
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
