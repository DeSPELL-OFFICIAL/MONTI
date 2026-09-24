import { describe, expect, it } from 'vitest';
import { organizerCopy } from './copy';
import { BANNED_ATTENDEE_WORDS } from '@monti/shared';

function keyPaths(value: unknown, prefix = ''): string[] {
  if (typeof value !== 'object' || value === null) return [prefix];
  return Object.entries(value).flatMap(([k, v]) => keyPaths(v, prefix ? `${prefix}.${k}` : k));
}

function sentences(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (typeof value !== 'object' || value === null) return [];
  return Object.values(value).flatMap(sentences);
}

describe('organizer copy', () => {
  it('has identical key sets in ko and en', () => {
    expect(keyPaths(organizerCopy.en).sort()).toEqual(keyPaths(organizerCopy.ko).sort());
  });

  /**
   * `pnpm lint:copy` skips this folder, so the same rule is kept honest here instead — with
   * the one exception the controller ruled: until the paymaster sponsors organiser writes,
   * an organiser has to be told plainly what is missing, and no other sentence may say it.
   */
  it('uses no attendee-banned vocabulary outside the ruled fee notice', () => {
    for (const locale of ['ko', 'en'] as const) {
      const copy = organizerCopy[locale];
      const allowed: string[] = [copy.unsponsored.notice];
      const offenders = sentences(copy)
        .filter((line) => !allowed.includes(line))
        .filter((line) => BANNED_ATTENDEE_WORDS.some((word) => line.toLowerCase().includes(word.toLowerCase())));
      expect(offenders, `${locale} copy`).toEqual([]);
    }
  });

  /**
   * The theme names live in `shared/copy` and are read through `shared/eventThemes`, because
   * the organiser's dropdown and 탐색's filter have to offer the same twelve. This file carried
   * its own `theme0`..`theme3` until the list grew; a second list here would drift silently —
   * an organiser picking 페스티벌 that nobody could ever filter for.
   */
  it('names no theme of its own, because one list owns all twelve', () => {
    for (const locale of ['ko', 'en'] as const) {
      const scene = organizerCopy[locale].scene as Record<string, unknown>;
      expect(Object.keys(scene).filter((key) => /^theme\d+$/.test(key)), locale).toEqual([]);
      // The label for the box stays here: it is the scene's own word, not a theme's name.
      expect(scene.themeLabel).toBeTruthy();
    }
  });

  it('carries the ruled notice for an organiser write nothing sponsors yet', () => {
    expect(organizerCopy.ko.unsponsored.notice).toBe('주최자 작업은 지금은 수수료 지갑이 필요해요');
    expect(organizerCopy.en.unsponsored.notice).toContain('wallet');
  });
});
