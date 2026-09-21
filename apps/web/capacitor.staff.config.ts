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
  },
  plugins: {
    /**
     * The relying party stays the web origin: a staff member's passkey is the same credential
     * whether they signed in on the site or in this APK. The plugin's sync hook turns this into
     * the app's Digital Asset Links declaration.
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
