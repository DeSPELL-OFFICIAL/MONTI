import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';

process.env.GCP_PROJECT_ID = 'monti-dev';

const PERSON_ID = `0x${'aa'.repeat(32)}`;
const ACCOUNT = '0x9999999999999999999999999999999999999999';
const SESSION = { sessionId: 'sess-9', url: 'https://verify.didit.me/s/sess-9' };

/** `persons` / `users` 두 컬렉션과 점 경로 읽기만 흉내 내는 가짜 Firestore(device.test.ts 와 같은 패턴). */
const docs = new Map<string, Record<string, unknown>>();
const SERVER_TIMESTAMP = FieldValue.serverTimestamp();

function isServerTimestamp(value: unknown): boolean {
  const candidate = value as FieldValue | undefined;
  return typeof candidate?.isEqual === 'function' && candidate.isEqual(SERVER_TIMESTAMP);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}

function deepMerge(target: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out = { ...target };
  for (const [key, value] of Object.entries(patch)) {
    if (isServerTimestamp(value)) out[key] = Timestamp.now();
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

vi.mock('../src/lib/db.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/db.js')>()),
  db: { collection: (name: string) => ({ doc: (id: string) => docRef(`${name}/${id}`) }) },
}));

/** 진짜 코드가 도는 것은 세션 재사용 판단까지다. HTTP 왕복만 가짜로 바꾼다. */
const createDiditSession = vi.fn(async (..._args: unknown[]) => ({ ...SESSION }));
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

  it('accepts a DEV_ORIGINS entry only while that setting carries it', async () => {
    await expect(call({ callbackUrl: 'http://localhost:5173/kyc' })).rejects.toThrow('BAD_CALLBACK_URL');

    process.env.DEV_ORIGINS = 'http://localhost:5173';
    await call({ callbackUrl: 'http://localhost:5173/kyc' });
    expect(createDiditSession.mock.calls[0]![3]).toBe('http://localhost:5173/kyc');
  });
});
