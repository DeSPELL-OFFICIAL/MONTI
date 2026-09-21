import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { redactDiditPayload, verifyDiditSignature } from '../src/lib/didit.js';

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

// ─────────────────────────────────────────────────────────────────────────────
// diditWebhook — 서명 검증 · 멱등 · 레닥션이 실제 핸들러에서 함께 도는지 본다.
// ─────────────────────────────────────────────────────────────────────────────

import { EventEmitter } from 'node:events';
import { beforeEach, vi } from 'vitest';
import type { Hex } from '@monti/shared';

process.env.GCP_PROJECT_ID = 'monti-dev';
process.env.DIDIT_WEBHOOK_SECRET = SECRET;

const PERSON = `0x${'aa'.repeat(32)}` as Hex;
const TX_HASH = `0x${'bb'.repeat(32)}` as Hex;
const NAME_FIRST = '길동';
const NAME_LAST = '홍';
const DOC_NUMBER = 'M12345678';
const PORTRAIT = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==';

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

function write(path: string, data: Record<string, unknown>, options?: { merge?: boolean }): void {
  const previous = options?.merge ? (docs.get(path) ?? {}) : {};
  docs.set(path, { ...previous, ...data });
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

function approvedBody(faceSearch = 'clear') {
  return {
    session_id: 's1',
    status: 'Approved',
    vendor_data: PERSON,
    decision: {
      session_id: 's1',
      face_search: { status: faceSearch, score: 0.1 },
      id_verification: {
        status: 'Approved',
        first_name: NAME_FIRST,
        last_name: NAME_LAST,
        document_number: DOC_NUMBER,
        date_of_birth: '1990-01-01',
        portrait_image: PORTRAIT,
        address: '서울시 어딘가',
      },
    },
  };
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
    expect(person.get('kyc')).toMatchObject({ status: 'rejected', rejectedReason: 'declined', sessionId: 's2' });
    expect(sendAttesterTx).not.toHaveBeenCalled();
  });

  it('rejects an approved session whose face search is not clear as duplicate_face', async () => {
    const res = await deliver(approvedBody('duplicate'));

    expect(res.statusCode).toBe(200);
    const person = snapshot(`${PERSONS}/${PERSON}`);
    expect(person.get('status')).toBe('rejected');
    expect(person.get('kycLevel')).toBe(0);
    expect((person.get('kyc') as Record<string, unknown>).rejectedReason).toBe('duplicate_face');
    expect(sendAttesterTx).not.toHaveBeenCalled();
  });

  it('never persists a Didit PII field, and binds every envelope to personId:field', async () => {
    await deliver(approvedBody());

    const everythingWritten = JSON.stringify([...docs.entries()]);
    for (const secret of [NAME_FIRST, NAME_LAST, DOC_NUMBER, '1990-01-01', '서울시 어딘가', PORTRAIT.slice(23)]) {
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
});
