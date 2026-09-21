import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FirebaseError } from 'firebase/app';

let nextError: unknown = null;

/** Set by a test that needs the server's own answer rather than the echo below. */
let nextResult: unknown = null;

vi.mock('firebase/functions', () => ({
  httpsCallable: (_fns: unknown, name: string) => async (payload: unknown) => {
    if (nextError !== null) {
      const thrown = nextError;
      nextError = null;
      throw thrown;
    }
    if (nextResult !== null) {
      const answer = nextResult;
      nextResult = null;
      return { data: answer };
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

const { api, CallableError, callableFailure } = await import('./functions');

beforeEach(() => {
  nextError = null;
  nextResult = null;
});

describe('callable wrappers', () => {
  it('names every function exactly as sub-plan 02 deploys it', async () => {
    await expect(api.startSignup()).resolves.toMatchObject({ name: 'startSignup' });
    await expect(api.resolveRecipient({ type: 'phone', value: '+821012345678' }))
      .resolves.toMatchObject({ name: 'resolveRecipient', payload: { type: 'phone', value: '+821012345678' } });
    await expect(api.startKyc()).resolves.toMatchObject({ name: 'startKyc' });
    await expect(api.revokeInvite({ inviteId: 'i1' })).resolves.toMatchObject({ name: 'revokeInvite' });
  });

  /**
   * The shipped callable answers `{ gates }` and every caller wants the rows, so the wrapper
   * unwraps — the same shape `pendingOffers` has. A row is exactly the four values
   * `Organizers.registerGate` takes plus when it arrived: no device label, no `createdAt`,
   * and never the uid that submitted it.
   */
  it('unwraps the pending-gate queue to its rows', async () => {
    nextResult = { gates: [{ gateAccount: '0xabc', kx: '0x01', ky: '0x02', submittedAt: 7 }] };
    await expect(api.listPendingGates({ eventId: '3' })).resolves.toEqual([
      { gateAccount: '0xabc', kx: '0x01', ky: '0x02', submittedAt: 7 },
    ]);
  });

  /**
   * `pinMessage` takes `messageId`, never `msgId` — the server refuses an unknown target with
   * `BAD_PIN_TARGET` — and authoring a notice is the `text` shape, with no `pinned` alongside
   * it (`BAD_PINNED`). Both go to the same callable and both answer with the message id.
   */
  it('posts a notice by text and toggles an existing pin by messageId', async () => {
    await expect(api.pinMessage({ eventId: '3', text: '문 앞에서 만나요' })).resolves.toMatchObject({
      name: 'pinMessage', payload: { eventId: '3', text: '문 앞에서 만나요' },
    });
    await expect(api.pinMessage({ eventId: '3', messageId: 'm1', pinned: false })).resolves.toMatchObject({
      name: 'pinMessage', payload: { eventId: '3', messageId: 'm1', pinned: false },
    });
  });

  it('offers nothing sub-plan 02 never deployed', () => {
    // `requestAccountDeletion` is planned, not built (functions/src/index.ts exports no such
    // name). A wrapper for it would fail as `internal`/`UNKNOWN` at the worst possible moment —
    // somebody asking to be erased — so the profile hands that request off by mail instead.
    expect(Object.keys(api)).not.toContain('requestAccountDeletion');
  });

  it('asks for a register-purpose challenge, which is the only way registerPasskey is reachable', async () => {
    // loginVerify demands purpose 'login' and registerPasskey demands 'register'; the server
    // refuses each ceremony the other's challenge, so the purpose has to leave the client.
    await expect(api.loginChallenge({ purpose: 'register' })).resolves.toMatchObject({
      name: 'loginChallenge', payload: { purpose: 'register' },
    });
  });

  it('carries the person id the backend mints through the passkey ceremony', async () => {
    const personId = `0x${'11'.repeat(32)}` as const;
    await expect(api.registerPasskey({ personId, attestation: { id: 'cred' } })).resolves.toMatchObject({
      name: 'registerPasskey', payload: { personId },
    });
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
    nextError = new FirebaseError('functions/already-exists', 'PHONE_ALREADY_REGISTERED');
    const failure = await api.startSignup().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CallableError);
    expect(failure).toMatchObject({ code: 'already-exists', message: 'PHONE_ALREADY_REGISTERED' });
  });

  it('never lets a transport failure pose as a server reason code', async () => {
    // A raw 'Failed to fetch' reaching a caller that branches on `message` is worse than opaque.
    nextError = new Error('Failed to fetch');
    const failure = await api.loginVerify({ assertion: {} }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ name: 'CallableError', code: 'internal', message: 'UNKNOWN' });
  });

  it('is opaque about anything that is not a Firebase error at all', async () => {
    nextError = 'boom';
    await expect(api.loginChallenge().catch((error: unknown) => error)).resolves.toMatchObject({
      code: 'internal', message: 'UNKNOWN',
    });
  });

  it('refuses to cast a code outside the HttpsError set into the union', async () => {
    nextError = new FirebaseError('functions/teapot', 'SOMETHING');
    await expect(api.startKyc().catch((error: unknown) => error)).resolves.toMatchObject({
      code: 'internal', message: 'UNKNOWN',
    });
  });

  it('leaves a non-callable Firebase error opaque too', async () => {
    nextError = new FirebaseError('auth/network-request-failed', 'A network error occurred');
    await expect(api.startKyc().catch((error: unknown) => error)).resolves.toMatchObject({
      code: 'internal', message: 'UNKNOWN',
    });
  });
});

describe('callableFailure', () => {
  it('splits a callable rejection into the status and the server reason a screen branches on', () => {
    expect(callableFailure(new CallableError('resource-exhausted', 'ATTESTER_BUSY'))).toEqual({
      code: 'resource-exhausted', reason: 'ATTESTER_BUSY',
    });
  });

  it('reads the same shape off a stand-in, so a mocked module does not silence the branch', () => {
    expect(callableFailure(Object.assign(new Error('PERSON_MISMATCH'), { code: 'permission-denied' }))).toEqual({
      code: 'permission-denied', reason: 'PERSON_MISMATCH',
    });
  });

  it('gives empty strings for anything that is not a rejection with those fields', () => {
    const empty = { code: '', reason: '' };
    expect(callableFailure(null)).toEqual(empty);
    expect(callableFailure('boom')).toEqual(empty);
    expect(callableFailure(new DOMException('cancelled', 'NotAllowedError'))).toEqual({
      code: '', reason: 'cancelled',
    });
  });
});
