import type { EnvioCheckIn, EnvioOffer, EnvioTicket, EnvioTier } from './queries';

/**
 * The documents the 내 티켓 tab sends. They live beside ./queries.ts rather than inside it
 * because the ticket list reads its rows in two round trips, and the second one is filtered by
 * the ids the first one returned — a shape no discovery query has.
 *
 * Scalars follow the same rule as ./queries.ts: a variable filtering a `BigInt!` column is
 * Hasura's `numeric`, a variable filtering the `ID!` primary key is `String`. `Ticket.id`,
 * `CheckIn.id` and `Event.id` are all `ID!`, so those lists are `[String!]!` — but `Tier` has
 * no event-scoped primary key and is filtered on its `eventId` column, which is `BigInt!`.
 * That is why the same set of event ids travels twice below under two different declarations:
 * a list of decimal strings is valid for both scalars, and picking the wrong one for either
 * selection comes back as a Hasura error rather than as an empty list.
 */

/**
 * What the list needs from an event: its id, what turns a ticket 취소됨, the CID of the
 * metadata document — the only place the event's readable title exists at all — and when it
 * starts, which is the date printed on the ticket.
 *
 * `startsAt` is the chain's own `uint64` in Unix seconds, carried as a decimal string the way
 * every `BigInt!` column is (see the note at the top of this file). An event whose row the
 * index has not reached yet answers `'0'`, and a ticket with no start draws no date at all.
 */
export interface EnvioEventState {
  id: string;
  status: string;
  imageCid: string;
  startsAt: string;
}

/** A ticket kind's name, and the two columns that say which ticket wears it. */
export type EnvioTierName = Pick<EnvioTier, 'id' | 'eventId' | 'idx' | 'name'>;

export interface OwnedTicketsResult {
  Ticket: EnvioTicket[];
  Offer: EnvioOffer[];
}

export interface TicketContextResult {
  CheckIn: EnvioCheckIn[];
  Event: EnvioEventState[];
  Tier: EnvioTierName[];
  Ticket: EnvioTicket[];
}

export interface EventStatesResult {
  Event: EnvioEventState[];
  Tier: EnvioTierName[];
}

/** The four columns both event documents below read. */
const EVENT_STATE_FIELDS = 'id status imageCid startsAt';
/** Enough of a tier to put its name on the right ticket, and nothing the screen will not draw. */
const TIER_NAME_FIELDS = 'id eventId idx name';

/** Everything that hangs off the address itself: the tickets it holds and the offers it made. */
export const OWNED_TICKETS_QUERY = `
  query OwnedTickets($owner: String!) {
    Ticket(where: { owner: { _eq: $owner } }) { id eventId tier owner transfers revoked }
    Offer(where: { from: { _eq: $owner } }) { id from commitment expiresAt status }
  }`;

/**
 * The second round trip, asked only about ids the first one returned: the check-ins of my own
 * tokens (an unfiltered `CheckIn` would pull every check-in in the index), the events those
 * tokens belong to, the ticket kinds those events sell — what the ticket art calls itself — and
 * the tokens an accepted offer moved to someone else, the only trace the index keeps of a
 * ticket I handed over, since `Ticket.owner` is no longer mine.
 */
export const TICKET_CONTEXT_QUERY = `
  query TicketContext($tokenIds: [String!]!, $eventIds: [String!]!, $tierEventIds: [numeric!]!, $handedOverIds: [String!]!) {
    CheckIn(where: { id: { _in: $tokenIds } }) { id gateId ts manual txHash block }
    Event(where: { id: { _in: $eventIds } }) { ${EVENT_STATE_FIELDS} }
    Tier(where: { eventId: { _in: $tierEventIds } }) { ${TIER_NAME_FIELDS} }
    Ticket(where: { id: { _in: $handedOverIds } }) { id eventId tier owner transfers revoked }
  }`;

/**
 * The third round trip, sent only when a handed-over token turns out to belong to an event none
 * of the held tickets named — its `eventId` only arrives with the token itself, and its status is
 * what decides between 취소됨 and 양도됨. It asks for that event's tiers too, so a handed-over
 * ticket's picture is captioned the same way every other ticket's is.
 */
export const EVENT_STATES_QUERY = `
  query EventStates($eventIds: [String!]!, $tierEventIds: [numeric!]!) {
    Event(where: { id: { _in: $eventIds } }) { ${EVENT_STATE_FIELDS} }
    Tier(where: { eventId: { _in: $tierEventIds } }) { ${TIER_NAME_FIELDS} }
  }`;
