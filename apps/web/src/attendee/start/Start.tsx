import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Alert, Button, Screen, Spinner, Steps } from '../../shared/ui';
import { fmt } from '../../shared/i18n';
import { ATTENDEE_KEY_ALIAS, DeviceKeyUnavailable, ensureDeviceKey } from '../../shared/deviceKey';
import { api, callableFailure } from '../../shared/api/functions';
import { ensureFirebaseUser } from '../../shared/api/auth';
import { markRegistered } from '../../shared/registration';
import { useSession } from '../../shared/session';
import { safeReturnTo } from '../../shared/returnTo';
import { refreshClaims, registerIdentityWithRetry } from '../signup/registerWithRetry';
import type { StartCopy } from './copy';
import { useStartCopy } from './useStartCopy';

type Step = 'create' | 'secure' | 'done';
const STEP_INDEX: Record<Step, number> = { create: 0, secure: 1, done: 2 };

/** How long a step may run before the screen says so out loud. */
const SLOW_AFTER_MS = 10_000;
/**
 * How long the screen waits, after the registration and the token refresh, for the hydrator to
 * read `{ personId, account }` off the new token. Normally one round trip; past this the server
 * did not set the claims, and the visitor gets the error instead of a spinner forever.
 */
export const CLAIMS_WAIT_MS = 15_000;

/** Statuses meaning the person behind this Firebase user still has signup ahead of them. */
const NOT_STARTED = new Set(['none', 'pending']);

/**
 * In open mode these are bugs, not states a visitor can act on (`PASSKEY_REQUIRED` means the
 * backend is still in phone mode), so the code is shown with the sentence.
 */
const SERVER_BUG_REASONS = new Set(['PASSKEY_REQUIRED', 'PHONE_REQUIRED', 'CLAIMS_MISSING']);
const BUSY_REASONS = new Set(['ATTESTER_BUSY', 'REGISTER_IN_FLIGHT', 'ALREADY_SENT']);

/** Matched by name too: a test that mocks the deviceKey module supplies its own class. */
function isDeviceKeyUnavailable(failure: unknown): boolean {
  if (failure instanceof DeviceKeyUnavailable) return true;
  return typeof failure === 'object' && failure !== null &&
    (failure as { name?: unknown }).name === 'DeviceKeyUnavailable';
}

interface Problem {
  text: string;
  code: string;
}

function describe(copy: StartCopy, failure: unknown): Problem {
  if (isDeviceKeyUnavailable(failure)) return { text: copy.noStorage, code: '' };
  const { code, reason } = callableFailure(failure);
  const shown = reason !== '' && /^[A-Z_]+$/.test(reason) ? reason : code;
  if (SERVER_BUG_REASONS.has(reason)) return { text: copy.serverBug, code: reason };
  if (BUSY_REASONS.has(reason) || code === 'resource-exhausted') return { text: copy.busyFailed, code: '' };
  if (code === 'deadline-exceeded' || code === 'unavailable') return { text: copy.slowFailed, code: '' };
  if (code.includes('network-request-failed')) return { text: copy.offline, code: '' };
  return { text: copy.failed, code: shown };
}

/**
 * Open mode's whole signup (`VITE_AUTH_MODE=open`): one tap, no form, no phone, no passkey.
 *
 * The tap reuses whichever Firebase user this browser already has (or signs in anonymously), asks
 * the server for a person (`startSignup`), mints the device key on this browser and registers it
 * (`registerIdentity` — in open mode the server derives the account from that key and writes the
 * `{ personId, account }` claims). The forced token refresh is what hands those claims to the
 * session hydrator, which alone decides "signed in"; the screen then waits for that verdict before
 * leaving, because a guarded `returnTo` would otherwise bounce straight back here.
 *
 * A reused user whose person is already past `pending` (the page was reloaded mid-way) skips to
 * the refresh. A visitor who is already signed in never sees the button at all.
 */
export function Start() {
  const copy = useStartCopy();
  const navigate = useNavigate();
  const session = useSession();
  const target = safeReturnTo(useSearchParams()[0].get('returnTo'), '/');

  const [step, setStep] = useState<Step>('create');
  const [running, setRunning] = useState(false);
  const [finished, setFinished] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [slow, setSlow] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);

  const signedIn = session.status === 'signedIn';

  useEffect(() => {
    if (signedIn && !running) navigate(target, { replace: true });
  }, [signedIn, running, navigate, target]);

  useEffect(() => {
    if (!running) {
      setSlow(false);
      return undefined;
    }
    const timer = setTimeout(() => setSlow(true), SLOW_AFTER_MS);
    return () => clearTimeout(timer);
  }, [running]);

  useEffect(() => {
    if (!finished || signedIn) return undefined;
    const timer = setTimeout(() => {
      setFinished(false);
      setStep('create');
      setProblem({ text: copy.serverBug, code: 'CLAIMS_MISSING' });
    }, CLAIMS_WAIT_MS);
    return () => clearTimeout(timer);
  }, [finished, signedIn, copy]);

  async function run(): Promise<void> {
    setProblem(null);
    setRunning(true);
    setStep('create');
    try {
      const { reused } = await ensureFirebaseUser();
      let active = false;
      if (reused) {
        const { status } = await api.getSignupStatus();
        active = !NOT_STARTED.has(status);
      }
      if (!active) {
        const { personId } = await api.startSignup();
        setStep('secure');
        const { x, y } = await ensureDeviceKey({
          alias: ATTENDEE_KEY_ALIAS,
          requireAuth: true,
          strongBox: true,
        });
        await registerIdentityWithRetry({ personId, deviceX: x, deviceY: y }, setRetrying);
      }
      await refreshClaims();
      // The guard would ask the server the same question; the answer is already known.
      markRegistered();
      setStep('done');
      setFinished(true);
    } catch (failure) {
      setProblem(describe(copy, failure));
    } finally {
      setRetrying(false);
      setRunning(false);
    }
  }

  const labels = [copy.stepCreate, copy.stepSecure, copy.stepDone];
  const busy = running || finished;
  const at = finished ? labels.length : STEP_INDEX[step];

  return (
    <Screen title={copy.title}>
      <p>{copy.subtitle}</p>
      {busy ? <Steps labels={labels} at={at} running={busy} /> : null}
      {problem ? (
        <Alert tone="error">
          {problem.text}
          {problem.code ? <span className="muted"> {fmt(copy.errorCode, { code: problem.code })}</span> : null}
        </Alert>
      ) : null}
      {busy ? (
        <div className="working">
          <Spinner />
          {retrying ? copy.busy : labels[Math.min(at, labels.length - 1)]}
        </div>
      ) : null}
      {running && slow ? <p className="muted">{copy.slow}</p> : null}
      <Button onClick={() => void run()} disabled={busy || session.status === 'loading'}>
        {problem ? copy.retry : copy.cta}
      </Button>
    </Screen>
  );
}
