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

/**
 * The floor under `verificationGasLimit`, for **every** account this app sends from.
 *
 * Both of them are WebAuthn owners — the attendee's passkey and the gate's StrongBox key — and
 * both are estimated with viem's stub signature. That stub carries viem's fixed challenge
 * (`toCoinbaseSmartAccount.js:122-124`), which can never equal a real `userOpHash`, so
 * `WebAuthn.verify` fails the challenge comparison and returns **before** the `0x100` precompile
 * runs. The stub gets the `SignatureWrapper` shape and the calldata cost right and hides the
 * verification itself: 5,012 gas estimated against 15,287 measured on Monad, ~10.3k short (Task
 * 12 review). Nothing puts it back — this module applies only `applyGasBuffer` and never calls
 * viem's `userOperation.estimateGas` hook.
 *
 * The first op of an account carries `initCode`, so its estimate is large and 7.5% of it dwarfs
 * 10.3k; every op after deployment estimates a bare `validateUserOp`, where 7.5% no longer
 * covers the gap and the EntryPoint reverts `AA23 out of gas`. Which is the worst shape of
 * failure at a door: the first check-in works and every one after it does not.
 *
 * 150,000 and not viem's 800,000, because Monad bills the limit rather than the usage — an 800k
 * floor would charge the organizer's paymaster roughly five times per check-in for gas nobody
 * spent.
 */
export const MIN_VERIFICATION_GAS = 150_000n;

/**
 * Per-call floors under the simulated limits. They are floors and never replacements: an
 * estimate above one is used as it stands, because the estimate knows things a constant cannot
 * (the calldata, whether the account still needs deploying) and lowering it would only fail.
 */
export interface SponsoredGasFloors {
  callGasLimit?: bigint;
  verificationGasLimit?: bigint;
  preVerificationGas?: bigint;
}

const atLeast = (value: bigint, minimum: bigint): bigint => (value > minimum ? value : minimum);

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

/**
 * One log this operation emitted, in the three fields `parseEventLogs` decodes from. The
 * bundler's `eth_getUserOperationReceipt` carries these at the top level — the logs of *this*
 * operation, not of the whole bundled transaction — which is what makes them safe to read: a
 * neighbouring operation in the same bundle cannot put its `EventCreated` in here.
 */
export interface SponsoredOpLog { address: Hex; topics: readonly Hex[]; data: Hex }

/** `revertReason` is the on-chain reason for a real revert, or the sentinel `'TIMEOUT'`
 * when `wait` gave up before the op landed. Callers (see `sendOp`) treat any
 * `success: false` as a failure; the sentinel lets them tell "reverted" from "never landed".
 *
 * `logs` is empty for anything that did not land, and for a bundler that answers without them. */
export interface SponsoredOpReceipt {
  success: boolean;
  /**
   * The operation's own hash, carried on the receipt and not only on the handle. A caller that
   * succeeded still needs it: `eth_getUserOperationReceipt` is the only way back to an
   * operation whose logs this side could not read, and without the hash on the receipt the
   * only way to ask again would be to send the operation a second time.
   */
  userOpHash: Hex;
  txHash: Hex;
  blockNumber: bigint;
  revertReason?: Hex | 'TIMEOUT';
  logs: readonly SponsoredOpLog[];
}
export interface SponsoredOpHandle {
  userOpHash: Hex;
  wait(timeoutMs?: number): Promise<SponsoredOpReceipt>;
}
export interface SendSponsoredOpArgs {
  account: SmartAccount;
  calls: SponsoredCall[];
  orgId: bigint;
  /** Optional per-call floors. `verificationGasLimit` is floored at {@link MIN_VERIFICATION_GAS}
   *  whether or not this is passed — that one is not a caller's choice. */
  gasFloors?: SponsoredGasFloors;
}

export const DEFAULT_WAIT_TIMEOUT_MS = 15_000;
const RECEIPT_POLL_INTERVAL_MS = 300;
/** Sentinel that wins the poll race when the deadline elapses first. */
const TIMED_OUT = Symbol('sponsored-op-timeout');

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface RawReceipt {
  success: boolean;
  reason?: Hex;
  logs?: SponsoredOpLog[];
  receipt: { transactionHash: Hex; blockNumber: Hex };
}

/**
 * The four bytes a contract reverted with, dug out of a bundler rejection.
 *
 * `eth_estimateUserOperationGas` is a simulation: a contract that refuses there produces no
 * operation, no receipt and no `UserOperationRevertReason` log — only a JSON-RPC error. Every
 * bundler this app talks to puts the reason in the same place,
 *
 *     { "code": -32521, "message": "execution reverted", "data": { "revertData": "0xdba16ce8" } }
 *
 * and viem wraps that a few `cause` levels deep, so the search walks down. Anything that is not
 * a selector-length hex string is not a revert reason and yields nothing — the caller then
 * rethrows the original error untouched.
 */
export function revertDataOf(cause: unknown, depth = 0): Hex | undefined {
  if (depth > 4 || typeof cause !== 'object' || cause === null) return undefined;
  const error = cause as { data?: unknown; cause?: unknown };
  const data = error.data as { revertData?: unknown } | null | undefined;
  const reason = typeof data === 'object' && data !== null ? data.revertData : undefined;
  // A selector is four bytes; a revert with arguments is longer. Shorter is not a revert.
  if (typeof reason === 'string' && /^0x[0-9a-f]{8,}$/i.test(reason)) return reason as Hex;
  return revertDataOf(error.cause, depth + 1);
}

/** A bundler that omits `logs`, or sends something other than an array, yields none. */
export function readOpLogs(raw: { logs?: unknown } | null | undefined): readonly SponsoredOpLog[] {
  return Array.isArray(raw?.logs) ? (raw.logs as SponsoredOpLog[]) : [];
}

export async function sendSponsoredOp({ account, calls, orgId, gasFloors }: SendSponsoredOpArgs): Promise<SponsoredOpHandle> {
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
    callGasLimit: numberToHex(
      atLeast(applyGasBuffer(hexToBigInt(estimate.callGasLimit)), gasFloors?.callGasLimit ?? 0n),
    ),
    verificationGasLimit: numberToHex(
      atLeast(
        applyGasBuffer(hexToBigInt(estimate.verificationGasLimit)),
        atLeast(gasFloors?.verificationGasLimit ?? 0n, MIN_VERIFICATION_GAS),
      ),
    ),
    preVerificationGas: numberToHex(
      atLeast(applyGasBuffer(hexToBigInt(estimate.preVerificationGas)), gasFloors?.preVerificationGas ?? 0n),
    ),
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
        const remaining = deadline - Date.now();

        // Race the poll against the remaining wall-clock time. The bundler transport
        // has a 30s timeout, so without this a single stalled poll could overrun
        // wait(15_000) to ~60s at a venue gate. The timer is cleared on settle.
        let timer: ReturnType<typeof setTimeout> | undefined;
        const deadlineRace = new Promise<typeof TIMED_OUT>((resolve) => {
          timer = setTimeout(() => resolve(TIMED_OUT), remaining);
        });

        // A flaky poll (dropped connection on venue wifi) must not reject the whole
        // wait: swallow it to null and retry. This also keeps the losing branch of the
        // race harmless if the deadline wins first.
        const poll = bundlerRequest<RawReceipt | null>('eth_getUserOperationReceipt', [userOpHash]).catch(
          () => null,
        );

        const result = await Promise.race([poll, deadlineRace]);
        clearTimeout(timer);

        if (result === TIMED_OUT) break;
        if (result) {
          return {
            success: result.success,
            userOpHash,
            txHash: result.receipt.transactionHash,
            blockNumber: hexToBigInt(result.receipt.blockNumber),
            revertReason: result.reason,
            logs: readOpLogs(result),
          };
        }

        // Not landed yet: pause a poll interval, but never past the deadline.
        const untilNext = Math.min(RECEIPT_POLL_INTERVAL_MS, deadline - Date.now());
        if (untilNext > 0) await sleep(untilNext);
      }

      // The op never landed within the deadline. Not a revert, but the caller must be
      // unblocked; sendOp() maps success:false -> OpReverted with this sentinel reason.
      return {
        success: false, userOpHash, txHash: '0x', blockNumber: 0n, revertReason: 'TIMEOUT', logs: [],
      };
    },
  };
}
