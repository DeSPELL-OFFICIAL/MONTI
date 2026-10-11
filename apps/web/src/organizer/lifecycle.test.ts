import { beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeFunctionData } from 'viem';
import { ticketAbi } from '../shared/chain/abis';

const sendAction = vi.fn();
vi.mock('../shared/relay/sendAction', () => ({ sendAction }));

const { cancelEvent } = await import('./lifecycle');

/** A relayed refusal, shaped like `CallableError` — the code sits on `details.code`. */
const refusing = (code: string) => ({ details: { code }, message: code });

beforeEach(() => {
  sendAction.mockReset().mockResolvedValue(undefined);
});

describe('cancelling an event', () => {
  it('cancels one event through the ticket relay', async () => {
    await expect(cancelEvent(5n)).resolves.toEqual({ state: 'done' });
    expect(sendAction).toHaveBeenCalledWith(
      'cancelEvent', 'ticket', encodeFunctionData({ abi: ticketAbi, functionName: 'cancelEvent', args: [5n] }),
    );
  });

  it('names each refusal the contract can answer with', async () => {
    sendAction.mockRejectedValueOnce(refusing('EventAlreadyClosed'));
    await expect(cancelEvent(5n)).resolves.toEqual({ state: 'refused', problem: 'closed' });
    sendAction.mockRejectedValueOnce(refusing('Unauthorized'));
    await expect(cancelEvent(5n)).resolves.toEqual({ state: 'refused', problem: 'notAllowed' });
  });

  it('falls back to one sentence for a revert it has no name for', async () => {
    sendAction.mockRejectedValueOnce(refusing('SoldOut'));
    await expect(cancelEvent(5n)).resolves.toEqual({ state: 'refused', problem: 'failed' });
  });
});
