import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config', () => ({
  getConfig: () => ({
    rpId: 'monti.despell.io',
    chainId: 10143,
    rpcUrls: ['https://rpc.example'],
    wsUrl: 'wss://ws.example',
    addresses: { identity: `0x${'11'.repeat(20)}`, organizers: `0x${'22'.repeat(20)}`, ticket: `0x${'33'.repeat(20)}`, forwarder: `0x${'55'.repeat(20)}` },
  }),
}));

const toCoinbaseSmartAccount = vi.fn(async (args: Record<string, unknown>) => ({ address: `0x${'ab'.repeat(20)}`, args }));
vi.mock('viem/account-abstraction', async (importOriginal) => ({
  ...(await importOriginal<typeof import('viem/account-abstraction')>()),
  toCoinbaseSmartAccount,
}));

vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => false } }));

const { getSmartAccount, resetBundler } = await import('./bundler');
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

  it('holds both the staff passkey account and the gate account without evicting either', async () => {
    // The staff build derives two accounts from two different owners and switches between them
    // per screen; a single memo slot would re-ask the factory on every switch.
    const passkey = { type: 'webAuthn', publicKey: OWNER } as never;
    const gate = { type: 'webAuthn', publicKey: `0x${'11'.repeat(32)}${'22'.repeat(32)}` } as never;
    const first = await getSmartAccount(passkey);
    await getSmartAccount(gate);
    expect(await getSmartAccount(passkey)).toBe(first);
    expect(toCoinbaseSmartAccount).toHaveBeenCalledTimes(2);
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
