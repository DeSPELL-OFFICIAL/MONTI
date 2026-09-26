import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, vi } from 'vitest';
import { initI18n } from './src/shared/i18n';

// Component tests assert Korean copy; initialise i18next for real instead of
// relying on react-i18next's uninitialised stub falling back to ko by accident.
beforeAll(async () => {
  await initI18n('ko');
});

/**
 * jsdom ships no `matchMedia`, and framer's `useReducedMotion()` calls it the moment any
 * animated component mounts — without this the whole suite would throw. The default answers "no
 * media matches", i.e. motion is on, which is the state most tests want. A test that needs
 * reduced motion overrides `window.matchMedia` itself (see `motion.test.tsx`); this resets to
 * the default before each test so that override never leaks.
 */
function defaultMatchMedia(query: string): MediaQueryList {
  return {
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  } as unknown as MediaQueryList;
}

beforeEach(() => {
  // Some suites opt into the node environment (`// @vitest-environment node`), where there is no
  // `window`; only the jsdom suites need the mock.
  if (typeof window !== 'undefined') {
    window.matchMedia = defaultMatchMedia as typeof window.matchMedia;
  }
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

if (!globalThis.crypto?.getRandomValues) {
  throw new Error('WebCrypto is required for these tests; use Node 22+');
}
