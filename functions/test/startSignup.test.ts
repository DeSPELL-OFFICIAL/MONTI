import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';

process.env.GCP_PROJECT_ID = 'monti-dev';
process.env.PHONE_INDEX_KEY = 'monti-test-key';

const PHONE = '+821011112222';
const KEY = 'monti-test-key';

/**
 * `persons` / `users` / `phoneIndex` 세 컬렉션과 트랜잭션만 흉내 내는 가짜 Firestore.
 * 에뮬레이터 없이 `pnpm test` 안에서 돈다(auth.test.ts 와 같은 패턴).
 */
const docs = new Map<string, Record<string, unknown>>();
/** 트랜잭션 밖에서 일어난 쓰기 횟수. 가입 경로는 0이어야 한다. */
let directWrites = 0;
let transactions = 0;

function snapshot(path: string) {
  const data = docs.get(path);
  return {
    exists: data !== undefined,
    id: path.slice(path.indexOf('/') + 1),
    get: (field: string) => data?.[field],
    data: () => data,
  };
}

function docRef(path: string) {
  return {
    path,
    id: path.slice(path.indexOf('/') + 1),
    get: async () => snapshot(path),
    set: async (data: Record<string, unknown>, options?: { merge?: boolean }) => {
      directWrites += 1;
      write(path, data, options);
    },
  };
}

function write(path: string, data: Record<string, unknown>, options?: { merge?: boolean }): void {
  const previous = options?.merge ? (docs.get(path) ?? {}) : {};
  docs.set(path, { ...previous, ...data });
}

vi.mock('../src/lib/db.js', () => ({
  PERSONS: 'persons',
  USERS: 'users',
  PHONE_INDEX: 'phoneIndex',
  db: {
    collection: (name: string) => ({
      doc: (id: string) => docRef(`${name}/${id}`),
      get: async () => {
        const paths = [...docs.keys()].filter((p) => p.startsWith(`${name}/`));
        return { size: paths.length, docs: paths.map(snapshot) };
      },
    }),
    runTransaction: async <T>(body: (tx: unknown) => Promise<T>): Promise<T> => {
      transactions += 1;
      const pending: Array<() => void> = [];
      let reading = true;
      const tx = {
        get: async (ref: { path: string }) => {
          // 실제 Firestore 는 쓰기 뒤의 읽기를 거부한다. 같은 규칙을 여기서도 강제한다.
          if (!reading) throw new Error('READ_AFTER_WRITE');
          return snapshot(ref.path);
        },
        set: (ref: { path: string }, data: Record<string, unknown>, options?: { merge?: boolean }) => {
          reading = false;
          pending.push(() => write(ref.path, data, options));
        },
      };
      const result = await body(tx);
      for (const apply of pending) apply();
      return result;
    },
  },
}));

vi.mock('@google-cloud/kms', async () => await import('./helpers/fakeKms.js'));

const { PERSONS, PHONE_INDEX, USERS } = await import('../src/lib/db.js');
const { decryptField, piiAad } = await import('../src/lib/kms.js');
const { hmacPhone } = await import('../src/lib/phoneIndex.js');
const { startSignup } = await import('../src/functions/startSignup.js');
const functionsTest = (await import('firebase-functions-test')).default();

const wrapped = functionsTest.wrap(startSignup);
const auth = { uid: 'uid-1', token: { phone_number: PHONE } };

beforeEach(() => {
  docs.clear();
  directWrites = 0;
  transactions = 0;
});

describe('startSignup', () => {
  it('creates a level-0 pending person with a random personId, a users doc and a phone index entry', async () => {
    const result = (await wrapped({ data: {}, auth } as never)) as Record<string, unknown>;

    expect(result.personId).toMatch(/^0x[0-9a-f]{64}$/);
    expect(result).not.toHaveProperty('kycUrl'); // 가입은 더 이상 본인인증을 요구하지 않는다

    const person = snapshot(`${PERSONS}/${result.personId as string}`);
    expect(person.get('status')).toBe('pending');
    expect(person.get('kycLevel')).toBe(0);
    expect(person.get('kyc')).toBeUndefined();
    expect(person.get('createdAt')).toBeDefined();

    const user = snapshot(`${USERS}/uid-1`);
    expect(user.get('personId')).toBe(result.personId);
    expect(user.get('locale')).toBe('ko');
    expect(user.get('chatOrder')).toEqual([]);
    // 색인 문서 id 와 같은 값이라야 번호를 풀지 않고도 phoneIndex 로 갈 수 있다.
    expect(user.get('phoneHmac')).toBe(hmacPhone(PHONE, KEY));

    const index = snapshot(`${PHONE_INDEX}/${hmacPhone(PHONE, KEY)}`);
    expect(index.get('personId')).toBe(result.personId);
    expect([...docs.keys()].filter((p) => p.startsWith(`${PHONE_INDEX}/`))).toHaveLength(1);
  });

  it('writes the person, the user and the index in one transaction', async () => {
    await wrapped({ data: {}, auth } as never);
    expect(transactions).toBe(1);
    expect(directWrites).toBe(0);
  });

  it('never persists the phone number in the clear, and binds the envelope to personId:phoneE164', async () => {
    const { personId } = (await wrapped({ data: {}, auth } as never)) as { personId: string };

    const everythingWritten = JSON.stringify([...docs.entries()]);
    expect(everythingWritten).not.toContain(PHONE);
    expect(everythingWritten).not.toContain('821011112222');
    expect(snapshot(`${USERS}/uid-1`).get('phoneE164')).toBeUndefined();

    expect(snapshot(`${USERS}/uid-1`).get('phoneHmac')).toMatch(/^[0-9a-f]{64}$/);

    const envelope = snapshot(`${USERS}/uid-1`).get('phoneEnc') as string;
    expect(typeof envelope).toBe('string');
    await expect(decryptField(envelope, piiAad(personId as `0x${string}`, 'phoneE164'))).resolves.toBe(PHONE);
    // 다른 사람 문서로 봉투를 옮겨 붙이면 열리지 않는다.
    await expect(decryptField(envelope, piiAad('0xdead', 'phoneE164'))).rejects.toThrow();
  });

  it('indexes the phone under an HMAC that the raw number cannot be read back from', async () => {
    await wrapped({ data: {}, auth } as never);
    const [id] = [...docs.keys()].filter((p) => p.startsWith(`${PHONE_INDEX}/`)).map((p) => p.split('/')[1]);
    expect(id).toBe(createHmac('sha256', KEY).update(PHONE, 'utf8').digest('hex'));
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(id).not.toContain('821011112222');
  });

  it('returns the same personId when called twice (idempotent by uid)', async () => {
    const first = (await wrapped({ data: {}, auth } as never)) as { personId: string };
    const second = (await wrapped({ data: {}, auth } as never)) as { personId: string };
    expect(second.personId).toBe(first.personId);
    expect([...docs.keys()].filter((p) => p.startsWith(`${PERSONS}/`))).toHaveLength(1);
    expect(transactions).toBe(1); // 두 번째 호출은 아무것도 쓰지 않는다
  });

  it('refuses an unauthenticated caller and a session without a phone number', async () => {
    await expect(wrapped({ data: {} } as never)).rejects.toThrow('AUTH_REQUIRED');
    await expect(wrapped({ data: {}, auth: { uid: 'uid-2', token: {} } } as never)).rejects.toThrow(
      'PHONE_REQUIRED',
    );
    expect(docs.size).toBe(0);
  });

  it('refuses a second account on a phone number that is already registered', async () => {
    const first = (await wrapped({ data: {}, auth } as never)) as { personId: string };
    await expect(
      wrapped({ data: {}, auth: { uid: 'uid-9', token: { phone_number: PHONE } } } as never),
    ).rejects.toThrow('PHONE_ALREADY_REGISTERED');

    expect([...docs.keys()].filter((p) => p.startsWith(`${PERSONS}/`))).toHaveLength(1);
    expect(snapshot(`${USERS}/uid-9`).exists).toBe(false);
    expect(snapshot(`${PHONE_INDEX}/${hmacPhone(PHONE, KEY)}`).get('personId')).toBe(first.personId);
  });

  it('gives two different phone numbers two different persons', async () => {
    const a = (await wrapped({ data: {}, auth } as never)) as { personId: string };
    const b = (await wrapped({
      data: {},
      auth: { uid: 'uid-3', token: { phone_number: '+821033334444' } },
    } as never)) as { personId: string };
    expect(b.personId).not.toBe(a.personId);
    expect([...docs.keys()].filter((p) => p.startsWith(`${PHONE_INDEX}/`))).toHaveLength(2);
  });
});
