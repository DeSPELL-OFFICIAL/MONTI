import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeFirestore } from './helpers/fakeFirestore.js';

process.env.GCP_PROJECT_ID = 'monti-dev';

const PERSON_ID = `0x${'aa'.repeat(32)}`;
const OTHER_PERSON_ID = `0x${'bb'.repeat(32)}`;
const ACCOUNT = '0x9999999999999999999999999999999999999999';
const PHONE_HMAC = 'hmac-of-+821012345678';
const SESSION_ID = 'sess-1';
const OLD_SESSION_ID = 'sess-0';
const KEY = 'didit-key';

const fake = createFakeFirestore();
const { docs, write, snapshot } = fake;

const deleteUser = vi.fn(async (_uid: string) => undefined);

vi.mock('../src/lib/db.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/db.js')>()),
  db: fake.db,
  authAdmin: { deleteUser },
}));

const deleteDiditSession = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock('../src/lib/didit.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/didit.js')>()),
  deleteDiditSession: (...args: unknown[]) => deleteDiditSession(...args),
}));

vi.mock('firebase-functions/logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('firebase-functions/logger')>()),
  info: () => undefined,
  error: () => undefined,
}));

const { DEVICES, NICKNAMES, PASSKEYS, PERSONS, PHONE_INDEX, USERS } = await import('../src/lib/db.js');
const { DiditErasureFailed, erasePerson } = await import('../src/lib/erasePerson.js');

/** 파기 대상이 실제로 흩어져 있는 다섯 자리 전부를 심는다. */
function seed(): void {
  write(`${PERSONS}/${PERSON_ID}`, {
    status: 'active',
    kycLevel: 1,
    account: ACCOUNT,
    kyc: { provider: 'didit', sessionId: SESSION_ID, status: 'approved' },
    kycSessionIds: [OLD_SESSION_ID, SESSION_ID],
    enc: { name: 'enc:name', docNumber: 'enc:doc' },
    photoEnc: 'enc:photo',
    chain: { registerTx: '0xabc', block: 7 },
  });
  write(`${USERS}/uid-1`, { personId: PERSON_ID, phoneEnc: 'enc:phone', phoneHmac: PHONE_HMAC, nickname: '태완' });
  write(`${PASSKEYS}/cred-1`, { personId: PERSON_ID, counter: 3 });
  write(`${PASSKEYS}/cred-2`, { personId: PERSON_ID, counter: 0 });
  write(`${PASSKEYS}/other`, { personId: OTHER_PERSON_ID, counter: 0 });
  write(`${DEVICES}/${ACCOUNT}`, { deviceX: '0x11', deviceY: '0x22', pushToken: 'fcm-1' });
  write(`${PHONE_INDEX}/${PHONE_HMAC}`, { personId: PERSON_ID });
}

function run(overrides: Partial<Parameters<typeof erasePerson>[0]> = {}) {
  return erasePerson({ uid: 'uid-1', personId: PERSON_ID as `0x${string}`, diditApiKey: KEY, ...overrides });
}

beforeEach(() => {
  docs.clear();
  deleteUser.mockClear();
  deleteUser.mockResolvedValue(undefined);
  deleteDiditSession.mockClear();
  deleteDiditSession.mockResolvedValue(undefined);
  seed();
});

describe('erasePerson', () => {
  it('erases every personal record and counts what it actually deleted', async () => {
    const result = await run();

    expect(snapshot(`${USERS}/uid-1`).exists).toBe(false);
    expect(snapshot(`${PHONE_INDEX}/${PHONE_HMAC}`).exists).toBe(false);
    expect(snapshot(`${DEVICES}/${ACCOUNT}`).exists).toBe(false);
    expect(snapshot(`${PASSKEYS}/cred-1`).exists).toBe(false);
    expect(snapshot(`${PASSKEYS}/cred-2`).exists).toBe(false);
    expect(snapshot(`${PASSKEYS}/other`).exists).toBe(true); // 남의 자격증명은 건드리지 않는다

    // 연 적 있는 세션 전부 — 열린 세션 하나만 지우면 옛 얼굴 템플릿이 Didit 에 영원히 남는다.
    expect(deleteDiditSession).toHaveBeenCalledWith(OLD_SESSION_ID, KEY);
    expect(deleteDiditSession).toHaveBeenCalledWith(SESSION_ID, KEY);
    expect(deleteUser).toHaveBeenCalledWith('uid-1');

    // phoneIndex + users + passkeys×2 + devices = 5. 사람 문서는 남기고 털기만 하므로 세지 않는다.
    expect(result).toEqual({ diditSessions: 2, firestoreDocs: 5, authDeleted: true });
  });

  it("frees the person's nickname (v2 P5) so the name can be taken again, and only theirs", async () => {
    write(`${NICKNAMES}/taewan`, { personId: PERSON_ID, account: ACCOUNT.toLowerCase(), display: 'Taewan' });
    write(`${NICKNAMES}/someone`, { personId: OTHER_PERSON_ID, account: '0xother', display: 'someone' });

    const result = await run();

    expect(snapshot(`${NICKNAMES}/taewan`).exists).toBe(false);
    expect(snapshot(`${NICKNAMES}/someone`).exists).toBe(true);
    // users/{uid} 는 통째로 지워지므로 그 안의 nickname 사본도 함께 사라진다.
    expect(snapshot(`${USERS}/uid-1`).exists).toBe(false);
    expect(result.firestoreDocs).toBe(6);
  });

  it('frees the nickname even when the uid is unknown (keyed by personId)', async () => {
    write(`${NICKNAMES}/taewan`, { personId: PERSON_ID, account: ACCOUNT.toLowerCase(), display: 'Taewan' });
    await run({ uid: undefined });
    expect(snapshot(`${NICKNAMES}/taewan`).exists).toBe(false);
  });

  it('keeps the person row the chain points at, stripped of every personal field', async () => {
    await run();

    const person = snapshot(`${PERSONS}/${PERSON_ID}`);
    expect(person.exists).toBe(true); // 체인이 이 personId 를 가리킨다(스펙 §10.2)
    expect(person.get('status')).toBe('deleted');
    expect(person.get('enc')).toBeUndefined();
    expect(person.get('photoEnc')).toBeUndefined();
    expect(person.get('kyc')).toBeUndefined();
    expect(person.get('kycSessionIds')).toBeUndefined();
    expect(person.get('account')).toBe(ACCOUNT);
    expect(person.get('chain.registerTx')).toBe('0xabc');

    const everything = JSON.stringify([...docs.entries()]);
    for (const secret of ['enc:phone', 'enc:photo', 'enc:name', 'enc:doc', PHONE_HMAC, '태완']) {
      expect(everything).not.toContain(secret);
    }
  });

  it('throws after retrying Didit once, having deleted nothing of ours', async () => {
    deleteDiditSession.mockRejectedValue(new Error('DIDIT_DELETE_FAILED:500'));

    await expect(run()).rejects.toBeInstanceOf(DiditErasureFailed);

    expect(deleteDiditSession).toHaveBeenCalledTimes(2); // 첫 세션에서 한 번 더 해 보고 포기한다
    // 우리 문서를 먼저 지우면 sessionId 가 사라져 남의 서버의 얼굴 자료를 영영 못 지운다.
    expect(snapshot(`${USERS}/uid-1`).exists).toBe(true);
    expect(snapshot(`${PERSONS}/${PERSON_ID}`).get('status')).toBe('active');
    expect(deleteUser).not.toHaveBeenCalled();
  });

  it('runs afterDidit once every session is gone and before a single document is touched', async () => {
    const seenWhenCalled: Array<boolean> = [];
    await run({
      afterDidit: async () => {
        seenWhenCalled.push(deleteDiditSession.mock.calls.length === 2, snapshot(`${USERS}/uid-1`).exists);
      },
    });

    expect(seenWhenCalled).toEqual([true, true]);
  });

  it('never reaches afterDidit when Didit refuses', async () => {
    deleteDiditSession.mockRejectedValue(new Error('DIDIT_DELETE_FAILED:401'));
    const afterDidit = vi.fn(async () => undefined);

    await expect(run({ afterDidit })).rejects.toBeInstanceOf(DiditErasureFailed);
    expect(afterDidit).not.toHaveBeenCalled();
  });

  it('is a no-op the second time — nothing left, nothing counted', async () => {
    await run();
    deleteDiditSession.mockClear();
    deleteUser.mockClear();
    deleteUser.mockRejectedValue(Object.assign(new Error('gone'), { code: 'auth/user-not-found' }));

    const again = await run();

    expect(again).toEqual({ diditSessions: 0, firestoreDocs: 0, authDeleted: false });
    expect(deleteDiditSession).not.toHaveBeenCalled();
    expect(snapshot(`${PERSONS}/${PERSON_ID}`).get('status')).toBe('deleted');
  });

  it('finishes when the Auth user is already gone', async () => {
    deleteUser.mockRejectedValue(Object.assign(new Error('gone'), { code: 'auth/user-not-found' }));

    const result = await run();

    expect(result.authDeleted).toBe(false);
    expect(snapshot(`${PERSONS}/${PERSON_ID}`).get('status')).toBe('deleted');
  });

  it('still rethrows an Auth failure that is not user-not-found', async () => {
    deleteUser.mockRejectedValue(Object.assign(new Error('boom'), { code: 'auth/internal-error' }));

    await expect(run()).rejects.toThrow('boom');
  });

  /** `users/{uid}` 가 먼저 지워진 반쪽 상태. 남은 것은 그래도 지워져야 한다. */
  it('erases what is left when the uid is unknown', async () => {
    docs.delete(`${USERS}/uid-1`);

    const result = await run({ uid: undefined });

    expect(snapshot(`${PASSKEYS}/cred-1`).exists).toBe(false);
    expect(snapshot(`${DEVICES}/${ACCOUNT}`).exists).toBe(false);
    expect(snapshot(`${PERSONS}/${PERSON_ID}`).get('status')).toBe('deleted');
    expect(snapshot(`${PHONE_INDEX}/${PHONE_HMAC}`).exists).toBe(true); // hmac 은 users 문서에만 있었다
    expect(deleteUser).not.toHaveBeenCalled();
    expect(result).toEqual({ diditSessions: 2, firestoreDocs: 3, authDeleted: false });
  });

  it('erases a person who never reached Didit or the chain', async () => {
    write(`${PERSONS}/${PERSON_ID}`, { status: 'pending', kycLevel: 0 }); // 세션도 계정 주소도 없다

    const result = await run();

    expect(deleteDiditSession).not.toHaveBeenCalled();
    expect(snapshot(`${PERSONS}/${PERSON_ID}`).get('status')).toBe('deleted');
    expect(result.diditSessions).toBe(0);
  });
});
