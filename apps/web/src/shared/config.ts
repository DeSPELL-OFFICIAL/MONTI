import { DEFAULT_CHAIN_ID, ENTRY_POINT_V06_ADDRESS, type Hex } from '@monti/shared';
import { explorerUrlFor } from './config/chainDefaults';

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
  /** Empty until an organizer build needs it: nothing in the attendee app pins. */
  pinataJwt: string;
  /** Derived from chainId, so no view hardcodes an explorer host. */
  explorerUrl: string;
}

let cached: AppConfig | null = null;

/** Reads a `VITE_*` variable, treating an empty string as absent. */
export function optionalEnv(name: string): string | undefined {
  const value = import.meta.env[name] as string | undefined;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Fail-fast read: every module that needs a `VITE_*` variable names it the same way. */
export function requiredEnv(name: string): string {
  const value = optionalEnv(name);
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
  const rawChainId = optionalEnv('VITE_CHAIN_ID');
  const chainId = rawChainId === undefined ? DEFAULT_CHAIN_ID : Number.parseInt(rawChainId, 10);
  cached = {
    chainId,
    rpcUrls: requiredEnv('VITE_RPC_URLS')
      .split(',')
      .map((url) => url.trim())
      .filter(Boolean),
    wsUrl: requiredEnv('VITE_WS_URL'),
    bundlerUrl: requiredEnv('VITE_BUNDLER_URL'),
    entryPoint: ENTRY_POINT_V06_ADDRESS,
    addresses: {
      identity: requiredEnv('VITE_ADDR_IDENTITY') as Hex,
      organizers: requiredEnv('VITE_ADDR_ORGANIZERS') as Hex,
      ticket: requiredEnv('VITE_ADDR_TICKET') as Hex,
      paymaster: requiredEnv('VITE_ADDR_PAYMASTER') as Hex,
    },
    envioUrl: requiredEnv('VITE_ENVIO_URL'),
    rpId: requiredEnv('VITE_RP_ID'),
    ipfsGateway: requiredEnv('VITE_IPFS_GATEWAY'),
    // Optional on purpose: the attendee app never pins, so a blank one must not stop it
    // booting. The organizer upload path fails fast at its own call site instead.
    pinataJwt: optionalEnv('VITE_PINATA_JWT') ?? '',
    explorerUrl: explorerUrlFor(chainId),
  };
  return cached;
}
