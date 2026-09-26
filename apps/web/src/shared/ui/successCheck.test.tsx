import { render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { hasReducedMotionListener, prefersReducedMotion } from 'motion/react';
import { SuccessCheck } from './SuccessCheck';

/**
 * framer caches the reduced-motion preference in module state the first time any animated
 * component mounts, so a test that changes the media query has to clear that cache before it
 * takes — and again afterwards, so the change never leaks into the next test. (Same dance as
 * motion.test.tsx; the shared setup resets `matchMedia` itself before each test.)
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

afterEach(resetReducedMotionCache);

describe('the success mark', () => {
  it('draws a check and throws confetti when motion is on', () => {
    reduceMotion(false);
    const { container } = render(<SuccessCheck />);
    // The check itself is on the page — the ring and the tick path.
    expect(container.querySelector('.success-mark__tick')).not.toBeNull();
    // ...and the celebration around it.
    expect(container.querySelector('.confetti')).not.toBeNull();
    expect(container.querySelectorAll('.confetti__bit').length).toBeGreaterThan(0);
  });

  it('shows a still check and no confetti under reduced motion', () => {
    reduceMotion(true);
    const { container } = render(<SuccessCheck />);
    // The check still stands — just still, not drawn.
    expect(container.querySelector('.success-mark')).not.toBeNull();
    expect(container.querySelector('.success-mark__tick')).not.toBeNull();
    // Nothing is thrown: the confetti is not in the tree at all.
    expect(container.querySelector('.confetti')).toBeNull();
    expect(container.querySelectorAll('.confetti__bit').length).toBe(0);
  });
});
