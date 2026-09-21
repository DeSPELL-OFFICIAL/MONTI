import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { getAddress } from 'viem';

process.env.GCP_PROJECT_ID = 'monti-dev';

const ORGANIZERS = '0x2222222222222222222222222222222222222222';
const TICKET = '0x3333333333333333333333333333333333333333';
/** 스태프 단말기가 하드웨어 키로 만든 게이트 계정. 대문자가 섞인 체크섬 형태로 들어온다. */
const GATE = getAddress('0x1234123412341234123412341234123412341234');
const SECOND_GATE = getAddress('0xabcdefabcdefabcdefabcdefabcdefabcdefabcd');
/** 호출자(관리자)의 스마트 계정. 세션에서 나오며 요청 본문에는 없다. */
const CALLER = getAddress('0x9999999999999999999999999999999999999999');
const OWNER = getAddress('0x8888888888888888888888888888888888888888');
const KX = `0x${'11'.repeat(32)}`;
const KY = `0x${'22'.repeat(32)}`;
const ZERO32 = `0x${'00'.repeat(32)}`;

/**
 * eth_call 하나하나의 답. 인가는 전부 체인에서 읽으므로(우리 DB 에는 역할이 없다)
 * 이 표를 갈아끼우는 것이 곧 "누구로 부르는가" 다.
 */
const chain = {
  orgId: 1n as bigint,
  owner: OWNER as string,
  /** `managerOf` — 매니저이기만 해서는 이 큐를 볼 수 없다. */
  manager: [false, false] as readonly [boolean, boolean],
  canManageGates: false,
};

type ReadArgs = { functionName: string; args?: readonly unknown[] };
const readContract = vi.fn(async ({ functionName }: ReadArgs) => {
  if (functionName === 'eventOrg') return chain.orgId;
  if (functionName === 'ownerOf') return chain.owner;
  if (functionName === 'managerOf') return chain.manager;
  if (functionName === 'hasPermission') return chain.canManageGates;
  throw new Error(`unexpected eth_call: ${functionName}`);
});

vi.mock('../src/lib/chain.js', () => ({
  publicClient: () => ({ readContract }),
  deployment: () => ({ organizers: ORGANIZERS, ticket: TICKET }),
}));

/**
 * `pendingGates` 한 컬렉션과 등식 질의·트랜잭션만 흉내 내는 가짜 Firestore.
 * 에뮬레이터 없이 `pnpm test` 안에서 돈다(transferInvites.test.ts 와 같은 패턴).
 */
const docs = new Map<string, Record<string, unknown>>();
const SERVER_TIMESTAMP = FieldValue.serverTimestamp();
/** 서버 타임스탬프를 쓸 때마다 1초씩 흐른다 — 재제출이 createdAt 을 갈아치우는지 보려면 값이 달라야 한다. */
let clock = 1_789_000_000_000;

function isServerTimestamp(value: unknown): boolean {
  const candidate = value as FieldValue | undefined;
  return typeof candidate?.isEqual === 'function' && candidate.isEqual(SERVER_TIMESTAMP);
}

function write(path: string, data: Record<string, unknown>, options?: { merge?: boolean }): void {
  const previous = options?.merge ? (docs.get(path) ?? {}) : {};
  const resolved = Object.fromEntries(
    Object.entries(data).map(([k, v]) => {
      if (!isServerTimestamp(v)) return [k, v];
      clock += 1_000;
      return [k, Timestamp.fromMillis(clock)];
    }),
  );
  docs.set(path, { ...previous, ...resolved });
}

function snapshot(path: string) {
  const data = docs.get(path);
  return {
    exists: data !== undefined,
    id: path.slice(path.indexOf('/') + 1),
    ref: docRef(path),
    get: (field: string) => data?.[field],
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

interface Order {
  field: string;
  direction: 'asc' | 'desc';
}

function comparable(value: unknown): number {
  return value instanceof Timestamp ? value.toMillis() : Number(value ?? 0);
}

function query(name: string, filters: Array<[string, unknown]>, max: number, order?: Order) {
  return {
    where: (field: string, op: string, value: unknown) => {
      if (op !== '==') throw new Error(`UNSUPPORTED_OP:${op}`);
      return query(name, [...filters, [field, value]], max, order);
    },
    orderBy: (field: string, direction: 'asc' | 'desc' = 'asc') =>
      query(name, filters, max, { field, direction }),
    limit: (n: number) => query(name, filters, n, order),
    get: async () => {
      const rows = [...docs.entries()]
        .filter(([path]) => path.startsWith(`${name}/`))
        .filter(([, data]) => filters.every(([field, value]) => data[field] === value));
      // 정렬은 **자르기 전에** 한다. 진짜 Firestore 와 순서가 달라지면 상한 테스트가 거짓말을 한다.
      if (order) {
        const sign = order.direction === 'desc' ? -1 : 1;
        rows.sort(([, a], [, b]) => sign * (comparable(a[order.field]) - comparable(b[order.field])));
      }
      const matched = rows.slice(0, max).map(([path]) => snapshot(path));
      return { docs: matched, size: matched.length, empty: matched.length === 0 };
    },
  };
}

function collection(name: string) {
  return { ...query(name, [], Number.POSITIVE_INFINITY), doc: (id: string) => docRef(`${name}/${id}`) };
}

type Ref = ReturnType<typeof docRef>;
type Query = ReturnType<typeof query>;

/** 진짜 `Transaction.get` 처럼 문서 참조도 질의도 받는다 — uid 당 상한은 트랜잭션 안에서 센다. */
const fakeDb = {
  collection,
  runTransaction: async <T>(fn: (tx: {
    get: (target: Ref | Query) => Promise<ReturnType<typeof snapshot> | Awaited<ReturnType<Query['get']>>>;
    set: (ref: Ref, data: Record<string, unknown>, options?: { merge?: boolean }) => void;
  }) => Promise<T>): Promise<T> =>
    fn({
      get: async (target: Ref | Query) =>
        'path' in target ? snapshot(target.path) : await target.get(),
      set: (ref: Ref, data: Record<string, unknown>, options?: { merge?: boolean }) =>
        write(ref.path, data, options),
    }),
};

vi.mock('../src/lib/db.js', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/db.js')>('../src/lib/db.js');
  return { ...actual, db: fakeDb };
});

/** `resolveCallerAccount` 만 가짜로 바꾸고 권한 비트는 진짜를 쓴다. */
const resolveCallerAccount = vi.fn(async () => CALLER);
vi.mock('../src/lib/auth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/auth.js')>()),
  resolveCallerAccount,
}));

const { PENDING_GATES } = await import('../src/lib/db.js');
const { PERM_MANAGE_GATES } = await import('../src/lib/auth.js');
const { MAX_PENDING_PER_UID } = await import('../src/functions/pendingGates.js');
const { listPendingGates, submitPendingGate } = await import('../src/functions/pendingGates.js');
const functionsTest = (await import('firebase-functions-test')).default();
const submit = functionsTest.wrap(submitPendingGate);
const list = functionsTest.wrap(listPendingGates);

/** 스태프 단말기는 전화 인증 세션으로 부른다 — 게이트 계정은 Identity 구성원이 아니다. */
const staff = { uid: 'uid-1', token: { phone_number: '+821011112222' } };
/** 다른 스태프 폰. 게이트 주소는 화면에 글자로 뜨는 반공개 값이라 이쪽도 그 주소를 안다. */
const otherStaff = { uid: 'uid-7', token: { phone_number: '+821033334444' } };
const admin = { uid: 'uid-2', token: { account: CALLER } };
const payload = { eventId: '11', gateAccount: GATE, kx: KX, ky: KY };

function post(data: Record<string, unknown> = payload, auth: unknown = staff) {
  return submit({ data, auth } as never) as Promise<{ ok: true }>;
}

function queue(data: Record<string, unknown> = { eventId: '11' }, auth: unknown = admin) {
  return list({ data, auth } as never) as Promise<{ gates: Array<Record<string, unknown>> }>;
}

beforeEach(() => {
  docs.clear();
  readContract.mockClear();
  resolveCallerAccount.mockClear();
  chain.orgId = 1n;
  chain.owner = OWNER;
  chain.manager = [false, false];
  chain.canManageGates = false;
});

describe('submitPendingGate', () => {
  it('queues the gate account under its lowercased address for any signed-in staff phone', async () => {
    expect(await post()).toEqual({ ok: true });

    const doc = snapshot(`${PENDING_GATES}/${GATE.toLowerCase()}`);
    expect(doc.exists).toBe(true);
    expect(doc.data()).toMatchObject({
      eventId: '11',
      kx: KX,
      ky: KY,
      submittedBy: 'uid-1',
      status: 'pending',
    });
    expect(Object.keys(doc.data() ?? {}).sort()).toEqual([
      'createdAt', 'eventId', 'kx', 'ky', 'status', 'submittedBy',
    ]);
    // 제안일 뿐이라 체인도 신원도 묻지 않는다 — 승인은 관리자가 체인에서 직접 서명한다.
    expect(readContract).not.toHaveBeenCalled();
    expect(resolveCallerAccount).not.toHaveBeenCalled();
  });

  it('is an upsert: re-submitting the same device replaces the keys and keeps the queue position', async () => {
    await post();
    const first = snapshot(`${PENDING_GATES}/${GATE.toLowerCase()}`).get('createdAt');

    const rotated = `0x${'33'.repeat(32)}`;
    await post({ ...payload, ky: rotated });

    const all = await collection(PENDING_GATES).get();
    expect(all.size).toBe(1);
    const doc = snapshot(`${PENDING_GATES}/${GATE.toLowerCase()}`);
    expect(doc.get('ky')).toBe(rotated);
    expect(doc.get('createdAt')).toBe(first);
  });

  it('does not put an already registered gate back in the queue', async () => {
    // `registerGate` 는 같은 계정을 두 번 받지 않는다(GateAccountInUse) —
    // 다시 pending 으로 돌리면 승인할 수 없는 줄이 관리자 화면에 영영 남는다.
    await post();
    write(`${PENDING_GATES}/${GATE.toLowerCase()}`, { status: 'registered', gateId: '9' }, { merge: true });

    await post({ ...payload, kx: `0x${'44'.repeat(32)}` });
    const doc = snapshot(`${PENDING_GATES}/${GATE.toLowerCase()}`);
    expect(doc.get('status')).toBe('registered');
    expect(doc.get('kx')).toBe(`0x${'44'.repeat(32)}`);
  });

  it('lets only the uid that queued a gate change its keys', async () => {
    await post();

    // 남의 줄에는 손대지 못한다 — 키를 덮어쓰거나 `eventId` 를 바꿔 원래 주최자 목록에서 치울 수 없다.
    await expect(post({ ...payload, kx: `0x${'99'.repeat(32)}` }, otherStaff)).rejects.toThrow('NOT_YOUR_GATE');
    await expect(post({ ...payload, eventId: '12' }, otherStaff)).rejects.toThrow('NOT_YOUR_GATE');
    const doc = snapshot(`${PENDING_GATES}/${GATE.toLowerCase()}`);
    expect(doc.get('kx')).toBe(KX);
    expect(doc.get('eventId')).toBe('11');
    expect(doc.get('submittedBy')).toBe('uid-1');

    // 올린 uid 는 그대로 고친다.
    await expect(post({ ...payload, kx: `0x${'99'.repeat(32)}` })).resolves.toEqual({ ok: true });
    expect(snapshot(`${PENDING_GATES}/${GATE.toLowerCase()}`).get('kx')).toBe(`0x${'99'.repeat(32)}`);
  });

  it('caps one uid at three open proposals, and frees a slot when one is closed', async () => {
    const address = (n: number) => getAddress(`0x${String(n).repeat(40).slice(0, 40)}`);
    for (let i = 1; i <= MAX_PENDING_PER_UID; i += 1) {
      await post({ ...payload, gateAccount: address(i) });
    }
    await expect(post({ ...payload, gateAccount: address(4) })).rejects.toThrow('TOO_MANY_PENDING');
    expect(docs.size).toBe(MAX_PENDING_PER_UID);

    // 다른 스태프의 몫은 그대로다 — 상한은 uid 마다 센다.
    await expect(post({ ...payload, gateAccount: address(4) }, otherStaff)).resolves.toEqual({ ok: true });

    // 승인(또는 만료)되면 자리가 돌아온다.
    write(`${PENDING_GATES}/${address(1).toLowerCase()}`, { status: 'registered' }, { merge: true });
    await expect(post({ ...payload, gateAccount: address(5) })).resolves.toEqual({ ok: true });

    // 이미 올린 단말기를 다시 올리는 것은 새 줄이 아니라서 상한에 걸리지 않는다.
    await expect(post({ ...payload, gateAccount: address(2), ky: `0x${'77'.repeat(32)}` })).resolves.toEqual({
      ok: true,
    });
  });

  it('normalizes the event id the same way the queue is read', async () => {
    await post({ ...payload, eventId: '011' });
    expect(snapshot(`${PENDING_GATES}/${GATE.toLowerCase()}`).get('eventId')).toBe('11');
  });

  it('refuses an unauthenticated caller', async () => {
    await expect(submit({ data: payload } as never)).rejects.toThrow('AUTH_REQUIRED');
    expect(docs.size).toBe(0);
  });

  it('refuses a malformed event id, gate account or device key', async () => {
    await expect(post({ ...payload, eventId: '0x11' })).rejects.toThrow('BAD_EVENT_ID');
    await expect(post({ ...payload, eventId: '' })).rejects.toThrow('BAD_EVENT_ID');

    await expect(post({ ...payload, gateAccount: '0xnope' })).rejects.toThrow('BAD_GATE_ACCOUNT');
    await expect(post({ ...payload, gateAccount: GATE.slice(0, 40) })).rejects.toThrow('BAD_GATE_ACCOUNT');
    // 체크섬이 어긋난 주소는 옮겨 적다 틀린 값이다 — EIP-55 가 잡으라고 있는 오타를 큐에 넣지 않는다.
    // 한 글자의 대소문자만 뒤집어도 체크섬은 깨진다(SECOND_GATE 의 첫 자리는 'A' 다).
    const typo = `0x${SECOND_GATE[2] === 'A' ? 'a' : 'A'}${SECOND_GATE.slice(3)}`;
    await expect(post({ ...payload, gateAccount: typo })).rejects.toThrow('BAD_GATE_ACCOUNT');
    // 소문자로만 적은 주소는 체크섬이 없는 것이라 그대로 받는다.
    await expect(post({ ...payload, gateAccount: GATE.toLowerCase() })).resolves.toEqual({ ok: true });
    docs.clear();

    await expect(post({ ...payload, kx: '0x11' })).rejects.toThrow('BAD_DEVICE_KEY');
    await expect(post({ ...payload, ky: undefined })).rejects.toThrow('BAD_DEVICE_KEY');
    // 반쪽이 0 인 키는 P-256 점이 아니다. 체인은 둘 다 0 일 때만 막으므로 여기서 막는다.
    await expect(post({ ...payload, kx: ZERO32 })).rejects.toThrow('BAD_DEVICE_KEY');
    await expect(post({ ...payload, ky: ZERO32 })).rejects.toThrow('BAD_DEVICE_KEY');

    expect(docs.size).toBe(0);
  });
});

describe('listPendingGates', () => {
  it('lists this event queue for a PERM_MANAGE_GATES admin, with checksummed addresses and no uid', async () => {
    await post();
    await post({ ...payload, gateAccount: SECOND_GATE });
    chain.canManageGates = true;

    const result = await queue();
    expect(result.gates).toHaveLength(2);
    expect(Object.keys(result.gates[0] ?? {}).sort()).toEqual(['gateAccount', 'kx', 'ky', 'submittedAt']);
    expect(result.gates.map((gate) => gate.gateAccount).sort()).toEqual([GATE, SECOND_GATE].sort());
    expect(result.gates[0]).toMatchObject({ kx: KX, ky: KY });
    expect(result.gates[0]?.submittedAt).toBeGreaterThan(0);
    expect(JSON.stringify(result)).not.toContain('uid-1');

    // 권한은 그 조직의 게이트 관리 비트로 묻는다.
    expect(readContract).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: 'hasPermission', args: [1n, CALLER, PERM_MANAGE_GATES] }),
    );
  });

  it('lets the organizer owner read the queue without an admin bit', async () => {
    await post();
    chain.owner = CALLER;

    expect((await queue()).gates).toHaveLength(1);
  });

  it('refuses a manager who has no PERM_MANAGE_GATES bit', async () => {
    await post();
    chain.manager = [true, true];

    await expect(queue()).rejects.toThrow('NOT_GATE_ADMIN');
  });

  it('shows only the pending gates of the event that was asked for', async () => {
    await post();
    await post({ ...payload, eventId: '12', gateAccount: SECOND_GATE });
    write(`${PENDING_GATES}/${GATE.toLowerCase()}`, { status: 'registered' }, { merge: true });
    chain.canManageGates = true;

    // 이 공연의 유일한 줄은 이미 체인에 올라갔다 — 승인 화면에 남을 것이 없다.
    expect((await queue()).gates).toEqual([]);
    expect((await queue({ eventId: '12' })).gates).toHaveLength(1);
  });

  it('hands the organizer the newest submissions first', async () => {
    await post();
    await post({ ...payload, gateAccount: SECOND_GATE });
    chain.canManageGates = true;

    // 정렬이 없으면 200칸 창이 주소 순으로 잘려 방금 올린 단말기가 사라진다.
    const result = await queue();
    expect(result.gates.map((gate) => gate.gateAccount)).toEqual([SECOND_GATE, GATE]);
    expect(Number(result.gates[0]?.submittedAt)).toBeGreaterThan(Number(result.gates[1]?.submittedAt));
  });

  it('refuses an event that no organizer owns', async () => {
    chain.orgId = 0n;
    chain.canManageGates = true;

    // 없는 공연에 "권한 없음" 을 돌려주면 호출자가 자기 권한을 의심한다. 틀린 것은 공연 번호다.
    await expect(queue({ eventId: '404' })).rejects.toThrow('UNKNOWN_EVENT');
  });

  it('refuses a malformed event id before it reads the chain', async () => {
    await expect(queue({ eventId: '0x0b' })).rejects.toThrow('BAD_EVENT_ID');
    expect(readContract).not.toHaveBeenCalled();
  });
});
