import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const PERSON_ID = `0x${'aa'.repeat(32)}`;
const ACCOUNT = `0x${'ab'.repeat(20)}`;
const CHALLENGE = 'Kioqoyoqkioqoyoqkioqoyoqkioqoyoqkioqoyoq123';
const ASSERTION = {
  id: 'cred',
  rawId: 'cred',
  type: 'public-key' as const,
  response: { clientDataJSON: 'e30', authenticatorData: 'AQID', signature: 'MEQ' },
  clientExtensionResults: {},
};

const loginChallenge = vi.fn(async () => ({ challenge: CHALLENGE, expiresAt: 0 }));
const loginVerify = vi.fn(async () => ({ token: 'custom-token', personId: PERSON_ID, account: ACCOUNT }));
// Partial: `callableFailure` reads a rejection's shape and is exercised, not stubbed.
vi.mock('../shared/api/functions', async (orig) => ({
  ...(await orig<typeof import('../shared/api/functions')>()),
  api: { loginChallenge, loginVerify },
}));

const signPasskeyAssertion = vi.fn(async () => ASSERTION);
vi.mock('../shared/passkey', async (orig) => ({
  ...(await orig<typeof import('../shared/passkey')>()),
  signPasskeyAssertion,
}));

const signInWithCustomToken = vi.fn(async () => ({ user: { uid: 'u1' } }));
vi.mock('firebase/auth', () => ({ signInWithCustomToken }));
vi.mock('../shared/api/firebase', () => ({ getFirebaseAuth: () => ({ name: 'auth' }) }));

const navigate = vi.fn();
vi.mock('react-router-dom', async (orig) => ({
  ...(await orig<typeof import('react-router-dom')>()),
  useNavigate: () => navigate,
}));

const { Login } = await import('./Login');

function renderScreen() {
  return render(
    <MemoryRouter>
      <Login />
    </MemoryRouter>,
  );
}

function callableError(code: string, reason: string): Error {
  return Object.assign(new Error(reason), { code });
}

beforeEach(() => {
  signPasskeyAssertion.mockResolvedValue(ASSERTION);
});

describe('passkey-only sign-in', () => {
  it('signs the server challenge and exchanges the verified assertion for a session', async () => {
    renderScreen();
    await userEvent.click(screen.getByRole('button', { name: '로그인' }));

    await waitFor(() => expect(signInWithCustomToken).toHaveBeenCalled());
    expect(loginChallenge).toHaveBeenCalledWith({ purpose: 'login' });
    expect(signPasskeyAssertion).toHaveBeenCalledWith(CHALLENGE);
    expect(loginVerify).toHaveBeenCalledWith({ assertion: ASSERTION });
    // The session itself comes from the token's claims, read by shared/api/sessionHydrator.
    expect(signInWithCustomToken).toHaveBeenCalledWith({ name: 'auth' }, 'custom-token');
    expect(navigate).toHaveBeenCalledWith('/tickets');
  });

  it('shows the failure sentence when the server rejects the assertion', async () => {
    loginVerify.mockRejectedValueOnce(callableError('permission-denied', 'ASSERTION_REJECTED'));
    renderScreen();
    await userEvent.click(screen.getByRole('button', { name: '로그인' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('로그인하지 못했어요. 다시 시도해 주세요.');
    expect(signInWithCustomToken).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('separates a dismissed prompt from a real failure', async () => {
    signPasskeyAssertion.mockRejectedValueOnce(
      Object.assign(new Error('failed'), { cause: Object.assign(new Error('x'), { name: 'NotAllowedError' }) }),
    );
    renderScreen();
    await userEvent.click(screen.getByRole('button', { name: '로그인' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('로그인을 취소했어요.');
  });

  it('tells a phone with no passkey to sign up first', async () => {
    signPasskeyAssertion.mockRejectedValueOnce(new Error('No passkey on this device'));
    renderScreen();
    await userEvent.click(screen.getByRole('button', { name: '로그인' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      '이 휴대폰에는 설정된 잠금이 없어요. 먼저 가입해 주세요.',
    );
  });

  it('does not offer a retry for an account that can never sign in again', async () => {
    loginVerify.mockRejectedValueOnce(callableError('failed-precondition', 'BAD_SIGNUP_STATE'));
    renderScreen();
    await userEvent.click(screen.getByRole('button', { name: '로그인' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      '이 계정으로는 들어갈 수 없어요. 고객센터에 문의해 주세요.',
    );
  });
});
