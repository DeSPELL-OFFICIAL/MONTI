import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { Encoder } from 'cbor-x';

process.env.GCP_PROJECT_ID = 'monti-dev';
process.env.RP_ID = 'monti.app';

const RP = 'monti.app';
const ORIGIN = `https://${RP}`;
const PERSON_ID = `0x${'aa'.repeat(32)}`;
const ACCOUNT = '0x9999999999999999999999999999999999999999';
const PHONE_HMAC = 'f'.repeat(64);
const CREDENTIAL_ID = 'cred-1';

/**
 * `authChallenges` / `passkeys` / `persons` / `users` 네 컬렉션과 트랜잭션·단일 필드 질의만
 * 흉내 내는 가짜 Firestore. 에뮬레이터 없이 `pnpm test` 안에서 돈다(registerPasskey.test.ts 와 같은 패턴).
 */
const docs = new Map<string, Record<string, unknown>>();
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

function write(path: string, data: Record<string, unknown>, options?: { merge?: boolean }): void {
  const previous = options?.merge ? (docs.get(path) ?? {}) : {};
  docs.set(path, { ...previous, ...data });
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
    update: async (data: Record<string, unknown>) => {
      directWrites += 1;
      if (!docs.has(path)) throw new Error('NO_DOCUMENT_TO_UPDATE');
      write(path, data, { merge: true });
    },
  };
}

function collectionRef(name: string) {
  return {
    doc: (id: string) => {
      // 진짜 Firestore 는 문서 id 에 `/` 나 빈 문자열을 허용하지 않는다. 같은 규칙을 여기서도 강제한다.
      if (typeof id !== 'string' || id.length === 0 || id.includes('/')) throw new Error('BAD_DOCUMENT_PATH');
      return docRef(`${name}/${id}`);
    },
    where: (field: string, _op: string, value: unknown) => ({
      limit: (max: number) => ({
        get: async () => {
          const paths = [...docs.keys()].filter(
            (p) => p.startsWith(`${name}/`) && docs.get(p)?.[field] === value,
          );
          return { empty: paths.length === 0, docs: paths.slice(0, max).map(snapshot) };
        },
      }),
    }),
  };
}

const createCustomToken = vi.fn(
  async (uid: string, _claims?: Record<string, unknown>) => `token:${uid}`,
);

vi.mock('../src/lib/db.js', () => ({
  PERSONS: 'persons',
  USERS: 'users',
  PASSKEYS: 'passkeys',
  AUTH_CHALLENGES: 'authChallenges',
  authAdmin: { createCustomToken },
  db: {
    collection: collectionRef,
    runTransaction: async <T>(body: (tx: unknown) => Promise<T>): Promise<T> => {
      transactions += 1;
      const pending: Array<() => void> = [];
      let reading = true;
      const tx = {
        get: async (ref: { path: string }) => {
          if (!reading) throw new Error('READ_AFTER_WRITE');
          return snapshot(ref.path);
        },
        update: (ref: { path: string }, data: Record<string, unknown>) => {
          reading = false;
          if (!docs.has(ref.path)) throw new Error('NO_DOCUMENT_TO_UPDATE');
          pending.push(() => write(ref.path, data, { merge: true }));
        },
      };
      const result = await body(tx);
      for (const apply of pending) apply();
      return result;
    },
  },
}));

const { loginChallenge, loginVerify } = await import('../src/functions/login.js');
const functionsTest = (await import('firebase-functions-test')).default();
const challengeFn = functionsTest.wrap(loginChallenge);
const verifyFn = functionsTest.wrap(loginVerify);

const encoder = new Encoder({ useRecords: false, mapsAsObjects: false, tagUint8Array: false });
const passkey = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const attacker = generateKeyPairSync('ec', { namedCurve: 'P-256' });

/** COSE_Key: 1=kty(2 EC2), 3=alg(-7 ES256), -1=crv(1 P-256), -2=x, -3=y */
function coseKey(publicKey: KeyObject): Buffer {
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  return Buffer.from(
    encoder.encode(
      new Map<number, unknown>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, Buffer.from(jwk.x, 'base64url')],
        [-3, Buffer.from(jwk.y, 'base64url')],
      ]),
    ),
  );
}

interface AssertionOptions {
  challenge: unknown;
  origin?: string;
  rpId?: string;
  /** UP(0x01) | UV(0x04) */
  flags?: number;
  counter?: number;
  type?: string;
  credentialId?: string;
  /** 진짜 인증기가 아닌 키로 서명한다. */
  forged?: boolean;
}

/** 진짜 인증기가 만드는 것과 같은 구조의 ES256 어설션을 만든다(서명까지 진짜다). */
function makeAssertion(options: AssertionOptions) {
  const authData = Buffer.alloc(37);
  createHash('sha256').update(options.rpId ?? RP).digest().copy(authData, 0);
  authData[32] = options.flags ?? 0x05; // UP|UV
  authData.writeUInt32BE(options.counter ?? 0, 33);

  const clientDataJSON = Buffer.from(
    JSON.stringify({
      type: options.type ?? 'webauthn.get',
      challenge: options.challenge,
      origin: options.origin ?? ORIGIN,
      crossOrigin: false,
    }),
    'utf8',
  );
  const signatureBase = Buffer.concat([authData, createHash('sha256').update(clientDataJSON).digest()]);
  const signature = createSign('SHA256')
    .update(signatureBase)
    .end()
    .sign(options.forged ? attacker.privateKey : passkey.privateKey);

  const id = options.credentialId ?? CREDENTIAL_ID;
  return {
    id,
    rawId: id,
    type: 'public-key',
    clientExtensionResults: {},
    response: {
      clientDataJSON: clientDataJSON.toString('base64url'),
      authenticatorData: authData.toString('base64url'),
      signature: signature.toString('base64url'),
    },
  };
}

async function issue(purpose?: 'login' | 'register'): Promise<string> {
  const { challenge } = (await challengeFn({
    data: purpose ? { purpose } : {},
  } as never)) as { challenge: string };
  return challenge;
}

function login(assertion: unknown) {
  return verifyFn({ data: { assertion } } as never);
}

beforeEach(() => {
  docs.clear();
  directWrites = 0;
  transactions = 0;
  createCustomToken.mockClear();
  docs.set(`passkeys/${CREDENTIAL_ID}`, {
    personId: PERSON_ID,
    publicKeyCose: coseKey(passkey.publicKey).toString('base64'),
    counter: 3,
    transports: ['internal'],
    rpId: RP,
  });
  docs.set(`persons/${PERSON_ID}`, { status: 'active', account: ACCOUNT });
  docs.set('users/uid-1', { personId: PERSON_ID, phoneHmac: PHONE_HMAC });
});

describe('loginChallenge', () => {
  it('issues a fresh base64url challenge without requiring auth', async () => {
    const a = (await challengeFn({ data: {} } as never)) as { challenge: string; expiresAt: number };
    const b = (await challengeFn({ data: { purpose: 'register' } } as never)) as { challenge: string };

    expect(a.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(b.challenge).not.toBe(a.challenge);
    expect(a.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(snapshot(`authChallenges/${a.challenge}`).get('purpose')).toBe('login');
    expect(snapshot(`authChallenges/${b.challenge}`).get('purpose')).toBe('register');
    expect(snapshot(`authChallenges/${a.challenge}`).get('usedAt')).toBeUndefined();
    // 한 번 부르면 문서 하나만 쓴다(로그인 전에 인증 없이 불리는 함수라 쓰기를 늘리지 않는다).
    expect(directWrites).toBe(2);
    expect([...docs.keys()].filter((p) => p.startsWith('authChallenges/'))).toHaveLength(2);
  });

  it('treats anything but the register purpose as a login challenge', async () => {
    for (const purpose of [undefined, 'login', 'nonsense', 42, null]) {
      const { challenge } = (await challengeFn({ data: { purpose } } as never)) as { challenge: string };
      expect(snapshot(`authChallenges/${challenge}`).get('purpose')).toBe('login');
    }
  });
});

/** 참석자 안드로이드 앱의 서명 인증서 해시 — base64url SHA-256, 패딩 없이 43글자. */
const ANDROID_HASH = '0UBplgrJxGVdhlStTif_-sczxK2uPjwEiwb9-eotdAY';

describe('loginVerify', () => {
  it('returns a custom token, consumes the challenge and bumps the stored counter', async () => {
    const challenge = await issue();
    const result = (await login(makeAssertion({ challenge, counter: 5 }))) as {
      token: string;
      personId: string;
      account: string;
    };

    expect(result.personId).toBe(PERSON_ID);
    expect(result.account).toBe(ACCOUNT);
    expect(result.token).toBe('token:uid-1');
    expect(snapshot(`passkeys/${CREDENTIAL_ID}`).get('counter')).toBe(5);
    expect(snapshot(`passkeys/${CREDENTIAL_ID}`).get('lastUsedAt')).toBeDefined();
    expect(snapshot(`authChallenges/${challenge}`).get('usedAt')).toBeDefined();
  });

  it('puts personId and account into the custom token claims, and nothing else', async () => {
    const challenge = await issue();
    await login(makeAssertion({ challenge, counter: 5 }));

    expect(createCustomToken).toHaveBeenCalledWith('uid-1', { personId: PERSON_ID, account: ACCOUNT });
    // 커스텀 토큰은 클라이언트가 읽는다. 전화번호 같은 개인정보는 클레임에 싣지 않는다.
    expect(Object.keys(createCustomToken.mock.calls[0]?.[1] ?? {})).toEqual(['personId', 'account']);
  });

  it('signs in with the person existing uid and never mints a new one', async () => {
    docs.set('users/uid-other', { personId: `0x${'bb'.repeat(32)}` });
    const challenge = await issue();
    await login(makeAssertion({ challenge, counter: 5 }));

    expect(createCustomToken).toHaveBeenCalledTimes(1);
    expect(createCustomToken.mock.calls[0]?.[0]).toBe('uid-1');
    expect([...docs.keys()].filter((p) => p.startsWith('users/'))).toHaveLength(2);
  });

  it('accepts the android apk-key-hash origin', async () => {
    const saved = process.env.ANDROID_APK_KEY_HASH;
    process.env.ANDROID_APK_KEY_HASH = ANDROID_HASH;
    try {
      const challenge = await issue();
      const result = (await login(
        makeAssertion({ challenge, counter: 5, origin: `android:apk-key-hash:${ANDROID_HASH}` }),
      )) as { token: string };
      expect(result.token).toBe('token:uid-1');
    } finally {
      if (saved === undefined) delete process.env.ANDROID_APK_KEY_HASH;
      else process.env.ANDROID_APK_KEY_HASH = saved;
    }
  });

  it('accepts a counter that stays at zero — apple passkeys never count', async () => {
    write(`passkeys/${CREDENTIAL_ID}`, { counter: 0 }, { merge: true });
    const challenge = await issue();
    const result = (await login(makeAssertion({ challenge, counter: 0 }))) as { token: string };

    expect(result.token).toBe('token:uid-1');
    expect(snapshot(`passkeys/${CREDENTIAL_ID}`).get('counter')).toBe(0);
  });

  it('keeps the counter high-water mark when an authenticator reports zero', async () => {
    write(`passkeys/${CREDENTIAL_ID}`, { counter: 5 }, { merge: true });
    const challenge = await issue();
    const result = (await login(makeAssertion({ challenge, counter: 0 }))) as { token: string };

    // 0 을 보고하는 인증기 하나 때문에 눈금을 0 으로 되돌리면 1..5 가 전부 다시 통과한다.
    expect(result.token).toBe('token:uid-1');
    expect(snapshot(`passkeys/${CREDENTIAL_ID}`).get('counter')).toBe(5);
  });

  it('rejects a replayed counter and one that went backwards', async () => {
    const challenge = await issue();
    await expect(login(makeAssertion({ challenge, counter: 3 }))).rejects.toThrow('COUNTER_REPLAY');
    expect(snapshot(`passkeys/${CREDENTIAL_ID}`).get('counter')).toBe(3);

    write(`passkeys/${CREDENTIAL_ID}`, { counter: 5 }, { merge: true });
    const backwards = await issue();
    await expect(login(makeAssertion({ challenge: backwards, counter: 3 }))).rejects.toThrow(
      'COUNTER_REPLAY',
    );
    expect(snapshot(`passkeys/${CREDENTIAL_ID}`).get('counter')).toBe(5);
    expect(createCustomToken).not.toHaveBeenCalled();
  });

  it('rejects an unknown challenge', async () => {
    await expect(login(makeAssertion({ challenge: 'unknown-challenge' }))).rejects.toThrow(
      'CHALLENGE_NOT_FOUND',
    );
    expect(createCustomToken).not.toHaveBeenCalled();
  });

  it('consumes the challenge so the same assertion cannot be replayed', async () => {
    const challenge = await issue();
    const assertion = makeAssertion({ challenge, counter: 5 });
    await login(assertion);
    await expect(login(assertion)).rejects.toThrow('CHALLENGE_USED');
  });

  it('rejects an expired challenge', async () => {
    const challenge = await issue();
    write(`authChallenges/${challenge}`, { expiresAt: Math.floor(Date.now() / 1000) - 1 }, { merge: true });
    await expect(login(makeAssertion({ challenge, counter: 5 }))).rejects.toThrow('CHALLENGE_EXPIRED');
  });

  it('refuses a challenge that was issued for registration, and leaves it unconsumed', async () => {
    const challenge = await issue('register');
    await expect(login(makeAssertion({ challenge, counter: 5 }))).rejects.toThrow('BAD_CHALLENGE');
    expect(snapshot(`authChallenges/${challenge}`).get('usedAt')).toBeUndefined();
  });

  it('maps every library rejection to a 4xx instead of an INTERNAL', async () => {
    const cases: AssertionOptions[] = [
      { challenge: '', origin: 'https://evil.app' },
      { challenge: '', rpId: 'evil.app' },
      { challenge: '', flags: 0x01 }, // UP 만, UV 없음
      { challenge: '', type: 'webauthn.create' },
      { challenge: '', forged: true },
    ];
    for (const options of cases) {
      const challenge = await issue();
      await expect(login(makeAssertion({ ...options, challenge, counter: 5 }))).rejects.toThrow(
        'ASSERTION_REJECTED',
      );
    }
    expect(createCustomToken).not.toHaveBeenCalled();
  });

  it('refuses an assertion that is not an object, or is missing fields', async () => {
    for (const assertion of [undefined, null, '{}', 42, [], {}, { id: 'cred-1', type: 'public-key' }]) {
      await expect(login(assertion)).rejects.toThrow('BAD_ASSERTION');
    }
    expect(transactions).toBe(0);
  });

  it('refuses a credential id that cannot be a document id', async () => {
    const challenge = await issue();
    for (const credentialId of ['../../persons/xyz', 'a/b', '', 'x'.repeat(256)]) {
      await expect(login(makeAssertion({ challenge, credentialId }))).rejects.toThrow('BAD_ASSERTION');
    }
    expect(transactions).toBe(0);
  });

  it('refuses a clientDataJSON that is not decodable JSON and one without a challenge', async () => {
    const assertion = makeAssertion({ challenge: 'whatever-challenge' });
    const withClientData = (clientDataJSON: string) => ({
      ...assertion,
      response: { ...assertion.response, clientDataJSON },
    });

    await expect(login(withClientData('zzzz'))).rejects.toThrow('BAD_ASSERTION');
    const noChallenge = Buffer.from(JSON.stringify({ type: 'webauthn.get', origin: ORIGIN })).toString(
      'base64url',
    );
    await expect(login(withClientData(noChallenge))).rejects.toThrow('BAD_ASSERTION');
    expect(transactions).toBe(0);
  });

  it('refuses a challenge that is not a string or cannot be a document id', async () => {
    // 숫자·배열은 `RegExp.test` 가 문자열로 바꿔 통과시킨 뒤 문서 id 에서 터진다.
    for (const challenge of [1234567890123456789, ['aaaaaaaaaaaaaaaaaa'], 'short', 'a/b/c/evil-0123456']) {
      await expect(login(makeAssertion({ challenge }))).rejects.toThrow('BAD_CHALLENGE');
    }
    expect(transactions).toBe(0);
  });

  it('refuses an unknown credential, a dead person status, a person with no account and a missing user', async () => {
    const unknown = await issue();
    await expect(login(makeAssertion({ challenge: unknown, credentialId: 'cred-2' }))).rejects.toThrow(
      'CREDENTIAL_NOT_FOUND',
    );

    // `rotated` 는 계정이 넘어간 사람, `rejected` 는 거절된 사람이다. 둘 다 세션을 받지 못한다.
    for (const status of ['rotated', 'rejected']) {
      docs.set(`persons/${PERSON_ID}`, { status, account: ACCOUNT });
      const challenge = await issue();
      await expect(login(makeAssertion({ challenge, counter: 5 }))).rejects.toThrow('BAD_SIGNUP_STATE');
    }

    docs.set(`persons/${PERSON_ID}`, { status: 'pending' });
    const noAccount = await issue();
    await expect(login(makeAssertion({ challenge: noAccount, counter: 5 }))).rejects.toThrow('NO_ACCOUNT');

    docs.set(`persons/${PERSON_ID}`, { status: 'active', account: ACCOUNT });
    docs.delete('users/uid-1');
    const noUser = await issue();
    await expect(login(makeAssertion({ challenge: noUser, counter: 5 }))).rejects.toThrow('USER_NOT_FOUND');

    expect(createCustomToken).not.toHaveBeenCalled();
  });

  it('never stores the assertion material', async () => {
    const challenge = await issue();
    const assertion = makeAssertion({ challenge, counter: 5 });
    await login(assertion);

    const everythingWritten = JSON.stringify([...docs.entries()]);
    expect(everythingWritten).not.toContain(assertion.response.clientDataJSON);
    expect(everythingWritten).not.toContain(assertion.response.signature);
    expect(everythingWritten).not.toContain(assertion.response.authenticatorData);
  });
});
