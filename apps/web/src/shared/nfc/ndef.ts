// The NDEF envelope around the gate wire formats — framing, and nothing else.
//
// The payloads themselves (the deterministic CBOR of `GateCodeWire` and `GateResponseWire`) are
// `@monti/shared`'s, and are not re-implemented here: this module only decides which bytes go
// around them. That split is what lets the staff phone's HCE file (Kotlin, sub-plan 04) and the
// attendee phone's write (sub-plan 03) be the same bytes without either side owning the format.
//
// Nothing here touches Capacitor or the DOM. The staff reader and the attendee writer both
// import it, and it also has to hold still under a plain `vitest` unit test.
import {
  NDEF_GATE_TYPE,
  NDEF_RESPONSE_TYPE,
  decodeGateCode,
  decodeGateResponse,
  encodeGateCode,
  encodeGateResponse,
  type GateCodeWire,
  type GateResponseWire,
} from '@monti/shared';
import { TNF_EXTERNAL, recordTypeBytes } from './records';

/**
 * The longest NDEF **message** the staff phone's Type 4 file can hold: the 2048-byte file the
 * Capability Container declares, less the two NLEN bytes in front of it. `Type4Files.kt` is the
 * original; `ndef.test.ts` reads that file and fails if the two ever disagree.
 */
export const MAX_NDEF_SIZE = 2046;

/** The two external types MONTI owns. Imported, never spelled again. */
export type MontiNdefType = typeof NDEF_GATE_TYPE | typeof NDEF_RESPONSE_TYPE;

export interface MontiNdefRecord {
  type: MontiNdefType;
  payload: Uint8Array;
}

/**
 * Why each refusal gets its own code: the gate treats every one of them as "bad tag" today, but
 * a field report of `NDEF_FOREIGN_TYPE` says someone tapped a different app's tag, while
 * `NDEF_TRUNCATED` says the tap broke halfway. One shared code would hide that difference at
 * exactly the moment it is needed.
 */
export const NDEF_DECODE_ERROR = {
  /** The buffer ends before the header, the type, or the payload the record declares. */
  truncated: 'NDEF_TRUNCATED',
  /** The record ended before the buffer did — a second record, or junk. */
  trailingBytes: 'NDEF_TRAILING_BYTES',
  /** MB and ME are not both set: this record is one of several in a longer message. */
  notSingleRecord: 'NDEF_NOT_SINGLE_RECORD',
  /** TNF is not 4. A MIME record carrying the same type bytes is not a gate record. */
  unknownTnf: 'NDEF_UNKNOWN_TNF',
  /** CF is set. MONTI never chunks, and re-assembling chunks here would buy nothing. */
  chunked: 'NDEF_CHUNKED',
  /** IL is set. MONTI writes no ID field, so an ID means these are not our bytes. */
  idField: 'NDEF_ID_FIELD',
  /** A well-formed external record, but not one of MONTI's two types. */
  foreignType: 'NDEF_FOREIGN_TYPE',
  /** The framing was sound and `@monti/shared` still refused the payload. */
  badPayload: 'NDEF_BAD_PAYLOAD',
  /** The record does not fit the NDEF file the staff phone serves. */
  tooLarge: 'NDEF_TOO_LARGE',
} as const;

export type NdefDecodeErrorCode = (typeof NDEF_DECODE_ERROR)[keyof typeof NDEF_DECODE_ERROR];

/**
 * An NDEF framing failure. The gate treats it as "bad tag" and never as a check-in verdict.
 *
 * `encodeExternalRecord` throws it too, for the one refusal the encoder has — a record too big
 * for the file. One error type means the tap path has one thing to catch.
 */
export class NdefDecodeError extends Error {
  readonly code: NdefDecodeErrorCode;

  constructor(code: NdefDecodeErrorCode, options?: { cause?: unknown }) {
    super(code, options);
    this.name = 'NdefDecodeError';
    this.code = code;
  }
}

// NDEF record header bits (NFC Forum NDEF 1.0 §3.2).
const MB = 0x80; // Message Begin
const ME = 0x40; // Message End
const CF = 0x20; // Chunk Flag
const SR = 0x10; // Short Record — a one-byte payload length
const IL = 0x08; // ID Length present
const TNF_MASK = 0x07;

/** A payload of 255 bytes or fewer fits the short record's one length byte. */
const SHORT_RECORD_MAX_PAYLOAD = 255;

function isMontiNdefType(type: string): type is MontiNdefType {
  return type === NDEF_GATE_TYPE || type === NDEF_RESPONSE_TYPE;
}

/**
 * One NDEF message holding one external-type record: MB and ME both set, because there is never
 * a second record, and SR set whenever the payload fits a single length byte.
 */
export function encodeExternalRecord(type: MontiNdefType, payload: Uint8Array): Uint8Array {
  const typeBytes = Uint8Array.from(recordTypeBytes(type));
  const short = payload.length <= SHORT_RECORD_MAX_PAYLOAD;
  const headerSize = short ? 3 : 6;
  const size = headerSize + typeBytes.length + payload.length;
  if (size > MAX_NDEF_SIZE) throw new NdefDecodeError(NDEF_DECODE_ERROR.tooLarge);

  const record = new Uint8Array(size);
  record[0] = MB | ME | (short ? SR : 0) | TNF_EXTERNAL;
  record[1] = typeBytes.length;
  if (short) {
    record[2] = payload.length;
  } else {
    record[2] = (payload.length >>> 24) & 0xff;
    record[3] = (payload.length >>> 16) & 0xff;
    record[4] = (payload.length >>> 8) & 0xff;
    record[5] = payload.length & 0xff;
  }
  record.set(typeBytes, headerSize);
  record.set(payload, headerSize + typeBytes.length);
  return record;
}

/**
 * The read side. A long-form record whose payload would have fitted a short one is accepted:
 * other stacks write it, it means the same thing, and refusing it would cost a tap for nothing.
 *
 * The payload is copied out rather than handed back as a view, because the caller's buffer is
 * usually the base64 the HCE plugin just decoded, which it is free to reuse on the next tap.
 */
export function decodeExternalRecord(message: Uint8Array): MontiNdefRecord {
  if (message.length > MAX_NDEF_SIZE) throw new NdefDecodeError(NDEF_DECODE_ERROR.tooLarge);
  if (message.length < 3) throw new NdefDecodeError(NDEF_DECODE_ERROR.truncated);

  const header = message[0] as number;
  if ((header & TNF_MASK) !== TNF_EXTERNAL) throw new NdefDecodeError(NDEF_DECODE_ERROR.unknownTnf);
  // CF is read before MB/ME on purpose: a genuinely chunked message always has ME clear on its
  // first record, so testing MB/ME first would make `chunked` a code nothing can ever produce.
  if ((header & CF) !== 0) throw new NdefDecodeError(NDEF_DECODE_ERROR.chunked);
  if ((header & IL) !== 0) throw new NdefDecodeError(NDEF_DECODE_ERROR.idField);
  if ((header & (MB | ME)) !== (MB | ME)) {
    throw new NdefDecodeError(NDEF_DECODE_ERROR.notSingleRecord);
  }

  const typeLength = message[1] as number;
  let at: number;
  let payloadLength: number;
  if ((header & SR) !== 0) {
    payloadLength = message[2] as number;
    at = 3;
  } else {
    if (message.length < 6) throw new NdefDecodeError(NDEF_DECODE_ERROR.truncated);
    payloadLength =
      (((message[2] as number) << 24) |
        ((message[3] as number) << 16) |
        ((message[4] as number) << 8) |
        (message[5] as number)) >>>
      0;
    at = 6;
  }

  const end = at + typeLength + payloadLength;
  if (message.length < end) throw new NdefDecodeError(NDEF_DECODE_ERROR.truncated);
  if (message.length > end) throw new NdefDecodeError(NDEF_DECODE_ERROR.trailingBytes);

  const type = new TextDecoder().decode(message.subarray(at, at + typeLength));
  if (!isMontiNdefType(type)) throw new NdefDecodeError(NDEF_DECODE_ERROR.foreignType);
  return { type, payload: message.slice(at + typeLength, end) };
}

/**
 * Framing off, then `@monti/shared` decides whether the payload is a gate wire at all. A
 * rejection from there is wrapped rather than rethrown, so the caller catches one error type
 * and the original reason is still on `cause`.
 */
function unframe<T>(
  message: Uint8Array,
  expected: MontiNdefType,
  decode: (payload: Uint8Array) => T,
): T {
  const record = decodeExternalRecord(message);
  if (record.type !== expected) throw new NdefDecodeError(NDEF_DECODE_ERROR.foreignType);
  try {
    return decode(record.payload);
  } catch (cause) {
    throw new NdefDecodeError(NDEF_DECODE_ERROR.badPayload, { cause });
  }
}

/** What the staff phone serves from its NDEF file. */
export function encodeGateCodeMessage(wire: GateCodeWire): Uint8Array {
  return encodeExternalRecord(NDEF_GATE_TYPE, encodeGateCode(wire));
}

/** What the attendee phone reads off the gate. */
export function decodeGateCodeMessage(message: Uint8Array): GateCodeWire {
  return unframe(message, NDEF_GATE_TYPE, decodeGateCode);
}

/** What the attendee phone writes back into the gate's NDEF file. */
export function encodeGateResponseMessage(wire: GateResponseWire): Uint8Array {
  return encodeExternalRecord(NDEF_RESPONSE_TYPE, encodeGateResponse(wire));
}

/** What the staff phone's write event carries. */
export function decodeGateResponseMessage(message: Uint8Array): GateResponseWire {
  return unframe(message, NDEF_RESPONSE_TYPE, decodeGateResponse);
}
