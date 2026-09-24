import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Capacitor } from '@capacitor/core';
import { Alert, Button, Screen, Spinner, Steps } from '../../shared/ui';
import { useCopy } from '../../shared/i18n';
import type { Hex } from '@monti/shared';
import type { Copy } from '../../shared/copy/index';
import { RP_NAME, createPasskey, passkeyProblem } from '../../shared/passkey';
import { ATTENDEE_KEY_ALIAS, DeviceKeyUnavailable, ensureDeviceKey } from '../../shared/deviceKey';
import { api, callableFailure } from '../../shared/api/functions';
import { getFirebaseAuth } from '../../shared/api/firebase';
import { deferRegistration, markRegistered } from '../../shared/registration';
import { getSession } from '../../shared/session';
import { readSignup, writeSignup } from './useSignup';

/** The three the server accepts; anything else (a desktop browser) registers as `web`. */
function platform(): 'ios' | 'android' | 'web' {
  const current = Capacitor.getPlatform();
  return current === 'ios' || current === 'android' ? current : 'web';
}

/** The server's own words for "this signup cannot continue"; retrying the step would loop. */
const RESTART_REASONS = new Set([
  'PERSON_MISMATCH',
  'PERSON_NOT_FOUND',
  'BAD_PERSON_ID',
  'BAD_SIGNUP_STATE',
  'PASSKEY_REQUIRED',
  'AUTH_REQUIRED',
]);

/** The challenge lives 60 seconds and is single-use, so a slow ceremony just starts over. */
const CHALLENGE_REASONS = new Set([
  'CHALLENGE_NOT_FOUND',
  'CHALLENGE_USED',
  'CHALLENGE_EXPIRED',
  'BAD_CHALLENGE',
]);

/** The attester is a single account sending one at a time; both of these mean "come back". */
const BUSY_REASONS = new Set(['ATTESTER_BUSY', 'REGISTER_IN_FLIGHT', 'ALREADY_SENT']);

/** The account already has a passkey — this person signs in, they do not register again. */
function isAlreadyLocked(reason: string): boolean {
  return reason === 'PASSKEY_ALREADY_REGISTERED' || reason === 'CREDENTIAL_EXISTS';
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

/** Which half of the run failed, so the same rejection reads as the step it happened in. */
type Step = 'passkey' | 'device';

function message(copy: Copy, step: Step, failure: unknown): string {
  const { code, reason } = callableFailure(failure);
  if (RESTART_REASONS.has(reason)) return copy.signup.restart;
  if (step === 'passkey') {
    const problem = passkeyProblem(failure);
    if (problem === 'cancelled') return copy.signup.passkeyCancelled;
    if (problem === 'unsupported') return copy.signup.passkeyUnsupported;
    if (CHALLENGE_REASONS.has(reason)) return copy.signup.retryStep;
    return copy.signup.passkeyFailed;
  }
  if (BUSY_REASONS.has(reason)) return copy.signup.deviceBusy;
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

/** A challenge is good for 60 seconds; one held longer than this is replaced rather than used. */
const CHALLENGE_TTL_MS = 45_000;
/** How long a step may run before the screen says so out loud. */
const SLOW_AFTER_MS = 10_000;

/**
 * The registration challenge, minted **before** the tap.
 *
 * `navigator.credentials.create` may only run inside a user gesture, and that gesture's window
 * is short (Chrome allows about five seconds, Safari less). The two screens this one replaced
 * spent that window on a `loginChallenge` round trip — a cold-started function then blew the
 * budget and the browser threw `NotAllowedError`, which the screen reported as "you cancelled
 * it": a sentence about the attendee that was actually about a server. So the round trip
 * happens on arrival, and the tap finds the answer already in hand.
 */
function useRegisterChallenge(): () => Promise<string> {
  const held = useRef<{ at: number; challenge: Promise<string> } | null>(null);

  const mint = useCallback((): Promise<string> => {
    const challenge = api.loginChallenge({ purpose: 'register' }).then((answer) => answer.challenge);
    const mine = { at: Date.now(), challenge };
    held.current = mine;
    // A challenge that never arrived is not one to hand out: the next ask mints a fresh one
    // rather than replaying the same rejection. The rejection itself is the caller's.
    challenge.catch(() => {
      if (held.current === mine) held.current = null;
    });
    return challenge;
  }, []);

  useEffect(() => {
    void mint();
  }, [mint]);

  return useCallback((): Promise<string> => {
    const mine = held.current;
    // Single-use on the server, so it is single-use here too.
    held.current = null;
    if (mine === null || Date.now() - mine.at > CHALLENGE_TTL_MS) return mint();
    return mine.challenge;
  }, [mint]);
}

/**
 * Where the person was headed when the guard sent them here. Its presence is also what says
 * this is an unfinished account being finished rather than a signup running its last step —
 * only the router's guard ever sets it (router.tsx `FinishSignupFirst`).
 */
function useReturnTo(): string | null {
  return useSearchParams()[0].get('returnTo');
}

/**
 * The end of signing up, as **one screen and one tap** (plan section C).
 *
 * It used to be two: `/signup/passkey` made the passkey, and `/signup/device` registered the
 * phone — two screens, two buttons, and a founder asking why signing up needed a second
 * confirmation after the face scan. Only the first half needs the tap: `navigator.credentials
 * .create` requires a user gesture, while the device key does not (`shared/deviceKey/web.ts`
 * mints it with `crypto.subtle`, and the native plugins open their biometric prompt when a key
 * is *used*, not when it is made). So the one tap starts the ceremony and everything after it
 * is chained on, with three dots saying where the run has got to.
 *
 * Somebody who already has an account — the founder's own, finished months of bugs ago and
 * stuck at `pending` — skips straight to the second step: the account is already on the token's
 * claims, and a second passkey is not what they are missing.
 */
export function Register() {
  const copy = useCopy();
  const navigate = useNavigate();
  const returnTo = useReturnTo();
  const finishing = returnTo !== null;
  const takeChallenge = useRegisterChallenge();

  // Somebody sent here with an account already has the first step behind them.
  const [hasPasskey] = useState(() => {
    const stored = readSignup();
    return Boolean(stored.account ?? getSession().account);
  });
  const [step, setStep] = useState<Step>(hasPasskey ? 'device' : 'passkey');
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);
  const [slow, setSlow] = useState(false);
  const [error, setError] = useState('');
  // True once this device is known to have no key store at all — a private window. Retrying
  // would fail identically, so the only thing left to offer is finishing without one.
  const [unavailable, setUnavailable] = useState(false);
  // The one tap has happened at least once, so the button now says 다시 시도하기.
  const [tried, setTried] = useState(false);

  useEffect(() => {
    if (!running) {
      setSlow(false);
      return undefined;
    }
    const timer = setTimeout(() => setSlow(true), SLOW_AFTER_MS);
    return () => clearTimeout(timer);
  }, [running]);

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
    // Signup carries these from screen to screen in sessionStorage, but an account finished
    // days later has none of that — only the claims the hydrator read, which are the same two
    // values the server minted (`personId`, `account`) and validated on the way in.
    const stored = readSignup();
    const session = getSession();
    const personId = (stored.personId ?? session.personId) as Hex | undefined;
    if (!personId) {
      setError(copy.signup.restart);
      setTried(true);
      return;
    }
    let account = stored.account ?? session.account;
    setTried(true);
    setError('');
    setRunning(true);
    let at: Step = account ? 'device' : 'passkey';
    setStep(at);
    try {
      if (!account) {
        // **First, and with nothing awaited in front of it but a promise already resolved.**
        // This is the call that owns the gesture.
        const challenge = await takeChallenge();
        const credential = await createPasskey(RP_NAME, challenge);
        const registered = await api.registerPasskey({
          personId,
          attestation: JSON.parse(credential.attestationJson) as unknown,
        });
        account = registered.account;
        // The address the rules check and the chain will hold. Deriving it again locally would
        // be a second source of truth that can silently disagree with the server's.
        writeSignup({ account });
      }

      at = 'device';
      setStep(at);
      // No second tap: the key is minted without a gesture of its own.
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
      setDone(true);
      finish();
    } catch (failure) {
      if (at === 'passkey' && isAlreadyLocked(callableFailure(failure).reason)) {
        navigate('/login', { replace: true, state: { notice: copy.signup.alreadyRegistered } });
        return;
      }
      if (isDeviceKeyUnavailable(failure)) {
        setUnavailable(true);
        setError(copy.enter.deviceUnavailable);
        // Nothing here can succeed on this browser, so the guard must stop sending them back —
        // otherwise every screen they can still use bounces to a step they cannot pass.
        deferRegistration();
        return;
      }
      setError(message(copy, at, failure));
    } finally {
      setRunning(false);
    }
  }

  const labels = [copy.signup.stepPasskey, copy.signup.stepDevice, copy.signup.stepDone];
  const at = done ? labels.length : (step === 'passkey' ? 0 : 1);

  return (
    <Screen title={copy.signup.registerTitle}>
      <Steps labels={labels} at={at} running={running} />
      {finishing ? <Alert tone="info">{copy.signup.finishPending}</Alert> : null}
      <p>{copy.signup.registerBody}</p>
      {platform() === 'web' ? <p>{copy.signup.deviceWebNote}</p> : null}
      {error ? <Alert tone={unavailable ? 'warn' : 'error'}>{error}</Alert> : null}
      {running ? (
        <div className="working">
          <Spinner />
          {step === 'passkey' ? copy.signup.passkeyWorking : copy.signup.deviceWorking}
        </div>
      ) : null}
      {running && slow ? <p className="muted">{copy.signup.registerSlow}</p> : null}
      {unavailable ? (
        <Button onClick={finish}>{copy.signup.deviceSkip}</Button>
      ) : (
        <Button onClick={() => void run()} disabled={running}>
          {tried && error !== '' ? copy.signup.registerRetry : copy.signup.registerCta}
        </Button>
      )}
    </Screen>
  );
}
