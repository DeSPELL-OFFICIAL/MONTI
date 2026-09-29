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
   * `pnpm lint:copy` now scans this folder too (T-EV-W14); this keeps the same rule next to the
   * copy so it fails fast in unit tests: no attendee-banned vocabulary anywhere, no exception.
   */
  it('uses no attendee-banned vocabulary', () => {
    for (const locale of ['ko', 'en'] as const) {
      const copy = organizerCopy[locale];
      const offenders = sentences(copy).filter((line) =>
        BANNED_ATTENDEE_WORDS.some((word) => line.toLowerCase().includes(word.toLowerCase())),
      );
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

});
