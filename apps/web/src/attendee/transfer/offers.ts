import type { Hex } from '@monti/shared';
import { callableFailure } from '../../shared/api/functions';
import { OpReverted } from '../../shared/chain/ops';
import { readTicket, type OfferStruct } from '../../shared/chain/reads';
import type { Copy } from '../../shared/copy/index';
import { precheckMessage } from './precheck';
import { revertMatch, revertRule } from './useTransfer';

/** `wait` gave up before the operation landed. Not a refusal — it is still on its way. */
export const STILL_CONFIRMING = 'TIMEOUT';

/** `offerOf` answers with the zero struct when nothing is pending, so this is "no offer". */
const NO_COMMITMENT = `0x${'00'.repeat(32)}`;

/**
 * The organisation that sponsors an operation on one ticket. Two reads, named once here,
 * because every write in the invite flow needs it and none of them should re-derive it.
 */
export async function orgIdOfTicket(tokenId: bigint): Promise<bigint> {
  const ticket = readTicket();
  return (await ticket.eventMeta(await ticket.eventOf(tokenId))).orgId;
}

/**
 * Whether an offer is still collectable. The expiry boundary is the contract's own:
 * `acceptOffer` refuses on `block.timestamp > o.expiresAt`, so the last second still counts.
 */
export function isOpenOffer(offer: OfferStruct, now: number): boolean {
  return offer.recipientCommitment.toLowerCase() !== NO_COMMITMENT && offer.expiresAt >= BigInt(now);
}

/** True while the operation is on its way rather than refused. Never shown as a denial. */
export function isStillConfirming(cause: unknown): boolean {
  return cause instanceof OpReverted && cause.revertReason === STILL_CONFIRMING;
}

type Sentence = (copy: Copy) => string;

/**
 * `createOffer` and `cancelOffer` re-check every handover rule, so most of what they can
 * refuse with is already in `revertRule`'s eight. These three are their own: the ticket is
 * not mine, the deadline handed to `createOffer` is already behind us, and there is nothing
 * left to cancel.
 */
const OFFER_REVERTS: ReadonlyArray<readonly [string, Sentence]> = [
  ['Unauthorized', (copy) => copy.transfer.notMyTicket],
  ['OfferExpired', (copy) => copy.transfer.offerExpired],
  ['NoOffer', (copy) => copy.transfer.offerGone],
];

/**
 * What `acceptOffer` refuses with, in the receiver's voice. `KycRequired`, `NotMember` and
 * `MaxPerWalletExceeded` are `_update`'s, and `revertRule` does own sentences for them — but
 * those are written about the person on the far side of a handover, and here that person is
 * the reader, so they get their own.
 */
const ACCEPT_REVERTS: ReadonlyArray<readonly [string, Sentence]> = [
  ['NoOffer', (copy) => copy.transfer.offerGone],
  ['OfferExpired', (copy) => copy.transfer.offerExpired],
  ['BadAttesterSig', (copy) => copy.transfer.offerNotYours],
  ['KycRequired', (copy) => copy.kyc.offerNeedsKyc],
  ['NotMember', (copy) => copy.transfer.offerNotMember],
  ['MaxPerWalletExceeded', (copy) => copy.transfer.offerMaxPerWallet],
];

/** A screen's own table first, then the eight rules a handover already has sentences for. */
function revertSentence(
  copy: Copy,
  cause: unknown,
  table: ReadonlyArray<readonly [string, Sentence]>,
): string | undefined {
  if (!(cause instanceof OpReverted) || !cause.revertReason || cause.revertReason === STILL_CONFIRMING) {
    return undefined;
  }
  const reason: Hex = cause.revertReason;
  const own = revertMatch(reason, table);
  if (own) return own(copy);
  const rule = revertRule(reason);
  return rule ? precheckMessage(copy, rule) : undefined;
}

/**
 * Everything that can go wrong on the way to an invite: the server refusing to make one
 * (`functions/src/functions/transferInvites.ts`), or the chain refusing the offer itself.
 */
export function inviteFailure(copy: Copy, cause: unknown): string {
  const revert = revertSentence(copy, cause, OFFER_REVERTS);
  if (revert) return revert;
  switch (callableFailure(cause).reason) {
    case 'OFFER_ALREADY_OPEN':
      return copy.transfer.offerAlreadyOpen;
    case 'NOT_TOKEN_OWNER':
      return copy.transfer.notMyTicket;
    case 'SELF_TRANSFER':
      return copy.transfer.alertSelf;
    case 'BAD_PHONE':
      return copy.signup.phoneInvalid;
    case 'BAD_TOKEN_ID':
      return copy.transfer.badInput;
    default:
      return copy.transfer.inviteFailed;
  }
}

/** The same for the receiving side. A refusal nobody here knows is not something to act on. */
export function acceptFailure(copy: Copy, cause: unknown): string {
  return revertSentence(copy, cause, ACCEPT_REVERTS) ?? copy.transfer.acceptFailed;
}
