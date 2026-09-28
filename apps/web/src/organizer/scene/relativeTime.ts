import { fmt } from '../../shared/i18n';

/**
 * How long ago something happened, in the three sizes this product ever needs: 방금, N분 전,
 * N시간 전.
 *
 * It lives on its own rather than inside `SaveStatus` because two parts now date the same
 * draft — the status line on the sticky bar, and the resume sheet that asks about a draft left
 * behind (plan section F-3). A second copy of the arithmetic would be a second set of
 * boundaries, and the day one of them said `59분 전` while the other said `1시간 전` about the
 * same moment is the day nobody believes either.
 *
 * A day is deliberately not a unit: a draft older than the cap survives is already gone, and
 * `27시간 전` is a truer thing to read than `어제` when deciding whether to carry on with it.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/** The three words, taken as an argument so this module holds no product copy of its own. */
export interface AgoCopy {
  agoNow: string;
  agoMinutes: string;
  agoHours: string;
}

/**
 * `since` is a span in milliseconds, not an instant. A negative one is a clock that moved
 * backwards — a phone whose time was corrected, or a server stamp a second ahead of this
 * device — and it reads as 방금 rather than as a time in the future.
 */
export function timeAgo(since: number, copy: AgoCopy): string {
  const passed = Math.max(0, since);
  if (passed < MINUTE_MS) return copy.agoNow;
  if (passed < HOUR_MS) return fmt(copy.agoMinutes, { count: Math.floor(passed / MINUTE_MS) });
  return fmt(copy.agoHours, { count: Math.floor(passed / HOUR_MS) });
}
