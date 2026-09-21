import { keccak256, toBytes } from 'viem';
import type { EventMetaStruct, TierStruct } from '../../shared/chain/reads';
import { REGION_CODES } from './regions';

/**
 * One ticket kind as the wizard edits it. There is no price: `Ticket.claim` reverts
 * `PaidTiersNotEnabled` on any tier whose `priceUsdCents` is not zero, so an event with a paid
 * tier is one nobody could ever get a ticket for. `buildTiers` writes the zero.
 */
export interface WizardTier {
  name: string;
  supply: number;
  maxPerWallet: number;
  seated: boolean;
}

/**
 * The cover picture, already narrowed to a type and a size the backend accepts. It is carried
 * as base64 rather than as a `File` because the draft is persisted: a `File` does not survive
 * `JSON.stringify`, and the image is only sent when the event is published.
 */
export interface PreparedImage {
  base64: string;
  mime: string;
  fileName: string;
}

export interface WizardDraft {
  orgId: string;
  title: string; description: string; image: PreparedImage | null;
  venue: string; regionCode: string; category: number;
  startsAt: number; endsAt: number; saleStart: number; saleEnd: number;
  transferable: boolean; transferCutoffHours: number; maxTransfers: number; approvalRequired: boolean;
  /** Anti-scalping switch. Off for casual meetups, on for concerts. */
  requireKyc: boolean;
  tiers: WizardTier[];
  /**
   * The names the organiser plans to give the entry terminals. Draft-only: a terminal is
   * linked to the event from the event's own screen once it exists, because linking one needs
   * the device's own key, which no browser has.
   */
  gates: string[];
  /**
   * The `userOpHash` of a `createEvent` whose `wait` gave up before it landed, or `''`.
   *
   * A timeout is not a failure: the operation may well be mined a second later. The draft
   * survives a reload, so without this a second Publish sends a second `createEvent` — and two
   * of those are two events, each with its own id, its own tickets and its own chat room. The
   * hash is how the next attempt asks the bundler what became of the first one instead.
   */
  submittedOpHash: string;
}

/** The four themes the discover filter offers (`attendee/discover/useEvents.ts`). */
export const CATEGORY_CODES = [0, 1, 2, 3] as const;

/** The struct widths. A value past one of these does not revert — it fails to encode. */
const UINT8_MAX = 255;
const UINT16_MAX = 65_535;
const UINT32_MAX = 4_294_967_295;
const UINT64_MAX = 18_446_744_073_709_551_615n;
const MAX_TIERS = 8;
const SECONDS_PER_HOUR = 3600;

/**
 * The venue's own width, and not a struct width: the chain stores a hash, so any length fits
 * there. This is the mirror of `MAX_META_FIELD_CHARS` in the backend's
 * `functions/src/functions/organizer.ts`, which refuses a longer field with
 * `invalid-argument` / `BAD_META` — and it refuses it at the pin step, after the cover picture
 * has already gone up. The count is taken **after** trimming, because that is what the server
 * counts.
 */
export const MAX_VENUE_CHARS = 200;

/**
 * Everything the wizard refuses to send. The first four stand in for a revert
 * `Ticket.createEvent` would raise; the rest are the fields whose widths or hashes would make
 * the operation meaningless rather than reverting. `organizer/copy.ts` owns a sentence each.
 */
export type DraftProblem =
  | 'orgId'          // Unauthorized — org 0 has no owner, so hasPermission can never pass
  | 'schedule'       // InvalidSchedule — startsAt >= endsAt
  | 'sale'           // InvalidSchedule — saleStart >= saleEnd
  | 'tiersEmpty'     // InvalidTiers — tiers_.length == 0
  | 'tiersTooMany'   // InvalidTiers — tiers_.length > 8
  | 'title' | 'description' | 'image' | 'venue' | 'venueTooLong' | 'region' | 'category'
  | 'cutoff' | 'maxTransfers'
  | 'tierName' | 'tierSupply' | 'tierMaxPerWallet';

function isWholeNumber(value: number, min: number, max: number): boolean {
  return Number.isInteger(value) && value >= min && value <= max;
}

/** A `uint64` timestamp the contract can compare: zero is an unset `datetime-local` field. */
function isTimestamp(value: number): boolean {
  return Number.isInteger(value) && value > 0 && BigInt(value) <= UINT64_MAX;
}

/**
 * Every rule `Ticket.createEvent` enforces, checked before the operation is built. The chain
 * checks again — this is not a substitute for it — but a refusal here costs nothing and names
 * the field, where the chain's four-byte revert names only the rule.
 *
 * Every failure is collected: the review step lists them all rather than surfacing one, having
 * the organiser fix it, and surfacing the next.
 */
export function validateDraft(draft: WizardDraft): DraftProblem[] {
  const problems: DraftProblem[] = [];

  // `Organizers.ownerOf(0)` is the zero address, so `hasPermission` on org 0 is always false.
  if (!/^[1-9][0-9]*$/.test(draft.orgId.trim())) problems.push('orgId');

  if (draft.title.trim() === '') problems.push('title');
  if (draft.description.trim() === '') problems.push('description');
  if (draft.image === null) problems.push('image');
  // Two rules, named apart: an organiser who wrote a venue that is merely too long should be
  // told to shorten it, not told to write one.
  const venue = draft.venue.trim();
  if (venue === '') problems.push('venue');
  else if (venue.length > MAX_VENUE_CHARS) problems.push('venueTooLong');
  if (!REGION_CODES.has(draft.regionCode)) problems.push('region');
  if (!(CATEGORY_CODES as readonly number[]).includes(draft.category)) problems.push('category');

  if (!isTimestamp(draft.startsAt) || !isTimestamp(draft.endsAt) || draft.startsAt >= draft.endsAt) {
    problems.push('schedule');
  }
  if (!isTimestamp(draft.saleStart) || !isTimestamp(draft.saleEnd) || draft.saleStart >= draft.saleEnd) {
    problems.push('sale');
  }

  const cutoffSeconds = draft.transferCutoffHours * SECONDS_PER_HOUR;
  if (!isWholeNumber(cutoffSeconds, 0, UINT32_MAX)) problems.push('cutoff');
  if (!isWholeNumber(draft.maxTransfers, 0, UINT8_MAX)) problems.push('maxTransfers');

  if (draft.tiers.length === 0) problems.push('tiersEmpty');
  if (draft.tiers.length > MAX_TIERS) problems.push('tiersTooMany');
  if (draft.tiers.some((tier) => tier.name.trim() === '')) problems.push('tierName');
  if (draft.tiers.some((tier) => !isWholeNumber(tier.supply, 1, UINT32_MAX))) problems.push('tierSupply');
  if (draft.tiers.some((tier) => !isWholeNumber(tier.maxPerWallet, 1, UINT16_MAX))) {
    problems.push('tierMaxPerWallet');
  }

  return problems;
}

/**
 * The draft as `Ticket.EventMeta`. `metaCid` is the CID of the metadata JSON the backend
 * pinned, and that JSON is what carries the image CID — the chain holds only hashes of the
 * readable fields, so `EventMeta.imageCid` has to point at the document `shared/envio/ipfs.ts`
 * reads `{ name, description, image }` out of, not at the picture.
 */
export function buildEventMeta(draft: WizardDraft, metaCid: string): EventMetaStruct {
  return {
    orgId: BigInt(draft.orgId),
    titleHash: keccak256(toBytes(draft.title)),
    descHash: keccak256(toBytes(draft.description)),
    imageCid: metaCid,
    startsAt: BigInt(draft.startsAt),
    endsAt: BigInt(draft.endsAt),
    // The backend trims the venue before it pins it (`optionalMetaField` in the backend's
    // `organizer.ts`), so the trimmed string is the one the readable document will carry.
    // Hashing the untrimmed one would put a `venueHash` on chain that the pinned document does
    // not match, and nothing can repair that afterwards: `EventMeta` is written once.
    venueHash: keccak256(toBytes(draft.venue.trim())),
    saleStart: BigInt(draft.saleStart),
    saleEnd: BigInt(draft.saleEnd),
    transferable: draft.transferable,
    transferCutoffSeconds: draft.transferCutoffHours * SECONDS_PER_HOUR,
    maxTransfers: draft.maxTransfers,
    approvalRequired: draft.approvalRequired,
    category: draft.category,
    regionCode: keccak256(toBytes(draft.regionCode)),
    requireKyc: draft.requireKyc,
  };
}

/** `minted` is zero on the way in; `createEvent` zeroes it again on the way into storage. */
export function buildTiers(draft: WizardDraft): TierStruct[] {
  return draft.tiers.map((tier) => ({
    name: tier.name,
    priceUsdCents: 0n,
    supply: tier.supply,
    minted: 0,
    maxPerWallet: tier.maxPerWallet,
    seated: tier.seated,
  }));
}
