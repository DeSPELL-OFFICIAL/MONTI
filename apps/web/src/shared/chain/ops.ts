import { encodeFunctionData, type Abi, type Hex } from 'viem';
import type { SmartAccount } from 'viem/account-abstraction';
import { getConfig } from '../config';
import { identityAbi, organizersAbi, ticketAbi, type UsedContract, type UsedFunction } from './abis';
import { sendSponsoredOp, type SponsoredOpReceipt } from './sendSponsoredOp';

/** The operation did not succeed — the contract reverted, or `wait` timed out before it
 * landed (`revertReason` is then the `'TIMEOUT'` sentinel). Either way, user-facing failure. */
export class OpReverted extends Error {
  constructor(readonly functionName: string, readonly revertReason?: Hex | 'TIMEOUT') {
    super(`OpReverted: ${functionName}${revertReason ? ` (${revertReason})` : ''}`);
    this.name = 'OpReverted';
  }
}

export interface SendOpArgs {
  account: SmartAccount;
  orgId: bigint;
  to: Hex;
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
  timeoutMs?: number;
}

/** Encode → sponsor → send → wait → throw on revert. Every write in this app goes through here. */
export async function sendOp(options: SendOpArgs): Promise<SponsoredOpReceipt> {
  const handle = await sendSponsoredOp({
    account: options.account,
    orgId: options.orgId,
    calls: [{ to: options.to, data: encodeFunctionData({ abi: options.abi, functionName: options.functionName, args: options.args }) }],
  });
  const receipt = await handle.wait(options.timeoutMs);
  if (!receipt.success) throw new OpReverted(options.functionName, receipt.revertReason);
  return receipt;
}

/** The contract is fixed, and the function name is one `USED_ABI` declares for it — so a
 *  write this app has not declared fails to compile instead of at the bundler. */
type ContractOpArgs<C extends UsedContract> =
  Omit<SendOpArgs, 'to' | 'abi' | 'functionName'> & { functionName: UsedFunction<C> };

export const ticketOp = (options: ContractOpArgs<'Ticket'>) =>
  sendOp({ ...options, to: getConfig().addresses.ticket, abi: ticketAbi });

export const identityOp = (options: ContractOpArgs<'Identity'>) =>
  sendOp({ ...options, to: getConfig().addresses.identity, abi: identityAbi });

export const organizersOp = (options: ContractOpArgs<'Organizers'>) =>
  sendOp({ ...options, to: getConfig().addresses.organizers, abi: organizersAbi });
