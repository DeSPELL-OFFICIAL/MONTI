// Manual approval: which contract call, sent from whose account.
//
// Two decisions, and neither of them belongs to this device.
//
// **Which call** is `Organizers`' answer, read fresh. A manager who may approve, and an admin
// holding `PERM_APPROVE_OVERRIDE`, send `manualOverride` — the person walks in and the chain
// records who said so. A manager without that right files a request through the backend
// `requestOverride` callable (P4 — off chain, no passkey prompt, admits nobody); somebody with the
// right sees it in their own dialog (`listOverrideRequests`) and approves it with `manualOverride`. Anybody else is
// `denied` and nothing is sent, because `manualOverride` from an unauthorised account reverts
// `Unauthorized` (Ticket.sol:408) and the only thing the attendee learns is that the door broke.
//
// The read is never cached. A staff member's rights change inside a shift — a floor manager is
// promoted between doors, or has the right taken away after an incident — and a cached
// permission is a permission that outlives the decision to grant it. Two `eth_call`s at the
// moment a dialog opens is the cheapest thing at this door.
//
// **Whose account** is not a choice at all: the staff member's own passkey account, always.
// Check-ins are sent by the gate account (Task 21) because a tap is the terminal's business; an
// override is a person's. `Ticket.manualOverride` writes `_msgSender()` into `ManualOverride` as
// the approver, and an override signed by the terminal would record a *device* where the whole
// point is to record a person who can be asked about it afterwards. The account is therefore
// fetched here rather than passed in — a caller that could hand one in is a caller that could
// hand in a different one from the account whose rights were just measured. The relayer forwards
// the call (ERC-2771), so the passkey the account holds signs the ForwardRequest and the person,
// not the terminal, still stands behind the door opening.
import { encodeFunctionData, type Address } from 'viem';

import { OVERRIDE_ROLE, PERM_APPROVE_OVERRIDE, ticketAbi, type OverrideReasonCode } from '@monti/shared';

import { api, type OverrideReason } from '../../shared/api/functions';
import { getStaffAccount } from '../../shared/chain/accounts';
import type { OverrideCall, OverrideRole, OverrideRoute } from '../types';
import { readOrganizers } from '../../shared/chain/reads';
import { sendAction } from '../../shared/relay/sendAction';

export { PERM_APPROVE_OVERRIDE };

/**
 * This account may not let anybody in, by hand or by request.
 *
 * A class rather than a message, the same as `NoPasskeyOnDevice`: the dialog has to tell "you do
 * not have this right" apart from "it did not go through", because the first is a sentence about
 * the person holding the phone and the second is an invitation to press again. Matching on
 * `error.message` would let a reworded string silently downgrade the one into the other.
 */
export class OverrideDenied extends Error {
  constructor() {
    super('OVERRIDE_DENIED');
    this.name = 'OverrideDenied';
  }
}

/**
 * The vocabulary comes from `staff/types.ts`, where the console reads it too. A second spelling
 * of `'manualOverride' | 'requestOverride'` here would be a screen and a chain call agreeing by
 * coincidence rather than by type.
 */
export type { OverrideCall, OverrideRole, OverrideRoute } from '../types';

const ROLE_CODE: Record<OverrideRole, number> = {
  none: OVERRIDE_ROLE.none,
  approver: OVERRIDE_ROLE.approver,
  manager: OVERRIDE_ROLE.manager,
};

/** `Ticket.ROLE_*` for a named role — what `ManualOverride` will carry in its `role` field. */
export const roleCode = (role: OverrideRole): number => ROLE_CODE[role];

export interface OverrideWho {
  orgId: bigint;
  account: Address;
}

export interface OverrideAuthority {
  route: OverrideRoute;
  /** What the `ManualOverride` event will say. `'none'` on the request path and when denied. */
  role: OverrideRole;
  /** On the organizer's team at all. It is what separates `requestOverride` from `denied`. */
  isManager: boolean;
}

/**
 * What this account may do about this organizer's doors, right now.
 *
 * The two views are read together and both are always read, even though the route could
 * short-circuit after the first: the **role** needs both answers. `Ticket.manualOverride` checks
 * `hasPermission` before `managerOf` (Ticket.sol:398-408), so somebody who is both a permitted
 * admin and an approving manager is recorded as `ROLE_APPROVER` — and a console that guessed
 * `manager` from the first read would print a different approver than the event carries.
 */
export async function readOverrideAuthority({ orgId, account }: OverrideWho): Promise<OverrideAuthority> {
  const organizers = readOrganizers();
  const [manager, permitted] = await Promise.all([
    organizers.managerOf(orgId, account),
    organizers.hasPermission(orgId, account, PERM_APPROVE_OVERRIDE),
  ]);

  const role: OverrideRole = permitted ? 'approver' : manager.exists && manager.canApprove ? 'manager' : 'none';
  const route: OverrideRoute =
    role !== 'none' ? 'manualOverride' : manager.exists ? 'requestOverride' : 'denied';
  return { route, role, isManager: manager.exists };
}

/** {@link readOverrideAuthority} reduced to the call. The dialog's button text reads this. */
export async function decideOverrideRoute(who: OverrideWho): Promise<OverrideRoute> {
  return (await readOverrideAuthority(who)).route;
}

export interface SubmitOverrideParams {
  orgId: bigint;
  /** The event the request is filed under (the callable checks `tokenId >> 96 == eventId`). */
  eventId: bigint;
  tokenId: bigint;
  gateId: bigint;
  reason: OverrideReasonCode;
  /** A short free-text note for the approver; request path only, blank is left off. */
  note?: string;
}

/**
 * The operation, plus everything the console has to show about it. `route`/`role`/`approver`/
 * `reason` are the answer to "who let this person in, and why", known the moment the authority is
 * read, so the console can show them while the relay is still in flight. `settled` is the relay's
 * verdict: it resolves once the relayer confirms the override, and rejects with the
 * `sendAction` refusal — a `CallableError` whose `details.code` is the contract/forwarder error
 * name — that the console maps to a DENY. A rejection carrying no code is an unknown outcome (a
 * dropped relay listener), which the console reads as still in flight, not as a failure.
 */
export interface OverrideSubmission {
  route: OverrideCall;
  role: OverrideRole;
  approver: Address;
  reason: OverrideReasonCode;
  settled: Promise<void>;
}

/** The request path: one backend record, resolved once the server has stored it. */
async function fileRequest(params: SubmitOverrideParams): Promise<void> {
  const note = params.note?.trim();
  await api.requestOverride({
    eventId: params.eventId.toString(),
    tokenId: params.tokenId.toString(),
    gateId: params.gateId.toString(),
    reason: params.reason as OverrideReason,
    ...(note ? { note } : {}),
  });
}

/**
 * Files or approves one override, as the signed-in staff member.
 *
 * Approving: the passkey signs the ForwardRequest, so a biometric prompt is expected here and is the point:
 * it is the moment a person, not a terminal, stands behind the door opening. The MONTI relayer
 * pays the gas and forwards the call, the same as a check-in — the budget belongs to the event
 * either way. The authority is read against the account that will sign, never one handed in, so
 * the console can never print an approver the chain will not record.
 */
export async function submitOverride(params: SubmitOverrideParams): Promise<OverrideSubmission> {
  const account = await getStaffAccount();
  const approver = account.address as Address;
  const { route, role } = await readOverrideAuthority({ orgId: params.orgId, account: approver });
  if (route === 'denied') throw new OverrideDenied();

  // Kicked off now, awaited by the caller through `settled`: the passkey prompt and the relay wait
  // (or the request callable) live on that promise, so the console shows who is acting the moment
  // this returns. A request is a backend record, not a chain write — its refusal (`details.code`
  // `UNKNOWN_EVENT`/`WRONG_EVENT`/`GATE_MISMATCH`/`NOT_ALLOWED`) rejects `settled` the same way.
  const settled =
    route === 'manualOverride'
      ? sendAction(
          route,
          'ticket',
          encodeFunctionData({ abi: ticketAbi, functionName: route, args: [params.tokenId, params.gateId, params.reason] }),
        ).then(() => undefined)
      : fileRequest(params);

  return { route, role, approver, reason: params.reason, settled };
}
