import { createPublicClient, fallback, http, type PublicClient } from 'viem';
import { getConfig } from '../config';
import { monadChain } from './chain';

export { monadChain };

let publicClient: PublicClient | null = null;

export function getPublicClient(): PublicClient {
  if (publicClient) return publicClient;
  const config = getConfig();
  const chain = monadChain(config.chainId, config.rpcUrls, config.wsUrl);
  publicClient = createPublicClient({
    chain,
    // rank:false keeps the operator-chosen order: Alchemy, Tenderly, then the official RPC.
    transport: fallback(
      config.rpcUrls.map((url) => http(url, { timeout: 8_000, retryCount: 1 })),
      { rank: false, retryCount: 0 },
    ),
    batch: { multicall: { wait: 16 } },
  });
  return publicClient;
}

/** Only the HTTP client lives here. The socket is owned by subscribeLogs.resetWebSocketClient(). */
export function resetChainClients(): void {
  publicClient = null;
}
