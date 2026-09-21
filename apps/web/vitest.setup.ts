import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeAll, vi } from 'vitest';
import { initI18n } from './src/shared/i18n';

// Component tests assert Korean copy; initialise i18next for real instead of
// relying on react-i18next's uninitialised stub falling back to ko by accident.
beforeAll(async () => {
  await initI18n('ko');
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

if (!globalThis.crypto?.getRandomValues) {
  throw new Error('WebCrypto is required for these tests; use Node 22+');
}
