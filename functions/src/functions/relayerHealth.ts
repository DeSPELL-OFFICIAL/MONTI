import { FieldValue } from 'firebase-admin/firestore';
import { error, info } from 'firebase-functions/logger';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { formatEther, parseEther } from 'viem';
import { RELAYER_LOW_BALANCE_MON, RELAYER_PK } from '../config.js';
import { publicClient } from '../lib/chain.js';
import { SYSTEM, db } from '../lib/db.js';
import { getRelayerAccount } from '../lib/relayer.js';

/** 10분마다. 설계 §5 "잔액 모니터링" — 신규 인프라 없이 dailyExport/reconcilePending 패턴을 따른다. */
const SCHEDULE = 'every 10 minutes';

/**
 * 순수 판정: 잔액이 임계치(MON) 아래인가. **wei 로 비교**해 부동소수 오차를 없앤다
 * (`parseEther` 로 임계치를 wei 로 올린다).
 */
export function isRelayerBalanceLow(balanceWei: bigint, thresholdMon: number): boolean {
  return balanceWei < parseEther(String(thresholdMon));
}

/**
 * 릴레이어 EOA 잔액을 주기적으로 확인한다(설계 §5).
 *
 * 매 실행 `system/relayer` 문서(주소·잔액·확인시각)를 갱신해 관리자 UI 가 나중에 싸게 읽게 하고,
 * 임계치(`RELAYER_LOW_BALANCE_MON`, 기본 3 MON) 아래면 `system/alerts` 문서에 경보를 남기고
 * error 레벨로 로그한다. `system/*` 는 서버 전용이라 클라이언트는 규칙의 포괄 거부로 닿지 못한다.
 *
 * **스케줄러 밖으로는 던지지 않는다** — 던지면 Cloud Scheduler 가 같은 실행을 재시도한다.
 */
export const relayerHealth = onSchedule(
  { schedule: SCHEDULE, timeZone: 'Asia/Seoul', secrets: [RELAYER_PK] },
  async () => {
    const address = getRelayerAccount().address;

    let balanceWei: bigint;
    try {
      balanceWei = await publicClient().getBalance({ address });
    } catch (cause) {
      error('relayerHealth.balance.read', { address, reason: (cause as Error).message });
      return;
    }
    const balanceMon = formatEther(balanceWei);
    const thresholdMon = Number(RELAYER_LOW_BALANCE_MON.value());

    try {
      await db
        .collection(SYSTEM)
        .doc('relayer')
        .set(
          {
            address,
            balanceWei: balanceWei.toString(),
            balanceMon,
            lastCheckedAt: FieldValue.serverTimestamp(),
          },
          { merge: true },
        );

      if (isRelayerBalanceLow(balanceWei, thresholdMon)) {
        error('relayerHealth.lowBalance', { address, balanceMon, thresholdMon });
        await db
          .collection(SYSTEM)
          .doc('alerts')
          .set(
            {
              'relayer-low-balance': {
                address,
                balanceWei: balanceWei.toString(),
                balanceMon,
                thresholdMon,
                at: FieldValue.serverTimestamp(),
              },
            },
            { merge: true },
          );
      } else {
        info('relayerHealth.ok', { address, balanceMon });
      }
    } catch (cause) {
      error('relayerHealth.write', { address, reason: (cause as Error).message });
    }
  },
);
