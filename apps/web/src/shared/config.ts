import { DEFAULT_CHAIN_ID, type Hex } from '@monti/shared';
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
  /**
   * `settlementVault`/`usdc` are OPTIONAL: the programmable-settlement layer is a
   * standalone contract deployed after the core four, so a build without
   * `VITE_ADDR_SETTLEMENT_VAULT` simply hides the feature (see {@link settlementEnabled}).
   */
  addresses: {
    identity: Hex;
    organizers: Hex;
    ticket: Hex;
    forwarder: Hex;
    settlementVault?: Hex;
    usdc?: Hex;
    /** The MONTI platform fee recipient — the fixed `platform`-tagged row in a split policy. */
    platform?: Hex;
  };
  envioUrl: string;
  rpId: string;
  ipfsGateway: string;
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

/**
 * Whether the organiser scene may offer `관리자 승인 후 발급` (approvalRequired). It is off
 * unless `VITE_APPROVAL_MODES` is exactly `on`, because the deployed contract still reverts on a
 * `claim` for an approval-required event until the 01c redeploy — so the option is drawn but
 * disabled until this flag opens it. Read at call time, so a build (or a test's `vi.stubEnv`)
 * decides it the same way every other `VITE_*` variable is decided.
 */
export function approvalModesEnabled(): boolean {
  return optionalEnv('VITE_APPROVAL_MODES') === 'on';
}

/**
 * Whether the programmable-settlement feature is live for this build. True only when BOTH the
 * vault and the USDC token address are configured — a vault with no token to escrow is a
 * half-wired feature, so the screens stay hidden until both are present. Read at call time, the
 * same way {@link approvalModesEnabled} is, so a build (or a test's `vi.stubEnv`) decides it
 * like every other `VITE_*` variable.
 */
export function settlementEnabled(): boolean {
  return optionalEnv('VITE_ADDR_SETTLEMENT_VAULT') !== undefined && optionalEnv('VITE_ADDR_USDC') !== undefined;
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
    addresses: {
      identity: requiredEnv('VITE_ADDR_IDENTITY') as Hex,
      organizers: requiredEnv('VITE_ADDR_ORGANIZERS') as Hex,
      ticket: requiredEnv('VITE_ADDR_TICKET') as Hex,
      // The ERC-2771 relay target (design §1). Added for Phase 2; B2 finalises the deployed value.
      forwarder: requiredEnv('VITE_ADDR_FORWARDER') as Hex,
      // Optional: present once the settlement layer is deployed. `settlementEnabled()`
      // gates every screen that reads them, so an unset build never touches them.
      settlementVault: optionalEnv('VITE_ADDR_SETTLEMENT_VAULT') as Hex | undefined,
      usdc: optionalEnv('VITE_ADDR_USDC') as Hex | undefined,
      // The MONTI platform fee wallet the organiser split's fixed `platform` row pays to. Optional:
      // the settlement screens read it only when `settlementEnabled()` is already true.
      platform: optionalEnv('VITE_ADDR_PLATFORM') as Hex | undefined,
    },
    envioUrl: requiredEnv('VITE_ENVIO_URL'),
    rpId: requiredEnv('VITE_RP_ID'),
    ipfsGateway: requiredEnv('VITE_IPFS_GATEWAY'),
    explorerUrl: explorerUrlFor(chainId),
  };
  return cached;
}
