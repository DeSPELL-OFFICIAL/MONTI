import { P256_HALF_ORDER, P256_ORDER, type Hex } from '@monti/shared';

/**
 * Ticket.checkIn verifies through Solady's `P256.verifySignature`, which includes the
 * malleability check and rejects anything with `s > n/2`. A signer's `s` is uniform, so half of
 * all real signatures land in the high half. `(r, n - s)` verifies for the same message and key
 * — that is exactly what ECDSA malleability means — so flipping `s` into the low half is
 * lossless, and skipping it would revert ~50% of check-ins.
 *
 * Both signers go through here: the secure element (native.ts) and the software key (web.ts).
 */
export function toLowS(s: Hex): Hex {
  const value = BigInt(s);
  if (value <= P256_HALF_ORDER) return s;
  return `0x${(P256_ORDER - value).toString(16).padStart(64, '0')}`;
}
