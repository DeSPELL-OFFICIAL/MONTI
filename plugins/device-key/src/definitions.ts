/**
 * MONTI's own hardware key plugin. It exists because `@perfood/capacitor-crypto-api@8.0.0`
 * re-hashes the message it is given, hard-codes a 5-second auth window and has no StrongBox
 * switch — three things MONTI cannot express through it (Task 13 read this off its native
 * sources, not its README). Every method below is defined by what the on-chain path needs:
 * a P-256 key that never leaves secure hardware, a single biometric that arms it for 60
 * seconds, and a signature over the exact 32-byte digest `Ticket.checkIn` verifies.
 */

/** Which secure hardware the private key actually landed in. Never inferred, always reported. */
export type DeviceKeyBacking = 'secureEnclave' | 'strongBox' | 'tee';

/** Every rejection from this plugin carries one of these as its Capacitor error code. */
export const DEVICE_KEY_ERROR = {
  /** A required option was missing, or `data` was not a 32-byte digest. */
  invalidArgument: 'INVALID_ARGUMENT',
  /** No key under this tag. The ONLY rejection that may lead to minting a new one. */
  keyNotFound: 'KEY_NOT_FOUND',
  /** The holder dismissed the biometric prompt. Distinct from a failed one. */
  userCancelled: 'USER_CANCELLED',
  /** Biometrics changed since the key was created, so the chip destroyed it. */
  keyInvalidated: 'KEY_INVALIDATED',
  /**
   * The secure element cannot serve this request: the web, a device with no usable enclave,
   * or an existing key whose public half it refused to hand back. Never `keyNotFound`, which
   * would tell the caller it is safe to mint a replacement.
   */
  unavailable: 'UNAVAILABLE',
  keyGenerationFailed: 'KEY_GENERATION_FAILED',
  signFailed: 'SIGN_FAILED',
} as const;

export type DeviceKeyErrorCode = (typeof DEVICE_KEY_ERROR)[keyof typeof DEVICE_KEY_ERROR];

export interface GenerateKeyOptions {
  /** Keychain application tag (iOS) / Keystore alias (Android). */
  tag: string;
  /**
   * `true` mints a biometric-gated key: iOS adds `.biometryCurrentSet`, Android sets
   * `setUserAuthenticationParameters(60, AUTH_BIOMETRIC_STRONG)`. `false` mints an
   * unattended key — the gate terminal signs without a holder present and must never prompt.
   */
  accessControl: boolean;
  /**
   * Android only: try StrongBox first. When the device has no StrongBox the key is created
   * in the TEE instead and the result says `tee` — the one downgrade this plugin allows,
   * and it is reported rather than silent. iOS ignores it; there is only the Secure Enclave.
   */
  strongBox: boolean;
}

export interface LoadKeyOptions {
  tag: string;
}

export interface SignOptions {
  tag: string;
  /** The 32-byte digest, base64url, unpadded. Signed as-is — never hashed again. */
  data: string;
}

export interface DeviceKeyResult {
  /** P-256 SubjectPublicKeyInfo (RFC 5280), base64url, unpadded, no line breaks. */
  publicKey: string;
  backing: DeviceKeyBacking;
}

export interface SignResult {
  /** ECDSA signature in DER, base64url, unpadded, no line breaks. */
  signature: string;
}

export interface DeviceKeyPlugin {
  /** Creates a hardware P-256 key under `tag`. Rejects rather than downgrade the policy. */
  generateKey(options: GenerateKeyOptions): Promise<DeviceKeyResult>;
  /** Rejects with `KEY_NOT_FOUND` when the tag holds no key. Raises no biometric prompt. */
  loadKey(options: LoadKeyOptions): Promise<DeviceKeyResult>;
  /** Signs the given digest RAW. The first call inside 60 s is the one that prompts. */
  sign(options: SignOptions): Promise<SignResult>;
}
