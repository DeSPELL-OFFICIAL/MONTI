// vitest/config re-exports Vite's defineConfig with the `test` key typed.
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

/**
 * `mode` is the only thing that separates a bundle that becomes an APK asset from one a human
 * steps through, so it is what decides the sourcemap.
 *
 * `vite build` defaults to mode `production`, and `pnpm sync:attendee` runs exactly that before
 * `cap sync` copies `dist/` into `android/app/src/main/assets/public/`. With `sourcemap: true`
 * the `.js.map` went in too — megabytes of readable source inside the APK, for nobody. A debug
 * build loses nothing: `vite build --mode development` still writes the map.
 *
 * The dev server never reads `build.sourcemap` at all — it serves its own inline maps — so
 * `pnpm dev` is unaffected. `vite preview` replays whatever `vite build` last wrote, so
 * previewing with sources is `vite build --mode development && pnpm preview`.
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
