// Web NFC — Chrome on Android only. There is no polyfill and no type package, so the small
// slice of the spec this module uses is declared here; the one lookup on `globalThis` is the
// only place a shape is asserted rather than known.
import type { GateCodeWire, GateResponseWire } from '@monti/shared';
import { NFC_ERROR, NfcError } from './errors';
import { GATE_CODE_RECORD_TYPE, decodeGateCode, encodeGateResponse } from './records';

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

function readGateCodeFrom(reader: NdefReaderLike, signal: AbortSignal): Promise<GateCodeWire> {
  return new Promise<GateCodeWire>((resolve, reject) => {
    reader.addEventListener(
      'reading',
      ({ message }) => {
        const record = message.records.find((entry) => entry.recordType === GATE_CODE_RECORD_TYPE);
        if (!record?.data) {
          reject(new NfcError(NFC_ERROR.noGateRecord));
          return;
        }
        const { buffer, byteOffset, byteLength } = record.data;
        try {
          resolve(decodeGateCode(new Uint8Array(buffer, byteOffset, byteLength)));
        } catch (cause) {
          reject(cause);
        }
      },
      { once: true, signal },
    );
    reader.addEventListener('readingerror', () => reject(new NfcError(NFC_ERROR.readFailed)), {
      once: true,
      signal,
    });
  });
}

/** The gate tap on Chrome Android: one reader, so the answer lands on the tag that was read. */
export async function readThenWriteWebNfc(
  sign: (code: GateCodeWire) => Promise<GateResponseWire>,
): Promise<void> {
  const reader = newReader();
  const controller = new AbortController();
  try {
    await reader.scan({ signal: controller.signal });
    const record = encodeGateResponse(await sign(await readGateCodeFrom(reader, controller.signal)));
    await reader.write({ records: [{ recordType: record.type, data: record.payload }] }, { overwrite: true });
  } finally {
    controller.abort();
  }
}

export async function readGateCodeWebNfc(): Promise<GateCodeWire> {
  const reader = newReader();
  const controller = new AbortController();
  try {
    await reader.scan({ signal: controller.signal });
    return await readGateCodeFrom(reader, controller.signal);
  } finally {
    controller.abort();
  }
}

export async function writeGateResponseWebNfc(wire: GateResponseWire): Promise<void> {
  const record = encodeGateResponse(wire);
  await newReader().write({ records: [{ recordType: record.type, data: record.payload }] }, { overwrite: true });
}
