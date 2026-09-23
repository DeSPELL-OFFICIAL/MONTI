import { describe, expect, it, vi } from 'vitest';
import { decodeFunctionData, getAddress, toFunctionSelector } from 'viem';

const sendSponsoredOp = vi.fn();
vi.mock('./sendSponsoredOp', () => ({ sendSponsoredOp }));
// The ABI is deliberately *not* mocked: a hand-written fragment here would let a renamed or
// re-typed contract function ship green. Everything below encodes against the generated JSON.
vi.mock('../config', () => ({ getConfig: () => ({ addresses: { ticket: `0x${'33'.repeat(20)}`, identity: `0x${'11'.repeat(20)}`, organizers: `0x${'22'.repeat(20)}` } }) }));

const { OpReverted, ticketOp } = await import('./ops');
const { ticketAbi } = await import('./abis');
const account = { address: `0x${'ab'.repeat(20)}` } as never;

function landed() {
  sendSponsoredOp.mockResolvedValueOnce({
    userOpHash: '0x1', wait: async () => ({ success: true, txHash: '0x2', blockNumber: 7n }),
  });
}

function sentCall(index = 0) {
  const sent = sendSponsoredOp.mock.calls[index]![0] as { orgId: bigint; calls: Array<{ to: string; data: string }> };
  return { orgId: sent.orgId, to: sent.calls[0]!.to, data: sent.calls[0]!.data as `0x${string}` };
}

describe('ticketOp', () => {
  it('encodes the call against the ticket address and returns the receipt', async () => {
    landed();
    await expect(ticketOp({ account, orgId: 9n, functionName: 'claim', args: [5n, 0, '0x'] }))
      .resolves.toMatchObject({ success: true, blockNumber: 7n });
    const sent = sentCall();
    expect(sent.orgId).toBe(9n);
    expect(sent.to).toBe(`0x${'33'.repeat(20)}`);
    // The real selector, written out here rather than read back from the same ABI.
    expect(sent.data.slice(0, 10)).toBe(toFunctionSelector('claim(uint256,uint8,bytes)'));
    expect(decodeFunctionData({ abi: ticketAbi, data: sent.data }))
      .toMatchObject({ functionName: 'claim', args: [5n, 0, '0x'] });
  });

  it('picks the three-argument safeTransferFrom overload, not the one that takes data', async () => {
    sendSponsoredOp.mockReset();
    landed();
    const from = `0x${'aa'.repeat(20)}` as const;
    const to = `0x${'bb'.repeat(20)}` as const;
    await ticketOp({ account, orgId: 9n, functionName: 'safeTransferFrom', args: [from, to, 1n] });
    const sent = sentCall();
    expect(sent.data.slice(0, 10)).toBe('0x42842e0e');
    expect(sent.data.slice(0, 10)).toBe(toFunctionSelector('safeTransferFrom(address,address,uint256)'));
    expect(decodeFunctionData({ abi: ticketAbi, data: sent.data }))
    // viem decodes addresses checksummed, so compare against the checksummed form.
      .toMatchObject({ functionName: 'safeTransferFrom', args: [getAddress(from), getAddress(to), 1n] });
  });

  it('throws OpReverted when the operation lands but the contract reverts', async () => {
    sendSponsoredOp.mockResolvedValueOnce({
      userOpHash: '0x1', wait: async () => ({ success: false, txHash: '0x2', blockNumber: 7n, revertReason: '0xdead' }),
    });
    await expect(ticketOp({ account, orgId: 9n, functionName: 'claim', args: [5n, 0, '0x'] }))
      .rejects.toBeInstanceOf(OpReverted);
  });
});
