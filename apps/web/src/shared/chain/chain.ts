import { defineChain, type Chain } from 'viem';
import { MONAD_MAINNET_CHAIN_ID } from '@monti/shared';
import { explorerUrlFor } from '../config/chainDefaults';

/**
 * How far above the block's base fee every fee estimate reaches. It is the ceiling on
 * `maxFeePerGas`, not what anything actually pays.
 *
 * viem's default is 1.2, which on Monad's fixed 100 gwei base fee yields maxFeePerGas = 122 gwei
 * (base×1.2 + 2 gwei priority). That sits **just below** the padding Alchemy's rundler puts on a
 * Monad bundle transaction — mined bundles carry 129–152 gwei — so rundler accepts a perfectly
 * valid, includable sponsored op and then can never fit it into a bundle: `eth_sendUserOperation`
 * returns a hash, no bundle is ever built, and the op sits in the mempool for hours. That is the
 * whole of the "만드는 중" hang the S1 root-cause report diagnosed (task-create-failure-3): a
 * `createEvent` op priced at 122 gwei, accepted but never bundled, 468 s and counting.
 *
 * 2× → ~202 gwei clears the observed threshold with margin and stays ≥ 1.6× base. It costs
 * nothing extra: the EntryPoint charges `min(maxFeePerGas, baseFee + maxPriorityFeePerGas)` ≈ 102
 * gwei, so the paymaster's real spend is unchanged — `maxFeePerGas` is a "this far and no further"
 * ceiling only. It is safe against the paymaster's budget rules, too: `createEvent` is
 * platform-sponsored (`MontiPaymaster` `ArgKind.Platform`), and the platform slot is deliberately
 * *not* capped in `validatePaymasterUserOp` (only self-sponsored project slots are) — the only
 * backstop is the EntryPoint deposit via AA31, and one createEvent's prefund at 202 gwei
 * (~0.77 MON) stays under the 1.0 MON platform deposit. viem 2.38 reads this multiplier from the
 * chain, not from a per-call argument, so it lives here and every `estimateFeesPerGas()` in the
 * app inherits it.
 */
export const BASE_FEE_MULTIPLIER = 2;

export function monadChain(chainId: number, rpcUrls: string[], wsUrl: string): Chain {
  return defineChain({
    id: chainId,
    name: chainId === MONAD_MAINNET_CHAIN_ID ? 'Monad' : 'Monad Testnet',
    nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
    rpcUrls: { default: { http: rpcUrls, webSocket: [wsUrl] } },
    blockExplorers: { default: { name: 'MonadVision', url: explorerUrlFor(chainId) } },
    testnet: chainId !== MONAD_MAINNET_CHAIN_ID,
    fees: { baseFeeMultiplier: BASE_FEE_MULTIPLIER },
  });
}
