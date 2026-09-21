// The tap, read back: the attendee's answer turned into something this gate can act on.
//
// Two halves, and neither of them admits anybody. The first is decoding, and it is deliberately
// thin — the NDEF framing is Task 9's codec and the CBOR is `@monti/shared`'s, so not one byte
// of the wire is spelled again here. What this module adds is the gate's vocabulary for a
// refusal: one error type carrying the code that says what happened and, where the attendee
// should be shown something, the DENY screen it becomes.
//
// The second half is the match. `GateResponseWire` v2 names the `nonce` of the code it answers,
// and that field exists for exactly this: the gate serves a new code every 3 seconds and the
// HCE plugin swaps the served payload only *between* taps (Task 5), so a write landing just
// after a rotation answers the code *before* it and the gate cannot see which side of the swap
// the read fell on. With the nonce the match is a lookup. Without it the gate would have to try
// every live code against the snapshot's device key and guess, and a wrong guess is a
// `BadDeviceSignature` revert with a real attendee standing at the door.
//
// What this module does NOT do is verify the device signature. Online the chain is the judge;
// offline Task 27 verifies it against the device key the snapshot holds for this `tokenId`.
// The one signature check here is a shape check — see `assertSignatureShape`.
import { p256 } from '@noble/curves/p256';

import { fromQrPayload, splitRs, type GateCodeWire, type GateResponseWire } from '@monti/shared';

import { decodeGateResponseMessage } from '../../shared/nfc/ndef';
import type { DenyCode } from '../types';
import { isGateCodeFresh } from './gateCode';

/**
 * Why each refusal gets its own code rather than one "bad tap": they mean different things to
 * whoever reads the field report. `badTag` is somebody else's tag or a tap that broke.
 * `unknownCode` is an answer to a code this gate never served — a different gate's code, or a
 * replay. `codeExpired` is an answer to a code this gate *did* serve, too long ago. One code
 * for all three would hide the difference at the only moment it matters.
 */
export const RESPONSE_ERROR = {
  /** Not a MONTI gate response: another app's tag, a broken tap, or a build older than v2. */
  badTag: 'RESPONSE_BAD_TAG',
  /** Well-formed, but names a nonce this gate has no record of serving. */
  unknownCode: 'RESPONSE_UNKNOWN_CODE',
  /** Names a code this gate served, past the window `Ticket.checkIn` would still accept. */
  codeExpired: 'RESPONSE_CODE_EXPIRED',
  /** The `deviceSig` is not a signature the chain could accept — see `assertSignatureShape`. */
  badSignature: 'RESPONSE_BAD_SIGNATURE',
} as const;

export type ResponseErrorCode = (typeof RESPONSE_ERROR)[keyof typeof RESPONSE_ERROR];

/**
 * A tap that cannot become a check-in.
 *
 * `deny` is the screen the attendee is shown, and it is **optional on purpose**: a tag that was
 * never ours produces no verdict at all — the gate stays ready and the staff sees a note,
 * because flashing a red refusal at whoever happened to wave a transit card past the phone is a
 * queue the gate created for itself.
 */
export class ResponseDecodeError extends Error {
  readonly code: ResponseErrorCode;
  readonly deny?: DenyCode;

  constructor(code: ResponseErrorCode, deny?: DenyCode, options?: { cause?: unknown }) {
    super(code, options);
    this.name = 'ResponseDecodeError';
    this.code = code;
    if (deny) this.deny = deny;
  }
}

/** Framing and CBOR are `@monti/shared`'s; the refusal is wrapped so a caller catches one type. */
export function decodeTapResponse(message: Uint8Array): GateResponseWire {
  try {
    return decodeGateResponseMessage(message);
  } catch (cause) {
    throw new ResponseDecodeError(RESPONSE_ERROR.badTag, undefined, { cause });
  }
}

/**
 * The iPhone-browser path: the same CBOR the NDEF record would have carried, base64url inside
 * `MONTI1:`. `fromQrPayload` owns the prefix and the decoding, so a QR and a tap cannot come to
 * mean different things.
 */
export function decodeQrResponse(text: string): GateResponseWire {
  try {
    return fromQrPayload(text);
  } catch (cause) {
    throw new ResponseDecodeError(RESPONSE_ERROR.badTag, undefined, { cause });
  }
}

const HALF_ORDER = p256.CURVE.n / 2n;

/**
 * The only thing checked about the signature here, and it is arithmetic rather than
 * cryptography: `r` and `s` inside the curve order, and `s` in the low half.
 *
 * Solady's `P256.verifySignature` — what `Ticket.checkIn` calls — returns false on a high `s`
 * before it verifies anything, so such an answer can only ever revert. Refusing it locally
 * costs the attendee one re-tap instead of a transaction, a paymaster charge and five seconds
 * of standing still. `signWithDeviceKey` already normalises `s`, so a high one means the
 * attendee's build does not — which is worth seeing as `DEVICE_MISMATCH` rather than as a
 * mystery revert.
 */
function assertSignatureShape(deviceSig: GateResponseWire['deviceSig']): void {
  const bad = (cause?: unknown): never => {
    throw new ResponseDecodeError(RESPONSE_ERROR.badSignature, 'DEVICE_MISMATCH', { cause });
  };
  let r: bigint;
  let s: bigint;
  try {
    const parts = splitRs(deviceSig);
    r = BigInt(parts.r);
    s = BigInt(parts.s);
  } catch (cause) {
    return bad(cause);
  }
  if (r <= 0n || r >= p256.CURVE.n) return bad();
  if (s <= 0n || s > HALF_ORDER) return bad();
}

export interface MatchIssuedCodeParams {
  response: GateResponseWire;
  /** Every code this gate has served and not yet forgotten — the emitter's ring (Task 17). */
  codes: readonly GateCodeWire[];
  /** Milliseconds. The terminal's clock is assumed NTP-synced (spec §7.3). */
  now?: number;
}

/**
 * The code this answer belongs to, or a typed refusal — decided entirely locally, before any
 * chain call is made or any transaction is paid for.
 *
 * The freshness test is `isGateCodeFresh`, which is `Ticket.checkIn`'s own two clock checks
 * (Task 16) and not a second reading of the window: a code this gate would accept and the chain
 * would not is a check-in that can only revert, and one the chain would accept and this gate
 * would not is a real attendee turned away.
 */
export function matchIssuedCode(params: MatchIssuedCodeParams): GateCodeWire {
  assertSignatureShape(params.response.deviceSig);

  const served = params.codes.find((code) => code.nonce === params.response.nonce);
  if (!served) {
    // Another gate's code, a replay, or this gate restarted since it was served. The attendee
    // is asked to tap again, because the one thing that is certainly true is that this gate
    // cannot turn the answer into a check-in.
    throw new ResponseDecodeError(RESPONSE_ERROR.unknownCode, 'EXPIRED_CODE');
  }

  const nowSeconds = Math.floor((params.now ?? Date.now()) / 1000);
  if (!isGateCodeFresh(served, nowSeconds)) {
    throw new ResponseDecodeError(RESPONSE_ERROR.codeExpired, 'EXPIRED_CODE');
  }
  return served;
}
