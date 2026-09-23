import { defineChain, type Chain } from 'viem';
import { MONAD_MAINNET_CHAIN_ID } from '@monti/shared';
import { explorerUrlFor } from '../config/chainDefaults';

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
