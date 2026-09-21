import { FirebaseError } from 'firebase/app';
import { httpsCallable } from 'firebase/functions';
import type { FunctionsErrorCodeCore } from 'firebase/functions';
import type { Hex, SnapshotWire } from '@monti/shared';
import { getFirebaseFunctions } from './firebase';

/** The gRPC status the server chose, with Firebase's `functions/` prefix stripped. */
export type CallableErrorCode = FunctionsErrorCodeCore;

/**
 * The complete set of statuses an `HttpsError` can carry. A code outside it is not a server
 * answer at all, so it is never cast into the union — the caller's `switch` stays honest.
 */
const CALLABLE_ERROR_CODES: ReadonlySet<string> = new Set<CallableErrorCode>([
  'ok', 'cancelled', 'unknown', 'invalid-argument', 'deadline-exceeded', 'not-found',
  'already-exists', 'permission-denied', 'resource-exhausted', 'failed-precondition',
  'aborted', 'out-of-range', 'unimplemented', 'internal', 'unavailable', 'data-loss',
  'unauthenticated',
]);

const FUNCTIONS_CODE_PREFIX = 'functions/';

/** What a caller gets when the rejection did not come from a callable at all. */
const OPAQUE_FAILURE = { code: 'internal', message: 'UNKNOWN' } as const;

/**
 * Every rejection out of `api.*` is one of these, so a caller branches on `code` (the status)
 * and `message` (the server's short uppercase reason, e.g. `BAD_CHALLENGE`) instead of
 * inspecting `unknown`. Neither field is copy — the view picks the sentence from them.
 */
export class CallableError extends Error {
  readonly code: CallableErrorCode;

  constructor(code: CallableErrorCode, message: string) {
    super(message);
    this.name = 'CallableError';
    this.code = code;
  }
}

/**
 * Only a `FirebaseError` carrying a real `functions/<status>` code is a server answer, and only
 * then is `message` the server's reason code. Anything else — a dropped connection, a bug in
 * this file — becomes `internal`/`UNKNOWN`: a raw `Failed to fetch` must never reach a caller
 * that is told `message` is a reason code it can branch on.
 */
function toCallableError(error: unknown): CallableError {
  if (!(error instanceof FirebaseError) || !error.code.startsWith(FUNCTIONS_CODE_PREFIX)) {
    return new CallableError(OPAQUE_FAILURE.code, OPAQUE_FAILURE.message);
  }
  const code = error.code.slice(FUNCTIONS_CODE_PREFIX.length);
  if (!CALLABLE_ERROR_CODES.has(code)) {
    return new CallableError(OPAQUE_FAILURE.code, OPAQUE_FAILURE.message);
  }
  const message = error.message.length > 0 ? error.message : OPAQUE_FAILURE.message;
  return new CallableError(code as CallableErrorCode, message);
}

function call<Req, Res>(name: string): (payload?: Req) => Promise<Res> {
  return async (payload?: Req) => {
    const fn = httpsCallable<Req | Record<string, never>, Res>(getFirebaseFunctions(), name);
    try {
      // onCall v2 rejects a null body, so the no-argument callables send `{}`.
      const result = await fn((payload ?? {}) as Req);
      return result.data;
    } catch (error) {
      throw toCallableError(error);
    }
  };
}

export type SignupStatus = 'pending' | 'kyc_ok' | 'rejected' | 'active' | 'rotated';

export const api = {
  startSignup: call<void, { personId: Hex }>('startSignup'),
  // Identity verification is per event, not part of signup. startKyc opens a fresh Didit session.
  startKyc: call<void, { kycUrl: string; sessionId: string }>('startKyc'),
  getSignupStatus: call<
    void,
    {
      status: SignupStatus;
      kycLevel: number;
      reason?: 'duplicate_face' | 'document_failed' | 'liveness_failed';
      account?: Hex;
      kycUrl?: string;
    }
  >('getSignupStatus'),
  registerPasskey: call<
    { personId: Hex; attestation: unknown },
    { ok: true; account: Hex; credentialId: string }
  >('registerPasskey'),
  registerIdentity: call<{ personId: Hex; deviceX: Hex; deviceY: Hex }, { txHash: Hex }>('registerIdentity'),
  // One challenge endpoint serves both ceremonies; the server pins the purpose into the
  // challenge document and refuses a login challenge used to register, and the reverse.
  // `rpId` is not returned — the web app already has it from getConfig().
  loginChallenge: call<
    { purpose?: 'register' | 'login' },
    { challenge: string; expiresAt: number }
  >('loginChallenge'),
  // `token` goes to signInWithCustomToken; its claims are exactly { personId, account },
  // which is where the session store reads the signed-in identity from.
  loginVerify: call<{ assertion: unknown }, { token: string; personId: Hex; account: Hex }>('loginVerify'),
  lockDevice: call<void, { txHash: Hex }>('lockDevice'),
  startDeviceChange: call<{ method: 'sms' | 'kyc' }, { allowedAt: number; kycUrl?: string }>('startDeviceChange'),
  resolveRecipient: call<
    { type: 'phone' | 'nickname' | 'address'; value: string },
    { member: boolean; account?: Hex; nickname?: string; commitment?: Hex }
  >('resolveRecipient'),
  createTransferInvite: call<
    { tokenId: string; phoneE164: string },
    { inviteId: string; commitment: Hex; expiresAt: number; smsText: string; smsUri: string }
  >('createTransferInvite'),
  pendingOffers: call<void, Array<{ tokenId: string; attesterSig: Hex }>>('pendingOffers'),
  joinEventChat: call<{ eventId: string }, { ok: true }>('joinEventChat'),
  reportMessage: call<{ eventId: string; msgId: string }, { ok: true }>('reportMessage'),
  listAttendees: call<
    { eventId: string },
    Array<{ tokenId: string; nickname: string; tier: number; checkedIn: boolean; kycLevel: number }>
  >('listAttendees'),
  // Sub-plan 04's staff gate-registration screen calls this instead of writing Firestore directly.
  submitPendingGate: call<
    { eventId: string; gateAccount: Hex; kx: Hex; ky: Hex; deviceLabel: string },
    { ok: true }
  >('submitPendingGate'),
  listPendingGates: call<
    { eventId: string },
    { gates: Array<{ gateAccount: Hex; kx: Hex; ky: Hex; label: string; createdAt: number }> }
  >('listPendingGates'),
  createInvite: call<
    { orgId: string; role: 'admin' | 'manager'; phoneE164: string; permissionBits?: number; canApprove?: boolean },
    { inviteId: string }
  >('createInvite'),
  acceptInvite: call<{ inviteId: string }, { orgId: string; role: 'admin' | 'manager'; to: Hex; data: Hex }>('acceptInvite'),
  // Staff-only, consumed by sub-plan 04 through this same module.
  // The gate device account never authenticates; these go out on the staff member's Firebase
  // session and the server authorises them against organizers.isOpenGate(eventId, gateAccount).
  issueSnapshot: call<{ eventId: string; gateAccount: Hex }, SnapshotWire>('issueSnapshot'),
  getPhotoForGate: call<
    { tokenId: string; gateAccount: Hex },
    { photoJpegB64: string; displayName: string }
  >('getPhotoForGate'),
  // Defined by this sub-plan, see the Interfaces block.
  pinMessage: call<{ eventId: string; msgId: string; pinned: boolean }, { ok: true }>('pinMessage'),
  requestAccountDeletion: call<{ reason?: string }, { ok: true; scheduledFor: number }>('requestAccountDeletion'),
};
