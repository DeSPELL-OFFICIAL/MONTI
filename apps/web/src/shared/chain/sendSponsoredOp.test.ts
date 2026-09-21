import { describe, expect, it, vi, beforeEach } from 'vitest';
import { numberToHex } from 'viem';

const PAYMASTER = `0x${'44'.repeat(20)}` as const;
vi.mock('../config', () => ({
  getConfig: () => ({
    chainId: 10143, bundlerUrl: 'https://bundler.example',
    entryPoint: '0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789',
    addresses: { identity: `0x${'11'.repeat(20)}`, organizers: `0x${'22'.repeat(20)}`, ticket: `0x${'33'.repeat(20)}`, paymaster: PAYMASTER },
  }),
}));
vi.mock('./client', () => ({
  getPublicClient: () => ({ estimateFeesPerGas: async () => ({ maxFeePerGas: 100_000_000_000n, maxPriorityFeePerGas: 2_000_000_000n }) }),
}));
const bundlerRequest = vi.fn();
vi.mock('./bundler', () => ({ bundlerRequest }));

// Hoisted like bundlerRequest so beforeEach can clear it: `account` is cast to `never`
// for the call sites, and property access on `never` is a type error in this tsconfig.
const encodeCalls = vi.fn(async (calls: unknown[]) => (calls.length > 1 ? ('0xbatch' as const) : ('0xsingle' as const)));

const account = {
  address: `0x${'ab'.repeat(20)}` as const,
  encodeCalls,
  getNonce: vi.fn(async () => 5n),
  getFactoryArgs: vi.fn(async () => ({ factory: undefined, factoryData: undefined })),
  getStubSignature: vi.fn(async () => '0xstub' as const),
  signUserOperation: vi.fn(async () => '0xsig' as const),
} as never;

const { applyGasBuffer, encodePaymasterAndData, sendSponsoredOp, SponsoredOpTimeout } = await import('./sendSponsoredOp');

// restoreMocks only restores spies; a bare vi.fn() keeps its call history between tests.
beforeEach(() => {
  bundlerRequest.mockReset();
  encodeCalls.mockClear();
});

describe('sendSponsoredOp', () => {
  it('multiplies every simulated gas limit by 1.075', () => {
    expect(applyGasBuffer(200_000n)).toBe(215_000n);
    expect(applyGasBuffer(100_000n)).toBe(107_500n);
    expect(applyGasBuffer(50_000n)).toBe(53_750n);
    expect(applyGasBuffer(1n)).toBe(1n);
  });

  it('packs paymasterAndData as address ++ uint256 orgId', () => {
    const packed = encodePaymasterAndData(PAYMASTER, 7n);
    expect(packed).toBe(`${PAYMASTER}${'0'.repeat(63)}7`);
    expect(packed).toHaveLength(2 + 40 + 64);
  });

  it('simulates, buffers the limits, sends and resolves the receipt through wait()', async () => {
    bundlerRequest
      .mockResolvedValueOnce({ callGasLimit: '0x30d40', verificationGasLimit: '0x186a0', preVerificationGas: '0xc350' })
      .mockResolvedValueOnce('0xuserophash')
      .mockResolvedValueOnce({ success: true, receipt: { transactionHash: '0xtx', blockNumber: '0x2a' } });

    const handle = await sendSponsoredOp({
      account, orgId: 7n, calls: [{ to: `0x${'33'.repeat(20)}`, data: '0xdeadbeef' }],
    });

    const [sendMethod, sendParams] = bundlerRequest.mock.calls[1]!;
    const sent = (sendParams as unknown[])[0] as Record<string, string>;
    expect(sendMethod).toBe('eth_sendUserOperation');
    // Assert the multiplication itself, not a hand-typed hex string.
    expect(sent.callGasLimit).toBe(numberToHex(applyGasBuffer(200_000n)));
    expect(sent.verificationGasLimit).toBe(numberToHex(applyGasBuffer(100_000n)));
    expect(sent.preVerificationGas).toBe(numberToHex(applyGasBuffer(50_000n)));
    // And pin the three values so a silent change to the buffer is visible in the diff.
    expect(sent.callGasLimit).toBe('0x347d8');          // 200000 * 1.075 = 215000
    expect(sent.verificationGasLimit).toBe('0x1a3ec');  // 100000 * 1.075 = 107500
    expect(sent.preVerificationGas).toBe('0xd1f6');     //  50000 * 1.075 =  53750
    expect(sent.paymasterAndData).toBe(encodePaymasterAndData(PAYMASTER, 7n));
    expect(handle.userOpHash).toBe('0xuserophash');
    await expect(handle.wait()).resolves.toEqual({ success: true, txHash: '0xtx', blockNumber: 42n });
  });

  it('rejects with SponsoredOpTimeout when the receipt never appears', async () => {
    bundlerRequest
      .mockResolvedValueOnce({ callGasLimit: '0x1', verificationGasLimit: '0x1', preVerificationGas: '0x1' })
      .mockResolvedValueOnce('0xlost')
      .mockResolvedValue(null);
    const handle = await sendSponsoredOp({ account, orgId: 1n, calls: [{ to: `0x${'33'.repeat(20)}`, data: '0x01' }] });
    await expect(handle.wait(1)).rejects.toBeInstanceOf(SponsoredOpTimeout);
  });

  it('batches two calls through the account encoder', async () => {
    bundlerRequest
      .mockResolvedValueOnce({ callGasLimit: '0x1', verificationGasLimit: '0x1', preVerificationGas: '0x1' })
      .mockResolvedValueOnce('0xhash2');
    await sendSponsoredOp({
      account, orgId: 1n,
      calls: [{ to: `0x${'33'.repeat(20)}`, data: '0x01' }, { to: `0x${'33'.repeat(20)}`, data: '0x02' }],
    });
    const estimated = (bundlerRequest.mock.calls[0]![1] as unknown[])[0] as Record<string, string>;
    expect(estimated.callData).toBe('0xbatch');
  });
});
