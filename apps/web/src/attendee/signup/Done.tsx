import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Field, Screen, SuccessCheck } from '../../shared/ui';
import { useCopy } from '../../shared/i18n';
import { MAX_DISPLAY_NAME_CHARS, saveUserProfile } from '../../shared/api/firestore';
import { acceptPendingOffers } from '../transfer/offers';
import { takeInvite } from '../transfer/InviteLanding';
import { clearSignup } from './useSignup';

/**
 * The end of signup: the phone number, the lock and this phone are all attached.
 *
 * The one question left is what to call this person. It is asked **here** and not on the
 * register screen because that screen has to stay one tap (plan section C-3), and it is asked
 * at all because a ticket with a name on it is the thing an attendee shows at a door. The name
 * is `users/{uid}.displayName` — a field of its own, not the chain nickname, which is
 * `^[a-z0-9_]{3,20}$` and cannot hold `김태완`.
 *
 * Leaving it blank is a real answer: nothing is written, and a ticket with no name on it draws
 * no name at all rather than a placeholder.
 */
export function Done() {
  const copy = useCopy();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  async function finish(): Promise<void> {
    // Nothing in there is needed again, and leaving it behind would let a reload drop the
    // attendee back into a half-finished signup.
    clearSignup();
    const invited = takeInvite() !== null;
    setBusy(true);
    const displayName = name.trim();
    // Swallowed on purpose: signing up is over either way, and a name nobody can save is not a
    // reason to hold somebody on the last screen of it. The profile can set it later.
    if (displayName !== '') await saveUserProfile({ displayName }).catch(() => undefined);
    // Awaited: the inbox this lands on queries the same rows, and a ticket collected a moment
    // later would still be listed there with a 받기 button that answers "no longer there".
    await acceptPendingOffers().catch(() => undefined);
    navigate(invited ? '/tickets/inbox' : '/');
  }

  return (
    <Screen title={copy.signup.doneTitle}>
      <SuccessCheck />
      <p>{copy.signup.doneBody}</p>
      <Field label={copy.signup.nameTitle}>
        <input
          value={name}
          maxLength={MAX_DISPLAY_NAME_CHARS}
          placeholder={copy.signup.namePlaceholder}
          onChange={(event) => setName(event.target.value)}
        />
      </Field>
      <p className="muted">{copy.signup.nameHelp}</p>
      <Button onClick={() => void finish()} disabled={busy}>
        {busy ? copy.common.loading : copy.signup.doneCta}
      </Button>
    </Screen>
  );
}
