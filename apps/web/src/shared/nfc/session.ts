// The two ways a tap ends without a tag, and the latch that makes sure only one ending wins.
//
// `nfcSessionEnd` is an iOS event. On Android native and on Web NFC nothing else ever settles a
// read, so an attendee who walks away from the gate would leave the promise pending forever and
// the gate screen would have no way to take it back. Every read arms a deadline instead.
import { NFC_ERROR, NfcError } from './errors';

/** The iOS reader session's own lifetime; there is nothing to wait for past it. */
export const NFC_SESSION_TIMEOUT_MS = 60_000;

export interface NfcTapOptions {
  /** Cancels the tap from the gate screen: the session is torn down and `NFC_CANCELLED` raised. */
  signal?: AbortSignal;
  /** Defaults to {@link NFC_SESSION_TIMEOUT_MS}. */
  timeoutMs?: number;
}

export function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new NfcError(NFC_ERROR.cancelled);
}

/**
 * Arms the abort listener and the timeout. Returns the disarm, which the caller must run once
 * the wait is over so neither outlives the session.
 */
export function armDeadline(options: NfcTapOptions, reject: (cause: unknown) => void): () => void {
  const { signal, timeoutMs = NFC_SESSION_TIMEOUT_MS } = options;
  const onAbort = (): void => reject(new NfcError(NFC_ERROR.cancelled));
  signal?.addEventListener('abort', onAbort);
  const timer = setTimeout(() => reject(new NfcError(NFC_ERROR.timeout)), timeoutMs);
  return () => {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  };
}

export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (cause: unknown) => void;
}

/**
 * First settlement wins. A tag that arrives as the session is being torn down, a deadline that
 * fires while the biometric prompt is up — neither may overwrite an ending already decided.
 */
export function deferred<T>(): Deferred<T> {
  let resolveFn!: (value: T) => void;
  let rejectFn!: (cause: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });
  // The rejection is always delivered to whoever awaits `promise`; this only marks it handled so
  // a deadline firing before anyone awaits cannot surface as an unhandled rejection.
  promise.catch(() => undefined);
  let settled = false;
  return {
    promise,
    resolve: (value) => {
      if (settled) return;
      settled = true;
      resolveFn(value);
    },
    reject: (cause) => {
      if (settled) return;
      settled = true;
      rejectFn(cause);
    },
  };
}
