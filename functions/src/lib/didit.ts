import { createHmac, timingSafeEqual } from 'node:crypto';
import { DIDIT_WEBHOOK_TOLERANCE_SECONDS } from '@monti/shared';

// ─────────────────────────────────────────────────────────────────────────────
// Didit 웹훅 서명 — V2(정규화 JSON) · raw 바이트 · Simple(4필드)
// ─────────────────────────────────────────────────────────────────────────────

/** 세션 결정을 실어 오는 `webhook_type` 은 이 둘뿐이다. 나머지는 받기만 하고 버린다. */
export const DIDIT_SESSION_WEBHOOK_TYPES = ['status.updated', 'data.updated'] as const;

/** Didit 이 보내는 세션 상태 전부(V3 기준). 여기 없는 값은 접수만 하고 넘어간다. */
export const DIDIT_STATUSES = [
  'Approved',
  'Declined',
  'In Review',
  'In Progress',
  'Not Started',
  'Abandoned',
  'Expired',
  'KYC Expired',
  'Resubmitted',
] as const;
export type DiditStatus = (typeof DIDIT_STATUSES)[number];

/**
 * 키를 **코드 포인트** 순으로 비교한다. JS 의 기본 정렬은 UTF-16 코드 유닛 순이라
 * 보조 평면 문자(서로게이트 쌍)가 U+E000..U+FFFF 보다 **앞**으로 간다 — Python 의
 * `sorted()` 는 코드 포인트 순이므로 그 자리에서만 두 정렬이 갈린다. 서명은 바이트가
 * 한 글자만 달라도 깨지므로, 갈릴 수 있는 자리를 아예 없앤다.
 */
function byCodePoint(a: string, b: string): number {
  const left = [...a];
  const right = [...b];
  const shared = Math.min(left.length, right.length);
  for (let i = 0; i < shared; i += 1) {
    const diff = (left[i]?.codePointAt(0) ?? 0) - (right[i]?.codePointAt(0) ?? 0);
    if (diff !== 0) return diff;
  }
  return left.length - right.length;
}

/**
 * 정규화가 들어갈 수 있는 최대 깊이. Didit 의 봉투는 `decision.id_verifications[].warnings[]` 까지
 * 세어도 대여섯 단이다. 상한이 없으면 `[[[[…]]]]` 2만 단짜리 본문 하나로 스택이 넘쳐
 * **인증되지 않은** 요청이 500 을 받아 간다 — Didit 은 5xx 에 두 번 더 때린다.
 */
const CANONICAL_MAX_DEPTH = 64;

/** 상한을 넘었다는 뜻. 서명을 맞출 수 없으므로 부르는 쪽은 그냥 불일치로 접는다. */
class CanonicalDepthError extends Error {
  constructor() {
    super('CANONICAL_TOO_DEEP');
    this.name = 'CanonicalDepthError';
  }
}

function sortDeep(value: unknown, depth: number): unknown {
  if (depth > CANONICAL_MAX_DEPTH) throw new CanonicalDepthError();
  if (Array.isArray(value)) return value.map((item) => sortDeep(item, depth + 1));
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    // 배열은 **순서가 값**이다. 정렬하지 않는다 — 객체의 키만 정렬한다.
    for (const key of Object.keys(source).sort(byCodePoint)) out[key] = sortDeep(source[key], depth + 1);
    return out;
  }
  return value;
}

/**
 * `X-Signature-V2` 가 서명하는 문자열. Didit 서버의
 * `json.dumps(body, sort_keys=True, separators=(',', ':'), ensure_ascii=False)` 와 같은 바이트다.
 *
 *  - 키는 **재귀적으로** 코드 포인트 사전순. 배열 순서는 그대로 둔다.
 *  - 구분자는 `,` 와 `:` 뿐 — 공백을 넣지 않는다(`JSON.stringify` 의 기본값).
 *  - 유니코드는 **그대로** 둔다. `\uXXXX` 로 이스케이프하면 한글이 든 본문마다 서명이 깨진다.
 *  - 깊이가 `CANONICAL_MAX_DEPTH` 를 넘으면 **던진다**. 그런 본문에는 맞출 서명이 없다.
 *
 * 순수 함수다. 들어온 값을 고치지 않고, 시계도 비밀값도 보지 않는다 — 테스트가 손으로 계산한
 * 벡터 하나로 이 정의 전체를 못 박는다.
 */
export function canonicalDiditJson(value: unknown): string {
  return JSON.stringify(sortDeep(value, 0));
}

export type DiditSignatureScheme = 'v2' | 'raw' | 'simple';

/** 서명을 거절한 이유. 핸들러가 이 값으로 상태 코드와 로그를 고른다. */
export type DiditRejection =
  | 'timestamp_out_of_window'
  | 'no_signature'
  | 'malformed_body'
  | 'signature_mismatch'
  /** 검증 단계에서 우리가 못 본 입력 모양을 만났다. 서버 고장이 아니라 거절이다. */
  | 'verify_error';

export type DiditVerification =
  | {
      ok: true;
      scheme: DiditSignatureScheme;
      /**
       * **결정(decision)까지** 서명이 덮었는가. `simple` 은 `timestamp:session_id:status:webhook_type`
       * 네 값만 덮으므로 `vendor_data` 도 `decision` 도 인증하지 않는다 — 그 배달로는
       * 사람 문서를 건드리지 않는다(`kycLevel` 을 올리는 길은 더더욱 없다).
       */
      authenticated: boolean;
      body: unknown;
    }
  | { ok: false; code: DiditRejection };

function hmacHex(secret: string, message: string): string {
  return createHmac('sha256', secret).update(message, 'utf8').digest('hex');
}

/** HMAC-SHA256 은 32바이트다. 서명 헤더가 이 모양이 아니면 비교할 것도 없다. */
const HEX_SIGNATURE_RE = /^[0-9a-f]{64}$/i;

/**
 * 서명 비교. 양쪽을 **32바이트 버퍼로 풀어** `timingSafeEqual` 에 넘긴다 — 문자열 `===` 는
 * 앞에서부터 짧게 끊겨 서명을 한 글자씩 맞힐 틈을 준다.
 *
 * 글자 수로 길이를 재면 안 된다. `timingSafeEqual` 은 **바이트**로 세므로, 멀티바이트 문자
 * 64글자짜리 헤더(예: `Ã` × 64 = 128바이트)는 글자 수 검사를 통과한 뒤 `RangeError` 로 터진다 —
 * 인증되지 않은 요청 하나가 500 을 받아 가는 길이다. 모양이 아니면 **조용히 불일치**다.
 */
function signatureMatches(expected: string, provided: string): boolean {
  const candidate = provided.trim();
  if (!HEX_SIGNATURE_RE.test(candidate)) return false;
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(candidate.toLowerCase(), 'hex'));
}

/**
 * 받은 **원본 바이트**로 세 가지 서명 중 하나를 맞춘다. 맞은 것이 없으면 아무것도 파싱하지 않은 셈이다.
 *
 *  1. `X-Signature`     원본 바이트 그대로의 HMAC. JSON 이 아니어도 맞출 수 있어 **먼저** 본다.
 *  2. `X-Signature-V2`  정규화 JSON 의 HMAC(위 `canonicalDiditJson`). Didit 이 권하는 헤더다.
 *  3. `X-Signature-Simple` 네 값만 덮는 폴백. **다른 두 헤더가 아예 없을 때만** 받는다 —
 *     있는데 틀렸다면 그것은 위조이고, 약한 서명으로 갈아타 통과시켜 줄 이유가 없다.
 *
 * 타임스탬프 창(±300초)을 **가장 먼저** 본다. 오래된 배달은 서명이 맞아도 재생 공격이다.
 */
export function verifyDiditWebhook(input: {
  raw: string;
  v2?: string;
  rawSignature?: string;
  simple?: string;
  timestamp: number;
  secret: string;
  now: number;
  toleranceSeconds?: number;
}): DiditVerification {
  const tolerance = input.toleranceSeconds ?? DIDIT_WEBHOOK_TOLERANCE_SECONDS;
  if (!Number.isFinite(input.timestamp) || input.timestamp <= 0) {
    return { ok: false, code: 'timestamp_out_of_window' };
  }
  if (Math.abs(input.now - input.timestamp) > tolerance) {
    return { ok: false, code: 'timestamp_out_of_window' };
  }

  const v2 = (input.v2 ?? '').trim();
  const rawSignature = (input.rawSignature ?? '').trim();
  const simple = (input.simple ?? '').trim();
  if (!v2 && !rawSignature && !simple) return { ok: false, code: 'no_signature' };

  // 원본 바이트 서명부터. 본문이 JSON 이 아니어도 여기서 끝나므로 파싱이 필요 없다.
  const rawMatched = rawSignature !== '' && signatureMatches(hmacHex(input.secret, input.raw), rawSignature);

  let body: unknown;
  try {
    body = JSON.parse(input.raw);
  } catch {
    // 원본 바이트 서명이 맞았다면 JSON 이 아니어도 Didit 이 보낸 것은 맞다 — 본문만 못 읽는다.
    if (rawMatched) return { ok: true, scheme: 'raw', authenticated: true, body: undefined };
    // V2 와 Simple 은 파싱 없이는 맞춰 볼 수조차 없다. 위조인지 깨진 본문인지 가릴 길이 없으므로
    // 덜 단정적인 쪽으로 답한다 — 어차피 아무것도 쓰지 않고 끝난다.
    return { ok: false, code: 'malformed_body' };
  }
  if (rawMatched) return { ok: true, scheme: 'raw', authenticated: true, body };

  if (v2 !== '') {
    // 정규화할 수 없는 본문에는 맞출 V2 서명이 없다. 던지지 말고 불일치로 접는다 —
    // 원본 바이트 서명은 위에서 이미 봤고, 아래 Simple 분기도 그대로 돈다.
    let canonical: string | null = null;
    try {
      canonical = canonicalDiditJson(body);
    } catch {
      canonical = null;
    }
    if (canonical !== null && signatureMatches(hmacHex(input.secret, canonical), v2)) {
      return { ok: true, scheme: 'v2', authenticated: true, body };
    }
  }

  if (v2 === '' && rawSignature === '' && simple !== '') {
    const envelope = body as { session_id?: unknown; status?: unknown; webhook_type?: unknown };
    const message = [
      input.timestamp,
      typeof envelope.session_id === 'string' ? envelope.session_id : '',
      typeof envelope.status === 'string' ? envelope.status : '',
      typeof envelope.webhook_type === 'string' ? envelope.webhook_type : '',
    ].join(':');
    if (signatureMatches(hmacHex(input.secret, message), simple)) {
      return { ok: true, scheme: 'simple', authenticated: false, body };
    }
  }

  return { ok: false, code: 'signature_mismatch' };
}

const PII_KEYS = new Set([
  'first_name', 'last_name', 'full_name', 'date_of_birth', 'document_number', 'personal_number',
  'address', 'portrait_image', 'front_image', 'back_image', 'face_image', 'full_front_image',
  'gender', 'nationality', 'place_of_birth', 'expiration_date', 'date_of_issue', 'issuing_state',
  'phone', 'email', 'age', 'ip_address',
]);

/** 256자 넘게 이어지는 base64 덩어리. 사진·문서 스캔은 전부 여기 걸린다. */
const BASE64_RUN = /[A-Za-z0-9+/=_-]{256,}/g;
const PII_VALUE = new RegExp(`"(${[...PII_KEYS].join('|')})"\\s*:\\s*"(?:[^"\\\\]|\\\\.)*"`, 'g');

/**
 * 서명이 틀린 본문을 **로그에 남기기 위해** 깎는다(Didit 통합 규격: 서명 실패 시 원본을 남긴다).
 *
 * 규격과 우리 §10.3(개인정보는 로그에 남기지 않는다)이 부딪히는 자리다. 통째로 남기는 대신
 * 남기는 이유 — 어느 스킴으로 어떤 모양이 왔는지 —만 남긴다: 알려진 개인정보 키의 값과
 * base64 덩어리를 지우고 2 KB 에서 자른다. 본문이 JSON 이 아닐 수도 있으므로(그래서 서명이
 * 틀렸을 수도 있다) 파싱하지 않고 문자열 위에서 깎는다.
 */
export function redactRawBody(raw: string, limit = 2048): string {
  const scrubbed = raw
    .replace(PII_VALUE, (_match, key: string) => `"${key}":"[redacted]"`)
    .replace(BASE64_RUN, '[redacted]');
  return scrubbed.length > limit ? `${scrubbed.slice(0, limit)}…[+${scrubbed.length - limit}B]` : scrubbed;
}

/** 개인정보는 체인에도 로그에도 Firestore 원본에도 남기지 않는다(스펙 §10.3). */
export function redactDiditPayload(input: unknown): unknown {
  if (Array.isArray(input)) return input.map(redactDiditPayload);
  if (input !== null && typeof input === 'object') {
    const source = input as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(source)) {
      out[key] = PII_KEYS.has(key) ? '[redacted]' : redactDiditPayload(value);
    }
    return out;
  }
  return input;
}

/**
 * 거절 사유는 **우리가 정한 이 네 개뿐**이다. Didit 이 준 자유 문장은 저장하지도 보여주지도
 * 않는다 — 웹은 이 코드마다 다른 안내를 그린다(관객이 다음에 무엇을 해야 하는지가 다르다).
 *  - `declined`             Didit 이 문서·얼굴 검증에서 거절했다(Expired·Abandoned 포함).
 *  - `duplicate_face`       Face Search 1:N 이 같은 얼굴을 이미 찾았다 — "이미 계정이 있습니다".
 *  - `face_search_missing`  승인인데 Face Search 결과 자체가 없다. **중복 얼굴이 아니다.**
 *  - `face_search_not_clear` 승인인데 Face Search 가 `clear` 도 `duplicate` 도 아닌 값을 줬다.
 * 넷 다 `kycLevel` 을 올리지 않는다(fail-closed).
 */
export type KycDeclineReason =
  | 'declined'
  | 'duplicate_face'
  | 'face_search_missing'
  | 'face_search_not_clear';

/** Didit 의 `status` + `decision.face_search.status` 를 위 네 값 중 하나로 접는다. */
export function declineReason(status: string, faceSearch: string | null): KycDeclineReason {
  if (status !== 'Approved') return 'declined';
  if (faceSearch === null) return 'face_search_missing';
  if (faceSearch === 'duplicate') return 'duplicate_face';
  return 'face_search_not_clear';
}

// ─────────────────────────────────────────────────────────────────────────────
// V3 decision — 복수형 배열에서 노드를 꺼낸다
// ─────────────────────────────────────────────────────────────────────────────

/** V3 는 검증 노드마다 `node_id` 가 붙은 **배열**을 보낸다. 워크플로가 한 번만 돌면 항목도 하나다. */
export interface DiditNode {
  node_id?: string;
  status?: string;
  warnings?: Array<{ risk?: string; log_type?: string; short_description?: string; long_description?: string }>;
  [key: string]: unknown;
}

export interface DiditIdVerification extends DiditNode {
  first_name?: string;
  last_name?: string;
  document_number?: string;
  portrait_image?: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * `decision` 에서 노드 하나를 꺼낸다. **V3 의 복수형 배열이 먼저**고(첫 항목), 없으면 예전
 * 단수 키로 물러난다. 둘 다 없으면 `undefined` — 빈 객체를 지어내지 않는다. 그래야 부르는 쪽이
 * "값이 없다"와 "빈 값이 왔다"를 구분한다(빈 값으로 기존 봉투를 덮어쓰면 조용한 데이터 손실이다).
 */
function pickNode<T extends DiditNode>(decision: unknown, plural: string, singular: string): T | undefined {
  const source = asRecord(decision);
  const list = source[plural];
  if (Array.isArray(list)) {
    const first = list.find((item) => item !== null && typeof item === 'object');
    if (first) return first as T;
  }
  const one = source[singular];
  if (one !== null && typeof one === 'object' && !Array.isArray(one)) return one as T;
  return undefined;
}

export function diditIdVerification(decision: unknown): DiditIdVerification | undefined {
  return pickNode<DiditIdVerification>(decision, 'id_verifications', 'id_verification');
}

export function diditFaceMatch(decision: unknown): DiditNode | undefined {
  return pickNode<DiditNode>(decision, 'face_matches', 'face_match');
}

export function diditFaceSearch(decision: unknown): DiditNode | undefined {
  return pickNode<DiditNode>(decision, 'face_searches', 'face_search');
}

/** `face_match` 의 통과 값은 `Approved` 다. 1:N 얼굴 검색의 `clear` 와 같은 뜻으로 접는다. */
function normalizeFaceMatch(status: string): string {
  const lower = status.trim().toLowerCase();
  return lower === 'approved' || lower === 'match' ? 'clear' : lower;
}

/**
 * 얼굴 신호 하나로 접는다. `face_search`(1:N 중복 검색)가 먼저고, 없으면 `face_matches[]`
 * (셀피 ↔ 신분증 사진 대조)를 본다. 둘 다 없으면 `null` — **"중복"이 아니라 "없음"**이다.
 */
export function faceSearchStatus(decision: unknown): string | null {
  const search = diditFaceSearch(decision);
  if (typeof search?.status === 'string') return search.status;
  const match = diditFaceMatch(decision);
  if (typeof match?.status === 'string') return normalizeFaceMatch(match.status);
  return null;
}

const DUPLICATE_WARNING = /duplicat|same[_\s-]?face|face[_\s-]?(?:reuse|repeat)/i;

/**
 * V3 는 중복 얼굴을 별도 상태가 아니라 **경고**로 싣는다. 세 배열(`face_matches`,
 * `aml_screenings`, `id_verifications`)의 `warnings[]` 를 훑어 중복을 가리키는 것이 있는지 본다.
 */
export function hasDuplicateFaceWarning(decision: unknown): boolean {
  const source = asRecord(decision);
  for (const key of ['face_matches', 'aml_screenings', 'id_verifications', 'face_searches']) {
    const list = source[key];
    const nodes = Array.isArray(list) ? list : [source[key.replace(/(?:es|s)$/, '')]];
    for (const node of nodes) {
      const warnings = asRecord(node).warnings;
      if (!Array.isArray(warnings)) continue;
      for (const warning of warnings) {
        const text = Object.values(asRecord(warning))
          .filter((value): value is string => typeof value === 'string')
          .join(' ');
        if (DUPLICATE_WARNING.test(text)) return true;
      }
    }
  }
  return false;
}

/** `kycLevel` 을 올려도 되는 얼굴 신호인가. 중복 경고 하나라도 있으면 아니다(fail-closed). */
export function faceSearchClear(decision: unknown): boolean {
  return !hasDuplicateFaceWarning(decision) && faceSearchStatus(decision) === 'clear';
}

/** V3 배열과 경고까지 본 뒤 위 네 값 중 하나로 접는다. `declineReason` 의 V3 입구다. */
export function declineReasonFromDecision(status: string, decision: unknown): KycDeclineReason {
  if (hasDuplicateFaceWarning(decision)) return 'duplicate_face';
  return declineReason(status, faceSearchStatus(decision));
}

const DIDIT_API = 'https://verification.didit.me/v2';

export interface DiditSession {
  sessionId: string;
  url: string;
}

/**
 * 본인인증 세션을 연다.
 *
 * `vendorData` 는 **난수 personId** 다. 전화번호·이름 같은 개인정보는 절대 싣지 않는다
 * (스펙 §10.3). Didit 은 이 값을 그대로 웹훅에 돌려주고 `diditWebhook` 이 그것으로
 * 사람 문서를 찾는다 — 그래서 우리가 만든 적 없는 값은 사람을 만들지 못한다.
 *
 * `callbackUrl` 은 검증을 마친 사람이 돌아올 우리 주소다. 아무 주소나 넘기면 우리 이름으로
 * 임의 사이트를 여는 열린 리디렉트가 되므로, 부르는 쪽이 `assertCallbackUrl` 로 먼저 거른다.
 */
export async function createDiditSession(
  vendorData: string,
  apiKey: string,
  workflowId: string,
  callbackUrl: string,
): Promise<DiditSession> {
  const response = await fetch(`${DIDIT_API}/session/`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify({
      workflow_id: workflowId,
      vendor_data: vendorData,
      callback: callbackUrl,
    }),
  });
  if (!response.ok) throw new Error(`DIDIT_SESSION_FAILED:${response.status}`);

  const body = (await response.json()) as { session_id?: string; url?: string };
  if (!body.session_id || !body.url) throw new Error('DIDIT_SESSION_MALFORMED');
  return { sessionId: body.session_id, url: body.url };
}

/**
 * 개인정보 파기 요청. Didit 쪽 세션과 그 안의 생체 템플릿까지 지운다(스펙 §9.2 데이터 항목).
 *
 * 404 는 성공으로 읽는다 — 파기에서 "이미 없다" 는 우리가 원하던 결과다. 그 밖의 실패는
 * 던진다: 부르는 쪽(`processDeletions`)이 우리 DB 를 지우기 **전에** 다시 시도해야 하고,
 * 여기서 조용히 삼키면 Didit 에 자료가 남은 채로 "파기 완료" 도장이 찍힌다.
 */
export async function deleteDiditSession(sessionId: string, apiKey: string): Promise<void> {
  const response = await fetch(`${DIDIT_API}/session/${sessionId}/delete/`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify({ deletion_instruction: 'privacy erasure' }),
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(`DIDIT_DELETE_FAILED:${response.status}`);
  }
}
