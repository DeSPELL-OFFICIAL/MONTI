import { describe, expect, it } from 'vitest';
import { emptyEventDraft } from '../useEventDraft';
import type { EventDraft } from '../../shared/api/firestore';
import {
  MAX_TAGS, MAX_TIER_NAME_CHARS, eventProblems, normalizeTags, paidTiers, saleWindow,
  tierArt, tierProblems,
} from './draftRules';

/** A draft with nothing left to fix, so each case below can break exactly one rule. */
const READY: EventDraft = {
  ...emptyEventDraft,
  orgId: '9',
  title: '재즈 나이트',
  description: '한남동 라이브',
  posterCid: 'bafkposter',
  regionCode: 'KR-11',
  venue: '서울 용산구 한남동',
  startsAt: 1_790_000_000,
  endsAt: 1_790_010_000,
};

describe('normalizeTags', () => {
  it('runs the server rule: trim, drop a leading hash, drop empties and duplicates', () => {
    expect(normalizeTags([' 재즈 ', '#라이브', '재즈', '', '   ', '#'])).toEqual(['재즈', '라이브']);
  });

  it('keeps the order they were written in and stops at five', () => {
    expect(normalizeTags(['a', 'b', 'c', 'd', 'e', 'f'])).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(normalizeTags(['a', 'b', 'c', 'd', 'e', 'f'])).toHaveLength(MAX_TAGS);
  });
});

describe('eventProblems', () => {
  it('finds nothing wrong with a filled-in draft', () => {
    expect(eventProblems(READY)).toEqual([]);
  });

  it('names an empty draft section by section, in the order the scene asks', () => {
    expect(eventProblems(emptyEventDraft)).toEqual(['poster', 'title', 'body', 'venue', 'startsAt', 'endsAt']);
  });

  /**
   * The draft rule allows 80 and 5,000, but `pinEventMetadata` refuses a name over 60 or a
   * description over 2,000 with `BAD_META` — at publish, after everything else is filled in.
   * The scene is held to the tighter pair so the refusal lands under the field being typed.
   */
  it('holds the title and the body to what the pin will actually accept', () => {
    expect(eventProblems({ ...READY, title: '재' })).toEqual(['title']);
    expect(eventProblems({ ...READY, title: 'ㄱ'.repeat(60) })).toEqual([]);
    expect(eventProblems({ ...READY, title: 'ㄱ'.repeat(61) })).toEqual(['title']);
    expect(eventProblems({ ...READY, description: 'ㄱ'.repeat(2_000) })).toEqual([]);
    expect(eventProblems({ ...READY, description: 'ㄱ'.repeat(2_001) })).toEqual(['body']);
  });

  it('counts code points rather than UTF-16 units, as the server does', () => {
    // Six emoji: 12 UTF-16 units, 6 code points. A title of these is well under the cap.
    expect(eventProblems({ ...READY, title: '🎷'.repeat(6) })).toEqual([]);
    expect(eventProblems({ ...READY, title: '🎷'.repeat(61) })).toEqual(['title']);
  });

  it('refuses a tag over twelve characters and a sixth tag', () => {
    expect(eventProblems({ ...READY, tags: ['ㄱ'.repeat(12)] })).toEqual([]);
    expect(eventProblems({ ...READY, tags: ['ㄱ'.repeat(13)] })).toEqual(['tags']);
    expect(eventProblems({ ...READY, tags: ['a', 'b', 'c', 'd', 'e', 'f'] })).toEqual(['tags']);
  });

  it('refuses a region the chain filter could never produce', () => {
    expect(eventProblems({ ...READY, regionCode: 'KR-99' })).toEqual(['region']);
  });

  it('separates a missing venue from one that is merely too long', () => {
    expect(eventProblems({ ...READY, venue: '  ' })).toEqual(['venue']);
    expect(eventProblems({ ...READY, venue: 'ㄱ'.repeat(201) })).toEqual(['venueTooLong']);
  });

  it('asks for each time on its own, and only then whether they are the right way round', () => {
    expect(eventProblems({ ...READY, startsAt: 0 })).toEqual(['startsAt']);
    expect(eventProblems({ ...READY, endsAt: 0 })).toEqual(['endsAt']);
    expect(eventProblems({ ...READY, endsAt: READY.startsAt })).toEqual(['schedule']);
  });
});

describe('saleWindow', () => {
  /**
   * `Ticket.createEvent` only asks that `saleStart < saleEnd`, and the rule above has already
   * put `endsAt` after `startsAt` — so a window derived this way is always acceptable, which
   * is why the wizard's two extra date fields are gone.
   */
  it('opens now and closes when the event ends', () => {
    expect(saleWindow(READY, 1_789_000_000)).toEqual({ saleStart: 1_789_000_000, saleEnd: READY.endsAt });
  });
});

describe('tierProblems', () => {
  const tier = { ...READY.tiers[0], name: '일반', supply: 100, maxPerWallet: 1 } as EventDraft['tiers'][number];
  const withTiers = (tiers: EventDraft['tiers']): EventDraft => ({ ...READY, tiers });

  it('finds nothing wrong with one named, free, countable kind', () => {
    expect(tierProblems(withTiers([tier]))).toEqual([]);
  });

  it('names an unnamed kind, an empty run and an impossible per-person limit', () => {
    expect(tierProblems(withTiers([{ ...tier, name: ' ' }]))).toEqual(['tierName']);
    expect(tierProblems(withTiers([{ ...tier, supply: 0 }]))).toEqual(['tierSupply']);
    expect(tierProblems(withTiers([{ ...tier, maxPerWallet: 65_536 }]))).toEqual(['tierMaxPerWallet']);
  });

  it('refuses a ninth kind, as `Ticket.createEvent` would', () => {
    expect(tierProblems(withTiers(Array.from({ length: 8 }, () => tier)))).toEqual([]);
    expect(tierProblems(withTiers(Array.from({ length: 9 }, () => tier)))).toEqual(['tiersTooMany']);
  });

  /**
   * The draft rule caps a kind's name at 40 (`firestore.rules` `tierOk`) and refuses the
   * **whole document** past it — so a 41st character would turn every autosave from then on
   * into a permission error with nothing on screen saying which box did it. The chain never
   * measures this field, so nothing else would ever have caught it.
   */
  it('refuses a kind name over forty characters, as the draft rule does', () => {
    expect(tierProblems(withTiers([{ ...tier, name: 'ㄱ'.repeat(40) }]))).toEqual([]);
    expect(tierProblems(withTiers([{ ...tier, name: 'ㄱ'.repeat(41) }]))).toEqual(['tierNameTooLong']);
    expect(MAX_TIER_NAME_CHARS).toBe(40);
  });

  it('refuses a negative hand-over cut-off', () => {
    expect(tierProblems({ ...withTiers([tier]), transferCutoffHours: -1 })).toEqual(['cutoff']);
  });
});

describe('paidTiers', () => {
  const tier = { ...READY.tiers[0], name: '일반', supply: 10, maxPerWallet: 1 } as EventDraft['tiers'][number];

  /**
   * `Ticket.claim` reverts `PaidTiersNotEnabled` on any tier whose `priceUsdCents` is not
   * zero, and `updateEventMeta` closes at publish — so a paid kind is an event nobody can
   * ever get a ticket for and nobody can repair. The card is blocked where it was chosen.
   */
  it('names every card that cannot be created, by index', () => {
    const draft = { ...READY, tiers: [tier, { ...tier, currency: 'USDC' as const }, tier] };
    expect(paidTiers(draft)).toEqual([1]);
    expect(tierProblems(draft)).toContain('paidTier');
    expect(paidTiers({ ...READY, tiers: [tier] })).toEqual([]);
  });
});

describe('tierArt', () => {
  const tier = READY.tiers[0] as EventDraft['tiers'][number];

  it('is a letter, never a name — nothing else reaches `saveEventArt`', () => {
    expect(tierArt({ ...tier, design: 'c', imageCid: '' })).toEqual({ preset: 'c' });
    // A draft written before the presets were letters, or edited by hand.
    expect(tierArt({ ...tier, design: 'aurora', imageCid: '' })).toEqual({ preset: 'a' });
  });

  it('lets an uploaded picture win, and keeps the design the draft still remembers', () => {
    expect(tierArt({ ...tier, design: 'd', imageCid: 'bafkart' })).toEqual({ imageCid: 'bafkart' });
  });
});
