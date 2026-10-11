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
    await db.doc('relays/r1').set({ personId: '0xaa', account: ACCOUNT, kind: 'claim', status: 'sent' });
    await db.doc('admissions/7/tokens/42').set({ status: 'passing', gateId: 'g1', relayId: 'r1' });
    await db.doc('settlements/42').set({ policyHash: '0x00', policy: { recipients: [], platformBps: 2000 } });
    await db.doc('orders/o1').set({ personId: '0xaa', account: ACCOUNT, eventId: '42', tier: 0, status: 'deposited' });
    await db.doc('overrideRequests/q1').set({
      eventId: '1001', tokenId: '1', gateId: '3', reason: 2, requesterAccount: ACCOUNT, requesterPersonId: '0xaa', status: 'open',
    });
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

  /**
   * 티켓에 찍히는 표시 이름. 체인 닉네임과 다른 칸이라 **한글이 들어온다** — 24 자는
   * 한글로 세어 24 자여야 한다(바이트로 재면 여덟 자에서 막힌다). 여기서 막히면 증상은
   * 화면의 검증 메시지가 아니라 권한 오류이고, 사용자는 왜 안 되는지 볼 수단이 없다.
   */
  it('lets the owner set a Korean displayName of exactly 24 characters', async () => {
    await assertSucceeds(owner().doc('users/uid-1').update({ displayName: '김'.repeat(24) }));
    await assertSucceeds(owner().doc('users/uid-1').update({ displayName: '김태완' }));
    await assertSucceeds(owner().doc('users/uid-1').update({ displayName: ' 김태완 ' }));
  });

  it('blocks a displayName of 25 characters', async () => {
    await assertFails(owner().doc('users/uid-1').update({ displayName: '김'.repeat(25) }));
    await assertFails(owner().doc('users/uid-1').update({ displayName: 'x'.repeat(25) }));
  });

  // 앞뒤 공백을 지우고 재므로, 공백 24 칸은 24 자가 아니라 0 자다. 빈 이름은 티켓에
  // 아무것도 그리지 않는 것이 규칙이지 공백을 그리는 것이 아니다.
  it('blocks an empty, blank or non-string displayName', async () => {
    const db = owner();
    await assertFails(db.doc('users/uid-1').update({ displayName: '' }));
    await assertFails(db.doc('users/uid-1').update({ displayName: '   ' }));
    await assertFails(db.doc('users/uid-1').update({ displayName: 7 }));
    await assertFails(db.doc('users/uid-1').update({ displayName: ['김태완'] }));
  });

  // 제어문자는 티켓 SVG 의 한 줄을 깨뜨린다.
  it('blocks a displayName carrying a control character', async () => {
    const db = owner();
    await assertFails(db.doc('users/uid-1').update({ displayName: '김\n태완' }));
    await assertFails(db.doc('users/uid-1').update({ displayName: '김\u0000태완' }));
  });

  it('blocks a stranger from setting the displayName', async () => {
    const other = env.authenticatedContext('uid-2', { account: '0x02' }).firestore();
    await assertFails(other.doc('users/uid-1').update({ displayName: '가로채기' }));
  });

  // 허용 목록에 한 칸이 늘었다고 그 옆에 다른 칸을 실어 보낼 수 있으면 안 된다.
  it('blocks a protected field smuggled in alongside the displayName', async () => {
    const db = owner();
    await assertFails(db.doc('users/uid-1').update({ displayName: '김태완', personId: '0xbb' }));
    await assertFails(db.doc('users/uid-1').update({ displayName: '김태완', phoneHmac: 'hmac-2' }));
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

describe('orgProfiles', () => {
  beforeEach(async () => {
    await env.withSecurityRulesDisabled(async (context) => {
      await context
        .firestore()
        .doc('orgProfiles/42')
        .set({ orgId: '42', name: '모나드 컴퍼니', ownerPersonId: '0xaa', ownerAccount: ACCOUNT });
    });
  });

  // 주최사 이름은 공개 정보다 — 탐색·공연 화면이 "누가 여는 공연인가" 를 그리려면 읽혀야 한다.
  it('lets any signed-in user read an organizer display name', async () => {
    await assertSucceeds(owner().doc('orgProfiles/42').get());
    await assertSucceeds(env.authenticatedContext('uid-9', {}).firestore().doc('orgProfiles/42').get());
  });

  it('blocks a signed-out reader', async () => {
    await assertFails(env.unauthenticatedContext().firestore().doc('orgProfiles/42').get());
  });

  // 쓰는 길은 `createOrganizerForMe` 하나다. 클라이언트가 쓸 수 있으면 남의 주최사 이름을
  // 바꾸거나 체인에 없는 주최사를 지어내 공연 화면에 띄울 수 있다.
  it('blocks every client write — create, rename and delete alike', async () => {
    const db = owner();
    await assertFails(db.doc('orgProfiles/42').update({ name: '가짜 컴퍼니' }));
    await assertFails(db.doc('orgProfiles/42').update({ ownerAccount: '0x02' }));
    await assertFails(db.doc('orgProfiles/42').delete());
    await assertFails(db.doc('orgProfiles/99').set({ orgId: '99', name: '없는 주최사' }));
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

describe('eventArt', () => {
  beforeEach(async () => {
    await env.withSecurityRulesDisabled(async (context) => {
      await context
        .firestore()
        .doc('eventArt/11')
        .set({ tiers: [{ preset: 'a' }, { imageCid: `bafk${'a'.repeat(55)}` }], updatedAt: 1 });
    });
  });

  // 티켓 그림은 공개 정보다 — 목록 한 화면이 여러 공연의 그림을 그리므로 콜러블로 감싸면
  // 콜드 스타트가 그대로 빈칸이 된다. `orgProfiles` 와 같은 모양이다.
  it('lets any signed-in user read the art of an event', async () => {
    await assertSucceeds(owner().doc('eventArt/11').get());
    await assertSucceeds(env.authenticatedContext('uid-9', {}).firestore().doc('eventArt/11').get());
  });

  it('blocks a signed-out reader', async () => {
    await assertFails(env.unauthenticatedContext().firestore().doc('eventArt/11').get());
  });

  // 쓰는 길은 `saveEventArt` 하나다 — 주최자 판정은 체인에서만 할 수 있고 규칙은 체인을 못 읽는다.
  // 클라이언트가 쓸 수 있으면 남의 공연 티켓에 아무 그림이나 붙일 수 있다.
  it('blocks every client write — create, change and delete alike', async () => {
    const db = owner();
    await assertFails(db.doc('eventArt/11').update({ tiers: [{ preset: 'd' }] }));
    await assertFails(db.doc('eventArt/11').delete());
    await assertFails(db.doc('eventArt/99').set({ tiers: [{ preset: 'a' }] }));
  });
});

describe('eventPrivate', () => {
  beforeEach(async () => {
    await env.withSecurityRulesDisabled(async (context) => {
      await context.firestore().doc('eventPrivate/11').set({ venue: '올림픽공원 K-아트홀', updatedAt: 1 });
    });
  });

  // 규칙은 체인을 읽을 수 없어 "티켓을 들고 있는가"를 판정하지 못한다. 그 판정은
  // `getEventPrivate` 이 eth_call 로 하고, 문서 자체는 서버 말고 아무도 닿지 못한다.
  it('blocks the client from reading or writing a private venue directly', async () => {
    const db = owner();
    await assertFails(db.doc('eventPrivate/11').get());
    await assertFails(db.collection('eventPrivate').get());
    await assertFails(db.doc('eventPrivate/11').update({ venue: '다른 곳' }));
    await assertFails(db.doc('eventPrivate/11').delete());
    await assertFails(db.doc('eventPrivate/99').set({ venue: '없는 공연' }));
  });
});

describe('eventDrafts/{uid}/drafts/{draftId}', () => {
  const MINE = 'eventDrafts/uid-1/drafts/d1';
  const THEIRS = 'eventDrafts/uid-2/drafts/d1';
  const draft = {
    title: '모나드 데모 나이트',
    body: '한 줄 소개',
    tags: ['모나드', '해커톤'],
    posterCid: `bafk${'a'.repeat(55)}`,
    tiers: [{ name: '일반', supply: 100 }],
  };

  // W5 뒤의 티켓 종류 한 줄. 그림은 글자 프리셋이거나 올린 그림의 CID 다.
  const tier = {
    name: '일반',
    supply: 100,
    maxPerWallet: 1,
    currency: 'free',
    amount: 0,
    transferable: true,
    transferCutoffHours: 2,
    art: { preset: 'a' },
  };

  // W2 의 훅이 실제로 보내는 문서 그대로 — `updatedAt` 은 서버 스탬프(규칙에는 timestamp 로
  // 도착한다), `submittedOpHash` 는 아직 공개 전이라 빈 문자열이다.
  const webDraft = {
    orgId: '42',
    title: '모나드 데모 나이트',
    description: '한 줄 소개',
    posterCid: `bafk${'a'.repeat(55)}`,
    category: 0,
    tags: ['모나드', '해커톤'],
    regionCode: 'KR-11',
    venue: '올림픽공원 K-아트홀',
    venueHidden: false,
    startsAt: 1_767_225_600,
    endsAt: 1_767_232_800,
    timeHidden: false,
    transferable: true,
    transferCutoffHours: 2,
    requireKyc: false,
    tiers: [
      tier,
      {
        name: 'VIP',
        supply: 20,
        maxPerWallet: 2,
        currency: 'USDC',
        amount: 49.5,
        transferable: false,
        transferCutoffHours: 0,
        art: { imageCid: `bafk${'b'.repeat(55)}` },
      },
    ],
    submittedOpHash: '',
    updatedAt: new Date(),
  };

  beforeEach(async () => {
    await env.withSecurityRulesDisabled(async (context) => {
      await context.firestore().doc(MINE).set(draft);
      await context.firestore().doc(THEIRS).set(draft);
    });
  });

  // 초안은 클라이언트가 직접 쓴다 — 2초 디바운스마다 콜러블을 부르면 비용도 지연도 나쁘다.
  it('lets the owner create, read, update and delete their own drafts', async () => {
    const db = owner();
    await assertSucceeds(db.doc(MINE).get());
    await assertSucceeds(db.doc(MINE).update({ title: '이름을 바꿨다' }));
    await assertSucceeds(db.doc('eventDrafts/uid-1/drafts/d2').set(draft));
    await assertSucceeds(db.collection('eventDrafts/uid-1/drafts').get());
    await assertSucceeds(db.doc(MINE).delete());
  });

  // 초안은 아직 아무것도 아닌 글이다. 남의 것은 읽지도 쓰지도 못한다.
  it("blocks a stranger from every operation on somebody else's draft", async () => {
    const db = owner();
    await assertFails(db.doc(THEIRS).get());
    await assertFails(db.collection('eventDrafts/uid-2/drafts').get());
    await assertFails(db.doc(THEIRS).update({ title: '가로채기' }));
    await assertFails(db.doc('eventDrafts/uid-2/drafts/d9').set(draft));
    await assertFails(db.doc(THEIRS).delete());
  });

  it('blocks a signed-out client entirely', async () => {
    const out = env.unauthenticatedContext().firestore();
    await assertFails(out.doc(MINE).get());
    await assertFails(out.doc(MINE).set(draft));
  });

  /**
   * 규칙에는 문서 크기를 재는 수단이 없다(`request.resource.size()` 는 없는 함수다).
   * 상한이 칸마다 걸려 있지 않으면 한 사람이 자기 초안 하나로 1 MiB 를 채운다.
   */
  it('blocks an oversize body, title, poster CID, tag list or tier list', async () => {
    const db = owner();
    await assertFails(db.doc(MINE).update({ body: 'x'.repeat(5001) }));
    await assertFails(db.doc(MINE).update({ title: 'x'.repeat(81) }));
    await assertFails(db.doc(MINE).update({ posterCid: 'x'.repeat(81) }));
    await assertFails(db.doc(MINE).update({ tags: ['1', '2', '3', '4', '5', '6'] }));
    await assertFails(db.doc(MINE).update({ tiers: Array.from({ length: 9 }, () => ({})) }));
    await assertFails(db.doc('eventDrafts/uid-1/drafts/d3').set({ ...draft, body: 'x'.repeat(5001) }));
  });

  it('takes the limits exactly at the edge', async () => {
    const db = owner();
    await assertSucceeds(db.doc(MINE).update({ body: 'x'.repeat(5000) }));
    await assertSucceeds(db.doc(MINE).update({ title: 'x'.repeat(80) }));
    await assertSucceeds(db.doc(MINE).update({ tags: ['1', '2', '3', '4', '5'] }));
    await assertSucceeds(db.doc(MINE).update({ tiers: Array.from({ length: 8 }, () => ({})) }));
  });

  // 포스터는 CID 한 줄로만 들어온다. 바이트를 담으려 하면 그 자리에서 막힌다 —
  // 600 KB JPEG 의 base64 는 800 KB 라 Firestore 문서 상한 1 MiB 에 여유가 없다(계획 C절).
  it('blocks a field of the wrong type, so bytes cannot be smuggled into a string slot', async () => {
    const db = owner();
    await assertFails(db.doc(MINE).update({ title: 7 }));
    await assertFails(db.doc(MINE).update({ posterCid: { base64: 'x' } }));
    await assertFails(db.doc(MINE).update({ tags: 'not-a-list' }));
  });

  // 훅이 보내는 문서가 규칙을 그대로 통과해야 한다 — 통과하지 못하면 저장 실패는 화면의
  // 검증 메시지가 아니라 권한 오류이고, 조직자는 왜 안 되는지 볼 수단이 없다.
  it("accepts the whole document the web's draft hook writes", async () => {
    const db = owner();
    await assertSucceeds(db.doc('eventDrafts/uid-1/drafts/d4').set(webDraft));
    await assertSucceeds(db.doc(MINE).update({ updatedAt: new Date(), tiers: webDraft.tiers }));
    await assertSucceeds(db.doc(MINE).update({ submittedOpHash: `0x${'a'.repeat(64)}` }));
    await assertSucceeds(db.doc(MINE).update({ submittedOpHash: '' }));
  });

  // W2 가 아직 쓰고 있는 옛 모양(`art` 대신 `design`/`imageCid` 를 종류에 납작하게 둔 것)도
  // 그대로 지나가야 한다. 규칙이 웹보다 먼저 올라가는 일이 있고, 그때 저장이 멈추면 안 된다.
  it("accepts the tier shape the web writes today, before art lands", async () => {
    await assertSucceeds(
      owner()
        .doc(MINE)
        .update({
          tiers: [{ name: '일반', supply: 100, maxPerWallet: 1, currency: 'free', amount: 0, design: 'aurora', imageCid: '' }],
        }),
    );
  });

  /**
   * 이 테스트가 이 블록에서 가장 중요하다. 규칙 엔진은 요청 하나에 **표현식 1,000개**가
   * 상한이고, 목록을 돌 수 없어 8칸을 손으로 편 탓에 종류마다 붙는 검사 값이 여덟 배가 된다.
   * 종류 검사를 하나만 더 늘려도 여기서 6칸째부터 BUDGET 오류로 저장이 통째로 거부된다 —
   * 조직자에게는 "티켓 종류를 여섯 개 넣으면 초안이 사라진다"로 보인다. 규칙의 종류 검사를
   * 건드린 사람은 이 테스트로 예산을 다시 재게 된다.
   */
  it('takes eight fully filled tiers at once — the rule budget has to hold', async () => {
    const eight = Array.from({ length: 8 }, (_, i) => ({
      ...tier,
      name: `종류 ${i}`,
      supply: 100_000,
      maxPerWallet: 20,
      currency: 'USDT',
      amount: 12.5,
      transferCutoffHours: 24,
      art: { imageCid: `bafk${'c'.repeat(55)}` },
    }));
    await assertSucceeds(owner().doc(MINE).update({ tiers: eight }));
  });

  // 통화는 체인이 아는 네 가지뿐이다. 마지막 줄은 두 번째 칸도 실제로 검사된다는 확인이다 —
  // 0번만 보면 두 번째 종류로 그대로 빠져나간다.
  it('blocks a tier currency the chain does not know', async () => {
    const db = owner();
    await assertFails(db.doc(MINE).update({ tiers: [{ ...tier, currency: 'KRW' }] }));
    await assertFails(db.doc(MINE).update({ tiers: [{ ...tier, currency: 'mon' }] }));
    await assertFails(db.doc(MINE).update({ tiers: [{ ...tier, currency: 7 }] }));
    await assertFails(db.doc(MINE).update({ tiers: [tier, { ...tier, currency: 'KRW' }] }));
  });

  // 종류 이름이 바이트를 담는 자리가 되면 안 된다. 여덟 종류 × 상한 없는 이름이면
  // 초안 하나가 그대로 1 MiB 다.
  it('blocks an oversize tier name, in the first slot and in the last', async () => {
    const db = owner();
    await assertFails(db.doc(MINE).update({ tiers: [{ ...tier, name: 'x'.repeat(41) }] }));
    await assertFails(db.doc(MINE).update({ tiers: [{ ...tier, name: 7 }] }));
    await assertFails(
      db.doc(MINE).update({
        tiers: [...Array.from({ length: 7 }, () => tier), { ...tier, name: 'x'.repeat(41) }],
      }),
    );
  });

  // 번들된 글자는 열둘이다(`eventArt.ts` 의 `ART_PRESETS`). 마지막 글자가 여기서 막히면
  // 그 그림을 고른 순간부터 초안 자동저장이 통째로 권한 오류가 된다.
  it('takes every bundled preset letter, first to last', async () => {
    const db = owner();
    for (const preset of ['a', 'e', 'h', 'l']) {
      await assertSucceeds(db.doc(MINE).update({ tiers: [{ ...tier, art: { preset } }] }));
    }
  });

  // 그림 칸이 잠겨 있지 않으면 거기가 base64 바이트를 담는 자리가 된다.
  it('blocks ticket art that is neither a preset letter nor a CID', async () => {
    const db = owner();
    await assertFails(db.doc(MINE).update({ tiers: [{ ...tier, art: { preset: 'm' } }] }));
    await assertFails(db.doc(MINE).update({ tiers: [{ ...tier, art: { preset: 'A' } }] }));
    await assertFails(db.doc(MINE).update({ tiers: [{ ...tier, art: { preset: 'aurora' } }] }));
    await assertFails(db.doc(MINE).update({ tiers: [{ ...tier, art: { base64: 'x'.repeat(40) } }] }));
    await assertFails(db.doc(MINE).update({ tiers: [{ ...tier, art: { imageCid: 'x'.repeat(81) } }] }));
    await assertFails(db.doc(MINE).update({ tiers: [{ ...tier, art: { imageCid: 7 } }] }));
    await assertFails(db.doc(MINE).update({ tiers: [{ ...tier, art: 'a' }] }));
  });

  // `updatedAt` 은 "가장 최근 초안"을 고르는 정렬 키다 — 숫자를 섞으면 이어쓰기가 엉뚱한
  // 초안을 연다. `submittedOpHash` 는 빈 문자열이거나 0x + 64 hex 딱 하나다.
  it('blocks a hand-stamped updatedAt and a malformed submittedOpHash', async () => {
    const db = owner();
    await assertFails(db.doc(MINE).update({ updatedAt: 1 }));
    await assertFails(db.doc(MINE).update({ updatedAt: '2026-09-22' }));
    await assertFails(db.doc(MINE).update({ submittedOpHash: '0xnope' }));
    await assertFails(db.doc(MINE).update({ submittedOpHash: `0x${'a'.repeat(63)}` }));
    await assertFails(db.doc(MINE).update({ submittedOpHash: `0x${'a'.repeat(65)}` }));
    await assertFails(db.doc(MINE).update({ submittedOpHash: 7 }));
  });

  // 웹이 쓰는 본문 칸의 이름은 `description` 이다. `body` 만 재면 본문이 상한 없는 칸이 되어
  // 문서 하나로 1 MiB 를 채울 수 있다.
  it('caps description the same way it caps body', async () => {
    const db = owner();
    await assertSucceeds(db.doc(MINE).update({ description: 'x'.repeat(5000) }));
    await assertFails(db.doc(MINE).update({ description: 'x'.repeat(5001) }));
  });
});

describe('relays/{relayId}', () => {
  // 소유자 판정은 토큰의 personId 클레임과 문서의 personId 다(mintSessionClaims 와 같은 모양).
  function attendee() {
    return env.authenticatedContext('uid-1', { account: ACCOUNT, personId: '0xaa' }).firestore();
  }

  it('lets the owning person read their own relay', async () => {
    await assertSucceeds(attendee().doc('relays/r1').get());
  });

  it("blocks reading another person's relay", async () => {
    const other = env.authenticatedContext('uid-2', { account: '0x02', personId: '0xbb' }).firestore();
    await assertFails(other.doc('relays/r1').get());
  });

  it('blocks an anonymous read', async () => {
    await assertFails(env.unauthenticatedContext().firestore().doc('relays/r1').get());
  });

  it('blocks client writes even by the owner (server-only)', async () => {
    await assertFails(attendee().doc('relays/r1').set({ status: 'confirmed' }, { merge: true }));
    await assertFails(attendee().doc('relays/r2').set({ personId: '0xaa', status: 'pending' }));
  });
});

describe('admissions/{eventId}/tokens/{tokenId}', () => {
  it('lets any signed-in session read an admission token (staff/gate)', async () => {
    await assertSucceeds(owner().doc('admissions/7/tokens/42').get());
    const staff = env.authenticatedContext('uid-2', { account: '0x02', personId: '0xbb' }).firestore();
    await assertSucceeds(staff.doc('admissions/7/tokens/42').get());
  });

  it('blocks an anonymous read', async () => {
    await assertFails(env.unauthenticatedContext().firestore().doc('admissions/7/tokens/42').get());
  });

  it('blocks client writes (server-only)', async () => {
    await assertFails(owner().doc('admissions/7/tokens/42').set({ status: 'confirmed' }, { merge: true }));
    await assertFails(owner().doc('admissions/7/tokens/99').set({ status: 'passing' }));
  });
});

describe('usage/{scope}', () => {
  // 대납 가스 사용 원장(설계 §4). 서버(Admin SDK)만 읽고 쓴다 — 클라이언트는 어느 scope 도 못 본다.
  it('blocks client reads and writes (server-only ledger)', async () => {
    const client = env.authenticatedContext('uid-1', { account: ACCOUNT, personId: '0xaa' }).firestore();
    await assertFails(client.doc('usage/org:7').get());
    await assertFails(client.doc('usage/person:0xaa').get());
    await assertFails(client.doc('usage/org:7').set({ monSpentWei: '0', count: 1 }));
    await assertFails(env.unauthenticatedContext().firestore().doc('usage/org:7').get());
  });
});

describe('settlements/{eventId}', () => {
  it('lets anyone (even anonymous) read the public settlement mirror', async () => {
    await assertSucceeds(owner().doc('settlements/42').get());
    await assertSucceeds(env.unauthenticatedContext().firestore().doc('settlements/42').get());
  });

  it('blocks client writes (server-only)', async () => {
    await assertFails(owner().doc('settlements/42').set({ policyHash: '0xff' }, { merge: true }));
    await assertFails(owner().doc('settlements/99').set({ policyHash: '0x01' }));
  });
});

describe('orders/{orderId}', () => {
  function buyer() {
    return env.authenticatedContext('uid-1', { account: ACCOUNT, personId: '0xaa' }).firestore();
  }

  it('lets the owning person read their own order', async () => {
    await assertSucceeds(buyer().doc('orders/o1').get());
  });

  it("blocks reading another person's order", async () => {
    const other = env.authenticatedContext('uid-2', { account: '0x02', personId: '0xbb' }).firestore();
    await assertFails(other.doc('orders/o1').get());
  });

  it('blocks an anonymous read', async () => {
    await assertFails(env.unauthenticatedContext().firestore().doc('orders/o1').get());
  });

  it('blocks client writes even by the owner (server-only)', async () => {
    await assertFails(buyer().doc('orders/o1').set({ status: 'refunded' }, { merge: true }));
    await assertFails(buyer().doc('orders/o2').set({ personId: '0xaa', status: 'pending' }));
  });
});

describe('nicknames/{name}', () => {
  it('blocks client reads and writes (server-only book)', async () => {
    await env.withSecurityRulesDisabled(async (context) => {
      await context.firestore().doc('nicknames/alex').set({ personId: '0xaa', account: ACCOUNT, display: 'Alex' });
    });
    const client = env.authenticatedContext('uid-1', { account: ACCOUNT, personId: '0xaa' }).firestore();
    await assertFails(client.doc('nicknames/alex').get());
    await assertFails(client.doc('nicknames/alex').set({ personId: '0xaa' }, { merge: true }));
    await assertFails(client.doc('nicknames/bob').set({ personId: '0xaa', account: ACCOUNT }));
    await assertFails(env.unauthenticatedContext().firestore().doc('nicknames/alex').get());
  });
});

describe('overrideRequests/{requestId}', () => {
  function requester() {
    return env.authenticatedContext('uid-1', { account: ACCOUNT, personId: '0xaa' }).firestore();
  }

  it('lets the requesting staff member read their own request', async () => {
    await assertSucceeds(requester().doc('overrideRequests/q1').get());
  });

  it("blocks reading another person's request and anonymous reads", async () => {
    const other = env.authenticatedContext('uid-2', { account: '0x02', personId: '0xbb' }).firestore();
    await assertFails(other.doc('overrideRequests/q1').get());
    await assertFails(env.unauthenticatedContext().firestore().doc('overrideRequests/q1').get());
  });

  it('blocks client writes even by the requester (server-only)', async () => {
    await assertFails(requester().doc('overrideRequests/q1').set({ status: 'approved' }, { merge: true }));
    await assertFails(requester().doc('overrideRequests/q2').set({ requesterPersonId: '0xaa', status: 'open' }));
  });
});
