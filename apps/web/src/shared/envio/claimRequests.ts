import { useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { gql } from './client';
import { EVENT_REQUESTS_QUERY, MY_REQUESTS_QUERY, type EnvioClaimRequest } from './queries';
import { useSession } from '../session';

/**
 * The attendee's own request for one event: the newest row {@link MY_REQUESTS_QUERY} returns, or
 * null when they have never asked. The address goes to the indexer lowercase, the way every row is
 * stored — a checksummed one matches nothing — and nothing is asked on behalf of a signed-out
 * visitor. The screen refetches after it sends a request or a cancel, since the indexer takes a
 * moment to catch up to the transaction.
 */
export interface MyRequestResult {
  request: EnvioClaimRequest | null;
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  refetch: () => Promise<EnvioClaimRequest | null>;
}

export function useMyRequest(eventId: string): MyRequestResult {
  const session = useSession();
  const requester = session.account?.toLowerCase();
  const query = useQuery({
    queryKey: ['claimRequest', 'mine', eventId, requester],
    queryFn: async (): Promise<EnvioClaimRequest | null> => {
      const { ClaimRequest } = await gql<{ ClaimRequest: EnvioClaimRequest[] }>(MY_REQUESTS_QUERY, {
        eventId,
        requester,
      });
      return ClaimRequest[0] ?? null;
    },
    enabled: requester !== undefined && eventId !== '',
  });
  const refetch = useCallback(
    async (): Promise<EnvioClaimRequest | null> => (await query.refetch()).data ?? null,
    [query],
  );
  return {
    request: query.data ?? null,
    isLoading: query.isLoading,
    isError: query.isError,
    error: query.error,
    refetch,
  };
}

/**
 * Every request an event has in one status, oldest first — the organiser's 신청 관리 screen. It
 * defaults to `"Pending"`, the only set with actions on it: approving or rejecting moves a row out
 * of that set, so the screen refetches after each op rather than trusting a cached list.
 */
export interface EventRequestsResult {
  requests: EnvioClaimRequest[];
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  refetch: () => Promise<EnvioClaimRequest[]>;
}

export function useEventRequests(eventId: string, status = 'Pending'): EventRequestsResult {
  const query = useQuery({
    queryKey: ['claimRequest', 'event', eventId, status],
    queryFn: async (): Promise<EnvioClaimRequest[]> => {
      const { ClaimRequest } = await gql<{ ClaimRequest: EnvioClaimRequest[] }>(EVENT_REQUESTS_QUERY, {
        eventId,
        status,
      });
      return ClaimRequest;
    },
    enabled: eventId !== '',
  });
  const refetch = useCallback(
    async (): Promise<EnvioClaimRequest[]> => (await query.refetch()).data ?? [],
    [query],
  );
  return {
    requests: query.data ?? [],
    isLoading: query.isLoading,
    isError: query.isError,
    error: query.error,
    refetch,
  };
}
