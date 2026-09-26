import { beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeErrorResult } from 'viem';
import { ticketAbi } from '../shared/chain/abis';

interface SentOp { functionName: string; orgId: bigint; args: readonly unknown[] }
const ticketOp = vi.fn(async (_options: SentOp) => ({ success: true }));
vi.mock('../shared/chain/ops', async (orig) => ({
  ...(await orig<typeof import('../shared/chain/ops')>()),
  ticketOp,
}));

const ACCOUNT = `0x${'ab'.repeat(20)}` as const;
vi.mock('../shared/chain/accounts', () => ({ getStaffAccount: async () => ({ address: ACCOUNT }) }));

const { OpReverted } = await import('../shared/chain/ops');
const { cancelEvent, publishEvent, saveDraft } = await import('./lifecycle');

const reverting = (errorName: string) =>
  new OpReverted('publishEvent', encodeErrorResult({ abi: ticketAbi, errorName }));

beforeEach(() => {
  ticketOp.mockResolvedValue({ success: true });
});

describe('the event lifecycle', () => {
  it('publishes one event for one organisation', async () => {
    await expect(publishEvent(5n, 9n)).resolves.toEqual({ state: 'done' });
    expect(ticketOp).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: 9n, functionName: 'publishEvent', args: [5n] }),
    );
  });

  it('cancels one event for one organisation', async () => {
    await expect(cancelEvent(5n, 9n)).resolves.toEqual({ state: 'done' });
    expect(ticketOp).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: 9n, functionName: 'cancelEvent', args: [5n] }),
    );
  });

  it('edits a draft through updateEventMeta, which the contract refuses after publishing', async () => {
    const meta = { orgId: 9n } as never;
    await expect(saveDraft(5n, 9n, meta, [])).resolves.toEqual({ state: 'done' });
    expect(ticketOp).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: 'updateEventMeta', args: [5n, meta, []] }),
    );
  });

  it('names each refusal the contract can answer with', async () => {
    ticketOp.mockRejectedValueOnce(reverting('NotDraft'));
    await expect(publishEvent(5n, 9n)).resolves.toEqual({ state: 'refused', problem: 'notDraft' });

    ticketOp.mockRejectedValueOnce(reverting('EventAlreadyClosed'));
    await expect(cancelEvent(5n, 9n)).resolves.toEqual({ state: 'refused', problem: 'closed' });

    ticketOp.mockRejectedValueOnce(reverting('Unauthorized'));
    await expect(publishEvent(5n, 9n)).resolves.toEqual({ state: 'refused', problem: 'notAllowed' });
  });

  it('treats a wait that gave up as still confirming, not as a failure', async () => {
    ticketOp.mockRejectedValueOnce(new OpReverted('publishEvent', 'TIMEOUT'));
    await expect(publishEvent(5n, 9n)).resolves.toEqual({ state: 'confirming' });
  });

  /** Until sub-plan 01b's `setAllowed` the paymaster sponsors no organiser selector at all. */
  it('says plainly when nothing will pay for the write yet', async () => {
    ticketOp.mockRejectedValueOnce(
      new Error('UserOperation reverted during simulation with reason: SelectorNotAllowed()'),
    );
    await expect(publishEvent(5n, 9n)).resolves.toEqual({ state: 'unsponsored' });
  });

  it('falls back to one sentence for a revert it has no name for', async () => {
    ticketOp.mockRejectedValueOnce(reverting('SoldOut'));
    await expect(publishEvent(5n, 9n)).resolves.toEqual({ state: 'refused', problem: 'failed' });
  });
});
