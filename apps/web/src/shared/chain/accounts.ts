import { toCoinbaseSmartAccount, type SmartAccount, type WebAuthnAccount } from 'viem/account-abstraction';
import { getPasskeyAccount } from '../passkey';
import { getPublicClient } from './client';

/**
 * The attendee's counterfactual Coinbase Smart Wallet. Its address is the on-chain identity a
 * ForwardRequest is `from` (`shared/relay/buildForwardRequest.ts`) and the account the server
 * salts in `registerPasskey`, so the derivation must stay byte-identical to the server's:
 *
 *  - `version: '1.1'` is load-bearing. viem picks the factory from the version, and only the v1.1
 *    factory (`0xBA5ED110…`, the `coinbaseFactory` in the deployment) has code on Monad; version
 *    '1' would predict an address the server, the Identity contract and firestore.rules have never
 *    heard of.
 *  - the owner is whatever `getPasskeyAccount().publicKey` holds — the 64-byte `x ‖ y` the server
 *    salts over — handed to the factory untouched.
 *
 * Memoised per owner so a `clearCredential()` + re-login never resurrects the previous account and
 * repeated screens pay one factory `getAddress` round trip per credential rather than one per call.
 *
 * Phase 2 retired ERC-4337 on the web — the relayer submits `MontiForwarder.execute` and pays — so
 * nothing here signs a UserOperation any more; every caller reads only `.address`. The full
 * `SmartAccount` is kept as the return because it is what `toCoinbaseSmartAccount` resolves the
 * verified counterfactual address on.
 */
const accounts = new Map<string, SmartAccount>();

async function coinbaseAccount(owner: WebAuthnAccount): Promise<SmartAccount> {
  const key = String(owner.publicKey);
  const memoised = accounts.get(key);
  if (memoised) return memoised;
  const account = await toCoinbaseSmartAccount({
    client: getPublicClient(),
    owners: [owner],
    nonce: 0n,
    version: '1.1',
  });
  accounts.set(key, account);
  return account;
}

/** The signed-in attendee's own passkey smart account. */
export async function getAttendeeAccount(): Promise<SmartAccount> {
  return coinbaseAccount(await getPasskeyAccount());
}

/**
 * The signed-in staff member's own passkey smart account, used for requestOverride /
 * manualOverride. It is NOT the gate device account — a gate has no smart account any more
 * (`gateAccount.ts`) and never signs with a passkey.
 */
export async function getStaffAccount(): Promise<SmartAccount> {
  return getAttendeeAccount();
}

/** Drops the memo. The credential is stable per session, so only tests re-derive one. */
export function resetAccounts(): void {
  accounts.clear();
}
