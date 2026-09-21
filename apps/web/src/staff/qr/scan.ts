// The QR fallback at the gate, and the only file in the staff app that knows a camera exists.
//
// It exists for the attendee whose phone can read the gate's code but cannot write an answer
// back to it — an iPhone in a browser, a tag write that failed — so the answer is held up on a
// screen instead. What the camera reads is not a second protocol: `MONTI1:` carries base64url
// of the very CBOR an NDEF record would have carried (`@monti/shared`'s `toQrPayload`, which
// the attendee's QR screen calls), and Task 19's `decodeQrResponse` unwraps it. Everything
// after the decode — the nonce match, the pre-checks, the send, the verdict — is the NFC path,
// because there is only one of it.
//
// The plugin's real behaviour differs from its README in one way that matters at a door, and
// the constants below are read from its Android source rather than guessed: `scan()` **rejects**
// with `scan canceled.` when the staff member backs out. Left unmapped that arrives as a raw
// English string in a catch block, which is how a cancelled scan turns into "전송 실패" on a
// screen somebody is standing in front of.
import { BarcodeFormat, BarcodeScanner, type Barcode } from '@capacitor-mlkit/barcode-scanning';
import { Capacitor } from '@capacitor/core';

import { QR_PREFIX, type GateResponseWire } from '@monti/shared';

import { decodeQrResponse } from '../gate/decodeResponse';

/**
 * Failure codes, never copy — the same division `NfcError` keeps. `copy.ts` beside this file
 * owns the sentences, in both locales.
 */
export const SCAN_ERROR = {
  /** The staff member closed the camera. Not a failure: the gate says nothing and stays ready. */
  cancelled: 'SCAN_CANCELLED',
  /** The camera was refused. The staff member can grant it and press again. */
  permissionDenied: 'SCAN_PERMISSION_DENIED',
  /** No scanner on this device: a browser, or an Android without the Google scanner module. */
  unavailable: 'SCAN_UNAVAILABLE',
  /** Something was scanned, and it was not a MONTI entry code. Never reaches the gate. */
  notGateCode: 'SCAN_NOT_GATE_CODE',
  /** The camera itself failed, for a reason the plugin did not name. */
  failed: 'SCAN_FAILED',
} as const;

export type ScanErrorCode = (typeof SCAN_ERROR)[keyof typeof SCAN_ERROR];

export class ScanError extends Error {
  readonly code: ScanErrorCode;

  constructor(code: ScanErrorCode, options?: { cause?: unknown }) {
    super(code, options);
    this.name = 'ScanError';
    this.code = code;
  }
}

/**
 * Its own type because it is the one ending the caller must be able to tell apart without
 * reading a code: a staff member who closed the camera asked for nothing and is told nothing.
 */
export class ScanCancelled extends ScanError {
  constructor(options?: { cause?: unknown }) {
    super(SCAN_ERROR.cancelled, options);
    this.name = 'ScanCancelled';
  }
}

// Verbatim from `@capacitor-mlkit/barcode-scanning@8.0.0`
// `android/src/main/java/io/capawesome/.../BarcodeScannerPlugin.java` (ERROR_SCAN_CANCELED,
// ERROR_GOOGLE_BARCODE_SCANNER_MODULE_NOT_AVAILABLE). A plugin upgrade that rewords either one
// lands as `SCAN_FAILED`, which is a wrong sentence and not a wrong outcome.
const ANDROID_CANCELLED = 'scan canceled.';
const ANDROID_MODULE_MISSING =
  'The Google Barcode Scanner Module is not available. You must install it first using the installGoogleBarcodeScannerModule method.';

function scanFailure(cause: unknown): ScanError {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (message === ANDROID_CANCELLED) return new ScanCancelled({ cause });
  if (message === ANDROID_MODULE_MISSING) return new ScanError(SCAN_ERROR.unavailable, { cause });
  return new ScanError(SCAN_ERROR.failed, { cause });
}

/**
 * Asked for before the camera is opened, and only when it is not already held.
 *
 * The staff APK declares `android.permission.CAMERA` for this: without the declaration
 * Capacitor reports the permission as never-granted and the plugin's `requestPermissions`
 * quietly skips the prompt (`isPermissionDeclared(CAMERA)` in `BarcodeScannerPlugin.java`), so
 * the fallback would refuse itself forever on a phone whose camera works fine.
 */
async function holdCamera(): Promise<void> {
  const held = await BarcodeScanner.checkPermissions();
  if (held.camera === 'granted') return;
  const asked = await BarcodeScanner.requestPermissions();
  if (asked.camera !== 'granted') throw new ScanError(SCAN_ERROR.permissionDenied);
}

async function scanOnce(): Promise<Barcode[]> {
  try {
    const { barcodes } = await BarcodeScanner.scan({ formats: [BarcodeFormat.QrCode] });
    return barcodes;
  } catch (cause) {
    throw scanFailure(cause);
  }
}

/**
 * One scan, one answer — or a typed refusal. Cancelling is `ScanCancelled`; a QR that is not a
 * MONTI entry code is refused here rather than handed on, because the gate's vocabulary has no
 * word for a bus timetable and the attendee in front of the staff member is owed a sentence
 * about their code, not about a nonce.
 *
 * A well-formed `MONTI1:` whose body is broken throws `ResponseDecodeError` — the exact type
 * and code a broken tap throws, so the screen already knows what to do with it.
 */
export async function scanGateResponse(): Promise<GateResponseWire> {
  // A browser has no scanner at all, and asking it for a camera first would open a permission
  // prompt that leads nowhere. `/staff/*` renders in one on a laptop (Task 10).
  if (!Capacitor.isNativePlatform()) throw new ScanError(SCAN_ERROR.unavailable);
  await holdCamera();
  const barcodes = await scanOnce();
  const entryCode = barcodes.map((found) => found.rawValue).find((value) => value?.startsWith(QR_PREFIX));
  if (!entryCode) {
    // Nothing scanned means the camera was closed; something scanned means it was not ours.
    if (barcodes.length === 0) throw new ScanCancelled();
    throw new ScanError(SCAN_ERROR.notGateCode);
  }
  return decodeQrResponse(entryCode);
}
