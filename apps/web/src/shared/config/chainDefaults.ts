// TODO(02-T2): replace with @monti/shared constants
//
// Sub-plan 02 Task 2 will publish the canonical Monad chain constants from
// `@monti/shared` (MONAD_TESTNET_CHAIN_ID, ENTRY_POINT_V06, explorerUrlFor, …).
// That task is deferred until the contracts ship, so until then the web app
// keeps the constants here — in ONE file — so no view hardcodes a chain id, RPC
// host, EntryPoint, precompile, or explorer host. When 02-T2 lands, delete this
// file and import the identical names from `@monti/shared`.
import type { Hex } from '@monti/shared';

/** Monad testnet — the default target for the attendee MVP. */
export const MONAD_TESTNET_CHAIN_ID = 10143;
/** Monad mainnet. */
export const MONAD_MAINNET_CHAIN_ID = 143;

/** Chain id used when `VITE_CHAIN_ID` is absent. */
export const DEFAULT_CHAIN_ID = MONAD_TESTNET_CHAIN_ID;

/** Public JSON-RPC endpoints for each Monad network. */
export const MONAD_TESTNET_RPC_URL = 'https://testnet-rpc.monad.xyz';
export const MONAD_MAINNET_RPC_URL = 'https://rpc.monad.xyz';

/** ERC-4337 EntryPoint v0.6 — identical address on every chain. */
export const ENTRY_POINT_V06 = '0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789' as Hex;

/** RIP-7212 secp256r1 (P-256) signature-verification precompile. */
export const P256_PRECOMPILE_ADDRESS = '0x0000000000000000000000000000000000000100' as Hex;

const EXPLORER_URL_TESTNET = 'https://testnet.monadexplorer.com';
const EXPLORER_URL_MAINNET = 'https://monadexplorer.com';

/**
 * Block-explorer base URL for a chain id, so no view hardcodes an explorer host.
 * Anything that is not mainnet resolves to the testnet explorer.
 */
export function explorerUrlFor(chainId: number): string {
  return chainId === MONAD_MAINNET_CHAIN_ID ? EXPLORER_URL_MAINNET : EXPLORER_URL_TESTNET;
}
