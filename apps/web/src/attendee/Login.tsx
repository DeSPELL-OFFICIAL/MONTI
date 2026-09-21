import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { signInWithCustomToken } from 'firebase/auth';
import { Alert, Button, Screen, Spinner } from '../shared/ui';
import { useCopy } from '../shared/i18n';
import type { Copy } from '../shared/copy/index';
import { api, callableFailure } from '../shared/api/functions';
import { getFirebaseAuth } from '../shared/api/firebase';
import { passkeyProblem, signPasskeyAssertion } from '../shared/passkey';

/** The person is gone as far as signing in goes — a retry cannot change any of these. */
const UNAVAILABLE_REASONS = new Set(['BAD_SIGNUP_STATE', 'NO_ACCOUNT', 'USER_NOT_FOUND']);

/** The server has never seen this credential: this phone has a passkey for another account. */
const NO_CREDENTIAL_REASONS = new Set(['CREDENTIAL_NOT_FOUND']);

function message(copy: Copy, failure: unknown): string {
  if (passkeyProblem(failure) === 'cancelled') return copy.login.cancelled;
  // getPasskeyAccount throws this before any ceremony starts when nothing is stored here.
  if (failure instanceof Error && failure.message === 'No passkey on this device') {
    return copy.login.noPasskey;
  }
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
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function run(): Promise<void> {
    setBusy(true);
    setError('');
    try {
      const { challenge } = await api.loginChallenge({ purpose: 'login' });
      const assertion = await signPasskeyAssertion(challenge);
      const { token } = await api.loginVerify({ assertion });
      await signInWithCustomToken(getFirebaseAuth(), token);
      navigate('/tickets');
    } catch (failure) {
      setError(message(copy, failure));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen title={copy.login.title}>
      {notice ? <Alert tone="info">{notice}</Alert> : null}
      <p>{copy.login.body}</p>
      {error ? <Alert tone="error">{error}</Alert> : null}
      {busy ? (
        <div className="working">
          <Spinner />
          {copy.login.working}
        </div>
      ) : null}
      <Button onClick={run} disabled={busy}>
        {copy.login.cta}
      </Button>
    </Screen>
  );
}
