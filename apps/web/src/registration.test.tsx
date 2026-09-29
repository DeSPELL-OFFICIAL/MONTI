import { render, screen, waitFor } from '@testing-library/react';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getSignupStatus = vi.fn(async () => ({ status: 'active', kycLevel: 0 }));
vi.mock('./shared/api/functions', async (orig) => ({
  ...(await orig<typeof import('./shared/api/functions')>()),
  api: { getSignupStatus },
}));

vi.mock('./shared/deviceHealth', async (orig) => ({
  ...(await orig<typeof import('./shared/deviceHealth')>()),
  // This file is about the route table / the signup guard, not device health; a healthy-enough
  // "unknown" keeps the health guard from redirecting the signed-in routes under test to /recover.
  useDeviceHealth: () => 'unknown',
}));

const { routes } = await import('./router');
const { queryClient } = await import('./shared/query');
const { setSession } = await import('./shared/session');
const { resetRegistration } = await import('./shared/registration');

const PERSON_ID = `0x${'aa'.repeat(32)}`;
const ACCOUNT = `0x${'ab'.repeat(20)}` as `0x${string}`;

function routerAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

beforeEach(() => {
  resetRegistration();
  sessionStorage.clear();
  getSignupStatus.mockResolvedValue({ status: 'active', kycLevel: 0 });
  setSession({ status: 'signedIn', personId: PERSON_ID, account: ACCOUNT });
});

describe('the unfinished-signup guard', () => {
  /**
   * The whole bug in one test: a person whose chain registration never happened is signed in,
   * looks signed in, and is refused by `startKyc` with `NOT_ACTIVE`. Sending them to the one
   * screen that can fix it — and remembering where they were going — is the fix.
   */
  it('sends a person who never finished signup to the register screen, carrying where they were going', async () => {
    getSignupStatus.mockResolvedValue({ status: 'pending', kycLevel: 0 });
    const router = routerAt('/me/verify');

    await waitFor(() => expect(router.state.location.pathname).toBe('/signup/register'));
    expect(new URLSearchParams(router.state.location.search).get('returnTo')).toBe('/me/verify');
    // `replace`: the screen they could not use must not be one Back step away.
    expect(router.state.historyAction).toBe('REPLACE');
  });

  it('leaves a finished person exactly where they asked to be', async () => {
    const router = routerAt('/me/verify');

    await waitFor(() => expect(getSignupStatus).toHaveBeenCalled());
    expect(router.state.location.pathname).toBe('/me/verify');
  });

  it('asks the server once, however many guarded screens are opened', async () => {
    const router = routerAt('/tickets');
    await waitFor(() => expect(getSignupStatus).toHaveBeenCalled());
    await router.navigate('/me');
    await waitFor(() => expect(router.state.location.pathname).toBe('/me'));

    expect(getSignupStatus).toHaveBeenCalledTimes(1);
  });

  /** A dropped connection is not an answer, and must never push a finished person into signup. */
  it('does not interrupt anyone when the question cannot be answered', async () => {
    getSignupStatus.mockRejectedValue(new Error('offline'));
    const router = routerAt('/me/verify');

    await waitFor(() => expect(getSignupStatus).toHaveBeenCalled());
    expect(router.state.location.pathname).toBe('/me/verify');
  });

  it('never asks on behalf of somebody who is not signed in', async () => {
    setSession({ status: 'anonymous' });
    const router = routerAt('/me/verify');

    expect(await screen.findByRole('heading', { name: '다시 오셨네요' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/login');
    expect(getSignupStatus).not.toHaveBeenCalled();
  });
});
