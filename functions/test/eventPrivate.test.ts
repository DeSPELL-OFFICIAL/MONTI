import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';

process.env.GCP_PROJECT_ID = 'monti-dev';

const TICKET = '0x3333333333333333333333333333333333333333';
const ORGANIZERS = '0x2222222222222222222222222222222222222222';
/** 표를 들고 있는 관객. 숫자만 쓰는 주소라 EIP-55 정규화가 대소문자를 바꾸지 않는다. */
const HOLDER = '0x9999999999999999999999999999999999999999';
/** 조직 오너. **글자가 섞인** 주소다 — 체크섬을 빠뜨린 회귀는 이런 주소에서만 잡힌다. */
const OWNER = '0xDeaDbeefdEAdbeefdEadbEEFdeadbeEFdEaDbeeF';
/** `PERM_CREATE_EVENT(1)` 만 가진 관리자. */
const CREATOR_ADMIN = '0x8888888888888888888888888888888888888888';
const OUTSIDER = '0x7777777777777777777777777777777777777777';

// ───────────────────────────────────────────────────────── 가짜 Firestore
const docs = new Map<string, Record<string, unknown>>();
const writes: string[] = [];
const SERVER_TIMESTAMP = FieldValue.serverTimestamp();

function isServerTimestamp(value: unknown): boolean {
  const candidate = value as FieldValue | undefined;
  return typeof candidate?.isEqual === 'function' && candidate.isEqual(SERVER_TIMESTAMP);
}

function snapshot(path: string) {
  const data = docs.get(path);
  return { exists: data !== undefined, get: (field: string) => data?.[field], data: () => data };
}

function docRef(path: string) {
  return {
    path,
    get: async () => {
      reads.push(path);
      return snapshot(path);
    },
    // `set` 은 병합하지 않는다 — 콜러블의 약속과 같다.
    set: async (data: Record<string, unknown>) => {
      writes.push(path);
      docs.set(
        path,
        Object.fromEntries(
          Object.entries(data).map(([k, v]) => [k, isServerTimestamp(v) ? Timestamp.now() : v]),
        ),
      );
    },
  };
}

const reads: string[] = [];

vi.mock('../src/lib/db.js', () => ({
  EVENT_PRIVATE: 'eventPrivate',
  PERSONS: 'persons',
  USERS: 'users',
  db: { collection: (name: string) => ({ doc: (id: string) => docRef(`${name}/${id}`) }) },
}));

// ───────────────────────────────────────────────────────── 가짜 체인
/** eth_call 하나하나의 답. 인가는 전부 체인에서 읽으므로 이 표가 곧 "누구로 부르는가" 다. */
const chain = {
  balance: 1n,
  orgId: 5n,
  owner: OWNER.toLowerCase() as string,
  bits: new Map<string, number>(),
};
const calls: Array<{ functionName: string; args: readonly unknown[] }> = [];

vi.mock('../src/lib/chain.js', () => ({
  deployment: () => ({ ticket: TICKET, organizers: ORGANIZERS }),
  publicClient: () => ({
    readContract: async ({ functionName, args }: { functionName: string; args: readonly unknown[] }) => {
      calls.push({ functionName, args });
      if (functionName === 'balanceOfEvent') return chain.balance;
      if (functionName === 'eventOrg') return chain.orgId;
      if (functionName === 'ownerOf') return chain.owner;
      if (functionName === 'hasPermission') {
        const [, account, bit] = args as [bigint, string, number];
        return ((chain.bits.get(account.toLowerCase()) ?? 0) & bit) === bit && bit !== 0;
      }
      throw new Error(`UNEXPECTED_READ:${functionName}`);
    },
  }),
}));

/** 거절 로그에 무엇이 실리는지 직접 본다 — 숨긴 장소가 로그로 새면 숨긴 뜻이 없다. */
const warn = vi.fn();
vi.mock('firebase-functions/logger', () => ({ warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() }));

/** 호출자는 언제나 세션에서 온다 — 요청 본문의 주소는 어디에서도 읽지 않는다. */
let caller = HOLDER;
vi.mock('../src/lib/auth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/auth.js')>()),
  resolveCallerAccount: vi.fn(async () => caller),
}));

// 운영에서는 `lib/chain.js` 가 `../config.js` 를 끌어와 트리거 정의 전에 `setGlobalOptions` 를
// 돌린다. 그 chain 이 위에서 mock 되므로 여기서 직접 불러 리전 순서를 실제 배포와 맞춘다.
await import('../src/config.js');
const { MAX_PRIVATE_NOTE_CHARS, MAX_PRIVATE_VENUE_CHARS, getEventPrivate, setEventPrivate } =
  await import('../src/functions/eventPrivate.js');
const functionsTest = (await import('firebase-functions-test')).default();

const get = functionsTest.wrap(getEventPrivate);
const set = functionsTest.wrap(setEventPrivate);

const auth = { uid: 'uid-1' };
const VENUE = '올림픽공원 K-아트홀 3층';
const NOTE = '지하 1층 후문으로 오세요. 엘리베이터는 B동에 있습니다.';

function names(): string[] {
  return calls.map((call) => call.functionName);
}

beforeEach(() => {
  docs.clear();
  writes.length = 0;
  reads.length = 0;
  calls.length = 0;
  warn.mockReset();
  caller = HOLDER;
  chain.balance = 1n;
  chain.orgId = 5n;
  chain.owner = OWNER.toLowerCase();
  chain.bits.clear();
  chain.bits.set(CREATOR_ADMIN.toLowerCase(), 1); // PERM_CREATE_EVENT
  docs.set('eventPrivate/11', { venue: VENUE, note: NOTE });
});

describe('getEventPrivate', () => {
  it('gives the venue and the note to somebody holding a ticket', async () => {
    await expect(get({ data: { eventId: '11' }, auth } as never)).resolves.toEqual({
      venue: VENUE,
      note: NOTE,
    });
  });

  /** 보유자가 대부분이다. 통과하는 흔한 길에서 주최자 질문 세 개를 던지지 않는다. */
  it('asks the chain for the balance alone when the caller holds a ticket', async () => {
    await get({ data: { eventId: '11' }, auth } as never);
    expect(names()).toEqual(['balanceOfEvent']);
    expect(calls[0]?.args).toEqual([HOLDER, 11n]);
  });

  it('lets the organizer read their own event without holding a ticket', async () => {
    chain.balance = 0n;
    caller = OWNER;
    await expect(get({ data: { eventId: '11' }, auth } as never)).resolves.toEqual({
      venue: VENUE,
      note: NOTE,
    });
    expect(names()).toContain('eventOrg');
  });

  it('lets an admin holding PERM_CREATE_EVENT read it, and asks with that exact bit', async () => {
    chain.balance = 0n;
    caller = CREATOR_ADMIN;
    await expect(get({ data: { eventId: '11' }, auth } as never)).resolves.toMatchObject({
      venue: VENUE,
    });
    expect(calls).toContainEqual({ functionName: 'hasPermission', args: [5n, CREATOR_ADMIN, 1] });
  });

  /**
   * 표를 넘긴 사람은 **다음 호출부터 바로** 막힌다. 거울 문서였다면 낡은 거울이
   * 장소를 계속 열어 줬을 자리다(계획 B-1).
   */
  it('refuses somebody who holds no ticket, and never reads the document', async () => {
    chain.balance = 0n;
    caller = OUTSIDER;
    await expect(get({ data: { eventId: '11' }, auth } as never)).rejects.toThrow('NOT_HOLDER');
    expect(reads).toEqual([]);
  });

  it('logs a rejection with the code and the reason alone — never the venue', async () => {
    chain.balance = 0n;
    caller = OUTSIDER;
    await expect(get({ data: { eventId: '11' }, auth } as never)).rejects.toThrow('NOT_HOLDER');
    expect(warn).toHaveBeenCalledWith('eventPrivate.rejected', {
      code: 'permission-denied',
      reason: 'NOT_HOLDER',
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('올림픽공원');
    expect(JSON.stringify(warn.mock.calls)).not.toContain(OUTSIDER);
  });

  it('returns an empty object rather than empty strings when nothing is stored', async () => {
    docs.delete('eventPrivate/11');
    await expect(get({ data: { eventId: '11' }, auth } as never)).resolves.toEqual({});
    docs.set('eventPrivate/11', { venue: '', note: '' });
    await expect(get({ data: { eventId: '11' }, auth } as never)).resolves.toEqual({});
  });

  it('reads "011" and "11" as the same event', async () => {
    await expect(get({ data: { eventId: '011' }, auth } as never)).resolves.toMatchObject({
      venue: VENUE,
    });
    expect(reads).toEqual(['eventPrivate/11']);
  });

  it('refuses a malformed or absent event id', async () => {
    for (const eventId of [undefined, '', '0x11', '11n', 11, '１１']) {
      await expect(get({ data: { eventId }, auth } as never)).rejects.toThrow('BAD_EVENT_ID');
    }
    expect(calls).toEqual([]);
  });

  it('refuses an unauthenticated caller before it looks at the arguments', async () => {
    const { resolveCallerAccount } = await import('../src/lib/auth.js');
    vi.mocked(resolveCallerAccount).mockRejectedValueOnce(new Error('AUTH_REQUIRED'));
    await expect(get({ data: { eventId: '11' } } as never)).rejects.toThrow('AUTH_REQUIRED');
    expect(calls).toEqual([]);
  });
});

describe('setEventPrivate', () => {
  it('lets the organizer overwrite the venue and the note, trimmed', async () => {
    caller = OWNER;
    await expect(
      set({ data: { eventId: '11', venue: `  ${VENUE}  `, note: `  ${NOTE}  ` }, auth } as never),
    ).resolves.toEqual({ ok: true });
    expect(docs.get('eventPrivate/11')).toMatchObject({ venue: VENUE, note: NOTE });
  });

  /** 공개 뒤에도 고칠 수 있는 것은 이 문서뿐이다 — 체인도 IPFS 도 그때는 얼어 있다. */
  it('replaces the record instead of merging, so a field can be cleared', async () => {
    caller = OWNER;
    await set({ data: { eventId: '11', note: NOTE }, auth } as never);
    const stored = docs.get('eventPrivate/11') as Record<string, unknown>;
    expect('venue' in stored).toBe(false);
    expect(stored.note).toBe(NOTE);
  });

  it('refuses a caller who is not an organizer, and writes nothing', async () => {
    caller = OUTSIDER;
    await expect(set({ data: { eventId: '11', venue: VENUE }, auth } as never)).rejects.toThrow(
      'NOT_ORGANIZER',
    );
    expect(writes).toEqual([]);
  });

  /** 표를 들고 있는 것과 고칠 수 있는 것은 다른 일이다. */
  it('refuses a ticket holder who is not the organizer', async () => {
    chain.balance = 1n;
    caller = HOLDER;
    await expect(set({ data: { eventId: '11', venue: VENUE }, auth } as never)).rejects.toThrow(
      'NOT_ORGANIZER',
    );
    expect(writes).toEqual([]);
  });

  it('takes a 200 character venue and a 500 character note, and refuses one longer', async () => {
    caller = OWNER;
    const venue = '가'.repeat(MAX_PRIVATE_VENUE_CHARS);
    const note = '나'.repeat(MAX_PRIVATE_NOTE_CHARS);
    await expect(set({ data: { eventId: '11', venue, note }, auth } as never)).resolves.toEqual({
      ok: true,
    });

    writes.length = 0;
    await expect(
      set({ data: { eventId: '11', venue: `${venue}가` }, auth } as never),
    ).rejects.toThrow('BAD_VENUE');
    await expect(set({ data: { eventId: '11', note: `${note}나` }, auth } as never)).rejects.toThrow(
      'BAD_NOTE',
    );
    await expect(set({ data: { eventId: '11', venue: 7 }, auth } as never)).rejects.toThrow(
      'BAD_VENUE',
    );
    expect(writes).toEqual([]);
  });

  it('counts the limits in code points, so emoji do not halve the allowance', async () => {
    caller = OWNER;
    await expect(
      set({ data: { eventId: '11', venue: '🎉'.repeat(MAX_PRIVATE_VENUE_CHARS) }, auth } as never),
    ).resolves.toEqual({ ok: true });
  });

  it('writes "011" and "11" to the same document', async () => {
    caller = OWNER;
    await set({ data: { eventId: '011', venue: VENUE }, auth } as never);
    expect(writes).toEqual(['eventPrivate/11']);
  });

  it('never logs the venue when it rejects one for being too long', async () => {
    caller = OWNER;
    await expect(
      set({ data: { eventId: '11', venue: `${VENUE}${'가'.repeat(MAX_PRIVATE_VENUE_CHARS)}` }, auth } as never),
    ).rejects.toThrow('BAD_VENUE');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('올림픽공원');
  });
});
