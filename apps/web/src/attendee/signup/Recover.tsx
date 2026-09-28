import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Capacitor } from '@capacitor/core';
import { signInWithCustomToken } from 'firebase/auth';
import { Alert, Button, OpProgress, Screen, Spinner } from '../../shared/ui';
import { fmt, useCopy, useLocale } from '../../shared/i18n';
import type { Copy } from '../../shared/copy/index';
import type { Hex } from '@monti/shared';
import { RP_NAME, createPasskey, passkeyProblem } from '../../shared/passkey';
import { ATTENDEE_KEY_ALIAS, DeviceKeyUnavailable, ensureDeviceKey } from '../../shared/deviceKey';
import { api, callableFailure } from '../../shared/api/functions';
import { getFirebaseAuth } from '../../shared/api/firebase';
import { getSession } from '../../shared/session';
import { clearSignup, readSignup } from './useSignup';
import { useRegisterChallenge } from './Register';

/** The three the server accepts; anything else (a desktop browser) recovers as `web`. */
function platform(): 'ios' | 'android' | 'web' {
  const current = Capacitor.getPlatform();
  return current === 'ios' || current === 'android' ? current : 'web';
}

/**
 * `instanceof` alone is not enough: a test that mocks the whole deviceKey module supplies its
 * own class, and the name is what both the real error and any stand-in agree on.
 */
function isDeviceKeyUnavailable(failure: unknown): boolean {
  if (failure instanceof DeviceKeyUnavailable) return true;
  return typeof failure === 'object' && failure !== null &&
    (failure as { name?: unknown }).name === 'DeviceKeyUnavailable';
}

/**
 * The cooldown answer carries the moment recovery reopens as `details.allowedAt` (epoch seconds).
 * Read structurally, so it works whether the rejection is a real `CallableError` (which surfaces
 * `details`) or a screen test's plain stand-in.
 */
function cooldownAllowedAt(failure: unknown): number | null {
  if (typeof failure !== 'object' || failure === null) return null;
  const details = (failure as { details?: unknown }).details;
  if (typeof details !== 'object' || details === null) return null;
  const allowedAt = (details as { allowedAt?: unknown }).allowedAt;
  return typeof allowedAt === 'number' ? allowedAt : null;
}

/** The one place a recovery failure becomes a sentence. */
function message(copy: Copy, locale: string, failure: unknown): string {
  if (isDeviceKeyUnavailable(failure)) return copy.recover.deviceUnavailable;
  if (passkeyProblem(failure) === 'cancelled') return copy.signup.passkeyCancelled;
  const { reason } = callableFailure(failure);
  if (reason === 'ROTATION_COOLDOWN') {
    const allowedAt = cooldownAllowedAt(failure);
    return allowedAt !== null
      ? fmt(copy.recover.cooldown, { date: new Date(allowedAt * 1_000).toLocaleDateString(locale) })
      : copy.recover.failed;
  }
  if (reason === 'RECOVERY_RATE_LIMIT') return copy.recover.rateLimit;
  return copy.recover.failed;
}

/**
 * Lost-passkey recovery, from a fresh phone (plan: "lost passkey -> recover by phone").
 *
 * The person has already proved the number on the screen before this one (Verify), which found an
 * `active` account with no passkey on this device and sent them here. One tap makes a new passkey
 * and device key and hands them to `recoverAccess`, which rotates the account's owner on chain and
 * mints a Firebase session -- all inside that single call, so the wait is one `confirming` phase
 * rather than a stepper.
 *
 * The old phone is not cut off: for 24 hours it can undo the move (`me/NewDevice.tsx`), and the
 * tickets only cross once that window closes. Both facts are said out loud here, because a genuine
 * recovery should see that nothing was taken from anyone, and a thief should see that the real
 * owner can take it straight back.
 */
export function Recover() {
  const copy = useCopy();
  const locale = useLocale();
  const navigate = useNavigate();
  const registerChallenge = useRegisterChallenge();

  // Verify writes it the moment it learns this is a returning person; a reload between the two
  // screens loses that, so the claims the phone session already carries are the fallback.
  const [personId] = useState<Hex | undefined>(() => {
    const stored = readSignup();
    return (stored.personId ?? getSession().personId) as Hex | undefined;
  });
  const [running, setRunning] = useState(false);
  // The recoverAccess call is in flight: the server is rotating on chain and waiting for finality,
  // which is the one wait worth a determinate progress UI.
  const [confirming, setConfirming] = useState(false);
  // The run is up and the challenge is not here yet; it carries on by itself the moment it is.
  const [gettingReady, setGettingReady] = useState(false);
  const [error, setError] = useState('');
  const [tried, setTried] = useState(false);

  // Nothing to recover without a person to recover. A fresh tab opened straight on /recover has
  // neither the signup state nor a session, so it belongs on the sign-in screen.
  useEffect(() => {
    if (!personId) navigate('/login', { replace: true });
  }, [personId, navigate]);

  async function run(): Promise<void> {
    if (!personId) {
      navigate('/login', { replace: true });
      return;
    }
    setTried(true);
    setError('');
    setRunning(true);
    try {
      // First, with nothing awaited in front of it: `take` answers out of the hand the hook keeps
      // full, so `createPasskey` is reached in the same turn as the tap and the gesture is still
      // the browser's to spend on the ceremony (see Register.tsx `useRegisterChallenge`).
      let challenge = registerChallenge.take();
      if (challenge === '') {
        setGettingReady(true);
        challenge = await registerChallenge.wait();
        setGettingReady(false);
      }
      const credential = await createPasskey(RP_NAME, challenge);
      // No second tap: the device key is minted without a gesture of its own.
      const { x, y } = await ensureDeviceKey({
        alias: ATTENDEE_KEY_ALIAS,
        requireAuth: true,
        strongBox: true,
      });
      // The server rotates the owner on chain and waits for finality inside this one call, so the
      // whole of it is a single confirming phase.
      setConfirming(true);
      const result = await api.recoverAccess({
        personId,
        attestation: JSON.parse(credential.attestationJson) as unknown,
        deviceX: x,
        deviceY: y,
        platform: platform(),
      });
      // The session comes from the token's claims, read by shared/api/sessionHydrator -- the same
      // path signup and sign-in take, which is why nothing here sets the session by hand.
      await signInWithCustomToken(getFirebaseAuth(), result.token);
      clearSignup();
      navigate('/tickets');
    } catch (failure) {
      setError(message(copy, locale, failure));
    } finally {
      setGettingReady(false);
      setConfirming(false);
      setRunning(false);
    }
  }

  return (
    <Screen title={copy.recover.title}>
      <p>{copy.recover.body}</p>
      <p className="muted">{copy.recover.undoNote}</p>
      <p className="muted">{copy.recover.ticketsNote}</p>
      {error ? <Alert tone="error">{error}</Alert> : null}
      {confirming ? (
        <OpProgress phase="confirming" note={copy.recover.working} />
      ) : running ? (
        <div className="working">
          <Spinner />
          {gettingReady ? copy.signup.challengeWaiting : copy.recover.working}
        </div>
      ) : null}
      <Button onClick={() => void run()} disabled={running}>
        {tried && error !== '' ? copy.common.retry : copy.recover.cta}
      </Button>
    </Screen>
  );
}
