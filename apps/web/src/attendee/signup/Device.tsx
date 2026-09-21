import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Capacitor } from '@capacitor/core';
import { Alert, Button, Screen, Spinner } from '../../shared/ui';
import { useCopy } from '../../shared/i18n';
import type { Copy } from '../../shared/copy/index';
import { ATTENDEE_KEY_ALIAS, DeviceKeyUnavailable, ensureDeviceKey } from '../../shared/deviceKey';
import { api, callableFailure } from '../../shared/api/functions';
import { setSession } from '../../shared/session';
import { readSignup } from './useSignup';

/** The three the server accepts; anything else (a desktop browser) registers as `web`. */
function platform(): 'ios' | 'android' | 'web' {
  const current = Capacitor.getPlatform();
  return current === 'ios' || current === 'android' ? current : 'web';
}

/** The attester is a single account sending one at a time; both of these mean "come back". */
const BUSY_REASONS = new Set(['ATTESTER_BUSY', 'REGISTER_IN_FLIGHT', 'ALREADY_SENT']);

const RESTART_REASONS = new Set([
  'PERSON_MISMATCH',
  'PERSON_NOT_FOUND',
  'BAD_PERSON_ID',
  'BAD_SIGNUP_STATE',
  'PASSKEY_REQUIRED',
  'AUTH_REQUIRED',
]);

/**
 * `instanceof` alone is not enough: a test that mocks the whole deviceKey module supplies its
 * own class, and the name is what both the real error and any stand-in agree on.
 */
function isDeviceKeyUnavailable(failure: unknown): boolean {
  if (failure instanceof DeviceKeyUnavailable) return true;
  return typeof failure === 'object' && failure !== null &&
    (failure as { name?: unknown }).name === 'DeviceKeyUnavailable';
}

function message(copy: Copy, failure: unknown): string {
  const { code, reason } = callableFailure(failure);
  if (BUSY_REASONS.has(reason)) return copy.signup.deviceBusy;
  if (RESTART_REASONS.has(reason)) return copy.signup.restart;
  // Registration waits for the block to finalise, so a slow network shows up as a deadline.
  if (code === 'deadline-exceeded' || code === 'unavailable') return copy.signup.deviceSlow;
  return copy.signup.deviceFailed;
}

/**
 * Signup step 3 of 3. The phone's secure chip mints a key that never leaves it, and the
 * attester writes its public half next to the account so the door can recognise this phone.
 * A browser has no such chip: that attendee finishes signup here and shows a code at the door.
 */
export function DeviceStep() {
  const copy = useCopy();
  const navigate = useNavigate();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // True once this device is known to have no secure chip — retrying would fail identically,
  // so the only thing left to offer is finishing signup without it.
  const [unavailable, setUnavailable] = useState(false);

  function finish(): void {
    const { personId, account } = readSignup();
    if (personId && account) setSession({ status: 'signedIn', personId, account });
    // The state itself is dropped on the done screen, which is where signup actually ends.
    navigate('/signup/done');
  }

  async function run(): Promise<void> {
    const { personId, account } = readSignup();
    if (!personId || !account) {
      setError(copy.signup.restart);
      return;
    }
    setBusy(true);
    setError('');
    try {
      const { x, y } = await ensureDeviceKey({
        alias: ATTENDEE_KEY_ALIAS,
        requireAuth: true,
        strongBox: true,
      });
      // Resolving at all is success. `alreadyRegistered` means the server found this account
      // on chain already and sent nothing — there is no hash to wait for and nothing to redo.
      await api.registerIdentity({ personId, deviceX: x, deviceY: y, platform: platform() });
      finish();
    } catch (failure) {
      if (isDeviceKeyUnavailable(failure)) {
        setUnavailable(true);
        setError(copy.enter.deviceUnavailable);
        return;
      }
      setError(message(copy, failure));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen title={copy.signup.deviceTitle}>
      <p>{copy.signup.deviceBody}</p>
      {error ? <Alert tone={unavailable ? 'warn' : 'error'}>{error}</Alert> : null}
      {busy ? (
        <div className="working">
          <Spinner />
          {copy.signup.deviceWorking}
        </div>
      ) : null}
      {unavailable ? (
        <Button onClick={finish}>{copy.signup.deviceSkip}</Button>
      ) : (
        <Button onClick={run} disabled={busy}>
          {copy.signup.deviceCta}
        </Button>
      )}
    </Screen>
  );
}
