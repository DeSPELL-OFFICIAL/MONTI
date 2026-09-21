import { MONAD_MAINNET_CHAIN_ID } from '@monti/shared';

// Chain ids, RPC hosts, EntryPoint and the P-256 precompile are owned by `@monti/shared`.
// Only the block-explorer hosts live here, because the explorer is a web-app concern the
// contracts and functions packages never need — and it stays in ONE file so no view
// hardcodes an explorer host.
const EXPLORER_URL_TESTNET = 'https://testnet.monadexplorer.com';
const EXPLORER_URL_MAINNET = 'https://monadexplorer.com';

/**
 * Block-explorer base URL for a chain id.
 * Anything that is not mainnet resolves to the testnet explorer.
 */
export function explorerUrlFor(chainId: number): string {
  return chainId === MONAD_MAINNET_CHAIN_ID ? EXPLORER_URL_MAINNET : EXPLORER_URL_TESTNET;
}
