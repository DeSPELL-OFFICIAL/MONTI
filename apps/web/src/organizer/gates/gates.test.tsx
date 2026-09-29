import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeFunctionData, getAddress } from 'viem';
import { organizersAbi } from '../../shared/chain/abis';

const sendAction = vi.fn(async () => undefined);
vi.mock('../../shared/relay/sendAction', () => ({ sendAction }));

const ACCOUNT = `0x${'ab'.repeat(20)}` as const;
vi.mock('../../shared/chain/accounts', () => ({ getStaffAccount: async () => ({ address: ACCOUNT }) }));

const eventOrg = vi.fn(async () => 9n);
const hasPermission = vi.fn(async () => true);
vi.mock('../../shared/chain/reads', async (orig) => ({
  ...(await orig<typeof import('../../shared/chain/reads')>()),
  readTicket: () => ({ eventOrg }),
  readOrganizers: () => ({ hasPermission }),
}));

// EIP-55, the form the backend's queue hands back (`getAddress(doc.id)`) and the form
// `readGateKey` normalises a typed-in address to.
const GATE = getAddress(`0x${'dd'.repeat(20)}`);
const KX = `0x${'01'.repeat(32)}` as const;
const KY = `0x${'02'.repeat(32)}` as const;

const listPendingGates = vi.fn(async () => [{ gateAccount: GATE, kx: KX, ky: KY, submittedAt: 1_700_000_000_000 }]);
vi.mock('../../shared/api/functions', async (orig) => ({
  ...(await orig<typeof import('../../shared/api/functions')>()),
  api: { listPendingGates },
}));

const gql = vi.fn(async () => ({ Gate: [] as unknown[] }));
vi.mock('../../shared/envio/client', () => ({ gql }));

const { organizerCopy } = await import('../copy');
const { Gates } = await import('./Gates');
const copy = organizerCopy.ko.gates;
const life = organizerCopy.ko.lifecycle;
const data = (functionName: 'registerGate' | 'openGate' | 'closeGate' | 'revokeGate', args: readonly unknown[]) =>
  encodeFunctionData({ abi: organizersAbi, functionName, args });

function open() {
  render(
    <MemoryRouter initialEntries={['/org/events/5/gates']}>
      <Routes>
        <Route path="/org/events/:eventId/gates" element={<Gates />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  listPendingGates.mockResolvedValue([{ gateAccount: GATE, kx: KX, ky: KY, submittedAt: 1_700_000_000_000 }]);
  gql.mockResolvedValue({ Gate: [] });
  hasPermission.mockResolvedValue(true);
  eventOrg.mockResolvedValue(9n);
});

describe('the pending-gate queue', () => {
  it('registers a queued terminal against the event organisation', async () => {
    const user = userEvent.setup();
    open();
    await user.click(await screen.findByRole('button', { name: copy.register }));

    await waitFor(() =>
      expect(sendAction).toHaveBeenCalledWith('registerGate', 'organizers', data('registerGate', [5n, GATE, KX, KY])),
    );
  });

  it('says so rather than showing an empty list when nothing is waiting', async () => {
    listPendingGates.mockResolvedValue([]);
    open();
    expect(await screen.findByText(copy.none)).toBeInTheDocument();
  });

  /** `GateAccountInUse`: the same terminal is already on another event's allowlist. */
  it('names the refusal when the terminal is already registered somewhere', async () => {
    const user = userEvent.setup();
    sendAction.mockRejectedValueOnce({ details: { code: 'GateAccountInUse' } });
    open();
    await user.click(await screen.findByRole('button', { name: copy.register }));
    expect(await screen.findByText(copy.problems.inUse)).toBeInTheDocument();
  });

  /** `registerGate` raises this for an event that does not exist (`Organizers.sol:127`). */
  it('says the event number is not one rather than "try again"', async () => {
    const user = userEvent.setup();
    sendAction.mockRejectedValueOnce({ details: { code: 'UnknownOrganizer' } });
    open();
    await user.click(await screen.findByRole('button', { name: copy.register }));
    expect(await screen.findByText(copy.problems.unknownEvent)).toBeInTheDocument();
  });

  /**
   * A `success: false` receipt need not carry a reason. `revertMatch` slices the four bytes off
   * one, so without the guard the catch threw a second time and the screen went silent after a
   * write that plainly did not land — no sentence, no reload, the busy banner simply gone.
   */
  it('survives a failure that carries no revert reason', async () => {
    const user = userEvent.setup();
    sendAction.mockRejectedValueOnce({ details: {} });
    open();
    const before = listPendingGates.mock.calls.length;
    await user.click(await screen.findByRole('button', { name: copy.register }));

    expect(await screen.findByText(copy.problems.failed)).toBeInTheDocument();
    // The list is reloaded either way, so whatever did land shows up in it.
    await waitFor(() => expect(listPendingGates.mock.calls.length).toBeGreaterThan(before));
  });

  it('tells an organiser without the gate permission instead of letting them send', async () => {
    hasPermission.mockResolvedValue(false);
    open();
    expect(await screen.findByText(copy.problems.notAllowed)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: copy.register })).not.toBeInTheDocument();
  });
});

describe('the paste fallback', () => {
  async function paste(user: ReturnType<typeof userEvent.setup>, kx: string, ky: string) {
    await user.type(await screen.findByLabelText(copy.account), GATE);
    await user.type(screen.getByLabelText(copy.kx), kx);
    await user.type(screen.getByLabelText(copy.ky), ky);
    await user.click(screen.getByRole('button', { name: copy.manual }));
  }

  it('sends a typed-in terminal the same way as a queued one', async () => {
    const user = userEvent.setup();
    open();
    await paste(user, KX, KY);
    await waitFor(() =>
      expect(sendAction).toHaveBeenCalledWith('registerGate', 'organizers', data('registerGate', [5n, GATE, KX, KY])),
    );
  });

  /**
   * `Organizers.registerGate` only refuses a key whose halves are BOTH zero, so a half-zero
   * key is written to the allowlist and then verifies nothing. It has to be caught here.
   */
  it('refuses a key with one zero half, which the contract would accept', async () => {
    const user = userEvent.setup();
    open();
    await paste(user, KX, `0x${'00'.repeat(32)}`);
    expect(await screen.findByText(copy.problems.halfZero)).toBeInTheDocument();
    expect(sendAction).not.toHaveBeenCalled();
  });

  it('refuses an address that is not 20 bytes', async () => {
    const user = userEvent.setup();
    open();
    await user.type(await screen.findByLabelText(copy.account), '0xnope');
    await user.type(screen.getByLabelText(copy.kx), KX);
    await user.type(screen.getByLabelText(copy.ky), KY);
    await user.click(screen.getByRole('button', { name: copy.manual }));
    expect(await screen.findByText(copy.problems.account)).toBeInTheDocument();
    expect(sendAction).not.toHaveBeenCalled();
  });
});

describe('the registered list', () => {
  /** The indexer column is `isOpen`, named after `Organizers.isOpenGate` — not `open`. */
  it('reads the open flag from the indexer as isOpen', async () => {
    gql.mockResolvedValue({
      Gate: [
        { id: '7', eventId: '5', account: GATE, kx: KX, ky: KY, isOpen: true, revoked: false },
        { id: '8', eventId: '5', account: GATE, kx: KX, ky: KY, isOpen: false, revoked: false },
      ],
    });
    open();
    expect(await screen.findByText(copy.isOpen)).toBeInTheDocument();
    expect(screen.getByText(copy.isClosed)).toBeInTheDocument();
    expect(gql).toHaveBeenCalledWith(expect.stringContaining('isOpen'), { eventId: '5' });
  });

  it('closes an open terminal by its gate number', async () => {
    const user = userEvent.setup();
    gql.mockResolvedValue({
      Gate: [{ id: '7', eventId: '5', account: GATE, kx: KX, ky: KY, isOpen: true, revoked: false }],
    });
    open();
    await user.click(await screen.findByRole('button', { name: copy.close }));
    await waitFor(() =>
      expect(sendAction).toHaveBeenCalledWith('closeGate', 'organizers', data('closeGate', [7n])),
    );
  });

  it('opens a closed terminal and retires it on request', async () => {
    const user = userEvent.setup();
    gql.mockResolvedValue({
      Gate: [{ id: '7', eventId: '5', account: GATE, kx: KX, ky: KY, isOpen: false, revoked: false }],
    });
    open();
    await user.click(await screen.findByRole('button', { name: copy.open }));
    await waitFor(() =>
      expect(sendAction).toHaveBeenCalledWith('openGate', 'organizers', data('openGate', [7n])),
    );
    await user.click(screen.getByRole('button', { name: copy.revoke }));
    await waitFor(() =>
      expect(sendAction).toHaveBeenCalledWith('revokeGate', 'organizers', data('revokeGate', [7n])),
    );
  });
});
