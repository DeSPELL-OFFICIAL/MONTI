import { useQueries } from '@tanstack/react-query';
import { loadEventArt } from '../../shared/api/firestore';
import { useCopy } from '../../shared/i18n';
import type { TicketArtProps, TicketArtSource } from '../../shared/ui';
import type { MyTicket } from './useTickets';

/**
 * The picture a ticket has when nothing else was said about it. `eventArt/{eventId}` is written
 * by a callable most events have never been through, and a ticket with no picture at all would
 * be a hole in the list, so the missing document resolves to a bundled preset rather than to
 * nothing. The same value covers a tier the stored list is too short to reach.
 */
const DEFAULT_ART: TicketArtSource = { preset: 'a' };

/**
 * One Firestore read per event, keyed by the event itself so the list and the detail screen
 * share the answer: opening a ticket from the list reads nothing a second time. The set is
 * de-duplicated and sorted first — four tickets to one event are one read, and two renders
 * that name the same events in a different order are the same set of cache keys.
 */
function useEventArt(eventIds: readonly string[]): (eventId: string, tier: number) => TicketArtSource {
  const ids = [...new Set(eventIds)].sort();
  const results = useQueries({
    queries: ids.map((eventId) => ({
      queryKey: ['eventArt', eventId],
      queryFn: () => loadEventArt(eventId),
    })),
  });
  const byEvent = new Map(ids.map((eventId, index) => [eventId, results[index]?.data ?? []]));
  return (eventId, tier) => byEvent.get(eventId)?.[tier] ?? DEFAULT_ART;
}

/**
 * Everything {@link TicketArt} needs for one ticket, in one place because both ticket screens
 * need exactly the same four values and disagreeing about any of them would show as two
 * different pictures for one ticket.
 *
 * The two fallbacks are words rather than blanks: a title the gateway would not hand over and
 * a kind the index did not name are both things the person can still be shown a ticket for.
 */
export function useTicketArtProps(tickets: readonly MyTicket[]): (ticket: MyTicket) => TicketArtProps {
  const copy = useCopy().tickets;
  const artOf = useEventArt(tickets.map((ticket) => ticket.eventId));
  return (ticket) => ({
    art: artOf(ticket.eventId, ticket.tier),
    title: ticket.title === '' ? copy.artNoTitle : ticket.title,
    tierName: ticket.tierName === '' ? copy.artNoTier : ticket.tierName,
    used: ticket.used,
  });
}
