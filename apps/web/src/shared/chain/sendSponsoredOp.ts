import { concat, encodePacked, hexToBigInt, numberToHex, type Hex } from 'viem';
import type { SmartAccount } from 'viem/account-abstraction';
import { getConfig } from '../config';
import { getPublicClient } from './client';
import { bundlerRequest } from './bundler';

/** Monad charges on the limit, not on usage. The recommended headroom is 7.5%. */
export const GAS_BUFFER_NUMERATOR = 1075n;
export const GAS_BUFFER_DENOMINATOR = 1000n;

export function applyGasBuffer(value: bigint): bigint {
  return (value * GAS_BUFFER_NUMERATOR) / GAS_BUFFER_DENOMINATOR;
}

/** MontiPaymaster reads abi.encodePacked(address paymaster, uint256 orgId). */
export function encodePaymasterAndData(paymaster: Hex, orgId: bigint): Hex {
  return encodePacked(['address', 'uint256'], [paymaster, orgId]);
}

export interface UserOperationV06 {
  sender: Hex; nonce: Hex; initCode: Hex; callData: Hex;
  callGasLimit: Hex; verificationGasLimit: Hex; preVerificationGas: Hex;
  maxFeePerGas: Hex; maxPriorityFeePerGas: Hex; paymasterAndData: Hex; signature: Hex;
}

export interface SponsoredCall { to: Hex; data: Hex; value?: bigint }
export interface SponsoredOpReceipt { success: boolean; txHash: Hex; blockNumber: bigint; revertReason?: Hex }
export interface SponsoredOpHandle {
  userOpHash: Hex;
  wait(timeoutMs?: number): Promise<SponsoredOpReceipt>;
}
export interface SendSponsoredOpArgs { account: SmartAccount; calls: SponsoredCall[]; orgId: bigint }

/** Callers distinguish "not landed yet" from "reverted": only the latter is a user-facing failure. */
export class SponsoredOpTimeout extends Error {
  constructor(readonly userOpHash: Hex, readonly timeoutMs: number) {
    super(`SponsoredOpTimeout: ${userOpHash} did not land within ${timeoutMs}ms`);
    this.name = 'SponsoredOpTimeout';
  }
}

export const DEFAULT_WAIT_TIMEOUT_MS = 15_000;
const RECEIPT_POLL_INTERVAL_MS = 300;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function sendSponsoredOp({ account, calls, orgId }: SendSponsoredOpArgs): Promise<SponsoredOpHandle> {
  if (calls.length === 0) throw new Error('sendSponsoredOp needs at least one call');
  const config = getConfig();

  // Coinbase Smart Wallet encodeCalls emits execute() for one call and executeBatch() for many.
  const callData = await account.encodeCalls(calls.map((call) => ({ ...call, value: call.value ?? 0n })));
  const nonce = await account.getNonce();
  const factoryArgs = await account.getFactoryArgs();
  const initCode: Hex =
    factoryArgs.factory && factoryArgs.factoryData ? concat([factoryArgs.factory, factoryArgs.factoryData]) : '0x';
  const fees = await getPublicClient().estimateFeesPerGas();
  const paymasterAndData = encodePaymasterAndData(config.addresses.paymaster, orgId);

  const unsigned: UserOperationV06 = {
    sender: account.address,
    nonce: numberToHex(nonce),
    initCode,
    callData,
    callGasLimit: '0x0',
    verificationGasLimit: '0x0',
    preVerificationGas: '0x0',
    maxFeePerGas: numberToHex(fees.maxFeePerGas),
    maxPriorityFeePerGas: numberToHex(fees.maxPriorityFeePerGas),
    paymasterAndData,
    signature: await account.getStubSignature(),
  };

  const estimate = await bundlerRequest<{ callGasLimit: Hex; verificationGasLimit: Hex; preVerificationGas: Hex }>(
    'eth_estimateUserOperationGas',
    [unsigned, config.entryPoint],
  );

  const limits = {
    callGasLimit: numberToHex(applyGasBuffer(hexToBigInt(estimate.callGasLimit))),
    verificationGasLimit: numberToHex(applyGasBuffer(hexToBigInt(estimate.verificationGasLimit))),
    preVerificationGas: numberToHex(applyGasBuffer(hexToBigInt(estimate.preVerificationGas))),
  };

  const signature = await account.signUserOperation({
    sender: unsigned.sender,
    nonce,
    initCode,
    callData,
    callGasLimit: hexToBigInt(limits.callGasLimit),
    verificationGasLimit: hexToBigInt(limits.verificationGasLimit),
    preVerificationGas: hexToBigInt(limits.preVerificationGas),
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    paymasterAndData,
  } as never);

  const userOp: UserOperationV06 = { ...unsigned, ...limits, signature };
  const userOpHash = await bundlerRequest<Hex>('eth_sendUserOperation', [userOp, config.entryPoint]);

  return {
    userOpHash,
    async wait(timeoutMs = DEFAULT_WAIT_TIMEOUT_MS): Promise<SponsoredOpReceipt> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const receipt = await bundlerRequest<{
          success: boolean; reason?: Hex; receipt: { transactionHash: Hex; blockNumber: Hex };
        } | null>('eth_getUserOperationReceipt', [userOpHash]);
        if (receipt) {
          return {
            success: receipt.success,
            txHash: receipt.receipt.transactionHash,
            blockNumber: hexToBigInt(receipt.receipt.blockNumber),
            revertReason: receipt.reason,
          };
        }
        await sleep(RECEIPT_POLL_INTERVAL_MS);
      }
      throw new SponsoredOpTimeout(userOpHash, timeoutMs);
    },
  };
}
