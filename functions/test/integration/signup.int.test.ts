import { createHash, createHmac, createSign, generateKeyPairSync, randomBytes } from 'node:crypto';
import { Encoder } from 'cbor-x';
import { getAddress } from 'viem';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Hex } from '@monti/shared';
import { FakeRes } from '../helpers/webhookRes.js';

/**
 * 가입 한 줄 흐름을 **진짜 Firestore·Auth 에뮬레이터** 위에서 끝까지 돌린다.
 *
 * 유닛 테스트는 전부 `db.ts` 를 가짜 Map 으로 바꿔 놓고 돈다. 그래서 확인하지 못하는 것이 있다 —
 * 트랜잭션 직렬화, `set(..., {merge:true})` 의 중첩 맵 합치기, `FieldValue.delete()`,
 * 문서 id 규칙, 실제 문서에 남은 상태 위에서 도는 `assertStatusTransition`,
 * 그리고 Auth 사용자에 실제로 박히는 커스텀 클레임. 이 파일이 그 자리를 메운다.
 *
 * 진짜: Firestore·Auth 에뮬레이터, 봉투 암호화(`lib/kms.ts`), 전화번호 HMAC 색인,
 *       WebAuthn 등록·인증 검증(`@simplewebauthn/server`, 진짜 P-256 서명), Didit 서명 검증·레닥션,
 *       상태 전이표, 어테스터 리스.
 * 가짜: 체인(`lib/chain.js` 통째)과 KMS 랩(`@google-cloud/kms` 클라이언트) 둘뿐이다.
 *
 * 실행: `pnpm test:int` (firebase emulators:exec 안에서만 돈다).
 */
if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST) {
  throw new Error(
    'NO_EMULATOR: 이 파일은 에뮬레이터 안에서만 돈다. `pnpm test:int` 로 실행해라 ' +
      '(firebase emulators:exec --only firestore,auth --project mon-ti).',
  );
}

const PROJECT_ID = process.env.GCLOUD_PROJECT ?? 'mon-ti';
process.env.GCP_PROJECT_ID = PROJECT_ID;
process.env.RP_ID = 'monti.app';
process.env.DIDIT_WEBHOOK_SECRET = 'whsec-int';
process.env.PHONE_INDEX_KEY = 'phone-int-key';

const UID = 'int-uid';
const PHONE = '+821055556666';
const RP = 'monti.app';
const ORIGIN = `https://${RP}`;
const WEBHOOK_SECRET = 'whsec-int';
const PHONE_KEY = 'phone-int-key';
const SESSION_ID = 'int-session-1';

const IDENTITY = `0x${'11'.repeat(20)}` as Hex;
const FACTORY = `0x${'55'.repeat(20)}` as Hex;
/** 팩토리는 소문자를 돌려준다. 함수가 EIP-55 로 고쳐서 저장하는지 본다. */
const PREDICTED_LOWER = '0x9f8ab3c1d2e4f5061728394a5b6c7d8e9f0a1b2c';
const ACCOUNT = getAddress(PREDICTED_LOWER) as Hex;
const REGISTER_TX = `0x${'ab'.repeat(32)}` as Hex;
const KYC_TX = `0x${'cd'.repeat(32)}` as Hex;
const DEVICE_X = `0x${'11'.repeat(32)}` as Hex;
const DEVICE_Y = `0x${'22'.repeat(32)}` as Hex;

const NAME_LAST = '홍';
const NAME_FIRST = '길동';
const DOC_NUMBER = 'M12345678';
const PORTRAIT = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==';

/** 이 흐름이 건드려도 되는 컬렉션 전부. 마지막 테스트가 이 목록 밖의 컬렉션이 생겼는지 본다. */
const TOUCHED = [
  'authChallenges',
  'devices',
  'diditEvents',
  'kycSessions',
  'passkeys',
  'persons',
  'phoneIndex',
  'system',
  'users',
];

// ─────────────────────────────────────────────────────────────────────────────
// 체인과 KMS 랩만 가짜다. 그 밖의 모든 모듈은 진짜가 돈다.
// ─────────────────────────────────────────────────────────────────────────────

const { sendAttesterTx, awaitFinalized, readContract, waitForTransactionReceipt } = vi.hoisted(() => {
  const register = `0x${'ab'.repeat(32)}`;
  const kyc = `0x${'cd'.repeat(32)}`;
  const predicted = '0x9f8ab3c1d2e4f5061728394a5b6c7d8e9f0a1b2c';
  return {
    sendAttesterTx: vi.fn(async (tx: { functionName: string; args: readonly unknown[] }) =>
      tx.functionName === 'register' ? register : kyc,
    ),
    awaitFinalized: vi.fn(async (_blockNumber: bigint) => undefined),
    // `getAddress` 는 팩토리의 반사실적 주소, `isMember` 는 "체인이 아직 모른다".
    readContract: vi.fn(async ({ functionName }: { functionName: string }) =>
      functionName === 'getAddress' ? predicted : false,
    ),
    waitForTransactionReceipt: vi.fn(async ({ hash }: { hash: string }) => ({
      status: 'success',
      blockNumber: hash === register ? 42n : 43n,
    })),
  };
});

vi.mock('../../src/lib/chain.js', () => ({
  sendAttesterTx,
  awaitFinalized,
  publicClient: () => ({ readContract, waitForTransactionReceipt }),
  deployment: () => ({ identity: IDENTITY, coinbaseFactory: FACTORY }),
  gasLimitFor: (estimate: bigint) => estimate,
}));

vi.mock('@google-cloud/kms', async () => await import('../helpers/fakeKms.js'));

/**
 * `firebase-functions-test` 는 인자가 없으면 `GCLOUD_PROJECT` 를 'not-a-project' 로 덮어쓴다.
 * 에뮬레이터는 `singleProjectMode` 라 그 순간 모든 읽기·쓰기가 다른 프로젝트로 샌다.
 * 그래서 **먼저** 진짜 프로젝트 id 로 초기화하고, 그다음에 db.ts 를 불러온다.
 */
const functionsTest = (await import('firebase-functions-test')).default({
  projectId: PROJECT_ID,
  storageBucket: `${PROJECT_ID}.appspot.com`,
});

const { db, authAdmin, AUTH_CHALLENGES, DEVICES, KYC_SESSIONS, PASSKEYS, PERSONS, PHONE_INDEX, SYSTEM, USERS } =
  await import('../../src/lib/db.js');
const { decryptField, piiAad } = await import('../../src/lib/kms.js');
const { canonicalDiditJson } = await import('../../src/lib/didit.js');
const { hmacPhone } = await import('../../src/lib/phoneIndex.js');
const { startSignup } = await import('../../src/functions/startSignup.js');
const { registerPasskey } = await import('../../src/functions/registerPasskey.js');
const { registerIdentity } = await import('../../src/functions/registerIdentity.js');
const { loginChallenge, loginVerify } = await import('../../src/functions/login.js');
const { diditWebhook } = await import('../../src/functions/diditWebhook.js');

const callStartSignup = functionsTest.wrap(startSignup);
const callRegisterPasskey = functionsTest.wrap(registerPasskey);
const callRegisterIdentity = functionsTest.wrap(registerIdentity);
const callLoginChallenge = functionsTest.wrap(loginChallenge);
const callLoginVerify = functionsTest.wrap(loginVerify);

const auth = { uid: UID, token: { phone_number: PHONE } };

// ─────────────────────────────────────────────────────────────────────────────
// 진짜 인증기와 같은 구조의 WebAuthn 고정물. 등록과 로그인이 **같은 P-256 키**를 쓴다.
// ─────────────────────────────────────────────────────────────────────────────

const encoder = new Encoder({ useRecords: false, mapsAsObjects: false, tagUint8Array: false });
const passkey = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const credentialIdBytes = randomBytes(16);
const credentialId = credentialIdBytes.toString('base64url');

function coseKey(): Buffer {
  const jwk = passkey.publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  return Buffer.from(
    encoder.encode(
      new Map<number, unknown>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, Buffer.from(jwk.x, 'base64url')],
        [-3, Buffer.from(jwk.y, 'base64url')],
      ]),
    ),
  );
}

/** `fmt:'none'` 어테스테이션(자기 서명이 없어 서명 검증도 없다) — 실제 플랫폼 인증기와 같은 모양. */
function makeAttestation(challenge: string) {
  const cose = coseKey();
  const head = Buffer.alloc(37);
  createHash('sha256').update(RP).digest().copy(head, 0);
  head[32] = 0x45; // UP|UV|AT
  head.writeUInt32BE(0, 33);
  const credentialIdLength = Buffer.alloc(2);
  credentialIdLength.writeUInt16BE(credentialIdBytes.length, 0);
  const authData = Buffer.concat([head, Buffer.alloc(16, 0), credentialIdLength, credentialIdBytes, cose]);
  const attestationObject = Buffer.from(
    encoder.encode(
      new Map<string, unknown>([
        ['fmt', 'none'],
        ['attStmt', new Map()],
        ['authData', authData],
      ]),
    ),
  );
  const clientDataJSON = Buffer.from(
    JSON.stringify({ type: 'webauthn.create', challenge, origin: ORIGIN, crossOrigin: false }),
    'utf8',
  );
  return {
    cose,
    attestation: {
      id: credentialId,
      rawId: credentialId,
      type: 'public-key',
      clientExtensionResults: {},
      response: {
        clientDataJSON: clientDataJSON.toString('base64url'),
        attestationObject: attestationObject.toString('base64url'),
        transports: ['internal'],
      },
    },
  };
}

/** 진짜 ES256 서명이 붙은 어설션. 등록에 쓴 키로 서명한다. */
function makeAssertion(challenge: string, counter: number) {
  const authData = Buffer.alloc(37);
  createHash('sha256').update(RP).digest().copy(authData, 0);
  authData[32] = 0x05; // UP|UV
  authData.writeUInt32BE(counter, 33);
  const clientDataJSON = Buffer.from(
    JSON.stringify({ type: 'webauthn.get', challenge, origin: ORIGIN, crossOrigin: false }),
    'utf8',
  );
  const signature = createSign('SHA256')
    .update(Buffer.concat([authData, createHash('sha256').update(clientDataJSON).digest()]))
    .end()
    .sign(passkey.privateKey);
  return {
    id: credentialId,
    rawId: credentialId,
    type: 'public-key',
    clientExtensionResults: {},
    response: {
      clientDataJSON: clientDataJSON.toString('base64url'),
      authenticatorData: authData.toString('base64url'),
      signature: signature.toString('base64url'),
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Didit 웹훅 배달. 실제 핸들러를 그대로 부르고 rawBody 에 진짜 HMAC 서명을 붙인다.
// ─────────────────────────────────────────────────────────────────────────────

async function deliver(body: unknown): Promise<FakeRes> {
  const raw = JSON.stringify(body);
  const timestamp = Math.floor(Date.now() / 1000);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    // Didit 이 권하는 V2: **정규화 JSON** 에 대한 HMAC. 보내는 바이트가 아니라 값이 서명 대상이다.
    'x-signature-v2': createHmac('sha256', WEBHOOK_SECRET)
      .update(canonicalDiditJson(JSON.parse(raw)), 'utf8')
      .digest('hex'),
    'x-timestamp': String(timestamp),
  };
  const req = {
    method: 'POST',
    headers,
    rawBody: Buffer.from(raw, 'utf8'),
    get: (name: string) => headers[name.toLowerCase()],
  };
  const res = new FakeRes();
  await (diditWebhook as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res);
  await new Promise((resolve) => setImmediate(resolve));
  return res;
}

function approvedBody(personId: Hex): unknown {
  return {
    // 진짜 Firestore 위에서 `diditEvents/{event_id}` first-wins 도장까지 돈다.
    event_id: 'int-event-1',
    webhook_type: 'status.updated',
    session_id: SESSION_ID,
    status: 'Approved',
    vendor_data: personId,
    decision: {
      face_search: { status: 'clear', score: 0.01 },
      id_verification: {
        first_name: NAME_FIRST,
        last_name: NAME_LAST,
        document_number: DOC_NUMBER,
        portrait_image: PORTRAIT,
      },
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────

async function clearCollection(name: string): Promise<void> {
  const snap = await db.collection(name).get();
  await Promise.all(snap.docs.map((doc) => doc.ref.delete()));
}

async function everythingWritten(): Promise<string> {
  const parts: string[] = [];
  for (const name of TOUCHED) {
    const snap = await db.collection(name).get();
    for (const doc of snap.docs) parts.push(`${name}/${doc.id}=${JSON.stringify(doc.data())}`);
  }
  return parts.join('\n');
}

let personId: Hex;

beforeAll(async () => {
  await Promise.all(TOUCHED.map(clearCollection));
  await authAdmin.deleteUser(UID).catch(() => undefined);
  // 전화번호 인증으로 태어난 Auth 사용자. 커스텀 클레임이 실제로 박히려면 사용자가 있어야 한다.
  await authAdmin.createUser({ uid: UID, phoneNumber: PHONE });
});

describe('signup chain on the Firestore + Auth emulators', () => {
  it('1. startSignup creates a level-0 pending person, a user without the plaintext phone and one index entry', async () => {
    const result = (await callStartSignup({ data: {}, auth } as never)) as { personId: Hex };
    personId = result.personId;
    expect(personId).toMatch(/^0x[0-9a-f]{64}$/);

    const person = await db.collection(PERSONS).doc(personId).get();
    expect(person.get('status')).toBe('pending');
    expect(person.get('kycLevel')).toBe(0);
    expect(person.get('createdAt')).toBeDefined();
    expect(person.get('kyc')).toBeUndefined();

    // users 문서에 남는 번호의 파생물은 색인 HMAC 과 KMS 봉투 둘뿐이다.
    const user = await db.collection(USERS).doc(UID).get();
    expect(user.get('personId')).toBe(personId);
    expect(user.get('phoneHmac')).toBe(hmacPhone(PHONE, PHONE_KEY));
    expect(Object.keys(user.data() ?? {}).sort()).toEqual([
      'chatOrder',
      'createdAt',
      'locale',
      'personId',
      'phoneEnc',
      'phoneHmac',
    ]);

    const index = await db.collection(PHONE_INDEX).get();
    expect(index.size).toBe(1);
    expect(index.docs[0]!.id).toBe(hmacPhone(PHONE, PHONE_KEY));
    expect(index.docs[0]!.get('personId')).toBe(personId);

    // 봉투는 진짜 암호화 코드가 만든 것이고 `personId:phoneE164` 에 묶여 있다.
    const envelope = user.get('phoneEnc') as string;
    await expect(decryptField(envelope, piiAad(personId, 'phoneE164'))).resolves.toBe(PHONE);
    await expect(decryptField(envelope, piiAad(`0x${'00'.repeat(32)}` as Hex, 'phoneE164'))).rejects.toThrow();

    const written = await everythingWritten();
    expect(written).not.toContain(PHONE);
    expect(written).not.toContain('821055556666');
  });

  it('2. the webhook refuses to promote a person that is still pending, and writes nothing', async () => {
    // 상태 전이표는 pending → kyc_ok 를 막는다. 에뮬레이터에 실제로 남은 문서 위에서 돈다.
    await expect(deliver(approvedBody(personId))).rejects.toThrow('BAD_STATUS_TRANSITION:pending->kyc_ok');

    expect((await db.collection(KYC_SESSIONS).get()).size).toBe(0);
    // `event_id` 도장도 반납됐다 — 그대로 두면 Didit 의 재배달이 "이미 처리됨"으로 삼켜진다.
    expect((await db.collection('diditEvents').get()).size).toBe(0);
    const person = await db.collection(PERSONS).doc(personId).get();
    expect(person.get('status')).toBe('pending');
    expect(person.get('kycLevel')).toBe(0);
    expect(sendAttesterTx).not.toHaveBeenCalled();
  });

  it('3. registerPasskey consumes a real challenge and binds the counterfactual account to the person', async () => {
    const { challenge } = (await callLoginChallenge({ data: { purpose: 'register' } } as never)) as {
      challenge: string;
    };
    expect((await db.collection(AUTH_CHALLENGES).doc(challenge).get()).get('purpose')).toBe('register');

    const { attestation, cose } = makeAttestation(challenge);
    const result = (await callRegisterPasskey({ data: { personId, attestation }, auth } as never)) as {
      ok: true;
      account: Hex;
      credentialId: string;
    };

    expect(result.ok).toBe(true);
    expect(result.credentialId).toBe(credentialId);
    expect(result.account).toBe(ACCOUNT); // 팩토리가 준 소문자를 EIP-55 로 고쳐서 돌려준다
    expect(readContract.mock.calls[0]![0]).toMatchObject({ address: FACTORY, functionName: 'getAddress' });

    const stored = await db.collection(PASSKEYS).doc(credentialId).get();
    expect(stored.get('personId')).toBe(personId);
    expect(stored.get('publicKeyCose')).toBe(cose.toString('base64'));
    expect(stored.get('rpId')).toBe(RP);
    expect(stored.get('counter')).toBe(0);

    const consumed = await db.collection(AUTH_CHALLENGES).doc(challenge).get();
    expect(consumed.get('usedAt')).toBeDefined();

    // 계정만 붙었다. 상태는 아직 pending 이다 — 체인 등록이 끝나야 active 가 된다.
    const person = await db.collection(PERSONS).doc(personId).get();
    expect(person.get('account')).toBe(ACCOUNT);
    expect(person.get('status')).toBe('pending');

    const written = await everythingWritten();
    expect(written).not.toContain(attestation.response.attestationObject);
    expect(written).not.toContain(attestation.response.clientDataJSON);
  });

  it('4. registerIdentity sends register once, promotes pending → active and mints the session claims', async () => {
    const call = { data: { personId, deviceX: DEVICE_X, deviceY: DEVICE_Y, platform: 'ios' }, auth };
    const first = (await callRegisterIdentity(call as never)) as { txHash: Hex; claimsUpdated: true };
    const second = (await callRegisterIdentity(call as never)) as { txHash: Hex };

    expect(first.txHash).toBe(REGISTER_TX);
    expect(first.claimsUpdated).toBe(true);
    expect(second.txHash).toBe(first.txHash); // 두 번 불러도 체인 쓰기는 한 번이다
    expect(sendAttesterTx).toHaveBeenCalledTimes(1);
    expect(sendAttesterTx.mock.calls[0]![0]).toMatchObject({ address: IDENTITY, functionName: 'register' });
    expect(sendAttesterTx.mock.calls[0]![0].args).toEqual([personId, ACCOUNT, DEVICE_X, DEVICE_Y, 0]);
    expect(awaitFinalized).toHaveBeenCalledWith(42n);

    const person = await db.collection(PERSONS).doc(personId).get();
    expect(person.get('status')).toBe('active');
    expect(person.get('kycLevel')).toBe(0); // 가입에 본인인증은 없다
    expect(person.get('chain.registerTx')).toBe(REGISTER_TX);
    expect(person.get('chain.block')).toBe(42);
    // `FieldValue.delete()` 가 진짜 Firestore 에서 딱지만 지우고 해시는 남기는지 본다.
    expect(person.get('chain.registerPending')).toBeUndefined();
    expect(person.get('chain.registerPendingAt')).toBeUndefined();

    // 기기 문서는 보안 규칙이 클라이언트 생성을 막는다. 서버가 만들고 개인정보는 없다.
    const device = await db.collection(DEVICES).doc(ACCOUNT).get();
    expect(Object.keys(device.data() ?? {}).sort()).toEqual(['deviceX', 'deviceY', 'platform', 'updatedAt']);
    expect(device.get('deviceX')).toBe(DEVICE_X);
    expect(device.get('platform')).toBe('ios');

    // 어테스터 리스는 진짜 Firestore 트랜잭션으로 잡고 반납한다.
    expect((await db.collection(SYSTEM).doc('attester').get()).get('lockedUntil')).toBe(0);

    // 커스텀 클레임이 Auth 에뮬레이터의 사용자에 실제로 박힌다.
    const user = await authAdmin.getUser(UID);
    expect(user.customClaims).toEqual({ personId, account: ACCOUNT });
  });

  it('5. the Didit webhook takes active → kyc_ok → active with kycLevel 1 and stores only redacted PII', async () => {
    const res = await deliver(approvedBody(personId));
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('ok');

    expect(sendAttesterTx).toHaveBeenCalledTimes(2);
    expect(sendAttesterTx.mock.calls[1]![0]).toMatchObject({ functionName: 'setKycLevel' });
    expect(sendAttesterTx.mock.calls[1]![0].args).toEqual([personId, 1]);
    expect(awaitFinalized).toHaveBeenLastCalledWith(43n);

    const person = await db.collection(PERSONS).doc(personId).get();
    expect(person.get('status')).toBe('active');
    expect(person.get('kycLevel')).toBe(1);
    expect(person.get('kyc.status')).toBe('approved');
    expect(person.get('kyc.sessionId')).toBe(SESSION_ID);
    expect(person.get('chain.kycLevelTx')).toBe(KYC_TX);
    expect(person.get('chain.kycLevelError')).toBeNull();
    // 중첩 맵 merge 가 진짜 Firestore 에서 등록 해시를 지우지 않는지 본다.
    expect(person.get('chain.registerTx')).toBe(REGISTER_TX);

    // 개인정보는 봉투로만 남는다. AAD 가 다르면 열리지 않는다.
    await expect(decryptField(person.get('enc.name') as string, piiAad(personId, 'name'))).resolves.toBe(
      `${NAME_LAST}${NAME_FIRST}`,
    );
    await expect(decryptField(person.get('enc.docNumber') as string, piiAad(personId, 'docNumber'))).resolves.toBe(
      DOC_NUMBER,
    );
    await expect(decryptField(person.get('enc.name') as string, piiAad(personId, 'docNumber'))).rejects.toThrow();

    const session = await db.collection(KYC_SESSIONS).doc(SESSION_ID).get();
    expect(session.get('personId')).toBe(personId);
    expect(session.get('decision')).toBe('Approved');
    expect(session.get('raw.decision.face_search.status')).toBe('clear');

    const written = await everythingWritten();
    for (const secret of [NAME_FIRST, NAME_LAST, DOC_NUMBER, PORTRAIT.slice(-12)]) {
      expect(written).not.toContain(secret);
    }
  });

  it('6. a redelivered webhook is swallowed as a duplicate and never writes to the chain again', async () => {
    const res = await deliver(approvedBody(personId));
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('duplicate');
    expect(sendAttesterTx).toHaveBeenCalledTimes(2);
    expect((await db.collection(PERSONS).doc(personId).get()).get('kycLevel')).toBe(1);
  });

  it('7. loginVerify signs the same uid back in with the passkey that signup registered', async () => {
    const { challenge } = (await callLoginChallenge({ data: {} } as never)) as { challenge: string };
    const assertion = makeAssertion(challenge, 7);

    const result = (await callLoginVerify({ data: { assertion } } as never)) as {
      token: string;
      personId: Hex;
      account: Hex;
    };

    expect(result.personId).toBe(personId);
    expect(result.account).toBe(ACCOUNT);
    // 에뮬레이터가 서명한 커스텀 토큰. uid 는 가입 때 만든 그대로고 클레임은 두 개뿐이다.
    const payload = JSON.parse(Buffer.from(result.token.split('.')[1]!, 'base64url').toString('utf8')) as {
      uid: string;
      claims: Record<string, unknown>;
    };
    expect(payload.uid).toBe(UID);
    expect(payload.claims).toEqual({ personId, account: ACCOUNT });

    expect((await db.collection(PASSKEYS).doc(credentialId).get()).get('counter')).toBe(7);
    expect((await db.collection(AUTH_CHALLENGES).doc(challenge).get()).get('usedAt')).toBeDefined();

    // 같은 어설션을 다시 쓰면 챌린지가 이미 타 있다.
    await expect(callLoginVerify({ data: { assertion } } as never)).rejects.toThrow('CHALLENGE_USED');
  });

  it('8. the whole chain touched only the collections the spec allows it to', async () => {
    const collections = (await db.listCollections()).map((ref) => ref.id).sort();
    expect(collections).toEqual(TOUCHED);
  });
});
