import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ko } from '../../shared/copy/index';

const PERSON_ID = `0x${'aa'.repeat(32)}`;
const ACCOUNT = `0x${'ab'.repeat(20)}`;
const DEVICE_X = `0x${'11'.repeat(32)}`;
const DEVICE_Y = `0x${'22'.repeat(32)}`;
const CHALLENGE = 'Kioqoyoqkioqoyoqkioqoyoqkioqoyoqkioqoyoq123';

const loginChallenge = vi.fn(async () => ({ challenge: CHALLENGE, expiresAt: 0 }));
const registerPasskey = vi.fn(async () => ({ ok: true as const, account: ACCOUNT, credentialId: 'cred' }));
const registerIdentity = vi.fn(
  async (_payload: { personId: string; deviceX: string; deviceY: string; platform: string }) => ({
    txHash: '0xtx',
  }),
);
// Partial: `callableFailure` reads a rejection's shape and is exercised, not stubbed.
vi.mock('../../shared/api/functions', async (orig) => ({
  ...(await orig<typeof import('../../shared/api/functions')>()),
  api: { loginChallenge, registerPasskey, registerIdentity },
}));

const createPasskey = vi.fn(async () => ({
  id: 'cred',
  publicKey: `0x04${'cd'.repeat(64)}`,
  transports: ['internal'],
  attestationJson: '{"id":"cred","type":"public-key"}',
}));
vi.mock('../../shared/passkey', async (orig) => ({
  ...(await orig<typeof import('../../shared/passkey')>()),
  createPasskey,
}));

/** The real error: a browser has no non-syncing hardware key, and the name is the contract. */
class DeviceKeyUnavailable extends Error {
  constructor() {
    super('DeviceKeyUnavailable');
    this.name = 'DeviceKeyUnavailable';
  }
}
const ensureDeviceKey = vi.fn(async () => ({ x: DEVICE_X, y: DEVICE_Y, backing: 'secureEnclave' }));
vi.mock('../../shared/deviceKey', () => ({
  ensureDeviceKey,
  ATTENDEE_KEY_ALIAS: 'monti-attendee',
  DeviceKeyUnavailable,
}));

const saveUserProfile = vi.fn(async (_patch: { displayName?: string }) => undefined);
vi.mock('../../shared/api/firestore', async (orig) => ({
  ...(await orig<typeof import('../../shared/api/firestore')>()),
  saveUserProfile,
}));

/** The hydrator reads the claims out of a fresh token; the screen only asks for one. */
const getIdToken = vi.fn(async (_force?: boolean) => 'id-token');
vi.mock('../../shared/api/firebase', () => ({
  getFirebaseAuth: () => ({ currentUser: { getIdToken } }),
}));

const getPlatform = vi.fn(() => 'ios');
vi.mock('@capacitor/core', () => ({ Capacitor: { getPlatform: () => getPlatform(), isNativePlatform: () => true } }));

const navigate = vi.fn();
vi.mock('react-router-dom', async (orig) => ({
  ...(await orig<typeof import('react-router-dom')>()),
  useNavigate: () => navigate,
}));

const { Register } = await import('./Register');
const { Done } = await import('./Done');
const { readSignup } = await import('./useSignup');
const { getSession, setSession } = await import('../../shared/session');
const { MAX_DISPLAY_NAME_CHARS } = await import('../../shared/api/firestore');

/** Every screen here resumes from what the step before it left in sessionStorage. */
function seedSignup(state: Record<string, unknown>): void {
  sessionStorage.setItem('monti.signup', JSON.stringify(state));
}

function renderScreen(element: React.ReactElement, at = '/signup/register') {
  return render(<MemoryRouter initialEntries={[at]}>{element}</MemoryRouter>);
}

/** The one button this screen has, whatever it says on it. */
function start(): HTMLElement {
  return screen.getByRole('button', { name: ko.signup.registerCta });
}

/** A callable rejection: an uppercase reason in `message`, the gRPC status in `code`. */
function callableError(code: string, reason: string): Error {
  return Object.assign(new Error(reason), { code });
}

beforeEach(() => {
  sessionStorage.clear();
  setSession({ status: 'anonymous' });
  getPlatform.mockReturnValue('ios');
});

afterEach(() => {
  vi.useRealTimers();
});

/**
 * The founder's first complaint: the face scan was followed by a second screen with a second
 * button. Only the passkey needs the gesture, so everything after it is chained onto the same
 * tap and the three dots say where the run has got to.
 */
describe('register · one screen, one tap', () => {
  beforeEach(() => seedSignup({ personId: PERSON_ID }));

  it('shows the three steps in order, with the first one in hand', () => {
    renderScreen(<Register />);
    const steps = screen.getAllByRole('listitem').map((item) => item.textContent);
    expect(steps).toEqual([ko.signup.stepPasskey, ko.signup.stepDevice, ko.signup.stepDone]);
    expect(screen.getByText(ko.signup.stepPasskey).closest('li')).toHaveAttribute('aria-current', 'step');
  });

  it('makes the passkey and registers this phone off a single tap', async () => {
    renderScreen(<Register />);
    await userEvent.click(start());

    await waitFor(() => expect(registerIdentity).toHaveBeenCalled());
    // A locally invented challenge is rejected by the server, so the minted one has to travel.
    expect(createPasskey).toHaveBeenCalledWith('MONTI', CHALLENGE);
    expect(registerPasskey).toHaveBeenCalledWith({
      personId: PERSON_ID,
      attestation: { id: 'cred', type: 'public-key' },
    });
    expect(readSignup().account).toBe(ACCOUNT);
    expect(ensureDeviceKey).toHaveBeenCalledWith({
      alias: 'monti-attendee',
      requireAuth: true,
      strongBox: true,
    });
    expect(registerIdentity).toHaveBeenCalledWith({
      personId: PERSON_ID,
      deviceX: DEVICE_X,
      deviceY: DEVICE_Y,
      platform: 'ios',
    });
    // Signing in is the hydrator's call, not this screen's: it reads `{ personId, account }`
    // off the Firebase token, so all the screen may do is ask for a fresh one.
    expect(getIdToken).toHaveBeenCalledWith(true);
    expect(getSession().status).toBe('anonymous');
    expect(navigate).toHaveBeenCalledWith('/signup/done');
    // One tap, and no screen in between: `/signup/device` is never navigated to again.
    expect(navigate).not.toHaveBeenCalledWith('/signup/device');
  });

  /**
   * The gesture-window bug the two screens carried (plan section C-1). `loginChallenge` used to
   * run *inside* the tap; a cold-started function then spent the browser's five seconds and the
   * ceremony threw `NotAllowedError`, which the screen reported as "you cancelled it".
   */
  it('mints the challenge on arrival, so the tap goes straight to the authenticator', async () => {
    renderScreen(<Register />);
    await waitFor(() => expect(loginChallenge).toHaveBeenCalledWith({ purpose: 'register' }));
    expect(createPasskey).not.toHaveBeenCalled();

    loginChallenge.mockClear();
    await userEvent.click(start());
    await waitFor(() => expect(createPasskey).toHaveBeenCalled());
    // The tap asked the server for nothing: the answer was already in hand.
    expect(loginChallenge).not.toHaveBeenCalled();
  });

  it('walks the dots from the lock to this phone as the run goes on', async () => {
    let letDeviceKeyGo = (): void => undefined;
    ensureDeviceKey.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { letDeviceKeyGo = resolve; });
      return { x: DEVICE_X, y: DEVICE_Y, backing: 'secureEnclave' };
    });
    renderScreen(<Register />);
    await userEvent.click(start());

    await waitFor(() =>
      expect(screen.getByText(ko.signup.stepDevice).closest('li')).toHaveAttribute('aria-current', 'step'));
    expect(screen.getByText(ko.signup.deviceWorking)).toBeInTheDocument();
    letDeviceKeyGo();
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/signup/done'));
  });

  /**
   * `registerIdentity` waits for finality and can take thirty seconds. A percentage bar over a
   * wait nobody can predict is a lie, so the screen says one sentence instead — and only after
   * ten seconds, because saying it straight away would make every ordinary run look broken.
   */
  it('says nothing about the wait until ten seconds have actually passed', async () => {
    vi.useFakeTimers();
    // Held open on purpose: the sentence belongs to a run that is still going.
    ensureDeviceKey.mockImplementationOnce(() => new Promise(() => undefined));
    renderScreen(<Register />);
    // `fireEvent` rather than `userEvent`, which schedules waits of its own on the same clock.
    await act(async () => { fireEvent.click(start()); });
    await act(async () => { vi.advanceTimersByTime(0); });
    expect(ensureDeviceKey).toHaveBeenCalled();

    await act(async () => { vi.advanceTimersByTime(9_000); });
    expect(screen.queryByText(ko.signup.registerSlow)).toBeNull();

    await act(async () => { vi.advanceTimersByTime(1_500); });
    expect(screen.getByText(ko.signup.registerSlow)).toBeInTheDocument();
  });

  it('says the ceremony was cancelled and never calls the server', async () => {
    createPasskey.mockRejectedValueOnce(
      Object.assign(new Error('failed'), { cause: Object.assign(new Error('x'), { name: 'NotAllowedError' }) }),
    );
    renderScreen(<Register />);
    await userEvent.click(start());

    expect(await screen.findByRole('alert')).toHaveTextContent('잠금 설정을 취소했어요. 다시 시도해 주세요.');
    expect(registerPasskey).not.toHaveBeenCalled();
    expect(ensureDeviceKey).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    // The button now offers the run again rather than pretending nothing happened.
    expect(screen.getByRole('button', { name: ko.signup.registerRetry })).toBeEnabled();
  });

  it('sends an account that already has a passkey to sign-in instead of failing', async () => {
    registerPasskey.mockRejectedValueOnce(callableError('already-exists', 'PASSKEY_ALREADY_REGISTERED'));
    renderScreen(<Register />);
    await userEvent.click(start());

    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith('/login', {
        replace: true,
        state: { notice: '이미 가입된 번호예요. 로그인해 주세요.' },
      }),
    );
  });

  it('refuses to start without the person the phone step produced', async () => {
    sessionStorage.clear();
    renderScreen(<Register />);
    await userEvent.click(start());

    expect(await screen.findByRole('alert')).toHaveTextContent('가입을 처음부터 다시 해 주세요.');
    expect(createPasskey).not.toHaveBeenCalled();
    expect(ensureDeviceKey).not.toHaveBeenCalled();
  });
});

describe('register · the phone half', () => {
  beforeEach(() => seedSignup({ personId: PERSON_ID, account: ACCOUNT }));

  /** An account already carries the first step, so the tap starts at the second one. */
  it('skips the passkey when the account is already there', async () => {
    renderScreen(<Register />);
    expect(screen.getByText(ko.signup.stepDevice).closest('li')).toHaveAttribute('aria-current', 'step');

    await userEvent.click(start());
    await waitFor(() => expect(registerIdentity).toHaveBeenCalled());
    expect(createPasskey).not.toHaveBeenCalled();
    expect(registerPasskey).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith('/signup/done');
  });

  it('treats alreadyRegistered as a finished signup, not a failure', async () => {
    registerIdentity.mockResolvedValueOnce({ alreadyRegistered: true } as never);
    renderScreen(<Register />);
    await userEvent.click(start());

    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/signup/done'));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(getIdToken).toHaveBeenCalledWith(true);
  });

  it('finishes signup even when the token refresh fails, because registration already landed', async () => {
    getIdToken.mockRejectedValueOnce(new Error('network'));
    renderScreen(<Register />);
    await userEvent.click(start());

    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/signup/done'));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  /**
   * The bug this step exists to close: a browser used to throw at `ensureDeviceKey` and skip
   * `registerIdentity` altogether, so every web attendee finished signup as `pending` — which
   * is exactly what `startKyc` and every claim refuse. The browser now registers a key of its
   * own and takes the same path a phone takes.
   */
  it('registers the browser key on chain instead of skipping registration', async () => {
    getPlatform.mockReturnValue('web');
    renderScreen(<Register />);
    await userEvent.click(start());

    await waitFor(() =>
      expect(registerIdentity).toHaveBeenCalledWith({
        personId: PERSON_ID,
        deviceX: DEVICE_X,
        deviceY: DEVICE_Y,
        platform: 'web',
      }),
    );
    // The skip button belongs to a browser that cannot make a key at all, not to every browser.
    expect(screen.queryByRole('button', { name: '이대로 계속하기' })).toBeNull();
    expect(navigate).toHaveBeenCalledWith('/signup/done');
  });

  it('tells a browser that the gate is an app thing, and says nothing of the sort on a phone', async () => {
    getPlatform.mockReturnValue('web');
    const { unmount } = renderScreen(<Register />);
    expect(screen.getByText(ko.signup.deviceWebNote)).toBeInTheDocument();

    unmount();
    getPlatform.mockReturnValue('android');
    renderScreen(<Register />);
    expect(screen.queryByText(ko.signup.deviceWebNote)).toBeNull();
  });

  it('asks the attendee to try again when the attester is busy, and succeeds on the retry', async () => {
    registerIdentity.mockRejectedValueOnce(callableError('resource-exhausted', 'ATTESTER_BUSY'));
    renderScreen(<Register />);
    await userEvent.click(start());

    expect(await screen.findByRole('alert')).toHaveTextContent('지금 처리가 밀려 있어요. 잠시 뒤 다시 눌러 주세요.');
    expect(navigate).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: ko.signup.registerRetry }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/signup/done'));
  });

  it('lets a phone with no secure chip finish signup and explains the entry path', async () => {
    ensureDeviceKey.mockRejectedValueOnce(new DeviceKeyUnavailable());
    renderScreen(<Register />);
    await userEvent.click(start());

    // The same sentence the entry screen shows, read from the copy rather than repeated here:
    // a phone that cannot sign cannot produce the code either, so there is nothing to offer.
    expect(await screen.findByRole('status')).toHaveTextContent(ko.enter.deviceUnavailable);
    expect(registerIdentity).not.toHaveBeenCalled();
    // Retrying cannot help, so the only button left finishes signup without a hardware key.
    await userEvent.click(screen.getByRole('button', { name: '이대로 계속하기' }));
    expect(navigate).toHaveBeenCalledWith('/signup/done');
    // Nothing was registered, so nothing may claim a session either.
    expect(getSession().status).toBe('anonymous');
  });

  /**
   * The founder's own account: signup finished on a browser months of bugs ago and stopped at
   * `pending`, so `startKyc` and every claim refuse it. The router's guard sends that person
   * here with where they were going, and none of the sessionStorage signup state survives —
   * the claims are all there is.
   */
  describe('finishing an account that stayed pending', () => {
    beforeEach(() => {
      sessionStorage.clear();
      setSession({ status: 'signedIn', personId: PERSON_ID, account: ACCOUNT as `0x${string}` });
    });

    it('registers with the identity from the session and goes back where the person was headed', async () => {
      renderScreen(<Register />, '/signup/register?returnTo=%2Fme%2Fverify');
      expect(screen.getByRole('status')).toHaveTextContent(ko.signup.finishPending);

      await userEvent.click(start());

      await waitFor(() =>
        expect(registerIdentity).toHaveBeenCalledWith({
          personId: PERSON_ID,
          deviceX: DEVICE_X,
          deviceY: DEVICE_Y,
          platform: 'ios',
        }),
      );
      // The account is on the claims, so nothing asks this person for a second passkey.
      expect(createPasskey).not.toHaveBeenCalled();
      expect(navigate).toHaveBeenCalledWith('/me/verify', { replace: true });
      expect(navigate).not.toHaveBeenCalledWith('/signup/done');
    });

    it('lands on the explore tab when there was nowhere in particular to go back to', async () => {
      renderScreen(<Register />, '/signup/register?returnTo=');
      await userEvent.click(start());

      await waitFor(() => expect(navigate).toHaveBeenCalledWith('/', { replace: true }));
    });

    it('says nothing about finishing when this is an ordinary last step', async () => {
      seedSignup({ personId: PERSON_ID, account: ACCOUNT });
      renderScreen(<Register />);
      expect(screen.queryByText(ko.signup.finishPending)).toBeNull();
    });
  });
});

describe('done screen', () => {
  beforeEach(() => seedSignup({ personId: PERSON_ID, account: ACCOUNT }));

  it('drops the leftover signup state and goes home', async () => {
    renderScreen(<Done />);
    await userEvent.click(screen.getByRole('button', { name: ko.signup.doneCta }));

    expect(sessionStorage.getItem('monti.signup')).toBeNull();
    expect(navigate).toHaveBeenCalledWith('/');
  });

  /** The name a ticket is drawn with. Its own field — the chain nickname cannot hold `김태완`. */
  it('saves the name this person gave before going on', async () => {
    renderScreen(<Done />);
    await userEvent.type(screen.getByRole('textbox'), '  김태완  ');
    await userEvent.click(screen.getByRole('button', { name: ko.signup.doneCta }));

    await waitFor(() => expect(saveUserProfile).toHaveBeenCalledWith({ displayName: '김태완' }));
    expect(navigate).toHaveBeenCalledWith('/');
  });

  /**
   * `users/{uid}` is written under a rule that measures this field (`displayName is string &&
   * size() <= 24`), and the rule refuses the **whole document** rather than one key — so a
   * twenty-fifth character would not be a message under the box, it would be a save that never
   * happens, on the last screen of signing up.
   */
  it('stops the name where the security rule stops it', async () => {
    renderScreen(<Done />);
    const box = screen.getByRole('textbox');
    expect(box).toHaveAttribute('maxlength', String(MAX_DISPLAY_NAME_CHARS));
    expect(MAX_DISPLAY_NAME_CHARS).toBe(24);

    await userEvent.type(box, 'ㄱ'.repeat(30));
    await userEvent.click(screen.getByRole('button', { name: ko.signup.doneCta }));
    await waitFor(() => expect(saveUserProfile).toHaveBeenCalled());
    const sent = saveUserProfile.mock.calls[0]?.[0]?.displayName ?? '';
    expect([...sent]).toHaveLength(24);
  });

  it('writes nothing at all when the name is left blank, and still finishes', async () => {
    renderScreen(<Done />);
    await userEvent.click(screen.getByRole('button', { name: ko.signup.doneCta }));

    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/'));
    expect(saveUserProfile).not.toHaveBeenCalled();
  });

  /** Signing up is over either way: a refused write must not hold anybody on this screen. */
  it('finishes even when the name could not be saved', async () => {
    saveUserProfile.mockRejectedValueOnce(new Error('permission-denied'));
    renderScreen(<Done />);
    await userEvent.type(screen.getByRole('textbox'), '김태완');
    await userEvent.click(screen.getByRole('button', { name: ko.signup.doneCta }));

    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/'));
  });
});
