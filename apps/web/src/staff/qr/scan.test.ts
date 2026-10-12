import { beforeEach, describe, expect, it, vi } from 'vitest';

import { toQrPayload, type GateResponseWire } from '@monti/shared';

import { encodeGateResponseMessage } from '../../shared/nfc/ndef';
// `../copy` has no mocked dependency of its own, so it comes in statically like any other module.
import { staffEn } from '../copy';

const scan = vi.fn();
const checkPermissions = vi.fn();
const requestPermissions = vi.fn();
const isNativePlatform = vi.fn();

// Only the plugin object is replaced. `BarcodeFormat` stays the plugin's own enum, so the
// `'QR_CODE'` pinned below is the string the plugin would really hand to Android — a renamed
// member fails here instead of at the door.
vi.mock('@capacitor-mlkit/barcode-scanning', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@capacitor-mlkit/barcode-scanning')>()),
  BarcodeScanner: { scan, checkPermissions, requestPermissions },
}));
vi.mock('@capacitor/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@capacitor/core')>()),
  Capacitor: { isNativePlatform },
}));

const { SCAN_ERROR, ScanCancelled, ScanError, scanFailureText, scanGateResponse } = await import('./scan');
const { RESPONSE_ERROR, ResponseDecodeError, decodeTapResponse } = await import('../gate/decodeResponse');

/**
 * One answer, in the two shapes the gate can receive it. `RESPONSE` is built with the same
 * fields the attendee phone signs; `toQrPayload` is the encoder the attendee's QR screen calls
 * and `encodeGateResponseMessage` is the NDEF record the tap writes. Nothing here is typed by
 * hand, so the two hand-overs cannot drift apart without this file going red.
 */
const RESPONSE: GateResponseWire = {
  v: 2,
  tokenId: '7',
  nonce: `0x${'11'.repeat(32)}`,
  deviceSig: `0x${'22'.repeat(32)}${'33'.repeat(32)}`,
};

const barcode = (rawValue: string) => ({ rawValue });
const granted = { camera: 'granted' } as const;

beforeEach(() => {
  isNativePlatform.mockReturnValue(true);
  checkPermissions.mockResolvedValue(granted);
  requestPermissions.mockResolvedValue(granted);
  scan.mockResolvedValue({ barcodes: [barcode(toQrPayload(RESPONSE))] });
});

describe('scanGateResponse', () => {
  it('hands back exactly what the tap would have decoded from the same answer', async () => {
    const scanned = await scanGateResponse();
    expect(scanned).toEqual(RESPONSE);
    expect(scanned).toEqual(decodeTapResponse(encodeGateResponseMessage(RESPONSE)));
  });

  it('scans QR only, so a barcode on a lanyard is never a candidate', async () => {
    await scanGateResponse();
    expect(scan).toHaveBeenCalledWith({ formats: ['QR_CODE'] });
  });

  it('does not re-ask for a camera it already has', async () => {
    await scanGateResponse();
    expect(requestPermissions).not.toHaveBeenCalled();
  });

  it('asks once when the camera has never been granted', async () => {
    checkPermissions.mockResolvedValueOnce({ camera: 'prompt' });
    await expect(scanGateResponse()).resolves.toEqual(RESPONSE);
    expect(requestPermissions).toHaveBeenCalledTimes(1);
  });

  it('refuses with a typed error, and never opens the camera, when permission is denied', async () => {
    checkPermissions.mockResolvedValueOnce({ camera: 'denied' });
    requestPermissions.mockResolvedValueOnce({ camera: 'denied' });
    await expect(scanGateResponse()).rejects.toMatchObject({ code: SCAN_ERROR.permissionDenied });
    expect(scan).not.toHaveBeenCalled();
  });

  it('throws ScanCancelled when the camera closes with nothing scanned', async () => {
    scan.mockResolvedValueOnce({ barcodes: [] });
    await expect(scanGateResponse()).rejects.toThrow(ScanCancelled);
  });

  it('throws ScanCancelled for the rejection Android actually sends on cancel', async () => {
    // BarcodeScannerPlugin.java rejects with ERROR_SCAN_CANCELED — it does not resolve empty.
    scan.mockRejectedValueOnce(new Error('scan canceled.'));
    await expect(scanGateResponse()).rejects.toThrow(ScanCancelled);
  });

  it('ignores a QR that is not a MONTI gate code instead of feeding it to the gate', async () => {
    scan.mockResolvedValueOnce({ barcodes: [barcode('https://monti.despell.io/')] });
    await expect(scanGateResponse()).rejects.toMatchObject({ code: SCAN_ERROR.notGateCode });
  });

  it('picks the gate code out of a frame that also held somebody else’s QR', async () => {
    scan.mockResolvedValueOnce({
      barcodes: [barcode('WIFI:S=lobby;;'), barcode(toQrPayload(RESPONSE))],
    });
    await expect(scanGateResponse()).resolves.toEqual(RESPONSE);
  });

  it('names the missing Google scanner module rather than passing its English sentence on', async () => {
    scan.mockRejectedValueOnce(
      new Error(
        'The Google Barcode Scanner Module is not available. You must install it first using the installGoogleBarcodeScannerModule method.',
      ),
    );
    await expect(scanGateResponse()).rejects.toMatchObject({ code: SCAN_ERROR.unavailable });
  });

  it('says a browser has no scanner before it asks that browser for a camera', async () => {
    isNativePlatform.mockReturnValue(false);
    await expect(scanGateResponse()).rejects.toMatchObject({ code: SCAN_ERROR.unavailable });
    expect(checkPermissions).not.toHaveBeenCalled();
  });

  it('keeps any other plugin failure a typed one', async () => {
    scan.mockRejectedValueOnce(new Error('camera in use by another app'));
    await expect(scanGateResponse()).rejects.toMatchObject({ code: SCAN_ERROR.failed });
  });

  it('lets a corrupt MONTI code fail exactly as a corrupt tap does', async () => {
    scan.mockResolvedValue({ barcodes: [barcode('MONTI1:AAEC')] });
    await expect(scanGateResponse()).rejects.toThrow(ResponseDecodeError);
    await expect(scanGateResponse()).rejects.toMatchObject({ code: RESPONSE_ERROR.badTag });
  });
});

describe('scan copy', () => {
  it('says nothing when the staff member closed the camera on purpose', () => {
    expect(scanFailureText(staffEn.qr, new ScanCancelled())).toBeNull();
  });

  it('leaves the gate’s own vocabulary to the gate', () => {
    expect(scanFailureText(staffEn.qr, new ResponseDecodeError(RESPONSE_ERROR.badTag))).toBeNull();
  });

  it('has a line for every failure a staff member can see, in both locales', () => {
    const showable = [SCAN_ERROR.permissionDenied, SCAN_ERROR.notGateCode, SCAN_ERROR.unavailable, SCAN_ERROR.failed];
    for (const code of showable) {
      expect(scanFailureText(staffEn.qr, new ScanError(code))).toBeTruthy();
      expect(scanFailureText(staffEn.qr, new ScanError(code))).toBeTruthy();
    }
  });
});
