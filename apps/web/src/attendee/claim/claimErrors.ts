import type { Copy } from '../../shared/copy';

/**
 * The relayed claim's structured refusal, read off the callable's `HttpsError.details` (frozen
 * contract) — the same `{ code, nonce? }` a `relays/{id}` doc's `error` carries. Read structurally
 * (not with `instanceof`) so it still resolves when a screen's test mocks the callable module.
 */
export interface RelayClaimError {
  code: string;
  /** Present on `BAD_NONCE` only: the current on-chain claim nonce to rebuild the auth with. */
  nonce?: string;
}

export function relayClaimError(cause: unknown): RelayClaimError {
  const details = (cause as { details?: unknown } | null)?.details;
  if (typeof details === 'object' && details !== null) {
    const { code, nonce } = details as { code?: unknown; nonce?: unknown };
    return {
      code: typeof code === 'string' ? code : '',
      nonce: typeof nonce === 'string' ? nonce : undefined,
    };
  }
  return { code: '' };
}

/**
 * The one place relay refusal codes turn into attendee copy. The backend reuses the web's own
 * claim error names (design §7), and an unknown code falls back to the generic retry sentence —
 * never a blank. Zero web3 words, like every attendee string. `BAD_NONCE` never reaches here:
 * the flow rebuilds and retries it once before it could become copy.
 */
export function relayClaimCopy(code: string, copy: Copy): string {
  switch (code) {
    case 'SOLD_OUT':
      return copy.claim.soldOut;
    case 'LIMIT':
      return copy.claim.limitReached;
    case 'NOT_ON_SALE':
      return copy.claim.notOnSale;
    case 'APPROVAL_REQUIRED':
      return copy.claim.approvalOnly;
    case 'DEVICE_LOCKED':
      return copy.claim.deviceLocked;
    default:
      return copy.claim.failed;
  }
}
