import { describe, expect, it } from 'vitest';
import { en, ko } from './index';
import { fmt } from '../i18n';

function keyPaths(value: unknown, prefix = ''): string[] {
  if (typeof value !== 'object' || value === null) return [prefix];
  return Object.entries(value).flatMap(([k, v]) => keyPaths(v, prefix ? `${prefix}.${k}` : k));
}

describe('attendee copy', () => {
  it('has identical key sets in ko and en', () => {
    expect(keyPaths(en).sort()).toEqual(keyPaths(ko).sort());
  });

  it('keeps the same interpolation placeholders in both locales', () => {
    expect(ko.enter.armed).toContain('{{seconds}}');
    expect(en.enter.armed).toContain('{{seconds}}');
  });

  /**
   * The support address lives here and nowhere else — no component spells it out — so this is
   * the one place a typo in it can be caught, and the one place it has to be changed.
   */
  it('gives both locales the same support address', () => {
    expect(ko.common.contactEmail).toBe('info@despell.io');
    expect(en.common.contactEmail).toBe(ko.common.contactEmail);
  });

  /**
   * Face ID is an iPhone feature and half the demo runs on Android, where naming it is simply
   * a lie. The promise has to be one both phones can keep.
   */
  it('promises a lock both phones can actually offer', () => {
    const lock = [
      ko.signup.registerBody, en.signup.registerBody,
      ko.signup.passkeyWorking, en.signup.passkeyWorking,
      ko.signup.passkeyUnsupported, en.signup.passkeyUnsupported,
    ].join(' ');
    expect(ko.signup.registerBody).toContain('얼굴·지문');
    expect(lock).not.toMatch(/face id/i);
  });

  /**
   * The founder's first complaint was the second tap. The screen promises one, in both
   * locales, so a copy edit cannot quietly take the promise back while the code still keeps it.
   */
  it('promises the whole of signing up in one tap', () => {
    expect(ko.signup.registerTitle).toBe('계정 만들기');
    expect(ko.signup.registerBody).toBe('얼굴·지문 잠금을 걸고 이 휴대폰을 등록할게요. 한 번만 누르면 끝나요.');
    expect(en.signup.registerBody).toMatch(/one tap/i);
    // Three dots, three names — the screen cannot show a step nothing is called.
    expect([ko.signup.stepPasskey, ko.signup.stepDevice, ko.signup.stepDone].every(Boolean)).toBe(true);
  });

  it('interpolates with fmt', () => {
    expect(fmt(ko.enter.armed, { seconds: 42 })).toBe('42초 안에 단말기에 대세요');
  });
});
