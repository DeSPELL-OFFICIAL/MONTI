import { getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import type { PersonStatus } from '@monti/shared';

if (getApps().length === 0) initializeApp();

export const db = getFirestore();
export const authAdmin = getAuth();
export const storage = getStorage();

export const PERSONS = 'persons';
export const USERS = 'users';
export const PASSKEYS = 'passkeys';
export const DEVICES = 'devices';
export const INVITES = 'invites';
export const KYC_SESSIONS = 'kycSessions';
export const AUTH_CHALLENGES = 'authChallenges';
export const PHONE_INDEX = 'phoneIndex';
export const TRANSFER_INVITES = 'transferInvites';
export const EVENT_CHATS = 'eventChats';
export const DELETION_REQUESTS = 'deletionRequests';
export const PENDING_GATES = 'pendingGates';
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
  AUTH_CHALLENGES,
  PHONE_INDEX,
  TRANSFER_INVITES,
  EVENT_CHATS,
  DELETION_REQUESTS,
  PENDING_GATES,
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
 * 본인인증 통과 여부의 **원본은 `kycLevel`(0/1)** 이고 status 는 진행 단계 표시다.
 */
export const ALLOWED_TRANSITIONS: Record<PersonStatus, PersonStatus[]> = {
  pending: ['pending', 'active', 'rejected'],
  active: ['active', 'kyc_ok', 'rejected', 'rotated'],
  kyc_ok: ['kyc_ok', 'active', 'rejected'],
  rejected: ['rejected', 'kyc_ok', 'active'],
  rotated: ['rotated'],
};

/** 뒤로 가거나 죽은 상태를 되살리는 전이만 막는다. */
export function assertStatusTransition(from: PersonStatus, to: PersonStatus): void {
  if (!ALLOWED_TRANSITIONS[from]?.includes(to)) {
    throw new Error(`BAD_STATUS_TRANSITION:${from}->${to}`);
  }
}
