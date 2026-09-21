import * as PublicKey from 'ox/PublicKey';
import * as WebAuthnP256 from 'ox/WebAuthnP256';
import { base64UrlDecode } from '@monti/shared';
import { getConfig } from '../config';
import { RP_NAME, storeCredential, type WebAuthnCredential } from './types';

export async function createPasskeyWeb(name: string, challenge: string): Promise<WebAuthnCredential> {
  const created = await WebAuthnP256.createCredential({
    name,
    // ox invents its own challenge when none is given, and the server would never find it.
    challenge: base64UrlDecode(challenge),
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
