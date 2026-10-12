import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeFunctionData } from 'viem';
import { organizersAbi } from '../shared/chain/abis';

const sendAction = vi.fn(async () => undefined);
vi.mock('../shared/relay/sendAction', () => ({ sendAction }));

const OWNER = `0x${'ab'.repeat(20)}` as const;
const STRANGER = `0x${'cd'.repeat(20)}` as const;
const INVITED = `0x${'ef'.repeat(20)}` as const;
vi.mock('../shared/chain/accounts', () => ({ getStaffAccount: async () => ({ address: OWNER }) }));

const ownerOf = vi.fn(async () => OWNER as string);
const adminBitsOf = vi.fn(async () => 0);
const managerOf = vi.fn(async () => ({ exists: false, canApprove: false }));
vi.mock('../shared/chain/reads', async (orig) => ({
  ...(await orig<typeof import('../shared/chain/reads')>()),
  readOrganizers: () => ({ ownerOf, adminBitsOf, managerOf }),
}));

/** One row of `listInvites`, which carries no number, no permission bits and nobody's uid. */
interface ServerInvite {
  inviteId: string;
  role: 'admin' | 'manager';
  status: string;
  createdAt: number;
  expiresAt?: number;
  requiredSender?: string;
}

/**
 * Two epoch seconds fixed on either side of every run of this suite. Expiry is a comparison
 * against the clock, so a fixture built from `Date.now()` would drift along with the thing it
 * is meant to pin down — one of these is 2020 and the other 2096, and neither can be overtaken
 * while a test runs.
 */
const LONG_AGO = 1_600_000_000;
const FAR_OFF = 4_000_000_000;

const createInvite = vi.fn(async () => ({ inviteId: 'i1', link: 'https://monti.test/org/invite/i1' }));
const revokeInvite = vi.fn(async () => ({ status: 'revoked' as const }));
const listInvites = vi.fn(async (_args: { orgId: string }): Promise<ServerInvite[]> => []);
vi.mock('../shared/api/functions', async (orig) => ({
  ...(await orig<typeof import('../shared/api/functions')>()),
  api: { createInvite, revokeInvite, listInvites },
}));

const { CallableError } = await import('../shared/api/functions');
const { organizerCopy } = await import('./copy');
const { Team } = await import('./Team');
const copy = organizerCopy.en.team;
const life = organizerCopy.en.lifecycle;
const data = (functionName: 'setAdmin' | 'setManager', args: readonly unknown[]) =>
  encodeFunctionData({ abi: organizersAbi, functionName, args });

function open() {
  render(
    <MemoryRouter>
      <Team orgId="9" />
    </MemoryRouter>,
  );
}

/** The one row a grant can start from: `requiredSender` is the server's `ownerOf` as it is now. */
function accepted(role: 'admin' | 'manager'): ServerInvite {
  return { inviteId: 'a1', role, status: 'accepted', createdAt: LONG_AGO, requiredSender: OWNER };
}

/** Lists one accepted row and presses its grant action, which is what opens the panel. */
async function openGrant(user: ReturnType<typeof userEvent.setup>, role: 'admin' | 'manager') {
  listInvites.mockResolvedValue([accepted(role)]);
  open();
  await waitFor(() => expect(ownerOf).toHaveBeenCalled());
  await user.click(await screen.findByRole('button', { name: copy.grant }));
}

/** One of several matches, as `noUncheckedIndexedAccess` wants it read: a match that is not
 *  there is a failed test, not something to reach past with `?.`. */
function nth(found: HTMLElement[], index: number): HTMLElement {
  const one = found[index];
  if (one === undefined) throw new Error(`no match at ${index}`);
  return one;
}

/** One listed invitation, by its place in the list. A grant panel is drawn inside its own row,
 *  which is the only thing telling its checkboxes apart from the invite form's copies of them. */
function row(index: number) {
  return within(nth(screen.getAllByRole('listitem'), index));
}

beforeEach(() => {
  ownerOf.mockResolvedValue(OWNER);
  adminBitsOf.mockResolvedValue(0);
  managerOf.mockResolvedValue({ exists: false, canApprove: false });
  createInvite.mockResolvedValue({ inviteId: 'i1', link: 'https://monti.test/org/invite/i1' });
  listInvites.mockResolvedValue([]);
});

describe('inviting somebody', () => {
  it('sends the number to the server and shows the link it answers with', async () => {
    const user = userEvent.setup();
    open();
    await user.type(screen.getByLabelText(copy.phone), '+821012345678');
    await user.click(screen.getByRole('button', { name: copy.invite }));

    await waitFor(() =>
      expect(createInvite).toHaveBeenCalledWith({
        orgId: '9', role: 'manager', phoneE164: '+821012345678', canApprove: false,
      }),
    );
    expect(await screen.findByText(/monti.test\/org\/invite\/i1/)).toBeInTheDocument();
    expect(screen.getByText(copy.linkOnce)).toBeInTheDocument();
  });

  /**
   * `listInvites` answers with the invite id and nothing else, so an invitation made here has
   * to appear without a refetch or the organiser would watch their own invitation vanish.
   */
  it('puts the invitation it just made at the top of the list without asking again', async () => {
    const user = userEvent.setup();
    listInvites.mockResolvedValue([
      { inviteId: 'old', role: 'admin', status: 'sent', createdAt: LONG_AGO, expiresAt: FAR_OFF },
    ]);
    open();
    await user.type(screen.getByLabelText(copy.phone), '+821012345678');
    await user.click(screen.getByRole('button', { name: copy.invite }));

    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(2));
    const rows = screen.getAllByRole('listitem');
    expect(within(nth(rows, 0)).getByText(/monti.test\/org\/invite\/i1/)).toBeInTheDocument();
    expect(within(nth(rows, 0)).getByText(copy.status.sent)).toBeInTheDocument();
    expect(listInvites).toHaveBeenCalledTimes(1);
  });

  it('refuses a number that is not in international form before it leaves', async () => {
    const user = userEvent.setup();
    open();
    await user.type(screen.getByLabelText(copy.phone), '01012345678');
    await user.click(screen.getByRole('button', { name: copy.invite }));
    expect(await screen.findByText(copy.problems.phone)).toBeInTheDocument();
    expect(createInvite).not.toHaveBeenCalled();
  });

  it('withdraws an invitation it made', async () => {
    const user = userEvent.setup();
    open();
    await user.type(screen.getByLabelText(copy.phone), '+821012345678');
    await user.click(screen.getByRole('button', { name: copy.invite }));
    await user.click(await screen.findByRole('button', { name: copy.revoke }));
    await waitFor(() => expect(revokeInvite).toHaveBeenCalledWith({ inviteId: 'i1' }));
    expect(await screen.findByText(copy.status.revoked)).toBeInTheDocument();
  });
});

describe('the invitations the server lists', () => {
  it('shows the ones this session did not create, with their role and their state', async () => {
    listInvites.mockResolvedValue([
      { inviteId: 's1', role: 'admin', status: 'sent', createdAt: LONG_AGO, expiresAt: FAR_OFF },
      { inviteId: 's2', role: 'manager', status: 'accepted', createdAt: LONG_AGO, requiredSender: OWNER },
    ]);
    open();

    const rows = await screen.findAllByRole('listitem');
    expect(listInvites).toHaveBeenCalledWith({ orgId: '9' });
    expect(rows).toHaveLength(2);
    expect(within(nth(rows, 0)).getByText(copy.admin)).toBeInTheDocument();
    expect(within(nth(rows, 0)).getByText(copy.status.sent)).toBeInTheDocument();
    expect(within(nth(rows, 1)).getByText(copy.manager)).toBeInTheDocument();
    expect(within(nth(rows, 1)).getByText(copy.status.accepted)).toBeInTheDocument();
    // The link is never in the answer, so a row this session did not create cannot show one.
    expect(screen.queryByText(copy.linkOnce)).not.toBeInTheDocument();
  });

  it('says there is nothing to show when the organisation has no invitations', async () => {
    open();
    expect(await screen.findByText(copy.invitesEmpty)).toBeInTheDocument();
  });

  /** `acceptInvite` refuses an invitation past its deadline, so the stored word outlives it. */
  it('reads a sent invitation whose deadline has passed as expired', async () => {
    listInvites.mockResolvedValue([
      { inviteId: 'e1', role: 'manager', status: 'sent', createdAt: LONG_AGO, expiresAt: LONG_AGO + 60 },
    ]);
    open();
    expect(await screen.findByText(copy.status.expired)).toBeInTheDocument();
    expect(screen.queryByText(copy.status.sent)).not.toBeInTheDocument();
  });

  /** A `0` is a `serverTimestamp()` that had not settled when the row was read: unknown, not past. */
  it('leaves a deadline the server had not written yet as sent rather than expired', async () => {
    listInvites.mockResolvedValue([
      { inviteId: 'u1', role: 'manager', status: 'sent', createdAt: 0, expiresAt: 0 },
    ]);
    open();
    expect(await screen.findByText(copy.status.sent)).toBeInTheDocument();
    expect(screen.queryByText(copy.status.expired)).not.toBeInTheDocument();
  });

  /**
   * `permission-denied` is the ordinary answer for a manager without `PERM_MANAGE_MANAGERS`,
   * not a failure: the rest of the screen still has work to do for them.
   */
  it('says the list is not theirs to see instead of raising a failure', async () => {
    listInvites.mockRejectedValue(new CallableError('permission-denied', 'NOT_ALLOWED_TO_INVITE'));
    open();
    expect(await screen.findByText(copy.invitesNotAllowed)).toBeInTheDocument();
    expect(screen.queryByText(copy.problems.failed)).not.toBeInTheDocument();
    expect(screen.queryByText(copy.problems.notAllowed)).not.toBeInTheDocument();
    expect(screen.getByLabelText(copy.phone)).toBeInTheDocument();
  });

  it('withdraws an invitation somebody else created', async () => {
    const user = userEvent.setup();
    listInvites.mockResolvedValue([
      { inviteId: 's9', role: 'manager', status: 'sent', createdAt: LONG_AGO, expiresAt: FAR_OFF },
    ]);
    open();
    await user.click(await screen.findByRole('button', { name: copy.revoke }));
    await waitFor(() => expect(revokeInvite).toHaveBeenCalledWith({ inviteId: 's9' }));
    expect(await screen.findByText(copy.status.revoked)).toBeInTheDocument();
  });
});

describe('putting the role on chain', () => {
  /**
   * `Organizers.setAdmin` reverts unless `msg.sender` is the organisation's owner, which is
   * why `acceptInvite` hands back calldata and a `requiredSender` rather than sending it. An
   * admin who can create the invitation still cannot finish it.
   */
  it('offers the last step to the owner only', async () => {
    ownerOf.mockResolvedValue(STRANGER);
    listInvites.mockResolvedValue([accepted('manager')]);
    open();
    expect(await screen.findByText(copy.status.accepted)).toBeInTheDocument();
    expect(await screen.findByText(copy.notOwner)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: copy.grant })).not.toBeInTheDocument();
  });

  it('names the account the last step has to be sent from on the accepted row', async () => {
    listInvites.mockResolvedValue([accepted('manager')]);
    open();
    expect(await screen.findByText(`${copy.requiredSender} ${OWNER}`)).toBeInTheDocument();
  });

  it('sends setManager with the approval right the organiser chose', async () => {
    const user = userEvent.setup();
    await openGrant(user, 'manager');
    await user.type(screen.getByLabelText(copy.account), INVITED);
    // The approval right sent here is the panel's own. The invite form carries a checkbox that
    // reads the same and decides something else entirely — what the *next* invitation stores —
    // so the one inside the row is the one this test has to press.
    await user.click(row(0).getByLabelText(copy.requestOnly));
    await user.click(screen.getByRole('button', { name: copy.grant }));

    await waitFor(() =>
      expect(sendAction).toHaveBeenCalledWith('setManager', 'organizers', data('setManager', [9n, INVITED, true, true])),
    );
  });

  /** The row's own role decides the write, not whatever the invite form happens to be set to. */
  it('sends setAdmin with exactly the permission bits that were ticked', async () => {
    const user = userEvent.setup();
    await openGrant(user, 'admin');
    await user.type(screen.getByLabelText(copy.account), INVITED);
    // Starts on createEvent|manageGates (1|2); ticking approveOverride makes it 7.
    await user.click(screen.getByLabelText(copy.perms.approveOverride));
    await user.click(screen.getByRole('button', { name: copy.grant }));

    await waitFor(() =>
      expect(sendAction).toHaveBeenCalledWith('setAdmin', 'organizers', data('setAdmin', [9n, INVITED, 7])),
    );
  });

  /**
   * The invite document's `done` is written by the Tenderly webhook — a mirror of the chain
   * that can be late or absent — so the screen asks the chain itself.
   */
  it('reads completion off the chain rather than waiting on the invite document', async () => {
    const user = userEvent.setup();
    managerOf.mockResolvedValue({ exists: true, canApprove: false });
    await openGrant(user, 'manager');
    await user.type(screen.getByLabelText(copy.account), INVITED);
    await user.click(screen.getByRole('button', { name: copy.check }));

    await waitFor(() => expect(managerOf).toHaveBeenCalledWith(9n, INVITED));
    expect(await screen.findByText(copy.granted)).toBeInTheDocument();
  });

  it('refuses an address that is not one before anything is sent', async () => {
    const user = userEvent.setup();
    await openGrant(user, 'manager');
    await user.type(screen.getByLabelText(copy.account), '0xnope');
    await user.click(screen.getByRole('button', { name: copy.grant }));
    expect(await screen.findByText(copy.problems.account)).toBeInTheDocument();
    expect(sendAction).not.toHaveBeenCalled();
  });
});

describe('what comes back from the grant', () => {
  async function grant(user: ReturnType<typeof userEvent.setup>) {
    await openGrant(user, 'manager');
    await user.type(screen.getByLabelText(copy.account), INVITED);
    await user.click(screen.getByRole('button', { name: copy.grant }));
  }

  /** `setAdmin` raises `NotOwner` and `setManager` raises `Unauthorized` — different rules. */
  it('tells the two authorisation refusals apart', async () => {
    const user = userEvent.setup();
    sendAction.mockRejectedValueOnce({ details: { code: 'NotOwner' } });
    await grant(user);
    expect(await screen.findByText(copy.problems.notOwner)).toBeInTheDocument();

    sendAction.mockRejectedValueOnce({ details: { code: 'Unauthorized' } });
    await user.click(screen.getByRole('button', { name: copy.grant }));
    expect(await screen.findByText(copy.problems.notAllowed)).toBeInTheDocument();
  });

  it('says the organisation number is not one rather than blaming the permissions', async () => {
    const user = userEvent.setup();
    sendAction.mockRejectedValueOnce({ details: { code: 'UnknownOrganizer' } });
    await grant(user);
    expect(await screen.findByText(copy.problems.unknownOrg)).toBeInTheDocument();
  });

  it('falls back to one sentence for a revert it has no name for', async () => {
    const user = userEvent.setup();
    sendAction.mockRejectedValueOnce({ details: { code: 'GateAccountInUse' } });
    await grant(user);
    expect(await screen.findByText(copy.problems.failed)).toBeInTheDocument();
  });

  /**
   * EIP-55 exists for the "copied one character wrong off a colleague's screen" case, and
   * admin bits on an account nobody holds cannot be taken back.
   */
  it('refuses a mixed-case address whose checksum does not add up', async () => {
    const user = userEvent.setup();
    await openGrant(user, 'manager');
    await user.type(screen.getByLabelText(copy.account), `0xA${INVITED.slice(3)}`);
    await user.click(screen.getByRole('button', { name: copy.grant }));
    expect(await screen.findByText(copy.problems.account)).toBeInTheDocument();
    expect(sendAction).not.toHaveBeenCalled();
  });
});

/**
 * The panel and the form ask the same two questions about two different people. `createInvite`
 * stores `permissionBits` and `canApprove` on the invitation document and `acceptInvite` builds
 * its calldata from them, so a value a panel changed and the form never showed is a wrong
 * permission leaving the browser rather than a checkbox in the wrong place.
 */
describe('the grant panel against the invite form', () => {
  it('keeps a permission ticked inside a panel out of the next invitation', async () => {
    const user = userEvent.setup();
    await openGrant(user, 'admin');
    // While the form is still on its manager default the panel is the only thing on screen
    // offering permission bits, so this reads unambiguously.
    await user.click(screen.getByLabelText(copy.perms.approveOverride));

    await user.selectOptions(screen.getByLabelText(copy.role), 'admin');
    await user.type(screen.getByLabelText(copy.phone), '+821012345678');
    await user.click(screen.getByRole('button', { name: copy.invite }));

    await waitFor(() =>
      // createEvent|manageGates: what the form showed, untouched by the panel beside it.
      expect(createInvite).toHaveBeenCalledWith({
        orgId: '9', role: 'admin', phoneE164: '+821012345678', permissionBits: 3,
      }),
    );
  });

  it('keeps an approval right ticked inside a panel out of the next invitation', async () => {
    const user = userEvent.setup();
    await openGrant(user, 'manager');
    await user.click(row(0).getByLabelText(copy.requestOnly));

    await user.type(screen.getByLabelText(copy.phone), '+821012345678');
    await user.click(screen.getByRole('button', { name: copy.invite }));

    await waitFor(() =>
      expect(createInvite).toHaveBeenCalledWith({
        orgId: '9', role: 'manager', phoneE164: '+821012345678', canApprove: false,
      }),
    );
  });

  /** Two accepted rows is where the one word `copy.grant` would name two actions at once. */
  it('offers the last step on one row at a time', async () => {
    const user = userEvent.setup();
    listInvites.mockResolvedValue([accepted('manager'), { ...accepted('manager'), inviteId: 'a2' }]);
    open();
    await waitFor(() => expect(screen.getAllByRole('button', { name: copy.grant })).toHaveLength(2));

    await user.click(row(0).getByRole('button', { name: copy.grant }));
    expect(screen.getAllByRole('button', { name: copy.grant })).toHaveLength(1);
    expect(row(1).queryByRole('button', { name: copy.grant })).not.toBeInTheDocument();
  });

  /** The guard above buys one `copy.grant` on screen and closing is what pays for it: with no
   *  way out, the first panel opened would be the last one this owner could reach — a grant that
   *  lands leaves its panel standing, so even finishing does not free them to start the next. */
  it('gives a panel a way out that puts the other rows back within reach', async () => {
    const user = userEvent.setup();
    managerOf.mockResolvedValue({ exists: true, canApprove: false });
    listInvites.mockResolvedValue([accepted('manager'), { ...accepted('manager'), inviteId: 'a2' }]);
    open();
    await waitFor(() => expect(screen.getAllByRole('button', { name: copy.grant })).toHaveLength(2));

    await user.click(row(0).getByRole('button', { name: copy.grant }));
    await user.type(row(0).getByLabelText(copy.account), INVITED);
    await user.click(row(0).getByRole('button', { name: copy.grant }));
    expect(await screen.findByText(copy.granted)).toBeInTheDocument();

    await user.click(row(0).getByRole('button', { name: copy.grantClose }));
    expect(screen.queryByText(copy.granted)).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: copy.grant })).toHaveLength(2);

    await user.click(row(1).getByRole('button', { name: copy.grant }));
    expect(row(1).getByLabelText(copy.account)).toHaveValue('');
    expect(screen.queryByText(copy.granted)).not.toBeInTheDocument();
  });

  /** The chain write does not read the invitation document, so nothing incorrect could land —
   *  the screen would simply be offering the last step of an invitation it has just withdrawn. */
  it('takes the panel away with the invitation it belongs to', async () => {
    const user = userEvent.setup();
    await openGrant(user, 'manager');
    await user.click(screen.getByRole('button', { name: copy.revoke }));

    expect(await screen.findByText(copy.status.revoked)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: copy.grant })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(copy.account)).not.toBeInTheDocument();
  });

  it('opens a panel from nothing the last one left behind', async () => {
    const user = userEvent.setup();
    adminBitsOf.mockResolvedValue(7);
    listInvites.mockResolvedValue([accepted('admin'), { ...accepted('admin'), inviteId: 'a2' }]);
    open();
    await waitFor(() => expect(screen.getAllByRole('button', { name: copy.grant })).toHaveLength(2));

    await user.click(row(0).getByRole('button', { name: copy.grant }));
    await user.click(row(0).getByLabelText(copy.perms.approveOverride));
    await user.type(row(0).getByLabelText(copy.account), INVITED);
    await user.click(row(0).getByRole('button', { name: copy.grant }));
    expect(await screen.findByText(copy.granted)).toBeInTheDocument();

    // Withdrawing the first invitation is what closes its panel, and a closed panel is what
    // puts the second row's offer back on screen.
    await user.click(row(0).getByRole('button', { name: copy.revoke }));
    await user.click(await screen.findByRole('button', { name: copy.grant }));

    expect(row(1).getByLabelText(copy.account)).toHaveValue('');
    expect(row(1).getByLabelText(copy.perms.approveOverride)).not.toBeChecked();
    expect(screen.queryByText(copy.granted)).not.toBeInTheDocument();
  });
});
