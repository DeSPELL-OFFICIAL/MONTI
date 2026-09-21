import { encode as encodeCbor } from 'cbor-x';
import * as Base64 from 'ox/Base64';
import { describe, expect, it } from 'vitest';
import { parseAttestationPublicKey } from './cose';

function toBase64Url(bytes: Uint8Array): string {
  return Base64.fromBytes(bytes, { url: true, pad: false });
}

function buildAttestation(x: Uint8Array, y: Uint8Array): string {
  const credentialId = new Uint8Array(16).fill(0x7a);
  // COSE_Key for ES256: kty 2, alg -7, crv 1, x -2, y -3
  const cose = encodeCbor(
    new Map<number, unknown>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, x],
      [-3, y],
    ]),
  );
  const authData = new Uint8Array(37 + 16 + 2 + credentialId.length + cose.length);
  authData[32] = 0x45; // flags: UP | UV | AT
  authData.set([0x00, credentialId.length], 53);
  authData.set(credentialId, 55);
  authData.set(cose, 55 + credentialId.length);
  return toBase64Url(encodeCbor({ fmt: 'none', attStmt: {}, authData }));
}

describe('parseAttestationPublicKey', () => {
  it('extracts the uncompressed P-256 point from a WebAuthn attestation object', () => {
    const x = new Uint8Array(32).fill(0x11);
    const y = new Uint8Array(32).fill(0x22);
    expect(parseAttestationPublicKey(buildAttestation(x, y))).toBe(
      `0x04${'11'.repeat(32)}${'22'.repeat(32)}`,
    );
  });

  it('reads a padded base64url attestation the same way as an unpadded one', () => {
    const x = new Uint8Array(32).fill(0x33);
    const y = new Uint8Array(32).fill(0x44);
    const unpadded = buildAttestation(x, y);
    const padded = Base64.fromBytes(Base64.toBytes(unpadded), { url: true });
    expect(parseAttestationPublicKey(padded)).toBe(parseAttestationPublicKey(unpadded));
  });

  it('rejects an attestation without the attested-credential-data flag', () => {
    const broken = toBase64Url(encodeCbor({ fmt: 'none', attStmt: {}, authData: new Uint8Array(37) }));
    expect(() => parseAttestationPublicKey(broken)).toThrow('no attested credential data');
  });

  it('rejects a COSE key that is not ES256 on P-256', () => {
    const cose = encodeCbor(
      new Map<number, unknown>([
        [1, 2],
        [3, -257], // RS256
        [-1, 1],
        [-2, new Uint8Array(32).fill(0x11)],
        [-3, new Uint8Array(32).fill(0x22)],
      ]),
    );
    const authData = new Uint8Array(55 + 16 + cose.length);
    authData[32] = 0x45;
    authData.set([0x00, 16], 53);
    authData.set(cose, 71);
    const attestation = toBase64Url(encodeCbor({ fmt: 'none', attStmt: {}, authData }));
    expect(() => parseAttestationPublicKey(attestation)).toThrow('not an ES256 key');
  });
});
