import { afterEach, describe, expect, it, vi } from 'vitest';

import attendeeConfig from '../capacitor.attendee.config';
import staffConfig from '../capacitor.staff.config';
import attendeeAppBuildGradle from '../android/app/build.gradle?raw';
import attendeeCapacitorBuildGradle from '../android/app/capacitor.build.gradle?raw';
import attendeeCapacitorSettingsGradle from '../android/capacitor.settings.gradle?raw';
import attendeeManifestXml from '../android/app/src/main/AndroidManifest.xml?raw';
import attendeePasskeyValuesXml from '../android/app/src/main/res/values/capacitor-passkey.xml?raw';
import attendeeVariablesGradle from '../android/variables.gradle?raw';
import staffCapacitorBuildGradle from '../android-staff/app/capacitor.build.gradle?raw';
import staffCapacitorSettingsGradle from '../android-staff/capacitor.settings.gradle?raw';
import staffManifestXml from '../android-staff/app/src/main/AndroidManifest.xml?raw';
import deviceKeyPluginGradle from '../../../plugins/device-key/android/build.gradle?raw';
import hcePluginGradle from '../../../plugins/hce-android/android/build.gradle?raw';

/**
 * The attendee half of what `src/staff/androidProject.test.ts` does for the gate APK, plus the
 * one thing neither file could assert alone: that the two flavors link *disjoint* plugin sets.
 *
 * It lives at the top of `src/` rather than under `attendee/` because half of it reads
 * `android-staff/`; it is a statement about the pair, not about either app's screens.
 *
 * There is still no Android SDK on this machine, so `android/` has never been compiled and no
 * APK exists. Everything Gradle would have caught is caught here instead, by reading the files
 * the founder's machine will feed to Gradle unchanged. Each of these is silent when wrong: a
 * drifted `applicationId` breaks the asset links the invite deep link and the passkey both rest
 * on; a missing `pathPrefix` sends the SMS invite to the browser instead of the app; a linked
 * HCE module puts the attendee app in the system "tap and pay" list for an AID it never serves.
 */

// ── a very small XML scanner (it keeps track of which element an attribute sits on) ──

type Attributes = Readonly<Record<string, string>>;

function elements(xml: string, tag: string): Attributes[] {
  const body = xml.replace(/<!--[\s\S]*?-->/g, ' ');
  const open = new RegExp(`<${tag}(\\s[^>]*?)?/?>`, 'g');
  const found: Attributes[] = [];
  for (const match of body.matchAll(open)) {
    const attributes: Record<string, string> = {};
    for (const pair of (match[1] ?? '').matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) {
      attributes[pair[1] as string] = pair[2] as string;
    }
    found.push(attributes);
  }
  return found;
}

/** Every `<intent-filter>` body, so `<data>` can be read against the filter it belongs to. */
function intentFilters(xml: string): string[] {
  const body = xml.replace(/<!--[\s\S]*?-->/g, ' ');
  return [...body.matchAll(/<intent-filter(\s[^>]*?)?>([\s\S]*?)<\/intent-filter>/g)].map(
    (match) => `<intent-filter${match[1] ?? ''}>${match[2] ?? ''}`,
  );
}

/** `name = 31` / `name 31` / `name "app.monti"` out of a Gradle file, comments stripped. */
function gradleValue(gradle: string, name: string): string {
  const body = gradle.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
  const match = new RegExp(`\\b${name}\\b\\s*=?\\s*"?([\\w.]+)"?`).exec(body);
  if (!match?.[1]) throw new Error(`no ${name} in this Gradle file`);
  return match[1];
}

/** The Gradle module name `cap sync` derives from an npm package name. */
function gradleModuleOf(npmPackage: string): string {
  return npmPackage.replace(/^@/, '').replace(/[/@]/g, '-');
}

afterEach(() => {
  // `restoreMocks` in vite.config.ts does not cover env stubs (`unstubEnvs` defaults to false),
  // so a stubbed flavor would otherwise leak into whatever else shares this worker.
  vi.unstubAllEnvs();
});

describe('capacitor.attendee.config.ts', () => {
  it('is the Android-only attendee flavor, with its own app id and the default project path', () => {
    expect(attendeeConfig.appId).toBe('app.monti');
    expect(attendeeConfig.appName).toBe('MONTI');
    expect(attendeeConfig.webDir).toBe('dist');
    expect(attendeeConfig.android?.path).toBe('android');
  });

  it('declares no iOS target: iOS is after the hackathon', () => {
    expect(attendeeConfig.ios).toBeUndefined();
  });

  it('keeps the two app ids apart, so both APKs sit side by side on one phone', () => {
    expect(attendeeConfig.appId).not.toBe(staffConfig.appId);
  });
});

describe('capacitor.config.ts — the file the CLI actually reads', () => {
  it('resolves MONTI_APP_FLAVOR=attendee to the attendee config', async () => {
    vi.resetModules();
    vi.stubEnv('MONTI_APP_FLAVOR', 'attendee');
    const loaded = (await import('../capacitor.config')).default;
    expect(loaded.appId).toBe('app.monti');
    expect(loaded.android?.path).toBe('android');
  });

  it('still resolves MONTI_APP_FLAVOR=staff to the staff config', async () => {
    vi.resetModules();
    vi.stubEnv('MONTI_APP_FLAVOR', 'staff');
    const loaded = (await import('../capacitor.config')).default;
    expect(loaded.appId).toBe('app.monti.staff');
    expect(loaded.android?.path).toBe('android-staff');
  });

  it('names both flavors when it refuses to guess one', async () => {
    vi.resetModules();
    vi.stubEnv('MONTI_APP_FLAVOR', '');
    await expect(import('../capacitor.config')).rejects.toThrow(/attendee, staff/);
  });
});

describe('android/ — the generated attendee native project', () => {
  it('carries the attendee application id the asset links placeholder already names', () => {
    // `apps/web/public/.well-known/assetlinks.json` (mvp-web) declares `app.monti` for
    // `delegate_permission/common.handle_all_urls` *and* `…/common.get_login_creds`. That file
    // is on the other branch, so the id is restated here rather than imported; if it ever
    // changes, both the `/i/*` app link and the passkey stop verifying.
    expect(gradleValue(attendeeAppBuildGradle, 'applicationId')).toBe('app.monti');
    expect(gradleValue(attendeeAppBuildGradle, 'namespace')).toBe('app.monti');
  });

  it('requires NFC: an attendee whose phone cannot tap has no ticket to present', () => {
    const feature = elements(attendeeManifestXml, 'uses-feature').find(
      (attributes) => attributes['android:name'] === 'android.hardware.nfc',
    );
    expect(feature, 'the attendee manifest declares no android.hardware.nfc feature').toBeTruthy();
    // @capgo/capacitor-nfc's library manifest says required="false"; the merger ORs the two and
    // this is the app where the answer has to be true, so Play never offers it to a phone that
    // could never enter a gate.
    expect(feature?.['android:required']).toBe('true');
  });

  it('declares the NFC permission in the app manifest, not only by library merge', () => {
    const permissions = elements(attendeeManifestXml, 'uses-permission').map(
      (attributes) => attributes['android:name'],
    );
    expect(permissions).toContain('android.permission.NFC');
    // @capacitor/push-notifications ships no manifest permission of its own, so on targetSdk 33+
    // the runtime prompt never appears without this line.
    expect(permissions).toContain('android.permission.POST_NOTIFICATIONS');
  });

  it('asks for no camera: KYC is a hosted web flow and the QR is shown, never scanned', () => {
    const permissions = elements(attendeeManifestXml, 'uses-permission').map(
      (attributes) => attributes['android:name'],
    );
    expect(permissions).not.toContain('android.permission.CAMERA');
    const features = elements(attendeeManifestXml, 'uses-feature').map(
      (attributes) => attributes['android:name'],
    );
    expect(features).not.toContain('android.hardware.camera');
  });

  it('declares no HCE feature: emulating a tag is the gate app’s job', () => {
    const features = elements(attendeeManifestXml, 'uses-feature').map(
      (attributes) => attributes['android:name'],
    );
    expect(features).not.toContain('android.hardware.nfc.hce');
  });

  it('opens the SMS invite link itself: autoVerify on https://monti.despell.io/i/*', () => {
    const filter = intentFilters(attendeeManifestXml).find((body) =>
      elements(body, 'data').some((data) => data['android:pathPrefix'] === '/i/'),
    );
    expect(filter, 'no intent-filter carries the /i/ path prefix').toBeTruthy();
    expect(elements(filter ?? '', 'intent-filter')[0]?.['android:autoVerify']).toBe('true');
    const data = elements(filter ?? '', 'data')[0];
    expect(data?.['android:scheme']).toBe('https');
    // The same host the passkey origin and the asset links file use — an app link verifies
    // against `https://<host>/.well-known/assetlinks.json`, so a drift here is a silent failure.
    expect(data?.['android:host']).toBe(new URL(attendeePasskeyOrigin()).host);
    const categories = elements(filter ?? '', 'category').map((c) => c['android:name']);
    expect(categories).toContain('android.intent.category.DEFAULT');
    expect(categories).toContain('android.intent.category.BROWSABLE');
  });

  it('answers the KYC return address the app itself hands to the hosted flow', () => {
    // shared/api/deepLink.ts sends `monti://kyc/callback` as the native return address. Without
    // this filter the hosted identity flow finishes and the phone has nowhere to go back to.
    const filter = intentFilters(attendeeManifestXml).find((body) =>
      elements(body, 'data').some((data) => data['android:scheme'] === 'monti'),
    );
    expect(filter, 'no intent-filter registers the monti:// scheme').toBeTruthy();
    expect(elements(filter ?? '', 'data')[0]?.['android:host']).toBe('kyc');
  });

  it('floors minSdk at what the MONTI plugins already require', () => {
    const pluginFloor = Number(gradleValue(hcePluginGradle, 'montiMinSdkVersion'));
    expect(Number(gradleValue(deviceKeyPluginGradle, 'montiMinSdkVersion'))).toBe(pluginFloor);
    expect(pluginFloor).toBe(31);
    expect(Number(gradleValue(attendeeVariablesGradle, 'minSdkVersion'))).toBeGreaterThanOrEqual(
      pluginFloor,
    );
  });
});

function attendeePasskeyOrigin(): string {
  const plugin = attendeeConfig.plugins?.CapacitorPasskey as { origin: string } | undefined;
  if (!plugin?.origin) throw new Error('capacitor.attendee.config.ts sets no passkey origin');
  return plugin.origin;
}

describe('the attendee APK’s WebAuthn identity', () => {
  it('keeps the relying party on the web origin, so one passkey works in both', () => {
    expect(attendeeConfig.plugins?.CapacitorPasskey).toEqual({
      origin: 'https://monti.despell.io',
    });
    // Both APKs vouch for the same relying party; only the signing certificates differ.
    expect(attendeeConfig.plugins?.CapacitorPasskey).toEqual(staffConfig.plugins?.CapacitorPasskey);
  });

  it('declares Digital Asset Links for exactly that origin and no other', () => {
    // Unlike android-staff, this project sits where @capgo/capacitor-passkey's sync hook looks,
    // so the hook writes both halves. This pins what it wrote against the configured origin.
    const statements = /translatable="false">([^<]*)</.exec(attendeePasskeyValuesXml)?.[1];
    expect(statements, 'capacitor-passkey.xml has no asset_statements string').toBeTruthy();
    expect(JSON.parse(statements ?? 'null')).toEqual([
      { include: `${attendeePasskeyOrigin()}/.well-known/assetlinks.json` },
    ]);
    const metadata = elements(attendeeManifestXml, 'meta-data').find(
      (attributes) => attributes['android:name'] === 'asset_statements',
    );
    expect(metadata?.['android:resource']).toBe('@string/capacitor_passkey_asset_statements');
  });
});

describe('the two flavors link disjoint plugin sets', () => {
  const attendeePlugins = attendeeConfig.android?.includePlugins ?? [];
  const staffPlugins = staffConfig.android?.includePlugins ?? [];

  it('sets an allowlist on both, or `cap sync` falls back to every dependency', () => {
    expect(attendeePlugins.length).toBeGreaterThan(0);
    expect(staffPlugins.length).toBeGreaterThan(0);
  });

  it('gives card emulation to the gate only and the reader to the attendee only', () => {
    expect(staffPlugins).toContain('@monti/hce-android');
    expect(attendeePlugins).not.toContain('@monti/hce-android');
    expect(attendeePlugins).toContain('@capgo/capacitor-nfc');
    expect(staffPlugins).not.toContain('@capgo/capacitor-nfc');
  });

  it('gives the QR scanner to the gate only: the attendee shows a code, never reads one', () => {
    expect(staffPlugins).toContain('@capacitor-mlkit/barcode-scanning');
    expect(attendeePlugins).not.toContain('@capacitor-mlkit/barcode-scanning');
  });

  it('shares everything neither flavor owns alone', () => {
    for (const shared of [
      '@capacitor-firebase/authentication',
      '@capacitor/app',
      '@capacitor/browser',
      '@capacitor/preferences',
      '@capacitor/push-notifications',
      '@capgo/capacitor-passkey',
      '@monti/device-key',
    ]) {
      expect(attendeePlugins, `attendee is missing ${shared}`).toContain(shared);
      expect(staffPlugins, `staff is missing ${shared}`).toContain(shared);
    }
  });

  it('is what `cap sync` actually wrote into each project’s Gradle files', () => {
    const projects = [
      { plugins: attendeePlugins, settings: attendeeCapacitorSettingsGradle, build: attendeeCapacitorBuildGradle },
      { plugins: staffPlugins, settings: staffCapacitorSettingsGradle, build: staffCapacitorBuildGradle },
    ];
    for (const project of projects) {
      for (const npmPackage of [...attendeePlugins, ...staffPlugins]) {
        const module = gradleModuleOf(npmPackage);
        const linked = project.plugins.includes(npmPackage);
        expect(project.settings.includes(`include ':${module}'`), `${module} in settings`).toBe(linked);
        expect(
          project.build.includes(`implementation project(':${module}')`),
          `${module} in capacitor.build.gradle`,
        ).toBe(linked);
      }
    }
  });

  it('leaves the gate manifest alone: HCE is still required there', () => {
    // Dropping the reader module must not have taken the gate's own feature with it.
    const feature = elements(staffManifestXml, 'uses-feature').find(
      (attributes) => attributes['android:name'] === 'android.hardware.nfc.hce',
    );
    expect(feature?.['android:required']).toBe('true');
  });
});
