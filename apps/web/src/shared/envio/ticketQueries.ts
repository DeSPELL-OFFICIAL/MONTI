import type { EnvioCheckIn, EnvioOffer, EnvioTicket } from './queries';

/**
 * The documents the 내 티켓 tab sends. They live beside ./queries.ts rather than inside it
 * because the ticket list reads its rows in two round trips, and the second one is filtered by
 * the ids the first one returned — a shape no discovery query has.
 *
 * Scalars follow the same rule as ./queries.ts: a variable filtering a `BigInt!` column is
 * Hasura's `numeric`, a variable filtering the `ID!` primary key is `String`. Every id below
 * filters a primary key (`Ticket.id`, `CheckIn.id`, `Event.id` are all `ID!`), so all three
 * lists are `[String!]!` — none of them is the `eventId`/`tokenId` BigInt column.
 */

/** Only the two columns the list needs from an event: its id, and what turns a ticket 취소됨. */
export interface EnvioEventState {
  id: string;
  status: string;
}

export interface OwnedTicketsResult {
  Ticket: EnvioTicket[];
  Offer: EnvioOffer[];
}

export interface TicketContextResult {
  CheckIn: EnvioCheckIn[];
  Event: EnvioEventState[];
  Ticket: EnvioTicket[];
}

export interface EventStatesResult {
  Event: EnvioEventState[];
}

/** The two columns both event documents below read. */
const EVENT_STATE_FIELDS = 'id status';

/** Everything that hangs off the address itself: the tickets it holds and the offers it made. */
export const OWNED_TICKETS_QUERY = `
  query OwnedTickets($owner: String!) {
    Ticket(where: { owner: { _eq: $owner } }) { id eventId tier owner transfers revoked }
    Offer(where: { from: { _eq: $owner } }) { id from commitment expiresAt status }
  }`;

/**
 * The second round trip, asked only about ids the first one returned: the check-ins of my own
 * tokens (an unfiltered `CheckIn` would pull every check-in in the index), the events those
 * tokens belong to, and the tokens an accepted offer moved to someone else — the only trace the
 * index keeps of a ticket I handed over, since `Ticket.owner` is no longer mine.
 */
export const TICKET_CONTEXT_QUERY = `
  query TicketContext($tokenIds: [String!]!, $eventIds: [String!]!, $handedOverIds: [String!]!) {
    CheckIn(where: { id: { _in: $tokenIds } }) { id gateId ts manual txHash block }
    Event(where: { id: { _in: $eventIds } }) { ${EVENT_STATE_FIELDS} }
    Ticket(where: { id: { _in: $handedOverIds } }) { id eventId tier owner transfers revoked }
  }`;

/**
 * The third round trip, sent only when a handed-over token turns out to belong to an event none
 * of the held tickets named — its `eventId` only arrives with the token itself, and its status is
 * what decides between 취소됨 and 양도됨.
 */
export const EVENT_STATES_QUERY = `
  query EventStates($eventIds: [String!]!) {
    Event(where: { id: { _in: $eventIds } }) { ${EVENT_STATE_FIELDS} }
  }`;
