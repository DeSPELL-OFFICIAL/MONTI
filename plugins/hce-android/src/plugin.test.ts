import { HCE_AID } from '@monti/shared';
import { describe, expect, it } from 'vitest';
import hcePluginKt from '../android/src/main/java/app/monti/hce/HcePlugin.kt?raw';
import definitionsTs from './definitions.ts?raw';
import indexTs from './index.ts?raw';
import { toBase64, fromBase64 } from './base64';
import { HCE_ERROR } from './definitions';

/**
 * 다리의 양끝을 맞대어 본다. 이 플러그인에서 조용히 깨지는 자리는 바이트가 아니라 **이름**이다:
 * `setPayload` 를 Kotlin 에서 `setNdef` 로 고치면 Kotlin 도 TS 도 각자 멀쩡히 컴파일되고,
 * 게이트에서 "method not found" 한 줄이 런타임에 처음 나타난다. 이벤트 이름, 옵션 키,
 * base64 철자, 에러 코드도 전부 같은 모양의 실패를 한다.
 *
 * `definitions.ts` 가 단일 원천이므로 방향은 언제나 TS → Kotlin 이다. 여기서 하는 일은
 * Kotlin 이 그 원천을 따르고 있는지 보는 것뿐이다.
 */

const squeeze = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** `interface HcePlugin { ... }` 본문의 최상위 메서드 이름. */
function declaredMethods(source: string): string[] {
  const body = source.slice(source.indexOf('export interface HcePlugin {'));
  const end = body.indexOf('\n}');
  return [...body.slice(0, end).matchAll(/^ {2}([A-Za-z0-9_]+)\(/gm)].map((m) => m[1] as string);
}

/** `@PluginMethod fun name(` — Kotlin 이 JS 에 내보이는 이름. */
const nativeMethods = [...hcePluginKt.matchAll(/@PluginMethod\s+fun\s+([A-Za-z0-9_]+)\s*\(/g)].map(
  (m) => m[1] as string,
);

describe('the method names JS calls', () => {
  it('matches the TypeScript interface one for one', () => {
    // addListener/removeAllListeners 는 Capacitor 의 Plugin 기반 클래스가 제공한다 —
    // @PluginMethod 로 다시 선언하지 않는다.
    expect(nativeMethods).toEqual(['start', 'setPayload', 'stop']);
    expect(declaredMethods(definitionsTs)).toEqual([
      'start',
      'setPayload',
      'stop',
      'addListener',
      'removeAllListeners',
    ]);
    for (const method of nativeMethods) expect(declaredMethods(definitionsTs)).toContain(method);
  });

  it('registers under the name registerPlugin asks for', () => {
    expect(hcePluginKt).toContain('@CapacitorPlugin(name = "Hce")');
    expect(indexTs).toContain("registerPlugin<HcePlugin>('Hce'");
  });
});

describe('the option keys and the event', () => {
  it('reads the same option keys the interface declares', () => {
    expect(definitionsTs).toContain('export interface HceStartOptions {');
    expect(hcePluginKt).toContain('call.getString("aid")');
    expect(squeeze(definitionsTs)).toContain('aid: string;');
    expect(hcePluginKt).toContain('call.getString("ndef")');
    expect(squeeze(definitionsTs)).toContain('ndef: Base64;');
  });

  it('fires the one event name the interface allows a listener for', () => {
    expect(hcePluginKt).toContain('notifyListeners("write", payload)');
    expect(squeeze(definitionsTs)).toContain("addListener( eventName: 'write',");
  });

  it('spells the write payload with the key HceWriteEvent declares', () => {
    expect(squeeze(definitionsTs)).toContain('export interface HceWriteEvent { ndef: Base64; }');
    expect(hcePluginKt).toContain('payload.put("ndef", Base64.encodeToString(message, Base64.NO_WRAP))');
  });

  it('accepts the AID the manifest fixed and @monti/shared names', () => {
    expect(hcePluginKt).toContain(`const val REGISTERED_AID = "${HCE_AID}"`);
  });
});

describe('the base64 spelling definitions.ts fixes', () => {
  it('encodes with NO_WRAP, which is what fromBase64 accepts', () => {
    // DEFAULT 로 인코딩하면 76열마다 줄바꿈이 들어간다. 그 철자는 TS 쪽에서 거절된다.
    expect(hcePluginKt).toContain('Base64.NO_WRAP');
    expect(hcePluginKt).not.toContain('Base64.encodeToString(message, Base64.DEFAULT)');
    expect(definitionsTs).toContain('Base64.NO_WRAP');
  });

  it('round-trips a write event the size of a real gate response', () => {
    // 176바이트 레코드는 base64 로 76열을 훌쩍 넘는다 — 줄바꿈이 들어갔다면 여기서 드러난다.
    const message = Uint8Array.from({ length: 176 }, (_, i) => (i * 7) & 0xff);
    const encoded = toBase64(message);
    expect(encoded).not.toContain('\n');
    expect(fromBase64(encoded)).toEqual(message);
  });

  it('decodes what the caller sent rather than repair it', () => {
    expect(hcePluginKt).toContain('Base64.decode(ndef, Base64.DEFAULT)');
    // 잘못 쓴 철자는 부른 자리에서 터진다. 게이트에서 읽히지 않는 태그로 나타나지 않는다.
    expect(() => fromBase64('AA-_')).toThrow();
  });
});

describe('the error codes every rejection carries', () => {
  const rejections = [...hcePluginKt.matchAll(/call\.reject\(([^\n]*)\)/g)].map((m) => m[1] as string);

  it('rejects in more than one place, and never without a code', () => {
    // 코드 없는 reject 는 JS 가 분기할 수 없는 실패다 — 게이트에서는 전부 "다시 태그하세요"가 된다.
    expect(rejections.length).toBeGreaterThanOrEqual(5);
    const codes = Object.values(HCE_ERROR);
    for (const rejection of rejections) {
      expect(codes.some((code) => rejection.includes(`"${code}"`) || rejection.includes(code))).toBe(true);
    }
  });

  it('declares each code in Kotlin with the exact string definitions.ts exports', () => {
    expect(hcePluginKt).toContain(`const val INVALID_ARGUMENT = "${HCE_ERROR.invalidArgument}"`);
    expect(hcePluginKt).toContain(`const val UNAVAILABLE = "${HCE_ERROR.unavailable}"`);
    expect(hcePluginKt).toContain(`const val NFC_DISABLED = "${HCE_ERROR.nfcDisabled}"`);
  });

  it('separates a phone that cannot emulate from one whose NFC is merely off', () => {
    // 전자는 영구적이라 QR 로 간다. 후자는 설정 두 번이면 풀리므로 QR 로 내려보내면 안 된다.
    expect(squeeze(hcePluginKt)).toContain('call.reject("this device has no NFC adapter", UNAVAILABLE)');
    expect(squeeze(hcePluginKt)).toContain('call.reject("NFC is turned off", NFC_DISABLED)');
  });

  it('refuses an AID other than the one the manifest fixed', () => {
    expect(squeeze(hcePluginKt)).toContain(
      'if (aid == null || !aid.equals(REGISTERED_AID, ignoreCase = true))',
    );
  });

  it('refuses setPayload before start, so a rotation loop cannot run into a dead gate', () => {
    expect(squeeze(hcePluginKt)).toContain('if (!started) {');
    expect(squeeze(hcePluginKt)).toContain('call.reject("call start() before setPayload()", INVALID_ARGUMENT)');
  });
});

describe('claiming and releasing the tap', () => {
  it('claims the preferred service so a wallet app on the same AID cannot take it', () => {
    expect(hcePluginKt).toContain('emulation.setPreferredService(it, serviceComponent)');
    expect(hcePluginKt).toContain('emulation.unsetPreferredService(it)');
  });

  it('drops the listener before it clears the gate', () => {
    // reset() 이 onDeactivated 를 부른다. 콜백을 나중에 떼면 멈춘 게이트의 이벤트가 한 번 더 샌다.
    const dropAt = hcePluginKt.indexOf('HceBridge.onWrite = null');
    const resetAt = hcePluginKt.indexOf('HceBridge.reset()');
    expect(dropAt).toBeGreaterThan(-1);
    expect(resetAt).toBeGreaterThan(dropAt);
  });

  it('keeps the web build refusing, so no browser pretends to be a card', () => {
    // 네이티브가 생겼다고 해서 web 쪽에 흉내가 생기면 안 된다 — web.test.ts 가 동작을 본다.
    expect(indexTs).toContain("web: () => import('./web')");
    expect(definitionsTs).toContain('UNAVAILABLE');
  });
});
