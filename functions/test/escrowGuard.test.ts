import { beforeEach, describe, expect, it, vi } from 'vitest';
import { settlementVaultAbi } from '@monti/shared';

const VAULT = '0x5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a';
const USDC = '0x534b2f3A21130d7a60830c2Df862319e593943A3';

/** 배포 JSON. 금고가 없는 배포(무료 전용)를 시험할 때 undefined 로 바꾼다. */
let settlementVault: string | undefined = VAULT;
/** tokenId → escrow status(0 None · 1 Held · 2 Released · 3 Refunded). 없는 토큰은 0. */
const statusOf = new Map<bigint, number>();

const escrowTuple = (tokenId: bigint) => [USDC, 1_000_000n, VAULT, 1_730_000_000n, statusOf.get(tokenId) ?? 0] as const;

const readContract = vi.fn(async ({ args }: { args: readonly [bigint] }) => escrowTuple(args[0]));
const multicall = vi.fn(async ({ contracts }: { contracts: { args: readonly [bigint] }[] }) =>
  contracts.map(({ args }) => escrowTuple(args[0])),
);

vi.mock('../src/lib/chain.js', () => ({
  publicClient: () => ({ readContract, multicall }),
  deployment: () => ({ settlementVault }),
}));

const { isRefunded, refundedAmong, MULTICALL3, REFUNDED_CHECKIN_CODE, REFUNDED_ACTION_CODE } = await import(
  '../src/lib/escrowGuard.js'
);

beforeEach(() => {
  settlementVault = VAULT;
  statusOf.clear();
  readContract.mockClear();
  multicall.mockClear();
});

describe('isRefunded', () => {
  it('is true for a refunded escrow (status 3)', async () => {
    statusOf.set(7n, 3);
    expect(await isRefunded(7n)).toBe(true);
  });

  it.each([
    [1, 'held'],
    [2, 'released'],
  ])('is false for status %i (%s)', async (status) => {
    statusOf.set(7n, status);
    expect(await isRefunded(7n)).toBe(false);
  });

  it('is false for a free-tier ticket that was never escrowed (status 0)', async () => {
    expect(await isRefunded(7n)).toBe(false);
  });

  it('reads SettlementVault.escrowOf(tokenId) once', async () => {
    await isRefunded(7n);
    expect(readContract).toHaveBeenCalledTimes(1);
    expect(readContract).toHaveBeenCalledWith({
      address: VAULT,
      abi: settlementVaultAbi,
      functionName: 'escrowOf',
      args: [7n],
    });
  });

  it('is false without a vault in the deployment and makes no call', async () => {
    settlementVault = undefined;
    expect(await isRefunded(7n)).toBe(false);
    expect(readContract).not.toHaveBeenCalled();
  });

  it('lets an RPC failure surface instead of admitting on a guess', async () => {
    readContract.mockRejectedValueOnce(new Error('RPC_DOWN'));
    await expect(isRefunded(7n)).rejects.toThrow('RPC_DOWN');
  });
});

describe('refundedAmong', () => {
  it('returns only the refunded ids out of a mixed batch, in one multicall', async () => {
    statusOf.set(1n, 1);
    statusOf.set(2n, 3);
    statusOf.set(3n, 2);
    statusOf.set(5n, 3);
    const refunded = await refundedAmong([1n, 2n, 3n, 4n, 5n]);
    expect([...refunded].sort()).toEqual(['2', '5']);
    expect(multicall).toHaveBeenCalledTimes(1);
    expect(multicall.mock.calls[0]![0]).toMatchObject({
      allowFailure: false,
      batchSize: 0,
      multicallAddress: MULTICALL3,
    });
    expect(MULTICALL3).toBe('0xcA11bde05977b3631167028862bE2a173976CA11');
  });

  it('makes no call for an empty list or a deployment without a vault', async () => {
    expect((await refundedAmong([])).size).toBe(0);
    settlementVault = undefined;
    expect((await refundedAmong([1n])).size).toBe(0);
    expect(multicall).not.toHaveBeenCalled();
  });
});

describe('codes', () => {
  it('reuses the revoked-ticket codes the web already maps', () => {
    expect(REFUNDED_CHECKIN_CODE).toBe('REVOKED');
    expect(REFUNDED_ACTION_CODE).toBe('TicketRevoked');
  });
});
