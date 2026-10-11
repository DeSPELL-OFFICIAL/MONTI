import { encodeFunctionData } from 'viem';
import type { Hex, PolicyRecipientInput } from '@monti/shared';
import { ticketAbi } from '../../shared/chain/abis';
import type { EventMetaStruct, TierStruct } from '../../shared/chain/reads';

/**
 * Everything the single publish write carries: the event, its kinds with their prices, and —
 * for an event with a paid kind — the split rules the vault freezes in the same transaction.
 * A free event has no recipients and `platformBps` 0.
 */
export interface PublishCallInput {
  meta: EventMetaStruct;
  tiers: TierStruct[];
  recipients: PolicyRecipientInput[];
  platformBps: number;
}

/** One relayed `Ticket` write, as `sendAction(kind, 'ticket', data, onSent, { reasons })` takes it. */
export interface PublishCall {
  kind: string;
  data: Hex;
  /** One readable reason per recipient, in recipient order; absent for a free event. */
  reasons?: string[];
}

/**
 * The publish write's calldata — the one on-chain step of the draft → 정산 규칙 → 공개 flow.
 *
 * This is the seam the v2 ABI fills: the frozen `Ticket.publishEvent(meta, tiers, policy)` with
 * `toOnChainRecipients(recipients)`, `platformBps`, `reserveBps 0`, `noShowRefund false`. The ABI
 * in this build predates it, so the body encodes the build's `createEvent(meta, tiers)` and the
 * policy travels only as `reasons`.
 */
export function encodePublishCall(input: PublishCallInput): PublishCall {
  const data = encodeFunctionData({
    abi: ticketAbi,
    functionName: 'createEvent',
    args: [input.meta, input.tiers],
  });
  return input.recipients.length === 0
    ? { kind: 'createEvent', data }
    : { kind: 'createEvent', data, reasons: input.recipients.map((recipient) => recipient.reason) };
}
