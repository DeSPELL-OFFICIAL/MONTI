import { createHmac, timingSafeEqual } from 'node:crypto';
import { decodeEventLog } from 'viem';
import { identityAbi, organizersAbi, ticketAbi, type Hex } from '@monti/shared';

/**
 * Tenderly 웹훅 서명. 문서대로 **본문 바이트 + `Date` 헤더**를 이어 붙인 것에 대한
 * HMAC-SHA256 이다. 본문은 파싱 전의 원본(`req.rawBody`)이어야 한다 —
 * JSON.parse → JSON.stringify 를 거치면 키 순서·공백이 달라져 같은 본문도 서명이 깨진다.
 * 비교는 `timingSafeEqual` 로만 한다(`verifyDiditWebhook` 과 같은 규칙).
 */
export function verifyTenderlySignature(input: {
  raw: string;
  signature: string;
  date: string;
  secret: string;
}): boolean {
  const expected = createHmac('sha256', input.secret).update(input.raw).update(input.date).digest('hex');
  const provided = input.signature.trim().toLowerCase();
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(provided, 'utf8'));
}

export interface TenderlyLog {
  raw: { address?: string; topics: readonly string[]; data: string };
}

/**
 * Tenderly가 붙인 이름을 믿지 않고 로그를 우리 ABI로 직접 디코드한다.
 *
 * `addresses` 를 주면 **그 주소에서 나온 로그만** 본다. 알림 페이로드에는 그 트랜잭션의
 * 로그가 전부 실려 오므로, 같은 트랜잭션에 낀 남의 ERC-721 `Transfer` 는 우리 ABI 로도
 * 그대로 디코드된다 — 주소를 보지 않으면 남의 토큰 이동이 우리 채팅 멤버를 건드린다.
 * 주소 집합을 준 호출에서 `raw.address` 가 없는 로그는 버린다(fail-closed).
 * 인자를 주지 않으면 주소를 보지 않는다 — 순수한 디코더로 단위 테스트할 수 있다.
 */
export function decodeMontiLogs(
  logs: readonly TenderlyLog[],
  addresses?: readonly string[],
): Array<{ name: string; args: Record<string, unknown> }> {
  const allowed = addresses ? new Set(addresses.map((address) => address.toLowerCase())) : undefined;
  const out: Array<{ name: string; args: Record<string, unknown> }> = [];
  for (const log of logs) {
    if (allowed && !allowed.has(String(log.raw.address ?? '').toLowerCase())) continue;
    for (const abi of [ticketAbi, identityAbi, organizersAbi]) {
      try {
        const decoded = decodeEventLog({
          abi,
          topics: log.raw.topics as [Hex, ...Hex[]],
          data: log.raw.data as Hex,
        });
        // `abi` 가 `Abi`(const 단언 없음)라 viem 이 이벤트 이름을 좁혀 주지 못한다.
        out.push({
          name: decoded.eventName as unknown as string,
          args: (decoded.args ?? {}) as Record<string, unknown>,
        });
        break;
      } catch {
        // 이 ABI의 이벤트가 아니다. 다음 ABI를 시도한다.
      }
    }
  }
  return out;
}
