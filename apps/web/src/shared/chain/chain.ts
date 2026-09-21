import { defineChain, type Chain } from 'viem';
// 02-T2 is deferred, so the canonical Monad chain constants still live in
// chainDefaults.ts (one file) rather than @monti/shared. Import them from there so
// no view hardcodes a chain id or explorer host.
import { MONAD_MAINNET_CHAIN_ID, explorerUrlFor } from '../config/chainDefaults';

export function monadChain(chainId: number, rpcUrls: string[], wsUrl: string): Chain {
  return defineChain({
    id: chainId,
    name: chainId === MONAD_MAINNET_CHAIN_ID ? 'Monad' : 'Monad Testnet',
    nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
    rpcUrls: { default: { http: rpcUrls, webSocket: [wsUrl] } },
    blockExplorers: { default: { name: 'MonadVision', url: explorerUrlFor(chainId) } },
    testnet: chainId !== MONAD_MAINNET_CHAIN_ID,
  });
}
