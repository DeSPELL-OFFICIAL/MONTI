import { useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Hex } from 'viem';

import { EventStatus, readTicket } from '../../shared/chain/reads';
import { useSession } from '../../shared/session';
import { deriveTicketState } from './ticketState';
import { useMyTickets, type MyTicket } from './useTickets';

/**
 * The ticket detail screen reads one ticket out of {@link useMyTickets}, whose list is the
 * indexer's. The hosted indexer can freeze, so a deep link to a freshly minted ticket finds no
 * row there and the screen used to render "there is no such ticket" — which also meant the
 * receipt and the refund it hosts never mounted. This hook answers that one ticket from the
 * chain when the indexer's list has settled without it.
 *
 * It mirrors {@link useClaimEventData}: the indexer is the preferred source, and only a *settled,
 * empty* list (not a still-loading one, not an errored one) is worth a chain read. The chain row
 * is shaped into the same {@link MyTicket} the list serves, so the screen below it reads one shape
 * wherever the answer came from. Scope is this one ticket — the 내 티켓 list is never built from
 * the chain, because enumerating every token an address holds is not a single read.
 */

/** The `Ticket.EventStatus` ordinal that the whole event is off. */
const CANCELLED = EventStatus.Cancelled;

/**
 * Builds one {@link MyTicket} from the chain, or `null` when it should stay "not found": a token
 * that was never minted (`ownerOf` reverts) or one this session does not hold. Ownership is read
 * first so a deep link to somebody else's ticket number never renders their ticket here.
 */
async function readTicketFromChain(tokenId: string, account: Hex): Promise<MyTicket | null> {
  const ticket = readTicket();
  const id = BigInt(tokenId);
  const owner = await ticket.ownerOf(id).catch(() => undefined);
  if (owner === undefined || owner.toLowerCase() !== account.toLowerCase()) return null;

  const [eventId, tier, checkIn, revoked] = await Promise.all([
    ticket.eventOf(id),
    ticket.tierOf(id),
    ticket.checkInOf(id),
    ticket.isRevoked(id),
  ]);
  const [meta, status, tiers] = await Promise.all([
    ticket.eventMeta(eventId),
    ticket.eventStatus(eventId),
    ticket.tiers(eventId),
  ]);

  const checkInTs = checkIn.ts > 0n ? Number(checkIn.ts) : null;
  return {
    tokenId,
    eventId: String(eventId),
    tier,
    checkInTs,
    used: checkInTs !== null,
    imageCid: meta.imageCid,
    tierName: tiers[tier]?.name ?? '',
    startsAt: Number(meta.startsAt),
    state: deriveTicketState({
      ownerIsMe: true,
      revoked,
      eventCancelled: Number(status) === CANCELLED,
      checkIn: checkInTs !== null ? { ts: checkInTs } : null,
      // A deep link that lands on the chain is a just-minted ticket; a pending handover is the
      // indexer's record and never the reason this fallback runs, so none is read here.
      offer: null,
      now: Math.floor(Date.now() / 1000),
    }),
  };
}

export type TicketDetailSource = 'indexer' | 'direct' | 'none';

export interface TicketDetailResult {
  ticket: MyTicket | undefined;
  source: TicketDetailSource;
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  refetch: () => void;
}

export function useTicketDetail(tokenId: string): TicketDetailResult {
  const account = useSession().account;
  const indexer = useMyTickets();
  const indexerTicket = (indexer.data ?? []).find((row) => row.tokenId === tokenId);
  // Settled and empty: the list arrived and this id is not in it. Only then is the chain read
  // worth it — a still-loading list is waited for, and an errored one keeps its own retry screen.
  const indexerEmpty = indexer.isSuccess && indexerTicket === undefined;

  const chain = useQuery({
    queryKey: ['ticketDetail', 'direct', tokenId, (account ?? '').toLowerCase()],
    queryFn: () => readTicketFromChain(tokenId, account as Hex),
    enabled: tokenId !== '' && indexerEmpty && account !== undefined,
  });

  const ticket = indexerTicket ?? chain.data ?? undefined;
  const source: TicketDetailSource =
    indexerTicket !== undefined ? 'indexer' : chain.data != null ? 'direct' : 'none';

  const refetch = useCallback((): void => {
    void indexer.refetch();
    void chain.refetch();
  }, [indexer, chain]);

  return {
    ticket,
    source,
    isLoading: indexer.isLoading || (indexerEmpty && chain.isLoading),
    isError: indexer.isError || (indexerEmpty && chain.isError),
    error: indexer.error ?? chain.error,
    refetch,
  };
}
