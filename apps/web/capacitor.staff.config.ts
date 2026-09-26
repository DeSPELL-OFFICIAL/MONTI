import type { CapacitorConfig } from '@capacitor/cli';

/**
 * The staff-only Android build. Android only by founder decision — there is no iOS target, no
 * Apple App Site Association and no universal links in this sub-plan, because HCE (the gate
 * phone emulating a tag) has no iOS equivalent at all.
 *
 * `app.monti.staff` is a different application id from the attendee build on purpose: the two
 * APKs sit side by side on a staff member's own phone, and only this one registers the HCE
 * service and asks for the gate key.
 *
 * `android.path` keeps the generated project out of the attendee build's `android/`, so the two
 * native projects never share a Gradle file.
 */
const config: CapacitorConfig = {
  appId: 'app.monti.staff',
  appName: 'MONTI Staff',
  webDir: 'dist-staff',
  android: {
    path: 'android-staff',
    /**
     * An allowlist, not a filter: with `includePlugins` set, `cap sync` links exactly these and
     * `getDependencies()` is never consulted (`@capacitor/cli` 8.5.2, `dist/plugin.js:25`).
     *
     * The Capgo NFC reader package — the one `capacitor.attendee.config.ts` lists and this file
     * does not — is deliberately absent, and `noReaderMode.test.ts` asserts on *this array* that
     * no reader package is in it. The gate phone emulates a tag; it never opens a reader
     * session. Before this list existed the reader plugin was still linked into the APK: a
     * registered native plugin one `Capacitor.Plugins` lookup away from that text scan, plus an
     * `android.permission.NFC` the gate build never used. Dropping the module removes the
     * reachable surface rather than only forbidding the names that reach it.
     *
     * `@monti/hce-android` is the mirror image: card emulation belongs to this flavor and is
     * excluded from the attendee one.
     */
    includePlugins: [
      '@capacitor-firebase/authentication',
      '@capacitor-mlkit/barcode-scanning',
      '@capacitor/app',
      '@capacitor/browser',
      '@capacitor/preferences',
      '@capacitor/push-notifications',
      '@capgo/capacitor-passkey',
      '@monti/device-key',
      '@monti/hce-android',
    ],
  },
  plugins: {
    /**
     * The relying party stays the web origin: a staff member's passkey is the same credential
     * whether they signed in on the site or in this APK. The plugin's sync hook turns this into
     * the app's Digital Asset Links declaration.
     *
     * ⚠ `@capgo/capacitor-passkey`'s sync hook cannot see `android.path`. Its
     * `scripts/configure-native.js:124-125` joins `rootDir` with the literal `'android'`, so
     * `pnpm sync:staff` never touches `android-staff/` — it rewrites the **attendee** project's
     * `android/app/src/main/res/values/capacitor-passkey.xml` and its manifest `<meta-data>`,
     * from the origin *this* file declares. That is harmless only while both flavors declare the
     * same origin, which they do (`androidProjects.test.ts` asserts the two are equal). The day
     * they diverge, a staff sync would silently repoint the attendee APK's Digital Asset Links at
     * the staff origin; the pin tests are what catch it — `androidProjects.test.ts` reads the
     * attendee XML against the attendee origin, and `src/staff/androidProject.test.ts` reads
     * `android-staff/`'s hand-written copy, which no hook maintains.
     *
     * Two halves of this are not in this repository and block staff sign-in on a real device:
     * `https://monti.despell.io/.well-known/assetlinks.json` has to list the APK's signing
     * certificate SHA-256, and the server's allowed-origin list has to accept
     * `android:apk-key-hash:<ANDROID_APK_KEY_HASH>` beside the web origin. Android Credential
     * Manager reports the app signature, not the website, as `clientDataJSON.origin`. Both wait
     * on a signing key that does not exist yet — see the Task 10 report.
     */
    CapacitorPasskey: { origin: 'https://monti.despell.io' },
  },
};

export default config;
