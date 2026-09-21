import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FieldValue } from 'firebase-admin/firestore';

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
/** 체인 호출이 트랜잭션 안에서 일어나면 실제 Firestore 는 재시도로 중복 전송을 만든다. */
let inTransaction = false;

const DELETE = FieldValue.delete();
const SERVER_TIMESTAMP = FieldValue.serverTimestamp();

function isSentinel(value: unknown, sentinel: FieldValue): boolean {
  const candidate = value as FieldValue | undefined;
  return typeof candidate?.isEqual === 'function' && candidate.isEqual(sentinel);
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
      out[key] = new Date();
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
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
    DEVICES: 'devices',
    SYSTEM: 'system',
    assertStatusTransition: real.assertStatusTransition,
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

const sendAttesterTx = vi.fn(async () => guard(TX));
const readContract = vi.fn(async () => guard(false));
const waitForTransactionReceipt = vi.fn(async () => guard({ status: 'success', blockNumber: 100n }));
const awaitFinalized = vi.fn(async (_blockNumber: bigint) => guard(undefined));

vi.mock('../src/lib/chain.js', () => ({
  sendAttesterTx,
  awaitFinalized,
  publicClient: () => ({ readContract, waitForTransactionReceipt }),
  deployment: () => ({ identity: IDENTITY }),
}));

const { registerIdentity } = await import('../src/functions/registerIdentity.js');
const functionsTest = (await import('firebase-functions-test')).default();
const wrapped = functionsTest.wrap(registerIdentity);

function call(data: Record<string, unknown> = { personId: PERSON_ID, deviceX: X, deviceY: Y }) {
  return wrapped({ data, auth } as never) as Promise<{ txHash: string }>;
}

beforeEach(() => {
  docs.clear();
  inTransaction = false;
  sendAttesterTx.mockClear();
  readContract.mockClear();
  waitForTransactionReceipt.mockClear();
  awaitFinalized.mockClear();
  write(`persons/${PERSON_ID}`, { status: 'pending', kycLevel: 0, account: ACCOUNT });
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
    write(`persons/${PERSON_ID}`, { status: 'pending', kycLevel: 0, account: ACCOUNT });
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
    await expect(call()).resolves.toEqual({ txHash: OTHER_TX });
    expect(waitForTransactionReceipt).not.toHaveBeenCalled();
    expect(readContract).not.toHaveBeenCalled();
  });

  it('reconciles the database and sends nothing when the account is already a member', async () => {
    readContract.mockResolvedValueOnce(true as never);
    await expect(call()).rejects.toThrow('ALREADY_REGISTERED_ON_CHAIN');
    expect(sendAttesterTx).not.toHaveBeenCalled();
    expect(readContract.mock.calls[0]![0]).toMatchObject({
      address: IDENTITY,
      functionName: 'isMember',
      args: [ACCOUNT],
    });
    expect(snapshot(`persons/${PERSON_ID}`).get('status')).toBe('active');
  });

  it('refuses a second concurrent call while the first is still sending', async () => {
    write(`persons/${PERSON_ID}`, { chain: { registerPending: true } }, { merge: true });
    await expect(call()).rejects.toThrow('REGISTER_IN_FLIGHT');
    expect(sendAttesterTx).not.toHaveBeenCalled();
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
    await expect(call()).resolves.toEqual({ txHash: TX });
  });

  it('retries once when the node rejects the nonce as too low', async () => {
    sendAttesterTx.mockRejectedValueOnce(new Error('nonce too low'));
    await expect(call()).resolves.toEqual({ txHash: TX });
    expect(sendAttesterTx).toHaveBeenCalledTimes(2);
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
    write(`persons/${PERSON_ID}`, { status: 'pending', kycLevel: 0 });
    await expect(call()).rejects.toThrow('PASSKEY_REQUIRED');
    expect(sendAttesterTx).not.toHaveBeenCalled();
  });

  it('refuses an unknown person', async () => {
    docs.clear();
    await expect(call()).rejects.toThrow('PERSON_NOT_FOUND');
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
