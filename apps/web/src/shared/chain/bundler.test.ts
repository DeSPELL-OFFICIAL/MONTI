import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config', () => ({
  getConfig: () => ({
    chainId: 10143,
    rpcUrls: ['https://rpc.example'],
    wsUrl: 'wss://ws.example',
    bundlerUrl: 'https://bundler.example',
    entryPoint: '0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789',
    addresses: { identity: `0x${'11'.repeat(20)}`, organizers: `0x${'22'.repeat(20)}`, ticket: `0x${'33'.repeat(20)}`, paymaster: `0x${'44'.repeat(20)}` },
  }),
}));

const toCoinbaseSmartAccount = vi.fn(async (args: Record<string, unknown>) => ({ address: `0x${'ab'.repeat(20)}`, args }));
vi.mock('viem/account-abstraction', async (importOriginal) => ({
  ...(await importOriginal<typeof import('viem/account-abstraction')>()),
  toCoinbaseSmartAccount,
}));

const { getBundlerClient, getSmartAccount, bundlerRequest, resetBundler } = await import('./bundler');

beforeEach(() => {
  resetBundler();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('getSmartAccount', () => {
  it('builds a Coinbase Smart Wallet v1 account with the passkey as the only owner and nonce 0', async () => {
    resetBundler();
    const owner = { type: 'webAuthn', publicKey: `0x${'cd'.repeat(64)}` } as never;
    const account = (await getSmartAccount(owner)) as unknown as { args: Record<string, unknown> };
    expect(toCoinbaseSmartAccount).toHaveBeenCalledTimes(1);
    expect(account.args.owners).toEqual([owner]);
    expect(account.args.nonce).toBe(0n);
    expect(account.args.version).toBe('1');
  });

  it('memoises per owner: the same passkey returns the same instance without rebuilding', async () => {
    const owner = { type: 'webAuthn', publicKey: `0x${'cd'.repeat(64)}` } as never;
    const first = await getSmartAccount(owner);
    const second = await getSmartAccount(owner);
    expect(second).toBe(first);
    expect(toCoinbaseSmartAccount).toHaveBeenCalledTimes(1);
  });

  it('rebuilds for a different passkey, yielding a different account instance', async () => {
    const ownerA = { type: 'webAuthn', publicKey: `0x${'cd'.repeat(64)}` } as never;
    const ownerB = { type: 'webAuthn', publicKey: `0x${'ef'.repeat(64)}` } as never;
    const a = await getSmartAccount(ownerA);
    const b = await getSmartAccount(ownerB);
    expect(b).not.toBe(a);
    expect(toCoinbaseSmartAccount).toHaveBeenCalledTimes(2);
  });
});

describe('getBundlerClient', () => {
  it('memoises the client and resetBundler clears it', () => {
    const first = getBundlerClient();
    expect(getBundlerClient()).toBe(first);
    resetBundler();
    expect(getBundlerClient()).not.toBe(first);
  });

  it('sends bundler JSON-RPC to config.bundlerUrl with the requested method', async () => {
    const seen: Array<{ url: string; method: string }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { id: number; method: string };
        seen.push({ url: String(input), method: body.method });
        const result = body.method === 'eth_supportedEntryPoints'
          ? ['0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789']
          : { preVerificationGas: '0x1', verificationGasLimit: '0x2', callGasLimit: '0x3' };
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), {
          headers: { 'content-type': 'application/json' },
        });
      }),
    );

    const entryPoints = await bundlerRequest<string[]>('eth_supportedEntryPoints', []);
    expect(entryPoints).toEqual(['0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789']);

    await bundlerRequest('eth_estimateUserOperationGas', [
      {},
      '0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789',
    ]);

    expect(seen.every((r) => r.url === 'https://bundler.example')).toBe(true);
    expect(seen.map((r) => r.method)).toEqual([
      'eth_supportedEntryPoints',
      'eth_estimateUserOperationGas',
    ]);
  });
});
