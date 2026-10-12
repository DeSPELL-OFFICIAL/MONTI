import { settlementVaultAbi, type Hex } from '@monti/shared';
import { deployment, publicClient } from './chain.js';
import { ESCROW_STATUS } from './settlementAbi.js';

/**
 * 환불된 티켓 방어선. `SettlementVault.refund` 는 돈만 돌려주고 티켓은 그대로 둔다(소유자 유지·
 * revoke 아님). 그래서 입장·수동 입장·양도 경로가 체인 view 를 한 번 보고 **환불된 티켓을 거절**한다.
 *
 * 진실은 체인이다(결제 진실은 온체인). Firestore 주문의 `refunded` 는 환불 tx 를 **보낸 순간** 찍혀
 * revert 돼도 남으므로 판정에 쓰지 않는다. 읽는 것은 금고의 공개 매핑 getter
 * `escrowOf(uint256) → (token, amount, payer, depositedAt, status)` 의 `status` 하나다
 * (0 None · 1 Held · 2 Released · 3 Refunded, ISettlementVault).
 *
 * 무료 티켓은 escrow 가 아예 없다(status 0) → 막지 않는다. 금고가 배포에 없으면(무료 전용) 역시 통과.
 */

/** Monad 메인넷·테스트넷 공통 Multicall3 정식 주소(viem `monad`/`monadTestnet` 정의와 같다). */
export const MULTICALL3: Hex = '0xcA11bde05977b3631167028862bE2a173976CA11';

/** 거절 코드. 입장(relayCheckIn)은 DENY 어휘, relayAction 은 Solidity 이름 어휘를 쓴다 — 웹이 둘 다 "취소된 티켓"으로 보여준다. */
export const REFUNDED_CHECKIN_CODE = 'REVOKED';
export const REFUNDED_ACTION_CODE = 'TicketRevoked';

type EscrowTuple = readonly [Hex, bigint, Hex, bigint, number];

function vault(): Hex | undefined {
  return deployment().settlementVault;
}

/** 이 토큰의 escrow 가 환불됐는가. RPC 1회(eth_call 하나). */
export async function isRefunded(tokenId: bigint): Promise<boolean> {
  const address = vault();
  if (!address) return false;
  const escrow = (await publicClient().readContract({
    address,
    abi: settlementVaultAbi,
    functionName: 'escrowOf',
    args: [tokenId],
  })) as EscrowTuple;
  return Number(escrow[4]) === ESCROW_STATUS.refunded;
}

/**
 * 여러 토큰 중 환불된 것의 id(10진 문자열) 집합. Multicall3 한 번(eth_call 하나)으로 읽는다 —
 * 스냅샷 한 쪽(≤500장)을 쪼개지 않게 `batchSize: 0`.
 */
export async function refundedAmong(tokenIds: readonly bigint[]): Promise<Set<string>> {
  const address = vault();
  if (!address || tokenIds.length === 0) return new Set();
  const results = (await publicClient().multicall({
    contracts: tokenIds.map((tokenId) => ({
      address,
      abi: settlementVaultAbi,
      functionName: 'escrowOf',
      args: [tokenId],
    })),
    allowFailure: false,
    batchSize: 0,
    multicallAddress: MULTICALL3,
  } as never)) as unknown as readonly EscrowTuple[];
  const refunded = new Set<string>();
  results.forEach((escrow, i) => {
    if (Number(escrow[4]) === ESCROW_STATUS.refunded) refunded.add(tokenIds[i]!.toString());
  });
  return refunded;
}
