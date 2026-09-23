import { describe, expect, it } from 'vitest';
import { spkiToXy } from './spki';

const hex = (h: string) => Uint8Array.from(h.match(/.{1,2}/g)!.map((b) => Number.parseInt(b, 16)));
const P256_PREFIX = '3059301306072a8648ce3d020106082a8648ce3d030107034200';

describe('spkiToXy', () => {
  it('splits a P-256 SubjectPublicKeyInfo into its x and y coordinates', () => {
    const spki = hex(`${P256_PREFIX}04${'11'.repeat(32)}${'22'.repeat(32)}`);
    expect(spkiToXy(spki)).toEqual({ x: `0x${'11'.repeat(32)}`, y: `0x${'22'.repeat(32)}` });
  });

  it('rejects a key that is not 91 bytes', () => {
    const spki = hex(`${P256_PREFIX}04${'11'.repeat(32)}${'22'.repeat(31)}`);
    expect(() => spkiToXy(spki)).toThrow('P-256 SubjectPublicKeyInfo');
  });

  it('rejects a full-length key whose curve OID is not prime256v1', () => {
    // Same 91 bytes, last OID byte 07 -> 0a, so only the prefix comparison can catch it.
    const spki = hex(`3059301306072a8648ce3d020106082a8648ce3d03010a03420004${'11'.repeat(32)}${'22'.repeat(32)}`);
    expect(() => spkiToXy(spki)).toThrow('P-256 SubjectPublicKeyInfo');
  });

  it('rejects a compressed point', () => {
    const spki = hex(`${P256_PREFIX}03${'11'.repeat(32)}${'22'.repeat(32)}`);
    expect(() => spkiToXy(spki)).toThrow('uncompressed');
  });
});
