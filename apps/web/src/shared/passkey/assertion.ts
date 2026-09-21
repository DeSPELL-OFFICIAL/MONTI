import { bytesToHex } from 'viem';
import { base64UrlDecode, base64UrlEncode, type Hex } from '@monti/shared';

/**
 * What `loginVerify` expects in `assertion`: WebAuthn's `AuthenticationResponseJSON`, every
 * binary field base64url. The browser hands back `ArrayBuffer`s instead, so the conversion
 * lives here rather than in a screen — `login.ts` rejects anything else as `BAD_ASSERTION`.
 */
export interface PasskeyAssertion {
  id: string;
  rawId: string;
  type: 'public-key';
  response: {
    clientDataJSON: string;
    authenticatorData: string;
    signature: string;
    userHandle?: string;
  };
  clientExtensionResults: Record<string, never>;
}

function toBytes(value: unknown): Uint8Array {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new Error('Passkey assertion is missing binary data');
}

/**
 * The server's challenge is base64url over the same 32 bytes the authenticator will echo in
 * `clientDataJSON`. viem takes it as a hash, so it travels as hex here and comes back out of
 * the authenticator as the original base64url string — which is the document id the server
 * consumes. Any other encoding lands on `CHALLENGE_NOT_FOUND`.
 */
export function challengeToHash(challenge: string): Hex {
  return bytesToHex(base64UrlDecode(challenge));
}

/** The raw credential from `navigator.credentials.get` (or the native shim) → wire JSON. */
export function toAssertionJson(raw: unknown): PasskeyAssertion {
  const credential = raw as { id?: unknown; rawId?: unknown; response?: Record<string, unknown> };
  const response = credential.response;
  if (typeof credential.id !== 'string' || !response) throw new Error('Passkey assertion is not a credential');
  const userHandle = response['userHandle'];
  return {
    id: credential.id,
    rawId: base64UrlEncode(toBytes(credential.rawId)),
    type: 'public-key',
    response: {
      clientDataJSON: base64UrlEncode(toBytes(response['clientDataJSON'])),
      authenticatorData: base64UrlEncode(toBytes(response['authenticatorData'])),
      // WebAuthn's ES256 signature is DER, and that is exactly what the server verifies.
      signature: base64UrlEncode(toBytes(response['signature'])),
      ...(userHandle === undefined || userHandle === null
        ? {}
        : { userHandle: base64UrlEncode(toBytes(userHandle)) }),
    },
    // No extensions are requested, and the server reads none.
    clientExtensionResults: {},
  };
}
