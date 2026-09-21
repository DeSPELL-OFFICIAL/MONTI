import { describe, expect, it } from 'vitest';
import { keccak256, toBytes } from 'viem';
import {
  buildEventMeta,
  buildTiers,
  validateDraft,
  type DraftProblem,
  type WizardDraft,
} from './buildEventMeta';

const draft: WizardDraft = {
  title: '재즈 나이트', description: '한남동 라이브',
  image: { base64: 'AAAA', mime: 'image/jpeg', fileName: 'cover.jpg' },
  venue: '서울 용산구 한남동', regionCode: 'KR-11', category: 0,
  startsAt: 1_790_000_000, endsAt: 1_790_010_000, saleStart: 1_789_000_000, saleEnd: 1_789_900_000,
  transferable: true, transferCutoffHours: 2, maxTransfers: 3, approvalRequired: false,
  requireKyc: true,
  tiers: [{ name: '일반', supply: 100, maxPerWallet: 2, seated: false }],
  gates: ['정문'],
  orgId: '9',
};

describe('buildEventMeta', () => {
  it('hashes title, description, venue and region with keccak256 over UTF-8', () => {
    const meta = buildEventMeta(draft, 'bafyMetaJson');
    expect(meta.titleHash).toBe(keccak256(toBytes('재즈 나이트')));
    expect(meta.descHash).toBe(keccak256(toBytes('한남동 라이브')));
    expect(meta.venueHash).toBe(keccak256(toBytes('서울 용산구 한남동')));
    expect(meta.regionCode).toBe(keccak256(toBytes('KR-11')));
  });

  it('puts the metadata JSON cid in imageCid and converts the cutoff to seconds', () => {
    const meta = buildEventMeta(draft, 'bafyMetaJson');
    expect(meta.imageCid).toBe('bafyMetaJson');
    expect(meta.transferCutoffSeconds).toBe(7200);
    expect(meta.orgId).toBe(9n);
    expect(meta.category).toBe(0);
  });

  it('carries the per-event identity check through to the struct', () => {
    expect(buildEventMeta(draft, 'bafyMetaJson').requireKyc).toBe(true);
    expect(buildEventMeta({ ...draft, requireKyc: false }, 'bafyMetaJson').requireKyc).toBe(false);
  });

  it('builds tiers with minted zero and no price: the contract mints free tiers only', () => {
    expect(buildTiers(draft)).toEqual([
      { name: '일반', priceUsdCents: 0n, supply: 100, minted: 0, maxPerWallet: 2, seated: false },
    ]);
  });
});

/**
 * Every rule `Ticket.createEvent` enforces, checked here so the wizard refuses before the
 * operation is sent rather than after the chain reverts. The comment on each case names the
 * revert it stands in for.
 */
describe('validateDraft mirrors what Ticket.createEvent reverts on', () => {
  function problems(patch: Partial<WizardDraft>): DraftProblem[] {
    return validateDraft({ ...draft, ...patch });
  }

  it('passes a complete draft', () => {
    expect(validateDraft(draft)).toEqual([]);
  });

  // `InvalidSchedule`: meta.startsAt >= meta.endsAt
  it('refuses an end that is not after the start', () => {
    expect(problems({ endsAt: draft.startsAt })).toContain('schedule');
    expect(problems({ endsAt: draft.startsAt - 1 })).toContain('schedule');
  });

  // `InvalidSchedule`: meta.saleStart >= meta.saleEnd
  it('refuses a sale window that does not open before it closes', () => {
    expect(problems({ saleEnd: draft.saleStart })).toContain('sale');
  });

  // `InvalidTiers`: tiers_.length == 0
  it('refuses an event with no ticket kinds', () => {
    expect(problems({ tiers: [] })).toContain('tiersEmpty');
  });

  // `InvalidTiers`: tiers_.length > 8
  it('refuses more than eight ticket kinds', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({
      name: `종류 ${i}`, supply: 10, maxPerWallet: 1, seated: false,
    }));
    expect(problems({ tiers: many })).toContain('tiersTooMany');
    expect(problems({ tiers: many.slice(0, 8) })).not.toContain('tiersTooMany');
  });

  // `Unauthorized`: organizers.hasPermission(meta.orgId, …) — org 0 has no owner, so it never passes.
  it('refuses a missing or zero organisation', () => {
    expect(problems({ orgId: '' })).toContain('orgId');
    expect(problems({ orgId: '0' })).toContain('orgId');
    expect(problems({ orgId: 'nine' })).toContain('orgId');
  });

  it('names every empty readable field separately', () => {
    expect(problems({ title: ' ' })).toContain('title');
    expect(problems({ description: '' })).toContain('description');
    expect(problems({ venue: '' })).toContain('venue');
    expect(problems({ image: null })).toContain('image');
  });

  it('refuses a region the picker does not offer, because the chain stores its hash', () => {
    expect(problems({ regionCode: 'KR-99' })).toContain('region');
    expect(problems({ regionCode: 'KR-49' })).toEqual([]);
  });

  // The struct's widths: values past them do not revert, they fail to encode.
  it('refuses values that do not fit the struct', () => {
    expect(problems({ category: 4 })).toContain('category');
    expect(problems({ maxTransfers: 256 })).toContain('maxTransfers');
    expect(problems({ maxTransfers: -1 })).toContain('maxTransfers');
    expect(problems({ transferCutoffHours: -1 })).toContain('cutoff');
    expect(problems({ transferCutoffHours: 2_000_000 })).toContain('cutoff');
    expect(problems({ startsAt: 0 })).toContain('schedule');
    expect(problems({ saleStart: 0 })).toContain('sale');
  });

  it('names a tier that cannot be sold', () => {
    expect(problems({ tiers: [{ name: '', supply: 10, maxPerWallet: 1, seated: false }] })).toContain('tierName');
    expect(problems({ tiers: [{ name: '일반', supply: 0, maxPerWallet: 1, seated: false }] })).toContain('tierSupply');
    expect(problems({ tiers: [{ name: '일반', supply: 10, maxPerWallet: 0, seated: false }] }))
      .toContain('tierMaxPerWallet');
    expect(problems({ tiers: [{ name: '일반', supply: 10, maxPerWallet: 70_000, seated: false }] }))
      .toContain('tierMaxPerWallet');
  });

  it('collects every failure at once rather than stopping at the first', () => {
    expect(problems({ title: '', tiers: [], endsAt: 0 }).sort()).toEqual(
      ['schedule', 'tiersEmpty', 'title'].sort(),
    );
  });
});
