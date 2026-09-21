import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { CHAT_CLOSE_SCHEDULE, FIREBASE_REGION } from '@monti/shared';

process.env.GCP_PROJECT_ID = 'monti-dev';

const TICKET = '0x3333333333333333333333333333333333333333';
/** 채팅에 들어오려는 사람. 숫자만 쓰는 주소라 EIP-55 체크섬이 대소문자를 바꾸지 않는다. */
const ACCOUNT = '0x9999999999999999999999999999999999999999';
const PUBLISHED = 1;
const ENDED = 3;

/**
 * `eventChats` 한 컬렉션과 그 하위 컬렉션만 흉내 내는 가짜 Firestore.
 * 에뮬레이터 없이 `pnpm test` 안에서 돈다(transferInvites.test.ts 와 같은 패턴).
 */
const docs = new Map<string, Record<string, unknown>>();
/** 쓰기가 일어난 경로. "이미 닫힌 채팅은 건드리지 않는다" 를 여기서 본다. */
const writes: string[] = [];

const SERVER_TIMESTAMP = FieldValue.serverTimestamp();

function isServerTimestamp(value: unknown): boolean {
  const candidate = value as FieldValue | undefined;
  return typeof candidate?.isEqual === 'function' && candidate.isEqual(SERVER_TIMESTAMP);
}

function write(path: string, data: Record<string, unknown>, options?: { merge?: boolean }): void {
  writes.push(path);
  const previous = options?.merge ? (docs.get(path) ?? {}) : {};
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
    ref: docRef(path),
    get: (field: string) => data?.[field],
    data: () => data,
  };
}

function docRef(path: string) {
  return {
    path,
    id: path.slice(path.lastIndexOf('/') + 1),
    get: async () => snapshot(path),
    set: async (data: Record<string, unknown>, options?: { merge?: boolean }) => {
      write(path, data, options);
    },
    update: async (data: Record<string, unknown>) => {
      if (!docs.has(path)) throw new Error(`NOT_FOUND:${path}`);
      write(path, data, { merge: true });
    },
  };
}

type Filter = [field: string, op: string, value: unknown];

function matches(data: Record<string, unknown>, [field, op, value]: Filter): boolean {
  const actual = data[field];
  if (op === '==') return actual === value;
  if (op === '<') return (actual as number) < (value as number);
  throw new Error(`UNSUPPORTED_OP:${op}`);
}

function query(name: string, filters: Filter[], max: number) {
  return {
    where: (field: string, op: string, value: unknown) =>
      query(name, [...filters, [field, op, value]], max),
    limit: (n: number) => query(name, filters, n),
    get: async () => {
      const matched = [...docs.entries()]
        // 하위 컬렉션(`eventChats/11/members/uid-1`)은 루트 질의에 걸리지 않는다.
        .filter(([path]) => path.startsWith(`${name}/`) && path.split('/').length === 2)
        .filter(([, data]) => filters.every((filter) => matches(data, filter)))
        .slice(0, max)
        .map(([path]) => snapshot(path));
      return { docs: matched, size: matched.length, empty: matched.length === 0 };
    },
  };
}

function collection(name: string) {
  return {
    ...query(name, [], Number.POSITIVE_INFINITY),
    doc: (id: string) => docRef(`${name}/${id}`),
  };
}

vi.mock('../src/lib/db.js', () => ({
  EVENT_CHATS: 'eventChats',
  db: {
    collection,
    doc: (path: string) => docRef(path),
    runTransaction: async <T>(body: (tx: unknown) => Promise<T>): Promise<T> => {
      const pending: Array<() => void> = [];
      const tx = {
        get: async (ref: { path: string }) => snapshot(ref.path),
        update: (ref: { path: string }, data: Record<string, unknown>) => {
          pending.push(() => write(ref.path, data, { merge: true }));
        },
      };
      const result = await body(tx);
      for (const apply of pending) apply();
      return result;
    },
  },
}));

/** 체인 상태. 세 값 모두 eth_call 로만 읽는다 — DB에는 권한의 원본이 없다. */
const chain = { balance: 1n, status: PUBLISHED, endsAt: 0n, orgId: 1n };
const reads: Array<{ functionName: string; args: readonly unknown[] }> = [];

vi.mock('../src/lib/chain.js', () => ({
  deployment: () => ({ ticket: TICKET }),
  publicClient: () => ({
    readContract: async ({
      functionName,
      args,
    }: {
      functionName: string;
      args: readonly unknown[];
    }) => {
      reads.push({ functionName, args });
      if (functionName === 'balanceOfEvent') return chain.balance;
      if (functionName === 'eventStatus') return chain.status;
      if (functionName === 'eventMeta') return { orgId: chain.orgId, endsAt: chain.endsAt };
      throw new Error(`UNEXPECTED_READ:${functionName}`);
    },
  }),
}));

vi.mock('../src/lib/auth.js', () => ({
  resolveCallerAccount: vi.fn(async () => ACCOUNT),
}));

// 운영에서는 `lib/chain.js` 가 `../config.js` 를 끌어와 트리거 정의 전에
// `setGlobalOptions` 를 돌린다. 그 chain 이 위에서 mock 되므로 여기서 직접 불러
// 리전이 실제 배포와 같은 순서로 붙게 한다.
await import('../src/config.js');
const { joinEventChat, reportMessage, closeEndedChats } = await import(
  '../src/functions/eventChat.js'
);
const functionsTest = (await import('firebase-functions-test')).default();

const join = functionsTest.wrap(joinEventChat);
const report = functionsTest.wrap(reportMessage);
const closeChats = functionsTest.wrap(closeEndedChats);

/** 호출자는 언제나 세션에서 나온다 — 요청 본문의 주소는 어디에서도 읽지 않는다. */
const auth = { uid: 'uid-1', token: { account: ACCOUNT } };
const otherAuth = { uid: 'uid-2', token: { account: ACCOUNT } };

function now(): number {
  return Math.floor(Date.now() / 1000);
}

beforeEach(() => {
  docs.clear();
  writes.length = 0;
  reads.length = 0;
  chain.balance = 1n;
  chain.status = PUBLISHED;
  chain.endsAt = BigInt(now() + 3600);
  chain.orgId = 1n;
});

describe('joinEventChat', () => {
  it('adds a member when the caller holds a ticket for a published, unfinished event', async () => {
    await join({ data: { eventId: '11' }, auth } as never);

    const member = snapshot('eventChats/11/members/uid-1');
    expect(member.exists).toBe(true);
    expect(member.get('account')).toBe(ACCOUNT);
    const chat = snapshot('eventChats/11');
    expect(chat.get('closed')).toBe(false);
    expect(chat.get('endsAt')).toBe(Number(chain.endsAt));
    expect(chat.get('orgId')).toBe('1');
  });

  it('reads the three conditions from the chain, never from Firestore', async () => {
    await join({ data: { eventId: '11' }, auth } as never);

    expect(reads.map((read) => read.functionName).sort()).toEqual([
      'balanceOfEvent',
      'eventMeta',
      'eventStatus',
    ]);
    expect(reads.find((read) => read.functionName === 'balanceOfEvent')?.args).toEqual([
      ACCOUNT,
      11n,
    ]);
  });

  it('stores only the account and a join timestamp — no phone, no name', async () => {
    await join({ data: { eventId: '11' }, auth } as never);

    expect(Object.keys(snapshot('eventChats/11/members/uid-1').data() ?? {}).sort()).toEqual([
      'account',
      'joinedAt',
    ]);
    expect(Object.keys(snapshot('eventChats/11').data() ?? {}).sort()).toEqual([
      'closed',
      'endsAt',
      'orgId',
    ]);
  });

  it('refuses a caller with no ticket for the event', async () => {
    chain.balance = 0n;
    await expect(join({ data: { eventId: '11' }, auth } as never)).rejects.toThrow(
      'NO_TICKET_FOR_EVENT',
    );
    expect(docs.has('eventChats/11/members/uid-1')).toBe(false);
  });

  it('refuses an event that is not Published', async () => {
    chain.status = ENDED;
    await expect(join({ data: { eventId: '11' }, auth } as never)).rejects.toThrow(
      'EVENT_NOT_PUBLISHED',
    );
  });

  it('refuses an event whose end time has passed', async () => {
    chain.endsAt = BigInt(now() - 1);
    await expect(join({ data: { eventId: '11' }, auth } as never)).rejects.toThrow('EVENT_ENDED');
  });

  it('refuses an anonymous caller and a malformed event id', async () => {
    await expect(join({ data: { eventId: '11' } } as never)).rejects.toThrow('AUTH_REQUIRED');
    await expect(join({ data: { eventId: '0x11' }, auth } as never)).rejects.toThrow('BAD_EVENT_ID');
    await expect(join({ data: {}, auth } as never)).rejects.toThrow('BAD_EVENT_ID');
    expect(reads).toHaveLength(0);
  });

  it('is idempotent — joining twice leaves one member with the same account', async () => {
    await join({ data: { eventId: '11' }, auth } as never);
    await expect(join({ data: { eventId: '11' }, auth } as never)).resolves.toEqual({ ok: true });

    expect(snapshot('eventChats/11/members/uid-1').get('account')).toBe(ACCOUNT);
    expect([...docs.keys()].filter((path) => path.startsWith('eventChats/11/members/'))).toEqual([
      'eventChats/11/members/uid-1',
    ]);
  });

  it('refuses a closed chat instead of reopening it', async () => {
    write('eventChats/11', { closed: true, endsAt: now() + 3600, orgId: '1' });
    writes.length = 0;

    await expect(join({ data: { eventId: '11' }, auth } as never)).rejects.toThrow('CHAT_CLOSED');
    expect(snapshot('eventChats/11').get('closed')).toBe(true);
    expect(writes).toEqual([]);
  });
});

describe('reportMessage', () => {
  beforeEach(async () => {
    await join({ data: { eventId: '11' }, auth } as never);
    write('eventChats/11/messages/m1', { uid: 'uid-2', text: 'hi', createdAt: 1, reported: 0 });
  });

  it('increments the report counter', async () => {
    const result = (await report({ data: { eventId: '11', msgId: 'm1' }, auth } as never)) as {
      reported: number;
    };

    expect(result.reported).toBe(1);
    expect(snapshot('eventChats/11/messages/m1').get('reported')).toBe(1);
  });

  it('counts a second report on top of the first', async () => {
    await report({ data: { eventId: '11', msgId: 'm1' }, auth } as never);
    const result = (await report({ data: { eventId: '11', msgId: 'm1' }, auth } as never)) as {
      reported: number;
    };

    expect(result.reported).toBe(2);
  });

  it('leaves the message text alone — a report never edits what was said', async () => {
    await report({ data: { eventId: '11', msgId: 'm1' }, auth } as never);

    const message = snapshot('eventChats/11/messages/m1');
    expect(message.get('text')).toBe('hi');
    expect(message.get('uid')).toBe('uid-2');
  });

  it('refuses somebody who never joined the chat', async () => {
    await expect(
      report({ data: { eventId: '11', msgId: 'm1' }, auth: otherAuth } as never),
    ).rejects.toThrow('NOT_A_MEMBER');
    expect(snapshot('eventChats/11/messages/m1').get('reported')).toBe(0);
  });

  it('refuses an anonymous caller and missing arguments', async () => {
    await expect(report({ data: { eventId: '11', msgId: 'm1' } } as never)).rejects.toThrow(
      'AUTH_REQUIRED',
    );
    await expect(report({ data: { eventId: '11' }, auth } as never)).rejects.toThrow('BAD_ARGS');
    await expect(report({ data: { msgId: 'm1' }, auth } as never)).rejects.toThrow('BAD_ARGS');
  });

  it('reports a message that is not there as not found', async () => {
    await expect(report({ data: { eventId: '11', msgId: 'gone' }, auth } as never)).rejects.toThrow(
      'MESSAGE_NOT_FOUND',
    );
  });
});

describe('closeEndedChats', () => {
  it('closes chats whose event has ended and leaves running ones open', async () => {
    write('eventChats/11', { closed: false, endsAt: now() + 3600, orgId: '1' });
    write('eventChats/12', { closed: false, endsAt: 1, orgId: '1' });

    await closeChats({} as never);

    expect(snapshot('eventChats/12').get('closed')).toBe(true);
    expect(snapshot('eventChats/11').get('closed')).toBe(false);
  });

  it('skips a chat that is already closed', async () => {
    write('eventChats/12', { closed: true, endsAt: 1, orgId: '1' });
    writes.length = 0;

    await closeChats({} as never);

    expect(writes).toEqual([]);
  });

  it('never touches the members or messages under a chat', async () => {
    write('eventChats/12', { closed: false, endsAt: 1, orgId: '1' });
    write('eventChats/12/members/uid-1', { account: ACCOUNT, joinedAt: 1 });
    writes.length = 0;

    await closeChats({} as never);

    expect(writes).toEqual(['eventChats/12']);
    expect(snapshot('eventChats/12/members/uid-1').get('account')).toBe(ACCOUNT);
  });

  it('writes nothing at all when no event has ended', async () => {
    write('eventChats/11', { closed: false, endsAt: now() + 3600, orgId: '1' });
    writes.length = 0;

    await closeChats({} as never);

    expect(writes).toEqual([]);
  });

  it('runs every ten minutes in the deployed region', () => {
    const endpoint = (closeEndedChats as unknown as { __endpoint: Record<string, unknown> })
      .__endpoint;
    expect(endpoint.scheduleTrigger).toMatchObject({
      schedule: CHAT_CLOSE_SCHEDULE,
      timeZone: 'Asia/Seoul',
    });
    expect(CHAT_CLOSE_SCHEDULE).toBe('every 10 minutes');
    expect(endpoint.region).toEqual([FIREBASE_REGION]);
  });
});
