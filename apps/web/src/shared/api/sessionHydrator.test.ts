import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../session';

const unsubscribe = vi.fn();
let authUser: { uid: string } | null = null;
vi.mock('firebase/auth', () => ({
  onAuthStateChanged: (_auth: unknown, next: (user: unknown) => void) => {
    next(authUser);
    return unsubscribe;
  },
}));
vi.mock('./firebase', () => ({ getFirebaseAuth: () => ({}) }));

const storedCredential = vi.fn();
vi.mock('../passkey', () => ({ storedCredential }));

const getAttendeeAccount = vi.fn();
vi.mock('../chain/accounts', () => ({ getAttendeeAccount }));

const { firebaseSessionHydrator } = await import('./sessionHydrator');

const ACCOUNT = `0x${'ab'.repeat(20)}`;

/** Runs the hydrator and waits out the account derivation it may kick off. */
async function hydrate(): Promise<Session[]> {
  const seen: Session[] = [];
  firebaseSessionHydrator((session) => seen.push(session));
  await vi.waitFor(() => expect(seen.length).toBeGreaterThan(0));
  return seen;
}

beforeEach(() => {
  authUser = { uid: 'uid-1' };
  storedCredential.mockReturnValue({ id: 'cred', publicKey: '0x00' });
  getAttendeeAccount.mockResolvedValue({ address: ACCOUNT });
});

describe('firebaseSessionHydrator', () => {
  it('resolves a signed-in Firebase user with a passkey on this device', async () => {
    expect(await hydrate()).toEqual([{ status: 'signedIn', account: ACCOUNT }]);
  });

  it('is anonymous without a Firebase user', async () => {
    authUser = null;
    expect(await hydrate()).toEqual([{ status: 'anonymous' }]);
    expect(getAttendeeAccount).not.toHaveBeenCalled();
  });

  it('is anonymous when the passkey is gone from this device', async () => {
    storedCredential.mockReturnValue(undefined);
    expect(await hydrate()).toEqual([{ status: 'anonymous' }]);
  });

  it('never leaves the guard spinning when the account cannot be derived', async () => {
    getAttendeeAccount.mockRejectedValue(new Error('no account'));
    expect(await hydrate()).toEqual([{ status: 'anonymous' }]);
  });

  it('hands back the auth listener teardown', () => {
    expect(firebaseSessionHydrator(() => undefined)).toBe(unsubscribe);
  });
});
