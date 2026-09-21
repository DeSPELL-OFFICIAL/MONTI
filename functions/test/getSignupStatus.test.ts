import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.GCP_PROJECT_ID = 'monti-dev';

const PERSON_ID = `0x${'aa'.repeat(32)}`;
const OTHER_PERSON_ID = `0x${'bb'.repeat(32)}`;
const ACCOUNT = '0x9999999999999999999999999999999999999999';

/**
 * `persons` · `users` · `passkeys` 세 컬렉션과 등식 질의만 흉내 내는 가짜 Firestore.
 * 에뮬레이터 없이 `pnpm test` 안에서 돈다(transferInvites.test.ts 와 같은 패턴).
 */
const docs = new Map<string, Record<string, unknown>>();
/** 쓰기 횟수. 상태 조회는 아무것도 쓰지 않아야 한다. */
let writeCount = 0;

/** 진짜 `DocumentSnapshot.get` 처럼 점 경로를 따라 들어간다(`kyc.lastReason`). */
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
    get: (name: string) => field(data, name),
    data: () => data,
  };
}

function query(name: string, filters: Array<[string, unknown]>, max: number) {
  return {
    where: (field: string, op: string, value: unknown) => {
      if (op !== '==') throw new Error(`UNSUPPORTED_OP:${op}`);
      return query(name, [...filters, [field, value]], max);
    },
    limit: (n: number) => query(name, filters, n),
    get: async () => {
      const matched = [...docs.entries()]
        .filter(([path]) => path.startsWith(`${name}/`))
        .filter(([, data]) => filters.every(([field, value]) => data[field] === value))
        .slice(0, max)
        .map(([path]) => snapshot(path));
      return { docs: matched, size: matched.length, empty: matched.length === 0 };
    },
  };
}

function collection(name: string) {
  return {
    ...query(name, [], Number.POSITIVE_INFINITY),
    doc: (id: string) => ({
      get: async () => snapshot(`${name}/${id}`),
      set: async () => {
        writeCount += 1;
      },
      update: async () => {
        writeCount += 1;
      },
    }),
  };
}

vi.mock('../src/lib/db.js', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/db.js')>('../src/lib/db.js');
  return { ...actual, db: { collection } };
});

const { ALLOWED_TRANSITIONS, PASSKEYS, PERSONS, USERS } = await import('../src/lib/db.js');
const { getSignupStatus } = await import('../src/functions/getSignupStatus.js');
const functionsTest = (await import('firebase-functions-test')).default();
const status = functionsTest.wrap(getSignupStatus);

/** 가입 도중이라 패스키 세션이 아직 없다 — 호출자는 언제나 Firebase 전화 사용자다. */
const auth = { uid: 'uid-1', token: { phone_number: '+821011112222' } };

function call(uid = 'uid-1') {
  return status({ data: {}, auth: { ...auth, uid } } as never) as Promise<Record<string, unknown>>;
}

/** 전화 가입만 끝난 사람. `startSignup` 이 실제로 쓰는 문서와 같은 모양이다. */
function signedUp(fields: Record<string, unknown> = {}): void {
  docs.set(`${USERS}/uid-1`, { personId: PERSON_ID, phoneEnc: 'AQAdRkFLRQ==', phoneHmac: 'hmac-1', locale: 'ko' });
  docs.set(`${PERSONS}/${PERSON_ID}`, { status: 'pending', kycLevel: 0, ...fields });
}

beforeEach(() => {
  docs.clear();
  writeCount = 0;
});

describe('getSignupStatus', () => {
  it('refuses an unauthenticated caller', async () => {
    await expect(status({ data: {} } as never)).rejects.toThrow('AUTH_REQUIRED');
  });

  it('answers status none for a uid that never started, instead of an error', async () => {
    // 로그인만 하고 `startSignup` 을 부르지 않은 uid — 재개할 가입이 없다.
    expect(await call('uid-9')).toEqual({ status: 'none', hasPasskey: false, hasAccount: false });

    // 사용자 문서는 있지만 personId 가 없는 반쪽 상태도 같다.
    docs.set(`${USERS}/uid-1`, { locale: 'ko' });
    expect(await call()).toEqual({ status: 'none', hasPasskey: false, hasAccount: false });

    // personId 는 있는데 사람 문서가 없다(지워졌다) — 역시 재개할 것이 없다.
    docs.set(`${USERS}/uid-1`, { personId: PERSON_ID });
    expect(await call()).toEqual({ status: 'none', hasPasskey: false, hasAccount: false });
  });

  it('reports a brand-new signup as pending with no passkey and no account', async () => {
    signedUp();
    expect(await call()).toEqual({
      status: 'pending',
      hasPasskey: false,
      hasAccount: false,
      kycLevel: 0,
      personId: PERSON_ID,
    });
  });

  it('reports the passkey and the counterfactual account once registerPasskey ran', async () => {
    signedUp({ account: ACCOUNT });
    docs.set(`${PASSKEYS}/cred-1`, { personId: PERSON_ID, counter: 0 });
    expect(await call()).toEqual({
      status: 'pending',
      hasPasskey: true,
      hasAccount: true,
      kycLevel: 0,
      personId: PERSON_ID,
    });
  });

  it('does not count another person passkey as this caller passkey', async () => {
    signedUp();
    docs.set(`${PASSKEYS}/cred-2`, { personId: OTHER_PERSON_ID });
    expect(await call()).toMatchObject({ hasPasskey: false });
  });

  it('carries every status of the real transition table through unchanged', async () => {
    // 상태의 원본은 `lib/db.ts` 의 표다. 여기에 목록을 베껴 적으면 표가 늘어날 때 조용히 늙는다.
    for (const person of Object.keys(ALLOWED_TRANSITIONS)) {
      signedUp({ status: person, account: ACCOUNT, kycLevel: 1 });
      expect(await call()).toEqual({
        status: person,
        hasPasskey: false,
        hasAccount: true,
        kycLevel: 1,
        personId: PERSON_ID,
      });
    }
  });

  it('narrows kycLevel to 0 or 1 and falls back to pending on a status it does not know', async () => {
    signedUp({ status: 'active', kycLevel: 2 });
    expect(await call()).toMatchObject({ status: 'active', kycLevel: 0 });

    signedUp({ status: 'half_done' });
    expect(await call()).toMatchObject({ status: 'pending', kycLevel: 0 });

    // 필드가 통째로 없는 오래된 문서도 가입 시작으로 읽는다.
    docs.set(`${PERSONS}/${PERSON_ID}`, {});
    expect(await call()).toMatchObject({ status: 'pending', kycLevel: 0 });
  });

  it('never returns phone, KYC session or encrypted fields, and writes nothing', async () => {
    signedUp({
      account: ACCOUNT,
      enc: { name: 'enc:x' },
      photoEnc: 'enc:photo',
      kyc: { provider: 'didit', sessionId: 'sess-1', url: 'https://verify.didit.me/s/sess-1', status: 'open' },
    });
    const result = await call();
    expect(Object.keys(result).sort()).toEqual(['hasAccount', 'hasPasskey', 'kycLevel', 'personId', 'status']);
    const json = JSON.stringify(result);
    expect(json).not.toContain('enc:');
    expect(json).not.toContain('didit');
    expect(json).not.toContain('+8210');
    expect(writeCount).toBe(0);
  });

  it('hands the web the decline reason it has no other way to read', async () => {
    signedUp({
      status: 'rejected',
      kyc: { provider: 'didit', sessionId: 's1', status: 'rejected', lastReason: 'duplicate_face' },
    });
    expect((await call()).kycReason).toBe('duplicate_face');

    // 통과한 사람에게는 지난 사유를 보내지 않는다.
    signedUp({ status: 'active', kycLevel: 1, kyc: { lastReason: 'declined' } });
    expect((await call()).kycReason).toBeUndefined();

    // 우리가 정한 네 값이 아니면 내보내지 않는다 — 웹이 그릴 화면이 없다.
    signedUp({ status: 'rejected', kyc: { lastReason: 'weird' } });
    expect((await call()).kycReason).toBeUndefined();

    signedUp({ status: 'active' });
    expect((await call()).kycReason).toBeUndefined();
  });
});
