import {
  claimAuthDigest,
  claimAuthPreimage,
  encodeClaimAuthStruct,
  joinRs,
  P256_HALF_ORDER,
  type ClaimAuth,
  type ClaimAuthWire,
  type Hex,
} from '@monti/shared';
import { getConfig } from '../../shared/config';
import { readClaimNonce } from '../../shared/chain/reads';
import { ATTENDEE_KEY_ALIAS, deviceKeyCapability, signWithDeviceKey } from '../../shared/deviceKey';

/** How long an unsent authorization lives before the chain refuses it (design §2: ~10 minutes). */
export const CLAIM_DEADLINE_SECONDS = 10 * 60;

export interface BuiltClaimAuth {
  /** The `ClaimAuth` tuple as JSON-safe strings — exactly what `relayClaim` takes. */
  auth: ClaimAuthWire;
  /** The device key's P-256 signature over {@link claimAuthDigest}: `0x` + 128 hex (r‖s). */
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
 * Builds and signs one relayed-claim authorization (design §2/§7). The result must verify as a
 * P-256 signature over the 32-byte {@link claimAuthDigest} — what `Ticket._verifyClaimAuth`
 * recomputes and checks. The two device-key backends need different bytes to get there, so the
 * call site chooses (as the check-in flow does): the secure element (`native`) signs the digest
 * **raw**, while the browser's WebCrypto key (`software`) hashes what it is handed, so it is given
 * the {@link claimAuthPreimage} whose SHA-256 is that digest. Handing the WebCrypto signer the
 * digest instead would sign `sha256(digest)` and the chain would reject it with
 * `BadDeviceSignature` — the live browser-claim bug this guards against. `s` must land in the low
 * half or Solady's verifier rejects it; `chainId` and the Ticket address come from config, so a
 * signature is bound to this chain and this deployment and cannot be replayed elsewhere.
 */
export async function buildClaimAuth(params: BuildClaimAuthParams): Promise<BuiltClaimAuth> {
  const config = getConfig();
  const eventId = BigInt(params.eventId);
  const nonce = params.nonce ?? (await readClaimNonce(eventId, params.account));
  const deadline = BigInt(Math.floor(Date.now() / 1000) + CLAIM_DEADLINE_SECONDS);
  const auth: ClaimAuth = { eventId, tier: params.tier, account: params.account, nonce, deadline };
  const chainId = BigInt(config.chainId);
  // The digest is what the chain verifies; the preimage is the bytes whose SHA-256 is that digest.
  const digest = claimAuthDigest(chainId, config.addresses.ticket, auth);
  const preimage = claimAuthPreimage(chainId, config.addresses.ticket, auth);
  // A raw signer (secure element) signs the digest as-is; WebCrypto hashes its input, so it takes
  // the preimage. Either way r‖s is a P-256 signature over `digest`.
  const message = deviceKeyCapability() === 'native' ? digest : preimage;
  const { r, s } = await signWithDeviceKey(message, { alias: ATTENDEE_KEY_ALIAS });
  // Solady's P256.verifySignature rejects the high half outright, and about half of real
  // signatures land there. The signer normalises, but a value that reached here high-s would be a
  // revert the attendee cannot explain, so it is refused before it leaves (mirrors buildResponse).
  if (BigInt(s) > P256_HALF_ORDER) throw new Error('HIGH_S');
  return { auth: encodeClaimAuthStruct(auth), deviceSig: joinRs(r, s) };
}
