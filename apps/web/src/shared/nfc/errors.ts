/**
 * Failure codes, never copy. The attendee-facing sentence is chosen by the gate screen from
 * `code`; this module stays translatable-free so `lint:copy` never has to reach into it.
 */
export const NFC_ERROR = {
  /** No NFC on this platform at all — the gate screen offers the QR path instead. */
  unavailable: 'NFC_UNAVAILABLE',
  /** The reader sheet was dismissed by the attendee. */
  cancelled: 'NFC_CANCELLED',
  /** iOS closed the session before a tag arrived (~60 s). */
  timeout: 'NFC_TIMEOUT',
  /** The session died with the phone still at the gate — almost always the tag leaving the field. */
  tagLost: 'NFC_TAG_LOST',
  /** A tag was read, but it carried no `monti.app:g` record. */
  noGateRecord: 'NFC_NO_GATE_RECORD',
  readFailed: 'NFC_READ_FAILED',
} as const;

export type NfcErrorCode = (typeof NFC_ERROR)[keyof typeof NFC_ERROR];

export class NfcError extends Error {
  readonly code: NfcErrorCode;

  constructor(code: NfcErrorCode) {
    super(code);
    this.name = 'NfcError';
    this.code = code;
  }
}
