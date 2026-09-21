// The gate, running. One AID claim, a new one-time code every 3 seconds, and every completed
// tap handed on as a response paired with the code it answers.
//
// This file never calls an NFC reader API and never will (spec §11, §18): the staff phone is
// the tag. `noReaderMode.test.ts` enforces that over this whole folder, which is also why the
// NDEF codec is imported by its own path — `shared/nfc/index.ts` re-exports the attendee's
// reader alongside it, and a gate that opened a reader session would kill the attendee's tap.
import { Hce, fromBase64, toBase64 } from '@monti/hce-android';
import type { GateCodeWire, GateResponseWire } from '@monti/shared';

import { encodeGateCodeMessage } from '../../shared/nfc/ndef';
import { GATE_CODE_ROTATE_MS, MONTI_AID } from '../constants';
import { decodeTapResponse, matchIssuedCode } from './decodeResponse';
import { buildGateCode, isGateCodeFresh } from './gateCode';
import { ensureGateKey } from './gateKey';

/** The two ways a write reaches the gate and turns out not to be a check-in. */
export const GATE_TAP_ERROR = {
  /** Not a MONTI gate response: another app's tag, a tap that broke, or our own code echoed. */
  badTag: 'GATE_TAP_BAD_TAG',
  /**
   * A well-formed response naming a nonce this gate never served, or served so long ago that it
   * has fallen out of the ring. The answer cannot be turned into a check-in `Ticket.checkIn`
   * would accept, so it is refused here rather than queued as a transaction that can only ever
   * revert with `CodeExpired`.
   */
  noLiveCode: 'GATE_TAP_NO_LIVE_CODE',
} as const;

export type GateTapErrorCode = (typeof GATE_TAP_ERROR)[keyof typeof GATE_TAP_ERROR];

export class GateTapError extends Error {
  readonly code: GateTapErrorCode;

  constructor(code: GateTapErrorCode, options?: { cause?: unknown }) {
    super(code, options);
    this.name = 'GateTapError';
    this.code = code;
  }
}

export interface GateTap {
  response: GateResponseWire;
  /**
   * The code this response answers — the ring entry whose `nonce` the response names.
   *
   * `GateResponseWire` v2 carries that nonce precisely so this is a lookup and not a guess. It
   * has to be: the plugin applies a payload swap only between taps (Task 5), so a write landing
   * just after a rotation answers the code *before* it, and the gate cannot see which side of
   * the swap the read fell on. Before the nonce the only way to tell was to try every live code
   * against the snapshot's device key; now the answer says which one it is, and a nonce this
   * gate never served is a `noLiveCode` refusal rather than a transaction that can only revert.
   */
  code: GateCodeWire;
}

export interface StartGateEmitterParams {
  gateId: bigint;
  eventId: bigint;
  /** One completed tap. Runs on the plugin's event; a throw is reported, not re-raised. */
  onTap: (tap: GateTap) => void;
  /**
   * Everything that went wrong without stopping the gate: a write that was not an answer
   * (`GateTapError`), or a swap the plugin refused. Nothing is retried and nothing is shown
   * unless this is passed — a gate that cannot say "that was not a MONTI tag" leaves the staff
   * watching an attendee tap a phone that is listening perfectly well.
   */
  onError?: (error: unknown) => void;
}

export interface GateEmitter {
  /** Releases the AID and clears the ring. The plugin empties the served file itself. */
  stop(): Promise<void>;
  /** The code on the wire, or `undefined` before the first rotation and after `stop()`. */
  lastCode(): GateCodeWire | undefined;
}

/**
 * Turns the HCE on and keeps a fresh code in front of it.
 *
 * The order matters at both ends. The write listener goes on before the AID is claimed, so a
 * tap cannot land in the gap and be lost; and if the claim is refused the listener comes back
 * off before the rejection is re-raised, because `HcePlugin.start` leaves card emulation off in
 * that case — there is no degraded mode to fall into, and the caller has to show a persistent
 * warning rather than believe the gate is open.
 *
 * The key is resolved once. It is minted under a single alias and registering a different one
 * on chain cannot be undone, so it cannot change under a running gate; asking the Keystore for
 * it again on every rotation would be one more bridge call per 3 seconds that can only fail.
 */
export async function startGateEmitter(params: StartGateEmitterParams): Promise<GateEmitter> {
  const key = await ensureGateKey();
  let ring: GateCodeWire[] = [];
  let stopped = false;

  const report = (error: unknown): void => params.onError?.(error);


  /**
   * Decoding and the nonce lookup are Task 19's (`decodeResponse.ts`); this only decides what a
   * refusal means to a gate that has to keep running. The two error surfaces stay separate on
   * purpose: `ResponseDecodeError` is about one answer, `GateTapError` is about one tap at this
   * plugin boundary, and a caller of `startGateEmitter` should not have to know the first one.
   */
  const onWrite = (event: { ndef: string }): void => {
    // A write dispatched before `remove()` landed is a tap at a gate that is already closed.
    if (stopped) return;
    let response: GateResponseWire;
    let code: GateCodeWire;
    try {
      response = decodeTapResponse(fromBase64(event.ndef));
    } catch (cause) {
      report(new GateTapError(GATE_TAP_ERROR.badTag, { cause }));
      return;
    }
    try {
      code = matchIssuedCode({ response, codes: ring });
    } catch (cause) {
      // Every refusal from the match means the same thing here — a MONTI answer that cannot
      // become a check-in this gate would send. Which one it was (unknown nonce, expired code,
      // a signature the chain would reject) is on `cause` as the `ResponseDecodeError`, along
      // with the DENY screen it becomes, so nothing is lost by naming the class of failure.
      report(new GateTapError(GATE_TAP_ERROR.noLiveCode, { cause }));
      return;
    }
    // `onTap` runs on the plugin's event dispatch. A throw from a caller's handler would
    // escape into Android's listener loop, where nothing catches it and the gate can be left
    // without a working write listener — so it is reported like any other tap failure instead.
    try {
      params.onTap({ response, code });
    } catch (cause) {
      report(cause);
    }
  };

  const handle = await Hce.addListener('write', onWrite);
  try {
    await Hce.start({ aid: MONTI_AID });
  } catch (cause) {
    await handle.remove();
    throw cause;
  }

  /**
   * A code enters the ring only once the plugin has taken it. A swap that failed never reached
   * the wire, so nobody can have read it, and offering it as an answer's candidate would send a
   * check-in signed over bytes no attendee ever saw.
   *
   * `stopped` is re-read after **every** await, and that is not defensive noise: both of them
   * cross a bridge to Android, so `stop()` can land in either gap. Without the first check a
   * gate that has released its AID would still push a payload into the plugin's NDEF file;
   * without the second it would repopulate the ring `stop()` had just emptied, and the next
   * `lastCode()` would name a code no reader can be served.
   */
  const rotate = async (): Promise<void> => {
    if (stopped) return;
    const code = await buildGateCode({ gateId: params.gateId, eventId: params.eventId, key });
    if (stopped) return;
    await Hce.setPayload({ ndef: toBase64(encodeGateCodeMessage(code)) });
    if (stopped) return;
    const nowSeconds = Math.floor(Date.now() / 1000);
    ring = [code, ...ring.filter((older) => isGateCodeFresh(older, nowSeconds))];
  };

  await rotate();
  const timer = setInterval(() => {
    rotate().catch(report);
  }, GATE_CODE_ROTATE_MS);

  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      ring = [];
      await handle.remove();
      await Hce.stop();
    },
    lastCode: () => ring[0],
  };
}
