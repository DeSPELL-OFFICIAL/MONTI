import type { Hex } from 'viem';
import { ticketAbi } from '../shared/chain/abis';
import { getStaffAccount } from '../shared/chain/accounts';
import { OpReverted, ticketOp } from '../shared/chain/ops';
import type { EventMetaStruct, TierStruct } from '../shared/chain/reads';
import { revertMatch } from '../shared/chain/revert';
import { isUnsponsored } from '../shared/chain/unsponsored';

/**
 * The three writes that move an event through its life, and the one answer every screen needs
 * back from them. Nothing here renders anything: the caller pairs the result with its own
 * sentence from `organizerCopy.lifecycle`.
 */

/** A named rule the organiser can understand, rather than one sentence for every refusal. */
export type LifecycleProblem = 'notDraft' | 'closed' | 'notAllowed' | 'failed';

export type LifecycleResult =
  /** The chain has it. */
  | { state: 'done' }
  /** `wait` gave up before it landed. Not a failure — it is still on its way. */
  | { state: 'confirming' }
  /** Nothing agreed to pay for it, so it was never even sent (until sub-plan 01b). */
  | { state: 'unsponsored' }
  | { state: 'refused'; problem: LifecycleProblem };

/**
 * What `Ticket` reverts with on these three, against the rule each one names.
 * `_requireEventPermission` raises `Unauthorized`; `publishEvent` and `updateEventMeta` raise
 * `NotDraft` once the event is out; `cancelEvent` raises `EventAlreadyClosed` for an event
 * that has already ended or already been cancelled.
 */
const LIFECYCLE_REVERTS: ReadonlyArray<readonly [string, LifecycleProblem]> = [
  ['NotDraft', 'notDraft'],
  ['EventAlreadyClosed', 'closed'],
  ['Unauthorized', 'notAllowed'],
  ['UnknownEvent', 'failed'],
];

async function send(orgId: bigint, functionName: 'publishEvent' | 'cancelEvent' | 'updateEventMeta', args: readonly unknown[]): Promise<LifecycleResult> {
  try {
    await ticketOp({ account: await getStaffAccount(), orgId, functionName, args });
    return { state: 'done' };
  } catch (cause) {
    if (cause instanceof OpReverted) {
      if (cause.revertReason === 'TIMEOUT') return { state: 'confirming' };
      const problem = cause.revertReason
        ? revertMatch(ticketAbi, cause.revertReason as Hex, LIFECYCLE_REVERTS)
        : undefined;
      return { state: 'refused', problem: problem ?? 'failed' };
    }
    if (isUnsponsored(cause)) return { state: 'unsponsored' };
    return { state: 'refused', problem: 'failed' };
  }
}

/** Draft → Published. From here the event is visible to everybody and cannot be edited. */
export function publishEvent(eventId: bigint, orgId: bigint): Promise<LifecycleResult> {
  return send(orgId, 'publishEvent', [eventId]);
}

/**
 * Published (or Draft) → Cancelled, and there is no way back. Sign-ups close immediately, and
 * after sub-plan 01b's redeploy a cancelled event's tickets can no longer be handed over —
 * which is why the confirmation says so before this is called.
 */
export function cancelEvent(eventId: bigint, orgId: bigint): Promise<LifecycleResult> {
  return send(orgId, 'cancelEvent', [eventId]);
}

/** Draft only — the contract reverts `NotDraft` once the event is published. */
export function saveDraft(
  eventId: bigint,
  orgId: bigint,
  meta: EventMetaStruct,
  tiers: readonly TierStruct[],
): Promise<LifecycleResult> {
  return send(orgId, 'updateEventMeta', [eventId, meta, tiers]);
}
