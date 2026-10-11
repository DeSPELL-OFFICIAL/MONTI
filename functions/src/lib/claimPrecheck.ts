import { HttpsError } from 'firebase-functions/v2/https';
import { BaseError, ContractFunctionRevertedError } from 'viem';
import { identityAbi, ticketAbi, type Hex } from '@monti/shared';
import { deployment, publicClient } from './chain.js';
import { RELAYS, db } from './db.js';

/**
 * 관객 승인서(ClaimAuth) 제출의 **가스 전 사전확인** 한 벌. 무료 발급(`relay.ts` `runRelayClaim`)과
 * 유료 원자 결제(`settlement.ts` `purchaseTicket`, v2 설계 §3 단계 2)가 같은 규약을 쓰도록 뽑아 둔다.
 * 클라이언트로 나가는 `message` 에는 web3 단어를 넣지 않는다 — 코드만 주고 카피는 웹이 가진다.
 */

/** 사람당 미확정(pending|sent) 릴레이 상한. RPC/가스 남용 방어(설계 §5). */
const MAX_PENDING = 5;

/**
 * Ticket 발급 revert → 안정 코드(웹이 카피로 매핑). 무료 발급과 유료 결제(`mintPaid` 가 같은 검사를
 * 버블)가 함께 쓴다. 표에 없는 이름은 호출부의 fallback(`REVERTED`)으로 떨어진다.
 */
export const CLAIM_CODES: Record<string, string> = {
  AuthExpired: 'AUTH_EXPIRED',
  BadNonce: 'BAD_NONCE',
  NotMember: 'NOT_MEMBER',
  DeviceLocked: 'DEVICE_LOCKED',
  BadDeviceSignature: 'BAD_DEVICE_SIG',
  ApprovalRequired: 'APPROVAL_REQUIRED',
  ApprovalNotRequired: 'APPROVAL_NOT_REQUIRED',
  KycRequired: 'KYC_REQUIRED',
  SaleClosed: 'NOT_ON_SALE',
  SoldOut: 'SOLD_OUT',
  MaxPerWalletExceeded: 'LIMIT',
  PaidTiersNotEnabled: 'PAID_TIERS',
  UnknownTier: 'UNKNOWN_TIER',
  UnknownEvent: 'UNKNOWN_EVENT',
  EventNotPublished: 'NOT_PUBLISHED',
  EventEnded: 'EVENT_ENDED',
  EventCancelled: 'EVENT_CANCELLED',
};

/** 던진 오류에서 viem 이 디코딩한 커스텀 에러 이름을 꺼낸다. revert 가 아니면 null(→ RPC 오류). */
export function revertName(err: unknown): string | null {
  if (!(err instanceof BaseError)) return null;
  const revert = err.walk((e) => e instanceof ContractFunctionRevertedError);
  if (revert instanceof ContractFunctionRevertedError) {
    return revert.data?.errorName ?? revert.reason ?? null;
  }
  return null;
}

/** revert → HttpsError. 매핑되면 `failed-precondition`+코드, revert 가 아니면 `internal`. */
export function mapRevert(err: unknown, table: Record<string, string>, fallback: string): HttpsError {
  const name = revertName(err);
  if (name === null) return new HttpsError('internal', 'SIMULATE_FAILED', { code: 'SIMULATE_FAILED' });
  const code = table[name] ?? fallback;
  return new HttpsError('failed-precondition', code, { code });
}

export interface ClaimPrecheck {
  account: Hex;
  eventId: bigint;
  nonce: bigint;
  deadline: bigint;
}

/**
 * 승인서 사전확인(설계 §5): deadline 미래 → `isMember`·`!isLocked` → 체인 `claimNonce` 재대조.
 * 진부/중복 승인서를 가스 쓰기 전에 막고, nonce 가 어긋나면 현재 값을 돌려줘 재서명하게 한다.
 */
export async function precheckClaim({ account, eventId, nonce, deadline }: ClaimPrecheck): Promise<void> {
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  if (deadline <= nowSec) throw new HttpsError('failed-precondition', 'AUTH_EXPIRED', { code: 'AUTH_EXPIRED' });

  const pc = publicClient();
  const contracts = deployment();

  const [member, locked] = await Promise.all([
    pc.readContract({ address: contracts.identity, abi: identityAbi, functionName: 'isMember', args: [account] }) as Promise<boolean>,
    pc.readContract({ address: contracts.identity, abi: identityAbi, functionName: 'isLocked', args: [account] }) as Promise<boolean>,
  ]);
  if (!member) throw new HttpsError('failed-precondition', 'NOT_MEMBER', { code: 'NOT_MEMBER' });
  if (locked) throw new HttpsError('failed-precondition', 'DEVICE_LOCKED', { code: 'DEVICE_LOCKED' });

  const chainNonce = (await pc.readContract({
    address: contracts.ticket,
    abi: ticketAbi,
    functionName: 'claimNonce',
    args: [eventId, account],
  })) as bigint;
  if (chainNonce !== nonce) {
    throw new HttpsError('failed-precondition', 'BAD_NONCE', { code: 'BAD_NONCE', nonce: chainNonce.toString() });
  }
}

/** 사람당 미확정 릴레이가 상한을 넘으면 거절(설계 §5). */
export async function assertUnderPendingLimit(personId: Hex): Promise<void> {
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
