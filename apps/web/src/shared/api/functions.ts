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
  // `alreadyLocked` is a success, not a failure: the chain was already locked, so nothing was
  // sent and there is no hash. A caller that read it as an error would show a locked attendee
  // a failure screen. See functions/src/functions/device.ts.
  lockDevice: call<void, { txHash?: Hex; alreadyLocked?: true }>('lockDevice'),
  // Proves the recovery right and answers when the chain will accept a device change. The
  // server never sends `setActiveDevice` — the contract reads `msg.sender`, so that write is
  // the new phone's own sponsored operation. Numbers are epoch seconds.
  //
  // `device.ts` also accepts `phone` (for the `sms` method) and a `deviceX`/`deviceY` pair it
  // records as `pendingChange`, and answers with that `pending` record. Nothing here sends
  // either, so neither is typed: the day a screen needs them it adds them back against
  // `DeviceChangeResult` rather than inheriting a shape nobody ever filled.
  startDeviceChange: call<
    { method: 'sms' | 'kyc' },
    { allowedAt: number; now: number; cooldownSeconds: number; allowed: boolean }
  >('startDeviceChange'),
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
  // Chain-verified on every call (a ticket for this event, the event published, not yet over)
  // and idempotent, so it is what a room is opened with. It writes the membership the security
  // rules check, which is why nothing in `eventChats/{eventId}` can be read before it answers.
  // Refusals worth their own sentence: `NO_TICKET_FOR_EVENT` (permission-denied),
  // `CHAT_CLOSED` / `EVENT_ENDED` / `EVENT_NOT_PUBLISHED` (failed-precondition).
  joinEventChat: call<{ eventId: string }, { ok: true }>('joinEventChat'),
  // A counter and nothing else — no reporter, no reason, no threshold that hides anything.
  // The answer is the message's new total, which is everybody's, not this person's.
  // See functions/src/functions/eventChat.ts.
  reportMessage: call<{ eventId: string; msgId: string }, { reported: number }>('reportMessage'),
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
  // The web never holds a pinning token. The organiser sends the cover picture and the two
  // readable fields; the server checks that this caller may create events for `orgId`, pins
  // the picture, then pins `{ name, description, image: "ipfs://<imageCid>" }` and answers
  // with both CIDs. `metadataCid` is what goes into `EventMeta.imageCid` — the document
  // `shared/envio/ipfs.ts` reads a title and a picture out of.
  // Refusals worth their own sentence: `permission-denied` (not this caller's organisation),
  // `invalid-argument` with `IMAGE_TOO_LARGE` or `BAD_MIME`.
  // See functions/src/functions/organizer.ts (sub-plan 02, task C5).
  pinEventMetadata: call<
    {
      orgId: string;
      image: { base64: string; mime: string };
      meta: { name: string; description: string };
    },
    { imageCid: string; metadataCid: string }
  >('pinEventMetadata'),
};
