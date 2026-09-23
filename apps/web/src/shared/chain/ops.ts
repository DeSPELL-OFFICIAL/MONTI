import { encodeFunctionData, type Abi, type Hex } from 'viem';
import type { SmartAccount } from 'viem/account-abstraction';
import { getConfig } from '../config';
import { identityAbi, organizersAbi, ticketAbi, type UsedContract, type UsedFunction } from './abis';
import { bundlerRequest } from './bundler';
import { readOpLogs, sendSponsoredOp, type SponsoredOpLog, type SponsoredOpReceipt } from './sendSponsoredOp';

/** The operation did not succeed — the contract reverted, or `wait` timed out before it
 * landed (`revertReason` is then the `'TIMEOUT'` sentinel). Either way, user-facing failure.
 *
 * `userOpHash` is carried so a caller that saw the sentinel can come back to the same
 * operation later instead of sending a second one: the first may still be in flight, and two
 * `createEvent` operations are two events. */
export class OpReverted extends Error {
  constructor(
    readonly functionName: string,
    readonly revertReason?: Hex | 'TIMEOUT',
    readonly userOpHash?: Hex,
  ) {
    super(`OpReverted: ${functionName}${revertReason ? ` (${revertReason})` : ''}`);
    this.name = 'OpReverted';
  }
}

/** Where an operation this app already sent has got to. */
export type SubmittedOpState = 'pending' | 'landed' | 'failed';

export interface SubmittedOp {
  state: SubmittedOpState;
  /** The operation's own logs, so a caller that timed out can still read what it created. */
  logs: readonly SponsoredOpLog[];
}

/**
 * Asks the bundler about an operation whose `wait` gave up. `pending` means it is still on its
 * way and nothing new may be sent for it; `failed` means it reverted, so the same work may be
 * tried again. A bundler that cannot be reached is the caller's problem, not this function's —
 * it throws, and the caller decides (every one of them treats that as `pending`, because the
 * safe answer to "did my event get created?" is never "send another one").
 */
export async function resolveSubmittedOp(userOpHash: Hex): Promise<SubmittedOp> {
  const receipt = await bundlerRequest<{ success?: boolean; logs?: unknown } | null>(
    'eth_getUserOperationReceipt',
    [userOpHash],
  );
  if (receipt === null || receipt === undefined) return { state: 'pending', logs: [] };
  return { state: receipt.success === true ? 'landed' : 'failed', logs: readOpLogs(receipt) };
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
  if (!receipt.success) throw new OpReverted(options.functionName, receipt.revertReason, handle.userOpHash);
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
