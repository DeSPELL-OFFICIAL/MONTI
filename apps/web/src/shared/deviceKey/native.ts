import { bytesToHex, hexToBytes } from 'viem';
import { base64UrlDecode, base64UrlEncode, derToRs, splitRs, type Hex } from '@monti/shared';
import { PLUGIN_SUPPORTS_ACCESS_CONTROL, generateKey, loadKey, sign } from './plugin';
import { spkiToXy } from './spki';
import { DeviceKeyPolicyUnsupported, type DeviceKeyOptions, type DeviceKeyPublic } from './types';

/** Constant throwaway message, never a real digest and never leaves the device. */
const ARM_DIGEST = base64UrlEncode(new Uint8Array(32).fill(0x6d));

export async function ensureDeviceKeyNative(options: DeviceKeyOptions): Promise<DeviceKeyPublic> {
  // Never create a key that claims biometric protection the backend cannot enforce.
  if (options.requireAuth && !PLUGIN_SUPPORTS_ACCESS_CONTROL) {
    throw new DeviceKeyPolicyUnsupported(options.alias);
  }
  let spki: string;
  try {
    spki = (await loadKey({ alias: options.alias })).publicKey;
  } catch {
    spki = (await generateKey(options)).publicKey;
  }
  return spkiToXy(base64UrlDecode(spki));
}

/** Triggers Face ID / fingerprint once; the chip keeps the key usable for 60 s. */
export async function armDeviceKeyNative(options: { alias: string }): Promise<void> {
  await sign({ alias: options.alias, data: ARM_DIGEST });
}

/** Signs the 32-byte digest as-is. The plugin must not hash it again. */
export async function signWithDeviceKeyNative(digest: Hex, options: { alias: string }): Promise<{ r: Hex; s: Hex }> {
  const { signature } = await sign({ alias: options.alias, data: base64UrlEncode(hexToBytes(digest)) });
  // derToRs pads each DER INTEGER back to 32 bytes, so r || s is always exactly 64 bytes —
  // what the P-256 precompile expects. No low-s normalisation: the gate code is verified,
  // not malleability-checked, and rewriting s would break a signature the chip produced.
  return splitRs(derToRs(bytesToHex(base64UrlDecode(signature))));
}
