import { describe, expect, it } from 'vitest';
import type { EventDraft } from '../../shared/api/firestore';
import { emptyEventDraft, emptyEventDraftTier } from '../useEventDraft';
import { platformRow, serializeSplit } from '../settlement/settlementModel';
import { publishSplit, publishView } from './draftPublishModel';

const PLATFORM = `0x${'cc'.repeat(20)}`;
const BAND = `0x${'a1'.repeat(20)}`;
const NOW = 1_800_000_000;

const FREE: EventDraft = {
  ...emptyEventDraft,
  orgId: '9', title: '재즈 나이트', startsAt: 1_900_000_000,
  tiers: [{ ...emptyEventDraftTier, name: '일반' }],
};
const PAID: EventDraft = {
  ...FREE,
  tiers: [{ ...emptyEventDraftTier, name: '일반' }, { ...emptyEventDraftTier, name: 'VIP', currency: 'USDC', amount: 30 }],
};
const GOOD_SPLIT = serializeSplit([
  { id: 'b', name: '밴드', account: BAND, bps: 9_500, tag: 'band' },
  platformRow(PLATFORM),
]);
const ON = { platformAccount: PLATFORM, settlementOn: true, now: NOW };

describe('publishView', () => {
  it('lets a free draft publish with no split rules at all', () => {
    const view = publishView(FREE, ON);
    expect(view).toMatchObject({ paid: false, split: null, rows: [], blocker: '', publishable: true });
    expect(view.tiers).toEqual([{ name: '일반', priceUsdCents: 0 }]);
  });

  it('holds a paid draft until its split adds up to 100%', () => {
    const unset = publishView(PAID, ON);
    expect(unset.paid).toBe(true);
    expect(unset.rows).toEqual([expect.objectContaining({ platform: true, bps: 500 })]);
    expect(unset.split?.error).toBe('BAD_SUM');
    expect(unset).toMatchObject({ blocker: 'split', publishable: false });

    const set = publishView({ ...PAID, splitJson: GOOD_SPLIT }, ON);
    expect(set).toMatchObject({ blocker: '', publishable: true });
    expect(set.tiers).toEqual([{ name: '일반', priceUsdCents: 0 }, { name: 'VIP', priceUsdCents: 3_000 }]);
  });

  it('keeps the platform row at 5% or more', () => {
    const low = serializeSplit([
      { id: 'b', name: '밴드', account: BAND, bps: 9_600, tag: 'band' },
      { ...platformRow(PLATFORM), bps: 400 },
    ]);
    expect(publishView({ ...PAID, splitJson: low }, ON).split?.error).toBe('PLATFORM_LOW');
  });

  it('cannot publish a paid draft where settlement is not set up', () => {
    const off = publishView({ ...PAID, splitJson: GOOD_SPLIT }, { ...ON, settlementOn: false });
    expect(off).toMatchObject({ blocker: 'settlementOff', publishable: false });
    const noPlatform = publishView({ ...PAID, splitJson: GOOD_SPLIT }, { ...ON, platformAccount: undefined });
    expect(noPlatform.blocker).toBe('settlementOff');
    // A free draft never needs it.
    expect(publishView(FREE, { ...ON, settlementOn: false }).publishable).toBe(true);
  });

  it('sends a draft that broke a creation rule back to 만들기', () => {
    expect(publishView({ ...FREE, title: '' }, ON)).toMatchObject({ blocker: 'draft', publishable: false });
    expect(publishView({ ...FREE, startsAt: NOW - 10_000 }, ON).blocker).toBe('draft');
    expect(publishView({ ...PAID, approvalRequired: true, splitJson: GOOD_SPLIT }, ON).blocker).toBe('draft');
  });

  /** A publish already sent (or already landed) is followed, never re-sent — no rule can stop that. */
  it('always lets a sent or landed publish carry on', () => {
    const past = { ...FREE, startsAt: NOW - 10_000 };
    expect(publishView({ ...past, submittedRelayId: 'r1' }, ON)).toMatchObject({ resuming: true, publishable: true });
    expect(publishView({ ...past, createdEventId: '1001' }, ON)).toMatchObject({ resuming: true, publishable: true });
  });
});

describe('publishSplit', () => {
  it('is empty for a free draft', () => {
    expect(publishSplit(FREE, PLATFORM)).toEqual({ recipients: [], platformBps: 0 });
  });

  it('is the recipients in row order with the platform mirror for a paid one', () => {
    expect(publishSplit({ ...PAID, splitJson: GOOD_SPLIT }, PLATFORM)).toEqual({
      recipients: [
        { account: BAND, bps: 9_500, reason: '밴드', tag: 'band' },
        { account: PLATFORM, bps: 500, reason: 'MONTI 플랫폼', tag: 'platform' },
      ],
      platformBps: 500,
    });
  });
});
