import type { GateCodeWire, GateResponseWire } from '@monti/shared';
import { NFC_ERROR, NfcError, type NfcErrorCode } from './errors';
import { armDeadline, assertNotAborted, deferred, type NfcTapOptions } from './session';
import {
  onNdefDiscovered,
  onSessionEnd,
  startScan,
  stopScan,
  writeRecord,
  type PluginListener,
  type SessionEndReason,
} from './plugin';
import { decodeGateCode, gateResponseRecord, isGateCodeRecord } from './records';

const SESSION_END_CODE: Record<SessionEndReason, NfcErrorCode> = {
  userCancelled: NFC_ERROR.cancelled,
  sessionTimeout: NFC_ERROR.timeout,
  // `invalidated` is the plugin's catch-all session ending, not specifically a tag leaving the
  // field, so it is reported as a failed read rather than guessed at.
  invalidated: NFC_ERROR.readFailed,
};

/**
 * One reader session, opened once and closed exactly once. `body` gets a `readGateCode` it may
 * call at any point while the session is open, which is what lets read → sign → write happen on
 * a single tap: iOS binds a write to the tag discovered in the session that read it, and its
 * session lives about 60 seconds.
 *
 * Listeners are registered before scanning starts, so a tap faster than the registration cannot
 * be missed, and removed in `finally` so a failed read never leaks one into the next tap. The
 * deadline is armed before any of it, because `nfcSessionEnd` only fires on iOS: without it an
 * Android read has no ending but a tag.
 */
async function withSession<T>(
  options: NfcTapOptions,
  body: (readGateCode: () => Promise<GateCodeWire>) => Promise<T>,
): Promise<T> {
  assertNotAborted(options.signal);
  const handles: PluginListener[] = [];
  const gate = deferred<GateCodeWire>();
  const disarm = armDeadline(options, gate.reject);
  try {
    handles.push(
      await onNdefDiscovered((records) => {
        const record = records.find(isGateCodeRecord);
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
    disarm();
    for (const handle of handles) await handle.remove().catch(() => undefined);
    await stopScan().catch(() => undefined);
  }
}

/** The gate tap: read the code, hand it to `sign`, write the answer back — one session, one tap. */
export function readThenWriteNative(
  sign: (code: GateCodeWire) => Promise<GateResponseWire>,
  options: NfcTapOptions = {},
): Promise<void> {
  return withSession(options, async (readGateCode) => {
    const record = gateResponseRecord(await sign(await readGateCode()));
    await writeRecord(record.type, record.payload);
  });
}

/** Read only — for the attendee who will answer by QR instead of writing back. */
export function readGateCodeNative(options: NfcTapOptions = {}): Promise<GateCodeWire> {
  return withSession(options, (readGateCode) => readGateCode());
}
