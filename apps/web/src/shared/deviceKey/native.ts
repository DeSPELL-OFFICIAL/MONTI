import { bytesToHex, hexToBytes } from 'viem';
import {
  base64UrlDecode,
  base64UrlEncode,
  derToRs,
  splitRs,
  type Hex,
} from '@monti/shared';
import { toLowS } from './lowS';
import { generateKey, loadKey, sign } from './plugin';
import { spkiToXy } from './spki';
import type { DeviceKeyOptions, DeviceKeyPublic } from './types';

/** Constant throwaway message, never a real digest and never leaves the device. */
const ARM_DIGEST = base64UrlEncode(new Uint8Array(32).fill(0x6d));

export async function ensureDeviceKeyNative(options: DeviceKeyOptions): Promise<DeviceKeyPublic> {
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
