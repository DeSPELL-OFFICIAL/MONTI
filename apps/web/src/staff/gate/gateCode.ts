// The gate's one-time number: built here, signed by the gate key, rotated by the emitter.
//
// Every byte of it is already defined somewhere else, and that is the point. The four signed
// fields and their order are `@monti/shared`'s `gateCodePreimage`; the digest over them is its
// `gateCodeHash`; the signature is Task 11's `signGateCode`, which hands the chip the raw digest
// and normalises `s` on the way back. This module only decides the two things nobody else can:
// when the code was stamped, and what the nonce is.
import { bytesToHex, type Hex } from 'viem';
import { gateCodeHash, joinRs, type GateCodeDigestInput, type GateCodeWire } from '@monti/shared';

import { CLOCK_SKEW_SECONDS, CODE_WINDOW_SECONDS } from '../constants';
import { ensureGateKey, gateKeyCoordinates, signGateCode, type GatePublicKey } from './gateKey';

/** The four fields the gate key signs, spelled as they sit on the wire. */
export type GateCodeFields = Pick<GateCodeWire, 'gateId' | 'eventId' | 'issuedAt' | 'nonce'>;

/** Wire spelling (decimal strings, a number) → the `uint256`/`uint64` the preimage encodes. */
function digestInput(fields: GateCodeFields): GateCodeDigestInput {
  return {
    gateId: BigInt(fields.gateId),
    eventId: BigInt(fields.eventId),
    issuedAt: BigInt(fields.issuedAt),
    nonce: fields.nonce,
  };
}

/**
 * What the gate key signs: `sha256(abi.encode(gateId, eventId, issuedAt, nonce))`. Identical to
 * the attendee's `gateCodeDigest`, because both are this one call into `@monti/shared` — a
 * second spelling of these bytes is every tap failing with a signature that will not verify.
 */
export function gateCodeDigest(fields: GateCodeFields): Hex {
  return gateCodeHash(digestInput(fields));
}

/**
 * 32 bytes straight from the CSPRNG. `Ticket.checkIn` burns `keccak256(abi.encode(nonce))`, so
 * the nonce is what makes a code single-use on chain: a repeat cannot admit a second person, it
 * reverts as a replay. At one code every 3 seconds a 256-bit draw never collides.
 */
function randomNonce(): Hex {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
}

export interface BuildGateCodeParams {
  gateId: bigint;
  eventId: bigint;
  /** Milliseconds. The terminal's clock is assumed NTP-synced (spec §7.3). */
  now?: number;
  /**
   * The gate key, when the caller already holds it. The emitter resolves it once at start
   * rather than crossing the Keystore bridge on every rotation for an answer that cannot change
   * — the alias is minted once and re-registering it on chain is irreversible.
   */
  key?: GatePublicKey;
}

export async function buildGateCode(params: BuildGateCodeParams): Promise<GateCodeWire> {
  const key = params.key ?? (await ensureGateKey());
  const fields: GateCodeFields = {
    gateId: params.gateId.toString(),
    eventId: params.eventId.toString(),
    issuedAt: Math.floor((params.now ?? Date.now()) / 1000),
    nonce: randomNonce(),
  };
  const { r, s } = await signGateCode(digestInput(fields));
  return { v: 1, ...fields, ...gateKeyCoordinates(key), sig: joinRs(r, s) };
}

/**
 * Whether `Ticket.checkIn` would still take this code. Its two clock checks are: a stamp more
 * than `CLOCK_SKEW` ahead of chain time is a forgery, and one `CODE_WINDOW` behind it a replay.
 *
 * The lower edge is relaxed by the skew as well. The gate's own clock is what stamped
 * `issuedAt`, and it may sit anywhere inside that skew of the chain's; holding a code slightly
 * too long costs at most one `CodeExpired` the staff sees as "다시 대세요", while dropping one
 * the chain would still have taken loses a real attendee's entry with no way to get it back.
 */
export function isGateCodeFresh(code: Pick<GateCodeWire, 'issuedAt'>, nowSeconds: number): boolean {
  if (code.issuedAt > nowSeconds + CLOCK_SKEW_SECONDS) return false;
  return code.issuedAt + CODE_WINDOW_SECONDS + CLOCK_SKEW_SECONDS > nowSeconds;
}
