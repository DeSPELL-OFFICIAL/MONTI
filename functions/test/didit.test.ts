import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  canonicalDiditJson,
  declineReason,
  declineReasonFromDecision,
  diditIdVerification,
  faceSearchClear,
  faceSearchStatus,
  redactDiditPayload,
  redactRawBody,
  verifyDiditWebhook,
} from '../src/lib/didit.js';

const SECRET = 'whsec-monti';
const NOW = 1_789_862_400;

// ─────────────────────────────────────────────────────────────────────────────
// V2 정규화 JSON — 손으로 계산한 벡터 하나가 이 정의 전체를 못 박는다
// ─────────────────────────────────────────────────────────────────────────────

describe('canonicalDiditJson', () => {
  it('sorts keys recursively, keeps array order, keeps Unicode and uses compact separators', () => {
    // 손으로 계산한 기대값: 최상위는 a,b,c 순, `c` 안은 y,z 순, `[3,1]` 은 **그대로**,
    // `é` 는 `\uXXXX` 가 아니라 글자 그대로, 구분자는 `,` 와 `:` 뿐(공백 없음).
    const canonical = canonicalDiditJson({ b: 1, c: { z: true, y: [3, 1] }, a: 'héllo' });
    expect(canonical).toBe('{"a":"héllo","b":1,"c":{"y":[3,1],"z":true}}');
    expect(canonical).not.toContain('\\u');
    expect(canonical).not.toContain(', ');
    expect(canonical).not.toContain(': ');
  });

  it('keeps Korean text as Korean — a \\uXXXX escape would break every signature we get', () => {
    expect(canonicalDiditJson({ status: 'Approved', name: '홍길동' })).toBe(
      '{"name":"홍길동","status":"Approved"}',
    );
  });

  it('is a pure function of the value, not of the bytes it arrived in', () => {
    const spaced = '{ "b" : 1 ,\n "a" : { "d" : 2, "c" : 3 } }';
    const tight = '{"a":{"c":3,"d":2},"b":1}';
    expect(canonicalDiditJson(JSON.parse(spaced))).toBe(canonicalDiditJson(JSON.parse(tight)));
    expect(canonicalDiditJson(JSON.parse(spaced))).toBe(tight);
  });

  it('matches the HMAC vector pinned for this secret', () => {
    // 위 정규화 문자열에 대한 HMAC-SHA256. 정규화가 한 글자라도 달라지면 이 값이 깨진다.
    expect(createHmac('sha256', SECRET).update('{"a":"héllo","b":1,"c":{"y":[3,1],"z":true}}', 'utf8').digest('hex')).toBe(
      '4f183d1ba5684d9839ff99df92ed028b5e2b02e352c1260823744341a3eed9aa',
    );
    expect(createHmac('sha256', SECRET).update('{"name":"홍길동","status":"Approved"}', 'utf8').digest('hex')).toBe(
      '66478facea2203621b68eec9b586ae46baf11f5915d3f3543759f3aaf4f1b6fd',
    );
  });
});

describe('verifyDiditWebhook', () => {
  const RAW_V3 = '{ "status" : "Approved" ,\n  "session_id" : "s1" }';
  const CANONICAL = canonicalDiditJson(JSON.parse(RAW_V3));
  const sign = (message: string, secret = SECRET): string =>
    createHmac('sha256', secret).update(message, 'utf8').digest('hex');

  it('accepts X-Signature-V2 over the canonical JSON', () => {
    const result = verifyDiditWebhook({
      raw: RAW_V3, v2: sign(CANONICAL), timestamp: NOW, secret: SECRET, now: NOW,
    });
    expect(result).toMatchObject({ ok: true, scheme: 'v2', authenticated: true });
    // 원본 바이트로 서명한 값은 V2 헤더에서 통하지 않는다.
    expect(verifyDiditWebhook({ raw: RAW_V3, v2: sign(RAW_V3), timestamp: NOW, secret: SECRET, now: NOW })).toEqual({
      ok: false, code: 'signature_mismatch',
    });
  });

  it('accepts X-Signature over the exact raw bytes', () => {
    expect(
      verifyDiditWebhook({ raw: RAW_V3, rawSignature: sign(RAW_V3), timestamp: NOW, secret: SECRET, now: NOW }),
    ).toMatchObject({ ok: true, scheme: 'raw', authenticated: true });
  });

  it('accepts X-Signature-Simple only when neither other header is present, and never as authenticated', () => {
    const raw = '{"session_id":"s1","status":"Approved","webhook_type":"status.updated"}';
    const simple = sign(`${NOW}:s1:Approved:status.updated`);

    const alone = verifyDiditWebhook({ raw, simple, timestamp: NOW, secret: SECRET, now: NOW });
    expect(alone).toMatchObject({ ok: true, scheme: 'simple' });
    // 결정을 인증하지 않는다 — 핸들러는 이 값을 보고 사람 문서를 건드리지 않는다.
    expect(alone.ok && alone.authenticated).toBe(false);

    // 강한 서명이 붙어 있는데 틀렸다면 그것은 위조다. 약한 서명으로 갈아타 통과시키지 않는다.
    expect(verifyDiditWebhook({ raw, simple, v2: 'deadbeef', timestamp: NOW, secret: SECRET, now: NOW })).toEqual({
      ok: false, code: 'signature_mismatch',
    });
    expect(
      verifyDiditWebhook({ raw, simple, rawSignature: 'deadbeef', timestamp: NOW, secret: SECRET, now: NOW }),
    ).toEqual({ ok: false, code: 'signature_mismatch' });
  });

  it('refuses a stale, a future, a missing and a zero timestamp with one clear code', () => {
    const v2 = sign(CANONICAL);
    for (const timestamp of [NOW - 301, NOW + 301, 0, Number.NaN]) {
      expect(verifyDiditWebhook({ raw: RAW_V3, v2, timestamp, secret: SECRET, now: NOW })).toEqual({
        ok: false, code: 'timestamp_out_of_window',
      });
    }
    // 창 안이면 통과한다 — 300 초는 경계 포함이다.
    expect(verifyDiditWebhook({ raw: RAW_V3, v2, timestamp: NOW - 300, secret: SECRET, now: NOW })).toMatchObject({
      ok: true,
    });
  });

  it('refuses a body with no signature header at all', () => {
    expect(verifyDiditWebhook({ raw: RAW_V3, timestamp: NOW, secret: SECRET, now: NOW })).toEqual({
      ok: false, code: 'no_signature',
    });
  });

  it('refuses a signature made with another secret', () => {
    expect(
      verifyDiditWebhook({ raw: RAW_V3, v2: sign(CANONICAL, 'other'), timestamp: NOW, secret: SECRET, now: NOW }),
    ).toEqual({ ok: false, code: 'signature_mismatch' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 리뷰 fix round 1 — 인증 전에 **던지는** 길을 둘 다 막는다
// ─────────────────────────────────────────────────────────────────────────────

/** `[[[…1…]]]` 를 `depth` 단으로 만든다. `JSON.stringify` 를 거치지 않는다 — 그것도 재귀다. */
function nest(depth: number): unknown {
  let value: unknown = 1;
  for (let index = 0; index < depth; index += 1) value = [value];
  return value;
}

describe('canonicalDiditJson depth limit', () => {
  it('canonicalises up to 64 levels and refuses to go deeper', () => {
    expect(canonicalDiditJson(nest(64))).toBe(`${'['.repeat(64)}1${']'.repeat(64)}`);
    expect(() => canonicalDiditJson(nest(65))).toThrow('CANONICAL_TOO_DEEP');
    expect(() => canonicalDiditJson(nest(20_000))).toThrow('CANONICAL_TOO_DEEP');
  });

  it('counts object nesting the same way', () => {
    let value: unknown = 1;
    for (let index = 0; index < 65; index += 1) value = { a: value };
    expect(() => canonicalDiditJson(value)).toThrow('CANONICAL_TOO_DEEP');
  });
});

describe('verifyDiditWebhook — inputs that used to throw', () => {
  const RAW = '{"session_id":"s1","status":"Approved"}';
  const MULTIBYTE = 'Ã'.repeat(64); // 64 글자, **128 바이트** — 글자 수로 재면 통과한다
  const sign = (message: string): string => createHmac('sha256', SECRET).update(message, 'utf8').digest('hex');

  it('treats a 64-character multibyte signature as a plain mismatch, not a RangeError', () => {
    expect(Buffer.byteLength(MULTIBYTE)).toBe(128);
    for (const header of ['v2', 'rawSignature', 'simple'] as const) {
      expect(
        verifyDiditWebhook({ raw: RAW, [header]: MULTIBYTE, timestamp: NOW, secret: SECRET, now: NOW }),
      ).toEqual({ ok: false, code: 'signature_mismatch' });
    }
  });

  it('refuses any signature that is not 64 hex characters', () => {
    for (const signature of ['deadbeef', `${sign(RAW)}00`, 'z'.repeat(64), '', ' ']) {
      const result = verifyDiditWebhook({ raw: RAW, rawSignature: signature, timestamp: NOW, secret: SECRET, now: NOW });
      // 빈 문자열은 "서명 헤더가 없다" 로 갈린다. 나머지는 전부 불일치다.
      expect(result.ok).toBe(false);
    }
    // 대문자 16진수는 Didit 이 실제로 보낼 수 있는 모양이다 — 받아야 한다.
    expect(
      verifyDiditWebhook({ raw: RAW, rawSignature: sign(RAW).toUpperCase(), timestamp: NOW, secret: SECRET, now: NOW }),
    ).toMatchObject({ ok: true, scheme: 'raw' });
  });

  it('folds a body too deep to canonicalise into a V2 mismatch, and still honours the raw signature', () => {
    const deep = `{"a":${'['.repeat(20_000)}${']'.repeat(20_000)}}`;
    expect(verifyDiditWebhook({ raw: deep, v2: sign('anything'), timestamp: NOW, secret: SECRET, now: NOW })).toEqual({
      ok: false,
      code: 'signature_mismatch',
    });
    // 원본 바이트 서명은 정규화를 거치지 않으므로 깊이와 무관하게 그대로 통한다.
    expect(
      verifyDiditWebhook({ raw: deep, rawSignature: sign(deep), timestamp: NOW, secret: SECRET, now: NOW }),
    ).toMatchObject({ ok: true, scheme: 'raw' });
  });
});

describe('redactRawBody', () => {
  it('drops the portrait base64 and every known PII value, and caps the length', () => {
    const portrait = 'A'.repeat(4096);
    const redacted = redactRawBody(
      `{"session_id":"s1","decision":{"id_verifications":[{"first_name":"길동","portrait_image":"${portrait}"}]}}`,
    );
    expect(redacted).not.toContain(portrait.slice(0, 64));
    expect(redacted).not.toContain('길동');
    expect(redacted).toContain('"session_id":"s1"');
    expect(redacted.length).toBeLessThanOrEqual(2100);
  });

  it('works on a body that is not JSON at all — that is often why the signature failed', () => {
    expect(redactRawBody('not json')).toBe('not json');
  });
});

describe('the V3 decision arrays', () => {
  it('reads the id verification from id_verifications[0] and falls back to the singular key', () => {
    expect(diditIdVerification({ id_verifications: [{ node_id: 'n1', first_name: '길동' }] })?.first_name).toBe('길동');
    expect(diditIdVerification({ id_verification: { first_name: '단수' } })?.first_name).toBe('단수');
    expect(diditIdVerification({})).toBeUndefined();
  });

  it('folds face_matches[0] onto the same clear/duplicate signal as the legacy face_search', () => {
    expect(faceSearchStatus({ face_search: { status: 'clear' } })).toBe('clear');
    expect(faceSearchStatus({ face_matches: [{ node_id: 'n2', status: 'Approved' }] })).toBe('clear');
    expect(faceSearchStatus({ face_matches: [{ status: 'Declined' }] })).toBe('declined');
    expect(faceSearchStatus({})).toBeNull();

    expect(faceSearchClear({ face_matches: [{ status: 'Approved' }] })).toBe(true);
    expect(faceSearchClear({})).toBe(false);
  });

  it('maps a duplicate-face warning on any array to duplicate_face', () => {
    for (const key of ['face_matches', 'aml_screenings', 'id_verifications']) {
      const decision = {
        face_matches: [{ status: 'Approved' }],
        [key]: [{ node_id: 'n3', warnings: [{ risk: 'DUPLICATE_FACE', short_description: 'Same face' }] }],
      };
      expect(declineReasonFromDecision('Approved', decision)).toBe('duplicate_face');
      // 경고가 있으면 얼굴 신호가 깨끗해도 승인하지 않는다(fail-closed).
      expect(faceSearchClear(decision)).toBe(false);
    }
  });

  it('keeps the other three codes when there is no duplicate warning', () => {
    expect(declineReasonFromDecision('Declined', { id_verifications: [{ status: 'Declined' }] })).toBe('declined');
    expect(declineReasonFromDecision('Approved', {})).toBe('face_search_missing');
    expect(declineReasonFromDecision('Approved', { face_matches: [{ status: 'In Review' }] })).toBe(
      'face_search_not_clear',
    );
  });
});

/**
 * `redactDiditPayload` 는 들어온 모양을 그대로 돌려주므로 반환이 `unknown` 이다.
 * 색인 시그니처로 받으면 중간 칸마다 `undefined` 가 붙어 읽을 수 없다 — 넣은 모양을 그대로 적는다.
 */
interface Redacted {
  decision: { id_verification: Record<string, unknown>; face_search: Record<string, unknown> };
}

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
    }) as Redacted;

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

import { FakeRes } from './helpers/webhookRes.js';
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

/** Firestore 의 `create()` 는 문서가 이미 있으면 ALREADY_EXISTS(6) 으로 던진다. `event_id` 도장이 그것에 기댄다. */
class AlreadyExists extends Error {
  readonly code = 6;
}

function docRef(path: string) {
  return {
    path,
    id: path.slice(path.indexOf('/') + 1),
    get: async () => snapshot(path),
    set: async (data: Record<string, unknown>, options?: { merge?: boolean }) => write(path, data, options),
    create: async (data: Record<string, unknown>) => {
      if (docs.has(path)) throw new AlreadyExists(path);
      write(path, data);
    },
    delete: async () => {
      docs.delete(path);
    },
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
  publicClient: () => ({
    waitForTransactionReceipt: (...args: Parameters<typeof waitForTransactionReceipt>) =>
      waitForTransactionReceipt(...args),
  }),
  sendAttesterTx: (...args: Parameters<typeof sendAttesterTx>) => sendAttesterTx(...args),
  awaitFinalized: (...args: Parameters<typeof awaitFinalized>) => awaitFinalized(...args),
}));

vi.mock('@google-cloud/kms', async () => await import('./helpers/fakeKms.js'));

/**
 * 구조화 로그를 가로챈다. firebase-functions 의 logger 는 모듈이 로드될 때 콘솔을 붙잡아 두므로
 * (`UNPATCHED_CONSOLE`) 나중에 `console.warn` 을 감시해도 잡히지 않는다 — 모듈째 바꾼다.
 */
const logged = vi.hoisted(() => ({
  debug: vi.fn(), log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), write: vi.fn(),
}));
vi.mock('firebase-functions/logger', () => logged);

const { KYC_SESSIONS, PERSONS } = await import('../src/lib/db.js');
const { decryptField, piiAad } = await import('../src/lib/kms.js');
const { diditWebhook } = await import('../src/functions/diditWebhook.js');

interface Delivery {
  raw?: string;
  signature?: string;
  timestamp?: number;
  secret?: string;
  method?: string;
  /**
   * 어느 헤더로 서명을 보낼지. 기본은 Didit 이 권하는 `v2`(정규화 JSON) 다.
   * `both` 는 V2 와 원본 바이트를 같이 보내고, `none` 은 서명 헤더를 아예 빼 본다.
   */
  scheme?: 'v2' | 'raw' | 'simple' | 'both' | 'none';
}

/** `X-Signature-V2` 가 덮는 문자열. 본문이 JSON 이 아니면 정규화할 수 없으므로 원본 그대로 쓴다. */
function v2Message(raw: string): string {
  try {
    return canonicalDiditJson(JSON.parse(raw));
  } catch {
    return raw;
  }
}

async function deliver(body: unknown, override: Delivery = {}): Promise<FakeRes> {
  const raw = override.raw ?? JSON.stringify(body);
  const timestamp = override.timestamp ?? Math.floor(Date.now() / 1000);
  const secret = override.secret ?? SECRET;
  const scheme = override.scheme ?? 'v2';
  const sign = (message: string): string => createHmac('sha256', secret).update(message, 'utf8').digest('hex');
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-timestamp': String(timestamp),
  };
  if (scheme === 'v2' || scheme === 'both') headers['x-signature-v2'] = override.signature ?? sign(v2Message(raw));
  if (scheme === 'raw' || scheme === 'both') headers['x-signature'] = override.signature ?? sign(raw);
  if (scheme === 'simple') {
    const envelope = JSON.parse(raw) as { session_id?: string; status?: string; webhook_type?: string };
    headers['x-signature-simple'] =
      override.signature ??
      sign(`${timestamp}:${envelope.session_id ?? ''}:${envelope.status ?? ''}:${envelope.webhook_type ?? ''}`);
  }
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
  for (const spy of Object.values(logged)) spy.mockClear();
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

  it('accepts X-Signature over the exact raw bytes as an alternative to V2', async () => {
    // 같은 객체라도 키 순서·공백이 다르면 다른 바이트다. `X-Signature` 는 받은 바이트 그대로에 맞는다.
    const raw = `{ "status" : "Approved" ,\n  "session_id" : "s1" ,\n  "vendor_data" : "${PERSON}" }`;
    expect(JSON.stringify(JSON.parse(raw))).not.toBe(raw);
    const res = await deliver(null, { raw, scheme: 'raw' });
    expect(res.statusCode).toBe(200);
    expect(snapshot(`${PERSONS}/${PERSON}`).get('status')).toBe('rejected'); // face_search 가 없다
  });

  it('accepts V2 over the canonical JSON of the same bytes, whatever their order and spacing', async () => {
    // V2 는 **정규화한 뒤** 서명하므로 키 순서와 공백이 달라도 같은 서명이 나온다.
    const raw = `{ "status" : "Approved" ,\n  "session_id" : "s1" ,\n  "vendor_data" : "${PERSON}" }`;
    const res = await deliver(null, { raw, scheme: 'v2' });
    expect(res.statusCode).toBe(200);

    // 원본 바이트로 서명한 값을 V2 헤더에 넣으면 이제 통하지 않는다 — 정의가 다르다.
    const wrong = await deliver(null, {
      raw,
      scheme: 'v2',
      signature: createHmac('sha256', SECRET).update(raw, 'utf8').digest('hex'),
    });
    expect(wrong.statusCode).toBe(401);
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

// ─────────────────────────────────────────────────────────────────────────────
// Didit 통합 규격 감사 — 감사표의 각 줄에 테스트 하나
// ─────────────────────────────────────────────────────────────────────────────

describe('diditWebhook — the Didit integration spec', () => {
  const EVENTS = 'diditEvents';

  function v3Body(overrides: Record<string, unknown> = {}) {
    return {
      event_id: 'evt-1',
      session_id: 's1',
      status: 'Approved',
      webhook_type: 'status.updated',
      created_at: 1_789_862_400,
      timestamp: 1_789_862_400,
      application_id: 'app-1',
      workflow_id: 'wf-1',
      workflow_version: 3,
      vendor_data: PERSON,
      metadata: { plan: 'demo' },
      decision: {
        session_id: 's1',
        id_verifications: [
          {
            node_id: 'id-1',
            status: 'Approved',
            first_name: NAME_FIRST,
            last_name: NAME_LAST,
            document_number: DOC_NUMBER,
            date_of_birth: '1990-01-01',
            portrait_image: PORTRAIT,
          },
        ],
        face_matches: [{ node_id: 'fm-1', status: 'Approved', score: 98.2 }],
        liveness_checks: [{ node_id: 'lv-1', status: 'Approved' }],
        aml_screenings: [{ node_id: 'aml-1', status: 'Approved', warnings: [] }],
        ip_analyses: [{ node_id: 'ip-1', status: 'Approved' }],
        reviews: [{ node_id: 'rv-1', status: 'Approved' }],
      },
      ...overrides,
    };
  }

  // ── (5) webhook_type 분배 ──────────────────────────────────────────────────

  it('acknowledges every non-session webhook_type with 200 and writes nothing', async () => {
    for (const webhookType of [
      'user.created',
      'user.updated',
      'business.created',
      'business.updated',
      'activity.created',
      'transaction.completed',
      'transaction.failed',
    ]) {
      const res = await deliver({ webhook_type: webhookType, event_id: `e-${webhookType}`, id: 'x' });
      expect(res.statusCode).toBe(200);
      expect(res.body).toBe('ignored');
    }
    // 4xx·5xx 로 답하면 Didit 의 재시도 큐가 계속 두드린다. 아무것도 쓰이지 않았다.
    expect(docs.size).toBe(1);
    expect(sendAttesterTx).not.toHaveBeenCalled();
  });

  it('still treats a body without webhook_type as a session event', async () => {
    const res = await deliver(approvedBody());
    expect(res.statusCode).toBe(200);
    expect(snapshot(`${PERSONS}/${PERSON}`).get('kycLevel')).toBe(1);
  });

  // ── (7) event_id 멱등 ──────────────────────────────────────────────────────

  it('swallows a replayed event_id before it reaches the session guard', async () => {
    const first = await deliver(v3Body());
    expect(first.statusCode).toBe(200);
    expect(first.body).toBe('ok');
    expect(snapshot(`${EVENTS}/evt-1`).exists).toBe(true);
    expect(snapshot(`${EVENTS}/evt-1`).get('sessionId')).toBe('s1');
    // TTL 정책이 보는 필드. 이 장부는 스스로 지워져야 한다.
    expect(snapshot(`${EVENTS}/evt-1`).get('expireAt')).toBeDefined();

    // 같은 이벤트가 다시 왔다. 세션 id 나 상태가 무엇이든 여기서 끝난다.
    const replay = await deliver(v3Body({ session_id: 'other-session' }));
    expect(replay.statusCode).toBe(200);
    expect(replay.body).toBe('duplicate');
    expect(snapshot(`${KYC_SESSIONS}/other-session`).exists).toBe(false);
    expect(sendAttesterTx).toHaveBeenCalledTimes(1);
  });

  it('hands the event_id back when the delivery blows up, so the retry is not swallowed', async () => {
    // register 가 아직 finalized 되지 않은 사람. pending → kyc_ok 는 전이 표가 막는다.
    docs.set(`${PERSONS}/${PERSON}`, { status: 'pending', kycLevel: 0 });
    await expect(deliver(v3Body())).rejects.toThrow('BAD_STATUS_TRANSITION:pending->kyc_ok');
    expect(snapshot(`${EVENTS}/evt-1`).exists).toBe(false);

    // Didit 의 재배달(같은 event_id)이 "이미 처리됨"으로 삼켜지지 않고 정상 처리된다.
    write(`${PERSONS}/${PERSON}`, { status: 'active' }, { merge: true });
    const retry = await deliver(v3Body());
    expect(retry.statusCode).toBe(200);
    expect(retry.body).toBe('ok');
    expect(snapshot(`${PERSONS}/${PERSON}`).get('kycLevel')).toBe(1);
  });

  it('keeps the session guard underneath for a redelivery that carries no event_id', async () => {
    await deliver(approvedBody());
    const again = await deliver(approvedBody());
    expect(again.body).toBe('duplicate');
    expect(docs.has(`${EVENTS}/undefined`)).toBe(false);
  });

  // ── (6) 상태 전체 ──────────────────────────────────────────────────────────

  it('maps every Didit status onto kyc.status without ever raising kycLevel by itself', async () => {
    const cases: Array<[string, string | null]> = [
      ['In Review', 'in_review'],
      ['Abandoned', 'abandoned'],
      ['Expired', 'expired'],
      ['KYC Expired', 'expired'],
      ['In Progress', null],
      ['Not Started', null],
    ];
    for (const [status, expected] of cases) {
      docs.clear();
      write(`${PERSONS}/${PERSON}`, { status: 'active', kycLevel: 0 });
      const res = await deliver({ session_id: `s-${status}`, status, vendor_data: PERSON });

      expect(res.statusCode).toBe(200);
      const person = snapshot(`${PERSONS}/${PERSON}`);
      // 진행 딱지만 바뀐다. 사람의 status 도 kycLevel 도 그대로다.
      expect(person.get('status')).toBe('active');
      expect(person.get('kycLevel')).toBe(0);
      expect((person.get('kyc') as Record<string, unknown> | undefined)?.status ?? null).toBe(expected);
      // 접수 사실은 남는다 — 같은 상태가 다시 오면 중복으로 삼켜진다.
      expect(snapshot(`${KYC_SESSIONS}/s-${status}`).get('decision')).toBe(status);
    }
    expect(sendAttesterTx).not.toHaveBeenCalled();
  });

  it('opens the session again on Resubmitted and clears the last decline reason', async () => {
    write(`${PERSONS}/${PERSON}`, { kyc: { status: 'rejected', lastReason: 'declined', sessionId: 's1' } }, { merge: true });

    const res = await deliver({ session_id: 's1', status: 'Resubmitted', vendor_data: PERSON });

    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('reopened');
    const kyc = snapshot(`${PERSONS}/${PERSON}`).get('kyc') as Record<string, unknown>;
    // `ensureKycSession` 은 'open' 을 보고 같은 링크를 돌려주고, 버려지면 스윕이 `openedAt` 으로 닫는다.
    expect(kyc.status).toBe('open');
    expect(kyc.lastReason).toBeNull();
    expect(typeof kyc.openedAt).toBe('number');
    expect(kyc.sessionId).toBe('s1'); // 파기가 Didit 의 얼굴 자료를 찾는 열쇠다 — 지우지 않는다
    expect(snapshot(`${PERSONS}/${PERSON}`).get('kycLevel')).toBe(0);
  });

  it('never lets a late Expired or Resubmitted undo a person who already passed', async () => {
    await deliver(approvedBody());
    expect(snapshot(`${PERSONS}/${PERSON}`).get('kycLevel')).toBe(1);

    for (const status of ['Expired', 'KYC Expired', 'Abandoned', 'In Review', 'Resubmitted']) {
      const res = await deliver({ session_id: `late-${status}`, status, vendor_data: PERSON });
      expect(res.statusCode).toBe(200);
      const person = snapshot(`${PERSONS}/${PERSON}`);
      expect(person.get('kycLevel')).toBe(1);
      expect(person.get('status')).toBe('active');
      expect((person.get('kyc') as Record<string, unknown>).status).toBe('approved');
    }
  });

  it('acknowledges a status we have never heard of instead of answering 5xx', async () => {
    const res = await deliver({ session_id: 's9', status: 'Bananas', vendor_data: PERSON });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('ignored status');
    const person = snapshot(`${PERSONS}/${PERSON}`);
    expect(person.get('status')).toBe('active');
    expect(person.get('kyc')).toBeUndefined();
    expect(snapshot(`${KYC_SESSIONS}/s9`).get('decision')).toBe('Bananas');
    expect(sendAttesterTx).not.toHaveBeenCalled();
  });

  // ── (6) V3 decision 배열 ───────────────────────────────────────────────────

  it('reads the portrait, the name and the document number out of the V3 plural arrays', async () => {
    const res = await deliver(v3Body());

    expect(res.statusCode).toBe(200);
    const person = snapshot(`${PERSONS}/${PERSON}`);
    expect(person.get('kycLevel')).toBe(1);
    // 얼굴 신호는 `face_matches[0].status === 'Approved'` 에서 왔다 — V3 에는 face_search 가 없다.
    expect((person.get('kyc') as Record<string, unknown>).faceSearchOk).toBe(true);

    const enc = person.get('enc') as Record<string, string>;
    await expect(decryptField(enc.name as string, piiAad(PERSON, 'name'))).resolves.toBe(`${NAME_LAST}${NAME_FIRST}`);
    await expect(decryptField(enc.docNumber as string, piiAad(PERSON, 'docNumber'))).resolves.toBe(DOC_NUMBER);
    await expect(decryptField(person.get('photoEnc') as string, piiAad(PERSON, 'photo'))).resolves.toContain('/9j/');

    // 배열 안의 개인정보도 어느 문서에도 평문으로 남지 않는다.
    const written = JSON.stringify([...docs.entries()]);
    for (const secret of [NAME_FIRST, NAME_LAST, DOC_NUMBER, '1990-01-01', PORTRAIT_BODY]) {
      expect(written).not.toContain(secret);
    }
  });

  it('declines a V3 approval whose aml_screenings warn about a duplicate face', async () => {
    const body = v3Body();
    (body.decision as Record<string, unknown>).aml_screenings = [
      { node_id: 'aml-1', status: 'Declined', warnings: [{ risk: 'DUPLICATE_FACE', short_description: 'Same face seen' }] },
    ];

    const res = await deliver(body);

    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('rejected');
    const person = snapshot(`${PERSONS}/${PERSON}`);
    expect(person.get('status')).toBe('rejected');
    expect(person.get('kycLevel')).toBe(0);
    expect((person.get('kyc') as Record<string, unknown>).lastReason).toBe('duplicate_face');
    expect(sendAttesterTx).not.toHaveBeenCalled();
  });

  it('declines a V3 approval with no face node at all as face_search_missing', async () => {
    const body = v3Body();
    delete (body.decision as Record<string, unknown>).face_matches;

    const res = await deliver(body);

    expect(res.statusCode).toBe(200);
    expect((snapshot(`${PERSONS}/${PERSON}`).get('kyc') as Record<string, unknown>).lastReason).toBe(
      'face_search_missing',
    );
    expect(snapshot(`${PERSONS}/${PERSON}`).get('kycLevel')).toBe(0);
  });

  // ── (2) Simple 서명은 결정을 인증하지 않는다 ────────────────────────────────

  it('never raises kycLevel from a Simple-signed event, and writes nothing at all', async () => {
    const res = await deliver(v3Body(), { scheme: 'simple' });

    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('unauthenticated decision');
    // `X-Signature-Simple` 은 vendor_data 도 decision 도 덮지 않는다. 사람 문서는 그대로다.
    const person = snapshot(`${PERSONS}/${PERSON}`);
    expect(person.get('kycLevel')).toBe(0);
    expect(person.get('kyc')).toBeUndefined();
    expect(sendAttesterTx).not.toHaveBeenCalled();
    // 도장도 찍지 않는다 — 진짜 서명을 단 같은 이벤트가 뒤이어 오면 정상 처리돼야 한다.
    expect(docs.size).toBe(1);

    const authenticated = await deliver(v3Body());
    expect(authenticated.body).toBe('ok');
    expect(snapshot(`${PERSONS}/${PERSON}`).get('kycLevel')).toBe(1);
  });

  it('refuses a Simple signature while a real signature header is present but wrong', async () => {
    const raw = JSON.stringify(v3Body());
    const timestamp = Math.floor(Date.now() / 1000);
    const simple = createHmac('sha256', SECRET)
      .update(`${timestamp}:s1:Approved:status.updated`, 'utf8')
      .digest('hex');
    const headers: Record<string, string> = {
      'x-signature-v2': 'deadbeef',
      'x-signature-simple': simple,
      'x-timestamp': String(timestamp),
    };
    const res = new FakeRes();
    await (diditWebhook as unknown as (req: unknown, res: unknown) => Promise<void>)(
      { method: 'POST', headers, rawBody: Buffer.from(raw, 'utf8'), get: (name: string) => headers[name.toLowerCase()] },
      res,
    );
    expect(res.statusCode).toBe(401);
    expect(docs.size).toBe(1);
  });

  // ── (2) 서명 실패 로그 ─────────────────────────────────────────────────────

  it('logs the offending body on a signature failure, with the portrait base64 cut out', async () => {
    const res = await deliver(approvedBody(), { signature: 'deadbeef' });

    expect(res.statusCode).toBe(401);
    expect(logged.warn).toHaveBeenCalledWith('didit.signature.rejected', expect.any(Object));
    const entry = JSON.stringify(logged.warn.mock.calls);
    expect(entry).toContain('signature_mismatch');
    expect(entry).toContain('s1'); // 어떤 배달이었는지는 남는다
    // 사진 base64 도 이름도 문서번호도 남지 않는다(스펙 §10.3).
    expect(entry).not.toContain(PORTRAIT_BODY.slice(0, 64));
    expect(entry).not.toContain(NAME_FIRST);
    expect(entry).not.toContain(DOC_NUMBER);
  });

  it('answers 401 with a code that tells a stale timestamp apart from a forged signature', async () => {
    const stale = await deliver(approvedBody(), { timestamp: Math.floor(Date.now() / 1000) - 301 });
    expect(stale.statusCode).toBe(401);
    expect(stale.body).toBe('timestamp_out_of_window');

    const forged = await deliver(approvedBody(), { signature: 'deadbeef' });
    expect(forged.body).toBe('signature_mismatch');

    const unsigned = await deliver(approvedBody(), { scheme: 'none' });
    expect(unsigned.statusCode).toBe(401);
    expect(unsigned.body).toBe('no_signature');

    expect(docs.size).toBe(1);
  });
  // ── 리뷰 fix round 1 ───────────────────────────────────────────────────────

  it('answers 401 to a 64-character multibyte signature on any of the three headers', async () => {
    const multibyte = 'Ã'.repeat(64);
    for (const scheme of ['v2', 'raw', 'simple'] as const) {
      const res = await deliver(v3Body(), { scheme, signature: multibyte });
      // 예전에는 `timingSafeEqual` 이 RangeError 로 터져 인증되지 않은 요청이 500 을 받아 갔다.
      expect(res.statusCode).toBe(401);
      expect(res.body).toBe('signature_mismatch');
    }
    expect(docs.size).toBe(1);
    expect(sendAttesterTx).not.toHaveBeenCalled();
  });

  it('answers 401 — never 500 — to a body too deep to canonicalise, and 2xx when the raw signature is good', async () => {
    // 2만 단 중첩. `JSON.parse` 는 이것을 견디므로 예전에는 정규화에서 스택이 넘쳤다.
    const deep = `{"session_id":"deep","status":"Not Started","vendor_data":"${PERSON}","deep":${'['.repeat(
      20_000,
    )}${']'.repeat(20_000)}}`;

    const v2 = await deliver(null, { raw: deep, scheme: 'v2' });
    expect(v2.statusCode).toBe(401);
    expect(docs.size).toBe(1);

    // 원본 바이트 서명은 정규화를 거치지 않는다 — 평소처럼 접수된다.
    const rawSigned = await deliver(null, { raw: deep, scheme: 'raw' });
    expect(rawSigned.statusCode).toBe(200);
    expect(rawSigned.body).toBe('pending');
    expect(snapshot(`${PERSONS}/${PERSON}`).get('kycLevel')).toBe(0);
    expect(sendAttesterTx).not.toHaveBeenCalled();
  });

  it('turns any unexpected throw in the verification phase into a 401, not a 500', async () => {
    // `req.get` 이 문자열이 아닌 것을 돌려주는 요청. 검증기는 `.trim()` 에서 던진다.
    const headers: Record<string, unknown> = { 'x-timestamp': String(Math.floor(Date.now() / 1000)) };
    const res = new FakeRes();
    await (diditWebhook as unknown as (req: unknown, res: unknown) => Promise<void>)(
      {
        method: 'POST',
        headers,
        rawBody: Buffer.from('{}', 'utf8'),
        get: (name: string) => (name.toLowerCase() === 'x-signature-v2' ? 42 : headers[name.toLowerCase()]),
      },
      res,
    );
    expect(res.statusCode).toBe(401);
    expect(res.body).toBe('verify_error');
    expect(logged.warn).toHaveBeenCalledWith('didit.signature.rejected', expect.objectContaining({ code: 'verify_error' }));
    expect(docs.size).toBe(1);
  });

});
