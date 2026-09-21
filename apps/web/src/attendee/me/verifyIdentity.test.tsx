import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const POLL_INTERVAL_MS = 2_000;
const POLL_LIMIT = 45;

const openBrowser = vi.fn(async () => undefined);
const closeBrowser = vi.fn(async () => undefined);
vi.mock('@capacitor/browser', () => ({ Browser: { open: openBrowser, close: closeBrowser } }));

// The screen only ever sees a URL and a remover, so the listener is captured here and fired by hand.
let onDeepLink: ((url: string) => void) | null = null;
const removeDeepLink = vi.fn();
vi.mock('../../shared/api/deepLink', () => ({
  KYC_CALLBACK_URL: 'monti://kyc/callback',
  listenDeepLink: async (handler: (url: string) => void) => {
    onDeepLink = handler;
    return removeDeepLink;
  },
}));

const startKyc = vi.fn(async () => ({ kycUrl: 'https://verify.didit.me/s/abc', sessionId: 'sess-1' }));
const getSignupStatus = vi.fn();
vi.mock('../../shared/api/functions', () => ({ api: { startKyc, getSignupStatus } }));

const navigate = vi.fn();
vi.mock('react-router-dom', async (orig) => ({
  ...(await orig<typeof import('react-router-dom')>()),
  useNavigate: () => navigate,
}));

const { VerifyIdentity } = await import('./VerifyIdentity');
const { useKycLevel } = await import('./useKycLevel');

function renderScreen(entry = '/me/verify') {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={[entry]}><VerifyIdentity /></MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  onDeepLink = null;
  getSignupStatus.mockResolvedValue({ status: 'active', kycLevel: 0 });
});

describe('VerifyIdentity', () => {
  it('opens the hosted link in the system browser', async () => {
    renderScreen();
    await userEvent.click(await screen.findByRole('button', { name: '본인인증 하기' }));
    expect(openBrowser).toHaveBeenCalledWith({ url: 'https://verify.didit.me/s/abc', presentationStyle: 'popover' });
  });

  it('reports a duplicate face with the "already have an account" copy', async () => {
    getSignupStatus.mockResolvedValue({ status: 'rejected', kycLevel: 0, reason: 'duplicate_face' });
    renderScreen();
    await userEvent.click(await screen.findByRole('button', { name: '본인인증 하기' }));
    expect(await screen.findByText('이미 계정이 있습니다. 기존 계정으로 로그인해 주세요.')).toBeInTheDocument();
  });

  it('reports any other failure with the generic rejection copy', async () => {
    getSignupStatus.mockResolvedValue({ status: 'rejected', kycLevel: 0, reason: 'document_failed' });
    renderScreen();
    await userEvent.click(await screen.findByRole('button', { name: '본인인증 하기' }));
    expect(await screen.findByText('본인 확인에 실패했어요. 다시 시도해 주세요.')).toBeInTheDocument();
  });

  it('sends a verified person back to the screen that asked for the check', async () => {
    getSignupStatus.mockResolvedValue({ status: 'kyc_ok', kycLevel: 1 });
    renderScreen('/me/verify?returnTo=%2Ftickets%2F42');
    await userEvent.click(await screen.findByRole('button', { name: '본인인증 하기' }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/tickets/42', { replace: true }));
  });

  it('polls when the deep link brings the person back, and closes the hosted page', async () => {
    getSignupStatus.mockResolvedValue({ status: 'kyc_ok', kycLevel: 1 });
    renderScreen();
    await waitFor(() => expect(onDeepLink).not.toBeNull());

    await act(async () => { onDeepLink?.('monti://kyc/callback'); });

    await waitFor(() => expect(getSignupStatus).toHaveBeenCalled());
    expect(closeBrowser).toHaveBeenCalled();
    // The person came back on their own; nothing re-opened the hosted page behind them.
    expect(openBrowser).not.toHaveBeenCalled();
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/me', { replace: true }));
  });

  it('ignores a return that is not the verification callback', async () => {
    renderScreen();
    await waitFor(() => expect(onDeepLink).not.toBeNull());
    await act(async () => { onDeepLink?.('https://monti.app/events/42'); });
    expect(getSignupStatus).not.toHaveBeenCalled();
    expect(closeBrowser).not.toHaveBeenCalled();
  });

  it('gives up after ninety seconds instead of polling forever', async () => {
    vi.useFakeTimers();
    getSignupStatus.mockResolvedValue({ status: 'pending', kycLevel: 0 });
    renderScreen();
    fireEvent.click(screen.getByRole('button', { name: '본인인증 하기' }));

    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_LIMIT * POLL_INTERVAL_MS + POLL_INTERVAL_MS); });

    expect(getSignupStatus).toHaveBeenCalledTimes(POLL_LIMIT);
    expect(navigate).not.toHaveBeenCalled();
    expect(screen.queryByRole('progressbar')).toBeNull();
    vi.useRealTimers();
  });

  it('stops polling and drops the listener when the screen goes away', async () => {
    vi.useFakeTimers();
    getSignupStatus.mockResolvedValue({ status: 'pending', kycLevel: 0 });
    const { unmount } = renderScreen();
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(onDeepLink).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '본인인증 하기' }));
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
