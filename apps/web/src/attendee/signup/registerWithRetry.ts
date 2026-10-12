import { Capacitor } from '@capacitor/core';
import type { Hex } from '@monti/shared';
import { api, callableFailure } from '../../shared/api/functions';
import { getFirebaseAuth } from '../../shared/api/firebase';

/**
 * The chain-registration step both entry screens end with — `/signup/register` (phone + passkey)
 * and `/start` (open mode) — kept in one place so the attester's queue is waited out the same way
 * on both.
 */

/** The three the server accepts; anything else (a desktop browser) registers as `web`. */
export function platform(): 'ios' | 'android' | 'web' {
  const current = Capacitor.getPlatform();
  return current === 'ios' || current === 'android' ? current : 'web';
}

/**
 * `registerIdentity` goes through a single attester that sends one registration at a time, so a
 * burst of signups queues behind it and the ones that cannot get a turn come back as
 * `resource-exhausted` / `ATTESTER_BUSY`. That is "the queue is full, come back", not "this
 * failed", so the run waits it out on its own — three times, longer each time — before the
 * screen says a word about it. Only when the queue is still full after all three does the
 * ordinary busy message surface.
 */
export const REGISTER_RETRY_DELAYS_MS = [3_000, 6_000, 10_000];

/** A momentary "the attester is busy", worth waiting out — not a refusal that retrying would loop on. */
export function isAttesterBusy(failure: unknown): boolean {
  const { code, reason } = callableFailure(failure);
  return code === 'resource-exhausted' || reason === 'ATTESTER_BUSY';
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/**
 * Resolving at all is success. `alreadyRegistered` means the server found this account on chain
 * already and sent nothing — there is no hash to wait for and nothing to redo. A busy attester is
 * not a failure, so this waits it out ({@link REGISTER_RETRY_DELAYS_MS}) and reports the wait
 * through `onRetrying` (true while waiting, false when the next attempt starts). Any other
 * rejection, or a busy answer after the last retry, is thrown to the caller.
 */
export async function registerIdentityWithRetry(
  input: { personId: Hex; deviceX: Hex; deviceY: Hex },
  onRetrying: (waiting: boolean) => void,
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await api.registerIdentity({ ...input, platform: platform() });
      return;
    } catch (failure) {
      // `undefined` here means the retries are spent (index past the end); a non-busy answer is
      // a real failure. Either way the caller gets it.
      const backoff = REGISTER_RETRY_DELAYS_MS[attempt];
      if (backoff === undefined || !isAttesterBusy(failure)) throw failure;
      onRetrying(true);
      await delay(backoff);
      onRetrying(false);
    }
  }
}

/**
 * The session is never written by hand. `shared/api/sessionHydrator` reads `{ personId, account }`
 * out of the Firebase token's claims and is the only thing that may say "signed in"; forcing a
 * refresh is how the claims the server just wrote reach that hydrator. The registration itself
 * already succeeded, so a refresh that fails must not undo it.
 */
export async function refreshClaims(): Promise<void> {
  try {
    await getFirebaseAuth().currentUser?.getIdToken(true);
  } catch {
    // A stale token costs one sign-in, a thrown one costs the whole signup.
  }
}
