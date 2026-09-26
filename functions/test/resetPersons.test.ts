import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Timestamp } from 'firebase-admin/firestore';
import { createFakeFirestore } from './helpers/fakeFirestore.js';

process.env.GCP_PROJECT_ID = 'monti-dev';

const PERSON_A = `0x${'aa'.repeat(32)}` as const;
const PERSON_B = `0x${'bb'.repeat(32)}` as const;
const PERSON_GONE = `0x${'cc'.repeat(32)}` as const;
const ACCOUNT_A = '0x9999999999999999999999999999999999999999';
const PHONE_A = '+821012345678';
const PHONE_B = '+821098765432';
const HMAC_A = 'hmac-a';
const ENV = { DIDIT_API_KEY: 'didit-key' };

const fake = createFakeFirestore();
const { docs, write, snapshot } = fake;

/** Firebase Auth. 평문 번호는 Firestore 어디에도 없어서 목록의 번호는 여기서만 나온다. */
const users = new Map<string, { uid: string; phoneNumber?: string }>();
const deleteUser = vi.fn(async (uid: string) => {
  if (!users.has(uid)) throw Object.assign(new Error('gone'), { code: 'auth/user-not-found' });
  users.delete(uid);
});
const getUser = vi.fn(async (uid: string) => {
  const found = users.get(uid);
  if (!found) throw Object.assign(new Error('gone'), { code: 'auth/user-not-found' });
  return found;
});
const getUserByPhoneNumber = vi.fn(async (phone: string) => {
  const found = [...users.values()].find((user) => user.phoneNumber === phone);
  if (!found) throw Object.assign(new Error('gone'), { code: 'auth/user-not-found' });
  return found;
});

vi.mock('../src/lib/db.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/db.js')>()),
  db: fake.db,
  authAdmin: { deleteUser, getUser, getUserByPhoneNumber },
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

const { DEVICES, PASSKEYS, PERSONS, PHONE_INDEX, USERS } = await import('../src/lib/db.js');
const { HELP, UsageError, main, maskPhone, parseArgs, selectTargets } = await import(
  '../scripts/reset-persons.js'
);

const CREATED_A = Timestamp.fromMillis(Date.UTC(2026, 8, 21, 4, 11, 7));
const CREATED_B = Timestamp.fromMillis(Date.UTC(2026, 8, 22, 9, 0, 0));

/**
 * 두 명은 살아 있고(A: KYC 까지 끝남, B: 가입만 함) 한 명은 이미 지워졌다.
 * A 에게는 행사 초안 두 개가 달려 있다.
 */
function seed(): void {
  write(`${PERSONS}/${PERSON_A}`, {
    status: 'active',
    account: ACCOUNT_A,
    kyc: { sessionId: 'sess-1', status: 'approved' },
    kycSessionIds: ['sess-0', 'sess-1'],
    enc: { name: 'enc:name' },
    photoEnc: 'enc:photo',
    createdAt: CREATED_A,
  });
  write(`${PERSONS}/${PERSON_B}`, { status: 'pending', createdAt: CREATED_B });
  write(`${PERSONS}/${PERSON_GONE}`, { status: 'deleted', createdAt: CREATED_B });

  write(`${USERS}/uid-a`, { personId: PERSON_A, phoneHmac: HMAC_A, phoneEnc: 'enc:phone' });
  write(`${USERS}/uid-b`, { personId: PERSON_B });
  write(`${PHONE_INDEX}/${HMAC_A}`, { personId: PERSON_A });
  write(`${PASSKEYS}/cred-a`, { personId: PERSON_A });
  write(`${DEVICES}/${ACCOUNT_A}`, { deviceX: '0x11' });

  write(`eventDrafts/uid-a/drafts/d1`, { title: '공연 하나' });
  write(`eventDrafts/uid-a/drafts/d2`, { title: '공연 둘' });

  // 행사에 달린 것들. 사람을 지운다고 같이 사라지면 안 된다.
  write(`orgProfiles/42`, { name: '테스트 주최사' });
  write(`eventPrivate/7`, { venue: '비밀 장소' });
  write(`eventArt/7`, { tiers: [] });

  users.set('uid-a', { uid: 'uid-a', phoneNumber: PHONE_A });
  users.set('uid-b', { uid: 'uid-b', phoneNumber: PHONE_B });
}

function runMain(argv: string[], env: Record<string, string | undefined> = ENV) {
  const lines: string[] = [];
  return main(argv, env, (line) => lines.push(line)).then((code) => ({ code, out: lines.join('\n') }));
}

beforeEach(() => {
  docs.clear();
  users.clear();
  for (const spy of [deleteUser, getUser, getUserByPhoneNumber, deleteDiditSession]) spy.mockClear();
  deleteDiditSession.mockResolvedValue(undefined);
  seed();
});

describe('parseArgs', () => {
  it('reads each target and the confirmation flag', () => {
    expect(parseArgs(['--all'])).toEqual({ mode: 'all', personId: undefined, phone: undefined, confirmed: false });
    expect(parseArgs(['--all', '--yes']).confirmed).toBe(true);
    expect(parseArgs(['--person', PERSON_A])).toMatchObject({ mode: 'person', personId: PERSON_A });
    expect(parseArgs(['--phone', PHONE_A])).toMatchObject({ mode: 'phone', phone: PHONE_A });
  });

  it('lowercases a personId so a pasted checksum spelling still finds the document', () => {
    expect(parseArgs(['--person', PERSON_A.toUpperCase().replace('0X', '0x')]).personId).toBe(PERSON_A);
  });

  it('refuses two targets at once — silently picking one is the worst outcome', () => {
    expect(() => parseArgs(['--all', '--person', PERSON_A])).toThrow(UsageError);
    expect(() => parseArgs(['--phone', PHONE_A, '--person', PERSON_A])).toThrow(UsageError);
  });

  it('refuses no target, a malformed id, a malformed phone, a missing value and an unknown flag', () => {
    expect(() => parseArgs([])).toThrow(UsageError);
    expect(() => parseArgs(['--yes'])).toThrow(UsageError);
    expect(() => parseArgs(['--person', '0xdead'])).toThrow(UsageError);
    expect(() => parseArgs(['--phone', '01012345678'])).toThrow(UsageError);
    expect(() => parseArgs(['--person', '--yes'])).toThrow(UsageError);
    expect(() => parseArgs(['--everything'])).toThrow(UsageError);
  });
});

describe('maskPhone', () => {
  it('leaves enough to recognise a test account and no more', () => {
    expect(maskPhone(PHONE_A)).toBe('+8210****5678');
    expect(maskPhone('+15551234')).toBe('+1*****34'); // 짧은 번호도 길이는 그대로 남는다
    expect(maskPhone(undefined)).toBe('(번호 없음)');
  });
});

describe('selectTargets', () => {
  it('--all takes everyone who still holds personal data and skips the already-erased', async () => {
    const targets = await selectTargets(parseArgs(['--all']));

    expect(targets.map((target) => target.personId).sort()).toEqual([PERSON_A, PERSON_B].sort());
    const a = targets.find((target) => target.personId === PERSON_A);
    expect(a).toMatchObject({ uid: 'uid-a', phone: PHONE_A, status: 'active', kycStatus: 'approved' });
    expect(a?.createdAt).toBe(CREATED_A.toDate().toISOString());
    expect(targets.find((target) => target.personId === PERSON_B)?.kycStatus).toBeUndefined();
  });

  it('--person takes exactly that one, even when it is already deleted', async () => {
    expect(await selectTargets(parseArgs(['--person', PERSON_B]))).toHaveLength(1);
    expect((await selectTargets(parseArgs(['--person', PERSON_GONE])))[0]?.status).toBe('deleted');
    expect(await selectTargets(parseArgs(['--person', `0x${'ee'.repeat(32)}`]))).toEqual([]);
  });

  it('--phone goes through Firebase Auth, which is the only place the plaintext number lives', async () => {
    const targets = await selectTargets(parseArgs(['--phone', PHONE_B]));

    expect(getUserByPhoneNumber).toHaveBeenCalledWith(PHONE_B);
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({ personId: PERSON_B, uid: 'uid-b' });
    expect(await selectTargets(parseArgs(['--phone', '+821000000000']))).toEqual([]);
  });

  it('still lists a person whose users document is already gone', async () => {
    docs.delete(`${USERS}/uid-a`);

    const target = (await selectTargets(parseArgs(['--person', PERSON_A])))[0];

    expect(target?.uid).toBeUndefined();
    expect(target?.phone).toBeUndefined();
    expect(target?.status).toBe('active');
  });
});

describe('main', () => {
  it('refuses to run at all without the Didit key — a dry run must not promise what it cannot do', async () => {
    const { code, out } = await runMain(['--all'], {});

    expect(code).toBe(2);
    expect(out).toContain('DIDIT_API_KEY');
    expect(snapshot(`${PERSONS}/${PERSON_A}`).get('status')).toBe('active');
  });

  it('prints the targets and touches nothing without --yes', async () => {
    const { code, out } = await runMain(['--all']);

    expect(code).toBe(0);
    expect(out).toContain('대상 2명');
    expect(out).toContain(PERSON_A);
    expect(out).toContain('+8210****5678');
    expect(out).toContain('status=active');
    expect(out).toContain('드라이런');
    expect(out).not.toContain(PHONE_A); // 평문 번호는 터미널에도 남지 않는다

    expect(snapshot(`${PERSONS}/${PERSON_A}`).get('status')).toBe('active');
    expect(snapshot(`${USERS}/uid-a`).exists).toBe(true);
    expect(deleteDiditSession).not.toHaveBeenCalled();
    expect(deleteUser).not.toHaveBeenCalled();
  });

  it('with --yes runs the same erasure the scheduled job runs, plus the event drafts', async () => {
    const { code, out } = await runMain(['--all', '--yes']);

    expect(code).toBe(0);
    expect(snapshot(`${USERS}/uid-a`).exists).toBe(false);
    expect(snapshot(`${PHONE_INDEX}/${HMAC_A}`).exists).toBe(false);
    expect(snapshot(`${PASSKEYS}/cred-a`).exists).toBe(false);
    expect(snapshot(`${DEVICES}/${ACCOUNT_A}`).exists).toBe(false);
    expect(snapshot(`${PERSONS}/${PERSON_A}`).get('status')).toBe('deleted');
    expect(snapshot(`${PERSONS}/${PERSON_A}`).get('photoEnc')).toBeUndefined();

    // 주인이 사라진 행사 초안도 같이 지운다.
    expect(snapshot('eventDrafts/uid-a/drafts/d1').exists).toBe(false);
    expect(snapshot('eventDrafts/uid-a/drafts/d2').exists).toBe(false);

    expect(deleteDiditSession).toHaveBeenCalledWith('sess-0', 'didit-key');
    expect(deleteDiditSession).toHaveBeenCalledWith('sess-1', 'didit-key');
    expect(deleteUser.mock.calls.map(([uid]) => uid).sort()).toEqual(['uid-a', 'uid-b']);

    // phoneIndex + users + passkeys + devices + 초안 2 = 6
    expect(out).toContain('didit sessions deleted 2, firestore docs deleted 6, auth deleted yes');
    expect(out).toContain('didit sessions deleted 0, firestore docs deleted 1, auth deleted yes');
    expect(out).toContain('2명 지웠다, 0명 실패');
  });

  it('leaves the event-scoped documents alone — they belong to a show, not to a person', async () => {
    await runMain(['--all', '--yes']);

    expect(snapshot('orgProfiles/42').exists).toBe(true);
    expect(snapshot('eventPrivate/7').exists).toBe(true);
    expect(snapshot('eventArt/7').exists).toBe(true);
  });

  it('is idempotent — the second sweep finds nothing left to do', async () => {
    await runMain(['--all', '--yes']);
    for (const spy of [deleteDiditSession, deleteUser]) spy.mockClear();

    const { code, out } = await runMain(['--all', '--yes']);

    expect(code).toBe(0);
    expect(out).toContain('대상 0명');
    expect(deleteDiditSession).not.toHaveBeenCalled();
    expect(deleteUser).not.toHaveBeenCalled();
  });

  it('re-running on one already-deleted person deletes nothing and says so', async () => {
    const { code, out } = await runMain(['--person', PERSON_GONE, '--yes']);

    expect(code).toBe(0);
    expect(out).toContain('didit sessions deleted 0, firestore docs deleted 0, auth deleted no');
  });

  it('keeps going when one person blows up, and reports the failure', async () => {
    deleteDiditSession.mockRejectedValue(new Error('DIDIT_DELETE_FAILED:500'));

    const { code, out } = await runMain(['--all', '--yes']);

    expect(code).toBe(1);
    expect(out).toContain('실패');
    expect(out).toContain('1명 지웠다, 1명 실패'); // B 에게는 세션이 없어 그대로 지워진다
    expect(snapshot(`${PERSONS}/${PERSON_A}`).get('status')).toBe('active'); // 아무것도 지우지 않았다
    expect(snapshot(`${PERSONS}/${PERSON_B}`).get('status')).toBe('deleted');
  });

  it('answers an explicit target that does not exist with a non-zero exit', async () => {
    const { code, out } = await runMain(['--phone', '+821000000000']);

    expect(code).toBe(1);
    expect(out).toContain('지울 것이 없다');
  });

  it('prints usage with no arguments, on a bad argument, and on --help', async () => {
    expect(await runMain([])).toMatchObject({ code: 2 });
    const bad = await runMain(['--everything']);
    expect(bad.code).toBe(2);
    expect(bad.out).toContain('모르는 인자');
    expect(await runMain(['--help'])).toMatchObject({ code: 0 });
  });

  it('spells out in the help text which collections it deliberately leaves behind', () => {
    for (const kept of ['orgProfiles', 'eventPrivate', 'eventArt']) expect(HELP).toContain(kept);
    expect(HELP).toContain('eventDrafts');
    expect(HELP).toContain('--yes');
  });
});
