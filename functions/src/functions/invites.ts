import { randomUUID } from 'node:crypto';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { encodeFunctionData, getAddress } from 'viem';
import { organizersAbi, type Hex } from '@monti/shared';
import { PHONE_INDEX_KEY, RP_ID } from '../config.js';
import { PERM_MANAGE_MANAGERS, resolveCallerAccount } from '../lib/auth.js';
import { deployment, publicClient } from '../lib/chain.js';
import { INVITES, USERS, db } from '../lib/db.js';
import { hmacPhone } from '../lib/phoneIndex.js';

const ORG_ID_RE = /^[0-9]{1,78}$/;
const PHONE_RE = /^\+[0-9]{7,15}$/;
/** `randomUUID()` 가 내는 모양 그대로. 문서 id 자리에 경로가 들어오는 것을 막는다. */
const INVITE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type Role = 'admin' | 'manager';

/** `Organizers.sol` 이 선언한 비트의 합(1|2|4|8|16). 이 밖의 비트는 컨트랙트가 모른다. */
const ALL_PERMISSION_BITS = 31;
/** 초대장 수명. 지나면 아무도 못 받는다. */
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** `listInvites` 한 쪽의 상한. 한 조직의 팀 화면이 한 장에 그릴 만큼이다. */
export const INVITE_PAGE_SIZE = 200;

/**
 * **저장된** orgId. 인자는 `ORG_ID_RE` 를 지나지만 문서 안의 값은 아무도 검증하지 않는다 —
 * 그대로 `BigInt(...)` 에 넣으면 날것의 TypeError 가 터져 이유 없는 `internal` 이 나간다.
 */
function requireStoredOrgId(value: unknown): string {
  if (typeof value !== 'string' || !ORG_ID_RE.test(value)) {
    throw new HttpsError('failed-precondition', 'BAD_INVITE');
  }
  return value;
}

/**
 * Firestore `Timestamp` → epoch **초**. `serverTimestamp()` 는 쓰기가 확정되기 전까지
 * 비어 있으므로(그 순간 읽으면 `null`) 그런 줄은 0 초로 둔다 — 목록에서 빼지는 않는다.
 */
function epochSeconds(value: unknown): number {
  const stamp = value as { toMillis?: () => number } | null | undefined;
  return typeof stamp?.toMillis === 'function' ? Math.floor(stamp.toMillis() / 1000) : 0;
}

/** 주최자 팀 화면이 읽는 초대 한 줄. 번호 색인도, 권한 비트도, 만든 사람도 들어가지 않는다. */
export interface InviteRow {
  inviteId: string;
  role: Role;
  status: string;
  createdAt: number;
  /** 만료 시각(초). 이게 없으면 이미 죽은 `sent` 초대가 팀 화면에서 살아 있는 것처럼 보인다. */
  expiresAt: number;
  /** `accepted` 인 줄에만 붙는다 — 그 상태에서만 calldata 가 오너의 서명을 기다린다. */
  requiredSender?: Hex;
}

export interface InviteCalldata {
  to: Hex;
  data: Hex;
  orgId: string;
  role: Role;
  /**
   * 이 calldata 를 **보낼 수 있는** 계정 — 조직의 현재 오너다.
   * 초대받은 사람이 자기 지갑으로 보내면 `Organizers` 가 되돌린다(`setAdmin` 은 오너만,
   * `setManager` 는 권한 보유자만). 웹은 이 주소를 보고 "오너가 보내야 한다"를 그린다.
   */
  requiredSender: Hex;
}

/**
 * 초대장을 만든다. **전화번호는 저장하지 않는다** — `startSignup` 과 똑같은 HMAC 색인
 * 값(`phoneHmac`)만 남기고 평문은 이 함수 밖으로 나가지 않는다. 받는 사람은 나중에
 * 자기 `users/{uid}.phoneHmac` 이 같을 때만 이 초대장을 쓸 수 있다.
 *
 * 인가는 컨트랙트 규칙을 그대로 옮긴다(`Organizers.sol`).
 *  - `manager` 초대 → 수락 calldata 가 `setManager` 이고, 그건 `PERM_MANAGE_MANAGERS(8)` 를
 *    가진 사람이 보낼 수 있다. 오너는 `hasPermission` 이 모든 비트를 참으로 돌려준다.
 *  - `admin` 초대 → 수락 calldata 가 `setAdmin` 이고, 그건 **오너만** 보낼 수 있다
 *    (`if (msg.sender != _owners[orgId]) revert NotOwner()`). 그래서 만드는 것도 오너만이다 —
 *    관리자가 만들면 아무도 실행할 수 없는 초대장이 된다.
 */
export const createInvite = onCall(
  { secrets: [PHONE_INDEX_KEY] },
  async (request): Promise<{ inviteId: string; link: string }> => {
    const { orgId, role, phoneE164, permissionBits, canApprove } = (request.data ?? {}) as {
      orgId?: string;
      role?: string;
      phoneE164?: string;
      permissionBits?: number;
      canApprove?: boolean;
    };
    if (typeof orgId !== 'string' || !ORG_ID_RE.test(orgId)) {
      throw new HttpsError('invalid-argument', 'BAD_ORG_ID');
    }
    if (role !== 'admin' && role !== 'manager') throw new HttpsError('invalid-argument', 'BAD_ROLE');
    if (typeof phoneE164 !== 'string' || !PHONE_RE.test(phoneE164)) {
      throw new HttpsError('invalid-argument', 'BAD_PHONE');
    }

    let bits = 0;
    if (role === 'admin') {
      if (
        !Number.isInteger(permissionBits) ||
        (permissionBits as number) < 1 ||
        (permissionBits as number) > ALL_PERMISSION_BITS
      ) {
        throw new HttpsError('invalid-argument', 'BAD_PERMISSION_BITS');
      }
      bits = permissionBits as number;
    }
    // 매니저에게는 비트가 없다. 승인 권한 하나뿐이다(스펙 §9.4).
    const grantCanApprove = role === 'manager' && canApprove === true;

    // 호출자는 언제나 세션 클레임에서 나온다. 요청 본문의 주소는 읽지 않는다.
    const caller = await resolveCallerAccount(request);
    const contracts = deployment();
    const pc = publicClient();

    if (role === 'admin') {
      // 체인이 돌려주는 주소는 체크섬이 지켜져 있지 않다. `lib/auth.ts` 가 세션 클레임에
      // 거는 것과 같은 정규화를 비교 전에 한 번 건다.
      const owner = getAddress(
        (await pc.readContract({
          address: contracts.organizers,
          abi: organizersAbi,
          functionName: 'ownerOf',
          args: [BigInt(orgId)],
        })) as string,
      );
      if (owner.toLowerCase() !== caller.toLowerCase()) {
        throw new HttpsError('permission-denied', 'NOT_ORG_OWNER');
      }
    } else {
      const allowed = (await pc.readContract({
        address: contracts.organizers,
        abi: organizersAbi,
        functionName: 'hasPermission',
        args: [BigInt(orgId), caller, PERM_MANAGE_MANAGERS],
      })) as boolean;
      if (!allowed) throw new HttpsError('permission-denied', 'NOT_ALLOWED_TO_INVITE');
    }

    const inviteId = randomUUID();
    const inviteRef = db.collection(INVITES).doc(inviteId);
    const phoneHmac = hmacPhone(phoneE164, PHONE_INDEX_KEY.value());

    await db.runTransaction(async (tx) => {
      // 읽고 나서 쓴다. 같은 id 위에 덮어쓰는 경로를 아예 만들지 않는다.
      if ((await tx.get(inviteRef)).exists) throw new HttpsError('aborted', 'INVITE_ID_TAKEN');
      tx.set(inviteRef, {
        orgId,
        role,
        phoneHmac,
        permissionBits: bits,
        canApprove: grantCanApprove,
        status: 'sent',
        createdBy: caller,
        createdAt: FieldValue.serverTimestamp(),
        expiresAt: Timestamp.fromMillis(Date.now() + INVITE_TTL_MS),
      });
    });

    // 링크에는 초대 id 말고 아무것도 없다. 번호도 조직 정보도 들어가지 않는다.
    return { inviteId, link: `https://${RP_ID.value()}/org/invite/${inviteId}` };
  },
);

/**
 * 초대를 받는다. **서버는 권한을 체인에 쓰지 않는다.**
 * `Organizers.setAdmin` 은 오너만, `setManager` 는 `PERM_MANAGE_MANAGERS` 를 가진 사람만
 * 보낼 수 있고 어테스터는 둘 다 아니다. 그래서 여기서는 그 계정이 웹에서 서명해 보낼
 * **calldata** 만 만들어 준다.
 *
 * 묶는 방법: 초대장의 `phoneHmac` 과 호출자의 `users/{uid}.phoneHmac`(Task 20 `startSignup`
 * 이 써 둔 값)이 같아야 한다. 역할이 붙는 주소는 세션 클레임의 계정이고 요청 본문이 아니다.
 * 한 번 수락되면 그 계정 말고는 아무도 못 쓴다. 같은 계정이 다시 부르면 역할이 체인에
 * 올라갈 때까지 같은 calldata 를 그대로 돌려준다(멱등).
 */
export const acceptInvite = onCall(
  { secrets: [PHONE_INDEX_KEY] },
  async (request): Promise<InviteCalldata> => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError('unauthenticated', 'AUTH_REQUIRED');
    const { inviteId } = (request.data ?? {}) as { inviteId?: string };
    if (typeof inviteId !== 'string' || !INVITE_ID_RE.test(inviteId)) {
      throw new HttpsError('invalid-argument', 'BAD_INVITE_ID');
    }

    const account = await resolveCallerAccount(request);
    const inviteRef = db.collection(INVITES).doc(inviteId);
    const userRef = db.collection(USERS).doc(uid);

    const spec = await db.runTransaction(async (tx) => {
      // 읽기를 전부 먼저 한다. 아래 `tx.set` 뒤에는 실제 Firestore 가 읽기를 거부한다.
      const user = await tx.get(userRef);
      const invite = await tx.get(inviteRef);

      const phoneHmac = user.get('phoneHmac') as string | undefined;
      if (!phoneHmac) throw new HttpsError('failed-precondition', 'PHONE_INDEX_MISSING');
      if (!invite.exists) throw new HttpsError('not-found', 'INVITE_NOT_FOUND');
      if (invite.get('phoneHmac') !== phoneHmac) {
        throw new HttpsError('permission-denied', 'INVITE_NOT_FOR_YOU');
      }

      const acceptedBy = invite.get('acceptedBy') as Hex | undefined;
      const accepted = invite.get('status') === 'accepted';
      const mine = accepted && acceptedBy?.toLowerCase() === account.toLowerCase();
      if (accepted && !mine) throw new HttpsError('failed-precondition', 'INVITE_ALREADY_USED');
      if (!accepted && invite.get('status') !== 'sent') {
        throw new HttpsError('failed-precondition', 'INVITE_NOT_OPEN');
      }
      // 만료는 아직 안 받은 초대장에만 건다. 이미 내가 받은 초대장은 역할이 체인에 올라갈
      // 때까지 같은 calldata 를 다시 받을 수 있어야 한다.
      if (!mine) {
        const expiresAt = invite.get('expiresAt') as Timestamp | undefined;
        if (!expiresAt || expiresAt.toMillis() <= Date.now()) {
          throw new HttpsError('failed-precondition', 'INVITE_EXPIRED');
        }
      }

      const role = invite.get('role');
      if (role !== 'admin' && role !== 'manager') {
        throw new HttpsError('failed-precondition', 'BAD_ROLE');
      }
      const orgId = requireStoredOrgId(invite.get('orgId'));

      if (!mine) {
        tx.set(
          inviteRef,
          {
            status: 'accepted',
            acceptedBy: account,
            acceptedAt: FieldValue.serverTimestamp(),
          },
          { merge: true },
        );
      }

      return {
        orgId,
        role: role as Role,
        permissionBits: (invite.get('permissionBits') as number | undefined) ?? 0,
        canApprove: invite.get('canApprove') === true,
      };
    });

    const data =
      spec.role === 'admin'
        ? encodeFunctionData({
            abi: organizersAbi,
            functionName: 'setAdmin',
            args: [BigInt(spec.orgId), account, spec.permissionBits],
          })
        : encodeFunctionData({
            abi: organizersAbi,
            functionName: 'setManager',
            args: [BigInt(spec.orgId), account, true, spec.canApprove],
          });

    // 보낼 수 있는 계정은 **지금의 오너**다. 초대를 만든 사람(관리자일 수 있다)이 아니고,
    // 초대장에 박아 둔 값도 아니다 — 오너가 바뀌면 답도 따라 바뀌어야 한다.
    const contracts = deployment();
    const requiredSender = getAddress(
      (await publicClient().readContract({
        address: contracts.organizers,
        abi: organizersAbi,
        functionName: 'ownerOf',
        args: [BigInt(spec.orgId)],
      })) as string,
    );

    // 초대장의 나머지(누가 만들었는지, 번호 색인, 조직의 다른 사람)는 나가지 않는다.
    return { to: contracts.organizers, data, orgId: spec.orgId, role: spec.role, requiredSender };
  },
);

/**
 * 초대를 거둔다. **오너만** 할 수 있다 — 초대는 만들 수 있는 사람이 여럿이어도
 * (관리자도 매니저 초대를 만든다) 거두는 것은 조직을 대표하는 한 사람의 결정이다.
 *
 * `sent` 든 `accepted` 든 `revoked` 로 간다. 수락된 초대까지 거둘 수 있어야 하는 이유는,
 * 수락은 calldata 를 받아 간 것일 뿐 역할이 체인에 올라간 것이 아니기 때문이다.
 * 이미 나간 calldata 는 어차피 **오너가 직접 보내야** 실행된다 — 거둔 초대를 오너가
 * 실수로 보내는 일만 조심하면 된다. 두 번 불러도 같은 답을 주고 첫 기록을 덮지 않는다.
 */
export const revokeInvite = onCall(async (request): Promise<{ status: 'revoked' }> => {
  const caller = await resolveCallerAccount(request);
  const { inviteId } = (request.data ?? {}) as { inviteId?: string };
  if (typeof inviteId !== 'string' || !INVITE_ID_RE.test(inviteId)) {
    throw new HttpsError('invalid-argument', 'BAD_INVITE_ID');
  }

  const inviteRef = db.collection(INVITES).doc(inviteId);
  const invite = await inviteRef.get();
  if (!invite.exists) throw new HttpsError('not-found', 'INVITE_NOT_FOUND');

  const orgId = requireStoredOrgId(invite.get('orgId'));
  const owner = getAddress(
    (await publicClient().readContract({
      address: deployment().organizers,
      abi: organizersAbi,
      functionName: 'ownerOf',
      args: [BigInt(orgId)],
    })) as string,
  );
  if (owner.toLowerCase() !== caller.toLowerCase()) {
    throw new HttpsError('permission-denied', 'NOT_ORG_OWNER');
  }

  const status = invite.get('status');
  if (status === 'revoked') return { status: 'revoked' };
  if (status !== 'sent' && status !== 'accepted') {
    throw new HttpsError('failed-precondition', 'INVITE_NOT_OPEN');
  }

  await inviteRef.set(
    { status: 'revoked', revokedBy: caller, revokedAt: FieldValue.serverTimestamp() },
    { merge: true },
  );
  return { status: 'revoked' };
});

/**
 * 주최자 팀 화면의 초대 목록.
 *
 * 초대는 세션을 넘겨 살아 있는데 `createInvite` 는 만든 그 순간의 링크만 돌려준다 —
 * 화면을 새로 열면 보낸 초대가 어디에도 없다. 이 콜러블이 그 목록이다.
 *
 * 인가는 조직 **오너** 또는 `PERM_MANAGE_MANAGERS` 를 가진 **관리자**다. 초대를 만들 수 있는
 * 사람이 자기가 만든 초대를 볼 수 있어야 하므로 `createInvite` 의 매니저 갈래와 같은 판정이다.
 */
export const listInvites = onCall(async (request): Promise<{ invites: InviteRow[] }> => {
  // 인증이 먼저다. 로그인하지 않은 호출자는 인자가 어떻게 생겼는지도 배우지 못한다.
  const caller = await resolveCallerAccount(request);
  const { orgId } = (request.data ?? {}) as { orgId?: unknown };
  if (typeof orgId !== 'string' || !ORG_ID_RE.test(orgId)) {
    throw new HttpsError('invalid-argument', 'BAD_ORG_ID');
  }

  const contracts = deployment();
  const pc = publicClient();
  // 두 질문을 각각 던진다. 오너에게 모든 비트를 주는 것은 컨트랙트의 약속이지만,
  // 그 약속 하나에 인가를 걸어 두면 컨트랙트가 바뀌는 날 오너가 자기 조직에서 잠긴다.
  const [ownerRead, allowed] = await Promise.all([
    pc.readContract({
      address: contracts.organizers,
      abi: organizersAbi,
      functionName: 'ownerOf',
      args: [BigInt(orgId)],
    }) as Promise<string>,
    pc.readContract({
      address: contracts.organizers,
      abi: organizersAbi,
      functionName: 'hasPermission',
      args: [BigInt(orgId), caller, PERM_MANAGE_MANAGERS],
    }) as Promise<boolean>,
  ]);
  const owner = getAddress(ownerRead);
  if (owner.toLowerCase() !== caller.toLowerCase() && !allowed) {
    throw new HttpsError('permission-denied', 'NOT_ALLOWED_TO_INVITE');
  }

  // 등식 하나뿐이다. 여기에 다른 칸 정렬을 붙이면 복합 색인이 하나 더 필요해지는데,
  // 한 조직의 초대는 상한 안에 들어오므로 메모리에서 세우는 편이 싸다.
  const page = await db.collection(INVITES).where('orgId', '==', orgId).limit(INVITE_PAGE_SIZE).get();

  const invites = page.docs.map((doc) => {
    const status = doc.get('status') as string;
    const row: InviteRow = {
      inviteId: doc.id,
      role: doc.get('role') as Role,
      status,
      createdAt: epochSeconds(doc.get('createdAt')),
      expiresAt: epochSeconds(doc.get('expiresAt')),
    };
    // `accepted` 만이 "calldata 는 나갔는데 아직 체인에 올라가지 않은" 상태다. 그 줄에만
    // 보낼 사람을 달아 준다 — 값은 인가에 이미 쓴 `ownerOf` 그대로다(초대장에 박힌 값이 아니다).
    if (status === 'accepted') row.requiredSender = owner;
    return row;
  });
  // 최신 것이 맨 위다.
  invites.sort((a, b) => b.createdAt - a.createdAt);
  return { invites };
});
