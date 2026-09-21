import type { GateCodeWire, GateResponseWire } from '@monti/shared';
import { NFC_ERROR, NfcError, type NfcErrorCode } from './errors';
import {
  onNdefDiscovered,
  onSessionEnd,
  startScan,
  stopScan,
  writeRecord,
  type PluginListener,
  type SessionEndReason,
} from './plugin';
import { GATE_CODE_RECORD_TYPE, decodeGateCode, encodeGateResponse, recordTypeMatches } from './records';

const SESSION_END_CODE: Record<SessionEndReason, NfcErrorCode> = {
  userCancelled: NFC_ERROR.cancelled,
  sessionTimeout: NFC_ERROR.timeout,
  invalidated: NFC_ERROR.tagLost,
};

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (cause: unknown) => void;
}

/** First settlement wins: a tag that arrives as the session is dying must not settle twice. */
function deferred<T>(): Deferred<T> {
  let resolveFn!: (value: T) => void;
  let rejectFn!: (cause: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });
  // The rejection is always delivered to whoever awaits `promise`; this only marks it handled so
  // a session that ends before anyone awaits cannot surface as an unhandled rejection.
  promise.catch(() => undefined);
  let settled = false;
  return {
    promise,
    resolve: (value) => {
      if (settled) return;
      settled = true;
      resolveFn(value);
    },
    reject: (cause) => {
      if (settled) return;
      settled = true;
      rejectFn(cause);
    },
  };
}

/**
 * One reader session, opened once and closed exactly once. `body` gets a `readGateCode` it may
 * call at any point while the session is open, which is what lets read → sign → write happen on
 * a single tap: iOS binds a write to the tag discovered in the session that read it, and its
 * session lives about 60 seconds.
 *
 * Listeners are registered before scanning starts, so a tap faster than the registration cannot
 * be missed, and removed in `finally` so a failed read never leaks one into the next tap.
 */
async function withSession<T>(body: (readGateCode: () => Promise<GateCodeWire>) => Promise<T>): Promise<T> {
  const handles: PluginListener[] = [];
  const gate = deferred<GateCodeWire>();
  try {
    handles.push(
      await onNdefDiscovered((records) => {
        const record = records.find((entry) => recordTypeMatches(entry.type, GATE_CODE_RECORD_TYPE));
        if (!record?.payload?.length) {
          gate.reject(new NfcError(NFC_ERROR.noGateRecord));
          return;
        }
        try {
          gate.resolve(decodeGateCode(Uint8Array.from(record.payload)));
        } catch (cause) {
          gate.reject(cause);
        }
      }),
    );
    handles.push(await onSessionEnd((reason) => gate.reject(new NfcError(SESSION_END_CODE[reason]))));
    await startScan();
    return await body(() => gate.promise);
  } finally {
    for (const handle of handles) await handle.remove().catch(() => undefined);
    await stopScan().catch(() => undefined);
  }
}

/** The gate tap: read the code, hand it to `sign`, write the answer back — one session, one tap. */
export function readThenWriteNative(
  sign: (code: GateCodeWire) => Promise<GateResponseWire>,
): Promise<void> {
  return withSession(async (readGateCode) => {
    const record = encodeGateResponse(await sign(await readGateCode()));
    await writeRecord(record.type, record.payload);
  });
}

/** Read only — for the attendee who will answer by QR instead of writing back. */
export function readGateCodeNative(): Promise<GateCodeWire> {
  return withSession((readGateCode) => readGateCode());
}

/** Writes into the session that is already open; it does not start one. */
export async function writeGateResponseNative(wire: GateResponseWire): Promise<void> {
  const record = encodeGateResponse(wire);
  await writeRecord(record.type, record.payload);
}
