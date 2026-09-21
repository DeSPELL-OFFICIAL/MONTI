import { describe, expect, it, vi } from 'vitest';

const sendSponsoredOp = vi.fn();
vi.mock('./sendSponsoredOp', () => ({ sendSponsoredOp }));
vi.mock('./abis', () => ({
  ticketAbi: [{ type: 'function', name: 'claim', stateMutability: 'nonpayable',
    inputs: [{ name: 'eventId', type: 'uint256' }, { name: 'tier', type: 'uint8' }, { name: 'voucher', type: 'bytes' }],
    outputs: [{ name: '', type: 'uint256' }] }],
  identityAbi: [], organizersAbi: [],
}));
vi.mock('../config', () => ({ getConfig: () => ({ addresses: { ticket: `0x${'33'.repeat(20)}`, identity: `0x${'11'.repeat(20)}`, organizers: `0x${'22'.repeat(20)}` } }) }));

const { OpReverted, ticketOp } = await import('./ops');
const account = { address: `0x${'ab'.repeat(20)}` } as never;

describe('ticketOp', () => {
  it('encodes the call against the ticket address and returns the receipt', async () => {
    sendSponsoredOp.mockResolvedValueOnce({
      userOpHash: '0x1', wait: async () => ({ success: true, txHash: '0x2', blockNumber: 7n }),
    });
    await expect(ticketOp({ account, orgId: 9n, functionName: 'claim', args: [5n, 0, '0x'] }))
      .resolves.toMatchObject({ success: true, blockNumber: 7n });
    const sent = sendSponsoredOp.mock.calls[0]![0] as { orgId: bigint; calls: Array<{ to: string; data: string }> };
    expect(sent.orgId).toBe(9n);
    expect(sent.calls[0]!.to).toBe(`0x${'33'.repeat(20)}`);
    expect(sent.calls[0]!.data.startsWith('0x')).toBe(true);
  });

  it('throws OpReverted when the operation lands but the contract reverts', async () => {
    sendSponsoredOp.mockResolvedValueOnce({
      userOpHash: '0x1', wait: async () => ({ success: false, txHash: '0x2', blockNumber: 7n, revertReason: '0xdead' }),
    });
    await expect(ticketOp({ account, orgId: 9n, functionName: 'claim', args: [5n, 0, '0x'] }))
      .rejects.toBeInstanceOf(OpReverted);
  });
});
