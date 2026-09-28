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
/**
 * How often the one in hand is replaced while this screen is open. Under the server's sixty
 * seconds and comfortably under {@link CHALLENGE_TTL_MS}, so the hand is never found empty by
 * a tap — which is the whole point: a mint that happens inside the tap is the bug this file
 * exists to close.
 */
const CHALLENGE_REFRESH_MS = 40_000;
/** How long a step may run before the screen says so out loud. */
const SLOW_AFTER_MS = 10_000;

/**
 * `registerIdentity` goes through a single attester that sends one registration at a time, so a
 * burst of signups queues behind it and the ones that cannot get a turn come back as
 * `resource-exhausted` / `ATTESTER_BUSY`. That is "the queue is full, come back", not "this
 * failed", so the run waits it out on its own — three times, longer each time — before the
 * screen says a word about it. Only when the queue is still full after all three does the
 * ordinary busy message surface.
 */
const REGISTER_RETRY_DELAYS_MS = [3_000, 6_000, 10_000];

/**
 * The stepper line shown while a busy answer is being waited out. Inlined here rather than added
 * to `shared/copy`: this one screen is the only place a retry is waited out, and the copy files
 * are outside this change's scope.
 */
const REGISTER_BUSY_LINE = '잠시 붐벼요 · 다시 시도 중…';

/** A momentary "the attester is busy", worth waiting out — not a refusal that retrying would loop on. */
function isAttesterBusy(failure: unknown): boolean {
  const { code, reason } = callableFailure(failure);
  return code === 'resource-exhausted' || reason === 'ATTESTER_BUSY';
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/**
 * The registration challenge, minted **before** the tap and kept fresh for as long as the
 * screen is open.
 *
 * `navigator.credentials.create` may only run inside a user gesture, and that gesture's window
 * is short (Chrome allows about five seconds, Safari less). The two screens this one replaced
 * spent that window on a `loginChallenge` round trip — a cold-started function then blew the
 * budget and the browser threw `NotAllowedError`, which the screen reported as "you cancelled
 * it": a sentence about the attendee that was actually about a server.
 *
 * Minting once on arrival is not enough on its own. Somebody who reads the screen for a minute
 * before pressing, or whose phone slept with it open, used to hold a challenge past
 * {@link CHALLENGE_TTL_MS} — and the tap then minted a new one, putting the round trip back
 * exactly where it had been taken out of. So the mint repeats on a timer and whenever the tab
 * comes back, and {@link HeldChallenge.take} never sends anything itself.
 */
interface HeldChallenge {
  /**
   * The challenge in hand, handed over. **Synchronous**: the gesture is spent on the ceremony
   * and on nothing else. `''` means there is none ready, and the caller waits rather than
   * putting a round trip between the tap and `navigator.credentials.create`.
   */
  take: () => string;
  /** The mint already on its way, for the wait an empty {@link take} asks for. */
  wait: () => Promise<string>;
}

function useRegisterChallenge(): HeldChallenge {
  const held = useRef<{ at: number; challenge: string } | null>(null);
  const flight = useRef<Promise<string> | null>(null);

  const mint = useCallback((): Promise<string> => {
    // One at a time. The timer, the tab coming back and a tap can all ask at once, and a
    // second round trip would only throw away the answer the first one is about to give.
    const already = flight.current;
    if (already !== null) return already;
    const run = api.loginChallenge({ purpose: 'register' }).then((answer) => answer.challenge);
    flight.current = run;
    run.then(
      (challenge) => {
        if (flight.current === run) flight.current = null;
        held.current = { at: Date.now(), challenge };
      },
      () => {
        // A challenge that never arrived is not one to hand out, and it is not replayed
        // either: the next ask mints a fresh one. The rejection itself is the caller's.
        if (flight.current === run) flight.current = null;
      },
    );
    return run;
  }, []);

  useEffect(() => {
    const refresh = (): void => { void mint(); };
    refresh();
    const timer = setInterval(refresh, CHALLENGE_REFRESH_MS);
    // A phone that slept through the timer wakes holding one that is already too old, and the
    // person's next act is the tap. Asking on the way back in is what stops that.
    const woken = (): void => {
      if (document.visibilityState === 'visible') refresh();
    };
    document.addEventListener('visibilitychange', woken);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', woken);
    };
  }, [mint]);

  const take = useCallback((): string => {
    const mine = held.current;
    // Single-use on the server, so it is single-use here too.
    held.current = null;
    if (mine !== null && Date.now() - mine.at <= CHALLENGE_TTL_MS) return mine.challenge;
    // Nothing usable in hand — a cold start still answering, or a mint that was refused. One
    // is started so the wait has an end, and **not** awaited: this is still the tap.
    void mint();
    return '';
  }, [mint]);

  const wait = useCallback(async (): Promise<string> => {
    const challenge = await mint();
    // Handed over, like the one above: whichever of the two gives it out, it is given out once.
    if (held.current?.challenge === challenge) held.current = null;
    return challenge;
  }, [mint]);

  return { take, wait };
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
  const registerChallenge = useRegisterChallenge();

  // Somebody sent here with an account already has the first step behind them.
  const [hasPasskey] = useState(() => {
    const stored = readSignup();
    return Boolean(stored.account ?? getSession().account);
  });
  const [step, setStep] = useState<Step>(hasPasskey ? 'device' : 'passkey');
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);
  const [slow, setSlow] = useState(false);
  // The run is up and the challenge is not here yet. It carries on by itself the moment it is.
  const [gettingReady, setGettingReady] = useState(false);
  // A busy answer from the attester is being waited out; the stepper says so and the run resumes
  // by itself. No tap is involved and no error is shown until the retries are spent.
  const [retrying, setRetrying] = useState(false);
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
        // **First, and with nothing awaited in front of it at all.** `take` answers out of the
        // hand the timer keeps full, so `createPasskey` is reached in the same turn as the tap
        // and the gesture is still the browser's to spend on the ceremony.
        let challenge = registerChallenge.take();
        if (challenge === '') {
          // The first mint is still in flight (a cold start), or the last one was refused.
          // Calling the ceremony late would only earn a `NotAllowedError` and the sentence
          // about cancelling that this whole file exists to stop saying — so the screen says
          // it is getting ready instead, and the run resumes on its own the moment the
          // challenge lands. Nobody is asked to press anything a second time.
          setGettingReady(true);
          challenge = await registerChallenge.wait();
          setGettingReady(false);
        }
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
      // A busy attester is not a failure, so the run waits it out and comes back on its own
      // ({@link REGISTER_RETRY_DELAYS_MS}) before the catch below ever surfaces the busy answer.
      for (let attempt = 0; ; attempt += 1) {
        try {
          await api.registerIdentity({ personId, deviceX: x, deviceY: y, platform: platform() });
          break;
        } catch (failure) {
          // `undefined` here means the retries are spent (index past the end); a non-busy
          // answer is a real failure. Either way the catch below gets it.
          const backoff = REGISTER_RETRY_DELAYS_MS[attempt];
          if (backoff === undefined || !isAttesterBusy(failure)) throw failure;
          setRetrying(true);
          await delay(backoff);
          setRetrying(false);
        }
      }
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
      setGettingReady(false);
      setRetrying(false);
      setRunning(false);
    }
  }

  /** What the spinner says: the wait for a challenge, or the step the run has reached. */
  function workingLine(): string {
    if (retrying) return REGISTER_BUSY_LINE;
    if (gettingReady) return copy.signup.challengeWaiting;
    return step === 'passkey' ? copy.signup.passkeyWorking : copy.signup.deviceWorking;
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
          {workingLine()}
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
