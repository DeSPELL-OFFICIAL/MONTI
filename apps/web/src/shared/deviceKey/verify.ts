import { base64UrlEncode, type Hex } from '@monti/shared';
import { hexToBytes } from 'viem';
import type { DeviceKeyPublic } from './types';

/**
 * Does `signature` (r‖s, 64 bytes) verify as a P-256 signature over `message` for the public key
 * `point`? WebCrypto's ECDSA hashes the message it is given, so `message` is the **preimage**
 * whose SHA-256 is the digest that was actually signed — the same bytes the software signer is
 * handed (`signWithDeviceKeyWeb`), and the same shape `enter/buildResponse` verifies a gate
 * answer against before it leaves the phone.
 *
 * Any failure — a malformed point, a store with no `crypto.subtle`, a signature that simply does
 * not verify — is `false`, never a throw: the callers are health and parity checks that turn a
 * "no" into a screen, not an exception.
 */
export async function verifyDeviceSignature(
  point: DeviceKeyPublic,
  signature: Hex,
  message: Hex,
): Promise<boolean> {
  const bytes = (hex: Hex): Uint8Array<ArrayBuffer> => Uint8Array.from(hexToBytes(hex));
  try {
    const key = await crypto.subtle.importKey(
      'jwk',
      { kty: 'EC', crv: 'P-256', x: base64UrlEncode(bytes(point.x)), y: base64UrlEncode(bytes(point.y)), ext: true },
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, bytes(signature), bytes(message));
  } catch {
    return false;
  }
}
