import { encodeFunctionData } from 'viem';
import { ticketAbi } from '../shared/chain/abis';
import { sendAction } from '../shared/relay/sendAction';
import { relayProblem } from '../shared/relay/relayError';
import type { EventMetaStruct, TierStruct } from '../shared/chain/reads';

/**
 * The three writes that move an event through its life, and the one answer every screen needs
 * back from them. Nothing here renders anything: the caller pairs the result with its own
 * sentence from `organizerCopy.lifecycle`.
 *
 * Phase 2: each write is a relayed `MontiForwarder.execute` (via {@link sendAction}) rather than a
 * sponsored UserOperation. `sendAction` follows the relay document to a settled answer, so a
 * success is always `done` here — the `confirming` UX now lives in the awaiting screen, not in a
 * timed-out receipt.
 */

/** A named rule the organiser can understand, rather than one sentence for every refusal. */
export type LifecycleProblem = 'notDraft' | 'closed' | 'notAllowed' | 'schedule' | 'tiers' | 'failed';

export type LifecycleResult =
  /** The chain has it. */
  | { state: 'done' }
  /** Still settling — kept for the organiser home's indexer poll; the final sweep (F) removes it. */
  | { state: 'confirming' }
  /** No longer reachable under the relayer (it pays); kept until the final sweep (F) drops it. */
  | { state: 'unsponsored' }
  | { state: 'refused'; problem: LifecycleProblem };

type LifecycleWrite = 'publishEvent' | 'cancelEvent' | 'updateEventMeta';

/**
 * What `Ticket` reverts with on these three, against the rule each one names. The relayer bubbles
 * the target's Solidity error name, which `relayProblem` matches against this table (the same names
 * the sponsored path decoded from a four-byte selector).
 *
 * `_requireEventPermission` raises `Unauthorized`; `publishEvent` and `updateEventMeta` raise
 * `NotDraft` once the event is out; `cancelEvent` raises `EventAlreadyClosed` for an event that has
 * already ended or already been cancelled. The last two belong to `updateEventMeta` alone — it
 * re-checks the schedule and the tiers the way `createEvent` did (`Ticket.sol:208`).
 */
const LIFECYCLE_REVERTS: ReadonlyArray<readonly [string, LifecycleProblem]> = [
  ['NotDraft', 'notDraft'],
  ['EventAlreadyClosed', 'closed'],
  ['Unauthorized', 'notAllowed'],
  ['InvalidSchedule', 'schedule'],
  ['InvalidTiers', 'tiers'],
  ['UnknownEvent', 'failed'],
];

async function send(functionName: LifecycleWrite, args: readonly unknown[]): Promise<LifecycleResult> {
  try {
    await sendAction(functionName, 'ticket', encodeFunctionData({ abi: ticketAbi, functionName, args }));
    return { state: 'done' };
  } catch (cause) {
    return { state: 'refused', problem: relayProblem(cause, LIFECYCLE_REVERTS) ?? 'failed' };
  }
}

/**
 * Draft → Published. From here the event is visible to everybody and cannot be edited. `_orgId` is
 * no longer used to pick a paymaster (the relayer pays), kept only so callers need not change until
 * the final sweep (F).
 */
export function publishEvent(eventId: bigint, _orgId: bigint): Promise<LifecycleResult> {
  return send('publishEvent', [eventId]);
}

/**
 * Published (or Draft) → Cancelled, and there is no way back. Sign-ups close immediately, and a
 * cancelled event's tickets can no longer be handed over — which is why the confirmation says so
 * before this is called.
 */
export function cancelEvent(eventId: bigint, _orgId: bigint): Promise<LifecycleResult> {
  return send('cancelEvent', [eventId]);
}

/** Draft only — the contract reverts `NotDraft` once the event is published. */
export function saveDraft(
  eventId: bigint,
  _orgId: bigint,
  meta: EventMetaStruct,
  tiers: readonly TierStruct[],
): Promise<LifecycleResult> {
  return send('updateEventMeta', [eventId, meta, tiers]);
}
