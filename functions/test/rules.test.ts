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
const ROOT = join(process.cwd(), '..');

// `pnpm test:rules` 가 띄우는 에뮬레이터를 그대로 읽는다. 룰 스위트와 통합 스위트가
// 동시에 떠야 하니 포트를 테스트에 박지 않는다 — 박으면 둘이 같은 포트를 물고 죽는다.
//
// 포트만으로는 모자란다: `test:rules` 의 `--project demo-monti-rules` 도 함께 있어야 한다.
// 에뮬레이터 허브의 위치 파일이 `os.tmpdir()/hub-<projectId>.json` 이라 **포트가 아니라
// 프로젝트 id** 로 갈린다 — 둘이 같은 id 를 쓰면 포트를 나눠도 서로의 허브 파일을 덮어쓴다.
// `test:int` 의 `mon-ti` 로 "정리"하지 말 것.
const { host, port } = (
  JSON.parse(readFileSync(join(ROOT, 'firebase.rules.json'), 'utf8')) as {
    emulators: { firestore: { host: string; port: number } };
  }
).emulators.firestore;

let env: RulesTestEnvironment;

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: 'monti-rules-test',
    firestore: {
      rules: readFileSync(join(ROOT, 'firestore.rules'), 'utf8'),
      host,
      port,
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
    await db.doc('users/uid-1').set({ personId: '0xaa', phoneEnc: 'AQAdRkFLRS1FTlZFTE9QRQ==', locale: 'ko' });
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

  it('blocks writing personId or phoneEnc', async () => {
    await assertFails(owner().doc('users/uid-1').update({ personId: '0xbb' }));
    await assertFails(owner().doc('users/uid-1').update({ phoneEnc: 'AQAdT1RIRVItRU5WRUxPUEU=' }));
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

  // `pinned` 는 "주최자가 고정했다"는 권한 표현이다. 권한은 체인에만 있으므로(스펙 §9.4)
  // 규칙은 그것을 알 수 없고, 서버의 `pinMessage` 가 eth_call 로 확인하는 길 하나만 남긴다.
  it('blocks a client from creating a message that carries pinned', async () => {
    await assertFails(
      owner()
        .collection('eventChats/11/messages')
        .add({ uid: 'uid-1', text: 'hi', createdAt: 1, reported: 0, pinned: true }),
    );
  });

  it('blocks a client from setting pinned on an existing message', async () => {
    await env.withSecurityRulesDisabled(async (context) => {
      await context
        .firestore()
        .doc('eventChats/11/messages/m1')
        .set({ uid: 'uid-1', text: 'hi', createdAt: 1, reported: 0 });
    });
    await assertFails(owner().doc('eventChats/11/messages/m1').update({ pinned: true }));
  });
});

describe('deletionRequests', () => {
  beforeEach(async () => {
    await env.withSecurityRulesDisabled(async (context) => {
      await context
        .firestore()
        .doc('deletionRequests/uid-1')
        .set({ personId: '0xaa', status: 'pending', scheduledFor: 4102444800 });
    });
  });

  // 접수는 `requestAccountDeletion`, 실행은 `processDeletions` 뿐이다. 클라이언트가 직접
  // 쓰면 자기 유예 기한을 앞당기거나(`scheduledFor`) 남의 uid 로 파기를 걸 수 있다.
  it('blocks the owner from reading, creating, rescheduling or cancelling their own request', async () => {
    const db = owner();
    await assertFails(db.doc('deletionRequests/uid-1').get());
    await assertFails(db.doc('deletionRequests/uid-1').update({ scheduledFor: 1 }));
    await assertFails(db.doc('deletionRequests/uid-1').update({ status: 'done' }));
    await assertFails(db.doc('deletionRequests/uid-1').delete());
    await assertFails(db.doc('deletionRequests/uid-2').set({ personId: '0xbb', status: 'pending' }));
  });
});

describe('pendingGates', () => {
  const GATE = '0x1234123412341234123412341234123412341234';

  beforeEach(async () => {
    await env.withSecurityRulesDisabled(async (context) => {
      await context
        .firestore()
        .doc(`pendingGates/${GATE}`)
        .set({ eventId: '11', kx: '0x11', ky: '0x22', status: 'pending', submittedBy: 'uid-1' });
    });
  });

  // 큐에 올리는 것도 읽는 것도 callable 만 한다 — 제안은 `submitPendingGate`, 조회는
  // `listPendingGates` 이고 후자는 체인에서 게이트 관리 권한을 확인한다. 클라이언트가 직접
  // 읽으면 다른 공연의 단말기 키까지 보이고, 직접 쓰면 승인 화면에 아무 주소나 올릴 수 있다.
  it('blocks the client from reading the queue or writing into it', async () => {
    const db = owner();
    await assertFails(db.doc(`pendingGates/${GATE}`).get());
    await assertFails(db.collection('pendingGates').get());
    await assertFails(db.doc(`pendingGates/${GATE}`).update({ status: 'registered' }));
    await assertFails(db.doc(`pendingGates/${GATE}`).delete());
    await assertFails(
      db.doc('pendingGates/0x5555555555555555555555555555555555555555').set({ eventId: '11', status: 'pending' }),
    );
  });
});

describe('diditEvents', () => {
  const EVENT = 'evt-1';

  beforeEach(async () => {
    await env.withSecurityRulesDisabled(async (context) => {
      await context.firestore().doc(`diditEvents/${EVENT}`).set({ sessionId: 's1', status: 'Approved' });
    });
  });

  // Didit 웹훅의 중복 방지 장부. 여기에 쓸 수 있으면 아직 오지 않은 event_id 를 미리 찍어
  // 진짜 배달을 "이미 처리됨"으로 삼키게 만들 수 있고, 읽으면 남의 본인인증 진행이 보인다.
  it('blocks the client from reading the ledger or stamping an event of its own', async () => {
    const db = owner();
    await assertFails(db.doc(`diditEvents/${EVENT}`).get());
    await assertFails(db.collection('diditEvents').get());
    await assertFails(db.doc(`diditEvents/${EVENT}`).delete());
    await assertFails(db.doc('diditEvents/evt-2').set({ sessionId: 's2', status: 'Approved' }));
  });
});
