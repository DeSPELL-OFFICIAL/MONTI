import { describe, expect, it } from 'vitest';
import { parseEther } from 'viem';

// db.js 는 모듈 로드 때 initializeApp() 을 부른다 — 다른 함수 테스트와 같이 프로젝트만 넣어 준다.
process.env.GCP_PROJECT_ID = 'monti-dev';

const { isRelayerBalanceLow } = await import('../src/functions/relayerHealth.js');

/**
 * 잔액 경보 판정(설계 §5 "잔액 모니터링"). 순수 함수라 RPC·Firestore 없이 본다.
 * wei 로 비교해 부동소수 오차가 없어야 한다 — 임계치는 `parseEther` 로 wei 로 올린다.
 */
describe('isRelayerBalanceLow — low-balance decision (설계 §5)', () => {
  const THRESHOLD = 3; // 기본 RELAYER_LOW_BALANCE_MON

  it('flags a balance strictly below the threshold', () => {
    expect(isRelayerBalanceLow(parseEther('2.999999999999999999'), THRESHOLD)).toBe(true);
    expect(isRelayerBalanceLow(parseEther('2'), THRESHOLD)).toBe(true);
    expect(isRelayerBalanceLow(0n, THRESHOLD)).toBe(true);
  });

  it('does NOT flag a balance exactly at the threshold (strict <)', () => {
    expect(isRelayerBalanceLow(parseEther('3'), THRESHOLD)).toBe(false);
  });

  it('does NOT flag a balance above the threshold', () => {
    expect(isRelayerBalanceLow(parseEther('3.000000000000000001'), THRESHOLD)).toBe(false);
    expect(isRelayerBalanceLow(parseEther('5'), THRESHOLD)).toBe(false);
  });

  it('honours a custom threshold', () => {
    expect(isRelayerBalanceLow(parseEther('4'), 5)).toBe(true);
    expect(isRelayerBalanceLow(parseEther('6'), 5)).toBe(false);
  });
});
