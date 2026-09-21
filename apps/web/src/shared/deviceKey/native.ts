import { bytesToHex, hexToBytes } from 'viem';
import { base64UrlDecode, base64UrlEncode, derToRs, splitRs, type Hex } from '@monti/shared';
import { PLUGIN_SIGNS_DIGEST_RAW, PLUGIN_SUPPORTS_ACCESS_CONTROL, generateKey, loadKey, sign } from './plugin';
import { spkiToXy } from './spki';
import { DeviceKeyPolicyUnsupported, type DeviceKeyOptions, type DeviceKeyPublic } from './types';

/** Constant throwaway message, never a real digest and never leaves the device. */
const ARM_DIGEST = base64UrlEncode(new Uint8Array(32).fill(0x6d));

/** Order of the P-256 group (SEC 2, secp256r1 `n`). */
const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const P256_HALF_N = P256_N / 2n;

/**
 * Ticket.checkIn verifies through Solady's `P256.verifySignature`, which includes the
 * malleability check and rejects anything with `s > n/2`. A secure element's `s` is
 * uniform, so half of all real signatures land in the high half. `(r, n - s)` verifies for
 * the same message and key — that is exactly what ECDSA malleability means — so flipping
 * `s` into the low half is lossless, and skipping it would revert ~50% of check-ins.
 */
function toLowS(s: Hex): Hex {
  const value = BigInt(s);
  if (value <= P256_HALF_N) return s;
  return `0x${(P256_N - value).toString(16).padStart(64, '0')}`;
}

export async function ensureDeviceKeyNative(options: DeviceKeyOptions): Promise<DeviceKeyPublic> {
  // Never register a key on chain that this backend could never sign with.
  if (!PLUGIN_SIGNS_DIGEST_RAW) {
    throw new DeviceKeyPolicyUnsupported(options.alias, 'backend re-hashes the digest instead of signing it');
  }
  // Never create a key that claims biometric protection the backend cannot enforce.
  if (options.requireAuth && !PLUGIN_SUPPORTS_ACCESS_CONTROL) {
    throw new DeviceKeyPolicyUnsupported(options.alias, 'backend cannot enforce biometric access control');
  }
  // `null` is the only result that may mint a key. A cancelled prompt or a locked keychain
  // rejects instead, and rotating a key already registered on chain is unrecoverable.
  const key = (await loadKey({ alias: options.alias })) ?? (await generateKey(options));
  const point = spkiToXy(base64UrlDecode(key.publicKey));
  return key.backing ? { ...point, backing: key.backing } : point;
}

/** Triggers Face ID / fingerprint once; the chip keeps the key usable for 60 s. */
export async function armDeviceKeyNative(options: { alias: string }): Promise<void> {
  await sign({ alias: options.alias, data: ARM_DIGEST });
}

/** Signs the 32-byte digest as-is. The plugin must not hash it again. */
export async function signWithDeviceKeyNative(digest: Hex, options: { alias: string }): Promise<{ r: Hex; s: Hex }> {
  const { signature } = await sign({ alias: options.alias, data: base64UrlEncode(hexToBytes(digest)) });
  // derToRs pads each DER INTEGER back to 32 bytes, so r || s is always exactly 64 bytes —
  // what the P-256 precompile expects.
  const { r, s } = splitRs(derToRs(bytesToHex(base64UrlDecode(signature))));
  return { r, s: toLowS(s) };
}
