import { p256 } from '@noble/curves/p256';
import * as WebAuthnP256 from 'ox/WebAuthnP256';
import { encodeAbiParameters, sha256, type Hex } from 'viem';

import { signWithGateKey } from '../../staff/gate/gateKey';
import { getConfig } from '../config';

/**
 * `WebAuthn.WebAuthnAuth` (contracts/lib/smart-wallet/lib/webauthn-sol/src/WebAuthn.sol) in
 * TypeScript. The gate terminal has no authenticator — its P-256 key lives in StrongBox and is
 * registered as the smart account's 64-byte `x ‖ y` owner — so these bytes are synthesised.
 * That is honest rather than a forgery: `WebAuthn.verify` checks exactly four things, and every
 * one of them is true of what this module builds.
 *
 *   1. `clientDataJSON[typeIndex .. +21]` == `"type":"webauthn.get"`
 *   2. `clientDataJSON[challengeIndex ..]` == `"challenge":"` + Base64url(challenge) + `"`
 *   3. `authenticatorData[32] & 0x01` (UP), and `& 0x04` (UV) when `requireUV`
 *   4. P-256 over `sha256(authenticatorData ‖ sha256(clientDataJSON))`, with `s <= n/2`
 *
 * It deliberately does NOT check `rpIdHash`, the origin, the sign counter or attestation — the
 * library documents each omission. So the only thing the gate must get right is the digest.
 */
export interface WebAuthnAuth {
  authenticatorData: Hex;
  clientDataJSON: string;
  challengeIndex: bigint;
  typeIndex: bigint;
  r: bigint;
  s: bigint;
}

/** What a secure element offers: the raw 32-byte digest in, `r` and `s` out. */
export type DigestSigner = (digest: Hex) => Promise<{ r: Hex; s: Hex }>;

/**
 * `CoinbaseSmartWallet.SignatureWrapper` (contracts/lib/smart-wallet/src/CoinbaseSmartWallet.sol
 * line 25). `_validateSignature` decodes the UserOp signature into this, reads
 * `ownerAtIndex(ownerIndex)`, and — for a 64-byte owner — decodes `signatureData` as a
 * `WebAuthnAuth`. viem builds the identical bytes for the attendee's real passkey through its
 * own `wrapSignature`, which it marks `@internal` and does not export; `gateSigner.test.ts`
 * pins byte-equality against it so the two encodings cannot drift apart.
 */
const SIGNATURE_WRAPPER = [
  {
    type: 'tuple',
    components: [
      { name: 'ownerIndex', type: 'uint256' },
      { name: 'signatureData', type: 'bytes' },
    ],
  },
] as const;

const WEBAUTHN_AUTH = [
  {
    type: 'tuple',
    components: [
      { name: 'authenticatorData', type: 'bytes' },
      { name: 'clientDataJSON', type: 'string' },
      { name: 'challengeIndex', type: 'uint256' },
      { name: 'typeIndex', type: 'uint256' },
      { name: 'r', type: 'uint256' },
      { name: 's', type: 'uint256' },
    ],
  },
] as const;

/**
 * `WebAuthn.verify` returns false on `s > n/2` before it verifies anything, and `(r, n - s)` is
 * the same signature for the same key — so flipping is lossless and skipping it would bounce
 * roughly half of all UserOps. `signWithGateKey` already normalises, but this function takes an
 * arbitrary signer and must not assume one that does.
 */
function toLowS(s: bigint): bigint {
  return s > p256.CURVE.n / 2n ? p256.CURVE.n - s : s;
}

/**
 * Builds the assertion the gate's smart account will verify over `challenge`.
 *
 * The authenticator data and client data come from `ox`'s own builders — the same library viem
 * uses to produce the attendee's real passkey assertions — rather than from a second spelling
 * here. `flag` defaults to `0x05` (UP | UV) and `signCount` to 0: the gate claims no counter,
 * because it has no counter to claim. `rpId` is the configured one; `webauthn-sol` never reads
 * `rpIdHash`, but a gate that does not name itself in bytes it signs is a gate whose signatures
 * mean nothing outside this contract.
 */
export async function buildWebAuthnAuth(challenge: Hex, sign: DigestSigner): Promise<WebAuthnAuth> {
  const { rpId } = getConfig();
  const { metadata, payload } = WebAuthnP256.getSignPayload({
    challenge,
    origin: `https://${rpId}`,
    rpId,
    userVerification: 'required',
  });

  // `payload` is `authenticatorData ‖ sha256(clientDataJSON)`; step 20 hashes it once more.
  // The chip must sign THIS digest raw — `signWithGateKey` does not hash again.
  const { r, s } = await sign(sha256(payload));

  return {
    authenticatorData: metadata.authenticatorData,
    clientDataJSON: metadata.clientDataJSON,
    challengeIndex: BigInt(metadata.challengeIndex),
    typeIndex: BigInt(metadata.typeIndex),
    r: BigInt(r),
    s: toLowS(BigInt(s)),
  };
}

/** The UserOp `signature` field: `abi.encode(SignatureWrapper(ownerIndex, abi.encode(auth)))`. */
export function encodeWebAuthnSignature(auth: WebAuthnAuth, ownerIndex: bigint): Hex {
  return encodeAbiParameters(SIGNATURE_WRAPPER, [
    { ownerIndex, signatureData: encodeAbiParameters(WEBAUTHN_AUTH, [auth]) },
  ]);
}

/**
 * `CoinbaseSmartWallet.validateUserOp` hands `userOpHash` straight to `_isValidSignature`, which
 * passes `abi.encode(hash)` — the bare 32 bytes — as the WebAuthn challenge. `replaySafeHash` is
 * the ERC-1271 path only and must NOT be applied here. `ownerIndex` 0 is the gate device key:
 * the account is created with that key as its sole owner.
 */
export async function signUserOpWithDeviceKey(userOpHash: Hex): Promise<Hex> {
  return encodeWebAuthnSignature(await buildWebAuthnAuth(userOpHash, signWithGateKey), 0n);
}
