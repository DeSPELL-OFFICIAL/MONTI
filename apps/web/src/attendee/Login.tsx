import { useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { signInWithCustomToken } from 'firebase/auth';
import { Alert, Button, Screen, Spinner } from '../shared/ui';
import { useCopy } from '../shared/i18n';
import type { Copy } from '../shared/copy/index';
import { api, callableFailure } from '../shared/api/functions';
import { getFirebaseAuth } from '../shared/api/firebase';
import { NoPasskeyOnDevice, passkeyProblem, signPasskeyAssertion } from '../shared/passkey';
import { safeReturnTo } from '../shared/returnTo';
import { readSignup, writeSignup } from './signup/useSignup';

/** The person is gone as far as signing in goes — a retry cannot change any of these. */
const UNAVAILABLE_REASONS = new Set(['BAD_SIGNUP_STATE', 'NO_ACCOUNT', 'USER_NOT_FOUND']);

/** The server has never seen this credential: this phone has a passkey for another account. */
const NO_CREDENTIAL_REASONS = new Set(['CREDENTIAL_NOT_FOUND']);

/**
 * The statuses worth trying again on their own: a cold Cloud Run function, a dropped connection.
 * A network failure that never reached the server becomes `internal`/`UNKNOWN` (`callableFailure`),
 * a cold function answers `deadline-exceeded` or `unavailable`. Everything else is a settled answer.
 */
const TRANSIENT_CODES = new Set(['internal', 'deadline-exceeded', 'unavailable']);

/** Two attempts, so one intermittent cold start is absorbed without the person doing anything. */
const MAX_LOGIN_ATTEMPTS = 2;
const LOGIN_RETRY_BACKOFF_MS = 1_500;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Whether a failure is worth an automatic second try. A user cancel, a phone with no passkey, an
 * account that can never sign in, and a challenge already spent are all settled — retrying only
 * re-prompts for nothing. A transient status is not settled, and each retry mints a fresh
 * challenge, so the retry is idempotent.
 */
function isTransient(failure: unknown): boolean {
  if (passkeyProblem(failure) === 'cancelled') return false;
  if (isNoPasskeyOnDevice(failure)) return false;
  const { code, reason } = callableFailure(failure);
  if (UNAVAILABLE_REASONS.has(reason) || NO_CREDENTIAL_REASONS.has(reason) || reason === 'CHALLENGE_USED') {
    return false;
  }
  return TRANSIENT_CODES.has(code);
}

/**
 * `getPasskeyAccount` throws this before any ceremony starts when nothing is stored here.
 * `instanceof` alone is not enough: a test that mocks the passkey module supplies its own
 * class, and the name is what both the real error and any stand-in agree on.
 */
function isNoPasskeyOnDevice(failure: unknown): boolean {
  if (failure instanceof NoPasskeyOnDevice) return true;
  return typeof failure === 'object' && failure !== null &&
    (failure as { name?: unknown }).name === 'NoPasskeyOnDevice';
}

function message(copy: Copy, failure: unknown): string {
  if (passkeyProblem(failure) === 'cancelled') return copy.login.cancelled;
  if (isNoPasskeyOnDevice(failure)) return copy.login.noPasskey;
  const { reason } = callableFailure(failure);
  if (NO_CREDENTIAL_REASONS.has(reason)) return copy.login.noPasskey;
  if (UNAVAILABLE_REASONS.has(reason)) return copy.login.unavailable;
  return copy.login.failed;
}

/**
 * Signing in is the passkey and nothing else — no email, no password, no recovery phrase
 * (spec 5.1). The server checks the assertion and mints a Firebase token whose claims carry
 * the person and the account; `shared/api/sessionHydrator` reads the session back out of
 * those claims, which is why nothing here sets the session by hand.
 */
export function Login() {
  const copy = useCopy();
  const navigate = useNavigate();
  // Signup sends an already-registered number here with the sentence to show, so the attendee
  // is not dropped on a bare sign-in screen wondering what happened.
  const notice = (useLocation().state as { notice?: string } | null)?.notice;
  // Where a guarded route bounced this person from (`router.tsx` RequireSession), or — when
  // signup sent an already-registered number back here — the target signup was carrying.
  const [params] = useSearchParams();
  const requested = params.get('returnTo') ?? readSignup().next ?? null;
  const returnTo = safeReturnTo(requested, '/tickets');
  const [error, setError] = useState('');

  /** Somebody new has no passkey to sign in with: signup starts at the phone number, and the
   *  target rides along in the signup state so the done screen can put them back. */
  function startSignup(): void {
    writeSignup({ next: requested !== null ? safeReturnTo(requested, '/') : undefined });
    navigate('/signup/phone');
  }
  const [busy, setBusy] = useState(false);

  /**
   * The passkey, the challenge and the verify — retried as a whole on a transient failure, because
   * the challenge cannot be reused and a fresh one needs a fresh signature. A cold start almost
   * always fails on the first call (`loginChallenge`), before the prompt, so the common retry never
   * re-prompts; the spinner stays up across the 1.5s backoff and only a settled or exhausted
   * failure turns into an error and a 다시 시도 button (plan §2b).
   */
  async function run(): Promise<void> {
    setBusy(true);
    setError('');
    for (let attempt = 1; ; attempt += 1) {
      try {
        const { challenge } = await api.loginChallenge({ purpose: 'login' });
        const assertion = await signPasskeyAssertion(challenge);
        const { token } = await api.loginVerify({ assertion });
        await signInWithCustomToken(getFirebaseAuth(), token);
        navigate(returnTo);
        return;
      } catch (failure) {
        if (attempt < MAX_LOGIN_ATTEMPTS && isTransient(failure)) {
          await sleep(LOGIN_RETRY_BACKOFF_MS);
          continue;
        }
        setError(message(copy, failure));
        setBusy(false);
        return;
      }
    }
  }

  return (
    <Screen title={copy.login.title}>
      {notice ? <Alert tone="info">{notice}</Alert> : null}
      <p>{copy.login.body}</p>
      {error ? <Alert tone="error">{error}</Alert> : null}
      {/* Only after the automatic retries have been spent — the whole point is that most cold
          starts never reach here (plan §2b). */}
      {error && !busy ? (
        <Button variant="ghost" onClick={run}>
          {copy.common.retry}
        </Button>
      ) : null}
      {busy ? (
        <div className="working">
          <Spinner />
          {copy.login.working}
        </div>
      ) : null}
      <Button onClick={run} disabled={busy}>
        {copy.login.cta}
      </Button>
      <Button variant="ghost" onClick={startSignup} disabled={busy}>
        {copy.login.signupCta}
      </Button>
    </Screen>
  );
}
