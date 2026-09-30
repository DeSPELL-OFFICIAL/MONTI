import { useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { gql } from '../shared/envio/client';
import { readTicket } from '../shared/chain/reads';
import type { EnvioEventStatus } from '../shared/envio/queries';

/**
 * The organiser's two indexer-gated screens — the dashboard and the just-created done screen —
 * decide whether to offer 발행/취소 from an event's status. That status lives on the chain the
 * moment `createEvent`/`publishEvent` confirms, but the hosted indexer can lag it by minutes, so
 * a screen that reads only the indexer shows no actions for an event that plainly exists.
 *
 * This hook reads the status from the indexer first and falls back to the chain when the indexer
 * has no row yet, re-asking the indexer every {@link POLL_MS} until it catches up — at which point
 * its (richer) row takes over. The chain is authoritative and only ever ahead of the indexer, so
 * the precedence rule is: trust the indexer once it has a row that is *not older* than the chain.
 */

/** A light document beside the full EVENT_QUERY: just the one column this hook needs to poll. */
const EVENT_STATUS_QUERY = `
  query EventStatus($id: String!) {
    Event(where: { id: { _eq: $id } }) { id status }
  }`;

/** How often the indexer is re-asked while it still has no row (task: a short 3s poll). */
const POLL_MS = 3_000;

/** `Ticket.EventStatus` ordinals, spelled the way the indexer spells them, so a chain read reads
 *  like a row. Kept in step with `EventStatus` in shared/chain/reads.ts. */
const CHAIN_STATUS_NAME: Record<number, EnvioEventStatus> = {
  0: 'Draft', 1: 'Published', 2: 'Cancelled', 3: 'Ended',
};
const STATUS_ORDER: Record<string, number> = { Draft: 0, Published: 1, Cancelled: 2, Ended: 3 };

export type EventStatusSource = 'indexer' | 'direct' | 'none';

export interface EventStatusFallback {
  /** The status to gate 발행/취소 on, or '' while nothing has answered or there is no such event. */
  status: EnvioEventStatus | '';
  source: EventStatusSource;
  /** True until at least one of the two reads has an answer. */
  loading: boolean;
  /** Re-reads both the indexer and the chain — called after a write moves the event on. */
  refetch: () => void;
}

/**
 * Which of the two answers to trust. The indexer wins only when it has a row *and* that row is not
 * older than the chain's status; otherwise the chain (which the indexer only ever lags) wins. An
 * absent or unrecognised value on either side counts as "no answer" from that side.
 */
export function preferStatus(
  indexer: string | null | undefined,
  chain: string | null | undefined,
): { status: EnvioEventStatus | ''; source: EventStatusSource } {
  const iOrd = indexer != null ? STATUS_ORDER[indexer] ?? -1 : -1;
  const cOrd = chain != null ? STATUS_ORDER[chain] ?? -1 : -1;
  if (iOrd >= 0 && (cOrd < 0 || iOrd >= cOrd)) return { status: indexer as EnvioEventStatus, source: 'indexer' };
  if (cOrd >= 0) return { status: chain as EnvioEventStatus, source: 'direct' };
  return { status: '', source: 'none' };
}

export function useEventStatusWithFallback(eventId: string): EventStatusFallback {
  const indexer = useQuery({
    queryKey: ['eventStatus', 'indexer', eventId],
    queryFn: async (): Promise<string | null> => {
      const { Event } = await gql<{ Event: Array<{ status: string }> }>(EVENT_STATUS_QUERY, { id: eventId });
      return Event[0]?.status ?? null;
    },
    enabled: eventId !== '',
    // Keep asking until the indexer has the row, then stop — its data takes over from the chain.
    refetchInterval: (query) => (query.state.data == null ? POLL_MS : false),
  });

  const chain = useQuery({
    queryKey: ['eventStatus', 'direct', eventId],
    queryFn: async (): Promise<EnvioEventStatus | ''> => {
      const ticket = readTicket();
      // `eventStatus` returns Draft (0) for an id that was never created (Ticket.sol), so it cannot
      // tell a real Draft from a mistyped number on its own — `eventOrg` is 0 only for the latter.
      const orgId = await ticket.eventOrg(BigInt(eventId));
      if (orgId === 0n) return '';
      const value = Number(await ticket.eventStatus(BigInt(eventId)));
      return CHAIN_STATUS_NAME[value] ?? '';
    },
    enabled: eventId !== '',
  });

  const { status, source } = preferStatus(indexer.data, chain.data ?? null);
  const refetch = useCallback((): void => {
    void indexer.refetch();
    void chain.refetch();
  }, [indexer, chain]);

  return {
    status,
    source,
    loading: indexer.isLoading || chain.isLoading,
    refetch,
  };
}
