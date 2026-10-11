import { encodeEventTopics, encodeAbiParameters, encodeFunctionData, keccak256, stringToHex, toHex } from 'viem';
import { organizersAbi, settlementVaultAbi, ticketAbi, type Hex } from '@monti/shared';

/**
 * v2 `Ticket.publishEvent(meta, tiers, policy)` calldata 와 확정 영수증 로그를 짓는 테스트 도우미.
 * relayAction·postConfirm·reconcileRelays 테스트가 같은 모양을 쓴다.
 */

export interface PublishFixture {
  orgId?: bigint;
  prices?: bigint[];
  recipients?: Array<{ account: Hex; bps: number; reason: string; tag: string }>;
  platformBps?: number;
}

export function publishCalldata({ orgId = 7n, prices = [0n], recipients = [], platformBps = 0 }: PublishFixture = {}): Hex {
  const ZERO32 = `0x${'00'.repeat(32)}` as Hex;
  const meta = {
    orgId,
    titleHash: ZERO32,
    descHash: ZERO32,
    imageCid: 'bafy',
    startsAt: 2_000_000_000n,
    endsAt: 2_000_003_600n,
    venueHash: ZERO32,
    saleStart: 0n,
    saleEnd: 2_000_000_000n,
    transferable: true,
    transferCutoffSeconds: 0,
    maxTransfers: 0,
    approvalRequired: false,
    category: 0,
    regionCode: ZERO32,
    requireKyc: false,
  };
  const tiers = prices.map((priceUsdCents, i) => ({
    name: `T${i}`,
    priceUsdCents,
    supply: 100,
    minted: 0,
    maxPerWallet: 4,
    seated: false,
  }));
  const policy = {
    recipients: recipients.map((r) => ({
      account: r.account,
      bps: r.bps,
      reasonHash: keccak256(toHex(r.reason)),
      tag: stringToHex(r.tag, { size: 32 }),
    })),
    platformBps,
    reserveBps: 0,
    noShowRefund: false,
    frozen: false,
    version: 0,
  };
  return encodeFunctionData({ abi: ticketAbi, functionName: 'publishEvent', args: [meta, tiers, policy] } as never);
}

function log(address: Hex, topics: readonly (Hex | null)[] | Hex[], data: Hex, logIndex: number) {
  return {
    address,
    topics,
    data,
    blockNumber: 100n,
    blockHash: `0x${'bb'.repeat(32)}`,
    transactionHash: `0x${'ab'.repeat(32)}`,
    transactionIndex: 0,
    logIndex,
    removed: false,
  };
}

export function eventCreatedLog(ticket: Hex, eventId: bigint, orgId: bigint, creator: Hex) {
  return log(
    ticket,
    encodeEventTopics({ abi: ticketAbi, eventName: 'EventCreated', args: { eventId, orgId, creator } } as never) as Hex[],
    '0x',
    0,
  );
}

export function gateRegisteredLog(organizers: Hex, gateId: bigint, eventId: bigint, gateAccount: Hex) {
  return log(
    organizers,
    encodeEventTopics({ abi: organizersAbi, eventName: 'GateRegistered', args: { gateId, eventId, gateAccount } } as never) as Hex[],
    encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }], [`0x${'11'.repeat(32)}`, `0x${'22'.repeat(32)}`]),
    0,
  );
}

export function policySetLog(vault: Hex, eventId: bigint, organizer: Hex, policyHash: Hex) {
  return log(
    vault,
    encodeEventTopics({ abi: settlementVaultAbi, eventName: 'PolicySet', args: { eventId, organizer } } as never) as Hex[],
    encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint32' }], [policyHash, 1]),
    2,
  );
}
