import { useEffect, useSyncExternalStore } from 'react';
import { joinRs, type Hex } from '@monti/shared';
import {
  ATTENDEE_KEY_ALIAS,
  deviceKeyCapability,
  peekDeviceKey,
  signWithDeviceKey,
  verifyDeviceSignature,
} from './deviceKey';
import { readIdentity } from './chain/reads';
import { useSession } from './session';

/**
 * Is the device key on this browser one the account can actually claim and check in with?
 *
 * A passkey syncs across a person's browsers and phones; the device key does not — it is a
 * non-extractable WebCrypto key bound to one browser's IndexedDB (`shared/deviceKey/web.ts`). So a
 * synced passkey signs a person in on a browser whose device key is missing (cleared site data, a
 * new browser), freshly minted, or restored-but-unusable, and the mismatch only surfaces later as
 * `BadDeviceSignature` at a claim or a door. This check moves that failure forward to right after
 * login, where the fix — recover on the phone (`/recover` → `recoverAccess`) — is one screen away.
 *
 *  - `unknown`        nothing asked yet, the chain could not be reached, or this is a native
 *                     device (see {@link checkDeviceKeyHealth}). Never blocks anyone.
 *  - `checking`       the question is in flight. Never blocks.
 *  - `healthy`        a local key exists, signs, and matches `Identity.activeDevice`.
 *  - `needs-recovery` no local key, an unusable one, or one the chain does not know. The only
 *                     state that redirects — and, when it is the local key itself that is missing
 *                     or unusable, always answerable without the chain at all.
 */
export type DeviceHealth = 'unknown' | 'checking' | 'healthy' | 'needs-recovery';

/** A fixed throwaway message, signed and verified locally only. Never a real digest, never sent. */
const PROBE_MESSAGE = `0x${'6d'.repeat(32)}` as Hex;

/** `Identity.activeDevice` answers all-zero for an account with no device on chain yet. */
function isZeroWord(hex: Hex): boolean {
  return /^0x0*$/.test(hex);
}

/**
 * The check itself, kept out of the store so it is unit-testable on its own. Cheap by contract:
 * one IndexedDB read, one throwaway sign, one RPC read — no more.
 */
export async function checkDeviceKeyHealth(account: Hex): Promise<DeviceHealth> {
  // Native is a different gap: a new phone has neither the secure-element key nor a synced passkey,
  // so login already routes it through recovery, and a throwaway sign on the secure element would
  // raise a biometric prompt at app-start. The browser is the gap this closes.
  if (deviceKeyCapability() !== 'software') return 'unknown';

  // (a) A local key exists. Peeked, never minted, so a cleared browser reads as "none" here rather
  //     than silently getting a fresh key that could never match the chain.
  let local;
  try {
    local = await peekDeviceKey({ alias: ATTENDEE_KEY_ALIAS });
  } catch {
    return 'needs-recovery'; // The store is unreachable — nothing usable can live here.
  }
  if (!local) return 'needs-recovery';

  // (b) It can actually sign. A restored pair exports its public half but throws on sign; the
  //     throwaway signature, verified against the local public key, is what catches that.
  try {
    const { r, s } = await signWithDeviceKey(PROBE_MESSAGE, { alias: ATTENDEE_KEY_ALIAS });
    if (!(await verifyDeviceSignature(local, joinRs(r, s), PROBE_MESSAGE))) return 'needs-recovery';
  } catch {
    return 'needs-recovery';
  }

  // (c) It is the key the chain will check. An unreachable chain is not a refusal — the claim and
  //     the gate still verify on the way in — so an RPC failure leaves this unknown, not blocked.
  let onChain;
  try {
    onChain = await readIdentity().activeDevice(account);
  } catch {
    return 'unknown';
  }
  // Zero means the account has no device on chain yet (pending / not active). That is the
  // registration guard's business, not recovery's, so it is not blocked here.
  if (isZeroWord(onChain.x) && isZeroWord(onChain.y)) return 'unknown';
  return onChain.x.toLowerCase() === local.x.toLowerCase() && onChain.y.toLowerCase() === local.y.toLowerCase()
    ? 'healthy'
    : 'needs-recovery';
}

let state: DeviceHealth = 'unknown';
/** The account the answer belongs to, and the record that the question was already asked. */
let asked: string | null = null;
const listeners = new Set<() => void>();

function set(next: DeviceHealth): void {
  state = next;
  for (const listener of listeners) listener();
}

export function getDeviceHealth(): DeviceHealth {
  return state;
}

/**
 * Asks once per signed-in account per page life. A rejection leaves `unknown` and is deliberately
 * not retried: the guard would otherwise ask on every render, and the worst outcome here is a
 * person let through who fails one claim rather than one wrongly sent to recovery.
 */
export function ensureDeviceHealthChecked(account: string): void {
  if (asked === account) return;
  asked = account;
  set('checking');
  void checkDeviceKeyHealth(account as Hex)
    .then((next) => {
      if (asked === account) set(next);
    })
    .catch(() => {
      if (asked === account) set('unknown');
    });
}

/**
 * Recovery just replaced the key and re-registered it — say so rather than run the check again,
 * and, crucially, do not leave a stale `needs-recovery` that would bounce the recovered person
 * straight back to `/recover` the moment they land on `/tickets`.
 */
export function markDeviceHealthy(): void {
  set('healthy');
}

/** Sign-out and tests. The next signed-in account is a different question. */
export function resetDeviceHealth(): void {
  asked = null;
  set('unknown');
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * The health of the signed-in account's device key. `enabled` gates the check on the one thing
 * that must be true first — the registration guard has confirmed this person finished signup — so
 * a `pending` account (whose `activeDevice` is zero) is left to finish signup rather than sent to
 * recovery.
 */
export function useDeviceHealth(enabled: boolean): DeviceHealth {
  const session = useSession();
  const account = session.status === 'signedIn' ? session.account : undefined;
  useEffect(() => {
    if (enabled && account) ensureDeviceHealthChecked(account);
  }, [enabled, account]);
  return useSyncExternalStore(subscribe, getDeviceHealth, getDeviceHealth);
}
