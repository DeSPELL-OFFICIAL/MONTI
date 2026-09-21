// Entry, step 2 (spec §7.2 steps 4-6): the phone signs the gate's code and hands the answer
// back inside the same NFC session that read it, or — when there is no session to be had — as
// a code on screen carrying the identical bytes.
//
// Two invariants hold this file together, and both are about what the chain will accept:
//
//   1. the digest is byte-identical to the one `Ticket.checkIn` recomputes. It is never built
//      here — `@monti/shared` owns both forms and one line there says which one this build
//      signs, so the day 01b redeploys, the signer, the verifier and the QR move together;
//   2. `s` is in the low half of the curve order. Solady's `P256.verifySignature` rejects the
//      high half outright, and roughly half of all real signatures land there. The plugin
//      already normalises; this file checks anyway, because the cost of being wrong is an
//      attendee standing at a door with a signature no contract will take.
//
// Nothing is handed over before the signature has been verified locally against the device key
// the chain has on file. That catches a wrong alias or a key that was rotated on another phone
// in about a millisecond, on the attendee's screen, instead of as a silent revert.
import { hexToBytes, type Hex } from 'viem';
import {
  P256_HALF_ORDER,
  base64UrlEncode,
  deviceDigest,
  deviceDigestPreimage,
  isGateResponseWire,
  joinRs,
  type GateCodeWire,
  type GateResponseWire,
} from '@monti/shared';
import {
  ATTENDEE_KEY_ALIAS,
  DEVICE_KEY_ERROR,
  DeviceKeyUnavailable,
  deviceKeyErrorCode,
  signWithDeviceKey,
} from '../../shared/deviceKey';
import { NFC_ERROR, NfcError } from '../../shared/nfc';
import { readIdentity } from '../../shared/chain/reads';
import { getConfig } from '../../shared/config';
import { getSession } from '../../shared/session';
import type { ArmState, PhaseEnding } from './useArm';
import { tapEnding } from './useArm';
import { verifyGate, type GateFailure } from './verifyGate';

/** Every way the hand-over can end badly. Each has its own ko+en sentence. */
export type HandOverFailure =
  | 'armExpired'
  | 'signFailed'
  | 'keyInvalidated'
  | 'deviceMismatch'
  | 'deviceUnavailable';

export class HandOverError extends Error {
  readonly reason: HandOverFailure;

  constructor(reason: HandOverFailure) {
    super(reason);
    this.name = 'HandOverError';
    this.reason = reason;
  }
}

/**
 * The plugin's typed rejections, as this screen's reasons.
 *
 * `USER_CANCELLED` is the lapsed arm window: both backends re-raise the biometric when the 60 s
 * is up, so a window that closed reaches here as a prompt the holder did not answer. Spec §7.3
 * is explicit that nothing re-arms on its own — it goes back to the button.
 */
const SIGN_REASON: Record<string, HandOverFailure> = {
  [DEVICE_KEY_ERROR.userCancelled]: 'armExpired',
  [DEVICE_KEY_ERROR.keyInvalidated]: 'keyInvalidated',
  [DEVICE_KEY_ERROR.unavailable]: 'deviceUnavailable',
  [DEVICE_KEY_ERROR.keyNotFound]: 'deviceMismatch',
  [DEVICE_KEY_ERROR.invalidArgument]: 'signFailed',
  [DEVICE_KEY_ERROR.keyGenerationFailed]: 'signFailed',
  [DEVICE_KEY_ERROR.signFailed]: 'signFailed',
};

function asHandOverError(cause: unknown): HandOverError {
  if (cause instanceof HandOverError) return cause;
  if (cause instanceof DeviceKeyUnavailable) return new HandOverError('deviceUnavailable');
  const code = deviceKeyErrorCode(cause);
  return new HandOverError((code && SIGN_REASON[code]) ?? 'signFailed');
}

export interface DigestInput {
  tokenId: string;
  gateCode: GateCodeWire;
}

/** The chain and the deployment the signature is bound to, from config — never hardcoded. */
function digestFields(input: DigestInput) {
  const config = getConfig();
  return {
    chainId: BigInt(config.chainId),
    ticket: config.addresses.ticket,
    tokenId: BigInt(input.tokenId),
    gateId: BigInt(input.gateCode.gateId),
    eventId: BigInt(input.gateCode.eventId),
    nonce: input.gateCode.nonce,
    issuedAt: BigInt(input.gateCode.issuedAt),
  };
}

/** The 32 bytes the secure element signs, byte-identical to what `Ticket.checkIn` recomputes. */
export function deviceSigDigest(input: DigestInput): Hex {
  return deviceDigest(digestFields(input));
}

/**
 * The bytes that hash to {@link deviceSigDigest}. WebCrypto's ECDSA hashes the message it is
 * given rather than taking a digest, so the local verify below is handed this instead.
 */
export function deviceSigMessage(input: DigestInput): Hex {
  return deviceDigestPreimage(digestFields(input));
}

/**
 * The last check before anything leaves the phone: does the signature verify against the key
 * `Identity.activeDevice` has for this account? A wrong alias, or a key rotated on another
 * phone, is otherwise invisible until `Ticket.checkIn` reverts with the staff watching.
 *
 * A chain that cannot be reached is not a refusal — the chain still verifies on the way in, and
 * an attendee in a basement must not be stopped by a check that exists only to be quicker. A
 * chain that *answers* with a different key is a refusal.
 */
async function assertOurOwnDevice(wire: GateResponseWire, message: Hex): Promise<void> {
  const account = getSession().account;
  if (!account) return;
  let point: { x: Hex; y: Hex };
  try {
    point = await readIdentity().activeDevice(account);
  } catch {
    return;
  }
  if (/^0x0+$/.test(point.x) && /^0x0+$/.test(point.y)) return;

  const bytes = (hex: Hex): Uint8Array<ArrayBuffer> => Uint8Array.from(hexToBytes(hex));
  let ok = false;
  try {
    const key = await crypto.subtle.importKey(
      'jwk',
      {
        kty: 'EC',
        crv: 'P-256',
        x: base64UrlEncode(bytes(point.x)),
        y: base64UrlEncode(bytes(point.y)),
        ext: true,
      },
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, bytes(wire.deviceSig), bytes(message));
  } catch {
    ok = false;
  }
  if (!ok) throw new HandOverError('deviceMismatch');
}

/**
 * The signed answer, ready for either hand-over. `deviceSig` is `abi.encode(r, s)` — two 32-byte
 * words, which for two `bytes32` is exactly `r || s`, the 64 bytes `Ticket.checkIn` decodes.
 */
export async function buildGateResponse(tokenId: string, gateCode: GateCodeWire): Promise<GateResponseWire> {
  const fields = { tokenId, gateCode };
  let signature: { r: Hex; s: Hex };
  try {
    signature = await signWithDeviceKey(deviceSigDigest(fields), { alias: ATTENDEE_KEY_ALIAS });
  } catch (cause) {
    throw asHandOverError(cause);
  }
  // Solady's verifier rejects the high half outright; a signature that reached here high-s means
  // the normaliser was bypassed, and sending it would be a revert the attendee cannot explain.
  if (BigInt(signature.s) > P256_HALF_ORDER) throw new HandOverError('signFailed');

  const wire: GateResponseWire = { v: 1, tokenId, deviceSig: joinRs(signature.r, signature.s) };
  if (!isGateResponseWire(wire)) throw new HandOverError('signFailed');
  await assertOurOwnDevice(wire, deviceSigMessage(fields));
  return wire;
}

/** A failed hand-over, as a phase. Only a lapsed window goes back to the button. */
export function handOverEnding(cause: unknown): PhaseEnding {
  const { reason } = asHandOverError(cause);
  if (reason === 'armExpired') return { phase: 'idle', error: 'expired' };
  if (reason === 'deviceUnavailable') return { phase: 'qr', error: 'deviceUnavailable' };
  return { phase: 'failed', error: reason };
}

/** A gate the three Task 24 layers refused, raised out of the in-session callback. */
export class GateRefused extends Error {
  readonly reason: GateFailure;

  constructor(reason: GateFailure) {
    super(reason);
    this.name = 'GateRefused';
    this.reason = reason;
  }
}

export interface TapSigner {
  tokenId: string;
  setState: (update: (prev: ArmState) => ArmState) => void;
  /** The arm window this tap belongs to, and the question that says it is still open. */
  armedAt: number;
  isCurrent: (armedAt: number) => boolean;
  /** Called the moment the code is read, so the QR fallback can answer the same one. */
  onGateCode: (code: GateCodeWire) => void;
}

/**
 * The body of the one NFC session (spec §7.2 steps 3-5). `readThenWrite` opens the session,
 * reads the gate's record, calls this, and writes what it returns to the **same** tag before
 * ending the session — so everything here happens while the two phones are still touching.
 *
 * Which is why nothing in here may prompt: the biometric was already answered before the
 * session opened, and `verifyGate`'s chain read carries its own budget so a slow RPC cannot
 * eat the session. A refusal or a failed signature throws, which tears the session down
 * without writing anything.
 */
export function tapSigner({ tokenId, setState, armedAt, isCurrent, onGateCode }: TapSigner) {
  return async (gateCode: GateCodeWire): Promise<GateResponseWire> => {
    const started = performance.now();
    // The countdown may have expired while the reader was waiting for a tag. Throwing ends the
    // session instead of signing into a window the secure chip has already closed.
    if (!isCurrent(armedAt)) throw new NfcError(NFC_ERROR.cancelled);
    onGateCode(gateCode);

    setState((prev) => ({ ...prev, phase: 'verifying', error: '' }));
    const verdict = await verifyGate(gateCode, { tokenId });
    if (!verdict.ok) throw new GateRefused(verdict.reason);
    if (!isCurrent(armedAt)) throw new NfcError(NFC_ERROR.cancelled);

    setState((prev) => ({ ...prev, phase: 'signing', error: '' }));
    const wire = await buildGateResponse(tokenId, gateCode);
    if (!isCurrent(armedAt)) throw new NfcError(NFC_ERROR.cancelled);

    setState((prev) => ({ ...prev, phase: 'writing', error: '' }));
    if (import.meta.env.DEV && import.meta.env.MODE !== 'test') {
      // The budget that matters: Android's HCE tag is up only while the phones touch.
      console.info(`[enter] in-session verify+sign ${Math.round(performance.now() - started)}ms`);
    }
    return wire;
  };
}

/**
 * How a tap that did not end in a write is reported. The QR is a fallback, not a default: it is
 * offered when this phone cannot tap at all, and when a session that had already read a code
 * died before the write — there the code and the signature exist and a scanner can still take
 * them. A session that died before any code arrived has nothing to show, so it keeps Task 24's
 * sentence and the button.
 */
export function tapFailure(cause: unknown, hasGateCode: boolean): PhaseEnding {
  if (cause instanceof GateRefused) return { phase: 'failed', error: cause.reason };
  // Checked before the device-key codes: `NfcError` is how the session itself reports an
  // ending, and `asHandOverError` would flatten every one of them into `signFailed`.
  if (cause instanceof NfcError) {
    const ending = tapEnding(cause);
    return ending.phase === 'qr' || !hasGateCode ? ending : { phase: 'qr', error: 'writeFailed' };
  }
  if (cause instanceof HandOverError || cause instanceof DeviceKeyUnavailable || deviceKeyErrorCode(cause)) {
    return handOverEnding(cause);
  }
  return hasGateCode ? { phase: 'qr', error: 'writeFailed' } : { phase: 'failed', error: 'tapFailed' };
}
