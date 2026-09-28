import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseTransaction } from 'viem';
import { MONAD_TESTNET_CHAIN_ID, MONAD_TESTNET_RPC_URL } from '@monti/shared';
import type { Hex } from '@monti/shared';

process.env.GCP_PROJECT_ID = 'monti-dev';

// 릴레이어 리스는 system/relayer 문서 하나와 트랜잭션만 쓴다. attesterLock.test 와 같은 가짜 Firestore.
const docs = new Map<string, Record<string, unknown>>();
function snapshot(path: string) {
  const data = docs.get(path);
  return { exists: data !== undefined, get: (key: string) => data?.[key], data: () => data };
}
function write(path: string, data: Record<string, unknown>, options?: { merge?: boolean }): void {
  const previous = options?.merge ? (docs.get(path) ?? {}) : {};
  docs.set(path, { ...previous, ...data });
}
function docRef(path: string) {
  return {
    path,
    get: async () => snapshot(path),
    set: async (data: Record<string, unknown>, options?: { merge?: boolean }) => write(path, data, options),
  };
}
vi.mock('../src/lib/db.js', () => ({
  SYSTEM: 'system',
  db: {
    collection: (name: string) => ({ doc: (id: string) => docRef(`${name}/${id}`) }),
    runTransaction: async <T>(body: (tx: unknown) => Promise<T>): Promise<T> => {
      const pending: Array<() => void> = [];
      const tx = {
        get: async (ref: { path: string }) => snapshot(ref.path),
        set: (ref: { path: string }, data: Record<string, unknown>, options?: { merge?: boolean }) => {
          pending.push(() => write(ref.path, data, options));
        },
      };
      const result = await body(tx);
      for (const apply of pending) apply();
      return result;
    },
  },
}));

const {
  getRelayerAccount,
  relayerFees,
  sendRelayed,
  RELAYER_MAX_PRIORITY_FEE_WEI,
  RELAYER_MAX_FEE_CAP_WEI,
} = await import('../src/lib/relayer.js');

const ANVIL_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as Hex;
const ANVIL_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const TICKET = '0x00000000000000000000000000000000000000AA' as Hex;
const DATA = '0xdeadbeef' as Hex;
const TX_HASH = `0x${'ab'.repeat(32)}` as Hex;
const BASE_FEE = 100_000_000_000n; // Monad 고정 base fee 100 gwei
const GWEI = 1_000_000_000n;

interface RpcCall {
  method: string;
  params: unknown[];
}
interface RpcErr {
  __rpcError: { code: number; message: string };
}
function stubRpc(handlers: Record<string, (params: unknown[]) => unknown>): RpcCall[] {
  const calls: RpcCall[] = [];
  vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
    const request = JSON.parse(init.body) as { id: number; method: string; params?: unknown[] };
    const params = request.params ?? [];
    calls.push({ method: request.method, params });
    const handler = handlers[request.method];
    let payload: unknown;
    if (!handler) {
      payload = { jsonrpc: '2.0', id: request.id, error: { code: -32601, message: `Method not found: ${request.method}` } };
    } else {
      const result = handler(params);
      if (result && typeof result === 'object' && '__rpcError' in (result as RpcErr)) {
        payload = { jsonrpc: '2.0', id: request.id, error: (result as RpcErr).__rpcError };
      } else {
        payload = { jsonrpc: '2.0', id: request.id, result };
      }
    }
    return new Response(JSON.stringify(payload), { headers: { 'Content-Type': 'application/json' } });
  });
  return calls;
}
function block(baseFeeWei: bigint): Record<string, unknown> {
  return { number: '0x9', hash: `0x${'11'.repeat(32)}`, baseFeePerGas: `0x${baseFeeWei.toString(16)}` };
}

const saved: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const key of ['RELAYER_PK', 'CHAIN_ID', 'RPC_URL']) saved[key] = process.env[key];
  process.env.RELAYER_PK = ANVIL_PK;
  process.env.CHAIN_ID = String(MONAD_TESTNET_CHAIN_ID);
  process.env.RPC_URL = MONAD_TESTNET_RPC_URL;
});
afterAll(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
beforeEach(() => docs.clear());
afterEach(() => vi.unstubAllGlobals());

describe('relayerFees — 순수 수수료 정책 (설계 §5)', () => {
  it('maxFeePerGas = 2×baseFee + tip, tip = 2 gwei', () => {
    const fees = relayerFees(BASE_FEE);
    expect(fees.maxPriorityFeePerGas).toBe(2n * GWEI);
    expect(fees.maxPriorityFeePerGas).toBe(RELAYER_MAX_PRIORITY_FEE_WEI);
    // 2×100 + 2 = 202 gwei
    expect(fees.maxFeePerGas).toBe(202n * GWEI);
  });

  it('never lets the tip exceed maxFeePerGas, even at baseFee 0', () => {
    const fees = relayerFees(0n);
    expect(fees.maxFeePerGas).toBeGreaterThanOrEqual(fees.maxPriorityFeePerGas);
    expect(fees.maxFeePerGas).toBe(2n * GWEI); // 0 + tip
  });

  it('caps a spiking baseFee so one tx cannot drain the relayer', () => {
    const fees = relayerFees(400n * GWEI); // 2×400 + 2 = 802 gwei → capped
    expect(fees.maxFeePerGas).toBe(RELAYER_MAX_FEE_CAP_WEI);
    expect(fees.maxFeePerGas).toBe(500n * GWEI);
  });
});

describe('getRelayerAccount', () => {
  it('derives the relayer account from RELAYER_PK', () => {
    expect(getRelayerAccount().address).toBe(ANVIL_ADDRESS);
  });
  it('rejects a malformed key', () => {
    expect(() => getRelayerAccount('not-a-key')).toThrow('MISSING_RELAYER_PK');
  });
});

describe('sendRelayed', () => {
  it('reads the pending nonce inside the lease, sets margined gas + capped fees, returns the record', async () => {
    let raw: Hex | undefined;
    const calls = stubRpc({
      eth_chainId: () => `0x${MONAD_TESTNET_CHAIN_ID.toString(16)}`,
      eth_getBlockByNumber: () => block(BASE_FEE),
      eth_getTransactionCount: () => '0x5',
      eth_sendRawTransaction: (params) => {
        raw = params[0] as Hex;
        return TX_HASH;
      },
    });

    const estimate = 200_000n;
    const sent = await sendRelayed({ to: TICKET, data: DATA, gasLimit: estimate });

    expect(sent.hash).toBe(TX_HASH);
    expect(sent.nonce).toBe(5);
    expect(sent.gasLimit).toBe(206_000n); // +3% 릴레이 마진(relayGasLimitFor) — 어테스터의 +7.5% 와 다르다
    expect(sent.sentAt).toBeGreaterThan(0);

    const tx = parseTransaction(raw as Hex);
    expect(tx.nonce).toBe(5); // nonce 는 명시된다(설계 §5)
    expect(tx.gas).toBe(206_000n);
    expect(tx.maxPriorityFeePerGas).toBe(2n * GWEI);
    expect(tx.maxFeePerGas).toBe(202n * GWEI);
    expect(tx.to?.toLowerCase()).toBe(TICKET.toLowerCase());
    expect(tx.data).toBe(DATA);

    // pending nonce 를 명시적으로 읽었다.
    const nonceCall = calls.find((c) => c.method === 'eth_getTransactionCount');
    expect(nonceCall?.params[1]).toBe('pending');
  });

  it('retries exactly once on nonce-too-low, re-reading the pending nonce', async () => {
    let raw: Hex | undefined;
    let nonceReads = 0;
    const calls = stubRpc({
      eth_chainId: () => `0x${MONAD_TESTNET_CHAIN_ID.toString(16)}`,
      eth_getBlockByNumber: () => block(BASE_FEE),
      eth_getTransactionCount: () => {
        nonceReads += 1;
        return nonceReads === 1 ? '0x5' : '0x6'; // 재시도 때 새 nonce 를 읽는다
      },
      eth_sendRawTransaction: (params) => {
        const tx = parseTransaction(params[0] as Hex);
        if ((tx.nonce ?? 0) < 6) return { __rpcError: { code: -32000, message: 'nonce too low' } };
        raw = params[0] as Hex;
        return TX_HASH;
      },
    });

    const sent = await sendRelayed({ to: TICKET, data: DATA, gasLimit: 200_000n });

    expect(sent.hash).toBe(TX_HASH);
    expect(sent.nonce).toBe(6); // 재시도가 새 nonce 로 성공했다
    expect(parseTransaction(raw as Hex).nonce).toBe(6);
    // nonce 를 두 번 이상 읽었다 = 재시도가 pending nonce 를 다시 읽었다.
    expect(calls.filter((c) => c.method === 'eth_getTransactionCount').length).toBeGreaterThanOrEqual(2);
  });

  it('releases the lease when the broadcast fails with a non-retryable error', async () => {
    stubRpc({
      eth_chainId: () => `0x${MONAD_TESTNET_CHAIN_ID.toString(16)}`,
      eth_getBlockByNumber: () => block(BASE_FEE),
      eth_getTransactionCount: () => '0x5',
      // nonce-too-low 이 아닌 결정적 실패 → 재시도 없이 그대로 던진다.
      eth_sendRawTransaction: () => ({ __rpcError: { code: -32000, message: 'insufficient funds for gas' } }),
    });

    await expect(sendRelayed({ to: TICKET, data: DATA, gasLimit: 200_000n })).rejects.toThrow();

    // 전송이 실패해도 리스는 반납된다(withLease 의 finally) — 다음 호출이 곧바로 가져간다.
    const lease = docs.get('system/relayer');
    expect(lease?.lockedUntil).toBe(0);
    expect(lease?.holder).toBeNull();
  });
});
