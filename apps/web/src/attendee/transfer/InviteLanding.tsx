import { useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Screen, Spinner } from '../../shared/ui';
import { useCopy } from '../../shared/i18n';
import { useSession } from '../../shared/session';

/**
 * Where the invite id waits while a new arrival goes through signup. It dies with the tab,
 * which is exactly the lifetime of an unfinished arrival, and it is the only thing kept.
 */
export const INVITE_KEY = 'monti.invite';

export function rememberInvite(inviteId: string): void {
  try {
    sessionStorage.setItem(INVITE_KEY, inviteId);
  } catch {
    /* private mode */
  }
}

/** Reads the id and forgets it: it is good for exactly one landing. */
export function takeInvite(): string | null {
  try {
    const inviteId = sessionStorage.getItem(INVITE_KEY);
    sessionStorage.removeItem(INVITE_KEY);
    return inviteId;
  } catch {
    return null;
  }
}

/**
 * Where the link in the text lands. The id is opaque — this screen carries it and reads
 * nothing out of it; the ticket behind it is found by the number the invite was sent to,
 * which only the server can match. Somebody already signed in goes straight to what is
 * waiting; a new arrival signs up first and is brought back to the same place.
 */
export function InviteLanding() {
  const copy = useCopy();
  const navigate = useNavigate();
  const session = useSession();
  const { inviteId = '' } = useParams();

  useEffect(() => {
    // Still hydrating: deciding now would send a signed-in person through signup.
    if (session.status === 'loading') return;
    if (session.status === 'signedIn') {
      navigate('/tickets/inbox', { replace: true });
      return;
    }
    rememberInvite(inviteId);
    navigate('/signup/phone', { replace: true });
  }, [session.status, inviteId, navigate]);

  return (
    <Screen title={copy.transfer.landingTitle}>
      <p>{copy.transfer.landingBody}</p>
      <Spinner />
    </Screen>
  );
}
