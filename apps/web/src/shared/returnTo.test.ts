import { describe, expect, it } from 'vitest';
import { safeReturnTo } from './returnTo';

describe('safeReturnTo', () => {
  it('keeps a same-origin relative path, query included', () => {
    expect(safeReturnTo('/claim/12', '/tickets')).toBe('/claim/12');
    expect(safeReturnTo('/me/verify?returnTo=/me', '/tickets')).toBe('/me/verify?returnTo=/me');
  });

  it('falls back when there is nothing to return to', () => {
    expect(safeReturnTo(null, '/tickets')).toBe('/tickets');
    expect(safeReturnTo(undefined, '/tickets')).toBe('/tickets');
    expect(safeReturnTo('', '/tickets')).toBe('/tickets');
  });

  it('refuses anything that could leave the app', () => {
    for (const raw of [
      'https://evil.example/claim/1',
      '//evil.example',
      '/\\evil.example',
      '\\\\evil.example',
      'javascript:alert(1)',
      'claim/1',
      '/claim/1\nx',
    ]) {
      expect(safeReturnTo(raw, '/tickets')).toBe('/tickets');
    }
  });
});
