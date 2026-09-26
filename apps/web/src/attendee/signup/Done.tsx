import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Screen } from '../../shared/ui';
import { useCopy } from '../../shared/i18n';
import { acceptPendingOffers } from '../transfer/offers';
import { takeInvite } from '../transfer/InviteLanding';
import { clearSignup } from './useSignup';

/** The end of signup: the phone number, the passkey and this phone are all attached. */
export function Done() {
  const copy = useCopy();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);

  async function finish(): Promise<void> {
    // Nothing in there is needed again, and leaving it behind would let a reload drop the
    // attendee back into a half-finished signup.
    clearSignup();
    const invited = takeInvite() !== null;
    setBusy(true);
    // Awaited: the inbox this lands on queries the same rows, and a ticket collected a moment
    // later would still be listed there with a 받기 button that answers "no longer there".
    await acceptPendingOffers().catch(() => undefined);
    navigate(invited ? '/tickets/inbox' : '/');
  }

  return (
    <Screen title={copy.signup.doneTitle}>
      <p>{copy.signup.doneBody}</p>
      <Button onClick={() => void finish()} disabled={busy}>
        {busy ? copy.common.loading : copy.signup.doneCta}
      </Button>
    </Screen>
  );
}
