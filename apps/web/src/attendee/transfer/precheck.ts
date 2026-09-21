import type { Hex } from '@monti/shared';
import { readIdentity, readTicket } from '../../shared/chain/reads';
import type { Copy } from '../../shared/copy/index';

/**
 * Spec §5.4: everything the contract would revert on is checked here first, so a doomed
 * handover shows a sentence instead of spending an operation. `Ticket._update` runs the same
 * rules again, which is where the security boundary actually is — this list is for the person.
 *
 * `revoked`, `alreadyEntered`, `notTransferable`, `afterCutoff`, `notMember`,
 * `recipientNotVerified`, `noTransfersLeft` and `maxPerWallet` each mirror one revert in
 * `_update`. `self` is cut by the server before that, and `locked` and `eventCancelled` are
 * ours alone: `_update` reads neither, but a locked recipient cannot enter with the seat and
 * a called-off event has nothing left to hand over.
 */
/** `Ticket.EventStatus` by its solidity ordinal; only the two closed ones are named here. */
const STATUS_CANCELLED = 2;
const STATUS_ENDED = 3;

export type PrecheckFailure =
  | 'self' | 'notMember' | 'locked' | 'revoked' | 'alreadyEntered' | 'eventCancelled'
  | 'notTransferable' | 'afterCutoff' | 'noTransfersLeft' | 'maxPerWallet'
  | 'recipientNotVerified';

export interface PrecheckArgs {
  tokenId: bigint;
  eventId: bigint;
  from: Hex;
  to: Hex;
  /** Seconds since the epoch, compared against the event's cutoff the way the chain does. */
  now: number;
  /** The tier's cap, event-wide. Required: the contract has no "no limit" value, and 0 blocks. */
  maxPerWallet: number;
}

export async function runPrecheck(args: PrecheckArgs): Promise<PrecheckFailure | null> {
  if (args.to.toLowerCase() === args.from.toLowerCase()) return 'self';

  const identity = readIdentity();
  const ticket = readTicket();

  if (!(await identity.isMember(args.to))) return 'notMember';
  if (await identity.isLocked(args.to)) return 'locked';

  if (await ticket.isRevoked(args.tokenId)) return 'revoked';
  const checkIn = await ticket.checkInOf(args.tokenId);
  if (checkIn.ts > 0n) return 'alreadyEntered';

  const status = await ticket.eventStatus(args.eventId);
  if (status === STATUS_CANCELLED || status === STATUS_ENDED) return 'eventCancelled';

  const meta = await ticket.eventMeta(args.eventId);
  // Per-event KYC: the contract reverts with KycRequired, so warn before spending a user operation.
  if (meta.requireKyc && (await identity.kycLevelOf(args.to)) < 1) return 'recipientNotVerified';
  if (!meta.transferable) return 'notTransferable';
  // Allowed only while now < startsAt - cutoff. The cutoff instant itself is already closed.
  if (args.now >= Number(meta.startsAt) - meta.transferCutoffSeconds) return 'afterCutoff';
  if ((await ticket.transfersOf(args.tokenId)) >= meta.maxTransfers) return 'noTransfersLeft';

  // Unguarded on purpose, like the contract: a tier with maxPerWallet 0 lets nobody receive.
  if ((await ticket.balanceOfEvent(args.to, args.eventId)) >= BigInt(args.maxPerWallet)) return 'maxPerWallet';

  return null;
}

export function precheckMessage(copy: Copy, failure: PrecheckFailure): string {
  const table: Record<PrecheckFailure, string> = {
    self: copy.transfer.alertSelf,
    notMember: copy.transfer.alertNotMember,
    locked: copy.transfer.alertLocked,
    revoked: copy.transfer.alertRevoked,
    alreadyEntered: copy.transfer.alertAlreadyEntered,
    eventCancelled: copy.transfer.alertEventCancelled,
    notTransferable: copy.transfer.alertNotTransferable,
    afterCutoff: copy.transfer.alertAfterCutoff,
    noTransfersLeft: copy.transfer.alertNoTransfersLeft,
    maxPerWallet: copy.transfer.alertMaxPerWallet,
    recipientNotVerified: copy.kyc.recipientNotVerified,
  };
  return table[failure];
}
