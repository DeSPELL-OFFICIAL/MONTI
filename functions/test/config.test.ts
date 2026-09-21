import { describe, expect, it } from 'vitest';
import { REGION, expectedOrigins } from '../src/config.js';

describe('config', () => {
  it('pins the Seoul region for every function', () => {
    expect(REGION).toBe('us-east1');
  });

  it('accepts both the web origin and the Android apk-key-hash origin', () => {
    process.env.RP_ID = 'monti.app';
    process.env.ANDROID_APK_KEY_HASH = 'AbCdEf-123_xyz';
    expect(expectedOrigins()).toEqual(['https://monti.app', 'android:apk-key-hash:AbCdEf-123_xyz']);
  });

  it('omits the Android origin when no fingerprint is configured', () => {
    process.env.RP_ID = 'monti.app';
    process.env.ANDROID_APK_KEY_HASH = '';
    expect(expectedOrigins()).toEqual(['https://monti.app']);
  });
});
