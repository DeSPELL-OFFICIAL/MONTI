import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import type { Abi } from 'viem';
import type { Hex } from '@monti/shared';
import type { AttesterTx } from '../src/lib/chain.js';

process.env.GCP_PROJECT_ID = 'monti-dev';

const PERSON_ID = `0x${'aa'.repeat(32)}`;
const X = `0x${'11'.repeat(32)}`;
const Y = `0x${'22'.repeat(32)}`;
const ACCOUNT = '0x9999999999999999999999999999999999999999';
const IDENTITY = '0x1111111111111111111111111111111111111111';
const TX = '0xabc';
const OTHER_TX = '0xdef';
const auth = { uid: 'uid-1', token: {} };

/**
 * persons / devices / system 세 컬렉션과 트랜잭션만 흉내 내는 가짜 Firestore.
 * startSignup.test.ts 와 같은 패턴이고, 여기서는 중첩 맵 merge 와
 * `FieldValue.delete()` 까지 진짜 Firestore 와 똑같이 움직여야 한다
 * (`chain.registerPending` 을 지우면서 `chain.registerTx` 를 날리면 안 된다).
 */
const docs = new Map<string, Record<string, unknown>>();
/** 세션 클레임. loginVerify 가 만드는 것과 같은 모양이어야 웹이 토큰 하나만 새로 받으면 된다. */
const setCustomUserClaims = vi.fn(async (_uid: string, _claims: Record<string, unknown>) => {});
/** 체인 호출이 트랜잭션 안에서 일어나면 실제 Firestore 는 재시도로 중복 전송을 만든다. */
let inTransaction = false;
/** 리스 반납(`holder: null` 쓰기)만 골라 실패시킨다. 반납이 결과를 덮어쓰는지 보는 용도다. */
let failLeaseRelease = false;

const DELETE = FieldValue.delete();
const SERVER_TIMESTAMP = FieldValue.serverTimestamp();

function isSentinel(value: unknown, sentinel: FieldValue): boolean {
  const candidate = value as FieldValue | undefined;
  return typeof candidate?.isEqual === 'function' && candidate.isEqual(sentinel);
}

/** 중첩 맵만 깊게 합친다. Timestamp 같은 클래스 인스턴스는 통째로 갈아 끼운다. */
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
  };
}

vi.mock('../src/lib/db.js', async () => {
  const real = await vi.importActual<typeof import('../src/lib/db.js')>('../src/lib/db.js');
  return {
    PERSONS: 'persons',
    USERS: 'users',
    DEVICES: 'devices',
    SYSTEM: 'system',
    assertStatusTransition: real.assertStatusTransition,
    authAdmin: { setCustomUserClaims },
    db: {
      collection: (name: string) => ({ doc: (id: string) => docRef(`${name}/${id}`) }),
      runTransaction: async <T>(body: (tx: unknown) => Promise<T>): Promise<T> => {
        inTransaction = true;
        const pending: Array<() => void> = [];
        let reading = true;
        const tx = {
          get: async (ref: { path: string }) => {
            if (!reading) throw new Error('READ_AFTER_WRITE');
            return snapshot(ref.path);
          },
          set: (ref: { path: string }, data: Record<string, unknown>, options?: { merge?: boolean }) => {
            reading = false;
            if (failLeaseRelease && data.holder === null) throw new Error('FIRESTORE_UNAVAILABLE');
            pending.push(() => write(ref.path, data, options));
          },
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
  };
});

/** db.ts 를 통째로 mock 하므로 firebase-admin 앱 초기화는 일어나지 않는다. */
function guard<T>(value: T): T {
  if (inTransaction) throw new Error('CHAIN_CALL_INSIDE_TRANSACTION');
  return value;
}

const sendAttesterTx = vi.fn(async (_tx: AttesterTx) => guard(TX));
// `publicClient()` 를 통째로 가짜로 바꾸므로, 인자는 실제 호출부가 넘기는 모양 그대로 적는다 —
// 빈 인자로 두면 `mock.calls[0][0]` 이 타입상 존재하지 않는 칸이 된다.
const readContract = vi.fn(
  async (_args: { address: Hex; abi: Abi; functionName: string; args: readonly unknown[] }) =>
    guard(false),
);
const waitForTransactionReceipt = vi.fn(async () => guard({ status: 'success', blockNumber: 100n }));
const awaitFinalized = vi.fn(async (_blockNumber: bigint) => guard(undefined));

vi.mock('../src/lib/chain.js', () => ({
  sendAttesterTx,
  awaitFinalized,
  publicClient: () => ({ readContract, waitForTransactionReceipt }),
  deployment: () => ({ identity: IDENTITY }),
}));

/**
 * 계정 사전 배포는 그 자체 테스트(predeployAccount.test.ts)가 있으므로 여기서는 스파이로 둔다 —
 * 이 파일은 "등록이 끝난 뒤에만, 그리고 등록을 막지 않고 불린다" 만 확인한다.
 */
const predeployAccount = vi.fn(async (_params: unknown) => {});
vi.mock('../src/lib/predeployAccount.js', () => ({ predeployAccount }));

const { registerIdentity } = await import('../src/functions/registerIdentity.js');
const functionsTest = (await import('firebase-functions-test')).default();
const wrapped = functionsTest.wrap(registerIdentity);

function call(data: Record<string, unknown> = { personId: PERSON_ID, deviceX: X, deviceY: Y }) {
  return wrapped({ data, auth } as never) as Promise<{ txHash: string }>;
}

/** 호출자와 사람을 묶는 문서. 이 묶음이 없으면 어떤 경로도 통과하지 못한다. */
function seedCaller(personId: string = PERSON_ID): void {
  write(`users/${auth.uid}`, { personId });
}

/** 가입 직전의 사람. `docs.clear()` 한 테스트가 다시 세운다. */
function seedPerson(extra: Record<string, unknown> = {}): void {
  write(`persons/${PERSON_ID}`, { status: 'pending', kycLevel: 0, account: ACCOUNT, ...extra });
}

beforeEach(() => {
  docs.clear();
  inTransaction = false;
  failLeaseRelease = false;
  sendAttesterTx.mockClear();
  readContract.mockClear();
  waitForTransactionReceipt.mockClear();
  awaitFinalized.mockClear();
  setCustomUserClaims.mockClear();
  predeployAccount.mockClear();
  seedCaller();
  seedPerson();
});

describe('registerIdentity — the happy path', () => {
  it('sends Identity.register once and marks the person active after finality', async () => {
    const result = await call();
    expect(result.txHash).toBe(TX);
    expect(sendAttesterTx).toHaveBeenCalledTimes(1);
    expect(sendAttesterTx.mock.calls[0]![0]).toMatchObject({
      address: IDENTITY,
      functionName: 'register',
    });
    expect(sendAttesterTx.mock.calls[0]![0].args).toEqual([PERSON_ID, ACCOUNT, X, Y, 0]);

    const person = snapshot(`persons/${PERSON_ID}`);
    expect(person.get('status')).toBe('active');
    expect(person.get('chain.registerTx')).toBe(TX);
    expect(person.get('chain.block')).toBe(100);
    expect(person.get('chain.registerPending')).toBeUndefined();
    expect(awaitFinalized).toHaveBeenCalledWith(100n);
  });

  it('creates devices/{account} server-side, which the rules deny to clients', async () => {
    await call({ personId: PERSON_ID, deviceX: X, deviceY: Y, platform: 'android' });
    const device = snapshot(`devices/${ACCOUNT}`);
    expect(device.exists).toBe(true);
    expect(device.get('deviceX')).toBe(X);
    expect(device.get('deviceY')).toBe(Y);
    expect(device.get('platform')).toBe('android');
    // 개인정보는 한 글자도 들어가지 않는다.
    expect(Object.keys(device.data() ?? {}).sort()).toEqual([
      'deviceX',
      'deviceY',
      'platform',
      'updatedAt',
    ]);
  });

  it("defaults the device platform to 'web' and refuses an unknown one", async () => {
    await call();
    expect(snapshot(`devices/${ACCOUNT}`).get('platform')).toBe('web');
    docs.clear();
    seedCaller();
    seedPerson();
    await expect(
      call({ personId: PERSON_ID, deviceX: X, deviceY: Y, platform: 'watch' }),
    ).rejects.toThrow('BAD_PLATFORM');
  });

  it('takes the KYC level from the person document rather than hard-coding it', async () => {
    write(`persons/${PERSON_ID}`, { status: 'active', kycLevel: 1 }, { merge: true });
    await call();
    expect(sendAttesterTx.mock.calls[0]![0].args[4]).toBe(1);
  });

  it('releases the attester lease it took', async () => {
    await call();
    expect(field(docs.get('system/attester'), 'lockedUntil')).toBe(0);
  });
});

describe('registerIdentity — idempotency (spec §10.4 rule 3)', () => {
  it('is idempotent for the same personId', async () => {
    const first = await call();
    const second = await call();
    expect(second.txHash).toBe(first.txHash);
    expect(sendAttesterTx).toHaveBeenCalledTimes(1);
  });

  it('waits on an in-flight transaction instead of sending a second one', async () => {
    write(`persons/${PERSON_ID}`, { chain: { registerTx: OTHER_TX } }, { merge: true });
    const result = await call();
    expect(result.txHash).toBe(OTHER_TX);
    expect(sendAttesterTx).not.toHaveBeenCalled();
    expect(waitForTransactionReceipt).toHaveBeenCalledWith(
      expect.objectContaining({ hash: OTHER_TX }),
    );
    expect(snapshot(`persons/${PERSON_ID}`).get('status')).toBe('active');
    expect(snapshot(`persons/${PERSON_ID}`).get('chain.block')).toBe(100);
  });

  it('never re-reads a finalized transaction from the chain', async () => {
    write(`persons/${PERSON_ID}`, { chain: { registerTx: OTHER_TX, block: 12 } }, { merge: true });
    await expect(call()).resolves.toEqual({ txHash: OTHER_TX, claimsUpdated: true });
    expect(waitForTransactionReceipt).not.toHaveBeenCalled();
    expect(readContract).not.toHaveBeenCalled();
  });

  it('reconciles the database and reports success when the account is already a member', async () => {
    readContract.mockResolvedValueOnce(true as never);
    // 이미 끝난 등록은 오류가 아니라 성공이다. 오류로 올리면 일반적인 콜러블 래퍼가
    // 멀쩡히 가입된 사람에게 실패 화면을 보여 준다. 우리가 보낸 적이 없으니 txHash 는 없다.
    await expect(call()).resolves.toEqual({ alreadyRegistered: true, claimsUpdated: true });
    expect(sendAttesterTx).not.toHaveBeenCalled();
    expect(readContract.mock.calls[0]![0]).toMatchObject({
      address: IDENTITY,
      functionName: 'isMember',
      args: [ACCOUNT],
    });
    expect(snapshot(`persons/${PERSON_ID}`).get('status')).toBe('active');
  });

  it('refuses a second concurrent call while the first is still sending', async () => {
    write(
      `persons/${PERSON_ID}`,
      { chain: { registerPending: true, registerPendingAt: Date.now() } },
      { merge: true },
    );
    await expect(call()).rejects.toThrow('REGISTER_IN_FLIGHT');
    expect(sendAttesterTx).not.toHaveBeenCalled();
  });

  it('steps over a pending flag left behind by an instance that died mid-send', async () => {
    // 딱지만 있고 해시가 없는 상태는 전송 도중 죽은 인스턴스가 남긴 것이다.
    // 만료가 없으면 이 사람은 영영 가입을 못 하고, Task 23 이 쓸 해시도 없다.
    write(
      `persons/${PERSON_ID}`,
      { chain: { registerPending: true, registerPendingAt: Date.now() - 61_000 } },
      { merge: true },
    );
    await expect(call()).resolves.toEqual({ txHash: TX, claimsUpdated: true });
    expect(sendAttesterTx).toHaveBeenCalledTimes(1);
    const person = snapshot(`persons/${PERSON_ID}`);
    expect(person.get('status')).toBe('active');
    expect(person.get('chain.registerPending')).toBeUndefined();
    expect(person.get('chain.registerPendingAt')).toBeUndefined();
  });

  it('treats a pending flag with no timestamp as stale', async () => {
    write(`persons/${PERSON_ID}`, { chain: { registerPending: true } }, { merge: true });
    await expect(call()).resolves.toEqual({ txHash: TX, claimsUpdated: true });
  });
});

describe('registerIdentity — the attester is a single key', () => {
  it('refuses to send while another attester transaction holds the lease', async () => {
    write('system/attester', { holder: 'someone-else', lockedUntil: Date.now() + 10_000 });
    await expect(call()).rejects.toThrow('ATTESTER_BUSY');
    expect(sendAttesterTx).not.toHaveBeenCalled();
    // 잠금 실패로 끝난 자리에 pending 딱지가 남으면 이 사람은 영원히 가입을 못 한다.
    expect(snapshot(`persons/${PERSON_ID}`).get('chain.registerPending')).toBeUndefined();
    expect(field(docs.get('system/attester'), 'holder')).toBe('someone-else');
  });

  it('takes an expired lease over', async () => {
    write('system/attester', { holder: 'someone-else', lockedUntil: Date.now() - 1 });
    await expect(call()).resolves.toEqual({ txHash: TX, claimsUpdated: true });
  });

  it('retries once when the node rejects the nonce as too low', async () => {
    sendAttesterTx.mockRejectedValueOnce(new Error('nonce too low'));
    await expect(call()).resolves.toEqual({ txHash: TX, claimsUpdated: true });
    expect(sendAttesterTx).toHaveBeenCalledTimes(2);
    expect(snapshot(`persons/${PERSON_ID}`).get('status')).toBe('active');
  });

  it.each(['already known', 'replacement transaction underpriced'])(
    'never retries "%s" — that nonce is already in the pool, so a retry sends a second register',
    async (message) => {
      sendAttesterTx.mockRejectedValueOnce(new Error(message));
      await expect(call()).rejects.toThrow(`REGISTER_SEND_FAILED:${message}`);
      expect(sendAttesterTx).toHaveBeenCalledTimes(1);
      expect(snapshot(`persons/${PERSON_ID}`).get('chain.registerTx')).toBeUndefined();
      expect(snapshot(`persons/${PERSON_ID}`).get('chain.registerPending')).toBeUndefined();
    },
  );

  it('still returns the hash when giving the lease back fails', async () => {
    // 반납 실패가 결과를 덮어쓰면 보내 놓고 기록하지 못한 트랜잭션이 남는다 —
    // 세 겹 멱등 장치 중 어느 것도 복구하지 못하는 유일한 상태다.
    failLeaseRelease = true;
    await expect(call()).resolves.toEqual({ txHash: TX, claimsUpdated: true });
    expect(snapshot(`persons/${PERSON_ID}`).get('chain.registerTx')).toBe(TX);
    expect(snapshot(`persons/${PERSON_ID}`).get('status')).toBe('active');
  });

  it('gives the lease back and clears the pending flag when the send fails for good', async () => {
    sendAttesterTx.mockRejectedValue(new Error('insufficient funds'));
    await expect(call()).rejects.toThrow('REGISTER_SEND_FAILED:insufficient funds');
    expect(field(docs.get('system/attester'), 'lockedUntil')).toBe(0);
    expect(snapshot(`persons/${PERSON_ID}`).get('chain.registerPending')).toBeUndefined();
    expect(snapshot(`persons/${PERSON_ID}`).get('status')).toBe('pending');
    sendAttesterTx.mockReset();
    sendAttesterTx.mockImplementation(async () => guard(TX));
  });
});

describe('registerIdentity — failures leave the person repairable', () => {
  it('does not advance the status when the transaction reverted', async () => {
    waitForTransactionReceipt.mockResolvedValueOnce({
      status: 'reverted',
      blockNumber: 100n,
    } as never);
    await expect(call()).rejects.toThrow('REGISTER_REVERTED');
    const person = snapshot(`persons/${PERSON_ID}`);
    expect(person.get('status')).toBe('pending');
    // reconcilePending 이 고치려면 해시는 남아 있어야 한다.
    expect(person.get('chain.registerTx')).toBe(TX);
    expect(person.get('chain.block')).toBeUndefined();
    expect(snapshot(`devices/${ACCOUNT}`).exists).toBe(false);
    expect(awaitFinalized).not.toHaveBeenCalled();
  });

  it('refuses a person whose account was rotated away', async () => {
    write(`persons/${PERSON_ID}`, { status: 'rotated' }, { merge: true });
    await expect(call()).rejects.toThrow('BAD_SIGNUP_STATE');
    expect(sendAttesterTx).not.toHaveBeenCalled();
  });

  it('refuses a person that has no passkey account yet', async () => {
    docs.clear();
    seedCaller();
    write(`persons/${PERSON_ID}`, { status: 'pending', kycLevel: 0 });
    await expect(call()).rejects.toThrow('PASSKEY_REQUIRED');
    expect(sendAttesterTx).not.toHaveBeenCalled();
  });

  it('refuses an unknown person', async () => {
    docs.clear();
    seedCaller();
    await expect(call()).rejects.toThrow('PERSON_NOT_FOUND');
  });
});

describe('registerIdentity — the caller may only register themselves', () => {
  it("refuses a personId that is not the caller's own", async () => {
    // 이 함수는 호출자가 준 기기 키를 그대로 체인에 박는다(Identity.sol `_devices[account]`).
    // 묶음이 틀리면 체인은커녕 조회도 한 번 나가면 안 된다.
    const victim = `0x${'bb'.repeat(32)}`;
    write(`persons/${victim}`, { status: 'pending', kycLevel: 0, account: ACCOUNT });
    await expect(call({ personId: victim, deviceX: X, deviceY: Y })).rejects.toThrow(
      'PERSON_MISMATCH',
    );
    expect(sendAttesterTx).not.toHaveBeenCalled();
    expect(readContract).not.toHaveBeenCalled();
  });

  it('refuses a signed-in user with no person of their own', async () => {
    docs.clear();
    seedPerson();
    await expect(call()).rejects.toThrow('PERSON_MISMATCH');
    expect(sendAttesterTx).not.toHaveBeenCalled();
    expect(snapshot(`devices/${ACCOUNT}`).exists).toBe(false);
  });
});

describe('registerIdentity — input', () => {
  it('rejects an unauthenticated call', async () => {
    await expect(
      wrapped({ data: { personId: PERSON_ID, deviceX: X, deviceY: Y } } as never),
    ).rejects.toThrow('AUTH_REQUIRED');
    expect(sendAttesterTx).not.toHaveBeenCalled();
  });

  it.each([
    ['BAD_PERSON_ID', { personId: '0xdead', deviceX: X, deviceY: Y }],
    ['BAD_DEVICE_X', { personId: PERSON_ID, deviceX: '0x11', deviceY: Y }],
    ['BAD_DEVICE_Y', { personId: PERSON_ID, deviceX: X, deviceY: undefined }],
  ])('rejects malformed input with %s', async (code, data) => {
    await expect(call(data as Record<string, unknown>)).rejects.toThrow(code);
    expect(sendAttesterTx).not.toHaveBeenCalled();
  });
});

describe('registerIdentity — the session claims follow the chain', () => {
  /**
   * 가입 직후의 세션은 아직 `personId`·`account` 를 모르는 토큰이다. 규칙 파일이 그 클레임을 읽으므로
   * 등록이 끝난 자리에서 바로 심어 주지 않으면, 사람은 가입을 마치고도 자기 문서를 못 읽는다.
   * 모양은 loginVerify 가 만드는 것과 **한 글자도 다르면 안 된다** — 토큰 두 개가 갈라진다.
   */
  it('mints the same claims loginVerify does once the registration is finalized', async () => {
    await expect(call()).resolves.toEqual({ txHash: TX, claimsUpdated: true });
    expect(setCustomUserClaims).toHaveBeenCalledTimes(1);
    expect(setCustomUserClaims).toHaveBeenCalledWith(auth.uid, {
      personId: PERSON_ID,
      account: ACCOUNT,
    });
    // 전화번호는 커스텀 토큰에 싣지 않는다(클라이언트가 읽을 수 있다).
    expect(Object.keys(setCustomUserClaims.mock.calls[0]![1]).sort()).toEqual([
      'account',
      'personId',
    ]);
  });

  it('checksums the account exactly as loginVerify does', async () => {
    const lower = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
    write(`persons/${PERSON_ID}`, { account: lower }, { merge: true });
    await call();
    expect(setCustomUserClaims.mock.calls[0]![1].account).toBe(
      '0xABcdEFABcdEFabcdEfAbCdefabcdeFABcDEFabCD',
    );
  });

  it('sets the claims on the already-registered short circuit too', async () => {
    // 전송 뒤 인스턴스가 죽어 다시 부른 경우다. 여기서 클레임을 건너뛰면 재시도한 사람만
    // 영원히 쓸 수 없는 세션을 들고 있게 된다.
    readContract.mockResolvedValueOnce(true as never);
    await expect(call()).resolves.toEqual({ alreadyRegistered: true, claimsUpdated: true });
    expect(setCustomUserClaims).toHaveBeenCalledWith(auth.uid, {
      personId: PERSON_ID,
      account: ACCOUNT,
    });
  });

  it('sets the claims again for a transaction that was already finalized', async () => {
    write(`persons/${PERSON_ID}`, { chain: { registerTx: OTHER_TX, block: 12 } }, { merge: true });
    await expect(call()).resolves.toEqual({ txHash: OTHER_TX, claimsUpdated: true });
    expect(setCustomUserClaims).toHaveBeenCalledTimes(1);
  });

  it('never mints claims for a send that failed', async () => {
    sendAttesterTx.mockRejectedValue(new Error('insufficient funds'));
    await expect(call()).rejects.toThrow('REGISTER_SEND_FAILED:insufficient funds');
    expect(setCustomUserClaims).not.toHaveBeenCalled();
    sendAttesterTx.mockReset();
    sendAttesterTx.mockImplementation(async () => guard(TX));
  });

  it('never mints claims for a transaction that reverted', async () => {
    waitForTransactionReceipt.mockResolvedValueOnce({
      status: 'reverted',
      blockNumber: 100n,
    } as never);
    await expect(call()).rejects.toThrow('REGISTER_REVERTED');
    expect(setCustomUserClaims).not.toHaveBeenCalled();
  });

  it('never mints claims for a caller registering someone else', async () => {
    const victim = `0x${'bb'.repeat(32)}`;
    write(`persons/${victim}`, { status: 'pending', kycLevel: 0, account: ACCOUNT });
    await expect(call({ personId: victim, deviceX: X, deviceY: Y })).rejects.toThrow(
      'PERSON_MISMATCH',
    );
    expect(setCustomUserClaims).not.toHaveBeenCalled();
  });
});

describe('registerIdentity — pre-deploys the smart account (so later ops carry no initCode)', () => {
  it('pre-deploys the account after a fresh register, keyed on the same person and account', async () => {
    await call();
    expect(predeployAccount).toHaveBeenCalledTimes(1);
    const arg = predeployAccount.mock.calls[0]![0] as {
      personRef: { path: string };
      personId: string;
      account: string;
    };
    expect(arg.personId).toBe(PERSON_ID);
    expect(arg.account).toBe(ACCOUNT);
    expect(arg.personRef.path).toBe(`persons/${PERSON_ID}`);
    // 등록이 실제로 나간 뒤에만 불린다.
    expect(sendAttesterTx).toHaveBeenCalledTimes(1);
  });

  it('pre-deploys on the already-a-member short circuit too', async () => {
    readContract.mockResolvedValueOnce(true as never);
    await expect(call()).resolves.toEqual({ alreadyRegistered: true, claimsUpdated: true });
    expect(predeployAccount).toHaveBeenCalledTimes(1);
  });

  it('does not pre-deploy again on the finalized short circuit', async () => {
    // 이미 완료된 재호출이다. 원래 호출(또는 대사 스윕)이 배포를 맡았으므로 다시 부르지 않는다.
    write(`persons/${PERSON_ID}`, { chain: { registerTx: OTHER_TX, block: 12 } }, { merge: true });
    await call();
    expect(predeployAccount).not.toHaveBeenCalled();
  });

  it('never pre-deploys when the register transaction reverted', async () => {
    waitForTransactionReceipt.mockResolvedValueOnce({
      status: 'reverted',
      blockNumber: 100n,
    } as never);
    await expect(call()).rejects.toThrow('REGISTER_REVERTED');
    expect(predeployAccount).not.toHaveBeenCalled();
  });

  it('stays a successful signup even when the pre-deploy step throws', async () => {
    predeployAccount.mockRejectedValueOnce(new Error('RPC down'));
    await expect(call()).resolves.toEqual({ txHash: TX, claimsUpdated: true });
    expect(snapshot(`persons/${PERSON_ID}`).get('status')).toBe('active');
  });
});
