import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { signOut } from 'firebase/auth';
import { Alert, Button, Card, ContactLink, Field, Screen, Spinner } from '../../shared/ui';
import { fmt, setLocale, useCopy, useLocale } from '../../shared/i18n';
import type { Locale } from '../../shared/copy/index';
import { api } from '../../shared/api/functions';
import { getFirebaseAuth } from '../../shared/api/firebase';
import { MAX_DISPLAY_NAME_CHARS, saveUserProfile } from '../../shared/api/firestore';
import { useDisplayName } from '../../shared/displayName';
import { getConfig } from '../../shared/config';
import { useSession } from '../../shared/session';
import { useOrganizerEntry } from '../../organizer/useOrganizerEntry';
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
    <Card title={copy.kyc.status}>
      <p>{verified ? copy.kyc.mineVerified : copy.kyc.mineUnverified}</p>
      {verified ? null : (
        <Button onClick={() => navigate('/me/verify?returnTo=/me')}>{copy.kyc.cta}</Button>
      )}
    </Card>
  );
}

/**
 * The name printed on a ticket — `users/{uid}.displayName`. It is asked for once, on the last
 * screen of signing up, and never asked for again (T-UX2-4); what was missing until now was any
 * way to change it afterwards, which is the whole of this part.
 *
 * It sits directly above the chain nickname on purpose, with one line telling them apart. They
 * look like the same question and are not: 표시 이름 is a Firestore field, holds 김태완, and is
 * free to change, while 별명 is `^[a-z0-9_]{3,20}$`, is unique across everybody, and costs a
 * sponsored write to set (plan decision 6). Nothing here touches the nickname.
 *
 * The patch carries `displayName` and nothing else, deliberately: the security rule admits a
 * write to this document only when the keys that changed are within the list it names, so a
 * patch that swept anything else along would come back as a permission error rather than as a
 * message anybody could act on.
 *
 * A refusal leaves the box exactly as it was typed. Emptying it would throw away the only copy
 * of what somebody just wrote in order to tell them something the sentence beneath already says.
 */
function DisplayName() {
  const copy = useCopy();
  const stored = useDisplayName();
  const [value, setValue] = useState('');
  const [message, setMessage] = useState('');
  const [tone, setTone] = useState<'info' | 'error'>('info');
  const [busy, setBusy] = useState(false);
  /** Typing outranks the stored name: a read that answered late must not overwrite it. */
  const typed = useRef(false);

  useEffect(() => {
    if (typed.current || stored === '') return;
    setValue(stored);
  }, [stored]);

  async function save(): Promise<void> {
    setBusy(true);
    setMessage('');
    try {
      // Trimmed, because a name that is one space is a ticket with a gap drawn on it.
      await saveUserProfile({ displayName: value.trim() });
      setTone('info');
      setMessage(copy.me.displayNameSaved);
    } catch {
      setTone('error');
      setMessage(copy.me.displayNameFailed);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <Field label={copy.me.displayName}>
        <input
          value={value}
          maxLength={MAX_DISPLAY_NAME_CHARS}
          placeholder={copy.me.displayNamePlaceholder}
          onChange={(event) => {
            typed.current = true;
            setValue(event.target.value);
          }}
        />
      </Field>
      <p className="muted">{copy.me.displayNameHelp}</p>
      <p className="muted">{copy.me.displayNameVsNickname}</p>
      {message ? <Alert tone={tone}>{message}</Alert> : null}
      <Button onClick={() => void save()} disabled={busy}>{copy.common.save}</Button>
    </Card>
  );
}

/**
 * The way from 프로필 into the organiser side, and the second half of the answer to "there is
 * no link to `/org` anywhere" — the other half is the floating 만들기 on 탐색. Both ask
 * {@link useOrganizerEntry}, so neither can decide this person is an organiser while the other
 * decides they are not.
 *
 * It sits above 계정 삭제 rather than beside it because it is a capability, not something
 * irreversible. While the indexer has not answered, the heading stands alone over a spinner:
 * either label would be a guess, and `주최자 되기` is the guess that would be insulting to
 * somebody who already runs three organisations.
 */
function OrganizerSection() {
  const copy = useCopy();
  const navigate = useNavigate();
  const { profileTo, hasOrg, isLoading } = useOrganizerEntry();

  return (
    <Card title={copy.me.organizer}>
      {isLoading ? <Spinner /> : null}
      {isLoading ? null : (
        <>
          {hasOrg ? null : <p className="muted">{copy.me.organizerHint}</p>}
          <Button variant="ghost" onClick={() => navigate(profileTo)}>
            {hasOrg ? copy.me.organizerOpen : copy.me.organizerBecome}
          </Button>
        </>
      )}
    </Card>
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
    <Card title={copy.me.deleteAccount}>
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
    </Card>
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
      <DisplayName />
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
      <OrganizerSection />
      <DeleteAccount />
      <footer><ContactLink /></footer>
    </Screen>
  );
}
