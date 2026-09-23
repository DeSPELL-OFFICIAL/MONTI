// The ONLY file that touches @capgo/capacitor-nfc. Every shape below comes from the plugin's
// own types (node_modules/@capgo/capacitor-nfc/dist/esm/definitions.d.ts), so a plugin upgrade
// that moves a field is a tsc error here instead of a gate that silently stops reading. No casts.
//
// Two things about the real surface are easy to get wrong:
//   - `NdefRecord.type` is a byte array, not a string. `records.ts` owns that conversion.
//   - `ndefDiscovered` carries an `NfcEvent` — `{ type, tag }` — and the message sits on
//     `tag.ndefMessage`, not on the event itself.
import {
  CapacitorNfc,
  type NdefRecord,
  type NfcEvent,
  type NfcSessionEndEvent,
  type PluginListenerHandle,
} from '@capgo/capacitor-nfc';
import { TNF_EXTERNAL, recordTypeBytes } from './records';

export type ScannedRecord = NdefRecord;
export type SessionEndReason = NfcSessionEndEvent['reason'];
export type PluginListener = PluginListenerHandle;

/**
 * `invalidateAfterFirstRead` defaults to `true`, which closes the iOS reader session the moment
 * the gate code is read — and the answer must be written to that same tag in that same session.
 * The default is refused explicitly rather than inherited.
 *
 * `alertMessage` is deliberately absent: this module carries no attendee-facing copy.
 */
export function startScan(): Promise<void> {
  return CapacitorNfc.startScanning({ invalidateAfterFirstRead: false });
}

export function stopScan(): Promise<void> {
  return CapacitorNfc.stopScanning();
}

export function onNdefDiscovered(handler: (records: ScannedRecord[]) => void): Promise<PluginListener> {
  return CapacitorNfc.addListener('ndefDiscovered', (event: NfcEvent) => handler(event.tag?.ndefMessage ?? []));
}

/**
 * The only signal that a session died on its own. Without it a dismissed iOS sheet leaves the
 * read pending until the attendee gives up.
 */
export function onSessionEnd(handler: (reason: SessionEndReason) => void): Promise<PluginListener> {
  return CapacitorNfc.addListener('nfcSessionEnd', (event: NfcSessionEndEvent) => handler(event.reason));
}

/** Writes one external record to the tag discovered in the session that is currently open. */
export function writeRecord(type: string, payload: Uint8Array): Promise<void> {
  return CapacitorNfc.write({
    records: [{ tnf: TNF_EXTERNAL, type: recordTypeBytes(type), id: [], payload: Array.from(payload) }],
  });
}
