import { useEffect, useMemo, useState } from 'react';
import { loadChatRoom } from '../../shared/api/firestore';
import { useMyTickets } from '../tickets/useTickets';

export interface ChatEntry {
  eventId: string;
  closed: boolean;
  /** Epoch seconds. Zero for a room this device has not joined and therefore cannot read. */
  endsAt: number;
}

/**
 * Where the drag order lives. It is a per-device convenience — which rooms this person likes at
 * the top of this phone's list — so it never leaves the phone and is never written to the
 * profile. Storage can refuse (private mode), and then the list simply keeps its default order.
 */
export const CHAT_ORDER_STORAGE_KEY = 'monti.chatOrder';

/** `closeEndedChats` closes a room when the event ends; the row stays for one more day. */
const CLOSED_GRACE_SECONDS = 24 * 60 * 60;

/** A ticket in one of these states is no longer held, and `joinEventChat` refuses the room. */
const NOT_HELD: ReadonlySet<string> = new Set(['transferred', 'cancelled']);

export function readChatOrder(): string[] {
  try {
    const raw = localStorage.getItem(CHAT_ORDER_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

export function writeChatOrder(order: string[]): void {
  try {
    localStorage.setItem(CHAT_ORDER_STORAGE_KEY, JSON.stringify(order));
  } catch {
    /* private mode: the order is a convenience, not state anything depends on */
  }
}

/** Where a drag leaves the list: `activeId` takes `overId`'s place and the rest shift along. */
export function moveInOrder(ids: string[], activeId: string, overId: string): string[] {
  const from = ids.indexOf(activeId);
  const to = ids.indexOf(overId);
  if (from < 0 || to < 0 || from === to) return ids;
  const next = [...ids];
  next.splice(to, 0, ...next.splice(from, 1));
  return next;
}

/** Stored order first, in its own sequence; everything it does not name keeps its arrival order. */
function sortByOrder(entries: ChatEntry[], order: string[]): ChatEntry[] {
  const rank = new Map(order.map((id, index) => [id, index]));
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => {
      const left = rank.get(a.entry.eventId) ?? Number.MAX_SAFE_INTEGER;
      const right = rank.get(b.entry.eventId) ?? Number.MAX_SAFE_INTEGER;
      return left === right ? a.index - b.index : left - right;
    })
    .map(({ entry }) => entry);
}

/**
 * The rooms this person can walk into: one per event they still hold a ticket for, minus the
 * ones that closed more than a day ago. The tickets are the truth — `joinEventChat` re-checks
 * the same thing on chain, so a list built from anything else would only promise more than the
 * room can deliver.
 */
export function useChatList(): {
  entries: ChatEntry[];
  isLoading: boolean;
  reorder: (activeId: string, overId: string) => void;
} {
  const { data: tickets, isLoading } = useMyTickets();
  const [rooms, setRooms] = useState<ChatEntry[]>([]);
  const [order, setOrder] = useState<string[]>(() => readChatOrder());

  const eventIds = useMemo(
    () => [
      ...new Set(
        (tickets ?? []).filter((ticket) => !NOT_HELD.has(ticket.state)).map((ticket) => ticket.eventId),
      ),
    ],
    [tickets],
  );
  // A joined string, so a fresh array of the same ids does not re-run the reads.
  const eventKey = eventIds.join(',');

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const ids = eventKey === '' ? [] : eventKey.split(',');
      const rows = await Promise.all(
        ids.map(async (eventId): Promise<ChatEntry> => {
          const room = await loadChatRoom(eventId);
          return { eventId, closed: room?.closed ?? false, endsAt: room?.endsAt ?? 0 };
        }),
      );
      if (cancelled) return;
      const now = Math.floor(Date.now() / 1000);
      setRooms(rows.filter((room) => !room.closed || now - room.endsAt < CLOSED_GRACE_SECONDS));
    })();
    return () => {
      cancelled = true;
    };
  }, [eventKey]);

  const entries = sortByOrder(rooms, order);

  function reorder(activeId: string, overId: string): void {
    const next = moveInOrder(
      entries.map((entry) => entry.eventId),
      activeId,
      overId,
    );
    writeChatOrder(next);
    setOrder(next);
  }

  return { entries, isLoading, reorder };
}
