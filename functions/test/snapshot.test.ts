import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpsError } from 'firebase-functions/v2/https';
import { getAddress, recoverAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { snapshotDigest, type UnsignedSnapshot } from '@monti/shared';

process.env.GCP_PROJECT_ID = 'monti-dev';

const PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const;
const attester = privateKeyToAccount(PK);
const OWNER = '0x9999999999999999999999999999999999999999';
const OWNER_B = '0x8888888888888888888888888888888888888888';
const OWNER_C = '0x7777777777777777777777777777777777777777';
/** 체크섬(대소문자 섞인) 주소. 인덱서 id 규약을 시험하는 자리다. */
const MIXED = getAddress('0xabcdefabcdefabcdefabcdefabcdefabcdefabcd');
const PERSON_ID = `0x${'aa'.repeat(32)}`;
const GATE = '0x1234123412341234123412341234123412341234';
const DEVICE_X = `0x${'11'.repeat(32)}`;
const DEVICE_Y = `0x${'22'.repeat(32)}`;

/** device.test.ts 와 같은 가짜 Firestore. 에뮬레이터 없이 `pnpm test` 안에서 돈다. */
const docs = new Map<string, Record<string, unknown>>();

function snapshotOf(path: string) {
  const data = docs.get(path);
  return {
    exists: data !== undefined,
    id: path.slice(path.indexOf('/') + 1),
    get: (name: string) =>
      name
        .split('.')
        .reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], data),
    data: () => data,
  };
}

const firestoreWrites = vi.fn();

vi.mock('../src/lib/db.js', () => ({
  PERSONS: 'persons',
  db: {
    collection: (name: string) => ({
      doc: (id: string) => ({
        path: `${name}/${id}`,
        get: async () => snapshotOf(`${name}/${id}`),
        set: async (data: unknown) => {
          firestoreWrites(`${name}/${id}`, data);
        },
      }),
    }),
  },
}));

/** eth_call 하나하나의 답. 테스트가 필요한 값만 바꿔 끼운다. */
const chain = {
  requireKyc: true,
  eventOf: 11n as bigint,
  imageCid: 'bafyDemo',
  /** 계정마다 다른 person id 를 주고 싶을 때 갈아끼운다. */
  personOf: (_account: string) => PERSON_ID,
};

type ReadArgs = { functionName: string; args?: readonly unknown[] };

async function defaultReadContract({ functionName, args }: ReadArgs) {
  if (functionName === 'activeDevice') return [DEVICE_X, DEVICE_Y];
  if (functionName === 'personOf') return chain.personOf(String(args?.[0] ?? ''));
  if (functionName === 'ownerOf') return OWNER;
  if (functionName === 'eventOf') return chain.eventOf;
  if (functionName === 'eventMeta') {
    return {
      orgId: 1n,
      endsAt: 4102444800n,
      requireKyc: chain.requireKyc,
      imageCid: chain.imageCid,
    };
  }
  if (functionName === 'tiers') {
    return [
      { name: '일반', seated: false },
      { name: 'VIP', seated: true },
    ];
  }
  return 0n;
}

const readContract = vi.fn(defaultReadContract);

vi.mock('../src/lib/chain.js', () => ({
  publicClient: () => ({ readContract }),
  deployment: () => ({
    identity: '0x1111111111111111111111111111111111111111',
    organizers: '0x2222222222222222222222222222222222222222',
    ticket: '0x3333333333333333333333333333333333333333',
  }),
}));

const requireStaffForGate = vi.fn(async (eventId: bigint, _caller: string, _gate: string) => {
  // 게이트는 11번 공연의 것이다. 다른 공연의 토큰으로 들어오면 체인이 거부하는 그 자리다.
  if (eventId !== 11n) throw new HttpsError('permission-denied', 'GATE_WRONG_EVENT');
});
const resolveCallerAccount = vi.fn(async () => OWNER);
vi.mock('../src/lib/auth.js', () => ({ resolveCallerAccount, requireStaffForGate }));

const decryptField = vi.fn(async (envelope: string, aad?: string) => `plain:${envelope}:${aad}`);
vi.mock('../src/lib/kms.js', () => ({
  decryptField,
  piiAad: (personId: string, field: string) => `${personId}:${field}`,
}));

vi.mock('../src/lib/attester.js', () => ({ getAttesterAccount: () => attester }));

const envioQuery = vi.fn(async (_query: string, _variables?: Record<string, unknown>) => ({}) as never);
vi.mock('../src/lib/envio.js', () => ({ envioQuery, envioPage: vi.fn(async () => []) }));

const logInfo = vi.fn();
const logWarn = vi.fn();
vi.mock('firebase-functions/logger', () => ({ info: logInfo, warn: logWarn, error: vi.fn() }));

interface TicketRow {
  id: string;
  tier: number;
  owner: string;
  checkIn: { id: string } | null;
}

const ticketRow: TicketRow = {
  id: '7',
  tier: 0,
  owner: OWNER.toLowerCase(),
  checkIn: null,
};

/**
 * 티켓 목록은 쪽 단위로, 닉네임은 물어본 계정 그대로 돌려준다.
 * 두 질의를 이름으로 갈라 답한다.
 */
function envioAnswers(pages: TicketRow[][] = [[ticketRow]], nickname: string | null = 'alex') {
  let page = 0;
  return async (query: string, variables?: Record<string, unknown>) => {
    if (query.includes('IdentityAccount')) {
      const accounts = (variables?.accounts as string[] | undefined) ?? [];
      return { rows: accounts.map((id) => ({ id, nickname })) };
    }
    return { rows: pages[page++] ?? [] };
  };
}

function rowsOf(count: number, owner = OWNER.toLowerCase()): TicketRow[] {
  return Array.from({ length: count }, (_, i) => ({ ...ticketRow, id: String(i + 1), owner }));
}

function envioCalls(marker: string) {
  return envioQuery.mock.calls.filter(([query]) => query.includes(marker));
}

function auditRecord() {
  const record = logInfo.mock.calls.find(([event]) => event === 'pii.access');
  expect(record).toBeDefined();
  return record![1] as Record<string, unknown>;
}

const snapshotModule = await import('../src/functions/snapshot.js');
const {
  issueSnapshot,
  getPhotoForGate,
  eventTitleOf,
  SNAPSHOT_MAX_TICKETS,
  SNAPSHOT_MAX_PHOTO_BYTES,
  SNAPSHOT_MAX_BYTES,
} = snapshotModule;
const functionsTest = (await import('firebase-functions-test')).default();
const issue = functionsTest.wrap(issueSnapshot);
const photo = functionsTest.wrap(getPhotoForGate);
const auth = { uid: 'uid-1', token: { account: OWNER } };

type Snapshot = UnsignedSnapshot & { attesterSig: `0x${string}` };

function callIssue(data: Record<string, unknown> = { eventId: '11', gateAccount: GATE }) {
  return issue({ data, auth } as never) as Promise<Snapshot>;
}

function callPhoto(data: Record<string, unknown> = { tokenId: '7', gateAccount: GATE }) {
  return photo({ data, auth } as never) as Promise<{ photoJpegB64: string; displayName: string }>;
}

// IPFS 메타데이터는 네트워크를 타지 않게 가짜로 돌려준다.
const fetchMock = vi.fn(
  async () => new Response(JSON.stringify({ name: '몬티 데모 공연' }), { status: 200 }),
);
vi.stubGlobal('fetch', fetchMock);

beforeEach(() => {
  docs.clear();
  chain.requireKyc = true;
  chain.eventOf = 11n;
  chain.imageCid = 'bafyDemo';
  chain.personOf = () => PERSON_ID;
  ticketRow.checkIn = null;
  requireStaffForGate.mockClear();
  resolveCallerAccount.mockClear();
  decryptField.mockClear();
  decryptField.mockImplementation(async (envelope: string, aad?: string) => `plain:${envelope}:${aad}`);
  readContract.mockClear();
  readContract.mockImplementation(defaultReadContract);
  firestoreWrites.mockClear();
  logInfo.mockClear();
  logWarn.mockClear();
  fetchMock.mockClear();
  envioQuery.mockClear();
  envioQuery.mockImplementation(envioAnswers() as never);
  docs.set(`persons/${PERSON_ID}`, {
    status: 'active',
    account: OWNER,
    enc: { name: 'ENCNAME', docNumber: 'ENCDOC' },
    photoEnc: 'ENCPHOTO',
  });
});

describe('issueSnapshot', () => {
  it('builds a signed snapshot whose signature recovers to the attester', async () => {
    const snapshot = await callIssue();
    expect(requireStaffForGate).toHaveBeenCalledWith(11n, OWNER, GATE);
    expect(snapshot.v).toBe(1);
    expect(snapshot.eventId).toBe('11');
    expect(snapshot.eventTitle).toBe('몬티 데모 공연');
    expect(snapshot.requireKyc).toBe(true);
    expect(snapshot.tickets).toHaveLength(1);
    expect(snapshot.tickets[0]).toMatchObject({
      tokenId: '7',
      account: OWNER,
      deviceX: DEVICE_X,
      deviceY: DEVICE_Y,
      photoJpegB64: `plain:ENCPHOTO:${PERSON_ID}:photo`,
      displayName: 'alex',
      tier: 0,
      tierName: '일반',
      seat: '',
      checkedIn: false,
    });
    expect(snapshot.expiresAt).toBeGreaterThan(snapshot.epoch);

    const { attesterSig, ...unsigned } = snapshot;
    expect(await recoverAddress({ hash: snapshotDigest(unsigned), signature: attesterSig })).toBe(
      attester.address,
    );
  });

  it('never carries the encrypted real name or any other person field', async () => {
    const snapshot = await callIssue();
    const body = JSON.stringify(snapshot);
    expect(body).not.toContain('ENCNAME');
    expect(body).not.toContain('ENCDOC');
    // 실명 봉투는 복호화조차 하지 않는다. 사진 하나만 연다.
    expect(decryptField).toHaveBeenCalledTimes(1);
    expect(decryptField).toHaveBeenCalledWith('ENCPHOTO', `${PERSON_ID}:photo`);
  });

  it('asks Hasura for the ticket page with a numeric! eventId variable', async () => {
    await callIssue();
    const ticketCall = envioCalls('Ticket(')[0];
    expect(ticketCall).toBeDefined();
    expect(ticketCall![0]).toContain('$eventId: numeric!');
    expect(ticketCall![0]).not.toContain('$eventId: String!');
    expect(ticketCall![1]).toMatchObject({ eventId: '11' });
  });

  it('selects only the ticket fields it reads', async () => {
    await callIssue();
    // eventId·revoked 는 서버 쪽 필터일 뿐이라 골라 받지 않는다.
    const selection = envioCalls('Ticket(')[0]![0];
    expect(selection).toContain('{ id tier owner checkIn { id } }');
  });

  it('normalises the eventId so the signed wire and the authorisation agree', async () => {
    const snapshot = await callIssue({ eventId: '011', gateAccount: GATE });
    expect(snapshot.eventId).toBe('11');
    expect(requireStaffForGate).toHaveBeenCalledWith(11n, OWNER, GATE);
    expect(envioCalls('Ticket(')[0]![1]).toMatchObject({ eventId: '11' });
    expect(auditRecord()).toMatchObject({ eventId: '11' });
  });

  it('leaves photos empty and skips KMS entirely for a requireKyc=false event', async () => {
    chain.requireKyc = false;
    const snapshot = await callIssue();
    expect(snapshot.requireKyc).toBe(false);
    expect(snapshot.tickets[0]).toMatchObject({ photoJpegB64: '', displayName: 'alex' });
    expect(decryptField).not.toHaveBeenCalled();
  });

  it('writes an audit record with ids only and no personal data', async () => {
    await callIssue();
    const record = auditRecord();
    expect(record).toMatchObject({
      fn: 'issueSnapshot',
      eventId: '11',
      gateAccount: GATE,
      caller: OWNER,
      tickets: 1,
      photos: 1,
      outcome: 'ok',
    });
    expect(record).not.toHaveProperty('errorCode');
    expect(JSON.stringify(record)).not.toContain('ENCPHOTO');
    expect(JSON.stringify(record)).not.toContain('alex');
  });

  it('writes the audit record even when the call fails, with outcome error', async () => {
    requireStaffForGate.mockRejectedValueOnce(
      new HttpsError('permission-denied', 'NOT_EVENT_STAFF'),
    );
    await expect(callIssue()).rejects.toThrow('NOT_EVENT_STAFF');
    expect(auditRecord()).toMatchObject({
      fn: 'issueSnapshot',
      eventId: '11',
      caller: OWNER,
      outcome: 'error',
      errorCode: 'NOT_EVENT_STAFF',
    });
  });

  it('records the photos it already decrypted when a later step throws', async () => {
    // 첫 티켓의 사진은 풀렸고 두 번째 티켓에서 체인이 터진다 — 그 한 장도 감사에 남아야 한다.
    envioQuery.mockImplementation(
      envioAnswers([[{ ...ticketRow, id: '7' }, { ...ticketRow, id: '8', owner: OWNER_B }]]) as never,
    );
    readContract.mockImplementation(async (call: ReadArgs) => {
      if (call.functionName === 'activeDevice' && String(call.args?.[0]).toLowerCase() === OWNER_B) {
        throw new Error('rpc down');
      }
      return defaultReadContract(call);
    });
    await expect(callIssue()).rejects.toThrow('rpc down');
    // 첫 티켓의 사진 한 장은 이미 풀렸다. 그 한 건이 기록에 남는 것이 이 수정의 핵심이다.
    expect(auditRecord()).toMatchObject({
      outcome: 'error',
      errorCode: 'INTERNAL',
      tickets: 1,
      photos: 1,
    });
  });

  it('never writes the decrypted photo back to Firestore', async () => {
    await callIssue();
    expect(firestoreWrites).not.toHaveBeenCalled();
  });

  it('refuses a caller who is not staff of that event', async () => {
    requireStaffForGate.mockRejectedValueOnce(
      new HttpsError('permission-denied', 'NOT_EVENT_STAFF'),
    );
    await expect(callIssue()).rejects.toThrow('NOT_EVENT_STAFF');
    expect(decryptField).not.toHaveBeenCalled();
    expect(envioQuery).not.toHaveBeenCalled();
  });

  it('refuses a call without a usable eventId or gateAccount', async () => {
    await expect(callIssue({ gateAccount: GATE })).rejects.toThrow('BAD_EVENT_ID');
    await expect(callIssue({ eventId: '11' })).rejects.toThrow('BAD_GATE_ACCOUNT');
    expect(requireStaffForGate).not.toHaveBeenCalled();
  });

  it('reads every page of tickets so a big event is not silently truncated', async () => {
    envioQuery.mockImplementation(envioAnswers([rowsOf(SNAPSHOT_MAX_TICKETS), []]) as never);
    const snapshot = await callIssue();
    expect(snapshot.tickets).toHaveLength(SNAPSHOT_MAX_TICKETS);
    expect(snapshot.tickets[SNAPSHOT_MAX_TICKETS - 1]!.tokenId).toBe(String(SNAPSHOT_MAX_TICKETS));
    // 마지막 쪽이 꽉 찼으면 한 번 더 묻는다. 끝을 행 수로 판단하면 안 된다.
    expect(envioCalls('Ticket(')).toHaveLength(2);
  });

  it('asks for each nickname once across the whole event, not once per page', async () => {
    envioQuery.mockImplementation(envioAnswers([rowsOf(SNAPSHOT_MAX_TICKETS), []]) as never);
    await callIssue();
    const nicknameCalls = envioCalls('IdentityAccount');
    expect(nicknameCalls).toHaveLength(1);
    // 같은 주인이 500장을 들고 있어도 계정은 한 번만 묻는다.
    expect(nicknameCalls[0]![1]).toMatchObject({ accounts: [OWNER.toLowerCase()] });
  });

  it('leaves the display name empty when the account has no nickname', async () => {
    envioQuery.mockImplementation(envioAnswers([[ticketRow]], null) as never);
    const snapshot = await callIssue();
    expect(snapshot.tickets[0]!.displayName).toBe('');
  });

  it('matches a checksummed indexer id, because both sides are lowercased', async () => {
    // 인덱서가 id 를 체크섬 형태로 써도 조회가 빗나가면 안 된다(Task 36 은 소문자로 쓴다).
    envioQuery.mockImplementation((async (query: string) => {
      if (query.includes('IdentityAccount')) return { rows: [{ id: MIXED, nickname: 'alex' }] };
      return { rows: [{ ...ticketRow, owner: MIXED }] };
    }) as never);
    const snapshot = await callIssue();
    expect(snapshot.tickets[0]!.account).toBe(MIXED);
    expect(snapshot.tickets[0]!.displayName).toBe('alex');
    // 물어볼 때도 소문자로 보낸다.
    expect(envioCalls('IdentityAccount')[0]![1]).toMatchObject({ accounts: [MIXED.toLowerCase()] });
  });

  describe('a person document that is missing', () => {
    const three = [
      { ...ticketRow, id: '7', owner: OWNER.toLowerCase() },
      { ...ticketRow, id: '8', owner: OWNER_B },
      { ...ticketRow, id: '9', owner: OWNER_C },
    ];

    beforeEach(() => {
      // 계정마다 다른 person id. 가운데 티켓의 주인만 사람 문서가 없다.
      chain.personOf = (account) => `person-${account.toLowerCase()}`;
      docs.set(`persons/person-${OWNER.toLowerCase()}`, { photoEnc: 'ENC_A' });
      docs.set(`persons/person-${OWNER_C}`, { photoEnc: 'ENC_C' });
      envioQuery.mockImplementation(envioAnswers([three]) as never);
    });

    it('degrades only that ticket instead of failing the whole snapshot', async () => {
      const snapshot = await callIssue();
      expect(snapshot.tickets).toHaveLength(3);
      expect(snapshot.tickets.map((ticket) => ticket.photoJpegB64)).toEqual([
        `plain:ENC_A:person-${OWNER.toLowerCase()}:photo`,
        '',
        `plain:ENC_C:person-${OWNER_C}:photo`,
      ]);
      // 닉네임은 있으면 그대로 싣는다 — 스태프가 대조할 것이 아예 없어지면 안 된다.
      expect(snapshot.tickets[1]).toMatchObject({ tokenId: '8', displayName: 'alex' });

      const warns = logWarn.mock.calls.filter(([event]) => event === 'snapshot.person_missing');
      expect(warns).toHaveLength(1);
      expect(warns[0]![1]).toMatchObject({ tokenId: '8' });
      expect(auditRecord()).toMatchObject({ tickets: 3, photos: 2, degraded: 1, outcome: 'ok' });
    });

    it('still fails loudly when every ticket is missing its person', async () => {
      docs.clear();
      await expect(callIssue()).rejects.toThrow('PERSON_NOT_FOUND');
      expect(auditRecord()).toMatchObject({ outcome: 'error', errorCode: 'PERSON_NOT_FOUND' });
    });
  });

  describe('bounds', () => {
    it('publishes the caps it enforces', () => {
      expect(SNAPSHOT_MAX_TICKETS).toBe(500);
      expect(SNAPSHOT_MAX_PHOTO_BYTES).toBe(32 * 1024);
      expect(SNAPSHOT_MAX_BYTES).toBe(8 * 1024 * 1024);
    });

    it('refuses an event with more tickets than one snapshot can carry', async () => {
      envioQuery.mockImplementation(
        envioAnswers([rowsOf(SNAPSHOT_MAX_TICKETS), [{ ...ticketRow, id: '501' }]]) as never,
      );
      await expect(callIssue()).rejects.toThrow('SNAPSHOT_TOO_LARGE');
      expect(auditRecord()).toMatchObject({ outcome: 'error', errorCode: 'SNAPSHOT_TOO_LARGE' });
    });

    it('skips a photo that is over the per-photo cap and keeps the ticket', async () => {
      decryptField.mockImplementation(async () => 'x'.repeat(SNAPSHOT_MAX_PHOTO_BYTES + 1));
      const snapshot = await callIssue();
      expect(snapshot.tickets).toHaveLength(1);
      expect(snapshot.tickets[0]).toMatchObject({ photoJpegB64: '', displayName: 'alex' });
      const warns = logWarn.mock.calls.filter(([event]) => event === 'snapshot.photo_too_large');
      expect(warns).toHaveLength(1);
      expect(warns[0]![1]).toMatchObject({ tokenId: '7', bytes: SNAPSHOT_MAX_PHOTO_BYTES + 1 });
      expect(auditRecord()).toMatchObject({ photos: 0, outcome: 'ok' });
    });

    it('keeps a photo that is exactly at the cap', async () => {
      decryptField.mockImplementation(async () => 'x'.repeat(SNAPSHOT_MAX_PHOTO_BYTES));
      const snapshot = await callIssue();
      expect(snapshot.tickets[0]!.photoJpegB64).toHaveLength(SNAPSHOT_MAX_PHOTO_BYTES);
      expect(logWarn).not.toHaveBeenCalled();
    });

    it('refuses a snapshot whose serialized body would blow the response ceiling', async () => {
      // 300장 × 32 KB ≈ 9.8 MB. 티켓 수는 상한 안이지만 몸집이 넘친다.
      envioQuery.mockImplementation(envioAnswers([rowsOf(300), []]) as never);
      decryptField.mockImplementation(async () => 'x'.repeat(SNAPSHOT_MAX_PHOTO_BYTES));
      await expect(callIssue()).rejects.toThrow('SNAPSHOT_TOO_LARGE');
      expect(auditRecord()).toMatchObject({
        outcome: 'error',
        errorCode: 'SNAPSHOT_TOO_LARGE',
        tickets: 300,
      });
    });
  });
});

describe('eventTitleOf', () => {
  it('warns and returns an empty title when the gateway answers non-200', async () => {
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 503 }));
    expect(await eventTitleOf('bafyDown')).toBe('');
    expect(logWarn).toHaveBeenCalledWith('ipfs.title_miss', { imageCid: 'bafyDown', status: 503 });
  });

  it('warns and returns an empty title when the gateway times out', async () => {
    fetchMock.mockRejectedValueOnce(new Error('The operation was aborted due to timeout'));
    expect(await eventTitleOf('bafyTimeout')).toBe('');
    expect(logWarn).toHaveBeenCalledWith('ipfs.title_miss', { imageCid: 'bafyTimeout', status: 0 });
  });

  it('warns and returns an empty title when the metadata is not JSON', async () => {
    fetchMock.mockResolvedValueOnce(new Response('<html>429</html>', { status: 200 }));
    expect(await eventTitleOf('bafyJunk')).toBe('');
    expect(logWarn).toHaveBeenCalledWith('ipfs.title_miss', { imageCid: 'bafyJunk', status: 200 });
  });

  it('does not cache a failure, so the next call tries the gateway again', async () => {
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 500 }));
    expect(await eventTitleOf('bafyRetry')).toBe('');
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ name: '두 번째 시도' }), { status: 200 }),
    );
    expect(await eventTitleOf('bafyRetry')).toBe('두 번째 시도');
  });
});

describe('getPhotoForGate', () => {
  it('returns the decrypted photo and display name for one ticket', async () => {
    const result = await callPhoto();
    expect(result).toEqual({
      photoJpegB64: `plain:ENCPHOTO:${PERSON_ID}:photo`,
      displayName: 'alex',
    });
    expect(requireStaffForGate).toHaveBeenCalledWith(11n, OWNER, GATE);
  });

  it('returns an empty photo for a requireKyc=false event so staff draw a placeholder', async () => {
    chain.requireKyc = false;
    expect(await callPhoto()).toEqual({ photoJpegB64: '', displayName: 'alex' });
    expect(decryptField).not.toHaveBeenCalled();
  });

  it('refuses a token that belongs to another event than the gate', async () => {
    chain.eventOf = 99n;
    await expect(callPhoto()).rejects.toThrow('GATE_WRONG_EVENT');
    expect(decryptField).not.toHaveBeenCalled();
    expect(auditRecord()).toMatchObject({
      fn: 'getPhotoForGate',
      eventId: '99',
      tokenId: '7',
      outcome: 'error',
      errorCode: 'GATE_WRONG_EVENT',
    });
  });

  it('still fails loudly for one ticket whose person document is missing', async () => {
    docs.clear();
    await expect(callPhoto()).rejects.toThrow('PERSON_NOT_FOUND');
    expect(auditRecord()).toMatchObject({ outcome: 'error', errorCode: 'PERSON_NOT_FOUND' });
  });

  it('refuses a call without a gateAccount', async () => {
    await expect(callPhoto({ tokenId: '7' })).rejects.toThrow('BAD_GATE_ACCOUNT');
    expect(logInfo).not.toHaveBeenCalled();
  });

  it('writes an audit record with ids only', async () => {
    await callPhoto();
    expect(auditRecord()).toMatchObject({
      fn: 'getPhotoForGate',
      eventId: '11',
      tokenId: '7',
      gateAccount: GATE,
      caller: OWNER,
      photos: 1,
      outcome: 'ok',
    });
  });
});
