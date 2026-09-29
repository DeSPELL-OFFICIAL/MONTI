import {
  createPublicClient,
  custom,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  getContractAddress,
  keccak256,
  pad,
  parseAbi,
  size,
  type Hex,
} from 'viem';
import type { UserOperation, WebAuthnAccount } from 'viem/account-abstraction';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { monadChain } from './chain';

/**
 * The factory's one view these checks need. The full CoinbaseSmartWalletFactory ABI was retired
 * from `@monti/shared` in Phase 2 (design §3); `functions/src/functions/registerPasskey.ts` names
 * the same `getAddress` fragment, so the calldata asserted here and the calldata the server sends
 * stay byte-identical.
 */
const coinbaseFactoryAbi = parseAbi(['function getAddress(bytes[] owners, uint256 nonce) view returns (address)']);

/**
 * `contracts/deployments/10143.json` `coinbaseFactory` — Coinbase Smart Wallet **v1.1**. viem
 * defaults `version` to `'1'`, whose factory (0x0BA5ED0c…) has no code at all on Monad testnet:
 * the default would predict an address that can never be deployed, and the paymaster would see
 * an `UnknownSender`. So the version is asserted here rather than trusted.
 */
const FACTORY = '0xBA5ED110eFDBa3D005bfC882d75358ACBbB85842';

/**
 * The two values `getAddress(owners, nonce)` folds together, read off chain 10143 itself:
 *
 *   cast call 0xBA5ED110eFDBa3D005bfC882d75358ACBbB85842 "implementation()(address)"  --rpc-url https://testnet-rpc.monad.xyz
 *   cast call 0xBA5ED110eFDBa3D005bfC882d75358ACBbB85842 "initCodeHash()(bytes32)"    --rpc-url https://testnet-rpc.monad.xyz
 *
 * `initCodeHash()` is `LibClone.initCodeHashERC1967(implementation)`
 * (contracts/lib/smart-wallet/src/CoinbaseSmartWalletFactory.sol:85). On 10143 the
 * implementation is `0x00000110dCdEdC9581cb5eCB8467282f2926534d`, giving the hash below.
 */
const INIT_CODE_HASH = '0xa53d9968113cdf38ec78edc985b30bcb1a274ddaa221624c1d15604f70b0761a';

/** One fixed gate device key: Task 11 reports `x` and `y` as separate 32-byte words. */
const X = `0x${'11'.repeat(32)}` as Hex;
const Y = `0x${'22'.repeat(32)}` as Hex;
/** The owner bytes the factory salts over: 64 bytes, `x ‖ y`, no SEC1 `0x04` tag. */
const OWNER = `0x${'11'.repeat(32)}${'22'.repeat(32)}` as Hex;

/**
 * The counterfactual gate account for OWNER, as the deployed factory itself answers it:
 *
 *   cast call 0xBA5ED110eFDBa3D005bfC882d75358ACBbB85842 \
 *     "getAddress(bytes[],uint256)(address)" "[0x1111…2222]" 0 --rpc-url https://testnet-rpc.monad.xyz
 *
 * Everything below — the factory address, the init code hash, the `abi.encode(owners, nonce)`
 * salt, viem's `version: '1.1'` — has to agree with this one literal or the gate registers an
 * address it can never operate from.
 */
const GATE_ADDRESS = '0xCf83795Af2E30a8Bb373610f45563eB97A5aEDb1';

const ENTRY_POINT_V06 = '0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789';
const CHAIN_ID = 10143;

/**
 * `CoinbaseSmartWalletFactory.getAddress`, reimplemented locally from the Solidity. `deployer`
 * is a parameter rather than a constant so that asking the wrong factory answers the wrong
 * address, exactly as it would on chain — viem's default `version: '1'` must not slip past.
 */
function predict(owners: readonly Hex[], nonce: bigint, deployer: Hex = FACTORY): Hex {
  const salt = keccak256(
    encodeAbiParameters([{ type: 'bytes[]' }, { type: 'uint256' }], [owners as Hex[], nonce]),
  );
  return getContractAddress({ bytecodeHash: INIT_CODE_HASH, from: deployer, opcode: 'CREATE2', salt });
}

vi.mock('../config', () => ({
  getConfig: () => ({
    chainId: CHAIN_ID,
    rpId: 'monti.despell.io',
    bundlerUrl: 'https://bundler.example',
    entryPoint: ENTRY_POINT_V06,
  }),
}));
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => false } }));

/** Task 11. `backing` rides along the way the device-key module reports it. */
const ensureGateKey = vi.fn(async () => ({ x: X, y: Y, backing: 'strongbox' }));
vi.mock('../../staff/gate/gateKey', () => ({
  ensureGateKey,
  gatePublicKeyUncompressed: (key: { x: Hex; y: Hex }) => `0x${key.x.slice(2)}${key.y.slice(2)}`,
  signWithGateKey: async () => ({ r: `0x${'33'.repeat(32)}`, s: `0x${'44'.repeat(32)}` }),
}));

/** Task 12. The gate account must hand every user op to exactly this, and to nothing else. */
const signUserOpWithDeviceKey = vi.fn(async (_hash: Hex): Promise<Hex> => '0xdeadbeef');
vi.mock('./gateSigner', () => ({ signUserOpWithDeviceKey }));

/**
 * A spy that still runs the real derivation: the owner/nonce/version assertions below read the
 * arguments, and the address assertions get viem's genuine answer rather than a stub's.
 */
// A value import of the mocked module would run the factory before this line, so the real
// module is pulled in by hand and the spy wraps its implementation.
const actual = await vi.importActual<typeof import('viem/account-abstraction')>('viem/account-abstraction');
const { getUserOperationHash } = actual;
const toCoinbaseSmartAccount = vi.fn(actual.toCoinbaseSmartAccount);
vi.mock('viem/account-abstraction', async (importOriginal) => ({
  ...(await importOriginal<typeof import('viem/account-abstraction')>()),
  toCoinbaseSmartAccount,
}));

const factoryCalls: Array<{ to: Hex; data: Hex }> = [];

/** Stands in for chain 10143: answers `getAddress` exactly the way the deployed factory does. */
const client = createPublicClient({
  chain: monadChain(CHAIN_ID, ['https://rpc.example'], 'wss://ws.example'),
  transport: custom({
    async request({ method, params }) {
      if (method === 'eth_getCode') return '0x';
      if (method !== 'eth_call') throw new Error(`unexpected RPC ${method}`);
      const call = (params as [{ to: Hex; data: Hex }])[0];
      factoryCalls.push(call);
      const decoded = decodeFunctionData({ abi: coinbaseFactoryAbi, data: call.data });
      if (decoded.functionName !== 'getAddress') throw new Error(`unexpected call ${decoded.functionName}`);
      const [owners, nonce] = decoded.args as [Hex[], bigint];
      return pad(predict(owners, nonce, call.to));
    },
  }),
});
vi.mock('./client', () => ({ getPublicClient: () => client }));

const { getGateAddress, getGateSmartAccount, resetGateAccount } = await import('./gateAccount');
const { resetBundler } = await import('./bundler');

beforeEach(() => {
  factoryCalls.length = 0;
  resetGateAccount();
  resetBundler();
});

/** A user op shaped exactly the way `sendSponsoredOp` hands one over. */
const userOp = {
  callData: '0xabcdef' as Hex,
  callGasLimit: 100_000n,
  initCode: '0x' as Hex,
  maxFeePerGas: 60_000_000_000n,
  maxPriorityFeePerGas: 2_000_000_000n,
  nonce: 7n,
  paymasterAndData: `0x${'44'.repeat(20)}${'0'.repeat(63)}1` as Hex,
  preVerificationGas: 60_000n,
  verificationGasLimit: 150_000n,
};

describe('the pinned counterfactual address', () => {
  it('reproduces the deployed factory getAddress from the factory source, not from the RPC', () => {
    // CoinbaseSmartWalletFactory.sol:77 — predictDeterministicAddress(initCodeHash(),
    // keccak256(abi.encode(owners, nonce)), address(this)). If any constant above drifts from
    // chain 10143, this literal stops matching and the gate stops being registrable.
    expect(predict([OWNER], 0n)).toBe(GATE_ADDRESS);
  });

  it('is a pure function of the owner: another gate key is another account', () => {
    expect(predict([`0x${'22'.repeat(32)}${'11'.repeat(32)}`], 0n)).not.toBe(GATE_ADDRESS);
    expect(predict([OWNER], 1n)).not.toBe(GATE_ADDRESS);
  });
});

describe('gate smart account', () => {
  it('uses the raw P-256 key as the sole 64-byte WebAuthn owner, nonce 0, factory v1.1', async () => {
    await getGateSmartAccount();

    // gateSigner signs with `ownerIndex: 0`, which is only true while the gate key is the one
    // and only owner. All four of these are that coupling, written down.
    const [args] = toCoinbaseSmartAccount.mock.calls[0]!;
    const owners = args.owners as WebAuthnAccount[];
    expect(owners).toHaveLength(1);
    expect(owners[0]!.type).toBe('webAuthn');
    expect(owners[0]!.publicKey).toBe(OWNER);
    expect(size(OWNER)).toBe(64);
    expect(args.nonce).toBe(0n);
    expect(args.version).toBe('1.1');
  });

  it('asks the deployed v1.1 factory the same question registerPasskey asks it', async () => {
    const address = await getGateAddress();

    expect(address).toBe(getAddress(GATE_ADDRESS));
    expect(factoryCalls).toHaveLength(1);
    expect(getAddress(factoryCalls[0]!.to)).toBe(getAddress(FACTORY));
    expect(factoryCalls[0]!.data).toBe(
      encodeFunctionData({ abi: coinbaseFactoryAbi, functionName: 'getAddress', args: [[OWNER], 0n] }),
    );
  });

  it('derives once: the gate re-reads the account on every tap and must not re-ask the RPC', async () => {
    const first = await getGateSmartAccount();
    const second = await getGateSmartAccount();
    expect(second).toBe(first);
    expect(factoryCalls).toHaveLength(1);
    expect(toCoinbaseSmartAccount).toHaveBeenCalledTimes(1);
  });

  it('overrides signUserOperation with the device-key signature', async () => {
    const account = await getGateSmartAccount();
    expect(await account.signUserOperation({ ...userOp, sender: GATE_ADDRESS } as never)).toBe('0xdeadbeef');
  });

  it('signs the EntryPoint v0.6 hash viem itself would sign for this account', async () => {
    const account = await getGateSmartAccount();
    await account.signUserOperation({ ...userOp } as never);

    const signed = signUserOpWithDeviceKey.mock.calls[0]![0];

    // 1. The hash is the v0.6 one over *this* sender, entry point and chain.
    expect(signed).toBe(
      getUserOperationHash({
        chainId: CHAIN_ID,
        entryPointAddress: ENTRY_POINT_V06,
        entryPointVersion: '0.6',
        userOperation: { ...userOp, sender: GATE_ADDRESS, signature: '0x' } as UserOperation<'0.6'>,
      }),
    );

    // 2. And it is byte-identical to what viem's own `signUserOperation` would have hashed for
    //    the same account — the override replaces the signing, never the hashing.
    const hashes: Hex[] = [];
    const probe = await actual.toCoinbaseSmartAccount({
      client,
      nonce: 0n,
      owners: [
        {
          id: 'probe',
          publicKey: OWNER,
          type: 'webAuthn',
          async sign({ hash }: { hash: Hex }) {
            hashes.push(hash);
            return {
              signature: `0x${'aa'.repeat(32)}${'11'.repeat(32)}1b` as Hex,
              webauthn: {
                authenticatorData: '0x00',
                clientDataJSON: '{}',
                challengeIndex: 0,
                typeIndex: 0,
                userVerificationRequired: false,
              },
              raw: {} as never,
            };
          },
          signMessage: async () => { throw new Error('unused'); },
          signTypedData: async () => { throw new Error('unused'); },
        } as unknown as WebAuthnAccount,
      ],
      version: '1.1',
    });
    await probe.signUserOperation({ ...userOp } as never);
    expect(signed).toBe(hashes[0]);
  });

  it('refuses every other signing path: the gate has no ERC-1271 story', async () => {
    const account = await getGateSmartAccount();
    await expect(account.signMessage({ message: 'hello' })).rejects.toThrow(
      'the gate account signs user operations only',
    );
  });

  it('retries a failed key setup instead of caching the rejection until restart', async () => {
    // Task 11 §7.1: ensureGateKey can lose a StrongBox race at boot. The memo holds a promise,
    // so without the eviction one such boot would re-throw on every tap for the rest of the
    // event and only an app restart at the door would clear it.
    ensureGateKey.mockRejectedValueOnce(new Error('strongbox busy'));
    await expect(getGateSmartAccount()).rejects.toThrow('strongbox busy');

    const account = await getGateSmartAccount();
    expect(account.address).toBe(getAddress(GATE_ADDRESS));
  });

  it('estimates with viem WebAuthn stub: right shape, and a verify that is never priced', async () => {
    // sendSponsoredOp hands this to the bundler before it signs. The stub keeps the
    // SignatureWrapper shape and the calldata cost honest, but its fixed challenge
    // short-circuits WebAuthn.verify before the P-256 precompile, so ~10.3k of verification gas
    // (5,012 estimated vs 15,287 measured on Monad) is never priced. Task 21 clamps
    // verificationGasLimit at 150,000 in sendSponsoredOp — not viem's 800,000, because Monad
    // bills the limit rather than the usage.
    const account = await getGateSmartAccount();
    expect(size(await account.getStubSignature())).toBeGreaterThan(64);
  });
});
