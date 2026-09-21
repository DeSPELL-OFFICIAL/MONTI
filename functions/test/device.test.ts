import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';

process.env.GCP_PROJECT_ID = 'monti-dev';
process.env.PHONE_INDEX_KEY = 'monti-test-key';

const KEY = 'monti-test-key';
const PHONE = '+821011112222';
const OTHER_PHONE = '+821033334444';
const PERSON_ID = `0x${'aa'.repeat(32)}`;
const OTHER_PERSON_ID = `0x${'bb'.repeat(32)}`;
const ACCOUNT = '0x9999999999999999999999999999999999999999';
const IDENTITY = '0x1111111111111111111111111111111111111111';
const X = `0x${'11'.repeat(32)}`;
const Y = `0x${'22'.repeat(32)}`;
const ZERO32 = `0x${'00'.repeat(32)}`;
const TX = '0xlock';
const COOLDOWN = 604_800;

/**
 * registerIdentity.test.ts 와 같은 가짜 Firestore. 에뮬레이터 없이 `pnpm test` 안에서 돈다.
 * `system` 컬렉션까지 흉내 내므로 **어테스터 리스는 진짜 코드가 돈다** — 전송이 리스를
 * 통과하는지 여기서 같이 본다.
 */
const docs = new Map<string, Record<string, unknown>>();
/** 체인 호출이 Firestore 트랜잭션 안에서 일어나면 재시도가 중복 전송을 만든다. */
let inTransaction = false;

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
    set: async (data: Record<string, unknown>, options?: { merge?: boolean }) => {
      write(path, data, options);
    },
  };
}

vi.mock('../src/lib/db.js', () => ({
  PERSONS: 'persons',
  USERS: 'users',
  DEVICES: 'devices',
  PHONE_INDEX: 'phoneIndex',
  SYSTEM: 'system',
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
}));

function guard<T>(value: T): T {
  if (inTransaction) throw new Error('CHAIN_CALL_INSIDE_TRANSACTION');
  return value;
}

/** eth_call 하나하나의 답. 테스트가 필요한 값만 바꿔 끼운다. */
const chain = {
  isLocked: false as boolean,
  deviceUpdatedAt: 0n as bigint,
  personOf: PERSON_ID as string,
  isMember: true as boolean,
  kycLevelOf: 0 as number,
};

const sendAttesterTx = vi.fn(async () => guard(TX));
const readContract = vi.fn(async (call: { functionName: string }) =>
  guard(chain[call.functionName as keyof typeof chain]),
);
const waitForTransactionReceipt = vi.fn(async () => guard({ status: 'success', blockNumber: 7n }));

vi.mock('../src/lib/chain.js', () => ({
  sendAttesterTx,
  publicClient: () => ({ readContract, waitForTransactionReceipt }),
  deployment: () => ({ identity: IDENTITY }),
}));

/** Didit 세션 생성만 가짜로 바꾼다 — 재사용 판단(`ensureKycSession`)은 진짜 코드가 돈다. */
const createDiditSession = vi.fn(async (..._args: unknown[]) => ({
  sessionId: 'sess-dev',
  url: 'https://verify.didit.me/s/sess-dev',
}));
vi.mock('../src/lib/didit.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/didit.js')>()),
  createDiditSession: (...args: unknown[]) => createDiditSession(...args),
}));

const { hmacPhone } = await import('../src/lib/phoneIndex.js');
const { lockDevice, startDeviceChange } = await import('../src/functions/device.js');
const functionsTest = (await import('firebase-functions-test')).default();
const lock = functionsTest.wrap(lockDevice);
const change = functionsTest.wrap(startDeviceChange);

/** 패스키 세션. `loginVerify` 가 넣어 주는 클레임은 `personId`·`account` 둘뿐이다. */
const passkeyAuth = {
  uid: 'uid-1',
  token: { personId: PERSON_ID, account: ACCOUNT, firebase: { sign_in_provider: 'custom' } },
};
/** SMS 재인증 세션. 계정 클레임이 없으므로 users → persons 로 되짚어 간다. */
const smsAuth = { uid: 'uid-1', token: { firebase: { sign_in_provider: 'phone' } } };

function callLock(auth: unknown = passkeyAuth) {
  return lock({ data: {}, auth } as never) as Promise<{ txHash?: string; alreadyLocked?: true }>;
}

function callChange(data: Record<string, unknown>, auth: unknown = smsAuth) {
  return change({ data, auth } as never) as Promise<{
    allowedAt: number;
    now: number;
    cooldownSeconds: number;
    allowed: boolean;
    pending?: { deviceX: string; deviceY: string; requestedAt: number };
  }>;
}

beforeEach(() => {
  docs.clear();
  inTransaction = false;
  chain.isLocked = false;
  chain.deviceUpdatedAt = 0n;
  chain.personOf = PERSON_ID;
  chain.isMember = true;
  chain.kycLevelOf = 0;
  process.env.PHONE_INDEX_KEY = KEY;
  process.env.RP_ID = 'monti.despell.io';
  process.env.DEV_ORIGINS = '';
  process.env.DIDIT_API_KEY = 'didit-key';
  process.env.DIDIT_WORKFLOW_ID = 'wf-1';
  createDiditSession.mockClear();
  sendAttesterTx.mockClear();
  readContract.mockClear();
  waitForTransactionReceipt.mockClear();
  write(`users/uid-1`, { personId: PERSON_ID, phoneHmac: hmacPhone(PHONE, KEY) });
  write(`persons/${PERSON_ID}`, { status: 'active', account: ACCOUNT });
});

describe('lockDevice', () => {
  it('sends Identity.lockDevice for the caller account through the attester lease', async () => {
    const result = await callLock();
    expect(result.txHash).toBe(TX);
    expect(sendAttesterTx).toHaveBeenCalledTimes(1);
    expect(sendAttesterTx.mock.calls[0]![0]).toMatchObject({
      address: IDENTITY,
      functionName: 'lockDevice',
      args: [ACCOUNT],
    });
    // 리스를 잡았다가 반납했다는 증거. 전송이 리스 밖으로 새면 이 문서가 비어 있다.
    expect(snapshot('system/attester').exists).toBe(true);
    expect(snapshot('system/attester').get('lockedUntil')).toBe(0);
  });

  it('writes nothing about the lock to Firestore — the chain is the source of truth', async () => {
    await callLock();
    expect(snapshot(`devices/${ACCOUNT}`).exists).toBe(false);
    expect(snapshot(`persons/${PERSON_ID}`).data()).toEqual({ status: 'active', account: ACCOUNT });
  });

  it('reports an already-locked device as success without sending again', async () => {
    chain.isLocked = true;
    const result = await callLock();
    expect(result).toEqual({ alreadyLocked: true });
    expect(sendAttesterTx).not.toHaveBeenCalled();
  });

  it('refuses an unauthenticated caller', async () => {
    await expect(lock({ data: {} } as never)).rejects.toThrow('AUTH_REQUIRED');
    expect(sendAttesterTx).not.toHaveBeenCalled();
  });

  it('fails loudly when the lock transaction reverts', async () => {
    waitForTransactionReceipt.mockResolvedValueOnce({ status: 'reverted', blockNumber: 7n });
    await expect(callLock()).rejects.toThrow('LOCK_REVERTED');
  });
});

describe('startDeviceChange', () => {
  it('returns allowedAt = deviceUpdatedAt + 7 days read from the chain', async () => {
    chain.deviceUpdatedAt = BigInt(Math.floor(Date.now() / 1000) - 86_400);
    const result = await callChange({ method: 'sms', phone: PHONE });

    expect(result.cooldownSeconds).toBe(COOLDOWN);
    expect(result.allowedAt).toBe(Number(chain.deviceUpdatedAt) + COOLDOWN);
    expect(result.allowed).toBe(false);
    expect(readContract.mock.calls.map((call) => call[0].functionName)).toContain('deviceUpdatedAt');
    // 서버는 setActiveDevice 를 보낼 수 없다(msg.sender 가 계정이어야 한다). 전송은 0건이다.
    expect(sendAttesterTx).not.toHaveBeenCalled();
  });

  it('allows the change once the cooldown has elapsed', async () => {
    chain.deviceUpdatedAt = BigInt(Math.floor(Date.now() / 1000) - 8 * 86_400);
    const result = await callChange({ method: 'sms', phone: PHONE });
    expect(result.allowed).toBe(true);
    expect(result.allowedAt).toBeLessThanOrEqual(result.now);
  });

  it('records the pending device change and keeps it on a repeat of the same key', async () => {
    const first = await callChange({ method: 'sms', phone: PHONE, deviceX: X, deviceY: Y });
    expect(first.pending).toMatchObject({ deviceX: X, deviceY: Y });

    const device = snapshot(`devices/${ACCOUNT}`);
    expect(device.get('pendingChange.deviceX')).toBe(X);
    expect(device.get('pendingChange.deviceY')).toBe(Y);
    expect(device.get('pendingChange.method')).toBe('sms');
    expect(typeof device.get('pendingChange.requestedAt')).toBe('number');

    const second = await callChange({ method: 'sms', phone: PHONE, deviceX: X, deviceY: Y });
    expect(second.pending?.requestedAt).toBe(first.pending?.requestedAt);
  });

  it('replaces the pending change when a different key is requested', async () => {
    await callChange({ method: 'sms', phone: PHONE, deviceX: X, deviceY: Y });
    const other = `0x${'33'.repeat(32)}`;
    const result = await callChange({ method: 'sms', phone: PHONE, deviceX: other, deviceY: Y });
    expect(result.pending?.deviceX).toBe(other);
    expect(snapshot(`devices/${ACCOUNT}`).get('pendingChange.deviceX')).toBe(other);
  });

  it('rejects a phone that does not match the stored index', async () => {
    await expect(callChange({ method: 'sms', phone: OTHER_PHONE })).rejects.toThrow('PHONE_MISMATCH');
  });

  it('rejects a malformed phone before it reaches the HMAC', async () => {
    await expect(callChange({ method: 'sms', phone: '010-1111-2222' })).rejects.toThrow('BAD_PHONE');
    await expect(callChange({ method: 'sms' })).rejects.toThrow('BAD_PHONE');
  });

  it('reports an unbound PHONE_INDEX_KEY as our fault, not a wrong phone number', async () => {
    delete process.env.PHONE_INDEX_KEY;
    // 번호는 멀쩡하다. 여기서 BAD_PHONE 이 나오면 모든 복구가 사용자 탓으로 뭉개진다.
    await expect(callChange({ method: 'sms', phone: PHONE })).rejects.toThrow(
      'MISSING_PHONE_INDEX_KEY',
    );
  });

  it('requires a fresh SMS session for the sms method', async () => {
    await expect(callChange({ method: 'sms', phone: PHONE }, passkeyAuth)).rejects.toThrow(
      'PHONE_REAUTH_REQUIRED',
    );
  });

  it('refuses a caller whose person does not own the account on chain', async () => {
    chain.personOf = OTHER_PERSON_ID;
    await expect(callChange({ method: 'sms', phone: PHONE })).rejects.toThrow('PERSON_MISMATCH');
  });

  it('refuses a rotated-away account, which keeps its personOf but is no longer a member', async () => {
    chain.isMember = false;
    await expect(callChange({ method: 'sms', phone: PHONE })).rejects.toThrow('PERSON_MISMATCH');
    expect(snapshot(`devices/${ACCOUNT}`).exists).toBe(false);
  });

  it('refuses invalid device key coordinates', async () => {
    await expect(callChange({ method: 'sms', phone: PHONE, deviceX: '0x00', deviceY: Y })).rejects.toThrow(
      'BAD_DEVICE_X',
    );
    await expect(callChange({ method: 'sms', phone: PHONE, deviceX: X })).rejects.toThrow('BAD_DEVICE_Y');
    // 컨트랙트가 InvalidDeviceKey 로 되돌리는 0 좌표는 여기서 먼저 막는다.
    await expect(
      callChange({ method: 'sms', phone: PHONE, deviceX: ZERO32, deviceY: Y }),
    ).rejects.toThrow('BAD_DEVICE_X');
  });

  it('rejects an unknown method', async () => {
    await expect(callChange({ method: 'email' })).rejects.toThrow('BAD_METHOD');
  });

  it('accepts the kyc method only from a verified person and never asks for a phone', async () => {
    chain.kycLevelOf = 1;
    const result = await callChange({ method: 'kyc' }, passkeyAuth);
    expect(result.cooldownSeconds).toBe(COOLDOWN);
    expect(createDiditSession).not.toHaveBeenCalled(); // 이미 통과한 사람에게 세션을 열지 않는다

    chain.kycLevelOf = 0;
    await expect(callChange({ method: 'kyc' }, passkeyAuth)).rejects.toThrow('KYC_REQUIRED');
  });

  /**
   * Task 21 의 `KYC_REQUIRED` 는 "여기서 막혔다" 만 말하고 끝이었다. 이제 같은 세션 생성기
   * (`startKyc` 가 쓰는 `ensureKycSession`)로 연 링크를 함께 준다 — 웹이 곧바로 그 링크를 연다.
   */
  it('hands back a Didit link with KYC_REQUIRED, from the same session creator as startKyc', async () => {
    chain.kycLevelOf = 0;
    const error = (await callChange({ method: 'kyc' }, passkeyAuth).catch((cause: unknown) => cause)) as {
      message: string;
      details?: { kycUrl?: string; sessionId?: string };
    };

    expect(error.message).toBe('KYC_REQUIRED');
    expect(error.details).toEqual({
      kycUrl: 'https://verify.didit.me/s/sess-dev',
      sessionId: 'sess-dev',
    });
    // vendor_data 는 난수 personId, 복귀 주소는 우리 도메인의 기본값이다.
    expect(createDiditSession.mock.calls[0]).toEqual([
      PERSON_ID,
      'didit-key',
      'wf-1',
      'https://monti.despell.io/kyc/callback',
    ]);
    expect(snapshot(`persons/${PERSON_ID}`).get('kyc.status')).toBe('open');
  });

  it('reuses the open session instead of opening a second one on the next attempt', async () => {
    chain.kycLevelOf = 0;
    await expect(callChange({ method: 'kyc' }, passkeyAuth)).rejects.toThrow('KYC_REQUIRED');
    await expect(callChange({ method: 'kyc' }, passkeyAuth)).rejects.toThrow('KYC_REQUIRED');
    expect(createDiditSession).toHaveBeenCalledTimes(1);
  });

  it('refuses a callback that is not one of our own origins', async () => {
    chain.kycLevelOf = 0;
    await expect(
      callChange({ method: 'kyc', callbackUrl: 'https://evil.example/kyc' }, passkeyAuth),
    ).rejects.toThrow('BAD_CALLBACK_URL');
    expect(createDiditSession).not.toHaveBeenCalled();

    await expect(
      callChange({ method: 'kyc', callbackUrl: 'https://monti.despell.io/devices/new' }, passkeyAuth),
    ).rejects.toThrow('KYC_REQUIRED');
    expect(createDiditSession.mock.calls[0]![3]).toBe('https://monti.despell.io/devices/new');
  });

  it('accepts a KYC level above 1 — the rule is "at least verified", not "exactly 1"', async () => {
    chain.kycLevelOf = 2;
    const result = await callChange({ method: 'kyc' }, passkeyAuth);
    expect(result.cooldownSeconds).toBe(COOLDOWN);
  });

  it('never stores or echoes the plaintext phone number', async () => {
    const result = await callChange({ method: 'sms', phone: PHONE, deviceX: X, deviceY: Y });
    expect(JSON.stringify(result)).not.toContain(PHONE);
    expect(JSON.stringify([...docs.entries()])).not.toContain(PHONE);
  });
});
