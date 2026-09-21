import { FieldValue } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { getAddress, isAddress } from 'viem';
import { organizersAbi, ticketAbi, type Hex } from '@monti/shared';
import { PERM_MANAGE_GATES, resolveCallerAccount } from '../lib/auth.js';
import { deployment, publicClient } from '../lib/chain.js';
import { PENDING_GATES, db } from '../lib/db.js';

const DIGITS_RE = /^[0-9]+$/;
const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;
const ZERO_KEY = `0x${'00'.repeat(32)}`;

/** 한 공연의 승인 대기 단말기 수 상한. 화면 하나에 담기는 양을 넘으면 큐가 아니라 쓰레기통이다. */
export const PENDING_GATE_PAGE_SIZE = 200;

export interface PendingGateRow {
  gateAccount: Hex;
  kx: Hex;
  ky: Hex;
  submittedAt: number;
}

/**
 * 10진수 문자열 하나로 정규화한다. `"011"` 과 `"11"` 은 체인에서는 같은 공연인데
 * 문자열로는 다르다 — 큐에 적은 값과 읽을 때 거는 값이 어긋나면 안 된다.
 */
function requireEventId(value: unknown): string {
  if (typeof value !== 'string' || !DIGITS_RE.test(value)) {
    throw new HttpsError('invalid-argument', 'BAD_EVENT_ID');
  }
  return BigInt(value).toString();
}

/**
 * EIP-55 체크섬 주소로 통일한다. `strict` 는 대소문자가 섞인 주소의 체크섬까지 맞춰 본다 —
 * 그게 EIP-55 가 존재하는 이유(옮겨 적다 틀린 한 글자)이고, 여기서 놓치면 관리자가
 * 아무 단말기도 아닌 주소를 체인에 등록하게 된다. 소문자 주소는 그대로 통과한다.
 */
function requireGateAccount(value: unknown): Hex {
  if (typeof value !== 'string' || !isAddress(value, { strict: true })) {
    throw new HttpsError('invalid-argument', 'BAD_GATE_ACCOUNT');
  }
  return getAddress(value);
}

/**
 * 안드로이드 하드웨어 P-256 공개키의 한 좌표(bytes32).
 *
 * **반쪽이 0 인 키도 막는다.** `Organizers.registerGate` 는 `kx` 와 `ky` 가 **둘 다** 0 일 때만
 * 되돌리므로(`InvalidGateKey`), 한쪽만 0 인 키는 체인에 그대로 올라간다. 그런 값은 P-256 위의
 * 점이 아니라서 그 게이트는 어떤 서명도 검증하지 못한다 — 승인 화면에 오르기 전에 막는 편이,
 * 등록된 뒤 폐기하고 다시 올리는 것보다 싸다.
 */
function requireDeviceKey(value: unknown): Hex {
  if (typeof value !== 'string' || !BYTES32_RE.test(value)) {
    throw new HttpsError('invalid-argument', 'BAD_DEVICE_KEY');
  }
  const key = value.toLowerCase();
  if (key === ZERO_KEY) throw new HttpsError('invalid-argument', 'BAD_DEVICE_KEY');
  return key as Hex;
}

/**
 * 큐를 볼 수 있는 사람인지 **체인에서** 판정한다. 우리 DB 에는 역할이 없다(스펙 §9.4).
 *
 * 그 조직의 **오너**이거나 `PERM_MANAGE_GATES` 비트를 가진 **관리자**만 통과한다.
 * 매니저는 들어오지 못한다 — 이 목록은 곧 `Organizers.registerGate` 에 넣을 인자이고,
 * 그 함수가 요구하는 권한이 정확히 이 비트다. `ownerOf` 를 따로 읽는 이유는 `listAttendees`
 * 와 같다: 배포된 `hasPermission` 이 오너를 어떻게 다루는지에 인가를 걸지 않는다.
 */
async function requireGateAdmin(eventId: bigint, caller: Hex): Promise<void> {
  const pc = publicClient();
  const contracts = deployment();

  const orgId = (await pc.readContract({
    address: contracts.ticket,
    abi: ticketAbi,
    functionName: 'eventOrg',
    args: [eventId],
  })) as bigint;

  const [owner, canManageGates] = await Promise.all([
    pc.readContract({
      address: contracts.organizers,
      abi: organizersAbi,
      functionName: 'ownerOf',
      args: [orgId],
    }) as Promise<Hex>,
    pc.readContract({
      address: contracts.organizers,
      abi: organizersAbi,
      functionName: 'hasPermission',
      args: [orgId, caller, PERM_MANAGE_GATES],
    }) as Promise<boolean>,
  ]);

  if (owner.toLowerCase() !== caller.toLowerCase() && !canManageGates) {
    throw new HttpsError('permission-denied', 'NOT_GATE_ADMIN');
  }
}

/**
 * 스태프 단말기가 만든 게이트 계정을 관리자 화면 큐에 올린다(스펙 §5.7 1번).
 *
 * 호출자는 **스태프 폰의 전화 인증 세션**이다. 스마트 계정도, Identity 등록도 요구하지 않는다 —
 * 게이트 계정은 구성원이 아니고, 키를 만든 단말기는 패스키 로그인을 하지 않는다. 그래서
 * **여기에는 권한이 없다.** 이 컬렉션은 승인 전 제안일 뿐이고, 진짜 권한은 관리자가
 * `Organizers.registerGate` 를 직접 서명하는 순간에만 움직인다.
 */
export const submitPendingGate = onCall(async (request): Promise<{ ok: true }> => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'AUTH_REQUIRED');

  const raw = (request.data ?? {}) as { eventId?: unknown; gateAccount?: unknown; kx?: unknown; ky?: unknown };
  const eventId = requireEventId(raw.eventId);
  const gateAccount = requireGateAccount(raw.gateAccount);
  const kx = requireDeviceKey(raw.kx);
  const ky = requireDeviceKey(raw.ky);

  // 문서 id 는 소문자 주소다. 같은 단말기가 다시 올려도 줄이 하나 더 생기지 않는다.
  const ref = db.collection(PENDING_GATES).doc(gateAccount.toLowerCase());
  await db.runTransaction(async (tx) => {
    const existing = await tx.get(ref);
    if (!existing.exists) {
      tx.set(ref, {
        eventId,
        kx,
        ky,
        submittedBy: uid,
        status: 'pending',
        createdAt: FieldValue.serverTimestamp(),
      });
      return;
    }
    // 재제출은 키만 갈아 끼운다. `status` 와 `createdAt` 은 그대로 둔다 —
    // 이미 체인에 올라간 게이트를 다시 `pending` 으로 돌리면 `registerGate` 가 같은 계정을
    // 두 번 받지 않으므로(`GateAccountInUse`) 승인할 수 없는 줄이 화면에 영영 남는다.
    tx.set(ref, { eventId, kx, ky, submittedBy: uid }, { merge: true });
  });

  return { ok: true };
});

/**
 * 관리자 화면이 "승인 대기 중인 단말기" 목록을 읽는다. 승인은 체인에서 직접 한다.
 *
 * 나가는 것은 `registerGate(eventId, gateAccount, kx, ky)` 를 부르는 데 필요한 값과
 * 정렬용 시각뿐이다. 누가 올렸는지(uid)는 나가지 않는다 — 스태프의 전화 세션 식별자다.
 */
export const listPendingGates = onCall(async (request): Promise<{ gates: PendingGateRow[] }> => {
  // 인증이 먼저다. 로그인하지 않은 호출자는 인자가 어떻게 생겼는지도 배우지 못한다.
  const caller = await resolveCallerAccount(request);
  const raw = (request.data ?? {}) as { eventId?: unknown };
  const eventId = requireEventId(raw.eventId);
  await requireGateAdmin(BigInt(eventId), caller);

  const snapshot = await db
    .collection(PENDING_GATES)
    .where('eventId', '==', eventId)
    .where('status', '==', 'pending')
    .limit(PENDING_GATE_PAGE_SIZE)
    .get();

  return {
    gates: snapshot.docs.map((doc) => ({
      gateAccount: getAddress(doc.id),
      kx: doc.get('kx') as Hex,
      ky: doc.get('ky') as Hex,
      submittedAt: Number((doc.get('createdAt') as { toMillis?: () => number } | undefined)?.toMillis?.() ?? 0),
    })),
  };
});
