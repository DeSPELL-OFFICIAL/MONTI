import { describe, expect, it } from 'vitest';
import { Encoder } from 'cbor-x';
import { challengeFromClientData, coseToP256, ownerBytes } from '../src/lib/webauthn.js';

const encoder = new Encoder({ useRecords: false, mapsAsObjects: false, tagUint8Array: false });
const X = Buffer.alloc(32, 0x11);
const Y = Buffer.alloc(32, 0x22);

function coseKey(map: Array<[number, unknown]>): Uint8Array {
  return new Uint8Array(encoder.encode(new Map(map)));
}

describe('coseToP256', () => {
  it('extracts x and y from a P-256 COSE key', () => {
    const cose = coseKey([[1, 2], [3, -7], [-1, 1], [-2, X], [-3, Y]]);
    expect(coseToP256(cose)).toEqual({
      x: `0x${'11'.repeat(32)}`,
      y: `0x${'22'.repeat(32)}`,
    });
  });

  it('rejects a non-P-256 key and a truncated coordinate', () => {
    expect(() => coseToP256(coseKey([[1, 1], [3, -8], [-1, 6], [-2, X], [-3, Y]]))).toThrow('COSE_NOT_P256');
    expect(() => coseToP256(coseKey([[1, 2], [3, -7], [-1, 1], [-2, Buffer.alloc(31)], [-3, Y]]))).toThrow('COSE_BAD_COORDINATE');
  });
});

describe('ownerBytes', () => {
  it('concatenates x and y into 64 bytes for factory.getAddress', () => {
    expect(ownerBytes(`0x${'11'.repeat(32)}`, `0x${'22'.repeat(32)}`)).toBe(`0x${'11'.repeat(32)}${'22'.repeat(32)}`);
  });
});

describe('challengeFromClientData', () => {
  it('reads the challenge out of clientDataJSON', () => {
    const clientData = Buffer.from(
      JSON.stringify({ type: 'webauthn.create', challenge: 'abc-123_XY', origin: 'https://monti.app' }),
      'utf8',
    ).toString('base64url');
    expect(challengeFromClientData(clientData)).toBe('abc-123_XY');
  });

  it('rejects clientDataJSON without a challenge', () => {
    const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.create' }), 'utf8').toString('base64url');
    expect(() => challengeFromClientData(clientData)).toThrow('NO_CHALLENGE');
  });
});
