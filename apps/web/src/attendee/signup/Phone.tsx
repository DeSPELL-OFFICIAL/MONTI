import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, Button, Field, Screen } from '../../shared/ui';
import { useCopy } from '../../shared/i18n';
import {
  COUNTRY_CODES,
  DEFAULT_COUNTRY,
  RECAPTCHA_CONTAINER_ID,
  isE164,
  phoneAuthProblem,
  resetRecaptcha,
  sendOtp,
  toE164,
} from '../../shared/api/auth';
import { problemMessage, writeSignup } from './useSignup';

export function Phone() {
  const copy = useCopy();
  const navigate = useNavigate();
  const [country, setCountry] = useState<string>(DEFAULT_COUNTRY);
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // One invisible verifier per visit. Leaving it behind would point a live widget at a
  // container this screen has already taken out of the DOM.
  useEffect(() => resetRecaptcha, []);

  async function submit(): Promise<void> {
    const phoneE164 = toE164(value, country);
    // Checked here rather than by letting Firebase reject: a malformed number costs a round
    // trip and a spent reCAPTCHA challenge, and the answer is already known.
    if (!isE164(phoneE164)) {
      setError(copy.signup.phoneInvalid);
      return;
    }
    setBusy(true);
    setError('');
    try {
      const verificationId = await sendOtp(phoneE164);
      writeSignup({ phoneE164, verificationId });
      navigate('/signup/verify');
    } catch (failure) {
      setError(problemMessage(copy, phoneAuthProblem(failure)));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen title={copy.signup.phoneTitle}>
      <p>{copy.signup.phoneHint}</p>
      <Field label={copy.signup.phoneCountry}>
        <select value={country} onChange={(event) => setCountry(event.target.value)}>
          {COUNTRY_CODES.map((code) => (
            <option key={code} value={code}>
              {code}
            </option>
          ))}
        </select>
      </Field>
      <Field label={copy.signup.phoneTitle}>
        <input
          inputMode="tel"
          autoComplete="tel"
          placeholder={copy.signup.phonePlaceholder}
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
      </Field>
      {error ? <Alert tone="error">{error}</Alert> : null}
      <div id={RECAPTCHA_CONTAINER_ID} />
      <Button onClick={submit} disabled={busy || value.length === 0}>
        {copy.signup.sendCode}
      </Button>
    </Screen>
  );
}
