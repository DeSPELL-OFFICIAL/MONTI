import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { encodeEventTopics } from 'viem';
import { organizersAbi } from '@monti/shared';
import type { AttesterTx } from '../src/lib/chain.js';

process.env.GCP_PROJECT_ID = 'monti-dev';

const PERSON_ID = `0x${'aa'.repeat(32)}`;
const OTHER_PERSON_ID = `0x${'bb'.repeat(32)}`;
/** 글자가 섞인 주소. 숫자만 쓰면 체크섬 회귀를 테스트가 잡지 못한다. */
const ACCOUNT = '0xDeaDbeefdEAdbeefdEadbEEFdeadbeEFdEaDbeeF';
const ORGANIZERS = '0x2222222222222222222222222222222222222222';
const TX = `0x${'cd'.repeat(32)}`;
const ORG_ID = 42n;

/**
 * `device.test.ts` 와 같은 가짜 Firestore. 에뮬레이터 없이 `pnpm test` 안에서 돈다.
 * `system` 컬렉션까지 흉내 내므로 **어테스터 리스는 진짜 코드가 돈다**.
 * `orgProfiles` 는 문서 하나 읽기만이 아니라 질의(`where`/`limit`)도 받는다 — 상한이
 * 진짜 질의를 지나야 "세 개까지" 가 증명된다.
 */
const docs = new Map<string, Record<string, unknown>>();
let inTransaction = false;

const DELETE = FieldValue.delete();
const SERVER_TIMESTAMP = FieldValue.serverTimestamp();

function isSentinel(value: unknown, sentinel: FieldValue): boolean {
  const candidate = value as FieldValue | undefined;
  return typeof candidate?.isEqual === 'function' && candidate.isEqual(sentinel);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}

function deepMerge(target: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out = { ...target };
  for (const [key, value] of Object.entries(patch)) {
    if (isSentinel(value, DELETE)) delete out[key];
    else if (isSentinel(value, SERVER_TIMESTAMP)) out[key] = Timestamp.now();
    else if (isPlainObject(value)) {
      const previous = out[key];
      out[key] = deepMerge(isPlainObject(previous) ? previous : {}, value);
    } else out[key] = value;
  }
  return out;
}

function write(path: string, data: Record<string, unknown>, options?: { merge?: boolean }): void {
  docs.set(path, deepMerge(options?.merge ? (docs.get(path) ?? {}) : {}, data));
}

function field(data: Record<string, unknown> | undefined, path: string): unknown {
  return path.split('.').reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], data);
}

function snapshot(path: string) {
  const data = docs.get(path);
  return {
    exists: data !== undefined,
    id: path.slice(path.indexOf('/') + 1),
    get: (name: string) => field(data, name),
    data: () => data,
  };
}

function docRef(path: string) {
  return {
    path,
    id: path.slice(path.indexOf('/') + 1),
    get: async () => snapshot(path),
    set: async (data: Record<string, unknown>, options?: { merge?: boolean }) => write(path, data, options),
  };
}

/** 이 스위트가 쓰는 유일한 질의 모양 — 같은 값을 찾는 `where` 하나에 `limit` 하나. */
const queries: Array<{ collection: string; field: string; op: string; value: unknown; limit: number }> = [];

function collectionRef(name: string) {
  const prefix = `${name}/`;
  const query = (clause: { field: string; op: string; value: unknown }) => {
    const matching = () =>
      [...docs.entries()]
        .filter(([path]) => path.startsWith(prefix))
        .filter(([, data]) => field(data, clause.field) === clause.value);
    const limited = (max: number) => ({
      get: async () => {
        queries.push({ collection: name, ...clause, limit: max });
        const hits = matching().slice(0, max);
        return { size: hits.length, empty: hits.length === 0, docs: hits.map(([path]) => snapshot(path)) };
      },
    });
    return {
      limit: limited,
      get: limited(Number.POSITIVE_INFINITY).get,
    };
  };
  return {
    doc: (id: string) => docRef(`${name}/${id}`),
    where: (path: string, op: string, value: unknown) => query({ field: path, op, value }),
  };
}

vi.mock('../src/lib/db.js', () => ({
  PERSONS: 'persons',
  USERS: 'users',
  ORG_PROFILES: 'orgProfiles',
  SYSTEM: 'system',
  db: {
    collection: collectionRef,
    runTransaction: async <T>(body: (tx: unknown) => Promise<T>): Promise<T> => {
      inTransaction = true;
      const pending: Array<() => void> = [];
      const tx = {
        get: async (ref: { path: string }) => snapshot(ref.path),
        set: (ref: { path: string }, data: Record<string, unknown>, options?: { merge?: boolean }) =>
          pending.push(() => write(ref.path, data, options)),
      };
      try {
        const result = await body(tx);
        for (const apply of pending) apply();
        return result;
      } finally {
        inTransaction = false;
      }
    },
  },
}));

function guard<T>(value: T): T {
  if (inTransaction) throw new Error('CHAIN_CALL_INSIDE_TRANSACTION');
  return value;
}

/** 진짜 `OrganizerCreated` 로그. 토픽은 viem 이 ABI 에서 뽑는다 — 손으로 쓴 해시는 증명이 못 된다. */
function organizerCreatedLog(orgId: bigint, owner: string) {
  return {
    address: ORGANIZERS,
    topics: encodeEventTopics({
      abi: organizersAbi,
      eventName: 'OrganizerCreated',
      args: { orgId, owner },
    }),
    data: '0x',
    blockNumber: 7n,
    blockHash: `0x${'11'.repeat(32)}`,
    logIndex: 0,
    transactionHash: TX,
    transactionIndex: 0,
    removed: false,
  };
}

/** 영수증 하나하나의 답. 테스트가 필요한 값만 바꿔 끼운다. */
const receipt = {
  status: 'success' as 'success' | 'reverted',
  blockNumber: 7n,
  logs: [organizerCreatedLog(ORG_ID, ACCOUNT)] as unknown[],
};

const sendAttesterTx = vi.fn(async (_tx: AttesterTx) => guard(TX));
const waitForTransactionReceipt = vi.fn(async () => guard(receipt));
const awaitFinalized = vi.fn(async (_block: bigint) => guard(undefined));

vi.mock('../src/lib/chain.js', () => ({
  sendAttesterTx,
  awaitFinalized: (block: bigint) => awaitFinalized(block),
  publicClient: () => ({ waitForTransactionReceipt }),
  deployment: () => ({ organizers: ORGANIZERS }),
}));

/** 거절 로그. 400 하나만 보고는 어느 거절인지 알 수 없으므로 이 한 줄이 진단의 전부다. */
const logWarn = vi.fn();
vi.mock('firebase-functions/logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('firebase-functions/logger')>()),
  warn: (...args: unknown[]) => logWarn(...args),
}));

const { MAX_ORGS_PER_PERSON, createOrganizerForMe } = await import('../src/functions/createOrganizer.js');
const functionsTest = (await import('firebase-functions-test')).default();
const create = functionsTest.wrap(createOrganizerForMe);

const auth = { uid: 'uid-1', token: { personId: PERSON_ID, account: ACCOUNT } };

function call(data: Record<string, unknown> = { name: '모나드 컴퍼니' }) {
  return create({ data, auth } as never) as Promise<{ orgId: string }>;
}

beforeEach(() => {
  docs.clear();
  queries.length = 0;
  inTransaction = false;
  process.env.ATTESTER_PK = `0x${'11'.repeat(32)}`;
  receipt.status = 'success';
  receipt.blockNumber = 7n;
  receipt.logs = [organizerCreatedLog(ORG_ID, ACCOUNT)];
  sendAttesterTx.mockClear();
  waitForTransactionReceipt.mockClear();
  awaitFinalized.mockClear();
  logWarn.mockClear();
  write(`users/uid-1`, { personId: PERSON_ID });
  write(`persons/${PERSON_ID}`, { status: 'active', account: ACCOUNT, kycLevel: 0 });
});

describe('createOrganizerForMe', () => {
  it('sends createOrganizer(owner) from the attester and returns the orgId the chain assigned', async () => {
    const result = await call({ name: '모나드 컴퍼니' });

    expect(result).toEqual({ orgId: '42' });
    // 오너는 **그 사람의 계정**이다. 어테스터가 보내도 주최사의 주인은 어테스터가 아니다.
    expect(sendAttesterTx).toHaveBeenCalledTimes(1);
    const tx = sendAttesterTx.mock.calls[0]?.[0] as AttesterTx;
    expect(tx.address).toBe(ORGANIZERS);
    expect(tx.functionName).toBe('createOrganizer');
    expect(tx.args).toEqual([ACCOUNT]);
    expect(tx.abi).toBe(organizersAbi);
    // 스펙 §10.4 규칙 3 — DB 는 finalized 뒤에만 적는다.
    expect(awaitFinalized).toHaveBeenCalledWith(7n);
  });

  it('writes the display name under orgProfiles/{orgId} with the owner and the tx that made it', async () => {
    await call({ name: '  모나드 컴퍼니  ' });

    const profile = snapshot('orgProfiles/42');
    expect(profile.exists).toBe(true);
    expect(profile.get('orgId')).toBe('42');
    expect(profile.get('name')).toBe('모나드 컴퍼니'); // 앞뒤 공백은 떼고 저장한다
    expect(profile.get('ownerPersonId')).toBe(PERSON_ID);
    expect(profile.get('ownerAccount')).toBe(ACCOUNT);
    expect(profile.get('txHash')).toBe(TX);
    expect(profile.get('createdAt')).toBeInstanceOf(Timestamp);
  });

  it('decodes the orgId from the receipt log rather than guessing it', async () => {
    receipt.logs = [organizerCreatedLog(7n, ACCOUNT)];
    expect(await call()).toEqual({ orgId: '7' });

    // 다른 컨트랙트의 로그가 섞여 있어도 OrganizerCreated 만 읽는다.
    receipt.logs = [
      { ...organizerCreatedLog(9n, ACCOUNT), topics: [`0x${'ee'.repeat(32)}`], data: '0x' },
      organizerCreatedLog(123n, ACCOUNT),
    ];
    expect(await call()).toEqual({ orgId: '123' });
  });

  it('refuses an unauthenticated caller before it looks at the name', async () => {
    // `auth` 키를 **아예 빼고** 부른다 — 키를 두고 undefined 를 넣으면 firebase-functions-test 가
    // 기본 인증 맥락을 채워 넣어, 로그인하지 않은 호출을 흉내 내지 못한다.
    await expect(create({ data: { name: '모나드 컴퍼니' } } as never)).rejects.toThrow('AUTH_REQUIRED');
    expect(sendAttesterTx).not.toHaveBeenCalled();
    expect(logWarn).toHaveBeenCalledWith('organizer.create.rejected', {
      code: 'unauthenticated',
      reason: 'AUTH_REQUIRED',
    });
  });

  it('takes a name of exactly 2 and exactly 40 characters, measured after trimming', async () => {
    for (const [at, name] of ['가나', '가'.repeat(40)].entries()) {
      receipt.logs = [organizerCreatedLog(BigInt(at + 1), ACCOUNT)];
      const result = await call({ name: `  ${name}  ` });
      expect(snapshot(`orgProfiles/${result.orgId}`).get('name'), `${at} 번째 가장자리`).toBe(name);
    }
  });

  it('rejects a name that is too short, too long, not a string or carries a control character', async () => {
    const cases: unknown[] = [
      undefined,
      null,
      7,
      ['모나드'],
      '',
      ' ',
      '가',
      '  가  ',
      '가'.repeat(41),
      '모나드\n컴퍼니',
      '모나드\u0000',
      '모나드\u007f',
    ];
    for (const name of cases) {
      await expect(call({ name }), JSON.stringify(name)).rejects.toThrow('BAD_NAME');
    }
    expect(sendAttesterTx).not.toHaveBeenCalled();
    expect(logWarn).toHaveBeenCalledWith('organizer.create.rejected', {
      code: 'invalid-argument',
      reason: 'BAD_NAME',
    });
  });

  it('counts emoji by code point, so a 40-emoji name passes and 41 does not', async () => {
    await expect(call({ name: '🎪'.repeat(41) })).rejects.toThrow('BAD_NAME');
    expect(await call({ name: '🎪'.repeat(40) })).toEqual({ orgId: '42' });
  });

  it('refuses a person who is not on the chain yet, or is gone, and names the status in the log', async () => {
    for (const status of ['pending', 'kyc_ok', 'rejected', 'rotated', 'deleted']) {
      write(`persons/${PERSON_ID}`, { status }, { merge: true });
      await expect(call()).rejects.toThrow('NOT_ACTIVE');
    }
    expect(sendAttesterTx).not.toHaveBeenCalled();
    expect(logWarn).toHaveBeenCalledWith('organizer.create.rejected', {
      code: 'failed-precondition',
      reason: 'NOT_ACTIVE',
      status: 'pending',
    });
  });

  it('refuses an active person who somehow has no account address', async () => {
    docs.set(`persons/${PERSON_ID}`, { status: 'active' });
    await expect(call()).rejects.toThrow('NOT_ACTIVE');
    expect(sendAttesterTx).not.toHaveBeenCalled();
    expect(logWarn).toHaveBeenCalledWith('organizer.create.rejected', {
      code: 'failed-precondition',
      reason: 'NOT_ACTIVE',
      status: 'active',
      hasAccount: false,
    });
  });

  it('refuses a caller with no signup, whether the user doc or the person doc is missing', async () => {
    docs.delete(`persons/${PERSON_ID}`);
    await expect(call()).rejects.toThrow('NO_SIGNUP');

    docs.delete('users/uid-1');
    await expect(call()).rejects.toThrow('NO_SIGNUP');
    expect(sendAttesterTx).not.toHaveBeenCalled();
    expect(logWarn).toHaveBeenCalledWith('organizer.create.rejected', {
      code: 'not-found',
      reason: 'NO_SIGNUP',
    });
  });

  it('lets one person make three organizers and refuses the fourth before it burns any gas', async () => {
    for (let n = 0; n < MAX_ORGS_PER_PERSON; n += 1) {
      receipt.logs = [organizerCreatedLog(BigInt(100 + n), ACCOUNT)];
      expect(await call({ name: `주최사 ${n}` })).toEqual({ orgId: String(100 + n) });
    }
    expect(sendAttesterTx).toHaveBeenCalledTimes(MAX_ORGS_PER_PERSON);

    await expect(call({ name: '네 번째' })).rejects.toThrow('ORG_LIMIT');
    expect(sendAttesterTx).toHaveBeenCalledTimes(MAX_ORGS_PER_PERSON);
    expect(logWarn).toHaveBeenCalledWith('organizer.create.rejected', {
      code: 'resource-exhausted',
      reason: 'ORG_LIMIT',
    });
  });

  it('counts only the caller own organizers, and asks Firestore with a bounded query', async () => {
    for (const orgId of ['201', '202', '203']) {
      write(`orgProfiles/${orgId}`, { orgId, ownerPersonId: OTHER_PERSON_ID, name: '남의 주최사' });
    }
    expect(await call({ name: '내 첫 주최사' })).toEqual({ orgId: '42' });

    expect(queries[0]).toEqual({
      collection: 'orgProfiles',
      field: 'ownerPersonId',
      op: '==',
      value: PERSON_ID,
      limit: MAX_ORGS_PER_PERSON,
    });
  });

  it('does not write a profile when the transaction reverted', async () => {
    receipt.status = 'reverted';
    await expect(call()).rejects.toThrow('CREATE_ORG_REVERTED');
    expect(snapshot('orgProfiles/42').exists).toBe(false);
    expect(awaitFinalized).not.toHaveBeenCalled();
  });

  it('does not write a profile when the receipt carries no OrganizerCreated log', async () => {
    receipt.logs = [];
    await expect(call()).rejects.toThrow('NO_ORG_EVENT');
    expect(snapshot('orgProfiles/42').exists).toBe(false);
    expect(awaitFinalized).not.toHaveBeenCalled();
  });

  it('never leaks the name or the caller into the rejection log', async () => {
    await expect(call({ name: '모나드\n컴퍼니' })).rejects.toThrow('BAD_NAME');
    const logged = JSON.stringify(logWarn.mock.calls);
    expect(logged).not.toContain('모나드');
    expect(logged).not.toContain(PERSON_ID);
    expect(logged).not.toContain(ACCOUNT);
    expect(logged).not.toContain('uid-1');
  });
});
