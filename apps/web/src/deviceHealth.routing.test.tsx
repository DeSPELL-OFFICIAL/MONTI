import { render, waitFor } from '@testing-library/react';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The route table is about addresses; the register/recover screens mint a challenge the moment
// they draw, so the callable is stubbed and nothing here asserts on it.
const getSignupStatus = vi.fn(async () => ({ status: 'active', kycLevel: 0 }));
const loginChallenge = vi.fn(async () => ({ challenge: 'c'.repeat(43), expiresAt: 0 }));
vi.mock('./shared/api/functions', async (orig) => ({
  ...(await orig<typeof import('./shared/api/functions')>()),
  api: { getSignupStatus, loginChallenge },
}));

// The organiser home opens a connection on some routes; this file is about routing.
vi.mock('./organizer/useMyOrgs', () => ({
  useMyOrgs: () => ({ orgs: [], canCreateEvent: false, isLoading: false, isError: false, error: null, refetch: () => undefined }),
  useOrgEvents: () => ({ events: [], isLoading: false, isError: false, error: null, refetch: () => undefined }),
}));

// The health verdict is what this file drives; the check itself is unit-tested in deviceHealth.test.ts.
let health: 'healthy' | 'needs-recovery' | 'unknown' = 'needs-recovery';
vi.mock('./shared/deviceHealth', async (orig) => ({
  ...(await orig<typeof import('./shared/deviceHealth')>()),
  useDeviceHealth: () => health,
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
  health = 'needs-recovery';
});

describe('the device-key health guard', () => {
  /**
   * The whole gap: a synced passkey signs a person in on a browser with no usable device key, and
   * they would only find out at a claim or a door. The guard sends them to /recover instead.
   */
  it('sends a signed-in person whose device key is unhealthy to /recover', async () => {
    health = 'needs-recovery';
    const router = routerAt('/me/verify');
    await waitFor(() => expect(router.state.location.pathname).toBe('/recover'));
    // `replace`: the screen they cannot use must not be one Back step away.
    expect(router.state.historyAction).toBe('REPLACE');
  });

  it('leaves a healthy device exactly where it asked to be', async () => {
    health = 'healthy';
    const router = routerAt('/me/verify');
    await waitFor(() => expect(getSignupStatus).toHaveBeenCalled());
    expect(router.state.location.pathname).toBe('/me/verify');
  });

  it('never blocks when health is unknown (chain unreachable, or a native device)', async () => {
    health = 'unknown';
    const router = routerAt('/tickets');
    await waitFor(() => expect(getSignupStatus).toHaveBeenCalled());
    expect(router.state.location.pathname).toBe('/tickets');
  });
});
