import type { CapacitorConfig } from '@capacitor/cli';

/**
 * The attendee Android build. Android only by founder decision — iOS comes after the hackathon,
 * so there is no `ios` key, no Info.plist, no entitlements and no App Site Association here.
 *
 * `app.monti` is the id the web branch's Digital Asset Links placeholder already names
 * (`apps/web/public/.well-known/assetlinks.json`), so the app link and the passkey credential
 * both resolve against the same package. The gate app is `app.monti.staff`: two ids, two APKs,
 * side by side on a staff member's own phone.
 *
 * `android.path` is Capacitor's own default, written out rather than left implicit: the staff
 * flavor has to override it (`android-staff`), and a reader comparing the two files should see
 * the pair, not one path and one absence.
 */
const config: CapacitorConfig = {
  appId: 'app.monti',
  appName: 'MONTI',
  webDir: 'dist',
  android: {
    path: 'android',
    /**
     * An allowlist, not a filter: with `includePlugins` set, `cap sync` links exactly these and
     * `getDependencies()` is never consulted (`@capacitor/cli` 8.5.2, `dist/plugin.js:25`).
     * Anything dropped from this array vanishes from the native project, so each name below is
     * a package `apps/web/src` actually calls.
     *
     * Two are deliberately absent, and they are the two that make the flavors disjoint:
     *
     * - `@monti/hce-android` — card emulation is the gate phone's job. Its library manifest
     *   registers a `HostApduService` with `BIND_NFC_SERVICE`; linked here, the attendee APK
     *   would advertise itself in the system's "tap and pay" list for an AID it never serves.
     * - `@capacitor-mlkit/barcode-scanning` — only `src/staff/qr/scan.ts` imports it (the gate's
     *   fallback when an attendee's phone cannot write a tag). The attendee *shows* the
     *   `MONTI1:` code with the `qrcode` JS library; it never reads one. Leaving ML Kit out
     *   keeps the camera permission and the model download out of the attendee APK entirely.
     *
     * `@capgo/capacitor-nfc` is the mirror image: the reader/writer belongs to this flavor and
     * is excluded from the staff one.
     */
    includePlugins: [
      '@capacitor-firebase/authentication',
      '@capacitor/app',
      '@capacitor/browser',
      '@capacitor/preferences',
      '@capacitor/push-notifications',
      '@capgo/capacitor-nfc',
      '@capgo/capacitor-passkey',
      '@monti/device-key',
    ],
  },
  plugins: {
    /**
     * The relying party stays the web origin, so one passkey is the same credential on the site
     * and in the APK. Unlike the staff project, this one sits at `android/` — the exact path
     * `@capgo/capacitor-passkey`'s sync hook hardcodes (`scripts/configure-native.js:123`) — so
     * the hook writes `res/values/capacitor-passkey.xml` and the manifest `<meta-data>` itself
     * on every `cap sync`, and androidProjects.test.ts pins what it wrote.
     *
     * Still outside this repository and still blocking sign-in on a real device: the signing
     * certificate SHA-256 in `https://monti.despell.io/.well-known/assetlinks.json`, and
     * `android:apk-key-hash:<ANDROID_APK_KEY_HASH>` in the server's allowed-origin list —
     * Android Credential Manager reports the app signature, not the website, as
     * `clientDataJSON.origin`. Both wait on a signing key that does not exist yet.
     */
    CapacitorPasskey: { origin: 'https://monti.despell.io' },
  },
};

export default config;
