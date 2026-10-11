import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { HttpsError, onCall, type CallableRequest } from 'firebase-functions/v2/https';
import { info } from 'firebase-functions/logger';
import {
  WaitForTransactionReceiptTimeoutError,
  encodeFunctionData,
  parseEventLogs,
  type TransactionReceipt,
} from 'viem';
import { ticketAbi, type Hex } from '@monti/shared';
import { RELAYER_PK } from '../config.js';
import { resolveCallerAccount } from '../lib/auth.js';
import { deployment, publicClient } from '../lib/chain.js';
import { CLAIM_CODES, assertUnderPendingLimit, mapRevert, precheckClaim } from '../lib/claimPrecheck.js';
import { ADMISSIONS, ADMISSION_TOKENS, RELAYS, USERS, db } from '../lib/db.js';
import { getRelayerAccount, sendRelayed } from '../lib/relayer.js';
import { checkInRelayId, claimRelayId, type RelayKind } from '../lib/relayTypes.js';
import { recordEventUsage } from '../lib/usage.js';

/**
 * 설계 §5 Q4 — 관객의 두 고빈도 동작(발급·입장)을 릴레이한다. 관객/게이트 폰은 기기 키로
 * 짧은 승인서에 서명하고, 이 콜러블이 **가스 쓰기 전 시뮬레이션**으로 revert 를 걸러낸 뒤
 * (Monad 는 revert 도 한도로 과금한다) 릴레이어 EOA 로 일반 트랜잭션을 대신 제출한다.
 *
 * 릴레이어는 서명된 필드를 못 바꾸고(P-256 검증), 기기 키가 없어 위조도 못 한다 — 할 수 있는
 * 것은 (1) 이미 유효한 승인서 제출, (2) 자기 EOA 의 MON 소모뿐이다(설계 §5).
 *
 * 클라이언트로 나가는 `message` 에는 web3 단어를 넣지 않는다 — 코드만 주고 카피는 웹이 가진다.
 */

const B32_RE = /^0x[0-9a-fA-F]{64}$/; // personId · bytes32 게이트 코드 nonce
const SIG_RE = /^0x[0-9a-fA-F]{128}$/; // 64바이트 P-256 서명(r‖s)
const UINT_RE = /^\d+$/;

/** relays 문서 TTL(7일, C3 `firestore.indexes.json` fieldOverrides 와 일치). */
const RELAY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** admissions 대기 문서 TTL(3일, C3 와 일치). */
const ADMISSION_TTL_MS = 3 * 24 * 60 * 60 * 1000;
/** 확정을 기다리는 상한. 넘으면 `sent` 로 응답하고 대사(reconcileRelays)가 마무리한다. */
const RECEIPT_WAIT_MS = 8_000;

// ─────────────────────────────────────── 요청/응답 타입 (웹과 동결)

export interface RelayClaimRequest {
  mode: 'claim' | 'request';
  auth: { eventId: string; tier: number; account: string; nonce: string; deadline: string };
  deviceSig: string;
}
export interface RelayClaimResult {
  relayId: string;
  status: 'sent' | 'confirmed';
  txHash?: string;
  tokenId?: string;
}

export interface RelayCheckInRequest {
  tokenId: string;
  code: { gateId: string; eventId: string; issuedAt: string; nonce: string };
  gateSig: string;
  deviceSig: string;
  late: boolean;
}
export interface RelayCheckInResult {
  relayId: string;
  status: 'sent' | 'confirmed';
  txHash?: string;
  usedAt?: number;
}

// ─────────────────────────────────────── revert 이름 → details.code

/**
 * 입장 시뮬 revert → 게이트 DENY 코드. 값은 웹 게이트의 정본
 * (`apps/web/src/staff/gate/denyMap.ts` 의 `DenyCode` = `CHECK_IN_DENY` 매핑)과 같다 —
 * 게이트가 이미 가진 화면을 그대로 쓴다. 관객 잘못이 아닌 설정 오류(NotMember/EventNotPublished/
 * Unauthorized/BadGateSignature)는 웹과 같게 `TX_FAILED` 로 모은다. 표에 없으면 `UNKNOWN_REVERT`.
 */
const CHECKIN_CODES: Record<string, string> = {
  AlreadyCheckedIn: 'ALREADY_USED',
  WrongEvent: 'WRONG_EVENT',
  TicketRevoked: 'REVOKED',
  CodeExpired: 'EXPIRED_CODE',
  NoSuchTicket: 'NO_TICKET',
  GateNotOpen: 'GATE_CLOSED',
  GateMismatch: 'GATE_MISMATCH',
  DeviceLocked: 'DEVICE_LOCKED',
  BadDeviceSignature: 'DEVICE_MISMATCH',
  BadGateSignature: 'TX_FAILED',
  EventEnded: 'EVENT_ENDED',
  EventCancelled: 'EVENT_CANCELLED',
  EventNotPublished: 'TX_FAILED',
  NotMember: 'TX_FAILED',
  Unauthorized: 'TX_FAILED',
};

// ─────────────────────────────────────── 공통 헬퍼

function toBigInt(value: unknown, code: string): bigint {
  if (typeof value !== 'string' || !UINT_RE.test(value)) throw new HttpsError('invalid-argument', code);
  return BigInt(value);
}

function requireSig(value: unknown, code: string): Hex {
  if (typeof value !== 'string' || !SIG_RE.test(value)) throw new HttpsError('invalid-argument', code);
  return value as Hex;
}

/**
 * 호출자의 personId — relays 문서의 규칙 판정 키. 세션 토큰의 `personId` 클레임
 * (`mintSessionClaims`)이 있으면 DB 를 건드리지 않는다. account 는 언제나 `resolveCallerAccount`
 * 에서 별도로 온다(호출자 계정은 요청 본문이 아니라 세션이 정한다 — consistency 스캔의 규약).
 */
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

/** estimateContractGas 가 eth_call 시뮬을 겸한다(설계 §5). revert 면 던지고, 성공하면 가스 원값. */
async function simulateGas(functionName: string, args: readonly unknown[]): Promise<bigint> {
  return publicClient().estimateContractGas({
    address: deployment().ticket,
    abi: ticketAbi,
    functionName,
    args,
    account: getRelayerAccount().address,
  } as never) as Promise<bigint>;
}

function calldata(functionName: string, args: readonly unknown[]): Hex {
  return encodeFunctionData({ abi: ticketAbi, functionName, args } as never);
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
function admissionRef(eventId: string, tokenId: string) {
  return db.collection(ADMISSIONS).doc(eventId).collection(ADMISSION_TOKENS).doc(tokenId);
}

// ─────────────────────────────────────── relayClaim

/**
 * 관객이 자기 스마트 계정으로 티켓을 받는다(발급) 또는 승인제 신청을 낸다.
 * 자기 계정만·isMember·!isLocked·nonce 재대조·시뮬을 통과해야 가스를 쓴다. 멱등키는
 * `(account,eventId,nonce)` — 같은 승인서를 두 번 보내도 트랜잭션은 한 번이다.
 */
/** `runRelayClaim` 의 입력. 콜러블이 요청을 파싱해 이 모양으로 넘긴다(세션에서 온 account·personId 포함). */
export interface RunRelayClaim {
  account: Hex;
  personId: Hex;
  mode: 'claim' | 'request';
  eventId: bigint;
  tier: number;
  nonce: bigint;
  deadline: bigint;
  deviceSig: Hex;
}

/**
 * 무료 발급 릴레이의 알맹이(설계 §5). 요청 파싱만 콜러블이 하고, 자기 계정 발급·시뮬·전송·확정은
 * 전부 여기 한 곳이다(유료 티어는 v2 에서 `purchaseTicket` 의 원자 결제만 탄다).
 * 멱등키는 `(account,eventId,nonce)` 로, 같은 승인서를 두 번 보내도 트랜잭션은 한 번이다.
 */
export async function runRelayClaim(p: RunRelayClaim): Promise<RelayClaimResult> {
  const { account, personId, mode, eventId, tier, nonce, deadline, deviceSig } = p;

  // 승인서·회원·잠금·nonce 사전확인(설계 §5) — purchaseTicket 과 공용(lib/claimPrecheck).
  await precheckClaim({ account, eventId, nonce, deadline });
  const contracts = deployment();

  // 멱등: (account,eventId,nonce). 이미 진행 중/확정이면 재사용(두 번째 tx 없음).
  const relayId = claimRelayId(account, eventId, nonce);
  const ref = relayRef(relayId);
  const existing = await ref.get();
  if (existing.exists) {
    const status = existing.get('status') as string;
    if (status === 'confirmed') {
      return {
        relayId,
        status: 'confirmed',
        txHash: existing.get('txHash') as string | undefined,
        tokenId: existing.get('tokenId') as string | undefined,
      };
    }
    if (status === 'sent' || status === 'pending') {
      return { relayId, status: 'sent', txHash: existing.get('txHash') as string | undefined };
    }
    // status === 'failed' → 같은 nonce 로 재시도 허용(아래로 진행).
  }

  await assertUnderPendingLimit(personId);

  // 가스 쓰기 전 시뮬 + 가스 추정(설계 §5, Monad 는 revert 도 한도로 과금).
  const functionName = mode === 'request' ? 'requestClaimFor' : 'claimFor';
  const claimAuth = { eventId, tier, account, nonce, deadline };
  let gasEstimate: bigint;
  try {
    gasEstimate = await simulateGas(functionName, [claimAuth, deviceSig]);
  } catch (err) {
    throw mapRevert(err, CLAIM_CODES, 'REVERTED');
  }
  const data = calldata(functionName, [claimAuth, deviceSig]);

  // 클라 구독 전 문서 존재를 보장한다(규칙이 resource.data.personId 를 읽으므로, C3 §7).
  const kind: RelayKind = mode === 'request' ? 'request' : 'claim';
  await ref.set({
    kind,
    personId,
    account,
    eventId: eventId.toString(),
    idemKey: relayId,
    status: 'pending',
    createdAt: FieldValue.serverTimestamp(),
    expireAt: Timestamp.fromMillis(Date.now() + RELAY_TTL_MS),
  });

  let sent;
  try {
    sent = await sendRelayed({ to: contracts.ticket, data, gasLimit: gasEstimate });
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
  info('relayClaim.sent', { relayId, txHash: sent.hash, mode });

  const receipt = await receiptWithin(sent.hash);
  if (!receipt) return { relayId, status: 'sent', txHash: sent.hash };
  if (receipt.status !== 'success') {
    await ref.set(
      { status: 'failed', failedAt: FieldValue.serverTimestamp(), error: { code: 'REVERTED', message: 'execution reverted' } },
      { merge: true },
    );
    throw new HttpsError('aborted', 'REVERTED', { code: 'REVERTED' });
  }

  let tokenId: string | undefined;
  if (mode === 'claim') {
    const logs = parseEventLogs({ abi: ticketAbi, logs: receipt.logs, eventName: 'Claimed' }) as { args: { tokenId?: bigint } }[];
    tokenId = logs[0]?.args.tokenId?.toString();
  }
  await ref.set(
    { status: 'confirmed', confirmedAt: FieldValue.serverTimestamp(), ...(tokenId ? { tokenId } : {}) },
    { merge: true },
  );
  // 확정 가스를 이벤트의 조직 원장에 집계한다(설계 §4). 실패해도 릴레이는 이미 확정이라 삼킨다.
  await recordEventUsage(eventId, kind, receipt).catch((cause) =>
    info('relayClaim.usage.failed', { relayId, reason: (cause as Error).message }),
  );
  info('relayClaim.confirmed', { relayId, txHash: sent.hash, tokenId });
  return { relayId, status: 'confirmed', txHash: sent.hash, tokenId };
}

/**
 * 관객이 자기 스마트 계정으로 티켓을 받는다(발급) 또는 승인제 신청을 낸다.
 * 요청을 파싱해 세션 계정으로 `runRelayClaim` 에 넘긴다 — 수령 계정은 언제나 세션에서 온다
 * (요청 본문의 account 는 신뢰하지 않는다, consistency 스캔의 규약).
 */
export const relayClaim = onCall({ secrets: [RELAYER_PK] }, async (request): Promise<RelayClaimResult> => {
  const account = await resolveCallerAccount(request);
  const personId = await callerPersonId(request);
  const body = (request.data ?? {}) as Partial<RelayClaimRequest>;

  const mode = body.mode === 'claim' || body.mode === 'request' ? body.mode : undefined;
  if (!mode) throw new HttpsError('invalid-argument', 'BAD_MODE');
  const a = body.auth;
  if (!a || typeof a !== 'object') throw new HttpsError('invalid-argument', 'BAD_AUTH');
  const eventId = toBigInt(a.eventId, 'BAD_EVENT_ID');
  const nonce = toBigInt(a.nonce, 'BAD_NONCE_ARG');
  const deadline = toBigInt(a.deadline, 'BAD_DEADLINE');
  if (typeof a.tier !== 'number' || !Number.isInteger(a.tier) || a.tier < 0 || a.tier > 255) {
    throw new HttpsError('invalid-argument', 'BAD_TIER');
  }
  const tier = a.tier;
  const deviceSig = requireSig(body.deviceSig, 'BAD_DEVICE_SIG');

  return runRelayClaim({ account, personId, mode, eventId, tier, nonce, deadline, deviceSig });
});

// ─────────────────────────────────────── relayCheckIn

/**
 * 게이트가 관객을 입장시킨다. 정확성의 권위는 온체인 게이트 서명 + 관객 기기 서명이 지므로
 * 콜러블 인증은 남용 방지용(로그인된 MONTI 사용자면 통과) — 이벤트 운영자로 좁히는 강화는
 * 데모 후로 미룬다(리포트의 auth-hardening TODO). 멱등키는 `(eventId,tokenId)` = 1회 입장.
 * 이미 입장한 토큰은 성공(confirmed)으로 돌려준다 — 게이트에겐 그게 PASS 다.
 */
export const relayCheckIn = onCall({ secrets: [RELAYER_PK] }, async (request): Promise<RelayCheckInResult> => {
  // 제출자(스태프)의 세션 계정·personId. relays 문서 소유자이자 규칙 판정 키다.
  const account = await resolveCallerAccount(request);
  const personId = await callerPersonId(request);
  const body = (request.data ?? {}) as Partial<RelayCheckInRequest>;

  const tokenId = toBigInt(body.tokenId, 'BAD_TOKEN_ID');
  const late = body.late === true;
  const code = body.code;
  if (!code || typeof code !== 'object') throw new HttpsError('invalid-argument', 'BAD_CODE');
  const gateId = toBigInt(code.gateId, 'BAD_GATE_ID');
  const eventId = toBigInt(code.eventId, 'BAD_EVENT_ID');
  const issuedAt = toBigInt(code.issuedAt, 'BAD_ISSUED_AT');
  if (typeof code.nonce !== 'string' || !B32_RE.test(code.nonce)) throw new HttpsError('invalid-argument', 'BAD_CODE_NONCE');
  const codeNonce = code.nonce as Hex;
  const gateSig = requireSig(body.gateSig, 'BAD_GATE_SIG');
  const deviceSig = requireSig(body.deviceSig, 'BAD_DEVICE_SIG');

  const pc = publicClient();
  const contracts = deployment();
  const eventIdStr = eventId.toString();
  const tokenIdStr = tokenId.toString();

  // 멱등: (eventId,tokenId). 이미 진행 중/확정이면 재사용.
  const relayId = checkInRelayId(eventIdStr, tokenIdStr);
  const ref = relayRef(relayId);
  const existing = await ref.get();
  if (existing.exists) {
    const status = existing.get('status') as string;
    if (status === 'confirmed') {
      return { relayId, status: 'confirmed', txHash: existing.get('txHash') as string | undefined };
    }
    if (status === 'sent' || status === 'pending') {
      return { relayId, status: 'sent', txHash: existing.get('txHash') as string | undefined };
    }
    // status === 'failed' → 재시도 허용(아래로 진행).
  }

  // 이미 입장(usedAt != 0)이면 성공으로 돌려준다 — 게이트의 재탭/교차 게이트는 오류가 아니다.
  const used = Number(
    await pc.readContract({ address: contracts.ticket, abi: ticketAbi, functionName: 'usedAt', args: [tokenId] }),
  );
  if (used !== 0) return { relayId, status: 'confirmed', usedAt: used };

  // 가스 쓰기 전 시뮬 + 가스 추정. revert 면 미전송·대기 테이블 미기록(설계 §5).
  const functionName = late ? 'checkInForLate' : 'checkInFor';
  const gateCode = { gateId, eventId, issuedAt, nonce: codeNonce };
  let gasEstimate: bigint;
  try {
    gasEstimate = await simulateGas(functionName, [tokenId, gateCode, gateSig, deviceSig]);
  } catch (err) {
    throw mapRevert(err, CHECKIN_CODES, 'UNKNOWN_REVERT');
  }
  const data = calldata(functionName, [tokenId, gateCode, gateSig, deviceSig]);

  const kind: RelayKind = late ? 'checkInLate' : 'checkIn';
  const gateIdStr = gateId.toString();
  const admission = admissionRef(eventIdStr, tokenIdStr);

  // 대기 테이블 passing + relays pending 을 먼저 기록(브로드캐스트 순간, 설계 §6 / C3 §7).
  await Promise.all([
    admission.set(
      {
        status: 'passing',
        gateId: gateIdStr,
        relayId,
        passedAt: FieldValue.serverTimestamp(),
        expireAt: Timestamp.fromMillis(Date.now() + ADMISSION_TTL_MS),
      },
      { merge: true },
    ),
    ref.set({
      kind,
      personId,
      account,
      eventId: eventIdStr,
      tokenId: tokenIdStr,
      idemKey: relayId,
      status: 'pending',
      createdAt: FieldValue.serverTimestamp(),
      expireAt: Timestamp.fromMillis(Date.now() + RELAY_TTL_MS),
    }),
  ]);

  let sent;
  try {
    sent = await sendRelayed({ to: contracts.ticket, data, gasLimit: gasEstimate });
  } catch (err) {
    await Promise.all([
      ref.set(
        { status: 'failed', failedAt: FieldValue.serverTimestamp(), error: { code: 'SEND_FAILED', message: (err as Error).message } },
        { merge: true },
      ),
      admission.set({ status: 'failed' }, { merge: true }),
    ]);
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
  info('relayCheckIn.sent', { relayId, txHash: sent.hash, late });

  const receipt = await receiptWithin(sent.hash);
  if (!receipt) return { relayId, status: 'sent', txHash: sent.hash };
  if (receipt.status !== 'success') {
    await Promise.all([
      ref.set(
        { status: 'failed', failedAt: FieldValue.serverTimestamp(), error: { code: 'REVERTED', message: 'execution reverted' } },
        { merge: true },
      ),
      admission.set({ status: 'failed' }, { merge: true }),
    ]);
    throw new HttpsError('aborted', 'REVERTED', { code: 'REVERTED' });
  }

  const inLogs = parseEventLogs({ abi: ticketAbi, logs: receipt.logs, eventName: 'CheckedIn' }) as { args: { ts?: bigint } }[];
  const ts = inLogs[0]?.args.ts;
  const usedAtSec = ts === undefined ? undefined : Number(ts);
  const confirmedAt = FieldValue.serverTimestamp();
  await Promise.all([
    ref.set({ status: 'confirmed', confirmedAt }, { merge: true }),
    admission.set(
      { status: 'confirmed', confirmedAt, ...(usedAtSec !== undefined ? { usedAt: Timestamp.fromMillis(usedAtSec * 1000) } : {}) },
      { merge: true },
    ),
  ]);
  await recordEventUsage(eventId, kind, receipt).catch((cause) =>
    info('relayCheckIn.usage.failed', { relayId, reason: (cause as Error).message }),
  );
  info('relayCheckIn.confirmed', { relayId, txHash: sent.hash, usedAt: usedAtSec });
  // 입장 확정 직후 그 토큰의 예치 에스크로를 분배한다(설계 §3, 체감 ~1초). 정산 레이어와의 결합은
  // 동적 import 로 느슨하게 두고, 실패해도 입장 응답을 막지 않는다 — settlementSweep 이 백업한다.
  await import('./settlement.js')
    .then((m) => m.onCheckInConfirmed(eventId, tokenId))
    .catch((cause) => info('relayCheckIn.release.failed', { relayId, reason: (cause as Error).message }));
  return { relayId, status: 'confirmed', txHash: sent.hash, usedAt: usedAtSec };
});
