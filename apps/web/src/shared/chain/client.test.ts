import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getPublicClient, monadChain, resetChainClients } from './client';
import { resetWebSocketClient, subscribeLogs } from './subscribeLogs';

// The socket transport is mocked so no test opens a real connection. Only viem's
// `webSocket` is replaced — `http`, `fallback`, `createPublicClient` and
// `defineChain` stay real so the fallback-order and memoisation tests exercise the
// genuine viem client, and `subscribe` is swapped for a spy we drive per test.
const { mockSubscribe } = vi.hoisted(() => ({ mockSubscribe: vi.fn() }));

vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>();
  return {
    ...actual,
    webSocket:
      (url?: string, config?: unknown) =>
      (clientOpts: unknown) => {
        const real = (actual.webSocket as (u?: string, c?: unknown) => (o: unknown) => unknown)(
          url,
          config,
        )(clientOpts) as { value?: Record<string, unknown> };
        return { ...real, value: { ...real.value, subscribe: mockSubscribe } };
      },
  };
});

const ADDRESS = `0x${'11'.repeat(20)}` as `0x${string}`;

beforeEach(() => {
  vi.stubEnv('VITE_CHAIN_ID', '10143');
  vi.stubEnv('VITE_RPC_URLS', 'https://a.example/rpc,https://b.example/rpc');
  vi.stubEnv('VITE_WS_URL', 'wss://ws.example');
  vi.stubEnv('VITE_BUNDLER_URL', 'https://bundler.example');
  for (const name of ['IDENTITY', 'ORGANIZERS', 'TICKET', 'PAYMASTER']) {
    vi.stubEnv(`VITE_ADDR_${name}`, `0x${'11'.repeat(20)}`);
  }
  vi.stubEnv('VITE_ENVIO_URL', 'https://envio.example/v1/graphql');
  vi.stubEnv('VITE_RP_ID', 'monti.app');
  vi.stubEnv('VITE_IPFS_GATEWAY', 'https://gw.example/ipfs/');
  vi.stubEnv('VITE_PINATA_JWT', 'jwt');
});

afterEach(async () => {
  const { resetConfig } = await import('../config');
  resetChainClients();
  resetWebSocketClient(); // otherwise a live socket leaks between test files
  resetConfig();
  mockSubscribe.mockReset();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('chain client', () => {
  it('builds the chain definition from config, never a literal', () => {
    const chain = monadChain(10143, ['https://a.example/rpc'], 'wss://ws.example');
    expect(chain.id).toBe(10143);
    expect(chain.nativeCurrency.symbol).toBe('MON');
    expect(chain.rpcUrls.default.http).toEqual(['https://a.example/rpc']);
  });

  it('falls through to the second RPC when the first fails', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        calls.push(url);
        if (url.includes('a.example')) throw new Error('down');
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x279f' }), {
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
    const client = getPublicClient();
    await expect(client.getChainId()).resolves.toBe(10143);
    expect(calls.some((url) => url.includes('a.example'))).toBe(true);
    expect(calls.some((url) => url.includes('b.example'))).toBe(true);
  });

  it('keeps the operator-chosen fallback order (rank disabled)', () => {
    const client = getPublicClient();
    const transport = client.transport as unknown as {
      transports: Array<{ value?: { url?: string } }>;
    };
    const urls = transport.transports.map((t) => t.value?.url);
    expect(urls).toEqual(['https://a.example/rpc', 'https://b.example/rpc']);
  });

  it('returns the same client instance until reset', () => {
    const first = getPublicClient();
    expect(getPublicClient()).toBe(first);
    resetChainClients();
    expect(getPublicClient()).not.toBe(first);
  });
});

describe('subscribeLogs stage mapping', () => {
  it('maps each commitState to the right stage over the socket', async () => {
    mockSubscribe.mockImplementation(
      async ({ onData }: { onData: (m: { result?: Record<string, unknown> }) => void }) => {
        onData({ result: { commitState: 'Proposed', transactionHash: '0xa', logIndex: '0x0' } });
        onData({ result: { commitState: 'Voted', transactionHash: '0xb', logIndex: '0x0' } });
        onData({ result: { commitState: 'Finalized', transactionHash: '0xa', logIndex: '0x0' } });
        return { unsubscribe: async () => {} };
      },
    );
    const seen: Array<{ stage: string; transactionHash: unknown }> = [];
    const stop = subscribeLogs({
      address: ADDRESS,
      topics: [],
      onLog: (log) => seen.push({ stage: log.stage, transactionHash: log.transactionHash }),
    });
    await vi.waitFor(() => expect(seen).toHaveLength(3));
    stop();
    expect(seen).toEqual([
      { stage: 'speculative', transactionHash: '0xa' },
      { stage: 'speculative', transactionHash: '0xb' },
      { stage: 'finalized', transactionHash: '0xa' },
    ]);
  });
});

describe('subscribeLogs polling fallback', () => {
  it('polls eth_getLogs by blockTag when the socket rejects monadLogs', async () => {
    vi.useFakeTimers();
    const bodies: Array<{ method: string; params: Array<{ fromBlock?: string }> }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as {
          id: number;
          method: string;
          params: Array<{ fromBlock?: string }>;
        };
        bodies.push(body);
        const tag = body.params[0]?.fromBlock;
        const result =
          body.method === 'eth_getLogs'
            ? [{ transactionHash: tag === 'latest' ? '0xspec' : '0xfinal', logIndex: '0x0' }]
            : [];
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), {
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
    mockSubscribe.mockImplementation(
      async ({ onError }: { onError: (e: unknown) => void }) => {
        onError(new Error('monadLogs unsupported'));
        return { unsubscribe: async () => {} };
      },
    );
    const stages: string[] = [];
    const stop = subscribeLogs({ address: ADDRESS, topics: [], onLog: (log) => stages.push(log.stage) });
    await vi.advanceTimersByTimeAsync(0); // let the socket attempt + onError run
    await vi.advanceTimersByTimeAsync(400); // one polling tick
    await vi.advanceTimersByTimeAsync(0); // flush the async eth_getLogs requests
    stop();
    const tags = bodies.filter((b) => b.method === 'eth_getLogs').map((b) => b.params[0]?.fromBlock);
    expect(tags).toContain('latest');
    expect(tags).toContain('finalized');
    expect(stages.sort()).toEqual(['finalized', 'speculative']);
  });
});
