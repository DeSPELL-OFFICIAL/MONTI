// Manual approval: which contract call, sent from whose account.
//
// Two decisions, and neither of them belongs to this device.
//
// **Which call** is `Organizers`' answer, read fresh. A manager who may approve, and an admin
// holding `PERM_APPROVE_OVERRIDE`, send `manualOverride` — the person walks in and the chain
// records who said so. A manager without that right sends `requestOverride`, which files the
// request and admits nobody; somebody with the right approves it elsewhere. Anybody else is
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
// override is a person's. `Ticket.manualOverride` writes `msg.sender` into `ManualOverride` as
// the approver, and an override signed by the terminal would record a *device* where the whole
// point is to record a person who can be asked about it afterwards. The account is therefore
// fetched here rather than passed in — a caller that could hand one in is a caller that could
// hand in a different one from the account whose rights were just measured.
import { encodeFunctionData, type Address } from 'viem';

import { OVERRIDE_ROLE, PERM_APPROVE_OVERRIDE, ticketAbi, type OverrideReasonCode } from '@monti/shared';

import { getStaffAccount } from '../../shared/chain/accounts';
import type { OverrideCall, OverrideRole, OverrideRoute } from '../types';
import { getConfig } from '../../shared/config';
import { readOrganizers } from '../../shared/chain/reads';
import { sendSponsoredOp, type SponsoredOpHandle } from '../../shared/chain/sendSponsoredOp';

export { PERM_APPROVE_OVERRIDE };

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
  tokenId: bigint;
  gateId: bigint;
  reason: OverrideReasonCode;
}

/**
 * The operation, plus everything the console has to show about it. It **is** a
 * {@link SponsoredOpHandle} — `wait()` and all — so a caller that only wants the receipt treats
 * it as one; the four extra fields are the answer to "who let this person in, and why", which
 * is the question the chain event exists to answer and therefore the one the screen must too.
 */
export interface OverrideSubmission extends SponsoredOpHandle {
  route: OverrideCall;
  role: OverrideRole;
  approver: Address;
  reason: OverrideReasonCode;
}

/**
 * Files or approves one override, from the staff member's own passkey account.
 *
 * The passkey signs the user operation, so a biometric prompt is expected here and is the point:
 * it is the moment a person, not a terminal, stands behind the door opening. The organizer's
 * paymaster pays, the same as a check-in — the budget belongs to the event either way.
 */
export async function submitOverride(params: SubmitOverrideParams): Promise<OverrideSubmission> {
  const account = await getStaffAccount();
  const approver = account.address as Address;
  const { route, role } = await readOverrideAuthority({ orgId: params.orgId, account: approver });
  if (route === 'denied') throw new Error('OVERRIDE_DENIED');

  const handle = await sendSponsoredOp({
    account,
    orgId: params.orgId,
    calls: [
      {
        to: getConfig().addresses.ticket,
        data: encodeFunctionData({
          abi: ticketAbi,
          functionName: route,
          args: [params.tokenId, params.gateId, params.reason],
        }),
      },
    ],
  });

  return { ...handle, wait: (timeoutMs?: number) => handle.wait(timeoutMs), route, role, approver, reason: params.reason };
}
