import {
  addDoc, collection, deleteDoc, doc, getDoc, getDocs, limit, onSnapshot, orderBy, query,
  serverTimestamp, setDoc,
} from 'firebase/firestore';
import type { Hex } from '@monti/shared';
import type { RelayActionResult } from './functions';
import type { TicketArtPreset, TicketArtSource } from '../ui/TicketArt';
import { getDb, getFirebaseAuth } from './firebase';

/**
 * The four places the client is allowed to write to Firestore (firestore.rules): its own
 * `users/{uid}` profile fields, `devices/{account}.pushToken`, event chat, and its own event
 * drafts under `eventDrafts/{uid}/drafts` — the fourth, and the only one it may also delete,
 * because a draft is written every two seconds and a callable per keystroke costs both money
 * and latency.
 * It also reads server-written collections it may never write, each open to the readers the rules
 * allow and written by the server alone: `orgProfiles/{orgId}` (organiser display names the chain
 * has no room for), `eventArt/{eventId}` (the ticket pictures `Tier` has no column for),
 * `settlements/{eventId}` (the split policy, its hash and the per-tier USD price), `orders/{orderId}`
 * (one buyer's escrow, owner-readable) and `relays/{relayId}` (a relayed write's progress).
 * Everything else goes through a callable in ./functions.
 */

/**
 * `relays/{relayId}` — one relayed submission's lifecycle (design §5, backend task C3). The rules
 * open it to the submitting person alone, so this is the attendee's read path for a claim the MONTI
 * relayer is sending. Statuses: `pending`/`sent` (still going), `confirmed` (landed), `failed`
 * (with `error.code`). `tokenId` is filled on a confirmed claim.
 */
export type RelayStatus = 'pending' | 'sent' | 'confirmed' | 'failed';

export interface RelayView {
  status: RelayStatus;
  txHash?: string;
  tokenId?: string;
  /**
   * A settled relayed action's per-`kind` payload (design §1, Phase 2) — the same shape the
   * `relayAction` callable returns on a `confirmed` answer, written to the doc when the tx mines.
   * Absent for a claim (which uses `tokenId`) and for a still-pending action.
   */
  result?: RelayActionResult;
  error?: { code: string; message: string };
}

/** The collection name the backend writes (relayTypes.ts `RELAYS`), kept in step by hand. */
const RELAYS_COLLECTION = 'relays';

/**
 * Live-follows one relay doc. `null` is handed on for a doc that is not there (or not yet) so the
 * caller keeps waiting rather than reading a missing status as a failure. A read that the rules
 * refuse or a dropped listener goes to `onError`; the caller's 45s cap and 다시 시도 are the way out.
 */
export function watchRelay(
  relayId: string,
  onChange: (relay: RelayView | null) => void,
  onError?: (error: unknown) => void,
): () => void {
  return onSnapshot(
    doc(getDb(), RELAYS_COLLECTION, relayId),
    (snapshot) => {
      const data = snapshot.data() as Partial<RelayView> | undefined;
      onChange(
        data && typeof data.status === 'string'
          ? { status: data.status, txHash: data.txHash, tokenId: data.tokenId, result: data.result, error: data.error }
          : null,
      );
    },
    (error) => onError?.(error),
  );
}

export interface ChatMessage {
  id: string; uid: string; text: string; createdAt: number; reported: number;
  /** Server-only: set by the pinMessage callable, absent on freshly created messages. */
  pinned?: boolean;
}

/** What `closeEndedChats` writes on `eventChats/{eventId}`, and all the client reads there. */
export interface ChatRoomState {
  closed: boolean;
  /** Epoch seconds, copied off the chain by `joinEventChat`. */
  endsAt: number;
}

/** One row of `eventChats/{eventId}/members`, keyed by the member's Firebase uid. */
export interface ChatMember {
  uid: string;
  account: string;
}

/** Message limits the rules enforce server-side; checked here so a doomed write never leaves. */
export const CHAT_MESSAGE_MAX_LENGTH = 500;
const CHAT_PAGE_SIZE = 200;

/**
 * `createdAt` is written with serverTimestamp(), so a snapshot carries a Timestamp — and, for
 * the writer's own pending message, null until the server stamps it. Views are typed on
 * milliseconds and get milliseconds; 0 means "not stamped yet", which {@link sortByCreatedAt}
 * reads as the newest message there is.
 */
function toMillis(value: unknown): number {
  if (typeof value === 'number') return value;
  const timestamp = value as { toMillis?: () => number } | null;
  return typeof timestamp?.toMillis === 'function' ? timestamp.toMillis() : 0;
}

/**
 * Oldest first, with an unstamped message last. Firestore orders a pending serverTimestamp as
 * the smallest value there is, so under `orderBy('createdAt', 'desc')` the sender's own message
 * comes back at the end of the page — and reversing that page would throw it to the very top of
 * the room, above messages sent hours ago. It belongs at the bottom, where they just typed it.
 */
function sortByCreatedAt(messages: ChatMessage[]): ChatMessage[] {
  const rank = (message: ChatMessage): number =>
    message.createdAt === 0 ? Number.MAX_SAFE_INTEGER : message.createdAt;
  return [...messages].sort((left, right) => rank(left) - rank(right));
}

/**
 * `onError` is not optional in practice: the rules open `messages` to members only, so an
 * attendee who has not joined yet gets `permission-denied` on the very first snapshot. Firestore
 * detaches the listener when that happens, so this is a terminal answer, not a retryable one —
 * the screen turns it into the join error rather than letting it surface as an uncaught error.
 */
export function watchChatMessages(
  eventId: string,
  onChange: (messages: ChatMessage[]) => void,
  onError?: (error: unknown) => void,
): () => void {
  const messages = query(
    collection(getDb(), 'eventChats', eventId, 'messages'),
    orderBy('createdAt', 'desc'),
    limit(CHAT_PAGE_SIZE),
  );
  return onSnapshot(
    messages,
    (snapshot) => {
      onChange(
        // The query takes the newest 200; the view reads oldest first. `estimate` gives the
        // sender's own pending message a local timestamp instead of null, so it is dated
        // roughly right on screen while the server's stamp is still on its way.
        sortByCreatedAt(
          snapshot.docs.map((document) => {
            const data = document.data({ serverTimestamps: 'estimate' }) as Omit<ChatMessage, 'id'>;
            return { ...data, id: document.id, createdAt: toMillis(data.createdAt) };
          }),
        ),
      );
    },
    (error) => onError?.(error),
  );
}

export function watchChatRoom(
  eventId: string,
  onChange: (room: ChatRoomState) => void,
  onError?: (error: unknown) => void,
): () => void {
  return onSnapshot(
    doc(getDb(), 'eventChats', eventId),
    (snapshot) => {
      const data = snapshot.data() as Partial<ChatRoomState> | undefined;
      onChange({ closed: data?.closed ?? false, endsAt: data?.endsAt ?? 0 });
    },
    (error) => onError?.(error),
  );
}

/**
 * One read of the room document, for the list — which has no reason to hold a live listener on
 * every room at once. `null` means this device may not read it: the rules open
 * `eventChats/{eventId}` to members only, and membership is what `joinEventChat` writes. A room
 * nobody has joined yet is not a closed room, so the caller shows it as open.
 */
export async function loadChatRoom(eventId: string): Promise<ChatRoomState | null> {
  try {
    const snapshot = await getDoc(doc(getDb(), 'eventChats', eventId));
    const data = snapshot.data() as Partial<ChatRoomState> | undefined;
    return data ? { closed: data.closed ?? false, endsAt: data.endsAt ?? 0 } : null;
  } catch {
    return null;
  }
}

/**
 * The display name of one organisation. `null` when there is no document — an organisation
 * created straight on chain has no profile row, and the caller shows the number instead.
 *
 * `createOrganizerForMe` writes this document, and the rules open `orgProfiles/{orgId}` to any
 * signed-in reader. A refusal or a dropped connection is swallowed into `null` the way
 * {@link loadChatRoom} swallows its own: a name that could not be read is a missing name, and
 * a missing name must never fail the list it was being read for.
 */
export async function loadOrgName(orgId: string): Promise<string | null> {
  try {
    const snapshot = await getDoc(doc(getDb(), 'orgProfiles', orgId));
    const name = (snapshot.data() as { name?: string } | undefined)?.name;
    return typeof name === 'string' && name !== '' ? name : null;
  } catch {
    return null;
  }
}

/**
 * The twelve bundled backdrops, by the letter `eventArt` stores. Spelled out here rather than
 * imported as a value so that reading a document pulls in no pictures: this list is the
 * validator's alphabet, and TypeScript fails the build if {@link TicketArtPreset} ever
 * gains a letter this one does not.
 */
const TICKET_ART_PRESETS: readonly TicketArtPreset[] = [
  'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l',
];

/** What a ticket looks like before anybody has chosen anything, and after anything went wrong. */
const DEFAULT_TICKET_ART: TicketArtSource = { preset: 'a' };

/**
 * The seam, and the reason this validation is here rather than in the component. What comes
 * back is whatever is in the document: a shape an older `saveEventArt` wrote, a hand edit made
 * in the console, or a draft written before the presets were named a–d (they were called
 * `'aurora'` and friends). Anything this function does not recognise becomes the first preset,
 * so a stale document costs a ticket the picture its organiser picked and never its render.
 *
 * An upload wins over a design key when a document somehow carries both: choosing a picture is
 * the more deliberate of the two acts, and the draft only ever keeps one of them filled in.
 */
function toTicketArt(entry: unknown): TicketArtSource {
  const fields = (typeof entry === 'object' && entry !== null ? entry : {}) as {
    design?: unknown;
    imageCid?: unknown;
  };
  if (typeof fields.imageCid === 'string' && fields.imageCid !== '') {
    return { imageCid: fields.imageCid };
  }
  const preset = TICKET_ART_PRESETS.find((key) => key === fields.design);
  return preset ? { preset } : DEFAULT_TICKET_ART;
}

/**
 * One event's ticket pictures in tier order, as `eventArt/{eventId}` holds them:
 * `{ tiers: [ { design } | { imageCid }, ... ], updatedAt }`. `saveEventArt` writes the
 * document and the rules open it to any signed-in reader, the same shape `orgProfiles` has.
 *
 * **An empty list means the document is not there; a failed read throws.** The two are not the
 * same answer and this function must never blur them, because `saveEventArt` *replaces* the
 * document: a caller that read `[]` from a network blip and then saved would write every kind
 * back as the first preset and erase pictures an organiser uploaded. The missing document is
 * the ordinary case — most events have never been through `saveEventArt` — so it is an empty
 * list rather than a refusal, and a screen that only draws pictures (the ticket list) can go
 * on treating a rejection as "no picture" itself.
 *
 * This is why it does **not** swallow its own failure the way {@link loadOrgName} does: a name
 * that could not be read is only ever shown, while this list is also written back.
 */
export async function loadEventArt(eventId: string): Promise<TicketArtSource[]> {
  const snapshot = await getDoc(doc(getDb(), 'eventArt', eventId));
  const tiers: unknown = (snapshot.data() as { tiers?: unknown } | undefined)?.tiers;
  if (!Array.isArray(tiers)) return [];
  return (tiers as unknown[]).map(toTicketArt);
}

/**
 * The room's roster: `uid` (the message rows' author key) to `account` (what the index holds a
 * nickname for). `joinEventChat` writes these documents and the rules open them to members, so
 * this is the only permitted way to put a name on somebody else's message — `users/{uid}` is
 * readable by that user alone. A refusal is thrown, not swallowed: the caller decides.
 */
export async function loadChatMembers(eventId: string): Promise<ChatMember[]> {
  const snapshot = await getDocs(collection(getDb(), 'eventChats', eventId, 'members'));
  return snapshot.docs
    .map((document) => ({
      uid: document.id,
      account: String((document.data() as { account?: string }).account ?? ''),
    }))
    .filter((member) => member.account !== '');
}

/**
 * The security rules reject unknown keys (`hasAll` + `hasOnly`, firestore.rules:59-60), so the
 * create payload is exactly { uid, text, createdAt, reported } — a stray field is not a
 * validation message, it is a permission error. `pinned` is server-only: an announcement is a
 * row the organiser path pinned, never one this client wrote.
 * Returns the new message id so the organizer can pin it straight away.
 */
export async function sendChatMessage(eventId: string, text: string): Promise<string> {
  const uid = getFirebaseAuth().currentUser?.uid;
  if (!uid) throw new Error('NOT_SIGNED_IN');
  if (text.length > CHAT_MESSAGE_MAX_LENGTH) throw new Error('MESSAGE_TOO_LONG');
  const ref = await addDoc(collection(getDb(), 'eventChats', eventId, 'messages'), {
    uid, text, createdAt: serverTimestamp(), reported: 0,
  });
  return ref.id;
}

/**
 * The cap on `users/{uid}.displayName`, which the security rule holds to the same number. It is
 * the name drawn on a ticket — not the chain nickname, which is `^[a-z0-9_]{3,20}$` and cannot
 * hold a Korean name at all (plan section E-3).
 */
export const MAX_DISPLAY_NAME_CHARS = 24;

/**
 * This account's own `users/{uid}` document, or `null` when it has none yet. Only the fields
 * this side writes are read back — the rest of that document is the server's.
 */
export async function loadMyProfile(): Promise<{ displayName: string } | null> {
  const uid = getFirebaseAuth().currentUser?.uid;
  if (!uid) return null;
  const snapshot = await getDoc(doc(getDb(), 'users', uid));
  if (!snapshot.exists()) return null;
  const data = snapshot.data() as { displayName?: unknown };
  return { displayName: typeof data.displayName === 'string' ? data.displayName : '' };
}

export async function saveUserProfile(patch: {
  nickname?: string;
  displayName?: string;
  locale?: 'ko' | 'en';
  chatOrder?: string[];
}): Promise<void> {
  const uid = getFirebaseAuth().currentUser?.uid;
  if (!uid) throw new Error('NOT_SIGNED_IN');
  await setDoc(doc(getDb(), 'users', uid), patch, { merge: true });
}

/**
 * Security rules allow exactly one client-writable field on devices/{account}: pushToken.
 * platform and updatedAt are written by Functions, never from here.
 */
export async function savePushToken(account: Hex, token: string): Promise<void> {
  await setDoc(doc(getDb(), 'devices', account), { pushToken: token }, { merge: true });
}

/**
 * The currencies SCENE 2 offers. Only `free` can be created today: `Ticket.claim` reverts
 * `PaidTiersNotEnabled` on any tier whose `priceUsdCents` is not zero, so the rest are a
 * promise the screen makes and then blocks on the spot. They never reach the chain or the
 * public metadata — the amount lives in the draft and nowhere else.
 */
export type EventDraftCurrency = 'free' | 'MON' | 'USDT' | 'USDC';

/** One ticket kind as SCENE 2 edits it. */
export interface EventDraftTier {
  name: string;
  supply: number;
  maxPerWallet: number;
  currency: EventDraftCurrency;
  /** Whole currency units, not cents. Display only, per {@link EventDraftCurrency}. */
  amount: number;
  /**
   * The bundled artwork key, or `''` when the organiser uploaded a picture of their own.
   * `design` and `imageCid` are kept apart here and folded into the one-or-the-other shape
   * `saveEventArt` takes only when the event is created, because a draft is a half-made
   * thing: somebody who picks a design, uploads a picture and then changes their mind back
   * should not have lost the design in between.
   */
  design: string;
  imageCid: string;
}

/**
 * An event being written, as `eventDrafts/{uid}/drafts/{draftId}` holds it. Fields follow the
 * storage map: everything the chain or the public metadata will carry is here in readable
 * form, plus the two the draft alone remembers (the price, and the hash below).
 *
 * The poster is a CID, never bytes. A Firestore document stops at 1 MiB and a 600 KB JPEG is
 * 800 KB as base64, so a draft that carried the picture would be a draft that sometimes
 * cannot be saved at all. The crop is pinned the moment it is made and only its CID lands
 * here, which keeps the whole document at roughly two kilobytes.
 */
export interface EventDraft {
  orgId: string;
  title: string;
  description: string;
  posterCid: string;
  /** The theme, one of the four the discover filter offers. */
  category: number;
  tags: string[];
  regionCode: string;
  venue: string;
  /** Ticket holders only. The chain still gets the real venue's hash, so the claim holds. */
  venueHidden: boolean;
  startsAt: number;
  endsAt: number;
  /** Ticket holders only, and a rendering rule rather than storage: the chain needs the truth. */
  timeHidden: boolean;
  transferable: boolean;
  transferCutoffHours: number;
  requireKyc: boolean;
  /**
   * Whether tickets are issued only after the organiser approves each request, rather than on a
   * first-come basis. One switch per event (it lives on `EventMeta`, not on a kind), written by
   * the first tier card's 받는 방식 control and read by `buildEventMeta`. Off by default.
   */
  approvalRequired: boolean;
  tiers: EventDraftTier[];
  /**
   * The `relays/{relayId}` of a `createEvent` the relayer has broadcast (`sent`) but not yet
   * settled, or `''`. The draft outlives the page, so a reopen resumes by following that document
   * ({@link watchRelay}) to `confirmed`/`failed` rather than sending a second `createEvent` — which
   * would be a second event.
   */
  submittedRelayId: string;
  /**
   * The id of the event this draft already created, or `''`. Written the moment the chain
   * names it and **before** anything that could still fail, so a draft can never make a second
   * event — and so the two writes that need the id (`saveEventArt`, `setEventPrivate`) can be
   * tried again later. The draft is only deleted once both of them have landed.
   */
  createdEventId: string;
  /**
   * The id of the event this draft is **editing**, or `''` for a draft that will make a new
   * one. An event is editable only while the chain still calls it a Draft (`Ticket.sol:235`),
   * and the difference this field makes is the whole of it: the scene is the same, the rules
   * are the same, and the last button sends `updateEventMeta` instead of `createEvent`.
   *
   * It is never set on the same draft as {@link createdEventId}: one is an event this draft
   * made, the other an event this draft was opened from.
   */
  editingEventId: string;
  /**
   * The name a new organisation is being created under, or `''`. Written **before**
   * `createOrganizerForMe` is called and cleared once it answers, because that callable is not
   * idempotent: a second call is a second organisation. A draft that comes back with this
   * still set is a run that died mid-call, and the next attempt asks the indexer what became
   * of it before it makes another (plan section B-5).
   */
  orgPendingName: string;
}

/**
 * A stored draft on the way back in. `data` is deliberately `unknown`: the document is
 * whatever is in Firestore — half-written by a crash, or edited by hand — and it is the
 * reading hook that narrows every field back to its own type.
 */
export interface StoredEventDraft {
  id: string;
  /** Epoch ms of the last write. 0 while the server's stamp is still on its way. */
  updatedAt: number;
  data: unknown;
}

function draftsPath(): [string, string, string] {
  const uid = getFirebaseAuth().currentUser?.uid;
  if (!uid) throw new Error('NOT_SIGNED_IN');
  return ['eventDrafts', uid, 'drafts'];
}

/**
 * Every draft this account holds, newest first. The whole collection rather than a page: the
 * caller both resumes the newest and keeps the collection at its cap, and a rule cannot count
 * documents, so the count has to be the client's to see.
 */
export async function listEventDrafts(): Promise<StoredEventDraft[]> {
  const drafts = query(collection(getDb(), ...draftsPath()), orderBy('updatedAt', 'desc'));
  const snapshot = await getDocs(drafts);
  return snapshot.docs.map((document) => {
    const data = document.data() as { updatedAt?: unknown };
    return { id: document.id, updatedAt: toMillis(data.updatedAt), data };
  });
}

/**
 * The whole document every time, not a merge: a ticket kind the organiser deleted has to
 * actually leave, and a merge would keep it forever. `updatedAt` is the server's clock
 * because it is what "newest draft" is decided on, across devices whose clocks disagree.
 */
export async function saveEventDraft(draftId: string, draft: EventDraft): Promise<void> {
  await setDoc(doc(getDb(), ...draftsPath(), draftId), { ...draft, updatedAt: serverTimestamp() });
}

export async function deleteEventDraft(draftId: string): Promise<void> {
  await deleteDoc(doc(getDb(), ...draftsPath(), draftId));
}


/**
 * One event's settlement, as the server writes it to `settlements/{eventId}` — the split policy,
 * its on-chain hash, and the per-tier USD price the chain has no room for. The rules open it to any
 * signed-in reader and the server alone writes it (`relaySetPolicy`), the same shape
 * `orgProfiles`/`eventArt` have.
 *
 * The field names are stable on purpose: `priceUsdCentsByTier`, `policyHash` and the recipient
 * shape are the web→backend contract the organiser and attendee settlement screens read back.
 */
export interface SettlementView {
  policy: {
    recipients: { account: Hex; bps: number; reason: string; tag: string }[];
    platformBps: number;
  };
  policyHash: Hex;
  priceUsdCentsByTier: Record<string, number>;
  setBy?: Hex;
  txHash?: Hex;
  updatedAt?: number;
}

/**
 * One read of an event's settlement, for a screen that has no reason to hold a live listener.
 * `null` means missing or not permitted — swallowed the way {@link loadOrgName} swallows its own,
 * because a settlement a screen could not read is simply one it does not draw.
 */
export async function getSettlement(eventId: string): Promise<SettlementView | null> {
  try {
    const snapshot = await getDoc(doc(getDb(), 'settlements', eventId));
    const data = snapshot.data() as (SettlementView & { updatedAt?: unknown }) | undefined;
    return data ? ({ ...data, updatedAt: toMillis(data.updatedAt) } as SettlementView) : null;
  } catch {
    return null;
  }
}

/**
 * The live view of an event's settlement, for the organiser screen that just relayed a policy and
 * waits for it to land. `null` is the ordinary pre-policy state. Modelled on {@link watchChatRoom}.
 */
export function watchSettlement(
  eventId: string,
  onChange: (settlement: SettlementView | null) => void,
  onError?: (error: unknown) => void,
): () => void {
  return onSnapshot(
    doc(getDb(), 'settlements', eventId),
    (snapshot) => {
      const data = snapshot.data() as (SettlementView & { updatedAt?: unknown }) | undefined;
      onChange(data ? ({ ...data, updatedAt: toMillis(data.updatedAt) } as SettlementView) : null);
    },
    (error) => onError?.(error),
  );
}

/**
 * One buyer's order, as the server writes it to `orders/{orderId}`: the escrow behind a purchased
 * ticket. The rules open it to its owner, so a listener that is refused calls `onError` and
 * detaches — the same terminal answer {@link watchChatMessages} documents. `null` is a missing
 * order (a wrong or not-yet-created id).
 */
export interface OrderView {
  orderId: string;
  eventId: string;
  tier: number;
  tokenId?: string;
  amountUsdCents: number;
  /** The v2 order machine: `pending → sent → deposited → released | refunded`, or `failed` (one
   *  atomic step — no ticket and no charge). */
  status: 'pending' | 'sent' | 'deposited' | 'released' | 'refunded' | 'failed';
  createdAt?: number;
  depositTxHash?: Hex;
}

export function watchOrder(
  orderId: string,
  onChange: (order: OrderView | null) => void,
  onError?: (error: unknown) => void,
): () => void {
  return onSnapshot(
    doc(getDb(), 'orders', orderId),
    (snapshot) => {
      const data = snapshot.data() as (OrderView & { createdAt?: unknown }) | undefined;
      onChange(data ? ({ ...data, orderId: snapshot.id, createdAt: toMillis(data.createdAt) } as OrderView) : null);
    },
    (error) => onError?.(error),
  );
}

/**
 * A relayed write's progress, as the server writes it to `relays/{relayId}`. `purchaseTicket`
 * answers with a `relayId` (kind `purchase`) the attendee follows here for the one-step ticket +
 * payment; `relaySetPolicy` answers with
 * one too. `null` is a relay id that has no document yet. Modelled on {@link watchChatRoom}.
 */
export interface RelayStatusView {
  status: 'pending' | 'sent' | 'confirmed' | 'failed';
  txHash?: Hex;
  tokenId?: string;
  error?: { code: string };
}

export function watchRelayStatus(
  relayId: string,
  onChange: (relay: RelayStatusView | null) => void,
  onError?: (error: unknown) => void,
): () => void {
  return onSnapshot(
    doc(getDb(), 'relays', relayId),
    (snapshot) => {
      const data = snapshot.data() as RelayStatusView | undefined;
      onChange(data ?? null);
    },
    (error) => onError?.(error),
  );
}
