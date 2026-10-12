import { FieldValue } from 'firebase-admin/firestore';
import { info } from 'firebase-functions/logger';
import { decodeFunctionData, getAddress, hexToString, keccak256, parseEventLogs, toHex } from 'viem';
import { organizersAbi, settlementVaultAbi, ticketAbi, type Hex } from '@monti/shared';
import { PENDING_GATES, SETTLEMENTS, db } from './db.js';
import { approveOpenOverrideRequests } from './overrideRequests.js';

/**
 * relayAction **확정 훅**(v2 설계 §4). 콜러블이 8초 안에 영수증을 받으면 거기서, 못 받으면
 * `reconcileRelays` 가 나중에 같은 함수를 부른다 — 그래서 입력은 relays 문서에 남는 값
 * (kind·account·calldata·reasons·txHash)과 영수증뿐이고, 모든 쓰기는 **멱등**이다.
 * v1 은 타임아웃 뒤 확정된 공개의 eventId 를 영영 기록하지 못했다(대사가 상태만 닫았다).
 */

export interface ConfirmedAction {
  relayId: string;
  kind: string;
  /** 서명한 계정(세션 계정). 정산 거울의 `setBy`, 승인 요청의 `approvedBy`. */
  account: Hex;
  /** 포워드된 대상 calldata. */
  data: Hex;
  /** publishEvent 전용 — 수취인별 사유 원문(해시 일치분만 거울에 남는다). */
  reasons?: string[];
  txHash: Hex;
}

export interface ActionResult {
  eventId?: string;
  gateId?: string;
  orgId?: string;
  tokenIds?: string[];
}

type Logs = readonly unknown[];

function firstArg<T>(logs: Logs, abi: typeof ticketAbi, eventName: string, field: string): T | undefined {
  const parsed = parseEventLogs({ abi, logs: logs as never, eventName } as never) as unknown as {
    args: Record<string, unknown>;
  }[];
  return parsed[0]?.args[field] as T | undefined;
}

/** 확정 영수증에서 kind 별 결과를 뽑는다. 못 뽑으면 undefined — 실패로 보지 않는다. */
export function decodeResult(kind: string, logs: Logs): ActionResult | undefined {
  try {
    if (kind === 'publishEvent') {
      const eventId = firstArg<bigint>(logs, ticketAbi, 'EventCreated', 'eventId');
      return eventId === undefined ? undefined : { eventId: eventId.toString() };
    }
    if (kind === 'registerGate') {
      const gateId = firstArg<bigint>(logs, organizersAbi, 'GateRegistered', 'gateId');
      return gateId === undefined ? undefined : { gateId: gateId.toString() };
    }
    if (kind === 'createOrganizer') {
      const orgId = firstArg<bigint>(logs, organizersAbi, 'OrganizerCreated', 'orgId');
      return orgId === undefined ? undefined : { orgId: orgId.toString() };
    }
    if (kind === 'approveClaims') {
      const parsed = parseEventLogs({ abi: ticketAbi, logs: logs as never, eventName: 'ClaimApproved' } as never) as unknown as {
        args: { tokenId?: bigint };
      }[];
      const tokenIds = parsed
        .map((e) => e.args.tokenId)
        .filter((t): t is bigint => t !== undefined)
        .map((t) => t.toString());
      return tokenIds.length ? { tokenIds } : undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

interface PublishArgs {
  meta: { orgId: bigint };
  tiers: readonly { priceUsdCents: bigint }[];
  policy: {
    recipients: readonly { account: Hex; bps: number; reasonHash: Hex; tag: Hex }[];
    platformBps: number;
  };
}

/** publishEvent calldata → (meta, tiers, policy). relayAction 의 사유 검증도 같은 디코더를 쓴다. */
export function decodePublish(data: Hex): PublishArgs {
  const decoded = decodeFunctionData({ abi: ticketAbi, data });
  if (decoded.functionName !== 'publishEvent' || (decoded.args?.length ?? 0) !== 3) throw new Error('NOT_PUBLISH');
  const [meta, tiers, policy] = decoded.args as unknown as [PublishArgs['meta'], PublishArgs['tiers'], PublishArgs['policy']];
  return { meta, tiers, policy };
}

/**
 * 유료 공개의 **공개 정산 거울**(`settlements/{eventId}`). 가격·정책은 방금 체인에 들어간 calldata 를
 * 그대로 디코드한 값이고(정본은 체인), `policyHash` 는 금고의 `PolicySet` 로그에서 읽는다. 사유 원문은
 * `keccak256(reason) == reasonHash` 일 때만 남긴다 — 위조된 사유가 공개 페이지에 오르지 않게.
 * 무료 공개에는 거울이 없다(정책도 없다).
 */
async function mirrorSettlement(action: ConfirmedAction, eventId: string, logs: Logs): Promise<void> {
  const { meta, tiers, policy } = decodePublish(action.data);
  if (!tiers.some((tier) => tier.priceUsdCents > 0n)) return;
  const policyHash = firstArg<Hex>(logs, settlementVaultAbi as typeof ticketAbi, 'PolicySet', 'policyHash');
  const recipients = policy.recipients.map((r, i) => {
    const reason = action.reasons?.[i] ?? '';
    return {
      account: getAddress(r.account),
      bps: Number(r.bps),
      reason: reason && keccak256(toHex(reason)) === r.reasonHash.toLowerCase() ? reason : '',
      tag: hexToString(r.tag, { size: 32 }),
    };
  });
  await db
    .collection(SETTLEMENTS)
    .doc(eventId)
    .set({
      orgId: meta.orgId.toString(),
      policy: { recipients, platformBps: Number(policy.platformBps) },
      ...(policyHash ? { policyHash } : {}),
      priceUsdCentsByTier: Object.fromEntries(tiers.map((tier, i) => [String(i), Number(tier.priceUsdCents)])),
      setBy: action.account,
      txHash: action.txHash,
      updatedAt: FieldValue.serverTimestamp(),
    });
}

/**
 * 등록된 게이트의 대기 줄을 닫는다. v2 의 `registerGate` 는 같은 tx 에서 게이트를 연다(GateOpened).
 * 대기 줄이 없으면(단말기 큐를 거치지 않은 등록) 아무것도 만들지 않는다.
 */
async function closePendingGate(data: Hex, gateId: string): Promise<void> {
  const args = (decodeFunctionData({ abi: organizersAbi, data }).args ?? []) as readonly unknown[];
  const gateAccount = (args[1] as string).toLowerCase();
  const ref = db.collection(PENDING_GATES).doc(gateAccount);
  if (!(await ref.get()).exists) return;
  await ref.set({ status: 'registered', gateId, open: true }, { merge: true });
}

/** 수동 입장 확정: 그 토큰 에스크로를 바로 분배하고(스윕이 백업), 열린 승인 요청을 닫는다. */
async function onManualOverride(action: ConfirmedAction): Promise<void> {
  const tokenId = ((decodeFunctionData({ abi: ticketAbi, data: action.data }).args ?? []) as readonly unknown[])[0] as bigint;
  await import('../functions/settlement.js')
    .then((m) => m.onCheckInConfirmed(tokenId >> 96n, tokenId))
    .catch((cause) => info('postConfirm.release.failed', { relayId: action.relayId, reason: (cause as Error).message }));
  await approveOpenOverrideRequests(tokenId, action.account, action.txHash).catch((cause) =>
    info('postConfirm.overrideRequests.failed', { relayId: action.relayId, reason: (cause as Error).message }),
  );
}

/**
 * 확정 훅 본체. 결과(`relays.result`)를 돌려준다. 부수효과 하나가 실패해도 결과는 돌려준다 —
 * 확정은 이미 체인의 사실이고, 표시용 거울이 늦는 것은 다음 재실행(대사)이 메운다.
 */
export async function postConfirm(action: ConfirmedAction, receipt: { logs: Logs }): Promise<ActionResult | undefined> {
  const result = decodeResult(action.kind, receipt.logs);
  const guard = (step: string, run: () => Promise<void>) =>
    run().catch((cause) => info(`postConfirm.${step}.failed`, { relayId: action.relayId, reason: (cause as Error).message }));

  if (action.kind === 'publishEvent' && result?.eventId) {
    await guard('settlement', () => mirrorSettlement(action, result.eventId!, receipt.logs));
  }
  if (action.kind === 'registerGate' && result?.gateId) {
    await guard('pendingGate', () => closePendingGate(action.data, result.gateId!));
  }
  if (action.kind === 'manualOverride') {
    await guard('manualOverride', () => onManualOverride(action));
  }
  return result;
}
