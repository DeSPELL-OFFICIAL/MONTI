import { encodeFunctionData } from 'viem';
import { api, callableFailure } from '../../shared/api/functions';
import { ticketAbi } from '../../shared/chain/abis';
import { sendAction } from '../../shared/relay/sendAction';
import { readTicket, type OfferStruct } from '../../shared/chain/reads';
import type { Copy } from '../../shared/copy/index';
import { precheckMessage } from './precheck';
import { matchByName, relayActionCode, revertRuleByName } from './useTransfer';

/** `offerOf` answers with the zero struct when nothing is pending, and `from` at zero is the
 *  contract's own test for that (`Ticket.sol` `cancelOffer`/`acceptOffer`). */
const NO_SENDER = `0x${'00'.repeat(20)}`;

/**
 * Whether an offer is still collectable. The expiry boundary is the contract's own:
 * `acceptOffer` refuses on `block.timestamp > o.expiresAt`, so the last second still counts.
 */
export function isOpenOffer(offer: OfferStruct, now: number): boolean {
  return offer.from.toLowerCase() !== NO_SENDER && offer.expiresAt >= BigInt(now);
}

/**
 * Called the moment signup finishes, so somebody who arrived from a text finds the ticket
 * already theirs. Rows go one at a time on purpose: a single refusal — a verification not
 * done, an invite that expired, one already collected — must not abort the rest of the inbox.
 * Returns how many were really collected. It lives here rather than beside the inbox screen
 * so that signup can call it without pulling a react-query screen into its chunk. The relayer
 * sponsors each `acceptOffer`, so nothing here needs the event's organisation.
 */
export async function acceptPendingOffers(): Promise<number> {
  const offers = await api.pendingOffers();
  if (offers.length === 0) return 0;
  let accepted = 0;
  for (const offer of offers) {
    try {
      await sendAction(
        'acceptOffer',
        'ticket',
        encodeFunctionData({
          abi: ticketAbi,
          functionName: 'acceptOffer',
          args: [BigInt(offer.tokenId), offer.attesterSig],
        }),
      );
      accepted += 1;
    } catch {
      /* leave it in the inbox; the screen there says why when the person opens it */
    }
  }
  return accepted;
}

/** True while the operation's outcome is unknown rather than refused: no determinate code came
 *  back, so the write may yet be on chain. Never shown as a denial. */
export function isStillConfirming(cause: unknown): boolean {
  return relayActionCode(cause) === '';
}

type Sentence = (copy: Copy) => string;

/**
 * `createOffer` and `cancelOffer` re-check every handover rule, so most of what they can
 * refuse with is already in `revertRuleByName`'s eight. These three are their own: the ticket is
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
 * `MaxPerWalletExceeded` are `_update`'s, and `revertRuleByName` does own sentences for them — but
 * those are written about the person on the far side of a handover, and here that person is
 * the reader, so they get their own. `NOT_MEMBER`/`DEVICE_LOCKED` are the forwarder's own gate
 * codes for the same two conditions caught before the target runs; both spell one sentence.
 *
 * The last two are 01b's, and both are newly reachable on this side (abi-delta-01b.md §6):
 *
 * - `RotationPending` — `_update` now holds a freshly moved account at arm's length for the
 *   whole undo window, on mint as well as on transfer. It applies to an honest recovery too,
 *   so somebody who just changed phones receives nothing at all for that day, and the sentence
 *   has to say so rather than read as a failure they can retry out of.
 * - `DeviceLocked` — the freeze became bidirectional. A locked phone is now refused as the
 *   RECIPIENT of a handover, which is exactly this screen, and no longer only as its sender.
 */
const ACCEPT_REVERTS: ReadonlyArray<readonly [string, Sentence]> = [
  ['NoOffer', (copy) => copy.transfer.offerGone],
  ['OfferExpired', (copy) => copy.transfer.offerExpired],
  ['BadAttesterSig', (copy) => copy.transfer.offerNotYours],
  ['KycRequired', (copy) => copy.kyc.offerNeedsKyc],
  ['NotMember', (copy) => copy.transfer.offerNotMember],
  ['NOT_MEMBER', (copy) => copy.transfer.offerNotMember],
  ['MaxPerWalletExceeded', (copy) => copy.transfer.offerMaxPerWallet],
  ['RotationPending', (copy) => copy.transfer.offerRotationPending],
  ['DeviceLocked', (copy) => copy.transfer.offerDeviceLocked],
  ['DEVICE_LOCKED', (copy) => copy.transfer.offerDeviceLocked],
];

/** A screen's own table first, then the eight rules a handover already has sentences for. An
 *  indeterminate failure (no code) is not a sentence — the caller shows it as still confirming. */
function revertSentence(
  copy: Copy,
  cause: unknown,
  table: ReadonlyArray<readonly [string, Sentence]>,
): string | undefined {
  const code = relayActionCode(cause);
  if (code === '') return undefined;
  const own = matchByName(code, table);
  if (own) return own(copy);
  const rule = revertRuleByName(code);
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
