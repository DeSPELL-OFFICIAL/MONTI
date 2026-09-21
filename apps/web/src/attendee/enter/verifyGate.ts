// Spec §7.2 step 3 — the phone decides whether a gate is real BEFORE it signs anything.
//
// Threat T14 is a fake gate: a phone in someone's pocket that emits a well-formed code and
// collects device signatures. A signature that verifies against the key inside the code proves
// only that whoever wrote the code also wrote the key, so the check here is two-layered and the
// layers must stay in this order:
//
//   1. the code is fresh (no chain call, so a replayed code costs the attendee nothing);
//   2. the chain says gate `gateId` is registered, open, unrevoked, and belongs to the same
//      event as this ticket — and hands back the (kx, ky) it registered;
//   3. the gate's signature verifies against THAT key. Never the one in the payload.
//
// The digest is `@monti/shared`'s `gateCodeHash`, the same bytes the staff device signs; the
// signature is checked through WebCrypto's ECDSA/P-256/SHA-256, which hashes the message
// itself, so it is handed `gateCodePreimage` rather than the digest. One definition, two uses.
import { hexToBytes, type Hex } from 'viem';
import {
  CLOCK_SKEW_SECONDS,
  CODE_WINDOW_SECONDS,
  base64UrlEncode,
  gateCodeHash,
  gateCodePreimage,
  type GateCodeWire,
} from '@monti/shared';
import { readOrganizers, readTicket } from '../../shared/chain/reads';

/** Every way a tap can be refused before a signature is made. Each has its own ko+en sentence. */
export type GateFailure = 'codeExpired' | 'unknownGate' | 'gateClosed' | 'wrongEvent' | 'badSignature';

export type GateVerdict = { ok: true } | { ok: false; reason: GateFailure };

/** The gate public key as the chain holds it: two bytes32 words, not a wire field. */
export interface GatePublicKey {
  kx: Hex;
  ky: Hex;
}

/** The registration layer answers with the key, so the signature layer cannot reach for another. */
export type GateRegistration = { ok: true; key: GatePublicKey } | { ok: false; reason: GateFailure };

const fail = (reason: GateFailure): { ok: false; reason: GateFailure } => ({ ok: false, reason });

/**
 * viem hands back `Uint8Array<ArrayBufferLike>`; WebCrypto's `BufferSource` wants a view over a
 * plain `ArrayBuffer`. `Uint8Array.from` copies into one — the arrays here are 32-96 bytes.
 */
function bytes(hex: Hex, size?: number): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(size === undefined ? hexToBytes(hex) : hexToBytes(hex, { size }));
}

function digestInput(wire: GateCodeWire) {
  return {
    gateId: BigInt(wire.gateId),
    eventId: BigInt(wire.eventId),
    issuedAt: BigInt(wire.issuedAt),
    nonce: wire.nonce,
  };
}

/** What the gate key signed: `sha256(abi.encode(gateId, eventId, issuedAt, nonce))`. */
export function gateCodeDigest(wire: GateCodeWire): Hex {
  return gateCodeHash(digestInput(wire));
}

/**
 * `Ticket.checkIn` takes a code whose stamp is at most `CLOCK_SKEW` ahead of chain time and at
 * most `CODE_WINDOW` behind it. The phone's own clock is the one measuring here, and it may sit
 * anywhere inside that same skew, so the lower edge is relaxed by `CLOCK_SKEW` as well: a phone
 * running fast must not refuse a code the chain would still accept. The relaxed edge itself
 * (`now - CODE_WINDOW - CLOCK_SKEW`) is out — past it no honest clock explains the gap.
 */
export function isGateCodeFresh(wire: GateCodeWire, nowSeconds: number): boolean {
  if (wire.issuedAt > nowSeconds + CLOCK_SKEW_SECONDS) return false;
  return wire.issuedAt + CODE_WINDOW_SECONDS + CLOCK_SKEW_SECONDS > nowSeconds;
}

/**
 * WebCrypto wants the point as a JWK, which is base64url of the raw coordinates — the same
 * 32-byte words `Organizers.gateInfo` returns. An (x, y) that is not on the curve is rejected
 * by `importKey` itself, which is why the caller never has to validate one.
 */
function importGateKey(key: GatePublicKey): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'jwk',
    {
      kty: 'EC',
      crv: 'P-256',
      x: base64UrlEncode(bytes(key.kx, 32)),
      y: base64UrlEncode(bytes(key.ky, 32)),
      ext: true,
    },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  );
}

/**
 * Layer ①. `key` is the chain's, always: a caller that passed `{ kx: wire.kx, ky: wire.ky }`
 * would be verifying a forger's code against the forger's own key.
 *
 * WebCrypto ECDSA/SHA-256 hashes the message it is given, so it gets the preimage and arrives
 * at exactly `gateCodeDigest(wire)`. A malformed signature or key is a `false`, not a throw —
 * every refusal on this path is a sentence on the attendee's screen, never an exception.
 */
export async function verifyGateSignature(wire: GateCodeWire, key: GatePublicKey): Promise<boolean> {
  try {
    return await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      await importGateKey(key),
      bytes(wire.sig, 64),
      bytes(gateCodePreimage(digestInput(wire))),
    );
  } catch {
    return false;
  }
}

/**
 * Layer ②. An unregistered `gateId` reads back as the zero struct — `eventId` 0, `open` false —
 * so it is answered as unknown rather than closed: "this reader is shut" would tell an attendee
 * standing in front of a fake one to wait for it to open.
 *
 * The last check is the ticket's own: a real, open gate of event 11 must not admit a ticket for
 * event 12, and the code alone cannot say which event the ticket belongs to.
 */
export async function verifyGateRegistered(wire: GateCodeWire, tokenId: string): Promise<GateRegistration> {
  const eventId = BigInt(wire.eventId);
  const gate = await readOrganizers().gateInfo(BigInt(wire.gateId));
  if (gate.revoked || gate.eventId === 0n) return fail('unknownGate');
  if (!gate.open) return fail('gateClosed');
  if (gate.eventId !== eventId) return fail('wrongEvent');
  if ((await readTicket().eventOf(BigInt(tokenId))) !== eventId) return fail('wrongEvent');
  return { ok: true, key: { kx: gate.kx, ky: gate.ky } };
}

const GATE_CACHE_PREFIX = 'monti.gate.';

interface CachedGate extends GatePublicKey {
  eventId: string;
  tokenId: string;
}

/**
 * Spec §7.2: an attendee with no signal judges layer ② by the last `GateRegistered` value they
 * saw. What is kept is the chain's answer — the key the chain registered, next to the gate,
 * event and ticket it was verified for — never anything the code claimed about itself.
 */
export function cacheGate(wire: GateCodeWire, tokenId: string, key: GatePublicKey): void {
  const entry: CachedGate = { eventId: wire.eventId, tokenId, kx: key.kx, ky: key.ky };
  try {
    localStorage.setItem(`${GATE_CACHE_PREFIX}${wire.gateId}`, JSON.stringify(entry));
  } catch {
    /* private mode — the tap still works, it just cannot be repeated offline */
  }
}

export function cachedGateKey(wire: GateCodeWire, tokenId: string): GatePublicKey | null {
  try {
    const raw = localStorage.getItem(`${GATE_CACHE_PREFIX}${wire.gateId}`);
    if (!raw) return null;
    const cached = JSON.parse(raw) as CachedGate;
    if (cached.eventId !== wire.eventId || cached.tokenId !== tokenId) return null;
    return { kx: cached.kx, ky: cached.ky };
  } catch {
    return null;
  }
}

export interface GateCheckInput {
  tokenId: string;
  /** Unix seconds; defaults to this phone's clock. Passed in by tests and by a caller that froze it. */
  nowSeconds?: number;
}

/**
 * The whole of step 3, in the order the layers have to run. The cache is consulted only when the
 * chain read *throws* — a chain that answers "revoked" is the answer, and a stale cache must
 * never talk over it.
 */
export async function verifyGate(wire: GateCodeWire, input: GateCheckInput): Promise<GateVerdict> {
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (!isGateCodeFresh(wire, now)) return fail('codeExpired');

  const registration = await verifyGateRegistered(wire, input.tokenId).catch((): null => null);
  if (registration !== null && !registration.ok) return registration;
  const gateKey = registration?.ok ? registration.key : cachedGateKey(wire, input.tokenId);
  if (!gateKey) return fail('unknownGate');

  if (!(await verifyGateSignature(wire, gateKey))) return fail('badSignature');
  cacheGate(wire, input.tokenId, gateKey);
  return { ok: true };
}
