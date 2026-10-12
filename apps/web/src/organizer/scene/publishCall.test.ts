import { describe, expect, it } from 'vitest';
import { decodeFunctionData, getAddress, toFunctionSelector } from 'viem';
import { reasonHash, tagToBytes32 } from '@monti/shared';
import { ticketAbi } from '../../shared/chain/abis';
import { buildEventMeta, buildTiers, type ChainDraft } from './buildEventMeta';
import { encodePublishCall } from './publishCall';

const draft: ChainDraft = {
  orgId: '1001', title: '재즈 나이트', description: '', venue: '', regionCode: 'KR-11', category: 0,
  startsAt: 1_790_000_000, endsAt: 1_790_010_000, saleStart: 1_789_000_000, saleEnd: 1_790_010_000,
  transferable: true, transferCutoffHours: 2, maxTransfers: 3, approvalRequired: false, requireKyc: false,
  tiers: [{ name: 'VIP', priceUsdCents: 3_000, supply: 10, maxPerWallet: 1, seated: false }],
};
const meta = buildEventMeta(draft, 'bafyMeta');
const tiers = buildTiers(draft);
const BAND = `0x${'a1'.repeat(20)}` as const;
const PLATFORM = `0x${'cc'.repeat(20)}` as const;
const recipients = [
  { account: BAND, bps: 9_500, reason: '밴드', tag: 'band' },
  { account: PLATFORM, bps: 500, reason: 'MONTI 플랫폼', tag: 'platform' },
];

function decode(data: `0x${string}`) {
  const decoded = decodeFunctionData({ abi: ticketAbi, data });
  return { name: decoded.functionName, args: (decoded.args ?? []) as readonly unknown[] };
}

describe('encodePublishCall (v2: one Ticket.publishEvent)', () => {
  it('encodes publishEvent(meta, tiers, policy) — the frozen selector 0x7254c158', () => {
    const call = encodePublishCall({ meta, tiers, recipients, platformBps: 500 });
    expect(call.kind).toBe('publishEvent');
    expect(call.data.slice(0, 10)).toBe('0x7254c158');
    expect(toFunctionSelector(
      'publishEvent((uint256,bytes32,bytes32,string,uint64,uint64,bytes32,uint64,uint64,bool,uint32,uint8,bool,uint8,bytes32,bool),(string,uint256,uint32,uint32,uint16,bool)[],((address,uint16,bytes32,bytes32)[],uint16,uint16,bool,bool,uint32))',
    )).toBe('0x7254c158');
    const { name, args } = decode(call.data);
    expect(name).toBe('publishEvent');
    expect(args[0]).toMatchObject({ orgId: 1001n, imageCid: 'bafyMeta' });
    expect(args[1]).toEqual([expect.objectContaining({ name: 'VIP', priceUsdCents: 3_000n })]);
  });

  it('carries a paid split as on-chain recipients, the platform mirror, no reserve and no no-show refund', () => {
    const call = encodePublishCall({ meta, tiers, recipients, platformBps: 500 });
    expect(decode(call.data).args[2]).toEqual({
      recipients: [
        { account: getAddress(BAND), bps: 9_500, reasonHash: reasonHash('밴드'), tag: tagToBytes32('band') },
        { account: getAddress(PLATFORM), bps: 500, reasonHash: reasonHash('MONTI 플랫폼'), tag: tagToBytes32('platform') },
      ],
      platformBps: 500, reserveBps: 0, noShowRefund: false, frozen: false, version: 0,
    });
    expect(call.reasons).toEqual(['밴드', 'MONTI 플랫폼']);
  });

  it('sends an empty policy and no reasons for a free event', () => {
    const call = encodePublishCall({ meta, tiers: buildTiers({ ...draft, tiers: [{ ...draft.tiers[0]!, priceUsdCents: 0 }] }), recipients: [], platformBps: 0 });
    expect(decode(call.data).args[2]).toEqual({
      recipients: [], platformBps: 0, reserveBps: 0, noShowRefund: false, frozen: false, version: 0,
    });
    expect(call.reasons).toBeUndefined();
  });
});
