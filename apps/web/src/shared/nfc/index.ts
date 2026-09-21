import { Capacitor } from '@capacitor/core';
import type { GateCodeWire, GateResponseWire } from '@monti/shared';
import { NFC_ERROR, NfcError } from './errors';
import { readGateCodeNative, readThenWriteNative, writeGateResponseNative } from './native';
import { readGateCodeWebNfc, readThenWriteWebNfc, writeGateResponseWebNfc } from './webnfc';

export * from './errors';
export * from './records';

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
export function readThenWrite(sign: (code: GateCodeWire) => Promise<GateResponseWire>): Promise<void> {
  const capability = nfcCapability();
  if (capability === 'native') return readThenWriteNative(sign);
  if (capability === 'webnfc') return readThenWriteWebNfc(sign);
  return Promise.reject(new NfcError(NFC_ERROR.unavailable));
}

export function readGateCode(): Promise<GateCodeWire> {
  const capability = nfcCapability();
  if (capability === 'native') return readGateCodeNative();
  if (capability === 'webnfc') return readGateCodeWebNfc();
  return Promise.reject(new NfcError(NFC_ERROR.unavailable));
}

export function writeGateResponse(wire: GateResponseWire): Promise<void> {
  const capability = nfcCapability();
  if (capability === 'native') return writeGateResponseNative(wire);
  if (capability === 'webnfc') return writeGateResponseWebNfc(wire);
  return Promise.reject(new NfcError(NFC_ERROR.unavailable));
}
