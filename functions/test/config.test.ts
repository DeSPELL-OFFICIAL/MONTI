import { afterEach, describe, expect, it } from 'vitest';
import { DEV_ORIGINS, REGION, RP_ID, RP_NAME, expectedOrigins } from '../src/config.js';

/**
 * `defineString` 은 `.value()` 를 부를 때 `process.env` 를 읽는다. 테스트 파일은 한 프로세스를
 * 나눠 쓰므로(`fileParallelism: false`) 여기서 건드린 값은 반드시 원래대로 돌려놓는다.
 */
const ENV_KEYS = ['RP_ID', 'ANDROID_APK_KEY_HASH', 'DEV_ORIGINS'] as const;
const saved = new Map<string, string | undefined>(ENV_KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('config', () => {
  it('pins the Seoul region for every function', () => {
    expect(REGION).toBe('us-east1');
  });

  /**
   * `defineString` 의 `default` 는 런타임이 아니라 **배포 때** 값이 된다
   * (`StringParam.runtimeValue()` 는 `process.env[name] || ''` 뿐이다).
   * 그러니 배포되는 기본값 자체를 못 박는다 — 패스키는 RP ID 문자열 하나에 묶여 있어서
   * 틀린 값이 한 번 배포되면 그 도메인에 만들어진 계정이 통째로 끊긴다.
   */
  it('ships the production domain as the deployed RP ID default', () => {
    expect(RP_ID.options.default).toBe('monti.despell.io');
    expect(RP_NAME.options.default).toBe('MONTI');
  });

  it('ships no dev origin — a production deploy trusts only the real domain', () => {
    expect(DEV_ORIGINS.options.default).toBe('');
  });

  it('accepts both the web origin and the Android apk-key-hash origin', () => {
    process.env.RP_ID = 'monti.despell.io';
    process.env.ANDROID_APK_KEY_HASH = 'AbCdEf-123_xyz';
    process.env.DEV_ORIGINS = '';
    expect(expectedOrigins()).toEqual([
      'https://monti.despell.io',
      'android:apk-key-hash:AbCdEf-123_xyz',
    ]);
  });

  it('omits the Android origin when no fingerprint is configured', () => {
    process.env.RP_ID = 'monti.despell.io';
    process.env.ANDROID_APK_KEY_HASH = '';
    process.env.DEV_ORIGINS = '';
    expect(expectedOrigins()).toEqual(['https://monti.despell.io']);
  });

  it('adds nothing when DEV_ORIGINS is unset — production never trusts a dev origin', () => {
    process.env.RP_ID = 'monti.despell.io';
    process.env.ANDROID_APK_KEY_HASH = '';
    delete process.env.DEV_ORIGINS;
    expect(expectedOrigins()).toEqual(['https://monti.despell.io']);
  });

  it('appends each configured dev origin verbatim, after the production origins', () => {
    // 로컬 주소는 코드에 박지 않는다. 개발자가 자기 환경에 DEV_ORIGINS 를 넣어야만 열린다.
    process.env.RP_ID = 'monti.despell.io';
    process.env.ANDROID_APK_KEY_HASH = 'AbCdEf-123_xyz';
    process.env.DEV_ORIGINS = 'http://localhost:5173, http://192.168.0.10:5173';
    expect(expectedOrigins()).toEqual([
      'https://monti.despell.io',
      'android:apk-key-hash:AbCdEf-123_xyz',
      'http://localhost:5173',
      'http://192.168.0.10:5173',
    ]);
  });

  it('drops empty entries left by a stray comma instead of trusting an empty origin', () => {
    process.env.RP_ID = 'monti.despell.io';
    process.env.ANDROID_APK_KEY_HASH = '';
    process.env.DEV_ORIGINS = 'http://localhost:5173,,  ,';
    expect(expectedOrigins()).toEqual(['https://monti.despell.io', 'http://localhost:5173']);
  });
});
