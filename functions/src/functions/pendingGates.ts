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

/**
 * 한 uid 가 동시에 올려 둘 수 있는 `pending` 제안 수.
 *
 * 이 함수는 전화 인증만 확인하고 체인 권한을 묻지 않으므로(게이트를 만든 단말기에는 스마트 계정이
 * 없다), 로그인한 누구나 줄을 세울 수 있다. 상한이 없으면 한 사람이 관리자 화면을 통째로 덮어
 * 진짜 단말기가 `PENDING_GATE_PAGE_SIZE` 밖으로 밀려난다. 게이트 3대는 한 사람이 한 번에 설치하는
 * 현실적인 최대치고, 승인되거나(`registered`) 7일 뒤 만료되면(`reconcilePending`) 자리가 돌아온다.
 */
export const MAX_PENDING_PER_UID = 3;

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
  // 없는 공연은 0 을 돌려준다. 그대로 이어 가면 `ownerOf(0)` 은 0 주소라 아무도 오너가 아니고,
  // 호출자는 "권한 없음" 을 받아 자기 권한을 의심하게 된다 — 틀린 것은 공연 번호다.
  if (orgId === 0n) throw new HttpsError('not-found', 'UNKNOWN_EVENT');

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
  const mine = db
    .collection(PENDING_GATES)
    .where('submittedBy', '==', uid)
    .where('status', '==', 'pending')
    .limit(MAX_PENDING_PER_UID);

  await db.runTransaction(async (tx) => {
    const existing = await tx.get(ref);

    if (existing.exists) {
      // **올린 사람만 고친다.** 게이트 주소는 스태프 화면에 글자로 뜨는 반공개 값이라, 이 검사가
      // 없으면 아무 로그인 사용자나 남의 단말기 키를 덮어쓰거나 `eventId` 를 바꿔 그 줄을 원래
      // 주최자의 목록에서 치울 수 있다. 관리자는 소유자 키와 맞지 않는 키로 게이트를 등록하게 되고,
      // 그 게이트는 어떤 입장도 검증하지 못한다.
      if (existing.get('submittedBy') !== uid) {
        throw new HttpsError('permission-denied', 'NOT_YOUR_GATE');
      }
      // 재제출은 키만 갈아 끼운다. `status` 와 `createdAt` 은 그대로 둔다 —
      // 이미 체인에 올라간 게이트를 다시 `pending` 으로 돌리면 `registerGate` 가 같은 계정을
      // 두 번 받지 않으므로(`GateAccountInUse`) 승인할 수 없는 줄이 화면에 영영 남는다.
      tx.set(ref, { eventId, kx, ky }, { merge: true });
      return;
    }

    // 등식 두 개뿐이라 복합 색인이 필요 없다(Firestore 가 단일 필드 색인을 병합한다).
    // 상한만큼만 읽어 세면 되므로 밀린 줄이 몇 개든 읽는 양은 3건으로 고정이다.
    const open = await tx.get(mine);
    if (open.size >= MAX_PENDING_PER_UID) {
      throw new HttpsError('resource-exhausted', 'TOO_MANY_PENDING');
    }

    tx.set(ref, {
      eventId,
      kx,
      ky,
      submittedBy: uid,
      status: 'pending',
      createdAt: FieldValue.serverTimestamp(),
    });
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

  // 최신 것부터. 정렬이 없으면 200칸 창이 문서 id(주소) 순으로 잘려, 방금 올린 단말기가
  // 주소 하나 때문에 화면에서 사라진다. 등식 둘 + 다른 필드 정렬이라 복합 색인이 필요하다
  // (`firestore.indexes.json` 의 `pendingGates (eventId, status, createdAt desc)`).
  const snapshot = await db
    .collection(PENDING_GATES)
    .where('eventId', '==', eventId)
    .where('status', '==', 'pending')
    .orderBy('createdAt', 'desc')
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
