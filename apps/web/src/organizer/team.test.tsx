import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface SentOp { functionName: string; orgId: bigint; args: readonly unknown[] }
const organizersOp = vi.fn(async (_options: SentOp) => ({ success: true }));
vi.mock('../shared/chain/ops', async (orig) => ({
  ...(await orig<typeof import('../shared/chain/ops')>()),
  organizersOp,
}));

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

const createInvite = vi.fn(async () => ({ inviteId: 'i1', link: 'https://monti.test/org/invite/i1' }));
const revokeInvite = vi.fn(async () => ({ status: 'revoked' as const }));
vi.mock('../shared/api/functions', async (orig) => ({
  ...(await orig<typeof import('../shared/api/functions')>()),
  api: { createInvite, revokeInvite },
}));

const { organizerCopy } = await import('./copy');
const { Team } = await import('./Team');
const copy = organizerCopy.ko.team;

function open() {
  render(
    <MemoryRouter>
      <Team orgId="9" />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  ownerOf.mockResolvedValue(OWNER);
  adminBitsOf.mockResolvedValue(0);
  managerOf.mockResolvedValue({ exists: false, canApprove: false });
  createInvite.mockResolvedValue({ inviteId: 'i1', link: 'https://monti.test/org/invite/i1' });
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
    expect(screen.getByText(copy.sessionOnly)).toBeInTheDocument();
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
    expect(await screen.findByText(copy.revoked)).toBeInTheDocument();
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
    open();
    expect(await screen.findByText(copy.notOwner)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: copy.grant })).not.toBeInTheDocument();
  });

  it('sends setManager with the approval right the organiser chose', async () => {
    const user = userEvent.setup();
    open();
    await waitFor(() => expect(ownerOf).toHaveBeenCalled());
    await user.type(screen.getByLabelText(copy.account), INVITED);
    await user.click(screen.getByLabelText(copy.requestOnly));
    await user.click(screen.getByRole('button', { name: copy.grant }));

    await waitFor(() =>
      expect(organizersOp).toHaveBeenCalledWith(
        expect.objectContaining({ orgId: 9n, functionName: 'setManager', args: [9n, INVITED, true, true] }),
      ),
    );
  });

  it('sends setAdmin with exactly the permission bits that were ticked', async () => {
    const user = userEvent.setup();
    open();
    await waitFor(() => expect(ownerOf).toHaveBeenCalled());
    await user.selectOptions(screen.getByLabelText(copy.role), 'admin');
    await user.type(screen.getByLabelText(copy.account), INVITED);
    // Starts on createEvent|manageGates (1|2); ticking approveOverride makes it 7.
    await user.click(screen.getByLabelText(copy.perms.approveOverride));
    await user.click(screen.getByRole('button', { name: copy.grant }));

    await waitFor(() =>
      expect(organizersOp).toHaveBeenCalledWith(
        expect.objectContaining({ functionName: 'setAdmin', args: [9n, INVITED, 7] }),
      ),
    );
  });

  /**
   * The invite document's `done` is written by the Tenderly webhook — a mirror of the chain
   * that can be late or absent — so the screen asks the chain itself.
   */
  it('reads completion off the chain rather than waiting on the invite document', async () => {
    const user = userEvent.setup();
    managerOf.mockResolvedValue({ exists: true, canApprove: false });
    open();
    await waitFor(() => expect(ownerOf).toHaveBeenCalled());
    await user.type(screen.getByLabelText(copy.account), INVITED);
    await user.click(screen.getByRole('button', { name: copy.check }));

    await waitFor(() => expect(managerOf).toHaveBeenCalledWith(9n, INVITED));
    expect(await screen.findByText(copy.granted)).toBeInTheDocument();
  });

  it('refuses an address that is not one before anything is sent', async () => {
    const user = userEvent.setup();
    open();
    await waitFor(() => expect(ownerOf).toHaveBeenCalled());
    await user.type(screen.getByLabelText(copy.account), '0xnope');
    await user.click(screen.getByRole('button', { name: copy.grant }));
    expect(await screen.findByText(copy.problems.account)).toBeInTheDocument();
    expect(organizersOp).not.toHaveBeenCalled();
  });
});
