import { beforeEach, describe, expect, it, vi } from 'vitest';

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

function snapshot(path: string) {
  const data = docs.get(path);
  return {
    exists: data !== undefined,
    id: path.slice(path.lastIndexOf('/') + 1),
    get: (field: string) => data?.[field],
    data: () => data,
  };
}

function docRef(path: string) {
  return {
    path,
    id: path.slice(path.lastIndexOf('/') + 1),
    get: async () => snapshot(path),
    update: async (data: Record<string, unknown>) => {
      if (!docs.has(path)) throw new Error(`NOT_FOUND:${path}`);
      writes.push(path);
      docs.set(path, { ...(docs.get(path) as Record<string, unknown>), ...data });
    },
  };
}

vi.mock('../src/lib/db.js', () => ({
  PERSONS: 'persons',
  USERS: 'users',
  EVENT_CHATS: 'eventChats',
  db: {
    collection: (name: string) => ({ doc: (id: string) => docRef(`${name}/${id}`) }),
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
const { pinMessage } = await import('../src/functions/pinMessage.js');
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
  reads.length = 0;
  chain.orgId = 1n;
  chain.owner = OWNER;
  chain.bits.clear();
  chain.bits.set(CREATOR_ADMIN.toLowerCase(), 1); // PERM_CREATE_EVENT
  docs.set(`${EVENT_CHATS}/11`, { closed: false, endsAt: 4_102_444_800, orgId: '1' });
  docs.set(MESSAGE, { uid: 'uid-2', text: '공지', createdAt: 1, reported: 0 });
});

describe('pinMessage', () => {
  it('pins a message for the org owner and touches nothing else on it', async () => {
    const result = (await pin({
      data: { eventId: '11', msgId: 'm1', pinned: true },
      auth: ownerAuth,
    } as never)) as { ok: true };

    expect(result).toEqual({ ok: true });
    expect(docs.get(MESSAGE)).toEqual({ uid: 'uid-2', text: '공지', createdAt: 1, reported: 0, pinned: true });
    expect(writes).toEqual([MESSAGE]);
  });

  it('pins for an admin holding PERM_CREATE_EVENT, asking the chain with that exact bit', async () => {
    await pin({ data: { eventId: '11', msgId: 'm1', pinned: true }, auth: adminAuth } as never);

    expect(reads[0]).toEqual({ functionName: 'eventOrg', args: [11n] });
    expect(reads).toContainEqual({ functionName: 'hasPermission', args: [1n, CREATOR_ADMIN, 1] });
    expect(snapshot(MESSAGE).get('pinned')).toBe(true);
  });

  it('unpins with pinned: false', async () => {
    await pin({ data: { eventId: '11', msgId: 'm1', pinned: true }, auth: ownerAuth } as never);
    await pin({ data: { eventId: '11', msgId: 'm1', pinned: false }, auth: ownerAuth } as never);
    expect(snapshot(MESSAGE).get('pinned')).toBe(false);
  });

  it('refuses a caller who is neither the owner nor a create-event admin', async () => {
    await expect(
      pin({ data: { eventId: '11', msgId: 'm1', pinned: true }, auth: outsiderAuth } as never),
    ).rejects.toThrow('NOT_ORGANIZER_ADMIN');
    expect(snapshot(MESSAGE).get('pinned')).toBeUndefined();
    expect(writes).toEqual([]);
  });

  it('refuses a missing message and a non-boolean pinned', async () => {
    await expect(
      pin({ data: { eventId: '11', msgId: 'nope', pinned: true }, auth: ownerAuth } as never),
    ).rejects.toThrow('MESSAGE_NOT_FOUND');
    await expect(
      pin({ data: { eventId: '11', msgId: 'm1', pinned: 'yes' }, auth: ownerAuth } as never),
    ).rejects.toThrow('BAD_PINNED');
    expect(writes).toEqual([]);
  });

  it('refuses a closed chat — a finished room keeps the pins it ended with', async () => {
    docs.set(`${EVENT_CHATS}/11`, { closed: true, endsAt: 1, orgId: '1' });
    await expect(
      pin({ data: { eventId: '11', msgId: 'm1', pinned: true }, auth: ownerAuth } as never),
    ).rejects.toThrow('CHAT_CLOSED');
    expect(writes).toEqual([]);
  });

  it('rejects a malformed id and an unauthenticated caller', async () => {
    await expect(
      pin({ data: { eventId: '0x11', msgId: 'm1', pinned: true }, auth: ownerAuth } as never),
    ).rejects.toThrow('BAD_EVENT_ID');
    await expect(pin({ data: { msgId: 'm1', pinned: true }, auth: ownerAuth } as never)).rejects.toThrow(
      'BAD_EVENT_ID',
    );
    await expect(
      pin({ data: { eventId: '11', msgId: '../../users/uid-1', pinned: true }, auth: ownerAuth } as never),
    ).rejects.toThrow('BAD_MSG_ID');
    await expect(pin({ data: { eventId: '11', pinned: true }, auth: ownerAuth } as never)).rejects.toThrow(
      'BAD_MSG_ID',
    );
    await expect(pin({ data: { eventId: '11', msgId: 'm1', pinned: true } } as never)).rejects.toThrow(
      'AUTH_REQUIRED',
    );
    expect(writes).toEqual([]);
  });
});
