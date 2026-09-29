import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { Encoder } from 'cbor-x';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { getAddress } from 'viem';
import type { AttesterTx } from '../src/lib/chain.js';

process.env.GCP_PROJECT_ID = 'monti-dev';
process.env.RP_ID = 'monti.app';
process.env.PHONE_INDEX_KEY = 'monti-test-key';

const RP = 'monti.app';
const ORIGIN = `https://${RP}`;
const PERSON_ID = `0x${'ab'.repeat(32)}`;
const OTHER_PERSON_ID = `0x${'cd'.repeat(32)}`;
const PHONE = '+15551230000';
const FACTORY = '0x00000000000000000000000000000000000f4c70';
const IDENTITY = '0x1111111111111111111111111111111111111111';
const ZERO_ADDR = '0x0000000000000000000000000000000000000000';
/** 옛 계정. 사람 문서에 적혀 있는 값이고, 회전 뒤 새 계정으로 바뀐다. */
const OLD_ACCOUNT = '0xabcdef0000000000000000000000000000000001';
/** 팩토리가 새 패스키로 돌려주는 값은 소문자다. 함수는 EIP-55 체크섬으로 고쳐 쓴다. */
const NEW_ACCOUNT_LOWER = '0x9f8ab3c1d2e4f5061728394a5b6c7d8e9f0a1b2c';
const NEW_ACCOUNT = getAddress(NEW_ACCOUNT_LOWER);
const ROTATE_TX = '0xrotatetx';
const X = `0x${'11'.repeat(32)}`;
const Y = `0x${'22'.repeat(32)}`;

/**
 * 세션이 방금 SMS 로 재인증됐고, 그 토큰에 번호가 실려 있다. 번호는 **토큰에서만** 읽는다.
 */
const auth = {
  uid: 'uid-1',
  token: { phone_number: PHONE, firebase: { sign_in_provider: 'phone' } },
};

// ───────────────────────────────────────────────────── 체인 가짜값(테스트마다 바꾼다)

let accountOfValue: string = OLD_ACCOUNT;
let personOfValue: string = ZERO_ADDR;
let rotatedAtValue: bigint = 0n;

const readContract = vi.fn(async (args: { functionName: string }) => {
  switch (args.functionName) {
    case 'getAddress':
      return NEW_ACCOUNT_LOWER;
    case 'accountOf':
      return accountOfValue;
    case 'personOf':
      return personOfValue;
    case 'rotatedAt':
      return rotatedAtValue;
    default:
      throw new Error(`UNEXPECTED_READ:${args.functionName}`);
  }
});
const waitForTransactionReceipt = vi.fn(async () => ({ status: 'success', blockNumber: 1n }));
const sendAttesterTx = vi.fn(async (_tx: AttesterTx) => ROTATE_TX);
const awaitFinalized = vi.fn(async () => {});

vi.mock('../src/lib/chain.js', () => ({
  deployment: () => ({ identity: IDENTITY, coinbaseFactory: FACTORY }),
  publicClient: () => ({ readContract, waitForTransactionReceipt }),
  sendAttesterTx,
  awaitFinalized,
}));

/** 어테스터 리스는 이 파일의 관심사가 아니다 — 넘긴 함수를 그대로 실행한다. */
vi.mock('../src/lib/attesterLock.js', () => ({
  sendSerialized: async <T>(fn: () => Promise<T>): Promise<T> => fn(),
}));

const mintSessionClaims = vi.fn(async () => {});
vi.mock('../src/lib/claims.js', () => ({ mintSessionClaims }));

/** 결정적 HMAC. 진짜 키 없이도 "같은 번호 → 같은 값" 만 지키면 된다. */
vi.mock('../src/lib/phoneIndex.js', () => ({ hmacPhone: (phone: string, _key: string) => `H:${phone}` }));

/** 거절 로그에 무엇이 실리는지 직접 본다 — 숨긴 번호가 로그로 새면 숨긴 뜻이 없다. */
const warn = vi.fn();
vi.mock('firebase-functions/logger', () => ({ warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() }));

// ───────────────────────────────────────────────────── 가짜 Firestore

/**
 * persons/users/passkeys/devices/authChallenges/recoveryQuota 컬렉션과 트랜잭션을 흉내 낸다.
 * registerIdentity.test.ts 의 중첩 맵 merge·`FieldValue.delete()` 처리에 `where().get()` 질의와
 * `tx.delete` 를 더했다. 읽기는 언제나 쓰기보다 먼저여야 한다.
 */
const docs = new Map<string, Record<string, unknown>>();
const createCustomToken = vi.fn(async (uid: string, _claims: Record<string, unknown>) => `token:${uid}`);
const setCustomUserClaims = vi.fn();

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
    if (isSentinel(value, DELETE)) delete out[key];
    else if (isSentinel(value, SERVER_TIMESTAMP)) out[key] = Timestamp.now();
    else if (isPlainObject(value)) {
      const previous = out[key];
      out[key] = deepMerge(
        previous && typeof previous === 'object' ? (previous as Record<string, unknown>) : {},
        value as Record<string, unknown>,
      );
    } else out[key] = value;
  }
  return out;
}

function write(path: string, data: Record<string, unknown>, options?: { merge?: boolean }): void {
  docs.set(path, deepMerge(options?.merge ? (docs.get(path) ?? {}) : {}, data));
}

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

function docRef(path: string) {
  return {
    path,
    id: path.slice(path.indexOf('/') + 1),
    get: async () => snapshot(path),
    set: async (data: Record<string, unknown>, options?: { merge?: boolean }) => write(path, data, options),
  };
}

interface Clause {
  f: string;
  op: string;
  v: unknown;
}

function queryRef(name: string, clauses: Clause[], lim: number | undefined) {
  return {
    where: (f: string, op: string, v: unknown) => queryRef(name, [...clauses, { f, op, v }], lim),
    limit: (n: number) => queryRef(name, clauses, n),
    get: async () => {
      const results: ReturnType<typeof snapshot>[] = [];
      for (const path of docs.keys()) {
        if (!path.startsWith(`${name}/`) || path.slice(name.length + 1).includes('/')) continue;
        const data = docs.get(path);
        if (clauses.every(({ f, op, v }) => op === '==' && field(data, f) === v)) {
          results.push(snapshot(path));
        }
      }
      const sliced = lim === undefined ? results : results.slice(0, lim);
      return { docs: sliced, empty: sliced.length === 0, size: sliced.length };
    },
  };
}

function collectionRef(name: string) {
  return {
    doc: (id: string) => docRef(`${name}/${id}`),
    where: (f: string, op: string, v: unknown) => queryRef(name, [{ f, op, v }], undefined),
  };
}

vi.mock('../src/lib/db.js', () => ({
  PERSONS: 'persons',
  USERS: 'users',
  PASSKEYS: 'passkeys',
  DEVICES: 'devices',
  AUTH_CHALLENGES: 'authChallenges',
  RECOVERY_QUOTA: 'recoveryQuota',
  authAdmin: { createCustomToken, setCustomUserClaims },
  db: {
    collection: (name: string) => collectionRef(name),
    runTransaction: async <T>(body: (tx: unknown) => Promise<T>): Promise<T> => {
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
        delete: (ref: { path: string }) => {
          reading = false;
          pending.push(() => docs.delete(ref.path));
        },
      };
      const result = await body(tx);
      for (const apply of pending) apply();
      return result;
    },
  },
}));

const { recoverAccess } = await import('../src/functions/recoverAccess.js');
const functionsTest = (await import('firebase-functions-test')).default();
const wrapped = functionsTest.wrap(recoverAccess);

// ───────────────────────────────────────────────────── 어테스테이션 헬퍼(registerPasskey.test 와 동일)

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
  flags?: number;
  alg?: number;
  crv?: number;
  counter?: number;
  credentialId?: Buffer;
  type?: string;
  truncateX?: boolean;
}

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

// ───────────────────────────────────────────────────── 시드

function seedPerson(extra: Record<string, unknown> = {}): void {
  write(`persons/${PERSON_ID}`, { status: 'active', kycLevel: 0, account: OLD_ACCOUNT, ...extra });
}

function seedUser(extra: Record<string, unknown> = {}): void {
  write(`users/${auth.uid}`, { personId: PERSON_ID, phoneHmac: `H:${PHONE}`, ...extra });
}

function seedOldPasskey(): void {
  write('passkeys/old-cred-000', { personId: PERSON_ID, publicKeyCose: 'old', counter: 0 });
}

function seedChallenge(challenge: string, extra: Record<string, unknown> = {}): void {
  write(`authChallenges/${challenge}`, {
    purpose: 'register',
    expiresAt: Math.floor(Date.now() / 1000) + 300,
    ...extra,
  });
}

interface Result {
  token: string;
  personId: string;
  account: string;
  txHash?: string;
  alreadyRotated?: true;
}

function call(data: Record<string, unknown>, customAuth: unknown = auth): Promise<Result> {
  return wrapped({ data, auth: customAuth } as never) as Promise<Result>;
}

beforeEach(() => {
  docs.clear();
  readContract.mockClear();
  waitForTransactionReceipt.mockReset();
  waitForTransactionReceipt.mockResolvedValue({ status: 'success', blockNumber: 1n });
  sendAttesterTx.mockReset();
  sendAttesterTx.mockResolvedValue(ROTATE_TX);
  awaitFinalized.mockClear();
  mintSessionClaims.mockClear();
  createCustomToken.mockClear();
  setCustomUserClaims.mockClear();
  warn.mockClear();
  accountOfValue = OLD_ACCOUNT;
  personOfValue = ZERO_ADDR;
  rotatedAtValue = 0n;
  seedPerson();
  seedUser();
  seedOldPasskey();
});

describe('recoverAccess — the happy path', () => {
  it('rotates the account to the new passkey, swaps the passkey doc and pends the new device', async () => {
    seedChallenge('chal-happy-0123456789');
    const { attestation, credentialId } = makeAttestation({ challenge: 'chal-happy-0123456789', counter: 7 });

    const result = await call({ personId: PERSON_ID, attestation, deviceX: X, deviceY: Y });

    // 회전을 어테스터로 한 번 보낸다.
    expect(sendAttesterTx).toHaveBeenCalledTimes(1);
    expect(sendAttesterTx.mock.calls[0]![0]).toMatchObject({
      address: IDENTITY,
      functionName: 'rotateAccount',
    });
    expect(sendAttesterTx.mock.calls[0]![0].args).toEqual([PERSON_ID, NEW_ACCOUNT]);

    // 옛 패스키는 지워지고 새 패스키가 들어온다.
    expect(docs.has('passkeys/old-cred-000')).toBe(false);
    const passkey = snapshot(`passkeys/${credentialId}`);
    expect(passkey.exists).toBe(true);
    expect(passkey.get('personId')).toBe(PERSON_ID);
    expect(passkey.get('counter')).toBe(7);
    expect(passkey.get('rpId')).toBe(RP);
    expect(passkey.get('createdAt')).toBeDefined();

    // 사람의 계정이 새 계정으로 바뀌고 상태는 그대로다(rotated 로 넘기지 않는다).
    const person = snapshot(`persons/${PERSON_ID}`);
    expect(person.get('account')).toBe(NEW_ACCOUNT);
    expect(person.get('status')).toBe('active');
    expect(person.get('chain.rotateTx')).toBe(ROTATE_TX);
    expect(person.get('chain.rotateBlock')).toBe(1);

    // 새 기기 키는 대기 사본으로만 적힌다.
    const device = snapshot(`devices/${NEW_ACCOUNT}`);
    expect(device.get('pendingChange.deviceX')).toBe(X);
    expect(device.get('pendingChange.deviceY')).toBe(Y);
    expect(device.get('pendingChange.method')).toBe('sms');

    // 세션·토큰은 새 계정으로 심는다.
    expect(mintSessionClaims).toHaveBeenCalledWith(auth.uid, PERSON_ID, NEW_ACCOUNT);
    expect(createCustomToken).toHaveBeenCalledWith(auth.uid, { personId: PERSON_ID, account: NEW_ACCOUNT });

    expect(result.token).toBe('token:uid-1');
    expect(result.account).toBe(NEW_ACCOUNT);
    expect(result.txHash).toBe(ROTATE_TX);
    expect(result.alreadyRotated).toBeUndefined();
    expect(awaitFinalized).toHaveBeenCalledWith(1n);
  });

  it('succeeds without a device write when deviceX/Y are omitted', async () => {
    seedChallenge('chal-nodevice-0123456789');
    const { attestation } = makeAttestation({ challenge: 'chal-nodevice-0123456789' });

    const result = await call({ personId: PERSON_ID, attestation });

    expect(sendAttesterTx).toHaveBeenCalledTimes(1);
    expect(docs.has(`devices/${NEW_ACCOUNT}`)).toBe(false);
    expect(result.account).toBe(NEW_ACCOUNT);
    expect(result.txHash).toBe(ROTATE_TX);
  });
});

describe('recoverAccess — a fresh SMS session is required', () => {
  it('refuses a session that was not re-verified by phone', async () => {
    seedChallenge('chal-nophone-0123456789');
    const { attestation } = makeAttestation({ challenge: 'chal-nophone-0123456789' });
    await expect(
      call(
        { personId: PERSON_ID, attestation, deviceX: X, deviceY: Y },
        { uid: 'uid-1', token: { phone_number: PHONE, firebase: { sign_in_provider: 'password' } } },
      ),
    ).rejects.toThrow('PHONE_REAUTH_REQUIRED');
    expect(sendAttesterTx).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith('recovery.rejected', {
      code: 'failed-precondition',
      reason: 'PHONE_REAUTH_REQUIRED',
    });
  });

  it('refuses when the phone HMAC does not match the stored index', async () => {
    seedUser({ phoneHmac: 'H:+19998887777' });
    seedChallenge('chal-mismatch-0123456789');
    const { attestation } = makeAttestation({ challenge: 'chal-mismatch-0123456789' });
    await expect(
      call({ personId: PERSON_ID, attestation, deviceX: X, deviceY: Y }),
    ).rejects.toThrow('PHONE_MISMATCH');
    expect(sendAttesterTx).not.toHaveBeenCalled();
    // 로그에 번호가 새지 않는다.
    for (const c of warn.mock.calls) expect(JSON.stringify(c)).not.toContain('1555');
  });
});

describe('recoverAccess — the caller and the person', () => {
  it("refuses a personId that is not the caller's own", async () => {
    const { attestation } = makeAttestation({ challenge: 'chal-foreign-0123456789' });
    await expect(
      call({ personId: OTHER_PERSON_ID, attestation, deviceX: X, deviceY: Y }),
    ).rejects.toThrow('PERSON_MISMATCH');
    expect(sendAttesterTx).not.toHaveBeenCalled();
  });

  it('refuses a person that is not in a recoverable state', async () => {
    const pending = makeAttestation({ challenge: 'chal-pending-0123456789' });
    seedPerson({ status: 'pending' });
    await expect(
      call({ personId: PERSON_ID, attestation: pending.attestation, deviceX: X, deviceY: Y }),
    ).rejects.toThrow('BAD_SIGNUP_STATE');

    const rotated = makeAttestation({ challenge: 'chal-rotated-0123456789' });
    seedPerson({ status: 'rotated' });
    await expect(
      call({ personId: PERSON_ID, attestation: rotated.attestation, deviceX: X, deviceY: Y }),
    ).rejects.toThrow('BAD_SIGNUP_STATE');
    expect(sendAttesterTx).not.toHaveBeenCalled();
  });

  it('refuses a person that never finished signup (no account)', async () => {
    docs.delete(`persons/${PERSON_ID}`);
    write(`persons/${PERSON_ID}`, { status: 'active', kycLevel: 0 });
    const { attestation } = makeAttestation({ challenge: 'chal-noacct-0123456789' });
    await expect(
      call({ personId: PERSON_ID, attestation, deviceX: X, deviceY: Y }),
    ).rejects.toThrow('NO_ACCOUNT');
    expect(sendAttesterTx).not.toHaveBeenCalled();
  });
});

describe('recoverAccess — throttling and the challenge', () => {
  it('refuses once the person has used three recoveries today, without sending a tx', async () => {
    const day = new Date().toISOString().slice(0, 10);
    write(`recoveryQuota/${PERSON_ID}`, { day, count: 3 });
    seedChallenge('chal-rate-0123456789');
    const { attestation } = makeAttestation({ challenge: 'chal-rate-0123456789' });
    await expect(
      call({ personId: PERSON_ID, attestation, deviceX: X, deviceY: Y }),
    ).rejects.toThrow('RECOVERY_RATE_LIMIT');
    expect(sendAttesterTx).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith('recovery.rejected', {
      code: 'resource-exhausted',
      reason: 'RECOVERY_RATE_LIMIT',
    });
  });

  it('refuses a reused, an expired and a login-purpose challenge', async () => {
    const used = makeAttestation({ challenge: 'chal-used-0123456789' });
    seedChallenge('chal-used-0123456789', { usedAt: Timestamp.now() });
    await expect(
      call({ personId: PERSON_ID, attestation: used.attestation, deviceX: X, deviceY: Y }),
    ).rejects.toThrow('CHALLENGE_USED');

    const expired = makeAttestation({ challenge: 'chal-expired-0123456789' });
    seedChallenge('chal-expired-0123456789', { expiresAt: Math.floor(Date.now() / 1000) - 1 });
    await expect(
      call({ personId: PERSON_ID, attestation: expired.attestation, deviceX: X, deviceY: Y }),
    ).rejects.toThrow('CHALLENGE_EXPIRED');

    const login = makeAttestation({ challenge: 'chal-login-0123456789' });
    seedChallenge('chal-login-0123456789', { purpose: 'login' });
    await expect(
      call({ personId: PERSON_ID, attestation: login.attestation, deviceX: X, deviceY: Y }),
    ).rejects.toThrow('BAD_CHALLENGE');

    expect(sendAttesterTx).not.toHaveBeenCalled();
  });

  it('refuses a forged non-P256 attestation', async () => {
    seedChallenge('chal-crv-0123456789');
    const { attestation } = makeAttestation({ challenge: 'chal-crv-0123456789', alg: -7, crv: 2 });
    await expect(
      call({ personId: PERSON_ID, attestation, deviceX: X, deviceY: Y }),
    ).rejects.toThrow('ATTESTATION_REJECTED');
    expect(sendAttesterTx).not.toHaveBeenCalled();
  });
});

describe('recoverAccess — the chain guards the rotation', () => {
  it('refuses when the new account is already registered to someone on chain', async () => {
    personOfValue = '0x00000000000000000000000000000000000000ff';
    seedChallenge('chal-taken-0123456789');
    const { attestation } = makeAttestation({ challenge: 'chal-taken-0123456789' });
    await expect(
      call({ personId: PERSON_ID, attestation, deviceX: X, deviceY: Y }),
    ).rejects.toThrow('ACCOUNT_TAKEN');
    expect(sendAttesterTx).not.toHaveBeenCalled();
  });

  it('refuses while the 7-day rotation cooldown is still active, and reports allowedAt', async () => {
    rotatedAtValue = BigInt(Math.floor(Date.now() / 1000));
    seedChallenge('chal-cooldown-0123456789');
    const { attestation } = makeAttestation({ challenge: 'chal-cooldown-0123456789' });

    let error: unknown;
    try {
      await call({ personId: PERSON_ID, attestation, deviceX: X, deviceY: Y });
    } catch (e) {
      error = e;
    }
    expect(error).toBeDefined();
    expect((error as Error).message).toBe('ROTATION_COOLDOWN');
    const details = (error as { details?: { allowedAt?: number; cooldownSeconds?: number } }).details;
    expect(details?.allowedAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(details?.cooldownSeconds).toBe(604_800);
    expect(sendAttesterTx).not.toHaveBeenCalled();
  });

  it('is idempotent when the chain already points at the new account (no second tx)', async () => {
    accountOfValue = NEW_ACCOUNT_LOWER;
    seedChallenge('chal-idem-0123456789');
    const { attestation, credentialId } = makeAttestation({ challenge: 'chal-idem-0123456789' });

    const result = await call({ personId: PERSON_ID, attestation, deviceX: X, deviceY: Y });

    expect(sendAttesterTx).not.toHaveBeenCalled();
    expect(result.alreadyRotated).toBe(true);
    expect(result.txHash).toBeUndefined();
    expect(result.account).toBe(NEW_ACCOUNT);
    // 여전히 새 패스키를 저장하고 옛 것을 지운다.
    expect(docs.has('passkeys/old-cred-000')).toBe(false);
    expect(snapshot(`passkeys/${credentialId}`).exists).toBe(true);
    expect(snapshot(`persons/${PERSON_ID}`).get('account')).toBe(NEW_ACCOUNT);
    expect(result.token).toBe('token:uid-1');
  });

  it('does not swap the account when the rotation transaction reverted', async () => {
    waitForTransactionReceipt.mockResolvedValueOnce({ status: 'reverted', blockNumber: 1n });
    seedChallenge('chal-revert-0123456789');
    const { attestation } = makeAttestation({ challenge: 'chal-revert-0123456789' });
    await expect(
      call({ personId: PERSON_ID, attestation, deviceX: X, deviceY: Y }),
    ).rejects.toThrow('ROTATE_REVERTED');
    expect(sendAttesterTx).toHaveBeenCalledTimes(1);
    // 회전이 되돌아갔으므로 계정은 옛 것 그대로다.
    expect(snapshot(`persons/${PERSON_ID}`).get('account')).toBe(OLD_ACCOUNT);
    expect(docs.has('passkeys/old-cred-000')).toBe(true);
  });
});

describe('recoverAccess — a phone number never leaks', () => {
  it('keeps the raw phone number out of the logs, the stored docs and the response', async () => {
    seedChallenge('chal-pii-0123456789');
    const { attestation } = makeAttestation({ challenge: 'chal-pii-0123456789' });
    const result = await call({ personId: PERSON_ID, attestation, deviceX: X, deviceY: Y });

    for (const c of warn.mock.calls) expect(JSON.stringify(c)).not.toContain('+1555');

    // recoverAccess 가 건드리는 문서(사람·패스키·기기·쿼터). users 는 시드일 뿐 이 함수가 쓰지 않는다.
    const written = [...docs.entries()].filter(([path]) => !path.startsWith('users/'));
    expect(JSON.stringify(written)).not.toContain('+1555');
    expect(JSON.stringify(written)).not.toContain(PHONE);

    expect(JSON.stringify(result)).not.toContain(PHONE);
    expect(Object.keys(createCustomToken.mock.calls[0]![1]).sort()).toEqual(['account', 'personId']);
  });
});
