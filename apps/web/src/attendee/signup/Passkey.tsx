import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, Button, Screen, Spinner } from '../../shared/ui';
import { useCopy } from '../../shared/i18n';
import type { Copy } from '../../shared/copy/index';
import { RP_NAME, createPasskey, passkeyProblem } from '../../shared/passkey';
import { api, callableFailure } from '../../shared/api/functions';
import { readSignup, writeSignup } from './useSignup';

/** The server's own words for "this signup cannot continue"; retrying the step would loop. */
const RESTART_REASONS = new Set([
  'PERSON_MISMATCH',
  'PERSON_NOT_FOUND',
  'BAD_PERSON_ID',
  'BAD_SIGNUP_STATE',
  'AUTH_REQUIRED',
]);

/** The challenge lives 60 seconds and is single-use, so a slow ceremony just starts over. */
const CHALLENGE_REASONS = new Set([
  'CHALLENGE_NOT_FOUND',
  'CHALLENGE_USED',
  'CHALLENGE_EXPIRED',
  'BAD_CHALLENGE',
]);

/** The account already has a passkey — this person signs in, they do not register again. */
function isAlreadyLocked(reason: string): boolean {
  return reason === 'PASSKEY_ALREADY_REGISTERED' || reason === 'CREDENTIAL_EXISTS';
}

function message(copy: Copy, failure: unknown): string {
  const problem = passkeyProblem(failure);
  if (problem === 'cancelled') return copy.signup.passkeyCancelled;
  if (problem === 'unsupported') return copy.signup.passkeyUnsupported;
  const { reason } = callableFailure(failure);
  if (RESTART_REASONS.has(reason)) return copy.signup.restart;
  if (CHALLENGE_REASONS.has(reason)) return copy.signup.retryStep;
  return copy.signup.passkeyFailed;
}

/**
 * Signup step 2 of 3. The passkey is the account: the server verifies the attestation, derives
 * the smart account address from the new public key, and hands it back. Nothing to memorise
 * and nothing to write down — the only secret is the one the secure chip holds.
 */
export function PasskeyStep() {
  const copy = useCopy();
  const navigate = useNavigate();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function run(): Promise<void> {
    const { personId } = readSignup();
    // Nothing to attach a passkey to. Sending an empty id would come back as BAD_PERSON_ID.
    if (!personId) {
      setError(copy.signup.restart);
      return;
    }
    setBusy(true);
    setError('');
    try {
      // The server only accepts an attestation over a challenge it minted for registration.
      const { challenge } = await api.loginChallenge({ purpose: 'register' });
      const credential = await createPasskey(RP_NAME, challenge);
      const { account } = await api.registerPasskey({
        personId,
        attestation: JSON.parse(credential.attestationJson) as unknown,
      });
      // The address the rules check and the chain will hold. Deriving it again locally would
      // be a second source of truth that can silently disagree with the server's.
      writeSignup({ account });
      navigate('/signup/device');
    } catch (failure) {
      if (isAlreadyLocked(callableFailure(failure).reason)) {
        navigate('/login', { replace: true, state: { notice: copy.signup.alreadyRegistered } });
        return;
      }
      setError(message(copy, failure));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen title={copy.signup.passkeyTitle}>
      <p>{copy.signup.passkeyBody}</p>
      {error ? <Alert tone="error">{error}</Alert> : null}
      {busy ? (
        <div className="working">
          <Spinner />
          {copy.signup.passkeyWorking}
        </div>
      ) : null}
      <Button onClick={run} disabled={busy}>
        {copy.signup.passkeyCta}
      </Button>
    </Screen>
  );
}
