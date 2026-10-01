import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { TransactionReceiptNotFoundError, getAddress } from 'viem';
import { FIREBASE_REGION } from '@monti/shared';
import type { CloudEvent, CloudFunction } from 'firebase-functions/v2';

process.env.GCP_PROJECT_ID = 'monti-dev';

const IDENTITY = '0x1111111111111111111111111111111111111111';
const ZERO = '0x0000000000000000000000000000000000000000';
/** 소문자로만 적힌 주소. 클레임에 체크섬이 박히는지 보려면 원본이 체크섬이 아니어야 한다. */
const ACCOUNT = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
const ON_CHAIN = '0xfedcbafedcbafedcbafedcbafedcbafedcbafedc';
const P1 = `0x${'a1'.repeat(32)}`;
const P2 = `0x${'a2'.repeat(32)}`;
const P3 = `0x${'a3'.repeat(32)}`;
const TX = '0xaa';
const KYC_TX = '0xee';

/**
 * persons / users / transferInvites / authChallenges / pendingGates / system 여섯 컬렉션만 흉내 내는
 * 가짜 Firestore. `pnpm test` 는 에뮬레이터 없이 돌기 때문에(vitest.config.ts)
 * registerIdentity.test.ts·eventChat.test.ts 가 쓰는 것과 같은 패턴을 그대로 쓴다.
 * 중첩 맵 merge 와 `FieldValue.delete()` 는 진짜 Firestore 와 똑같이 움직여야 한다 —
 * `chain.registerTx` 를 지우면서 `chain.block` 까지 날리면 이 함수의 복구가 거꾸로 데이터를 지운다.
 * `system/attester` 리스도 여기 들어간다(재전송이 진짜 `attesterLock` 을 지난다).
 */
const docs = new Map<string, Record<string, unknown>>();
/** 쓰기가 일어난 경로. "건드릴 것이 없으면 아무것도 쓰지 않는다" 를 여기서 본다. */
const writes: string[] = [];
/** 삭제된 경로. 챌린지 청소는 삭제로만 일어난다. */
const deletes: string[] = [];
/** 질의 기록. 스윕별 상한(200)을 여기서 확인한다. */
const queries: Array<{ name: string; filters: Filter[]; max: number }> = [];
/** 이 컬렉션의 질의는 터진다 — 스윕 하나가 죽어도 다음 스윕이 도는지 보는 장치. */
const failQuery = new Set<string>();
/** 이 경로의 쓰기는 터진다 — 문서 하나가 죽어도 다음 문서가 처리되는지 보는 장치. */
const failWrite = new Set<string>();

const setCustomUserClaims = vi.fn(async (_uid: string, _claims: Record<string, unknown>) => {});

/** 남긴 로그. 미룬 건수는 이 줄 하나로만 밖에 보인다. */
const logs: Array<[key: string, payload: Record<string, unknown>]> = [];
vi.mock('firebase-functions/logger', () => ({
  info: (key: string, payload: Record<string, unknown>) => void logs.push([key, payload]),
  warn: vi.fn(),
  error: (key: string, payload: Record<string, unknown>) => void logs.push([key, payload]),
}));

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
  if (failWrite.has(path)) throw new Error(`FIRESTORE_UNAVAILABLE:${path}`);
  writes.push(path);
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
    ref: docRef(path),
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
    delete: async () => {
      deletes.push(path);
      docs.delete(path);
    },
  };
}

type Filter = [field: string, op: string, value: unknown];

function comparable(value: unknown): number {
  return value instanceof Timestamp ? value.toMillis() : (value as number);
}

function matches(data: Record<string, unknown>, [name, op, value]: Filter): boolean {
  // 진짜 Firestore 처럼 `kyc.status` 같은 점 경로도 거른다 — 버린 세션 스윕이 그 모양으로 묻는다.
  const actual = field(data, name);
  if (op === '==') return actual === value;
  if (op === 'in') return (value as unknown[]).includes(actual);
  if (op === '<') return actual !== undefined && comparable(actual) < comparable(value);
  throw new Error(`UNSUPPORTED_OP:${op}`);
}

function query(name: string, filters: Filter[], max: number) {
  return {
    where: (f: string, op: string, value: unknown) => query(name, [...filters, [f, op, value]], max),
    limit: (n: number) => query(name, filters, n),
    get: async () => {
      queries.push({ name, filters, max });
      if (failQuery.has(name)) throw new Error(`FIRESTORE_UNAVAILABLE:${name}`);
      const matched = [...docs.entries()]
        .filter(([path]) => path.startsWith(`${name}/`))
        .filter(([, data]) => filters.every((filter) => matches(data, filter)))
        .slice(0, max)
        .map(([path]) => snapshot(path));
      return { docs: matched, size: matched.length, empty: matched.length === 0 };
    },
  };
}

vi.mock('../src/lib/db.js', async () => {
  const real = await vi.importActual<typeof import('../src/lib/db.js')>('../src/lib/db.js');
  return {
    PERSONS: 'persons',
    USERS: 'users',
    TRANSFER_INVITES: 'transferInvites',
    AUTH_CHALLENGES: 'authChallenges',
    PENDING_GATES: 'pendingGates',
    SYSTEM: 'system',
    assertStatusTransition: real.assertStatusTransition,
    authAdmin: { setCustomUserClaims },
    db: {
      collection: (name: string) => ({
        ...query(name, [], Number.POSITIVE_INFINITY),
        doc: (id: string) => docRef(`${name}/${id}`),
      }),
      // 어테스터 리스(`attesterLock.ts`)가 쓴다. 재전송은 진짜 리스를 지난다.
      runTransaction: async <T>(body: (tx: unknown) => Promise<T>): Promise<T> => {
        const pending: Array<() => void> = [];
        const tx = {
          get: async (ref: { path: string }) => snapshot(ref.path),
          set: (ref: { path: string }, data: Record<string, unknown>, o?: { merge?: boolean }) => {
            pending.push(() => write(ref.path, data, o));
          },
        };
        const result = await body(tx);
        for (const apply of pending) apply();
        return result;
      },
    },
  };
});

const getTransactionReceipt = vi.fn(async (_args: { hash: string }) => ({
  status: 'success',
  blockNumber: 100n,
}));
const getBlock = vi.fn(async (_args: { blockTag: string }) => ({ number: 200n }));
const readContract = vi.fn(async (_args: { functionName: string }) => ZERO as string | number);
const sendAttesterTx = vi.fn(async (_tx: Record<string, unknown>) => KYC_TX);

vi.mock('../src/lib/chain.js', () => ({
  publicClient: () => ({ getTransactionReceipt, getBlock, readContract }),
  deployment: () => ({ identity: IDENTITY }),
  sendAttesterTx: (...args: unknown[]) => sendAttesterTx(...(args as [Record<string, unknown>])),
}));

// 운영에서는 `lib/chain.js` 가 `../config.js` 를 끌어와 트리거 정의 전에 `setGlobalOptions` 를
// 돌린다. 그 chain 이 위에서 mock 되므로 여기서 직접 불러 리전이 배포와 같은 순서로 붙게 한다.
await import('../src/config.js');
const { reconcilePending } = await import('../src/functions/reconcilePending.js');
const functionsTest = (await import('firebase-functions-test')).default();
// `onSchedule` 이 주는 `ScheduleFunction` 은 `wrap` 오버로드 어디에도 맞지 않는다.
// 런타임은 `__endpoint.scheduleTrigger` 만 보고 스케줄 경로로 흘리므로 호출 형태는 그대로다.
const run = functionsTest.wrap(reconcilePending as unknown as CloudFunction<CloudEvent<unknown>>);

function seconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** 2분 넘게 멈춰 있던 문서만 스윕에 걸린다. */
function stale(): Timestamp {
  return Timestamp.fromMillis(Date.now() - 5 * 60 * 1000);
}

function seedPerson(personId: string, data: Record<string, unknown>): void {
  write(`persons/${personId}`, { updatedAt: stale(), ...data });
}

/** 포기 분기는 문서를 질의의 꼬리로 돌린다 — `updatedAt` 이 반드시 앞으로 간다. */
function rotated(personId: string): boolean {
  const updatedAt = snapshot(`persons/${personId}`).get('updatedAt') as Timestamp;
  return updatedAt.toMillis() > stale().toMillis();
}

beforeEach(() => {
  docs.clear();
  writes.length = 0;
  deletes.length = 0;
  queries.length = 0;
  logs.length = 0;
  failQuery.clear();
  failWrite.clear();
  setCustomUserClaims.mockClear();
  getTransactionReceipt.mockReset();
  getTransactionReceipt.mockResolvedValue({ status: 'success', blockNumber: 100n });
  getBlock.mockReset();
  getBlock.mockResolvedValue({ number: 200n });
  readContract.mockReset();
  readContract.mockResolvedValue(ZERO);
  sendAttesterTx.mockReset();
  sendAttesterTx.mockResolvedValue(KYC_TX);
  write('users/uid-1', { personId: P1 });
  write('users/uid-2', { personId: P2 });
  write('users/uid-3', { personId: P3 });
  writes.length = 0;
});

describe('reconcilePending — 멈춘 계정 등록', () => {
  it('promotes a pending person whose register tx is finalized', async () => {
    seedPerson(P1, { status: 'pending', account: ACCOUNT, chain: { registerTx: TX } });

    await run({} as never);

    const person = snapshot(`persons/${P1}`);
    expect(person.get('status')).toBe('active');
    expect(person.get('chain.block')).toBe(100);
    // 해시는 남는다 — registerIdentity 의 멱등 ① 이 이 값을 읽는다.
    expect(person.get('chain.registerTx')).toBe(TX);
  });

  it('mints the same session claims registerIdentity would have minted', async () => {
    seedPerson(P1, { status: 'pending', account: ACCOUNT, chain: { registerTx: TX } });

    await run({} as never);

    expect(setCustomUserClaims).toHaveBeenCalledTimes(1);
    expect(setCustomUserClaims.mock.calls[0]).toEqual([
      'uid-1',
      { personId: P1, account: getAddress(ACCOUNT) },
    ]);
  });

  it('mints the claims BEFORE flipping the status, so a failure leaves the doc for the next run', async () => {
    setCustomUserClaims.mockRejectedValueOnce(new Error('AUTH_UNAVAILABLE'));
    seedPerson(P1, { status: 'pending', account: ACCOUNT, chain: { registerTx: TX } });
    writes.length = 0;

    await run({} as never);

    // 상태가 넘어갔다면 이 사람은 질의에서 빠져 영영 클레임 없이 남는다.
    const person = snapshot(`persons/${P1}`);
    expect(person.get('status')).toBe('pending');
    expect(person.get('chain.block')).toBeUndefined();
    expect(writes).toEqual([]);
  });

  it('never puts a phone number or anything else into the claims', async () => {
    seedPerson(P1, { status: 'pending', account: ACCOUNT, chain: { registerTx: TX } });
    write(`users/uid-1`, { personId: P1, phoneHmac: 'deadbeef' });

    await run({} as never);

    expect(Object.keys(setCustomUserClaims.mock.calls[0]![1]).sort()).toEqual([
      'account',
      'personId',
    ]);
  });

  it('falls back to the chain for the account when the person doc has none', async () => {
    readContract.mockResolvedValue(ON_CHAIN);
    seedPerson(P1, { status: 'pending', chain: { registerTx: TX } });

    await run({} as never);

    expect(setCustomUserClaims.mock.calls[0]).toEqual([
      'uid-1',
      { personId: P1, account: getAddress(ON_CHAIN) },
    ]);
    expect(snapshot(`persons/${P1}`).get('status')).toBe('active');
  });

  it('clears a dropped register transaction so the client can retry', async () => {
    getTransactionReceipt.mockRejectedValue(new TransactionReceiptNotFoundError({ hash: '0xbb' }));
    seedPerson(P2, {
      status: 'pending',
      account: ACCOUNT,
      chain: { registerTx: '0xbb', registerPending: true, registerPendingAt: 1 },
    });

    await run({} as never);

    const person = snapshot(`persons/${P2}`);
    expect(person.get('status')).toBe('pending');
    expect(person.get('chain.registerTx')).toBeUndefined();
    // 딱지까지 풀어야 registerIdentity 가 다시 보낼 수 있다.
    expect(person.get('chain.registerPending')).toBeUndefined();
    expect(person.get('chain.registerPendingAt')).toBeUndefined();
    // 고쳐 놓고도 앞줄에 남으면 다음 사람이 밀린다.
    expect(rotated(P2)).toBe(true);
    expect(setCustomUserClaims).not.toHaveBeenCalled();
  });

  it('never mistakes an RPC failure for a dropped transaction', async () => {
    // 이걸 드롭으로 읽으면 한 번 흔들린 RPC 가 살아 있는 해시 200개를 지우고
    // registerIdentity 의 멱등 ① 이 무너져 register 가 두 번 나간다.
    getTransactionReceipt.mockRejectedValue(new Error('HTTP 503 rate limited'));
    seedPerson(P2, { status: 'pending', account: ACCOUNT, chain: { registerTx: '0xbb' } });
    writes.length = 0;

    await run({} as never);

    const person = snapshot(`persons/${P2}`);
    expect(person.get('chain.registerTx')).toBe('0xbb');
    expect(person.get('status')).toBe('pending');
    expect(writes).toEqual([]);
  });

  it('keeps a reverted registration pending and remembers the failed hash', async () => {
    getTransactionReceipt.mockResolvedValue({ status: 'reverted', blockNumber: 100n });
    seedPerson(P2, { status: 'pending', account: ACCOUNT, chain: { registerTx: '0xbb' } });

    await run({} as never);

    const person = snapshot(`persons/${P2}`);
    expect(person.get('status')).toBe('pending');
    expect(person.get('chain.registerTx')).toBeUndefined();
    expect(person.get('chain.lastFailedTx')).toBe('0xbb');
    expect(rotated(P2)).toBe(true);
    expect(setCustomUserClaims).not.toHaveBeenCalled();
  });

  it('waits while the receipt block is not finalized yet', async () => {
    getBlock.mockResolvedValue({ number: 50n });
    seedPerson(P1, { status: 'pending', account: ACCOUNT, chain: { registerTx: TX } });
    writes.length = 0;

    await run({} as never);

    expect(snapshot(`persons/${P1}`).get('status')).toBe('pending');
    expect(writes).toEqual([]);
  });

  it('repairs a person the chain already knows even with no stored tx', async () => {
    readContract.mockResolvedValue(ON_CHAIN);
    seedPerson(P3, { status: 'pending' });

    await run({} as never);

    expect(snapshot(`persons/${P3}`).get('status')).toBe('active');
    expect(readContract.mock.calls[0]![0]).toMatchObject({
      address: IDENTITY,
      functionName: 'accountOf',
    });
    // 계정 주소의 원본은 체인이다 — DB 에 아무것도 없어도 클레임을 심을 수 있다.
    expect(setCustomUserClaims.mock.calls[0]).toEqual([
      'uid-3',
      { personId: P3, account: getAddress(ON_CHAIN) },
    ]);
  });

  it('rotates a pending person the chain does not know to the tail of the queue', async () => {
    seedPerson(P3, { status: 'pending' });

    await run({} as never);

    const person = snapshot(`persons/${P3}`);
    expect(person.get('status')).toBe('pending');
    // 상태도 새 필드도 만들지 않는다. `updatedAt` 하나만 앞으로 간다.
    expect(Object.keys(person.data() ?? {}).sort()).toEqual(['status', 'updatedAt']);
    expect(rotated(P3)).toBe(true);
    expect(setCustomUserClaims).not.toHaveBeenCalled();
  });

  it('only scans persons that are stuck in pending or kyc_ok', async () => {
    await run({} as never);

    const persons = queries.find((q) => q.name === 'persons');
    expect(persons?.filters[0]).toEqual(['status', 'in', ['pending', 'kyc_ok']]);
    expect(persons?.filters[1]?.[0]).toBe('updatedAt');
    expect(persons?.filters[1]?.[1]).toBe('<');
  });

  it('skips a person that has only just been written', async () => {
    write(`persons/${P1}`, {
      status: 'pending',
      account: ACCOUNT,
      chain: { registerTx: TX },
      updatedAt: Timestamp.now(),
    });
    writes.length = 0;

    await run({} as never);

    expect(snapshot(`persons/${P1}`).get('status')).toBe('pending');
    expect(writes).toEqual([]);
  });
});

describe('reconcilePending — 멈춘 본인인증 레벨', () => {
  it('re-sends setKycLevel once for a kyc_ok person with no recorded hash', async () => {
    // diditWebhook 은 성공했을 때만 해시를 쓰고 그때 active 로 올린다. 그래서 운영에 남는
    // 멈춘 kyc_ok 은 언제나 해시가 없다 — 이 재전송이 유일한 복구 경로다.
    seedPerson(P1, { status: 'kyc_ok', kycLevel: 0, chain: { kycLevelError: 'reverted' } });

    await run({} as never);

    expect(sendAttesterTx).toHaveBeenCalledTimes(1);
    expect(sendAttesterTx.mock.calls[0]![0]).toMatchObject({
      address: IDENTITY,
      functionName: 'setKycLevel',
      args: [P1, 1],
    });
    const person = snapshot(`persons/${P1}`);
    expect(person.get('chain.kycLevelTx')).toBe(KYC_TX);
    expect(person.get('chain.kycLevelError')).toBeUndefined();
    // 방금 보낸 트랜잭션의 영수증은 아직 없다. 다음 실행이 영수증 경로로 끌고 간다.
    expect(person.get('status')).toBe('kyc_ok');
    expect(getTransactionReceipt).not.toHaveBeenCalled();
  });

  it('skips the re-send when the chain already carries the level and closes in one run', async () => {
    // "전송 후 finalize 전 사망" 이 이 모양으로 남는다 — 해시는 없고 체인에는 레벨이 있다.
    readContract.mockImplementation(async ({ functionName }: { functionName: string }) =>
      functionName === 'kycLevelOf' ? 1 : ACCOUNT,
    );
    seedPerson(P1, {
      status: 'kyc_ok',
      kycLevel: 0,
      account: ACCOUNT,
      chain: { kycLevelError: 'reverted' },
    });

    await run({} as never);

    expect(sendAttesterTx).not.toHaveBeenCalled();
    // 레벨은 personId 가 아니라 **계정 주소**로 읽는다(`Identity.kycLevelOf(address)`).
    expect(readContract.mock.calls.at(-1)![0]).toMatchObject({
      address: IDENTITY,
      functionName: 'kycLevelOf',
      args: [ACCOUNT],
    });
    const person = snapshot(`persons/${P1}`);
    expect(person.get('status')).toBe('active');
    expect(person.get('kycLevel')).toBe(1);
    expect(person.get('chain.kycLevelError')).toBeUndefined();
    expect(person.get('chain.kycLevelTx')).toBeUndefined();
    // 영수증을 기다릴 해시가 없다. 두 실행이 아니라 이 실행에서 끝난다.
    expect(getTransactionReceipt).not.toHaveBeenCalled();
  });

  it('caps the attester re-sends per run and leaves the rest at the head of the queue', async () => {
    const ids = Array.from(
      { length: 25 },
      (_, i) => `0x${i.toString(16).padStart(2, '0').repeat(32)}`,
    );
    for (const id of ids) seedPerson(id, { status: 'kyc_ok', kycLevel: 0 });

    await run({} as never);

    expect(sendAttesterTx).toHaveBeenCalledTimes(20);
    const sent = ids.filter((id) => snapshot(`persons/${id}`).get('chain.kycLevelTx') === KYC_TX);
    expect(sent).toHaveLength(20);
    // 미룬 문서는 `updatedAt` 을 그대로 둔다 — 다음 5분 틱이 이들을 가장 먼저 집는다.
    const deferred = ids.filter((id) => !sent.includes(id));
    expect(deferred).toHaveLength(5);
    expect(deferred.every((id) => !rotated(id))).toBe(true);
  });

  it('spends no chain read on a document this run will not send', async () => {
    // 예산 확인이 `kycLevelOf` 아래에 있던 시절에는 미룬 문서도 읽기를 1~2번씩 태웠다 —
    // 200건이 밀린 날 아무것도 보내지 않으면서 직렬 eth_call 400번이 나갔다.
    const ids = Array.from(
      { length: 25 },
      (_, i) => `0x${i.toString(16).padStart(2, '0').repeat(32)}`,
    );
    for (const id of ids) seedPerson(id, { status: 'kyc_ok', kycLevel: 0 });

    await run({} as never);

    const sent = ids.filter((id) => snapshot(`persons/${id}`).get('chain.kycLevelTx') === KYC_TX);
    const deferred = ids.filter((id) => !sent.includes(id));
    expect(deferred).toHaveLength(5);
    // 호출 목록 자체를 본다 — 횟수만 세면 다른 문서를 두 번 읽고 넘어가는 실수를 놓친다.
    const asked = readContract.mock.calls.map(
      (call) => (call[0] as unknown as { args: unknown[] }).args[0] as string,
    );
    expect([...asked].sort()).toEqual([...sent].sort());
    for (const id of deferred) expect(asked).not.toContain(id);
    // 미룬 건수는 그대로 남아야 한다 — 이 수가 계속 0 이 아니면 예산이 모자란다는 뜻이다.
    expect(logs).toContainEqual(['reconcile.kycLevel.deferred', { count: 5 }]);
  });

  it('takes the attester lease for the re-send and gives it back', async () => {
    seedPerson(P1, { status: 'kyc_ok', kycLevel: 0 });

    await run({} as never);

    expect(snapshot('system/attester').get('lockedUntil')).toBe(0);
    expect(snapshot('system/attester').get('holder')).toBeNull();
  });

  it('leaves a kyc_ok person for the next run when the re-send fails', async () => {
    sendAttesterTx.mockRejectedValue(new Error('NotRegistered'));
    seedPerson(P1, { status: 'kyc_ok', kycLevel: 0 });

    await run({} as never);

    const person = snapshot(`persons/${P1}`);
    expect(person.get('status')).toBe('kyc_ok');
    expect(person.get('chain.kycLevelTx')).toBeUndefined();
    // 다시 집히되 앞줄은 비켜 준다.
    expect(rotated(P1)).toBe(true);
  });

  it('finishes a stuck kyc_ok person once setKycLevel is finalized', async () => {
    seedPerson(P1, { status: 'kyc_ok', kycLevel: 0, chain: { kycLevelTx: '0xcc' } });

    await run({} as never);

    const person = snapshot(`persons/${P1}`);
    expect(person.get('status')).toBe('active');
    expect(person.get('kycLevel')).toBe(1);
    expect(person.get('chain.block')).toBe(100);
    expect(sendAttesterTx).not.toHaveBeenCalled();
  });

  it('falls back to active when the setKycLevel transaction reverted', async () => {
    getTransactionReceipt.mockResolvedValue({ status: 'reverted', blockNumber: 100n });
    seedPerson(P2, { status: 'kyc_ok', kycLevel: 0, chain: { kycLevelTx: '0xdd' } });

    await run({} as never);

    const person = snapshot(`persons/${P2}`);
    expect(person.get('status')).toBe('active');
    // 레벨의 원본은 체인이다. 되돌아간 트랜잭션은 레벨을 올리지 않는다.
    expect(person.get('kycLevel')).toBe(0);
    expect(person.get('chain.kycLevelTx')).toBeUndefined();
  });

  it('clears a dropped setKycLevel hash so the next run re-sends it', async () => {
    getTransactionReceipt.mockRejectedValue(new TransactionReceiptNotFoundError({ hash: '0xdd' }));
    seedPerson(P2, { status: 'kyc_ok', kycLevel: 0, chain: { kycLevelTx: '0xdd' } });

    await run({} as never);

    const person = snapshot(`persons/${P2}`);
    expect(person.get('status')).toBe('kyc_ok');
    expect(person.get('chain.kycLevelTx')).toBeUndefined();
    expect(rotated(P2)).toBe(true);
  });

  it('waits while the setKycLevel block is not finalized yet', async () => {
    getBlock.mockResolvedValue({ number: 50n });
    seedPerson(P1, { status: 'kyc_ok', kycLevel: 0, chain: { kycLevelTx: '0xcc' } });
    writes.length = 0;

    await run({} as never);

    expect(snapshot(`persons/${P1}`).get('status')).toBe('kyc_ok');
    expect(writes).toEqual([]);
  });
});

describe('reconcilePending — 죽은 양도 초대', () => {
  it('expires a sent invite whose expiry has passed and leaves a live one alone', async () => {
    write('transferInvites/dead', { status: 'sent', expiresAt: seconds() - 10 });
    write('transferInvites/live', { status: 'sent', expiresAt: seconds() + 3600 });

    await run({} as never);

    expect(snapshot('transferInvites/dead').get('status')).toBe('expired');
    expect(snapshot('transferInvites/live').get('status')).toBe('sent');
  });

  it('never revives an invite that is already accepted or expired', async () => {
    write('transferInvites/done', { status: 'accepted', expiresAt: seconds() - 10 });
    write('transferInvites/old', { status: 'expired', expiresAt: seconds() - 10 });
    writes.length = 0;

    await run({} as never);

    expect(writes).toEqual([]);
  });

  it('asks the index for the expired ones instead of filtering the window in memory', async () => {
    await run({} as never);

    const invites = queries.find((q) => q.name === 'transferInvites');
    expect(invites?.filters).toEqual([
      ['status', '==', 'sent'],
      ['expiresAt', '<', expect.any(Number)],
    ]);
  });
});

describe('reconcilePending — 만료된 인증 챌린지', () => {
  it('deletes challenges past their expiry and keeps the live ones', async () => {
    write('authChallenges/dead', { purpose: 'login', expiresAt: seconds() - 10 });
    write('authChallenges/live', { purpose: 'register', expiresAt: seconds() + 300 });

    await run({} as never);

    expect(deletes).toEqual(['authChallenges/dead']);
    expect(snapshot('authChallenges/live').exists).toBe(true);
  });

  it('deletes only on the stored expiry field, never by age', async () => {
    write('authChallenges/no-expiry', { purpose: 'login', createdAt: Timestamp.now() });

    await run({} as never);

    expect(deletes).toEqual([]);
    const challenges = queries.find((q) => q.name === 'authChallenges');
    expect(challenges?.filters).toEqual([['expiresAt', '<', expect.any(Number)]]);
  });
});

describe('reconcilePending — 늙은 게이트 제안', () => {
  const GATE = '0x1234123412341234123412341234123412341234';
  const day = 24 * 60 * 60 * 1000;

  function queued(id: string, ageMs: number, status = 'pending'): void {
    write(`pendingGates/${id}`, {
      eventId: '11',
      kx: `0x${'11'.repeat(32)}`,
      ky: `0x${'22'.repeat(32)}`,
      submittedBy: 'uid-1',
      status,
      createdAt: Timestamp.fromMillis(Date.now() - ageMs),
    });
  }

  it('expires a proposal nobody approved within seven days and leaves a fresh one alone', async () => {
    queued(GATE, 8 * day);
    queued('0x5555555555555555555555555555555555555555', 6 * day);

    await run({} as never);

    expect(snapshot(`pendingGates/${GATE}`).get('status')).toBe('expired');
    expect(snapshot('pendingGates/0x5555555555555555555555555555555555555555').get('status')).toBe('pending');
  });

  it('never touches a proposal the chain already closed', async () => {
    // `GateRegistered` 가 닫은 줄은 체인에 올라간 게이트다. 만료로 덮으면 기록이 거짓이 된다.
    queued(GATE, 30 * day, 'registered');
    writes.length = 0;

    await run({} as never);

    expect(writes).toEqual([]);
    expect(snapshot(`pendingGates/${GATE}`).get('status')).toBe('registered');
  });

  it('asks the index for the old ones instead of filtering the window in memory', async () => {
    await run({} as never);

    const gates = queries.find((q) => q.name === 'pendingGates');
    expect(gates?.filters).toEqual([
      ['status', '==', 'pending'],
      ['createdAt', '<', expect.any(Timestamp)],
    ]);
  });
});

describe('reconcilePending — 버려진 본인인증 세션', () => {
  const HOUR = 60 * 60;

  /** Didit 세션을 열어 둔 사람. `openedAt` 은 `kycSession.ts` 가 세션을 저장할 때 찍는다. */
  function opened(personId: string, ageSeconds: number): number {
    const openedAt = seconds() - ageSeconds;
    write(`persons/${personId}`, {
      status: 'active',
      kycLevel: 0,
      updatedAt: stale(),
      kyc: {
        provider: 'didit',
        sessionId: `sess-${personId.slice(2, 6)}`,
        url: 'https://verify.didit.me/s/x',
        status: 'open',
        openedAt,
      },
    });
    return openedAt;
  }

  it('marks a session nobody came back to as abandoned, and leaves a fresh one open', async () => {
    const openedAt = opened(P1, 25 * HOUR);
    opened(P2, 23 * HOUR);

    await run({} as never);

    const dead = snapshot(`persons/${P1}`);
    expect(dead.get('kyc.status')).toBe('abandoned');
    // 우리 쪽 딱지만 바꾼다 — 세션 id 를 지우면 파기가 Didit 의 얼굴 자료를 못 지운다.
    expect(dead.get('kyc.sessionId')).toBe(`sess-${P1.slice(2, 6)}`);
    expect(dead.get('kyc.openedAt')).toBe(openedAt);
    expect(dead.get('status')).toBe('active');
    expect(snapshot(`persons/${P2}`).get('kyc.status')).toBe('open');
  });

  it('never calls Didit — only our own record changes', async () => {
    opened(P1, 25 * HOUR);

    await run({} as never);

    // 여기서 Didit 을 부르면 스윕 한 번이 200번의 HTTP 왕복이 된다. 세션은 저쪽 TTL 이 닫는다.
    expect(readContract).not.toHaveBeenCalled();
    expect(sendAttesterTx).not.toHaveBeenCalled();
  });

  it('asks the index for the old open sessions instead of filtering the window in memory', async () => {
    await run({} as never);

    const abandoned = queries.filter((q) => q.name === 'persons')[1];
    expect(abandoned?.filters).toEqual([
      ['kyc.status', '==', 'open'],
      ['kyc.openedAt', '<', expect.any(Number)],
    ]);
    expect(abandoned?.max).toBe(200);
  });

  it('keeps going when one document blows up and never throws out of the scheduler', async () => {
    opened(P1, 25 * HOUR);
    opened(P2, 25 * HOUR);
    failWrite.add(`persons/${P1}`);

    await expect(run({} as never)).resolves.not.toThrow();

    expect(snapshot(`persons/${P1}`).get('kyc.status')).toBe('open');
    expect(snapshot(`persons/${P2}`).get('kyc.status')).toBe('abandoned');
  });

  /** 이 배포 **전에** 열린 세션. `kycSession.ts` 가 `openedAt` 을 찍기 시작하기 전의 모양이다. */
  function unstamped(personId: string): void {
    write(`persons/${personId}`, {
      status: 'active',
      kycLevel: 0,
      updatedAt: stale(),
      kyc: {
        provider: 'didit',
        sessionId: `sess-${personId.slice(2, 6)}`,
        url: 'https://verify.didit.me/s/x',
        status: 'open',
      },
    });
  }

  it('stamps openedAt on a session that has none instead of leaving it unsweepable', async () => {
    // Firestore 의 `<` 는 필드가 **없는** 문서를 통째로 뺀다. 백필이 없으면 이 세션은
    // 위 질의에 영영 걸리지 않고, 그 사람은 죽은 링크만 계속 받는다.
    unstamped(P1);
    const before = seconds();
    writes.length = 0;

    await run({} as never);

    const stamped = snapshot(`persons/${P1}`);
    expect(stamped.get('kyc.openedAt')).toBeGreaterThanOrEqual(before);
    // 같은 실행에서 버린 것으로 찍지는 않는다 — 이제부터 정상적으로 늙어 24시간 뒤에 닫힌다.
    expect(stamped.get('kyc.status')).toBe('open');
    expect(stamped.get('kyc.sessionId')).toBe(`sess-${P1.slice(2, 6)}`);
    expect(writes).toEqual([`persons/${P1}`]);
  });

  it('writes nothing to an open session that already carries openedAt', async () => {
    opened(P1, 23 * HOUR);
    writes.length = 0;

    await run({} as never);

    expect(writes).toEqual([]);
  });

  it('asks for the unstamped ones with an equality alone so no new index is needed', async () => {
    await run({} as never);

    const backfill = queries.filter((q) => q.name === 'persons')[2];
    expect(backfill?.filters).toEqual([['kyc.status', '==', 'open']]);
    expect(backfill?.max).toBe(200);
  });

  it('keeps backfilling when one stamp blows up and never throws out of the scheduler', async () => {
    unstamped(P1);
    unstamped(P2);
    failWrite.add(`persons/${P1}`);

    await expect(run({} as never)).resolves.not.toThrow();

    expect(snapshot(`persons/${P1}`).get('kyc.openedAt')).toBeUndefined();
    expect(snapshot(`persons/${P2}`).get('kyc.openedAt')).toEqual(expect.any(Number));
  });
});

describe('reconcilePending — 스윕 격리', () => {
  it('runs the later sweeps even when an earlier one throws', async () => {
    failQuery.add('persons');
    write('transferInvites/dead', { status: 'sent', expiresAt: seconds() - 10 });
    write('authChallenges/dead', { purpose: 'login', expiresAt: seconds() - 10 });

    await expect(run({} as never)).resolves.not.toThrow();

    expect(snapshot('transferInvites/dead').get('status')).toBe('expired');
    expect(deletes).toEqual(['authChallenges/dead']);
  });

  it('never throws out of the scheduler when every sweep fails', async () => {
    failQuery.add('persons');
    failQuery.add('transferInvites');
    failQuery.add('authChallenges');

    await expect(run({} as never)).resolves.not.toThrow();
  });

  it('keeps going when one document blows up mid-sweep', async () => {
    // 쓰기를 터뜨린다. 영수증 조회를 터뜨리면 "없음" 분기로 삼켜져 문서별 catch 를 지나지 않는다.
    seedPerson(P1, { status: 'kyc_ok', kycLevel: 0, chain: { kycLevelTx: '0xcc' } });
    seedPerson(P2, { status: 'kyc_ok', kycLevel: 0, chain: { kycLevelTx: '0xcc' } });
    failWrite.add(`persons/${P1}`);

    await run({} as never);

    expect(snapshot(`persons/${P1}`).get('status')).toBe('kyc_ok');
    expect(snapshot(`persons/${P2}`).get('status')).toBe('active');
  });

  it('caps every sweep so a backlog in one cannot starve the others', async () => {
    await run({} as never);

    expect(queries.filter((q) => q.name !== 'users').map((q) => [q.name, q.max])).toEqual([
      ['persons', 200],
      ['transferInvites', 200],
      ['authChallenges', 200],
      ['pendingGates', 200],
      ['persons', 200],
      // 백필 갈래 — `kyc.openedAt` 이 없는 문서는 위 부등식 질의에 걸리지 않는다.
      ['persons', 200],
    ]);
  });

  it('runs every five minutes in the deployed region with the attester secret', () => {
    const endpoint = (reconcilePending as unknown as { __endpoint: Record<string, unknown> })
      .__endpoint;
    expect(endpoint.scheduleTrigger).toMatchObject({
      schedule: 'every 5 minutes',
      timeZone: 'Asia/Seoul',
    });
    expect(endpoint.region).toEqual([FIREBASE_REGION]);
    // kyc_ok 재전송은 어테스터로, 정산 스윕의 deposit/release 는 트레저리·릴레이어로 나가므로
    // 세 시크릿이 모두 붙어 있어야 한다(settlementSweep 추가, 설계 2026-10-01 §3).
    expect(endpoint.secretEnvironmentVariables).toEqual([
      { key: 'ATTESTER_PK' },
      { key: 'RELAYER_PK' },
      { key: 'TREASURY_PK' },
    ]);
  });
});
