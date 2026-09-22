import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ko } from '../../shared/copy/index';

const POLL_INTERVAL_MS = 2_000;
const POLL_LIMIT = 45;
const KYC_URL = 'https://verify.didit.me/s/abc';
const TIMEOUT_COPY = '아직 확인 결과가 오지 않았어요. 잠시 뒤 다시 확인해 주세요.';
const GENERIC_COPY = '문제가 생겼어요. 잠시 뒤 다시 시도해 주세요.';
const IN_FLIGHT_COPY = '잠시 후 다시 시도해 주세요.';

// The screen only ever sees a URL and a remover, so the listener is captured here and fired by
// hand. The matcher is the real one — a mocked matcher is how the dead web leg survived review.
let onDeepLink: ((url: string) => void) | null = null;
const removeDeepLink = vi.fn();
const openHostedFlow = vi.fn(async () => undefined);
const closeHostedFlow = vi.fn(async () => undefined);
vi.mock('../../shared/api/deepLink', async (orig) => ({
  ...(await orig<typeof import('../../shared/api/deepLink')>()),
  openHostedFlow,
  closeHostedFlow,
  listenDeepLink: async (handler: (url: string) => void) => {
    onDeepLink = handler;
    return removeDeepLink;
  },
}));

const startKyc = vi.fn(async () => ({ kycUrl: KYC_URL, sessionId: 'sess-1' }));
const getSignupStatus = vi.fn();
// `callableFailure` is the real one: the screen's in-flight branch reads a server status, and a
// stubbed reader would let that branch pass while the real one never fired.
vi.mock('../../shared/api/functions', async (orig) => ({
  ...(await orig<typeof import('../../shared/api/functions')>()),
  api: { startKyc, getSignupStatus },
}));

const navigate = vi.fn();
vi.mock('react-router-dom', async (orig) => ({
  ...(await orig<typeof import('react-router-dom')>()),
  useNavigate: () => navigate,
}));

const { VerifyIdentity } = await import('./VerifyIdentity');
const { useKycLevel } = await import('./useKycLevel');

/** `setSearchParams` navigates for real under MemoryRouter, so the address is read back here. */
function Address() {
  const location = useLocation();
  return <span data-testid="address">{location.pathname + location.search}</span>;
}

function screenTree(entry: string) {
  return (
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={[entry]}>
        <VerifyIdentity />
        <Address />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

function renderScreen(entry = '/me/verify') {
  return render(screenTree(entry));
}

function cta() {
  return screen.getByRole('button', { name: '본인인증 하기' });
}

/** The person has finished at the hosted page and the app is back in front of them. */
async function comeBack(url = 'monti://kyc/callback') {
  await waitFor(() => expect(onDeepLink).not.toBeNull());
  await act(async () => { onDeepLink?.(url); });
}

beforeEach(() => {
  onDeepLink = null;
  startKyc.mockClear();
  getSignupStatus.mockResolvedValue({ status: 'active', kycLevel: 0 });
});

describe('VerifyIdentity', () => {
  it('opens the hosted link and waits for the return before it polls', async () => {
    renderScreen();
    await userEvent.click(await screen.findByRole('button', { name: '본인인증 하기' }));
    expect(openHostedFlow).toHaveBeenCalledWith(KYC_URL);
    // Browser.open resolves on presentation, not on dismissal: polling here burns the ceiling
    // while the person is still holding up their ID.
    expect(getSignupStatus).not.toHaveBeenCalled();
  });

  /**
   * Left off, the server falls back to `https://<rp>/kyc/callback` and the `returnTo` with it:
   * on the web a verified person lands on the explore tab and every resumed claim after it is
   * pointless. The address is the screen's own, marked, carrying where they were going.
   */
  it('tells the server where to send a web browser back to, returnTo and all', async () => {
    renderScreen('/me/verify?returnTo=%2Fclaim%2F1%3Fintent%3Dclaim%26tier%3D0');
    await userEvent.click(cta());
    expect(startKyc).toHaveBeenCalledWith({
      callbackUrl: `${window.location.origin}/me/verify?didit=done&returnTo=${encodeURIComponent('/claim/1?intent=claim&tier=0')}`,
    });
  });

  it('falls back to the profile in the callback when nothing asked for the check', async () => {
    renderScreen();
    await userEvent.click(cta());
    expect(startKyc).toHaveBeenCalledWith({
      callbackUrl: `${window.location.origin}/me/verify?didit=done&returnTo=${encodeURIComponent('/me')}`,
    });
  });

  it('says so plainly when the session could not be started', async () => {
    startKyc.mockRejectedValueOnce(new Error('unavailable'));
    renderScreen();
    await userEvent.click(cta());
    expect(await screen.findByText(GENERIC_COPY)).toBeInTheDocument();
    // Nothing here gets better by waiting, so the generic sentence gets no "try again" button.
    expect(screen.queryByRole('button', { name: '다시 시도' })).toBeNull();
  });

  it('asks the person to wait when another call already holds the session claim', async () => {
    // `ensureKycSession` throws aborted/KYC_SESSION_IN_FLIGHT while the 60 s claim is held.
    startKyc.mockRejectedValueOnce({ code: 'aborted', message: 'KYC_SESSION_IN_FLIGHT' } as never);
    renderScreen();
    await userEvent.click(cta());
    expect(await screen.findByText(IN_FLIGHT_COPY)).toBeInTheDocument();
    expect(screen.queryByText(GENERIC_COPY)).toBeNull();
  });

  it('lets the claim lapse and start over from the same screen', async () => {
    startKyc.mockRejectedValueOnce({ code: 'aborted', message: 'KYC_SESSION_IN_FLIGHT' } as never);
    renderScreen();
    await userEvent.click(cta());
    await screen.findByText(IN_FLIGHT_COPY);

    await userEvent.click(screen.getByRole('button', { name: '다시 시도' }));
    // The claim has lapsed, so the second attempt opens the hosted page and the sentence goes.
    expect(startKyc).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(openHostedFlow).toHaveBeenCalledWith(KYC_URL));
    expect(screen.queryByText(IN_FLIGHT_COPY)).toBeNull();
  });

  it('reports a duplicate face with the "already have an account" copy', async () => {
    getSignupStatus.mockResolvedValue({ status: 'rejected', kycLevel: 0, kycReason: 'duplicate_face' });
    renderScreen();
    await userEvent.click(cta());
    await comeBack();
    expect(await screen.findByText('이미 계정이 있습니다. 기존 계정으로 로그인해 주세요.')).toBeInTheDocument();
  });

  it('reports any other failure with the generic rejection copy', async () => {
    getSignupStatus.mockResolvedValue({ status: 'rejected', kycLevel: 0, kycReason: 'declined' });
    renderScreen();
    await userEvent.click(cta());
    await comeBack();
    expect(await screen.findByText('본인 확인에 실패했어요. 다시 시도해 주세요.')).toBeInTheDocument();
  });

  /**
   * A refusal is the one dead end in the app: the verdict came from the vendor, no button on
   * this screen can change it, and a person who believes it is wrong has nowhere else to go.
   * The address only appears with the refusal — an idle screen offering support reads as a
   * warning that something is already broken.
   */
  it('hands a refused person the support address, and only then', async () => {
    getSignupStatus.mockResolvedValue({ status: 'rejected', kycLevel: 0, kycReason: 'declined' });
    renderScreen();
    expect(screen.queryByRole('link', { name: ko.common.contactEmail })).toBeNull();

    await userEvent.click(cta());
    await comeBack();
    const link = await screen.findByRole('link', { name: ko.common.contactEmail });
    expect(link).toHaveAttribute('href', `mailto:${ko.common.contactEmail}`);
  });

  it('sends a verified person back to the screen that asked for the check', async () => {
    getSignupStatus.mockResolvedValue({ status: 'kyc_ok', kycLevel: 1 });
    renderScreen('/me/verify?returnTo=%2Ftickets%2F42');
    await comeBack();
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/tickets/42', { replace: true }));
  });

  it('refuses a returnTo that would leave the app', async () => {
    getSignupStatus.mockResolvedValue({ status: 'kyc_ok', kycLevel: 1 });
    renderScreen('/me/verify?returnTo=https%3A%2F%2Fevil.example%2Fx');
    await comeBack();
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/me', { replace: true }));
  });

  it('refuses a protocol-relative returnTo as well', async () => {
    getSignupStatus.mockResolvedValue({ status: 'kyc_ok', kycLevel: 1 });
    renderScreen('/me/verify?returnTo=%2F%2Fevil.example%2Fx');
    await comeBack();
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/me', { replace: true }));
  });

  it('polls when the deep link brings the person back, and closes the hosted page', async () => {
    getSignupStatus.mockResolvedValue({ status: 'kyc_ok', kycLevel: 1 });
    renderScreen();
    await comeBack();
    await waitFor(() => expect(getSignupStatus).toHaveBeenCalled());
    expect(closeHostedFlow).toHaveBeenCalled();
    // The person came back on their own; nothing re-opened the hosted page behind them.
    expect(openHostedFlow).not.toHaveBeenCalled();
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/me', { replace: true }));
  });

  it('ignores a return that is not the verification callback', async () => {
    renderScreen();
    await comeBack('https://monti.example/events/42');
    expect(getSignupStatus).not.toHaveBeenCalled();
    expect(closeHostedFlow).not.toHaveBeenCalled();
  });

  it('polls on the web marker and strips it so a refresh does not re-enter the flow', async () => {
    getSignupStatus.mockResolvedValue({ status: 'kyc_ok', kycLevel: 1 });
    renderScreen('/me/verify?didit=done&returnTo=%2Ftickets%2F42');
    await waitFor(() => expect(getSignupStatus).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId('address')).toHaveTextContent('/me/verify?returnTo=%2Ftickets%2F42'));
    expect(screen.getByTestId('address').textContent).not.toContain('didit');
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/tickets/42', { replace: true }));
  });

  it('keeps polling through a dropped call instead of throwing out of the screen', async () => {
    vi.useFakeTimers();
    getSignupStatus
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValue({ status: 'kyc_ok', kycLevel: 1 });
    renderScreen();
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { onDeepLink?.('monti://kyc/callback'); });

    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2); });

    // The blip cost one tick and nothing else: no error sentence, no stuck spinner.
    expect(navigate).toHaveBeenCalledWith('/me', { replace: true });
    expect(getSignupStatus.mock.calls.length).toBeGreaterThan(1);
    expect(screen.queryByText('문제가 생겼어요. 잠시 뒤 다시 시도해 주세요.')).toBeNull();
    vi.useRealTimers();
  });

  it('offers another look after ninety seconds instead of polling forever', async () => {
    vi.useFakeTimers();
    getSignupStatus.mockResolvedValue({ status: 'pending', kycLevel: 0 });
    renderScreen();
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { onDeepLink?.('monti://kyc/callback'); });

    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_LIMIT * POLL_INTERVAL_MS + POLL_INTERVAL_MS); });

    expect(getSignupStatus).toHaveBeenCalledTimes(POLL_LIMIT);
    expect(navigate).not.toHaveBeenCalled();
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.getByText(TIMEOUT_COPY)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '다시 시도' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(getSignupStatus.mock.calls.length).toBeGreaterThan(POLL_LIMIT);
    expect(screen.queryByText(TIMEOUT_COPY)).toBeNull();
    vi.useRealTimers();
  });

  it('still polls after the StrictMode remount', async () => {
    getSignupStatus.mockResolvedValue({ status: 'kyc_ok', kycLevel: 1 });
    render(<StrictMode>{screenTree('/me/verify')}</StrictMode>);
    await comeBack();
    await waitFor(() => expect(getSignupStatus).toHaveBeenCalled());
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/me', { replace: true }));
  });

  it('stops polling and drops the listener when the screen goes away', async () => {
    vi.useFakeTimers();
    getSignupStatus.mockResolvedValue({ status: 'pending', kycLevel: 0 });
    const { unmount } = renderScreen();
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { onDeepLink?.('monti://kyc/callback'); });
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS); });
    const before = getSignupStatus.mock.calls.length;
    expect(before).toBeGreaterThan(0);

    unmount();
    expect(removeDeepLink).toHaveBeenCalled();

    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 5); });
    expect(getSignupStatus).toHaveBeenCalledTimes(before);
    vi.useRealTimers();
  });
});

describe('useKycLevel', () => {
  it('reads the level the server reports and defaults to unverified', async () => {
    getSignupStatus.mockResolvedValue({ status: 'kyc_ok', kycLevel: 1 });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useKycLevel(), { wrapper });
    expect(result.current.kycLevel).toBe(0);
    await waitFor(() => expect(result.current.kycLevel).toBe(1));
  });
});
