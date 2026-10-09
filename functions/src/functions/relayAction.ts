import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { HttpsError, onCall, type CallableRequest } from 'firebase-functions/v2/https';
import { info } from 'firebase-functions/logger';
import {
  BaseError,
  ContractFunctionRevertedError,
  WaitForTransactionReceiptTimeoutError,
  decodeFunctionData,
  encodeFunctionData,
  getAddress,
  parseEventLogs,
  type Abi,
  type TransactionReceipt,
} from 'viem';
import { forwarderAbi, identityAbi, organizersAbi, ticketAbi, type Hex } from '@monti/shared';
import { RELAYER_PK } from '../config.js';
import { resolveCallerAccount } from '../lib/auth.js';
import { deployment, publicClient } from '../lib/chain.js';
import { RELAYS, USERS, db } from '../lib/db.js';
import { getRelayerAccount, sendRelayed } from '../lib/relayer.js';
import { actionFor, type ActionEntry, type ActionTarget } from '../lib/actionAllowlist.js';
import { recordUsage } from '../lib/usage.js';

/**
 * 설계 §4 C1 — **제네릭 릴레이 콜러블**. Phase 1 발급/입장을 뺀 나머지 스폰서드 동작(주최자
 * 동작 + 남은 관객 동작=양도/신청취소/닉네임/기기)을 **하나의** 콜러블로 대납한다. 관객/주최자
 * 기기가 기기 키(P-256)로 ForwardRequest 다이제스트에 서명하면, 이 콜러블이 **가스 쓰기 전
 * 시뮬**으로 revert 를 거른 뒤 릴레이어 EOA 로 forwarder.execute 를 일반 트랜잭션으로 낸다.
 *
 * 릴레이어는 서명된 필드를 못 바꾸고(다이제스트가 keccak(data)+nonce 를 봉인), 기기 키가 없어
 * 위조도 못 한다 — 할 수 있는 것은 (1) 이미 유효한 요청 제출, (2) 자기 EOA 의 MON 소모뿐이다(설계 §7).
 *
 * 구조는 relay.ts(relayClaim/relayCheckIn)를 그대로 따른다: 세션→계정, estimateContractGas 로
 * 시뮬 겸 가스 추정, revert-이름→details.code, relays pending→sent→confirmed, 멱등, 5-pending 한도.
 */

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const HEX_RE = /^0x([0-9a-fA-F]{2})*$/; // 0x + 짝수 hex(빈 calldata 는 없음 — 최소 4바이트 selector)
const SIG_RE = /^0x[0-9a-fA-F]{128}$/; // 64바이트 P-256 서명(r‖s)
const B32_RE = /^0x[0-9a-fA-F]{64}$/;
const UINT_RE = /^\d+$/;

/** relays 문서 TTL(7일, relay.ts 와 동일). */
const RELAY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** 확정을 기다리는 상한. 넘으면 `sent` 로 응답하고 대사(reconcileRelays)가 마무리한다. */
const RECEIPT_WAIT_MS = 8_000;
/** 사람당 미확정(pending|sent) 릴레이 상한(설계 §4·§7). relay.ts 와 같은 값. */
const MAX_PENDING = 5;
/** 조직당 시간당 대납 상한(설계 §4·§7 "주최자 폭주 방지"). 사람당 5-pending 과 별개다. */
const MAX_PER_ORG_HOUR = 60;
/** 조직 레이트리밋 창(1시간). */
const ORG_WINDOW_MS = 60 * 60 * 1000;
/** deadline 허용 창: (now, now+15분]. 너무 먼 deadline 은 재생 창을 넓혀 거절한다. */
const DEADLINE_MAX_S = 15 * 60;

// ─────────────────────────────────────── 요청/응답 타입 (웹과 동결)

export interface RelayActionRequest {
  /** ForwardRequest. `from` 은 서버가 세션 계정으로 덮어쓴다(본문 값은 신뢰하지 않는다). */
  req: { from: string; to: string; nonce: string; deadline: string; data: string };
  deviceSig: string;
  /** 회계/문서용 라벨 + allowlist 키(예: 'createEvent'). */
  kind: string;
}
export interface RelayActionResult {
  relayId: string;
  status: 'sent' | 'confirmed';
  txHash?: string;
  /** 확정 시 대상 이벤트에서 뽑은 값(kind 별). */
  result?: { eventId?: string; gateId?: string; orgId?: string; tokenIds?: string[] };
}

// ─────────────────────────────────────── forwarder revert → details.code

/**
 * forwarder 자체 revert → 안정 코드. 대상 함수 고유 revert 는 여기 없고 Solidity 이름 그대로
 * 버블한다(아래 mapSimError). 값은 웹이 카피로 매핑하는 안정 코드다(설계 §4).
 */
const FORWARDER_CODES: Record<string, string> = {
  Expired: 'EXPIRED',
  BadNonce: 'BAD_NONCE',
  TargetNotAllowed: 'TARGET_NOT_ALLOWED',
  NotMember: 'NOT_MEMBER',
  DeviceLocked: 'DEVICE_LOCKED',
  BadDeviceSignature: 'BAD_DEVICE_SIG',
};

/**
 * 시뮬 revert → HttpsError. execute 는 forwarder 에러(위 표)를 던지거나 대상 revert 를 그대로
 * 버블한다. 시뮬 abi 에 forwarder+대상 abi 를 함께 넘겨 viem 이 둘 다 이름으로 디코딩하게 한다:
 *  - forwarder 에러 → 안정 코드(FORWARDER_CODES).
 *  - 대상 고유 revert → Solidity 이름 그대로(웹이 카피로 매핑).
 *  - 이름을 못 얻은 revert → TX_REVERT. revert 자체가 아니면(RPC 오류) → SIMULATE_FAILED.
 */
function mapSimError(err: unknown): HttpsError {
  if (!(err instanceof BaseError)) {
    return new HttpsError('internal', 'SIMULATE_FAILED', { code: 'SIMULATE_FAILED' });
  }
  const revert = err.walk((e) => e instanceof ContractFunctionRevertedError);
  if (!(revert instanceof ContractFunctionRevertedError)) {
    return new HttpsError('internal', 'SIMULATE_FAILED', { code: 'SIMULATE_FAILED' });
  }
  const name = revert.data?.errorName ?? revert.reason ?? null;
  if (name && FORWARDER_CODES[name]) {
    const code = FORWARDER_CODES[name];
    return new HttpsError('failed-precondition', code, { code });
  }
  if (name && /^[A-Za-z_]\w*$/.test(name)) {
    return new HttpsError('failed-precondition', name, { code: name });
  }
  return new HttpsError('failed-precondition', 'TX_REVERT', { code: 'TX_REVERT' });
}

// ─────────────────────────────────────── 공통 헬퍼 (relay.ts 와 동형)

function requireStr(value: unknown, re: RegExp, code: string): string {
  if (typeof value !== 'string' || !re.test(value)) throw new HttpsError('invalid-argument', code);
  return value;
}
function toBigInt(value: unknown, code: string): bigint {
  if (typeof value !== 'string' || !UINT_RE.test(value)) throw new HttpsError('invalid-argument', code);
  return BigInt(value);
}

/** 호출자의 personId — relays 문서의 규칙 판정 키(relay.ts 와 동일). */
async function callerPersonId(request: CallableRequest): Promise<Hex> {
  const claim = request.auth?.token?.personId;
  if (typeof claim === 'string' && B32_RE.test(claim)) return claim as Hex;
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'AUTH_REQUIRED');
  const user = await db.collection(USERS).doc(uid).get();
  const personId = user.get('personId') as string | undefined;
  if (!personId || !B32_RE.test(personId)) throw new HttpsError('failed-precondition', 'NO_PERSON');
  return personId as Hex;
}

/** Phase 2 전달자 주소. 배포 파일에 없으면 MISSING_FORWARDER(재배포 진행 중). */
function requireForwarder(): Hex {
  const forwarder = deployment().forwarder;
  if (!forwarder) throw new HttpsError('failed-precondition', 'MISSING_FORWARDER', { code: 'MISSING_FORWARDER' });
  return getAddress(forwarder);
}

/** kind 의 대상 컨트랙트 주소(배포 모듈이 원본). */
function targetAddress(target: ActionTarget): Hex {
  const c = deployment();
  return getAddress(target === 'organizers' ? c.organizers : target === 'identity' ? c.identity : c.ticket);
}

/** 대상 abi — 시뮬 에러를 이름으로 디코딩할 수 있게 forwarder abi 와 합친다. */
function targetAbi(target: ActionTarget): Abi {
  return target === 'organizers' ? organizersAbi : target === 'identity' ? identityAbi : ticketAbi;
}

/** 확정 영수증을 상한까지만 기다린다. 타임아웃이면 null(→ `sent` 응답, 대사가 마무리). */
async function receiptWithin(hash: Hex): Promise<TransactionReceipt | null> {
  try {
    return await publicClient().waitForTransactionReceipt({ hash, timeout: RECEIPT_WAIT_MS });
  } catch (err) {
    if (err instanceof WaitForTransactionReceiptTimeoutError) return null;
    throw err;
  }
}

function relayRef(relayId: string) {
  return db.collection(RELAYS).doc(relayId);
}

/** 사람당 미확정 릴레이가 상한을 넘으면 거절(relay.ts 와 동일 질의·색인). */
async function assertUnderPendingLimit(personId: Hex): Promise<void> {
  const snap = await db
    .collection(RELAYS)
    .where('personId', '==', personId)
    .where('status', 'in', ['pending', 'sent'])
    .limit(MAX_PENDING)
    .get();
  if (snap.size >= MAX_PENDING) {
    throw new HttpsError('resource-exhausted', 'TOO_MANY_PENDING', { code: 'TOO_MANY_PENDING' });
  }
}

/**
 * kind 별 회계 scope 를 어떻게 얻는가(설계 §4). 조직 동작은 `org:{orgId}`, 관객/신원 동작은
 * `person:{personId}`. orgId 의 출처가 kind 마다 다르다:
 *  - orgStruct : createEvent 의 EventInit.orgId (calldata 디코드)
 *  - orgArg    : setAdmin/setManager 의 첫 인자 orgId (calldata 디코드)
 *  - event     : 첫 인자 eventId -> `Ticket.eventOrg(eventId)`
 *  - token     : 첫 인자 tokenId -> `eventOf` -> `eventOrg`
 *  - gate      : 첫 인자 gateId -> `gateInfo` -> `eventOrg`
 *  - person    : 관객·신원 동작(양도/오퍼/신청취소/닉네임/기기/주최사생성). 세션 personId.
 */
type ScopeSource = 'person' | 'orgStruct' | 'orgArg' | 'event' | 'token' | 'gate';
const SCOPE_SOURCE: Record<string, ScopeSource> = {
  createEvent: 'orgStruct',
  setAdmin: 'orgArg',
  setManager: 'orgArg',
  publishEvent: 'event',
  cancelEvent: 'event',
  updateEventMeta: 'event',
  approveClaims: 'event',
  rejectClaims: 'event',
  registerGate: 'event',
  revoke: 'token',
  requestOverride: 'token',
  manualOverride: 'token',
  openGate: 'gate',
  closeGate: 'gate',
  revokeGate: 'gate',
  createOffer: 'person',
  cancelOffer: 'person',
  acceptOffer: 'person',
  safeTransferFrom: 'person',
  cancelRequest: 'person',
  migrate: 'person',
  setNickname: 'person',
  cancelRotation: 'person',
  createOrganizer: 'person',
};

/**
 * 이 대납의 회계 scope 를 정한다. 시뮬을 통과한 **뒤에** 부르므로 대상 id 는 체인에서 유효하다 -
 * 디코드·체인 읽기가 그래도 실패하면(예상 밖 calldata) 조직 귀속을 포기하고 `person` scope 로
 * 떨어져 릴레이 자체는 막지 않는다(집계는 best-effort, 설계 §4).
 */
async function deriveScope(
  kind: string,
  target: ActionTarget,
  data: Hex,
  personId: Hex,
): Promise<{ scope: string; orgId?: string }> {
  const source = SCOPE_SOURCE[kind] ?? 'person';
  if (source === 'person') return { scope: `person:${personId}` };
  try {
    const decoded = decodeFunctionData({ abi: targetAbi(target), data });
    const args = (decoded.args ?? []) as readonly unknown[];
    if (source === 'orgStruct') {
      const orgId = (args[0] as { orgId: bigint }).orgId.toString();
      return { scope: `org:${orgId}`, orgId };
    }
    if (source === 'orgArg') {
      const orgId = (args[0] as bigint).toString();
      return { scope: `org:${orgId}`, orgId };
    }
    const pc = publicClient();
    const c = deployment();
    let eventId: bigint;
    if (source === 'event') {
      eventId = args[0] as bigint;
    } else if (source === 'token') {
      eventId = (await pc.readContract({ address: c.ticket, abi: ticketAbi, functionName: 'eventOf', args: [args[0]] })) as bigint;
    } else {
      const gate = (await pc.readContract({ address: c.organizers, abi: organizersAbi, functionName: 'gateInfo', args: [args[0]] })) as readonly [bigint, ...unknown[]];
      eventId = gate[0];
    }
    const orgId = ((await pc.readContract({ address: c.ticket, abi: ticketAbi, functionName: 'eventOrg', args: [eventId] })) as bigint).toString();
    return { scope: `org:${orgId}`, orgId };
  } catch (cause) {
    info('relayAction.scope.fallback', { kind, reason: (cause as Error).message });
    return { scope: `person:${personId}` };
  }
}

/** 조직당 시간당 대납이 상한을 넘으면 거절(설계 §4·§7). 색인: relays (orgId, createdAt). */
async function assertUnderOrgLimit(orgId: string): Promise<void> {
  const cutoff = Timestamp.fromMillis(Date.now() - ORG_WINDOW_MS);
  const snap = await db
    .collection(RELAYS)
    .where('orgId', '==', orgId)
    .where('createdAt', '>', cutoff)
    .limit(MAX_PER_ORG_HOUR)
    .get();
  if (snap.size >= MAX_PER_ORG_HOUR) {
    throw new HttpsError('resource-exhausted', 'TOO_MANY_FOR_ORG', { code: 'TOO_MANY_FOR_ORG' });
  }
}

/** 확정 영수증에서 kind 별 결과를 뽑는다(설계 §4). 못 뽑으면 undefined — 실패로 보지 않는다. */
function decodeResult(kind: string, logs: readonly unknown[]): RelayActionResult['result'] | undefined {
  try {
    if (kind === 'createEvent') {
      const l = parseEventLogs({ abi: ticketAbi, logs: logs as never, eventName: 'EventCreated' }) as { args: { eventId?: bigint } }[];
      const eventId = l[0]?.args.eventId;
      return eventId === undefined ? undefined : { eventId: eventId.toString() };
    }
    if (kind === 'registerGate') {
      const l = parseEventLogs({ abi: organizersAbi, logs: logs as never, eventName: 'GateRegistered' }) as { args: { gateId?: bigint } }[];
      const gateId = l[0]?.args.gateId;
      return gateId === undefined ? undefined : { gateId: gateId.toString() };
    }
    if (kind === 'createOrganizer') {
      const l = parseEventLogs({ abi: organizersAbi, logs: logs as never, eventName: 'OrganizerCreated' }) as { args: { orgId?: bigint } }[];
      const orgId = l[0]?.args.orgId;
      return orgId === undefined ? undefined : { orgId: orgId.toString() };
    }
    if (kind === 'approveClaims') {
      const l = parseEventLogs({ abi: ticketAbi, logs: logs as never, eventName: 'ClaimApproved' }) as { args: { tokenId?: bigint } }[];
      const tokenIds = l
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

/**
 * 확정 훅 — **현재는 로그만 남긴다**. C1 후속(사용량 원장 `usage/{orgId}` + 조직 레이트리밋,
 * 설계 §4)이 여기에 붙는다. relayDoc·영수증을 받아 `gasUsed×price` 를 누적할 깨끗한 이음새다.
 */
async function onConfirmed(
  relayDoc: { relayId: string; kind: string; personId: Hex; account: Hex; scope: string },
  receipt: TransactionReceipt,
): Promise<void> {
  info('relayAction.onConfirmed', {
    relayId: relayDoc.relayId,
    kind: relayDoc.kind,
    scope: relayDoc.scope,
    gasUsed: receipt.gasUsed?.toString(),
    txHash: receipt.transactionHash,
  });
  await recordUsage(relayDoc.scope, relayDoc.kind, receipt).catch((cause) =>
    info('relayAction.usage.failed', { relayId: relayDoc.relayId, reason: (cause as Error).message }),
  );
}

// ─────────────────────────────────────── relayAction

export const relayAction = onCall({ secrets: [RELAYER_PK] }, async (request): Promise<RelayActionResult> => {
  // 행위 주체 = 호출자 계정. **본문의 req.from 은 신뢰하지 않는다** — 언제나 세션 계정으로 덮는다
  // (설계 §4 "자기 것만 대행", consistency 스캔의 규약). 기기가 서명한 다이제스트도 이 from 을
  // 담으므로, 다른 계정을 넣으면 온체인 P-256 검증이 실패한다.
  const account = await resolveCallerAccount(request);
  const personId = await callerPersonId(request);
  const body = (request.data ?? {}) as Partial<RelayActionRequest>;

  const kind = typeof body.kind === 'string' ? body.kind : undefined;
  if (!kind) throw new HttpsError('invalid-argument', 'BAD_KIND');
  const entry: ActionEntry | undefined = actionFor(kind);
  if (!entry) throw new HttpsError('failed-precondition', 'KIND_NOT_ALLOWED', { code: 'KIND_NOT_ALLOWED' });

  const r = body.req;
  if (!r || typeof r !== 'object') throw new HttpsError('invalid-argument', 'BAD_REQUEST');
  const to = getAddress(requireStr(r.to, ADDRESS_RE, 'BAD_TO'));
  const nonce = toBigInt(r.nonce, 'BAD_NONCE_ARG');
  const deadline = toBigInt(r.deadline, 'BAD_DEADLINE');
  const data = requireStr(r.data, HEX_RE, 'BAD_DATA') as Hex;
  const deviceSig = requireStr(body.deviceSig, SIG_RE, 'BAD_DEVICE_SIG') as Hex;

  const forwarder = requireForwarder();
  const target = targetAddress(entry.target);

  // 대상·selector 이중 확인 — 임의 컨트랙트/임의 calldata 대납 차단(설계 §4·§7).
  if (to !== target) throw new HttpsError('failed-precondition', 'WRONG_TARGET', { code: 'WRONG_TARGET' });
  const selector = data.slice(0, 10).toLowerCase();
  if (selector !== entry.selector) {
    throw new HttpsError('failed-precondition', 'SELECTOR_NOT_ALLOWED', { code: 'SELECTOR_NOT_ALLOWED' });
  }

  // deadline 창: (now, now+15분]. 과거면 EXPIRED, 너무 멀면 재생 창을 넓혀 거절.
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  if (deadline <= nowSec) throw new HttpsError('failed-precondition', 'EXPIRED', { code: 'EXPIRED' });
  if (deadline > nowSec + BigInt(DEADLINE_MAX_S)) throw new HttpsError('invalid-argument', 'DEADLINE_TOO_FAR');

  const pc = publicClient();

  // nonce 재대조 — 진부/중복 요청을 가스 쓰기 전에 막고, 현재 nonce 를 돌려줘 재서명하게 한다.
  const chainNonce = (await pc.readContract({
    address: forwarder,
    abi: forwarderAbi,
    functionName: 'nonces',
    args: [account],
  })) as bigint;
  if (chainNonce !== nonce) {
    throw new HttpsError('failed-precondition', 'BAD_NONCE', { code: 'BAD_NONCE', nonce: chainNonce.toString() });
  }

  // 멱등: (from, nonce). 이미 진행 중/확정이면 재사용(두 번째 tx 없음).
  const relayId = `${account}:${nonce}`;
  const ref = relayRef(relayId);
  const existing = await ref.get();
  if (existing.exists) {
    const status = existing.get('status') as string;
    if (status === 'confirmed') {
      return {
        relayId,
        status: 'confirmed',
        txHash: existing.get('txHash') as string | undefined,
        result: (existing.get('result') as RelayActionResult['result']) ?? undefined,
      };
    }
    if (status === 'sent' || status === 'pending') {
      return { relayId, status: 'sent', txHash: existing.get('txHash') as string | undefined };
    }
    // status === 'failed' → 같은 nonce 로 재시도 허용(아래로 진행).
  }

  await assertUnderPendingLimit(personId);

  // ForwardRequest 는 서버가 정한 from/to 로 짓는다(본문의 from/to 는 이미 검증/무시).
  const forwardReq = { from: account, to: target, nonce, deadline, data };

  // 가스 쓰기 전 시뮬 + 가스 추정. forwarder+대상 abi 를 합쳐 두 계열 revert 를 이름으로 디코딩.
  const simAbi = [...forwarderAbi, ...targetAbi(entry.target)] as unknown as Abi;
  let gasEstimate: bigint;
  try {
    gasEstimate = (await pc.estimateContractGas({
      address: forwarder,
      abi: simAbi,
      functionName: 'execute',
      args: [forwardReq, deviceSig],
      account: getRelayerAccount().address,
    } as never)) as bigint;
  } catch (err) {
    throw mapSimError(err);
  }
  const callData = encodeFunctionData({ abi: forwarderAbi, functionName: 'execute', args: [forwardReq, deviceSig] } as never);

  // 회계 scope + 조직 레이트리밋(설계 §4). 시뮬을 통과한 뒤라 대상 id 는 체인에서 유효하다.
  const { scope, orgId } = await deriveScope(kind, entry.target, data, personId);
  if (orgId) await assertUnderOrgLimit(orgId);

  // 클라 구독 전 문서 존재를 보장한다(규칙이 resource.data.personId 를 읽으므로).
  await ref.set({
    kind,
    personId,
    account,
    to: target,
    ...(orgId ? { orgId } : {}),
    forwardNonce: nonce.toString(),
    idemKey: relayId,
    status: 'pending',
    createdAt: FieldValue.serverTimestamp(),
    expireAt: Timestamp.fromMillis(Date.now() + RELAY_TTL_MS),
  });

  let sent;
  try {
    sent = await sendRelayed({ to: forwarder, data: callData, gasLimit: gasEstimate });
  } catch (err) {
    await ref.set(
      { status: 'failed', failedAt: FieldValue.serverTimestamp(), error: { code: 'SEND_FAILED', message: (err as Error).message } },
      { merge: true },
    );
    throw new HttpsError('internal', 'SEND_FAILED', { code: 'SEND_FAILED' });
  }

  await ref.set(
    {
      status: 'sent',
      txHash: sent.hash,
      nonce: sent.nonce,
      gasLimit: Number(sent.gasLimit),
      sentAt: FieldValue.serverTimestamp(),
      expireAt: Timestamp.fromMillis(Date.now() + RELAY_TTL_MS),
    },
    { merge: true },
  );
  info('relayAction.sent', { relayId, txHash: sent.hash, kind });

  const receipt = await receiptWithin(sent.hash);
  if (!receipt) return { relayId, status: 'sent', txHash: sent.hash };
  if (receipt.status !== 'success') {
    await ref.set(
      { status: 'failed', failedAt: FieldValue.serverTimestamp(), error: { code: 'REVERTED', message: 'execution reverted' } },
      { merge: true },
    );
    throw new HttpsError('aborted', 'REVERTED', { code: 'REVERTED' });
  }

  // Forwarded 를 디코딩해 릴레이 성사를 확인하고, 회계용 kind 는 대상 이벤트에서 결과를 뽑는다.
  const forwardedLogs = parseEventLogs({ abi: forwarderAbi, logs: receipt.logs, eventName: 'Forwarded' });
  const result = decodeResult(kind, receipt.logs);
  await onConfirmed({ relayId, kind, personId, account, scope }, receipt);

  // 스태프 수동입장(manualOverride)도 usedAt 을 체인에 쓰지만 분배는 settlementSweep(5분) 전까지 밀린다.
  // 게이트 경로(relay.ts §3)처럼 입장 확정 직후 그 토큰 에스크로를 분배한다 — tokenId 는 calldata 에서,
  // eventId 는 토큰 레이아웃(상위 160비트 = tokenId >> 96)에서. 느슨한 결합·실패 무시, sweep 이 백업한다.
  if (kind === 'manualOverride') {
    await import('./settlement.js')
      .then((m) => {
        const tokenId = ((decodeFunctionData({ abi: ticketAbi, data }).args ?? []) as readonly unknown[])[0] as bigint;
        return m.onCheckInConfirmed(tokenId >> 96n, tokenId);
      })
      .catch((cause) => info('relayAction.release.failed', { relayId, reason: (cause as Error).message }));
  }

  await ref.set(
    { status: 'confirmed', confirmedAt: FieldValue.serverTimestamp(), ...(result ? { result } : {}) },
    { merge: true },
  );
  info('relayAction.confirmed', { relayId, txHash: sent.hash, kind, forwarded: forwardedLogs.length });
  return { relayId, status: 'confirmed', txHash: sent.hash, ...(result ? { result } : {}) };
});
