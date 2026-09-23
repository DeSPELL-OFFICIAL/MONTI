import { decode as decodeCbor } from 'cbor-x';
import * as Base64 from 'ox/Base64';
import type { Hex } from '@monti/shared';

/** authData flag bit 6 — attested credential data is present. */
const FLAG_ATTESTED_CREDENTIAL_DATA = 0x40;
/** authData = rpIdHash(32) | flags(1) | signCount(4) | aaguid(16) | credIdLen(2) | credId | COSE key */
const FLAGS_OFFSET = 32;
const CREDENTIAL_ID_LENGTH_OFFSET = 53;
const CREDENTIAL_ID_OFFSET = 55;

/** RFC 8152 COSE_Key labels and the only values a Coinbase Smart Wallet owner may have. */
const COSE_LABEL_KTY = 1;
const COSE_LABEL_ALG = 3;
const COSE_LABEL_CRV = -1;
const COSE_LABEL_X = -2;
const COSE_LABEL_Y = -3;
const COSE_KTY_EC2 = 2;
const COSE_ALG_ES256 = -7;
const COSE_CRV_P256 = 1;
const COORDINATE_BYTES = 32;

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

/** cbor-x returns a Map for the integer-keyed COSE_Key and a plain object for string keys. */
function coseLabel(cose: unknown, label: number): unknown {
  if (cose instanceof Map) return cose.get(label);
  if (typeof cose === 'object' && cose !== null) return (cose as Record<string, unknown>)[String(label)];
  return undefined;
}

function coordinate(value: unknown): Uint8Array | null {
  return value instanceof Uint8Array && value.length === COORDINATE_BYTES ? value : null;
}

/**
 * WebAuthn attestationObject (base64url, padded or not) → uncompressed P-256 public key.
 * The native path parses this itself because the platform hands back raw WebAuthn JSON,
 * while the web path gets the point from ox.
 */
export function parseAttestationPublicKey(attestationObjectB64Url: string): Hex {
  const attestation: unknown = decodeCbor(Base64.toBytes(attestationObjectB64Url));
  const authData =
    typeof attestation === 'object' && attestation !== null
      ? (attestation as { authData?: unknown }).authData
      : undefined;
  if (!(authData instanceof Uint8Array)) throw new Error('Attestation has no authenticator data');

  const flags = authData[FLAGS_OFFSET];
  const lengthHigh = authData[CREDENTIAL_ID_LENGTH_OFFSET];
  const lengthLow = authData[CREDENTIAL_ID_LENGTH_OFFSET + 1];
  if (
    flags === undefined ||
    (flags & FLAG_ATTESTED_CREDENTIAL_DATA) === 0 ||
    lengthHigh === undefined ||
    lengthLow === undefined
  ) {
    throw new Error('Attestation has no attested credential data');
  }

  const coseStart = CREDENTIAL_ID_OFFSET + ((lengthHigh << 8) | lengthLow);
  if (coseStart >= authData.length) throw new Error('Attestation has no attested credential data');

  const cose: unknown = decodeCbor(authData.slice(coseStart));
  const x = coordinate(coseLabel(cose, COSE_LABEL_X));
  const y = coordinate(coseLabel(cose, COSE_LABEL_Y));
  if (
    coseLabel(cose, COSE_LABEL_KTY) !== COSE_KTY_EC2 ||
    coseLabel(cose, COSE_LABEL_ALG) !== COSE_ALG_ES256 ||
    coseLabel(cose, COSE_LABEL_CRV) !== COSE_CRV_P256 ||
    !x ||
    !y
  ) {
    throw new Error('Attestation is not an ES256 key');
  }
  return `0x04${toHex(x)}${toHex(y)}`;
}
