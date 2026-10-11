import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getAddress } from 'viem';
import { recipientCommitment, type ResolveRecipientResult } from '@monti/shared';

process.env.GCP_PROJECT_ID = 'monti-dev';
process.env.PHONE_INDEX_KEY = 'monti-test-key';

const KEY = 'monti-test-key';
const IDENTITY = '0x1111111111111111111111111111111111111111';
/** 호출자. 숫자만 쓰는 주소라 EIP-55 체크섬이 대소문자를 바꾸지 않는다. */
const CALLER = '0x9999999999999999999999999999999999999999';
/** 받는 사람. 소문자로 저장·입력돼도 응답은 체크섬 형태라야 한다. */
const RECIPIENT_LOWER = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
const RECIPIENT = getAddress(RECIPIENT_LOWER);
const PERSON_ID = `0x${'aa'.repeat(32)}`;
const PHONE = '+821012345678';
const UNKNOWN_PHONE = '+821099998888';

/**
 * `persons` / `phoneIndex` 두 컬렉션만 흉내 내는 가짜 Firestore.
 * 에뮬레이터 없이 `pnpm test` 안에서 돈다(startSignup.test.ts 와 같은 패턴).
 */
const docs = new Map<string, Record<string, unknown>>();

function write(path: string, data: Record<string, unknown>): void {
  docs.set(path, data);
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

vi.mock('../src/lib/db.js', () => ({
  PERSONS: 'persons',
  USERS: 'users',
  PHONE_INDEX: 'phoneIndex',
  NICKNAMES: 'nicknames',
  db: {
    collection: (name: string) => ({
      doc: (id: string) => ({
        path: `${name}/${id}`,
        id,
        get: async () => snapshot(`${name}/${id}`),
      }),
    }),
  },
}));

/**
 * 체인 상태. 닉네임 함수는 일부러 없다 — v2 에서 닉네임은 Firestore 장부에만 있다(P5).
 * 구현이 체인에 닉네임을 물으면 테스트가 깨진다.
 */
const chain = { members: new Set<string>() };
const reads: Array<{ functionName: string; args: readonly unknown[] }> = [];

vi.mock('../src/lib/chain.js', () => ({
  deployment: () => ({ identity: IDENTITY }),
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
      if (address !== IDENTITY) throw new Error(`UNEXPECTED_CONTRACT:${address}`);
      reads.push({ functionName, args });
      if (functionName === 'isMember') {
        return chain.members.has((args[0] as string).toLowerCase());
      }
      throw new Error(`UNEXPECTED_READ:${functionName}`);
    },
  }),
}));

const { PERSONS, PHONE_INDEX } = await import('../src/lib/db.js');
const { hmacPhone, personIdByPhone } = await import('../src/lib/phoneIndex.js');
const { resolveRecipient } = await import('../src/functions/resolveRecipient.js');
const functionsTest = (await import('firebase-functions-test')).default();

const resolve = functionsTest.wrap(resolveRecipient);

/** 세션 클레임으로만 호출자를 묶는다 — 요청 본문의 주소는 어디에서도 읽지 않는다. */
const auth = { uid: 'uid-1', token: { account: CALLER } };

async function call(data: Record<string, unknown>): Promise<ResolveRecipientResult> {
  return await resolve({ data, auth } as never);
}

/** 메시지만이 아니라 HttpsError 의 코드까지 본다 — 클라이언트가 분기하는 값이다. */
async function expectRejection(
  promise: Promise<unknown>,
  code: string,
  message: string,
): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code, message });
}

beforeEach(() => {
  process.env.PHONE_INDEX_KEY = KEY;
  docs.clear();
  reads.length = 0;
  chain.members.clear();
  chain.members.add(RECIPIENT_LOWER);
  chain.members.add(CALLER.toLowerCase());
  // 받는 사람의 계정은 소문자로 저장돼 있다. 응답에서 체크섬으로 나와야 한다.
  write(`${PERSONS}/${PERSON_ID}`, { status: 'active', account: RECIPIENT_LOWER });
});

describe('hmacPhone', () => {
  it('matches the fixed HMAC-SHA256 vector', () => {
    expect(hmacPhone(PHONE, KEY)).toBe(
      'e3b01fa8547cd798cc330f31e3a1bad493a8d9f248d6bc34647c8e751966464e',
    );
  });

  it('rejects a non-E164 number', () => {
    expect(() => hmacPhone('010-1234-5678', KEY)).toThrow('BAD_PHONE');
  });
});

describe('personIdByPhone', () => {
  it('reads only the phoneIndex document named by the HMAC', async () => {
    write(`${PHONE_INDEX}/${hmacPhone(PHONE, KEY)}`, { personId: PERSON_ID });
    await expect(personIdByPhone(PHONE, KEY)).resolves.toBe(PERSON_ID);
    await expect(personIdByPhone(UNKNOWN_PHONE, KEY)).resolves.toBeUndefined();
  });
});

describe('resolveRecipient by phone', () => {
  it('finds a member and returns neither the number, the HMAC nor the personId', async () => {
    const id = hmacPhone(PHONE, KEY);
    write(`${PHONE_INDEX}/${id}`, { personId: PERSON_ID });

    const result = await call({ type: 'phone', value: PHONE });

    expect(result.member).toBe(true);
    expect(result.account).toBe(RECIPIENT);
    expect(result.commitment).toBe(recipientCommitment(id));
    const json = JSON.stringify(result);
    expect(json).not.toContain('821012345678');
    expect(json).not.toContain(id);
    expect(json).not.toContain(PERSON_ID);
  });

  it('returns a commitment for an unregistered number so an invite can be created', async () => {
    const result = await call({ type: 'phone', value: UNKNOWN_PHONE });

    expect(result.member).toBe(false);
    expect(result.account).toBeUndefined();
    expect(result.commitment).toBe(recipientCommitment(hmacPhone(UNKNOWN_PHONE, KEY)));
    expect(JSON.stringify(result)).not.toContain('821099998888');
  });

  it('treats a person without an account as an invite, not as a member', async () => {
    write(`${PERSONS}/${PERSON_ID}`, { status: 'pending' });
    write(`${PHONE_INDEX}/${hmacPhone(PHONE, KEY)}`, { personId: PERSON_ID });

    const result = await call({ type: 'phone', value: PHONE });

    expect(result.member).toBe(false);
    expect(result.commitment).toBe(recipientCommitment(hmacPhone(PHONE, KEY)));
  });

  it('rejects a number that is not E.164 before touching the index', async () => {
    await expect(call({ type: 'phone', value: '010-1234-5678' })).rejects.toThrow('BAD_PHONE');
    await expect(call({ type: 'phone', value: '821012345678' })).rejects.toThrow('BAD_PHONE');
    await expect(call({ type: 'phone', value: '+8210' })).rejects.toThrow('BAD_PHONE');
  });

  it('refuses my own number', async () => {
    write(`${PERSONS}/${PERSON_ID}`, { status: 'active', account: CALLER });
    write(`${PHONE_INDEX}/${hmacPhone(PHONE, KEY)}`, { personId: PERSON_ID });

    await expectRejection(call({ type: 'phone', value: PHONE }), 'invalid-argument', 'SELF_TRANSFER');
  });
});

describe('resolveRecipient by nickname (v2 P5: Firestore, not the chain)', () => {
  it('resolves nicknames/{key} → persons/{personId}.account and echoes the display form', async () => {
    write('nicknames/alex', { personId: PERSON_ID, account: '0xstale', display: 'Alex' });

    const result = await call({ type: 'nickname', value: '  ALEX ' });

    // 계정은 닉네임 문서가 아니라 사람 문서에서 온다(회전 자동 반영).
    expect(result).toMatchObject({ member: true, account: RECIPIENT, nickname: 'Alex' });
    expect(result.commitment).toBeUndefined();
    expect(reads).toEqual([]);
  });

  it('rejects a nickname nobody owns', async () => {
    await expectRejection(call({ type: 'nickname', value: 'ghost' }), 'not-found', 'NICKNAME_UNKNOWN');
  });

  it('treats a malformed nickname as unknown without reading anything', async () => {
    await expectRejection(call({ type: 'nickname', value: 'a b' }), 'not-found', 'NICKNAME_UNKNOWN');
  });

  it('rejects an empty nickname', async () => {
    await expect(call({ type: 'nickname', value: '   ' })).rejects.toThrow('EMPTY_NICKNAME');
  });

  it('refuses my own nickname', async () => {
    write(`${PERSONS}/0xme`, { status: 'active', account: CALLER });
    write('nicknames/myself', { personId: '0xme', account: CALLER, display: 'myself' });
    await expectRejection(
      call({ type: 'nickname', value: 'myself' }),
      'invalid-argument',
      'SELF_TRANSFER',
    );
  });
});

describe('resolveRecipient by address', () => {
  it('accepts an Identity member and checksums the answer', async () => {
    const result = await call({ type: 'address', value: RECIPIENT_LOWER });

    expect(result).toMatchObject({ member: true, account: RECIPIENT });
    expect(result.commitment).toBeUndefined();
    expect(reads.map((r) => r.functionName)).toEqual(['isMember']);
  });

  it('blocks an address that is not a member', async () => {
    chain.members.delete(RECIPIENT_LOWER);
    await expectRejection(
      call({ type: 'address', value: RECIPIENT_LOWER }),
      'failed-precondition',
      'NOT_A_MEMBER',
    );
  });

  it('rejects something that is not an address', async () => {
    await expect(call({ type: 'address', value: '0x1234' })).rejects.toThrow('BAD_ADDRESS');
  });

  it('refuses my own account', async () => {
    await expectRejection(
      call({ type: 'address', value: CALLER.toLowerCase() }),
      'invalid-argument',
      'SELF_TRANSFER',
    );
  });
});

describe('resolveRecipient guards', () => {
  it('needs a session', async () => {
    await expectRejection(
      resolve({ data: { type: 'address', value: CALLER } } as never) as Promise<unknown>,
      'unauthenticated',
      'AUTH_REQUIRED',
    );
  });

  it('rejects a missing value and an unknown type', async () => {
    await expect(call({ type: 'address' })).rejects.toThrow('BAD_VALUE');
    await expect(call({ type: 'email', value: 'a@b.c' })).rejects.toThrow('BAD_TYPE');
  });
});
