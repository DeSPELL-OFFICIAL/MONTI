import { afterEach, describe, expect, it, vi } from 'vitest';
import { getConfig, hiddenEventIds, resetConfig } from './config';

const BASE = {
  VITE_CHAIN_ID: '10143',
  VITE_RPC_URLS: 'https://a.example/rpc,https://b.example/rpc,https://testnet-rpc.monad.xyz',
  VITE_WS_URL: 'wss://testnet-rpc.monad.xyz',
  VITE_ADDR_IDENTITY: `0x${'11'.repeat(20)}`,
  VITE_ADDR_ORGANIZERS: `0x${'22'.repeat(20)}`,
  VITE_ADDR_TICKET: `0x${'33'.repeat(20)}`,
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
    expect(config.addresses.forwarder).toBe(BASE.VITE_ADDR_FORWARDER);
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

describe('authMode', () => {
  it('is phone unless VITE_AUTH_MODE is exactly open', async () => {
    const { authMode } = await import('./config');
    vi.stubEnv('VITE_AUTH_MODE', '');
    expect(authMode()).toBe('phone');
    vi.stubEnv('VITE_AUTH_MODE', 'Open');
    expect(authMode()).toBe('phone');
    vi.stubEnv('VITE_AUTH_MODE', 'phone');
    expect(authMode()).toBe('phone');
    vi.stubEnv('VITE_AUTH_MODE', 'open');
    expect(authMode()).toBe('open');
    vi.unstubAllEnvs();
  });
});

describe('hiddenEventIds', () => {
  it('is empty when unset or blank', () => {
    expect(hiddenEventIds().size).toBe(0);
    vi.stubEnv('VITE_HIDDEN_EVENT_IDS', '');
    expect(hiddenEventIds().size).toBe(0);
  });

  it('splits on commas and ignores spaces and empty entries', () => {
    vi.stubEnv('VITE_HIDDEN_EVENT_IDS', '1001, 1002,,1003 ');
    expect([...hiddenEventIds()]).toEqual(['1001', '1002', '1003']);
  });
});
