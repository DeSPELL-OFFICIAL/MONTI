import { render, screen } from '@testing-library/react';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';

// The organiser home asks the indexer who this person organises for. This file is about the
// route table, so both hooks answer "nobody" rather than opening a connection.
vi.mock('./organizer/useMyOrgs', () => ({
  useMyOrgs: () => ({ orgs: [], canCreateEvent: false, isLoading: false, isError: false, error: null, refetch: () => undefined }),
  useOrgEvents: () => ({ events: [], isLoading: false, isError: false, error: null, refetch: () => undefined }),
}));

import { routes } from './router';
import { queryClient } from './shared/query';
import { bootSession, getSession, registerSessionHydrator, setSession } from './shared/session';

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
    expect(await screen.findByRole('link', { name: '내 티켓' })).toBeInTheDocument();
  });

  it('hides the bottom tabs during signup', async () => {
    setSession({ status: 'anonymous' });
    renderAt('/signup/phone');
    expect(await screen.findByRole('main')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '내 티켓' })).toBeNull();
  });

  /**
   * Four tabs stay four: `/org` is reached from the explore FAB and from the profile, and it
   * carries its own `탐색으로` link back. Adding it to `TAB_PATHS` would give an attendee a
   * fifth tab for a screen most of them have no use for.
   */
  it('hides the bottom tabs on the organiser home', async () => {
    setSession({ status: 'signedIn', account: `0x${'44'.repeat(20)}`, personId: 'p4' });
    renderAt('/org');
    expect(await screen.findByRole('heading', { name: '주최자' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '내 티켓' })).toBeNull();
    expect(screen.getByRole('link', { name: '탐색으로' })).toBeInTheDocument();
  });

  it('redirects a protected route to /login when signed out', async () => {
    setSession({ status: 'anonymous' });
    renderAt('/me');
    expect(await screen.findByRole('heading', { name: '다시 오셨네요' })).toBeInTheDocument();
  });

  it('never leaves a guarded route stuck on loading after a cold boot', async () => {
    setSession({ status: 'loading' });
    bootSession();
    expect(getSession().status).toBe('anonymous');
    renderAt('/tickets');
    expect(await screen.findByRole('heading', { name: '다시 오셨네요' })).toBeInTheDocument();
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
