import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config', () => ({
  getConfig: () => ({
    rpId: 'monti.app',
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

vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => false } }));

const { getBundlerClient, getSmartAccount, bundlerRequest, resetBundler } = await import('./bundler');
const { getAttendeeAccount } = await import('./accounts');
const { storeCredential, clearCredential } = await import('../passkey');

/** A P-256 credential the way an authenticator stores it: the 65-byte 0x04 || x || y point. */
const OWNER_X = 'cd'.repeat(32);
const OWNER_Y = 'ef'.repeat(32);
const OWNER = `0x${OWNER_X}${OWNER_Y}`;

beforeEach(() => {
  clearCredential();
  resetBundler();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('getSmartAccount', () => {
  it('builds a Coinbase Smart Wallet v1.1 account with the passkey as the only owner and nonce 0', async () => {
    resetBundler();
    const owner = { type: 'webAuthn', publicKey: OWNER } as never;
    const account = (await getSmartAccount(owner)) as unknown as { args: Record<string, unknown> };
    expect(toCoinbaseSmartAccount).toHaveBeenCalledTimes(1);
    expect(account.args.owners).toEqual([owner]);
    expect(account.args.nonce).toBe(0n);
    // The deployed factory (contracts/deployments/10143.json coinbaseFactory) is the v1.1 one;
    // version '1' would derive a different address than registerPasskey wrote on the server.
    expect(account.args.version).toBe('1.1');
  });

  it('salts the factory over the 64-byte x || y, never the stored uncompressed point', async () => {
    storeCredential({
      id: 'cred',
      publicKey: `0x04${OWNER_X}${OWNER_Y}`,
      transports: ['internal'],
      attestationJson: '{}',
    });
    const account = (await getAttendeeAccount()) as unknown as {
      args: { owners: Array<{ publicKey: string }> };
    };

    // viem passes a webAuthn owner to the factory verbatim, and registerPasskey derives the
    // same address from ownerBytes(x, y) (functions/src/lib/webauthn.ts). A surviving 0x04
    // prefix is a different salt, so a different account than the one written to the person.
    const owner = account.args.owners[0]!.publicKey;
    expect(owner).toBe(OWNER);
    expect((owner.length - 2) / 2).toBe(64);
  });

  it('memoises per owner: the same passkey returns the same instance without rebuilding', async () => {
    const owner = { type: 'webAuthn', publicKey: OWNER } as never;
    const first = await getSmartAccount(owner);
    const second = await getSmartAccount(owner);
    expect(second).toBe(first);
    expect(toCoinbaseSmartAccount).toHaveBeenCalledTimes(1);
  });

  it('rebuilds for a different passkey, yielding a different account instance', async () => {
    const ownerA = { type: 'webAuthn', publicKey: OWNER } as never;
    const ownerB = { type: 'webAuthn', publicKey: `0x${OWNER_Y}${OWNER_X}` } as never;
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
