import { FirebaseError } from 'firebase/app';
import { httpsCallable } from 'firebase/functions';
import type { FunctionsErrorCodeCore } from 'firebase/functions';
import type { AttendeeRow, Hex, PersonStatus, ResolveRecipientResult, SnapshotWire } from '@monti/shared';
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

/**
 * `getSignupStatus`'s own answer: every `persons/{id}.status` the backend writes, plus `none`
 * for a uid that has never called `startSignup` (functions/src/functions/getSignupStatus.ts).
 * `none` is not an error — it is the ordinary first screen.
 */
export type SignupStatus = PersonStatus | 'none';

/**
 * Why the last identity check did not raise the level, folded to four closed values by the
 * server (functions/src/lib/didit.ts `declineReason`). None of it is personal data and none of
 * it is the vendor's own wording: each code is a different thing for the person to do next.
 *  - `declined`              the documents or the face were refused (expired and abandoned too)
 *  - `duplicate_face`        the same face already has an account
 *  - `face_search_missing`   approved, but no duplicate-face result came back — NOT a duplicate
 *  - `face_search_not_clear` approved, with a duplicate-face result that was neither
 * All four leave `kycLevel` at 0.
 */
export type KycDeclineReason =
  | 'declined'
  | 'duplicate_face'
  | 'face_search_missing'
  | 'face_search_not_clear';

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
 * One terminal waiting on the organiser's approval. These four values are the whole of
 * `Organizers.registerGate(eventId, gateAccount, kx, ky)` plus the time the staff phone sent
 * it; `submittedAt` is epoch milliseconds.
 */
export interface PendingGate {
  gateAccount: Hex;
  kx: Hex;
  ky: Hex;
  submittedAt: number;
}

/** Same unwrapping as `pendingOffers`: the callable answers `{ gates }`. */
const callPendingGates = call<{ eventId: string }, { gates: PendingGate[] }>('listPendingGates');

/**
 * What `acceptInvite` hands the invited person. `to`/`data` are a `setAdmin` or `setManager`
 * call ready to send, and `requiredSender` is the only account the contract will accept it
 * from — the organisation's owner.
 */
export interface InviteCalldata {
  to: Hex;
  data: Hex;
  orgId: string;
  role: 'admin' | 'manager';
  requiredSender: Hex;
}

/**
 * One invitation as the team screen reads it (functions/src/functions/invites.ts `InviteRow`).
 * It carries no phone number, no permission bits and nobody's uid — the number is only ever an
 * HMAC index on the server, and the bits live on chain.
 *
 * `createdAt` and `expiresAt` are epoch **seconds**, and either is `0` for a row whose
 * `serverTimestamp()` had not settled when it was read — not a date in 1970, an unknown one.
 * `requiredSender` is present on an `accepted` row only: that is the one state where calldata
 * is waiting, and the value is `ownerOf` as it is *now*, not whatever the invitation stored.
 */
export interface InviteRow {
  inviteId: string;
  role: 'admin' | 'manager';
  /** The stored word, passed through: `sent`, `accepted` or `revoked`. */
  status: string;
  createdAt: number;
  expiresAt?: number;
  requiredSender?: Hex;
}

/** Same unwrapping as `pendingOffers`: the callable answers `{ invites }`. */
const callListInvites = call<{ orgId: string }, { invites: InviteRow[] }>('listInvites');

/**
 * One pinned notice (functions/src/functions/pinMessage.ts `PinnedMessage`). Neither the room
 * identity that wrote it nor its report count leaves the server. `createdAt` is epoch seconds.
 */
export interface PinnedMessage {
  messageId: string;
  text: string;
  createdAt: number;
}

/** Same unwrapping again: the callable answers `{ messages }`. */
const callListPinned = call<{ eventId: string }, { messages: PinnedMessage[] }>('listPinned');

/** Authoring a notice, or turning the pin of an existing message on and off. Never both. */
export type PinMessageArgs =
  | { eventId: string; text: string }
  | { eventId: string; messageId: string; pinned: boolean };

export const api = {
  startSignup: call<void, { personId: Hex }>('startSignup'),
  // Identity verification is per event, not part of signup. `startKyc` reuses the person's open
  // session when there is one and opens a fresh one otherwise. `callbackUrl` is optional and
  // must be one of our own origins — the server refuses anything else (`BAD_CALLBACK_URL`),
  // because it is where the vendor sends the person's browser back to.
  startKyc: call<{ callbackUrl?: string } | void, { kycUrl: string; sessionId: string }>('startKyc'),
  // Exactly what the deployed callable returns (`SignupStatusResult`): how far signup got,
  // whether a passkey and an account exist, the identity-check level, and the `personId` to
  // carry back into `registerPasskey`. There is no `reason` — the vendor's verdict never
  // leaves the server — and no `account` or `kycUrl`; a screen that wants the address reads
  // the session, and a fresh identity-check link comes from `startKyc`.
  getSignupStatus: call<
    void,
    {
      status: SignupStatus;
      hasPasskey: boolean;
      hasAccount: boolean;
      kycLevel?: 0 | 1;
      /** Absent once the check has passed, and absent for somebody who never tried. */
      kycReason?: KycDeclineReason;
      personId?: Hex;
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
  // The row type is the server's own (packages/shared), so a change there breaks this call
  // site rather than silently disagreeing with it. It carries no phone, no name and no photo.
  listAttendees: call<{ eventId: string }, AttendeeRow[]>('listAttendees'),
  // Sub-plan 04's staff gate-registration screen calls this instead of writing Firestore
  // directly. The server records the submitting uid and nothing else about the device — there
  // is no label, so nothing here invents one.
  submitPendingGate: call<{ eventId: string; gateAccount: Hex; kx: Hex; ky: Hex }, { ok: true }>(
    'submitPendingGate',
  ),
  /** The queue the organiser's gate screen approves from. Every field is an argument of
   *  `Organizers.registerGate`, plus the time it arrived; who submitted it never leaves the
   *  server (functions/src/functions/pendingGates.ts). */
  listPendingGates: async (args: { eventId: string }): Promise<PendingGate[]> =>
    (await callPendingGates(args)).gates,
  /**
   * Makes one organisation owned by the person calling, and answers with the number the chain
   * chose for it — `orgId` is a **decimal string** like `"42"`, never a name and never an
   * address (functions/src/functions/createOrganizer.ts).
   *
   * The server's attester sends it, not this person's own account: until sub-plan 01b puts the
   * organiser selectors on the paymaster's allowlist there is nothing to pay that write with,
   * and `Organizers.createOrganizer(address owner)` takes the owner as an argument, so the
   * organisation belongs to this caller either way. Nothing here asks the caller for a fee.
   *
   * Two facts a call site has to build around:
   *  - **It is not idempotent.** The contract hands out a fresh id on every call, so a retry
   *    makes a *second* organisation — nothing on either side deduplicates, and the only thing
   *    that ever stops it is the limit of three per person (`ORG_LIMIT`). The caller must lock
   *    its button for the whole call rather than let a second tap through.
   *  - **It waits for the receipt and for finality before it answers** — normally 2-5 seconds,
   *    occasionally past ten (`timeoutSeconds: 120`). Show that something is happening.
   *
   * The display name is not put on chain. The server writes it to `orgProfiles/{orgId}`, which
   * is where `loadOrgName` reads it back; a caller reads nothing of its own after this.
   *
   * Refusals worth their own sentence, by reason: `NO_SIGNUP` (not-found), `NOT_ACTIVE`
   * (failed-precondition), `ORG_LIMIT` (resource-exhausted), `BAD_NAME` (invalid-argument).
   * The last two statuses are both HTTP 400, so branch on the reason, never on the status.
   */
  createOrganizerForMe: call<{ name: string }, { orgId: string }>('createOrganizerForMe'),
  // `link` is the one an organiser sends to the person; it carries the invite id and nothing
  // else — no number, no organisation detail.
  createInvite: call<
    { orgId: string; role: 'admin' | 'manager'; phoneE164: string; permissionBits?: number; canApprove?: boolean },
    { inviteId: string; link: string }
  >('createInvite'),
  // The server does not put the role on chain: `setAdmin` is owner-only and `setManager` needs
  // `PERM_MANAGE_MANAGERS`, and the attester is neither. It hands back the calldata and says
  // who may send it — `requiredSender` is the organisation's owner as it is *now*, so a screen
  // shows that address rather than remembering whoever made the invite.
  acceptInvite: call<{ inviteId: string }, InviteCalldata>('acceptInvite'),
  // Owner-only, and idempotent: a second call answers `revoked` rather than refusing.
  revokeInvite: call<{ inviteId: string }, { status: 'revoked' }>('revokeInvite'),
  /** Every invitation of one organisation, newest first, for the owner or a holder of
   *  `PERM_MANAGE_MANAGERS` — anybody else is refused `NOT_ALLOWED_TO_INVITE`. This is the
   *  only way a team screen can show an invitation somebody else created
   *  (functions/src/functions/invites.ts). */
  listInvites: async (args: { orgId: string }): Promise<InviteRow[]> =>
    (await callListInvites(args)).invites,
  // Staff-only, consumed by sub-plan 04 through this same module.
  // The gate device account never authenticates; these go out on the staff member's Firebase
  // session and the server authorises them against organizers.isOpenGate(eventId, gateAccount).
  issueSnapshot: call<{ eventId: string; gateAccount: Hex }, SnapshotWire>('issueSnapshot'),
  getPhotoForGate: call<
    { tokenId: string; gateAccount: Hex },
    { photoJpegB64: string; displayName: string }
  >('getPhotoForGate'),
  /**
   * The organiser's notice. Exactly one of the two shapes, never both
   * (functions/src/functions/pinMessage.ts):
   *  - `{ eventId, text }` — the server writes the notice itself and pins it. This is the only
   *    way an organiser can leave one: they hold no ticket, so `joinEventChat` would refuse
   *    them their own room.
   *  - `{ eventId, messageId, pinned }` — turns the pin on or off for a message already there.
   *
   * The argument is `messageId`, never `msgId`, and the answer carries the id either way.
   */
  pinMessage: call<PinMessageArgs, { ok: true; messageId: string }>('pinMessage'),
  /** The notices already pinned for one event, newest first. Authorised exactly like
   *  `pinMessage` — an organiser holds no ticket for their own event, so this callable is the
   *  only read path they have to what they posted (functions/src/functions/pinMessage.ts). */
  listPinned: async (args: { eventId: string }): Promise<PinnedMessage[]> =>
    (await callListPinned(args)).messages,
  /**
   * One picture, pinned on its own and answered with its CID
   * (functions/src/functions/organizer.ts). The creation scene calls this the moment a poster
   * is cropped rather than at publish time, because a draft document stops at 1 MiB and a
   * 600 KB JPEG is 800 KB once it is base64 — the CID is what the draft can carry.
   *
   * `bytesBase64` is standard base64 with the `data:<mime>;base64,` prefix already off, and
   * there is no `mime` field: the server decides the format from the leading bytes and takes
   * **JPEG and PNG only** (WebP is refused, which the old `pinEventMetadata` accepted).
   * Caps are per kind — `poster` 600 KB, `ticket` 400 KB, either one at most 4000 px a side.
   *
   * Being an organiser is *not* required: a draft is written before an organisation exists.
   * Any signed-in `active` person may call it, at most 20 pictures a day.
   *
   * Refusals worth their own sentence, by reason: `IMAGE_TOO_LARGE`, `BAD_IMAGE_FORMAT`,
   * `BAD_IMAGE_DIMENSIONS` (all `invalid-argument`), `PIN_QUOTA` (`resource-exhausted`),
   * `NOT_ACTIVE` (`failed-precondition`), `PIN_FAILED` (`internal`, and retryable).
   */
  pinEventImage: call<{ bytesBase64: string; kind: 'poster' | 'ticket' }, { cid: string }>(
    'pinEventImage',
  ),
  /**
   * The readable half of an event, pinned as one JSON document whose CID is what
   * `EventMeta.imageCid` carries — the chain holds only hashes of the title, the description
   * and the venue, so this document is what every discover screen actually reads.
   *
   * **It no longer takes the picture.** `imageCid` is the CID `pinEventImage` already
   * answered with; there is no `image` field and no `imageCid` in the reply, only
   * `metadataCid` (task-ev-b report §3.2).
   *
   * Three fields decide what an attendee is allowed to see:
   *  - `tags` — at most five, each at most 12 code points, already trimmed and de-duplicated.
   *    The server runs the same rule and **refuses the whole request** (`BAD_TAGS`) rather
   *    than dropping a bad one, because IPFS cannot be re-pinned and `updateEventMeta` closes
   *    the moment the event is published.
   *  - `venueHidden` — when true the server leaves the `venue` key out of the document
   *    altogether. This side omits it as well, so the words never leave the browser.
   *  - `timeHidden` — a rendering flag only: the chain always carries the real `startsAt`,
   *    because the entry window is derived from it.
   *
   * `category` is a **number** — the chain's `uint8`. The server would coerce a numeric
   * string, but the attendee reader takes the pinned value only when it is already a number.
   * Empty optional fields are dropped rather than pinned blank.
   *
   * Refusals worth their own sentence, by reason: `NOT_ORGANIZER` (permission-denied),
   * `BAD_META` / `BAD_TAGS` / `BAD_IMAGE_CID` / `BAD_ORG_ID` (invalid-argument),
   * `PINATA_UPLOAD_FAILED` (unavailable, retryable).
   */
  pinEventMetadata: call<
    {
      orgId: string;
      meta: {
        name: string;
        description: string;
        imageCid: string;
        venue?: string;
        category?: number;
        region?: string;
        tags?: string[];
        venueHidden?: boolean;
        timeHidden?: boolean;
      };
    },
    { metadataCid: string }
  >('pinEventMetadata'),
  /**
   * The ticket pictures of one event, in tier-index order — the index **is** `Tier.idx`, so a
   * gap is not expressible and none is needed (functions/src/functions/eventArt.ts).
   *
   * Organiser-only, and it works **after the event is published**, which is the whole reason
   * the art lives in Firestore rather than in the pinned document: `Tier` has no column for a
   * picture and `updateEventMeta` refuses anything past Draft.
   *
   * Exactly one of `preset` and `imageCid` per entry — both, or neither, is `BAD_TIERS`. The
   * preset is one of the four letters and never a name: the read side folds anything else back
   * to `'a'`, so a name here would silently give every kind the same picture.
   *
   * It replaces the document rather than merging into it, so the whole list goes every time.
   * Reading is **not** a callable — `shared/api/firestore.ts` reads `eventArt/{eventId}`
   * directly, because one ticket list draws several events and a cold start would be a screen
   * full of blanks.
   */
  saveEventArt: call<
    { eventId: string; tiers: Array<{ preset: 'a' | 'b' | 'c' | 'd' } | { imageCid: string }> },
    { ok: true }
  >('saveEventArt'),
  /**
   * The private half of an event — the venue an attendee only sees once they hold a ticket
   * (functions/src/functions/eventPrivate.ts). Organiser-only, and allowed after publishing.
   *
   * **It does not merge.** This call is the whole of the private record, so leaving `venue`
   * out erases it; both fields go every time.
   */
  setEventPrivate: call<{ eventId: string; venue?: string; note?: string }, { ok: true }>(
    'setEventPrivate',
  ),
  /**
   * The person asks for their account to be destroyed (functions/src/functions/accountDeletion.ts).
   * Idempotent: a second call answers with the date the first one set rather than pushing it back.
   *
   * Two facts the screen must say out loud, because both are true the moment this resolves:
   *  - signing in stops **now** — the server disables the account and revokes its refresh tokens,
   *    so the grace period is time to change one's mind, not time to keep using the app;
   *  - `onChainRetained` is always `true`: the public record of the tickets stays, because
   *    `personId` is a random number and the addresses carry nothing personal.
   * `scheduledFor` is epoch **seconds** — the day the personal details are actually erased.
   */
  requestAccountDeletion: call<void, { scheduledFor: number; onChainRetained: true }>(
    'requestAccountDeletion',
  ),
};
