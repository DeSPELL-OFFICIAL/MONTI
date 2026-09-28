import type { Copy } from './copy/index';

/**
 * The event themes — what the chain calls `EventMeta.category`, a `uint8` (`Ticket.sol:35`).
 *
 * One module, because two screens read this list: the organiser picks a theme in the creation
 * scene and an attendee narrows 탐색 by the same one. They each held their own copy of
 * `[0, 1, 2, 3]` until now (`scene/draftRules.ts`, `discover/useEvents.ts`), which meant
 * widening one of them alone would hide every event of a new theme from the filter — the
 * organiser would pick 페스티벌 and nobody could ever find it.
 *
 * **0 to 3 keep the meanings they already have on chain.** Events created before this list grew
 * carry those numbers and there is no migration — `updateEventMeta` closes at publish — so 기타
 * stays 3 and is simply shown last. The eight new ones take the numbers after it.
 */
export const THEME_CODES = [0, 1, 2, 4, 5, 6, 7, 8, 9, 10, 11, 3] as const;

export type ThemeCode = (typeof THEME_CODES)[number];

/**
 * The names, in whichever locale is on. The annotation is the point: a theme added to
 * {@link THEME_CODES} without a name — in either locale, since `en` is typed `typeof ko` —
 * fails the build here rather than showing a blank row in a dropdown.
 */
export function themeLabels(copy: Copy): Readonly<Record<ThemeCode, string>> {
  return copy.discover.themes;
}

/** True for a number some stored filter or draft claims is a theme. */
export function isThemeCode(value: number): value is ThemeCode {
  return (THEME_CODES as readonly number[]).includes(value);
}
