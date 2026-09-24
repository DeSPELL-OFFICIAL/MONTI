import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, Button, Countdown, Field, Screen, Spinner } from '../../shared/ui';
import { fmt, useCopy } from '../../shared/i18n';
import {
  INSTANT_VERIFICATION,
  RECAPTCHA_CONTAINER_ID,
  confirmOtp,
  phoneAuthProblem,
  resetRecaptcha,
  sendOtp,
} from '../../shared/api/auth';
import { finishSignup, isAlreadyRegistered, problemMessage, readSignup, writeSignup } from './useSignup';

const CODE_LENGTH = 6;

/** Firebase's own resend guidance, and the window the SMS itself is worth. */
const RESEND_COOLDOWN_SECONDS = 60;

export function Verify() {
  const copy = useCopy();
  const navigate = useNavigate();
  const [signup, setSignup] = useState(readSignup);
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [cooling, setCooling] = useState(true);
  // Android can verify without ever sending a code; there is then nothing to type and the
  // session already exists, so this screen only has the backend half left to do.
  const instant = signup.verificationId === INSTANT_VERIFICATION;
  const autoRan = useRef(false);
  // The six digits are single-use. Once they have been spent successfully, a retry of this
  // screen's work must never send them again — see `finish`.
  const confirmed = useRef(false);
  const aborter = useRef<AbortController | null>(null);

  // A resend on the web needs its own invisible verifier, rendered into this screen's container;
  // a native resend needs its listener race cancelled when the screen goes away.
  useEffect(() => {
    const controller = new AbortController();
    aborter.current = controller;
    return () => {
      controller.abort();
      resetRecaptcha();
    };
  }, []);

  async function finish(): Promise<void> {
    setBusy(true);
    setError('');
    // True once the phone session exists — the code was accepted, or was never needed. A retry
    // then resumes at startSignup instead of re-sending digits the server has already burnt.
    const spent = instant || confirmed.current;
    try {
      if (!spent) {
        await confirmOtp(signup.verificationId ?? '', code);
        confirmed.current = true;
      }
      // Creates persons/{personId} and users/{uid} from the number in the phone session.
      await finishSignup();
      navigate('/signup/register');
    } catch (failure) {
      if (isAlreadyRegistered(failure)) {
        navigate('/login', { replace: true, state: { notice: copy.signup.alreadyRegistered } });
        return;
      }
      // A callable rejection carries an uppercase reason code, not a phone-auth code. Showing
      // `codeWrong` for it would blame the digits for the server's answer.
      setError(confirmed.current || instant ? copy.common.error : problemMessage(copy, phoneAuthProblem(failure)));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!instant || autoRan.current) return;
    autoRan.current = true;
    // Runs once, the moment this screen learns the platform already verified the number.
    void finish();
  }, [instant]);

  async function resend(): Promise<void> {
    if (!signup.phoneE164) return;
    setBusy(true);
    setError('');
    try {
      const verificationId = await sendOtp(signup.phoneE164, {
        resend: true,
        signal: aborter.current?.signal,
      });
      writeSignup({ verificationId });
      setSignup((previous) => ({ ...previous, verificationId }));
      // A new code replaces the old one, so the "already spent" latch drops with it.
      confirmed.current = false;
      setCode('');
      setCooling(true);
    } catch (failure) {
      setError(problemMessage(copy, phoneAuthProblem(failure)));
    } finally {
      setBusy(false);
    }
  }

  if (instant) {
    return (
      <Screen title={copy.signup.codeTitle}>
        {error ? <Alert tone="error">{error}</Alert> : <Spinner />}
      </Screen>
    );
  }

  return (
    <Screen title={copy.signup.codeTitle}>
      <p>{fmt(copy.signup.codeSentTo, { phone: signup.phoneE164 ?? '' })}</p>
      <Field label={copy.signup.codeTitle}>
        <input
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={CODE_LENGTH}
          value={code}
          onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
        />
      </Field>
      {error ? <Alert tone="error">{error}</Alert> : null}
      <div id={RECAPTCHA_CONTAINER_ID} />
      {cooling ? (
        <div className="resend">
          <Countdown seconds={RESEND_COOLDOWN_SECONDS} onExpire={() => setCooling(false)} />
          {copy.signup.codeResendWait}
        </div>
      ) : (
        <Button variant="ghost" onClick={resend} disabled={busy}>
          {copy.signup.codeResend}
        </Button>
      )}
      <Button onClick={finish} disabled={busy || code.length !== CODE_LENGTH}>
        {copy.signup.verifyCta}
      </Button>
    </Screen>
  );
}
