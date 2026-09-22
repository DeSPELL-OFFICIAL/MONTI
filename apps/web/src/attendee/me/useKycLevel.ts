import { useQuery } from '@tanstack/react-query';
import { api } from '../../shared/api/functions';
import { useSession } from '../../shared/session';

/**
 * 0 = unverified, 1 = id + face verified. Cached so claim gating does not re-ask the server.
 *
 * Nothing is asked of a signed-out visitor: `/` and `/events/:id` are public routes, and the
 * callable would only answer `unauthenticated` there. 0 is the right answer for them, and it is
 * the one the badge already draws nothing from.
 */
export function useKycLevel() {
  const signedIn = useSession().status === 'signedIn';
  const query = useQuery({
    queryKey: ['kycLevel'],
    queryFn: async () => (await api.getSignupStatus()).kycLevel ?? 0,
    staleTime: 60_000,
    enabled: signedIn,
  });
  return { kycLevel: query.data ?? 0, isLoading: query.isLoading, refetch: query.refetch };
}
