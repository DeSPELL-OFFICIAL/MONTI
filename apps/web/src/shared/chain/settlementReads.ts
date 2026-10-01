import type { Address, Hex } from 'viem';
import { getConfig } from '../config';
import { getPublicClient } from './client';
import { settlementVaultAbi } from './settlementAbi';

/**
 * The deployed `SettlementVault`, or a clear throw when it is not configured. Every read below is
 * gated on it so a build without `VITE_ADDR_SETTLEMENT_VAULT` never calls the zero address — the
 * feature is hidden by `settlementEnabled()` (config.ts), and these throw if reached anyway. This
 * is the same shape the reads in `reads.ts` have, where the address comes from `getConfig()`.
 */
function settlementVault(): Address {
  const vault = getConfig().addresses.settlementVault;
  if (!vault) throw new Error('SETTLEMENT_VAULT_NOT_CONFIGURED');
  return vault;
}

/**
 * `SettlementVault.policyNonce(organizer)` — the per-organizer replay counter the device key signs
 * over. The next `setPolicy` auth must carry exactly this value, so the organiser screen reads it
 * immediately before building the digest, never from a cache.
 */
export function readPolicyNonce(organizer: Address): Promise<bigint> {
  return getPublicClient().readContract({
    address: settlementVault(),
    abi: settlementVaultAbi,
    functionName: 'policyNonce',
    args: [organizer],
  });
}

/** One payout line as the chain holds it (`SettlementVault.Recipient`). */
export interface ChainRecipient {
  account: Hex;
  bps: number;
  reasonHash: Hex;
  tag: Hex;
}

/**
 * The frozen-on-sale split (`SettlementVault.SplitPolicy`) as `getPolicy` hands it back. An event
 * with no policy answers the zero struct — `recipients` empty, `version` 0 — the same way the
 * reads in `reads.ts` read an absent mapping value as a zero struct rather than an error. The
 * field order mirrors `settlementVaultAbi`'s tuple, which viem decodes positionally.
 */
export interface ChainPolicy {
  recipients: ChainRecipient[];
  platformBps: number;
  reserveBps: number;
  noShowRefund: boolean;
  frozen: boolean;
  version: number;
}

export async function readChainPolicy(eventId: bigint): Promise<ChainPolicy> {
  const policy = await getPublicClient().readContract({
    address: settlementVault(),
    abi: settlementVaultAbi,
    functionName: 'getPolicy',
    args: [eventId],
  });
  return {
    recipients: policy.recipients.map((r) => ({
      account: r.account,
      bps: r.bps,
      reasonHash: r.reasonHash,
      tag: r.tag,
    })),
    platformBps: policy.platformBps,
    reserveBps: policy.reserveBps,
    noShowRefund: policy.noShowRefund,
    frozen: policy.frozen,
    version: policy.version,
  };
}
