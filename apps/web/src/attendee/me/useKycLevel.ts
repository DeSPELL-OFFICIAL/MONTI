import { useQuery } from '@tanstack/react-query';
import { api } from '../../shared/api/functions';

/** 0 = unverified, 1 = id + face verified. Cached so claim gating does not re-ask the server. */
export function useKycLevel() {
  const query = useQuery({
    queryKey: ['kycLevel'],
    queryFn: async () => (await api.getSignupStatus()).kycLevel ?? 0,
    staleTime: 60_000,
  });
  return { kycLevel: query.data ?? 0, isLoading: query.isLoading, refetch: query.refetch };
}
