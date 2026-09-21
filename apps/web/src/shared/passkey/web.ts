import * as PublicKey from 'ox/PublicKey';
import * as WebAuthnP256 from 'ox/WebAuthnP256';
import { getConfig } from '../config';
import { RP_NAME, storeCredential, type WebAuthnCredential } from './types';

export async function createPasskeyWeb(name: string): Promise<WebAuthnCredential> {
  const created = await WebAuthnP256.createCredential({
    name,
    rp: { id: getConfig().rpId, name: RP_NAME },
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
  });
  const credential: WebAuthnCredential = {
    id: created.id,
    publicKey: PublicKey.toHex(created.publicKey),
    transports: ['internal', 'hybrid'],
    // PublicKeyCredential.toJSON() (WebAuthn L3) is what JSON.stringify picks up here.
    attestationJson: JSON.stringify(created.raw),
  };
  storeCredential(credential);
  return credential;
}
