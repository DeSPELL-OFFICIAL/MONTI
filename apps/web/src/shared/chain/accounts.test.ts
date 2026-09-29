import { createPublicClient, custom, encodeFunctionData, getAddress, parseAbi, size, type Hex } from 'viem';
import { describe, expect, it, vi } from 'vitest';
import { monadChain } from './chain';

/**
 * The factory's one view these checks need. The full CoinbaseSmartWalletFactory ABI was retired
 * from `@monti/shared` in Phase 2 (design §3); `functions/src/functions/registerPasskey.ts` names
 * the same `getAddress` fragment, so the calldata asserted here and the calldata the server sends
 * stay byte-identical.
 */
const coinbaseFactoryAbi = parseAbi(['function getAddress(bytes[] owners, uint256 nonce) view returns (address)']);

/**
 * contracts/deployments/10143.json `coinbaseFactory` — the factory `registerPasskey` reads
 * `getAddress` from (functions/src/functions/registerPasskey.ts).
 */
const FACTORY = '0xBA5ED110eFDBa3D005bfC882d75358ACBbB85842';

/** One fixed credential, stored the way an authenticator hands it over: 0x04 || x || y. */
const X = '3b'.repeat(32);
const Y = '7c'.repeat(32);
const OWNER = `0x${X}${Y}` as Hex;

/** Whatever the factory answers; the point of the test is the question, not the answer. */
const PREDICTED = `0x${'ab'.repeat(20)}` as Hex;

const calls: Array<{ to: Hex; data: Hex }> = [];

vi.mock('../config', () => ({ getConfig: () => ({ rpId: 'monti.despell.io' }) }));
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => false } }));
vi.mock('./client', () => ({ getPublicClient: () => client }));

const client = createPublicClient({
  chain: monadChain(10143, ['https://rpc.example'], 'wss://ws.example'),
  transport: custom({
    async request({ method, params }) {
      if (method !== 'eth_call') throw new Error(`unexpected RPC ${method}`);
      const call = (params as [{ to: Hex; data: Hex }])[0];
      calls.push(call);
      return `0x${'0'.repeat(24)}${PREDICTED.slice(2)}`;
    },
  }),
});

const { getAttendeeAccount, resetAccounts } = await import('./accounts');
const { storeCredential, clearCredential } = await import('../passkey');

describe('getAttendeeAccount', () => {
  it('asks the deployed factory the exact question registerPasskey asks it', async () => {
    storeCredential({
      id: 'cred',
      publicKey: `0x04${X}${Y}`,
      transports: ['internal'],
      attestationJson: '{}',
    });

    // toSmartAccount resolves the address on construction, so this is the factory call itself.
    const account = await getAttendeeAccount();

    expect(account.address).toBe(getAddress(PREDICTED));
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(getAddress(call!.to)).toBe(getAddress(FACTORY));

    // Byte-for-byte the call the server makes: same factory, same ABI, same owner, same nonce
    // (functions/src/functions/registerPasskey.ts `readContract({ args: [[owner], 0n] })`).
    // `getAddress` is a pure keccak over exactly these, so identical calldata is identical
    // address — that is the whole parity claim, checked rather than asserted in a comment.
    expect(call!.data).toBe(
      encodeFunctionData({
        abi: coinbaseFactoryAbi,
        functionName: 'getAddress',
        args: [[OWNER], 0n],
      }),
    );
    expect(size(OWNER)).toBe(64);
  });
});

describe('getAttendeeAccount memo', () => {
  it('reuses one factory read per credential, and re-derives after a re-login', async () => {
    resetAccounts();
    clearCredential();
    storeCredential({
      id: 'cred',
      publicKey: `0x04${X}${Y}`,
      transports: ['internal'],
      attestationJson: '{}',
    });

    const before = calls.length;
    const first = await getAttendeeAccount();
    const second = await getAttendeeAccount();
    // Same credential, one factory getAddress round trip, the same instance both times.
    expect(second).toBe(first);
    expect(calls.length).toBe(before + 1);

    // A clearCredential() + re-login drops the memo, so the next read asks the factory again and
    // the stale account is never resurrected.
    resetAccounts();
    const third = await getAttendeeAccount();
    expect(third).not.toBe(first);
    expect(calls.length).toBe(before + 2);
  });
});
