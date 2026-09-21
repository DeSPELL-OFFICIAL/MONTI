import {
  addDoc, collection, doc, limit, onSnapshot, orderBy, query, serverTimestamp, setDoc,
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

export function watchChatMessages(eventId: string, onChange: (messages: ChatMessage[]) => void): () => void {
  const messages = query(
    collection(getDb(), 'eventChats', eventId, 'messages'),
    orderBy('createdAt', 'desc'),
    limit(CHAT_PAGE_SIZE),
  );
  return onSnapshot(messages, (snapshot) => {
    onChange(
      snapshot.docs
        .map((document) => {
          const data = document.data() as Omit<ChatMessage, 'id'>;
          return { ...data, id: document.id, createdAt: toMillis(data.createdAt) };
        })
        // The query takes the newest 200; the view reads oldest first.
        .reverse(),
    );
  });
}

export function watchChatRoom(eventId: string, onChange: (room: { closed: boolean; endsAt: number }) => void): () => void {
  return onSnapshot(doc(getDb(), 'eventChats', eventId), (snapshot) => {
    const data = snapshot.data() as { closed?: boolean; endsAt?: number } | undefined;
    onChange({ closed: data?.closed ?? false, endsAt: data?.endsAt ?? 0 });
  });
}

/**
 * The security rules reject unknown keys, so the create payload is exactly
 * { uid, text, createdAt, reported }. `pinned` is server-only (pinMessage callable).
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
