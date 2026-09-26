import { describe, expect, it } from 'vitest';

import capacitorBuildGradle from '../../../android-staff/app/capacitor.build.gradle?raw';
import capacitorSettingsGradle from '../../../android-staff/capacitor.settings.gradle?raw';
import staffManifestXml from '../../../android-staff/app/src/main/AndroidManifest.xml?raw';

/**
 * There is no Android SDK on this machine, so nothing below has ever been compiled — the same
 * reason `staff/androidProject.test.ts` exists, and the same method: read the files the
 * founder's machine will hand to Gradle unchanged.
 *
 * Both of these are silent when wrong. An unregistered plugin turns `BarcodeScanner.scan()`
 * into "plugin not implemented" at the door; a missing `CAMERA` declaration makes Capacitor
 * report the permission as never-granted **and** makes the plugin skip the prompt
 * (`isPermissionDeclared(CAMERA)` in `BarcodeScannerPlugin.java`), so the QR fallback refuses
 * itself forever on a phone whose camera works.
 */

function attributesOf(xml: string, tag: string): Array<Record<string, string>> {
  const body = xml.replace(/<!--[\s\S]*?-->/g, ' ');
  const found: Array<Record<string, string>> = [];
  for (const match of body.matchAll(new RegExp(`<${tag}(\\s[^>]*?)?/?>`, 'g'))) {
    const attributes: Record<string, string> = {};
    for (const pair of (match[1] ?? '').matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) {
      attributes[pair[1] as string] = pair[2] as string;
    }
    found.push(attributes);
  }
  return found;
}

describe('the QR fallback’s native wiring', () => {
  it('registers the barcode plugin as a Gradle module of the staff project', () => {
    expect(capacitorSettingsGradle).toContain("include ':capacitor-mlkit-barcode-scanning'");
    expect(capacitorBuildGradle).toContain("implementation project(':capacitor-mlkit-barcode-scanning')");
  });

  it('declares the camera permission the scan asks for', () => {
    const declared = attributesOf(staffManifestXml, 'uses-permission').map((it) => it['android:name']);
    expect(declared).toContain('android.permission.CAMERA');
  });

  it('keeps the camera off Play’s filter, because HCE is the requirement and QR is the fallback', () => {
    // `uses-permission CAMERA` implies both features as *required* unless they are declared.
    // A gate phone that cannot scan can still take taps, which is the whole job.
    const features = attributesOf(staffManifestXml, 'uses-feature');
    for (const name of ['android.hardware.camera', 'android.hardware.camera.autofocus']) {
      const feature = features.find((it) => it['android:name'] === name);
      expect(feature, `the staff manifest does not declare ${name}`).toBeTruthy();
      expect(feature?.['android:required']).toBe('false');
    }
  });
});
