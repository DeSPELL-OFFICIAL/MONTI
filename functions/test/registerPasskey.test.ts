import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { Encoder } from 'cbor-x';
import { getAddress } from 'viem';

process.env.GCP_PROJECT_ID = 'monti-dev';
process.env.RP_ID = 'monti.app';

const RP = 'monti.app';
const ORIGIN = `https://${RP}`;
const PERSON_ID = `0x${'ab'.repeat(32)}`;
const OTHER_PERSON_ID = `0x${'cd'.repeat(32)}`;
const FACTORY = '0x00000000000000000000000000000000000f4c70';
/** 팩토리가 돌려주는 값은 소문자다. 함수는 EIP-55 체크섬으로 고쳐서 돌려줘야 한다. */
const ACCOUNT_LOWER = '0x9f8ab3c1d2e4f5061728394a5b6c7d8e9f0a1b2c';

const { readContract } = vi.hoisted(() => ({ readContract: vi.fn() }));

/**
 * persons / users / passkeys / authChallenges 네 컬렉션과 트랜잭션만 흉내 내는 가짜 Firestore.
 * startSignup.test.ts 와 같은 패턴이고, 여기서는 tx.update 까지 필요하다.
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
  };
}

vi.mock('../src/lib/db.js', () => ({
  PERSONS: 'persons',
  USERS: 'users',
  PASSKEYS: 'passkeys',
  AUTH_CHALLENGES: 'authChallenges',
  db: {
    collection: (name: string) => ({ doc: (id: string) => docRef(`${name}/${id}`) }),
    runTransaction: async <T>(body: (tx: unknown) => Promise<T>): Promise<T> => {
      transactions += 1;
      const pending: Array<() => void> = [];
      let reading = true;
      const tx = {
        get: async (ref: { path: string }) => {
          if (!reading) throw new Error('READ_AFTER_WRITE');
          return snapshot(ref.path);
        },
        set: (ref: { path: string }, data: Record<string, unknown>, options?: { merge?: boolean }) => {
          reading = false;
          pending.push(() => write(ref.path, data, options));
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

vi.mock('../src/lib/chain.js', () => ({
  deployment: () => ({ coinbaseFactory: FACTORY }),
  publicClient: () => ({ readContract }),
}));

const { registerPasskey } = await import('../src/functions/registerPasskey.js');
const functionsTest = (await import('firebase-functions-test')).default();
const wrapped = functionsTest.wrap(registerPasskey);

const encoder = new Encoder({ useRecords: false, mapsAsObjects: false, tagUint8Array: false });

function p256Coordinates(): { x: Buffer; y: Buffer } {
  const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  return { x: Buffer.from(jwk.x, 'base64url'), y: Buffer.from(jwk.y, 'base64url') };
}

interface AttestationOptions {
  challenge: string;
  origin?: string;
  rpId?: string;
  /** UP(0x01) | UV(0x04) | AT(0x40) */
  flags?: number;
  alg?: number;
  crv?: number;
  counter?: number;
  credentialId?: Buffer;
  type?: string;
  /** x 좌표를 31바이트로 자른다 — 라이브러리가 좌표 길이를 보지 않는다는 사실의 회귀 테스트용. */
  truncateX?: boolean;
}

/** 진짜 인증기가 만드는 것과 같은 구조의 `none` 어테스테이션을 만든다(자기 서명이 없어 서명 검증도 없다). */
function makeAttestation(options: AttestationOptions) {
  const credentialId = options.credentialId ?? randomBytes(16);
  const { x, y } = p256Coordinates();
  const cose = Buffer.from(
    encoder.encode(
      new Map<number, unknown>([
        [1, 2],
        [3, options.alg ?? -7],
        [-1, options.crv ?? 1],
        [-2, options.truncateX ? x.subarray(0, 31) : x],
        [-3, y],
      ]),
    ),
  );

  const head = Buffer.alloc(37);
  createHash('sha256').update(options.rpId ?? RP).digest().copy(head, 0);
  head[32] = options.flags ?? 0x45;
  head.writeUInt32BE(options.counter ?? 0, 33);
  const credentialIdLength = Buffer.alloc(2);
  credentialIdLength.writeUInt16BE(credentialId.length, 0);
  const authData = Buffer.concat([head, Buffer.alloc(16, 0), credentialIdLength, credentialId, cose]);

  const attestationObject = Buffer.from(
    encoder.encode(
      new Map<string, unknown>([
        ['fmt', 'none'],
        ['attStmt', new Map()],
        ['authData', authData],
      ]),
    ),
  );
  const clientDataJSON = Buffer.from(
    JSON.stringify({
      type: options.type ?? 'webauthn.create',
      challenge: options.challenge,
      origin: options.origin ?? ORIGIN,
      crossOrigin: false,
    }),
    'utf8',
  );

  return {
    credentialId: credentialId.toString('base64url'),
    cose,
    attestation: {
      id: credentialId.toString('base64url'),
      rawId: credentialId.toString('base64url'),
      response: {
        clientDataJSON: clientDataJSON.toString('base64url'),
        attestationObject: attestationObject.toString('base64url'),
        transports: ['internal'],
      },
      type: 'public-key',
      clientExtensionResults: {},
    },
  };
}

function seedChallenge(challenge: string, extra: Record<string, unknown> = {}): void {
  docs.set(`authChallenges/${challenge}`, {
    purpose: 'register',
    expiresAt: Math.floor(Date.now() / 1000) + 300,
    ...extra,
  });
}

function seedPerson(personId: string, uid: string, extra: Record<string, unknown> = {}): void {
  docs.set(`persons/${personId}`, { status: 'pending', kycLevel: 0, ...extra });
  docs.set(`users/${uid}`, { personId });
}

const auth = { uid: 'uid-1', token: {} };

beforeEach(() => {
  docs.clear();
  directWrites = 0;
  transactions = 0;
  readContract.mockReset();
  readContract.mockResolvedValue(ACCOUNT_LOWER);
  seedPerson(PERSON_ID, 'uid-1');
});

describe('registerPasskey', () => {
  it('verifies the attestation, derives the counterfactual account and stores passkey + account together', async () => {
    seedChallenge('chal-happy-0123456789');
    const { attestation, credentialId, cose } = makeAttestation({ challenge: 'chal-happy-0123456789', counter: 7 });

    const result = (await wrapped({ data: { personId: PERSON_ID, attestation }, auth } as never)) as {
      ok: true;
      account: string;
      credentialId: string;
    };

    expect(result.ok).toBe(true);
    expect(result.credentialId).toBe(credentialId);
    expect(result.account).toBe(getAddress(ACCOUNT_LOWER));
    expect(result.account).not.toBe(ACCOUNT_LOWER); // 체크섬으로 고쳐서 돌려준다

    // 팩토리 호출: 소유자는 0x04 접두 없는 x‖y 64바이트 한 개, nonce 는 0.
    const call = readContract.mock.calls[0]?.[0] as {
      address: string;
      functionName: string;
      args: [string[], bigint];
    };
    expect(call.address).toBe(FACTORY);
    expect(call.functionName).toBe('getAddress');
    expect(call.args[1]).toBe(0n);
    expect(call.args[0]).toHaveLength(1);
    const owner = call.args[0][0] as string;
    expect(owner).toHaveLength(2 + 128); // 64바이트
    expect(Buffer.from(owner.slice(2), 'hex')).toHaveLength(64);

    const passkey = snapshot(`passkeys/${credentialId}`);
    expect(passkey.get('personId')).toBe(PERSON_ID);
    expect(passkey.get('publicKeyCose')).toBe(cose.toString('base64'));
    expect(passkey.get('counter')).toBe(7);
    expect(passkey.get('transports')).toEqual(['internal']);
    expect(passkey.get('rpId')).toBe(RP);
    expect(passkey.get('createdAt')).toBeDefined();

    expect(snapshot(`persons/${PERSON_ID}`).get('account')).toBe(getAddress(ACCOUNT_LOWER));
    // 챌린지 소비 1 + 패스키·사람 쓰기 1. 트랜잭션 밖 쓰기는 없다.
    expect(transactions).toBe(2);
    expect(directWrites).toBe(0);
  });

  it('never stores the raw attestation, only the COSE public key', async () => {
    seedChallenge('chal-raw-0123456789');
    const { attestation } = makeAttestation({ challenge: 'chal-raw-0123456789' });
    await wrapped({ data: { personId: PERSON_ID, attestation }, auth } as never);

    const everythingWritten = JSON.stringify([...docs.entries()]);
    expect(everythingWritten).not.toContain(attestation.response.attestationObject);
    expect(everythingWritten).not.toContain(attestation.response.clientDataJSON);
  });

  it('accepts the android apk-key-hash origin', async () => {
    const saved = process.env.ANDROID_APK_KEY_HASH;
    process.env.ANDROID_APK_KEY_HASH = 'kV8uQhash';
    try {
      seedChallenge('chal-android-0123456789');
      const { attestation } = makeAttestation({
        challenge: 'chal-android-0123456789',
        origin: 'android:apk-key-hash:kV8uQhash',
      });
      const result = (await wrapped({ data: { personId: PERSON_ID, attestation }, auth } as never)) as {
        ok: true;
      };
      expect(result.ok).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.ANDROID_APK_KEY_HASH;
      else process.env.ANDROID_APK_KEY_HASH = saved;
    }
  });

  it('refuses a challenge that was never issued', async () => {
    const { attestation } = makeAttestation({ challenge: 'never-issued-0123456' });
    await expect(
      wrapped({ data: { personId: PERSON_ID, attestation }, auth } as never),
    ).rejects.toThrow('CHALLENGE_NOT_FOUND');
    expect(docs.has(`passkeys/${attestation.id}`)).toBe(false);
    expect(snapshot(`persons/${PERSON_ID}`).get('account')).toBeUndefined();
  });

  it('consumes the challenge so the same attestation cannot be replayed', async () => {
    seedChallenge('chal-once-0123456789');
    const { attestation } = makeAttestation({ challenge: 'chal-once-0123456789' });
    await wrapped({ data: { personId: PERSON_ID, attestation }, auth } as never);
    expect(snapshot('authChallenges/chal-once-0123456789').get('usedAt')).toBeDefined();

    await expect(
      wrapped({ data: { personId: PERSON_ID, attestation }, auth } as never),
    ).rejects.toThrow('CHALLENGE_USED');
  });

  it('refuses an expired challenge', async () => {
    seedChallenge('chal-old-0123456789', { expiresAt: Math.floor(Date.now() / 1000) - 1 });
    const { attestation } = makeAttestation({ challenge: 'chal-old-0123456789' });
    await expect(
      wrapped({ data: { personId: PERSON_ID, attestation }, auth } as never),
    ).rejects.toThrow('CHALLENGE_EXPIRED');
  });

  it('refuses a foreign origin, a foreign rpIdHash, an unverified user and a wrong COSE algorithm', async () => {
    const cases: Array<[string, AttestationOptions]> = [
      ['chal-origin-0123456789', { challenge: 'chal-origin-0123456789', origin: 'https://evil.app' }],
      ['chal-rpid-0123456789', { challenge: 'chal-rpid-0123456789', rpId: 'evil.app' }],
      ['chal-uv-0123456789', { challenge: 'chal-uv-0123456789', flags: 0x41 }], // UP|AT, UV 없음
      ['chal-alg-0123456789', { challenge: 'chal-alg-0123456789', alg: -35, crv: 2 }], // ES384
      ['chal-type-0123456789', { challenge: 'chal-type-0123456789', type: 'webauthn.get' }],
    ];
    for (const [challenge, options] of cases) {
      seedChallenge(challenge);
      const { attestation } = makeAttestation(options);
      await expect(
        wrapped({ data: { personId: PERSON_ID, attestation }, auth } as never),
      ).rejects.toThrow('ATTESTATION_REJECTED');
    }
    expect(snapshot(`persons/${PERSON_ID}`).get('account')).toBeUndefined();
    expect(readContract).not.toHaveBeenCalled();
  });

  it('refuses an empty attestation object, an attestation string and missing fields', async () => {
    seedChallenge('chal-empty-0123456789');
    for (const attestation of [{}, '{}', null, { id: 'abc', type: 'public-key' }]) {
      await expect(
        wrapped({ data: { personId: PERSON_ID, attestation }, auth } as never),
      ).rejects.toThrow('BAD_ATTESTATION');
    }
    expect(transactions).toBe(0);
  });

  it('refuses a credential id that is already registered', async () => {
    seedChallenge('chal-first-0123456789');
    const first = makeAttestation({ challenge: 'chal-first-0123456789' });
    await wrapped({ data: { personId: PERSON_ID, attestation: first.attestation }, auth } as never);

    // 다른 사람이 같은 credential id 를 다시 들고 온다.
    seedPerson(OTHER_PERSON_ID, 'uid-2');
    seedChallenge('chal-second-0123456789');
    const stolen = makeAttestation({
      challenge: 'chal-second-0123456789',
      credentialId: Buffer.from(first.credentialId, 'base64url'),
    });
    await expect(
      wrapped({
        data: { personId: OTHER_PERSON_ID, attestation: stolen.attestation },
        auth: { uid: 'uid-2', token: {} },
      } as never),
    ).rejects.toThrow('CREDENTIAL_EXISTS');

    expect(snapshot(`passkeys/${first.credentialId}`).get('personId')).toBe(PERSON_ID);
    expect(snapshot(`persons/${OTHER_PERSON_ID}`).get('account')).toBeUndefined();
  });

  it('refuses a second passkey for a person that already has an account', async () => {
    seedChallenge('chal-a-0123456789');
    await wrapped({
      data: { personId: PERSON_ID, attestation: makeAttestation({ challenge: 'chal-a-0123456789' }).attestation },
      auth,
    } as never);

    seedChallenge('chal-b-0123456789');
    await expect(
      wrapped({
        data: { personId: PERSON_ID, attestation: makeAttestation({ challenge: 'chal-b-0123456789' }).attestation },
        auth,
      } as never),
    ).rejects.toThrow('PASSKEY_ALREADY_REGISTERED');
  });

  it('refuses a personId that is not the caller own', async () => {
    docs.set(`persons/${OTHER_PERSON_ID}`, { status: 'pending' });
    seedChallenge('chal-foreign-0123456789');
    const { attestation } = makeAttestation({ challenge: 'chal-foreign-0123456789' });
    await expect(
      wrapped({ data: { personId: OTHER_PERSON_ID, attestation }, auth } as never),
    ).rejects.toThrow('PERSON_MISMATCH');
    expect(transactions).toBe(0);
  });

  it('refuses an unauthenticated caller, a malformed personId and a person that is past signup', async () => {
    const { attestation } = makeAttestation({ challenge: 'chal-x-0123456789' });
    await expect(wrapped({ data: { personId: PERSON_ID, attestation } } as never)).rejects.toThrow(
      'AUTH_REQUIRED',
    );
    await expect(wrapped({ data: { personId: '0xdead', attestation }, auth } as never)).rejects.toThrow(
      'BAD_PERSON_ID',
    );

    docs.set(`persons/${PERSON_ID}`, { status: 'rotated' });
    await expect(wrapped({ data: { personId: PERSON_ID, attestation }, auth } as never)).rejects.toThrow(
      'BAD_SIGNUP_STATE',
    );
    expect(transactions).toBe(0);
  });
  it('refuses a clientDataJSON that is not decodable JSON and one without a challenge', async () => {
    const { attestation } = makeAttestation({ challenge: 'chal-broken-0123456789' });
    const withClientData = (clientDataJSON: string) => ({
      ...attestation,
      response: { ...attestation.response, clientDataJSON },
    });

    // base64url 은 풀리지만 JSON 이 아니다.
    await expect(
      wrapped({ data: { personId: PERSON_ID, attestation: withClientData('zzzz') }, auth } as never),
    ).rejects.toThrow('BAD_ATTESTATION');

    const noChallenge = Buffer.from(
      JSON.stringify({ type: 'webauthn.create', origin: ORIGIN }),
      'utf8',
    ).toString('base64url');
    await expect(
      wrapped({ data: { personId: PERSON_ID, attestation: withClientData(noChallenge) }, auth } as never),
    ).rejects.toThrow('BAD_ATTESTATION');

    expect(transactions).toBe(0);
  });

  it('refuses a challenge string that cannot be a document id', async () => {
    for (const challenge of ['a/b/c/evil-0123456', 'short', '../../persons/xyz-0123', 'chal with spaces 0']) {
      const { attestation } = makeAttestation({ challenge });
      await expect(
        wrapped({ data: { personId: PERSON_ID, attestation }, auth } as never),
      ).rejects.toThrow('BAD_CHALLENGE');
    }
    expect(transactions).toBe(0); // 문서 id 로 쓰기 전에 끝난다
  });

  it('refuses a challenge that was issued for login, and leaves it unconsumed', async () => {
    seedChallenge('chal-login-0123456789', { purpose: 'login' });
    const { attestation } = makeAttestation({ challenge: 'chal-login-0123456789' });
    await expect(
      wrapped({ data: { personId: PERSON_ID, attestation }, auth } as never),
    ).rejects.toThrow('BAD_CHALLENGE');
    expect(snapshot('authChallenges/chal-login-0123456789').get('usedAt')).toBeUndefined();
    expect(snapshot(`persons/${PERSON_ID}`).get('account')).toBeUndefined();
  });

  it('refuses a forged none attestation whose key passes the library but is not P-256', async () => {
    // 라이브러리는 alg 만 본다. crv·좌표 길이는 우리가 봐야 한다(fmt:'none' 은 서명 검증도 없다).
    const cases: Array<[string, AttestationOptions]> = [
      ['chal-crv-0123456789', { challenge: 'chal-crv-0123456789', alg: -7, crv: 2 }],
      ['chal-coord-0123456789', { challenge: 'chal-coord-0123456789', alg: -7, truncateX: true }],
    ];
    for (const [challenge, options] of cases) {
      seedChallenge(challenge);
      const { attestation } = makeAttestation(options);
      await expect(
        wrapped({ data: { personId: PERSON_ID, attestation }, auth } as never),
      ).rejects.toThrow('ATTESTATION_REJECTED');
    }
    expect(readContract).not.toHaveBeenCalled();
    expect(snapshot(`persons/${PERSON_ID}`).get('account')).toBeUndefined();
  });
});
