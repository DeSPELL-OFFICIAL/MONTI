import {
  addDoc, collection, doc, getDoc, getDocs, limit, onSnapshot, orderBy, query, serverTimestamp,
  setDoc,
} from 'firebase/firestore';
import type { Hex } from '@monti/shared';
import { getDb, getFirebaseAuth } from './firebase';

/**
 * The only three places the client is allowed to touch Firestore (firestore.rules):
 * its own `users/{uid}` profile fields, `devices/{account}.pushToken`, and event chat.
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
 * the writer's own pending message, null. Views are typed on milliseconds and get milliseconds.
 */
function toMillis(value: unknown): number {
  if (typeof value === 'number') return value;
  const timestamp = value as { toMillis?: () => number } | null;
  return typeof timestamp?.toMillis === 'function' ? timestamp.toMillis() : 0;
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
        snapshot.docs
          .map((document) => {
            const data = document.data() as Omit<ChatMessage, 'id'>;
            return { ...data, id: document.id, createdAt: toMillis(data.createdAt) };
          })
          // The query takes the newest 200; the view reads oldest first.
          .reverse(),
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
