import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sendOtp = vi.fn(async () => 'verification-id');
const confirmOtp = vi.fn(async () => undefined);
// Phone.tsx calls toE164 before sendOtp; a partial mock makes it undefined and throws.
vi.mock('../../shared/api/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../shared/api/auth')>()),
  sendOtp,
  confirmOtp,
}));
const startSignup = vi.fn(async () => ({ personId: 'p1' }));
vi.mock('../../shared/api/functions', () => ({ api: { startSignup } }));
const navigate = vi.fn();
vi.mock('react-router-dom', async (orig) => ({
  ...(await orig<typeof import('react-router-dom')>()),
  useNavigate: () => navigate,
}));

const { Phone } = await import('./Phone');
const { Verify } = await import('./Verify');
const { toE164, isE164 } = await import('../../shared/api/auth');

const PHONE = '+821012345678';

function firebaseError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

function renderScreen(element: React.ReactElement) {
  return render(<MemoryRouter>{element}</MemoryRouter>);
}

/** Verify reads the state Phone left behind; every test says what that state is. */
function seedSignup(state: Record<string, unknown>): void {
  sessionStorage.setItem('monti.signup', JSON.stringify(state));
}

beforeEach(() => {
  sessionStorage.clear();
});

describe('E.164', () => {
  it('prefixes the selected country and drops the national trunk zero', () => {
    expect(toE164('010-1234-5678')).toBe(PHONE);
    expect(toE164('(650) 555 0101', '+1')).toBe('+16505550101');
  });

  it('leaves a number that already carries a country code alone', () => {
    expect(toE164('+8210 1234 5678')).toBe(PHONE);
  });

  it('accepts 7 to 15 digits and nothing else', () => {
    expect(isE164(PHONE)).toBe(true);
    expect(isE164('+8210')).toBe(false);
    expect(isE164('01012345678')).toBe(false);
    expect(isE164(`+${'1'.repeat(16)}`)).toBe(false);
  });
});

describe('Phone screen', () => {
  it('normalises a Korean number to E.164 and moves to the code step', async () => {
    render(<MemoryRouter><Phone /></MemoryRouter>);
    await userEvent.type(screen.getByRole('textbox'), '01012345678');
    await userEvent.click(screen.getByRole('button', { name: '인증번호 받기' }));
    // The screen hands its abort signal down so leaving mid-send cancels the native listeners.
    expect(sendOtp).toHaveBeenCalledWith('+821012345678', { signal: expect.any(AbortSignal) });
    expect(navigate).toHaveBeenCalledWith('/signup/verify');
  });

  it('uses the selected country code', async () => {
    renderScreen(<Phone />);
    await userEvent.selectOptions(screen.getByRole('combobox'), '+1');
    await userEvent.type(screen.getByRole('textbox'), '6505550101');
    await userEvent.click(screen.getByRole('button', { name: '인증번호 받기' }));
    expect(sendOtp).toHaveBeenCalledWith('+16505550101', { signal: expect.any(AbortSignal) });
  });

  it('refuses a number that cannot be E.164 without spending a send', async () => {
    renderScreen(<Phone />);
    await userEvent.type(screen.getByRole('textbox'), '0101');
    await userEvent.click(screen.getByRole('button', { name: '인증번호 받기' }));
    expect(sendOtp).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    expect(await screen.findByRole('alert')).toHaveTextContent('번호를 다시 확인해 주세요.');
  });

  it('says so plainly when phone sign-in is not switched on in the project', async () => {
    sendOtp.mockRejectedValueOnce(firebaseError('auth/operation-not-allowed'));
    renderScreen(<Phone />);
    await userEvent.type(screen.getByRole('textbox'), '01012345678');
    await userEvent.click(screen.getByRole('button', { name: '인증번호 받기' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('지금은 문자 인증을 쓸 수 없어요.');
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe('Verify screen', () => {
  it('confirms the code, starts the signup and moves to the passkey step', async () => {
    seedSignup({ verificationId: 'vid', phoneE164: PHONE });
    renderScreen(<Verify />);
    await userEvent.type(screen.getByRole('textbox'), '123456');
    await userEvent.click(screen.getByRole('button', { name: '확인' }));
    expect(confirmOtp).toHaveBeenCalledWith('vid', '123456');
    expect(startSignup).toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith('/signup/register');
    expect(JSON.parse(sessionStorage.getItem('monti.signup') ?? '{}')).toMatchObject({ personId: 'p1' });
  });

  it('shows the wrong-code sentence and stays put', async () => {
    seedSignup({ verificationId: 'vid', phoneE164: PHONE });
    confirmOtp.mockRejectedValueOnce(firebaseError('auth/invalid-verification-code'));
    renderScreen(<Verify />);
    await userEvent.type(screen.getByRole('textbox'), '000000');
    await userEvent.click(screen.getByRole('button', { name: '확인' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('인증번호가 맞지 않아요.');
    expect(startSignup).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('holds the resend back for the cooldown, then resends to the same number', async () => {
    vi.useFakeTimers();
    seedSignup({ verificationId: 'vid', phoneE164: PHONE });
    renderScreen(<Verify />);

    expect(screen.getByRole('timer')).toHaveTextContent('60');
    expect(screen.queryByRole('button', { name: '다시 보내기' })).toBeNull();

    // One second per act: the next timer is only armed after React flushes the state update.
    for (let tick = 0; tick < 60; tick += 1) {
      act(() => { vi.advanceTimersByTime(1000); });
    }

    const resend = screen.getByRole('button', { name: '다시 보내기' });
    vi.useRealTimers();
    fireEvent.click(resend);
    await waitFor(() =>
      expect(sendOtp).toHaveBeenCalledWith(PHONE, expect.objectContaining({ resend: true })),
    );
  });

  it('sends an already-registered number to sign-in instead of creating a second account', async () => {
    seedSignup({ verificationId: 'vid', phoneE164: PHONE });
    startSignup.mockRejectedValueOnce(
      Object.assign(new Error('PHONE_ALREADY_REGISTERED'), { code: 'already-exists' }),
    );
    renderScreen(<Verify />);
    await userEvent.type(screen.getByRole('textbox'), '123456');
    await userEvent.click(screen.getByRole('button', { name: '확인' }));
    expect(navigate).toHaveBeenCalledWith('/login', {
      replace: true,
      state: { notice: '이미 가입된 번호예요. 로그인해 주세요.' },
    });
  });

  it('retries only the backend when the code was accepted but startSignup failed', async () => {
    seedSignup({ verificationId: 'vid', phoneE164: PHONE });
    startSignup.mockRejectedValueOnce(Object.assign(new Error('INTERNAL'), { code: 'internal' }));
    renderScreen(<Verify />);
    await userEvent.type(screen.getByRole('textbox'), '123456');
    await userEvent.click(screen.getByRole('button', { name: '확인' }));

    // The digits were spent, so the failure is the server's — blaming the code would hide it.
    expect(await screen.findByRole('alert')).toHaveTextContent('문제가 생겼어요.');
    expect(screen.queryByText('인증번호가 맞지 않아요.')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: '확인' }));
    expect(confirmOtp).toHaveBeenCalledTimes(1);
    expect(startSignup).toHaveBeenCalledTimes(2);
    expect(navigate).toHaveBeenCalledWith('/signup/register');
  });

  it('skips the code entirely when the platform verified the number instantly', async () => {
    // Android's Play-services path: no SMS, no verification id, already signed in.
    seedSignup({ verificationId: '', phoneE164: PHONE });
    renderScreen(<Verify />);
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/signup/register'));
    expect(confirmOtp).not.toHaveBeenCalled();
    expect(screen.queryByRole('textbox')).toBeNull();
  });
});
