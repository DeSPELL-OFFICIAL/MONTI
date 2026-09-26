import { useQuery } from '@tanstack/react-query';
import { gql } from '../../shared/envio/client';
import {
  EVENT_STATES_QUERY,
  OWNED_TICKETS_QUERY,
  TICKET_CONTEXT_QUERY,
  type EnvioEventState,
  type EventStatesResult,
  type OwnedTicketsResult,
  type TicketContextResult,
} from '../../shared/envio/ticketQueries';
import { fetchEventMetadata } from '../../shared/envio/ipfs';
import type { EnvioTicket } from '../../shared/envio/queries';
import { useSession } from '../../shared/session';
import { deriveTicketState, type TicketState } from './ticketState';

export interface MyTicket {
  tokenId: string;
  eventId: string;
  tier: number;
  state: TicketState;
  checkInTs: number | null;
  /**
   * What the ticket art greys out, and deliberately not `state === 'entered'`. The index
   * defines it as the check-in itself (`used = checkIn != null`, indexer/schema.graphql's
   * `type Ticket`), while {@link deriveTicketState} lets 취소됨 outrank a check-in — so a
   * ticket revoked after somebody had already walked in on it reads 취소됨 and is still,
   * unchangeably, a ticket that was used.
   */
  used: boolean;
  /** The event's name from its metadata document, or '' when the gateway did not answer. */
  title: string;
  /** The ticket kind's name as the index holds it, or '' when no Tier row named it. */
  tierName: string;
}

/** Event.status when the organiser called the whole thing off. */
const EVENT_CANCELLED = 'Cancelled';
/** Offer.status once the recipient took the ticket: the token is theirs now. */
const OFFER_ACCEPTED = 'accepted';

const EMPTY_CONTEXT: TicketContextResult = { CheckIn: [], Event: [], Tier: [], Ticket: [] };
const EMPTY_EVENT_STATES: EventStatesResult = { Event: [], Tier: [] };

/** One tier of one event. `Tier.id` is the contract's own key and says nothing about which. */
function tierKey(eventId: string, idx: number): string {
  return `${eventId}:${idx}`;
}

/**
 * The readable half of an event lives in one pinned JSON document, so a title can only come
 * from the gateway. A gateway that does not answer costs a ticket its title and never its row:
 * the empty string travels on and the screen puts a word from copy in its place, the same way
 * the discover list and the invite inbox already do.
 */
async function loadTitles(events: EnvioEventState[]): Promise<Map<string, string>> {
  const entries = await Promise.all(
    events.map(async (event): Promise<readonly [string, string]> => {
      if (event.imageCid === '') return [event.id, ''];
      const metadata = await fetchEventMetadata(event.imageCid).catch(() => null);
      return [event.id, metadata?.title ?? ''];
    }),
  );
  return new Map(entries);
}

/**
 * Two round trips, because the second one is filtered by what the first one returned: ask the
 * index what this address holds and offered, then ask it only about those ids.
 */
export async function loadMyTickets(owner: string): Promise<MyTicket[]> {
  const owned = await gql<OwnedTicketsResult>(OWNED_TICKETS_QUERY, { owner });

  const tokenIds = owned.Ticket.map((row) => row.id);
  const held = new Set(tokenIds);
  const eventIds = [...new Set(owned.Ticket.map((row) => String(row.eventId)))];
  // An accepted offer on a token I no longer hold is the index's only record that I handed it over.
  const handedOverIds = owned.Offer.filter((offer) => offer.status === OFFER_ACCEPTED && !held.has(offer.id))
    .map((offer) => offer.id);

  const context =
    tokenIds.length + handedOverIds.length === 0
      ? EMPTY_CONTEXT
      : await gql<TicketContextResult>(TICKET_CONTEXT_QUERY, {
          tokenIds,
          eventIds,
          // The same ids again, because `Tier` is filtered on a BigInt column; see ticketQueries.ts.
          tierEventIds: eventIds,
          handedOverIds,
        });

  // A handed-over token arrives in the same trip that would have had to name its event, so the
  // event it belongs to can still be unknown here. Its status outranks 양도됨, so it is worth
  // asking — but only for the ids no held ticket already covered.
  const asked = new Set(eventIds);
  const missingEventIds = [...new Set(context.Ticket.map((row) => String(row.eventId)))].filter(
    (id) => !asked.has(id),
  );
  const late: EventStatesResult =
    missingEventIds.length === 0
      ? EMPTY_EVENT_STATES
      : await gql<EventStatesResult>(EVENT_STATES_QUERY, {
          eventIds: missingEventIds,
          tierEventIds: missingEventIds,
        });

  const offers = new Map(owned.Offer.map((offer) => [offer.id, offer]));
  const checkIns = new Map(context.CheckIn.map((entry) => [entry.id, entry]));
  const events = [...context.Event, ...late.Event];
  const cancelledEvents = new Set(
    events.filter((event) => event.status === EVENT_CANCELLED).map((event) => event.id),
  );
  const tierNames = new Map(
    [...context.Tier, ...late.Tier].map((tier) => [tierKey(String(tier.eventId), tier.idx), tier.name]),
  );
  // One gateway read per event, not per ticket: four tickets to the same event share a title,
  // and `fetchEventMetadata` memoises the document for the session on top of that.
  const titles = await loadTitles(events);
  const now = Math.floor(Date.now() / 1000);

  // Rows I hold win over the handover copies, in case an accepted offer came back to me.
  const rows = new Map<string, EnvioTicket>();
  for (const row of [...context.Ticket, ...owned.Ticket]) rows.set(row.id, row);

  return [...rows.values()]
    .map((ticket) => {
      const eventId = String(ticket.eventId);
      const checkIn = checkIns.get(ticket.id) ?? null;
      const offer = offers.get(ticket.id) ?? null;
      return {
        tokenId: ticket.id,
        eventId,
        tier: ticket.tier,
        checkInTs: checkIn ? Number(checkIn.ts) : null,
        used: checkIn !== null,
        title: titles.get(eventId) ?? '',
        tierName: tierNames.get(tierKey(eventId, ticket.tier)) ?? '',
        state: deriveTicketState({
          ownerIsMe: ticket.owner.toLowerCase() === owner,
          revoked: ticket.revoked,
          eventCancelled: cancelledEvents.has(eventId),
          checkIn: checkIn ? { ts: Number(checkIn.ts) } : null,
          offer: offer ? { expiresAt: Number(offer.expiresAt), status: offer.status } : null,
          now,
        }),
      };
    })
    .sort((a, b) => Number(b.tokenId) - Number(a.tokenId));
}

/** Every ticket this address has anything to do with, newest token first. */
export function useMyTickets() {
  const session = useSession();
  const owner = (session.account ?? '').toLowerCase();
  return useQuery({
    queryKey: ['tickets', owner],
    enabled: Boolean(owner),
    queryFn: () => loadMyTickets(owner),
  });
}
