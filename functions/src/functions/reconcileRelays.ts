import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { error } from 'firebase-functions/logger';
import { TransactionReceiptNotFoundError } from 'viem';
import type { Hex } from '@monti/shared';
import { publicClient } from '../lib/chain.js';
import { ADMISSIONS, ADMISSION_TOKENS, RELAYS, db } from '../lib/db.js';
import { isCheckInKind, type RelayError, type RelayKind } from '../lib/relayTypes.js';
import { actionFor } from '../lib/actionAllowlist.js';
import { postConfirm } from '../lib/postConfirm.js';

/**
 * 릴레이 타임아웃 대사(설계 §5). `sent` 로 멈춘 릴레이를 영수증과 대조해 `confirmed`/`failed`
 * 로 닫고, 체크인이면 대기 테이블(`admissions`)도 함께 옮긴다. `reconcilePending` 스케줄러의
 * 스윕 하나로 붙는다 — 새 인프라(스케줄러)를 만들지 않는다.
 */

/** 브로드캐스트 뒤 이만큼 지난 `sent` 만 본다. 살아 있는 콜러블이 마무리 중인 건 건드리지 않는다. */
const RELAY_STALE_MS = 2 * 60 * 1000;
/** 영수증이 이만큼 지나도록 없으면 드롭으로 본다. */
const RELAY_DROP_MS = 10 * 60 * 1000;
/** 한 실행이 볼 문서 상한(`reconcilePending` 의 SWEEP_LIMIT 과 같은 뜻). */
const SWEEP_LIMIT = 200;

type PublicClient = ReturnType<typeof publicClient>;
type Doc = FirebaseFirestore.QueryDocumentSnapshot;

/** 이 릴레이를 어떻게 닫을지. `wait` 는 아직 결론이 없어 다음 틱으로 미루는 것. */
export type RelayDecision =
  | { kind: 'wait' }
  | { kind: 'confirm'; receipt: { logs: readonly unknown[] } }
  | { kind: 'fail'; error: RelayError };

/**
 * 영수증을 읽되 **"없다"는 답만** 드롭으로 읽는다(reconcilePending 과 같은 규약). 네트워크
 * 오류·타임아웃·429 까지 드롭으로 오독하면 RPC 가 흔들릴 때 살아 있는 tx 를 실패로 닫는다 —
 * 그 밖의 오류는 그대로 올려 문서별 catch 가 로그만 남기고 문서는 손대지 않게 한다.
 */
async function receiptOrDropped(pc: PublicClient, hash: Hex) {
  try {
    return await pc.getTransactionReceipt({ hash });
  } catch (cause) {
    if (cause instanceof TransactionReceiptNotFoundError) return null;
    throw cause;
  }
}

/**
 * revert 사유를 **얻을 수 있으면** 얻는다("if obtainable"). 채굴됐지만 되돌아간 tx 의 사유는
 * 영수증에 없어 같은 블록에서 eth_call 로 재현해야 한다 — 재현이 안 되거나 무엇이든 실패하면
 * 일반 문구로 떨어진다. 읽기 전용이라 가스를 쓰지 않는다.
 */
async function revertReason(pc: PublicClient, hash: Hex): Promise<string> {
  try {
    const tx = await pc.getTransaction({ hash });
    await pc.call({
      to: tx.to ?? undefined,
      data: tx.input,
      account: tx.from,
      value: tx.value,
      blockNumber: tx.blockNumber ?? undefined,
    });
    return 'execution reverted';
  } catch (cause) {
    const e = cause as { shortMessage?: string; details?: string; message?: string };
    return e.shortMessage ?? e.details ?? e.message ?? 'execution reverted';
  }
}

/**
 * 상태 전이만 정한다(순수에 가깝다 — 오직 스텁 가능한 체인 읽기만 부른다). 쓰기는 하지 않아
 * 스텁 클라이언트만으로 전 분기를 검증할 수 있다.
 *  - 영수증 success        → confirm
 *  - 영수증 reverted       → fail(REVERTED, 사유 있으면 사유)
 *  - 영수증 없음, 10분 초과 → fail(TX_DROPPED)
 *  - 영수증 없음, 아직      → wait
 */
export async function decideRelay(
  view: { txHash?: Hex; sentAtMs: number; nowMs: number },
  pc: PublicClient,
): Promise<RelayDecision> {
  const dropped = view.nowMs - view.sentAtMs > RELAY_DROP_MS;
  if (!view.txHash) {
    // `sent` 인데 해시가 없다 — 비정상. 드롭 창을 넘겼으면 닫고, 아니면 기다린다.
    return dropped
      ? { kind: 'fail', error: { code: 'TX_DROPPED', message: 'sent without a tx hash' } }
      : { kind: 'wait' };
  }
  const receipt = await receiptOrDropped(pc, view.txHash);
  if (receipt) {
    if (receipt.status === 'success') return { kind: 'confirm', receipt: { logs: receipt.logs ?? [] } };
    return { kind: 'fail', error: { code: 'REVERTED', message: await revertReason(pc, view.txHash) } };
  }
  if (dropped) {
    return { kind: 'fail', error: { code: 'TX_DROPPED', message: 'no receipt after 10 minutes' } };
  }
  return { kind: 'wait' };
}

/** `admissions/{eventId}/tokens/{tokenId}` 참조. */
function admissionRef(eventId: string, tokenId: string) {
  return db.collection(ADMISSIONS).doc(eventId).collection(ADMISSION_TOKENS).doc(tokenId);
}

/** relays 문서에 남은 입력(kind·account·data·reasons·txHash)으로 확정 훅을 다시 돌린다. */
async function rerunPostConfirm(doc: Doc, receipt: { logs: readonly unknown[] }) {
  const data = doc.get('data') as Hex | undefined;
  const txHash = doc.get('txHash') as Hex | undefined;
  if (!data || !txHash) return undefined;
  const reasons = doc.get('reasons') as string[] | undefined;
  return postConfirm(
    {
      relayId: doc.id,
      kind: doc.get('kind') as string,
      account: doc.get('account') as Hex,
      data,
      ...(reasons ? { reasons } : {}),
      txHash,
    },
    receipt,
  );
}

/**
 * 결정을 Firestore 에 적용한다. 확정/실패는 merge 로 써서 콜러블(C2)이 남긴 다른 칸
 * (gateId·relayId·passedAt 등)을 지우지 않는다. 체크인일 때만 대기 테이블을 함께 옮긴다 —
 * claim 은 대기 테이블이 없다.
 */
export async function applyRelayDecision(doc: Doc, decision: RelayDecision): Promise<void> {
  if (decision.kind === 'wait') return;

  const kind = doc.get('kind') as RelayKind;
  const eventId = doc.get('eventId') as string | undefined;
  const tokenId = doc.get('tokenId') as string | undefined;
  const admission =
    isCheckInKind(kind) && eventId && tokenId ? admissionRef(eventId, tokenId) : null;

  if (decision.kind === 'confirm') {
    const confirmedAt = FieldValue.serverTimestamp();
    // relayAction 문서(allowlist kind)는 콜러블과 **같은 확정 훅**을 돌리고 결과를 남긴다 — 8초를 넘겨
    // 확정된 공개의 eventId 가 사라지던 v1 결함의 수리다. purchase·claim·checkIn 은 allowlist 밖이라 건너뛴다.
    const result = actionFor(kind) ? await rerunPostConfirm(doc, decision.receipt) : undefined;
    await doc.ref.set({ status: 'confirmed', confirmedAt, ...(result ? { result } : {}) }, { merge: true });
    if (admission) await admission.set({ status: 'confirmed', confirmedAt }, { merge: true });
    return;
  }

  await doc.ref.set(
    { status: 'failed', failedAt: FieldValue.serverTimestamp(), error: decision.error },
    { merge: true },
  );
  if (admission) await admission.set({ status: 'failed' }, { merge: true });
}

/**
 * 2분 넘게 `sent` 에 멈춘 릴레이를 체인 영수증과 대조해 닫는다. 부등호를 질의에 넣어
 * (`relays (status, sentAt)` 색인) 가장 오래 멈춘 것부터 창에 들어오게 한다 —
 * 메모리에서 거르면 밀린 문서가 200칸 창을 영영 점유한다(reconcilePending 의 같은 이유).
 */
export async function sweepRelays(): Promise<void> {
  const cutoff = Timestamp.fromMillis(Date.now() - RELAY_STALE_MS);
  const snapshot = await db
    .collection(RELAYS)
    .where('status', '==', 'sent')
    .where('sentAt', '<', cutoff)
    .limit(SWEEP_LIMIT)
    .get();
  if (snapshot.empty) return;

  const pc = publicClient();
  const nowMs = Date.now();
  for (const doc of snapshot.docs) {
    // 문서 하나가 터져도 나머지는 계속 간다 — 깨진 문서 하나가 밀린 전부를 막지 않는다.
    try {
      const sentAt = doc.get('sentAt') as Timestamp | undefined;
      const decision = await decideRelay(
        { txHash: doc.get('txHash') as Hex | undefined, sentAtMs: sentAt?.toMillis() ?? nowMs, nowMs },
        pc,
      );
      await applyRelayDecision(doc, decision);
    } catch (cause) {
      error('reconcile.relay', { relayId: doc.id, reason: (cause as Error).message });
    }
  }
}
