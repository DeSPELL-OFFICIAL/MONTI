import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { declineReason, redactDiditPayload, verifyDiditSignature } from '../src/lib/didit.js';

const SECRET = 'whsec-monti';
const RAW = '{"session_id":"s1","status":"Approved","vendor_data":"0xaa"}';
const NOW = 1_789_862_400;
const SIG = createHmac('sha256', SECRET).update(RAW, 'utf8').digest('hex');

describe('verifyDiditSignature', () => {
  it('accepts a correct signature inside the 300 s window', () => {
    expect(verifyDiditSignature({ raw: RAW, signature: SIG, timestamp: NOW, secret: SECRET, now: NOW })).toBe(true);
    expect(verifyDiditSignature({ raw: RAW, signature: SIG, timestamp: NOW - 299, secret: SECRET, now: NOW })).toBe(true);
  });

  it('rejects a stale or future timestamp', () => {
    expect(verifyDiditSignature({ raw: RAW, signature: SIG, timestamp: NOW - 301, secret: SECRET, now: NOW })).toBe(false);
    expect(verifyDiditSignature({ raw: RAW, signature: SIG, timestamp: NOW + 301, secret: SECRET, now: NOW })).toBe(false);
  });

  it('rejects a wrong signature, a wrong body and a wrong secret', () => {
    expect(verifyDiditSignature({ raw: RAW, signature: 'deadbeef', timestamp: NOW, secret: SECRET, now: NOW })).toBe(false);
    expect(verifyDiditSignature({ raw: `${RAW} `, signature: SIG, timestamp: NOW, secret: SECRET, now: NOW })).toBe(false);
    expect(verifyDiditSignature({ raw: RAW, signature: SIG, timestamp: NOW, secret: 'other', now: NOW })).toBe(false);
  });
});

describe('redactDiditPayload', () => {
  it('removes every PII field at any depth but keeps decision fields', () => {
    const redacted = redactDiditPayload({
      session_id: 's1',
      status: 'Approved',
      vendor_data: '0xaa',
      decision: {
        id_verification: { first_name: '길동', last_name: '홍', document_number: 'M12345678', portrait_image: 'data:...' },
        face_search: { status: 'clear', score: 0.1 },
      },
    }) as Record<string, Record<string, Record<string, unknown>>>;

    expect(redacted.decision.id_verification.first_name).toBe('[redacted]');
    expect(redacted.decision.id_verification.document_number).toBe('[redacted]');
    expect(redacted.decision.id_verification.portrait_image).toBe('[redacted]');
    expect(redacted.decision.face_search.status).toBe('clear');
    expect((redacted as unknown as { session_id: string }).session_id).toBe('s1');
  });
});

describe('declineReason', () => {
  // 웹은 이 네 값마다 다른 안내를 그린다. 값이 하나라도 늘거나 바뀌면 그 화면이 빈다.
  it('folds every Didit outcome into exactly four codes', () => {
    expect(declineReason('Declined', null)).toBe('declined');
    expect(declineReason('Expired', 'clear')).toBe('declined');
    expect(declineReason('Abandoned', 'duplicate')).toBe('declined');
    expect(declineReason('Approved', null)).toBe('face_search_missing');
    expect(declineReason('Approved', 'duplicate')).toBe('duplicate_face');
    expect(declineReason('Approved', 'in_review')).toBe('face_search_not_clear');
    expect(declineReason('Approved', '')).toBe('face_search_not_clear');
  });

  it('never calls a missing face search a duplicate — that copy says "이미 계정이 있습니다"', () => {
    expect(declineReason('Approved', null)).not.toBe('duplicate_face');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// diditWebhook — 서명 검증 · 멱등 · 레닥션이 실제 핸들러에서 함께 도는지 본다.
// ─────────────────────────────────────────────────────────────────────────────

import { EventEmitter } from 'node:events';
import { beforeEach, vi } from 'vitest';
import { decode as decodeJpeg, encode as encodeJpeg } from 'jpeg-js';
import type { Hex } from '@monti/shared';

process.env.GCP_PROJECT_ID = 'monti-dev';
process.env.DIDIT_WEBHOOK_SECRET = SECRET;

const PERSON = `0x${'aa'.repeat(32)}` as Hex;
const TX_HASH = `0x${'bb'.repeat(32)}` as Hex;
const NAME_FIRST = '길동';
const NAME_LAST = '홍';
const DOC_NUMBER = 'M12345678';
/** 실제로 디코드되는 작은 JPEG. 잘린 바이트는 이제 저장되지 않고 거절된다(`PortraitError`). */
function smallJpeg(width = 200, height = 260): string {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      data[i] = (x * 255) / width;
      data[i + 1] = (y * 255) / height;
      data[i + 2] = 128;
      data[i + 3] = 255;
    }
  }
  return encodeJpeg({ data, width, height }, 80).data.toString('base64');
}

const PORTRAIT_BODY = smallJpeg();
const PORTRAIT = `data:image/jpeg;base64,${PORTRAIT_BODY}`;

/**
 * Didit 이 실제로 보내는 모양의 사진: 신분증 촬영 해상도 그대로인 JPEG.
 * 노이즈로 채워야 압축이 안 먹어 32 KB 한도를 진짜로 넘긴다.
 */
function oversizedPortrait(): string {
  const width = 1200;
  const height = 1600;
  const data = new Uint8Array(width * height * 4);
  let seed = 7;
  for (let i = 0; i < width * height; i += 1) {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    data[i * 4] = seed % 256;
    data[i * 4 + 1] = (seed >> 8) % 256;
    data[i * 4 + 2] = (seed >> 16) % 256;
    data[i * 4 + 3] = 255;
  }
  return encodeJpeg({ data, width, height }, 95).data.toString('base64');
}

/** `persons` / `kycSessions` 두 컬렉션과 트랜잭션만 흉내 내는 가짜 Firestore(startSignup.test.ts 와 같은 패턴). */
const docs = new Map<string, Record<string, unknown>>();

function snapshot(path: string) {
  const data = docs.get(path);
  return {
    exists: data !== undefined,
    id: path.slice(path.indexOf('/') + 1),
    get: (field: string) => data?.[field],
    data: () => data,
  };
}

/** Firestore 의 `set(..., {merge:true})` 는 맵을 **깊이** 합친다. 가짜도 같게 둬야 덮어쓰기 버그가 보인다. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}

function mergeInto(previous: Record<string, unknown>, data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...previous };
  for (const [key, value] of Object.entries(data)) {
    const existing = out[key];
    out[key] = isPlainObject(value) && isPlainObject(existing) ? mergeInto(existing, value) : value;
  }
  return out;
}

function write(path: string, data: Record<string, unknown>, options?: { merge?: boolean }): void {
  docs.set(path, options?.merge ? mergeInto(docs.get(path) ?? {}, data) : { ...data });
}

function docRef(path: string) {
  return {
    path,
    id: path.slice(path.indexOf('/') + 1),
    get: async () => snapshot(path),
    set: async (data: Record<string, unknown>, options?: { merge?: boolean }) => write(path, data, options),
  };
}

const fakeDb = {
  collection: (name: string) => ({ doc: (id: string) => docRef(`${name}/${id}`) }),
  runTransaction: async <T>(body: (tx: unknown) => Promise<T>): Promise<T> => {
    const pending: Array<() => void> = [];
    let reading = true;
    const tx = {
      get: async (ref: { path: string }) => {
        if (!reading) throw new Error('READ_AFTER_WRITE');
        return snapshot(ref.path);
      },
      set: (ref: { path: string }, data: Record<string, unknown>, options?: { merge?: boolean }) => {
        reading = false;
        pending.push(() => write(ref.path, data, options));
      },
    };
    const result = await body(tx);
    for (const apply of pending) apply();
    return result;
  },
};

// 전이 표(assertStatusTransition)는 진짜를 쓴다. Firestore 핸들 하나만 가짜로 바꾼다.
vi.mock('../src/lib/db.js', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/db.js')>('../src/lib/db.js');
  return { ...actual, db: fakeDb };
});

const sendAttesterTx = vi.fn(async (_tx: Record<string, unknown>) => TX_HASH);
const waitForTransactionReceipt = vi.fn(async (_args: Record<string, unknown>) => ({ status: 'success', blockNumber: 42n }));
const awaitFinalized = vi.fn(async (_block: bigint) => undefined);

vi.mock('../src/lib/chain.js', () => ({
  deployment: () => ({ identity: `0x${'11'.repeat(20)}` }),
  publicClient: () => ({ waitForTransactionReceipt: (...args: unknown[]) => waitForTransactionReceipt(...(args as [])) }),
  sendAttesterTx: (...args: unknown[]) => sendAttesterTx(...(args as [])),
  awaitFinalized: (...args: unknown[]) => awaitFinalized(...(args as [])),
}));

/** DEK 를 'W' 한 바이트로 감싸는 가짜 KMS. 봉투 암호화 자체는 진짜 코드가 돈다. */
vi.mock('@google-cloud/kms', () => ({
  KeyManagementServiceClient: class {
    async encrypt({ plaintext }: { plaintext: Buffer }) {
      return [{ ciphertext: Buffer.concat([Buffer.from('W'), Buffer.from(plaintext)]) }];
    }
    async decrypt({ ciphertext }: { ciphertext: Buffer }) {
      const buf = Buffer.from(ciphertext);
      if (buf[0] !== 'W'.charCodeAt(0)) throw new Error('FAKE_KMS_BAD_WRAP');
      return [{ plaintext: buf.subarray(1) }];
    }
  },
}));

const { KYC_SESSIONS, PERSONS } = await import('../src/lib/db.js');
const { decryptField, piiAad } = await import('../src/lib/kms.js');
const { diditWebhook } = await import('../src/functions/diditWebhook.js');

class FakeRes extends EventEmitter {
  statusCode = 200;
  body: unknown;
  private readonly sent: Record<string, unknown> = {};
  setHeader(key: string, value: unknown): void {
    this.sent[key.toLowerCase()] = value;
  }
  getHeader(key: string): unknown {
    return this.sent[key.toLowerCase()];
  }
  removeHeader(key: string): void {
    delete this.sent[key.toLowerCase()];
  }
  status(code: number): this {
    this.statusCode = code;
    return this;
  }
  send(body?: unknown): this {
    this.body = body;
    this.emit('finish');
    return this;
  }
  end(body?: unknown): this {
    if (body !== undefined) this.body = body;
    this.emit('finish');
    return this;
  }
}

interface Delivery {
  raw?: string;
  signature?: string;
  timestamp?: number;
  secret?: string;
  method?: string;
}

async function deliver(body: unknown, override: Delivery = {}): Promise<FakeRes> {
  const raw = override.raw ?? JSON.stringify(body);
  const timestamp = override.timestamp ?? Math.floor(Date.now() / 1000);
  const signature =
    override.signature ?? createHmac('sha256', override.secret ?? SECRET).update(raw, 'utf8').digest('hex');
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-signature-v2': signature,
    'x-timestamp': String(timestamp),
  };
  const req = {
    method: override.method ?? 'POST',
    headers,
    rawBody: Buffer.from(raw, 'utf8'),
    get: (name: string) => headers[name.toLowerCase()],
  };
  const res = new FakeRes();
  await (diditWebhook as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res);
  await new Promise((resolve) => setImmediate(resolve));
  return res;
}

function approvedBody(faceSearch: string | null = 'clear', sessionId = 's1') {
  const decision: Record<string, unknown> = {
    session_id: sessionId,
    id_verification: {
      status: 'Approved',
      first_name: NAME_FIRST,
      last_name: NAME_LAST,
      document_number: DOC_NUMBER,
      date_of_birth: '1990-01-01',
      portrait_image: PORTRAIT,
      address: '서울시 어딘가',
    },
  };
  if (faceSearch !== null) decision.face_search = { status: faceSearch, score: 0.1 };
  return { session_id: sessionId, status: 'Approved', vendor_data: PERSON, decision };
}

beforeEach(() => {
  docs.clear();
  sendAttesterTx.mockClear();
  waitForTransactionReceipt.mockClear();
  awaitFinalized.mockClear();
  // register 가 finalized 된 사람만 본인인증을 올릴 수 있다(pending → kyc_ok 는 막혀 있다).
  write(`${PERSONS}/${PERSON}`, { status: 'active', kycLevel: 0 });
});

describe('diditWebhook', () => {
  it('raises an approved person to kycLevel 1 only after the chain write is finalized', async () => {
    const res = await deliver(approvedBody());

    expect(res.statusCode).toBe(200);
    expect(sendAttesterTx).toHaveBeenCalledTimes(1);
    expect(sendAttesterTx.mock.calls[0]?.[0]).toMatchObject({ functionName: 'setKycLevel', args: [PERSON, 1] });
    expect(awaitFinalized).toHaveBeenCalledWith(42n);

    const person = snapshot(`${PERSONS}/${PERSON}`);
    expect(person.get('status')).toBe('active');
    expect(person.get('kycLevel')).toBe(1);
    expect(person.get('chain')).toMatchObject({ kycLevelTx: TX_HASH, block: 42 });
    expect(person.get('kyc')).toMatchObject({ provider: 'didit', sessionId: 's1', status: 'approved' });
    expect(snapshot(`${KYC_SESSIONS}/s1`).get('personId')).toBe(PERSON);
  });

  it('refuses a forged signature with 401 and writes nothing', async () => {
    const res = await deliver(approvedBody(), { signature: 'deadbeef' });
    expect(res.statusCode).toBe(401);
    expect(snapshot(`${KYC_SESSIONS}/s1`).exists).toBe(false);
    expect(snapshot(`${PERSONS}/${PERSON}`).get('kycLevel')).toBe(0);
    expect(sendAttesterTx).not.toHaveBeenCalled();

    const wrongSecret = await deliver(approvedBody(), { secret: 'not-the-secret' });
    expect(wrongSecret.statusCode).toBe(401);
    expect(snapshot(`${KYC_SESSIONS}/s1`).exists).toBe(false);
  });

  it('refuses a timestamp outside the tolerance window with 401', async () => {
    const stale = await deliver(approvedBody(), { timestamp: Math.floor(Date.now() / 1000) - 301 });
    expect(stale.statusCode).toBe(401);
    const future = await deliver(approvedBody(), { timestamp: Math.floor(Date.now() / 1000) + 301 });
    expect(future.statusCode).toBe(401);
    expect(snapshot(`${KYC_SESSIONS}/s1`).exists).toBe(false);
    expect(sendAttesterTx).not.toHaveBeenCalled();
  });

  it('signs the raw bytes, not the re-serialised JSON', async () => {
    // 같은 객체라도 키 순서가 다르면 다른 바이트다. 서명은 받은 바이트 그대로에 대해서만 맞는다.
    const raw = `{ "status" : "Approved" ,\n  "session_id" : "s1" ,\n  "vendor_data" : "${PERSON}" }`;
    expect(JSON.stringify(JSON.parse(raw))).not.toBe(raw);
    const res = await deliver(null, { raw, signature: createHmac('sha256', SECRET).update(raw, 'utf8').digest('hex') });
    expect(res.statusCode).toBe(200);
  });

  it('refuses a non-JSON body and a body without a usable vendor_data with 400', async () => {
    const badJson = await deliver(null, { raw: 'not json' });
    expect(badJson.statusCode).toBe(400);

    const noPerson = await deliver({ session_id: 's1', status: 'Approved' });
    expect(noPerson.statusCode).toBe(400);

    const badPerson = await deliver({ session_id: 's1', status: 'Approved', vendor_data: '0xzz' });
    expect(badPerson.statusCode).toBe(400);

    expect(snapshot(`${KYC_SESSIONS}/s1`).exists).toBe(false);
    expect(sendAttesterTx).not.toHaveBeenCalled();
  });

  it('treats a repeated delivery of the same decision as a no-op', async () => {
    await deliver(approvedBody());
    expect(sendAttesterTx).toHaveBeenCalledTimes(1);

    const again = await deliver(approvedBody());
    expect(again.statusCode).toBe(200);
    expect(again.body).toBe('duplicate');
    // 두 번째 배달은 체인에 아무것도 쓰지 않는다.
    expect(sendAttesterTx).toHaveBeenCalledTimes(1);
    expect(snapshot(`${PERSONS}/${PERSON}`).get('kycLevel')).toBe(1);
  });

  it('leaves kycLevel at 0 and records a reason code when Didit declines', async () => {
    const res = await deliver({ session_id: 's2', status: 'Declined', vendor_data: PERSON });

    expect(res.statusCode).toBe(200);
    const person = snapshot(`${PERSONS}/${PERSON}`);
    expect(person.get('status')).toBe('rejected');
    expect(person.get('kycLevel')).toBe(0);
    expect(person.get('kyc')).toMatchObject({ status: 'rejected', lastReason: 'declined', sessionId: 's2' });
    expect(sendAttesterTx).not.toHaveBeenCalled();
  });

  it('rejects an approved session whose face search found the same face as duplicate_face', async () => {
    const res = await deliver(approvedBody('duplicate'));

    expect(res.statusCode).toBe(200);
    const person = snapshot(`${PERSONS}/${PERSON}`);
    expect(person.get('status')).toBe('rejected');
    expect(person.get('kycLevel')).toBe(0);
    expect((person.get('kyc') as Record<string, unknown>).lastReason).toBe('duplicate_face');
    expect(sendAttesterTx).not.toHaveBeenCalled();
  });

  // ── 리뷰 fix round 1 ────────────────────────────────────────────────────────

  it('refuses any method but POST with 405, before it looks at the signature', async () => {
    for (const method of ['GET', 'PUT', 'DELETE', 'PATCH']) {
      const res = await deliver(approvedBody(), { method });
      expect(res.statusCode).toBe(405);
      expect(res.body).toBe('method not allowed');
    }
    // 서명이 아예 틀려도 405 가 먼저다 — 메서드 검사가 서명 검사보다 앞에 있다.
    const forged = await deliver(approvedBody(), { method: 'GET', signature: 'deadbeef' });
    expect(forged.statusCode).toBe(405);

    expect(docs.size).toBe(1); // beforeEach 가 만든 person 문서 하나뿐
    expect(snapshot(`${KYC_SESSIONS}/s1`).exists).toBe(false);
    expect(sendAttesterTx).not.toHaveBeenCalled();
  });

  it('stamps neither the session nor the person when the transition is refused', async () => {
    // register 가 아직 finalized 되지 않은 사람. pending → kyc_ok 는 전이 표가 막는다.
    docs.set(`${PERSONS}/${PERSON}`, { status: 'pending', kycLevel: 0 });

    await expect(deliver(approvedBody())).rejects.toThrow('BAD_STATUS_TRANSITION:pending->kyc_ok');

    // 세션에 도장이 찍히지 않았다 — 그래서 재배달이 duplicate 로 삼켜지지 않는다.
    expect(snapshot(`${KYC_SESSIONS}/s1`).exists).toBe(false);
    const blocked = snapshot(`${PERSONS}/${PERSON}`);
    expect(blocked.get('status')).toBe('pending');
    // 검사에 걸리기 전에는 봉투도 쓰지 않는다.
    expect(blocked.get('enc')).toBeUndefined();
    expect(blocked.get('photoEnc')).toBeUndefined();
    expect(blocked.get('kyc')).toBeUndefined();

    // register 가 끝난 뒤 같은 배달이 다시 오면 이번엔 통과한다.
    write(`${PERSONS}/${PERSON}`, { status: 'active' }, { merge: true });
    const retry = await deliver(approvedBody());
    expect(retry.statusCode).toBe(200);
    expect(snapshot(`${PERSONS}/${PERSON}`).get('kycLevel')).toBe(1);
  });

  it('leaves a recoverable kyc_ok marker when the chain send blows up after the commit', async () => {
    // Identity.register 전이면 estimateContractGas 가 NotRegistered() 로 되돌린다.
    sendAttesterTx.mockRejectedValueOnce(new Error('NotRegistered'));

    await expect(deliver(approvedBody())).rejects.toThrow('NotRegistered');

    // 사람 도장과 세션 도장이 **둘 다** 남았다 — 한 트랜잭션에서 같이 커밋됐다.
    const person = snapshot(`${PERSONS}/${PERSON}`);
    expect(person.get('status')).toBe('kyc_ok'); // reconcilePending 이 찾는 키
    expect(person.get('kycLevel')).toBe(0);
    expect(person.get('chain')).toBeUndefined(); // 되돌린·보내지 못한 해시는 남기지 않는다
    expect((person.get('kyc') as Record<string, unknown>).sessionId).toBe('s1');
    expect(snapshot(`${KYC_SESSIONS}/s1`).get('decision')).toBe('Approved');

    // 재배달은 duplicate 로 흡수되는 게 맞다. 복구는 reconcilePending 몫이고,
    // 그 작업이 찾을 상태(kyc_ok + 체인 kycLevel 0)가 실제로 남아 있다.
    const again = await deliver(approvedBody());
    expect(again.body).toBe('duplicate');
    expect(snapshot(`${PERSONS}/${PERSON}`).get('status')).toBe('kyc_ok');
  });

  it('does not record a tx hash when the setKycLevel receipt reverts', async () => {
    waitForTransactionReceipt.mockResolvedValueOnce({ status: 'reverted', blockNumber: 43n });

    const res = await deliver(approvedBody());

    expect(res.statusCode).toBe(500);
    const person = snapshot(`${PERSONS}/${PERSON}`);
    const chain = person.get('chain') as Record<string, unknown>;
    expect(chain.kycLevelTx).toBeUndefined(); // 실패한 해시를 "이미 보냈다"로 읽히게 두지 않는다
    expect(chain.kycLevelError).toBe('reverted');
    expect(person.get('status')).toBe('kyc_ok');
    expect(person.get('kycLevel')).toBe(0);
    expect(awaitFinalized).not.toHaveBeenCalled();
  });

  it('tells a missing face search apart from a duplicate one', async () => {
    const missing = await deliver(approvedBody(null, 's3'));
    expect(missing.statusCode).toBe(200);
    const afterMissing = snapshot(`${PERSONS}/${PERSON}`);
    expect((afterMissing.get('kyc') as Record<string, unknown>).lastReason).toBe('face_search_missing');
    expect(afterMissing.get('kycLevel')).toBe(0); // 사유가 무엇이든 fail-closed 다

    const unknown = await deliver(approvedBody('in_review', 's4'));
    expect(unknown.statusCode).toBe(200);
    expect((snapshot(`${PERSONS}/${PERSON}`).get('kyc') as Record<string, unknown>).lastReason).toBe(
      'face_search_not_clear',
    );
    expect(snapshot(`${PERSONS}/${PERSON}`).get('kycLevel')).toBe(0);
    expect(sendAttesterTx).not.toHaveBeenCalled();
  });

  it('never blanks an existing envelope when a later session carries no id_verification', async () => {
    await deliver(approvedBody());
    const enc = snapshot(`${PERSONS}/${PERSON}`).get('enc') as Record<string, string>;
    const photoEnc = snapshot(`${PERSONS}/${PERSON}`).get('photoEnc') as string;
    expect(enc.name).toBeTruthy();
    expect(photoEnc).toBeTruthy();

    // 같은 사람이 다시 본인인증을 받는다. 이번 결정에는 문서 정보가 실려 오지 않았다.
    write(`${PERSONS}/${PERSON}`, { status: 'active', kycLevel: 0 }, { merge: true });
    const res = await deliver({
      session_id: 's5',
      status: 'Approved',
      vendor_data: PERSON,
      decision: { face_search: { status: 'clear' } },
    });

    expect(res.statusCode).toBe(200);
    const after = snapshot(`${PERSONS}/${PERSON}`);
    expect(after.get('enc')).toEqual(enc); // 빈 문자열로 덮어쓰지 않는다
    expect(after.get('photoEnc')).toBe(photoEnc);
    expect(after.get('kycLevel')).toBe(1);
  });

  it('never creates a person document from an unknown vendor_data', async () => {
    const stranger = `0x${'cd'.repeat(32)}` as Hex;

    const approved = await deliver({ ...approvedBody(null, 's7'), vendor_data: stranger, decision: { face_search: { status: 'clear' } } });
    expect(approved.statusCode).toBe(200); // Didit 이 영원히 재시도하지 않게 200 이다
    expect(approved.body).toBe('unknown person');

    // 거절 결정도 마찬가지다 — 예전에는 이 경로가 사람 문서를 새로 만들었다.
    const declined = await deliver({ session_id: 's8', status: 'Declined', vendor_data: stranger });
    expect(declined.statusCode).toBe(200);

    // persons 에는 beforeEach 가 만든 문서 하나뿐이다.
    expect([...docs.keys()].filter((path) => path.startsWith(`${PERSONS}/`))).toEqual([`${PERSONS}/${PERSON}`]);
    expect(snapshot(`${PERSONS}/${stranger}`).exists).toBe(false);
    expect(sendAttesterTx).not.toHaveBeenCalled();

    // 세션에는 orphan 표시와 사유만 남는다 — 그 밖에는 아무것도 없다.
    for (const id of ['s7', 's8']) {
      expect(snapshot(`${KYC_SESSIONS}/${id}`).data()).toEqual({
        sessionId: id,
        status: 'orphan',
        reason: 'unknown_person',
      });
    }

    // 사람이 나중에 만들어지고 같은 세션이 다시 오면, orphan 기록이 그 배달을 삼키지 않는다.
    write(`${PERSONS}/${stranger}`, { status: 'active', kycLevel: 0 });
    const retry = await deliver({ ...approvedBody(null, 's7'), vendor_data: stranger, decision: { face_search: { status: 'clear' } } });
    expect(retry.statusCode).toBe(200);
    expect(snapshot(`${PERSONS}/${stranger}`).get('kycLevel')).toBe(1);
    expect(snapshot(`${KYC_SESSIONS}/s7`).get('status')).toBe('Approved'); // 더 이상 orphan 이 아니다
  });

  it('never persists a Didit PII field, and binds every envelope to personId:field', async () => {
    await deliver(approvedBody());

    const everythingWritten = JSON.stringify([...docs.entries()]);
    for (const secret of [NAME_FIRST, NAME_LAST, DOC_NUMBER, '1990-01-01', '서울시 어딘가', PORTRAIT_BODY]) {
      expect(everythingWritten).not.toContain(secret);
    }

    const person = snapshot(`${PERSONS}/${PERSON}`);
    const enc = person.get('enc') as Record<string, string>;
    await expect(decryptField(enc.name as string, piiAad(PERSON, 'name'))).resolves.toBe(`${NAME_LAST}${NAME_FIRST}`);
    await expect(decryptField(enc.docNumber as string, piiAad(PERSON, 'docNumber'))).resolves.toBe(DOC_NUMBER);
    await expect(decryptField(person.get('photoEnc') as string, piiAad(PERSON, 'photo'))).resolves.toContain('/9j/');
    // 봉투를 다른 필드나 다른 사람 문서로 옮겨 붙이면 열리지 않는다.
    await expect(decryptField(enc.name as string, piiAad(PERSON, 'docNumber'))).rejects.toThrow();

    // 세션 문서에는 허용한 결정 필드만 남는다. 목록에 없는 키는 저장되지 않는다.
    const session = snapshot(`${KYC_SESSIONS}/s1`).data() as Record<string, unknown>;
    expect(Object.keys(session).sort()).toEqual(['decision', 'personId', 'raw', 'receivedAt', 'status']);
    const raw = session.raw as { decision: Record<string, unknown> };
    expect(Object.keys(raw.decision)).toEqual(['face_search']);
    expect(raw).not.toHaveProperty('decision.id_verification');
  });

  // ── 요청 시 본인인증(Task 44) ───────────────────────────────────────────────

  it('downscales an oversized portrait before the envelope and never stores the original', async () => {
    const original = oversizedPortrait();
    expect(original.length).toBeGreaterThan(32 * 1024);

    const body = approvedBody();
    (body.decision.id_verification as Record<string, unknown>).portrait_image =
      `data:image/jpeg;base64,${original}`;
    const res = await deliver(body);
    expect(res.statusCode).toBe(200);

    // 원본 바이트는 어느 문서에도 없다.
    expect(JSON.stringify([...docs.entries()])).not.toContain(original.slice(0, 64));

    const stored = await decryptField(
      snapshot(`${PERSONS}/${PERSON}`).get('photoEnc') as string,
      piiAad(PERSON, 'photo'),
    );
    // 봉투 안의 것은 우리 규격 JPEG 다 — 32 KB 한도 안, 긴 변 256 px.
    expect(stored.length).toBeLessThanOrEqual(32 * 1024);
    expect(stored).not.toBe(original);
    const decoded = decodeJpeg(Buffer.from(stored, 'base64'), { useTArray: true });
    expect(Math.max(decoded.width, decoded.height)).toBe(256);
  });

  it('clears the previous decline reason when a later session is approved', async () => {
    await deliver({ session_id: 'd1', status: 'Declined', vendor_data: PERSON });
    expect((snapshot(`${PERSONS}/${PERSON}`).get('kyc') as Record<string, unknown>).lastReason).toBe('declined');

    // 같은 사람이 다시 시도해 통과했다. merge 는 맵을 깊이 합치므로 사유를 지우지 않으면 남는다.
    const res = await deliver(approvedBody('clear', 'd2'));
    expect(res.statusCode).toBe(200);
    const kyc = snapshot(`${PERSONS}/${PERSON}`).get('kyc') as Record<string, unknown>;
    expect(kyc.status).toBe('approved');
    expect(kyc.lastReason).toBeNull();
    expect(snapshot(`${PERSONS}/${PERSON}`).get('kycLevel')).toBe(1);
  });

  it('approves without a photo when the portrait format is one we cannot re-encode', async () => {
    const body = approvedBody();
    // WebP. 디코더가 없다 — 원본을 그대로 저장하면 게이트가 JPEG 로 읽다가 실패한다.
    const webp = Buffer.concat([
      Buffer.from('RIFF'),
      Buffer.from([0x20, 0, 0, 0]),
      Buffer.from('WEBPVP8 '),
      Buffer.alloc(24, 0x55),
    ]).toString('base64');
    (body.decision.id_verification as Record<string, unknown>).portrait_image =
      `data:image/webp;base64,${webp}`;

    const res = await deliver(body);

    expect(res.statusCode).toBe(200);
    const person = snapshot(`${PERSONS}/${PERSON}`);
    expect(person.get('kycLevel')).toBe(1); // 사진 포맷 때문에 본인인증을 막지는 않는다
    expect(person.get('photoEnc')).toBeUndefined(); // 원본은 저장되지 않는다
    expect(JSON.stringify([...docs.entries()])).not.toContain(webp);
    // 이름·문서번호 봉투는 평소대로 들어간다.
    expect((person.get('enc') as Record<string, string>).name).toBeTruthy();
  });
});
