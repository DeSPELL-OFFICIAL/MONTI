import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import staffConfig from '../../capacitor.staff.config';

/**
 * Spec §11 and §18, as a test.
 *
 * The staff phone is the tag. The moment anything in this app turns on reader mode, the same
 * phone also tries to be the reader, and the two roles fight over one antenna: the attendee's
 * tap silently fails and neither side can say why. §18 puts the iPhone tap failure rate at 50%
 * for exactly this class of mistake, and it is the kind that arrives by import — someone reuses
 * the attendee's `readThenWrite` because it is already in the tree and does the right-looking
 * thing.
 *
 * So the rule is not "do not call the reader", it is "the reader API is not in this build's
 * reachable source at all", and that is what a static scan can actually hold.
 */

/** Vitest runs with `apps/web` as its root, the same anchor 02's consistency scan uses. */
const WEB = process.cwd();
const HERE = resolve(WEB, 'src/staff');
const REPO = resolve(WEB, '../..');

function walk(dir: string, match: RegExp): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return walk(full, match);
    return match.test(name) ? [full] : [];
  });
}

/**
 * Everything the staff APK is **built from** that could name a reader API: the staff app, the
 * entry the staff HTML loads, the HCE plugin's TypeScript, and the plugin's Kotlin and XML. The
 * Kotlin half has its own guard in `ApduServiceManifestTest`, but that one needs Gradle and an
 * Android SDK, neither of which exists on this machine — this is the copy that runs.
 *
 * Tests are left out, and deliberately: they do not ship, and a scan that included them would
 * be a scan that trips over every guard written in these same words — this file, the plugin's
 * `apduService.test.ts`, and the next one.
 */
const SCANNED = [
  ...walk(HERE, /\.tsx?$/),
  resolve(WEB, 'src/staffMain.tsx'),
  ...walk(resolve(REPO, 'plugins/hce-android/src'), /\.ts$/),
  ...walk(resolve(REPO, 'plugins/hce-android/android/src/main'), /\.(kt|xml)$/),
  resolve(WEB, 'android-staff/app/src/main/AndroidManifest.xml'),
].filter((file) => !/\.test\.tsx?$/.test(file));

const SOURCES = SCANNED.map((file) => ({
  file: relative(REPO, file),
  text: readFileSync(file, 'utf8'),
}));

/**
 * Two kinds of needle. The first three are the Android reader APIs themselves; the last four
 * are the JavaScript doors to them — the attendee's package, its two exported tap functions,
 * and the Web NFC reader the browser build falls back to.
 */
const FORBIDDEN = [
  'enableReaderMode',
  'enableForegroundDispatch',
  'NfcAdapter.ACTION_',
  '@capgo/capacitor-nfc',
  'NDEFReader',
  'readGateCode',
  'readThenWrite',
];

describe('the staff device never enables NFC reader mode', () => {
  it('scans the staff app, its entry and the HCE plugin', () => {
    // A walk that found nothing would make every assertion below vacuously true — the way this
    // guard dies is a renamed folder, not a removed test.
    expect(SOURCES.length).toBeGreaterThan(10);
    expect(SOURCES.map((source) => source.file)).toContain('apps/web/src/staffMain.tsx');
    expect(SOURCES.map((source) => source.file)).toContain('apps/web/src/staff/gate/emitter.ts');
    expect(
      SOURCES.some((source) => source.file.endsWith('.kt')),
      'the plugin’s Kotlin was not scanned',
    ).toBe(true);
  });

  it.each(FORBIDDEN)('never mentions %s', (needle) => {
    const offenders = SOURCES.filter((source) => source.text.includes(needle)).map((s) => s.file);
    expect(offenders, `${needle} found in:\n${offenders.join('\n')}`).toEqual([]);
  });

  /**
   * `shared/nfc/index.ts` re-exports the NDEF codec and `readThenWrite` from the same module.
   * Importing the folder rather than the file pulls the attendee's reader — and the Capgo
   * plugin behind it — into the staff bundle, where the next person to reach for autocomplete
   * finds it. The codec is allowed; the barrel that carries it is not.
   */
  it('reaches the NDEF codec by its own path, never through the reader barrel', () => {
    const barrel = /from\s+['"][^'"]*\/shared\/nfc['"]/;
    const offenders = SOURCES.filter((source) => barrel.test(source.text)).map((s) => s.file);
    expect(offenders, `imports the NFC barrel:\n${offenders.join('\n')}`).toEqual([]);
  });

  /**
   * The scan above cannot cover the Capacitor config — it is build configuration, not source that
   * ships — and reading its *text* was the wrong guard anyway. `expect(text).not.toContain(…)`
   * answers a different question than "is the plugin linked": it fires on a comment that merely
   * names the package (the config's own prose has to say "the Capgo NFC reader package" to stay
   * green), and it stays silent if the name ever arrives spread across a variable or a shared
   * constant. `includePlugins` is the array `cap sync` actually reads, so assert that.
   */
  it('links no reader plugin into the staff APK, and does link the two the gate needs', () => {
    const plugins = staffConfig.android?.includePlugins ?? [];
    // An empty or absent allowlist is the failure that looks like success: `cap sync` then falls
    // back to `getDependencies()` and links the reader along with everything else.
    expect(plugins.length, 'no allowlist means cap sync links every dependency').toBeGreaterThan(0);
    expect(
      plugins.filter((name) => /nfc/i.test(name)),
      'an NFC reader package is in the staff allowlist',
    ).toEqual([]);
    // Card emulation and the QR fallback are the gate's own two; losing either is a silent gate.
    expect(plugins).toContain('@monti/hce-android');
    expect(plugins).toContain('@capacitor-mlkit/barcode-scanning');
    expect(staffConfig.appId).toBe('app.monti.staff');
  });
});
