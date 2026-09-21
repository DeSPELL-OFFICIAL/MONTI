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
