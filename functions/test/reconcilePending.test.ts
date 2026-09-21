import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { getAddress } from 'viem';
import { FIREBASE_REGION } from '@monti/shared';

process.env.GCP_PROJECT_ID = 'monti-dev';

const IDENTITY = '0x1111111111111111111111111111111111111111';
const ZERO = '0x0000000000000000000000000000000000000000';
/** 소문자로만 적힌 주소. 클레임에 체크섬이 박히는지 보려면 원본이 체크섬이 아니어야 한다. */
const ACCOUNT = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
const ON_CHAIN = '0xfedcbafedcbafedcbafedcbafedcbafedcbafedc';
const P1 = `0x${'a1'.repeat(32)}`;
const P2 = `0x${'a2'.repeat(32)}`;
const P3 = `0x${'a3'.repeat(32)}`;
const TX = '0xaa';

/**
 * persons / users / transferInvites / authChallenges 네 컬렉션만 흉내 내는 가짜 Firestore.
 * `pnpm test` 는 에뮬레이터 없이 돌기 때문에(vitest.config.ts) registerIdentity.test.ts 와
 * eventChat.test.ts 가 쓰는 것과 같은 패턴을 그대로 쓴다. 중첩 맵 merge 와
 * `FieldValue.delete()` 는 진짜 Firestore 와 똑같이 움직여야 한다 — `chain.registerTx` 를
 * 지우면서 `chain.block` 까지 날리면 이 함수의 복구가 거꾸로 데이터를 지운다.
 */
const docs = new Map<string, Record<string, unknown>>();
/** 쓰기가 일어난 경로. "건드릴 것이 없으면 아무것도 쓰지 않는다" 를 여기서 본다. */
const writes: string[] = [];
/** 삭제된 경로. 챌린지 청소는 삭제로만 일어난다. */
const deletes: string[] = [];
/** 질의 기록. 스윕별 상한(200)을 여기서 확인한다. */
const queries: Array<{ name: string; filters: Filter[]; max: number }> = [];
/** 이 컬렉션의 질의는 터진다 — 스윕 하나가 죽어도 다음 스윕이 도는지 보는 장치. */
const failQuery = new Set<string>();

const setCustomUserClaims = vi.fn(async (_uid: string, _claims: Record<string, unknown>) => {});

const DELETE = FieldValue.delete();
const SERVER_TIMESTAMP = FieldValue.serverTimestamp();

function isSentinel(value: unknown, sentinel: FieldValue): boolean {
  const candidate = value as FieldValue | undefined;
  return typeof candidate?.isEqual === 'function' && candidate.isEqual(sentinel);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

function deepMerge(
  target: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out = { ...target };
  for (const [key, value] of Object.entries(patch)) {
    if (isSentinel(value, DELETE)) {
      delete out[key];
    } else if (isSentinel(value, SERVER_TIMESTAMP)) {
      out[key] = Timestamp.now();
    } else if (isPlainObject(value)) {
      const previous = out[key];
      out[key] = deepMerge(
        previous && typeof previous === 'object' ? (previous as Record<string, unknown>) : {},
        value as Record<string, unknown>,
      );
    } else {
      out[key] = value;
    }
  }
  return out;
}

function write(path: string, data: Record<string, unknown>, options?: { merge?: boolean }): void {
  writes.push(path);
  docs.set(path, deepMerge(options?.merge ? (docs.get(path) ?? {}) : {}, data));
}

/** 실제 Firestore 처럼 `a.b` 점 경로를 읽는다. */
function field(data: Record<string, unknown> | undefined, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], data);
}

function snapshot(path: string) {
  const data = docs.get(path);
  return {
    exists: data !== undefined,
    id: path.slice(path.indexOf('/') + 1),
    ref: docRef(path),
    get: (name: string) => field(data, name),
    data: () => data,
  };
}

function docRef(path: string) {
  return {
    path,
    id: path.slice(path.indexOf('/') + 1),
    get: async () => snapshot(path),
    set: async (data: Record<string, unknown>, options?: { merge?: boolean }) => {
      write(path, data, options);
    },
    delete: async () => {
      deletes.push(path);
      docs.delete(path);
    },
  };
}

type Filter = [field: string, op: string, value: unknown];

function comparable(value: unknown): number {
  return value instanceof Timestamp ? value.toMillis() : (value as number);
}

function matches(data: Record<string, unknown>, [name, op, value]: Filter): boolean {
  const actual = data[name];
  if (op === '==') return actual === value;
  if (op === 'in') return (value as unknown[]).includes(actual);
  if (op === '<') return actual !== undefined && comparable(actual) < comparable(value);
  throw new Error(`UNSUPPORTED_OP:${op}`);
}

function query(name: string, filters: Filter[], max: number) {
  return {
    where: (f: string, op: string, value: unknown) => query(name, [...filters, [f, op, value]], max),
    limit: (n: number) => query(name, filters, n),
    get: async () => {
      queries.push({ name, filters, max });
      if (failQuery.has(name)) throw new Error(`FIRESTORE_UNAVAILABLE:${name}`);
      const matched = [...docs.entries()]
        .filter(([path]) => path.startsWith(`${name}/`))
        .filter(([, data]) => filters.every((filter) => matches(data, filter)))
        .slice(0, max)
        .map(([path]) => snapshot(path));
      return { docs: matched, size: matched.length, empty: matched.length === 0 };
    },
  };
}

vi.mock('../src/lib/db.js', async () => {
  const real = await vi.importActual<typeof import('../src/lib/db.js')>('../src/lib/db.js');
  return {
    PERSONS: 'persons',
    USERS: 'users',
    TRANSFER_INVITES: 'transferInvites',
    AUTH_CHALLENGES: 'authChallenges',
    assertStatusTransition: real.assertStatusTransition,
    authAdmin: { setCustomUserClaims },
    db: {
      collection: (name: string) => ({
        ...query(name, [], Number.POSITIVE_INFINITY),
        doc: (id: string) => docRef(`${name}/${id}`),
      }),
    },
  };
});

const getTransactionReceipt = vi.fn(async (_args: { hash: string }) => ({
  status: 'success',
  blockNumber: 100n,
}));
const getBlock = vi.fn(async (_args: { blockTag: string }) => ({ number: 200n }));
const readContract = vi.fn(async (_args: { functionName: string }) => ZERO as string);

vi.mock('../src/lib/chain.js', () => ({
  publicClient: () => ({ getTransactionReceipt, getBlock, readContract }),
  deployment: () => ({ identity: IDENTITY }),
}));

// 운영에서는 `lib/chain.js` 가 `../config.js` 를 끌어와 트리거 정의 전에 `setGlobalOptions` 를
// 돌린다. 그 chain 이 위에서 mock 되므로 여기서 직접 불러 리전이 배포와 같은 순서로 붙게 한다.
await import('../src/config.js');
const { reconcilePending } = await import('../src/functions/reconcilePending.js');
const functionsTest = (await import('firebase-functions-test')).default();
const run = functionsTest.wrap(reconcilePending);

function seconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** 2분 넘게 멈춰 있던 문서만 스윕에 걸린다. */
function stale(): Timestamp {
  return Timestamp.fromMillis(Date.now() - 5 * 60 * 1000);
}

function seedPerson(personId: string, data: Record<string, unknown>): void {
  write(`persons/${personId}`, { updatedAt: stale(), ...data });
}

beforeEach(() => {
  docs.clear();
  writes.length = 0;
  deletes.length = 0;
  queries.length = 0;
  failQuery.clear();
  setCustomUserClaims.mockClear();
  getTransactionReceipt.mockReset();
  getTransactionReceipt.mockResolvedValue({ status: 'success', blockNumber: 100n });
  getBlock.mockReset();
  getBlock.mockResolvedValue({ number: 200n });
  readContract.mockReset();
  readContract.mockResolvedValue(ZERO);
  write('users/uid-1', { personId: P1 });
  write('users/uid-2', { personId: P2 });
  write('users/uid-3', { personId: P3 });
  writes.length = 0;
});

describe('reconcilePending — 멈춘 계정 등록', () => {
  it('promotes a pending person whose register tx is finalized', async () => {
    seedPerson(P1, { status: 'pending', account: ACCOUNT, chain: { registerTx: TX } });

    await run({} as never);

    const person = snapshot(`persons/${P1}`);
    expect(person.get('status')).toBe('active');
    expect(person.get('chain.block')).toBe(100);
    // 해시는 남는다 — registerIdentity 의 멱등 ① 이 이 값을 읽는다.
    expect(person.get('chain.registerTx')).toBe(TX);
  });

  it('mints the same session claims registerIdentity would have minted', async () => {
    seedPerson(P1, { status: 'pending', account: ACCOUNT, chain: { registerTx: TX } });

    await run({} as never);

    expect(setCustomUserClaims).toHaveBeenCalledTimes(1);
    expect(setCustomUserClaims.mock.calls[0]).toEqual([
      'uid-1',
      { personId: P1, account: getAddress(ACCOUNT) },
    ]);
  });

  it('never puts a phone number or anything else into the claims', async () => {
    seedPerson(P1, { status: 'pending', account: ACCOUNT, chain: { registerTx: TX } });
    write(`users/uid-1`, { personId: P1, phoneHmac: 'deadbeef' });

    await run({} as never);

    expect(Object.keys(setCustomUserClaims.mock.calls[0]![1]).sort()).toEqual([
      'account',
      'personId',
    ]);
  });

  it('clears a dropped register transaction so the client can retry', async () => {
    getTransactionReceipt.mockRejectedValue(new Error('not found'));
    seedPerson(P2, {
      status: 'pending',
      account: ACCOUNT,
      chain: { registerTx: '0xbb', registerPending: true, registerPendingAt: 1 },
    });

    await run({} as never);

    const person = snapshot(`persons/${P2}`);
    expect(person.get('status')).toBe('pending');
    expect(person.get('chain.registerTx')).toBeUndefined();
    // 딱지까지 풀어야 registerIdentity 가 다시 보낼 수 있다.
    expect(person.get('chain.registerPending')).toBeUndefined();
    expect(person.get('chain.registerPendingAt')).toBeUndefined();
    expect(setCustomUserClaims).not.toHaveBeenCalled();
  });

  it('keeps a reverted registration pending and remembers the failed hash', async () => {
    getTransactionReceipt.mockResolvedValue({ status: 'reverted', blockNumber: 100n });
    seedPerson(P2, { status: 'pending', account: ACCOUNT, chain: { registerTx: '0xbb' } });

    await run({} as never);

    const person = snapshot(`persons/${P2}`);
    expect(person.get('status')).toBe('pending');
    expect(person.get('chain.registerTx')).toBeUndefined();
    expect(person.get('chain.lastFailedTx')).toBe('0xbb');
    expect(setCustomUserClaims).not.toHaveBeenCalled();
  });

  it('waits while the receipt block is not finalized yet', async () => {
    getBlock.mockResolvedValue({ number: 50n });
    seedPerson(P1, { status: 'pending', account: ACCOUNT, chain: { registerTx: TX } });
    writes.length = 0;

    await run({} as never);

    expect(snapshot(`persons/${P1}`).get('status')).toBe('pending');
    expect(writes).toEqual([]);
  });

  it('repairs a person the chain already knows even with no stored tx', async () => {
    readContract.mockResolvedValue(ON_CHAIN);
    seedPerson(P3, { status: 'pending' });

    await run({} as never);

    expect(snapshot(`persons/${P3}`).get('status')).toBe('active');
    expect(readContract.mock.calls[0]![0]).toMatchObject({
      address: IDENTITY,
      functionName: 'accountOf',
    });
    // 계정 주소의 원본은 체인이다 — DB 에 아무것도 없어도 클레임을 심을 수 있다.
    expect(setCustomUserClaims.mock.calls[0]).toEqual([
      'uid-3',
      { personId: P3, account: getAddress(ON_CHAIN) },
    ]);
  });

  it('leaves a pending person alone when the chain has no account either', async () => {
    seedPerson(P3, { status: 'pending' });
    writes.length = 0;

    await run({} as never);

    expect(snapshot(`persons/${P3}`).get('status')).toBe('pending');
    expect(writes).toEqual([]);
    expect(setCustomUserClaims).not.toHaveBeenCalled();
  });

  it('only scans persons that are stuck in pending or kyc_ok', async () => {
    await run({} as never);

    const persons = queries.find((q) => q.name === 'persons');
    expect(persons?.filters[0]).toEqual(['status', 'in', ['pending', 'kyc_ok']]);
    expect(persons?.filters[1]?.[0]).toBe('updatedAt');
    expect(persons?.filters[1]?.[1]).toBe('<');
  });

  it('skips a person that has only just been written', async () => {
    write(`persons/${P1}`, {
      status: 'pending',
      account: ACCOUNT,
      chain: { registerTx: TX },
      updatedAt: Timestamp.now(),
    });
    writes.length = 0;

    await run({} as never);

    expect(snapshot(`persons/${P1}`).get('status')).toBe('pending');
    expect(writes).toEqual([]);
  });
});

describe('reconcilePending — 멈춘 본인인증 레벨', () => {
  it('finishes a stuck kyc_ok person once setKycLevel is finalized', async () => {
    seedPerson(P1, { status: 'kyc_ok', kycLevel: 0, chain: { kycLevelTx: '0xcc' } });

    await run({} as never);

    const person = snapshot(`persons/${P1}`);
    expect(person.get('status')).toBe('active');
    expect(person.get('kycLevel')).toBe(1);
    expect(person.get('chain.block')).toBe(100);
  });

  it('falls back to active when the setKycLevel transaction reverted', async () => {
    getTransactionReceipt.mockResolvedValue({ status: 'reverted', blockNumber: 100n });
    seedPerson(P2, { status: 'kyc_ok', kycLevel: 0, chain: { kycLevelTx: '0xdd' } });

    await run({} as never);

    const person = snapshot(`persons/${P2}`);
    expect(person.get('status')).toBe('active');
    // 레벨의 원본은 체인이다. 되돌아간 트랜잭션은 레벨을 올리지 않는다.
    expect(person.get('kycLevel')).toBe(0);
    expect(person.get('chain.kycLevelTx')).toBeUndefined();
  });

  it('clears a dropped setKycLevel hash and leaves the person in kyc_ok', async () => {
    getTransactionReceipt.mockRejectedValue(new Error('not found'));
    seedPerson(P2, { status: 'kyc_ok', kycLevel: 0, chain: { kycLevelTx: '0xdd' } });

    await run({} as never);

    const person = snapshot(`persons/${P2}`);
    expect(person.get('status')).toBe('kyc_ok');
    expect(person.get('chain.kycLevelTx')).toBeUndefined();
  });

  it('leaves a kyc_ok person with no recorded hash untouched', async () => {
    seedPerson(P2, { status: 'kyc_ok', kycLevel: 0, chain: { kycLevelError: 'reverted' } });
    writes.length = 0;

    await run({} as never);

    expect(snapshot(`persons/${P2}`).get('status')).toBe('kyc_ok');
    expect(writes).toEqual([]);
    expect(getTransactionReceipt).not.toHaveBeenCalled();
  });

  it('waits while the setKycLevel block is not finalized yet', async () => {
    getBlock.mockResolvedValue({ number: 50n });
    seedPerson(P1, { status: 'kyc_ok', kycLevel: 0, chain: { kycLevelTx: '0xcc' } });
    writes.length = 0;

    await run({} as never);

    expect(snapshot(`persons/${P1}`).get('status')).toBe('kyc_ok');
    expect(writes).toEqual([]);
  });
});

describe('reconcilePending — 죽은 양도 초대', () => {
  it('expires a sent invite whose expiry has passed and leaves a live one alone', async () => {
    write('transferInvites/dead', { status: 'sent', expiresAt: seconds() - 10 });
    write('transferInvites/live', { status: 'sent', expiresAt: seconds() + 3600 });

    await run({} as never);

    expect(snapshot('transferInvites/dead').get('status')).toBe('expired');
    expect(snapshot('transferInvites/live').get('status')).toBe('sent');
  });

  it('never revives an invite that is already accepted or expired', async () => {
    write('transferInvites/done', { status: 'accepted', expiresAt: seconds() - 10 });
    write('transferInvites/old', { status: 'expired', expiresAt: seconds() - 10 });
    writes.length = 0;

    await run({} as never);

    expect(writes).toEqual([]);
  });

  it('scans only invites that still say sent', async () => {
    await run({} as never);

    const invites = queries.find((q) => q.name === 'transferInvites');
    expect(invites?.filters).toEqual([['status', '==', 'sent']]);
  });
});

describe('reconcilePending — 만료된 인증 챌린지', () => {
  it('deletes challenges past their expiry and keeps the live ones', async () => {
    write('authChallenges/dead', { purpose: 'login', expiresAt: seconds() - 10 });
    write('authChallenges/live', { purpose: 'register', expiresAt: seconds() + 300 });

    await run({} as never);

    expect(deletes).toEqual(['authChallenges/dead']);
    expect(snapshot('authChallenges/live').exists).toBe(true);
  });

  it('deletes only on the stored expiry field, never by age', async () => {
    write('authChallenges/no-expiry', { purpose: 'login', createdAt: Timestamp.now() });

    await run({} as never);

    expect(deletes).toEqual([]);
    const challenges = queries.find((q) => q.name === 'authChallenges');
    expect(challenges?.filters).toEqual([['expiresAt', '<', expect.any(Number)]]);
  });
});

describe('reconcilePending — 스윕 격리', () => {
  it('runs the later sweeps even when an earlier one throws', async () => {
    failQuery.add('persons');
    write('transferInvites/dead', { status: 'sent', expiresAt: seconds() - 10 });
    write('authChallenges/dead', { purpose: 'login', expiresAt: seconds() - 10 });

    await expect(run({} as never)).resolves.not.toThrow();

    expect(snapshot('transferInvites/dead').get('status')).toBe('expired');
    expect(deletes).toEqual(['authChallenges/dead']);
  });

  it('never throws out of the scheduler when every sweep fails', async () => {
    failQuery.add('persons');
    failQuery.add('transferInvites');
    failQuery.add('authChallenges');

    await expect(run({} as never)).resolves.not.toThrow();
  });

  it('keeps going when one document blows up mid-sweep', async () => {
    getTransactionReceipt.mockImplementation(async ({ hash }: { hash: string }) => {
      if (hash === '0xbad') throw new Error('RPC_BROKEN');
      return { status: 'success', blockNumber: 100n };
    });
    seedPerson(P1, { status: 'kyc_ok', kycLevel: 0, chain: { kycLevelTx: '0xbad' } });
    seedPerson(P2, { status: 'kyc_ok', kycLevel: 0, chain: { kycLevelTx: '0xcc' } });

    await run({} as never);

    expect(snapshot(`persons/${P2}`).get('status')).toBe('active');
  });

  it('caps every sweep so a backlog in one cannot starve the others', async () => {
    await run({} as never);

    expect(queries.filter((q) => q.name !== 'users').map((q) => [q.name, q.max])).toEqual([
      ['persons', 200],
      ['transferInvites', 200],
      ['authChallenges', 200],
    ]);
  });

  it('runs every five minutes in the deployed region', () => {
    const endpoint = (reconcilePending as unknown as { __endpoint: Record<string, unknown> })
      .__endpoint;
    expect(endpoint.scheduleTrigger).toMatchObject({
      schedule: 'every 5 minutes',
      timeZone: 'Asia/Seoul',
    });
    expect(endpoint.region).toEqual([FIREBASE_REGION]);
  });
});
