import { beforeEach, describe, expect, it, vi } from 'vitest';

// Everything below the module under test is mocked at its own boundary — the Firebase JS SDK
// and the Capacitor plugin — so the verifier lifetime, the three-listener race and the error
// table are exercised for real rather than mocked away with `shared/api/auth` itself.
const clear = vi.fn();
const recaptchaInstances: Array<{ clear: () => void }> = [];
// Records `appVerificationDisabledForTesting` as it stood the instant each verifier was built, so
// a test can prove the E2E bypass is applied *before* construction rather than after.
const verifierDisabledAtConstruction: boolean[] = [];
const RecaptchaVerifier = vi.fn((auth: { settings?: { appVerificationDisabledForTesting?: boolean } }) => {
  verifierDisabledAtConstruction.push(auth.settings?.appVerificationDisabledForTesting === true);
  const instance = { clear };
  recaptchaInstances.push(instance);
  return instance;
});
const signInWithPhoneNumberWeb = vi.fn(async () => ({ verificationId: 'web-vid' }));
const signInWithCredential = vi.fn(async () => ({}));
const credential = vi.fn((verificationId: string, code: string) => ({ verificationId, code }));

const signInAnonymously = vi.fn(async () => ({}));

vi.mock('firebase/auth', () => ({
  RecaptchaVerifier,
  signInAnonymously,
  signInWithPhoneNumber: signInWithPhoneNumberWeb,
  signInWithCredential,
  PhoneAuthProvider: { credential },
}));

const fakeAuth: {
  name: string;
  settings: { appVerificationDisabledForTesting: boolean };
  currentUser: unknown;
  authStateReady: () => Promise<void>;
} = {
  name: 'test-auth',
  settings: { appVerificationDisabledForTesting: false },
  currentUser: null,
  authStateReady: async () => undefined,
};
vi.mock('./firebase', () => ({ getFirebaseAuth: () => fakeAuth }));

const isNativePlatform = vi.fn(() => false);
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform } }));

type Listener = (event: never) => void;
const listeners = new Map<string, Listener>();
const remove = vi.fn(async () => undefined);
const addListener = vi.fn(async (name: string, listener: Listener) => {
  listeners.set(name, listener);
  return { remove };
});
const signInWithPhoneNumberNative = vi.fn(async () => undefined);
const confirmVerificationCode = vi.fn(async () => ({}));

vi.mock('@capacitor-firebase/authentication', () => ({
  FirebaseAuthentication: {
    addListener,
    signInWithPhoneNumber: signInWithPhoneNumberNative,
    confirmVerificationCode,
  },
}));

const {
  INSTANT_VERIFICATION,
  OTP_TIMEOUT_MS,
  RECAPTCHA_CONTAINER_ID,
  confirmOtp,
  phoneAuthProblem,
  resetRecaptcha,
  sendOtp,
} = await import('./auth');

const PHONE = '+821012345678';

/** The race only starts once all three listeners are registered; fire events after this. */
async function listenersReady(): Promise<void> {
  await vi.waitFor(() => {
    if (listeners.size < 3) throw new Error('listeners not registered yet');
  });
}

function fire(name: string, event: unknown): void {
  const listener = listeners.get(name);
  if (!listener) throw new Error(`no listener for ${name}`);
  listener(event as never);
}

beforeEach(() => {
  resetRecaptcha();
  listeners.clear();
  recaptchaInstances.length = 0;
  verifierDisabledAtConstruction.length = 0;
  fakeAuth.settings.appVerificationDisabledForTesting = false;
  window.localStorage.clear();
});

describe('web phone sign-in', () => {
  it('sends through an invisible verifier bound to the screen container', async () => {
    await expect(sendOtp(PHONE)).resolves.toBe('web-vid');
    expect(RecaptchaVerifier).toHaveBeenCalledWith(fakeAuth, RECAPTCHA_CONTAINER_ID, { size: 'invisible' });
    expect(signInWithPhoneNumberWeb).toHaveBeenCalledWith(fakeAuth, PHONE, recaptchaInstances[0]);
  });

  it('builds a new verifier for every send, because a reCAPTCHA token is single-use', async () => {
    await sendOtp(PHONE);
    await sendOtp(PHONE, { resend: true });
    expect(RecaptchaVerifier).toHaveBeenCalledTimes(2);
    expect(recaptchaInstances).toHaveLength(2);
    // The first widget is torn down rather than left holding its spent token.
    expect(clear).toHaveBeenCalledTimes(2);
  });

  it('drops the verifier when the send fails too', async () => {
    signInWithPhoneNumberWeb.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'auth/too-many-requests' }));
    await expect(sendOtp(PHONE)).rejects.toMatchObject({ code: 'auth/too-many-requests' });
    expect(clear).toHaveBeenCalledTimes(1);
  });

  it('confirms by rebuilding the credential from the verification id', async () => {
    await confirmOtp('web-vid', '123456');
    expect(credential).toHaveBeenCalledWith('web-vid', '123456');
    expect(signInWithCredential).toHaveBeenCalledWith(fakeAuth, { verificationId: 'web-vid', code: '123456' });
  });
});

describe('e2e verification bypass', () => {
  const MESSAGE = '[monti] e2e verification bypass on (test numbers only)';

  it('disables app verification before the verifier is built when the opt-in flag is set', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    window.localStorage.setItem('monti:e2e', '1');

    await sendOtp(PHONE);

    // The flag was already true at the moment `new RecaptchaVerifier(auth, …)` ran, so Firebase
    // constructs its mock verifier rather than a live reCAPTCHA it would then ignore.
    expect(verifierDisabledAtConstruction[0]).toBe(true);
    expect(fakeAuth.settings.appVerificationDisabledForTesting).toBe(true);
    expect(info).toHaveBeenCalledWith(MESSAGE);
  });

  it('changes nothing without the flag', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    await sendOtp(PHONE);

    expect(verifierDisabledAtConstruction[0]).toBe(false);
    expect(fakeAuth.settings.appVerificationDisabledForTesting).toBe(false);
    expect(info).not.toHaveBeenCalledWith(MESSAGE);
  });
});

describe('native phone sign-in', () => {
  beforeEach(() => {
    isNativePlatform.mockReturnValue(true);
  });

  it('takes the verification id off phoneCodeSent and confirms with it', async () => {
    const sending = sendOtp(PHONE);
    await listenersReady();
    fire('phoneCodeSent', { verificationId: 'native-vid' });
    await expect(sending).resolves.toBe('native-vid');
    expect(signInWithPhoneNumberNative).toHaveBeenCalledWith({ phoneNumber: PHONE, resendCode: false });
    expect(remove).toHaveBeenCalledTimes(3);
    expect(RecaptchaVerifier).not.toHaveBeenCalled();

    await confirmOtp('native-vid', '123456');
    expect(confirmVerificationCode).toHaveBeenCalledWith({
      verificationId: 'native-vid',
      verificationCode: '123456',
    });
    expect(signInWithCredential).not.toHaveBeenCalled();
  });

  it('reports instant verification as having no code to enter', async () => {
    const sending = sendOtp(PHONE);
    await listenersReady();
    fire('phoneVerificationCompleted', {});
    await expect(sending).resolves.toBe(INSTANT_VERIFICATION);
    expect(remove).toHaveBeenCalledTimes(3);
  });

  it('rejects on phoneVerificationFailed with a message the error table can read', async () => {
    const sending = sendOtp(PHONE, { resend: true });
    await listenersReady();
    fire('phoneVerificationFailed', { message: 'ERROR_INVALID_PHONE_NUMBER' });
    await expect(sending).rejects.toThrow('ERROR_INVALID_PHONE_NUMBER');
    expect(signInWithPhoneNumberNative).toHaveBeenCalledWith({ phoneNumber: PHONE, resendCode: true });
    expect(remove).toHaveBeenCalledTimes(3);
  });

  it('aborts on unmount and removes all three listeners', async () => {
    const controller = new AbortController();
    const sending = sendOtp(PHONE, { signal: controller.signal });
    await listenersReady();
    controller.abort();
    await expect(sending).rejects.toThrow('PHONE_VERIFICATION_ABORTED');
    expect(remove).toHaveBeenCalledTimes(3);
  });

  it('gives up when no event arrives, instead of holding the listeners forever', async () => {
    vi.useFakeTimers();
    // The assertion is attached before time moves: advancing timers awaits, and a rejection
    // delivered with no handler yet would surface as an unhandled rejection.
    const settled = expect(sendOtp(PHONE)).rejects.toThrow('PHONE_VERIFICATION_TIMEOUT');
    await vi.advanceTimersByTimeAsync(OTP_TIMEOUT_MS);
    await settled;
    expect(remove).toHaveBeenCalledTimes(3);
  });
});

describe('failure mapping', () => {
  it.each([
    ['auth/invalid-phone-number', 'invalid-phone'],
    ['auth/operation-not-allowed', 'not-enabled'],
    ['auth/too-many-requests', 'too-many-requests'],
    ['auth/invalid-verification-code', 'wrong-code'],
    ['auth/code-expired', 'code-expired'],
    ['auth/network-request-failed', 'network'],
    ['auth/captcha-check-failed', 'unknown'],
  ])('reads the web SDK code %s as %s', (code, problem) => {
    expect(phoneAuthProblem(Object.assign(new Error(code), { code }))).toBe(problem);
  });

  it('reads the native SCREAMING_SNAKE spelling the same way', () => {
    expect(phoneAuthProblem(new Error('ERROR_SESSION_EXPIRED'))).toBe('code-expired');
    expect(phoneAuthProblem(new Error('ERROR_TOO_MANY_REQUESTS'))).toBe('too-many-requests');
  });

  it('never guesses at something it does not recognise', () => {
    expect(phoneAuthProblem(new Error('PHONE_VERIFICATION_TIMEOUT'))).toBe('unknown');
    expect(phoneAuthProblem(null)).toBe('unknown');
  });
});

describe('ensureFirebaseUser (open mode)', () => {
  it('signs in anonymously when nobody is signed in', async () => {
    const { ensureFirebaseUser } = await import('./auth');
    fakeAuth.currentUser = null;
    signInAnonymously.mockClear();
    expect(await ensureFirebaseUser()).toEqual({ reused: false });
    expect(signInAnonymously).toHaveBeenCalledWith(fakeAuth);
  });

  it('reuses the persisted user (phone or anonymous) rather than minting another', async () => {
    const { ensureFirebaseUser } = await import('./auth');
    fakeAuth.currentUser = { uid: 'kept' };
    signInAnonymously.mockClear();
    expect(await ensureFirebaseUser()).toEqual({ reused: true });
    expect(signInAnonymously).not.toHaveBeenCalled();
    fakeAuth.currentUser = null;
  });
});
