import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { parseAbi, parseTransaction } from 'viem';
import {
  MONAD_TESTNET_CHAIN_ID,
  MONAD_TESTNET_RPC_URL,
  withGasMargin,
} from '@monti/shared';
import type { Hex } from '@monti/shared';
import {
  awaitFinalized,
  deployment,
  gasLimitFor,
  monadChain,
  publicClient,
  sendAttesterTx,
  walletClient,
} from '../src/lib/chain.js';

const ANVIL_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as Hex;
const ANVIL_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const TICKET = '0x00000000000000000000000000000000000000AA' as Hex;
const TX_HASH = `0x${'ab'.repeat(32)}` as Hex;
const BASE_FEE = 100_000_000_000n; // Monad 고정 base fee 100 gwei

interface RpcCall {
  method: string;
  params: unknown[];
}

/** viem http 트랜스포트는 전역 fetch 를 호출한다. 그 한 겹만 가짜로 덮어 네트워크 없이 돌린다. */
function stubRpc(handlers: Record<string, (params: unknown[]) => unknown>): RpcCall[] {
  const calls: RpcCall[] = [];
  vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
    const request = JSON.parse(init.body) as { id: number; method: string; params?: unknown[] };
    const params = request.params ?? [];
    calls.push({ method: request.method, params });
    const handler = handlers[request.method];
    // 스텁하지 않은 메서드는 실제 노드처럼 JSON-RPC "method not found" 로 답한다.
    // (viem 은 eth_fillTransaction 을 먼저 찔러 보고 없으면 eth_estimateGas 로 내려온다.)
    const payload = handler
      ? { jsonrpc: '2.0', id: request.id, result: handler(params) }
      : { jsonrpc: '2.0', id: request.id, error: { code: -32601, message: `Method not found: ${request.method}` } };
    return new Response(JSON.stringify(payload), { headers: { 'Content-Type': 'application/json' } });
  });
  return calls;
}

function block(number: bigint, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { number: `0x${number.toString(16)}`, hash: `0x${'11'.repeat(32)}`, ...extra };
}

// firebase-functions 파라미터는 런타임에 process.env 만 읽는다(기본값은 배포 때 구워진다).
// 배포된 함수가 받는 것과 같은 환경을 테스트가 직접 만들어 준다.
const TESTNET_ID = String(MONAD_TESTNET_CHAIN_ID);
const saved: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const key of ['ATTESTER_PK', 'CHAIN_ID', 'RPC_URL']) saved[key] = process.env[key];
  process.env.ATTESTER_PK = ANVIL_PK;
  process.env.CHAIN_ID = TESTNET_ID;
  process.env.RPC_URL = MONAD_TESTNET_RPC_URL;
});
afterAll(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('monadChain', () => {
  it('is built from CHAIN_ID and never hardcoded in logic', () => {
    expect(monadChain().id).toBe(10143);
    expect(monadChain().nativeCurrency.symbol).toBe('MON');
  });

  it('follows CHAIN_ID when it moves', () => {
    process.env.CHAIN_ID = '143';
    try {
      expect(monadChain().id).toBe(143);
      expect(monadChain().name).toBe('Monad');
    } finally {
      process.env.CHAIN_ID = TESTNET_ID;
    }
    expect(monadChain().id).toBe(MONAD_TESTNET_CHAIN_ID);
  });
});

describe('deployment', () => {
  it('returns the addresses recorded for CHAIN_ID without second-guessing them', () => {
    const current = deployment();
    expect(current.chainId).toBe(MONAD_TESTNET_CHAIN_ID);
    expect(current.forwarder).toMatch(/^0x[0-9a-fA-F]{40}$/);
    // 아직 배포 전이라 주소가 0인 상태 그대로 통과해야 한다. 특별 취급하지 않는다.
    expect(typeof current.attester).toBe('string');
  });

  it('fails loudly when CHAIN_ID has no deployment file', () => {
    process.env.CHAIN_ID = '31337';
    try {
      expect(() => deployment()).toThrow('NO_DEPLOYMENT:31337');
    } finally {
      process.env.CHAIN_ID = TESTNET_ID;
    }
  });
});

describe('gasLimitFor', () => {
  it('applies the Monad 7.5% margin', () => {
    expect(gasLimitFor(275_000n)).toBe(withGasMargin(275_000n));
    expect(gasLimitFor(275_000n)).toBe(295_625n);
  });

  it('never returns a limit below the estimate', () => {
    expect(gasLimitFor(1n)).toBeGreaterThanOrEqual(1n);
    expect(gasLimitFor(0n)).toBe(0n);
  });
});

describe('clients', () => {
  it('points the public client at RPC_URL on the configured chain', () => {
    expect(publicClient().chain?.id).toBe(MONAD_TESTNET_CHAIN_ID);
  });

  it('signs with the attester account', () => {
    expect(walletClient().account.address).toBe(ANVIL_ADDRESS);
  });

  // 블록타임이 없는 체인 정의면 viem 기본 폴링이 4 s 라 영수증 대기가 블록(≈0.4–1 s)보다 3 s 늦다.
  it('polls receipts every 1 s, not the 4 s viem default', () => {
    expect(publicClient().pollingInterval).toBe(1_000);
    expect(walletClient().pollingInterval).toBe(1_000);
  });
});

describe('sendAttesterTx', () => {
  const abi = parseAbi(['function markUsed(uint256 tokenId)']);

  it('sends the estimate plus the shared gas margin and returns the hash', async () => {
    const estimate = 275_000n;
    let raw: Hex | undefined;
    const calls = stubRpc({
      eth_chainId: () => `0x${MONAD_TESTNET_CHAIN_ID.toString(16)}`,
      eth_estimateGas: () => `0x${estimate.toString(16)}`,
      eth_getTransactionCount: () => '0x7',
      eth_getBlockByNumber: () => block(9n, { baseFeePerGas: `0x${BASE_FEE.toString(16)}` }),
      eth_maxPriorityFeePerGas: () => '0x3b9aca00',
      eth_sendRawTransaction: (params) => {
        raw = params[0] as Hex;
        return TX_HASH;
      },
    });

    const hash = await sendAttesterTx({ address: TICKET, abi, functionName: 'markUsed', args: [1n] });

    expect(hash).toBe(TX_HASH);
    expect(calls.map((call) => call.method)).toContain('eth_estimateGas');
    expect(parseTransaction(raw as Hex).gas).toBe(withGasMargin(estimate));
    // 가스 한도는 반드시 명시된다. 추정치를 그대로 보내면 Monad 에서 실패한다.
    expect(parseTransaction(raw as Hex).gas).toBeGreaterThan(estimate);
    // finality 는 호출자 몫이다. 여기서 영수증이나 finalized 블록을 기다리지 않는다.
    expect(calls.map((call) => call.method)).not.toContain('eth_getTransactionReceipt');
    expect(calls.filter((call) => call.method === 'eth_getBlockByNumber').every((call) => call.params[0] !== 'finalized')).toBe(true);
  });
});

describe('awaitFinalized', () => {
  it('resolves once the finalized head reaches the block', async () => {
    let head = 4n;
    const calls = stubRpc({
      eth_getBlockByNumber: () => {
        const current = head;
        head += 3n;
        return block(current);
      },
    });

    await awaitFinalized(7n);

    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls[0]?.params[0]).toBe('finalized');
  });

  it('throws FINALITY_TIMEOUT when the head never catches up', async () => {
    stubRpc({ eth_getBlockByNumber: () => block(1n) });
    await expect(awaitFinalized(999n, 10)).rejects.toThrow('FINALITY_TIMEOUT');
  });
});
