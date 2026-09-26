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
   * Organiser creation goes through the attester rather than a send of this person's own:
   * until sub-plan 01b sponsors `Organizers.createOrganizer` an attendee account has nothing
   * to pay that write with. The wrapper passes the name straight through — the server trims it
   * and counts code points — and answers with the number the chain chose.
   */
  it('names the attester-sponsored organiser callable exactly as it is deployed', async () => {
    await expect(api.createOrganizerForMe({ name: '재즈 컴퍼니' })).resolves.toMatchObject({
      name: 'createOrganizerForMe',
      payload: { name: '재즈 컴퍼니' },
    });
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
   * `listInvites` answers `{ invites }` and every caller wants the rows, so the wrapper unwraps
   * — the same shape `pendingOffers` and `listPendingGates` have. A row is exactly what
   * `invites.ts` `InviteRow` carries: no phone, no permission bits, nobody's uid, and
   * `requiredSender` only where the server put one (an `accepted` row).
   */
  it('unwraps the invitation list to its rows', async () => {
    const owner = `0x${'ab'.repeat(20)}` as const;
    nextResult = {
      invites: [
        { inviteId: 'i2', role: 'admin', status: 'accepted', createdAt: 40, expiresAt: 80, requiredSender: owner },
        { inviteId: 'i1', role: 'manager', status: 'sent', createdAt: 30, expiresAt: 70 },
      ],
    };
    await expect(api.listInvites({ orgId: '9' })).resolves.toEqual([
      { inviteId: 'i2', role: 'admin', status: 'accepted', createdAt: 40, expiresAt: 80, requiredSender: owner },
      { inviteId: 'i1', role: 'manager', status: 'sent', createdAt: 30, expiresAt: 70 },
    ]);
  });

  /**
   * `listPinned` is the only read path an organiser has to their own notices — they hold no
   * ticket, so `joinEventChat` refuses them the room and the rules refuse them the messages.
   * It answers `{ messages }`, unwrapped here the same way; a row carries no uid and no
   * report count.
   */
  it('unwraps the pinned notices to their rows', async () => {
    nextResult = { messages: [{ messageId: 'm1', text: '문 앞에서 만나요', createdAt: 7 }] };
    await expect(api.listPinned({ eventId: '5' })).resolves.toEqual([
      { messageId: 'm1', text: '문 앞에서 만나요', createdAt: 7 },
    ]);
  });

  /**
   * The landed `pinEventMetadata` no longer takes the picture — `imageCid` is what
   * `pinEventImage` already answered with — and `category` is a **number**, the chain's
   * `uint8`. The server would coerce a numeric string, but the attendee reader reads the
   * pinned `category` only when it is already a number, so this side always sends one.
   */
  it('carries the optional metadata fields, with the theme as a number', async () => {
    await expect(
      api.pinEventMetadata({
        orgId: '9',
        meta: {
          name: 'n', description: 'd', imageCid: 'bafkImage',
          venue: '한남동', category: 2, region: 'KR-11',
        },
      }),
    ).resolves.toMatchObject({
      name: 'pinEventMetadata',
      payload: {
        meta: {
          name: 'n', description: 'd', imageCid: 'bafkImage',
          venue: '한남동', category: 2, region: 'KR-11',
        },
      },
    });
  });

  /**
   * The three fields that decide what an attendee is allowed to see. `venue` is left out
   * entirely when it is hidden — the words never leave the browser — and `tags` are already
   * normalised here, because the server refuses the whole request over a bad one.
   */
  it('hides the venue by omitting it, and carries tags and the two flags', async () => {
    const answer = await api.pinEventMetadata({
      orgId: '9',
      meta: {
        name: 'n', description: 'd', imageCid: 'bafkImage', region: 'KR-11', category: 0,
        tags: ['재즈', '라이브'], venueHidden: true, timeHidden: true,
      },
    });
    expect(answer).toMatchObject({
      name: 'pinEventMetadata',
      payload: { meta: { tags: ['재즈', '라이브'], venueHidden: true, timeHidden: true } },
    });
    // Not merely absent from the pinned document — never sent at all. (`venueHidden` is a
    // different key, so the check is for the key itself rather than for the substring.)
    const meta = (answer as unknown as { payload: { meta: Record<string, unknown> } }).payload.meta;
    expect(Object.hasOwn(meta, 'venue')).toBe(false);
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

  /**
   * The deletion request takes no argument at all: the server reads the caller's uid and
   * nothing else, so a body here could only ever be somebody else's account.
   */
  it('asks for deletion on the signed-in caller alone', async () => {
    nextResult = { scheduledFor: 1_800_000_000, onChainRetained: true };
    await expect(api.requestAccountDeletion()).resolves.toEqual({
      scheduledFor: 1_800_000_000, onChainRetained: true,
    });
    await expect(api.requestAccountDeletion()).resolves.toMatchObject({
      name: 'requestAccountDeletion', payload: {},
    });
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
