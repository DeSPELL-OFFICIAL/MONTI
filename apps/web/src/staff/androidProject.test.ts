import { describe, expect, it, vi } from 'vitest';

import staffConfig from '../../capacitor.staff.config';
import appBuildGradle from '../../android-staff/app/build.gradle?raw';
import capacitorBuildGradle from '../../android-staff/app/capacitor.build.gradle?raw';
import capacitorSettingsGradle from '../../android-staff/capacitor.settings.gradle?raw';
import staffManifestXml from '../../android-staff/app/src/main/AndroidManifest.xml?raw';
import passkeyValuesXml from '../../android-staff/app/src/main/res/values/capacitor-passkey.xml?raw';
import variablesGradle from '../../android-staff/variables.gradle?raw';
import deviceKeyPluginGradle from '../../../../plugins/device-key/android/build.gradle?raw';
import hcePluginGradle from '../../../../plugins/hce-android/android/build.gradle?raw';

/**
 * There is no Android SDK on this machine, so `android-staff/` has never been compiled and no
 * APK exists. Everything a Gradle build would have caught is caught here instead, by reading the
 * files the founder's machine will feed to Gradle unchanged.
 *
 * Each of these is silent when wrong. A drifted `applicationId` installs beside the staff app
 * instead of over it; a missing `uses-feature` lets Play offer the gate app to a phone that
 * cannot emulate a tag; an unregistered plugin turns `Hce.start()` into "plugin not implemented"
 * at the door; a `minSdk` below the plugins' floor fails the merge with a message nobody reads
 * until the first build.
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

/** `name = 31` / `name 31` / `name "app.monti.staff"` out of a Gradle file, comments stripped. */
function gradleValue(gradle: string, name: string): string {
  const body = gradle.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
  const match = new RegExp(`\\b${name}\\b\\s*=?\\s*"?([\\w.]+)"?`).exec(body);
  if (!match?.[1]) throw new Error(`no ${name} in this Gradle file`);
  return match[1];
}

describe('capacitor.staff.config.ts', () => {
  it('is the Android-only staff flavor, with its own app id and its own native project', () => {
    expect(staffConfig.appId).toBe('app.monti.staff');
    expect(staffConfig.appName).toBe('MONTI Staff');
    expect(staffConfig.webDir).toBe('dist-staff');
    expect(staffConfig.android?.path).toBe('android-staff');
  });

  it('declares no iOS target: iOS is out of scope and HCE has no iOS equivalent', () => {
    expect(staffConfig.ios).toBeUndefined();
  });
});

describe('capacitor.config.ts — the file the CLI actually reads', () => {
  it('resolves MONTI_APP_FLAVOR=staff to the staff config', async () => {
    vi.resetModules();
    vi.stubEnv('MONTI_APP_FLAVOR', 'staff');
    const loaded = (await import('../../capacitor.config')).default;
    expect(loaded.appId).toBe('app.monti.staff');
  });

  it('refuses to guess a flavor rather than build one app id into the other app', async () => {
    vi.resetModules();
    vi.stubEnv('MONTI_APP_FLAVOR', '');
    await expect(import('../../capacitor.config')).rejects.toThrow('MONTI_APP_FLAVOR');
  });
});

describe('android-staff — the generated native project', () => {
  it('carries the staff application id, not the attendee one', () => {
    expect(gradleValue(appBuildGradle, 'applicationId')).toBe('app.monti.staff');
    expect(gradleValue(appBuildGradle, 'namespace')).toBe('app.monti.staff');
  });

  it('requires HCE, so Play never offers the gate app to a phone that cannot emulate a tag', () => {
    const feature = elements(staffManifestXml, 'uses-feature').find(
      (attributes) => attributes['android:name'] === 'android.hardware.nfc.hce',
    );
    expect(feature, 'the staff manifest declares no android.hardware.nfc.hce feature').toBeTruthy();
    // The plugin's own manifest says required="false" on purpose — it merges into the attendee
    // app too, where an HCE-less phone is fine. The manifest merger ORs the two, and this is the
    // one app where the answer has to be true.
    expect(feature?.['android:required']).toBe('true');
  });

  it('registers both MONTI plugins as Gradle modules', () => {
    for (const module of [':monti-hce-android', ':monti-device-key']) {
      expect(capacitorSettingsGradle).toContain(`include '${module}'`);
      expect(capacitorBuildGradle).toContain(`implementation project('${module}')`);
    }
  });

  it('floors minSdk at what the MONTI plugins already require', () => {
    // Both plugins hardcode 31 (StrongBox read-back). A lower app floor fails the manifest merge.
    const pluginFloor = Number(gradleValue(hcePluginGradle, 'montiMinSdkVersion'));
    expect(Number(gradleValue(deviceKeyPluginGradle, 'montiMinSdkVersion'))).toBe(pluginFloor);
    expect(pluginFloor).toBe(31);
    expect(Number(gradleValue(variablesGradle, 'minSdkVersion'))).toBeGreaterThanOrEqual(pluginFloor);
  });
});

describe('the staff APK’s WebAuthn identity', () => {
  it('keeps the relying party on the web origin, so one passkey works in both', () => {
    expect(staffConfig.plugins?.CapacitorPasskey).toEqual({ origin: 'https://monti.despell.io' });
  });

  it('declares Digital Asset Links for exactly that origin and no other', () => {
    // @capgo/capacitor-passkey's sync hook would write this pair, but it only ever looks in
    // `android/` — this project is `android-staff`, so the wiring sits in the tree by hand and
    // this is what keeps the hand-written copy honest.
    const { origin } = staffConfig.plugins?.CapacitorPasskey as { origin: string };
    const statements = /translatable="false">([^<]*)</.exec(passkeyValuesXml)?.[1];
    expect(statements, 'capacitor-passkey.xml has no asset_statements string').toBeTruthy();
    expect(JSON.parse(statements ?? 'null')).toEqual([
      { include: `${origin}/.well-known/assetlinks.json` },
    ]);
    const metadata = elements(staffManifestXml, 'meta-data').find(
      (attributes) => attributes['android:name'] === 'asset_statements',
    );
    expect(metadata?.['android:resource']).toBe('@string/capacitor_passkey_asset_statements');
  });
});
