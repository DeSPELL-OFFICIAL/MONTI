import { encodeFunctionData, type Abi, type Hex } from 'viem';
import type { SmartAccount } from 'viem/account-abstraction';
import { getConfig } from '../config';
import { identityAbi, organizersAbi, ticketAbi, type UsedContract, type UsedFunction } from './abis';
import { bundlerRequest } from './bundler';
import {
  readOpLogs, revertDataOf, sendSponsoredOp, type SponsoredOpLog, type SponsoredOpReceipt,
} from './sendSponsoredOp';
import { OpReverted } from './opReverted';
import { isUnsponsored } from './unsponsored';

export { OpReverted } from './opReverted';

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
  /**
   * Keep polling the receipt past `timeoutMs`, up to this cap, before declaring the op unlanded.
   * The create path passes it so a late inclusion resolves on its own instead of parking the
   * organiser on "확인 중" (persona R2 P0-1). Omitted, `wait` behaves exactly as it did.
   */
  maxTimeoutMs?: number;
}

/** Encode → sponsor → send → wait → throw on revert. Every write in this app goes through here. */
export async function sendOp(options: SendOpArgs): Promise<SponsoredOpReceipt> {
  const handle = await sendSponsoredOp({
    account: options.account,
    orgId: options.orgId,
    calls: [{ to: options.to, data: encodeFunctionData({ abi: options.abi, functionName: options.functionName, args: options.args }) }],
  }).catch((cause: unknown) => {
    // A revert the bundler caught while *simulating* never becomes a receipt, so until now it
    // left this layer as viem's `RpcRequestError` and every screen fell through to its most
    // generic sentence. That is how a draft whose end time had passed said only "행사를 만들지
    // 못했어요" instead of naming the end time (task-create-failure-2 report §0). The four
    // bytes are right there in the rejection, so the failure is promoted to the same
    // `OpReverted` a landed revert produces and every `revertMatch` table works on it.
    //
    // A paymaster refusal is deliberately left alone: it also reverts during simulation, but
    // it is a sponsorship problem rather than a rule the organiser broke, and `isUnsponsored`
    // answers false for anything that is already an `OpReverted`.
    const revertData = revertDataOf(cause);
    if (revertData !== undefined && !isUnsponsored(cause)) {
      throw new OpReverted(options.functionName, revertData);
    }
    throw cause;
  });
  const receipt = await handle.wait(options.timeoutMs, options.maxTimeoutMs);
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
