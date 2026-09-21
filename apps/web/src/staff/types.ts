// The staff console's state vocabulary: the words every screen from the gate to the queue
// reads its meaning from. Nothing here is a second spelling of something that already exists.
//
// The wire formats (`GateCodeWire`, `GateResponseWire`, `SnapshotTicket`) belong to
// `@monti/shared`, which the attendee phone, the indexer and the contracts also read; they are
// re-exported rather than restated so a field added there cannot be missed here. The names in
// `CHECK_IN_ERRORS` belong to `Ticket.sol` and are *read off* its exported ABI rather than typed
// out, so an error the contracts add cannot arrive here as a surprise. What this module *owns*
// is the vocabularies that exist only on the staff device: the DENY codes a refusal is shown as,
// the states a gate moves through, and the marks the offline queue writes on a row of its own.
import { ticketAbi } from '@monti/shared';
import type {
  GateCodeWire,
  GateDenyCode,
  GateResponseWire,
  Hex,
  OverrideReasonCode,
  SnapshotTicket,
} from '@monti/shared';

export type { GateCodeWire, GateResponseWire, Hex, SnapshotTicket };

/**
 * Spec §13's refusal rows — **re-exported, not restated**.
 *
 * The list lives in `@monti/shared` because both apps read it: the staff phone picks the screen
 * and the attendee phone is shown its sentence, and a code that exists on only one side is an
 * empty screen on the other. `UNKNOWN_REVERT` is the one that is not a contract error at all —
 * a revert whose selector this build has never seen, which means the contracts moved ahead of
 * the app. Still a refusal (a gate that cannot read the reason cannot admit on it), and still a
 * different thing from `TX_FAILED`, which is a send that produced no reason to begin with.
 *
 * `TIMEOUT` is deliberately absent: an operation that has not answered yet has not refused.
 */
export { GATE_DENY_CODES as DENY_CODES, isGateDenyCode } from '@monti/shared';

/** The staff spelling of `@monti/shared`'s `GateDenyCode`. One list, two names for it. */
export type DenyCode = GateDenyCode;

/**
 * Every custom error `Ticket.json` declares, read **off the generated ABI**.
 *
 * This used to be a hand-typed list of twelve names, and Task 34's cross-branch diff found what
 * that costs: `manualOverride` reverts `NotMember`, the list had never heard of it, and an
 * unmatched selector falls through to `TX_FAILED` — so the door showed "전송 실패" for a
 * terminal that simply is not on the organizer's team, and no test could notice. The 01b
 * redeploy adds more errors on the same surface, which would have arrived the same silent way.
 *
 * So the direction is inverted: a name the contracts add is **in** by default, and the way out
 * is the explicit list below.
 */
const TICKET_ERROR_NAMES: readonly string[] = ticketAbi.flatMap((entry) =>
  entry.type === 'error' ? [entry.name] : [],
);

/**
 * The errors no gate operation can raise, named one by one — the one thing the ABI cannot say,
 * because it records which errors a contract declares and not which function raises them.
 *
 * The three families are the whole of it. The inherited ones (`ERC721*`, `ECDSA*`) belong to the
 * token and the signature library. The sale and admin ones belong to `mint`, `publish` and the
 * tier editor — an organizer's console, not a door. The transfer, offer and migrate ones belong
 * to the attendee's phone. What is left is what `checkIn`, `checkInLate` and `manualOverride`
 * can raise, which are the only three calls this app ever sends.
 *
 * `NotMember` is the borderline one and it stays **in**. No gate call raises it today (`mint`,
 * `migrate` and the transfer hook do), but it is an error about *who is calling*, and the gate
 * is a caller whose registration can be wrong — which is the exact shape of the bug Task 34
 * found. A row in a table costs nothing; a missing screen at a door costs a paying customer.
 *
 * A name here that the ABI no longer declares is a red test next to this file: it means the
 * exclusion is now excluding nothing, and something else may have quietly taken its place.
 */
export const NON_GATE_ERRORS = [
  'ApprovalRequiredNotSupported',
  'BadAttesterSig',
  'ECDSAInvalidSignature',
  'ECDSAInvalidSignatureLength',
  'ECDSAInvalidSignatureS',
  'ERC721IncorrectOwner',
  'ERC721InsufficientApproval',
  'ERC721InvalidApprover',
  'ERC721InvalidOperator',
  'ERC721InvalidOwner',
  'ERC721InvalidReceiver',
  'ERC721InvalidSender',
  'ERC721NonexistentToken',
  'EventAlreadyClosed',
  'InvalidSchedule',
  'InvalidTiers',
  'KycRequired',
  'MaxPerWalletExceeded',
  'NoOffer',
  'NotDraft',
  'NotRotatedAccount',
  'NothingToMigrate',
  'OfferExpired',
  'PaidTiersNotEnabled',
  'SaleClosed',
  'SoldOut',
  'TransferCutoffPassed',
  'TransferLimitReached',
  'TransfersDisabled',
  'UnknownEvent',
  'UnknownTier',
] as const;

/**
 * The errors a tap can come back with, derived: the ABI's, minus {@link NON_GATE_ERRORS}.
 *
 * `EventNotPublished` survives the subtraction although `checkIn` cannot raise it today (only
 * `mint` does). That is deliberate and predates the derivation: a gate opened against a draft
 * event is a configuration mistake the staff have to be able to read, and Task 22 gives it its
 * own sentence rather than the bare label.
 */
export const CHECK_IN_ERRORS: readonly string[] = TICKET_ERROR_NAMES.filter(
  (name) => !new Set<string>(NON_GATE_ERRORS).has(name),
);

/**
 * One of {@link CHECK_IN_ERRORS}. It is `string` and not a literal union because the list is now
 * the ABI's and `ticketAbi` is typed as viem's `Abi` — the names are not literals at compile
 * time. What that costs is the `Record<CheckInError, DenyCode>` exhaustiveness the hand-written
 * list used to buy, and `denyMap.test.ts` buys it back as an assertion: every name in this list
 * has a screen, or the test is red.
 */
export type CheckInError = string;

/**
 * The gate screen's states. `admit` and `offlineAdmit` are separate on purpose: the second is a
 * ticket the chain has not yet accepted, and a screen that cannot tell the two apart is a
 * screen that lets a staff member believe a queued entry is settled.
 *
 * There is no "soft admit" — nothing between `confirming` and a verdict. Spec §7.2.
 */
export const GATE_STATES = [
  'idle',
  'ready',
  'received',
  'confirming',
  'admit',
  'offlineAdmit',
  'deny',
  'override',
] as const;

export type GateState = (typeof GATE_STATES)[number];

/**
 * The answer the signed snapshot alone can give, before any chain call.
 *
 * A union rather than one shape with optional fields, so the two arms cannot be confused: a
 * refusal **always** carries the `deny` that says why — the compiler will not let one through
 * without it — and a pass carries no `deny` at all. `ok: true` with no `ticket` is the third
 * answer: the snapshot did not recognise the token, which online means "send it, the chain
 * decides" and offline means a refusal. `isUnknownToSnapshot` (Task 20) names that branch.
 */
export type PreflightResult =
  | { ok: true; deny?: undefined; ticket?: SnapshotTicket }
  | { ok: false; deny: DenyCode; ticket?: SnapshotTicket };

/**
 * The same answer as {@link PreflightResult}, flattened to the three things the screen draws.
 *
 * It lives here rather than in the card that reads it because two modules now speak it — the
 * card and the wiring that derives it from a `GateContext` — and a vocabulary owned by one of
 * its two speakers is a vocabulary that drifts. `'unknown'` is the one that must not be
 * collapsed into either neighbour: the guest list did not recognise the token, which online
 * means "send it, the chain decides" and offline means a refusal. It is not a verdict.
 */
export type PrecheckResult = 'ok' | 'unknown' | 'fail';

/**
 * One check-in waiting to reach the chain. It is a record of a person who already walked in,
 * so it is durable (IndexedDB, Task 28) and is never dropped on a failure the gate cannot
 * explain: `status` distinguishes "not sent yet" from "the chain refused it", and `conflict`
 * from both, because a `ALREADY_USED` on a resend is a reconciliation note rather than an error.
 */
export interface QueueEntry {
  id: string;
  tokenId: string;
  gateCode: GateCodeWire;
  response: GateResponseWire;
  createdAt: number;
  attempts: number;
  nextAttemptAt: number;
  status: 'pending' | 'sent' | 'confirmed' | 'conflict' | 'failed';
  lastError?: string;
  userOpHash?: Hex;
}

// The three `QueueEntry.lastError` values the queue writes itself, as opposed to the message of
// whatever was thrown. `queue/opQueue.ts` writes them and the two queue screens read them;
// neither owns them, so they live here, next to the row they are written on.
//
// The move is not tidiness. `components/QueueBanner.tsx` imported them from `queue/opQueue.ts`
// and pulled IndexedDB, viem and the generated ABI into a barrel of pure cards for the sake of
// three string literals.
//
// What the three have in common is the reason they are worth a sentence at all: none of them
// clears by waiting. Everything else in `lastError` is a send that failed and will be retried,
// and a banner that calls a person over for something about to fix itself is a banner that gets
// ignored the next time it matters.

/** The drain declined to send: this build's ABI has no `checkInLate` (before the 01b redeploy). */
export const DRY_RUN_MARK = 'CHECK_IN_LATE_UNAVAILABLE';
/** Parked: the event's deadline (`endsAt` + 12 h) passed, so the chain would refuse it for good. */
export const LATE_WINDOW_ELAPSED = 'LATE_WINDOW_ELAPSED';
/**
 * Parked: Task 29 re-armed this row its limit of times and the chain still has no record of it.
 * Deliberately **not** a {@link DenyCode} — nothing on chain refused this. The operation simply
 * never arrived, and only a person can take it from here.
 */
export const RESEND_EXHAUSTED = 'RESEND_EXHAUSTED';

export type QueueMark = typeof DRY_RUN_MARK | typeof LATE_WINDOW_ELAPSED | typeof RESEND_EXHAUSTED;

/**
 * The four reasons spec §7.5 recognises for letting somebody in by hand.
 *
 * The numbers are `@monti/shared`'s, because they are what `Ticket.requestOverride` and
 * `Ticket.manualOverride` record on chain as `uint8 reason` — not a screen's enum. They used to
 * be spelled out here as `1 | 2 | 3 | 4`, which was the same four values written down twice:
 * the contracts' copy and the console's, with nothing to notice if 01b ever added a fifth.
 */
export type OverrideReason = OverrideReasonCode;

/** The two calls. `denied` is not one of them — it is what happens instead of sending. */
export type OverrideCall = 'manualOverride' | 'requestOverride';
export type OverrideRoute = OverrideCall | 'denied';

/**
 * The role tag `Ticket.ManualOverride` carries, named (`Ticket.sol:80-82`). `'none'` is what a
 * filed request has: `OverrideRequested` records a requester and no role, because a request is
 * precisely the case where nobody has approved anything yet.
 */
export type OverrideRole = 'approver' | 'manager' | 'none';

/**
 * How one manual approval went, in the shape the console draws it.
 *
 * It lives in the context rather than on the screen because it is the **only** record of an
 * event the gate cannot otherwise show: `manualOverride` emits `CheckedIn` with a zero
 * `nonceHash`, so the chain watch — which matches a tap by its nonce — will never see it, and
 * `requestOverride` emits no check-in at all. If this object is not kept, a staff member who
 * filed a request has no way to tell whether it went out.
 *
 * `reason` is present from the first moment because the staff member chose it before anything
 * was sent; `route`, `role` and `approver` arrive with the chain's answer about who they are,
 * and they are exactly the three fields the on-chain event will carry.
 */
export interface OverrideOutcome {
  status: 'sending' | 'requested' | 'approved' | 'failed';
  reason: OverrideReason;
  /**
   * Who it is about. Present from the moment the operation goes out, and load-bearing on the
   * request path: it is the key the `ManualOverride` watch filters on, so a filed request can
   * turn into 승인됨 when somebody with the right acts on it.
   */
  tokenId?: string;
  /** The name on the ticket, so 직전 탭 can still say who was let in after the dialog closes. */
  displayName?: string;
  route?: OverrideCall;
  role?: OverrideRole;
  /** The account the chain will record as approver — the staff member's own, never the gate's. */
  approver?: Hex;
  /** One sentence for a failure or a refusal, already chosen. Never a raw error. */
  detail?: string;
}

/**
 * Everything the gate screen renders from, in one object. `finalized`, `pendingCount`,
 * `snapshotAgeMs` and `online` are here rather than in a separate status bar model because a
 * staff member reads them together with the verdict — "admitted, but nothing has reached the
 * chain in ten minutes" is one fact, not two.
 */
export interface GateContext {
  state: GateState;
  gateId: bigint;
  eventId: bigint;
  orgId: bigint;
  deny?: DenyCode;
  denyDetail?: string;
  ticket?: SnapshotTicket;
  blockNumber?: bigint;
  finalized: boolean;
  /**
   * Spec §7.3's two thresholds while an operation is in flight, and neither of them is a state:
   * the gate is `confirming` throughout, because the operation is still alive throughout.
   *
   * `checking` goes up at 2 s — before that a tap usually resolves and a label would only
   * flicker. `waitHint` goes up at 5 s, and it was called `retapHint` until the Task 24 review:
   * it used to say "다시 대세요", the machine had just started refusing a second tap while
   * the first is confirming, and the screen was therefore asking for something the gate would
   * turn down. Worse, whoever obeyed it sent the same ticket twice. It now says
   * "확인 중입니다 · 잠시만 기다려 주세요", which is the truth: the chain has not answered yet
   * and a `CheckedIn` arriving at six seconds still turns this tap green. Nothing here ever
   * becomes an admit on its own.
   */
  checking: boolean;
  waitHint: boolean;
  pendingCount: number;
  snapshotAgeMs: number;
  online: boolean;
  /**
   * The manual approval on screen, while `state` is `'override'`. Cleared on the way back to
   * waiting like every other settled fact — and kept in `lastSettled()` on the way out, because
   * "누가 손으로 들여보냈는가" is exactly the thing a shift should still be able to read later.
   */
  override?: OverrideOutcome;
}
