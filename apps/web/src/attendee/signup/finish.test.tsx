import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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

const { PasskeyStep } = await import('./Passkey');
const { DeviceStep } = await import('./Device');
const { Done } = await import('./Done');
const { readSignup } = await import('./useSignup');
const { getSession, setSession } = await import('../../shared/session');

/** Every screen here resumes from what the step before it left in sessionStorage. */
function seedSignup(state: Record<string, unknown>): void {
  sessionStorage.setItem('monti.signup', JSON.stringify(state));
}

function renderScreen(element: React.ReactElement, at = '/signup/device') {
  return render(<MemoryRouter initialEntries={[at]}>{element}</MemoryRouter>);
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

describe('passkey step', () => {
  it('registers a passkey against a server challenge and keeps the account the server derived', async () => {
    seedSignup({ personId: PERSON_ID });
    renderScreen(<PasskeyStep />);
    await userEvent.click(screen.getByRole('button', { name: '잠금 설정하기' }));

    await waitFor(() => expect(registerPasskey).toHaveBeenCalled());
    expect(loginChallenge).toHaveBeenCalledWith({ purpose: 'register' });
    // A locally invented challenge is rejected by the server, so the minted one has to travel.
    expect(createPasskey).toHaveBeenCalledWith('MONTI', CHALLENGE);
    expect(registerPasskey).toHaveBeenCalledWith({
      personId: PERSON_ID,
      attestation: { id: 'cred', type: 'public-key' },
    });
    expect(readSignup().account).toBe(ACCOUNT);
    expect(navigate).toHaveBeenCalledWith('/signup/device');
  });

  it('says the ceremony was cancelled and never calls the server', async () => {
    seedSignup({ personId: PERSON_ID });
    createPasskey.mockRejectedValueOnce(
      Object.assign(new Error('failed'), { cause: Object.assign(new Error('x'), { name: 'NotAllowedError' }) }),
    );
    renderScreen(<PasskeyStep />);
    await userEvent.click(screen.getByRole('button', { name: '잠금 설정하기' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('잠금 설정을 취소했어요. 다시 시도해 주세요.');
    expect(registerPasskey).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('sends an account that already has a passkey to sign-in instead of failing', async () => {
    seedSignup({ personId: PERSON_ID });
    registerPasskey.mockRejectedValueOnce(callableError('already-exists', 'PASSKEY_ALREADY_REGISTERED'));
    renderScreen(<PasskeyStep />);
    await userEvent.click(screen.getByRole('button', { name: '잠금 설정하기' }));

    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith('/login', {
        replace: true,
        state: { notice: '이미 가입된 번호예요. 로그인해 주세요.' },
      }),
    );
  });
});

describe('device step', () => {
  beforeEach(() => seedSignup({ personId: PERSON_ID, account: ACCOUNT }));

  it('registers the hardware key on chain and lands on the done screen', async () => {
    renderScreen(<DeviceStep />);
    await userEvent.click(screen.getByRole('button', { name: '등록하기' }));

    await waitFor(() => expect(registerIdentity).toHaveBeenCalled());
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
  });

  it('treats alreadyRegistered as a finished signup, not a failure', async () => {
    registerIdentity.mockResolvedValueOnce({ alreadyRegistered: true } as never);
    renderScreen(<DeviceStep />);
    await userEvent.click(screen.getByRole('button', { name: '등록하기' }));

    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/signup/done'));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(getIdToken).toHaveBeenCalledWith(true);
  });

  it('finishes signup even when the token refresh fails, because registration already landed', async () => {
    getIdToken.mockRejectedValueOnce(new Error('network'));
    renderScreen(<DeviceStep />);
    await userEvent.click(screen.getByRole('button', { name: '등록하기' }));

    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/signup/done'));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('reports a desktop browser as the web platform', async () => {
    getPlatform.mockReturnValue('web');
    renderScreen(<DeviceStep />);
    await userEvent.click(screen.getByRole('button', { name: '등록하기' }));

    await waitFor(() => expect(registerIdentity).toHaveBeenCalled());
    expect(registerIdentity.mock.calls[0]![0]).toMatchObject({ platform: 'web' });
  });

  /**
   * The bug this step exists to close: a browser used to throw at `ensureDeviceKey` and skip
   * `registerIdentity` altogether, so every web attendee finished signup as `pending` — which
   * is exactly what `startKyc` and every claim refuse. The browser now registers a key of its
   * own and takes the same path a phone takes.
   */
  it('registers the browser key on chain instead of skipping registration', async () => {
    getPlatform.mockReturnValue('web');
    renderScreen(<DeviceStep />);
    await userEvent.click(screen.getByRole('button', { name: '등록하기' }));

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
    const { unmount } = renderScreen(<DeviceStep />);
    expect(screen.getByText(ko.signup.deviceWebNote)).toBeInTheDocument();

    unmount();
    getPlatform.mockReturnValue('android');
    renderScreen(<DeviceStep />);
    expect(screen.queryByText(ko.signup.deviceWebNote)).toBeNull();
  });

  it('asks the attendee to try again when the attester is busy, and succeeds on the retry', async () => {
    registerIdentity.mockRejectedValueOnce(callableError('resource-exhausted', 'ATTESTER_BUSY'));
    renderScreen(<DeviceStep />);
    await userEvent.click(screen.getByRole('button', { name: '등록하기' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('지금 처리가 밀려 있어요. 잠시 뒤 다시 눌러 주세요.');
    expect(navigate).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: '등록하기' }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/signup/done'));
  });

  it('lets a phone with no secure chip finish signup and explains the entry path', async () => {
    ensureDeviceKey.mockRejectedValueOnce(new DeviceKeyUnavailable());
    renderScreen(<DeviceStep />);
    await userEvent.click(screen.getByRole('button', { name: '등록하기' }));

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
      renderScreen(<DeviceStep />, '/signup/device?returnTo=%2Fme%2Fverify');
      expect(screen.getByRole('status')).toHaveTextContent(ko.signup.finishPending);

      await userEvent.click(screen.getByRole('button', { name: '등록하기' }));

      await waitFor(() =>
        expect(registerIdentity).toHaveBeenCalledWith({
          personId: PERSON_ID,
          deviceX: DEVICE_X,
          deviceY: DEVICE_Y,
          platform: 'ios',
        }),
      );
      expect(navigate).toHaveBeenCalledWith('/me/verify', { replace: true });
      expect(navigate).not.toHaveBeenCalledWith('/signup/done');
    });

    it('lands on the explore tab when there was nowhere in particular to go back to', async () => {
      renderScreen(<DeviceStep />, '/signup/device?returnTo=');
      await userEvent.click(screen.getByRole('button', { name: '등록하기' }));

      await waitFor(() => expect(navigate).toHaveBeenCalledWith('/', { replace: true }));
    });

    it('says nothing about finishing when this is an ordinary third step', async () => {
      seedSignup({ personId: PERSON_ID, account: ACCOUNT });
      renderScreen(<DeviceStep />);
      expect(screen.queryByText(ko.signup.finishPending)).toBeNull();
    });
  });

  it('refuses to start without the account the passkey step produced', async () => {
    setSession({ status: 'anonymous' });
    seedSignup({ personId: PERSON_ID });
    renderScreen(<DeviceStep />);
    await userEvent.click(screen.getByRole('button', { name: '등록하기' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('가입을 처음부터 다시 해 주세요.');
    expect(ensureDeviceKey).not.toHaveBeenCalled();
  });
});

describe('done screen', () => {
  it('drops the leftover signup state and goes home', async () => {
    seedSignup({ personId: PERSON_ID, account: ACCOUNT });
    renderScreen(<Done />);
    await userEvent.click(screen.getByRole('button', { name: '행사 둘러보기' }));

    expect(sessionStorage.getItem('monti.signup')).toBeNull();
    expect(navigate).toHaveBeenCalledWith('/');
  });
});
