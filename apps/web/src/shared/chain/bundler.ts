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
 */
export async function getSmartAccount(webAuthnAccount: WebAuthnAccount): Promise<SmartAccount> {
  // Memo keyed on the owner: after clearCredential() + re-login the stale account must not come back.
  const key = String(webAuthnAccount.publicKey);
  if (smartAccount && smartAccountKey === key) return smartAccount;
  smartAccount = await toCoinbaseSmartAccount({
    client: getPublicClient(),
    owners: [webAuthnAccount],
    nonce: 0n,
    version: '1',
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
