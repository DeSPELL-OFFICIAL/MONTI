// Who may let somebody in by hand, asked of the chain, and the account the answer is sent from.
//
// Two separate rules live here and both are easy to get wrong in the same direction — towards
// letting the terminal decide.
//
// **The role is a chain read, never a local flag.** A staff member's rights change while a shift
// is running: an organizer promotes a floor manager between doors, or takes the right away after
// an incident. Anything this device cached would be a permission that outlives the decision to
// grant it, so `Organizers` is asked at the moment the dialog opens and again as the operation
// goes out — and the answer picks the *function*, because sending `manualOverride` without the
// right reverts `Unauthorized` and tells the attendee nothing except that the door broke.
//
// **It is sent from the staff member's own account.** Check-ins come from the gate account
// (Task 21); this does not. `Ticket.manualOverride` records `msg.sender` as the approver, and an
// override signed by the terminal would put a *device* on the chain where a person has to be —
// which is the entire point of recording it. The last test in this file reads the module's own
// source to make sure nothing ever imports the gate account into it.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { decodeFunctionData, type Hex } from 'viem';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { OVERRIDE_REASON, ticketAbi } from '@monti/shared';

const ORGANIZERS = `0x${'55'.repeat(20)}` as Hex;
const TICKET = `0x${'33'.repeat(20)}` as Hex;
/** The staff member's passkey account. Deliberately not the gate's `0xaa…`. */
const STAFF = `0x${'bb'.repeat(20)}` as Hex;

vi.mock('../../shared/config', () => ({
  getConfig: () => ({
    chainId: 10143,
    addresses: { identity: `0x${'44'.repeat(20)}`, organizers: ORGANIZERS, ticket: TICKET },
  }),
}));

const readContract = vi.fn();
vi.mock('../../shared/chain/client', () => ({ getPublicClient: () => ({ readContract }) }));

// The relay client is mocked; `submitOverride` builds the calldata and hands it to `sendAction`.
const sendAction = vi.fn();
vi.mock('../../shared/relay/sendAction', () => ({ sendAction }));

const staffAccount = { address: STAFF };
const getStaffAccount = vi.fn(async () => staffAccount);
vi.mock('../../shared/chain/accounts', () => ({ getStaffAccount: () => getStaffAccount() }));

const { OverrideDenied, PERM_APPROVE_OVERRIDE, readOverrideAuthority, decideOverrideRoute, submitOverride } =
  await import('./route');

const WHO = { orgId: 5n, account: STAFF } as const;

/** `managerOf` first, `hasPermission` second — the order `readOverrideAuthority` asks in. */
function chainSays(manager: [boolean, boolean], permitted: boolean): void {
  readContract.mockResolvedValueOnce(manager).mockResolvedValueOnce(permitted);
}

function sentCall(): { kind: string; target: string; data: Hex } {
  const [kind, target, data] = sendAction.mock.calls[0]! as [string, string, Hex];
  return { kind, target, data };
}

beforeEach(() => {
  readContract.mockReset();
  sendAction.mockReset();
  sendAction.mockResolvedValue(undefined);
});

describe('who may approve, asked of the chain', () => {
  it('routes an approving manager to manualOverride, tagged ROLE_MANAGER', async () => {
    chainSays([true, true], false);
    expect(await readOverrideAuthority(WHO)).toEqual({ route: 'manualOverride', role: 'manager', isManager: true });
  });

  it('routes a manager without the right to requestOverride', async () => {
    chainSays([true, false], false);
    expect(await readOverrideAuthority(WHO)).toEqual({ route: 'requestOverride', role: 'none', isManager: true });
  });

  it('routes an admin holding PERM_APPROVE_OVERRIDE to manualOverride, tagged ROLE_APPROVER', async () => {
    chainSays([false, false], true);
    expect(await readOverrideAuthority(WHO)).toEqual({ route: 'manualOverride', role: 'approver', isManager: false });
  });

  it('denies an account that is neither, so nothing is spent finding out', async () => {
    chainSays([false, false], false);
    expect(await decideOverrideRoute(WHO)).toBe('denied');
  });

  /**
   * `Ticket.manualOverride` checks `hasPermission` **before** `managerOf` (Ticket.sol:398-408),
   * so somebody who is both is recorded as ROLE_APPROVER. The screen has to say what the chain
   * will say, or the console and the event disagree about who let this person in.
   */
  it('calls somebody who is both an approver, the way the contract tags them', async () => {
    chainSays([true, true], true);
    expect(await readOverrideAuthority(WHO)).toEqual({ route: 'manualOverride', role: 'approver', isManager: true });
  });

  it('asks Organizers at the configured address about this account and this permission bit', async () => {
    chainSays([true, true], false);
    await decideOverrideRoute(WHO);
    expect(readContract).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ address: ORGANIZERS, functionName: 'managerOf', args: [5n, STAFF] }),
    );
    expect(readContract).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ functionName: 'hasPermission', args: [5n, STAFF, PERM_APPROVE_OVERRIDE] }),
    );
  });
});

describe('the override operation', () => {
  it('relays manualOverride, from the staff member own account and its measured authority', async () => {
    chainSays([true, true], false);
    const submission = await submitOverride({
      orgId: 5n,
      tokenId: 123n,
      gateId: 7n,
      reason: OVERRIDE_REASON.photoChecked,
    });
    await submission.settled;

    const call = sentCall();
    expect(call.kind).toBe('manualOverride');
    expect(call.target).toBe('ticket');
    const { functionName, args: callArgs } = decodeFunctionData({ abi: ticketAbi, data: call.data });
    expect(functionName).toBe('manualOverride');
    expect(callArgs).toEqual([123n, 7n, 1]);

    expect(submission.route).toBe('manualOverride');
    expect(submission.role).toBe('manager');
    // The approver is the account whose rights were just measured — never one handed in.
    expect(submission.approver).toBe(STAFF);
    expect(submission.reason).toBe(OVERRIDE_REASON.photoChecked);
  });

  it('relays requestOverride when that is what this account may do', async () => {
    chainSays([true, false], false);
    const submission = await submitOverride({
      orgId: 5n,
      tokenId: 9n,
      gateId: 7n,
      reason: OVERRIDE_REASON.phoneTrouble,
    });
    await submission.settled;
    const { functionName, args } = decodeFunctionData({ abi: ticketAbi, data: sentCall().data });
    expect(functionName).toBe('requestOverride');
    expect(args).toEqual([9n, 7n, 2]);
    expect(submission.route).toBe('requestOverride');
    expect(submission.role).toBe('none');
  });

  /**
   * The role is read against the account that will actually sign, never against one handed in:
   * reading one account's rights and signing with another is how a permitted admin's answer
   * ends up in front of a terminal signed in as somebody else.
   */
  it('measures the rights of the account it is about to sign with', async () => {
    chainSays([true, true], false);
    await submitOverride({ orgId: 5n, tokenId: 1n, gateId: 7n, reason: OVERRIDE_REASON.other });
    expect(readContract).toHaveBeenNthCalledWith(1, expect.objectContaining({ args: [5n, STAFF] }));
  });

  it('refuses a denied account before anything is signed or sent', async () => {
    chainSays([false, false], false);
    await expect(
      submitOverride({ orgId: 5n, tokenId: 1n, gateId: 7n, reason: OVERRIDE_REASON.other }),
    ).rejects.toBeInstanceOf(OverrideDenied);
    expect(sendAction).not.toHaveBeenCalled();
  });

  /**
   * The invariant in one grep. The gate account is a device key that signs code rotations
   * without a person present; an approver has to be a person, so this module must not be able
   * to reach for it even by accident.
   */
  it('never reaches for the gate account', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/staff/override/route.ts'), 'utf8');
    expect(source).not.toMatch(/gateAccount|gateAccountAddress|gateKey/);
    expect(source).toContain('getStaffAccount');
  });
});
