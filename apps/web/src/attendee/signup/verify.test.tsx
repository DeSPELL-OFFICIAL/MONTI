import { render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const PERSON_ID = `0x${'aa'.repeat(32)}`;

const getSignupStatus = vi.fn();
const startSignup = vi.fn(async () => ({ personId: PERSON_ID }));
// Partial: `callableFailure`/`isAlreadyRegistered` read a rejection's shape and are exercised.
vi.mock('../../shared/api/functions', async (orig) => ({
  ...(await orig<typeof import('../../shared/api/functions')>()),
  api: { getSignupStatus, startSignup },
}));

// The whole auth module is stubbed so the test never reaches Firebase phone sign-in. The empty
// verification id is `INSTANT_VERIFICATION`, the platform-verified path -- there is no code to
// type, so `finish` runs on its own the moment the screen mounts, which is the branch under test.
const confirmOtp = vi.fn(async () => undefined);
vi.mock('../../shared/api/auth', () => ({
  INSTANT_VERIFICATION: '',
  RECAPTCHA_CONTAINER_ID: 'recaptcha-container',
  confirmOtp,
  phoneAuthProblem: () => 'unknown',
  resetRecaptcha: vi.fn(),
  sendOtp: vi.fn(async () => 'vid'),
}));

const navigate = vi.fn();
vi.mock('react-router-dom', async (orig) => ({
  ...(await orig<typeof import('react-router-dom')>()),
  useNavigate: () => navigate,
}));

const { Verify } = await import('./Verify');

function seedSignup(state: Record<string, unknown>): void {
  sessionStorage.setItem('monti.signup', JSON.stringify(state));
}

function renderScreen() {
  return render(
    <MemoryRouter initialEntries={['/signup/verify']}>
      <Verify />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  sessionStorage.clear();
  getSignupStatus.mockReset();
  startSignup.mockReset();
  startSignup.mockResolvedValue({ personId: PERSON_ID });
  confirmOtp.mockClear();
  navigate.mockClear();
  seedSignup({ verificationId: '' });
});

describe('verify -> recovery branch', () => {
  it('sends an already-active account to /recover instead of signing up again', async () => {
    getSignupStatus.mockResolvedValue({
      status: 'active', hasPasskey: false, hasAccount: true, personId: PERSON_ID,
    });
    renderScreen();

    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/recover'));
    // A returning person is recovered, not signed up again.
    expect(startSignup).not.toHaveBeenCalled();
    const saved = JSON.parse(sessionStorage.getItem('monti.signup') ?? '{}') as { personId?: string };
    expect(saved.personId).toBe(PERSON_ID);
  });

  for (const status of ['none', 'pending'] as const) {
    it(`keeps a ${status} person on the ordinary signup path`, async () => {
      getSignupStatus.mockResolvedValue({ status, hasPasskey: false, hasAccount: false });
      renderScreen();

      await waitFor(() => expect(startSignup).toHaveBeenCalled());
      // The exit fallback when there is no ?returnTo=.
      expect(navigate).toHaveBeenCalledWith('/signup/passkey');
      expect(navigate).not.toHaveBeenCalledWith('/recover');
    });
  }
});
