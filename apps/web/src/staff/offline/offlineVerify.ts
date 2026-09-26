// The gate, with no internet: checking the attendee's signature ourselves.
//
// `Ticket.checkIn` makes five checks (spec §7.2-6 ①~⑤) and the one this module stands in for is
// ② — the attendee's device key signed *this* gate's code. Every other check is a fact the
// signed snapshot already carries, and `offlineAdmit.ts` reads those. This file does the
// cryptography and nothing else.
//
// Two rules decide everything here:
//
// **The same bytes the chain hashes, from the same switch the attendee's phone reads.** The
// digest is `@monti/shared`'s `deviceDigest`, which dispatches on `DEVICE_DIGEST_FORM`: today
// the five-field form the deployed `Ticket.checkIn` recomputes, and the seven-field
// domain-separated form once sub-plan 01b redeploys `Ticket._deviceDigest`. Flipping that one
// line moves the attendee's signer and this verifier on the same day. Nothing here names either
// form, and a second spelling of these bytes would be every tap failing at a door with a
// signature that "does not verify" and no way to see why.
//
// **A pass here is not the chain's pass.** The queued transaction is verified again by
// `Ticket.checkIn` when the gate comes back online, which is exactly why a terminal cannot
// manufacture an entry (spec T15): it has no way to produce this signature. What it can do is
// admit someone the chain will later refuse — which is why the card this leads to says so, and
// why `offlineAdmit` is a separate outcome from the online green.
import { hexToBytes } from 'viem';

import { deviceDigest, deviceDigestPreimage, type DeviceDigestInput } from '@monti/shared';

import { getConfig } from '../../shared/config';
import type { DeviceKey } from '../snapshot/lookup';
import type { GateCodeWire, GateResponseWire, Hex } from '../types';

/**
 * The chain and the deployment a v2 signature is bound to. Carried as a parameter rather than
 * read at the call site so the digest has exactly one source for them — and so tests can pin
 * the cross-plan vector row without standing up the app's environment.
 *
 * The v1 form ignores both words. They are still required, because a caller that had to decide
 * which fields to pass would be deciding the digest form, and that decision lives in
 * `DEVICE_DIGEST_FORM` alone.
 */
export interface DeviceDigestDomain {
  chainId: bigint;
  ticket: Hex;
}

/** This build's chain and Ticket, from config — never hardcoded in a screen. */
export function configDomain(): DeviceDigestDomain {
  const config = getConfig();
  return { chainId: BigInt(config.chainId), ticket: config.addresses.ticket };
}

export interface CheckInDigestParams {
  /** The token the answer claims — `GateResponseWire.tokenId`. */
  tokenId: string;
  /** The code this gate served and the answer names (Task 19 matched them by nonce). */
  code: GateCodeWire;
  domain?: DeviceDigestDomain;
}

function digestInput({ tokenId, code, domain }: CheckInDigestParams): DeviceDigestInput {
  const { chainId, ticket } = domain ?? configDomain();
  return {
    chainId,
    ticket,
    tokenId: BigInt(tokenId),
    gateId: BigInt(code.gateId),
    eventId: BigInt(code.eventId),
    nonce: code.nonce,
    issuedAt: BigInt(code.issuedAt),
  };
}

/** The 32 bytes `Ticket.checkIn` recomputes for this tap. */
export function checkInDigest(params: CheckInDigestParams): Hex {
  return deviceDigest(digestInput(params));
}

/**
 * The bytes that hash to {@link checkInDigest}. WebCrypto's ECDSA takes a message and hashes it
 * itself rather than taking a digest, so the verify below is handed this — the same reason
 * `gateCodePreimage` is exported for the attendee's side of the tap.
 */
export function checkInMessage(params: CheckInDigestParams): Hex {
  return deviceDigestPreimage(digestInput(params));
}

export interface VerifyDeviceSignatureParams {
  /**
   * `deviceKeyOf(tokenId)` — Task 25's store, which answers `undefined` for a ticket whose key
   * the snapshot has cleared. That `undefined` must reach here: handing 32 zero bytes to a
   * verifier is how it comes back saying "valid".
   */
  deviceKey: DeviceKey | undefined;
  code: GateCodeWire;
  response: GateResponseWire;
  domain?: DeviceDigestDomain;
}

const bytes = (hex: Hex): Uint8Array<ArrayBuffer> => Uint8Array.from(hexToBytes(hex));

/**
 * Whether this tap was signed by the key the snapshot holds for this ticket.
 *
 * `false` for everything that is not a verified signature — a key that is not on the curve, a
 * `deviceSig` that is not 64 bytes, a cleared key — because at a door there is nothing useful
 * to do with the difference and a thrown error at this point is a gate that stops answering.
 * `decodeResponse` (Task 19) has already refused the shapes that are worth naming.
 */
export async function verifyDeviceSignatureOffline({
  deviceKey,
  code,
  response,
  domain,
}: VerifyDeviceSignatureParams): Promise<boolean> {
  if (!deviceKey) return false;
  try {
    const key = await crypto.subtle.importKey(
      'raw',
      bytes(`0x04${deviceKey.x.slice(2)}${deviceKey.y.slice(2)}`),
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    const message = checkInMessage({ tokenId: response.tokenId, code, domain });
    return await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      bytes(response.deviceSig),
      bytes(message),
    );
  } catch {
    return false;
  }
}
