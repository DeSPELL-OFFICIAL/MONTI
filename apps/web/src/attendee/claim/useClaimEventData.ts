import { useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Hex } from 'viem';
import { gql } from '../../shared/envio/client';
import { readTicket } from '../../shared/chain/reads';
import { useSession } from '../../shared/session';
import { EVENT_QUERY, type EnvioEvent, type EnvioTier } from '../../shared/envio/queries';

/**
 * The claim screen reads one event and its ticket kinds from the indexer. The event exists on the
 * chain the moment `createEvent`/`publishEvent` confirms, but the hosted indexer can lag by minutes,
 * and a claim screen that finds no row shows the error state — so a published event cannot be
 * claimed while the indexer is behind. This hook answers from the chain when the indexer has no row.
 *
 * The chain data is shaped into the same `EnvioEvent`/`EnvioTier` rows the rest of the screen reads,
 * so nothing downstream has to know where the answer came from. Only a *clean empty* indexer answer
 * triggers the fallback: an indexer error keeps its own retry screen, which names how it failed.
 */

/** `Ticket.EventStatus` ordinals, spelled the way the indexer spells them. */
const STATUS_NAME: Record<number, EnvioEvent['status']> = {
  0: 'Draft', 1: 'Published', 2: 'Cancelled', 3: 'Ended',
};

/** How often the indexer is re-asked while it still has no row, so its (richer) row takes over the
 *  chain fallback the moment it catches up (task: a short 3s poll, matching the organiser hook). */
const POLL_MS = 3_000;

/**
 * Builds the indexer-shaped Event + Tier[] from the chain. Returns null when there is no such event
 * — `eventMeta.orgId` is 0 only for an id that was never created (Ticket.sol) — so a mistyped number
 * still lands on the not-found screen rather than a blank claim.
 */
async function readEventFromChain(eventId: string): Promise<{ event: EnvioEvent; tiers: EnvioTier[] } | null> {
  const ticket = readTicket();
  const [meta, status, chainTiers] = await Promise.all([
    ticket.eventMeta(BigInt(eventId)),
    ticket.eventStatus(BigInt(eventId)),
    ticket.tiers(BigInt(eventId)),
  ]);
  if (meta.orgId === 0n) return null;
  const event: EnvioEvent = {
    id: eventId,
    orgId: String(meta.orgId),
    imageCid: meta.imageCid,
    startsAt: String(meta.startsAt),
    endsAt: String(meta.endsAt),
    saleStart: String(meta.saleStart),
    saleEnd: String(meta.saleEnd),
    transferable: meta.transferable,
    transferCutoffSeconds: String(meta.transferCutoffSeconds),
    maxTransfers: meta.maxTransfers,
    category: meta.category,
    regionCode: meta.regionCode,
    status: STATUS_NAME[Number(status)] ?? 'Draft',
    requireKyc: meta.requireKyc,
    approvalRequired: meta.approvalRequired,
  };
  const tiers: EnvioTier[] = chainTiers.map((tier, idx) => ({
    id: `${eventId}-${idx}`,
    eventId,
    idx,
    name: tier.name,
    priceUsdCents: String(tier.priceUsdCents),
    supply: String(tier.supply),
    minted: String(tier.minted),
    maxPerWallet: String(tier.maxPerWallet),
    seated: tier.seated,
  }));
  return { event, tiers };
}

export type ClaimEventSource = 'indexer' | 'direct' | 'none';

export interface ClaimEventData {
  event: EnvioEvent | undefined;
  tiers: EnvioTier[];
  source: ClaimEventSource;
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  refetch: () => void;
  /**
   * The held-ticket count for the pre-block, read from the chain (`balanceOfEvent`, counted per
   * event exactly as maxPerWallet is) when the event itself came from the chain — because the
   * indexer's own ticket list is just as unavailable then. Null when the indexer path is in use, or
   * when nobody is signed in.
   */
  chainHeld: number | null;
  chainHeldLoading: boolean;
}

export function useClaimEventData(eventId: string): ClaimEventData {
  const account = useSession().account;

  const indexer = useQuery({
    queryKey: ['claim', eventId],
    // `id` is the text primary key, `eventId` the numeric column the tiers hang off.
    queryFn: () => gql<{ Event: EnvioEvent[]; Tier: EnvioTier[] }>(EVENT_QUERY, { id: eventId, eventId }),
    enabled: eventId !== '',
    // While the indexer still has no row for this event, keep asking every POLL_MS so the chain
    // fallback is handed back the moment the indexer catches up; stop the poll once it has the row.
    refetchInterval: (query) => (query.state.data?.Event[0] === undefined ? POLL_MS : false),
  });

  const indexerEvent = indexer.data?.Event[0];
  // Only a clean "no row" answer falls back — an indexer error keeps its own retry screen.
  const indexerEmpty = indexer.isSuccess && indexerEvent === undefined;

  const chain = useQuery({
    queryKey: ['claimChain', eventId],
    queryFn: () => readEventFromChain(eventId),
    enabled: eventId !== '' && indexerEmpty,
  });

  const source: ClaimEventSource =
    indexerEvent !== undefined ? 'indexer' : chain.data != null ? 'direct' : 'none';

  const chainHeld = useQuery({
    queryKey: ['claimHeld', eventId, account],
    queryFn: () => readTicket().balanceOfEvent(account as Hex, BigInt(eventId)).then(Number),
    enabled: eventId !== '' && source === 'direct' && account !== undefined,
  });

  const event = indexerEvent ?? chain.data?.event;
  const tiers = indexerEvent !== undefined ? indexer.data?.Tier ?? [] : chain.data?.tiers ?? [];

  const refetch = useCallback((): void => {
    void indexer.refetch();
    void chain.refetch();
    void chainHeld.refetch();
  }, [indexer, chain, chainHeld]);

  return {
    event,
    tiers,
    source,
    isLoading: indexer.isLoading || (indexerEmpty && chain.isLoading),
    isError: indexer.isError || (indexerEmpty && chain.isError),
    error: indexer.error ?? chain.error,
    refetch,
    chainHeld: source === 'direct' ? chainHeld.data ?? null : null,
    chainHeldLoading: source === 'direct' && account !== undefined ? chainHeld.isLoading : false,
  };
}
