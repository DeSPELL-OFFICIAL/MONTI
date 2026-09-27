import { useQueries } from '@tanstack/react-query';
import { loadEventArt } from '../../shared/api/firestore';
import { fetchEventMetadata } from '../../shared/envio/ipfs';
import { useDisplayName } from '../../shared/displayName';
import { useCopy, useLocale } from '../../shared/i18n';
import { formatTicketDate } from '../../shared/ui';
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
      // A read that failed is "no picture" **here** and nowhere else: this screen only draws
      // them. The screens that write the list back must tell a failed read from an absent
      // document, which is why `loadEventArt` throws rather than swallowing its own.
      queryFn: () => loadEventArt(eventId).catch(() => [] as TicketArtSource[]),
    })),
  });
  const byEvent = new Map(ids.map((eventId, index) => [eventId, results[index]?.data ?? []]));
  return (eventId, tier) => byEvent.get(eventId)?.[tier] ?? DEFAULT_ART;
}

/** The three answers an event's name can be in mid-render, so the caller can tell them apart. */
interface TitleState {
  status: 'loading' | 'loaded' | 'failed';
  title: string;
}

/**
 * One IPFS read per event for its name, keyed by the event so the list and the detail screen
 * share the answer and never disagree. Decoupled from the rows on purpose: the rows come off the
 * indexer and must not wait on a gateway, so the name streams in behind them — a shimmer while it
 * is in flight, the name when it lands, and the fallback word only once the read has failed.
 */
function useEventTitles(tickets: readonly MyTicket[]): (eventId: string) => TitleState {
  const cidOf = new Map(tickets.map((ticket) => [ticket.eventId, ticket.imageCid]));
  const ids = [...cidOf.keys()].sort();
  const results = useQueries({
    queries: ids.map((eventId) => {
      const cid = cidOf.get(eventId) ?? '';
      return {
        queryKey: ['eventTitle', eventId],
        queryFn: () => fetchEventMetadata(cid).then((metadata) => metadata.title),
        // A 404 or a timed-out gateway will not succeed on a second try, so the fallback shows at
        // once rather than shimmering through three retries first.
        retry: false,
        // An event with no pinned document has no CID to even ask about: the query never runs, and
        // the state is decided below rather than left pending forever.
        enabled: cid !== '',
      };
    }),
  });
  const byEvent = new Map(ids.map((eventId, index) => [eventId, results[index]]));
  return (eventId) => {
    if ((cidOf.get(eventId) ?? '') === '') return { status: 'failed', title: '' };
    const query = byEvent.get(eventId);
    if (!query || query.isError) return { status: 'failed', title: '' };
    if (query.isSuccess) return { status: 'loaded', title: query.data ?? '' };
    return { status: 'loading', title: '' };
  };
}

/**
 * Everything {@link TicketArt} needs for one ticket, in one place because both ticket screens
 * need exactly the same six values and disagreeing about any of them would show as two
 * different pictures for one ticket.
 *
 * **The name is read here and nowhere else.** `users/{uid}.displayName` is one document for the
 * whole session, so reading it in the list and again in the detail screen would be two reads
 * that can answer differently while one of them is still in flight — a ticket that says 게스트
 * in the list and a name when you open it. One hook, one answer, both screens.
 *
 * It is the profile field and deliberately not the chain nickname: that one is
 * `^[a-z0-9_]{3,20}$`, cannot hold a Korean name, and costs a sponsored write to set. Nor is it
 * `getSignupStatus` — the typed callable does not return a display name, and this reads the
 * same Firestore field with no round trip to ask for one (plan section E-3).
 *
 * The three fallbacks are words rather than blanks: a title the gateway would not hand over, a
 * kind the index did not name and a person who left their name empty are all things somebody
 * can still be shown a ticket for. A missing *date* is the exception and draws nothing at all,
 * because a placeholder date would look like a date.
 */
export function useTicketArtProps(tickets: readonly MyTicket[]): (ticket: MyTicket) => TicketArtProps {
  const copy = useCopy().tickets;
  const locale = useLocale();
  const displayName = useDisplayName();
  const artOf = useEventArt(tickets.map((ticket) => ticket.eventId));
  const titleOf = useEventTitles(tickets);
  const holder = displayName === '' ? copy.artGuest : displayName;
  return (ticket) => {
    const title = titleOf(ticket.eventId);
    return {
      art: artOf(ticket.eventId, ticket.tier),
      // A name still in flight draws a shimmer, not a word: the fallback (copy.artNoTitle) is what a
      // *failed* read gets, and a load in progress is not a failure. A loaded-but-empty name falls
      // back too — a document that named nothing is nothing to show.
      title: title.title === '' ? copy.artNoTitle : title.title,
      titleLoading: title.status === 'loading',
      tierName: ticket.tierName === '' ? copy.artNoTier : ticket.tierName,
      holder,
      dateText: formatTicketDate(ticket.startsAt, locale),
      used: ticket.used,
    };
  };
}
