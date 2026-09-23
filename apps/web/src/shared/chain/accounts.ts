import type { SmartAccount } from 'viem/account-abstraction';
import { getPasskeyAccount } from '../passkey';
import { getSmartAccount } from './bundler';

/**
 * The signed-in attendee's own passkey smart account. `getSmartAccount` memoises on the
 * passkey public key, so calling this repeatedly costs one derivation per credential and
 * a `clearCredential()` + re-login cannot resurrect the previous account.
 */
export async function getAttendeeAccount(): Promise<SmartAccount> {
  return getSmartAccount(await getPasskeyAccount());
}

/**
 * The signed-in staff member's own passkey smart account, used by sub-plan 04 for
 * requestOverride / manualOverride. It is NOT the gate device account, which 04 derives
 * from the gate hardware key under GATE_KEY_ALIAS and never signs with a passkey.
 */
export async function getStaffAccount(): Promise<SmartAccount> {
  return getAttendeeAccount();
}
