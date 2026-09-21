// Web NFC — Chrome on Android only. There is no polyfill and no type package, so the small
// slice of the spec this module uses is declared here; the one lookup on `globalThis` is the
// only place a shape is asserted rather than known.
import type { GateCodeWire, GateResponseWire } from '@monti/shared';
import { NFC_ERROR, NfcError } from './errors';
import { GATE_CODE_RECORD_TYPE, decodeGateCode, gateResponseRecord } from './records';
import { armDeadline, assertNotAborted, deferred, type NfcTapOptions } from './session';

interface NdefReadingRecord {
  /** For an external record this is the external type itself, e.g. `monti.app:g`. */
  recordType: string;
  data?: DataView;
}

interface NdefReadingEvent {
  message: { records: NdefReadingRecord[] };
}

interface NdefReaderLike {
  scan: (options?: { signal?: AbortSignal }) => Promise<void>;
  write: (
    message: { records: Array<{ recordType: string; data: Uint8Array }> },
    options?: { overwrite?: boolean; signal?: AbortSignal },
  ) => Promise<void>;
  addEventListener: (
    name: 'reading' | 'readingerror',
    handler: (event: NdefReadingEvent) => void,
    options?: { once?: boolean; signal?: AbortSignal },
  ) => void;
}

function newReader(): NdefReaderLike {
  const Reader = (globalThis as { NDEFReader?: new () => NdefReaderLike }).NDEFReader;
  if (!Reader) throw new NfcError(NFC_ERROR.unavailable);
  return new Reader();
}

/**
 * Web NFC exposes no `tnf`: the spec maps TNF 4 onto a `recordType` that *is* the external type
 * string, so this is the same assertion `native.ts` makes with `tnf === TNF_EXTERNAL`. A MIME or
 * text record carrying the same bytes reports `recordType` `'mime'` or `'text'` and is refused.
 */
function isGateCodeRecord(record: NdefReadingRecord): boolean {
  return record.recordType === GATE_CODE_RECORD_TYPE;
}

/**
 * Attached before `scan()` — the same ordering the native path keeps — so a tag already in the
 * field when the scan starts cannot be read before anyone is listening.
 */
function watchForGateCode(
  reader: NdefReaderLike,
  signal: AbortSignal,
  options: NfcTapOptions,
): { gate: Promise<GateCodeWire>; disarm: () => void } {
  const gate = deferred<GateCodeWire>();
  const disarm = armDeadline(options, gate.reject);
  reader.addEventListener(
    'reading',
    ({ message }) => {
      const record = message.records.find(isGateCodeRecord);
      if (!record?.data) {
        gate.reject(new NfcError(NFC_ERROR.noGateRecord));
        return;
      }
      const { buffer, byteOffset, byteLength } = record.data;
      try {
        gate.resolve(decodeGateCode(new Uint8Array(buffer, byteOffset, byteLength)));
      } catch (cause) {
        gate.reject(cause);
      }
    },
    { once: true, signal },
  );
  reader.addEventListener('readingerror', () => gate.reject(new NfcError(NFC_ERROR.readFailed)), {
    once: true,
    signal,
  });
  return { gate: gate.promise, disarm };
}

/** The gate tap on Chrome Android: one reader, so the answer lands on the tag that was read. */
export async function readThenWriteWebNfc(
  sign: (code: GateCodeWire) => Promise<GateResponseWire>,
  options: NfcTapOptions = {},
): Promise<void> {
  assertNotAborted(options.signal);
  const reader = newReader();
  const controller = new AbortController();
  const { gate, disarm } = watchForGateCode(reader, controller.signal, options);
  try {
    await reader.scan({ signal: controller.signal });
    const record = gateResponseRecord(await sign(await gate));
    await reader.write({ records: [{ recordType: record.type, data: record.payload }] }, { overwrite: true });
  } finally {
    disarm();
    controller.abort();
  }
}

export async function readGateCodeWebNfc(options: NfcTapOptions = {}): Promise<GateCodeWire> {
  assertNotAborted(options.signal);
  const reader = newReader();
  const controller = new AbortController();
  const { gate, disarm } = watchForGateCode(reader, controller.signal, options);
  try {
    await reader.scan({ signal: controller.signal });
    return await gate;
  } finally {
    disarm();
    controller.abort();
  }
}

export async function writeGateResponseWebNfc(wire: GateResponseWire): Promise<void> {
  const record = gateResponseRecord(wire);
  await newReader().write({ records: [{ recordType: record.type, data: record.payload }] }, { overwrite: true });
}
