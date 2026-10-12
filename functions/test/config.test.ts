import { afterEach, describe, expect, it } from 'vitest';
import { AUTH_MODE, DEV_ORIGINS, REGION, RP_ID, RP_NAME, authMode, expectedOrigins } from '../src/config.js';

/**
 * 서명 인증서의 SHA-256 을 base64url 로 쓴 값 — 패딩 없이 정확히 43글자다.
 * 안드로이드 앱이 둘이라 서명 인증서도 둘이다(참석자 `app.monti`, 스태프 `app.monti.staff`).
 */
const ATTENDEE_HASH = '0UBplgrJxGVdhlStTif_-sczxK2uPjwEiwb9-eotdAY';
const STAFF_HASH = 'x5m2PJ8h2drdMq_6aS848UymRmR4kt6zna-vGQlGS2A';

/**
 * `defineString` 은 `.value()` 를 부를 때 `process.env` 를 읽는다. 테스트 파일은 한 프로세스를
 * 나눠 쓰므로(`fileParallelism: false`) 여기서 건드린 값은 반드시 원래대로 돌려놓는다.
 */
const ENV_KEYS = ['RP_ID', 'ANDROID_APK_KEY_HASH', 'DEV_ORIGINS', 'AUTH_MODE'] as const;
const saved = new Map<string, string | undefined>(ENV_KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('config', () => {
  it('pins the v2 region for every function', () => {
    expect(REGION).toBe('us-east4');
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
    process.env.ANDROID_APK_KEY_HASH = ATTENDEE_HASH;
    process.env.DEV_ORIGINS = '';
    expect(expectedOrigins()).toEqual([
      'https://monti.despell.io',
      `android:apk-key-hash:${ATTENDEE_HASH}`,
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
    process.env.ANDROID_APK_KEY_HASH = ATTENDEE_HASH;
    process.env.DEV_ORIGINS = 'http://localhost:5173, http://192.168.0.10:5173';
    expect(expectedOrigins()).toEqual([
      'https://monti.despell.io',
      `android:apk-key-hash:${ATTENDEE_HASH}`,
      'http://localhost:5173',
      'http://192.168.0.10:5173',
    ]);
  });

  it('builds one android origin per app, in the order they are listed', () => {
    // 안드로이드 앱이 둘이라 서명 인증서도 둘이다. 하나만 받으면 나머지 앱의 패스키가 전부 거부된다.
    process.env.RP_ID = 'monti.despell.io';
    process.env.ANDROID_APK_KEY_HASH = `${ATTENDEE_HASH},${STAFF_HASH}`;
    process.env.DEV_ORIGINS = '';
    expect(expectedOrigins()).toEqual([
      'https://monti.despell.io',
      `android:apk-key-hash:${ATTENDEE_HASH}`,
      `android:apk-key-hash:${STAFF_HASH}`,
    ]);
  });

  it('tolerates the whitespace and trailing comma a hand-edited .env picks up', () => {
    process.env.RP_ID = 'monti.despell.io';
    process.env.ANDROID_APK_KEY_HASH = `  ${ATTENDEE_HASH} , ${STAFF_HASH} ,`;
    process.env.DEV_ORIGINS = '';
    expect(expectedOrigins()).toEqual([
      'https://monti.despell.io',
      `android:apk-key-hash:${ATTENDEE_HASH}`,
      `android:apk-key-hash:${STAFF_HASH}`,
    ]);
  });

  it('refuses a hash that is not a base64url SHA-256 instead of trusting a bogus origin', () => {
    // `keytool` 은 `AB:CD:…` 16진수를 뱉는다. 그걸 그대로 붙여 넣으면 아무 앱도 통과하지 못하는
    // origin 이 조용히 배포된다 — 조용히 넘기지 말고 읽을 수 있는 이유와 함께 터뜨린다.
    process.env.RP_ID = 'monti.despell.io';
    process.env.ANDROID_APK_KEY_HASH = `${ATTENDEE_HASH},AB:CD:EF`;
    process.env.DEV_ORIGINS = '';
    expect(() => expectedOrigins()).toThrow(/ANDROID_APK_KEY_HASH/);
    expect(() => expectedOrigins()).toThrow(/43 characters/);
  });

  it('drops empty entries left by a stray comma instead of trusting an empty origin', () => {
    process.env.RP_ID = 'monti.despell.io';
    process.env.ANDROID_APK_KEY_HASH = '';
    process.env.DEV_ORIGINS = 'http://localhost:5173,,  ,';
    expect(expectedOrigins()).toEqual(['https://monti.despell.io', 'http://localhost:5173']);
  });

  it('ships phone as the deployed AUTH_MODE default', () => {
    expect(AUTH_MODE.options.default).toBe('phone');
  });

  it("reads AUTH_MODE as open only for the exact value 'open'; anything else is phone", () => {
    process.env.AUTH_MODE = 'open';
    expect(authMode()).toBe('open');
    process.env.AUTH_MODE = ' open ';
    expect(authMode()).toBe('open');
    for (const value of ['phone', '', 'OPEN', 'anonymous', 'true']) {
      process.env.AUTH_MODE = value;
      expect(authMode()).toBe('phone');
    }
    delete process.env.AUTH_MODE;
    expect(authMode()).toBe('phone');
  });
});
