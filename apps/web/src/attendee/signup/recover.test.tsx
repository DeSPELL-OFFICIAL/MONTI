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
const recoverAccess = vi.fn(async () => ({
  token: 'custom-token', personId: PERSON_ID, account: ACCOUNT, txHash: '0xtx',
}));
const getSignupStatus = vi.fn(async () => ({
  status: 'active', hasPasskey: false, hasAccount: true, personId: PERSON_ID,
}));
// Partial: `callableFailure` reads a rejection's shape and is exercised, not stubbed.
vi.mock('../../shared/api/functions', async (orig) => ({
  ...(await orig<typeof import('../../shared/api/functions')>()),
  api: { loginChallenge, recoverAccess, getSignupStatus },
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
const resetDeviceKey = vi.fn(async () => undefined);
vi.mock('../../shared/deviceKey', () => ({
  ensureDeviceKey,
  resetDeviceKey,
  ATTENDEE_KEY_ALIAS: 'monti-attendee',
  DeviceKeyUnavailable,
}));

const signInWithCustomToken = vi.fn(async () => ({ user: { uid: 'u1' } }));
vi.mock('firebase/auth', () => ({ signInWithCustomToken }));
vi.mock('../../shared/api/firebase', () => ({ getFirebaseAuth: () => ({ name: 'auth' }) }));

const getPlatform = vi.fn(() => 'ios');
vi.mock('@capacitor/core', () => ({
  Capacitor: { getPlatform: () => getPlatform(), isNativePlatform: () => true },
}));

const navigate = vi.fn();
vi.mock('react-router-dom', async (orig) => ({
  ...(await orig<typeof import('react-router-dom')>()),
  useNavigate: () => navigate,
}));

const { Recover } = await import('./Recover');

function seedSignup(state: Record<string, unknown>): void {
  sessionStorage.setItem('monti.signup', JSON.stringify(state));
}

function renderScreen() {
  return render(
    <MemoryRouter initialEntries={['/recover']}>
      <Recover />
    </MemoryRouter>,
  );
}

/** The one primary button, before an error reworded it to 다시 시도. */
function start(): HTMLElement {
  return screen.getByRole('button', { name: ko.recover.cta });
}

/** A callable rejection: an uppercase reason in `message`, the gRPC status in `code`, and the
 *  structured `details` the cooldown answer carries. */
function callableError(code: string, reason: string, details?: unknown): Error {
  return Object.assign(new Error(reason), { code, details });
}

beforeEach(() => {
  sessionStorage.clear();
  seedSignup({ personId: PERSON_ID });
  loginChallenge.mockClear();
  recoverAccess.mockReset();
  recoverAccess.mockResolvedValue({
    token: 'custom-token', personId: PERSON_ID, account: ACCOUNT, txHash: '0xtx',
  });
  createPasskey.mockClear();
  ensureDeviceKey.mockReset();
  ensureDeviceKey.mockResolvedValue({ x: DEVICE_X, y: DEVICE_Y, backing: 'secureEnclave' });
  resetDeviceKey.mockClear();
  signInWithCustomToken.mockClear();
  navigate.mockClear();
  getPlatform.mockReturnValue('ios');
});

describe('lost-passkey recovery', () => {
  it('makes a new lock, rotates the account and signs in off a single tap', async () => {
    renderScreen();
    await userEvent.click(start());

    await waitFor(() => expect(signInWithCustomToken).toHaveBeenCalled());
    // A locally invented challenge is rejected by the server, so the minted one has to travel.
    expect(createPasskey).toHaveBeenCalledWith('MONTI', CHALLENGE);
    expect(resetDeviceKey).toHaveBeenCalledWith({ alias: 'monti-attendee' });
    expect(ensureDeviceKey).toHaveBeenCalledWith({
      alias: 'monti-attendee',
      requireAuth: true,
      strongBox: true,
    });
    expect(recoverAccess).toHaveBeenCalledWith({
      personId: PERSON_ID,
      attestation: { id: 'cred', type: 'public-key' },
      deviceX: DEVICE_X,
      deviceY: DEVICE_Y,
      platform: 'ios',
    });
    // The session itself comes from the token's claims, read by shared/api/sessionHydrator.
    expect(signInWithCustomToken).toHaveBeenCalledWith({ name: 'auth' }, 'custom-token');
    expect(navigate).toHaveBeenCalledWith('/tickets');
  });

  it('shows the cooldown date when recovery is still on its 7-day timer', async () => {
    const allowedAt = 1_800_000_000;
    recoverAccess.mockRejectedValueOnce(
      callableError('failed-precondition', 'ROTATION_COOLDOWN', { allowedAt }),
    );
    renderScreen();
    await userEvent.click(start());

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('최근에 설정을 바꿔서 아직 다시 설정할 수 없어요.');
    expect(alert).toHaveTextContent(new Date(allowedAt * 1_000).toLocaleDateString('ko'));
    expect(signInWithCustomToken).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalledWith('/tickets');
  });

  it('shows the rate-limit sentence after too many tries in a day', async () => {
    recoverAccess.mockRejectedValueOnce(callableError('resource-exhausted', 'RECOVERY_RATE_LIMIT'));
    renderScreen();
    await userEvent.click(start());

    expect(await screen.findByRole('alert')).toHaveTextContent(ko.recover.rateLimit);
    expect(navigate).not.toHaveBeenCalledWith('/tickets');
  });

  it('tells a private browser it cannot set up here, and never calls the server', async () => {
    ensureDeviceKey.mockRejectedValueOnce(new DeviceKeyUnavailable());
    renderScreen();
    await userEvent.click(start());

    expect(await screen.findByRole('alert')).toHaveTextContent(ko.recover.deviceUnavailable);
    expect(recoverAccess).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalledWith('/tickets');
  });
});
