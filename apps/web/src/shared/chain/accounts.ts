import { getAddress, type Address } from 'viem';
import { toCoinbaseSmartAccount, type SmartAccount, type WebAuthnAccount } from 'viem/account-abstraction';
import { getPasskeyAccount } from '../passkey';
import { NoPasskeyOnDevice } from '../passkey/errors';
import { getSession } from '../session';
import { getPublicClient } from './client';

/**
 * The phone attendee's counterfactual Coinbase Smart Wallet, derived from the stored passkey. It is
 * only the fallback for {@link getAttendeeAccount} before the session claim is there, and it is the
 * account the server salts in `registerPasskey`, so the derivation must stay byte-identical to the
 * server's:
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

/** The one thing every caller reads off the signed-in account: its on-chain address. */
export interface SignedInAccount {
  address: Address;
}

/**
 * Nobody is signed in on this device: no session claim and no passkey record either. A class
 * rather than a message so a screen can tell "sign in first" apart from a failed write.
 */
export class NotSignedIn extends Error {
  constructor() {
    super('NotSignedIn');
    this.name = 'NotSignedIn';
  }
}

/**
 * The signed-in person's on-chain account — the `from` of every ForwardRequest.
 *
 * The session's `account` claim is the source of truth: `loginVerify` (phone) and the open-mode
 * start callable both mint it, firestore.rules check it, and in open mode there is no passkey at
 * all, so deriving the account from the passkey would fail every signed write. For a phone user
 * the claim and the passkey-derived address are the same account. The passkey record is only a
 * fallback for the window before the session has hydrated; with neither, {@link NotSignedIn}.
 * Signing is not affected: the device key signs either way (`shared/deviceKey`).
 */
export async function getAttendeeAccount(): Promise<SignedInAccount> {
  const session = getSession();
  if (session.status === 'signedIn' && session.account) {
    return { address: getAddress(session.account) };
  }
  let owner: WebAuthnAccount;
  try {
    owner = await getPasskeyAccount();
  } catch (error) {
    if (error instanceof NoPasskeyOnDevice) throw new NotSignedIn();
    throw error;
  }
  return coinbaseAccount(owner);
}

/**
 * The signed-in staff member's own account, used for requestOverride / manualOverride. It is NOT
 * the gate device account — a gate has no smart account any more (`gateAccount.ts`) and never
 * signs with a passkey.
 */
export async function getStaffAccount(): Promise<SignedInAccount> {
  return getAttendeeAccount();
}

/** Drops the memo. The credential is stable per session, so only tests re-derive one. */
export function resetAccounts(): void {
  accounts.clear();
}
