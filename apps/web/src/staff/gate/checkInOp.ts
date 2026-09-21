// The check-in, as a sponsored user operation.
//
// Three things this module is careful about, and each of them is a door that stops working if
// it is got wrong.
//
// **Who sends it.** Always the gate's own smart account (Task 13), never the staff member's
// passkey account. `Ticket.checkIn` reads `organizers.gateOf(msg.sender)` and compares it with
// the `gateId` in the code, so a check-in signed by the person holding the phone reverts
// `GateMismatch` however correct everything else is.
//
// **What it costs.** Monad bills the gas *limit*, not the usage, so nothing here is inflated
// "to be safe" — an over-large limit is the organizer's paymaster budget spent on gas nobody
// used. The two floors below are the measured numbers plus the one shortfall the estimate
// cannot see; see `CHECK_IN_GAS_FLOORS`.
//
// **When it is done.** It is not done when this returns. `sendCheckIn` hands back the handle
// and nothing else: the verdict is the `CheckedIn` event (Task 24), and a `wait()` that times
// out means "still confirming", never a refusal. A gate that turned a timeout into a DENY would
// refuse people whose check-in lands two seconds later.
import { encodeFunctionData, type Hex } from 'viem';

import { ticketAbi, type GateCodeWire, type GateResponseWire } from '@monti/shared';

import type { UsedFunction } from '../../shared/chain/abis';
import { getGateSmartAccount } from '../../shared/chain/gateAccount';
import {
  sendSponsoredOp,
  type SponsoredGasFloors,
  type SponsoredOpHandle,
} from '../../shared/chain/sendSponsoredOp';
import { getConfig } from '../../shared/config';

/**
 * The check-in entry points, typed against the usage manifest so a name the app has not
 * declared cannot be sent. Today that is `checkIn` alone; the 01b redeploy adds `checkInLate`
 * with the same three arguments for the offline queue (Task 28) to drain through, and adding it
 * to `USED_ABI` is the whole of what that will take here.
 */
export type CheckInFunction = Extract<UsedFunction<'Ticket'>, 'checkIn' | 'checkInLate'>;

/**
 * The floors the gate path puts under the bundler's estimate. Both are floors, not overrides:
 * an estimate above them is used as it stands.
 *
 * - `callGasLimit` **200,000**. `checkIn` measured 123,800 in the 01b tests and `checkInLate`
 *   132,607. The headroom covers the branches those two runs did not take — a ticket with a
 *   pending offer to clear, a cold storage slot — without paying for a limit nobody approaches.
 * - `verificationGasLimit` **150,000**, the same floor `sendSponsoredOp` applies to every
 *   account. It is stated here as well because the gate is where the shortfall was found and a
 *   silent removal of it there should fail a test here too.
 *
 * `preVerificationGas` is left to the bundler: it prices calldata against the current L1/DA
 * conditions, which no constant in this repo can know. `maxFeePerGas` and `maxPriorityFeePerGas`
 * come from `estimateFeesPerGas()` against the chain (Monad's base fee is a fixed 100 gwei).
 */
export const CHECK_IN_GAS_FLOORS: SponsoredGasFloors = {
  callGasLimit: 200_000n,
  verificationGasLimit: 150_000n,
};

/**
 * The paymaster refused the sender: `gateOf(account)` is zero, so this device was never
 * registered against the event (or was revoked since).
 *
 * It is deliberately **not** a DENY. Nothing is wrong with the attendee or their ticket — the
 * terminal is not set up — and showing them a red screen would send a valid ticket-holder away
 * while the fix is one admin action on another phone. Task 23 routes this to the setup screen.
 */
export class GateNotRegisteredError extends Error {
  readonly gateAccount: Hex;

  constructor(gateAccount: Hex, options?: { cause?: unknown }) {
    super('GATE_NOT_REGISTERED', options);
    this.name = 'GateNotRegisteredError';
    this.gateAccount = gateAccount;
  }
}

/** What `MontiPaymaster` reverts with when it does not recognise the sending account. */
const UNKNOWN_SENDER = /UnknownSender/i;

/**
 * viem and the bundler transport both wrap errors, so the revert name rarely sits on the
 * message of the error that was thrown — it turns up on `details`, on `shortMessage`, or two
 * `cause` levels down. Reading only the top message made this miss silently, which is
 * fail-safe (a miss is a `TX_FAILED`, never a false setup error) and also useless.
 *
 * The walk is depth-limited because an error chain can be cyclic, and a gate that hung parsing
 * its own failure would be worse than one that mislabelled it.
 */
function mentionsUnknownSender(error: unknown, depth = 5): boolean {
  if (depth <= 0 || error === null || error === undefined) return false;
  if (typeof error === 'string') return UNKNOWN_SENDER.test(error);
  if (typeof error !== 'object') return false;

  const candidate = error as { message?: unknown; shortMessage?: unknown; details?: unknown; cause?: unknown };
  for (const field of [candidate.message, candidate.shortMessage, candidate.details]) {
    if (typeof field === 'string' && UNKNOWN_SENDER.test(field)) return true;
  }
  return mentionsUnknownSender(candidate.cause, depth - 1);
}

export interface CheckInCallParams {
  code: GateCodeWire;
  response: GateResponseWire;
  functionName?: CheckInFunction;
}

/**
 * `checkIn(uint256 tokenId, Ticket.GateCode g, bytes deviceSig)` — the argument shape is the
 * generated ABI's, and the struct's four fields are in its declared order. The chain recomputes
 * `sha256(abi.encode(tokenId, g.gateId, g.eventId, g.nonce, g.issuedAt))` and checks the device
 * signature against it, so every one of these values has to be the one the attendee signed.
 *
 * That is why the nonces are compared. The response names the code it answers (`GateResponseWire`
 * v2) and Task 19 resolves the pair; if a caller ever hands over a mismatched pair anyway, the
 * signature cannot verify and the only thing on chain would be a `BadDeviceSignature` revert and
 * a burnt nonce. Better to refuse to build it.
 */
export function encodeCheckInCall({ code, response, functionName = 'checkIn' }: CheckInCallParams): Hex {
  if (code.nonce !== response.nonce) throw new Error('CHECK_IN_CODE_MISMATCH');
  return encodeFunctionData({
    abi: ticketAbi,
    functionName,
    args: [
      BigInt(response.tokenId),
      {
        gateId: BigInt(code.gateId),
        eventId: BigInt(code.eventId),
        issuedAt: BigInt(code.issuedAt),
        nonce: code.nonce,
      },
      response.deviceSig,
    ],
  });
}

export interface SendCheckInParams extends CheckInCallParams {
  /** `Ticket.eventOrg(eventId)`. The paymaster debits this organizer's budget. */
  orgId: bigint;
}

/**
 * Sends the check-in and returns immediately with the handle. The caller waits — or does not:
 * Task 23's machine keeps the op alive past its own 5-second "tap again" hint, because a late
 * `CheckedIn` still turns the tap green.
 */
export async function sendCheckIn(params: SendCheckInParams): Promise<SponsoredOpHandle> {
  const account = await getGateSmartAccount();
  const data = encodeCheckInCall(params);
  try {
    return await sendSponsoredOp({
      account,
      orgId: params.orgId,
      calls: [{ to: getConfig().addresses.ticket, data }],
      gasFloors: CHECK_IN_GAS_FLOORS,
    });
  } catch (cause) {
    if (mentionsUnknownSender(cause)) throw new GateNotRegisteredError(account.address, { cause });
    throw cause;
  }
}
