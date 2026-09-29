import { FieldValue } from 'firebase-admin/firestore';
import type { TransactionReceipt } from 'viem';
import { ticketAbi } from '@monti/shared';
import { deployment, publicClient } from './chain.js';
import { USAGE, db } from './db.js';

/**
 * 대납 가스 사용 원장(설계 §4). `usage/{scope}` 한 문서에 한 조직/사람이 태운 가스를 모은다.
 * scope 는 `org:{orgId}` 또는 `person:{personId}` 다. **집계 전용** — 지금은 아무것도 막지 않고,
 * 미래 정산·과금의 데이터 기반일 뿐이다(창업자: 무료·최소 유지).
 *
 * 영수증만 있으면 되는 순수한 이음새라 relayAction 의 확정 훅과 relay.ts 의 발급/입장 확정이
 * 같이 쓴다. Firestore 는 bigint 를 담지 못하므로 monSpentWei 는 **십진 문자열**로 읽고 더하고
 * 다시 문자열로 쓴다(FieldValue.increment 는 문자열 bigint 를 더하지 못한다). 동시 확정이 같은
 * scope 에 겹칠 수 있어 읽고-더하고-쓰기를 트랜잭션으로 묶는다.
 */
type UsageReceipt = Pick<TransactionReceipt, 'gasUsed' | 'effectiveGasPrice'>;

export async function recordUsage(scope: string, kind: string, receipt: UsageReceipt): Promise<void> {
  // Monad 는 gas_limit 기준 과금이라 receipt.gasUsed 는 사실상 우리가 정한 한도다 —
  // gasUsed × effectiveGasPrice 가 그 한도 기준 실지출(wei)이다.
  const spentWei = (receipt.gasUsed ?? 0n) * (receipt.effectiveGasPrice ?? 0n);
  const ref = db.collection(USAGE).doc(scope);
  await db.runTransaction(async (tx) => {
    const doc = await tx.get(ref);
    const prev = doc.exists ? BigInt((doc.get('monSpentWei') as string | undefined) ?? '0') : 0n;
    const count = doc.exists ? ((doc.get('count') as number | undefined) ?? 0) : 0;
    tx.set(
      ref,
      {
        monSpentWei: (prev + spentWei).toString(),
        count: count + 1,
        lastAt: FieldValue.serverTimestamp(),
        lastKind: kind,
      },
      { merge: true },
    );
  });
}

/**
 * 공연 이벤트의 **조직 scope** 로 사용량을 기록한다(relay.ts 의 발급/입장 확정이 부른다).
 * 조직 id 의 원본은 체인이라 `Ticket.eventOrg(eventId)` 로 읽어 `org:{orgId}` 로 쓴다.
 */
export async function recordEventUsage(eventId: bigint, kind: string, receipt: UsageReceipt): Promise<void> {
  const orgId = (await publicClient().readContract({
    address: deployment().ticket,
    abi: ticketAbi,
    functionName: 'eventOrg',
    args: [eventId],
  })) as bigint;
  await recordUsage(`org:${orgId.toString()}`, kind, receipt);
}
