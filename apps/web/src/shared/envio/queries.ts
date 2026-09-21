/**
 * The documents this app sends to the indexer, and the row shapes that come back.
 *
 * Envio serves Hasura over the indexer's Postgres, so the scalar names here are Hasura's, not
 * the ones in indexer/schema.graphql: every `BigInt!` column is the `numeric` scalar, and only
 * the `ID!` primary key is text. That is why a variable filtering `eventId` (or `tokenId`) is
 * declared `numeric!` while a variable filtering `id` is declared `String!` — and why every
 * `numeric` column is typed `string` below and compared as a string, never as a number.
 *
 * Only columns that exist in indexer/schema.graphql are selected. The 내 티켓 tab's own two
 * round trips live in ./ticketQueries.ts and reuse the row types below.
 */

/** Ticket.EventStatusChanged, carried as the enum's name. */
export type EnvioEventStatus = 'Draft' | 'Published' | 'Cancelled' | 'Ended';

export interface EnvioEvent {
  id: string;
  orgId: string;
  imageCid: string;
  startsAt: string;
  endsAt: string;
  saleStart: string;
  saleEnd: string;
  transferable: boolean;
  transferCutoffSeconds: string;
  maxTransfers: number;
  category: number;
  /** `keccak256(<ISO 3166-2 region>)`, so a region picker hashes its choice to compare. */
  regionCode: string;
  status: string;
  requireKyc: boolean;
}

export interface EnvioTier {
  id: string;
  eventId: string;
  idx: number;
  name: string;
  priceUsdCents: string;
  supply: string;
  minted: string;
  maxPerWallet: string;
  seated: boolean;
}

export interface EnvioTicket {
  id: string;
  eventId: string;
  tier: number;
  owner: string;
  transfers: number;
  revoked: boolean;
}

export interface EnvioCheckIn {
  id: string;
  gateId: string;
  ts: string;
  manual: boolean;
  txHash: string;
  block: string;
}

export interface EnvioOffer {
  id: string;
  from: string;
  commitment: string;
  expiresAt: string;
  status: string;
}

/** Every column the discovery list and the detail screen read, in one place. */
const EVENT_FIELDS = `
      id orgId imageCid startsAt endsAt saleStart saleEnd transferable
      transferCutoffSeconds maxTransfers category regionCode status requireKyc`;

export const EVENTS_QUERY = `
  query Events($limit: Int!) {
    Event(where: { status: { _eq: "Published" } }, order_by: { startsAt: asc }, limit: $limit) {${EVENT_FIELDS}
    }
  }`;

export const EVENT_QUERY = `
  query OneEvent($id: String!, $eventId: numeric!) {
    Event(where: { id: { _eq: $id } }) {${EVENT_FIELDS}
    }
    Tier(where: { eventId: { _eq: $eventId } }, order_by: { idx: asc }) {
      id eventId idx name priceUsdCents supply minted maxPerWallet seated
    }
  }`;
