import { encodeFunctionData } from 'viem';
import { toOnChainRecipients, type Hex, type PolicyRecipientInput } from '@monti/shared';
import { ticketAbi } from '../../shared/chain/abis';
import type { EventMetaStruct, SplitPolicyStruct, TierStruct } from '../../shared/chain/reads';

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
  kind: 'publishEvent';
  data: Hex;
  /** One readable reason per recipient, in recipient order; absent for a free event. */
  reasons?: string[];
}

/**
 * The calldata of `Ticket.publishEvent(meta, tiers, policy)` (`0x7254c158`) — the one on-chain
 * step of draft → 정산 규칙 → 공개 (design D2). The event is created Published in that one
 * transaction; for a paid event the Ticket hands `policy` to `SettlementVault.setPolicyByTicket`,
 * which freezes it. A free event must send an empty policy (`UnexpectedPolicy` otherwise).
 *
 * The chain keeps only `keccak256(reason)`; the readable reasons ride beside the request
 * (`relayAction.reasons`) so the confirm hook can store them in `settlements/{eventId}`.
 * `reserveBps` and `noShowRefund` have no screen and one right answer each; `frozen`/`version`
 * are ignored by the contract (stored as `true`/`1`).
 */
export function encodePublishCall(input: PublishCallInput): PublishCall {
  const policy: SplitPolicyStruct = {
    recipients: toOnChainRecipients(input.recipients),
    platformBps: input.platformBps,
    reserveBps: 0,
    noShowRefund: false,
    frozen: false,
    version: 0,
  };
  const data = encodeFunctionData({
    abi: ticketAbi,
    functionName: 'publishEvent',
    args: [input.meta, input.tiers, policy],
  });
  return input.recipients.length === 0
    ? { kind: 'publishEvent', data }
    : { kind: 'publishEvent', data, reasons: input.recipients.map((recipient) => recipient.reason) };
}
