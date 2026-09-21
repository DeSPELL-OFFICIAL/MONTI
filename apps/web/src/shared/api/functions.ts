import { FirebaseError } from 'firebase/app';
import { httpsCallable } from 'firebase/functions';
import type { FunctionsErrorCodeCore } from 'firebase/functions';
import type { Hex, ResolveRecipientResult, SnapshotWire } from '@monti/shared';
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

/**
 * The two fields a caller branches on, read structurally rather than with `instanceof` so the
 * branch still works when a screen's test mocks this whole module. A rejection from somewhere
 * else — a dismissed authenticator prompt, a bug in a screen — yields empty strings and falls
 * through every reason branch to the caller's default sentence.
 */
export function callableFailure(error: unknown): { code: string; reason: string } {
  if (typeof error !== 'object' || error === null) return { code: '', reason: '' };
  const { code, message } = error as { code?: unknown; message?: unknown };
  return {
    code: typeof code === 'string' ? code : '',
    reason: typeof message === 'string' ? message : '',
  };
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

/**
 * What `createTransferInvite` answers with, field for field
 * (functions/src/functions/transferInvites.ts). The server wrote the sentence and built the
 * `sms:` link from the number the sender just typed; neither is rewritten on this side, and
 * neither is stored anywhere — the number lives in this answer and nowhere else.
 */
export interface TransferInviteResult {
  inviteId: string;
  commitment: Hex;
  expiresAt: number;
  smsText: string;
  smsUri: string;
}

/**
 * One invite waiting for the signed-in attendee. `attesterSig` is what `Ticket.acceptOffer`
 * takes; the server binds it to this caller's account, so another account picking it up
 * cannot spend it. `inviteId` is opaque — it is carried back, never read.
 */
export interface PendingOffer {
  tokenId: string;
  attesterSig: Hex;
  inviteId: string;
}

/** The callable answers `{ offers }`; every caller wants the rows, so the wrapper unwraps. */
const callPendingOffers = call<void, { offers: PendingOffer[] }>('pendingOffers');

/**
 * One staff device asking to be registered as a gate, field for field
 * (functions/src/functions/pendingGates.ts). These four are the whole of it: the server
 * validates exactly them, stores exactly them, and hands exactly them back to the organizer
 * as the arguments of `Organizers.registerGate(eventId, gateAccount, kx, ky)`.
 *
 * There is deliberately no device label. The callable reads `request.data.eventId`,
 * `gateAccount`, `kx` and `ky` and nothing else, so a label would be typed as sent, shown on
 * the setup screen's fallback, and silently dropped — a field the staff device only thinks
 * the organizer can see.
 */
export interface PendingGateSubmission {
  /** Decimal, as the server normalises it: `BigInt(value).toString()`. */
  eventId: string;
  gateAccount: Hex;
  kx: Hex;
  ky: Hex;
}

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
  // `alreadyRegistered` is a success, not a failure: the chain already knew this account, so
  // nothing was sent and there is no hash. Treating it as an error would show a signed-up
  // attendee a failure screen. See functions/src/functions/registerIdentity.ts.
  registerIdentity: call<
    { personId: Hex; deviceX: Hex; deviceY: Hex; platform: 'ios' | 'android' | 'web' },
    { txHash?: Hex; alreadyRegistered?: true }
  >('registerIdentity'),
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
  // The result type is the server's own (packages/shared), so a change there breaks this
  // call site rather than silently disagreeing with it.
  resolveRecipient: call<
    { type: 'phone' | 'nickname' | 'address'; value: string },
    ResolveRecipientResult
  >('resolveRecipient'),
  createTransferInvite: call<{ tokenId: string; phoneE164: string }, TransferInviteResult>(
    'createTransferInvite',
  ),
  pendingOffers: async (): Promise<PendingOffer[]> => (await callPendingOffers()).offers,
  joinEventChat: call<{ eventId: string }, { ok: true }>('joinEventChat'),
  reportMessage: call<{ eventId: string; msgId: string }, { ok: true }>('reportMessage'),
  listAttendees: call<
    { eventId: string },
    Array<{ tokenId: string; nickname: string; tier: number; checkedIn: boolean; kycLevel: number }>
  >('listAttendees'),
  // Sub-plan 04's staff gate-registration screen calls this instead of writing Firestore directly.
  submitPendingGate: call<PendingGateSubmission, { ok: true }>('submitPendingGate'),
  // The row is the server's `PendingGateRow` (functions/src/functions/pendingGates.ts): the
  // three `registerGate` arguments plus the time it arrived. There is no label — the device
  // never sends one — and the timestamp is `submittedAt`, not `createdAt`.
  listPendingGates: call<
    { eventId: string },
    { gates: Array<{ gateAccount: Hex; kx: Hex; ky: Hex; submittedAt: number }> }
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

/**
 * The staff setup screen's one call, named rather than reached through `api`, so the screen
 * and its tests depend on this single callable instead of the whole surface. It is the same
 * wrapper, not a second one.
 */
export const submitPendingGate = api.submitPendingGate;
