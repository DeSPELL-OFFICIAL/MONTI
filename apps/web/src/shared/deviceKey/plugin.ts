// ONLY file that touches a native crypto plugin. Backend switch lives here.
//
// @perfood/capacitor-crypto-api@8.0.0 real surface (read from its own typings and native
// sources in node_modules, not from the README):
//   CryptoApi.generateKey({ tag, algorithm: 'ecdsa' | 'ecdh', type? }) -> { publicKey?: string }
//   CryptoApi.loadKey({ tag, algorithm })                              -> { publicKey?: string }
//   CryptoApi.sign({ tag, data, type? })                               -> { signature?: string }
// `type` is a BiometryType ('BIOMETRY' | 'BIOMETRY_OR_PASSCODE' | 'PASSCODE'), and both
// publicKey and signature are OPTIONAL in the response, so every wrapper below narrows.
//
// Three defects make this backend unusable for MONTI, and each one is silent at runtime:
//   1. No auth window. iOS pins `.biometryCurrentSet` with no validity period; Android
//      hard-codes `setUserAuthenticationParameters(5, ...)`. ARM_WINDOW_SECONDS is 60.
//   2. No StrongBox switch. Android always tries StrongBox and silently falls back to TEE;
//      iOS always uses the Secure Enclave. `strongBox` cannot be honoured either way.
//   3. It re-hashes. iOS signs with `.ecdsaSignatureMessageX962SHA256` over
//      `data.data(using: .utf8)` and Android with `SHA256withECDSA` over `data.getBytes()`,
//      so the plugin signs SHA-256(utf8(data)) — never the 32-byte gate digest we hand it.
//      Ticket.checkIn verifies P256 over that digest, so every such signature is invalid.
//      This blocks key CREATION too: a key registered on chain that can never produce a
//      verifiable signature is worse than no key at all.
// Task 14 re-points this file at @monti/device-key; both flags are then deleted, not
// flipped — a constant-true guard is a dead path.
import { CryptoApi } from '@perfood/capacitor-crypto-api';
import type { DeviceKeyBacking } from './types';

/** Flip to true only with a backend that can enforce biometric access control (Task 14). */
export const PLUGIN_SUPPORTS_ACCESS_CONTROL: boolean = false;
/** Flip to true only with a backend that signs the given digest as-is (defect 3 above). */
export const PLUGIN_SIGNS_DIGEST_RAW: boolean = false;

export interface KeyOptions {
  alias: string;
  requireAuth: boolean;
  strongBox: boolean;
}

/**
 * `backing` is how a backend reports which secure hardware it actually landed in — Android
 * downgrades StrongBox to TEE silently, so `strongBox: true` is only enforceable if the
 * backend says where the key went. This vendor cannot report it; Task 14's plugin can.
 */
export interface PluginKey {
  publicKey: string;
  backing?: DeviceKeyBacking;
}

/** The plugin types every response field as optional; a missing key is a backend failure. */
function requirePublicKey(response: { publicKey?: string }): PluginKey {
  if (!response.publicKey) throw new Error('Secure element returned no public key');
  return { publicKey: response.publicKey };
}

export async function generateKey(options: KeyOptions): Promise<PluginKey> {
  return requirePublicKey(
    await CryptoApi.generateKey({
      tag: options.alias,
      algorithm: 'ecdsa',
      // The only access control this backend can express. It is not enough on its own —
      // see defect 1 — which is why PLUGIN_SUPPORTS_ACCESS_CONTROL stays false.
      type: options.requireAuth ? 'BIOMETRY' : undefined,
    }),
  );
}

/**
 * `null` is the typed "no key under this alias yet" result, and the ONLY result that may
 * lead to minting a new key. This vendor signals it by resolving without a `publicKey`
 * (iOS `call.resolve([:])`, Android omits the field, web returns `{}`); everything else —
 * a cancelled biometric prompt, a locked keychain — rejects, and that rejection propagates
 * untouched. Rotating a key that is already registered on chain is unrecoverable.
 */
export async function loadKey(options: { alias: string }): Promise<PluginKey | null> {
  const response = await CryptoApi.loadKey({ tag: options.alias, algorithm: 'ecdsa' });
  return response.publicKey ? { publicKey: response.publicKey } : null;
}

export async function sign(options: { alias: string; data: string }): Promise<{ signature: string }> {
  // Refuse rather than hand the gate a signature over the wrong message (defect 3).
  if (!PLUGIN_SIGNS_DIGEST_RAW) throw new Error('DeviceKeyPolicyUnsupported: backend re-hashes the digest');
  const { signature } = await CryptoApi.sign({ tag: options.alias, data: options.data });
  if (!signature) throw new Error('Secure element returned no signature');
  return { signature };
}
