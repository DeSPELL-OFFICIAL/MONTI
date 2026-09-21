import { describe, expect, it } from 'vitest';
import { fromBase64, toBase64 } from './base64';
import { HCE_ERROR } from './definitions';

/** The AID bytes themselves, so the fixture is a payload this plugin really carries. */
const AID_BYTES = new Uint8Array([0xd2, 0x76, 0x00, 0x00, 0x85, 0x01, 0x01]);
const AID_BASE64 = '0nYAAIUBAQ==';

describe('bridge base64', () => {
  it('spells bytes the way Android Base64.NO_WRAP does: standard alphabet, padded', () => {
    expect(toBase64(AID_BYTES)).toBe(AID_BASE64);
  });

  it('uses +/ rather than the base64url -_ the QR fallback uses', () => {
    expect(toBase64(new Uint8Array([0xff, 0xef, 0xbe]))).toBe('/+++');
  });

  it('round-trips every byte value, including the 0x00 an NDEF length prefix starts with', () => {
    const all = new Uint8Array(256);
    for (let i = 0; i < 256; i += 1) all[i] = i;
    expect(fromBase64(toBase64(all))).toEqual(all);
  });

  it('accepts the empty message', () => {
    expect(toBase64(new Uint8Array(0))).toBe('');
    expect(fromBase64('')).toEqual(new Uint8Array(0));
  });

  it('rejects a trailing line break, which is what MIME base64 would hand us', () => {
    expect(() => fromBase64(`${AID_BASE64}\n`)).toThrow(HCE_ERROR.invalidArgument);
  });

  it('rejects an embedded line break', () => {
    expect(() => fromBase64('0nYAAIUB\nAQ==')).toThrow(HCE_ERROR.invalidArgument);
  });

  it('rejects the same bytes unpadded', () => {
    expect(() => fromBase64('0nYAAIUBAQ')).toThrow(HCE_ERROR.invalidArgument);
  });

  it('rejects base64url, so the QR wire can never be mistaken for the NFC one', () => {
    expect(() => fromBase64('_-YAAIUBAQ==')).toThrow(HCE_ERROR.invalidArgument);
  });

  it('carries the code as well as the message', () => {
    expect(() => fromBase64('!')).toThrow(
      expect.objectContaining({ code: HCE_ERROR.invalidArgument }),
    );
  });
});
