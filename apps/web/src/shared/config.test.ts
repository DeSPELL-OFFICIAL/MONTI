import { afterEach, describe, expect, it, vi } from 'vitest';
import { getConfig, resetConfig } from './config';

const BASE = {
  VITE_CHAIN_ID: '10143',
  VITE_RPC_URLS: 'https://a.example/rpc,https://b.example/rpc,https://testnet-rpc.monad.xyz',
  VITE_WS_URL: 'wss://testnet-rpc.monad.xyz',
  VITE_BUNDLER_URL: 'https://api.pimlico.io/v2/10143/rpc?apikey=k',
  VITE_ADDR_IDENTITY: `0x${'11'.repeat(20)}`,
  VITE_ADDR_ORGANIZERS: `0x${'22'.repeat(20)}`,
  VITE_ADDR_TICKET: `0x${'33'.repeat(20)}`,
  VITE_ADDR_PAYMASTER: `0x${'44'.repeat(20)}`,
  VITE_ADDR_FORWARDER: `0x${'55'.repeat(20)}`,
  VITE_ENVIO_URL: 'https://indexer.example/v1/graphql',
  VITE_RP_ID: 'monti.despell.io',
  VITE_IPFS_GATEWAY: 'https://gateway.pinata.cloud/ipfs/',
};

afterEach(() => {
  resetConfig();
  vi.unstubAllEnvs();
});

describe('getConfig', () => {
  it('parses every variable and splits the RPC list', () => {
    for (const [key, value] of Object.entries(BASE)) vi.stubEnv(key, value);
    const config = getConfig();
    expect(config.chainId).toBe(10143);
    expect(config.rpcUrls).toHaveLength(3);
    expect(config.addresses.ticket).toBe(BASE.VITE_ADDR_TICKET);
    expect(config.entryPoint).toBe('0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789');
    expect(config.explorerUrl).toBe('https://testnet.monadexplorer.com');
  });

  it('throws naming the missing variable', () => {
    for (const [key, value] of Object.entries(BASE)) vi.stubEnv(key, value);
    vi.stubEnv('VITE_ADDR_TICKET', '');
    expect(() => getConfig()).toThrow('VITE_ADDR_TICKET');
  });

  // Pinning is a backend callable (`pinEventImage` / `pinEventMetadata`), so no build of this
  // app carries a pinning token and nothing in `src` may ever read one.
  it('carries no pinning token at all', () => {
    for (const [key, value] of Object.entries(BASE)) vi.stubEnv(key, value);
    expect(Object.keys(getConfig())).not.toContain('pinataJwt');
  });

  it('never hardcodes the chain id in logic', () => {
    for (const [key, value] of Object.entries(BASE)) vi.stubEnv(key, value);
    vi.stubEnv('VITE_CHAIN_ID', '143');
    expect(getConfig().chainId).toBe(143);
    expect(getConfig().explorerUrl).toBe('https://monadexplorer.com');
  });
});
