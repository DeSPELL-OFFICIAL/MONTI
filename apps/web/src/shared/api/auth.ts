// The ONLY file that touches Firebase phone sign-in or @capacitor-firebase/authentication.
//
// Two paths, one reason each:
//   - Web uses the Firebase JS SDK's `signInWithPhoneNumber` with an invisible
//     `RecaptchaVerifier`. A browser has no app attestation, so reCAPTCHA is the only abuse
//     gate there is; the Firebase console decides whether that key is reCAPTCHA Enterprise,
//     and this code is identical either way.
//   - Native uses the plugin because Android's Play-services path can verify a number with no
//     SMS at all (instant verification / auto-retrieval), which is what makes Android free.
//     A web SDK running inside the WebView loses that path and pays for every message.
//
// The plugin's v8 surface is not the one a reader expects: `signInWithPhoneNumber` resolves to
// `void`, and the verification id arrives on the `phoneCodeSent` listener. Shapes come from
// node_modules/@capacitor-firebase/authentication/dist/esm/definitions.d.ts. No casts.
import { Capacitor } from '@capacitor/core';
import { FirebaseAuthentication } from '@capacitor-firebase/authentication';
import {
  PhoneAuthProvider,
  RecaptchaVerifier,
  signInWithCredential,
  signInWithPhoneNumber,
} from 'firebase/auth';
import { getFirebaseAuth } from './firebase';

/** `+` then 7–15 digits, the shape `startSignup` reads off `request.auth.token.phone_number`. */
const E164_RE = /^\+[1-9]\d{6,14}$/;

export const DEFAULT_COUNTRY = '+82';

/** The dial codes the signup screen offers. Dial codes only: a country name would be copy. */
export const COUNTRY_CODES = ['+82', '+1', '+44', '+61', '+65', '+81', '+84', '+86'] as const;

/** The id of the div an invisible reCAPTCHA renders into. Screens use this, never a literal. */
export const RECAPTCHA_CONTAINER_ID = 'recaptcha-container';

/**
 * What `sendOtp` returns when the platform verified the number without sending anything —
 * Android instant verification. There is no code to enter and the user is already signed in.
 */
export const INSTANT_VERIFICATION = '';

/** E.164, defaulting a bare national number to `defaultCountry`. */
export function toE164(input: string, defaultCountry: string = DEFAULT_COUNTRY): string {
  const digits = input.replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) return digits;
  return `${defaultCountry}${digits.replace(/^0/, '')}`;
}

export function isE164(value: string): boolean {
  return E164_RE.test(value);
}

/**
 * Every way phone sign-in can fail that the attendee can act on. The screens turn one of these
 * into a sentence; nothing here is copy, and nothing else in the app reads Firebase error codes.
 */
export type PhoneAuthProblem =
  | 'invalid-phone'
  | 'not-enabled'
  | 'too-many-requests'
  | 'wrong-code'
  | 'code-expired'
  | 'network'
  | 'unknown';

/**
 * The web SDK says `auth/invalid-phone-number`; the Android SDK says
 * `ERROR_INVALID_PHONE_NUMBER`; iOS puts it in the message. Lowercasing and folding `_` to `-`
 * makes one table serve all three, matched on the distinctive middle of the code.
 */
const PROBLEM_PATTERNS: ReadonlyArray<readonly [string, PhoneAuthProblem]> = [
  ['invalid-phone-number', 'invalid-phone'],
  ['missing-phone-number', 'invalid-phone'],
  // Phone sign-in is a per-project switch in the Firebase console. Until it is on, every send
  // fails with this and only this — it must never surface as a generic "something went wrong".
  ['operation-not-allowed', 'not-enabled'],
  ['too-many-requests', 'too-many-requests'],
  ['quota-exceeded', 'too-many-requests'],
  ['invalid-verification-code', 'wrong-code'],
  ['missing-verification-code', 'wrong-code'],
  ['invalid-verification-id', 'code-expired'],
  ['code-expired', 'code-expired'],
  ['session-expired', 'code-expired'],
  ['network-request-failed', 'network'],
  ['network-error', 'network'],
];

function readString(value: unknown, key: string): string {
  if (typeof value !== 'object' || value === null) return '';
  const field = (value as Record<string, unknown>)[key];
  return typeof field === 'string' ? field : '';
}

export function phoneAuthProblem(error: unknown): PhoneAuthProblem {
  const text = `${readString(error, 'code')} ${readString(error, 'message')}`
    .toLowerCase()
    .replace(/_/g, '-');
  for (const [pattern, problem] of PROBLEM_PATTERNS) {
    if (text.includes(pattern)) return problem;
  }
  return 'unknown';
}

let recaptcha: RecaptchaVerifier | null = null;

/**
 * Created on the first send rather than during render: a verifier built in a render body would
 * leak a widget per re-render into the same container.
 */
function verifier(): RecaptchaVerifier {
  recaptcha ??= new RecaptchaVerifier(getFirebaseAuth(), RECAPTCHA_CONTAINER_ID, { size: 'invisible' });
  return recaptcha;
}

/**
 * Drops the widget and the instance. A screen calls this on unmount — a verifier still pointing
 * at a container React has removed can never solve again — and `sendOtp` calls it on failure,
 * because the challenge a failed send consumed cannot be replayed on the retry.
 */
export function resetRecaptcha(): void {
  recaptcha?.clear();
  recaptcha = null;
}

/**
 * Android may settle the whole verification before any SMS goes out, so three listeners race:
 * the code being sent, the number being verified outright, and failure. They are registered
 * before the call that can fire them, and removed however this ends, so a resend never inherits
 * the previous attempt's handlers.
 */
async function sendOtpNative(phoneE164: string, resend: boolean): Promise<string> {
  let settle: (verificationId: string) => void = () => undefined;
  let fail: (error: unknown) => void = () => undefined;
  const outcome = new Promise<string>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  const handles = await Promise.all([
    FirebaseAuthentication.addListener('phoneCodeSent', ({ verificationId }) => settle(verificationId)),
    FirebaseAuthentication.addListener('phoneVerificationCompleted', () => settle(INSTANT_VERIFICATION)),
    FirebaseAuthentication.addListener('phoneVerificationFailed', ({ message }) => fail(new Error(message))),
  ]);
  try {
    await FirebaseAuthentication.signInWithPhoneNumber({ phoneNumber: phoneE164, resendCode: resend });
    return await outcome;
  } finally {
    await Promise.all(handles.map((handle) => handle.remove()));
  }
}

/**
 * Starts phone verification. Resolves with the verification id to confirm against, or
 * `INSTANT_VERIFICATION` when the platform already signed the user in.
 */
export async function sendOtp(phoneE164: string, options: { resend?: boolean } = {}): Promise<string> {
  if (Capacitor.isNativePlatform()) return sendOtpNative(phoneE164, options.resend === true);
  try {
    const confirmation = await signInWithPhoneNumber(getFirebaseAuth(), phoneE164, verifier());
    return confirmation.verificationId;
  } catch (error) {
    resetRecaptcha();
    throw error;
  }
}

/**
 * Confirms the six-digit code. On success the Firebase session carries `phone_number`, which is
 * the only place `startSignup` reads the number from — it is never sent in a request body.
 */
export async function confirmOtp(verificationId: string, code: string): Promise<void> {
  if (Capacitor.isNativePlatform()) {
    await FirebaseAuthentication.confirmVerificationCode({ verificationId, verificationCode: code });
    return;
  }
  // The credential is rebuilt from the id rather than held in a ConfirmationResult, so a reload
  // between the two screens still confirms: the id survives in sessionStorage, the object does not.
  await signInWithCredential(getFirebaseAuth(), PhoneAuthProvider.credential(verificationId, code));
}
