import type { Hex } from '@monti/shared';
import { EventStatus, readIdentity, readTicket } from '../../shared/chain/reads';
import type { Copy } from '../../shared/copy/index';

/**
 * Spec §5.4: everything the contract would revert on is checked here first, so a doomed
 * handover shows a sentence instead of spending an operation. `Ticket._update` runs the same
 * rules again, which is where the security boundary actually is — this list is for the person.
 *
 * `revoked`, `notTransferable`, `alreadyEntered`, `afterCutoff`, `notMember`,
 * `recipientNotVerified`, `noTransfersLeft` and `maxPerWallet` each mirror one revert in
 * `_update`, **in that order**, because that is the order the chain refuses in. `self` is cut
 * by the server before that, and `locked` and `eventCancelled` are ours alone: `_update`
 * reads neither, but a locked recipient cannot enter with the seat and a called-off event has
 * nothing left to hand over.
 */
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
  // Costs no read at all, so it is settled before anything goes to the network.
  if (args.to.toLowerCase() === args.from.toLowerCase()) return 'self';

  const identity = readIdentity();
  const ticket = readTicket();

  // Every read leaves at once. `client.ts` batches them into a single multicall, so a
  // handover that is going to be refused costs one round trip on a phone instead of nine —
  // and every value is in hand before the first rule is judged, which is what lets the
  // order below be the chain's order rather than the order the reads happen to finish in.
  const [isMember, isLocked, kycLevel, revoked, checkIn, status, meta, transfers, held] =
    await Promise.all([
      identity.isMember(args.to),
      identity.isLocked(args.to),
      identity.kycLevelOf(args.to),
      ticket.isRevoked(args.tokenId),
      ticket.checkInOf(args.tokenId),
      ticket.eventStatus(args.eventId),
      ticket.eventMeta(args.eventId),
      ticket.transfersOf(args.tokenId),
      ticket.balanceOfEvent(args.to, args.eventId),
    ]);

  // Ours, not the contract's. `_update` reads neither, so they cannot disturb the mirror
  // below; they go first because a locked recipient or a dead event makes the rest moot.
  if (isLocked) return 'locked';
  if (status === EventStatus.Cancelled || status === EventStatus.Ended) return 'eventCancelled';

  // From here down this is `Ticket._update` (contracts/src/Ticket.sol) line for line. When two
  // rules fail at once the person reads the reason the chain would actually have refused with.
  if (revoked) return 'revoked'; // TicketRevoked
  if (!meta.transferable) return 'notTransferable'; // TransfersDisabled
  if (checkIn.ts > 0n) return 'alreadyEntered'; // AlreadyCheckedIn
  // TransferCutoffPassed. Allowed only while now < startsAt - cutoff; the instant itself is closed.
  if (args.now >= Number(meta.startsAt) - meta.transferCutoffSeconds) return 'afterCutoff';
  if (!isMember) return 'notMember'; // NotMember
  if (meta.requireKyc && kycLevel < 1) return 'recipientNotVerified'; // KycRequired
  if (transfers >= meta.maxTransfers) return 'noTransfersLeft'; // TransferLimitReached
  // MaxPerWalletExceeded. Unguarded on purpose, like the contract: a tier with maxPerWallet 0
  // lets nobody receive.
  if (held >= BigInt(args.maxPerWallet)) return 'maxPerWallet';

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
