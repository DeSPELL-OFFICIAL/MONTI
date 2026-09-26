import type { Hex } from '@monti/shared';
import type { Copy } from '../../shared/copy/index';
import type { PhoneAuthProblem } from '../../shared/api/auth';
import { api } from '../../shared/api/functions';

/**
 * Signup spans several screens and a redirect or two, so the little that has to survive a
 * navigation lives in `sessionStorage`: it dies with the tab, which is exactly the lifetime of
 * an unfinished signup. Nothing secret goes in here — the verification id is useless without
 * the code, and the person id is a random 32 bytes that means nothing on its own.
 */
const KEY = 'monti.signup';

export interface SignupState {
  personId?: Hex;
  /**
   * The smart account `registerPasskey` predicted from the new passkey. It is the address
   * firestore.rules checks and the one `registerIdentity` puts on chain, so it is carried
   * from that answer rather than derived a second time on the client.
   */
  account?: Hex;
  /** Empty string means the platform verified instantly; absent means nothing started. */
  verificationId?: string;
  phoneE164?: string;
}

export function readSignup(): SignupState {
  try {
    return JSON.parse(sessionStorage.getItem(KEY) ?? '{}') as SignupState;
  } catch {
    return {};
  }
}

export function writeSignup(patch: SignupState): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ ...readSignup(), ...patch }));
  } catch {
    /* private mode */
  }
}

export function clearSignup(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* private mode */
  }
}

/**
 * The step both phone screens end at: the code was confirmed (or never needed, on Android), so
 * the Firebase session now carries the number and the backend can mint the person. No identity
 * check happens here — that is per event, and Task 18 opens it when an event asks for it.
 */
export async function finishSignup(): Promise<string> {
  const { personId } = await api.startSignup();
  writeSignup({ personId });
  return personId;
}

/**
 * A callable rejection is `{ code, message }` (see `CallableError`). It is matched structurally
 * rather than with `instanceof` so the branch still works when a caller's test mocks the whole
 * functions module.
 */
export function isAlreadyRegistered(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  return code === 'already-exists' || (typeof message === 'string' && message.includes('ALREADY_REGISTERED'));
}

/** The one place a phone-auth failure becomes a sentence. Both signup screens use it. */
export function problemMessage(copy: Copy, problem: PhoneAuthProblem): string {
  switch (problem) {
    case 'invalid-phone':
      return copy.signup.phoneInvalid;
    case 'not-enabled':
      return copy.signup.smsUnavailable;
    case 'too-many-requests':
      return copy.signup.tooManyRequests;
    case 'wrong-code':
      return copy.signup.codeWrong;
    case 'code-expired':
      return copy.signup.codeExpired;
    case 'network':
      return copy.common.offline;
    default:
      return copy.common.error;
  }
}
