import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CallableRequest } from 'firebase-functions/v2/https';

const UID = 'uid-abc';
const ACCOUNT = '0x9999999999999999999999999999999999999999';
const CHECKSUMMED = '0x1234567890AbcdEF1234567890aBcdef12345678';

/** `persons/{id}` / `users/{uid}` 두 컬렉션만 흉내 내는 가짜 Firestore. 에뮬레이터 없이 돈다. */
const docs = new Map<string, Record<string, unknown>>();

vi.mock('../src/lib/db.js', () => ({
  PERSONS: 'persons',
  USERS: 'users',
  db: {
    collection: (name: string) => ({
      doc: (id: string) => ({
        get: async () => {
          const data = docs.get(`${name}/${id}`);
          return { exists: data !== undefined, get: (field: string) => data?.[field] };
        },
      }),
    }),
  },
}));

const { PERM_APPROVE_OVERRIDE, PERM_MANAGE_GATES, resolveCallerAccount } = await import(
  '../src/lib/auth.js'
);

function callable(auth?: { uid: string; token?: Record<string, unknown> }): CallableRequest {
  return { data: {}, auth, rawRequest: {} } as unknown as CallableRequest;
}

beforeEach(() => {
  docs.clear();
});

describe('resolveCallerAccount', () => {
  it('rejects an unauthenticated call', async () => {
    await expect(resolveCallerAccount(callable())).rejects.toMatchObject({
      code: 'unauthenticated',
      message: 'AUTH_REQUIRED',
    });
  });

  it('takes the account claim loginVerify minted, without reading Firestore', async () => {
    const request = callable({ uid: UID, token: { account: ACCOUNT } });
    await expect(resolveCallerAccount(request)).resolves.toBe(ACCOUNT);
  });

  it('returns the claim EIP-55 checksummed', async () => {
    const request = callable({ uid: UID, token: { account: CHECKSUMMED.toLowerCase() } });
    await expect(resolveCallerAccount(request)).resolves.toBe(CHECKSUMMED);
  });

  it('falls back to users/{uid} → persons/{personId}.account when there is no claim', async () => {
    docs.set(`users/${UID}`, { personId: 'p1' });
    docs.set('persons/p1', { account: CHECKSUMMED.toLowerCase() });
    await expect(resolveCallerAccount(callable({ uid: UID }))).resolves.toBe(CHECKSUMMED);
  });

  it('ignores a claim that is not a 20-byte address and falls back to Firestore', async () => {
    docs.set(`users/${UID}`, { personId: 'p1' });
    docs.set('persons/p1', { account: ACCOUNT });
    const request = callable({ uid: UID, token: { account: '0xdeadbeef' } });
    await expect(resolveCallerAccount(request)).resolves.toBe(ACCOUNT);
  });

  it('rejects a signed-in user with no person document', async () => {
    await expect(resolveCallerAccount(callable({ uid: UID }))).rejects.toMatchObject({
      code: 'failed-precondition',
      message: 'NO_PERSON',
    });
  });

  it('rejects a person that has no on-chain account yet', async () => {
    docs.set(`users/${UID}`, { personId: 'p1' });
    docs.set('persons/p1', { status: 'pending' });
    await expect(resolveCallerAccount(callable({ uid: UID }))).rejects.toMatchObject({
      code: 'failed-precondition',
      message: 'NO_ACCOUNT',
    });
  });
});

describe('permission bits', () => {
  it('matches the Organizers contract bit layout', () => {
    expect(PERM_MANAGE_GATES).toBe(2);
    expect(PERM_APPROVE_OVERRIDE).toBe(4);
  });
});

/** 게이트 인가 매트릭스. 판정은 전부 eth_call 이라 체인 mock 하나로 모든 행을 만든다. */
const GATE = '0x00000000000000000000000000000000000000Ga'.toLowerCase() as `0x${string}`;
const STAFF = '0x9999999999999999999999999999999999999999';
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const TICKET = '0x3333333333333333333333333333333333333333';
const ORGANIZERS = '0x2222222222222222222222222222222222222222';

const chain = {
  owner: ZERO_ADDRESS as string,
  manager: [false, false] as readonly [boolean, boolean],
  manageGates: false,
  approveOverride: false,
  openGate: false,
  gateId: 3n,
  gateInfo: [11n, GATE, `0x${'11'.repeat(32)}`, `0x${'22'.repeat(32)}`, false, false] as readonly unknown[],
  /** 어느 컨트랙트에 물었는지까지 확인한다. Organizers 질문이 Ticket 으로 새면 안 된다. */
  calls: [] as Array<{ address: string; functionName: string }>,
};

vi.mock('../src/lib/chain.js', () => ({
  deployment: () => ({ ticket: TICKET, organizers: ORGANIZERS }),
  publicClient: () => ({
    readContract: async ({
      address,
      functionName,
      args,
    }: {
      address: string;
      functionName: string;
      args: readonly unknown[];
    }) => {
      chain.calls.push({ address, functionName });
      switch (functionName) {
        case 'eventOrg':
          return 1n;
        case 'ownerOf':
          return chain.owner;
        case 'managerOf':
          return chain.manager;
        case 'hasPermission':
          return args[2] === PERM_MANAGE_GATES ? chain.manageGates : chain.approveOverride;
        case 'isOpenGate':
          return chain.openGate;
        case 'gateOf':
          return chain.gateId;
        case 'gateInfo':
          return chain.gateInfo;
        default:
          throw new Error(`UNEXPECTED_READ:${functionName}`);
      }
    },
  }),
}));

const { requireStaffForGate } = await import('../src/lib/auth.js');

beforeEach(() => {
  chain.owner = ZERO_ADDRESS;
  chain.manager = [false, false];
  chain.manageGates = false;
  chain.approveOverride = false;
  chain.openGate = false;
  chain.gateId = 3n;
  chain.gateInfo = [11n, GATE, `0x${'11'.repeat(32)}`, `0x${'22'.repeat(32)}`, false, false];
  chain.calls = [];
});

describe('requireStaffForGate — condition (a): the caller is event staff', () => {
  it('accepts the organizer owner', async () => {
    chain.owner = STAFF.toUpperCase().replace('0X', '0x');
    chain.openGate = true;
    await expect(requireStaffForGate(11n, STAFF, GATE)).resolves.toBeUndefined();
  });

  it('accepts a manager', async () => {
    chain.manager = [true, false];
    chain.openGate = true;
    await expect(requireStaffForGate(11n, STAFF, GATE)).resolves.toBeUndefined();
  });

  it('accepts an admin with only PERM_MANAGE_GATES', async () => {
    chain.manageGates = true;
    chain.openGate = true;
    await expect(requireStaffForGate(11n, STAFF, GATE)).resolves.toBeUndefined();
  });

  it('accepts an admin with only PERM_APPROVE_OVERRIDE', async () => {
    chain.approveOverride = true;
    chain.openGate = true;
    await expect(requireStaffForGate(11n, STAFF, GATE)).resolves.toBeUndefined();
  });

  it('rejects a caller with neither role even when the gate is open', async () => {
    chain.openGate = true;
    await expect(requireStaffForGate(11n, STAFF, GATE)).rejects.toMatchObject({
      code: 'permission-denied',
      message: 'NOT_EVENT_STAFF',
    });
  });

  it('resolves the org from Ticket.eventOrg and asks Organizers about that org', async () => {
    chain.manager = [true, false];
    chain.openGate = true;
    await requireStaffForGate(11n, STAFF, GATE);
    expect(chain.calls[0]).toEqual({ address: TICKET, functionName: 'eventOrg' });
    for (const call of chain.calls.slice(1)) expect(call.address).toBe(ORGANIZERS);
  });
});

describe('requireStaffForGate — condition (b): the gate belongs to the event', () => {
  it('accepts a registered but not-yet-open gate (pre-event snapshot download)', async () => {
    chain.manager = [true, false];
    await expect(requireStaffForGate(11n, STAFF, GATE)).resolves.toBeUndefined();
  });

  it('rejects an unregistered gate account', async () => {
    chain.manager = [true, false];
    chain.gateId = 0n;
    await expect(requireStaffForGate(11n, STAFF, GATE)).rejects.toMatchObject({
      code: 'permission-denied',
      message: 'GATE_NOT_REGISTERED',
    });
  });

  it('rejects a revoked gate', async () => {
    chain.manager = [true, false];
    chain.gateInfo = [11n, GATE, `0x${'11'.repeat(32)}`, `0x${'22'.repeat(32)}`, false, true];
    await expect(requireStaffForGate(11n, STAFF, GATE)).rejects.toMatchObject({
      code: 'permission-denied',
      message: 'GATE_REVOKED',
    });
  });

  it('rejects a gate registered to another event', async () => {
    chain.manager = [true, false];
    chain.gateInfo = [12n, GATE, `0x${'11'.repeat(32)}`, `0x${'22'.repeat(32)}`, false, false];
    await expect(requireStaffForGate(11n, STAFF, GATE)).rejects.toMatchObject({
      code: 'permission-denied',
      message: 'GATE_WRONG_EVENT',
    });
  });

  it('never trusts our own database for a role', async () => {
    chain.manager = [true, false];
    chain.openGate = true;
    await requireStaffForGate(11n, STAFF, GATE);
    expect(docs.size).toBe(0);
  });
});
