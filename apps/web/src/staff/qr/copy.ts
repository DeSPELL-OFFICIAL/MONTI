import { useLocale } from '../../shared/i18n';

import { SCAN_ERROR, ScanError, type ScanErrorCode } from './scan';

/**
 * The QR fallback's own copy, in the two locales every staff screen carries. It is a module of
 * its own rather than a block inside the console's copy because the console's copy is being
 * written next door — and because these five lines are the only ones in the staff app spoken
 * about a camera.
 *
 * Every line says what to do next. The staff member holding this phone is being watched by a
 * queue, so "읽지 못했어요" alone is a person standing still.
 */
export const staffQrKo = {
  scanButton: 'QR로 확인',
  cameraDenied: '카메라를 쓸 수 없어요. 설정에서 카메라 권한을 켜고 다시 누르세요.',
  notGateCode: '입장 QR이 아니에요. 관객 화면의 QR을 비춰 주세요.',
  unavailable: '이 단말기에서는 QR을 읽을 수 없어요. NFC로 받아 주세요.',
  failed: 'QR을 읽지 못했어요. 다시 누르세요.',
};

export const staffQrEn: typeof staffQrKo = {
  scanButton: 'Check with QR',
  cameraDenied: 'The camera is not available. Turn the camera permission on in Settings and press again.',
  notGateCode: 'That is not an entry code. Point the camera at the QR on the attendee’s screen.',
  unavailable: 'This device cannot read QR codes. Take the tap over NFC instead.',
  failed: 'The code could not be read. Press again.',
};

export type StaffQrCopy = typeof staffQrKo;

/**
 * One line per failure the staff member can act on, keyed by every code `scan.ts` can throw —
 * so a code added there without a sentence here does not compile. `SCAN_CANCELLED` maps to
 * nothing on purpose: see below.
 */
const SCAN_FAILURE_TEXT: Record<ScanErrorCode, keyof StaffQrCopy | null> = {
  [SCAN_ERROR.cancelled]: null,
  [SCAN_ERROR.permissionDenied]: 'cameraDenied',
  [SCAN_ERROR.notGateCode]: 'notGateCode',
  [SCAN_ERROR.unavailable]: 'unavailable',
  [SCAN_ERROR.failed]: 'failed',
};

/**
 * What to show after a scan that did not produce an answer — and `null` where showing anything
 * would be wrong: a staff member who closed the camera did not fail at something, and a
 * `ResponseDecodeError` is the gate's own refusal, already spoken by the gate's own screen.
 */
export function scanFailureText(copy: StaffQrCopy, cause: unknown): string | null {
  if (!(cause instanceof ScanError)) return null;
  const line = SCAN_FAILURE_TEXT[cause.code];
  return line === null ? null : copy[line];
}

/** Same locale the rest of the device follows, so one phone speaks one language. */
export function useStaffQrCopy(): StaffQrCopy {
  return useLocale() === 'en' ? staffQrEn : staffQrKo;
}
