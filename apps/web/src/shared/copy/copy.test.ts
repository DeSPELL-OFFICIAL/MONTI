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

  it('interpolates with fmt', () => {
    expect(fmt(ko.enter.armed, { seconds: 42 })).toBe('42초 안에 단말기에 대세요');
  });
});
