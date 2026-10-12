import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { en as startEn } from './attendee/start/copy';
import { en } from './shared/copy';

vi.mock('./organizer/useMyOrgs', () => ({
  useMyOrgs: () => ({ orgs: [], canCreateEvent: false, isLoading: false, isError: false, error: null, refetch: () => undefined }),
  useOrgEvents: () => ({ events: [], isLoading: false, isError: false, error: null, refetch: () => undefined }),
}));

const loginChallenge = vi.fn(async () => ({ challenge: 'c'.repeat(43), expiresAt: 0 }));
const getSignupStatus = vi.fn(async () => ({ status: 'active', kycLevel: 0 }));
vi.mock('./shared/api/functions', async (orig) => ({
  ...(await orig<typeof import('./shared/api/functions')>()),
  api: { loginChallenge, getSignupStatus },
}));

const deviceHealth = vi.fn(() => 'unknown');
vi.mock('./shared/deviceHealth', async (orig) => ({
  ...(await orig<typeof import('./shared/deviceHealth')>()),
  useDeviceHealth: () => deviceHealth(),
}));

// The claim screen itself is not under test here, only where the router leaves the visitor.
vi.mock('./attendee/claim/Claim', () => ({ Claim: () => <h1>claim screen</h1> }));

const { routes } = await import('./router');
const { queryClient } = await import('./shared/query');
const { setSession } = await import('./shared/session');
const { resetRegistration, markRegistered } = await import('./shared/registration');

function routerAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

function returnToOf(router: ReturnType<typeof routerAt>): string | null {
  return new URLSearchParams(router.state.location.search).get('returnTo');
}

beforeEach(() => {
  resetRegistration();
  deviceHealth.mockReturnValue('unknown');
  getSignupStatus.mockResolvedValue({ status: 'active', kycLevel: 0 });
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

describe('routing with VITE_AUTH_MODE=open', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_AUTH_MODE', 'open');
  });

  it('sends a signed-out visitor on a guarded route to /start, carrying returnTo', async () => {
    setSession({ status: 'anonymous' });
    const router = routerAt('/claim/7?x=1');
    expect(await screen.findByRole('heading', { name: startEn.title })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/start');
    expect(returnToOf(router)).toBe('/claim/7?x=1');
  });

  it('forwards every phone-mode entry screen to /start with its query', async () => {
    setSession({ status: 'anonymous' });
    for (const path of ['/login', '/signup/phone', '/signup/verify', '/signup/register', '/signup/passkey']) {
      const router = routerAt(`${path}?returnTo=%2Fclaim%2F3`);
      await screen.findByRole('heading', { name: startEn.title });
      expect(router.state.location.pathname, path).toBe('/start');
      expect(returnToOf(router), path).toBe('/claim/3');
      cleanup();
    }
  });

  it('sends a signed-in person whose signup is pending to /start', async () => {
    getSignupStatus.mockResolvedValue({ status: 'pending', kycLevel: 0 });
    setSession({ status: 'signedIn', account: `0x${'21'.repeat(20)}`, personId: 'open-pending' });
    const router = routerAt('/tickets');
    await waitFor(() => expect(router.state.location.pathname).toBe('/start'));
    expect(returnToOf(router)).toBe('/tickets');
  });

  it('offers a fresh start instead of an SMS check on /recover', async () => {
    setSession({ status: 'signedIn', account: `0x${'22'.repeat(20)}`, personId: 'open-recover' });
    routerAt('/recover');
    expect(await screen.findByRole('heading', { name: startEn.recoverTitle })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: startEn.recoverCta })).toBeInTheDocument();
  });

  it('keeps a shared link\'s destination once the session turns signedIn on /start', async () => {
    setSession({ status: 'anonymous' });
    const router = routerAt('/claim/1001');
    await screen.findByRole('heading', { name: startEn.title });
    expect(router.state.location.pathname).toBe('/start');
    expect(returnToOf(router)).toBe('/claim/1001');

    // What Get started ends with: registration known done, then the hydrator reads the claims.
    markRegistered();
    act(() => setSession({ status: 'signedIn', account: `0x${'25'.repeat(20)}`, personId: 'open-link' }));

    expect(await screen.findByRole('heading', { name: 'claim screen' })).toBeInTheDocument();
    // The exiting /start screen must not redirect again once its slide-out is over.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(router.state.location.pathname).toBe('/claim/1001');
  });

  it('lets a returning visitor whose persisted session has the claims straight in', async () => {
    setSession({ status: 'signedIn', account: `0x${'23'.repeat(20)}`, personId: 'open-back' });
    const router = routerAt('/tickets');
    await screen.findByRole('link', { name: en.tabs.tickets });
    expect(router.state.location.pathname).toBe('/tickets');
  });
});

describe('routing with VITE_AUTH_MODE unset (phone mode)', () => {
  it('keeps the guarded-route redirect on /login', async () => {
    setSession({ status: 'anonymous' });
    const router = routerAt('/claim/7');
    await screen.findByRole('heading', { name: en.login.title });
    expect(router.state.location.pathname).toBe('/login');
    expect(returnToOf(router)).toBe('/claim/7');
  });

  it('keeps the phone-mode entry screens where they are', async () => {
    setSession({ status: 'anonymous' });
    for (const path of ['/login', '/signup/phone', '/signup/register']) {
      const router = routerAt(path);
      await screen.findAllByRole('main');
      expect(router.state.location.pathname, path).toBe(path);
      cleanup();
    }
  });

  it('keeps sending a pending signup to /signup/register', async () => {
    getSignupStatus.mockResolvedValue({ status: 'pending', kycLevel: 0 });
    setSession({ status: 'signedIn', account: `0x${'24'.repeat(20)}`, personId: 'phone-pending' });
    const router = routerAt('/tickets');
    await waitFor(() => expect(router.state.location.pathname).toBe('/signup/register'));
    expect(returnToOf(router)).toBe('/tickets');
  });

  it('keeps /start out of the way: it is not the redirect target', async () => {
    vi.stubEnv('VITE_AUTH_MODE', 'phone');
    setSession({ status: 'anonymous' });
    const router = routerAt('/tickets');
    await screen.findByRole('heading', { name: en.login.title });
    expect(router.state.location.pathname).toBe('/login');
  });
});
