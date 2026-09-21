import { Capacitor } from '@capacitor/core';
import { toWebAuthnAccount, type WebAuthnAccount } from 'viem/account-abstraction';
import { getConfig } from '../config';
import { challengeToHash, toAssertionJson, type PasskeyAssertion } from './assertion';
import { createPasskeyNative, getFnNative } from './native';
import { storedCredential, type WebAuthnCredential } from './types';
import { createPasskeyWeb } from './web';

export * from './types';
export * from './errors';
export { parseAttestationPublicKey } from './cose';
export { challengeToHash, toAssertionJson, type PasskeyAssertion } from './assertion';

/**
 * `challenge` is the base64url string `loginChallenge({ purpose: 'register' })` minted. The
 * server looks the attestation's own challenge up as a document id and refuses one it did not
 * issue, so a locally generated challenge cannot register a passkey at all.
 */
export async function createPasskey(name: string, challenge: string): Promise<WebAuthnCredential> {
  return Capacitor.isNativePlatform()
    ? createPasskeyNative(name, challenge)
    : createPasskeyWeb(name, challenge);
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

/**
 * One assertion over the server's login challenge, in the shape `loginVerify` reads. The
 * signature viem assembles for a user operation is a different encoding and is not used here:
 * the server verifies raw WebAuthn, not an on-chain signature.
 */
export async function signPasskeyAssertion(challenge: string): Promise<PasskeyAssertion> {
  const account = await getPasskeyAccount();
  const { raw } = await account.sign({ hash: challengeToHash(challenge) });
  return toAssertionJson(raw);
}
