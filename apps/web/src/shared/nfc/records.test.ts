import { describe, expect, it } from 'vitest';
import type { GateCodeWire, GateResponseWire } from '@monti/shared';
import { encodeGateCode } from '@monti/shared';
import {
  GATE_CODE_RECORD_TYPE,
  GATE_RESPONSE_RECORD_TYPE,
  QR_PREFIX,
  TNF_EXTERNAL,
  decodeGateCode,
  encodeGateResponse,
  gateResponseToQr,
  qrToGateResponse,
  recordTypeBytes,
  recordTypeMatches,
} from './records';

/**
 * The bytes sub-plan 04's HCE service puts in the `monti.app:g` record. Pinned literally
 * rather than round-tripped through the encoder, because the two sides only interoperate if
 * the map header, the key order and the length prefixes are exactly these.
 *
 * `cborText` covers just the four long values: CBOR major type 3 with a one-byte length
 * (0x78) followed by the ASCII of the hex string. Every structural byte stays literal.
 */
function cborText(value: string): string {
  return `78${value.length.toString(16)}${[...value].map((c) => c.charCodeAt(0).toString(16)).join('')}`;
}

const NONCE = `0x${'11'.repeat(32)}` as const;
const KX = `0x${'aa'.repeat(32)}` as const;
const KY = `0x${'bb'.repeat(32)}` as const;
const SIG = `0x${'cc'.repeat(64)}` as const;

const GATE_CODE_VECTOR_HEX =
  'a8' + //                                map of 8 pairs
  '617601' + //                            "v": 1
  '66676174654964' + '6137' + //           "gateId": "7"
  '676576656e744964' + '6133' + //         "eventId": "3"
  '686973737565644174' + '1a6ab13b80' + // "issuedAt": 1790000000
  '656e6f6e6365' + cborText(NONCE) + //    "nonce"
  '626b78' + cborText(KX) + //             "kx"
  '626b79' + cborText(KY) + //             "ky"
  '63736967' + cborText(SIG); //           "sig"

const GATE_CODE_BYTES = Uint8Array.from(
  GATE_CODE_VECTOR_HEX.match(/.{2}/g)!.map((byte) => Number.parseInt(byte, 16)),
);

const GATE_CODE: GateCodeWire = {
  v: 1,
  gateId: '7',
  eventId: '3',
  issuedAt: 1790000000,
  nonce: NONCE,
  kx: KX,
  ky: KY,
  sig: SIG,
};

describe('nfc records', () => {
  it('decodes the fixed gate-code CBOR vector', () => {
    expect(decodeGateCode(GATE_CODE_BYTES)).toEqual<GateCodeWire>(GATE_CODE);
  });

  it('is byte-identical to what @monti/shared encodes, so the HCE tag and the phone agree', () => {
    expect([...encodeGateCode(GATE_CODE)]).toEqual([...GATE_CODE_BYTES]);
  });

  it('rejects a payload whose version is not 1', () => {
    const wrong = Uint8Array.from(GATE_CODE_BYTES);
    wrong[2] = 0x02; // the value byte of "v"
    expect(() => decodeGateCode(wrong)).toThrow('BAD_GATE_CODE');
  });

  it('encodes the record type as the NDEF external-type bytes the plugin wants', () => {
    expect(TNF_EXTERNAL).toBe(4);
    expect(recordTypeBytes(GATE_RESPONSE_RECORD_TYPE)).toEqual(
      [...'monti.app:s'].map((character) => character.charCodeAt(0)),
    );
    expect(recordTypeMatches([...'monti.app:g'].map((c) => c.charCodeAt(0)), GATE_CODE_RECORD_TYPE)).toBe(true);
    expect(recordTypeMatches([1, 2, 3], GATE_CODE_RECORD_TYPE)).toBe(false);
    expect(recordTypeMatches(undefined, GATE_CODE_RECORD_TYPE)).toBe(false);
  });

  it('writes the response as an external record and round-trips through the QR form', () => {
    const wire: GateResponseWire = { v: 1, tokenId: '42', deviceSig: `0x${'ab'.repeat(64)}` };
    const record = encodeGateResponse(wire);
    expect(record.type).toBe('monti.app:s');
    // v + tokenId + a 64-byte signature as 130 hex chars: comfortably over 140 bytes.
    expect(record.payload.byteLength).toBeGreaterThan(140);
    const qr = gateResponseToQr(wire);
    expect(qr.startsWith(QR_PREFIX)).toBe(true);
    expect(qrToGateResponse(qr)).toEqual(wire);
  });

  it('refuses a QR string that is not a MONTI payload', () => {
    expect(() => qrToGateResponse('https://example.invalid')).toThrow('BAD_QR_PREFIX');
  });
});
