import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { organizersAbi, ticketAbi, type Hex } from '@monti/shared';
import { PERM_APPROVE_OVERRIDE, resolveCallerAccount, resolveCallerPersonId } from '../lib/auth.js';
import { deployment, publicClient } from '../lib/chain.js';
import { OVERRIDE_REQUESTS, db } from '../lib/db.js';

/**
 * 수동 입장 승인 **요청**(v2 설계 §6, P4). v1 은 권한 없는 매니저가 `Ticket.requestOverride` 를
 * 체인에 올렸지만, 그 tx 는 아무도 온체인에서 읽지 않는 이벤트만 냈다. v2 는 요청을 이 컬렉션에
 * 적고, 승인은 그대로 승인권자의 `manualOverride` 릴레이 1건이다 — 그 확정이
 * `approveOpenOverrideRequests` 로 요청을 닫는다.
 *
 * 인가는 삭제된 컨트랙트 함수와 **같은 기준**을 eth_call 로 묻는다(우리 DB 에는 역할이 없다).
 */

const UINT_RE = /^[0-9]{1,78}$/;
/** 요청 문서 수명. 현장 승인은 분 단위 일이라 하루면 넉넉하고, 그 뒤엔 TTL 이 지운다. */
export const OVERRIDE_REQUEST_TTL_MS = 24 * 60 * 60 * 1000;
/** 승인권자 목록 상한(설계 §6). */
export const OVERRIDE_REQUEST_PAGE_SIZE = 50;
const NOTE_MAX = 140;

export interface OverrideRequestRow {
  id: string;
  tokenId: string;
  gateId: string;
  reason: number;
  note?: string;
  requesterAccount: string;
  createdAt: number;
}

function fail(status: 'not-found' | 'invalid-argument' | 'failed-precondition' | 'permission-denied', code: string): HttpsError {
  return new HttpsError(status, code, { code });
}

/** 10진수 문자열 → bigint. `"011"` 과 `"11"` 이 같은 문서 값이 되도록 저장은 `toString()` 으로 한다. */
function requireUint(value: unknown, code: string): bigint {
  if (typeof value !== 'string' || !UINT_RE.test(value)) throw new HttpsError('invalid-argument', code);
  return BigInt(value);
}

function requireReason(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 4) {
    throw new HttpsError('invalid-argument', 'BAD_REASON');
  }
  return value;
}

function optionalNote(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new HttpsError('invalid-argument', 'BAD_NOTE');
  const note = value.trim();
  if (note.length > NOTE_MAX) throw new HttpsError('invalid-argument', 'BAD_NOTE');
  return note.length > 0 ? note : undefined;
}

/** TTL 삭제는 최대 하루 늦게 돈다 — 만료 시각이 지난 문서는 없는 것으로 본다. */
function unexpired(doc: { get(field: string): unknown }, now: number): boolean {
  const expireAt = doc.get('expireAt') as Timestamp | undefined;
  return (expireAt?.toMillis() ?? 0) > now;
}

async function eventOrgOf(eventId: bigint): Promise<bigint> {
  const orgId = (await publicClient().readContract({
    address: deployment().ticket,
    abi: ticketAbi,
    functionName: 'eventOrg',
    args: [eventId],
  })) as bigint;
  if (orgId === 0n) throw fail('not-found', 'UNKNOWN_EVENT');
  return orgId;
}

async function managerOf(orgId: bigint, account: Hex): Promise<readonly [boolean, boolean]> {
  return (await publicClient().readContract({
    address: deployment().organizers,
    abi: organizersAbi,
    functionName: 'managerOf',
    args: [orgId, account],
  })) as readonly [boolean, boolean];
}

/** `hasPermission` 은 오너에게 언제나 참이다(`Organizers.sol`). */
async function canApproveOverride(orgId: bigint, account: Hex): Promise<boolean> {
  return (await publicClient().readContract({
    address: deployment().organizers,
    abi: organizersAbi,
    functionName: 'hasPermission',
    args: [orgId, account, PERM_APPROVE_OVERRIDE],
  })) as boolean;
}

export const requestOverride = onCall(async (request): Promise<{ requestId: string }> => {
  const account = await resolveCallerAccount(request);
  const personId = await resolveCallerPersonId(request);
  const body = (request.data ?? {}) as Record<string, unknown>;
  const eventId = requireUint(body.eventId, 'BAD_EVENT_ID');
  const tokenId = requireUint(body.tokenId, 'BAD_TOKEN_ID');
  const gateId = requireUint(body.gateId, 'BAD_GATE_ID');
  const reason = requireReason(body.reason);
  const note = optionalNote(body.note);

  const orgId = await eventOrgOf(eventId);
  // 토큰 id 의 상위 160비트가 공연 id 다(Ticket 의 id 레이아웃).
  if (tokenId >> 96n !== eventId) throw fail('invalid-argument', 'WRONG_EVENT');

  const [gate, manager, approver] = await Promise.all([
    publicClient().readContract({
      address: deployment().organizers,
      abi: organizersAbi,
      functionName: 'gateInfo',
      args: [gateId],
    }) as Promise<readonly [bigint, ...unknown[]]>,
    managerOf(orgId, account),
    canApproveOverride(orgId, account),
  ]);
  if (gate[0] !== eventId) throw fail('failed-precondition', 'GATE_MISMATCH');
  if (!manager[0] && !approver) throw fail('permission-denied', 'NOT_ALLOWED');

  // 같은 티켓의 열린 요청이 있으면 그것을 돌려준다 — 승인권자 카드에 같은 사람이 두 줄 서지 않게.
  const now = Date.now();
  const open = await db
    .collection(OVERRIDE_REQUESTS)
    .where('tokenId', '==', tokenId.toString())
    .where('status', '==', 'open')
    .get();
  const live = open.docs.find((doc) => unexpired(doc, now));
  if (live) return { requestId: live.id };

  const ref = db.collection(OVERRIDE_REQUESTS).doc();
  await ref.set({
    eventId: eventId.toString(),
    tokenId: tokenId.toString(),
    gateId: gateId.toString(),
    reason,
    ...(note ? { note } : {}),
    requesterAccount: account,
    requesterPersonId: personId,
    status: 'open',
    createdAt: FieldValue.serverTimestamp(),
    expireAt: Timestamp.fromMillis(now + OVERRIDE_REQUEST_TTL_MS),
  });
  return { requestId: ref.id };
});

export const listOverrideRequests = onCall(async (request): Promise<{ requests: OverrideRequestRow[] }> => {
  const account = await resolveCallerAccount(request);
  const body = (request.data ?? {}) as Record<string, unknown>;
  const eventId = requireUint(body.eventId, 'BAD_EVENT_ID');

  const orgId = await eventOrgOf(eventId);
  // 승인할 수 있는 사람만 본다: PERM_APPROVE_OVERRIDE(오너 포함) 또는 canApprove 매니저.
  const [manager, approver] = await Promise.all([managerOf(orgId, account), canApproveOverride(orgId, account)]);
  if (!approver && !manager[1]) throw fail('permission-denied', 'NOT_ALLOWED');

  const snap = await db
    .collection(OVERRIDE_REQUESTS)
    .where('eventId', '==', eventId.toString())
    .where('status', '==', 'open')
    .orderBy('createdAt', 'desc')
    .limit(OVERRIDE_REQUEST_PAGE_SIZE)
    .get();
  const now = Date.now();
  const requests = snap.docs
    .filter((doc) => unexpired(doc, now))
    .map((doc) => {
      const note = doc.get('note') as string | undefined;
      return {
        id: doc.id,
        tokenId: doc.get('tokenId') as string,
        gateId: doc.get('gateId') as string,
        reason: doc.get('reason') as number,
        ...(note ? { note } : {}),
        requesterAccount: doc.get('requesterAccount') as string,
        createdAt: (doc.get('createdAt') as Timestamp).toMillis(),
      };
    });
  return { requests };
});
