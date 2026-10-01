import type { Copy } from '../../shared/copy';

/**
 * The one place a purchase refusal code turns into attendee copy. `purchaseTicket` reuses the
 * claim error names plus the two price checks the escrow adds (`NO_PRICE`/`PRICE_MISMATCH`), and
 * an unknown code falls back to the generic retry sentence — never a blank, and never a web3 word.
 * `BAD_NONCE` never reaches here: the flow rebuilds and retries it once before it could be copy.
 */
export function purchaseCopy(code: string, copy: Copy): string {
  switch (code) {
    case 'NO_PRICE':
    case 'PRICE_MISMATCH':
      return copy.purchase.priceChanged;
    case 'SOLD_OUT':
      return copy.purchase.soldOut;
    case 'LIMIT':
      return copy.claim.limitReached;
    case 'NOT_ON_SALE':
      return copy.claim.notOnSale;
    case 'DEVICE_LOCKED':
      return copy.claim.deviceLocked;
    default:
      return copy.purchase.failed;
  }
}
