import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getAddress } from 'viem';
import { createFakeFirestore } from './helpers/fakeFirestore.js';

process.env.GCP_PROJECT_ID = 'monti-dev';

const ME = getAddress(`0x${'ab'.repeat(20)}`);
const OTHER = getAddress(`0x${'cd'.repeat(20)}`);
const MY_PERSON = `0x${'aa'.repeat(32)}`;
const OTHER_PERSON = `0x${'bb'.repeat(32)}`;

const fake = createFakeFirestore();
vi.mock('../src/lib/db.js', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/db.js')>('../src/lib/db.js');
  return { ...actual, db: fake.db };
});
// 체인은 이 파일 어디에서도 읽지 않는다 — 부르면 깨진다.
vi.mock('../src/lib/chain.js', () => ({
  publicClient: () => {
    throw new Error('UNEXPECTED_CHAIN_READ');
  },
  deployment: () => ({}),
}));

const { NICKNAMES, USERS } = await import('../src/lib/db.js');
const { parseNickname, nicknamesByAccount } = await import('../src/lib/nicknames.js');
const { setNickname, resolveNicknames } = await import('../src/functions/nickname.js');
const functionsTest = (await import('firebase-functions-test')).default();
const set = functionsTest.wrap(setNickname);
const resolve = functionsTest.wrap(resolveNicknames);

const me = { uid: 'uid-1', token: { account: ME.toLowerCase(), personId: MY_PERSON } };
const other = { uid: 'uid-2', token: { account: OTHER.toLowerCase(), personId: OTHER_PERSON } };

function callSet(nickname: unknown, auth: unknown = me) {
  return set({ data: { nickname }, auth } as never) as Promise<{ nickname: string }>;
}
function callResolve(accounts: unknown, auth: unknown = me) {
  return resolve({ data: { accounts }, auth } as never) as Promise<{ names: Record<string, string> }>;
}

beforeEach(() => {
  fake.docs.clear();
  fake.write(`${USERS}/uid-1`, { personId: MY_PERSON });
  fake.write(`${USERS}/uid-2`, { personId: OTHER_PERSON });
});

describe('parseNickname', () => {
  it('trims, NFC-normalises and lowercases the key while keeping the display form', () => {
    expect(parseNickname('  Alex_01 ')).toEqual({ key: 'alex_01', display: 'Alex_01' });
  });

  it.each(['ab', 'a'.repeat(21), 'has space', '한글닉', 'emoji😀', 'dash-name', '', 42, null])(
    'rejects %s',
    (raw) => {
      expect(parseNickname(raw)).toBeNull();
    },
  );
});

describe('setNickname', () => {
  it('rejects an unauthenticated call', async () => {
    await expect(set({ data: { nickname: 'alex' } } as never)).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('NICKNAME_INVALID for a malformed name', async () => {
    await expect(callSet('a b')).rejects.toMatchObject({ code: 'invalid-argument', details: { code: 'NICKNAME_INVALID' } });
  });

  it('NO_PERSON when the session has no person', async () => {
    const stranger = { uid: 'uid-9', token: {} };
    await expect(callSet('alex', stranger)).rejects.toMatchObject({ details: { code: 'NO_PERSON' } });
  });

  it('claims the lowercase key, stores the display form and mirrors users.nickname', async () => {
    expect(await callSet(' Alex ')).toEqual({ nickname: 'Alex' });
    const doc = fake.snapshot(`${NICKNAMES}/alex`);
    expect(doc.data()).toMatchObject({ personId: MY_PERSON, account: ME.toLowerCase(), display: 'Alex' });
    expect(doc.get('updatedAt')).toBeDefined();
    expect(fake.snapshot(`${USERS}/uid-1`).get('nickname')).toBe('Alex');
  });

  it("NICKNAME_TAKEN when someone else holds the name, in any letter case", async () => {
    await callSet('alex', other);
    await expect(callSet('ALEX')).rejects.toMatchObject({ code: 'already-exists', details: { code: 'NICKNAME_TAKEN' } });
    expect(fake.snapshot(`${NICKNAMES}/alex`).get('personId')).toBe(OTHER_PERSON);
    expect(fake.snapshot(`${USERS}/uid-1`).get('nickname')).toBeUndefined();
  });

  it('releases my previous name when I rename, so someone else can take it', async () => {
    await callSet('alex');
    await callSet('monti');
    expect(fake.snapshot(`${NICKNAMES}/alex`).exists).toBe(false);
    expect(fake.snapshot(`${NICKNAMES}/monti`).get('personId')).toBe(MY_PERSON);
    await expect(callSet('alex', other)).resolves.toEqual({ nickname: 'alex' });
  });

  it('lets me re-set my own name with a different letter case', async () => {
    await callSet('alex');
    await expect(callSet('Alex')).resolves.toEqual({ nickname: 'Alex' });
    expect(fake.snapshot(`${NICKNAMES}/alex`).get('display')).toBe('Alex');
    expect([...fake.docs.keys()].filter((path) => path.startsWith(`${NICKNAMES}/`))).toEqual([`${NICKNAMES}/alex`]);
  });
});

describe('nicknamesByAccount / resolveNicknames', () => {
  it('maps lowercase accounts to display names, skipping accounts without one', async () => {
    await callSet('Alex');
    const names = await nicknamesByAccount([ME, OTHER, ME.toLowerCase()]);
    expect([...names.entries()]).toEqual([[ME.toLowerCase(), 'Alex']]);
  });

  it('chunks past the Firestore in-limit of 30', async () => {
    const accounts = Array.from({ length: 65 }, (_, i) => `0x${i.toString(16).padStart(40, '0')}`);
    accounts.forEach((account, i) =>
      fake.write(`${NICKNAMES}/name_${i}`, { personId: `p${i}`, account, display: `Name_${i}` }),
    );
    const names = await nicknamesByAccount(accounts);
    expect(names.size).toBe(65);
    expect(names.get(accounts[64]!)).toBe('Name_64');
  });

  it('resolveNicknames answers a signed-in caller with a lowercase-keyed record', async () => {
    await callSet('Alex');
    await expect(callResolve([ME, OTHER])).resolves.toEqual({ names: { [ME.toLowerCase()]: 'Alex' } });
  });

  it('resolveNicknames refuses more than 100 accounts or a non-address', async () => {
    const many = Array.from({ length: 101 }, (_, i) => `0x${i.toString(16).padStart(40, '0')}`);
    await expect(callResolve(many)).rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(callResolve(['nope'])).rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(callResolve('0x00')).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('resolveNicknames requires a session', async () => {
    await expect(resolve({ data: { accounts: [ME] } } as never)).rejects.toMatchObject({ code: 'unauthenticated' });
  });
});
