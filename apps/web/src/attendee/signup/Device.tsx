import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Capacitor } from '@capacitor/core';
import { Alert, Button, Screen, Spinner } from '../../shared/ui';
import { useCopy } from '../../shared/i18n';
import type { Hex } from '@monti/shared';
import type { Copy } from '../../shared/copy/index';
import { ATTENDEE_KEY_ALIAS, DeviceKeyUnavailable, ensureDeviceKey } from '../../shared/deviceKey';
import { api, callableFailure } from '../../shared/api/functions';
import { getFirebaseAuth } from '../../shared/api/firebase';
import { deferRegistration, markRegistered } from '../../shared/registration';
import { getSession } from '../../shared/session';
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
 * The session is never written by hand here. `shared/api/sessionHydrator` reads `{ personId,
 * account }` out of the Firebase token's claims and is the only thing that may say "signed in";
 * a local `setSession` would be a second source of truth that the next `onIdTokenChanged`
 * contradicts. Forcing a refresh is how the claims the server just wrote reach that hydrator.
 * The registration itself already succeeded, so a refresh that fails must not undo it — and
 * until the server sets the claims this is simply a no-op and signup still finishes.
 */
async function refreshClaims(): Promise<void> {
  try {
    await getFirebaseAuth().currentUser?.getIdToken(true);
  } catch {
    // A stale token costs one sign-in, a thrown one costs the whole signup.
  }
}

/**
 * Signup step 3 of 3, and the step that makes a person `active`. The phone's secure chip mints a
 * key that never leaves it, and the attester writes its public half next to the account so the
 * door can recognise this phone.
 *
 * A browser has no such chip, so it mints a software P-256 key instead (shared/deviceKey/web.ts)
 * and registers exactly the same way. That key is not proof of a device, so a browser is not
 * offered the gate — the line under the title says so. What it buys is the rest of the product:
 * before this, a browser skipped `registerIdentity` entirely and every web attendee stayed
 * `pending`, which is what `startKyc` and every claim refuse.
 *
 * The skip path is now only for a browser that genuinely cannot make a key — a private window
 * with no IndexedDB — and never the default.
 */
/**
 * Where the person was headed when the guard sent them here. Its presence is also what says
 * this is an unfinished account being finished rather than a signup running its third step —
 * only the router's guard ever sets it (router.tsx `FinishSignupFirst`).
 */
function useReturnTo(): string | null {
  const [params] = useSearchParams();
  return params.get('returnTo');
}

export function DeviceStep() {
  const copy = useCopy();
  const navigate = useNavigate();
  const returnTo = useReturnTo();
  const finishing = returnTo !== null;
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // True once this device is known to have no secure chip — retrying would fail identically,
  // so the only thing left to offer is finishing signup without it.
  const [unavailable, setUnavailable] = useState(false);

  function finish(): void {
    // An account being finished is already past signup: it goes back to whatever it was trying
    // to do. A signup in progress ends on the done screen, which is where its state is dropped.
    if (finishing) {
      navigate(returnTo || '/', { replace: true });
      return;
    }
    navigate('/signup/done');
  }

  async function run(): Promise<void> {
    // Signup carries these from step to step in sessionStorage, but an account finished days
    // later has none of that — only the claims the hydrator read, which are the same two values
    // the server minted (`personId`, `account`) and validated on the way in.
    const stored = readSignup();
    const session = getSession();
    const personId = (stored.personId ?? session.personId) as Hex | undefined;
    const account = stored.account ?? session.account;
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
      await refreshClaims();
      // The guard asked the server once; saying so here is cheaper and truer than asking again.
      markRegistered();
      finish();
    } catch (failure) {
      if (isDeviceKeyUnavailable(failure)) {
        setUnavailable(true);
        setError(copy.enter.deviceUnavailable);
        // Nothing here can succeed on this browser, so the guard must stop sending them back —
        // otherwise every screen they can still use bounces to a step they cannot pass.
        deferRegistration();
        return;
      }
      setError(message(copy, failure));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen title={copy.signup.deviceTitle}>
      {finishing ? <Alert tone="info">{copy.signup.finishPending}</Alert> : null}
      <p>{copy.signup.deviceBody}</p>
      {platform() === 'web' ? <p>{copy.signup.deviceWebNote}</p> : null}
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
