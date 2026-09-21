import { beforeEach, describe, expect, it, vi } from 'vitest';
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

const resolveCallerAccount = vi.fn(async () => CALLER);
vi.mock('../src/lib/auth.js', () => ({ resolveCallerAccount, PERM_CREATE_EVENT: 1 }));

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
    const names = readContract.mock.calls.map(([args]) => (args as ReadArgs).functionName);
    expect(names).toContain('eventOrg');
    expect(names).toContain('ownerOf');
    expect(names).toContain('managerOf');
    expect(names).toContain('hasPermission');
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

  it('rejects an eventId that is not a decimal string', async () => {
    await expect(call({ eventId: '0x11' })).rejects.toThrow('BAD_EVENT_ID');
    await expect(call({})).rejects.toThrow('BAD_EVENT_ID');
  });
});
