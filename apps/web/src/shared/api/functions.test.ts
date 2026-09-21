import { beforeEach, describe, expect, it, vi } from 'vitest';

let nextError: unknown = null;

vi.mock('firebase/functions', () => ({
  httpsCallable: (_fns: unknown, name: string) => async (payload: unknown) => {
    if (nextError !== null) {
      const thrown = nextError;
      nextError = null;
      throw thrown;
    }
    return { data: { name, payload } };
  },
}));
// functions.ts asks firebase.ts for the region-bound Functions instance; a partial factory
// mock throws at import time, so the whole surface this module uses is stubbed here.
vi.mock('./firebase', () => ({
  getFirebaseApp: () => ({}),
  getFunctionsRegion: () => 'us-east1',
  getFirebaseFunctions: () => ({}),
}));

const { api, CallableError } = await import('./functions');

beforeEach(() => {
  nextError = null;
});

describe('callable wrappers', () => {
  it('names every function exactly as sub-plan 02 deploys it', async () => {
    await expect(api.startSignup()).resolves.toMatchObject({ name: 'startSignup' });
    await expect(api.resolveRecipient({ type: 'phone', value: '+821012345678' }))
      .resolves.toMatchObject({ name: 'resolveRecipient', payload: { type: 'phone', value: '+821012345678' } });
    await expect(api.listPendingGates({ eventId: '3' })).resolves.toMatchObject({ name: 'listPendingGates' });
    await expect(api.startKyc()).resolves.toMatchObject({ name: 'startKyc' });
    await expect(api.pinMessage({ eventId: '3', msgId: 'm1', pinned: true })).resolves.toMatchObject({ name: 'pinMessage' });
  });

  it('passes the gate device account to the staff-only callables', async () => {
    const gateAccount = `0x${'dd'.repeat(20)}` as const;
    await expect(api.issueSnapshot({ eventId: '5', gateAccount })).resolves.toMatchObject({
      name: 'issueSnapshot', payload: { eventId: '5', gateAccount },
    });
    await expect(api.getPhotoForGate({ tokenId: '42', gateAccount })).resolves.toMatchObject({
      name: 'getPhotoForGate', payload: { tokenId: '42', gateAccount },
    });
  });

  it('sends {} rather than undefined for the no-argument callables', async () => {
    await expect(api.loginChallenge()).resolves.toMatchObject({ payload: {} });
  });
});

describe('error mapping', () => {
  it('turns an HttpsError into a typed { code, message } the caller can branch on', async () => {
    nextError = Object.assign(new Error('PHONE_ALREADY_REGISTERED'), { code: 'functions/already-exists' });
    const failure = await api.startSignup().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CallableError);
    expect(failure).toMatchObject({ code: 'already-exists', message: 'PHONE_ALREADY_REGISTERED' });
  });

  it('falls back to unknown/UNKNOWN when the rejection is not a Firebase error', async () => {
    nextError = 'boom';
    const failure = await api.loginVerify({ assertion: {} }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ name: 'CallableError', code: 'unknown', message: 'UNKNOWN' });
  });
});
