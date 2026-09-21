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
  /** A tag was read, but it carried no `monti.app:g` external record. */
  noGateRecord: 'NFC_NO_GATE_RECORD',
  /** The read itself failed, or the session was invalidated for a reason iOS did not name. */
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
