import { render, screen } from '@testing-library/react';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { hasReducedMotionListener, prefersReducedMotion } from 'motion/react';
import { MotionProvider } from './motion';
import { routes } from '../router';

/**
 * framer caches the reduced-motion preference in module state the first time any animated
 * component mounts, so a test that changes the media query has to clear that cache before it
 * takes — and again afterwards, so the change never leaks into the next test.
 */
function resetReducedMotionCache(): void {
  hasReducedMotionListener.current = false;
  prefersReducedMotion.current = null;
}

function reduceMotion(on: boolean): void {
  window.matchMedia = ((query: string) => ({
    matches: on,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  resetReducedMotionCache();
}

function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  return render(
    <MotionProvider>
      <RouterProvider router={router} />
    </MotionProvider>,
  );
}

afterEach(resetReducedMotionCache);

describe('motion foundation', () => {
  it('renders the target screen through the animated route region', async () => {
    // `/login` is public, so no session is needed to reach it through the shell.
    const { container } = renderAt('/login');
    expect(await screen.findByRole('heading', { name: '다시 오셨네요' })).toBeInTheDocument();
    // The screen came through the sliding wrapper, not a bare outlet.
    expect(container.querySelector('.route-view')).not.toBeNull();
  });

  it('drops the slide entirely under reduced motion', async () => {
    reduceMotion(true);
    const { container } = renderAt('/login');
    // The same screen is on the page...
    expect(await screen.findByRole('heading', { name: '다시 오셨네요' })).toBeInTheDocument();
    // ...but the transform wrapper is gone: the outlet is rendered straight, an instant cut.
    expect(container.querySelector('.route-view')).toBeNull();
  });
});
