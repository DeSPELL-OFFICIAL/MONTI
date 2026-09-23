import type { DeviceKeyPublic } from './types';

/**
 * A P-256 public key in SubjectPublicKeyInfo (RFC 5280) form is fully fixed except for the
 * point itself, so the whole header is one constant:
 *   SEQUENCE(0x3059) SEQUENCE(0x3013) OID id-ecPublicKey(1.2.840.10045.2.1)
 *   OID prime256v1(1.2.840.10045.3.1.7) BIT STRING(0x0342 00)
 * followed by 0x04 || x(32) || y(32). A secp256k1 or compressed key differs inside this
 * prefix, so comparing it byte for byte is the whole validation.
 */
const P256_SPKI_PREFIX = Uint8Array.from([
  0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce,
  0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00,
]);
const UNCOMPRESSED_POINT = 0x04;
const COORDINATE_BYTES = 32;
const SPKI_BYTES = P256_SPKI_PREFIX.length + 1 + COORDINATE_BYTES * 2;

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

/**
 * Secure-element public key (SPKI, the shape both iOS and Android export) → the x and y the
 * Ticket contract stores. Anything that is not exactly a P-256 uncompressed point is refused
 * loudly: a key registered on chain with the wrong coordinates can never be corrected.
 */
export function spkiToXy(spki: Uint8Array): DeviceKeyPublic {
  if (spki.length !== SPKI_BYTES) {
    throw new Error(`Device public key is not a ${SPKI_BYTES}-byte P-256 SubjectPublicKeyInfo`);
  }
  for (let i = 0; i < P256_SPKI_PREFIX.length; i += 1) {
    if (spki[i] !== P256_SPKI_PREFIX[i]) throw new Error('Device public key is not a P-256 SubjectPublicKeyInfo');
  }
  const point = spki.subarray(P256_SPKI_PREFIX.length);
  if (point[0] !== UNCOMPRESSED_POINT) throw new Error('Device public key is not an uncompressed P-256 point');
  return {
    x: `0x${toHex(point.subarray(1, 1 + COORDINATE_BYTES))}`,
    y: `0x${toHex(point.subarray(1 + COORDINATE_BYTES))}`,
  };
}
