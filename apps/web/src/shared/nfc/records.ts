// The NDEF wrapper around the gate wire formats, and nothing else.
//
// The wire formats themselves — the deterministic CBOR, the base64url, the `MONTI1:` prefix —
// live in @monti/shared and are shared with the staff app and the contracts. This module only
// decides which NDEF record those bytes travel in, so a change of wire format is made once,
// there, and never drifts between the two sides of a tap.
import {
  QR_PREFIX,
  decodeGateCode,
  encodeGateResponse as encodeGateResponseBytes,
  fromQrPayload,
  toQrPayload,
  type GateCodeWire,
  type GateResponseWire,
} from '@monti/shared';

/**
 * NDEF external types, the namespace MONTI owns. Sub-plan 04's HCE service emits `monti.app:g`
 * and parses `monti.app:s`, so these two strings are a cross-app contract: changing one without
 * the other turns every gate into a silent no-read.
 */
export const GATE_CODE_RECORD_TYPE = 'monti.app:g';
export const GATE_RESPONSE_RECORD_TYPE = 'monti.app:s';
/** NDEF TNF 4 = external type. */
export const TNF_EXTERNAL = 4;

export { QR_PREFIX, decodeGateCode };

export interface NdefExternalRecord {
  type: string;
  payload: Uint8Array;
}

/**
 * The plugin models `NdefRecord.type` as a byte array, not a string. Both record types are
 * ASCII, so a code unit is a byte.
 */
export function recordTypeBytes(type: string): number[] {
  return [...type].map((character) => character.charCodeAt(0));
}

export function recordTypeMatches(bytes: readonly number[] | undefined, type: string): boolean {
  if (!bytes || bytes.length !== type.length) return false;
  return bytes.every((byte, index) => byte === type.charCodeAt(index));
}

export function encodeGateResponse(wire: GateResponseWire): NdefExternalRecord {
  return { type: GATE_RESPONSE_RECORD_TYPE, payload: encodeGateResponseBytes(wire) };
}

/** The iPhone-browser answer: the same CBOR the NDEF record would have carried, as a QR string. */
export function gateResponseToQr(wire: GateResponseWire): string {
  return toQrPayload(wire);
}

export function qrToGateResponse(text: string): GateResponseWire {
  return fromQrPayload(text);
}

export type { GateCodeWire, GateResponseWire };
