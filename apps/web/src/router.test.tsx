import { cleanup, render, screen } from '@testing-library/react';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';

// The organiser home asks the indexer who this person organises for. This file is about the
// route table, so both hooks answer "nobody" rather than opening a connection.
vi.mock('./organizer/useMyOrgs', () => ({
  useMyOrgs: () => ({ orgs: [], canCreateEvent: false, isLoading: false, isError: false, error: null, refetch: () => undefined }),
  useOrgEvents: () => ({ events: [], isLoading: false, isError: false, error: null, refetch: () => undefined }),
}));

/**
 * The register screen mints its passkey challenge the moment it is drawn, so the two redirect
 * tests below would otherwise open a real callable. Nothing here asserts on it — what is under
 * test is the address, not the ceremony.
 */
const loginChallenge = vi.fn(async () => ({ challenge: 'c'.repeat(43), expiresAt: 0 }));
const getSignupStatus = vi.fn(async () => ({ status: 'active', kycLevel: 0 }));
vi.mock('./shared/api/functions', async (orig) => ({
  ...(await orig<typeof import('./shared/api/functions')>()),
  api: { loginChallenge, getSignupStatus },
}));

// Imported after the mocks rather than above them: `vi.mock` is hoisted, and a factory that
// closes over the stubs above cannot run before they exist.
vi.mock('./shared/deviceHealth', async (orig) => ({
  ...(await orig<typeof import('./shared/deviceHealth')>()),
  // This file is about the route table / the signup guard, not device health; a healthy-enough
  // "unknown" keeps the health guard from redirecting the signed-in routes under test to /recover.
  useDeviceHealth: () => 'unknown',
}));

const { routes } = await import('./router');
const { queryClient } = await import('./shared/query');
const { bootSession, getSession, registerSessionHydrator, setSession } = await import('./shared/session');

function routerAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

function renderAt(path: string) {
  routerAt(path);
}

describe('router', () => {
  it('shows the bottom tabs on an attendee tab route', async () => {
    setSession({ status: 'signedIn', account: `0x${'11'.repeat(20)}`, personId: 'p1' });
    renderAt('/tickets');
    expect(await screen.findByRole('link', { name: 'Tickets' })).toBeInTheDocument();
  });

  it('hides the bottom tabs during signup', async () => {
    setSession({ status: 'anonymous' });
    renderAt('/signup/phone');
    expect(await screen.findByRole('main')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Tickets' })).toBeNull();
  });

  /**
   * Four tabs stay four: `/org` is reached from the explore FAB and from the profile, and it
   * carries its own `탐색으로` link back. Adding it to `TAB_PATHS` would give an attendee a
   * fifth tab for a screen most of them have no use for.
   */
  it('hides the bottom tabs on the organiser home', async () => {
    setSession({ status: 'signedIn', account: `0x${'44'.repeat(20)}`, personId: 'p4' });
    renderAt('/org');
    expect(await screen.findByRole('heading', { name: 'Organizer' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Tickets' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Back to explore' })).toBeInTheDocument();
  });

  it('redirects a protected route to /login when signed out', async () => {
    setSession({ status: 'anonymous' });
    const router = routerAt('/me?tab=1');
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    // Where they were going rides along, so sign-in (or signup) can put them back there.
    expect(router.state.location.pathname).toBe('/login');
    expect(new URLSearchParams(router.state.location.search).get('returnTo')).toBe('/me?tab=1');
  });

  it('never leaves a guarded route stuck on loading after a cold boot', async () => {
    setSession({ status: 'loading' });
    bootSession();
    expect(getSession().status).toBe('anonymous');
    renderAt('/tickets');
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
  });

  /**
   * A session opened before the web return address existed comes back to the server's own
   * default, `https://<rp>/kyc/callback`. Without this route the catch-all drops the person on
   * the explore tab with no sign that the check ever finished.
   */
  it('forwards the hosted verification callback to the verification screen', async () => {
    setSession({ status: 'signedIn', account: `0x${'33'.repeat(20)}`, personId: 'p3' });
    const router = routerAt('/kyc/callback?returnTo=%2Fme%2Fverify%3FreturnTo%3D%2Fclaim%2F1');
    await screen.findByRole('main');
    expect(router.state.location.pathname).toBe('/me/verify');
    expect(new URLSearchParams(router.state.location.search).get('returnTo')).toBe('/claim/1');
  });

  it('sends a callback with nowhere to go back to the profile', async () => {
    setSession({ status: 'signedIn', account: `0x${'33'.repeat(20)}`, personId: 'p3' });
    const router = routerAt('/kyc/callback');
    await screen.findByRole('main');
    expect(router.state.location.pathname).toBe('/me');
  });

  /**
   * `/signup/passkey` and `/signup/device` were the two screens `/signup/register` replaced.
   * Addresses to them are already in the wild — an old tab, a text somebody sent themselves —
   * and a dead route would drop them on the explore tab with their signup half finished.
   */
  it('forwards both of the signup screens that were merged away', async () => {
    setSession({ status: 'anonymous' });
    for (const gone of ['/signup/passkey', '/signup/device']) {
      const router = routerAt(gone);
      await screen.findAllByRole('main');
      expect(router.state.location.pathname, gone).toBe('/signup/register');
      expect(router.state.historyAction, gone).toBe('REPLACE');
      cleanup();
    }
  });

  /**
   * The query has to travel with them. `returnTo` is what tells the register screen this is an
   * account being finished rather than a signup running its last step — the router's own guard
   * sets it (`FinishSignupFirst`), and without it that person lands on the explore tab instead
   * of the screen they were refused from.
   */
  it('carries returnTo across the redirect, which is what the guard puts there', async () => {
    setSession({ status: 'anonymous' });
    const router = routerAt('/signup/device?returnTo=%2Fme%2Fverify%3FreturnTo%3D%2Fclaim%2F1');
    await screen.findAllByRole('main');
    expect(router.state.location.pathname).toBe('/signup/register');
    expect(new URLSearchParams(router.state.location.search).get('returnTo'))
      .toBe('/me/verify?returnTo=/claim/1');
  });

  it('uses a registered hydrator when one exists', async () => {
    setSession({ status: 'loading' });
    registerSessionHydrator((set) => {
      set({ status: 'signedIn', account: `0x${'22'.repeat(20)}`, personId: 'p2' });
      return () => undefined;
    });
    bootSession();
    expect(getSession()).toMatchObject({ status: 'signedIn', personId: 'p2' });
    registerSessionHydrator(null);
  });
});
