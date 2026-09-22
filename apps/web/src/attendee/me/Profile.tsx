import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { signOut } from 'firebase/auth';
import { Alert, Button, ContactLink, Field, Screen } from '../../shared/ui';
import { fmt, setLocale, useCopy, useLocale } from '../../shared/i18n';
import type { Locale } from '../../shared/copy/index';
import { api } from '../../shared/api/functions';
import { getFirebaseAuth } from '../../shared/api/firebase';
import { saveUserProfile } from '../../shared/api/firestore';
import { getConfig } from '../../shared/config';
import { useSession } from '../../shared/session';
import { Nickname } from './Nickname';
import { DeviceLock } from './DeviceLock';
import { NewDevice } from './NewDevice';
import { useKycLevel } from './useKycLevel';

/** Level 1 is id + face confirmed; the events that ask for it ask for exactly that. */
const VERIFIED_LEVEL = 1;

export function KycStatus() {
  const copy = useCopy();
  const navigate = useNavigate();
  const { kycLevel } = useKycLevel();
  const verified = kycLevel >= VERIFIED_LEVEL;
  return (
    <section>
      <h2>{copy.kyc.status}</h2>
      <p>{verified ? copy.kyc.mineVerified : copy.kyc.mineUnverified}</p>
      {verified ? null : (
        <Button onClick={() => navigate('/me/verify?returnTo=/me')}>{copy.kyc.cta}</Button>
      )}
    </section>
  );
}

/**
 * Deleting an account is a legal obligation (개인정보 보호법 §36), and
 * `functions/src/functions/accountDeletion.ts` is the one place it happens: the request is
 * written, sign-in is disabled and the refresh tokens are revoked on the spot, and a scheduled
 * job erases the personal details once the grace period is up.
 *
 * The three sentences in the dialog are the three facts that are already true by the time the
 * call resolves, and all three are ones a person would be right to be angry about learning
 * afterwards: the session ends immediately, the personal details go seven days later, and the
 * public record of the tickets stays (`onChainRetained`) because nothing in it is personal.
 * Saying "everything is deleted" would be the easy sentence and a false one.
 *
 * Signing out here is not housekeeping — the server has already made this session worthless,
 * so leaving the app looking signed in would only hand back opaque refusals on the next tap.
 * A failed sign-out does not undo the request, so it never becomes an error sentence.
 */
function DeleteAccount() {
  const copy = useCopy();
  const locale = useLocale();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [scheduled, setScheduled] = useState('');

  async function run(): Promise<void> {
    setBusy(true);
    setError('');
    let scheduledFor: number;
    try {
      ({ scheduledFor } = await api.requestAccountDeletion());
    } catch {
      setError(copy.me.deleteFailed);
      setBusy(false);
      return;
    }
    setAsking(false);
    setScheduled(fmt(copy.me.deleteScheduled, {
      date: new Date(scheduledFor * 1_000).toLocaleDateString(locale),
    }));
    // The session hydrator turns the sign-out into an anonymous session; nothing is set by hand.
    await signOut(getFirebaseAuth()).catch(() => undefined);
    setBusy(false);
  }

  return (
    <section>
      <h2>{copy.me.deleteAccount}</h2>
      {scheduled ? <Alert tone="info">{scheduled}</Alert> : null}
      {error ? <Alert tone="error">{error}</Alert> : null}
      {asking ? (
        <dialog open aria-label={copy.me.deleteConfirmTitle}>
          <h3>{copy.me.deleteConfirmTitle}</h3>
          <ul>
            <li>{copy.me.deleteSignOut}</li>
            <li>{copy.me.deleteErase}</li>
            <li>{copy.me.deleteRetained}</li>
          </ul>
          <Button variant="danger" onClick={() => void run()} disabled={busy}>
            {copy.me.deleteConfirmCta}
          </Button>
          <Button variant="ghost" onClick={() => setAsking(false)} disabled={busy}>
            {copy.common.cancel}
          </Button>
        </dialog>
      ) : null}
      {asking || scheduled ? null : (
        <Button variant="ghost" onClick={() => setAsking(true)}>{copy.me.deleteCta}</Button>
      )}
    </section>
  );
}

export function Profile() {
  const copy = useCopy();
  const locale = useLocale();
  const session = useSession();
  const explorerBase = getConfig().explorerUrl;

  async function chooseLocale(next: Locale): Promise<void> {
    await setLocale(next);
    // The stored copy is a convenience for the server's own messages; failing to save it must
    // not undo the language the person just picked on this device.
    await saveUserProfile({ locale: next }).catch(() => undefined);
  }

  return (
    <Screen title={copy.me.title}>
      <KycStatus />
      <Nickname />
      <Field label={copy.me.language}>
        <select value={locale} onChange={(event) => void chooseLocale(event.target.value as Locale)}>
          <option value="ko">{copy.me.languageKo}</option>
          <option value="en">{copy.me.languageEn}</option>
        </select>
      </Field>
      <DeviceLock />
      <NewDevice />
      <p>
        <a href={`${explorerBase}/address/${session.account ?? ''}`}>{copy.me.publicRecord}</a>
      </p>
      <DeleteAccount />
      <footer><ContactLink /></footer>
    </Screen>
  );
}
