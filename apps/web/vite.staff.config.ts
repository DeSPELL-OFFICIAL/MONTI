import { renameSync } from 'node:fs';
import { resolve } from 'node:path';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * The staff APK's web build. It shares every line of `src/` with the attendee build — only the
 * entry point differs, so there is no second copy of a screen to keep in step.
 *
 * Capacitor serves `index.html` from the asset directory and nothing else, but a Rollup input of
 * `staff.html` writes `staff.html`. Renaming after the bundle is written is cheaper than a second
 * HTML file that exists only to be copied.
 */
export default defineConfig({
  plugins: [
    react(),
    {
      name: 'staff-html-entry',
      closeBundle() {
        renameSync(resolve(__dirname, 'dist-staff/staff.html'), resolve(__dirname, 'dist-staff/index.html'));
      },
    },
  ],
  define: { 'import.meta.env.VITE_APP_FLAVOR': JSON.stringify('staff') },
  build: {
    outDir: 'dist-staff',
    emptyOutDir: true,
    sourcemap: true,
    target: 'es2022',
    rollupOptions: { input: resolve(__dirname, 'staff.html') },
  },
});
