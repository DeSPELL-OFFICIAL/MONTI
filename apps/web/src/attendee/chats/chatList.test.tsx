import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { en } from '../../shared/copy/index';
import type { MyTicket } from '../tickets/useTickets';

const DAY = 86_400;
const now = () => Math.floor(Date.now() / 1000);

function ticket(tokenId: string, eventId: string, state: MyTicket['state'] = 'before'): MyTicket {
  // The art fields the ticket screens read; the chat list only ever looks at the event id.
  return {
    tokenId, eventId, tier: 0, state, checkInTs: null, used: false, imageCid: '', tierName: '', startsAt: 0,
  };
}

let tickets: MyTicket[] = [];
const useMyTickets = vi.fn();
vi.mock('../tickets/useTickets', () => ({ useMyTickets: () => useMyTickets() }));

let rooms: Record<string, { closed: boolean; endsAt: number } | null> = {};
const loadChatRoom = vi.fn();
vi.mock('../../shared/api/firestore', () => ({ loadChatRoom: (id: string) => loadChatRoom(id) }));

const { useChatList, moveInOrder, CHAT_ORDER_STORAGE_KEY } = await import('./useChats');
const { ChatList, DRAG_ACTIVATION } = await import('./ChatList');

beforeEach(() => {
  localStorage.clear();
  tickets = [ticket('20', '5'), ticket('19', '5'), ticket('18', '7')];
  rooms = {};
  useMyTickets.mockImplementation(() => ({ data: tickets, isLoading: false }));
  loadChatRoom.mockImplementation(async (id: string) => rooms[id] ?? null);
});

describe('moveInOrder', () => {
  it('moves one id to where the other one sat', () => {
    expect(moveInOrder(['a', 'b', 'c'], 'c', 'a')).toEqual(['c', 'a', 'b']);
    expect(moveInOrder(['a', 'b', 'c'], 'a', 'c')).toEqual(['b', 'c', 'a']);
    expect(moveInOrder(['a', 'b', 'c'], 'a', 'zz')).toEqual(['a', 'b', 'c']);
  });
});

describe('useChatList', () => {
  it('lists one room per event the person still holds a ticket for', async () => {
    tickets = [...tickets, ticket('17', '9', 'transferred'), ticket('16', '11', 'cancelled')];
    const { result } = renderHook(() => useChatList());
    await waitFor(() => expect(result.current.entries).toHaveLength(2));
    expect(result.current.entries.map((entry) => entry.eventId)).toEqual(['5', '7']);
  });

  it('treats a room it is not a member of yet as open rather than missing', async () => {
    const { result } = renderHook(() => useChatList());
    await waitFor(() => expect(result.current.entries).toHaveLength(2));
    expect(result.current.entries.every((entry) => !entry.closed)).toBe(true);
  });

  it('keeps a room that just closed and drops one that closed a day ago', async () => {
    rooms = {
      5: { closed: true, endsAt: now() - 3_600 },
      7: { closed: true, endsAt: now() - 2 * DAY },
    };
    const { result } = renderHook(() => useChatList());
    await waitFor(() => expect(result.current.entries).toHaveLength(1));
    expect(result.current.entries[0]).toMatchObject({ eventId: '5', closed: true });
  });

  it('keeps the order the person dragged into place, across a reload', async () => {
    const first = renderHook(() => useChatList());
    await waitFor(() => expect(first.result.current.entries).toHaveLength(2));
    act(() => first.result.current.reorder('7', '5'));
    await waitFor(() =>
      expect(first.result.current.entries.map((entry) => entry.eventId)).toEqual(['7', '5']),
    );
    expect(JSON.parse(localStorage.getItem(CHAT_ORDER_STORAGE_KEY) ?? '[]')).toEqual(['7', '5']);

    first.unmount();
    const reloaded = renderHook(() => useChatList());
    await waitFor(() => expect(reloaded.result.current.entries).toHaveLength(2));
    expect(reloaded.result.current.entries.map((entry) => entry.eventId)).toEqual(['7', '5']);
  });

  it('falls back to the default order when storage is not available', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    const { result } = renderHook(() => useChatList());
    await waitFor(() => expect(result.current.entries).toHaveLength(2));
    expect(result.current.entries.map((entry) => entry.eventId)).toEqual(['5', '7']);
    expect(() => act(() => result.current.reorder('7', '5'))).not.toThrow();
  });
});

describe('ChatList', () => {
  function renderList() {
    return render(
      <MemoryRouter>
        <ChatList />
      </MemoryRouter>,
    );
  }

  it('renders the rooms in the stored order, each one a link into the room', async () => {
    localStorage.setItem(CHAT_ORDER_STORAGE_KEY, JSON.stringify(['7', '5']));
    renderList();
    const links = await screen.findAllByRole('link');
    expect(links.map((link) => link.getAttribute('href'))).toEqual(['/chats/7', '/chats/5']);
    expect(screen.getByText(en.chats.reorderHint)).toBeInTheDocument();
  });

  it('marks a closed room and says nothing else about it', async () => {
    rooms = { 5: { closed: true, endsAt: now() - 60 }, 7: null };
    renderList();
    await waitFor(() => expect(screen.getByText(/5/)).toBeInTheDocument());
    expect(screen.getByText(new RegExp(en.chats.closed))).toBeInTheDocument();
  });

  it('says so when there is nothing to show', async () => {
    tickets = [];
    renderList();
    expect(await screen.findByText(en.chats.empty)).toBeInTheDocument();
  });

  it('does not claim the list is empty while the tickets are still on their way', async () => {
    useMyTickets.mockImplementation(() => ({ data: undefined, isLoading: true }));
    renderList();
    await waitFor(() => expect(screen.getByText(en.chats.title)).toBeInTheDocument());
    expect(screen.queryByText(en.chats.empty)).not.toBeInTheDocument();
  });

  it('waits out a press before it treats a touch as a drag, so a tap is still a tap', async () => {
    // The whole row carries the drag listeners and the whole row is the link. Without this
    // delay dnd-kit claims the first pointer-down and the tap never reaches the room.
    expect(DRAG_ACTIVATION).toEqual({ delay: 200, tolerance: 5 });

    render(
      <MemoryRouter initialEntries={['/chats']}>
        <Routes>
          <Route path="/chats" element={<ChatList />} />
          <Route path="/chats/:eventId" element={<p>room open</p>} />
        </Routes>
      </MemoryRouter>,
    );
    const first = (await screen.findAllByRole('link'))[0] as HTMLElement;
    await userEvent.click(first);
    expect(await screen.findByText('room open')).toBeInTheDocument();
    // A plain click is not a reorder, so nothing was written to storage either.
    expect(localStorage.getItem(CHAT_ORDER_STORAGE_KEY)).toBeNull();
  });
});
