import { FieldValue } from 'firebase-admin/firestore';
import type { Hex } from '@monti/shared';
import { OVERRIDE_REQUESTS, db } from './db.js';

/**
 * `manualOverride` 확정 훅(v2 설계 §6). 같은 tokenId 의 **열린** 승인 요청을 모두 `approved` 로
 * 닫는다 — 승인은 요청 문서가 아니라 토큰에 대한 것이라, 게이트를 바꿔 두 번 올린 요청도 함께 닫힌다.
 * 멱등이다: 이미 닫힌 요청은 질의에 걸리지 않는다. 닫은 개수를 돌려준다.
 */
export async function approveOpenOverrideRequests(tokenId: bigint, approvedBy: Hex, txHash: string): Promise<number> {
  const open = await db
    .collection(OVERRIDE_REQUESTS)
    .where('tokenId', '==', tokenId.toString())
    .where('status', '==', 'open')
    .get();
  await Promise.all(
    open.docs.map((doc) =>
      doc.ref.set(
        { status: 'approved', approvedBy, approvedTxHash: txHash, approvedAt: FieldValue.serverTimestamp() },
        { merge: true },
      ),
    ),
  );
  return open.size;
}
