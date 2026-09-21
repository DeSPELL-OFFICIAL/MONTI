import type { ToWebAuthnAccountParameters } from 'viem/account-abstraction';
import type { Hex } from '@monti/shared';

export interface WebAuthnCredential {
  id: string;
  /** Uncompressed P-256 point, 0x04 || x || y. */
  publicKey: Hex;
  transports: string[];
  /** Serialized WebAuthn registration response, forwarded verbatim to registerPasskey. */
  attestationJson: string;
}

/**
 * The assertion function viem hands to ox. Deriving it from viem's own parameter type
 * keeps the web and native paths honest: if either drifts from what ox calls, tsc says so.
 */
export type PasskeyGetFn = NonNullable<ToWebAuthnAccountParameters['getFn']>;
export type PasskeyCredentialRequest = Parameters<PasskeyGetFn>[0];

/** Relying-party display name the authenticator shows on both platforms. */
export const RP_NAME = 'MONTI';

const STORAGE_KEY = 'monti.passkey';

export function storeCredential(credential: WebAuthnCredential): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(credential));
}

export function storedCredential(): WebAuthnCredential | null {
  const raw = localStorage.getItem(STORAGE_KEY);
  return raw ? (JSON.parse(raw) as WebAuthnCredential) : null;
}

export function clearCredential(): void {
  localStorage.removeItem(STORAGE_KEY);
}
