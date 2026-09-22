import type { EventDraft } from '../../shared/api/firestore';
import { REGION_CODES } from '../wizard/regions';

/**
 * Every rule SCENE 1 enforces, and the one normalisation both this side and the server run.
 *
 * It is a module of its own because three places need the same answers: the scene (a line
 * under the field), SCENE 2's `행사 만들기` (which must not send a draft the pin would refuse)
 * and the publish path itself. A rule that lived in a component would be a rule the publish
 * path re-invented slightly differently.
 *
 * **The caps are the deployed backend's, not the draft rule's.** `eventDrafts` allows a title
 * of 80 and a body of 5,000 (functions/firestore.rules), but `pinEventMetadata` refuses a
 * `name` over 60 or a `description` over 2,000 with `BAD_META` — and it refuses it at publish
 * time, after every field has been filled in. The stricter pair is therefore what the fields
 * are held to, so the refusal happens under the field being typed rather than at the end.
 */
export const MIN_TITLE_CHARS = 2;
export const MAX_TITLE_CHARS = 60;
export const MAX_BODY_CHARS = 2_000;
export const MAX_VENUE_CHARS = 200;
export const MAX_TAGS = 5;
export const MAX_TAG_CHARS = 12;

/** The four themes the discover filter offers (`attendee/discover/useEvents.ts`). */
export const THEME_CODES = [0, 1, 2, 3] as const;

/** One named rule; `organizer/copy.ts` owns a sentence for each, and each names a section. */
export type EventProblem =
  | 'poster' | 'title' | 'tags' | 'body' | 'region' | 'venue' | 'venueTooLong'
  | 'startsAt' | 'endsAt' | 'schedule';

/** Which section of SCENE 1 a problem belongs to, so `다음` can scroll to the first one. */
export const PROBLEM_SECTION: Readonly<Record<EventProblem, string>> = {
  poster: 'poster', title: 'title', tags: 'tags', body: 'body',
  region: 'venue', venue: 'venue', venueTooLong: 'venue',
  startsAt: 'time', endsAt: 'time', schedule: 'time',
};

/**
 * The tag rule, run here before the tags are sent because the server runs exactly this one and
 * then **refuses the whole request** rather than quietly dropping a bad tag (`BAD_TAGS`): IPFS
 * cannot be re-pinned and `updateEventMeta` closes at publish, so an organiser's tags and an
 * attendee's tags must never be allowed to set differently.
 *
 * trim → drop a leading `#` → drop the empties and the duplicates → keep the first five.
 * Order is kept: the organiser wrote them in one.
 */
export function normalizeTags(raw: readonly string[]): string[] {
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const entry of raw) {
    const tag = entry.trim().replace(/^#+/, '').trim();
    if (tag === '' || seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag);
    if (tags.length === MAX_TAGS) break;
  }
  return tags;
}

/** Code points, not UTF-16 units: the server counts `[...value].length` and so does this. */
export function charCount(value: string): number {
  return [...value].length;
}

/** A `uint64` timestamp the contract can compare; 0 is an untouched `datetime-local`. */
function isTimestamp(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

/**
 * Everything SCENE 1 refuses, in the order the sections ask for it — so the first entry is
 * both the sentence to show and the section to scroll to.
 */
export function eventProblems(draft: EventDraft): EventProblem[] {
  const problems: EventProblem[] = [];

  if (draft.posterCid.trim() === '') problems.push('poster');

  const title = draft.title.trim();
  if (charCount(title) < MIN_TITLE_CHARS || charCount(title) > MAX_TITLE_CHARS) problems.push('title');

  // The count is taken after normalising, so five tags plus a duplicate is five tags.
  const tags = normalizeTags(draft.tags);
  if (tags.some((tag) => charCount(tag) > MAX_TAG_CHARS) || draft.tags.length > MAX_TAGS) {
    problems.push('tags');
  }

  const body = draft.description.trim();
  if (body === '' || charCount(body) > MAX_BODY_CHARS) problems.push('body');

  if (!REGION_CODES.has(draft.regionCode)) problems.push('region');
  const venue = draft.venue.trim();
  if (venue === '') problems.push('venue');
  else if (charCount(venue) > MAX_VENUE_CHARS) problems.push('venueTooLong');

  if (!isTimestamp(draft.startsAt)) problems.push('startsAt');
  if (!isTimestamp(draft.endsAt)) problems.push('endsAt');
  else if (isTimestamp(draft.startsAt) && draft.startsAt >= draft.endsAt) problems.push('schedule');

  return problems;
}

/**
 * The sign-up window, derived rather than asked for (plan section B-1): it opens the moment the
 * event is made and closes when the event ends. `Ticket.createEvent` only asks that
 * `saleStart < saleEnd`, and `endsAt` is already past `startsAt` by the rule above, so a window
 * derived this way is always one the contract accepts — which is why the two date fields the
 * old wizard asked for are gone.
 */
export function saleWindow(draft: EventDraft, now: number): { saleStart: number; saleEnd: number } {
  return { saleStart: now, saleEnd: draft.endsAt };
}
