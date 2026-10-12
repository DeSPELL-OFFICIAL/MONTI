import { useQueries } from '@tanstack/react-query';
import { fetchEventMetadata } from './ipfs';

/** The three answers an event's name can be in mid-render, so the caller can tell them apart. */
export interface TitleState {
  status: 'loading' | 'loaded' | 'failed';
  title: string;
}

/** What a title read needs from a row: the event it names and the CID of its pinned document. */
export interface TitledEvent {
  eventId: string;
  imageCid: string;
}

/**
 * One IPFS read per event for its name, keyed by the event so every screen that names it — the
 * ticket list and detail, the organiser's event list and event screen — shares the answer and
 * never disagrees: opening an event from a list that already named it reads nothing again.
 * Decoupled from the rows on purpose: the rows come off the indexer and must not wait on a
 * gateway, so the name streams in behind them — a placeholder while it is in flight, the name
 * when it lands, and the fallback only once the read has failed.
 */
export function useEventTitles(events: readonly TitledEvent[]): (eventId: string) => TitleState {
  const cidOf = new Map(events.map((event) => [event.eventId, event.imageCid]));
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
