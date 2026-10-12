import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Timestamp } from 'firebase-admin/firestore';
import { getAddress } from 'viem';
import { createFakeFirestore } from './helpers/fakeFirestore.js';

process.env.GCP_PROJECT_ID = 'monti-dev';

const ORGANIZERS = getAddress(`0x${'02'.repeat(20)}`);
const TICKET = getAddress(`0x${'ce'.repeat(20)}`);
const CALLER = getAddress(`0x${'99'.repeat(20)}`);
const PERSON_ID = `0x${'aa'.repeat(32)}`;
const EVENT_ID = 1001n;
const TOKEN_ID = (EVENT_ID << 96n) | 5n;
const GATE_ID = 3n;
const ORG_ID = 1001n;

/**
 * 체인 답. 요청 인가는 삭제된 `Ticket.requestOverride` 와 같은 기준을 eth_call 로 묻는다 —
 * 이 표를 갈아끼우는 것이 곧 "누구로, 어느 공연에 부르는가" 다.
 */
const chain = {
  orgId: ORG_ID as bigint,
  gateEventId: EVENT_ID as bigint,
  manager: [false, false] as readonly [boolean, boolean],
  canApproveOverride: false,
};

type ReadArgs = { functionName: string; args?: readonly unknown[] };
const readContract = vi.fn(async ({ functionName, args }: ReadArgs) => {
  if (functionName === 'eventOrg') return chain.orgId;
  if (functionName === 'gateInfo') return [chain.gateEventId, ORGANIZERS, '0x', '0x', true, false];
  if (functionName === 'managerOf') return chain.manager;
  if (functionName === 'hasPermission') {
    if (args?.[2] !== 4) throw new Error(`unexpected permission bit ${String(args?.[2])}`);
    return chain.canApproveOverride;
  }
  throw new Error(`unexpected eth_call: ${functionName}`);
});

vi.mock('../src/lib/chain.js', () => ({
  publicClient: () => ({ readContract }),
  deployment: () => ({ organizers: ORGANIZERS, ticket: TICKET }),
}));

const fake = createFakeFirestore();
vi.mock('../src/lib/db.js', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/db.js')>('../src/lib/db.js');
  return { ...actual, db: fake.db };
});

const { OVERRIDE_REQUESTS } = await import('../src/lib/db.js');
const { approveOpenOverrideRequests } = await import('../src/lib/overrideRequests.js');
const { requestOverride, listOverrideRequests } = await import('../src/functions/overrideRequests.js');
const functionsTest = (await import('firebase-functions-test')).default();
const request = functionsTest.wrap(requestOverride);
const list = functionsTest.wrap(listOverrideRequests);

const staff = { uid: 'uid-1', token: { account: CALLER.toLowerCase(), personId: PERSON_ID } };
const payload = { eventId: EVENT_ID.toString(), tokenId: TOKEN_ID.toString(), gateId: GATE_ID.toString(), reason: 2 };

function call(data: Record<string, unknown> = payload, auth: unknown = staff) {
  return request({ data, auth } as never) as Promise<{ requestId: string }>;
}

type Row = { id: string; tokenId: string; gateId: string; reason: number; note?: string; requesterAccount: string; createdAt: number };
function listFor(data: Record<string, unknown> = { eventId: EVENT_ID.toString() }, auth: unknown = staff) {
  return list({ data, auth } as never) as Promise<{ requests: Row[] }>;
}

function seed(id: string, over: Record<string, unknown> = {}) {
  fake.write(`${OVERRIDE_REQUESTS}/${id}`, {
    eventId: EVENT_ID.toString(),
    tokenId: TOKEN_ID.toString(),
    gateId: GATE_ID.toString(),
    reason: 1,
    requesterAccount: CALLER,
    requesterPersonId: PERSON_ID,
    status: 'open',
    createdAt: Timestamp.fromMillis(1_000),
    expireAt: Timestamp.fromMillis(Date.now() + 60_000),
    ...over,
  });
}

beforeEach(() => {
  fake.docs.clear();
  readContract.mockClear();
  chain.orgId = ORG_ID;
  chain.gateEventId = EVENT_ID;
  chain.manager = [true, false];
  chain.canApproveOverride = false;
});

describe('requestOverride', () => {
  it('rejects an unauthenticated call', async () => {
    // `auth` 키를 아예 뺀다 — undefined 를 넣으면 firebase-functions-test 가 기본 인증을 채운다.
    await expect(request({ data: payload } as never)).rejects.toMatchObject({ code: 'unauthenticated' });
    expect(fake.docs.size).toBe(0);
  });

  it('UNKNOWN_EVENT when the event has no organizer on chain', async () => {
    chain.orgId = 0n;
    await expect(call()).rejects.toMatchObject({ details: { code: 'UNKNOWN_EVENT' } });
  });

  it('WRONG_EVENT when the token id does not belong to the event (tokenId >> 96)', async () => {
    const other = ((EVENT_ID + 1n) << 96n) | 5n;
    await expect(call({ ...payload, tokenId: other.toString() })).rejects.toMatchObject({
      details: { code: 'WRONG_EVENT' },
    });
  });

  it('GATE_MISMATCH when the gate is registered to another event', async () => {
    chain.gateEventId = EVENT_ID + 1n;
    await expect(call()).rejects.toMatchObject({ details: { code: 'GATE_MISMATCH' } });
  });

  it('NOT_ALLOWED when the caller is neither a manager nor an override approver', async () => {
    chain.manager = [false, false];
    chain.canApproveOverride = false;
    await expect(call()).rejects.toMatchObject({ code: 'permission-denied', details: { code: 'NOT_ALLOWED' } });
    expect(fake.docs.size).toBe(0);
  });

  it('accepts an approver who is not a manager (same rule the deleted contract function used)', async () => {
    chain.manager = [false, false];
    chain.canApproveOverride = true;
    await expect(call()).resolves.toMatchObject({ requestId: expect.any(String) });
  });

  it.each([0, 5, '2', 1.5])('rejects a reason outside 1..4 (%s)', async (reason) => {
    await expect(call({ ...payload, reason })).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('rejects a note longer than 140 characters', async () => {
    await expect(call({ ...payload, note: 'x'.repeat(141) })).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('writes the open request in the frozen shape (design §1.3) with a 24h expireAt', async () => {
    const before = Date.now();
    const { requestId } = await call({ ...payload, note: '  phone died  ' });
    const doc = fake.snapshot(`${OVERRIDE_REQUESTS}/${requestId}`);
    expect(doc.exists).toBe(true);
    expect(doc.data()).toMatchObject({
      eventId: EVENT_ID.toString(),
      tokenId: TOKEN_ID.toString(),
      gateId: GATE_ID.toString(),
      reason: 2,
      note: 'phone died',
      requesterAccount: CALLER,
      requesterPersonId: PERSON_ID,
      status: 'open',
    });
    expect(Object.keys(doc.data() ?? {}).sort()).toEqual([
      'createdAt', 'eventId', 'expireAt', 'gateId', 'note', 'reason', 'requesterAccount', 'requesterPersonId', 'status', 'tokenId',
    ]);
    const expireAt = (doc.get('expireAt') as Timestamp).toMillis();
    expect(expireAt).toBeGreaterThanOrEqual(before + 24 * 60 * 60 * 1000);
    expect(expireAt).toBeLessThanOrEqual(Date.now() + 24 * 60 * 60 * 1000);
  });

  it('omits note when none is given', async () => {
    const { requestId } = await call();
    expect(fake.snapshot(`${OVERRIDE_REQUESTS}/${requestId}`).get('note')).toBeUndefined();
  });

  it('returns the existing open request for the same ticket instead of stacking a second one', async () => {
    const first = await call();
    const second = await call({ ...payload, reason: 3 });
    expect(second.requestId).toBe(first.requestId);
    expect(fake.docs.size).toBe(1);
  });
});

describe('listOverrideRequests', () => {
  it('UNKNOWN_EVENT for an event with no organizer', async () => {
    chain.orgId = 0n;
    chain.canApproveOverride = true;
    await expect(listFor()).rejects.toMatchObject({ details: { code: 'UNKNOWN_EVENT' } });
  });

  it('is for approvers only — a plain manager (no canApprove) is refused', async () => {
    chain.manager = [true, false];
    chain.canApproveOverride = false;
    await expect(listFor()).rejects.toMatchObject({ code: 'permission-denied', details: { code: 'NOT_ALLOWED' } });
  });

  it('lets a canApprove manager list', async () => {
    chain.manager = [true, true];
    seed('r1');
    await expect(listFor()).resolves.toMatchObject({ requests: [{ id: 'r1' }] });
  });

  it('returns only open, unexpired requests of this event, newest first', async () => {
    chain.canApproveOverride = true;
    seed('old', { createdAt: Timestamp.fromMillis(1_000), note: 'n' });
    seed('new', { createdAt: Timestamp.fromMillis(2_000) });
    seed('done', { status: 'approved', createdAt: Timestamp.fromMillis(3_000) });
    seed('other', { eventId: '9999', createdAt: Timestamp.fromMillis(4_000) });
    seed('stale', { createdAt: Timestamp.fromMillis(5_000), expireAt: Timestamp.fromMillis(Date.now() - 1) });

    const { requests } = await listFor();
    expect(requests.map((r) => r.id)).toEqual(['new', 'old']);
    expect(requests[1]).toEqual({
      id: 'old',
      tokenId: TOKEN_ID.toString(),
      gateId: GATE_ID.toString(),
      reason: 1,
      note: 'n',
      requesterAccount: CALLER,
      createdAt: 1_000,
    });
    expect(requests[0]).not.toHaveProperty('note');
  });

  it('caps the list at 50', async () => {
    chain.canApproveOverride = true;
    for (let i = 0; i < 55; i += 1) seed(`r${i}`, { createdAt: Timestamp.fromMillis(1_000 + i) });
    const { requests } = await listFor();
    expect(requests).toHaveLength(50);
    expect(requests[0]!.id).toBe('r54');
  });
});

describe('approveOpenOverrideRequests', () => {
  it('marks every open request for the token approved with the approver and tx hash', async () => {
    seed('a');
    seed('b', { gateId: '4' });
    seed('closed', { status: 'approved', approvedBy: '0xold' });
    seed('otherToken', { tokenId: (TOKEN_ID + 1n).toString() });

    const txHash = `0x${'ab'.repeat(32)}`;
    expect(await approveOpenOverrideRequests(TOKEN_ID, CALLER, txHash)).toBe(2);

    for (const id of ['a', 'b']) {
      const doc = fake.snapshot(`${OVERRIDE_REQUESTS}/${id}`);
      expect(doc.get('status')).toBe('approved');
      expect(doc.get('approvedBy')).toBe(CALLER);
      expect(doc.get('approvedTxHash')).toBe(txHash);
      expect(doc.get('approvedAt')).toBeInstanceOf(Timestamp);
    }
    expect(fake.snapshot(`${OVERRIDE_REQUESTS}/closed`).get('approvedBy')).toBe('0xold');
    expect(fake.snapshot(`${OVERRIDE_REQUESTS}/otherToken`).get('status')).toBe('open');
  });

  it('is a no-op when nothing is open', async () => {
    expect(await approveOpenOverrideRequests(TOKEN_ID, CALLER, `0x${'ab'.repeat(32)}`)).toBe(0);
  });
});
