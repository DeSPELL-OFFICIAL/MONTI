import { beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeFunctionData, getAddress, numberToHex, toFunctionSelector } from 'viem';

const sendSponsoredOp = vi.fn();
// Only the round trip is replaced. `revertDataOf` stays real, because the whole point of the
// estimate-time test below is that the four bytes are read out of a real bundler rejection.
vi.mock('./sendSponsoredOp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./sendSponsoredOp')>()),
  sendSponsoredOp,
}));
// The ABI is deliberately *not* mocked: a hand-written fragment here would let a renamed or
// re-typed contract function ship green. Everything below encodes against the generated JSON.
vi.mock('../config', () => ({ getConfig: () => ({ addresses: { ticket: `0x${'33'.repeat(20)}`, identity: `0x${'11'.repeat(20)}`, organizers: `0x${'22'.repeat(20)}` } }) }));
// `resolveSubmittedOp` is the only thing here that reaches the bundler and the public client
// directly (everything else goes through the mocked `sendSponsoredOp`), so both are replaced.
const bundlerRequest = vi.fn();
vi.mock('./bundler', () => ({ bundlerRequest }));
const estimateFeesPerGas = vi.fn();
vi.mock('./client', () => ({ getPublicClient: () => ({ estimateFeesPerGas }) }));

const { OpReverted, ticketOp, resolveSubmittedOp, STALE_OP_AGE_MS } = await import('./ops');
const { ticketAbi } = await import('./abis');
const { revertMatch } = await import('./revert');
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

/**
 * A revert the bundler caught while *simulating* produces no operation and no receipt, so
 * until now it left this layer as viem's own `RpcRequestError` and every screen fell through
 * to its most generic sentence. That is the whole of the founder's "행사를 만들지 못했어요"
 * (task-create-failure-2 report §0): the four bytes naming the rule were in the rejection all
 * along, one `data.revertData` down.
 */
describe('a revert the bundler caught while estimating', () => {
  /** Exactly what Alchemy answered `eth_estimateUserOperationGas` with, viem-wrapped. */
  function estimateReverted(revertData: string, message = 'execution reverted'): Error {
    const rpc = Object.assign(new Error(message), {
      code: -32521, data: { revertData },
    });
    return Object.assign(new Error(`RPC Request failed. ${message}`), {
      name: 'RpcRequestError', cause: rpc,
    });
  }

  it('becomes the same OpReverted a landed revert does, and maps to the rule it names', async () => {
    const invalidSchedule = toFunctionSelector('InvalidSchedule()');
    expect(invalidSchedule).toBe('0xdba16ce8');
    sendSponsoredOp.mockRejectedValueOnce(estimateReverted(invalidSchedule));
    const thrown: unknown = await ticketOp({ account, orgId: 9n, functionName: 'claim', args: [5n, 0, '0x'] })
      .catch((cause: unknown) => cause);
    expect(thrown).toBeInstanceOf(OpReverted);
    expect((thrown as InstanceType<typeof OpReverted>).revertReason).toBe(invalidSchedule);
    // Which is what puts the scene's own sentence on screen instead of the generic one.
    expect(revertMatch(ticketAbi, invalidSchedule, [['InvalidSchedule', 'schedule'] as const]))
      .toBe('schedule');
  });

  it('leaves a paymaster refusal alone — that is sponsorship, not a rule anybody broke', async () => {
    const refusal = estimateReverted(toFunctionSelector('SelectorNotAllowed()'), 'AA33 reverted');
    sendSponsoredOp.mockRejectedValueOnce(refusal);
    await expect(ticketOp({ account, orgId: 9n, functionName: 'claim', args: [5n, 0, '0x'] }))
      .rejects.toBe(refusal);
  });

  it('rethrows a rejection that carries no revert data untouched', async () => {
    const offline = new Error('fetch failed');
    sendSponsoredOp.mockRejectedValueOnce(offline);
    await expect(ticketOp({ account, orgId: 9n, functionName: 'claim', args: [5n, 0, '0x'] }))
      .rejects.toBe(offline);
  });
});


/**
 * `resolveSubmittedOp` is what tells a `createEvent` op that is still on its way from one that is
 * dead or stuck, so the create path can escape an account welded to a pre-fix underpriced op and
 * resend at the corrected fee (task-create-failure-4). A receipt settles it; with none, the op is
 * looked up by hash and judged on where it is, how it is priced, and how long it has waited.
 */
describe('resolveSubmittedOp', () => {
  const HASH = `0x${'ab'.repeat(32)}` as const;
  const GWEI = 1_000_000_000n;

  beforeEach(() => {
    bundlerRequest.mockReset();
    estimateFeesPerGas.mockReset();
    // A fresh send would price at 202 gwei (2x Monad's 100 gwei base + 2 gwei priority).
    estimateFeesPerGas.mockResolvedValue({ maxFeePerGas: 202n * GWEI, maxPriorityFeePerGas: 2n * GWEI });
  });

  function bundler(receipt: unknown, byHash: unknown): void {
    bundlerRequest.mockImplementation(async (method: string) =>
      (method === 'eth_getUserOperationReceipt' ? receipt : byHash));
  }

  it('reads a landed receipt as landed, and a reverted one as failed', async () => {
    bundler({ success: true, logs: [] }, null);
    await expect(resolveSubmittedOp(HASH)).resolves.toMatchObject({ state: 'landed' });
    bundler({ success: false, logs: [] }, null);
    await expect(resolveSubmittedOp(HASH)).resolves.toMatchObject({ state: 'failed' });
  });

  it('is failed when the op has been dropped from the mempool', async () => {
    // No receipt, and the bundler no longer knows the op at all.
    bundler(null, null);
    await expect(resolveSubmittedOp(HASH)).resolves.toMatchObject({ state: 'failed' });
  });

  it('is stale when a mempool op is priced below the current fee floor', async () => {
    // The pre-fix 122 gwei op: still in the mempool, below the 202 gwei a fresh send would pay.
    bundler(null, { blockNumber: null, userOperation: { maxFeePerGas: numberToHex(122n * GWEI) } });
    await expect(resolveSubmittedOp(HASH, Date.now())).resolves.toMatchObject({ state: 'stale' });
  });

  it('is stale when an adequately-priced mempool op has waited past the horizon', async () => {
    bundler(null, { blockNumber: null, userOperation: { maxFeePerGas: numberToHex(202n * GWEI) } });
    const old = Date.now() - STALE_OP_AGE_MS - 1_000;
    await expect(resolveSubmittedOp(HASH, old)).resolves.toMatchObject({ state: 'stale' });
  });

  it('is pending for a young, adequately-priced mempool op', async () => {
    bundler(null, { blockNumber: null, userOperation: { maxFeePerGas: numberToHex(202n * GWEI) } });
    await expect(resolveSubmittedOp(HASH, Date.now())).resolves.toMatchObject({ state: 'pending' });
  });

  it('is pending when the op is mined but the receipt has not caught up', async () => {
    bundler(null, { blockNumber: numberToHex(123n), userOperation: { maxFeePerGas: numberToHex(202n * GWEI) } });
    await expect(resolveSubmittedOp(HASH, Date.now())).resolves.toMatchObject({ state: 'pending' });
  });
});
