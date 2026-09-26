import { Capacitor } from '@capacitor/core';
import type { GateCodeWire, GateResponseWire } from '@monti/shared';
import { NFC_ERROR, NfcError } from './errors';
import { readGateCodeNative, readThenWriteNative } from './native';
import { readGateCodeWebNfc, readThenWriteWebNfc } from './webnfc';
import type { NfcTapOptions } from './session';

export * from './errors';
export * from './ndef';
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
