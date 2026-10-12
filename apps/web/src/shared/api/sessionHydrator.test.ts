import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../session';

const unsubscribe = vi.fn();
const getIdTokenResult = vi.fn();
let authUser: { getIdTokenResult: typeof getIdTokenResult } | null = null;

vi.mock('firebase/auth', () => ({
  onIdTokenChanged: (_auth: unknown, next: (user: unknown) => void) => {
    next(authUser);
    return unsubscribe;
  },
}));
vi.mock('./firebase', () => ({ getFirebaseAuth: () => ({}) }));

const { firebaseSessionHydrator } = await import('./sessionHydrator');

const PERSON_ID = `0x${'11'.repeat(32)}`;
const ACCOUNT = `0x${'ab'.repeat(20)}`;

/** Runs the hydrator and waits out the claim read it kicks off. */
async function hydrate(): Promise<Session[]> {
  const seen: Session[] = [];
  firebaseSessionHydrator((session) => seen.push(session));
  await vi.waitFor(() => expect(seen.length).toBeGreaterThan(0));
  return seen;
}

beforeEach(() => {
  getIdTokenResult.mockResolvedValue({ claims: { personId: PERSON_ID, account: ACCOUNT } });
  authUser = { getIdTokenResult };
});

describe('firebaseSessionHydrator', () => {
  it('takes personId and account from the custom token claims, not from local derivation', async () => {
    expect(await hydrate()).toEqual([{ status: 'signedIn', personId: PERSON_ID, account: ACCOUNT }]);
  });

  /**
   * Open mode (VITE_AUTH_MODE=open): the visitor is a Firebase *anonymous* user whose token the
   * server stamped with the same two claims. Firebase persists that user like any other, so a
   * returning visitor is signed in by this rule alone — the provider is never consulted.
   */
  it('treats an anonymous-provider user carrying the claims as signed in', async () => {
    getIdTokenResult.mockResolvedValue({
      claims: { personId: PERSON_ID, account: ACCOUNT, firebase: { sign_in_provider: 'anonymous' } },
      signInProvider: 'anonymous',
    });
    authUser = { getIdTokenResult, isAnonymous: true } as typeof authUser;
    expect(await hydrate()).toEqual([{ status: 'signedIn', personId: PERSON_ID, account: ACCOUNT }]);
  });

  it('is anonymous for an anonymous-provider user before the server stamped the claims', async () => {
    getIdTokenResult.mockResolvedValue({ claims: { firebase: { sign_in_provider: 'anonymous' } } });
    expect(await hydrate()).toEqual([{ status: 'anonymous' }]);
  });

  it('clears both identifiers when the user signs out', async () => {
    authUser = null;
    expect(await hydrate()).toEqual([{ status: 'anonymous' }]);
    expect(getIdTokenResult).not.toHaveBeenCalled();
  });

  it('is anonymous for a Firebase session that carries no MONTI claims', async () => {
    // The phone sign-in that precedes startSignup has a uid but no personId/account yet.
    getIdTokenResult.mockResolvedValue({ claims: { phone_number: '+821012345678' } });
    expect(await hydrate()).toEqual([{ status: 'anonymous' }]);
  });

  it('refuses claims that are not the shapes loginVerify mints', async () => {
    getIdTokenResult.mockResolvedValue({ claims: { personId: PERSON_ID, account: 'not-an-address' } });
    expect(await hydrate()).toEqual([{ status: 'anonymous' }]);
  });

  it('never leaves the guard spinning when the token cannot be read', async () => {
    getIdTokenResult.mockRejectedValue(new Error('token unavailable'));
    expect(await hydrate()).toEqual([{ status: 'anonymous' }]);
  });

  it('hands back the token listener teardown', () => {
    expect(firebaseSessionHydrator(() => undefined)).toBe(unsubscribe);
  });
});
