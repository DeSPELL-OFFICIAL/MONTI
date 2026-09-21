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
