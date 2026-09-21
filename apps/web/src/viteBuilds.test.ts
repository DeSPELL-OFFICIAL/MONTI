// @vitest-environment node
//
// Both config modules import `vite`, and `vite` loads esbuild, which refuses to start under
// jsdom's TextEncoder ("Invariant violation: `new TextEncoder().encode("") instanceof Uint8Array`
// is incorrectly false"). Nothing in this file touches the DOM, so it runs in node instead.
import type { ConfigEnv } from 'vite';
import { describe, expect, it } from 'vitest';

import packageJson from '../package.json?raw';
import attendeeConfig from '../vite.config';
import staffConfig from '../vite.staff.config';

/**
 * A sourcemap that survives `vite build` does not stop at `dist/`. `pnpm sync:attendee` and
 * `pnpm sync:staff` each run a build and then `cap sync`, which copies the whole output directory
 * into `app/src/main/assets/public/` — so `sourcemap: true` put a 1.3 MB `.js.map` beside a 226 kB
 * bundle inside the APK, and shipped readable source with it.
 *
 * `mode` is the switch, because it is the one thing that already separates the two cases: `vite
 * build` defaults to `production`, and the package scripts add no `--mode`, so every build that
 * becomes an APK asset is a production build. `--mode development` is the debug build and keeps
 * the map. The dev server is out of scope either way — it never reads `build.sourcemap`, it
 * serves its own inline maps — and `vite preview` simply replays the last `vite build`.
 *
 * These call the config functions directly rather than reading their text: a string search would
 * pass for `sourcemap` spelled anywhere in the file, including inside this very comment.
 */

const PRODUCTION: ConfigEnv = { command: 'build', mode: 'production' };
const DEVELOPMENT: ConfigEnv = { command: 'build', mode: 'development' };

const scripts = (JSON.parse(packageJson) as { scripts: Record<string, string> }).scripts;

describe('neither flavor ships a sourcemap into its APK', () => {
  it('is a function of `mode`, or the mode could not reach it at all', () => {
    expect(typeof attendeeConfig).toBe('function');
    expect(typeof staffConfig).toBe('function');
  });

  it('drops the attendee map in a production build and keeps it in a development one', () => {
    expect(attendeeConfig(PRODUCTION).build?.sourcemap).toBe(false);
    expect(attendeeConfig(DEVELOPMENT).build?.sourcemap).toBe(true);
  });

  it('drops the staff map in a production build and keeps it in a development one', () => {
    expect(staffConfig(PRODUCTION).build?.sourcemap).toBe(false);
    expect(staffConfig(DEVELOPMENT).build?.sourcemap).toBe(true);
  });

  it('is the mode the scripts that feed `cap sync` actually take', () => {
    // No `--mode` anywhere, so both builds are `production` and both hit the branch above.
    expect(scripts.build).toContain('vite build');
    expect(scripts['build:staff']).toContain('vite build');
    expect(scripts.build).not.toContain('--mode');
    expect(scripts['build:staff']).not.toContain('--mode');
    expect(scripts['sync:attendee']).toContain('pnpm build');
    expect(scripts['sync:staff']).toContain('pnpm build:staff');
  });

  it('keeps each flavor writing the output directory its Capacitor webDir names', () => {
    // A shared outDir would make the two `cap sync` runs copy each other's bundle.
    expect(attendeeConfig(PRODUCTION).build?.outDir).toBe('dist');
    expect(staffConfig(PRODUCTION).build?.outDir).toBe('dist-staff');
  });
});
