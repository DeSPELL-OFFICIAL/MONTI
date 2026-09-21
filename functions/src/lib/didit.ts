import { createHmac, timingSafeEqual } from 'node:crypto';
import { DIDIT_WEBHOOK_TOLERANCE_SECONDS } from '@monti/shared';

/**
 * 웹훅 서명은 **파싱 전의 원본 바이트**(`req.rawBody`)에 대해서만 검증한다.
 * JSON.parse → JSON.stringify 를 거치면 키 순서·공백이 달라져 같은 본문도 서명이 깨진다.
 * 비교는 `timingSafeEqual` 로만 한다 — 문자열 `===` 는 앞에서부터 짧게 끊겨 서명을 한 글자씩 맞힐 틈을 준다.
 */
export function verifyDiditSignature(input: {
  raw: string;
  signature: string;
  timestamp: number;
  secret: string;
  now: number;
  toleranceSeconds?: number;
}): boolean {
  const tolerance = input.toleranceSeconds ?? DIDIT_WEBHOOK_TOLERANCE_SECONDS;
  if (!Number.isFinite(input.timestamp) || input.timestamp <= 0) return false;
  if (Math.abs(input.now - input.timestamp) > tolerance) return false;

  const expected = createHmac('sha256', input.secret).update(input.raw, 'utf8').digest('hex');
  const provided = input.signature.trim().toLowerCase();
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(provided, 'utf8'));
}

const PII_KEYS = new Set([
  'first_name', 'last_name', 'full_name', 'date_of_birth', 'document_number', 'personal_number',
  'address', 'portrait_image', 'front_image', 'back_image', 'face_image', 'full_front_image',
  'gender', 'nationality', 'place_of_birth', 'expiration_date', 'date_of_issue', 'issuing_state',
  'phone', 'email', 'age', 'ip_address',
]);

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
