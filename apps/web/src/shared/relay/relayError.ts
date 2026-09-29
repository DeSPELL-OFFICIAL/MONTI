import { callableFailure } from '../api/functions';

/**
 * The refusal code a failed relayed action carries: the forwarder code (`TARGET_NOT_ALLOWED`,
 * `BAD_NONCE`, …) or the bubbled Solidity error name (`NotDraft`, `Unauthorized`, …), read off
 * `details.code` (the frozen contract, exactly as `claim/claimErrors.ts` reads the claim path's)
 * and falling back to the callable's message. Read structurally, not with `instanceof`, so it still
 * resolves when a screen's test mocks the relay/callable module.
 */
export function relayActionCode(cause: unknown): string {
  const details = (cause as { details?: unknown } | null)?.details;
  if (typeof details === 'object' && details !== null) {
    const { code } = details as { code?: unknown };
    if (typeof code === 'string' && code !== '') return code;
  }
  return callableFailure(cause).reason;
}

/**
 * Maps a relayed action's refusal to the caller's own problem name by matching {@link
 * relayActionCode} against a table keyed by Solidity error name / forwarder code — the same tables
 * the sponsored path fed to `revertMatch`, now matched by name rather than by four-byte selector.
 * `undefined` when nothing matches, so the caller falls through to its generic sentence.
 */
export function relayProblem<T>(cause: unknown, table: ReadonlyArray<readonly [string, T]>): T | undefined {
  const code = relayActionCode(cause);
  return table.find(([name]) => name === code)?.[1];
}
