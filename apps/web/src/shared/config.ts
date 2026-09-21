import type { Hex } from '@monti/shared';
import { DEFAULT_CHAIN_ID, ENTRY_POINT_V06, explorerUrlFor } from './config/chainDefaults';

/**
 * Every module that needs a chain id, contract address, RPC/WS endpoint, or key
 * reads it through {@link getConfig}. Values come from Vite `import.meta.env`;
 * parsing is fail-fast so a missing variable surfaces at startup, not mid-flow.
 */
export interface AppConfig {
  chainId: number;
  rpcUrls: string[];
  wsUrl: string;
  bundlerUrl: string;
  entryPoint: Hex;
  addresses: { identity: Hex; organizers: Hex; ticket: Hex; paymaster: Hex };
  envioUrl: string;
  rpId: string;
  ipfsGateway: string;
  pinataJwt: string;
  /** Derived from chainId via chainDefaults, so no view hardcodes an explorer host. */
  explorerUrl: string;
}

let cached: AppConfig | null = null;

function readEnv(name: string): string | undefined {
  const value = import.meta.env[name] as string | undefined;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function required(name: string): string {
  const value = readEnv(name);
  if (value === undefined) {
    throw new Error(`Missing environment variable ${name}. See apps/web/.env.example`);
  }
  return value;
}

export function resetConfig(): void {
  cached = null;
}

export function getConfig(): AppConfig {
  if (cached) return cached;
  const rawChainId = readEnv('VITE_CHAIN_ID');
  const chainId = rawChainId === undefined ? DEFAULT_CHAIN_ID : Number.parseInt(rawChainId, 10);
  cached = {
    chainId,
    rpcUrls: required('VITE_RPC_URLS')
      .split(',')
      .map((url) => url.trim())
      .filter(Boolean),
    wsUrl: required('VITE_WS_URL'),
    bundlerUrl: required('VITE_BUNDLER_URL'),
    entryPoint: ENTRY_POINT_V06,
    addresses: {
      identity: required('VITE_ADDR_IDENTITY') as Hex,
      organizers: required('VITE_ADDR_ORGANIZERS') as Hex,
      ticket: required('VITE_ADDR_TICKET') as Hex,
      paymaster: required('VITE_ADDR_PAYMASTER') as Hex,
    },
    envioUrl: required('VITE_ENVIO_URL'),
    rpId: required('VITE_RP_ID'),
    ipfsGateway: required('VITE_IPFS_GATEWAY'),
    pinataJwt: required('VITE_PINATA_JWT'),
    explorerUrl: explorerUrlFor(chainId),
  };
  return cached;
}
