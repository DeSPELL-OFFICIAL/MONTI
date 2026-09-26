import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ko } from '../../shared/copy/index';

/** Every Firestore/callable entry point this screen touches, in the order it touched them. */
const calls: string[] = [];

interface Row { id: string; uid: string; text: string; createdAt: number; reported: number; pinned?: boolean }

let messageRows: Row[] = [];
let room = { closed: false, endsAt: 0 };
let subscribeError: unknown = null;

const sendChatMessage = vi.fn();
const watchChatMessages = vi.fn();
const watchChatRoom = vi.fn();
// 500 is the rules' own cap (firestore.rules:64); it is spelled out here so a change to the
// helper cannot quietly let the screen offer a box longer than the write will be allowed.
vi.mock('../../shared/api/firestore', () => ({
  CHAT_MESSAGE_MAX_LENGTH: 500,
  sendChatMessage,
  watchChatMessages,
  watchChatRoom,
}));

const joinEventChat = vi.fn();
const reportMessage = vi.fn();
vi.mock('../../shared/api/functions', async (orig) => ({
  ...(await orig<typeof import('../../shared/api/functions')>()),
  api: { joinEventChat, reportMessage },
}));

// The uid -> nickname resolution has its own test; here it only has to prove the screen shows
// the name it is given and never the uid it was keyed by.
// `senderName` is not stubbed: the 주최자 label on a pinned row is this screen's own rule and
// the test below checks it through the real function.
vi.mock('./useChatNames', async (orig) => ({
  ...(await orig<typeof import('./useChatNames')>()),
  useChatNames: () => ({ u1: 'organizer_kim', u2: 'alice' }),
}));

// The route reuses one component instance across params, so the test has to be able to move
// between rooms the way the router does.
let routeEventId = '5';
vi.mock('react-router-dom', async (orig) => ({
  ...(await orig<typeof import('react-router-dom')>()),
  useParams: () => ({ eventId: routeEventId }),
}));

const { CallableError } = await import('../../shared/api/functions');
const { ChatRoom } = await import('./ChatRoom');

beforeEach(() => {
  routeEventId = '5';
  calls.length = 0;
  subscribeError = null;
  room = { closed: false, endsAt: 0 };
  messageRows = [
    { id: 'm1', uid: 'u1', text: '공지입니다', createdAt: 1, reported: 0, pinned: true },
    { id: 'm2', uid: 'u2', text: '안녕하세요', createdAt: 2, reported: 0 },
  ];
  sendChatMessage.mockResolvedValue('m9');
  joinEventChat.mockImplementation(async () => {
    calls.push('joinEventChat');
    return { ok: true } as const;
  });
  reportMessage.mockResolvedValue({ reported: 1 });
  watchChatMessages.mockImplementation(
    (_id: string, onChange: (rows: Row[]) => void, onError?: (error: unknown) => void) => {
      calls.push('watchChatMessages');
      if (subscribeError) onError?.(subscribeError);
      else onChange(messageRows);
      return () => undefined;
    },
  );
  watchChatRoom.mockImplementation((_id: string, onChange: (value: typeof room) => void) => {
    calls.push('watchChatRoom');
    onChange(room);
    return () => undefined;
  });
});

describe('ChatRoom', () => {
  it('joins the room before it subscribes to anything', async () => {
    render(<ChatRoom />);
    await screen.findByText('안녕하세요');
    expect(joinEventChat).toHaveBeenCalledWith({ eventId: '5' });
    expect(calls[0]).toBe('joinEventChat');
    expect(calls).toContain('watchChatMessages');
    expect(calls).toContain('watchChatRoom');
  });

  it('pins the notice, shows the closed banner and disables sending', async () => {
    room = { closed: true, endsAt: 0 };
    render(<ChatRoom />);
    expect(await screen.findByText(`${ko.chats.notice} · 공지입니다`)).toBeInTheDocument();
    expect(screen.getByText(ko.chats.closed)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(ko.chats.placeholder)).toBeDisabled();
    expect(screen.getByRole('button', { name: ko.chats.send })).toBeDisabled();
    expect(screen.getByPlaceholderText(ko.chats.placeholder)).toHaveAttribute('maxlength', '500');
  });

  it('shows the closed state and never subscribes when the join says the chat is closed', async () => {
    joinEventChat.mockImplementation(async () => {
      calls.push('joinEventChat');
      throw new CallableError('failed-precondition', 'CHAT_CLOSED');
    });
    render(<ChatRoom />);
    expect(await screen.findByText(ko.chats.closed)).toBeInTheDocument();
    expect(calls).toEqual(['joinEventChat']);
  });

  it('treats an ended event the same way', async () => {
    joinEventChat.mockImplementation(async () => {
      calls.push('joinEventChat');
      throw new CallableError('failed-precondition', 'EVENT_ENDED');
    });
    render(<ChatRoom />);
    expect(await screen.findByText(ko.chats.closed)).toBeInTheDocument();
  });

  it('says a ticket is needed when the join is refused', async () => {
    joinEventChat.mockImplementation(async () => {
      throw new CallableError('permission-denied', 'NO_TICKET_FOR_EVENT');
    });
    render(<ChatRoom />);
    expect(await screen.findByText(ko.chats.noTicket)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(ko.chats.placeholder)).toBeDisabled();
  });

  it('says a draft event has no room, instead of telling them to try again', async () => {
    joinEventChat.mockImplementation(async () => {
      throw new CallableError('failed-precondition', 'EVENT_NOT_PUBLISHED');
    });
    render(<ChatRoom />);
    expect(await screen.findByText(ko.chats.unavailable)).toBeInTheDocument();
    expect(screen.queryByText(ko.chats.joinFailed)).not.toBeInTheDocument();
  });

  it('carries nothing from a refused room into the next one', async () => {
    joinEventChat.mockImplementationOnce(async () => {
      throw new CallableError('permission-denied', 'NO_TICKET_FOR_EVENT');
    });
    const { rerender } = render(<ChatRoom />);
    expect(await screen.findByText(ko.chats.noTicket)).toBeInTheDocument();

    routeEventId = '6';
    rerender(<ChatRoom />);
    expect(await screen.findByText('안녕하세요')).toBeInTheDocument();
    expect(screen.queryByText(ko.chats.noTicket)).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText(ko.chats.placeholder)).toBeEnabled();
    expect(joinEventChat).toHaveBeenLastCalledWith({ eventId: '6' });
  });

  it('leaves the previous room messages and report markers behind', async () => {
    render(<ChatRoom />).unmount();
    messageRows = [{ id: 'm7', uid: 'u2', text: '다른 방', createdAt: 7, reported: 0 }];
    routeEventId = '6';
    render(<ChatRoom />);
    expect(await screen.findByText('다른 방')).toBeInTheDocument();
    expect(screen.queryByText('안녕하세요')).not.toBeInTheDocument();
  });

  it('falls back to one sentence for a join failure it does not know', async () => {
    joinEventChat.mockImplementation(async () => {
      throw new CallableError('internal', 'UNKNOWN');
    });
    render(<ChatRoom />);
    expect(await screen.findByText(ko.chats.joinFailed)).toBeInTheDocument();
  });

  it('reads a permission-denied subscription as not being a member yet, without crashing', async () => {
    subscribeError = Object.assign(new Error('Missing or insufficient permissions.'), {
      code: 'permission-denied',
    });
    render(<ChatRoom />);
    expect(await screen.findByText(ko.chats.noTicket)).toBeInTheDocument();
  });

  it('shows the sender nickname and never the uid', async () => {
    render(<ChatRoom />);
    expect(await screen.findByText('alice')).toBeInTheDocument();
    expect(screen.queryByText('u2')).not.toBeInTheDocument();
  });

  it('calls an unknown sender by a name, never by an identifier', async () => {
    messageRows = [{ id: 'm3', uid: 'u9', text: '처음 왔어요', createdAt: 3, reported: 0 }];
    render(<ChatRoom />);
    expect(await screen.findByText(ko.chats.someone)).toBeInTheDocument();
    expect(screen.queryByText('u9')).not.toBeInTheDocument();
  });

  it('marks a message reported the moment the report is sent', async () => {
    render(<ChatRoom />);
    await userEvent.click(await screen.findByRole('button', { name: ko.chats.report }));
    expect(reportMessage).toHaveBeenCalledWith({ eventId: '5', msgId: 'm2' });
    expect(await screen.findByText(ko.chats.reported)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: ko.chats.report })).not.toBeInTheDocument();
  });

  it('says so when the send did not go through, and gives the words back', async () => {
    sendChatMessage.mockRejectedValue(new Error('offline'));
    render(<ChatRoom />);
    const box = await screen.findByPlaceholderText(ko.chats.placeholder);
    await userEvent.type(box, '안녕');
    await userEvent.click(screen.getByRole('button', { name: ko.chats.send }));
    expect(await screen.findByText(ko.chats.sendFailed)).toBeInTheDocument();
    expect(box).toHaveValue('안녕');
  });

  it('sends the trimmed draft and clears the box', async () => {
    render(<ChatRoom />);
    const box = await screen.findByPlaceholderText(ko.chats.placeholder);
    await userEvent.type(box, '  안녕  ');
    await userEvent.click(screen.getByRole('button', { name: ko.chats.send }));
    await waitFor(() => expect(sendChatMessage).toHaveBeenCalledWith('5', '안녕'));
    expect(box).toHaveValue('');
  });
});
