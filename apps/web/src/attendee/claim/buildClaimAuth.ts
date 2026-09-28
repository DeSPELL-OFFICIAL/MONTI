import {
  claimAuthDigest,
  encodeClaimAuthStruct,
  joinRs,
  P256_HALF_ORDER,
  type ClaimAuth,
  type ClaimAuthWire,
  type Hex,
} from '@monti/shared';
import { getConfig } from '../../shared/config';
import { readClaimNonce } from '../../shared/chain/reads';
import { ATTENDEE_KEY_ALIAS, signWithDeviceKey } from '../../shared/deviceKey';

/** How long an unsent authorization lives before the chain refuses it (design §2: ~10 minutes). */
export const CLAIM_DEADLINE_SECONDS = 10 * 60;

export interface BuiltClaimAuth {
  /** The `ClaimAuth` tuple as JSON-safe strings — exactly what `relayClaim` takes. */
  auth: ClaimAuthWire;
  /** The device key's raw signature over {@link claimAuthDigest}: `0x` + 128 hex (r‖s). */
  deviceSig: Hex;
}

export interface BuildClaimAuthParams {
  eventId: string;
  tier: number;
  account: Hex;
  /**
   * The claim nonce to sign, when the caller already holds the fresh one — a BAD_NONCE retry
   * passes `details.nonce`. Omitted, it is read from the chain: `claimNonce(eventId, account)`.
   */
  nonce?: bigint;
}

/**
 * Builds and signs one relayed-claim authorization (design §2/§7). The attendee device key
 * (P-256) signs the 32-byte {@link claimAuthDigest} **raw** — the same signer path the check-in
 * flow uses (`enter/buildResponse.ts`): the secure element does not re-hash, and `s` must be in
 * the low half of the curve order or Solady's on-chain verifier rejects it. `chainId` and the
 * Ticket address come from config, so a signature is bound to this chain and this deployment and
 * cannot be replayed elsewhere.
 */
export async function buildClaimAuth(params: BuildClaimAuthParams): Promise<BuiltClaimAuth> {
  const config = getConfig();
  const eventId = BigInt(params.eventId);
  const nonce = params.nonce ?? (await readClaimNonce(eventId, params.account));
  const deadline = BigInt(Math.floor(Date.now() / 1000) + CLAIM_DEADLINE_SECONDS);
  const auth: ClaimAuth = { eventId, tier: params.tier, account: params.account, nonce, deadline };
  const digest = claimAuthDigest(BigInt(config.chainId), config.addresses.ticket, auth);
  const { r, s } = await signWithDeviceKey(digest, { alias: ATTENDEE_KEY_ALIAS });
  // Solady's P256.verifySignature rejects the high half outright, and about half of real
  // signatures land there. The signer normalises, but a value that reached here high-s would be a
  // revert the attendee cannot explain, so it is refused before it leaves (mirrors buildResponse).
  if (BigInt(s) > P256_HALF_ORDER) throw new Error('HIGH_S');
  return { auth: encodeClaimAuthStruct(auth), deviceSig: joinRs(r, s) };
}
