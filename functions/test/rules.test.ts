import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const ACCOUNT = '0x0000000000000000000000000000000000000001';
let env: RulesTestEnvironment;

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: 'monti-rules-test',
    firestore: {
      rules: readFileSync(join(process.cwd(), '..', 'firestore.rules'), 'utf8'),
      host: '127.0.0.1',
      port: 8089,
    },
  });
});

afterAll(async () => {
  await env.cleanup();
});

beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await db.doc(`devices/${ACCOUNT}`).set({ deviceX: '0x11', deviceY: '0x22', platform: 'ios' });
    await db.doc('users/uid-1').set({ personId: '0xaa', phoneE164: '+821011112222', locale: 'ko' });
    await db.doc('persons/0xaa').set({ status: 'active' });
    await db.doc('eventChats/11').set({ closed: false, endsAt: 4102444800, orgId: '1' });
    await db.doc('eventChats/11/members/uid-1').set({ account: ACCOUNT, joinedAt: 1 });
    await db.doc('eventChats/12').set({ closed: true, endsAt: 1, orgId: '1' });
    await db.doc('eventChats/12/members/uid-1').set({ account: ACCOUNT, joinedAt: 1 });
  });
});

function owner() {
  return env.authenticatedContext('uid-1', { account: ACCOUNT }).firestore();
}

describe('deny-all baseline', () => {
  it('blocks reading persons, passkeys, kycSessions, phoneIndex and transferInvites', async () => {
    const db = owner();
    await assertFails(db.doc('persons/0xaa').get());
    await assertFails(db.doc('passkeys/cred-1').get());
    await assertFails(db.doc('kycSessions/s1').get());
    await assertFails(db.doc('phoneIndex/abc').get());
    await assertFails(db.doc('transferInvites/i1').get());
    await assertFails(db.doc('invites/i1').get());
  });
});

describe('devices/{account}.pushToken', () => {
  it('lets the owning account update only pushToken', async () => {
    await assertSucceeds(owner().doc(`devices/${ACCOUNT}`).update({ pushToken: 'fcm-token' }));
  });

  it('blocks changing the device key', async () => {
    await assertFails(owner().doc(`devices/${ACCOUNT}`).update({ deviceX: '0xff' }));
  });

  it('blocks smuggling a second field alongside pushToken', async () => {
    await assertFails(owner().doc(`devices/${ACCOUNT}`).update({ pushToken: 'x', platform: 'web' }));
    await assertFails(owner().doc(`devices/${ACCOUNT}`).update({ pushToken: 'x', updatedAt: 1 }));
  });

  it('blocks another account', async () => {
    const other = env.authenticatedContext('uid-2', { account: '0x02' }).firestore();
    await assertFails(other.doc(`devices/${ACCOUNT}`).update({ pushToken: 'x' }));
  });
});

describe('users/{uid}', () => {
  it('lets the owner set nickname, locale and chatOrder', async () => {
    await assertSucceeds(
      owner().doc('users/uid-1').update({ nickname: 'alex', locale: 'en', chatOrder: ['11', '12'] }),
    );
  });

  it('blocks writing personId or phoneE164', async () => {
    await assertFails(owner().doc('users/uid-1').update({ personId: '0xbb' }));
    await assertFails(owner().doc('users/uid-1').update({ phoneE164: '+10000000000' }));
  });

  it('blocks an unsupported locale', async () => {
    await assertFails(owner().doc('users/uid-1').update({ locale: 'fr' }));
  });
});

describe('eventChats messages', () => {
  it('lets a member post in an open chat', async () => {
    await assertSucceeds(
      owner().collection('eventChats/11/messages').add({ uid: 'uid-1', text: '안녕하세요', createdAt: 1, reported: 0 }),
    );
  });

  it('blocks a message missing a required field', async () => {
    await assertFails(owner().collection('eventChats/11/messages').add({ uid: 'uid-1', text: 'hi', createdAt: 1 }));
    await assertFails(owner().collection('eventChats/11/messages').add({ uid: 'uid-1', text: 'hi', reported: 0 }));
  });

  it('blocks a message longer than 500 characters', async () => {
    await assertFails(
      owner().collection('eventChats/11/messages').add({ uid: 'uid-1', text: 'x'.repeat(501), createdAt: 1, reported: 0 }),
    );
  });

  it('blocks posting as somebody else', async () => {
    await assertFails(
      owner().collection('eventChats/11/messages').add({ uid: 'uid-2', text: 'hi', createdAt: 1, reported: 0 }),
    );
  });

  it('blocks posting into a closed chat', async () => {
    await assertFails(
      owner().collection('eventChats/12/messages').add({ uid: 'uid-1', text: 'hi', createdAt: 1, reported: 0 }),
    );
  });

  it('blocks a non-member from reading or posting', async () => {
    const stranger = env.authenticatedContext('uid-9', {}).firestore();
    await assertFails(stranger.collection('eventChats/11/messages').get());
    await assertFails(
      stranger.collection('eventChats/11/messages').add({ uid: 'uid-9', text: 'hi', createdAt: 1, reported: 0 }),
    );
  });

  it('blocks joining the chat from the client', async () => {
    const stranger = env.authenticatedContext('uid-9', {}).firestore();
    await assertFails(stranger.doc('eventChats/11/members/uid-9').set({ account: '0x09', joinedAt: 1 }));
  });
});
