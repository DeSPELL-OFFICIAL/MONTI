import { getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import type { PersonStatus } from '@monti/shared';

if (getApps().length === 0) initializeApp();

export const db = getFirestore();
export const authAdmin = getAuth();

export const PERSONS = 'persons';
export const USERS = 'users';
export const PASSKEYS = 'passkeys';
export const DEVICES = 'devices';
export const INVITES = 'invites';
export const KYC_SESSIONS = 'kycSessions';
/**
 * Didit 웹훅의 `event_id` 도장. 문서가 이미 있으면 그 배달은 재배달이다(first-wins).
 * 서버 전용이고, `expireAt`(Timestamp) 에 Firestore TTL 정책을 걸어 7일 뒤 스스로 지워진다 —
 * 이 컬렉션은 **읽을 일이 없고** 무한히 자라면 안 되는 중복 방지 장부일 뿐이다.
 */
export const DIDIT_EVENTS = 'diditEvents';
export const AUTH_CHALLENGES = 'authChallenges';
export const PHONE_INDEX = 'phoneIndex';
export const TRANSFER_INVITES = 'transferInvites';
export const EVENT_CHATS = 'eventChats';
export const DELETION_REQUESTS = 'deletionRequests';
export const PENDING_GATES = 'pendingGates';
/**
 * 주최사의 **표시 이름**. 체인에는 이름이 없다 — `Organizers` 가 아는 것은 `orgId` 와 오너·권한
 * 비트뿐이라(스펙 §9.4) 화면에 그릴 이름은 어딘가 오프체인에 있어야 한다. 문서 id 는 체인이 정한
 * `orgId`(십진 문자열)이고, 권한·소유권의 원본은 여기가 아니라 그대로 체인이다.
 * 누구나 읽고(`firestore.rules`), 쓰는 길은 서버의 `createOrganizerForMe` 하나다.
 */
export const ORG_PROFILES = 'orgProfiles';
/**
 * 공연의 **티켓 그림**. 문서 id 는 `eventId`(십진 문자열)이고 값은
 * `{ tiers: [{ preset } | { imageCid }], updatedAt }` 다. 체인의 `Tier` 에 그림 칸이 없고
 * (`Ticket.sol:40-47`) IPFS JSON 은 공개 뒤 고칠 수 없으므로, "나중에 수정 가능"을 지키는
 * 자리가 여기 하나다. 로그인한 사람이면 누구나 읽고(`firestore.rules`), 쓰는 길은
 * 서버의 `saveEventArt` 하나다 — `orgProfiles` 와 같은 모양이다.
 */
export const EVENT_ART = 'eventArt';
/**
 * 공연의 **비공개 장소**. 문서 id 는 체인이 정한 `eventId`(십진 문자열)이고 값은
 * `{ venue?, note? }` 다. 공개 IPFS JSON 에서는 `venue` 키가 통째로 빠지고(계획 B-1)
 * 진짜 값은 여기에만 있다. **서버 전용이다** — 규칙 파일은 체인을 읽을 수 없어
 * "티켓을 들고 있는가"를 판정할 수 없고, 그 판정은 `getEventPrivate` 이 eth_call 로 한다.
 */
export const EVENT_PRIVATE = 'eventPrivate';
/**
 * 사람 한 명의 **하루 핀 횟수**. 문서 id 는 `personId` 이고 값은 `{ day, count }` 하나뿐이다.
 * `pinEventImage` 는 주최자 인가보다 앞에 있어(초안은 주최사를 만들기 전에 쓴다) 로그인한
 * 아무나 부를 수 있다 — 이 장부가 우리 Pinata 저장 공간의 유일한 문지기다.
 * 서버 전용이고, 클라이언트는 규칙의 포괄 거부로 닿지 못한다.
 */
export const PIN_QUOTA = 'pinQuota';
/**
 * 사람 한 명의 **하루 복구 횟수**. 문서 id 는 `personId` 이고 값은 `{ day, count }` 하나뿐이다.
 * `recoverAccess` 가 비싼 검증·회전 전송 앞에서 소비해 실패한 시도까지 세므로, 어테스터로
 * 나가는 회전을 사람당 하루 세 번으로 묶는다(SIM 스왑 재시도 방어). 서버 전용이고, 클라이언트는
 * 규칙의 포괄 거부로 닿지 못한다.
 */
export const RECOVERY_QUOTA = 'recoveryQuota';
/** 서버 내부 상태만 들어간다. 클라이언트는 규칙의 포괄 거부로 닿지 못한다(어테스터 리스). */
export const SYSTEM = 'system';

/**
 * Functions가 쓸 수 있는 컬렉션의 전부. 스펙 §10.4 규칙 1에 따라
 * 티켓 상태·권한·입장 기록 컬렉션은 여기에 없고, Task 31이 소스를 스캔해 강제한다.
 */
export const ALLOWED_COLLECTIONS = [
  PERSONS,
  USERS,
  PASSKEYS,
  DEVICES,
  INVITES,
  KYC_SESSIONS,
  DIDIT_EVENTS,
  AUTH_CHALLENGES,
  PHONE_INDEX,
  TRANSFER_INVITES,
  EVENT_CHATS,
  DELETION_REQUESTS,
  PENDING_GATES,
  EVENT_ART,
  EVENT_PRIVATE,
  ORG_PROFILES,
  PIN_QUOTA,
  RECOVERY_QUOTA,
  SYSTEM,
  'members',
  'messages',
] as const;

/**
 * 마스터 계획의 유니온을 그대로 쓰되, 각 값의 뜻을 사전 스캔 7번 판정대로 고정한다.
 *  - `pending`  가입 시작. 아직 체인에 계정이 등록되지 않았다.
 *  - `active`   `Identity.register` 가 finalized 됐다. **`kycLevel` 과 무관하다.**
 *  - `kyc_ok`   Didit 이 승인했지만 `setKycLevel(1)` 이 아직 finalized 되지 않은 중간 상태.
 *  - `rejected` Didit 이 거절했거나 같은 얼굴이 이미 있다.
 *  - `rotated`  계정이 새 계정으로 교체됐다.
 *  - `deleted`  파기 요청이 끝났다. 문서는 남지만 개인정보는 없다 — 체인이 이 personId 를
 *               가리키고 있어서 지울 수 없다(스펙 §10.2). **어느 상태에서든 갈 수 있고,
 *               돌아오는 길은 없다.**
 * 본인인증 통과 여부의 **원본은 `kycLevel`(0/1)** 이고 status 는 진행 단계 표시다.
 */
export const ALLOWED_TRANSITIONS: Record<PersonStatus, PersonStatus[]> = {
  pending: ['pending', 'active', 'rejected', 'deleted'],
  active: ['active', 'kyc_ok', 'rejected', 'rotated', 'deleted'],
  kyc_ok: ['kyc_ok', 'active', 'rejected', 'deleted'],
  rejected: ['rejected', 'kyc_ok', 'active', 'deleted'],
  rotated: ['rotated', 'deleted'],
  deleted: ['deleted'],
};

/** 뒤로 가거나 죽은 상태를 되살리는 전이만 막는다. */
export function assertStatusTransition(from: PersonStatus, to: PersonStatus): void {
  if (!ALLOWED_TRANSITIONS[from]?.includes(to)) {
    throw new Error(`BAD_STATUS_TRANSITION:${from}->${to}`);
  }
}
