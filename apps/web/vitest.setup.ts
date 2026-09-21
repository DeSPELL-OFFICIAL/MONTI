import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

if (!globalThis.crypto?.getRandomValues) {
  throw new Error('WebCrypto is required for these tests; use Node 22+');
}
