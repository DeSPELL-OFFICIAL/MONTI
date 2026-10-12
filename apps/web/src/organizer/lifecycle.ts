import { encodeFunctionData } from 'viem';
import { ticketAbi } from '../shared/chain/abis';
import { sendAction } from '../shared/relay/sendAction';
import { relayProblem } from '../shared/relay/relayError';

/**
 * The one lifecycle write left after publishing: cancelling. Publishing is the draft screen's
 * single write (`scene/usePublish.ts`), and a published event is never edited — so there is no
 * Draft on chain to move or update. Nothing here renders anything: the caller pairs the result
 * with its own sentence from `organizerCopy.lifecycle`.
 *
 * The write is a relayed `MontiForwarder.execute` (via {@link sendAction}); `sendAction` follows
 * the relay document to a settled answer, so a success is always `done` here.
 */

/** A named rule the organiser can understand, rather than one sentence for every refusal. */
export type LifecycleProblem = 'closed' | 'notAllowed' | 'failed';

export type LifecycleResult =
  /** The chain has it. */
  | { state: 'done' }
  | { state: 'refused'; problem: LifecycleProblem };

/**
 * What `Ticket.cancelEvent` reverts with, against the rule each one names. The relayer bubbles
 * the target's Solidity error name, which `relayProblem` matches against this table.
 */
const CANCEL_REVERTS: ReadonlyArray<readonly [string, LifecycleProblem]> = [
  ['EventAlreadyClosed', 'closed'],
  ['Unauthorized', 'notAllowed'],
  ['UnknownEvent', 'failed'],
];

/**
 * Published → Cancelled, and there is no way back. Sign-ups close immediately, and a cancelled
 * event's tickets can no longer be handed over — which is why the confirmation says so before
 * this is called.
 */
export async function cancelEvent(eventId: bigint): Promise<LifecycleResult> {
  try {
    await sendAction(
      'cancelEvent',
      'ticket',
      encodeFunctionData({ abi: ticketAbi, functionName: 'cancelEvent', args: [eventId] }),
    );
    return { state: 'done' };
  } catch (cause) {
    return { state: 'refused', problem: relayProblem(cause, CANCEL_REVERTS) ?? 'failed' };
  }
}
