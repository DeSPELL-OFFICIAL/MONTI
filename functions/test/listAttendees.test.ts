import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpsError } from 'firebase-functions/v2/https';
import { getAddress } from 'viem';

process.env.GCP_PROJECT_ID = 'monti-dev';

/** 체크섬(대소문자 섞인) 주소. 체인이 돌려주는 주소와 대소문자만 다른 경우를 시험하는 자리다. */
const CALLER = getAddress('0xabcdefabcdefabcdefabcdefabcdefabcdefabcd');
const OWNER = '0x9999999999999999999999999999999999999999';

/**
 * eth_call 하나하나의 답. 인가는 전부 체인에서 읽으므로(우리 DB에는 역할이 없다)
 * 이 표를 갈아끼우는 것이 곧 "누구로 부르는가" 다.
 */
const chain = {
  orgId: 1n as bigint,
  owner: OWNER as string,
  manager: [false, false] as readonly [boolean, boolean],
  canCreateEvent: false,
};

type ReadArgs = { functionName: string; args?: readonly unknown[] };

const readContract = vi.fn(async ({ functionName }: ReadArgs) => {
  if (functionName === 'eventOrg') return chain.orgId;
  if (functionName === 'ownerOf') return chain.owner;
  if (functionName === 'managerOf') return chain.manager;
  if (functionName === 'hasPermission') return chain.canCreateEvent;
  throw new Error(`unexpected eth_call: ${functionName}`);
});

vi.mock('../src/lib/chain.js', () => ({
  publicClient: () => ({ readContract }),
  deployment: () => ({
    organizers: '0x2222222222222222222222222222222222222222',
    ticket: '0x3333333333333333333333333333333333333333',
  }),
}));

/** auth.ts 는 db.ts 를 끌고 오고 db.ts 는 import 시점에 firebase-admin 을 띄운다. 여기서는 필요 없다. */
vi.mock('../src/lib/db.js', () => ({ db: {}, PERSONS: 'persons', USERS: 'users' }));

/**
 * `resolveCallerAccount` 만 가짜로 바꾸고 나머지는 진짜를 쓴다.
 * 권한 비트를 여기에 베껴 적으면 `hasPermission` 에 실제로 실려 가는 값이 아무것도 고정되지 않는다.
 */
const resolveCallerAccount = vi.fn(async () => CALLER);
vi.mock('../src/lib/auth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/auth.js')>()),
  resolveCallerAccount,
}));

const { PERM_CREATE_EVENT } = await import('../src/lib/auth.js');

interface EnvioRow {
  id: string;
  tier: number;
  checkIn: { id: string } | null;
  identity: { nickname: string | null; kycLevel: number } | null;
}

/** 인덱서가 내려줄 쪽들. 테스트마다 갈아끼운다. */
let pages: EnvioRow[][] = [[]];

const envioQuery = vi.fn(async (_query: string, _variables?: Record<string, unknown>) => {
  const cursor = String((_variables as { cursor?: unknown } | undefined)?.cursor ?? '');
  // 커서 없는 첫 질의가 0쪽. 그 뒤로는 앞 쪽의 마지막 id 를 받은 만큼 넘어간다.
  const index = cursor === '' ? 0 : pages.findIndex((page) => page.at(-1)?.id === cursor) + 1;
  return { rows: pages[index] ?? [] };
});
vi.mock('../src/lib/envio.js', () => ({ envioQuery, envioPage: vi.fn(async () => []) }));

const { listAttendees, ATTENDEE_PAGE_SIZE } = await import('../src/functions/listAttendees.js');
const functionsTest = (await import('firebase-functions-test')).default();
const list = functionsTest.wrap(listAttendees);
const auth = { uid: 'uid-1', token: { account: CALLER } };

function call(data: Record<string, unknown> = { eventId: '11' }) {
  return list({ data, auth } as never) as Promise<Array<Record<string, unknown>>>;
}

function rowsOf(count: number, from = 1): EnvioRow[] {
  return Array.from({ length: count }, (_, i) => ({
    id: String(from + i),
    tier: 0,
    checkIn: null,
    identity: { nickname: 'alex', kycLevel: 1 },
  }));
}

beforeEach(() => {
  chain.orgId = 1n;
  chain.owner = OWNER;
  chain.manager = [false, false];
  chain.canCreateEvent = true;
  readContract.mockClear();
  resolveCallerAccount.mockClear();
  envioQuery.mockClear();
  pages = [
    [
      { id: '7', tier: 0, checkIn: { id: '7' }, identity: { nickname: 'alex', kycLevel: 1 } },
      { id: '8', tier: 1, checkIn: null, identity: null },
    ],
  ];
});

describe('listAttendees', () => {
  it('returns tokenId, nickname, checkedIn, tier and kycLevel and nothing else', async () => {
    const result = await call();
    expect(Array.isArray(result)).toBe(true);
    expect(result).toEqual([
      { tokenId: '7', nickname: 'alex', checkedIn: true, tier: 0, kycLevel: 1 },
      { tokenId: '8', nickname: '', checkedIn: false, tier: 1, kycLevel: 0 },
    ]);
  });

  it('carries no personal data beyond the nickname', async () => {
    const result = await call();
    for (const row of result) {
      expect(Object.keys(row).sort()).toEqual([
        'checkedIn',
        'kycLevel',
        'nickname',
        'tier',
        'tokenId',
      ]);
    }
    // `nickname` 은 허용된 유일한 사람 표시다. 그 밖의 이름·전화·사진·주소는 한 글자도 없어야 한다.
    expect(JSON.stringify(result)).not.toMatch(/phone|photo|person|account|owner|(?<!nick)name/i);
  });

  it('falls back to an empty nickname and kycLevel 0 when the indexer has no identity', async () => {
    pages = [[{ id: '9', tier: 2, checkIn: null, identity: { nickname: null, kycLevel: 0 } }]];
    await expect(call()).resolves.toEqual([
      { tokenId: '9', nickname: '', checkedIn: false, tier: 2, kycLevel: 0 },
    ]);
  });

  it('refuses a caller who is neither owner nor manager nor a PERM_CREATE_EVENT admin', async () => {
    chain.canCreateEvent = false;
    await expect(call()).rejects.toThrow('NOT_ORGANIZER');
    // 인가가 막힌 호출은 인덱서를 건드리지도 않는다.
    expect(envioQuery).not.toHaveBeenCalled();
  });

  it('lets the organisation owner through without any permission bit', async () => {
    chain.canCreateEvent = false;
    // 체인은 소문자로, 호출자는 체크섬으로 온다. 대소문자만 다른 같은 주소다.
    chain.owner = CALLER.toLowerCase();
    await expect(call()).resolves.toHaveLength(2);
  });

  it('lets a manager of the event organisation through', async () => {
    chain.canCreateEvent = false;
    chain.manager = [true, false];
    await expect(call()).resolves.toHaveLength(2);
  });

  it('reads the organisation from the chain, never from the indexer', async () => {
    await call();
    const argsOf = (name: string) =>
      readContract.mock.calls.find(([args]) => (args as ReadArgs).functionName === name)?.[0].args;
    // 공연 → 조직은 체인에서 찾고, 세 갈래 판정은 모두 그 orgId 와 호출자로 묻는다.
    expect(argsOf('eventOrg')).toEqual([11n]);
    expect(argsOf('ownerOf')).toEqual([1n]);
    expect(argsOf('managerOf')).toEqual([1n, CALLER]);
    expect(argsOf('hasPermission')).toEqual([1n, CALLER, PERM_CREATE_EVENT]);
  });

  it('asks for PERM_CREATE_EVENT, the bit Organizers.sol gives that name', async () => {
    // contracts/src/Organizers.sol:11 — `uint32 public constant PERM_CREATE_EVENT = 1;`
    expect(PERM_CREATE_EVENT).toBe(1);
    await call();
    const hasPermission = readContract.mock.calls
      .map(([args]) => args as ReadArgs)
      .filter((args) => args.functionName === 'hasPermission');
    // 한 비트만 묻는다. 마스크로 뭉쳐 물으면 hasPermission 이 "전부" 로 구현됐을 때 조용히 거부된다.
    expect(hasPermission).toHaveLength(1);
    expect(hasPermission[0]!.args?.[2]).toBe(1);
  });

  it('asks Hasura with a numeric eventId normalised to one decimal form', async () => {
    await call({ eventId: '011' });
    const [query, variables] = envioQuery.mock.calls[0]!;
    expect(query).toContain('$eventId: numeric!');
    expect(query).not.toContain('$eventId: String!');
    expect(variables).toMatchObject({ eventId: '11', cursor: '' });
  });

  it('walks every page with an id cursor so a big event is not silently cut off', async () => {
    pages = [rowsOf(ATTENDEE_PAGE_SIZE), rowsOf(3, ATTENDEE_PAGE_SIZE + 1)];
    const result = await call();
    expect(result).toHaveLength(ATTENDEE_PAGE_SIZE + 3);
    expect(envioQuery).toHaveBeenCalledTimes(2);
    expect(envioQuery.mock.calls[1]![1]).toMatchObject({ cursor: String(ATTENDEE_PAGE_SIZE) });
    expect(result.at(-1)).toMatchObject({ tokenId: String(ATTENDEE_PAGE_SIZE + 3) });
  });

  it('stops the whole list when the indexer hands back a kycLevel outside 0 | 1', async () => {
    pages = [[{ id: '9', tier: 0, checkIn: null, identity: { nickname: 'alex', kycLevel: 7 } }]];
    // 그 줄만 빼면 주최자 화면에서 표를 가진 사람이 소리 없이 사라진다. 크게 터뜨린다.
    await expect(call()).rejects.toThrow('BAD_KYC_LEVEL');
  });

  it('authenticates before it looks at the arguments', async () => {
    resolveCallerAccount.mockRejectedValueOnce(new HttpsError('unauthenticated', 'AUTH_REQUIRED'));
    await expect(call({ eventId: 'not-a-number' })).rejects.toThrow('AUTH_REQUIRED');
    expect(readContract).not.toHaveBeenCalled();
  });

  it('rejects an eventId that is not a decimal string', async () => {
    await expect(call({ eventId: '0x11' })).rejects.toThrow('BAD_EVENT_ID');
    await expect(call({})).rejects.toThrow('BAD_EVENT_ID');
  });
});
