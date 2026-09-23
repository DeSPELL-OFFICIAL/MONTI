import {
  addDoc, collection, deleteDoc, doc, getDoc, getDocs, limit, onSnapshot, orderBy, query,
  serverTimestamp, setDoc,
} from 'firebase/firestore';
import type { Hex } from '@monti/shared';
import type { TicketArtPreset, TicketArtSource } from '../ui/TicketArt';
import { getDb, getFirebaseAuth } from './firebase';

/**
 * The four places the client is allowed to write to Firestore (firestore.rules): its own
 * `users/{uid}` profile fields, `devices/{account}.pushToken`, event chat, and its own event
 * drafts under `eventDrafts/{uid}/drafts` — the fourth, and the only one it may also delete,
 * because a draft is written every two seconds and a callable per keystroke costs both money
 * and latency.
 * It also reads two collections it may never write, both open to any signed-in reader and
 * written by the server alone: `orgProfiles/{orgId}`, the organiser display names the chain
 * has no room for, and `eventArt/{eventId}`, the ticket pictures `Tier` has no column for.
 * Everything else goes through a callable in ./functions.
 */

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
 * The four bundled backdrops, by the letter `eventArt` stores. Spelled out here rather than
 * imported as a value so that reading a document pulls in no pictures: this list is the
 * validator's alphabet, and TypeScript fails the build if {@link TicketArtPreset} ever
 * gains a letter this one does not.
 */
const TICKET_ART_PRESETS: readonly TicketArtPreset[] = ['a', 'b', 'c', 'd'];

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

export async function saveUserProfile(patch: { nickname?: string; locale?: 'ko' | 'en'; chatOrder?: string[] }): Promise<void> {
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
  tiers: EventDraftTier[];
  /**
   * The `userOpHash` of a `createEvent` whose `wait` gave up before it landed, or `''`. The
   * draft outlives the page, so without it a second attempt is a second event.
   */
  submittedOpHash: string;
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
