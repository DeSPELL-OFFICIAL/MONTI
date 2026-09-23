// vitest/config re-exports Vite's defineConfig with the `test` key typed.
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

/**
 * The config is a function so the sourcemap decision reads the resolved `mode` rather than an
 * ambient `process.env` that `vite build` may never have set. A production map is copied into
 * the Android APK by `cap sync` and hands whoever unpacks it the entire source; every other
 * mode — the dev server, vitest — keeps it, because that is where a stack trace gets read.
 */
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  server: { host: '0.0.0.0', port: 5173 },
  build: { outDir: 'dist', sourcemap: mode !== 'production', target: 'es2022' },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    restoreMocks: true,
  },
}));
