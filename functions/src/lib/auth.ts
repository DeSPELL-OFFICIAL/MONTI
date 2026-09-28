import { HttpsError, type CallableRequest } from 'firebase-functions/v2/https';
import { getAddress } from 'viem';
import { organizersAbi, ticketAbi, type Hex } from '@monti/shared';
import { deployment, publicClient } from './chain.js';
import { PERSONS, USERS, db } from './db.js';

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * 호출자의 스마트 계정 주소.
 * 1순위: `loginVerify`가 커스텀 토큰에 넣어 준 `account` 클레임.
 * 2순위: users/{uid} → persons/{personId}.account.
 * 어느 경로로 왔든 EIP-55 체크섬 형태로 통일해서 돌려준다.
 */
export async function resolveCallerAccount(request: CallableRequest): Promise<Hex> {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'AUTH_REQUIRED');

  const claim = request.auth?.token?.account;
  if (typeof claim === 'string' && ADDRESS_RE.test(claim)) return getAddress(claim);

  const user = await db.collection(USERS).doc(uid).get();
  const personId = user.get('personId') as string | undefined;
  if (!personId) throw new HttpsError('failed-precondition', 'NO_PERSON');

  const person = await db.collection(PERSONS).doc(personId).get();
  const account = person.get('account') as string | undefined;
  if (!account || !ADDRESS_RE.test(account)) throw new HttpsError('failed-precondition', 'NO_ACCOUNT');
  return getAddress(account);
}

/** `Organizers.sol` 의 권한 비트. 값은 컨트랙트가 진실이다(contracts/src/Organizers.sol). */
export const PERM_CREATE_EVENT = 1;
export const PERM_MANAGE_GATES = 2;
export const PERM_APPROVE_OVERRIDE = 4;
export const PERM_MANAGE_MANAGERS = 8;

/**
 * 이 사람이 이 공연의 티켓을 들고 있는가. **체인에 직접 묻는다** — 인덱서는 인가에 쓰지 않는다.
 * 인덱싱이 밀리는 동안 잔고가 뒤처지면 그대로 인가 구멍이 된다.
 *
 * 매번 묻기 때문에 **양도하면 다음 호출부터 바로 막힌다.** 거울 문서(`eventChats/members`)로는
 * 그렇게 되지 않는다 — 거울은 양도 뒤 낡고, 그것을 갱신해 줄 "입장" 순간이 공연 페이지에는 없다.
 */
export async function holdsEventTicket(eventId: bigint, account: Hex): Promise<boolean> {
  const balance = (await publicClient().readContract({
    address: deployment().ticket,
    abi: ticketAbi,
    functionName: 'balanceOfEvent',
    args: [account, eventId],
  })) as bigint;
  return balance > 0n;
}

/**
 * 이 사람이 이 공연의 주최자인가. 공연 주최 조직의 **오너**이거나 `PERM_CREATE_EVENT` 비트를
 * 가진 **관리자**면 참이다(`pinMessage.requireOrganizerAdmin` 과 같은 판정).
 *
 * **던지지 않는 쪽이 원본이다.** 주최자가 아닌 것과 체인을 읽지 못한 것은 다른 일이라,
 * RPC 실패를 `permission-denied` 로 바꿔 삼키는 호출부가 생기지 않게 참·거짓으로 돌려준다.
 */
export async function isEventOrganizer(eventId: bigint, caller: Hex): Promise<boolean> {
  const pc = publicClient();
  const contracts = deployment();

  const orgId = (await pc.readContract({
    address: contracts.ticket,
    abi: ticketAbi,
    functionName: 'eventOrg',
    args: [eventId],
  })) as bigint;

  // 두 질문을 각각 던진다. 오너에게 모든 비트를 주는 것은 컨트랙트의 약속이지만,
  // 그 약속 하나에 인가를 걸어 두면 컨트랙트가 바뀌는 날 오너가 자기 공연에서 잠긴다.
  const [owner, canCreateEvent] = await Promise.all([
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
      args: [orgId, caller, PERM_CREATE_EVENT],
    }) as Promise<boolean>,
  ]);

  // 체인 읽기가 돌려주는 주소는 체크섬이 지켜져 있지 않다. 비교 전에 한 번만 정규화한다.
  return getAddress(owner).toLowerCase() === caller.toLowerCase() || canCreateEvent;
}

/** 주최자가 아니면 거절한다. 판정 자체는 `isEventOrganizer` 하나다. */
export async function requireEventOrganizer(eventId: bigint, caller: Hex): Promise<void> {
  if (!(await isEventOrganizer(eventId, caller))) {
    throw new HttpsError('permission-denied', 'NOT_ORGANIZER');
  }
}

/** `Organizers.gateInfo` 의 반환 튜플. ABI 가 JSON import 라 리터럴 타입이 없어 여기서 붙인다. */
type GateInfo = readonly [bigint, Hex, Hex, Hex, boolean, boolean];

/**
 * `issueSnapshot` / `getPhotoForGate` 의 인가.
 *
 * **게이트 단말기 계정은 Firebase에 로그인하지 않는다.** 게이트 계정의 소유자 키는
 * 안드로이드 하드웨어 P-256 키라서 패스키 로그인을 할 수 없다. 호출자는 언제나
 * **스태프 본인의 Firebase 세션**(패스키 스마트 계정 = `persons.account`)이고,
 * 어느 게이트를 위한 요청인지는 `gateAccount` 인자로 온다.
 *
 * 두 조건을 모두 만족해야 한다.
 *  (a) 호출자가 그 공연 주최자의 **오너**이거나 **매니저**이거나, `PERM_MANAGE_GATES`
 *      또는 `PERM_APPROVE_OVERRIDE` 권한을 가진 **관리자**다.
 *  (b) `gateAccount` 가 그 공연의 **열린 게이트**이거나, 아직 열기 전이라도
 *      등록돼 있고 폐기되지 않은 같은 공연의 게이트다(사전 스냅샷 내려받기).
 *
 * 판정은 전부 eth_call 이다. 우리 DB에는 역할이 없다(스펙 §9.4).
 */
export async function requireStaffForGate(
  eventId: bigint,
  callerAccount: Hex,
  gateAccount: Hex,
): Promise<void> {
  const pc = publicClient();
  const contracts = deployment();

  const orgId = (await pc.readContract({
    address: contracts.ticket,
    abi: ticketAbi,
    functionName: 'eventOrg',
    args: [eventId],
  })) as bigint;

  // 두 권한 비트를 각각 물어보고 OR 한다. 한 번에 마스크(2|4)를 넘기면
  // sub-plan 01 의 hasPermission 이 "모두" 로 구현됐을 때 조용히 거부된다.
  const [owner, manager, canManageGates, canApproveOverride] = await Promise.all([
    pc.readContract({
      address: contracts.organizers,
      abi: organizersAbi,
      functionName: 'ownerOf',
      args: [orgId],
    }) as Promise<Hex>,
    pc.readContract({
      address: contracts.organizers,
      abi: organizersAbi,
      functionName: 'managerOf',
      args: [orgId, callerAccount],
    }) as Promise<readonly [boolean, boolean]>,
    pc.readContract({
      address: contracts.organizers,
      abi: organizersAbi,
      functionName: 'hasPermission',
      args: [orgId, callerAccount, PERM_MANAGE_GATES],
    }) as Promise<boolean>,
    pc.readContract({
      address: contracts.organizers,
      abi: organizersAbi,
      functionName: 'hasPermission',
      args: [orgId, callerAccount, PERM_APPROVE_OVERRIDE],
    }) as Promise<boolean>,
  ]);
  const isOwner = owner.toLowerCase() === callerAccount.toLowerCase();
  if (!isOwner && !manager[0] && !canManageGates && !canApproveOverride) {
    throw new HttpsError('permission-denied', 'NOT_EVENT_STAFF');
  }

  const openGate = (await pc.readContract({
    address: contracts.organizers,
    abi: organizersAbi,
    functionName: 'isOpenGate',
    args: [eventId, gateAccount],
  })) as boolean;
  if (openGate) return;

  // 공연 시작 전 스냅샷 내려받기: 등록돼 있고 폐기되지 않은 같은 공연의 게이트면 통과.
  const gateId = (await pc.readContract({
    address: contracts.organizers,
    abi: organizersAbi,
    functionName: 'gateOf',
    args: [gateAccount],
  })) as bigint;
  if (gateId === 0n) throw new HttpsError('permission-denied', 'GATE_NOT_REGISTERED');

  const info = (await pc.readContract({
    address: contracts.organizers,
    abi: organizersAbi,
    functionName: 'gateInfo',
    args: [gateId],
  })) as GateInfo;
  const [gateEventId, , , , , revoked] = info;
  if (revoked) throw new HttpsError('permission-denied', 'GATE_REVOKED');
  if (gateEventId !== eventId) throw new HttpsError('permission-denied', 'GATE_WRONG_EVENT');
}
