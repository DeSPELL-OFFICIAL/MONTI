import { Capacitor } from '@capacitor/core';
import { toWebAuthnAccount, type WebAuthnAccount } from 'viem/account-abstraction';
import { getConfig } from '../config';
import { createPasskeyNative, getFnNative } from './native';
import { storedCredential, type WebAuthnCredential } from './types';
import { createPasskeyWeb } from './web';

export * from './types';
export { parseAttestationPublicKey } from './cose';

export async function createPasskey(name: string): Promise<WebAuthnCredential> {
  return Capacitor.isNativePlatform() ? createPasskeyNative(name) : createPasskeyWeb(name);
}

export async function getPasskeyAccount(): Promise<WebAuthnAccount> {
  const credential = storedCredential();
  if (!credential) throw new Error('No passkey on this device');
  return toWebAuthnAccount({
    credential: { id: credential.id, publicKey: credential.publicKey },
    // On the web ox falls back to navigator.credentials.get itself; only native needs a shim.
    getFn: Capacitor.isNativePlatform() ? getFnNative : undefined,
    rpId: getConfig().rpId,
  });
}
