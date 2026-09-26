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

const {
  MIN_VERIFICATION_GAS, applyGasBuffer, encodePaymasterAndData, readOpLogs, revertDataOf, sendSponsoredOp,
} = await import('./sendSponsoredOp');

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
    expect(sent.preVerificationGas).toBe(numberToHex(applyGasBuffer(50_000n)));
    // 100000 * 1.075 = 107500, which is under the floor: the stub hides ~10.3k of P-256
    // verification, so the buffered estimate would revert AA23 once the account is deployed.
    expect(sent.verificationGasLimit).toBe(numberToHex(MIN_VERIFICATION_GAS));
    // And pin the three values so a silent change to the buffer is visible in the diff.
    expect(sent.callGasLimit).toBe('0x347d8');          // 200000 * 1.075 = 215000
    expect(sent.verificationGasLimit).toBe('0x249f0');  // the 150000 floor
    expect(sent.preVerificationGas).toBe('0xd1f6');     //  50000 * 1.075 =  53750
    expect(sent.paymasterAndData).toBe(encodePaymasterAndData(PAYMASTER, 7n));
    expect(handle.userOpHash).toBe('0xuserophash');
    await expect(handle.wait()).resolves.toEqual({
      // The hash is on the receipt as well as on the handle: a caller whose operation landed
      // without readable logs has nothing else to ask the bundler with.
      success: true, userOpHash: '0xuserophash', txHash: '0xtx',
      blockNumber: 42n, revertReason: undefined, logs: [],
    });
  });

  it('resolves a TIMEOUT receipt at the deadline instead of overrunning a slow poll', async () => {
    // The receipt poll never settles (models the 30s bundler transport timeout).
    // wait(15_000) must still resolve by the 15s deadline, not ~60s later.
    vi.useFakeTimers();
    try {
      bundlerRequest
        .mockResolvedValueOnce({ callGasLimit: '0x1', verificationGasLimit: '0x1', preVerificationGas: '0x1' })
        .mockResolvedValueOnce('0xslow')
        .mockReturnValue(new Promise(() => {}));
      const handle = await sendSponsoredOp({ account, orgId: 1n, calls: [{ to: `0x${'33'.repeat(20)}`, data: '0x01' }] });
      const waited = handle.wait(15_000);
      await vi.advanceTimersByTimeAsync(15_000);
      await expect(waited).resolves.toEqual({
        success: false, userOpHash: '0xslow', txHash: '0x',
        blockNumber: 0n, revertReason: 'TIMEOUT', logs: [],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps polling through a transient RPC error and resolves the eventual receipt', async () => {
    // A single failed poll (flaky venue wifi) must not reject the whole wait.
    vi.useFakeTimers();
    try {
      bundlerRequest
        .mockResolvedValueOnce({ callGasLimit: '0x1', verificationGasLimit: '0x1', preVerificationGas: '0x1' })
        .mockResolvedValueOnce('0xflaky')
        .mockRejectedValueOnce(new Error('transient 502'))
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ success: true, receipt: { transactionHash: '0xtx', blockNumber: '0x2a' } });
      const handle = await sendSponsoredOp({ account, orgId: 1n, calls: [{ to: `0x${'33'.repeat(20)}`, data: '0x01' }] });
      const waited = handle.wait(15_000);
      await vi.advanceTimersByTimeAsync(1_000); // two poll intervals (~600ms), well under the deadline
      await expect(waited).resolves.toEqual({
        success: true, userOpHash: '0xflaky', txHash: '0xtx',
        blockNumber: 42n, revertReason: undefined, logs: [],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * The floor exists because both accounts this app sends from are WebAuthn owners estimated
   * with viem's stub signature, which fails its challenge comparison before the P-256 precompile
   * runs and so prices ~10.3k less than a real verification. Task 13's review measured it:
   * 5,012 estimated against 15,287 on Monad. Without the floor the first op of an account lands
   * (its initCode estimate is large) and every one after it reverts AA23 — at a door.
   */
  it('floors verificationGasLimit at 150k for every account, gate and attendee alike', async () => {
    bundlerRequest
      .mockResolvedValueOnce({ callGasLimit: '0x30d40', verificationGasLimit: '0x4e20', preVerificationGas: '0xc350' })
      .mockResolvedValueOnce('0xfloored');
    await sendSponsoredOp({ account, orgId: 7n, calls: [{ to: `0x${'33'.repeat(20)}`, data: '0x01' }] });

    const sent = (bundlerRequest.mock.calls[1]![1] as unknown[])[0] as Record<string, string>;
    // 20000 * 1.075 = 21500, far under the floor.
    expect(sent.verificationGasLimit).toBe(numberToHex(MIN_VERIFICATION_GAS));
    expect(MIN_VERIFICATION_GAS).toBe(150_000n);
  });

  it('never lowers an estimate to a floor — Monad bills the limit, but AA13 bills the truth', async () => {
    bundlerRequest
      .mockResolvedValueOnce({ callGasLimit: '0x30d40', verificationGasLimit: '0x7a120', preVerificationGas: '0xc350' })
      .mockResolvedValueOnce('0xdeploy');
    // 500000 * 1.075 = 537500: an account still carrying initCode. The floor must not touch it.
    await sendSponsoredOp({
      account, orgId: 7n, calls: [{ to: `0x${'33'.repeat(20)}`, data: '0x01' }],
      gasFloors: { verificationGasLimit: 150_000n, callGasLimit: 200_000n },
    });

    const sent = (bundlerRequest.mock.calls[1]![1] as unknown[])[0] as Record<string, string>;
    expect(sent.verificationGasLimit).toBe(numberToHex(applyGasBuffer(500_000n)));
    expect(sent.callGasLimit).toBe(numberToHex(applyGasBuffer(200_000n)));
  });

  it('applies a caller’s floors to every limit, the gate’s 200k callGasLimit included', async () => {
    bundlerRequest
      .mockResolvedValueOnce({ callGasLimit: '0x2710', verificationGasLimit: '0x2710', preVerificationGas: '0x2710' })
      .mockResolvedValueOnce('0xfloors');
    await sendSponsoredOp({
      account, orgId: 7n, calls: [{ to: `0x${'33'.repeat(20)}`, data: '0x01' }],
      gasFloors: { callGasLimit: 200_000n, verificationGasLimit: 150_000n, preVerificationGas: 60_000n },
    });

    const sent = (bundlerRequest.mock.calls[1]![1] as unknown[])[0] as Record<string, string>;
    expect(sent.callGasLimit).toBe(numberToHex(200_000n));
    expect(sent.verificationGasLimit).toBe(numberToHex(150_000n));
    expect(sent.preVerificationGas).toBe(numberToHex(60_000n));
  });

  it('leaves the attendee path’s other two limits exactly where they were', async () => {
    bundlerRequest
      .mockResolvedValueOnce({ callGasLimit: '0x30d40', verificationGasLimit: '0x186a0', preVerificationGas: '0xc350' })
      .mockResolvedValueOnce('0xattendee');
    // No gasFloors at all — the attendee app never passes any.
    await sendSponsoredOp({ account, orgId: 7n, calls: [{ to: `0x${'33'.repeat(20)}`, data: '0x01' }] });

    const sent = (bundlerRequest.mock.calls[1]![1] as unknown[])[0] as Record<string, string>;
    expect(sent.callGasLimit).toBe(numberToHex(applyGasBuffer(200_000n)));
    expect(sent.preVerificationGas).toBe(numberToHex(applyGasBuffer(50_000n)));
  });

  it('signs the same limits it sends', async () => {
    bundlerRequest
      .mockResolvedValueOnce({ callGasLimit: '0x2710', verificationGasLimit: '0x2710', preVerificationGas: '0x2710' })
      .mockResolvedValueOnce('0xsigned');
    await sendSponsoredOp({
      account, orgId: 7n, calls: [{ to: `0x${'33'.repeat(20)}`, data: '0x01' }],
      gasFloors: { callGasLimit: 200_000n },
    });

    // A signature over different limits than the ones sent is an AA24 at the EntryPoint.
    const signed = (account as unknown as { signUserOperation: { mock: { calls: unknown[][] } } })
      .signUserOperation.mock.calls.at(-1)?.[0] as Record<string, bigint>;
    const sent = (bundlerRequest.mock.calls[1]![1] as unknown[])[0] as Record<string, string>;
    expect(numberToHex(signed.callGasLimit as bigint)).toBe(sent.callGasLimit);
    expect(numberToHex(signed.verificationGasLimit as bigint)).toBe(sent.verificationGasLimit);
    expect(numberToHex(signed.preVerificationGas as bigint)).toBe(sent.preVerificationGas);
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

describe('the logs one operation emitted', () => {
  it('carries the operation\'s own logs off the receipt, so a caller can read what it created', async () => {
    const log = { address: `0x${'44'.repeat(20)}`, topics: ['0xaa'], data: '0x' };
    bundlerRequest
      .mockResolvedValueOnce({ callGasLimit: '0x186a0', verificationGasLimit: '0x186a0', preVerificationGas: '0xc350' })
      .mockResolvedValueOnce('0xuserophash')
      .mockResolvedValueOnce({ success: true, logs: [log], receipt: { transactionHash: '0xtx', blockNumber: '0x2a' } });
    const handle = await sendSponsoredOp({ account, orgId: 1n, calls: [{ to: `0x${'33'.repeat(20)}`, data: '0x01' }] });
    await expect(handle.wait()).resolves.toMatchObject({ logs: [log] });
  });

  /** A bundler that omits `logs` is not a failure — the caller simply learns nothing from them. */
  it('answers with none when the bundler sends none, or sends something that is not a list', async () => {
    expect(readOpLogs(null)).toEqual([]);
    expect(readOpLogs(undefined)).toEqual([]);
    expect(readOpLogs({})).toEqual([]);
    expect(readOpLogs({ logs: 'nope' })).toEqual([]);
  });
});

describe('the reason a simulated operation reverted with', () => {
  it('reads it out of the bundler rejection, however deep viem wrapped it', () => {
    expect(revertDataOf({ data: { revertData: '0xdba16ce8' } })).toBe('0xdba16ce8');
    expect(revertDataOf({ cause: { cause: { data: { revertData: '0xDBA16CE8' } } } })).toBe('0xDBA16CE8');
    // A revert with arguments is longer than a selector, and is kept whole.
    expect(revertDataOf({ data: { revertData: `0x08c379a0${'00'.repeat(32)}` } }))
      .toBe(`0x08c379a0${'00'.repeat(32)}`);
  });

  it('yields nothing for anything that is not one', () => {
    expect(revertDataOf(new Error('fetch failed'))).toBeUndefined();
    expect(revertDataOf({ data: 'execution reverted' })).toBeUndefined();
    expect(revertDataOf({ data: { revertData: '0x' } })).toBeUndefined();
    expect(revertDataOf({ data: { revertData: 42 } })).toBeUndefined();
    expect(revertDataOf(null)).toBeUndefined();
    // A cycle deeper than the walk goes is not found, and does not hang.
    expect(revertDataOf({ cause: { cause: { cause: { cause: { cause: { data: { revertData: '0xdba16ce8' } } } } } } }))
      .toBeUndefined();
  });
});
