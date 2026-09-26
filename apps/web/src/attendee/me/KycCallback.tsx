import { Navigate, useSearchParams } from 'react-router-dom';

/**
 * Where a session created before the web return address existed lands: the server's own default
 * is `https://<rp>/kyc/callback` (`functions/src/lib/kycSession.ts` defaultCallbackUrl), and the
 * native App Link falls through to the same path in a browser when the app is not installed.
 * Without this route the catch-all sends both to the explore tab and the person has to find
 * their way back to whatever they were doing.
 *
 * Neither of those carries a `returnTo`, so the profile is the usual destination. When one is
 * attached the person goes to the verification screen with it — and a `returnTo` that already
 * names that screen is followed as it stands rather than wrapped around itself, so nobody is
 * sent through `/me/verify` twice to reach one ticket.
 */
export function KycCallback() {
  const [params] = useSearchParams();
  const returnTo = params.get('returnTo');
  // Only an in-app path is a return target; the verification screen guards its own the same way.
  if (returnTo === null || !returnTo.startsWith('/') || returnTo.startsWith('//')) {
    return <Navigate to="/me" replace />;
  }
  const target = returnTo.startsWith('/me/verify')
    ? returnTo
    : `/me/verify?returnTo=${encodeURIComponent(returnTo)}`;
  return <Navigate to={target} replace />;
}
