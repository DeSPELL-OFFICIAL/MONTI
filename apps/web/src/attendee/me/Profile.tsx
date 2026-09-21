import { useNavigate } from 'react-router-dom';
import { Alert, Button, Field, Screen } from '../../shared/ui';
import { setLocale, useCopy, useLocale } from '../../shared/i18n';
import type { Locale } from '../../shared/copy/index';
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
      <p>{verified ? copy.kyc.verified : copy.kyc.unverified}</p>
      {verified ? null : (
        <Button onClick={() => navigate('/me/verify?returnTo=/me')}>{copy.kyc.cta}</Button>
      )}
    </section>
  );
}

/**
 * Deleting an account is a legal obligation, and sub-plan 02 has not built the callable for it
 * (`functions/src/index.ts` exports no `requestAccountDeletion`). A button wired to a callable
 * that is not deployed would fail as an opaque `internal` at the one moment a person must be
 * taken seriously, and a deletion this app performed only on its own side would be a lie —
 * the records live on the server. So this is a hand-off to people, stated as one.
 */
function DeleteRequest() {
  const copy = useCopy();
  const subject = encodeURIComponent(copy.me.deleteAccount);
  return (
    <section>
      <h2>{copy.me.deleteAccount}</h2>
      <Alert tone="warn">{copy.me.deleteRequestNote}</Alert>
      <a href={`mailto:${copy.me.deleteRequestEmail}?subject=${subject}`}>{copy.me.deleteAccount}</a>
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
      <DeleteRequest />
    </Screen>
  );
}
