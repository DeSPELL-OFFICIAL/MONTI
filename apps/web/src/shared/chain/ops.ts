import { encodeFunctionData, hexToBigInt, type Abi, type Hex } from 'viem';
import type { SmartAccount } from 'viem/account-abstraction';
import { getConfig } from '../config';
import { identityAbi, organizersAbi, ticketAbi, type UsedContract, type UsedFunction } from './abis';
import { bundlerRequest } from './bundler';
import { getPublicClient } from './client';
import {
  readOpLogs, revertDataOf, sendSponsoredOp, type SponsoredOpLog, type SponsoredOpReceipt,
} from './sendSponsoredOp';
import { OpReverted } from './opReverted';
import { isUnsponsored } from './unsponsored';

export { OpReverted } from './opReverted';

/**
 * Where an operation this app already sent has got to.
 *
 *   - `pending` — still on its way; nothing new may be sent for it.
 *   - `landed`  — included; its logs are readable.
 *   - `failed`  — reverted on chain, or dropped from the mempool. The same work may be resent.
 *   - `stale`   — still in the mempool but stuck: priced below what would clear rundler's Monad
 *                 bundling threshold now, or waiting past {@link STALE_OP_AGE_MS} with no
 *                 inclusion. It will never land on its own, so the same work may be resent.
 */
export type SubmittedOpState = 'pending' | 'landed' | 'failed' | 'stale';

export interface SubmittedOp {
  state: SubmittedOpState;
  /** The operation's own logs, so a caller that timed out can still read what it created. */
  logs: readonly SponsoredOpLog[];
}

/**
 * A mempool op still unincluded after this long is treated as `stale`. Five minutes is far past
 * Monad's seconds-long normal settle and past the create scene's own 45s wait, so nothing that is
 * merely slow trips it — only an op that is genuinely stuck.
 */
export const STALE_OP_AGE_MS = 5 * 60_000;

/**
 * Asks the bundler what became of an operation whose `wait` gave up. A receipt settles it —
 * `landed` or `failed`. With no receipt, `eth_getUserOperationReceipt` cannot tell a dead op from
 * a live one (both read null), so the op is looked up by hash: gone from the mempool is `failed`
 * (resendable); still in it is `pending` only while it is young **and** priced to be includable,
 * and `stale` (resendable) otherwise. That `stale` verdict is what lets an account welded to a
 * pre-fix op — accepted at 122 gwei, below rundler's Monad threshold, never bundlable — escape and
 * resend at the corrected fee (task-create-failure-4 report S4, S7).
 *
 * `submittedAt` is the epoch-ms the op was recorded, for the age test; 0 (the default) skips it,
 * leaving only the price test. A bundler that cannot be reached is the caller's problem, not this
 * function's — it throws, and every caller treats that as `pending`, because the safe answer to
 * "did my event get created?" is never "send another one".
 */
export async function resolveSubmittedOp(userOpHash: Hex, submittedAt = 0): Promise<SubmittedOp> {
  const receipt = await bundlerRequest<{ success?: boolean; logs?: unknown } | null>(
    'eth_getUserOperationReceipt',
    [userOpHash],
  );
  if (receipt !== null && receipt !== undefined) {
    return { state: receipt.success === true ? 'landed' : 'failed', logs: readOpLogs(receipt) };
  }

  const known = await bundlerRequest<
    { userOperation?: { maxFeePerGas?: Hex }; blockNumber?: Hex | null } | null
  >('eth_getUserOperationByHash', [userOpHash]);
  // Gone from the mempool entirely: it will never land, so the same work may be resent.
  if (known === null || known === undefined) return { state: 'failed', logs: [] };
  // Mined into a block, only the receipt has not caught up yet — genuinely on its way.
  if (known.blockNumber !== null && known.blockNumber !== undefined) return { state: 'pending', logs: [] };

  // Still in the mempool. It is stuck rather than progressing when it is priced below what a fresh
  // send would pay now (so it cannot clear rundler's Monad bundling threshold — the pre-fix
  // 122 gwei op), or when it has waited past the stale horizon. Only a young, adequately-priced op
  // is still `pending`.
  const opFee = known.userOperation?.maxFeePerGas;
  const floor = (await getPublicClient().estimateFeesPerGas()).maxFeePerGas;
  const underpriced = opFee !== undefined && hexToBigInt(opFee) < floor;
  const old = submittedAt > 0 && Date.now() - submittedAt > STALE_OP_AGE_MS;
  return { state: underpriced || old ? 'stale' : 'pending', logs: [] };
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
  /**
   * Called once the bundler accepts the op and hands back its hash — **before** `wait`. The claim
   * path records the hash durably here (T-SIMP-1), so a page closed mid-wait can `resolveSubmittedOp`
   * it on the next visit instead of blind-resending, and drives its progress from 저장 to 확인.
   */
  onSubmitted?: (userOpHash: Hex) => void;
  /**
   * Called each time a transient precheck rejection is retried at the send layer, so a screen can say
   * a resend is happening ("잠시 붐벼요…"). See {@link sendSponsoredOp}'s precheck backoff.
   */
  onSendRetry?: () => void;
}

/** Encode → sponsor → send → wait → throw on revert. Every write in this app goes through here. */
export async function sendOp(options: SendOpArgs): Promise<SponsoredOpReceipt> {
  const handle = await sendSponsoredOp({
    account: options.account,
    orgId: options.orgId,
    calls: [{ to: options.to, data: encodeFunctionData({ abi: options.abi, functionName: options.functionName, args: options.args }) }],
    onSendRetry: options.onSendRetry,
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
  // The op is in the mempool now and has a hash. Hand it to the caller before the wait, so a claim
  // recorded here survives the page being closed while `wait` is still polling.
  options.onSubmitted?.(handle.userOpHash);
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
