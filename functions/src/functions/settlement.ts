import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { HttpsError, onCall, type CallableRequest } from 'firebase-functions/v2/https';
import { error, info } from 'firebase-functions/logger';
import {
  TransactionReceiptNotFoundError,
  WaitForTransactionReceiptTimeoutError,
  encodeFunctionData,
  erc20Abi,
  parseEventLogs,
  type TransactionReceipt,
} from 'viem';
import { CIRCLE_TESTNET_USDC, ticketAbi, type Hex } from '@monti/shared';
import { RELAYER_PK, TREASURY_PK } from '../config.js';
import { isEventOrganizer, resolveCallerAccount } from '../lib/auth.js';
import { deployment, publicClient } from '../lib/chain.js';
import { CLAIM_CODES, assertUnderPendingLimit, mapRevert, precheckClaim, revertName } from '../lib/claimPrecheck.js';
import { ORDERS, RELAYS, SETTLEMENTS, USERS, db } from '../lib/db.js';
import { getRelayerAccount, sendRelayed } from '../lib/relayer.js';
import { claimRelayId, type RelayKind } from '../lib/relayTypes.js';
import { UNITS_PER_CENT, purchaseSimAbi, settlementAbi, type ClaimAuthArgs } from '../lib/settlementAbi.js';
import { getTreasuryAccount, sendFromTreasury, waitTreasury } from '../lib/treasury.js';
import { recordEventUsage } from '../lib/usage.js';

/**
 * 프로그래머블 정산 백엔드(v2 트랜잭션 다이어트 설계 §3·§9). 두 콜러블 + 입장 트리거 + 스윕:
 *  - `purchaseTicket` — mock 카드결제 → 트레저리가 `SettlementVault.purchase` **1건**을 보낸다.
 *     금고가 `Ticket.mintPaid` 로 민팅하고 같은 tx 에서 USDC 를 에스크로로 당긴다(원자: 둘 다 되거나 둘 다 안 됨).
 *  - `refundOrder`    — 분배 전 환불(주문자/주최자) → 트레저리가 금고 refund 호출.
 *  - `onCheckInConfirmed` — 입장 확정 직후 그 토큰 에스크로를 분배(permissionless release).
 *  - `settlementSweep` — 영수증을 못 본 결제 마무리 + 미분배/노쇼 정산(reconcile 스케줄러에 붙는다).
 *
 * 주문 상태 기계(하위 호환 없음):
 *   pending ─전송─▶ sent ─영수증 성공─▶ deposited ─입장/노쇼─▶ released
 *      │             │                     └─환불─▶ refunded
 *      └─전송 실패─▶ failed ◀─revert / 10분 무영수증─┘
 *
 * 돈은 트레저리 EOA 로만 흐르고(관객은 토큰을 만지지 않는다), 가격·분배 권위는 온체인이다 —
 * settlements 거울은 공개 표시용이고 truth 는 체인/인덱서다.
 */

const B32_RE = /^0x[0-9a-fA-F]{64}$/;
const SIG_RE = /^0x[0-9a-fA-F]{128}$/;
const UINT_RE = /^\d+$/;

/** relays 문서 TTL(7일, relay.ts 와 같다). */
const RELAY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** 확정을 기다리는 상한. 넘으면 `sent` 로 응답하고 스윕이 영수증으로 마무리한다. */
const RECEIPT_WAIT_MS = 8_000;
/** 스윕이 건드리기 전 주문이 멈춰 있어야 하는 시간(살아 있는 콜러블과 경합하지 않게). */
const SWEEP_STALE_MS = 2 * 60 * 1000;
/** 영수증 없이 이만큼 지난 결제는 드롭으로 본다(reconcileRelays 의 TX_DROPPED 와 같은 10분). */
const DROP_AFTER_MS = 10 * 60 * 1000;
/** 한 스윕이 볼 주문 수 상한(reconcile 의 SWEEP_LIMIT 과 같은 뜻). */
const SWEEP_LIMIT = 200;
/** settleNoShows 한 번에 넣는 tokenId 상한(유계 배치). */
const NOSHOW_BATCH = 20;

const MAX_UINT256 = (1n << 256n) - 1n;
/** Ticket.EventStatus: Draft 0 · Published 1 · Cancelled 2 · Ended 3. */
const EVENT_ENDED = 3;

// ─────────────────────────────────────── revert → code 매핑

/**
 * `purchase` 시뮬 revert → 코드(계획 §1.2). Ticket 발급 오류는 `mintPaid` 가 그대로 버블하므로
 * 무료 발급의 `CLAIM_CODES` 를 공유하고, 금고·토큰 쪽 오류를 덧붙인다. 표에 없으면 `REVERTED`.
 */
const PURCHASE_CODES: Record<string, string> = {
  ...CLAIM_CODES,
  NotPaidTier: 'NOT_PAID_TIER',
  Paused: 'PAUSED',
  NotDepositor: 'CONFIG',
  TokenNotAllowed: 'CONFIG',
  NotVault: 'CONFIG',
  TransferFromFailed: 'TREASURY_FUNDS',
};
const REFUND_CODES: Record<string, string> = {
  NoEscrow: 'NO_ESCROW',
  NothingToRefund: 'NOTHING_TO_REFUND',
  NotDepositor: 'NOT_DEPOSITOR',
  AlreadyCheckedIn: 'ALREADY_CHECKED_IN',
  EventEnded: 'EVENT_ENDED',
  Paused: 'PAUSED',
};

/** 사전확인 실패를 웹이 매핑하는 `details.code` 로 던진다. */
function precondition(code: string, extra: Record<string, unknown> = {}): HttpsError {
  return new HttpsError('failed-precondition', code, { code, ...extra });
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

/** 금고 주소. 배포 JSON 에 없으면 설정 오류(CONFIG). */
function vaultAddress(): Hex {
  const vault = deployment().settlementVault;
  if (!vault) throw precondition('CONFIG', { reason: 'MISSING_SETTLEMENT_VAULT' });
  return vault;
}
/** 정산 토큰. 배포 JSON 의 usdc 가 있으면 그것을, 없으면 Circle 테스트 USDC. */
function usdcAddress(): Hex {
  return deployment().usdc ?? CIRCLE_TESTNET_USDC;
}

/** 금고 함수의 eth_call 시뮬 겸 가스 추정. revert 면 던지고 성공하면 가스 원값. */
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

/** 확정 영수증을 상한까지만 기다린다. 타임아웃이면 null(→ `sent`, 스윕이 마무리). */
async function receiptWithin(hash: Hex): Promise<TransactionReceipt | null> {
  try {
    return await publicClient().waitForTransactionReceipt({ hash, timeout: RECEIPT_WAIT_MS });
  } catch (err) {
    if (err instanceof WaitForTransactionReceiptTimeoutError) return null;
    throw err;
  }
}

function orderRef(orderId: string) {
  return db.collection(ORDERS).doc(orderId);
}
function relayRef(relayId: string) {
  return db.collection(RELAYS).doc(relayId);
}

// ─────────────────────────────────────── purchaseTicket

export interface PurchaseTicketRequest {
  eventId: string;
  tier: number;
  auth: { eventId: string; tier: number; account: string; nonce: string; deadline: string };
  deviceSig: string;
  payment: { method: 'card-mock'; amountUsdCents: number };
}
/** 계획 §1.2 동결 모양. relayId = orderId(웹이 `relays/{relayId}` 를 kind `purchase` 로 구독). */
export interface PurchaseTicketResult {
  orderId: string;
  relayId: string;
  status: 'deposited' | 'sent';
  tokenId?: string;
  txHash?: Hex;
}

/**
 * 티어 가격(센트). 공개 확정 훅이 쓴 `settlements/{eventId}.priceUsdCentsByTier` 거울을 먼저 읽고
 * (calldata 에서 디코드한 값이라 체인과 같다), 거울이 아직 없거나 그 티어가 없으면 체인 `tiers` 를 읽는다.
 * 정본은 체인이다 — `purchase` 는 금액 인자 없이 언제나 온체인 가격을 청구한다.
 */
async function tierPrice(eventId: bigint, tier: number): Promise<number> {
  const mirror = await db.collection(SETTLEMENTS).doc(eventId.toString()).get();
  const mirrored = (mirror.get('priceUsdCentsByTier') as Record<string, unknown> | undefined)?.[String(tier)];
  if (typeof mirrored === 'number' && Number.isInteger(mirrored) && mirrored >= 0) return mirrored;
  const tiers = (await publicClient().readContract({
    address: deployment().ticket,
    abi: ticketAbi,
    functionName: 'tiers',
    args: [eventId],
  })) as readonly { priceUsdCents: bigint }[];
  const t = tiers[tier];
  if (!t) throw precondition('UNKNOWN_TIER');
  return Number(t.priceUsdCents);
}

/** 트레저리 USDC 잔고 ≥ 금액 사전확인(부족하면 시뮬도 TransferFromFailed 로 떨어진다 — 더 일찍·더 싸게 거절). */
async function assertTreasuryFunds(token: Hex, amount: bigint): Promise<void> {
  const balance = (await publicClient().readContract({
    address: token,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [getTreasuryAccount().address],
  })) as bigint;
  if (balance < amount) throw precondition('TREASURY_FUNDS');
}

/**
 * 관객 구매(v2 설계 §3, 원자 결제). mock 결제 성공을 가정하고 트레저리가 `purchase(auth, sig, usdc)`
 * 1건을 보낸다 — 민팅·에스크로·USDC 이동이 한 tx 이고, 실패하면 셋 다 없던 일이 된다(nonce 도 미소비).
 * 멱등키는 `(account,eventId,nonce)`(= orderId = relayId).
 */
export const purchaseTicket = onCall({ secrets: [TREASURY_PK] }, async (request): Promise<PurchaseTicketResult> => {
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

  // 1) 멱등 — 사전확인보다 먼저(성공한 주문은 nonce 가 이미 소비돼 BAD_NONCE 로 오판하게 된다).
  const orderId = claimRelayId(account, eventId, nonce);
  const oref = orderRef(orderId);
  const rref = relayRef(orderId);
  const existing = await oref.get();
  if (existing.exists) {
    const reflected = reflectOrder(orderId, existing);
    if (reflected) return reflected;
    // 'failed' → 같은 nonce 로 재시도(원자 revert 라 nonce 미소비).
  }

  // 2) 가스 전 사전확인: 승인서·회원·잠금·nonce → 티어 가격(거울, 없으면 체인) → 미확정 상한 → 트레저리 잔고.
  await precheckClaim({ account, eventId, nonce, deadline });
  const price = await tierPrice(eventId, tier);
  if (price === 0) throw precondition('NOT_PAID_TIER');
  if (price !== amountUsdCents) throw precondition('PRICE_MISMATCH', { expected: price });
  await assertUnderPendingLimit(personId);

  const vault = vaultAddress();
  const usdc = usdcAddress();
  const amount = BigInt(price) * UNITS_PER_CENT;
  await assertTreasuryFunds(usdc, amount);
  await ensureAllowance(vault, usdc, amount);

  // 3) 시뮬(트레저리 = depositor 로). Ticket 오류 + 금고 오류 + TransferFromFailed 를 이름으로 디코딩.
  const claimAuth: ClaimAuthArgs = { eventId, tier, account, nonce, deadline };
  const args = [claimAuth, deviceSig, usdc] as const;
  let gasEstimate: bigint;
  try {
    gasEstimate = (await publicClient().estimateContractGas({
      address: vault,
      abi: purchaseSimAbi,
      functionName: 'purchase',
      args,
      account: getTreasuryAccount().address,
    } as never)) as bigint;
  } catch (err) {
    throw mapRevert(err, PURCHASE_CODES, 'REVERTED');
  }
  const data = vaultCalldata('purchase', args);

  // 4) 전송 전에 주문·릴레이 문서를 둔다(웹이 구독, 규칙이 personId 로 판정).
  const kind: RelayKind = 'purchase';
  await Promise.all([
    oref.set({
      personId,
      account,
      eventId: eventIdStr,
      tier,
      amountUsdCents,
      method: 'card-mock',
      status: 'pending',
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    }),
    rref.set({
      kind,
      personId,
      account,
      eventId: eventIdStr,
      idemKey: orderId,
      status: 'pending',
      createdAt: FieldValue.serverTimestamp(),
      expireAt: Timestamp.fromMillis(Date.now() + RELAY_TTL_MS),
    }),
  ]);

  let sent;
  try {
    sent = await sendFromTreasury({ to: vault, data, gasLimit: gasEstimate });
  } catch (err) {
    const message = (err as Error).message;
    await Promise.all([
      oref.set({ status: 'failed', error: { code: 'SEND_FAILED' }, updatedAt: FieldValue.serverTimestamp() }, { merge: true }),
      rref.set({ status: 'failed', failedAt: FieldValue.serverTimestamp(), error: { code: 'SEND_FAILED', message } }, { merge: true }),
    ]);
    error('purchaseTicket.send.failed', { orderId, reason: message });
    throw new HttpsError('internal', 'SEND_FAILED', { code: 'SEND_FAILED' });
  }

  await Promise.all([
    oref.set({ status: 'sent', txHash: sent.hash, updatedAt: FieldValue.serverTimestamp() }, { merge: true }),
    rref.set(
      {
        status: 'sent',
        txHash: sent.hash,
        nonce: sent.nonce,
        gasLimit: Number(sent.gasLimit),
        sentAt: FieldValue.serverTimestamp(),
        expireAt: Timestamp.fromMillis(Date.now() + RELAY_TTL_MS),
      },
      { merge: true },
    ),
  ]);
  info('purchaseTicket.sent', { orderId, txHash: sent.hash });

  // 5) 영수증 ≤8초. 못 보면 `sent` 로 응답하고 sweepSentOrders 가 같은 함수로 마무리한다.
  const receipt = await receiptWithin(sent.hash);
  if (!receipt) return { orderId, relayId: orderId, status: 'sent', txHash: sent.hash };
  const outcome = await finalizePurchase(oref, rref, eventId, sent.hash, receipt);
  if (outcome.status === 'failed') throw new HttpsError('aborted', 'REVERTED', { code: 'REVERTED' });
  return { orderId, relayId: orderId, status: 'deposited', tokenId: outcome.tokenId, txHash: sent.hash };
});

/** 이미 있는 주문을 응답 모양으로 되비춘다(멱등 재호출). 'failed' 면 null(재시도 허용). */
function reflectOrder(orderId: string, snap: FirebaseFirestore.DocumentSnapshot): PurchaseTicketResult | null {
  const status = snap.get('status') as string;
  const tokenId = snap.get('tokenId') as string | undefined;
  const txHash = snap.get('txHash') as Hex | undefined;
  const base = { orderId, relayId: orderId };
  if (status === 'deposited' || status === 'released' || status === 'refunded') {
    return { ...base, status: 'deposited', ...(tokenId ? { tokenId } : {}), ...(txHash ? { txHash } : {}) };
  }
  if (status === 'pending' || status === 'sent') return { ...base, status: 'sent', ...(txHash ? { txHash } : {}) };
  return null;
}

/**
 * 결제 영수증 하나로 주문·릴레이를 닫는다(콜러블과 스윕 공용 — tokenId 를 일관되게 쓰는 유일한 곳).
 * 성공 → `deposited` + `Claimed` 의 tokenId(+ 릴레이 `confirmed`), revert → 둘 다 `failed`(REVERTED).
 */
async function finalizePurchase(
  oref: FirebaseFirestore.DocumentReference,
  rref: FirebaseFirestore.DocumentReference,
  eventId: bigint,
  hash: Hex,
  receipt: TransactionReceipt,
): Promise<{ status: 'deposited'; tokenId?: string } | { status: 'failed' }> {
  if (receipt.status !== 'success') {
    await Promise.all([
      oref.set({ status: 'failed', error: { code: 'REVERTED' }, updatedAt: FieldValue.serverTimestamp() }, { merge: true }),
      rref.set(
        { status: 'failed', failedAt: FieldValue.serverTimestamp(), error: { code: 'REVERTED', message: 'execution reverted' } },
        { merge: true },
      ),
    ]);
    info('purchase.reverted', { orderId: oref.id, txHash: hash });
    return { status: 'failed' };
  }
  const tokenId = purchasedTokenId(receipt);
  if (!tokenId) error('purchase.noClaimedLog', { orderId: oref.id, txHash: hash });
  const withToken = tokenId ? { tokenId } : {};
  await Promise.all([
    oref.set(
      { status: 'deposited', depositTxHash: hash, ...withToken, error: FieldValue.delete(), updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    ),
    rref.set({ status: 'confirmed', confirmedAt: FieldValue.serverTimestamp(), ...withToken }, { merge: true }),
  ]);
  // 확정 가스를 이벤트의 조직 원장에 집계한다. 실패해도 결제는 이미 확정이라 삼킨다.
  await recordEventUsage(eventId, 'purchase', receipt).catch((cause) =>
    info('purchase.usage.failed', { orderId: oref.id, reason: (cause as Error).message }),
  );
  info('purchase.deposited', { orderId: oref.id, txHash: hash, tokenId });
  return { status: 'deposited', ...withToken };
}

/** purchase 영수증에서 tokenId: Ticket.Claimed 가 정본, 없으면 SettlementVault.Deposited. */
function purchasedTokenId(receipt: TransactionReceipt): string | undefined {
  const claimed = parseEventLogs({ abi: ticketAbi, logs: receipt.logs, eventName: 'Claimed' }) as { args: { tokenId?: bigint } }[];
  const fromClaimed = claimed[0]?.args.tokenId;
  if (fromClaimed !== undefined) return fromClaimed.toString();
  const deposited = parseEventLogs({ abi: settlementAbi, logs: receipt.logs, eventName: 'Deposited' } as never) as {
    args: { tokenId?: bigint };
  }[];
  return deposited[0]?.args.tokenId?.toString();
}

/**
 * 트레저리가 금고에 USDC 를 쓸 수 있게 approve(max)한다. 이미 충분하면 건너뛴다(최초 1회만 전송).
 * 운영에서는 O7 에서 cast 로 미리 데워 두므로 보통 읽기 1회로 끝난다.
 */
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
  await waitTreasury(sent.hash); // approve 가 먼저 확정돼야 purchase 의 transferFrom 이 통과한다
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
 * 멈춘 정산을 주기적으로 마무리한다(reconcilePending 의 스윕 하나로 붙는다):
 *  (1) sent       → 결제 영수증으로 deposited/failed(콜러블이 8초 안에 못 본 것). purchase 릴레이 문서의
 *                   유일한 마무리 주체다(reconcileRelays 는 kind `purchase` 를 건너뛴다).
 *  (2) deposited + 입장 → release.
 *  (3) deposited + 미입장 + 행사 종료 → settleNoShows(행사별 ≤20 배치).
 * 스케줄러 밖으로는 던지지 않는다 — 문서 하나가 터져도 나머지는 계속 간다.
 */
export async function settlementSweep(): Promise<void> {
  await sweepSentOrders();
  await sweepDeposited();
}

/** 영수증 1회 조회. 아직 없으면 null, 그 밖의 RPC 오류는 올린다(문서별 catch 가 로그). */
async function receiptOrNull(hash: Hex): Promise<TransactionReceipt | null> {
  try {
    return await publicClient().getTransactionReceipt({ hash });
  } catch (cause) {
    if (cause instanceof TransactionReceiptNotFoundError) return null;
    throw cause;
  }
}

/**
 * `sent` 주문을 영수증으로 닫는다. 릴레이 문서 상태는 보지 않는다 — v1 의 범용 `sweepRelays` 가
 * 스테이징 창 동안 같은 `relays/{id}` 를 tokenId 없이 `confirmed`(또는 `failed`)로 먼저 닫을 수 있어서,
 * 주문 상태와 영수증만 믿고 finalizePurchase 가 릴레이를 tokenId 와 함께 다시 덮는다(멱등).
 */
async function sweepSentOrders(): Promise<void> {
  const now = Date.now();
  const snapshot = await db
    .collection(ORDERS)
    .where('status', '==', 'sent')
    .where('updatedAt', '<', Timestamp.fromMillis(now - SWEEP_STALE_MS))
    .limit(SWEEP_LIMIT)
    .get();
  if (snapshot.empty) return;

  for (const doc of snapshot.docs) {
    try {
      const hash = doc.get('txHash') as Hex | undefined;
      const eventId = BigInt(doc.get('eventId') as string);
      const rref = relayRef(doc.id);
      const receipt = hash ? await receiptOrNull(hash) : null;
      if (receipt && hash) {
        await finalizePurchase(doc.ref, rref, eventId, hash, receipt);
        continue;
      }
      const updatedAt = (doc.get('updatedAt') as Timestamp | undefined)?.toMillis() ?? 0;
      if (now - updatedAt < DROP_AFTER_MS) continue; // 아직 기다린다
      // 10분 무영수증 = 드롭. 원자 결제라 체인에는 아무것도 남지 않았다(같은 nonce 재시도 가능).
      await Promise.all([
        doc.ref.set({ status: 'failed', error: { code: 'SEND_FAILED' }, updatedAt: FieldValue.serverTimestamp() }, { merge: true }),
        rref.set(
          { status: 'failed', failedAt: FieldValue.serverTimestamp(), error: { code: 'SEND_FAILED', message: 'no receipt after 10 minutes' } },
          { merge: true },
        ),
      ]);
      info('settlement.sweep.dropped', { orderId: doc.id, txHash: hash });
    } catch (cause) {
      error('settlement.sweep.sent', { orderId: doc.id, reason: (cause as Error).message });
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
      const eventId = BigInt(doc.get('eventId') as string);
      const tokenIdStr = doc.get('tokenId') as string | undefined;
      if (!tokenIdStr) {
        // tokenId 없는 deposited(로그 누락 등) — 영수증으로 다시 닫는다(멱등). 다음 틱에 분배를 본다.
        const hash = (doc.get('depositTxHash') ?? doc.get('txHash')) as Hex | undefined;
        if (hash) {
          const receipt = await receiptOrNull(hash);
          if (receipt) await finalizePurchase(doc.ref, relayRef(doc.id), eventId, hash, receipt);
        }
        continue;
      }
      const tokenId = BigInt(tokenIdStr);

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
