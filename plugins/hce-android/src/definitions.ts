import type { PluginListenerHandle } from '@capacitor/core';

/**
 * MONTI's gate-side plugin: the staff phone *is* the tag. It emulates an NFC Forum Type 4
 * Tag over Host Card Emulation, so an attendee's phone — running nothing but its stock NFC
 * reader — reads the rotating gate code out of an emulated NDEF file and writes the signed
 * response back into that same file. One tap, both directions, no reader mode on this side
 * and no BLE.
 *
 * Android only, and by nature rather than by omission: iOS exposes card emulation to Apple
 * Pay and nothing else, so `HceWeb` refuses every method instead of pretending (see web.ts).
 */

/**
 * Bytes cross this bridge spelled exactly ONE way, and this comment is the only place that
 * says so — everything typed `Base64` below means it.
 *
 * **Standard base64: the RFC 4648 §4 `+/` alphabet, padded with `=`, no line breaks.**
 * Byte-for-byte what Android's `Base64.NO_WRAP` emits and accepts, which is what the native
 * half of this plugin uses in both directions.
 *
 * Not base64url — `@monti/shared`'s `base64UrlEncode` is a different wire, the one the QR
 * fallback rides on. Not MIME base64 either, with its 76-column line breaks. `fromBase64`
 * rejects both spellings on sight, so a payload encoded the wrong way fails at the call
 * that made it rather than as a tag the attendee's phone cannot read at the gate.
 */
export type Base64 = string;

/** Every rejection from this plugin carries one of these as its Capacitor error code. */
export const HCE_ERROR = {
  /** A required option was missing, or a `Base64` string was not spelled as above. */
  invalidArgument: 'INVALID_ARGUMENT',
  /**
   * This build cannot emulate a card at all — a browser, iOS, or an Android phone with no
   * NFC hardware. Permanent, so the caller falls back to the QR path rather than asking the
   * holder to tap again.
   */
  unavailable: 'UNAVAILABLE',
  /**
   * The hardware is there but NFC is switched off. Recoverable, and the recovery is two
   * taps in Settings — so the caller says "turn NFC on" rather than dropping the whole gate
   * to the QR fallback for the rest of the shift.
   */
  nfcDisabled: 'NFC_DISABLED',
} as const;

export type HceErrorCode = (typeof HCE_ERROR)[keyof typeof HCE_ERROR];

/** One complete NDEF message the attendee's phone just wrote into the emulated file. */
export interface HceWriteEvent {
  ndef: Base64;
}

export interface HceStartOptions {
  /**
   * Upper-case hex AID. Must equal the one the native service declares in its
   * `apduservice.xml`, which is `HCE_AID` from `@monti/shared` — passing it here is the
   * sanity check that the manifest and the caller still agree, not a second source of it.
   */
  aid: string;
}

export interface HceSetPayloadOptions {
  /**
   * The NDEF message to serve from the next SELECT onward. A tap already in flight keeps
   * reading the message it started with; swapping mid-session would hand the attendee half
   * of one gate code and half of the next.
   */
  ndef: Base64;
}

export interface HcePlugin {
  /** Claims the foreground preferred service and turns the APDU state machine on. */
  start(options: HceStartOptions): Promise<void>;
  /** Queues the NDEF message the next session serves. Never swaps one mid-session. */
  setPayload(options: HceSetPayloadOptions): Promise<void>;
  /** Releases the preferred service and turns the state machine off. */
  stop(): Promise<void>;
  /** Fires once per completed write, with the whole NDEF message the reader left behind. */
  addListener(
    eventName: 'write',
    listenerFunc: (event: HceWriteEvent) => void,
  ): Promise<PluginListenerHandle>;
  removeAllListeners(): Promise<void>;
}
