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
   * Face ID is an iPhone feature and half the demo runs on Android, where that title is simply
   * a lie. The promise has to be one both phones can keep.
   */
  it('promises a lock both phones can actually offer', () => {
    expect(ko.signup.passkeyTitle).toBe('얼굴이나 지문으로 잠그기');
    expect(en.signup.passkeyTitle).toBe('Lock with your face or fingerprint');
    expect(`${ko.signup.passkeyTitle} ${en.signup.passkeyTitle}`).not.toMatch(/face id/i);
  });

  /**
   * The registration step is the security ground for entry, so it says what it buys the person
   * rather than describing itself: nobody else can walk in on their ticket.
   */
  it('says what registering this phone is for', () => {
    expect(ko.signup.deviceTitle).toBe('입장은 이 휴대폰으로만');
    expect(ko.signup.deviceBody).toBe('표를 다른 사람이 대신 쓸 수 없게, 이 휴대폰만 입구에서 인정돼요.');
    expect(en.signup.deviceTitle).toBe('Entry works on this phone only');
  });

  it('interpolates with fmt', () => {
    expect(fmt(ko.enter.armed, { seconds: 42 })).toBe('42초 안에 단말기에 대세요');
  });
});
