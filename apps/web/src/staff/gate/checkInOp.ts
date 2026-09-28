// The check-in, submitted through the MONTI relayer.
//
// The gate no longer sends its own transaction. It signs the code — unchanged, that is
// `gateCode.ts` — and hands the signed tuple to `relayCheckIn`, a callable that simulates
// `checkInFor` (or `checkInForLate`) off chain, and, if the simulation passes, submits it from the
// relayer's own EOA. There is no gate smart account here any more, no paymaster and no bundler:
// the relayer pays the gas and the two signatures carry the authority — the gate's over the code
// (verified on chain against `Organizers.gateInfo`), the attendee's over the digest.
//
// What this module owns is small and deliberate: refuse to build a mismatched pair, shape the wire
// payload the frozen callable contract takes, and hand back its answer. The verdict — PASS now,
// and `confirmed`/`failed` a moment later — is the caller's to render from that answer and from the
// `relays/{relayId}` document the relayer writes; see `useGate.ts` and `relayStatus.ts`.
import type { GateCodeWire, GateResponseWire } from '@monti/shared';

import { relayCheckIn as callRelayCheckIn, type RelayCheckInResponse } from '../../shared/api/functions';

/**
 * What the relayer answers. `status: 'sent'` is a transaction broadcast (the simulation passed);
 * `status: 'confirmed'` is one already mined — and the backend also answers `confirmed` for a
 * ticket that was already checked in (`AlreadyCheckedIn` is idempotent success, not a refusal),
 * which is what lets the offline queue's late replay count a re-submission as done. `usedAt` is
 * set on that path and on a confirmed mine; `txHash` on anything that reached the chain.
 */
export type RelayCheckInResult = RelayCheckInResponse;

export interface RelayCheckInParams {
  code: GateCodeWire;
  response: GateResponseWire;
  /**
   * The offline queue's drain sets this: the relayer submits `checkInForLate` instead of
   * `checkInFor`, so a tap taken while the gate had no signal still lands after the code window.
   */
  late?: boolean;
}

/**
 * Submits one check-in through the relayer.
 *
 * The nonce match is refused here rather than left to the backend for the same reason the old
 * sponsored path refused it: a code and an answer that are not a pair can only produce a
 * `BadDeviceSignature` revert, and the chain recomputes the digest from these exact values. Better
 * to refuse to send it than to burn a simulation on a tuple that cannot verify.
 *
 * `code.sig` is the gate's P-256 signature over `sha256(abi.encode(gateId, eventId, issuedAt,
 * nonce))`, already r‖s (64 bytes) from `joinRs` in `gateCode.ts`; the wire spells `issuedAt` as a
 * decimal string, the one field `GateCodeWire` carries as a number.
 */
export async function relayCheckIn({ code, response, late = false }: RelayCheckInParams): Promise<RelayCheckInResult> {
  if (code.nonce !== response.nonce) throw new Error('CHECK_IN_CODE_MISMATCH');
  return callRelayCheckIn({
    tokenId: response.tokenId,
    code: {
      gateId: code.gateId,
      eventId: code.eventId,
      issuedAt: String(code.issuedAt),
      nonce: code.nonce,
    },
    gateSig: code.sig,
    deviceSig: response.deviceSig,
    late,
  });
}
