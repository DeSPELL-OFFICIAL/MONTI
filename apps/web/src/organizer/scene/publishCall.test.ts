import { describe, expect, it } from 'vitest';
import { decodeFunctionData } from 'viem';
import { ticketAbi } from '../../shared/chain/abis';
import { buildEventMeta, buildTiers, type ChainDraft } from './buildEventMeta';
import { encodePublishCall } from './publishCall';

const draft: ChainDraft = {
  orgId: '9', title: '재즈 나이트', description: '', venue: '', regionCode: 'KR-11', category: 0,
  startsAt: 1_790_000_000, endsAt: 1_790_010_000, saleStart: 1_789_000_000, saleEnd: 1_790_010_000,
  transferable: true, transferCutoffHours: 2, maxTransfers: 3, approvalRequired: false, requireKyc: false,
  tiers: [{ name: 'VIP', priceUsdCents: 3_000, supply: 10, maxPerWallet: 1, seated: false }],
};
const meta = buildEventMeta(draft, 'bafyMeta');
const tiers = buildTiers(draft);
const recipients = [
  { account: `0x${'a1'.repeat(20)}` as const, bps: 9_500, reason: '밴드', tag: 'band' },
  { account: `0x${'cc'.repeat(20)}` as const, bps: 500, reason: 'MONTI 플랫폼', tag: 'platform' },
];

describe('encodePublishCall', () => {
  it('encodes one Ticket write carrying the event and its priced kinds', () => {
    const call = encodePublishCall({ meta, tiers, recipients: [], platformBps: 0 });
    const decoded = decodeFunctionData({ abi: ticketAbi, data: call.data });
    expect(decoded.args?.[0]).toMatchObject({ orgId: 9n, imageCid: 'bafyMeta' });
    expect(decoded.args?.[1]).toEqual([expect.objectContaining({ name: 'VIP', priceUsdCents: 3_000n })]);
    expect(call.kind).toBe(decoded.functionName);
  });

  it('sends no reasons for a free event and one per recipient, in order, for a paid one', () => {
    expect(encodePublishCall({ meta, tiers, recipients: [], platformBps: 0 }).reasons).toBeUndefined();
    expect(encodePublishCall({ meta, tiers, recipients, platformBps: 500 }).reasons).toEqual(['밴드', 'MONTI 플랫폼']);
  });
});
