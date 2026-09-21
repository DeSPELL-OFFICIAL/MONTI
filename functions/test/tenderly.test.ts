import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { encodeEventTopics, encodeAbiParameters, parseAbiParameters } from 'viem';
import { ticketAbi } from '@monti/shared';
import { decodeMontiLogs, verifyTenderlySignature } from '../src/lib/tenderly.js';

const SECRET = 'tenderly-secret';
const RAW = '{"id":"alert-1"}';
const DATE = 'Sun, 20 Sep 2026 00:00:00 GMT';
const SIG = createHmac('sha256', SECRET).update(RAW).update(DATE).digest('hex');

describe('verifyTenderlySignature', () => {
  it('accepts the documented HMAC over body + Date header', () => {
    expect(verifyTenderlySignature({ raw: RAW, signature: SIG, date: DATE, secret: SECRET })).toBe(true);
  });

  it('rejects a wrong signature, date or secret', () => {
    expect(verifyTenderlySignature({ raw: RAW, signature: 'ff', date: DATE, secret: SECRET })).toBe(false);
    expect(verifyTenderlySignature({ raw: RAW, signature: SIG, date: 'other', secret: SECRET })).toBe(false);
    expect(verifyTenderlySignature({ raw: RAW, signature: SIG, date: DATE, secret: 'nope' })).toBe(false);
  });
});

describe('decodeMontiLogs', () => {
  it('decodes a CheckedIn log into name and args', () => {
    // 인덱스 인자 셋을 모두 주었으니 토픽에 `null` 도 배열도 없다 — `ticketAbi` 가
    // `Abi` 라 viem 이 그 사실을 타입으로 좁혀 주지 못할 뿐이다.
    const topics = encodeEventTopics({
      abi: ticketAbi,
      eventName: 'CheckedIn',
      args: { tokenId: 7n, eventId: 11n, gateId: 3n },
    }) as Hex[];
    const data = encodeAbiParameters(parseAbiParameters('bytes32 nonceHash, uint64 ts'), [
      `0x${'11'.repeat(32)}`,
      1_789_862_400n,
    ]);

    const decoded = decodeMontiLogs([{ raw: { topics, data } }]);
    expect(decoded).toHaveLength(1);
    expect(decoded[0]!.name).toBe('CheckedIn');
    expect(decoded[0]!.args.tokenId).toBe(7n);
    expect(decoded[0]!.args.gateId).toBe(3n);
  });

  it('skips logs that belong to no MONTI contract', () => {
    expect(decodeMontiLogs([{ raw: { topics: [`0x${'ab'.repeat(32)}`], data: '0x' } }])).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// tenderlyWebhook — 서명 검증·디코드·부수효과가 실제 핸들러에서 함께 도는지 본다.
// ─────────────────────────────────────────────────────────────────────────────

import { FakeRes } from './helpers/webhookRes.js';
import { beforeEach, vi } from 'vitest';
import { identityAbi, organizersAbi, type Hex } from '@monti/shared';

process.env.GCP_PROJECT_ID = 'monti-dev';
process.env.TENDERLY_WEBHOOK_SECRET = SECRET;

const TICKET = `0x${'11'.repeat(20)}` as Hex;
const IDENTITY = `0x${'22'.repeat(20)}` as Hex;
const ORGANIZERS = `0x${'33'.repeat(20)}` as Hex;
const ZERO = '0x0000000000000000000000000000000000000000' as Hex;
// 체인이 돌려주는 주소는 체크섬이다. devices 문서 id 도 같은 모양이다.
const OWNER = '0xABC0000000000000000000000000000000000001' as Hex;
const OTHER = '0xDEF0000000000000000000000000000000000002' as Hex;
const PERSON = `0x${'aa'.repeat(32)}` as Hex;

/** `collection().doc()` · `where()` · 하위 컬렉션만 흉내 내는 가짜 Firestore. */
const docs = new Map<string, Record<string, unknown>>();

function write(path: string, data: Record<string, unknown>, options?: { merge?: boolean }): void {
  docs.set(path, options?.merge ? { ...(docs.get(path) ?? {}), ...data } : { ...data });
}

function docRef(path: string) {
  return {
    path,
    id: path.slice(path.lastIndexOf('/') + 1),
    get: async () => snapshot(path),
    set: async (data: Record<string, unknown>, options?: { merge?: boolean }) => write(path, data, options),
    update: async (data: Record<string, unknown>) => {
      if (!docs.has(path)) throw new Error(`NOT_FOUND:${path}`);
      write(path, data, { merge: true });
    },
    delete: async () => {
      docs.delete(path);
    },
  };
}

function snapshot(path: string) {
  const data = docs.get(path);
  return {
    exists: data !== undefined,
    id: path.slice(path.lastIndexOf('/') + 1),
    ref: docRef(path),
    get: (field: string) => data?.[field],
    data: () => data,
  };
}

function collectionRef(path: string, filters: Array<[string, unknown]> = [], max?: number) {
  return {
    doc: (id: string) => docRef(`${path}/${id}`),
    where: (field: string, _op: string, value: unknown) => collectionRef(path, [...filters, [field, value]], max),
    limit: (n: number) => collectionRef(path, filters, n),
    get: async () => {
      const prefix = `${path}/`;
      let matched = [...docs.keys()]
        .filter((key) => key.startsWith(prefix) && !key.slice(prefix.length).includes('/'))
        .filter((key) => filters.every(([field, value]) => docs.get(key)?.[field] === value))
        .map((key) => snapshot(key));
      if (max !== undefined) matched = matched.slice(0, max);
      return { docs: matched, empty: matched.length === 0, size: matched.length };
    },
  };
}

const fakeDb = {
  collection: (path: string) => collectionRef(path),
  doc: (path: string) => docRef(path),
};

vi.mock('../src/lib/db.js', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/db.js')>('../src/lib/db.js');
  return { ...actual, db: fakeDb };
});

/** 체인 상태. 테스트마다 값만 바꿔 끼운다 — 권한·소유는 언제나 eth_call 이 원본이다. */
const chain = {
  ownerOf: new Map<string, Hex>(),
  eventOf: new Map<string, bigint>(),
  balanceOfEvent: new Map<string, bigint>(),
  personOf: new Map<string, Hex>(),
  eventMeta: { orgId: 5n, endsAt: 1_800_000_000n },
};

const readContract = vi.fn(async (args: { functionName: string; args: readonly unknown[] }) => {
  const [first, second] = args.args as [unknown, unknown];
  switch (args.functionName) {
    case 'ownerOf':
      return chain.ownerOf.get(String(first)) ?? ZERO;
    case 'eventOf':
      return chain.eventOf.get(String(first)) ?? 0n;
    case 'balanceOfEvent':
      return chain.balanceOfEvent.get(`${String(first).toLowerCase()}:${String(second)}`) ?? 0n;
    case 'personOf':
      return chain.personOf.get(String(first).toLowerCase()) ?? `0x${'00'.repeat(32)}`;
    case 'eventMeta':
      return chain.eventMeta;
    default:
      throw new Error(`UNEXPECTED_CALL:${args.functionName}`);
  }
});

vi.mock('../src/lib/chain.js', () => ({
  deployment: () => ({ ticket: TICKET, identity: IDENTITY, organizers: ORGANIZERS }),
  publicClient: () => ({ readContract: (...args: unknown[]) => readContract(...(args as [never])) }),
}));

const send = vi.fn(async (_message: unknown) => 'projects/monti/messages/1');
vi.mock('firebase-admin/messaging', () => ({
  getMessaging: () => ({ send: (...args: unknown[]) => send(...(args as [never])) }),
}));

const { DEVICES, EVENT_CHATS, INVITES, PENDING_GATES, PERSONS, TRANSFER_INVITES, USERS } = await import(
  '../src/lib/db.js',
);
const { tenderlyWebhook } = await import('../src/functions/tenderlyWebhook.js');

interface MontiLog {
  raw: { address?: string; topics: readonly string[]; data: string };
}

/** Tenderly 가 보내는 로그 한 줄. `address` 는 그 로그를 낸 컨트랙트다(소문자로 온다). */
function montiLog(
  address: string,
  abi: typeof ticketAbi,
  eventName: string,
  indexed: Record<string, unknown>,
  params = '',
  values: unknown[] = [],
): MontiLog {
  return {
    raw: {
      address: address.toLowerCase(),
      topics: encodeEventTopics({ abi, eventName, args: indexed } as never) as string[],
      data: params ? encodeAbiParameters(parseAbiParameters(params), values as never) : '0x',
    },
  };
}

const checkedIn = (tokenId: bigint) =>
  montiLog(TICKET, ticketAbi, 'CheckedIn', { tokenId, eventId: 11n, gateId: 3n }, 'bytes32 nonceHash, uint64 ts', [
    `0x${'11'.repeat(32)}`,
    1_789_862_400n,
  ]);
const registered = (personId: Hex, account: Hex) =>
  montiLog(IDENTITY, identityAbi, 'Registered', { personId, account });
const nicknameSet = (account: Hex, nickname: string) =>
  montiLog(IDENTITY, identityAbi, 'NicknameSet', { account, nicknameHash: `0x${'cc'.repeat(32)}` }, 'string nickname', [
    nickname,
  ]);
const transfer = (from: Hex, to: Hex, tokenId: bigint, address: string = TICKET) =>
  montiLog(address, ticketAbi, 'Transfer', { from, to, tokenId });
const offerAccepted = (tokenId: bigint) =>
  montiLog(TICKET, ticketAbi, 'OfferAccepted', { tokenId, from: OWNER, to: OTHER });
const eventStatusChanged = (eventId: bigint, status: number) =>
  montiLog(TICKET, ticketAbi, 'EventStatusChanged', { eventId }, 'uint8 status', [status]);
const adminSet = (orgId: bigint, admin: Hex, bits = 31) =>
  montiLog(ORGANIZERS, organizersAbi, 'AdminSet', { orgId, admin }, 'uint32 bits', [bits]);
const managerSet = (orgId: bigint, manager: Hex, exists = true) =>
  montiLog(ORGANIZERS, organizersAbi, 'ManagerSet', { orgId, manager }, 'bool exists, bool canApprove', [
    exists,
    true,
  ]);
const gateRegistered = (gateId: bigint, eventId: bigint) =>
  montiLog(
    ORGANIZERS,
    organizersAbi,
    'GateRegistered',
    { gateId, eventId, gateAccount: OTHER },
    'bytes32 kx, bytes32 ky',
    [`0x${'dd'.repeat(32)}`, `0x${'ee'.repeat(32)}`],
  );

interface Delivery {
  raw?: string;
  signature?: string;
  date?: string;
  secret?: string;
  method?: string;
}

async function deliver(logs: MontiLog[], override: Delivery = {}): Promise<FakeRes> {
  const raw = override.raw ?? JSON.stringify({ transaction: { logs } });
  const date = override.date ?? new Date().toUTCString();
  const signature =
    override.signature ?? createHmac('sha256', override.secret ?? SECRET).update(raw).update(date).digest('hex');
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-tenderly-signature': signature,
    date,
  };
  const req = {
    method: override.method ?? 'POST',
    headers,
    rawBody: Buffer.from(raw, 'utf8'),
    get: (name: string) => headers[name.toLowerCase()],
  };
  const res = new FakeRes();
  await (tenderlyWebhook as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res);
  await new Promise((resolve) => setImmediate(resolve));
  return res;
}

beforeEach(() => {
  docs.clear();
  send.mockClear();
  readContract.mockClear();
  chain.ownerOf.clear();
  chain.eventOf.clear();
  chain.balanceOfEvent.clear();
  chain.personOf.clear();
  chain.eventMeta = { orgId: 5n, endsAt: 1_800_000_000n };
});

describe('tenderlyWebhook', () => {
  it('refuses a forged signature with 401 and applies nothing', async () => {
    chain.ownerOf.set('7', OWNER);
    write(`${DEVICES}/${OWNER}`, { pushToken: 'fcm-1' });

    const forged = await deliver([checkedIn(7n)], { signature: 'deadbeef' });
    expect(forged.statusCode).toBe(401);
    const wrongSecret = await deliver([checkedIn(7n)], { secret: 'not-the-secret' });
    expect(wrongSecret.statusCode).toBe(401);
    // 서명은 본문 + Date 헤더에 함께 걸린다. 서명해 준 날짜와 다른 날짜를 얹으면 통과하지 않는다.
    const body = JSON.stringify({ transaction: { logs: [checkedIn(7n)] } });
    const signedForAnotherDay = createHmac('sha256', SECRET).update(body).update(DATE).digest('hex');
    const wrongDate = await deliver([], {
      raw: body,
      signature: signedForAnotherDay,
      date: 'Mon, 21 Sep 2026 00:00:00 GMT',
    });
    expect(wrongDate.statusCode).toBe(401);

    expect(send).not.toHaveBeenCalled();
    expect(readContract).not.toHaveBeenCalled();
  });

  it('refuses a body that is not JSON with 400', async () => {
    const res = await deliver([], { raw: 'not json' });
    expect(res.statusCode).toBe(400);
    expect(res.body).toBe('bad json');
  });

  it('answers 200 ok:N with the number of MONTI events it decoded', async () => {
    write(`${PERSONS}/${PERSON}`, { status: 'pending' });
    const res = await deliver([
      registered(PERSON, OWNER),
      // 우리 주소에서 나왔어도 우리 ABI 의 이벤트가 아니면 세지 않는다.
      { raw: { address: TICKET.toLowerCase(), topics: [`0x${'ab'.repeat(32)}`], data: '0x' } },
    ]);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('ok:1');
  });

  it('pushes 입장 완료 to the owner device on CheckedIn, and no-ops without a token', async () => {
    chain.ownerOf.set('7', OWNER);
    write(`${DEVICES}/${OWNER}`, { pushToken: 'fcm-1' });

    const res = await deliver([checkedIn(7n)]);
    expect(res.statusCode).toBe(200);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      token: 'fcm-1',
      notification: { title: '입장 완료' },
      data: { tokenId: '7' },
    });

    // 기기 문서는 있지만 토큰이 없다.
    send.mockClear();
    write(`${DEVICES}/${OWNER}`, {});
    expect((await deliver([checkedIn(7n)])).statusCode).toBe(200);
    expect(send).not.toHaveBeenCalled();

    // 기기 문서 자체가 없다.
    docs.delete(`${DEVICES}/${OWNER}`);
    expect((await deliver([checkedIn(7n)])).statusCode).toBe(200);
    expect(send).not.toHaveBeenCalled();
  });

  it('never 500s when Firebase Messaging rejects a stale token', async () => {
    chain.ownerOf.set('7', OWNER);
    write(`${DEVICES}/${OWNER}`, { pushToken: 'stale' });
    send.mockRejectedValueOnce(new Error('registration-token-not-registered'));

    const res = await deliver([checkedIn(7n)]);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('ok:1');
  });

  it('turns a pending person active on Registered and leaves an active one alone', async () => {
    write(`${PERSONS}/${PERSON}`, { status: 'pending' });
    await deliver([registered(PERSON, OWNER)]);
    expect(snapshot(`${PERSONS}/${PERSON}`).get('status')).toBe('active');

    // 알 수 없는 personId 로 사람 문서를 새로 만들지 않는다.
    const stranger = `0x${'bb'.repeat(32)}` as Hex;
    await deliver([registered(stranger, OWNER)]);
    expect(snapshot(`${PERSONS}/${stranger}`).exists).toBe(false);
  });

  it('mirrors the chain nickname onto the matching users document', async () => {
    chain.personOf.set(OWNER.toLowerCase(), PERSON);
    write(`${USERS}/uid-1`, { personId: PERSON });
    write(`${USERS}/uid-2`, { personId: `0x${'bb'.repeat(32)}` });

    await deliver([nicknameSet(OWNER, '몽티')]);
    expect(snapshot(`${USERS}/uid-1`).get('nickname')).toBe('몽티');
    expect(snapshot(`${USERS}/uid-2`).get('nickname')).toBeUndefined();
  });

  it('drops the sender from the event chat only when no ticket is left', async () => {
    chain.eventOf.set('7', 11n);
    write(`${EVENT_CHATS}/11/members/uid-1`, { account: OWNER });

    // 아직 다른 티켓이 남아 있다 — 방에서 내보내지 않는다.
    chain.balanceOfEvent.set(`${OWNER.toLowerCase()}:11`, 1n);
    await deliver([transfer(OWNER, OTHER, 7n)]);
    expect(snapshot(`${EVENT_CHATS}/11/members/uid-1`).exists).toBe(true);

    // 마지막 티켓이었다.
    chain.balanceOfEvent.set(`${OWNER.toLowerCase()}:11`, 0n);
    await deliver([transfer(OWNER, OTHER, 7n)]);
    expect(snapshot(`${EVENT_CHATS}/11/members/uid-1`).exists).toBe(false);
  });

  it('reads nothing on a mint, and still drops the sender on a burn', async () => {
    await deliver([transfer(ZERO, OWNER, 7n)]);
    expect(readContract).not.toHaveBeenCalled();

    chain.eventOf.set('7', 11n);
    chain.balanceOfEvent.set(`${OWNER.toLowerCase()}:11`, 0n);
    write(`${EVENT_CHATS}/11/members/uid-1`, { account: OWNER });
    await deliver([transfer(OWNER, ZERO, 7n)]);
    expect(snapshot(`${EVENT_CHATS}/11/members/uid-1`).exists).toBe(false);
  });

  it('accepts only the sent transfer invites for that token on OfferAccepted', async () => {
    write(`${TRANSFER_INVITES}/i1`, { tokenId: '7', status: 'sent' });
    write(`${TRANSFER_INVITES}/i2`, { tokenId: '7', status: 'accepted' });
    write(`${TRANSFER_INVITES}/i3`, { tokenId: '8', status: 'sent' });

    await deliver([offerAccepted(7n)]);
    expect(snapshot(`${TRANSFER_INVITES}/i1`).get('status')).toBe('accepted');
    expect(snapshot(`${TRANSFER_INVITES}/i2`).get('status')).toBe('accepted');
    expect(snapshot(`${TRANSFER_INVITES}/i3`).get('status')).toBe('sent');

    // 재배달은 아무것도 바꾸지 않는다.
    const res = await deliver([offerAccepted(7n)]);
    expect(res.statusCode).toBe(200);
    expect(snapshot(`${TRANSFER_INVITES}/i3`).get('status')).toBe('sent');
  });

  it('ignores the Draft status createEvent emits, opens the chat on Published and closes it later', async () => {
    await deliver([eventStatusChanged(11n, 0)]);
    expect(snapshot(`${EVENT_CHATS}/11`).exists).toBe(false);

    await deliver([eventStatusChanged(11n, 1)]);
    expect(snapshot(`${EVENT_CHATS}/11`).data()).toEqual({ closed: false, endsAt: 1_800_000_000, orgId: '5' });

    await deliver([eventStatusChanged(11n, 2)]);
    expect(snapshot(`${EVENT_CHATS}/11`).get('closed')).toBe(true);

    docs.delete(`${EVENT_CHATS}/11`);
    await deliver([eventStatusChanged(11n, 1)]);
    await deliver([eventStatusChanged(11n, 3)]);
    expect(snapshot(`${EVENT_CHATS}/11`).get('closed')).toBe(true);
  });

  it('marks the accepted organizer invite done on AdminSet, and is idempotent', async () => {
    write(`${INVITES}/a1`, { orgId: '5', role: 'admin', status: 'accepted', acceptedBy: OWNER.toLowerCase() });
    write(`${INVITES}/a2`, { orgId: '5', role: 'admin', status: 'accepted', acceptedBy: OTHER });
    write(`${INVITES}/a3`, { orgId: '6', role: 'admin', status: 'accepted', acceptedBy: OWNER });
    write(`${INVITES}/a4`, { orgId: '5', role: 'admin', status: 'sent', acceptedBy: OWNER });

    await deliver([adminSet(5n, OWNER)]);
    // 체인 인자는 체크섬, 저장된 값은 소문자일 수 있다 — 대소문자를 가리지 않고 맞춘다.
    expect(snapshot(`${INVITES}/a1`).get('status')).toBe('done');
    expect(snapshot(`${INVITES}/a2`).get('status')).toBe('accepted');
    expect(snapshot(`${INVITES}/a3`).get('status')).toBe('accepted');
    expect(snapshot(`${INVITES}/a4`).get('status')).toBe('sent');

    const again = await deliver([adminSet(5n, OWNER)]);
    expect(again.statusCode).toBe(200);
    expect(snapshot(`${INVITES}/a1`).get('status')).toBe('done');
  });

  it('refuses any method but POST with 405, before it looks at the signature', async () => {
    chain.ownerOf.set('7', OWNER);
    write(`${DEVICES}/${OWNER}`, { pushToken: 'fcm-1' });

    for (const method of ['GET', 'PUT', 'DELETE', 'PATCH']) {
      const res = await deliver([checkedIn(7n)], { method });
      expect(res.statusCode).toBe(405);
      expect(res.body).toBe('method not allowed');
    }
    expect(send).not.toHaveBeenCalled();
    expect(readContract).not.toHaveBeenCalled();
  });

  it('ignores a foreign ERC-721 Transfer riding in the same transaction', async () => {
    const foreign = '0x9999999999999999999999999999999999999999';
    chain.eventOf.set('7', 11n);
    chain.balanceOfEvent.set(`${OWNER.toLowerCase()}:11`, 0n);
    write(`${EVENT_CHATS}/11/members/uid-1`, { account: OWNER });

    // 같은 이벤트 서명(`Transfer(address,address,uint256)`)이라 우리 ABI 로도 디코드된다.
    // 주소를 보지 않으면 남의 토큰 이동이 우리 채팅 멤버를 지운다.
    const res = await deliver([transfer(OWNER, OTHER, 7n, foreign)]);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('ok:0');
    expect(readContract).not.toHaveBeenCalled();
    expect(snapshot(`${EVENT_CHATS}/11/members/uid-1`).exists).toBe(true);

    // 우리 Ticket 주소에서 온 같은 로그는 그대로 처리된다.
    const ours = await deliver([transfer(OWNER, OTHER, 7n)]);
    expect(ours.body).toBe('ok:1');
    expect(snapshot(`${EVENT_CHATS}/11/members/uid-1`).exists).toBe(false);
  });

  it('closes the manager invite on ManagerSet, and leaves it alone when the manager is removed', async () => {
    write(`${INVITES}/m1`, { orgId: '5', role: 'manager', status: 'accepted', acceptedBy: OWNER });

    // 권한을 거두는 이벤트(`exists:false`)는 초대장을 닫지 않는다 —
    // 아직 실행되지 않은 calldata 를 여기서 잃으면 다시 받을 길이 없다.
    await deliver([managerSet(5n, OWNER, false)]);
    expect(snapshot(`${INVITES}/m1`).get('status')).toBe('accepted');

    await deliver([managerSet(5n, OWNER, true)]);
    expect(snapshot(`${INVITES}/m1`).get('status')).toBe('done');
  });

  it('leaves the admin invite alone when AdminSet strips every permission bit', async () => {
    write(`${INVITES}/a1`, { orgId: '5', role: 'admin', status: 'accepted', acceptedBy: OWNER });

    await deliver([adminSet(5n, OWNER, 0)]);
    expect(snapshot(`${INVITES}/a1`).get('status')).toBe('accepted');

    await deliver([adminSet(5n, OWNER, 1)]);
    expect(snapshot(`${INVITES}/a1`).get('status')).toBe('done');
  });

  it('closes only the invite for the role that was set when one person holds both', async () => {
    // 세 필드(orgId·acceptedBy·status)가 똑같은 두 장. role 을 보지 않으면 둘 다 닫힌다.
    write(`${INVITES}/both-admin`, { orgId: '5', role: 'admin', status: 'accepted', acceptedBy: OWNER });
    write(`${INVITES}/both-manager`, { orgId: '5', role: 'manager', status: 'accepted', acceptedBy: OWNER });

    await deliver([adminSet(5n, OWNER)]);
    expect(snapshot(`${INVITES}/both-admin`).get('status')).toBe('done');
    expect(snapshot(`${INVITES}/both-manager`).get('status')).toBe('accepted');

    await deliver([managerSet(5n, OWNER)]);
    expect(snapshot(`${INVITES}/both-manager`).get('status')).toBe('done');
  });

  it('closes the queued gate on GateRegistered and stamps the chain gate id', async () => {
    // 문서 id 는 `submitPendingGate` 가 적은 소문자 주소다. 이벤트 인자는 체크섬으로 온다.
    const queued = `${PENDING_GATES}/${OTHER.toLowerCase()}`;
    write(queued, {
      eventId: '11',
      kx: `0x${'dd'.repeat(32)}`,
      ky: `0x${'ee'.repeat(32)}`,
      status: 'pending',
      submittedBy: 'uid-1',
    });

    const res = await deliver([gateRegistered(9n, 11n)]);
    expect(res.statusCode).toBe(200);
    expect(snapshot(queued).get('status')).toBe('registered');
    expect(snapshot(queued).get('gateId')).toBe('9');
    // 권한 판정은 여전히 eth_call 이다 — 여기서는 대기열만 닫고 체인을 읽지 않는다.
    expect(readContract).not.toHaveBeenCalled();

    // 재배달은 아무것도 바꾸지 않고, 스태프가 올린 키도 그대로 남는다.
    const again = await deliver([gateRegistered(9n, 11n)]);
    expect(again.statusCode).toBe(200);
    expect(snapshot(queued).get('status')).toBe('registered');
    expect(snapshot(queued).get('kx')).toBe(`0x${'dd'.repeat(32)}`);
  });

  it('never creates a pending gate document for a gate nobody queued', async () => {
    // 관리자가 승인 화면을 거치지 않고 바로 등록한 경우다. 웹훅 입력으로 문서를 만들지 않는다.
    const res = await deliver([gateRegistered(9n, 11n)]);
    expect(res.body).toBe('ok:1');
    expect(docs.size).toBe(0);
    expect(readContract).not.toHaveBeenCalled();
  });

  it('skips an event status code it does not know instead of throwing', async () => {
    const res = await deliver([eventStatusChanged(11n, 7)]);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('ok:1');
    expect(snapshot(`${EVENT_CHATS}/11`).exists).toBe(false);
    expect(readContract).not.toHaveBeenCalled();
  });

  it('refuses a transition the table blocks and leaves the person untouched', async () => {
    // `rotated` 는 되살아나지 않는다. 던진 것은 바깥 루프가 잡아 기록만 남긴다.
    write(`${PERSONS}/${PERSON}`, { status: 'rotated' });
    const res = await deliver([registered(PERSON, OWNER)]);
    expect(res.statusCode).toBe(200);
    expect(snapshot(`${PERSONS}/${PERSON}`).get('status')).toBe('rotated');
  });

  it('keeps going when one event blows up, and still answers 200', async () => {
    write(`${PERSONS}/${PERSON}`, { status: 'pending' });
    // ownerOf 가 터진다(되돌린 eth_call). 뒤에 오는 Registered 는 그대로 처리돼야 한다.
    readContract.mockRejectedValueOnce(new Error('RPC_DOWN'));

    const res = await deliver([checkedIn(7n), registered(PERSON, OWNER)]);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('ok:2');
    expect(send).not.toHaveBeenCalled();
    expect(snapshot(`${PERSONS}/${PERSON}`).get('status')).toBe('active');
  });
});
