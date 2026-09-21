import { render, screen } from '@testing-library/react';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { routes } from './router';
import { queryClient } from './shared/query';
import { bootSession, getSession, registerSessionHydrator, setSession } from './shared/session';

function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
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
