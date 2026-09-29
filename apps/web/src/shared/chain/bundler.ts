import {
  toCoinbaseSmartAccount,
  type SmartAccount,
  type WebAuthnAccount,
} from 'viem/account-abstraction';
import { getPublicClient } from './client';

// Phase 2 retires ERC-4337 on the web: the relayer submits `MontiForwarder.execute` and pays, so
// there is no bundler client or `eth_sendUserOperation` here any more. What stays is the Coinbase
// smart account itself — its address is still the on-chain identity a ForwardRequest is `from`, and
// `accounts.ts`/`gateAccount.ts` derive it here. (The file keeps its name for now; a rename to
// `smartAccount.ts` is a mechanical follow-up.)

const smartAccounts = new Map<string, SmartAccount>();

/**
 * One passkey owner, nonce 0 — the address is a pure function of the passkey public key,
 * so the same credential always resolves to the same account on any device.
 *
 * The owner is whatever `webAuthnAccount.publicKey` holds — viem hands it to the factory
 * untouched — so `shared/passkey/getPasskeyAccount` is what makes it the 64-byte `x || y`
 * the server salts over. Both halves of the parity live in those two places and nowhere else.
 *
 * `version: '1.1'` is load-bearing. viem picks the factory from the version, and the two
 * factories predict different addresses for the same owner: '1' is the v1.0 factory
 * (0x0BA5ED0c...), '1.1' is 0xBA5ED110eFDBa3D005bfC882d75358ACBbB85842 — the
 * `coinbaseFactory` in contracts/deployments/10143.json that `registerPasskey` reads
 * `getAddress` from. Version '1' here would hand the attendee an address the server, the
 * Identity contract and firestore.rules have never heard of.
 */
export async function getSmartAccount(webAuthnAccount: WebAuthnAccount): Promise<SmartAccount> {
  // Memo keyed on the owner: after clearCredential() + re-login the stale account is never
  // looked up again. One entry per owner rather than one slot, because the staff build holds
  // two accounts at once — the member's passkey account and the gate's device-key account
  // (`gateAccount.ts`) — and a single slot would make them evict each other, paying a factory
  // `getAddress` round trip on venue wifi every time a screen switched.
  const key = String(webAuthnAccount.publicKey);
  const memoised = smartAccounts.get(key);
  if (memoised) return memoised;
  const account = await toCoinbaseSmartAccount({
    client: getPublicClient(),
    owners: [webAuthnAccount],
    nonce: 0n,
    version: '1.1',
  });
  smartAccounts.set(key, account);
  return account;
}

export function resetBundler(): void {
  smartAccounts.clear();
}
