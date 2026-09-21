/** What went wrong in a WebAuthn ceremony, as far as a screen needs to care. */
export type PasskeyProblem = 'cancelled' | 'unsupported' | 'failed';

/** How deep a wrapped cause chain is worth walking; ox wraps the DOMException exactly once. */
const MAX_CAUSE_DEPTH = 5;

function errorName(value: unknown): string {
  if (typeof value !== 'object' || value === null) return '';
  const { name } = value as { name?: unknown };
  return typeof name === 'string' ? name : '';
}

/**
 * A cancelled ceremony and an unusable authenticator are the two failures worth their own
 * sentence — "try again" is wrong advice for both. The platform reports them as DOMException
 * names, and ox re-throws its own error with the original under `cause`, so the chain is
 * walked rather than only the top error inspected.
 */
export function passkeyProblem(error: unknown): PasskeyProblem {
  let cursor = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && cursor; depth += 1) {
    const name = errorName(cursor);
    // NotAllowedError is what every browser reports for "the user dismissed the prompt".
    if (name === 'NotAllowedError' || name === 'AbortError') return 'cancelled';
    if (name === 'NotSupportedError' || name === 'SecurityError' || name === 'InvalidStateError') {
      return 'unsupported';
    }
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return 'failed';
}
