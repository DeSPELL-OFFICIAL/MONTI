// ONLY file that touches a native crypto plugin. Backend switch lives here.
//
// The backend is @monti/device-key (plugins/device-key), MONTI's own plugin. Task 13 tried
// @perfood/capacitor-crypto-api@8.0.0 and read three disqualifying defects off its native
// sources: it signs SHA-256(utf8(data)) instead of the digest it is given, it hard-codes a
// 5-second Android auth window where MONTI needs 60, and it has no StrongBox switch or
// reportable backing. Each was silent at runtime, and a key registered on chain that can
// never produce a verifiable signature is unrecoverable — so the vendor is gone entirely.
//
// @monti/device-key surface:
//   DeviceKey.generateKey({ tag, accessControl, strongBox }) -> { publicKey, backing }
//   DeviceKey.loadKey({ tag })                               -> { publicKey, backing }
//   DeviceKey.sign({ tag, data })                            -> { signature }
// `publicKey` is a base64url P-256 SubjectPublicKeyInfo, `data` the base64url 32-byte digest
// signed as-is, `signature` a base64url DER signature. Failures reject with a typed code.
import { DEVICE_KEY_ERROR, DeviceKey, type DeviceKeyErrorCode } from '@monti/device-key';
import type { DeviceKeyBacking } from './types';

/**
 * The plugin's own error codes, re-exported here rather than imported from `@monti/device-key`
 * elsewhere: this file is the only one in the app allowed to name the native plugin, and a
 * caller that has to tell a lapsed arm window from a destroyed key needs those codes.
 */
export { DEVICE_KEY_ERROR, type DeviceKeyErrorCode };

const CODES = new Set<string>(Object.values(DEVICE_KEY_ERROR));

/** The plugin's typed code, or `undefined` for a rejection that did not come from it. */
export function deviceKeyErrorCode(error: unknown): DeviceKeyErrorCode | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && CODES.has(code) ? (code as DeviceKeyErrorCode) : undefined;
}

export interface KeyOptions {
  alias: string;
  requireAuth: boolean;
  strongBox: boolean;
}

/**
 * `backing` is which secure hardware the key actually landed in. Android may create the key in
 * the TEE when the device has no StrongBox — the one downgrade the plugin allows — and saying
 * so is the whole point of the field: `strongBox: true` is only meaningful if the answer comes
 * back. The plugin's own union is assigned to this one, so a divergence is a compile error.
 */
export interface PluginKey {
  publicKey: string;
  backing?: DeviceKeyBacking;
}

/**
 * The bridge is untyped at runtime, so a malformed native response is narrowed here rather
 * than trusted. `backing` travels with the key; dropping it would hide a TEE downgrade.
 */
function requirePublicKey(response: { publicKey?: string; backing?: DeviceKeyBacking }): PluginKey {
  if (!response.publicKey) throw new Error('Secure element returned no public key');
  return { publicKey: response.publicKey, backing: response.backing };
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code;
}

export async function generateKey(options: KeyOptions): Promise<PluginKey> {
  return requirePublicKey(
    await DeviceKey.generateKey({
      tag: options.alias,
      accessControl: options.requireAuth,
      strongBox: options.strongBox,
    }),
  );
}

/**
 * `null` is the typed "no key under this alias yet" result, and the ONLY result that may lead
 * to minting a new key. The plugin signals it by rejecting with `KEY_NOT_FOUND`; everything
 * else — a cancelled biometric prompt, a locked keystore, a dead bridge — propagates untouched.
 * Rotating a key that is already registered on chain cannot be undone.
 */
export async function loadKey(options: { alias: string }): Promise<PluginKey | null> {
  try {
    return requirePublicKey(await DeviceKey.loadKey({ tag: options.alias }));
  } catch (error) {
    if (hasCode(error, DEVICE_KEY_ERROR.keyNotFound)) return null;
    throw error;
  }
}

export async function sign(options: { alias: string; data: string }): Promise<{ signature: string }> {
  const { signature } = await DeviceKey.sign({ tag: options.alias, data: options.data });
  if (!signature) throw new Error('Secure element returned no signature');
  return { signature };
}
