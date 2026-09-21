import { Capacitor } from '@capacitor/core';
import type { GateCodeWire, GateResponseWire } from '@monti/shared';
import { NFC_ERROR, NfcError } from './errors';
import { readGateCodeNative, readThenWriteNative, writeGateResponseNative } from './native';
import { readGateCodeWebNfc, readThenWriteWebNfc, writeGateResponseWebNfc } from './webnfc';
import type { NfcTapOptions } from './session';

export * from './errors';
export * from './records';
export { NFC_SESSION_TIMEOUT_MS, type NfcTapOptions } from './session';

export type NfcCapability = 'native' | 'webnfc' | 'none';

/**
 * `none` is not a failure the gate screen hides — it is the signal to offer the QR path. Nothing
 * here falls back on its own: an attendee who thinks the tap worked and walked through is worse
 * than one who is told to hold up a code.
 */
export function nfcCapability(): NfcCapability {
  if (Capacitor.isNativePlatform()) return 'native';
  return 'NDEFReader' in globalThis ? 'webnfc' : 'none';
}

/**
 * The gate tap, start to finish: the gate's one-time code is read, `sign` turns it into the
 * device-signed answer, and the answer is written back to the same tag in the same session.
 */
export function readThenWrite(
  sign: (code: GateCodeWire) => Promise<GateResponseWire>,
  options: NfcTapOptions = {},
): Promise<void> {
  const capability = nfcCapability();
  if (capability === 'native') return readThenWriteNative(sign, options);
  if (capability === 'webnfc') return readThenWriteWebNfc(sign, options);
  return Promise.reject(new NfcError(NFC_ERROR.unavailable));
}

export function readGateCode(options: NfcTapOptions = {}): Promise<GateCodeWire> {
  const capability = nfcCapability();
  if (capability === 'native') return readGateCodeNative(options);
  if (capability === 'webnfc') return readGateCodeWebNfc(options);
  return Promise.reject(new NfcError(NFC_ERROR.unavailable));
}

/**
 * Writes the answer into a reader session that is **already open**. On native that is the
 * plugin's own contract — `write` targets the last discovered tag — and no exported function
 * here leaves such a session open, so this is for a caller that drives the session itself. The
 * one-tap gate flow is {@link readThenWrite}.
 */
export function writeGateResponse(wire: GateResponseWire): Promise<void> {
  const capability = nfcCapability();
  if (capability === 'native') return writeGateResponseNative(wire);
  if (capability === 'webnfc') return writeGateResponseWebNfc(wire);
  return Promise.reject(new NfcError(NFC_ERROR.unavailable));
}
