// The gate, running. One AID claim, a new one-time code every 3 seconds, and every completed
// tap handed on as a response paired with the code it answers.
//
// This file never calls an NFC reader API and never will (spec §11, §18): the staff phone is
// the tag. `noReaderMode.test.ts` enforces that over this whole folder, which is also why the
// NDEF codec is imported by its own path — `shared/nfc/index.ts` re-exports the attendee's
// reader alongside it, and a gate that opened a reader session would kill the attendee's tap.
import { Hce, fromBase64, toBase64 } from '@monti/hce-android';
import type { GateCodeWire, GateResponseWire } from '@monti/shared';

import { decodeGateResponseMessage, encodeGateCodeMessage } from '../../shared/nfc/ndef';
import { GATE_CODE_ROTATE_MS, MONTI_AID } from '../constants';
import { buildGateCode, isGateCodeFresh } from './gateCode';
import { ensureGateKey } from './gateKey';

/** The two ways a write reaches the gate and turns out not to be a check-in. */
export const GATE_TAP_ERROR = {
  /** Not a MONTI gate response: another app's tag, a tap that broke, or our own code echoed. */
  badTag: 'GATE_TAP_BAD_TAG',
  /**
   * A well-formed response, but no code this gate served is still inside the chain's window.
   * The answer cannot be turned into a check-in `Ticket.checkIn` would accept, so it is refused
   * here rather than queued as a transaction that can only ever revert with `CodeExpired`.
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
   * The codes this response can be an answer to, newest first and never empty.
   *
   * Why more than one: `GateResponseWire` is `{ v, tokenId, deviceSig }` — it carries no nonce,
   * so the response itself cannot name the code it answers. The plugin applies a payload swap
   * only between taps (Task 5), so a write landing just after a rotation answers the code
   * before it, and the gate has no way to see which side of the swap the read fell on. Every
   * code still inside the chain's window is therefore offered; the sender picks the one whose
   * `deviceSig` verifies against the device key the snapshot holds for this `tokenId`, which is
   * the same P-256 check `Ticket.checkIn` runs. Offering only the newest would refuse real
   * attendees at a rate the gate could never explain.
   */
  codes: GateCodeWire[];
}

export interface StartGateEmitterParams {
  gateId: bigint;
  eventId: bigint;
  /** One completed tap. Runs on the plugin's event, so it must not throw. */
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

  /** Newest first, and only what `Ticket.checkIn` would still take. */
  const live = (): GateCodeWire[] => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    return ring.filter((code) => isGateCodeFresh(code, nowSeconds));
  };

  const onWrite = (event: { ndef: string }): void => {
    // A write dispatched before `remove()` landed is a tap at a gate that is already closed.
    if (stopped) return;
    let response: GateResponseWire;
    try {
      response = decodeGateResponseMessage(fromBase64(event.ndef));
    } catch (cause) {
      report(new GateTapError(GATE_TAP_ERROR.badTag, { cause }));
      return;
    }
    const codes = live();
    if (codes.length === 0) {
      report(new GateTapError(GATE_TAP_ERROR.noLiveCode));
      return;
    }
    params.onTap({ response, codes });
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
   */
  const rotate = async (): Promise<void> => {
    const code = await buildGateCode({ gateId: params.gateId, eventId: params.eventId, key });
    await Hce.setPayload({ ndef: toBase64(encodeGateCodeMessage(code)) });
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
