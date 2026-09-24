import type { EventDraft, EventDraftTier } from '../../shared/api/firestore';
import type { TicketArtPreset, TicketArtSource } from '../../shared/ui';
import { REGION_CODES } from './regions';

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
 * How long an event runs when nobody says otherwise. The end time is one of the three fields
 * the founder's phone test put behind `더 설정하기` (plan section B-3): most events last an
 * evening, and asking for a second `datetime-local` before anybody has typed a title is how a
 * creation screen loses the person filling it in.
 */
export const DEFAULT_EVENT_SECONDS = 2 * 60 * 60;

/**
 * The end of the event — the one the organiser set, or two hours after it starts. Every reader
 * goes through here (the rules, the sign-up window, the scene's own field and the chain draft)
 * so a derived end can never disagree with the one being checked.
 */
export function endsAtOf(draft: EventDraft): number {
  if (isTimestamp(draft.endsAt)) return draft.endsAt;
  return isTimestamp(draft.startsAt) ? draft.startsAt + DEFAULT_EVENT_SECONDS : 0;
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

  // Not required: `pinEventMetadata` measures a description and refuses only a long one — an
  // empty one is fine by the server (`functions/src/functions/organizer.ts:206-212`), and a
  // required 소개 is one more wall between an organiser and their event (plan section B-3).
  if (charCount(draft.description.trim()) > MAX_BODY_CHARS) problems.push('body');

  if (!REGION_CODES.has(draft.regionCode)) problems.push('region');
  const venue = draft.venue.trim();
  if (venue === '') problems.push('venue');
  else if (charCount(venue) > MAX_VENUE_CHARS) problems.push('venueTooLong');

  if (!isTimestamp(draft.startsAt)) problems.push('startsAt');
  const endsAt = endsAtOf(draft);
  if (!isTimestamp(endsAt)) problems.push('endsAt');
  else if (isTimestamp(draft.startsAt) && draft.startsAt >= endsAt) problems.push('schedule');

  return problems;
}

/**
 * The sign-up window, derived rather than asked for (plan section B-1): it opens the moment the
 * event is made and closes when the event ends. `Ticket.createEvent` only asks that
 * `saleStart < saleEnd`, and `endsAt` is already past `startsAt` by the rule above, so a window
 * derived this way is always one the contract accepts — which is why the two date fields the
 * deleted wizard asked for are gone.
 */
export function saleWindow(draft: EventDraft, now: number): { saleStart: number; saleEnd: number } {
  return { saleStart: now, saleEnd: endsAtOf(draft) };
}

/** `Ticket.createEvent` refuses more than eight kinds with `InvalidTiers` (`Ticket.sol:193`). */
export const MAX_TIERS = 8;

/**
 * The security rule's own cap on a kind's name (`firestore.rules` `tierOk`). It is the *draft*
 * that breaks here, not the chain — the chain never measures a tier name — and the rule refuses
 * the **whole document** rather than one field, so a 41st character turns every autosave from
 * then on into a permission error with nothing on screen to say which box caused it.
 */
export const MAX_TIER_NAME_CHARS = 40;

/** The struct widths. A value past one of these does not revert — it fails to encode. */
const UINT16_MAX = 65_535;
const UINT32_MAX = 4_294_967_295;
const SECONDS_PER_HOUR = 3_600;

/** One named rule of SCENE 2; `organizer/copy.ts` owns a sentence for each. */
export type TierProblem =
  | 'tiersTooMany' | 'tierName' | 'tierNameTooLong' | 'tierSupply' | 'tierMaxPerWallet'
  | 'cutoff' | 'paidTier';

/**
 * Which ticket kinds cannot be created, by index. Today that is every kind whose currency is
 * not `무료`: `Ticket.claim` is not `payable` and reverts `PaidTiersNotEnabled` on any tier
 * whose `priceUsdCents` is not zero (`Ticket.sol:274`), so a paid kind is a kind nobody could
 * ever get a ticket for — and after `publishEvent` there is no `updateEventMeta` to fix it
 * with. The card says so where the choice was made rather than at the end (plan section B-3).
 */
export function paidTiers(draft: EventDraft): number[] {
  return draft.tiers.flatMap((tier, index) => (tier.currency === 'free' ? [] : [index]));
}

function isWholeNumber(value: number, low: number, high: number): boolean {
  return Number.isInteger(value) && value >= low && value <= high;
}

/** Everything SCENE 2 refuses, in the order the cards and then the event rules ask for it. */
export function tierProblems(draft: EventDraft): TierProblem[] {
  const problems: TierProblem[] = [];
  if (draft.tiers.length > MAX_TIERS) problems.push('tiersTooMany');
  if (draft.tiers.some((tier) => tier.name.trim() === '')) problems.push('tierName');
  if (draft.tiers.some((tier) => charCount(tier.name.trim()) > MAX_TIER_NAME_CHARS)) {
    problems.push('tierNameTooLong');
  }
  if (draft.tiers.some((tier) => !isWholeNumber(tier.supply, 1, UINT32_MAX))) problems.push('tierSupply');
  if (draft.tiers.some((tier) => !isWholeNumber(tier.maxPerWallet, 1, UINT16_MAX))) {
    problems.push('tierMaxPerWallet');
  }
  if (!isWholeNumber(draft.transferCutoffHours * SECONDS_PER_HOUR, 0, UINT32_MAX)) {
    problems.push('cutoff');
  }
  if (paidTiers(draft).length > 0) problems.push('paidTier');
  return problems;
}

/**
 * The draft's two art fields folded into the one-or-the-other shape `saveEventArt` takes and
 * `TicketArt` renders. They are kept apart in the draft on purpose — somebody who picks a
 * design, uploads a picture and then changes their mind back should not have lost the design
 * in between — so this fold happens at the two places the single value is needed: the preview
 * and the publish call.
 */
export function tierArt(tier: EventDraftTier): TicketArtSource {
  if (tier.imageCid !== '') return { imageCid: tier.imageCid };
  const preset = TICKET_ART_PRESETS.find((key) => key === tier.design);
  return { preset: preset ?? 'a' };
}

/**
 * The alphabet, in the order the picker offers it. Twelve letters, matching the server's
 * `ART_PRESETS` and the draft rule's `^[a-l]$`: a letter this list has and the rule does not
 * would fail autosave for the whole document the moment somebody picked it.
 */
export const TICKET_ART_PRESETS: readonly TicketArtPreset[] = [
  'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l',
];
