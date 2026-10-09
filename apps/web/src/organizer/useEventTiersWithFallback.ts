import { useQuery } from '@tanstack/react-query';
import { readTicket } from '../shared/chain/reads';
import { tierStructToEnvioTier } from '../shared/chain/tiers';
import type { EnvioTier } from '../shared/envio/queries';

/**
 * The organiser dashboard's 정산 설정 keys its per-tier price inputs to an event's tiers, and the
 * policy cannot be confirmed until every tier has a price (`SettlementSection`'s `pricesReady`
 * needs `tiers.length > 0`). Those tiers exist on the chain the moment `createEvent` confirms, but
 * the hosted indexer can lag it by minutes, so a fresh event has no `Tier` rows there and the price
 * fields never appear — exactly the gap `useEventStatusWithFallback` closes for the event's status.
 *
 * This hook takes the indexer's `Tier` rows the dashboard already fetched and, only once that query
 * has settled with *no* rows, reads the tiers straight from the chain (`Ticket.tiers`) and shapes
 * them into the same `EnvioTier` rows via the shared {@link tierStructToEnvioTier}. The indexer is
 * the preferred source whenever it has rows — the chain read is a fallback the indexer overtakes
 * the moment it catches up. `undefined` rows mean the indexer is still loading, so the chain is not
 * raced; a real event always has at least one tier, so a chain answer of none means no such event.
 */

export type EventTiersSource = 'indexer' | 'direct' | 'none';

export interface EventTiersFallback {
  /** The tiers to render, from the indexer when it has rows and from the chain while it lags. */
  tiers: EnvioTier[];
  source: EventTiersSource;
}

export function useEventTiersWithFallback(
  eventId: string,
  indexerTiers: EnvioTier[] | undefined,
): EventTiersFallback {
  // Only a settled, empty indexer answer is worth a chain read: `undefined` is still-loading (wait
  // for it rather than race it), and rows mean the indexer has already caught up.
  const indexerEmpty = indexerTiers !== undefined && indexerTiers.length === 0;

  const chain = useQuery({
    queryKey: ['eventTiers', 'direct', eventId],
    queryFn: async (): Promise<EnvioTier[]> => {
      const chainTiers = await readTicket().tiers(BigInt(eventId));
      return chainTiers.map((tier, idx) => tierStructToEnvioTier(tier, idx, eventId));
    },
    enabled: eventId !== '' && indexerEmpty,
  });

  if (indexerTiers !== undefined && indexerTiers.length > 0) {
    return { tiers: indexerTiers, source: 'indexer' };
  }
  // A non-empty chain answer is a real event the indexer has not reached yet; empty (or a failed
  // read, whose data stays undefined) means there is nothing to show.
  if (chain.data != null && chain.data.length > 0) {
    return { tiers: chain.data, source: 'direct' };
  }
  return { tiers: [], source: 'none' };
}
