import { describe, expect, it } from 'vitest';
import { THEME_CODES, isThemeCode, themeLabels } from './eventThemes';
import { en, ko } from './copy/index';

describe('event themes', () => {
  /**
   * `EventMeta.category` is written once and `updateEventMeta` closes at publish, so an event
   * already on chain carries whatever 0–3 meant when it was made. Widening the list may add
   * numbers; it may never move one.
   */
  it('keeps what 0 to 3 already mean on chain', () => {
    const names = themeLabels(en);
    expect(names[0]).toBe('Concert');
    expect(names[1]).toBe('Meetup');
    expect(names[2]).toBe('Exhibition');
    expect(names[3]).toBe('Other');
    // 기타 is shown last even though its number is fourth.
    expect(THEME_CODES.at(-1)).toBe(3);
  });

  it('offers twelve themes, each numbered once', () => {
    expect(THEME_CODES).toHaveLength(12);
    expect(new Set(THEME_CODES).size).toBe(12);
  });

  /** A blank row in a dropdown is what a missing name looks like; neither locale may have one. */
  it('names every theme in both locales', () => {
    for (const copy of [ko, en]) {
      const names = themeLabels(copy);
      for (const code of THEME_CODES) {
        expect(names[code], `theme ${code}`).toBeTruthy();
      }
    }
    expect(new Set(Object.values(themeLabels(en))).size).toBe(12);
  });

  it('reads a stored number back only when it is one of them', () => {
    expect(isThemeCode(4)).toBe(true);
    expect(isThemeCode(12)).toBe(false);
    expect(isThemeCode(-1)).toBe(false);
  });
});
