import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { signOut } from 'firebase/auth';
import { Alert, Button, Screen } from '../../shared/ui';
import { ATTENDEE_KEY_ALIAS, resetDeviceKey } from '../../shared/deviceKey';
import { getFirebaseAuth } from '../../shared/api/firebase';
import { resetDeviceHealth } from '../../shared/deviceHealth';
import { resetRegistration } from '../../shared/registration';
import { useStartCopy } from './useStartCopy';

/**
 * `/recover` in open mode. The phone flow re-issues a lost device key after an SMS check; an open
 * identity has no phone to check, so there is nothing to recover *with* — the identity lives in
 * this browser's key, and once that key is gone or no longer the one on record the pass cannot be
 * used. The honest offer is a fresh start: the stale key is dropped (so the next start mints a new
 * one rather than re-presenting the key that failed), the Firebase user is signed out, and `/start`
 * makes a new identity.
 */
export function RecoverOpen() {
  const copy = useStartCopy();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function startAgain(): Promise<void> {
    setBusy(true);
    setError('');
    try {
      await resetDeviceKey({ alias: ATTENDEE_KEY_ALIAS });
      await signOut(getFirebaseAuth());
      resetRegistration();
      resetDeviceHealth();
      navigate('/start', { replace: true });
    } catch {
      setError(copy.recoverFailed);
      setBusy(false);
    }
  }

  return (
    <Screen title={copy.recoverTitle}>
      <p>{copy.recoverBody}</p>
      <p className="muted">{copy.recoverNote}</p>
      {error ? <Alert tone="error">{error}</Alert> : null}
      <Button onClick={() => void startAgain()} disabled={busy}>{copy.recoverCta}</Button>
    </Screen>
  );
}
