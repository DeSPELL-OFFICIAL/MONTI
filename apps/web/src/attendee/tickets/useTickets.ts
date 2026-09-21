import { useQuery } from '@tanstack/react-query';
import { gql } from '../../shared/envio/client';
import {
  OWNED_TICKETS_QUERY,
  TICKET_CONTEXT_QUERY,
  type OwnedTicketsResult,
  type TicketContextResult,
} from '../../shared/envio/ticketQueries';
import type { EnvioTicket } from '../../shared/envio/queries';
import { useSession } from '../../shared/session';
import { deriveTicketState, type TicketState } from './ticketState';

export interface MyTicket {
  tokenId: string;
  eventId: string;
  tier: number;
  state: TicketState;
  checkInTs: number | null;
}

/** Event.status when the organiser called the whole thing off. */
const EVENT_CANCELLED = 'Cancelled';
/** Offer.status once the recipient took the ticket: the token is theirs now. */
const OFFER_ACCEPTED = 'accepted';

const EMPTY_CONTEXT: TicketContextResult = { CheckIn: [], Event: [], Ticket: [] };

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
      : await gql<TicketContextResult>(TICKET_CONTEXT_QUERY, { tokenIds, eventIds, handedOverIds });

  const offers = new Map(owned.Offer.map((offer) => [offer.id, offer]));
  const checkIns = new Map(context.CheckIn.map((entry) => [entry.id, entry]));
  const cancelledEvents = new Set(
    context.Event.filter((event) => event.status === EVENT_CANCELLED).map((event) => event.id),
  );
  const now = Math.floor(Date.now() / 1000);

  // Rows I hold win over the handover copies, in case an accepted offer came back to me.
  const rows = new Map<string, EnvioTicket>();
  for (const row of [...context.Ticket, ...owned.Ticket]) rows.set(row.id, row);

  return [...rows.values()]
    .map((ticket) => {
      const checkIn = checkIns.get(ticket.id) ?? null;
      const offer = offers.get(ticket.id) ?? null;
      return {
        tokenId: ticket.id,
        eventId: String(ticket.eventId),
        tier: ticket.tier,
        checkInTs: checkIn ? Number(checkIn.ts) : null,
        state: deriveTicketState({
          ownerIsMe: ticket.owner.toLowerCase() === owner,
          revoked: ticket.revoked,
          eventCancelled: cancelledEvents.has(String(ticket.eventId)),
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
