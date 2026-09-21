import { beforeEach, describe, expect, it, vi } from 'vitest';

const addDoc = vi.fn();
const setDoc = vi.fn();
const getDoc = vi.fn();
const getDocs = vi.fn();
const onSnapshot = vi.fn();
const SERVER_TIME = Symbol('serverTimestamp');

/**
 * The create allowlist, copied out of firestore.rules:59-60 (`hasAll` + `hasOnly`). A stray key
 * is not a validation message on that path, it is a permission error, so the payload is pinned
 * against this list rather than against whatever the helper happens to send.
 */
const RULES_MESSAGE_FIELDS = ['createdAt', 'reported', 'text', 'uid'];

vi.mock('firebase/firestore', () => ({
  addDoc,
  setDoc,
  getDoc,
  getDocs,
  onSnapshot,
  collection: (_db: unknown, ...path: string[]) => ({ path: path.join('/') }),
  doc: (_db: unknown, ...path: string[]) => ({ path: path.join('/') }),
  query: (base: unknown, ...clauses: unknown[]) => ({ base, clauses }),
  orderBy: (field: string, direction: string) => ({ orderBy: field, direction }),
  limit: (count: number) => ({ limit: count }),
  serverTimestamp: () => SERVER_TIME,
}));

let currentUser: { uid: string } | null = { uid: 'uid-1' };
vi.mock('./firebase', () => ({
  getDb: () => ({}),
  getFirebaseAuth: () => ({ currentUser }),
}));

const {
  loadChatMembers, loadChatRoom, saveUserProfile, savePushToken, sendChatMessage,
  watchChatMessages, watchChatRoom,
} = await import('./firestore');

/** A Firestore document snapshot, as thin as the helpers actually touch it. */
function docOf(id: string, data: Record<string, unknown>): { id: string; data: () => unknown } {
  return { id, data: () => data };
}

beforeEach(() => {
  currentUser = { uid: 'uid-1' };
  addDoc.mockResolvedValue({ id: 'msg-9' });
  setDoc.mockResolvedValue(undefined);
  getDoc.mockResolvedValue({ data: () => undefined });
  getDocs.mockResolvedValue({ docs: [] });
  onSnapshot.mockReturnValue(() => undefined);
});

describe('sendChatMessage', () => {
  it('writes exactly the four keys the security rules allow and returns the new id', async () => {
    await expect(sendChatMessage('3', 'hi')).resolves.toBe('msg-9');
    const [ref, payload] = addDoc.mock.calls[0] as [{ path: string }, Record<string, unknown>];
    expect(ref.path).toBe('eventChats/3/messages');
    expect(Object.keys(payload).sort()).toEqual(RULES_MESSAGE_FIELDS);
    // `pinned` is the one the rules single out: an announcement is the server's word, not ours.
    expect(RULES_MESSAGE_FIELDS).not.toContain('pinned');
    expect(payload).not.toHaveProperty('pinned');
    expect(payload).toMatchObject({ uid: 'uid-1', text: 'hi', reported: 0, createdAt: SERVER_TIME });
  });

  it('refuses to write when signed out or over the 500 character rule limit', async () => {
    currentUser = null;
    await expect(sendChatMessage('3', 'hi')).rejects.toThrow();
    currentUser = { uid: 'uid-1' };
    await expect(sendChatMessage('3', 'x'.repeat(501))).rejects.toThrow();
    expect(addDoc).not.toHaveBeenCalled();
  });
});

describe('watchChatMessages', () => {
  it('hands the view oldest-first messages with a numeric createdAt', () => {
    const received: unknown[] = [];
    watchChatMessages('3', (messages) => received.push(messages));
    const [queryRef, handler] = onSnapshot.mock.calls[0] as [
      { clauses: unknown[] },
      (snapshot: { docs: unknown[] }) => void,
    ];
    expect(queryRef.clauses).toContainEqual({ orderBy: 'createdAt', direction: 'desc' });
    expect(queryRef.clauses).toContainEqual({ limit: 200 });
    handler({
      docs: [
        docOf('b', { uid: 'u2', text: 'second', createdAt: { toMillis: () => 2000 }, reported: 0 }),
        docOf('a', { uid: 'u1', text: 'first', createdAt: 1000, reported: 0 }),
      ],
    });
    expect(received[0]).toEqual([
      { id: 'a', uid: 'u1', text: 'first', createdAt: 1000, reported: 0 },
      { id: 'b', uid: 'u2', text: 'second', createdAt: 2000, reported: 0 },
    ]);
  });
});

describe('watchChatRoom', () => {
  it('treats a room document that is not there yet as open', () => {
    const rooms: Array<{ closed: boolean; endsAt: number }> = [];
    watchChatRoom('3', (room) => rooms.push(room));
    const handler = onSnapshot.mock.calls[0]?.[1] as (snapshot: { data: () => unknown }) => void;
    handler({ data: () => undefined });
    handler({ data: () => ({ closed: true, endsAt: 1790000000 }) });
    expect(rooms).toEqual([
      { closed: false, endsAt: 0 },
      { closed: true, endsAt: 1790000000 },
    ]);
  });
});

describe('loadChatRoom', () => {
  it('reads the room document once', async () => {
    getDoc.mockResolvedValue({ data: () => ({ closed: true, endsAt: 1790000000 }) });
    await expect(loadChatRoom('3')).resolves.toEqual({ closed: true, endsAt: 1790000000 });
    expect(getDoc).toHaveBeenCalledWith({ path: 'eventChats/3' });
  });

  it('answers null for a room this device may not read yet, rather than inventing a state', async () => {
    await expect(loadChatRoom('3')).resolves.toBeNull();
    getDoc.mockRejectedValue(Object.assign(new Error('insufficient'), { code: 'permission-denied' }));
    await expect(loadChatRoom('3')).resolves.toBeNull();
  });
});

describe('loadChatMembers', () => {
  it('maps the roster from uid to account and drops a row without one', async () => {
    getDocs.mockResolvedValue({
      docs: [docOf('uid-1', { account: '0xabc' }), docOf('uid-2', {})],
    });
    await expect(loadChatMembers('3')).resolves.toEqual([{ uid: 'uid-1', account: '0xabc' }]);
    expect(getDocs).toHaveBeenCalledWith({ path: 'eventChats/3/members' });
  });

  it('lets a refusal through, because only the caller knows what to say about it', async () => {
    getDocs.mockRejectedValue(new Error('permission-denied'));
    await expect(loadChatMembers('3')).rejects.toThrow();
  });
});

describe('profile and push token writes', () => {
  it('merges the profile patch into the signed-in user document', async () => {
    await saveUserProfile({ nickname: 'moomi', locale: 'ko' });
    expect(setDoc).toHaveBeenCalledWith(
      { path: 'users/uid-1' },
      { nickname: 'moomi', locale: 'ko' },
      { merge: true },
    );
  });

  it('writes only pushToken on the device document', async () => {
    const account = `0x${'ab'.repeat(20)}` as const;
    await savePushToken(account, 'fcm-token');
    expect(setDoc).toHaveBeenCalledWith(
      { path: `devices/${account}` },
      { pushToken: 'fcm-token' },
      { merge: true },
    );
  });
});
