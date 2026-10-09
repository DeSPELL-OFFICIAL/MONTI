import type { TierStruct } from './reads';
import type { EnvioTier } from '../envio/queries';

/**
 * One on-chain `Ticket.tiers` row, shaped into the indexer's `EnvioTier` so a screen reading from
 * the chain reads exactly the row it would from Envio. The chain tier carries no id of its own, so
 * its id and `idx` are the indexer's own `${eventId}-${idx}` convention, and every numeric field
 * becomes the decimal string the indexer serves (`priceUsdCents`/`supply`/`minted` are `bigint`/
 * `number` on chain, `string` in the row).
 *
 * This mapping lives here once: both the attendee claim screen (`useClaimEventData`) and the
 * organiser dashboard (`useEventTiersWithFallback`) fall back to the chain when the indexer lags,
 * and a second copy would be a place for the two to silently drift.
 */
export function tierStructToEnvioTier(tier: TierStruct, idx: number, eventId: string): EnvioTier {
  return {
    id: `${eventId}-${idx}`,
    eventId,
    idx,
    name: tier.name,
    priceUsdCents: String(tier.priceUsdCents),
    supply: String(tier.supply),
    minted: String(tier.minted),
    maxPerWallet: String(tier.maxPerWallet),
    seated: tier.seated,
  };
}
