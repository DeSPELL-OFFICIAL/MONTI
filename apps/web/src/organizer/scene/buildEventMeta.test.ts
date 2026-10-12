import { describe, expect, it } from 'vitest';
import { keccak256, toBytes } from 'viem';
import { buildEventMeta, buildTiers, type ChainDraft } from './buildEventMeta';

/**
 * The rules these two builders used to be checked against live in `draftRules.ts` now — the
 * six-step wizard that owned `validateDraft` is gone (T-EV-W10), and the scene refuses a field
 * under the field rather than at a review step. What is left here is the encoding itself,
 * which is the half that can never be repaired once it is on chain.
 */
const draft: ChainDraft = {
  title: '재즈 나이트', description: '한남동 라이브',
  venue: '서울 용산구 한남동', regionCode: 'KR-11', category: 0,
  startsAt: 1_790_000_000, endsAt: 1_790_010_000, saleStart: 1_789_000_000, saleEnd: 1_789_900_000,
  transferable: true, transferCutoffHours: 2, maxTransfers: 3, approvalRequired: false,
  requireKyc: true,
  tiers: [{ name: 'General', priceUsdCents: 0, supply: 100, maxPerWallet: 2, seated: false }],
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

  /**
   * The backend trims every readable field before it pins it (`optionalMetaField` in
   * `functions/src/functions/organizer.ts`), so the hash has to be of the trimmed string.
   * Hashing the padded one would put a `venueHash` on chain that the pinned document does not
   * match, for that event, for good.
   */
  it('hashes the trimmed venue, because the trimmed venue is what the server pins', () => {
    const padded = buildEventMeta({ ...draft, venue: '  서울 용산구 한남동  ' }, 'bafyMetaJson');
    expect(padded.venueHash).toBe(keccak256(toBytes('서울 용산구 한남동')));
    expect(padded.venueHash).toBe(buildEventMeta(draft, 'bafyMetaJson').venueHash);
    expect(padded.venueHash).not.toBe(keccak256(toBytes('  서울 용산구 한남동  ')));
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

  it('builds tiers with minted zero and the price in cents, which v2 keeps on chain', () => {
    const priced = { ...draft, tiers: [...draft.tiers, { name: 'VIP', priceUsdCents: 3_000, supply: 10, maxPerWallet: 1, seated: false }] };
    expect(buildTiers(priced)).toEqual([
      { name: 'General', priceUsdCents: 0n, supply: 100, minted: 0, maxPerWallet: 2, seated: false },
      { name: 'VIP', priceUsdCents: 3_000n, supply: 10, minted: 0, maxPerWallet: 1, seated: false },
    ]);
  });
});
