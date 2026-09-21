import { httpsCallable } from 'firebase/functions';
import type { FunctionsErrorCodeCore } from 'firebase/functions';
import type { Hex, SnapshotWire } from '@monti/shared';
import { getFirebaseFunctions } from './firebase';

/** The gRPC status the server chose, with Firebase's `functions/` prefix stripped. */
export type CallableErrorCode = FunctionsErrorCodeCore;

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

function toCallableError(error: unknown): CallableError {
  const raw = error as { code?: unknown; message?: unknown } | null;
  const code = typeof raw?.code === 'string' ? raw.code.replace(/^functions\//, '') : 'unknown';
  const message = typeof raw?.message === 'string' && raw.message.length > 0 ? raw.message : 'UNKNOWN';
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
  startSignup: call<void, { personId: string }>('startSignup'),
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
  registerPasskey: call<{ personId: string; attestation: unknown }, { ok: true }>('registerPasskey'),
  registerIdentity: call<{ personId: string; deviceX: Hex; deviceY: Hex }, { txHash: Hex }>('registerIdentity'),
  loginChallenge: call<void, { challenge: string; rpId: string }>('loginChallenge'),
  loginVerify: call<{ assertion: unknown }, { customToken: string }>('loginVerify'),
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
