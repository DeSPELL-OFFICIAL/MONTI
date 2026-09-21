import type { Address, Hex } from 'viem';
import {
  getUserOperationHash,
  type SmartAccount,
  type UserOperation,
  type WebAuthnAccount,
} from 'viem/account-abstraction';

import { ENTRY_POINT_V06_ADDRESS } from '@monti/shared';

import { ensureGateKey, gatePublicKeyUncompressed } from '../../staff/gate/gateKey';
import { getConfig } from '../config';
import { getSmartAccount } from './bundler';
import { signUserOpWithDeviceKey } from './gateSigner';

/**
 * The gate terminal's own Coinbase Smart Wallet.
 *
 * A Coinbase Smart Wallet owner is either an address or a 64-byte WebAuthn public key. The gate
 * has no passkey — it has a StrongBox P-256 key that signs without a fingerprint every three
 * seconds — so the raw `x ‖ y` goes on as the WebAuthn owner and Task 12 synthesises the
 * assertion bytes around each signature. The contract cannot tell the difference, because
 * `webauthn-sol` checks the digest and the client data and nothing about an authenticator.
 *
 * The derivation itself is the attendee's: `getSmartAccount` (03) is the one place that names
 * the factory version, and it is parameterised by owner precisely so there is no second
 * spelling of "Coinbase Smart Wallet v1.1, nonce 0" in this codebase.
 */
let cached: Promise<SmartAccount> | null = null;

export function getGateSmartAccount(): Promise<SmartAccount> {
  // The memo holds the promise, so a rejected build has to evict itself. `ensureGateKey()` can
  // lose a StrongBox race at boot (Task 11 §7.1), and a cached rejection would re-throw on
  // every tap until someone restarts the app — at the door, mid-event. The sibling
  // `getSmartAccount` (bundler.ts) memoises the resolved value and so retries for free; this
  // does the same by hand, because a promise remembers its failure and a value does not.
  if (!cached) {
    cached = build().catch((error: unknown) => {
      cached = null;
      throw error;
    });
  }
  return cached;
}

/** Drops the memo. The gate key is provisioned once per device, so only tests re-derive. */
export function resetGateAccount(): void {
  cached = null;
}

/**
 * The address a controller passes to `Organizers.registerGate`. It is counterfactual: the
 * account is deployed by the first sponsored op's `initCode`, and until then it is a pure
 * function of the gate key, so it can be registered before it exists.
 */
export async function getGateAddress(): Promise<Address> {
  return (await getGateSmartAccount()).address;
}

/**
 * The gate key wearing viem's `WebAuthnAccount` shape. Only `publicKey` and `type` are read —
 * by the factory, to salt the address, and by `getStubSignature`, which `sendSponsoredOp` hands
 * the bundler before a real signature exists.
 *
 * That stub does NOT price a P-256 verification. It carries viem's fixed challenge
 * (`toCoinbaseSmartAccount.js:122-124`), which can never equal a real `userOpHash`, so
 * `WebAuthn.verify` fails the challenge comparison and returns **before** the `0x100`
 * precompile runs: the stub gets the `SignatureWrapper` shape and the calldata cost right and
 * hides the verify itself — 5,012 gas estimated against 15,287 measured on Monad, ~10.3k short.
 * `sendSponsoredOp` adds only `applyGasBuffer` (7.5%) and never calls viem's
 * `userOperation.estimateGas` hook, so nothing puts that gas back. Once the account is
 * deployed the estimate is small enough that 7.5% no longer covers the gap and the EntryPoint
 * reverts `AA23 out of gas`. Task 21 clamps `verificationGasLimit` at a **150,000** floor in
 * `sendSponsoredOp` — 150k, not viem's 800k, because Monad bills the limit, not the usage.
 *
 * The three signing hooks refuse. Each of them is the ERC-1271 path, which wraps the digest in
 * `CoinbaseSmartWallet.replaySafeHash` typed data; `validateUserOp` does not, and Task 12 is
 * explicit that the gate signs the bare `userOpHash`. A gate that quietly produced a
 * replay-safe signature would produce one no verifier in this system asks for.
 */
function gateOwner(publicKey: Hex): WebAuthnAccount {
  const refuse = (): never => {
    throw new Error('the gate account signs user operations only');
  };
  return { id: 'monti-gate-device-key', publicKey, type: 'webAuthn', sign: refuse, signMessage: refuse, signTypedData: refuse };
}

async function build(): Promise<SmartAccount> {
  const owner = gateOwner(gatePublicKeyUncompressed(await ensureGateKey()));
  const base = await getSmartAccount(owner);

  return {
    ...base,
    /**
     * viem would hash exactly this and then ask the owner to sign; the gate keeps the hashing
     * (same `getUserOperationHash`, same entry point, same chain) and replaces only the
     * signing, because the owner's key cannot produce a WebAuthn assertion by itself.
     *
     * `ownerIndex` inside `signUserOpWithDeviceKey` is 0, which is true only while the gate key
     * is the sole owner — `gateAccount.test.ts` pins that coupling.
     */
    async signUserOperation(parameters: Parameters<SmartAccount['signUserOperation']>[0]): Promise<Hex> {
      const userOpHash = getUserOperationHash({
        chainId: getConfig().chainId,
        entryPointAddress: ENTRY_POINT_V06_ADDRESS,
        entryPointVersion: '0.6',
        // The request type leaves the gas fields optional; `sendSponsoredOp` fills every one of
        // them before it calls here, and a missing one would change the hash rather than throw.
        userOperation: { ...parameters, sender: base.address } as UserOperation<'0.6'>,
      });
      return signUserOpWithDeviceKey(userOpHash);
    },
  } as SmartAccount;
}
