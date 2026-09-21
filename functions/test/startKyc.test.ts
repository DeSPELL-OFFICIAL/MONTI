import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';

process.env.GCP_PROJECT_ID = 'monti-dev';

const PERSON_ID = `0x${'aa'.repeat(32)}`;
const ACCOUNT = '0x9999999999999999999999999999999999999999';
const SESSION = { sessionId: 'sess-9', url: 'https://verify.didit.me/s/sess-9' };

/** `persons` / `users` 두 컬렉션과 점 경로 읽기만 흉내 내는 가짜 Firestore(device.test.ts 와 같은 패턴). */
const docs = new Map<string, Record<string, unknown>>();
const DELETE = FieldValue.delete();
const SERVER_TIMESTAMP = FieldValue.serverTimestamp();

function isSentinel(value: unknown, sentinel: FieldValue): boolean {
  const candidate = value as FieldValue | undefined;
  return typeof candidate?.isEqual === 'function' && candidate.isEqual(sentinel);
}

/** `FieldValue.arrayUnion(...)` 의 원소들. 이 sentinel 은 `elements` 를 그대로 들고 있다. */
function arrayUnionElements(value: unknown): unknown[] | undefined {
  const candidate = value as { constructor?: { name?: string }; elements?: unknown[] };
  return candidate?.constructor?.name === 'ArrayUnionTransform' ? candidate.elements : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}

function deepMerge(target: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out = { ...target };
  for (const [key, value] of Object.entries(patch)) {
    const union = arrayUnionElements(value);
    if (isSentinel(value, DELETE)) delete out[key];
    else if (isSentinel(value, SERVER_TIMESTAMP)) out[key] = Timestamp.now();
    else if (union) out[key] = [...new Set([...((out[key] as unknown[]) ?? []), ...union])];
    else if (isPlainObject(value)) {
      const previous = out[key];
      out[key] = deepMerge(isPlainObject(previous) ? previous : {}, value);
    } else out[key] = value;
  }
  return out;
}

/** 문서마다의 쓰기 횟수. 트랜잭션의 낙관적 잠금이 이 값으로 경합을 알아본다. */
const versions = new Map<string, number>();

function write(path: string, data: Record<string, unknown>, options?: { merge?: boolean }): void {
  docs.set(path, deepMerge(options?.merge ? (docs.get(path) ?? {}) : {}, data));
  versions.set(path, (versions.get(path) ?? 0) + 1);
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

type Ref = ReturnType<typeof docRef>;
let inFlight = 0;

/**
 * Firestore 의 **낙관적 잠금**을 흉내 낸다. 이것이 없으면 경합 테스트가 아무것도 증명하지
 * 못한다: 두 본문이 나란히 읽고 나란히 쓰는 것은 진짜 Firestore 가 결코 허용하지 않는 일이다.
 *
 * 읽은 문서의 버전을 기억해 두고, 커밋할 때 그 사이에 누가 바꿨으면 **본문을 처음부터 다시**
 * 돌린다. 재시도한 본문은 상대가 찍어 둔 `opening` 도장을 보게 된다.
 */
const fakeDb = {
  collection: (name: string) => ({ doc: (id: string) => docRef(`${name}/${id}`) }),
  runTransaction: async <T>(body: (tx: {
    get: (ref: Ref) => Promise<ReturnType<typeof snapshot>>;
    set: (ref: Ref, data: Record<string, unknown>, options?: { merge?: boolean }) => void;
  }) => Promise<T>): Promise<T> => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const seen = new Map<string, number>();
      const pending: Array<[string, () => void]> = [];
      inFlight += 1;
      let result: T;
      try {
        result = await body({
          get: async (ref: Ref) => {
            seen.set(ref.path, versions.get(ref.path) ?? 0);
            return snapshot(ref.path);
          },
          set: (ref: Ref, data: Record<string, unknown>, options?: { merge?: boolean }) =>
            pending.push([ref.path, () => write(ref.path, data, options)]),
        });
      } finally {
        inFlight -= 1;
      }
      const stale = [...seen].some(([path, version]) => (versions.get(path) ?? 0) !== version);
      if (stale) continue; // 상대가 먼저 커밋했다. 다시 읽고 다시 판단한다.
      for (const [, apply] of pending) apply();
      return result;
    }
    throw new Error('TRANSACTION_CONTENTION');
  },
};

vi.mock('../src/lib/db.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/db.js')>()),
  db: fakeDb,
}));

/** 진짜 코드가 도는 것은 세션 재사용 판단까지다. HTTP 왕복만 가짜로 바꾼다. */
const createDiditSession = vi.fn(async (..._args: unknown[]) => {
  // HTTP 가 트랜잭션 안에서 일어나면 Firestore 의 경합 재시도가 세션을 한 번 더 만든다.
  if (inFlight > 0) throw new Error('DIDIT_CALL_INSIDE_TRANSACTION');
  return { ...SESSION };
});
vi.mock('../src/lib/didit.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/didit.js')>()),
  createDiditSession: (...args: unknown[]) => createDiditSession(...args),
}));

const { PERSONS, USERS } = await import('../src/lib/db.js');
const { startKyc } = await import('../src/functions/startKyc.js');
const functionsTest = (await import('firebase-functions-test')).default();
const start = functionsTest.wrap(startKyc);

const auth = { uid: 'uid-1', token: { personId: PERSON_ID, account: ACCOUNT } };

function call(data: Record<string, unknown> = {}, who: unknown = auth) {
  return start({ data, auth: who } as never) as Promise<{ kycUrl: string; sessionId: string }>;
}

/**
 * `defineString().value()` 는 배포 때 심어 둔 `process.env` 를 읽는다(기본값은 런타임에 쓰이지 않는다).
 * 테스트 파일들이 한 프로세스를 나눠 쓰므로 여기서 건드린 값은 반드시 원래대로 돌려놓는다.
 */
const ENV_KEYS = ['RP_ID', 'DEV_ORIGINS', 'DIDIT_API_KEY', 'DIDIT_WORKFLOW_ID'] as const;
const savedEnv = new Map<string, string | undefined>(ENV_KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

beforeEach(() => {
  docs.clear();
  versions.clear();
  process.env.RP_ID = 'monti.despell.io';
  createDiditSession.mockClear();
  createDiditSession.mockResolvedValue({ ...SESSION });
  process.env.DIDIT_API_KEY = 'didit-key';
  process.env.DIDIT_WORKFLOW_ID = 'wf-1';
  process.env.DEV_ORIGINS = '';
  write(`${USERS}/uid-1`, { personId: PERSON_ID, phoneHmac: 'hmac-1' });
  write(`${PERSONS}/${PERSON_ID}`, { status: 'active', kycLevel: 0, account: ACCOUNT });
});

describe('startKyc', () => {
  it('opens a Didit session and records it on the person', async () => {
    const result = await call();
    expect(result).toEqual({ kycUrl: SESSION.url, sessionId: SESSION.sessionId });

    const person = snapshot(`${PERSONS}/${PERSON_ID}`);
    expect(person.get('kyc.provider')).toBe('didit');
    expect(person.get('kyc.sessionId')).toBe(SESSION.sessionId);
    expect(person.get('kyc.url')).toBe(SESSION.url);
    expect(person.get('kyc.status')).toBe('open');
    expect(person.get('kycLevel')).toBe(0); // 레벨은 웹훅이 올린다

    // vendor_data 는 난수 personId 다. 전화번호·이름은 Didit 으로 나가지 않는다.
    expect(createDiditSession.mock.calls[0]).toEqual([
      PERSON_ID,
      'didit-key',
      'wf-1',
      'https://monti.despell.io/kyc/callback',
    ]);
  });

  it('reuses an already open session instead of burning a new one', async () => {
    const first = await call();
    const second = await call();
    expect(second).toEqual(first);
    expect(createDiditSession).toHaveBeenCalledTimes(1);
  });

  it('opens a fresh session after a declined one, and clears the stale reason', async () => {
    await call();
    write(
      `${PERSONS}/${PERSON_ID}`,
      { status: 'rejected', kyc: { status: 'rejected', lastReason: 'duplicate_face' } },
      { merge: true },
    );

    createDiditSession.mockResolvedValueOnce({ sessionId: 'sess-10', url: 'https://verify.didit.me/s/sess-10' });
    const retry = await call();

    expect(retry.sessionId).toBe('sess-10');
    expect(createDiditSession).toHaveBeenCalledTimes(2);
    const person = snapshot(`${PERSONS}/${PERSON_ID}`);
    expect(person.get('kyc.status')).toBe('open');
    expect(person.get('kyc.lastReason')).toBeNull();
  });

  it('refuses a person who is already verified', async () => {
    write(`${PERSONS}/${PERSON_ID}`, { kycLevel: 1 }, { merge: true });
    await expect(call()).rejects.toThrow('ALREADY_VERIFIED');
    expect(createDiditSession).not.toHaveBeenCalled();
  });

  it('refuses a person whose account is not on the chain yet, or is gone', async () => {
    for (const status of ['pending', 'kyc_ok', 'rotated']) {
      write(`${PERSONS}/${PERSON_ID}`, { status, kycLevel: 0 }, { merge: true });
      await expect(call()).rejects.toThrow('NOT_ACTIVE');
    }
    expect(createDiditSession).not.toHaveBeenCalled();
  });

  it('refuses a caller with no session and a uid that never signed up', async () => {
    await expect(start({ data: {} } as never)).rejects.toThrow('AUTH_REQUIRED');
    await expect(call({}, { uid: 'uid-nobody', token: {} })).rejects.toThrow('NO_SIGNUP');

    docs.delete(`${PERSONS}/${PERSON_ID}`);
    await expect(call()).rejects.toThrow('NO_SIGNUP');
    expect(createDiditSession).not.toHaveBeenCalled();
  });
});

describe('startKyc — one session per person', () => {
  /**
   * 버튼 두 번 누르기, 또는 `startKyc` 와 `startDeviceChange` 가 겹치는 경우.
   * 예전에는 둘 다 "열린 세션 없음" 을 읽고 각각 세션을 만들었다 — 둘째가 첫째의
   * `kyc.sessionId` 를 덮어써, 첫 세션의 얼굴 템플릿은 파기할 방법이 없어진다.
   */
  it('opens exactly one Didit session when two calls race', async () => {
    const results = await Promise.allSettled([call(), call()]);

    // 불변식은 "세션이 하나뿐" 이다. 진 쪽이 그 세션을 그대로 받든, 재시도하라는 답을 받든
    // 둘 다 옳다 — 어느 쪽으로 갈라지는지는 커밋 순서에 달렸다.
    expect(createDiditSession).toHaveBeenCalledTimes(1);
    for (const result of results) {
      if (result.status === 'fulfilled') expect(result.value).toEqual({ kycUrl: SESSION.url, sessionId: SESSION.sessionId });
      else expect(String(result.reason)).toContain('KYC_SESSION_IN_FLIGHT');
    }

    const person = snapshot(`${PERSONS}/${PERSON_ID}`);
    expect(person.get('kyc.status')).toBe('open');
    expect(person.get('kyc.sessionId')).toBe(SESSION.sessionId);
    expect(person.get('kyc.claimedAt')).toBeUndefined(); // 도장은 성공하면 풀린다
    expect(person.get('kycSessionIds')).toEqual([SESSION.sessionId]);
  });

  it('refuses a second caller outright while the first is still talking to Didit', async () => {
    // Didit 왕복을 손으로 붙잡아, 도장만 찍힌 채 응답을 기다리는 창을 만든다.
    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    createDiditSession.mockImplementationOnce(async () => {
      await held;
      return { ...SESSION };
    });

    const first = call();
    await Promise.resolve(); // 도장이 커밋될 때까지 한 틱 양보한다
    await expect(call()).rejects.toThrow('KYC_SESSION_IN_FLIGHT');

    release();
    await expect(first).resolves.toEqual({ kycUrl: SESSION.url, sessionId: SESSION.sessionId });
    expect(createDiditSession).toHaveBeenCalledTimes(1);
  });

  it('never calls Didit from inside the transaction', async () => {
    // 가짜 트랜잭션 러너가 `inFlight` 를 세고, 안에서 불리면 던진다.
    await expect(call()).resolves.toMatchObject({ sessionId: SESSION.sessionId });
  });

  it('releases the claim when Didit refuses, so the next attempt can try again', async () => {
    createDiditSession.mockRejectedValueOnce(new Error('DIDIT_SESSION_FAILED:500'));
    await expect(call()).rejects.toThrow('DIDIT_SESSION_FAILED:500');

    // `opening` 도장이 남아 있으면 이 사람은 TTL 동안 본인인증을 시작할 수 없다.
    expect(snapshot(`${PERSONS}/${PERSON_ID}`).get('kyc.status')).toBeUndefined();

    await expect(call()).resolves.toMatchObject({ sessionId: SESSION.sessionId });
    expect(createDiditSession).toHaveBeenCalledTimes(2);
  });

  /**
   * 버려진 세션 스윕(`reconcilePending`)이 나이를 재는 값이다. 사람 문서의 `updatedAt` 은
   * 상관없는 쓰기에도 앞으로 가서, 그것으로 재면 버린 세션이 영영 늙지 않는다.
   */
  it('stamps when the Didit session was created, and never refreshes it on reuse', async () => {
    const before = Math.floor(Date.now() / 1000);
    await call();

    const openedAt = snapshot(`${PERSONS}/${PERSON_ID}`).get('kyc.openedAt') as number;
    expect(openedAt).toBeGreaterThanOrEqual(before);
    expect(openedAt).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));

    // 같은 링크를 다시 받는 것은 새 세션이 아니다. 여기서 값을 새로 찍으면 링크를 계속
    // 누르는 사람의 세션은 영원히 스윕에 걸리지 않는다.
    write(`${PERSONS}/${PERSON_ID}`, { kyc: { openedAt: 1 } }, { merge: true });
    await call();

    expect(snapshot(`${PERSONS}/${PERSON_ID}`).get('kyc.openedAt')).toBe(1);
    expect(createDiditSession).toHaveBeenCalledTimes(1);
  });

  it('opens a fresh session once the sweep has marked the last one abandoned', async () => {
    await call();
    // 하루가 지나도록 돌아오지 않은 세션에 `reconcilePending` 이 붙이는 딱지.
    write(`${PERSONS}/${PERSON_ID}`, { kyc: { status: 'abandoned' } }, { merge: true });

    createDiditSession.mockResolvedValueOnce({ sessionId: 'sess-12', url: 'https://verify.didit.me/s/sess-12' });
    const retry = await call();

    expect(retry.sessionId).toBe('sess-12');
    const person = snapshot(`${PERSONS}/${PERSON_ID}`);
    expect(person.get('kyc.status')).toBe('open');
    // 파기는 연 적 있는 세션을 전부 지운다 — 버린 세션도 그 목록에 남아 있어야 한다.
    expect(person.get('kycSessionIds')).toEqual(['sess-9', 'sess-12']);
  });

  it('records every session it ever opened, so deletion can erase all of them', async () => {
    await call();
    // 다른 공연 페이지에서 다시 시작한다 — 복귀 주소가 달라 새 세션이 열린다.
    createDiditSession.mockResolvedValueOnce({ sessionId: 'sess-10', url: 'https://verify.didit.me/s/sess-10' });
    await call({ callbackUrl: 'https://monti.despell.io/e/7/kyc' });

    expect(snapshot(`${PERSONS}/${PERSON_ID}`).get('kycSessionIds')).toEqual(['sess-9', 'sess-10']);
  });
});

describe('startKyc callbackUrl', () => {
  it('accepts any path under our own origin', async () => {
    await call({ callbackUrl: 'https://monti.despell.io/e/42/kyc?from=ticket' });
    expect(createDiditSession.mock.calls[0]![3]).toBe('https://monti.despell.io/e/42/kyc?from=ticket');
  });

  it('refuses a callback that would send the verified person somewhere else', async () => {
    for (const bad of [
      'https://evil.example/kyc',
      'http://monti.despell.io/kyc', // 평문 http 는 우리 origin 이 아니다
      'https://monti.despell.io.evil.example/kyc',
      'javascript:alert(1)',
      'not a url',
      42,
      null,
    ]) {
      await expect(call({ callbackUrl: bad })).rejects.toThrow('BAD_CALLBACK_URL');
    }
    expect(createDiditSession).not.toHaveBeenCalled();
  });

  /**
   * Didit 은 세션을 만들 때 받은 주소로만 돌려보낸다. A 공연에서 연 링크를 B 공연에서
   * 재사용하면 검증을 마치고 A 로 돌아간다 — 재사용은 복귀 주소가 같을 때만이다.
   */
  it('opens a fresh session when the caller wants to come back somewhere else', async () => {
    const first = await call();
    expect(await call()).toEqual(first); // 같은 주소면 그대로 재사용한다
    expect(createDiditSession).toHaveBeenCalledTimes(1);

    createDiditSession.mockResolvedValueOnce({ sessionId: 'sess-11', url: 'https://verify.didit.me/s/sess-11' });
    const elsewhere = await call({ callbackUrl: 'https://monti.despell.io/e/7/kyc' });

    expect(elsewhere.sessionId).toBe('sess-11');
    expect(createDiditSession).toHaveBeenCalledTimes(2);
    expect(createDiditSession.mock.calls[1]![3]).toBe('https://monti.despell.io/e/7/kyc');
    expect(snapshot(`${PERSONS}/${PERSON_ID}`).get('kyc.callbackUrl')).toBe('https://monti.despell.io/e/7/kyc');
  });

  it('accepts a DEV_ORIGINS entry only while that setting carries it', async () => {
    await expect(call({ callbackUrl: 'http://localhost:5173/kyc' })).rejects.toThrow('BAD_CALLBACK_URL');

    process.env.DEV_ORIGINS = 'http://localhost:5173';
    await call({ callbackUrl: 'http://localhost:5173/kyc' });
    expect(createDiditSession.mock.calls[0]![3]).toBe('http://localhost:5173/kyc');
  });
});
