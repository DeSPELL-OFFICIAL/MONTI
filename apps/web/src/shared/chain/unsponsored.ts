import { encodeErrorResult } from 'viem';
import { montiPaymasterAbi } from '@monti/shared';
import { OpReverted } from './opReverted';

/**
 * How the paymaster refuses to pay. Until sub-plan 01b's `setAllowed`, no organiser selector is
 * on its allowlist, so an organiser write is rejected while the operation is still being
 * simulated — the bundler answers the send with the paymaster's revert, which never becomes an
 * `OpReverted` because nothing ever landed. Both the error name and its four bytes are looked
 * for: a bundler may hand back either, wrapped in a message of its own.
 */
const PAYMASTER_REFUSALS: readonly string[] = ['SelectorNotAllowed', 'TargetNotAllowed', 'AA33'];

function paymasterSelectors(): string[] {
  return ['SelectorNotAllowed', 'TargetNotAllowed'].flatMap((errorName) => {
    try {
      return [encodeErrorResult({ abi: montiPaymasterAbi, errorName }).toLowerCase()];
    } catch {
      return [];
    }
  });
}

/** Flattens a bundler rejection: viem nests the reason under `details`, `shortMessage`, `cause`. */
function describeError(cause: unknown, depth = 0): string {
  if (depth > 4 || typeof cause !== 'object' || cause === null) return String(cause ?? '');
  const error = cause as { message?: unknown; details?: unknown; shortMessage?: unknown; cause?: unknown };
  return [error.message, error.details, error.shortMessage, describeError(error.cause, depth + 1)]
    .map((part) => (typeof part === 'string' ? part : ''))
    .join(' ');
}

/**
 * True when nothing agreed to pay for this operation, so it was never even sent. Every
 * organiser screen says so in its own words; no attendee screen ever reaches this.
 */
export function isUnsponsored(cause: unknown): boolean {
  if (cause instanceof OpReverted) return false;
  const text = describeError(cause).toLowerCase();
  if (text === '') return false;
  return (
    PAYMASTER_REFUSALS.some((name) => text.includes(name.toLowerCase())) ||
    paymasterSelectors().some((selector) => text.includes(selector))
  );
}
