import { describe, expect, it } from 'vitest';
import { emptyEventDraft, emptyEventDraftTier, normalizeEventDraft } from '../useEventDraft';
import type { EventDraft } from '../../shared/api/firestore';
import { TICKET_BACKDROPS } from '../../shared/ui/ticketArt/presets';
import {
  DEFAULT_EVENT_SECONDS, MAX_TAGS, MAX_TIER_NAME_CHARS, TICKET_ART_PRESETS, endsAtOf,
  eventProblems, isPaidDraft, normalizeTags, priceUsdCentsOf, saleWindow, tierArt, tierProblems,
} from './draftRules';

/** A draft with nothing left to fix, so each case below can break exactly one rule. */
const READY: EventDraft = {
  ...emptyEventDraft,
  orgId: '9',
  title: '재즈 나이트',
  description: '한남동 재즈 라이브 공연',
  posterCid: 'bafkposter',
  regionCode: 'KR-11',
  venue: '서울 용산구 한남동',
  startsAt: 1_900_000_000,
  endsAt: 1_900_010_000,
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

  /** 소개는 이제 선택이다(계획 B-4가 ≥10자 규칙을 뒤집음): 빈 소개는 더 이상 문제가 아니다. */
  it('names an empty draft section by section, in the order the scene asks', () => {
    expect(eventProblems(emptyEventDraft)).toEqual(
      ['title', 'startsAt', 'endsAt'],
    );
    expect(eventProblems({ ...READY, description: '' })).toEqual([]);
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

  /** 소개는 선택이다(계획 B-4): 빈값도 아주 짧은 값도 통과한다 — 남은 규칙은 2000자 상한뿐이다. */
  it('accepts an empty or very short description (plan section B-4)', () => {
    expect(eventProblems({ ...READY, description: '' })).toEqual([]);
    expect(eventProblems({ ...READY, description: 'ㄱ' })).toEqual([]);
    expect(eventProblems({ ...READY, description: `  ${'ㄱ'.repeat(3)}  ` })).toEqual([]);
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

  it('allows an empty 장소 (optional now) but still caps its length', () => {
    // P1 relaxation: 장소는 선택이다 — 빈값도 공백만도 통과한다(기본 라벨 "장소 미정"로 읽힘).
    expect(eventProblems({ ...READY, venue: '' })).toEqual([]);
    expect(eventProblems({ ...READY, venue: '  ' })).toEqual([]);
    expect(eventProblems({ ...READY, venue: 'ㄱ'.repeat(200) })).toEqual([]);
    expect(eventProblems({ ...READY, venue: 'ㄱ'.repeat(201) })).toEqual(['venueTooLong']);
  });

  it('asks for each time on its own, and only then whether they are the right way round', () => {
    expect(eventProblems({ ...READY, startsAt: 0 })).toEqual(['startsAt']);
    // An end nobody set is two hours after the start, so it is not a problem — an end with no
    // start to derive it from still is.
    expect(eventProblems({ ...READY, endsAt: 0 })).toEqual([]);
    expect(eventProblems({ ...READY, startsAt: 0, endsAt: 0 })).toEqual(['startsAt', 'endsAt']);
    expect(eventProblems({ ...READY, endsAt: READY.startsAt })).toEqual(['schedule']);
  });

  /**
   * The founder's "행사를 만들지 못했어요" (task-create-failure-2 report §0). The draft was
   * written on the 24th and published on the 26th; every field on the screen was right, but
   * `saleWindow` derives 지금 -> `endsAt`, so the sign-up window ran backwards and
   * `Ticket.createEvent` reverted `InvalidSchedule()` — during the *estimate*, where there is
   * no receipt and therefore no reason the app could read. It is a rule here now, checked
   * against a `now` the caller passes rather than against the clock, so this test cannot
   * itself go stale the way that draft did.
   */
  it('refuses a draft whose end time has already gone by', () => {
    expect(eventProblems(READY, READY.endsAt - 1)).toEqual([]);
    expect(eventProblems(READY, READY.endsAt)).toEqual(['eventPast']);
    expect(eventProblems(READY, READY.endsAt + 86_400)).toEqual(['eventPast']);
    // The derived end — two hours after the start — is measured exactly the same way.
    const derived = { ...READY, endsAt: 0 };
    expect(eventProblems(derived, READY.startsAt + DEFAULT_EVENT_SECONDS - 1)).toEqual([]);
    expect(eventProblems(derived, READY.startsAt + DEFAULT_EVENT_SECONDS + 1)).toEqual(['eventPast']);
    // One sentence at a time: a window that runs backwards is `schedule`, and only that.
    expect(eventProblems({ ...READY, endsAt: READY.startsAt }, READY.endsAt + 1)).toEqual(['schedule']);
  });
});

describe('endsAtOf', () => {
  it('keeps the end the organiser set', () => {
    expect(endsAtOf(READY)).toBe(READY.endsAt);
  });

  /** `더 설정하기` is closed by default, so most events never have one typed in. */
  it('derives two hours after the start when nobody set one', () => {
    expect(endsAtOf({ ...READY, endsAt: 0 })).toBe(READY.startsAt + DEFAULT_EVENT_SECONDS);
    expect(DEFAULT_EVENT_SECONDS).toBe(7_200);
  });

  it('has nothing to derive from without a start', () => {
    expect(endsAtOf({ ...READY, startsAt: 0, endsAt: 0 })).toBe(0);
  });
});

describe('saleWindow', () => {
  /**
   * `Ticket.createEvent` only asks that `saleStart < saleEnd`, and the rule above has already
   * put `endsAt` after `startsAt` — so a window derived this way is always acceptable, which
   * is why the deleted wizard's two extra date fields are gone.
   */
  it('opens now and closes when the event ends', () => {
    expect(saleWindow(READY, 1_789_000_000)).toEqual({ saleStart: 1_789_000_000, saleEnd: READY.endsAt });
  });

  /** The derived end is the one the window closes on, so `saleStart < saleEnd` still holds. */
  it('closes on the derived end when the organiser never set one', () => {
    const { saleStart, saleEnd } = saleWindow({ ...READY, endsAt: 0 }, 1_789_000_000);
    expect(saleEnd).toBe(READY.startsAt + DEFAULT_EVENT_SECONDS);
    expect(saleStart).toBeLessThan(saleEnd);
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

describe('paid kinds (v2: the price goes on chain at publish)', () => {
  const tier = { ...READY.tiers[0], name: '일반', supply: 10, maxPerWallet: 1 } as EventDraft['tiers'][number];
  const paid = { ...tier, currency: 'USDC' as const, amount: 30 };

  it('lets a priced kind through, and prices it in cents', () => {
    const draft = { ...READY, tiers: [tier, paid] };
    expect(tierProblems(draft)).toEqual([]);
    expect(isPaidDraft(draft)).toBe(true);
    expect(isPaidDraft({ ...READY, tiers: [tier] })).toBe(false);
    expect(priceUsdCentsOf(paid)).toBe(3_000);
    // A free kind is free whatever amount was typed while it was paid.
    expect(priceUsdCentsOf({ ...tier, amount: 30 })).toBe(0);
  });

  it('refuses a paid kind with no whole-dollar price', () => {
    expect(tierProblems({ ...READY, tiers: [{ ...paid, amount: 0 }] })).toEqual(['tierPrice']);
    expect(tierProblems({ ...READY, tiers: [{ ...paid, amount: 2.5 }] })).toEqual(['tierPrice']);
  });

  /**
   * The approval path only ever issues price-0 tickets, so a paid event that also asks for
   * approval is one nobody could get into — `publishEvent` reverts `PaidApprovalUnsupported`.
   */
  it('refuses a paid event that also asks for approval', () => {
    expect(tierProblems({ ...READY, approvalRequired: true, tiers: [paid] })).toEqual(['paidApproval']);
    expect(tierProblems({ ...READY, approvalRequired: true, tiers: [tier] })).toEqual([]);
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

describe('the preset alphabet', () => {
  /**
   * Four places hold these letters — this list, the union `TicketArtPreset`, the validator in
   * `shared/api/firestore.ts` and the drawings themselves — and the Firestore rule validates
   * `^[a-l]$` on top of them. A letter this list offers that one of the others has never heard
   * of does not draw a wrong picture: it fails the autosave for the **whole draft document**
   * the moment somebody picks it, with nothing on screen saying which box did it.
   */
  it('is the twelve letters a to l, each once and in order', () => {
    expect([...TICKET_ART_PRESETS]).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l']);
    expect(new Set(TICKET_ART_PRESETS).size).toBe(12);
  });

  /** A letter with no drawing behind it is a blank ticket, and nothing else would say so. */
  it('has a drawing for every letter, and draws nothing that is not one', () => {
    for (const preset of TICKET_ART_PRESETS) {
      expect(TICKET_BACKDROPS[preset], preset).toBeTruthy();
    }
    expect(Object.keys(TICKET_BACKDROPS).sort()).toEqual([...TICKET_ART_PRESETS].sort());
  });

  /** The fold that reaches `saveEventArt`: every letter survives it as itself. */
  it('keeps each of the twelve through the fold that reaches the callable', () => {
    const tier = READY.tiers[0] as EventDraft['tiers'][number];
    for (const preset of TICKET_ART_PRESETS) {
      expect(tierArt({ ...tier, design: preset, imageCid: '' }), preset).toEqual({ preset });
    }
    // A thirteenth is not a letter anything downstream would accept, so it folds back.
    expect(tierArt({ ...tier, design: 'm', imageCid: '' })).toEqual({ preset: 'a' });
  });
});

describe('approvalRequired', () => {
  /**
   * The one event-wide switch the tier card's 받는 방식 control writes. It defaults off — every
   * event issues on a first-come basis until an organiser chooses otherwise — and it is read
   * back at its own type, so a hand-broken value falls back rather than reaching the chain as a
   * string (plan section A-5).
   */
  it('defaults to false and round-trips through the draft normaliser', () => {
    expect(emptyEventDraft.approvalRequired).toBe(false);
    expect(normalizeEventDraft({ approvalRequired: true }).approvalRequired).toBe(true);
    expect(normalizeEventDraft({ approvalRequired: 'yes' }).approvalRequired).toBe(false);
    expect(normalizeEventDraft({}).approvalRequired).toBe(false);
  });
});

describe('what a kind starts as', () => {
  /**
   * The founder opened the scene and found a required box with nothing in it (plan section
   * B-3). A kind's name is the one thing `tierProblems` insists on, so it is filled in — and
   * `일반` is what almost every first kind is called. A blank default would put a red line
   * under a box nobody had touched the first time 만들기 was pressed.
   */
  it('is named 일반, so the one required field on it is already answered', () => {
    expect(emptyEventDraftTier.name).toBe('일반');
    expect(tierProblems(emptyEventDraft)).toEqual([]);
  });
});
