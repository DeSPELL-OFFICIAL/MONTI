import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpsError } from 'firebase-functions/v2/https';
import { recoverAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { snapshotDigest, type UnsignedSnapshot } from '@monti/shared';

process.env.GCP_PROJECT_ID = 'monti-dev';

const PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const;
const attester = privateKeyToAccount(PK);
const OWNER = '0x9999999999999999999999999999999999999999';
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
};

const readContract = vi.fn(async ({ functionName }: { functionName: string }) => {
  if (functionName === 'activeDevice') return [DEVICE_X, DEVICE_Y];
  if (functionName === 'personOf') return PERSON_ID;
  if (functionName === 'ownerOf') return OWNER;
  if (functionName === 'eventOf') return chain.eventOf;
  if (functionName === 'eventMeta') {
    return { orgId: 1n, endsAt: 4102444800n, requireKyc: chain.requireKyc, imageCid: 'bafyDemo' };
  }
  if (functionName === 'tiers') {
    return [
      { name: '일반', seated: false },
      { name: 'VIP', seated: true },
    ];
  }
  return 0n;
});

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
vi.mock('firebase-functions/logger', () => ({ info: logInfo, warn: vi.fn(), error: vi.fn() }));

const ticketRow = {
  id: '7',
  eventId: '11',
  tier: 0,
  owner: OWNER.toLowerCase(),
  revoked: false,
  checkIn: null as { id: string } | null,
};

/** 티켓 목록 한 쪽, 닉네임 한 묶음. 두 질의를 이름으로 갈라 답한다. */
function envioAnswers(rows: typeof ticketRow[] = [ticketRow], nickname: string | null = 'alex') {
  return async (query: string) => {
    if (query.includes('IdentityAccount')) {
      return { rows: rows.map((row) => ({ id: row.owner, nickname })) };
    }
    return { rows };
  };
}

const { issueSnapshot, getPhotoForGate } = await import('../src/functions/snapshot.js');
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
  ticketRow.checkIn = null;
  requireStaffForGate.mockClear();
  resolveCallerAccount.mockClear();
  decryptField.mockClear();
  readContract.mockClear();
  firestoreWrites.mockClear();
  logInfo.mockClear();
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
    const ticketCall = envioQuery.mock.calls.find(([query]) => query.includes('Ticket('));
    expect(ticketCall).toBeDefined();
    expect(ticketCall![0]).toContain('$eventId: numeric!');
    expect(ticketCall![0]).not.toContain('$eventId: String!');
    expect(ticketCall![1]).toMatchObject({ eventId: '11' });
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
    const record = logInfo.mock.calls.find(([event]) => event === 'pii.access');
    expect(record).toBeDefined();
    expect(record![1]).toMatchObject({
      fn: 'issueSnapshot',
      eventId: '11',
      gateAccount: GATE,
      caller: OWNER,
      tickets: 1,
      photos: 1,
    });
    expect(JSON.stringify(record![1])).not.toContain('ENCPHOTO');
    expect(JSON.stringify(record![1])).not.toContain('alex');
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
    const page = Array.from({ length: 500 }, (_, i) => ({ ...ticketRow, id: String(i + 1) }));
    const rest = [{ ...ticketRow, id: '501' }];
    let call = 0;
    envioQuery.mockImplementation((async (query: string) => {
      if (query.includes('IdentityAccount')) return { rows: [{ id: OWNER.toLowerCase(), nickname: 'alex' }] };
      return { rows: call++ === 0 ? page : rest };
    }) as never);
    const snapshot = await callIssue();
    expect(snapshot.tickets).toHaveLength(501);
    expect(snapshot.tickets[500]!.tokenId).toBe('501');
  });

  it('leaves the display name empty when the account has no nickname', async () => {
    envioQuery.mockImplementation(envioAnswers([ticketRow], null) as never);
    const snapshot = await callIssue();
    expect(snapshot.tickets[0]!.displayName).toBe('');
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
  });

  it('refuses a call without a gateAccount', async () => {
    await expect(callPhoto({ tokenId: '7' })).rejects.toThrow('BAD_GATE_ACCOUNT');
  });

  it('writes an audit record with ids only', async () => {
    await callPhoto();
    const record = logInfo.mock.calls.find(([event]) => event === 'pii.access');
    expect(record![1]).toMatchObject({
      fn: 'getPhotoForGate',
      eventId: '11',
      tokenId: '7',
      gateAccount: GATE,
      caller: OWNER,
      photos: 1,
    });
  });
});
