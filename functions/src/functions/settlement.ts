import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { HttpsError, onCall, type CallableRequest } from 'firebase-functions/v2/https';
import { error, info } from 'firebase-functions/logger';
import {
  BaseError,
  ContractFunctionRevertedError,
  TransactionReceiptNotFoundError,
  WaitForTransactionReceiptTimeoutError,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  parseEventLogs,
  type TransactionReceipt,
} from 'viem';
import { CIRCLE_TESTNET_USDC, ticketAbi, type Hex } from '@monti/shared';
import { RELAYER_PK, TREASURY_PK } from '../config.js';
import { isEventOrganizer, resolveCallerAccount } from '../lib/auth.js';
import { deployment, publicClient } from '../lib/chain.js';
import { ORDERS, RELAYS, SETTLEMENTS, USERS, db } from '../lib/db.js';
import { getRelayerAccount, sendRelayed } from '../lib/relayer.js';
import { claimRelayId, setPolicyRelayId, type RelayKind } from '../lib/relayTypes.js';
import {
  hashPolicy,
  reasonHashOf,
  settlementAbi,
  tagToBytes32,
  type OnChainRecipient,
  type SignedPolicy,
} from '../lib/settlementAbi.js';
import { getTreasuryAccount, sendFromTreasury, waitTreasury } from '../lib/treasury.js';
import { runRelayClaim } from './relay.js';

/**
 * 프로그래머블 정산 백엔드(설계 2026-10-01 §2~§5, Batch C). 세 콜러블 + 입장 트리거 + 스윕:
 *  - `relaySetPolicy` — 주최자 기기서명으로 행사별 분배정책을 금고에 설정(릴레이어 제출).
 *  - `purchaseTicket` — mock 카드결제 → relayClaim 민팅 → 트레저리가 USDC 를 금고에 예치.
 *  - `refundOrder`    — 분배 전 환불(주문자/주최자) → 트레저리가 금고 refund 호출.
 *  - `onCheckInConfirmed` — 입장 확정 직후 그 토큰 에스크로를 분배(permissionless release).
 *  - `settlementSweep` — 미완 예치/미분배/노쇼를 주기적으로 마무리(reconcile 스케줄러에 붙는다).
 *
 * 돈은 트레저리 EOA 로만 흐르고(관객은 토큰을 만지지 않는다), 분배 권위는 온체인이다 —
 * settlements 거울은 공개 표시용이고 truth 는 체인/인덱서다(설계 §5).
 */

const B32_RE = /^0x[0-9a-fA-F]{64}$/;
const SIG_RE = /^0x[0-9a-fA-F]{128}$/;
const UINT_RE = /^\d+$/;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

const RELAY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** 확정을 기다리는 상한. 넘으면 `sent`/`minted` 로 응답하고 스윕/대사가 마무리한다. */
const RECEIPT_WAIT_MS = 8_000;
/** 스윕이 건드리기 전 주문이 멈춰 있어야 하는 시간(살아 있는 콜러블과 경합하지 않게). */
const SWEEP_STALE_MS = 2 * 60 * 1000;
/** 한 스윕이 볼 주문 수 상한(reconcile 의 SWEEP_LIMIT 과 같은 뜻). */
const SWEEP_LIMIT = 200;
/** settleNoShows 한 번에 넣는 tokenId 상한(유계 배치, 설계 §3). */
const NOSHOW_BATCH = 20;

const BPS_DENOMINATOR = 10_000;
const MIN_PLATFORM_BPS = 500;
const MAX_RECIPIENTS = 10;
const TAG_PLATFORM = 'platform';
/** USDC 6dp: 1 cent = 1e4 units(설계 §8: 18 가정 금지). */
const USDC_UNITS_PER_CENT = 10_000n;
const MAX_UINT256 = (1n << 256n) - 1n;
/** Ticket.EventStatus: Draft 0 · Published 1 · Cancelled 2 · Ended 3. */
const EVENT_ENDED = 3;

// ─────────────────────────────────────── revert → code 매핑

const SET_POLICY_CODES: Record<string, string> = {
  UnknownEvent: 'UNKNOWN_EVENT',
  NotPolicyAuthorizer: 'NOT_ORGANIZER',
  PolicyFrozen: 'POLICY_FROZEN',
  AuthExpired: 'AUTH_EXPIRED',
  BadNonce: 'BAD_NONCE',
  BadDeviceSignature: 'BAD_DEVICE_SIG',
  InvalidRecipients: 'INVALID_RECIPIENTS',
  ZeroRecipient: 'ZERO_RECIPIENT',
  ZeroBps: 'ZERO_BPS',
  BadSplitSum: 'BAD_SPLIT_SUM',
  PlatformShareTooLow: 'PLATFORM_TOO_LOW',
  PlatformMirrorMismatch: 'PLATFORM_MISMATCH',
  BadReserve: 'BAD_RESERVE',
  Paused: 'PAUSED',
};
const DEPOSIT_CODES: Record<string, string> = {
  NotDepositor: 'NOT_DEPOSITOR',
  TokenNotAllowed: 'TOKEN_NOT_ALLOWED',
  ZeroAmount: 'ZERO_AMOUNT',
  AlreadyDeposited: 'ALREADY_DEPOSITED',
  EventMismatch: 'EVENT_MISMATCH',
  NoPolicy: 'NO_POLICY',
  Paused: 'PAUSED',
};
const REFUND_CODES: Record<string, string> = {
  NoEscrow: 'NO_ESCROW',
  NothingToRefund: 'NOTHING_TO_REFUND',
  NotDepositor: 'NOT_DEPOSITOR',
  AlreadyCheckedIn: 'ALREADY_CHECKED_IN',
  EventEnded: 'EVENT_ENDED',
  Paused: 'PAUSED',
};

/** 던진 오류에서 viem 이 settlementAbi 로 디코딩한 커스텀 에러 이름을 꺼낸다. revert 가 아니면 null. */
function revertName(err: unknown): string | null {
  if (!(err instanceof BaseError)) return null;
  const revert = err.walk((e) => e instanceof ContractFunctionRevertedError);
  if (revert instanceof ContractFunctionRevertedError) {
    return revert.data?.errorName ?? revert.reason ?? null;
  }
  return null;
}
/** revert → HttpsError. 매핑되면 failed-precondition+코드, revert 가 아니면 internal. */
function mapRevert(err: unknown, table: Record<string, string>, fallback: string): HttpsError {
  const name = revertName(err);
  if (name === null) return new HttpsError('internal', 'SIMULATE_FAILED', { code: 'SIMULATE_FAILED' });
  const code = table[name] ?? fallback;
  return new HttpsError('failed-precondition', code, { code });
}

// ─────────────────────────────────────── 공통 헬퍼

function toBigInt(value: unknown, code: string): bigint {
  if (typeof value !== 'string' || !UINT_RE.test(value)) throw new HttpsError('invalid-argument', code);
  return BigInt(value);
}
function requireSig(value: unknown, code: string): Hex {
  if (typeof value !== 'string' || !SIG_RE.test(value)) throw new HttpsError('invalid-argument', code);
  return value as Hex;
}
function requireTier(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 255) {
    throw new HttpsError('invalid-argument', 'BAD_TIER');
  }
  return value;
}

/** 호출자의 personId(세션 클레임 우선, 없으면 users/{uid}). relay.ts 의 같은 규약. */
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

/** 금고 주소. 배포 JSON 의 선택 키라, 없으면 MISSING_SETTLEMENT_VAULT(A4 배포 전). */
function vaultAddress(): Hex {
  const vault = deployment().settlementVault;
  if (!vault) throw new HttpsError('failed-precondition', 'MISSING_SETTLEMENT_VAULT', { code: 'MISSING_SETTLEMENT_VAULT' });
  return vault;
}
/** 정산 토큰. 배포 JSON 의 usdc 가 있으면 그것을, 없으면 Circle 테스트 USDC. */
function usdcAddress(): Hex {
  return deployment().usdc ?? CIRCLE_TESTNET_USDC;
}

/** 금고 함수의 eth_call 시뮬 겸 가스 추정(설계 §5). revert 면 던지고 성공하면 가스 원값. */
function vaultSimulate(functionName: string, args: readonly unknown[], account: Hex): Promise<bigint> {
  return publicClient().estimateContractGas({
    address: vaultAddress(),
    abi: settlementAbi,
    functionName,
    args,
    account,
  } as never) as Promise<bigint>;
}
function vaultCalldata(functionName: string, args: readonly unknown[]): Hex {
  return encodeFunctionData({ abi: settlementAbi, functionName, args } as never);
}

/** 확정 영수증을 상한까지만 기다린다. 타임아웃이면 null(→ pending 으로 두고 스윕이 마무리). */
async function receiptWithin(hash: Hex): Promise<TransactionReceipt | null> {
  try {
    return await publicClient().waitForTransactionReceipt({ hash, timeout: RECEIPT_WAIT_MS });
  } catch (err) {
    if (err instanceof WaitForTransactionReceiptTimeoutError) return null;
    throw err;
  }
}

function settlementRef(eventId: string) {
  return db.collection(SETTLEMENTS).doc(eventId);
}
function orderRef(orderId: string) {
  return db.collection(ORDERS).doc(orderId);
}
function relayRef(relayId: string) {
  return db.collection(RELAYS).doc(relayId);
}

// ─────────────────────────────────────── relaySetPolicy

export interface SetPolicyRecipient {
  account: string;
  bps: number;
  reason: string;
  tag: string;
}
export interface RelaySetPolicyRequest {
  eventId: string;
  policy: { recipients: SetPolicyRecipient[]; platformBps?: number };
  auth: { nonce: string; deadline: string };
  deviceSig: string;
  /** 티어별 가격(센트). 구매 검증용으로 settlements 거울에 함께 저장한다(설계 §5, 온체인은 무료 민팅). */
  priceUsdCentsByTier?: Record<string, number>;
}
export interface RelaySetPolicyResult {
  relayId: string;
  status: 'sent' | 'confirmed';
  txHash?: string;
}

/**
 * 주최자가 행사 분배정책을 금고에 설정한다(설계 §1/§3). 세션 계정 = 주최자이고, 기기키 서명
 * (deviceSig)이 금고에서 self-verify 된다. 서버는 정책 모양(합계 10000·플랫폼 미러)을 먼저 보고,
 * policyHash 를 **컨트랙트와 바이트 단위로 같게** 계산(+view 교차검증)해 settlements 거울에 둔다.
 * 멱등키는 `(organizer, policyNonce)`.
 */
export const relaySetPolicy = onCall({ secrets: [RELAYER_PK] }, async (request): Promise<RelaySetPolicyResult> => {
  const organizer = await resolveCallerAccount(request);
  const personId = await callerPersonId(request);
  const body = (request.data ?? {}) as Partial<RelaySetPolicyRequest>;

  const eventId = toBigInt(body.eventId, 'BAD_EVENT_ID');
  const eventIdStr = eventId.toString();
  const pol = body.policy;
  if (!pol || typeof pol !== 'object' || !Array.isArray(pol.recipients)) {
    throw new HttpsError('invalid-argument', 'BAD_POLICY');
  }
  const a = body.auth;
  if (!a || typeof a !== 'object') throw new HttpsError('invalid-argument', 'BAD_AUTH');
  const nonce = toBigInt(a.nonce, 'BAD_NONCE_ARG');
  const deadline = toBigInt(a.deadline, 'BAD_DEADLINE');
  const deviceSig = requireSig(body.deviceSig, 'BAD_DEVICE_SIG');

  const recipients = pol.recipients;
  if (recipients.length === 0 || recipients.length > MAX_RECIPIENTS) {
    throw new HttpsError('invalid-argument', 'INVALID_RECIPIENTS');
  }
  let sum = 0;
  let platformSum = 0;
  const onChain: OnChainRecipient[] = [];
  const stored: SetPolicyRecipient[] = [];
  for (const r of recipients) {
    if (!r || typeof r.account !== 'string' || !ADDRESS_RE.test(r.account)) {
      throw new HttpsError('invalid-argument', 'BAD_RECIPIENT');
    }
    if (typeof r.bps !== 'number' || !Number.isInteger(r.bps) || r.bps <= 0 || r.bps > BPS_DENOMINATOR) {
      throw new HttpsError('invalid-argument', 'BAD_BPS');
    }
    const reason = typeof r.reason === 'string' ? r.reason : '';
    const tag = typeof r.tag === 'string' ? r.tag : '';
    sum += r.bps;
    if (tag === TAG_PLATFORM) platformSum += r.bps;
    const account = getAddress(r.account);
    onChain.push({ account, bps: r.bps, reasonHash: reasonHashOf(reason), tag: tagToBytes32(tag) });
    stored.push({ account, bps: r.bps, reason, tag });
  }
  if (sum !== BPS_DENOMINATOR) throw new HttpsError('failed-precondition', 'BAD_SPLIT_SUM', { code: 'BAD_SPLIT_SUM' });
  const platformBps = typeof pol.platformBps === 'number' ? pol.platformBps : platformSum;
  if (platformBps !== platformSum) throw new HttpsError('failed-precondition', 'PLATFORM_MISMATCH', { code: 'PLATFORM_MISMATCH' });
  if (platformBps < MIN_PLATFORM_BPS) throw new HttpsError('failed-precondition', 'PLATFORM_TOO_LOW', { code: 'PLATFORM_TOO_LOW' });

  const signed: SignedPolicy = { recipients: onChain, platformBps, reserveBps: 0, noShowRefund: false };
  const policyHash = hashPolicy(signed);

  const pc = publicClient();
  const vault = vaultAddress();
  // 전체 SplitPolicy(frozen/version 포함) — 컨트랙트가 받는 calldata 모양. frozen/version 은 금고가 덮어쓴다.
  const fullPolicy = { ...signed, frozen: false, version: 0 };

  // view 로 hashPolicy 교차검증(설계 §1 "call the view to be safe"). view 가 안 되면 로컬값으로 간다.
  try {
    const onChainHash = (await pc.readContract({
      address: vault,
      abi: settlementAbi,
      functionName: 'hashPolicy',
      args: [fullPolicy],
    })) as Hex;
    if (onChainHash.toLowerCase() !== policyHash.toLowerCase()) {
      throw new HttpsError('internal', 'POLICY_HASH_MISMATCH', { code: 'POLICY_HASH_MISMATCH' });
    }
  } catch (err) {
    if (err instanceof HttpsError) throw err;
    info('relaySetPolicy.hashView.skipped', { eventId: eventIdStr, reason: (err as Error).message });
  }

  // nonce 재대조 — 진부한 서명을 가스 전에 막고 현재 nonce 를 돌려준다(relayClaim 규약).
  const chainNonce = (await pc.readContract({
    address: vault,
    abi: settlementAbi,
    functionName: 'policyNonce',
    args: [organizer],
  })) as bigint;
  if (chainNonce !== nonce) {
    throw new HttpsError('failed-precondition', 'BAD_NONCE', { code: 'BAD_NONCE', nonce: chainNonce.toString() });
  }

  // 멱등: (organizer, nonce).
  const relayId = setPolicyRelayId(organizer, nonce);
  const ref = relayRef(relayId);
  const existing = await ref.get();
  if (existing.exists) {
    const status = existing.get('status') as string;
    if (status === 'confirmed') return { relayId, status: 'confirmed', txHash: existing.get('txHash') as string | undefined };
    if (status === 'sent' || status === 'pending') return { relayId, status: 'sent', txHash: existing.get('txHash') as string | undefined };
  }

  const policyAuth = { organizer, nonce, deadline };
  let gasEstimate: bigint;
  try {
    gasEstimate = await vaultSimulate('setPolicy', [eventId, fullPolicy, policyAuth, deviceSig], getRelayerAccount().address);
  } catch (err) {
    throw mapRevert(err, SET_POLICY_CODES, 'REVERTED');
  }
  const data = vaultCalldata('setPolicy', [eventId, fullPolicy, policyAuth, deviceSig]);

  const kind: RelayKind = 'setPolicy';
  await ref.set({
    kind,
    personId,
    account: organizer,
    eventId: eventIdStr,
    idemKey: relayId,
    status: 'pending',
    createdAt: FieldValue.serverTimestamp(),
    expireAt: Timestamp.fromMillis(Date.now() + RELAY_TTL_MS),
  });

  let sent;
  try {
    sent = await sendRelayed({ to: vault, data, gasLimit: gasEstimate });
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

  // 공개 정산 거울(설계 §5). truth 는 체인/인덱서이고 이 문서는 표시용 — 사유·태그 원문을 여기 둔다.
  const settlement: Record<string, unknown> = {
    policy: { recipients: stored, platformBps },
    policyHash,
    setBy: organizer,
    txHash: sent.hash,
    updatedAt: FieldValue.serverTimestamp(),
  };
  if (body.priceUsdCentsByTier && typeof body.priceUsdCentsByTier === 'object') {
    settlement.priceUsdCentsByTier = sanitizePrices(body.priceUsdCentsByTier);
  }
  await settlementRef(eventIdStr).set(settlement, { merge: true });
  info('relaySetPolicy.sent', { relayId, eventId: eventIdStr, txHash: sent.hash });

  const receipt = await receiptWithin(sent.hash);
  if (!receipt) return { relayId, status: 'sent', txHash: sent.hash };
  if (receipt.status !== 'success') {
    await ref.set(
      { status: 'failed', failedAt: FieldValue.serverTimestamp(), error: { code: 'REVERTED', message: 'execution reverted' } },
      { merge: true },
    );
    throw new HttpsError('aborted', 'REVERTED', { code: 'REVERTED' });
  }
  await ref.set({ status: 'confirmed', confirmedAt: FieldValue.serverTimestamp() }, { merge: true });
  return { relayId, status: 'confirmed', txHash: sent.hash };
});

/** 티어별 가격 맵을 정리한다 — 양의 정수 센트만 남긴다. */
function sanitizePrices(raw: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [tier, cents] of Object.entries(raw)) {
    if (/^\d+$/.test(tier) && typeof cents === 'number' && Number.isInteger(cents) && cents > 0) out[tier] = cents;
  }
  return out;
}

// ─────────────────────────────────────── purchaseTicket

export interface PurchaseTicketRequest {
  eventId: string;
  tier: number;
  auth: { eventId: string; tier: number; account: string; nonce: string; deadline: string };
  deviceSig: string;
  payment: { method: 'card-mock'; amountUsdCents: number };
}
export interface PurchaseTicketResult {
  orderId: string;
  relayId: string;
  status: 'minted' | 'deposited' | 'sent';
  tokenId?: string;
  depositTxHash?: string;
}

/**
 * 관객 구매(설계 §2/§5). mock 결제 성공을 가정하고 (1) relayClaim 으로 무료 민팅,
 * (2) 트레저리가 USDC 를 금고에 예치한다. 가격은 settlements 거울의 티어별 가격과 대조한다.
 * 멱등키는 `(account,eventId,nonce)`(= claim relayId = orderId).
 */
export const purchaseTicket = onCall(
  { secrets: [RELAYER_PK, TREASURY_PK] },
  async (request): Promise<PurchaseTicketResult> => {
    const account = await resolveCallerAccount(request);
    const personId = await callerPersonId(request);
    const body = (request.data ?? {}) as Partial<PurchaseTicketRequest>;

    const eventId = toBigInt(body.eventId, 'BAD_EVENT_ID');
    const eventIdStr = eventId.toString();
    const tier = requireTier(body.tier);
    const a = body.auth;
    if (!a || typeof a !== 'object') throw new HttpsError('invalid-argument', 'BAD_AUTH');
    const nonce = toBigInt(a.nonce, 'BAD_NONCE_ARG');
    const deadline = toBigInt(a.deadline, 'BAD_DEADLINE');
    const deviceSig = requireSig(body.deviceSig, 'BAD_DEVICE_SIG');
    const pay = body.payment;
    if (!pay || pay.method !== 'card-mock') throw new HttpsError('invalid-argument', 'BAD_PAYMENT');
    if (typeof pay.amountUsdCents !== 'number' || !Number.isInteger(pay.amountUsdCents) || pay.amountUsdCents <= 0) {
      throw new HttpsError('invalid-argument', 'BAD_AMOUNT');
    }
    const amountUsdCents = pay.amountUsdCents;

    // 가격 검증 — settlements 거울의 티어 가격과 일치해야 한다(설계 §5).
    const settle = await settlementRef(eventIdStr).get();
    const prices = settle.get('priceUsdCentsByTier') as Record<string, number> | undefined;
    const price = prices?.[String(tier)];
    if (price === undefined) throw new HttpsError('failed-precondition', 'NO_PRICE', { code: 'NO_PRICE' });
    if (price !== amountUsdCents) {
      throw new HttpsError('failed-precondition', 'PRICE_MISMATCH', { code: 'PRICE_MISMATCH', expected: price });
    }

    const orderId = claimRelayId(account, eventId, nonce);
    const oref = orderRef(orderId);
    const existing = await oref.get();
    if (existing.exists) {
      const status = existing.get('status') as string;
      const done = reflectOrder(orderId, existing.get('tokenId') as string | undefined, status, existing.get('depositTxHash') as string | undefined);
      if (done) return done;
      // 'pending' 이면 아래로 진행해 민팅/예치를 재개한다(runRelayClaim 이 멱등).
    } else {
      await oref.set({
        personId,
        account,
        eventId: eventIdStr,
        tier,
        amountUsdCents,
        method: 'card-mock',
        status: 'pending',
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
    }

    const claim = await runRelayClaim({ account, personId, mode: 'claim', eventId, tier, nonce, deadline, deviceSig });

    if (claim.status !== 'confirmed' || !claim.tokenId) {
      // 발급이 아직 비행 중(또는 tokenId 미확정) → minted-pending. 스윕이 예치를 마무리한다.
      await oref.set({ status: 'minted-pending', relayId: claim.relayId, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      return { orderId, relayId: claim.relayId, status: 'sent' };
    }

    const tokenId = BigInt(claim.tokenId);
    await oref.set({ tokenId: claim.tokenId, relayId: claim.relayId, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    try {
      const dep = await depositForOrder(oref, eventId, tokenId, amountUsdCents);
      if (dep.status === 'deposited') {
        return { orderId, relayId: claim.relayId, status: 'deposited', tokenId: claim.tokenId, depositTxHash: dep.depositTxHash };
      }
      return { orderId, relayId: claim.relayId, status: 'minted', tokenId: claim.tokenId };
    } catch (err) {
      // 예치 실패(설정 오류·전송 실패) — 티켓은 이미 민팅됐으므로 500 을 던지지 않고 minted-pending 으로 둔다.
      const code = err instanceof HttpsError ? (err.details as { code?: string } | undefined)?.code ?? err.message : (err as Error).message;
      await oref.set({ status: 'minted-pending', depositError: code, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      info('purchaseTicket.deposit.deferred', { orderId, reason: code });
      return { orderId, relayId: claim.relayId, status: 'minted', tokenId: claim.tokenId };
    }
  },
);

/** 이미 있는 주문을 응답 모양으로 되비춘다(멱등 재호출). 아직 처리 중('pending')이면 null. */
function reflectOrder(orderId: string, tokenId: string | undefined, status: string, depositTxHash: string | undefined): PurchaseTicketResult | null {
  const relayId = orderId;
  if (status === 'deposited' || status === 'released' || status === 'refunded') {
    return { orderId, relayId, status: 'deposited', tokenId, depositTxHash };
  }
  if (status === 'minted-pending') {
    return { orderId, relayId, status: tokenId ? 'minted' : 'sent', tokenId };
  }
  return null;
}

/**
 * 트레저리가 한 토큰의 USDC 를 금고에 예치한다(설계 §2). 필요하면 먼저 approve(max)한다.
 * AlreadyDeposited 는 멱등 성공으로 읽는다. 영수증을 못 보면 minted-pending 으로 두고 스윕이 재확인한다.
 */
async function depositForOrder(
  oref: FirebaseFirestore.DocumentReference,
  eventId: bigint,
  tokenId: bigint,
  amountUsdCents: number,
): Promise<{ status: 'deposited' | 'minted-pending'; depositTxHash?: string }> {
  const vault = vaultAddress();
  const usdc = usdcAddress();
  const amount6dp = BigInt(amountUsdCents) * USDC_UNITS_PER_CENT;
  await ensureAllowance(vault, usdc, amount6dp);

  let gas: bigint;
  try {
    gas = await vaultSimulate('deposit', [eventId, tokenId, usdc, amount6dp], getTreasuryAccount().address);
  } catch (err) {
    if (revertName(err) === 'AlreadyDeposited') {
      await oref.set({ status: 'deposited', tokenId: tokenId.toString(), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      return { status: 'deposited' };
    }
    throw mapRevert(err, DEPOSIT_CODES, 'DEPOSIT_REVERTED');
  }
  const data = vaultCalldata('deposit', [eventId, tokenId, usdc, amount6dp]);
  const sent = await sendFromTreasury({ to: vault, data, gasLimit: gas });
  const receipt = await receiptWithin(sent.hash);
  if (receipt && receipt.status === 'success') {
    await oref.set(
      { status: 'deposited', tokenId: tokenId.toString(), depositTxHash: sent.hash, updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
    info('settlement.deposit.confirmed', { tokenId: tokenId.toString(), txHash: sent.hash });
    return { status: 'deposited', depositTxHash: sent.hash };
  }
  await oref.set(
    { status: 'minted-pending', tokenId: tokenId.toString(), depositTxHash: sent.hash, updatedAt: FieldValue.serverTimestamp() },
    { merge: true },
  );
  return { status: 'minted-pending', depositTxHash: sent.hash };
}

/** 트레저리가 금고에 USDC 를 쓸 수 있게 approve(max)한다. 이미 충분하면 건너뛴다(최초 1회만 전송). */
async function ensureAllowance(spender: Hex, token: Hex, needed: bigint): Promise<void> {
  const treasury = getTreasuryAccount().address;
  const allowance = (await publicClient().readContract({
    address: token,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [treasury, spender],
  })) as bigint;
  if (allowance >= needed) return;
  const gas = await publicClient().estimateContractGas({
    address: token,
    abi: erc20Abi,
    functionName: 'approve',
    args: [spender, MAX_UINT256],
    account: treasury,
  });
  const data = encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, MAX_UINT256] });
  const sent = await sendFromTreasury({ to: token, data, gasLimit: gas });
  await waitTreasury(sent.hash); // approve 가 먼저 확정돼야 deposit 의 transferFrom 이 통과한다
  info('settlement.approve.max', { token, spender, txHash: sent.hash });
}

// ─────────────────────────────────────── 입장 트리거(release)

/**
 * 입장 확정 직후 그 토큰의 에스크로를 분배한다(설계 §3). relay.ts 의 relayCheckIn 이 동적 import 로
 * 부른다. 예치된 주문이 없으면(무료 행사 등) 아무것도 하지 않는다. release 는 permissionless·멱등이라
 * 릴레이어로 보낸다 — 실패해도 settlementSweep 이 백업한다.
 */
export async function onCheckInConfirmed(eventId: bigint, tokenId: bigint): Promise<void> {
  const tokenIdStr = tokenId.toString();
  const snap = await db.collection(ORDERS).where('tokenId', '==', tokenIdStr).limit(2).get();
  const order = snap.docs.find((d) => d.get('status') === 'deposited');
  if (!order) return;
  await releaseToken(eventId, tokenId, order.ref);
}

/** 한 토큰을 분배한다(release). AlreadySettled 는 멱등 성공으로 읽는다. */
async function releaseToken(eventId: bigint, tokenId: bigint, oref: FirebaseFirestore.DocumentReference): Promise<void> {
  const vault = vaultAddress();
  let gas: bigint;
  try {
    gas = await vaultSimulate('release', [tokenId], getRelayerAccount().address);
  } catch (err) {
    const name = revertName(err);
    if (name === 'AlreadySettled') {
      await oref.set({ status: 'released', updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      return;
    }
    if (name === 'NotCheckedIn' || name === 'NoEscrow') return; // 아직 입장 전/에스크로 없음 — 다음 기회에
    throw mapRevert(err, {}, 'RELEASE_REVERTED');
  }
  const data = vaultCalldata('release', [tokenId]);
  const sent = await sendRelayed({ to: vault, data, gasLimit: gas });
  await oref.set(
    { status: 'released', releaseTxHash: sent.hash, updatedAt: FieldValue.serverTimestamp() },
    { merge: true },
  );
  info('settlement.release.sent', { eventId: eventId.toString(), tokenId: tokenId.toString(), txHash: sent.hash });
}

// ─────────────────────────────────────── refundOrder

export interface RefundOrderResult {
  orderId: string;
  status: 'refunded';
  refundTxHash?: string;
}

/**
 * 분배 전 환불(설계 §2). 호출자는 주문자 본인 또는 그 행사의 주최자다. 금고 refund 는 트레저리
 * (=payer/depositor)가 호출하고, 취소된 행사면 누구나·그 밖이면 payer 만·미입장·미종료여야 한다
 * (컨트랙트가 집행; 시뮬이 revert 를 코드로 매핑). 피아트 환불은 목업이다.
 */
export const refundOrder = onCall({ secrets: [TREASURY_PK] }, async (request): Promise<RefundOrderResult> => {
  const account = await resolveCallerAccount(request);
  const personId = await callerPersonId(request);
  const body = (request.data ?? {}) as { orderId?: string };
  const orderId = body.orderId;
  if (!orderId || typeof orderId !== 'string') throw new HttpsError('invalid-argument', 'BAD_ORDER_ID');

  const oref = orderRef(orderId);
  const snap = await oref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'ORDER_NOT_FOUND', { code: 'ORDER_NOT_FOUND' });

  const status = snap.get('status') as string;
  if (status === 'refunded') return { orderId, status: 'refunded', refundTxHash: snap.get('refundTxHash') as string | undefined };
  if (status !== 'deposited') throw new HttpsError('failed-precondition', 'NOT_REFUNDABLE', { code: 'NOT_REFUNDABLE' });

  const tokenIdStr = snap.get('tokenId') as string | undefined;
  if (!tokenIdStr) throw new HttpsError('failed-precondition', 'NO_TOKEN', { code: 'NO_TOKEN' });
  const eventId = BigInt(snap.get('eventId') as string);
  const ownerPersonId = snap.get('personId') as string | undefined;

  // 인가: 주문자 본인 또는 행사 주최자.
  const isOwner = ownerPersonId === personId;
  if (!isOwner && !(await isEventOrganizer(eventId, account))) {
    throw new HttpsError('permission-denied', 'NOT_ALLOWED', { code: 'NOT_ALLOWED' });
  }

  const tokenId = BigInt(tokenIdStr);
  const vault = vaultAddress();
  let gas: bigint;
  try {
    gas = await vaultSimulate('refund', [tokenId], getTreasuryAccount().address);
  } catch (err) {
    throw mapRevert(err, REFUND_CODES, 'REFUND_REVERTED');
  }
  const data = vaultCalldata('refund', [tokenId]);
  const sent = await sendFromTreasury({ to: vault, data, gasLimit: gas });
  await oref.set({ status: 'refunded', refundTxHash: sent.hash, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  info('refundOrder.sent', { orderId, tokenId: tokenIdStr, txHash: sent.hash });
  return { orderId, status: 'refunded', refundTxHash: sent.hash };
});

// ─────────────────────────────────────── settlementSweep (reconcile 스케줄러에 붙는다)

/**
 * 멈춘 정산을 주기적으로 마무리한다(설계 §3, reconcilePending 의 스윕 하나로 붙는다):
 *  (1) minted-pending  → 예치 마무리(tokenId 를 알게 됐으면 deposit).
 *  (2) deposited + 입장 → release.
 *  (3) deposited + 미입장 + 행사 종료 → settleNoShows(행사별 ≤20 배치).
 * 스케줄러 밖으로는 던지지 않는다 — 문서 하나가 터져도 나머지는 계속 간다.
 */
export async function settlementSweep(): Promise<void> {
  await sweepMintedPending();
  await sweepDeposited();
}

/**
 * claim 영수증의 Ticket.Claimed 로그에서 tokenId 를 읽는다(relay.ts 콜러블과 같은 파싱).
 * 영수증이 아직 없거나 되돌아갔거나 로그가 없으면 undefined — 스윕이 다음 틱에 다시 본다.
 * "영수증 없음" 외의 RPC 오류는 그대로 올려 문서별 catch 가 로그만 남기게 한다.
 */
async function claimedTokenIdOf(hash: Hex): Promise<string | undefined> {
  let receipt: TransactionReceipt;
  try {
    receipt = await publicClient().getTransactionReceipt({ hash });
  } catch (cause) {
    if (cause instanceof TransactionReceiptNotFoundError) return undefined;
    throw cause;
  }
  if (receipt.status !== 'success') return undefined;
  const logs = parseEventLogs({ abi: ticketAbi, logs: receipt.logs, eventName: 'Claimed' }) as { args: { tokenId?: bigint } }[];
  return logs[0]?.args.tokenId?.toString();
}

async function sweepMintedPending(): Promise<void> {
  const cutoff = Timestamp.fromMillis(Date.now() - SWEEP_STALE_MS);
  const snapshot = await db
    .collection(ORDERS)
    .where('status', '==', 'minted-pending')
    .where('updatedAt', '<', cutoff)
    .limit(SWEEP_LIMIT)
    .get();
  if (snapshot.empty) return;

  for (const doc of snapshot.docs) {
    try {
      const eventId = BigInt(doc.get('eventId') as string);
      const amountUsdCents = doc.get('amountUsdCents') as number;
      let tokenIdStr = doc.get('tokenId') as string | undefined;
      if (!tokenIdStr) {
        // 콜러블이 확정을 본 claim 이면 릴레이 문서에 tokenId 가 있다. 콜러블이 8 s 안에 못 보고
        // 대사(reconcileRelays)가 confirmed 로 닫은 claim 은 tokenId 가 없다 — 대사는 상태만 닫는다.
        // 그때는 claim 영수증의 Claimed 로그에서 직접 되찾아 주문에 박는다.
        const claim = await relayRef(doc.id).get();
        tokenIdStr = claim.get('tokenId') as string | undefined;
        const claimTx = claim.get('txHash') as Hex | undefined;
        if (!tokenIdStr && claimTx) {
          tokenIdStr = await claimedTokenIdOf(claimTx);
          if (tokenIdStr) {
            await doc.ref.set({ tokenId: tokenIdStr }, { merge: true });
            info('settlement.sweep.tokenIdRecovered', { orderId: doc.id, tokenId: tokenIdStr, txHash: claimTx });
          } else {
            info('settlement.sweep.noClaimedLog', { orderId: doc.id, txHash: claimTx });
          }
        }
      }
      if (!tokenIdStr) continue; // 아직 tokenId 모름 — 다음 틱에 다시 본다
      await depositForOrder(doc.ref, eventId, BigInt(tokenIdStr), amountUsdCents);
    } catch (cause) {
      error('settlement.sweep.deposit', { orderId: doc.id, reason: (cause as Error).message });
    }
  }
}

async function sweepDeposited(): Promise<void> {
  const cutoff = Timestamp.fromMillis(Date.now() - SWEEP_STALE_MS);
  const snapshot = await db
    .collection(ORDERS)
    .where('status', '==', 'deposited')
    .where('updatedAt', '<', cutoff)
    .limit(SWEEP_LIMIT)
    .get();
  if (snapshot.empty) return;

  const pc = publicClient();
  const contracts = deployment();
  const endedCache = new Map<string, boolean>();
  const noShowByEvent = new Map<string, { eventId: bigint; tokenIds: bigint[] }>();

  for (const doc of snapshot.docs) {
    try {
      const tokenIdStr = doc.get('tokenId') as string | undefined;
      if (!tokenIdStr) continue;
      const tokenId = BigInt(tokenIdStr);
      const eventId = BigInt(doc.get('eventId') as string);

      const used = Number(
        await pc.readContract({ address: contracts.ticket, abi: ticketAbi, functionName: 'usedAt', args: [tokenId] }),
      );
      if (used !== 0) {
        await releaseToken(eventId, tokenId, doc.ref);
        continue;
      }
      // 미입장 — 행사가 끝났으면 노쇼 정산 대상에 모은다.
      const eventIdStr = eventId.toString();
      let ended = endedCache.get(eventIdStr);
      if (ended === undefined) {
        const st = Number(
          await pc.readContract({ address: contracts.ticket, abi: ticketAbi, functionName: 'eventStatus', args: [eventId] }),
        );
        ended = st === EVENT_ENDED;
        endedCache.set(eventIdStr, ended);
      }
      if (!ended) continue;
      const bucket = noShowByEvent.get(eventIdStr) ?? { eventId, tokenIds: [] };
      bucket.tokenIds.push(tokenId);
      noShowByEvent.set(eventIdStr, bucket);
    } catch (cause) {
      error('settlement.sweep.release', { orderId: doc.id, reason: (cause as Error).message });
    }
  }

  for (const { eventId, tokenIds } of noShowByEvent.values()) {
    for (let i = 0; i < tokenIds.length; i += NOSHOW_BATCH) {
      const batch = tokenIds.slice(i, i + NOSHOW_BATCH);
      try {
        await settleNoShowBatch(eventId, batch);
      } catch (cause) {
        error('settlement.sweep.noShow', { eventId: eventId.toString(), reason: (cause as Error).message });
      }
    }
  }
}

/** 한 행사의 노쇼 토큰 묶음을 정산한다(settleNoShows). 확정되면 그 주문들을 released 로 닫는다. */
async function settleNoShowBatch(eventId: bigint, tokenIds: bigint[]): Promise<void> {
  const vault = vaultAddress();
  let gas: bigint;
  try {
    gas = await vaultSimulate('settleNoShows', [eventId, tokenIds], getRelayerAccount().address);
  } catch (err) {
    throw mapRevert(err, { EventNotEnded: 'EVENT_NOT_ENDED', Paused: 'PAUSED' }, 'SETTLE_REVERTED');
  }
  const data = vaultCalldata('settleNoShows', [eventId, tokenIds]);
  const sent = await sendRelayed({ to: vault, data, gasLimit: gas });
  const receipt = await receiptWithin(sent.hash);
  if (!receipt || receipt.status !== 'success') return; // 다음 틱이 재확인
  // 어느 토큰이 노쇼정산/환불됐는지는 이벤트 로그가 정본이지만, 주문 거울은 released 로 닫아 둔다.
  const settledIds = new Set<string>([
    ...logTokenIds(receipt, 'NoShowSettled'),
    ...logTokenIds(receipt, 'Refunded'),
  ]);
  for (const tokenId of tokenIds) {
    if (!settledIds.has(tokenId.toString())) continue;
    const snap = await db.collection(ORDERS).where('tokenId', '==', tokenId.toString()).limit(1).get();
    const doc = snap.docs[0];
    if (doc) await doc.ref.set({ status: 'released', releaseTxHash: sent.hash, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  }
  info('settlement.noShow.settled', { eventId: eventId.toString(), count: settledIds.size, txHash: sent.hash });
}

/** 영수증 로그에서 한 이벤트 이름의 tokenId 들을 꺼낸다(settleNoShows 결과 반영용). */
function logTokenIds(receipt: TransactionReceipt, eventName: string): string[] {
  const logs = parseEventLogs({ abi: settlementAbi, logs: receipt.logs, eventName } as never) as { args: { tokenId?: bigint } }[];
  return logs.map((l) => l.args.tokenId?.toString()).filter((v): v is string => v !== undefined);
}
