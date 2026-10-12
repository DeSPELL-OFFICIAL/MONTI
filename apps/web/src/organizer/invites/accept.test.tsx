import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InviteCalldata } from '../../shared/api/functions';

const ME = `0x${'ef'.repeat(20)}` as const;
const OWNER = `0x${'ab'.repeat(20)}` as const;
vi.mock('../../shared/chain/accounts', () => ({ getStaffAccount: async () => ({ address: ME }) }));

const adminBitsOf = vi.fn(async () => 0);
const managerOf = vi.fn(async () => ({ exists: false, canApprove: false }));
vi.mock('../../shared/chain/reads', async (orig) => ({
  ...(await orig<typeof import('../../shared/chain/reads')>()),
  readOrganizers: () => ({ adminBitsOf, managerOf }),
}));

const ACCEPTED: InviteCalldata = {
  to: OWNER, data: '0xdead', orgId: '9', role: 'manager', requiredSender: OWNER,
};
const acceptInvite = vi.fn(async () => ACCEPTED);
vi.mock('../../shared/api/functions', async (orig) => ({
  ...(await orig<typeof import('../../shared/api/functions')>()),
  api: { acceptInvite },
}));

const { organizerCopy } = await import('../copy');
const { AcceptInvite } = await import('./Accept');
const copy = organizerCopy.en.invite;

function open() {
  render(
    <MemoryRouter initialEntries={['/org/invite/i1']}>
      <Routes>
        <Route path="/org/invite/:inviteId" element={<AcceptInvite />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  acceptInvite.mockResolvedValue(ACCEPTED);
  adminBitsOf.mockResolvedValue(0);
  managerOf.mockResolvedValue({ exists: false, canApprove: false });
});

describe('accepting an invitation', () => {
  /**
   * Accepting binds the invitation to this account; it does not grant anything. The contract
   * takes `setManager` only from somebody holding `PERM_MANAGE_MANAGERS`, so the screen names
   * the owner and hands the invited person their own address to pass on.
   */
  it('says the owner has to finish it, and shows both addresses', async () => {
    open();
    expect(await screen.findByText(copy.accepted)).toBeInTheDocument();
    expect(screen.getByText(copy.ownerMustSend)).toBeInTheDocument();
    expect(screen.getByText(new RegExp(ME))).toBeInTheDocument();
    expect(screen.getByText(new RegExp(OWNER))).toBeInTheDocument();
    expect(acceptInvite).toHaveBeenCalledWith({ inviteId: 'i1' });
  });

  it('reads the role off the chain rather than waiting on the invite document', async () => {
    const user = userEvent.setup();
    open();
    await screen.findByText(copy.accepted);
    managerOf.mockResolvedValue({ exists: true, canApprove: false });
    await user.click(screen.getByRole('button', { name: copy.check }));

    await waitFor(() => expect(screen.getByText(copy.done)).toBeInTheDocument());
    expect(managerOf).toHaveBeenCalledWith(9n, ME);
    expect(screen.queryByText(copy.ownerMustSend)).not.toBeInTheDocument();
  });

  it('asks about admin bits for an admin invitation', async () => {
    acceptInvite.mockResolvedValue({ ...ACCEPTED, role: 'admin' });
    adminBitsOf.mockResolvedValue(3);
    open();
    await waitFor(() => expect(adminBitsOf).toHaveBeenCalledWith(9n, ME));
    expect(await screen.findByText(copy.done)).toBeInTheDocument();
  });

  it('explains each way the server can refuse rather than one sentence for all of them', async () => {
    for (const [reason, sentence] of [
      ['INVITE_NOT_FOR_YOU', copy.problems.notForYou],
      ['INVITE_ALREADY_USED', copy.problems.used],
      ['INVITE_EXPIRED', copy.problems.expired],
      ['PHONE_INDEX_MISSING', copy.problems.noPhone],
    ] as const) {
      acceptInvite.mockRejectedValueOnce(
        Object.assign(new Error(reason), { code: 'failed-precondition' }),
      );
      const view = render(
        <MemoryRouter initialEntries={['/org/invite/i1']}>
          <Routes>
            <Route path="/org/invite/:inviteId" element={<AcceptInvite />} />
          </Routes>
        </MemoryRouter>,
      );
      expect(await screen.findByText(sentence)).toBeInTheDocument();
      view.unmount();
    }
  });

  it('says so when there is no such invitation', async () => {
    acceptInvite.mockRejectedValueOnce(Object.assign(new Error('INVITE_NOT_FOUND'), { code: 'not-found' }));
    open();
    expect(await screen.findByText(copy.problems.notFound)).toBeInTheDocument();
  });
});
