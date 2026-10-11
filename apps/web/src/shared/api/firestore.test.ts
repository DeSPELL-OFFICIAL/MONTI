import { beforeEach, describe, expect, it, vi } from 'vitest';

const addDoc = vi.fn();
const setDoc = vi.fn();
const deleteDoc = vi.fn();
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
  deleteDoc,
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
  deleteEventDraft, listEventDrafts, loadChatMembers, loadChatRoom, loadEventArt, saveEventDraft,
  saveUserProfile, savePushToken, sendChatMessage, watchChatMessages, watchChatRoom,
} = await import('./firestore');
const { TICKET_ART_PRESETS } = await import('../../organizer/scene/draftRules');

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
  deleteDoc.mockResolvedValue(undefined);
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

  it('puts the sender own message last while its timestamp is still pending', () => {
    const received: Array<Array<{ id: string }>> = [];
    watchChatMessages('3', (messages) => received.push(messages));
    const handler = onSnapshot.mock.calls[0]?.[1] as (snapshot: { docs: unknown[] }) => void;
    // Firestore orders an unstamped serverTimestamp smallest, so it arrives at the end of a
    // `desc` page — exactly where a plain reverse would turn it into the oldest message.
    handler({
      docs: [
        docOf('b', { uid: 'u2', text: 'second', createdAt: { toMillis: () => 2000 }, reported: 0 }),
        docOf('a', { uid: 'u1', text: 'first', createdAt: { toMillis: () => 1000 }, reported: 0 }),
        docOf('mine', { uid: 'uid-1', text: 'just now', createdAt: null, reported: 0 }),
      ],
    });
    expect(received[0]?.map((message) => message.id)).toEqual(['a', 'b', 'mine']);
  });

  it('asks for an estimate so a pending message is not dated 1970 on screen', () => {
    watchChatMessages('3', () => undefined);
    const handler = onSnapshot.mock.calls[0]?.[1] as (snapshot: { docs: unknown[] }) => void;
    const data = vi.fn(() => ({ uid: 'u1', text: 'hi', createdAt: 1000, reported: 0 }));
    handler({ docs: [{ id: 'a', data }] });
    expect(data).toHaveBeenCalledWith({ serverTimestamps: 'estimate' });
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

describe('loadEventArt', () => {
  /**
   * The read side's own copy of the preset alphabet. It is the fourth place the twelve letters
   * are written down — after the union `TicketArtPreset`, the scene's `TICKET_ART_PRESETS` and
   * `saveEventArt`'s argument — and it is the one that fails **silently**: a letter this
   * validator has never heard of is folded back to `'a'`, so an organiser who picked the
   * twelfth drawing would see the first one on every ticket and nothing anywhere would say so.
   */
  it('reads every letter the scene can store back as itself', async () => {
    getDoc.mockResolvedValue({
      data: () => ({ tiers: TICKET_ART_PRESETS.map((design) => ({ design })) }),
    });
    expect(await loadEventArt('12')).toEqual(TICKET_ART_PRESETS.map((preset) => ({ preset })));
  });

  /** A hand edit, or a document an older build wrote, costs its ticket a drawing — not a render. */
  it('folds a letter nothing draws, and a name, back to the first drawing', async () => {
    getDoc.mockResolvedValue({ data: () => ({ tiers: [{ design: 'm' }, { design: 'aurora' }, {}] }) });
    expect(await loadEventArt('12')).toEqual([{ preset: 'a' }, { preset: 'a' }, { preset: 'a' }]);
  });

  /** An uploaded picture is the more deliberate of the two acts, so it wins over a letter. */
  it('lets an uploaded picture win, and calls a missing document an empty list', async () => {
    getDoc.mockResolvedValue({ data: () => ({ tiers: [{ design: 'c', imageCid: 'bafkart' }] }) });
    expect(await loadEventArt('12')).toEqual([{ imageCid: 'bafkart' }]);

    // Most events have never been through `saveEventArt`; that is not a refusal.
    getDoc.mockResolvedValue({ data: () => undefined });
    expect(await loadEventArt('12')).toEqual([]);
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

describe('event drafts', () => {
  /** The draft the storage map describes, at its smallest: the poster is a CID, never bytes. */
  const draft = {
    orgId: '9', title: '재즈 나이트', description: '', posterCid: 'bafk1',
    category: 0, tags: ['재즈'], regionCode: 'KR-11', venue: '한남동', venueHidden: true,
    startsAt: 0, endsAt: 0, timeHidden: false,
    transferable: true, transferCutoffHours: 2, requireKyc: false, approvalRequired: false,
    tiers: [], splitJson: '', submittedRelayId: '', createdEventId: '', orgPendingName: '',
  };

  it('lists this account own drafts newest first', async () => {
    getDocs.mockResolvedValue({
      docs: [docOf('d1', { title: 'a', updatedAt: { toMillis: () => 2000 } })],
    });
    await expect(listEventDrafts()).resolves.toEqual([
      { id: 'd1', updatedAt: 2000, data: { title: 'a', updatedAt: expect.anything() } },
    ]);
    const [built] = getDocs.mock.calls[0] as [{ base: { path: string }; clauses: unknown[] }];
    expect(built.base.path).toBe('eventDrafts/uid-1/drafts');
    expect(built.clauses).toContainEqual({ orderBy: 'updatedAt', direction: 'desc' });
  });

  it('replaces the whole document and stamps it on the server clock', async () => {
    await saveEventDraft('d1', draft);
    const [ref, payload, options] = setDoc.mock.calls[0] as [
      { path: string }, Record<string, unknown>, unknown,
    ];
    expect(ref.path).toBe('eventDrafts/uid-1/drafts/d1');
    // No `{ merge: true }`: a ticket kind the organiser deleted has to actually leave.
    expect(options).toBeUndefined();
    expect(payload).toMatchObject({ ...draft, updatedAt: SERVER_TIME });
    // The picture is a CID here and nowhere near the 1 MiB a document is capped at.
    expect(JSON.stringify(payload)).not.toContain('base64');
  });

  it('deletes one draft, the only document this client may remove', async () => {
    await deleteEventDraft('d1');
    expect(deleteDoc).toHaveBeenCalledWith({ path: 'eventDrafts/uid-1/drafts/d1' });
  });

  it('refuses to touch drafts when nobody is signed in', async () => {
    currentUser = null;
    await expect(listEventDrafts()).rejects.toThrow();
    await expect(saveEventDraft('d1', draft)).rejects.toThrow();
    await expect(deleteEventDraft('d1')).rejects.toThrow();
    expect(setDoc).not.toHaveBeenCalled();
    expect(deleteDoc).not.toHaveBeenCalled();
  });
});
