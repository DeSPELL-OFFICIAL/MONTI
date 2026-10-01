import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { gql } from '../../shared/envio/client';
import { EVENT_QUERY, type EnvioEvent } from '../../shared/envio/queries';
import { getSettlement, type SettlementView } from '../../shared/api/firestore';
import { fetchEventMetadata } from '../../shared/envio/ipfs';

/** How often the live section re-asks the indexer — the demo's "입장 순간 분배" has to feel live. */
export const LIVE_POLL_MS = 5_000;

export interface EscrowRow {
  id: string;
  status: string;
  amount: string;
}
export interface PayoutRow {
  id: string;
  tokenId: string;
  recipient: string;
  amount: string;
  reasonHash: string;
  at: string;
  txHash: string;
}
export interface EventSettlementRow {
  totalDeposited: string;
  totalReleased: string;
  totalRefunded: string;
  payoutCount: number;
}
export interface SettlementLive {
  EventSettlement: EventSettlementRow[];
  Escrow: EscrowRow[];
  Payout: PayoutRow[];
}

/**
 * One poll of the live settlement state: the running totals, every escrow (so the four tiles can be
 * counted and summed by status on the client), and the most recent payouts. It follows the app's
 * indexer-query shape — the document and its row types next to the {@link gql} call — and uses the
 * same `$id`/`$eventId` split the event query uses (the text primary key vs. the numeric column).
 */
export const SETTLEMENT_LIVE_QUERY = `
  query SettlementLive($id: String!, $eventId: numeric!) {
    EventSettlement(where: { id: { _eq: $id } }) {
      totalDeposited totalReleased totalRefunded payoutCount
    }
    Escrow(where: { eventId: { _eq: $eventId } }) {
      id status amount
    }
    Payout(where: { eventId: { _eq: $eventId } }, order_by: { at: desc }, limit: 12) {
      id tokenId recipient amount reasonHash at txHash
    }
  }`;

export function useSettlementLive(eventId: string): UseQueryResult<SettlementLive> {
  return useQuery({
    queryKey: ['settlementLive', eventId],
    queryFn: () => gql<SettlementLive>(SETTLEMENT_LIVE_QUERY, { id: eventId, eventId }),
    enabled: eventId !== '',
    refetchInterval: LIVE_POLL_MS,
  });
}

export interface SettlementEvent {
  event: EnvioEvent;
  title: string;
}

/**
 * The header's title and date. The event row carries the time directly and only a CID for the
 * title, so the readable name comes from the pinned metadata — a title the gateway cannot serve is
 * not an error here, it just leaves the title blank (the date and the rules still stand).
 */
export function useSettlementEvent(eventId: string): UseQueryResult<SettlementEvent | null> {
  return useQuery({
    queryKey: ['settlementEvent', eventId],
    queryFn: async (): Promise<SettlementEvent | null> => {
      const { Event } = await gql<{ Event: EnvioEvent[] }>(EVENT_QUERY, { id: eventId, eventId });
      const event = Event[0];
      if (!event) return null;
      let title = '';
      try {
        title = (await fetchEventMetadata(event.imageCid)).title;
      } catch {
        /* a title the gateway could not serve is simply not shown */
      }
      return { event, title };
    },
    enabled: eventId !== '',
  });
}

/** The server-written policy (readable recipients, platform share, per-tier price). */
export function useSettlementDoc(eventId: string): UseQueryResult<SettlementView | null> {
  return useQuery({
    queryKey: ['settlementDoc', eventId],
    queryFn: () => getSettlement(eventId),
    enabled: eventId !== '',
  });
}
