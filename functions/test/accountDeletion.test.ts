import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';

process.env.GCP_PROJECT_ID = 'monti-dev';

const PERSON_ID = `0x${'aa'.repeat(32)}`;
const ACCOUNT = '0x9999999999999999999999999999999999999999';
const PHONE_HMAC = 'hmac-of-+821012345678';
const SESSION_ID = 'sess-1';
const DAY = 24 * 60 * 60;

/**
 * 여섯 컬렉션과 등식·부등식 질의, 트랜잭션을 흉내 내는 가짜 Firestore.
 * 에뮬레이터 없이 `pnpm test` 안에서 돈다(device.test.ts 와 같은 패턴).
 */
const docs = new Map<string, Record<string, unknown>>();
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
    set: async (data: Record<string, unknown>, options?: { merge?: boolean }) => write(path, data, options),
    update: async (data: Record<string, unknown>) => {
      if (!docs.has(path)) throw new Error(`NOT_FOUND:${path}`);
      write(path, data, { merge: true });
    },
    delete: async () => {
      docs.delete(path);
    },
  };
}

type Filter = [string, string, unknown];

function matches(data: Record<string, unknown>, [name, op, value]: Filter): boolean {
  const actual = field(data, name);
  if (op === '==') return actual === value;
  if (op === '<=') return (actual as number) <= (value as number);
  throw new Error(`UNSUPPORTED_OP:${op}`);
}

function query(name: string, filters: Filter[], max: number) {
  return {
    where: (path: string, op: string, value: unknown) => query(name, [...filters, [path, op, value]], max),
    limit: (n: number) => query(name, filters, n),
    get: async () => {
      const matched = [...docs.entries()]
        .filter(([path]) => path.startsWith(`${name}/`))
        .filter(([, data]) => filters.every((filter) => matches(data, filter)))
        .slice(0, max)
        .map(([path]) => snapshot(path));
      return { docs: matched, size: matched.length, empty: matched.length === 0 };
    },
  };
}

function collection(name: string) {
  return { ...query(name, [], Number.POSITIVE_INFINITY), doc: (id: string) => docRef(`${name}/${id}`) };
}

type Ref = ReturnType<typeof docRef>;
const fakeDb = {
  collection,
  runTransaction: async <T>(body: (tx: {
    get: (ref: Ref) => Promise<ReturnType<typeof snapshot>>;
    set: (ref: Ref, data: Record<string, unknown>, options?: { merge?: boolean }) => void;
  }) => Promise<T>): Promise<T> => {
    const pending: Array<() => void> = [];
    const result = await body({
      get: async (ref: Ref) => snapshot(ref.path),
      set: (ref: Ref, data: Record<string, unknown>, options?: { merge?: boolean }) =>
        pending.push(() => write(ref.path, data, options)),
    });
    for (const apply of pending) apply();
    return result;
  },
};

/** Firebase Auth. 로그인 차단과 계정 삭제가 실제로 불렸는지만 본다. */
const updateUser = vi.fn(async (_uid: string, _update: Record<string, unknown>) => undefined);
const revokeRefreshTokens = vi.fn(async (_uid: string) => undefined);
const deleteUser = vi.fn(async (_uid: string) => undefined);

vi.mock('../src/lib/db.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/db.js')>()),
  db: fakeDb,
  authAdmin: { updateUser, revokeRefreshTokens, deleteUser },
}));

/** Didit 파기 API 호출만 가짜로 바꾼다. 재시도 판단은 진짜 코드가 돈다. */
const deleteDiditSession = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock('../src/lib/didit.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/didit.js')>()),
  deleteDiditSession: (...args: unknown[]) => deleteDiditSession(...args),
}));

const { DELETION_REQUESTS, DEVICES, PASSKEYS, PERSONS, PHONE_INDEX, USERS } = await import('../src/lib/db.js');
const { DELETION_GRACE_SECONDS, processDeletions, requestAccountDeletion } = await import(
  '../src/functions/accountDeletion.js'
);
const functionsTest = (await import('firebase-functions-test')).default();
const request = functionsTest.wrap(requestAccountDeletion);
const sweep = functionsTest.wrap(processDeletions);

const auth = { uid: 'uid-1', token: { personId: PERSON_ID, account: ACCOUNT } };

function call(who: unknown = auth) {
  return request({ data: {}, auth: who } as never) as Promise<{
    scheduledFor: number;
    onChainRetained: true;
  }>;
}

function run() {
  return sweep({} as never) as Promise<void>;
}

/** 파기 대상이 실제로 흩어져 있는 다섯 자리 전부를 심는다. */
function seed(): void {
  write(`${PERSONS}/${PERSON_ID}`, {
    status: 'active',
    kycLevel: 1,
    account: ACCOUNT,
    kyc: { provider: 'didit', sessionId: SESSION_ID, status: 'approved' },
    enc: { name: 'enc:name', docNumber: 'enc:doc' },
    photoEnc: 'enc:photo',
    chain: { registerTx: '0xabc', block: 7 },
  });
  write(`${USERS}/uid-1`, {
    personId: PERSON_ID,
    phoneEnc: 'enc:phone',
    phoneHmac: PHONE_HMAC,
    nickname: '태완',
    locale: 'ko',
  });
  write(`${PASSKEYS}/cred-1`, { personId: PERSON_ID, counter: 3 });
  write(`${PASSKEYS}/cred-2`, { personId: PERSON_ID, counter: 0 });
  write(`${PASSKEYS}/other`, { personId: `0x${'bb'.repeat(32)}`, counter: 0 });
  write(`${DEVICES}/${ACCOUNT}`, { deviceX: '0x11', deviceY: '0x22', pushToken: 'fcm-1' });
  write(`${PHONE_INDEX}/${PHONE_HMAC}`, { personId: PERSON_ID });
}

/** 유예 기간을 지나게 한다 — 스케줄 작업이 집어 갈 수 있는 상태. */
async function makeDue(uid = 'uid-1'): Promise<void> {
  write(`${DELETION_REQUESTS}/${uid}`, { scheduledFor: 1 }, { merge: true });
}

const ENV_KEYS = ['DIDIT_API_KEY'] as const;
const savedEnv = new Map<string, string | undefined>(ENV_KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

beforeEach(() => {
  docs.clear();
  process.env.DIDIT_API_KEY = 'didit-key';
  updateUser.mockClear();
  revokeRefreshTokens.mockClear();
  deleteUser.mockClear();
  deleteDiditSession.mockClear();
  deleteDiditSession.mockResolvedValue(undefined);
  seed();
});

describe('requestAccountDeletion', () => {
  it('records the request, states that the chain keeps its record, and cuts sign-in off now', async () => {
    const result = await call();

    expect(result.onChainRetained).toBe(true);
    const now = Math.floor(Date.now() / 1000);
    expect(result.scheduledFor).toBeGreaterThan(now + DELETION_GRACE_SECONDS - 60);
    expect(result.scheduledFor).toBeLessThanOrEqual(now + DELETION_GRACE_SECONDS);

    const stored = snapshot(`${DELETION_REQUESTS}/uid-1`);
    expect(stored.get('personId')).toBe(PERSON_ID);
    expect(stored.get('status')).toBe('pending');
    expect(stored.get('scheduledFor')).toBe(result.scheduledFor);
    expect(stored.get('requestedAt')).toBeInstanceOf(Timestamp);

    // 유예는 마음을 바꿀 시간이지 계속 쓰라는 시간이 아니다.
    expect(updateUser).toHaveBeenCalledWith('uid-1', { disabled: true });
    expect(revokeRefreshTokens).toHaveBeenCalledWith('uid-1');

    // 접수만으로는 아무것도 지우지 않는다.
    expect(snapshot(`${PERSONS}/${PERSON_ID}`).exists).toBe(true);
    expect(snapshot(`${USERS}/uid-1`).exists).toBe(true);
    expect(deleteUser).not.toHaveBeenCalled();
    expect(deleteDiditSession).not.toHaveBeenCalled();
  });

  it('is keyed by uid and never pushes the date out on a repeat call', async () => {
    const first = await call();
    write(`${DELETION_REQUESTS}/uid-1`, { scheduledFor: first.scheduledFor - 3 * DAY }, { merge: true });
    const second = await call();

    expect(second.scheduledFor).toBe(first.scheduledFor - 3 * DAY);
    expect(snapshot(`${DELETION_REQUESTS}/uid-1`).get('status')).toBe('pending');
  });

  it('refuses an unauthenticated caller and a uid that never signed up', async () => {
    await expect(request({ data: {} } as never)).rejects.toThrow('AUTH_REQUIRED');
    await expect(call({ uid: 'uid-nobody', token: {} })).rejects.toThrow('NO_PERSON');
    expect(updateUser).not.toHaveBeenCalled();
  });
});

describe('processDeletions', () => {
  it('leaves a request alone until its cooling period is over', async () => {
    await call();
    await run();

    expect(snapshot(`${DELETION_REQUESTS}/uid-1`).get('status')).toBe('pending');
    expect(snapshot(`${PERSONS}/${PERSON_ID}`).get('status')).toBe('active');
    expect(snapshot(`${USERS}/uid-1`).exists).toBe(true);
    expect(deleteDiditSession).not.toHaveBeenCalled();
    expect(deleteUser).not.toHaveBeenCalled();
  });

  it('erases every personal record once the cooling period is over', async () => {
    await call();
    await makeDue();

    await run();

    expect(snapshot(`${USERS}/uid-1`).exists).toBe(false);
    expect(snapshot(`${PHONE_INDEX}/${PHONE_HMAC}`).exists).toBe(false);
    expect(snapshot(`${DEVICES}/${ACCOUNT}`).exists).toBe(false);
    expect(snapshot(`${PASSKEYS}/cred-1`).exists).toBe(false);
    expect(snapshot(`${PASSKEYS}/cred-2`).exists).toBe(false);
    expect(snapshot(`${PASSKEYS}/other`).exists).toBe(true); // 남의 자격증명은 건드리지 않는다

    expect(deleteDiditSession).toHaveBeenCalledWith(SESSION_ID, 'didit-key');
    expect(deleteUser).toHaveBeenCalledWith('uid-1');
    expect(snapshot(`${DELETION_REQUESTS}/uid-1`).get('status')).toBe('done');
  });

  it('keeps the person row the chain points at, stripped of every personal field', async () => {
    await call();
    await makeDue();
    await run();

    const person = snapshot(`${PERSONS}/${PERSON_ID}`);
    expect(person.exists).toBe(true); // 체인이 이 personId 를 가리킨다(스펙 §10.2)
    expect(person.get('status')).toBe('deleted');
    expect(person.get('enc')).toBeUndefined();
    expect(person.get('photoEnc')).toBeUndefined();
    expect(person.get('kyc')).toBeUndefined();
    // 개인정보가 아닌 것은 남는다 — 계정 주소와 체인 기록은 personId 와 짝이라 지울 것이 없다.
    expect(person.get('account')).toBe(ACCOUNT);
    expect(person.get('chain.registerTx')).toBe('0xabc');

    const everything = JSON.stringify([...docs.entries()]);
    for (const secret of ['enc:phone', 'enc:photo', 'enc:name', 'enc:doc', PHONE_HMAC, '태완']) {
      expect(everything).not.toContain(secret);
    }
  });

  it('keeps the request pending when Didit refuses, after retrying once', async () => {
    deleteDiditSession.mockRejectedValue(new Error('DIDIT_DELETE_FAILED:500'));
    await call();
    await makeDue();

    await expect(run()).resolves.toBeUndefined(); // 스케줄러 밖으로 던지지 않는다

    expect(deleteDiditSession).toHaveBeenCalledTimes(2); // 한 번 더 해 본다
    // 아무것도 지우지 않았다 — 내일 실행이 같은 sessionId 로 다시 시도할 수 있어야 한다.
    expect(snapshot(`${USERS}/uid-1`).exists).toBe(true);
    expect(snapshot(`${PERSONS}/${PERSON_ID}`).get('status')).toBe('active');
    expect(deleteUser).not.toHaveBeenCalled();
    expect(snapshot(`${DELETION_REQUESTS}/uid-1`).get('status')).toBe('pending');

    // 다음 날 Didit 이 살아났다.
    deleteDiditSession.mockResolvedValue(undefined);
    await run();
    expect(snapshot(`${DELETION_REQUESTS}/uid-1`).get('status')).toBe('done');
  });

  it('erases a person who never reached Didit or the chain', async () => {
    write(`${PERSONS}/${PERSON_ID}`, { status: 'pending', kycLevel: 0 }); // 세션도 계정 주소도 없다
    await call();
    await makeDue();

    await run();

    expect(deleteDiditSession).not.toHaveBeenCalled();
    expect(snapshot(`${PERSONS}/${PERSON_ID}`).get('status')).toBe('deleted');
    expect(snapshot(`${USERS}/uid-1`).exists).toBe(false);
    expect(snapshot(`${DELETION_REQUESTS}/uid-1`).get('status')).toBe('done');
  });

  it('keeps going when one request blows up, and never throws out of the scheduler', async () => {
    write(`${DELETION_REQUESTS}/uid-broken`, { personId: PERSON_ID, status: 'pending', scheduledFor: 1 });
    deleteUser.mockRejectedValueOnce(new Error('AUTH_DOWN'));
    await call();
    await makeDue();

    await expect(run()).resolves.toBeUndefined();

    const outcomes = ['uid-broken', 'uid-1'].map((uid) => snapshot(`${DELETION_REQUESTS}/${uid}`).get('status'));
    expect(outcomes).toContain('done'); // 하나가 터져도 다른 하나는 끝났다
    expect(outcomes).toContain('pending'); // 터진 쪽은 내일 다시 집힌다
  });
});
