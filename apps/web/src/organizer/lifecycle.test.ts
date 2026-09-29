import { beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeFunctionData } from 'viem';
import { ticketAbi } from '../shared/chain/abis';

const sendAction = vi.fn();
vi.mock('../shared/relay/sendAction', () => ({ sendAction }));

const { cancelEvent, publishEvent, saveDraft } = await import('./lifecycle');

/** A relayed refusal, shaped like `CallableError` — the code sits on `details.code`. */
const refusing = (code: string) => ({ details: { code }, message: code });

const dataFor = (functionName: 'publishEvent' | 'cancelEvent' | 'updateEventMeta', args: readonly unknown[]) =>
  encodeFunctionData({ abi: ticketAbi, functionName, args });

const ZERO32 = `0x${'00'.repeat(32)}` as const;
/** A valid `Ticket.EventMeta` so `encodeFunctionData` (run for real inside lifecycle) succeeds. */
const META = {
  orgId: 9n, titleHash: ZERO32, descHash: ZERO32, imageCid: 'cid', startsAt: 1n, endsAt: 2n,
  venueHash: ZERO32, saleStart: 0n, saleEnd: 2n, transferable: true, transferCutoffSeconds: 0,
  maxTransfers: 3, approvalRequired: false, category: 0, regionCode: ZERO32, requireKyc: false,
} as never;

beforeEach(() => {
  sendAction.mockReset().mockResolvedValue(undefined);
});

describe('the event lifecycle', () => {
  it('publishes one event through the ticket relay', async () => {
    await expect(publishEvent(5n, 9n)).resolves.toEqual({ state: 'done' });
    expect(sendAction).toHaveBeenCalledWith('publishEvent', 'ticket', dataFor('publishEvent', [5n]));
  });

  it('cancels one event through the ticket relay', async () => {
    await expect(cancelEvent(5n, 9n)).resolves.toEqual({ state: 'done' });
    expect(sendAction).toHaveBeenCalledWith('cancelEvent', 'ticket', dataFor('cancelEvent', [5n]));
  });

  it('edits a draft through updateEventMeta, which the contract refuses after publishing', async () => {
    await expect(saveDraft(5n, 9n, META, [])).resolves.toEqual({ state: 'done' });
    expect(sendAction).toHaveBeenCalledWith('updateEventMeta', 'ticket', dataFor('updateEventMeta', [5n, META, []]));
  });

  it('names each refusal the contract can answer with', async () => {
    sendAction.mockRejectedValueOnce(refusing('NotDraft'));
    await expect(publishEvent(5n, 9n)).resolves.toEqual({ state: 'refused', problem: 'notDraft' });

    sendAction.mockRejectedValueOnce(refusing('EventAlreadyClosed'));
    await expect(cancelEvent(5n, 9n)).resolves.toEqual({ state: 'refused', problem: 'closed' });

    sendAction.mockRejectedValueOnce(refusing('Unauthorized'));
    await expect(publishEvent(5n, 9n)).resolves.toEqual({ state: 'refused', problem: 'notAllowed' });
  });

  it('falls back to one sentence for a revert it has no name for', async () => {
    sendAction.mockRejectedValueOnce(refusing('SoldOut'));
    await expect(publishEvent(5n, 9n)).resolves.toEqual({ state: 'refused', problem: 'failed' });
  });
});
