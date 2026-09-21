import type { CapacitorConfig } from '@capacitor/cli';

import attendee from './capacitor.attendee.config';
import staff from './capacitor.staff.config';

/**
 * The Capacitor CLI reads exactly this file name, from the current directory: `cap` has no
 * `--config` flag and no config environment variable (`@capacitor/cli` 8.5.2, `dist/config.js` →
 * `loadExtConfig(process.cwd())` with `CONFIG_FILE_NAME_TS` hardcoded). One app directory that
 * ships more than one APK therefore has to select its flavor here.
 *
 * `MONTI_APP_FLAVOR` is required rather than defaulted. A default would let a forgotten variable
 * build one flavor's web assets under the other flavor's application id — which is invisible
 * until an APK is installed and the wrong app opens.
 */
const FLAVORS: Record<string, CapacitorConfig> = { attendee, staff };

function selectedFlavor(): CapacitorConfig {
  const flavor = process.env.MONTI_APP_FLAVOR ?? '';
  const config = FLAVORS[flavor];
  if (!config) {
    throw new Error(
      `MONTI_APP_FLAVOR must be one of ${Object.keys(FLAVORS).join(', ')}; got ${JSON.stringify(flavor)}. ` +
        'Use the package scripts (pnpm sync:attendee, pnpm sync:staff) rather than calling cap directly.',
    );
  }
  return config;
}

export default selectedFlavor();
