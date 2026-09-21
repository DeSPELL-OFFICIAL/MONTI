import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { decodeFunctionData } from 'viem';
import { organizersAbi } from '@monti/shared';

process.env.GCP_PROJECT_ID = 'monti-dev';
process.env.PHONE_INDEX_KEY = 'monti-test-key';
// `defineString` 은 선언된 default 를 런타임에 쓰지 않는다(`process.env[name] || ''`, config.test.ts 참고).
process.env.RP_ID = 'monti.despell.io';

const KEY = 'monti-test-key';
const ORGANIZERS = '0x2222222222222222222222222222222222222222';
/** 오너. 숫자만 쓰는 주소라 EIP-55 체크섬이 대소문자를 바꾸지 않는다. */
const OWNER = '0x9999999999999999999999999999999999999999';
/** PERM_MANAGE_MANAGERS(8) 만 가진 관리자. */
const MANAGER_ADMIN = '0x8888888888888888888888888888888888888888';
/** 아무 권한도 없는 사람. */
const OUTSIDER = '0x7777777777777777777777777777777777777777';
/** 초대를 받는 사람. */
const INVITEE = '0x6666666666666666666666666666666666666666';
const PHONE = '+821011112222';
const OTHER_PHONE = '+821033334444';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * `invites` / `users` 두 컬렉션과 트랜잭션만 흉내 내는 가짜 Firestore.
 * 에뮬레이터 없이 `pnpm test` 안에서 돈다(startSignup.test.ts 와 같은 패턴).
 */
const docs = new Map<string, Record<string, unknown>>();
/** 트랜잭션 밖에서 일어난 쓰기 횟수. 초대 경로는 0이어야 한다. */
let directWrites = 0;

const SERVER_TIMESTAMP = FieldValue.serverTimestamp();

function isServerTimestamp(value: unknown): boolean {
  const candidate = value as FieldValue | undefined;
  return typeof candidate?.isEqual === 'function' && candidate.isEqual(SERVER_TIMESTAMP);
}

function write(path: string, data: Record<string, unknown>, options?: { merge?: boolean }): void {
  const previous = options?.merge ? (docs.get(path) ?? {}) : {};
  const resolved = Object.fromEntries(
    Object.entries(data).map(([k, v]) => [k, isServerTimestamp(v) ? Timestamp.now() : v]),
  );
  docs.set(path, { ...previous, ...resolved });
}

function snapshot(path: string) {
  const data = docs.get(path);
  return {
    exists: data !== undefined,
    id: path.slice(path.indexOf('/') + 1),
    get: (field: string) => data?.[field],
    data: () => data,
  };
}

function docRef(path: string) {
  return {
    path,
    id: path.slice(path.indexOf('/') + 1),
    get: async () => snapshot(path),
    set: async (data: Record<string, unknown>, options?: { merge?: boolean }) => {
      directWrites += 1;
      write(path, data, options);
    },
  };
}

vi.mock('../src/lib/db.js', () => ({
  PERSONS: 'persons',
  USERS: 'users',
  INVITES: 'invites',
  db: {
    collection: (name: string) => ({ doc: (id: string) => docRef(`${name}/${id}`) }),
    runTransaction: async <T>(body: (tx: unknown) => Promise<T>): Promise<T> => {
      const pending: Array<() => void> = [];
      let reading = true;
      const tx = {
        get: async (ref: { path: string }) => {
          // 실제 Firestore 는 쓰기 뒤의 읽기를 거부한다. 같은 규칙을 여기서도 강제한다.
          if (!reading) throw new Error('READ_AFTER_WRITE');
          return snapshot(ref.path);
        },
        set: (ref: { path: string }, data: Record<string, unknown>, options?: { merge?: boolean }) => {
          reading = false;
          pending.push(() => write(ref.path, data, options));
        },
      };
      const result = await body(tx);
      for (const apply of pending) apply();
      return result;
    },
  },
}));

/** 체인 상태. `hasPermission` 은 컨트랙트와 같이 오너에게 모든 비트를 준다. */
const chain = { owner: OWNER as string, bits: new Map<string, number>() };
const reads: Array<{ functionName: string; args: readonly unknown[] }> = [];

vi.mock('../src/lib/chain.js', () => ({
  deployment: () => ({ organizers: ORGANIZERS }),
  publicClient: () => ({
    readContract: async ({
      functionName,
      args,
    }: {
      functionName: string;
      args: readonly unknown[];
    }) => {
      reads.push({ functionName, args });
      if (functionName === 'ownerOf') return chain.owner;
      if (functionName === 'hasPermission') {
        const [, account, bit] = args as [bigint, string, number];
        if (account.toLowerCase() === chain.owner.toLowerCase()) return true;
        const held = chain.bits.get(account.toLowerCase()) ?? 0;
        return (held & bit) === bit && bit !== 0;
      }
      throw new Error(`UNEXPECTED_READ:${functionName}`);
    },
  }),
}));

const { INVITES, USERS } = await import('../src/lib/db.js');
const { hmacPhone } = await import('../src/lib/phoneIndex.js');
const { acceptInvite, createInvite, revokeInvite } = await import('../src/functions/invites.js');
const functionsTest = (await import('firebase-functions-test')).default();

const create = functionsTest.wrap(createInvite);
const accept = functionsTest.wrap(acceptInvite);
const revoke = functionsTest.wrap(revokeInvite);

/** 세션 클레임으로만 호출자를 묶는다 — 요청 본문의 주소는 어디에서도 읽지 않는다. */
const ownerAuth = { uid: 'uid-owner', token: { account: OWNER } };
const adminAuth = { uid: 'uid-admin', token: { account: MANAGER_ADMIN } };
const outsiderAuth = { uid: 'uid-outsider', token: { account: OUTSIDER } };
const inviteeAuth = { uid: 'uid-invitee', token: { account: INVITEE } };

function givenUser(uid: string, phoneE164: string | null): void {
  write(`${USERS}/${uid}`, phoneE164 ? { phoneHmac: hmacPhone(phoneE164, KEY) } : {});
  directWrites = 0;
}

async function createManagerInvite(canApprove = true): Promise<string> {
  const { inviteId } = (await create({
    data: { orgId: '1', role: 'manager', phoneE164: PHONE, canApprove },
    auth: ownerAuth,
  } as never)) as { inviteId: string };
  return inviteId;
}

beforeEach(() => {
  process.env.RP_ID = 'monti.despell.io';
  docs.clear();
  reads.length = 0;
  directWrites = 0;
  chain.owner = OWNER;
  chain.bits.clear();
  chain.bits.set(MANAGER_ADMIN.toLowerCase(), 8); // PERM_MANAGE_MANAGERS
  givenUser('uid-invitee', PHONE);
});

describe('createInvite', () => {
  it('stores a sent invite bound to the phone HMAC and returns a link carrying only the id', async () => {
    const result = (await create({
      data: { orgId: '1', role: 'manager', phoneE164: PHONE, canApprove: true },
      auth: ownerAuth,
    } as never)) as { inviteId: string; link: string };

    expect(result.inviteId).toMatch(UUID_RE);
    const invite = snapshot(`${INVITES}/${result.inviteId}`);
    expect(invite.get('status')).toBe('sent');
    expect(invite.get('role')).toBe('manager');
    expect(invite.get('canApprove')).toBe(true);
    expect(invite.get('orgId')).toBe('1');
    expect(invite.get('createdBy')).toBe(OWNER);
    expect((invite.get('expiresAt') as Timestamp).toMillis()).toBeGreaterThan(Date.now());
    expect(result.link).toContain(result.inviteId);
    expect(result.link).toBe(`https://monti.despell.io/org/invite/${result.inviteId}`);
  });

  it('never persists the phone number — only the HMAC startSignup also writes', async () => {
    const inviteId = await createManagerInvite();

    const invite = snapshot(`${INVITES}/${inviteId}`);
    expect(invite.get('phoneE164')).toBeUndefined();
    expect(invite.get('phoneHmac')).toBe(hmacPhone(PHONE, KEY));
    const everythingWritten = JSON.stringify([...docs.entries()]);
    expect(everythingWritten).not.toContain(PHONE);
    expect(everythingWritten).not.toContain('821011112222');
  });

  it('writes the invite inside a transaction', async () => {
    await createManagerInvite();
    expect(directWrites).toBe(0);
  });

  it('rejects an unknown role before it looks at anything else', async () => {
    await expect(
      create({ data: { orgId: '1', role: 'owner', phoneE164: '+8210' }, auth: ownerAuth } as never),
    ).rejects.toThrow('BAD_ROLE');
    expect(docs.has(`${INVITES}/x`)).toBe(false);
  });

  it('rejects a bad orgId and a bad phone number', async () => {
    await expect(
      create({ data: { orgId: '0x1', role: 'manager', phoneE164: PHONE }, auth: ownerAuth } as never),
    ).rejects.toThrow('BAD_ORG_ID');
    await expect(
      create({ data: { orgId: '1', role: 'manager', phoneE164: '01011112222' }, auth: ownerAuth } as never),
    ).rejects.toThrow('BAD_PHONE');
  });

  it('refuses an unauthenticated caller', async () => {
    await expect(
      create({ data: { orgId: '1', role: 'manager', phoneE164: PHONE } } as never),
    ).rejects.toThrow('AUTH_REQUIRED');
  });

  it('lets an admin holding PERM_MANAGE_MANAGERS invite a manager', async () => {
    const result = (await create({
      data: { orgId: '1', role: 'manager', phoneE164: PHONE },
      auth: adminAuth,
    } as never)) as { inviteId: string };
    expect(snapshot(`${INVITES}/${result.inviteId}`).get('createdBy')).toBe(MANAGER_ADMIN);
    expect(reads.at(-1)).toEqual({ functionName: 'hasPermission', args: [1n, MANAGER_ADMIN, 8] });
  });

  it('refuses a caller with no manage-managers permission', async () => {
    await expect(
      create({ data: { orgId: '1', role: 'manager', phoneE164: PHONE }, auth: outsiderAuth } as never),
    ).rejects.toThrow('NOT_ALLOWED_TO_INVITE');
    expect(docs.size).toBe(1); // users/uid-invitee 만 남는다
  });

  it('lets only the owner invite an admin, because Organizers.setAdmin is owner-only', async () => {
    const result = (await create({
      data: { orgId: '1', role: 'admin', phoneE164: PHONE, permissionBits: 6 },
      auth: ownerAuth,
    } as never)) as { inviteId: string };
    expect(snapshot(`${INVITES}/${result.inviteId}`).get('permissionBits')).toBe(6);

    await expect(
      create({
        data: { orgId: '1', role: 'admin', phoneE164: PHONE, permissionBits: 6 },
        auth: adminAuth,
      } as never),
    ).rejects.toThrow('NOT_ORG_OWNER');
  });

  it('rejects admin permission bits outside the contract declaration', async () => {
    for (const permissionBits of [undefined, 0, 32, 2.5]) {
      await expect(
        create({
          data: { orgId: '1', role: 'admin', phoneE164: PHONE, permissionBits },
          auth: ownerAuth,
        } as never),
      ).rejects.toThrow('BAD_PERMISSION_BITS');
    }
  });
});

describe('acceptInvite', () => {
  it('returns setManager calldata for the caller account and marks the invite accepted', async () => {
    const inviteId = await createManagerInvite(true);

    const result = (await accept({ data: { inviteId }, auth: inviteeAuth } as never)) as {
      to: string;
      data: `0x${string}`;
      orgId: string;
      role: string;
      requiredSender: string;
    };

    expect(result.to).toBe(ORGANIZERS);
    expect(result.orgId).toBe('1');
    expect(result.role).toBe('manager');
    // 이 calldata 를 보낼 수 있는 계정. 초대받은 사람이 자기 지갑으로 보내면 컨트랙트가 되돌린다.
    expect(result.requiredSender).toBe(OWNER);
    const decoded = decodeFunctionData({ abi: organizersAbi, data: result.data });
    expect(decoded.functionName).toBe('setManager');
    expect(decoded.args).toEqual([1n, INVITEE, true, true]);

    const invite = snapshot(`${INVITES}/${inviteId}`);
    expect(invite.get('status')).toBe('accepted');
    expect(invite.get('acceptedBy')).toBe(INVITEE);
    expect(invite.get('acceptedAt')).toBeDefined();
  });

  it('returns setAdmin calldata with the invited permission bits', async () => {
    const { inviteId } = (await create({
      data: { orgId: '7', role: 'admin', phoneE164: PHONE, permissionBits: 10 },
      auth: ownerAuth,
    } as never)) as { inviteId: string };

    const result = (await accept({ data: { inviteId }, auth: inviteeAuth } as never)) as {
      data: `0x${string}`;
      role: string;
    };
    const decoded = decodeFunctionData({ abi: organizersAbi, data: result.data });
    expect(decoded.functionName).toBe('setAdmin');
    expect(decoded.args).toEqual([7n, INVITEE, 10]);
    expect(result.role).toBe('admin');
  });

  it('never writes a role on chain — it only hands back calldata', async () => {
    const inviteId = await createManagerInvite();
    await accept({ data: { inviteId }, auth: inviteeAuth } as never);
    expect(reads.every((r) => r.functionName === 'ownerOf' || r.functionName === 'hasPermission')).toBe(true);
  });

  it('is idempotent: a repeat accept returns the same calldata and keeps the first acceptedAt', async () => {
    const inviteId = await createManagerInvite();
    const first = (await accept({ data: { inviteId }, auth: inviteeAuth } as never)) as { data: string };
    const acceptedAt = snapshot(`${INVITES}/${inviteId}`).get('acceptedAt');

    const second = (await accept({ data: { inviteId }, auth: inviteeAuth } as never)) as { data: string };
    expect(second.data).toBe(first.data);
    expect(snapshot(`${INVITES}/${inviteId}`).get('acceptedAt')).toBe(acceptedAt);
    expect(directWrites).toBe(0);
  });

  it('refuses a second account on an invite another account already accepted', async () => {
    const inviteId = await createManagerInvite();
    await accept({ data: { inviteId }, auth: inviteeAuth } as never);

    // 같은 번호로 계정을 새로 만든 사람. 초대는 이미 소진됐다.
    givenUser('uid-rotated', PHONE);
    await expect(
      accept({
        data: { inviteId },
        auth: { uid: 'uid-rotated', token: { account: OUTSIDER } },
      } as never),
    ).rejects.toThrow('INVITE_ALREADY_USED');
  });

  it('refuses an expired invite', async () => {
    const inviteId = await createManagerInvite();
    const stored = docs.get(`${INVITES}/${inviteId}`) as Record<string, unknown>;
    stored.expiresAt = Timestamp.fromMillis(Date.now() - 1);

    await expect(accept({ data: { inviteId }, auth: inviteeAuth } as never)).rejects.toThrow(
      'INVITE_EXPIRED',
    );
    expect(snapshot(`${INVITES}/${inviteId}`).get('status')).toBe('sent');
  });

  it('refuses an invite addressed to another phone number', async () => {
    const inviteId = await createManagerInvite();
    givenUser('uid-other', OTHER_PHONE);

    await expect(
      accept({ data: { inviteId }, auth: { uid: 'uid-other', token: { account: OUTSIDER } } } as never),
    ).rejects.toThrow('INVITE_NOT_FOR_YOU');
    expect(snapshot(`${INVITES}/${inviteId}`).get('status')).toBe('sent');
  });

  it('refuses a caller whose user doc has no phone index', async () => {
    const inviteId = await createManagerInvite();
    givenUser('uid-nophone', null);

    await expect(
      accept({ data: { inviteId }, auth: { uid: 'uid-nophone', token: { account: OUTSIDER } } } as never),
    ).rejects.toThrow('PHONE_INDEX_MISSING');
  });

  it('refuses an unknown invite, a malformed id and an unauthenticated caller', async () => {
    await expect(
      accept({ data: { inviteId: '11111111-2222-3333-4444-555555555555' }, auth: inviteeAuth } as never),
    ).rejects.toThrow('INVITE_NOT_FOUND');
    await expect(accept({ data: { inviteId: '../users/uid-1' }, auth: inviteeAuth } as never)).rejects.toThrow(
      'BAD_INVITE_ID',
    );
    await expect(accept({ data: {}, auth: inviteeAuth } as never)).rejects.toThrow('BAD_INVITE_ID');
    await expect(accept({ data: { inviteId: 'x' } } as never)).rejects.toThrow('AUTH_REQUIRED');
  });

  it('refuses an invite whose stored role is not one the contract knows', async () => {
    const inviteId = await createManagerInvite();
    (docs.get(`${INVITES}/${inviteId}`) as Record<string, unknown>).role = 'owner';

    await expect(accept({ data: { inviteId }, auth: inviteeAuth } as never)).rejects.toThrow('BAD_ROLE');
  });

  it('names the current org owner as the required sender, even for an invite an admin created', async () => {
    const { inviteId } = (await create({
      data: { orgId: '1', role: 'manager', phoneE164: PHONE },
      auth: adminAuth,
    } as never)) as { inviteId: string };

    const result = (await accept({ data: { inviteId }, auth: inviteeAuth } as never)) as {
      requiredSender: string;
    };
    // 만든 사람(관리자)이 아니라 **지금의 오너**다. 오너가 바뀌면 답도 바뀐다.
    expect(result.requiredSender).toBe(OWNER);
    expect(reads.at(-1)).toEqual({ functionName: 'ownerOf', args: [1n] });

    chain.owner = OUTSIDER;
    const again = (await accept({ data: { inviteId }, auth: inviteeAuth } as never)) as {
      requiredSender: string;
    };
    expect(again.requiredSender).toBe(OUTSIDER);
  });

  it('leaks nothing about the org beyond this invite and who must send the calldata', async () => {
    const inviteId = await createManagerInvite();
    const result = (await accept({ data: { inviteId }, auth: inviteeAuth } as never)) as Record<
      string,
      unknown
    >;
    expect(Object.keys(result).sort()).toEqual(['data', 'orgId', 'requiredSender', 'role', 'to']);
    expect(JSON.stringify(result)).not.toContain(hmacPhone(PHONE, KEY));
    // 오너 주소는 `requiredSender` 로만 나간다 — 누가 초대를 만들었는지(`createdBy`)는 나가지 않는다.
    expect(result.createdBy).toBeUndefined();
  });
});

describe('revokeInvite', () => {
  it('revokes an invite the owner sent and answers the same way when called again', async () => {
    const inviteId = await createManagerInvite();

    const first = (await revoke({ data: { inviteId }, auth: ownerAuth } as never)) as { status: string };
    expect(first).toEqual({ status: 'revoked' });
    const invite = snapshot(`${INVITES}/${inviteId}`);
    expect(invite.get('status')).toBe('revoked');
    expect(invite.get('revokedBy')).toBe(OWNER);
    expect(invite.get('revokedAt')).toBeDefined();
    const revokedAt = invite.get('revokedAt');

    // 멱등: 두 번째 호출은 같은 답을 주고 첫 기록을 덮어쓰지 않는다.
    expect(await revoke({ data: { inviteId }, auth: ownerAuth } as never)).toEqual({ status: 'revoked' });
    expect(snapshot(`${INVITES}/${inviteId}`).get('revokedAt')).toBe(revokedAt);
  });

  it('revokes an invite that was already accepted — the role has not gone on chain yet', async () => {
    const inviteId = await createManagerInvite();
    await accept({ data: { inviteId }, auth: inviteeAuth } as never);
    expect(snapshot(`${INVITES}/${inviteId}`).get('status')).toBe('accepted');

    await revoke({ data: { inviteId }, auth: ownerAuth } as never);
    expect(snapshot(`${INVITES}/${inviteId}`).get('status')).toBe('revoked');
  });

  it('closes the invite for good — a revoked invite can no longer be accepted', async () => {
    const inviteId = await createManagerInvite();
    await revoke({ data: { inviteId }, auth: ownerAuth } as never);

    await expect(accept({ data: { inviteId }, auth: inviteeAuth } as never)).rejects.toThrow(
      'INVITE_NOT_OPEN',
    );
  });

  it('refuses everyone but the org owner, including the admin who may create invites', async () => {
    const inviteId = await createManagerInvite();

    for (const auth of [adminAuth, outsiderAuth, inviteeAuth]) {
      await expect(revoke({ data: { inviteId }, auth } as never)).rejects.toThrow('NOT_ORG_OWNER');
    }
    expect(snapshot(`${INVITES}/${inviteId}`).get('status')).toBe('sent');
  });

  it('rejects an unknown invite, a malformed id and an unauthenticated caller', async () => {
    await expect(
      revoke({ data: { inviteId: '11111111-2222-3333-4444-555555555555' }, auth: ownerAuth } as never),
    ).rejects.toThrow('INVITE_NOT_FOUND');
    await expect(revoke({ data: { inviteId: '../users/uid-1' }, auth: ownerAuth } as never)).rejects.toThrow(
      'BAD_INVITE_ID',
    );
    await expect(revoke({ data: {}, auth: ownerAuth } as never)).rejects.toThrow('BAD_INVITE_ID');
    await expect(revoke({ data: { inviteId: 'x' } } as never)).rejects.toThrow('AUTH_REQUIRED');
  });
});
