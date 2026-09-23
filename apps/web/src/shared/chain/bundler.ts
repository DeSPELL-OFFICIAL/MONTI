import { http } from 'viem';
import {
  createBundlerClient,
  toCoinbaseSmartAccount,
  type BundlerClient,
  type SmartAccount,
  type WebAuthnAccount,
} from 'viem/account-abstraction';
import { getConfig } from '../config';
import { getPublicClient } from './client';

let bundlerClient: BundlerClient | null = null;
let smartAccount: SmartAccount | null = null;
let smartAccountKey: string | null = null;

export function getBundlerClient(): BundlerClient {
  if (bundlerClient) return bundlerClient;
  const config = getConfig();
  bundlerClient = createBundlerClient({
    client: getPublicClient(),
    transport: http(config.bundlerUrl, { timeout: 30_000, retryCount: 1 }),
  });
  return bundlerClient;
}

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
  // Memo keyed on the owner: after clearCredential() + re-login the stale account must not come back.
  const key = String(webAuthnAccount.publicKey);
  if (smartAccount && smartAccountKey === key) return smartAccount;
  smartAccount = await toCoinbaseSmartAccount({
    client: getPublicClient(),
    owners: [webAuthnAccount],
    nonce: 0n,
    version: '1.1',
  });
  smartAccountKey = key;
  return smartAccount;
}

export function resetBundler(): void {
  bundlerClient = null;
  smartAccount = null;
  smartAccountKey = null;
}

/** Raw bundler JSON-RPC, used for eth_estimateUserOperationGas and eth_sendUserOperation. */
export async function bundlerRequest<T>(method: string, params: unknown[]): Promise<T> {
  return (await getBundlerClient().request({ method, params } as never)) as T;
}
