import type { Copy } from '../../shared/copy';

/**
 * The one place a purchase refusal code (`purchaseTicket`'s `details.code`, or a `purchase` relay
 * doc's `error.code`) turns into attendee copy. The purchase is one atomic step — the ticket and
 * the payment land together or not at all — so every determinate refusal can say plainly that
 * nothing was charged. Only a call that never answered with a code (`''`, a dropped connection)
 * gets the plain retry sentence, because then we cannot promise what happened. Never a blank, and
 * never a web3 word. `BAD_NONCE` never reaches here: the flow rebuilds and retries it once first.
 */
export function purchaseCopy(code: string, copy: Copy): string {
  switch (code) {
    case '':
      return copy.purchase.failed;
    case 'PRICE_MISMATCH':
    case 'NOT_PAID_TIER':
    case 'UNKNOWN_TIER':
      return copy.purchase.priceChanged;
    case 'TREASURY_FUNDS':
    case 'PAUSED':
    case 'CONFIG':
      return copy.purchase.unavailable;
    case 'SOLD_OUT':
      return copy.purchase.soldOut;
    case 'LIMIT':
      return copy.claim.limitReached;
    case 'NOT_ON_SALE':
    case 'NOT_PUBLISHED':
      return copy.claim.notOnSale;
    case 'EVENT_ENDED':
      return copy.purchase.ended;
    case 'KYC_REQUIRED':
      return copy.purchase.kycRequired;
    case 'APPROVAL_REQUIRED':
      return copy.claim.approvalOnly;
    case 'DEVICE_LOCKED':
      return copy.claim.deviceLocked;
    case 'TOO_MANY_PENDING':
      return copy.purchase.busy;
    default:
      // SEND_FAILED, REVERTED, AUTH_EXPIRED, NOT_MEMBER, BAD_DEVICE_SIG and any newer code.
      return copy.purchase.notCharged;
  }
}
