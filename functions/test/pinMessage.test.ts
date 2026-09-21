import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';

process.env.GCP_PROJECT_ID = 'monti-dev';

const ORGANIZERS = '0x2222222222222222222222222222222222222222';
const TICKET = '0x3333333333333333333333333333333333333333';
/** 조직 오너. 숫자만 쓰는 주소라 EIP-55 체크섬이 대소문자를 바꾸지 않는다. */
const OWNER = '0x9999999999999999999999999999999999999999';
/** `PERM_CREATE_EVENT(1)` 만 가진 관리자. */
const CREATOR_ADMIN = '0x8888888888888888888888888888888888888888';
/** 아무 권한도 없는 사람 — 채팅 멤버일 수는 있다. */
const OUTSIDER = '0x7777777777777777777777777777777777777777';

/**
 * `eventChats` 와 그 하위 컬렉션만 흉내 내는 가짜 Firestore.
 * 에뮬레이터 없이 `pnpm test` 안에서 돈다(eventChat.test.ts 와 같은 패턴).
 */
const docs = new Map<string, Record<string, unknown>>();
const writes: string[] = [];
/** 읽은 경로. "멤버 문서는 쳐다보지도 않는다" 를 여기서 본다. */
const readPaths: string[] = [];

const SERVER_TIMESTAMP = FieldValue.serverTimestamp();

function isServerTimestamp(value: unknown): boolean {
  const candidate = value as FieldValue | undefined;
  return typeof candidate?.isEqual === 'function' && candidate.isEqual(SERVER_TIMESTAMP);
}

function write(path: string, data: Record<string, unknown>, merge: boolean): void {
  writes.push(path);
  const previous = merge ? (docs.get(path) ?? {}) : {};
  const resolved = Object.fromEntries(
    Object.entries(data).map(([k, v]) => [k, isServerTimestamp(v) ? Timestamp.now() : v]),
  );
  docs.set(path, { ...previous, ...resolved });
}

function snapshot(path: string) {
  const data = docs.get(path);
  return {
    exists: data !== undefined,
    id: path.slice(path.lastIndexOf('/') + 1),
    get: (field: string) => data?.[field],
    data: () => data,
  };
}

let autoId = 0;

function docRef(path: string) {
  return {
    path,
    id: path.slice(path.lastIndexOf('/') + 1),
    get: async () => {
      readPaths.push(path);
      return snapshot(path);
    },
    set: async (data: Record<string, unknown>) => write(path, data, false),
    update: async (data: Record<string, unknown>) => {
      if (!docs.has(path)) throw new Error(`NOT_FOUND:${path}`);
      write(path, data, true);
    },
  };
}

vi.mock('../src/lib/db.js', () => ({
  PERSONS: 'persons',
  USERS: 'users',
  EVENT_CHATS: 'eventChats',
  db: {
    collection: (path: string) => ({
      doc: (id?: string) => {
        autoId += 1;
        return docRef(`${path}/${id ?? `auto-${autoId}`}`);
      },
    }),
    doc: (path: string) => docRef(path),
  },
}));

/**
 * eth_call 하나하나의 답. 인가는 전부 체인에서 읽으므로(우리 DB에는 역할이 없다)
 * 이 표를 갈아끼우는 것이 곧 "누구로 부르는가" 다.
 */
const chain = { orgId: 1n, owner: OWNER as string, bits: new Map<string, number>() };
const reads: Array<{ functionName: string; args: readonly unknown[] }> = [];

vi.mock('../src/lib/chain.js', () => ({
  deployment: () => ({ organizers: ORGANIZERS, ticket: TICKET }),
  publicClient: () => ({
    readContract: async ({
      functionName,
      args,
    }: {
      functionName: string;
      args: readonly unknown[];
    }) => {
      reads.push({ functionName, args });
      if (functionName === 'eventOrg') return chain.orgId;
      if (functionName === 'ownerOf') return chain.owner;
      if (functionName === 'hasPermission') {
        const [, account, bit] = args as [bigint, string, number];
        if (account.toLowerCase() === chain.owner.toLowerCase()) return true;
        const held = chain.bits.get(account.toLowerCase()) ?? 0;
        return (held & bit) === bit && bit !== 0;
      }
      throw new Error(`UNEXPECTED_READ:${functionName}`);
    },
  }),
}));

const { EVENT_CHATS } = await import('../src/lib/db.js');
const { MAX_ANNOUNCEMENT_CHARS, pinMessage } = await import('../src/functions/pinMessage.js');
const functionsTest = (await import('firebase-functions-test')).default();

const pin = functionsTest.wrap(pinMessage);

/** 세션 클레임으로만 호출자를 묶는다 — 요청 본문의 주소는 어디에서도 읽지 않는다. */
const ownerAuth = { uid: 'uid-owner', token: { account: OWNER } };
const adminAuth = { uid: 'uid-admin', token: { account: CREATOR_ADMIN } };
const outsiderAuth = { uid: 'uid-outsider', token: { account: OUTSIDER } };

const MESSAGE = `${EVENT_CHATS}/11/messages/m1`;

beforeEach(() => {
  docs.clear();
  writes.length = 0;
  readPaths.length = 0;
  reads.length = 0;
  autoId = 0;
  chain.orgId = 1n;
  chain.owner = OWNER;
  chain.bits.clear();
  chain.bits.set(CREATOR_ADMIN.toLowerCase(), 1); // PERM_CREATE_EVENT
  docs.set(`${EVENT_CHATS}/11`, { closed: false, endsAt: 4_102_444_800, orgId: '1' });
  docs.set(MESSAGE, { uid: 'uid-2', text: '공지', createdAt: 1, reported: 0 });
});

describe('pinMessage — pinning a message that already exists', () => {
  it('pins a message for the org owner and touches nothing else on it', async () => {
    const result = (await pin({
      data: { eventId: '11', messageId: 'm1', pinned: true },
      auth: ownerAuth,
    } as never)) as { ok: true; messageId: string };

    expect(result).toEqual({ ok: true, messageId: 'm1' });
    expect(docs.get(MESSAGE)).toEqual({ uid: 'uid-2', text: '공지', createdAt: 1, reported: 0, pinned: true });
    expect(writes).toEqual([MESSAGE]);
  });

  it('pins for an admin holding PERM_CREATE_EVENT, asking the chain with that exact bit', async () => {
    await pin({ data: { eventId: '11', messageId: 'm1', pinned: true }, auth: adminAuth } as never);

    expect(reads[0]).toEqual({ functionName: 'eventOrg', args: [11n] });
    expect(reads).toContainEqual({ functionName: 'hasPermission', args: [1n, CREATOR_ADMIN, 1] });
    expect(snapshot(MESSAGE).get('pinned')).toBe(true);
  });

  it('unpins with pinned: false', async () => {
    await pin({ data: { eventId: '11', messageId: 'm1', pinned: true }, auth: ownerAuth } as never);
    await pin({ data: { eventId: '11', messageId: 'm1', pinned: false }, auth: ownerAuth } as never);
    expect(snapshot(MESSAGE).get('pinned')).toBe(false);
  });

  it('refuses a caller who is neither the owner nor a create-event admin', async () => {
    await expect(
      pin({ data: { eventId: '11', messageId: 'm1', pinned: true }, auth: outsiderAuth } as never),
    ).rejects.toThrow('NOT_ORGANIZER_ADMIN');
    expect(snapshot(MESSAGE).get('pinned')).toBeUndefined();
    expect(writes).toEqual([]);
  });

  it('refuses a missing message and a non-boolean pinned', async () => {
    await expect(
      pin({ data: { eventId: '11', messageId: 'nope', pinned: true }, auth: ownerAuth } as never),
    ).rejects.toThrow('MESSAGE_NOT_FOUND');
    await expect(
      pin({ data: { eventId: '11', messageId: 'm1', pinned: 'yes' }, auth: ownerAuth } as never),
    ).rejects.toThrow('BAD_PINNED');
    await expect(
      pin({ data: { eventId: '11', messageId: 'm1' }, auth: ownerAuth } as never),
    ).rejects.toThrow('BAD_PINNED');
    expect(writes).toEqual([]);
  });

  it('refuses a closed chat — a finished room keeps the pins it ended with', async () => {
    docs.set(`${EVENT_CHATS}/11`, { closed: true, endsAt: 1, orgId: '1' });
    await expect(
      pin({ data: { eventId: '11', messageId: 'm1', pinned: true }, auth: ownerAuth } as never),
    ).rejects.toThrow('CHAT_CLOSED');
    expect(writes).toEqual([]);
  });

  it('rejects a malformed id and an unauthenticated caller', async () => {
    await expect(
      pin({ data: { eventId: '0x11', messageId: 'm1', pinned: true }, auth: ownerAuth } as never),
    ).rejects.toThrow('BAD_EVENT_ID');
    await expect(pin({ data: { messageId: 'm1', pinned: true }, auth: ownerAuth } as never)).rejects.toThrow(
      'BAD_EVENT_ID',
    );
    await expect(
      pin({
        data: { eventId: '11', messageId: '../../users/uid-1', pinned: true },
        auth: ownerAuth,
      } as never),
    ).rejects.toThrow('BAD_MSG_ID');
    await expect(pin({ data: { eventId: '11', messageId: 'm1', pinned: true } } as never)).rejects.toThrow(
      'AUTH_REQUIRED',
    );
    expect(writes).toEqual([]);
  });
});

describe('pinMessage — authoring the announcement it pins', () => {
  /** 이 갈래가 새로 쓴 문서의 경로. 기존 메시지는 `beforeEach` 가 심어 둔 것뿐이다. */
  function authoredPath(): string {
    return writes[0] as string;
  }

  it('writes the rules field set plus pinned and senderUid, and returns the new id', async () => {
    const result = (await pin({
      data: { eventId: '11', text: '  공연 30분 전입니다  ' },
      auth: ownerAuth,
    } as never)) as { ok: true; messageId: string };

    expect(writes).toHaveLength(1);
    expect(authoredPath()).toBe(`${EVENT_CHATS}/11/messages/${result.messageId}`);
    const message = docs.get(authoredPath()) as Record<string, unknown>;
    expect(Object.keys(message).sort()).toEqual([
      'createdAt',
      'pinned',
      'reported',
      'senderUid',
      'text',
      'uid',
    ]);
    // 규칙이 부르는 이름은 `uid` 다(클라이언트가 그걸 읽는다). `senderUid` 는 서버가 대신 쓴
    // 글이라는 표시 — 클라이언트는 `hasOnly` 때문에 이 칸을 영원히 쓸 수 없다.
    expect(message.uid).toBe(ownerAuth.uid);
    expect(message.senderUid).toBe(ownerAuth.uid);
    expect(message.text).toBe('공연 30분 전입니다');
    expect(message.pinned).toBe(true);
    expect(message.reported).toBe(0);
    expect(message.createdAt).toBeInstanceOf(Timestamp);
  });

  it('needs no ticket and no chat membership — the chain read is the whole authorization', async () => {
    // 이 방에는 멤버 문서가 하나도 없다. 주최자는 자기 공연 표를 사지 않는다.
    await pin({ data: { eventId: '11', text: '안내드립니다' }, auth: adminAuth } as never);

    expect(docs.get(authoredPath())?.uid).toBe(adminAuth.uid);
    expect(readPaths.some((path) => path.includes('/members/'))).toBe(false);
    expect(reads).toContainEqual({ functionName: 'hasPermission', args: [1n, CREATOR_ADMIN, 1] });
  });

  it('announces into a room nobody has joined yet — the chat doc need not exist', async () => {
    await pin({ data: { eventId: '77', text: '안내드립니다' }, auth: ownerAuth } as never);
    expect(authoredPath().startsWith(`${EVENT_CHATS}/77/messages/`)).toBe(true);
  });

  it('refuses a caller outside the org and a closed chat, writing nothing', async () => {
    await expect(
      pin({ data: { eventId: '11', text: '안내드립니다' }, auth: outsiderAuth } as never),
    ).rejects.toThrow('NOT_ORGANIZER_ADMIN');

    docs.set(`${EVENT_CHATS}/11`, { closed: true, endsAt: 1, orgId: '1' });
    await expect(
      pin({ data: { eventId: '11', text: '안내드립니다' }, auth: ownerAuth } as never),
    ).rejects.toThrow('CHAT_CLOSED');
    expect(writes).toEqual([]);
  });

  it('caps the text at 500 characters and refuses a blank one', async () => {
    await pin({
      data: { eventId: '11', text: 'a'.repeat(MAX_ANNOUNCEMENT_CHARS) },
      auth: ownerAuth,
    } as never);
    expect((docs.get(authoredPath())?.text as string).length).toBe(MAX_ANNOUNCEMENT_CHARS);

    for (const text of ['', '   ', 'a'.repeat(MAX_ANNOUNCEMENT_CHARS + 1), 7, null]) {
      await expect(pin({ data: { eventId: '11', text }, auth: ownerAuth } as never)).rejects.toThrow(
        'BAD_TEXT',
      );
    }
    expect(writes).toHaveLength(1);
  });

  it('takes exactly one of messageId and text — never both, never neither', async () => {
    await expect(
      pin({ data: { eventId: '11', messageId: 'm1', text: '안내드립니다' }, auth: ownerAuth } as never),
    ).rejects.toThrow('BAD_PIN_TARGET');
    await expect(pin({ data: { eventId: '11' }, auth: ownerAuth } as never)).rejects.toThrow(
      'BAD_PIN_TARGET',
    );
    expect(writes).toEqual([]);
  });

  it('refuses a pinned flag alongside text — a new announcement is pinned by definition', async () => {
    await expect(
      pin({ data: { eventId: '11', text: '안내드립니다', pinned: false }, auth: ownerAuth } as never),
    ).rejects.toThrow('BAD_PINNED');
    expect(writes).toEqual([]);
  });
});
