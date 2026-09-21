import * as Base64 from 'ox/Base64';
import { getConfig } from '../config';
import { parseAttestationPublicKey } from './cose';
import { createCredentialNative, getCredentialNative } from './plugin';
import {
  RP_NAME,
  storeCredential,
  type PasskeyCredentialRequest,
  type PasskeyGetFn,
  type WebAuthnCredential,
} from './types';

function toBase64Url(bytes: Uint8Array): string {
  return Base64.fromBytes(bytes, { url: true, pad: false });
}

/** ox hands us its own BufferSource (ArrayBufferView over any ArrayBufferLike), not the DOM one. */
function toBytes(source: ArrayBufferView | ArrayBuffer): Uint8Array {
  return source instanceof ArrayBuffer
    ? new Uint8Array(source)
    : new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
}

/** Decoded base64url as a standalone ArrayBuffer — the shape `navigator.credentials.get` returns. */
function toArrayBuffer(base64Url: string): ArrayBuffer {
  const bytes = Base64.toBytes(base64Url);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function randomBase64Url(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function createPasskeyNative(name: string, challenge: string): Promise<WebAuthnCredential> {
  const registration = await createCredentialNative({
    rp: { id: getConfig().rpId, name: RP_NAME },
    // The user handle is ours to pick and carries no personal data; the challenge is not —
    // it has to be the one the server minted, which is already base64url.
    user: { id: randomBase64Url(), name, displayName: name },
    challenge,
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
  });
  const credential: WebAuthnCredential = {
    id: registration.id,
    publicKey: parseAttestationPublicKey(registration.response.attestationObject),
    transports: registration.response.transports ?? ['internal'],
    attestationJson: JSON.stringify(registration),
  };
  storeCredential(credential);
  return credential;
}

/** Native assertion shaped exactly like `navigator.credentials.get` so ox/viem cannot tell them apart. */
export const getFnNative: PasskeyGetFn = async (options?: PasskeyCredentialRequest) => {
  const request = options?.publicKey;
  if (!request) throw new Error('Passkey assertion needs a publicKey request');
  const assertion = await getCredentialNative({
    challenge: toBase64Url(toBytes(request.challenge)),
    rpId: request.rpId ?? getConfig().rpId,
    userVerification: request.userVerification ?? 'required',
    allowCredentials: (request.allowCredentials ?? []).map((entry) => ({
      id: toBase64Url(toBytes(entry.id)),
      type: 'public-key',
    })),
  });
  const { response } = assertion;
  const credential = {
    id: assertion.id,
    rawId: toArrayBuffer(assertion.rawId),
    type: assertion.type,
    authenticatorAttachment: assertion.authenticatorAttachment ?? null,
    response: {
      clientDataJSON: toArrayBuffer(response.clientDataJSON),
      authenticatorData: toArrayBuffer(response.authenticatorData),
      signature: toArrayBuffer(response.signature),
      userHandle: response.userHandle ? toArrayBuffer(response.userHandle) : null,
    },
    getClientExtensionResults: () => assertion.clientExtensionResults,
  };
  return credential;
};
