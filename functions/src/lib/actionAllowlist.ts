import { toFunctionSelector, type Hex } from 'viem';

/** Forwarder 대상 컨트랙트. 서버 allowlist 는 온체인 `to` allowlist 를 미러한다(설계 §7). */
export type ActionTarget = 'ticket' | 'organizers' | 'identity';

export interface ActionEntry {
  /** 이 kind 가 부를 수 있는 유일한 대상 컨트랙트. `to` 는 이 대상의 배포 주소여야 한다. */
  target: ActionTarget;
  /** 사람이 읽는 정규 시그니처(설계 §2, 배포 ABI에서 추출). selector 의 원본이다. */
  signature: string;
  /** `data` 앞 4바이트와 대조하는 함수 selector(소문자 0x…8). */
  selector: Hex;
}

/**
 * relayAction 이 대납할 수 있는 동작 **전수**(설계 §2 표의 23개 + createOrganizer).
 * 키(kind)는 웹/문서용 라벨이고, 값은 그 kind 가 부를 수 있는 유일한 (대상, selector) 다.
 * selector 는 viem `toFunctionSelector` 로 정규 시그니처에서 계산한다 — 이 표 밖 selector 의
 * calldata 대납을 막아 릴레이어를 "임의 컨트랙트 호출"로 쓰지 못하게 한다(설계 §4·§7).
 *
 * **여기 없는 것(의도적):** Phase 1 발급/입장(claimFor·requestClaimFor·checkInFor·checkInForLate)
 * 은 relayClaim/relayCheckIn 이 따로 대납하고, ERC-4337·페이마스터 경로는 폐기된다(설계 §3).
 */
const SIGNATURES: Record<string, { target: ActionTarget; signature: string }> = {
  // ── Ticket ──────────────────────────────────────────────────────────────
  createEvent: {
    target: 'ticket',
    signature:
      'function createEvent((uint256,bytes32,bytes32,string,uint64,uint64,bytes32,uint64,uint64,bool,uint32,uint8,bool,uint8,bytes32,bool),(string,uint256,uint32,uint32,uint16,bool)[])',
  },
  publishEvent: { target: 'ticket', signature: 'function publishEvent(uint256)' },
  cancelEvent: { target: 'ticket', signature: 'function cancelEvent(uint256)' },
  updateEventMeta: {
    target: 'ticket',
    signature:
      'function updateEventMeta(uint256,(uint256,bytes32,bytes32,string,uint64,uint64,bytes32,uint64,uint64,bool,uint32,uint8,bool,uint8,bytes32,bool),(string,uint256,uint32,uint32,uint16,bool)[])',
  },
  approveClaims: { target: 'ticket', signature: 'function approveClaims(uint256,uint256[])' },
  rejectClaims: { target: 'ticket', signature: 'function rejectClaims(uint256,uint256[])' },
  revoke: { target: 'ticket', signature: 'function revoke(uint256,uint8)' },
  manualOverride: { target: 'ticket', signature: 'function manualOverride(uint256,uint256,uint8)' },
  createOffer: { target: 'ticket', signature: 'function createOffer(uint256,bytes32,uint64)' },
  cancelOffer: { target: 'ticket', signature: 'function cancelOffer(uint256)' },
  acceptOffer: { target: 'ticket', signature: 'function acceptOffer(uint256,bytes)' },
  // ERC-721 3-인자 오버로드만 허용한다(양도, 설계 §2 #13). 4-인자 오버로드는 표에 없다.
  safeTransferFrom: { target: 'ticket', signature: 'function safeTransferFrom(address,address,uint256)' },
  cancelRequest: { target: 'ticket', signature: 'function cancelRequest(uint256,uint256)' },
  migrate: { target: 'ticket', signature: 'function migrate(uint256)' },
  // ── Organizers ──────────────────────────────────────────────────────────
  registerGate: { target: 'organizers', signature: 'function registerGate(uint256,address,bytes32,bytes32)' },
  openGate: { target: 'organizers', signature: 'function openGate(uint256)' },
  closeGate: { target: 'organizers', signature: 'function closeGate(uint256)' },
  revokeGate: { target: 'organizers', signature: 'function revokeGate(uint256)' },
  setAdmin: { target: 'organizers', signature: 'function setAdmin(uint256,address,uint32)' },
  setManager: { target: 'organizers', signature: 'function setManager(uint256,address,bool,bool)' },
  createOrganizer: { target: 'organizers', signature: 'function createOrganizer(address)' },
  // ── Identity ────────────────────────────────────────────────────────────
  setNickname: { target: 'identity', signature: 'function setNickname(bytes32,string)' },
  cancelRotation: { target: 'identity', signature: 'function cancelRotation()' },
};

/** kind → { target, signature, selector }. selector 는 로드 시점에 한 번 계산한다. */
export const ACTION_ALLOWLIST: Record<string, ActionEntry> = Object.fromEntries(
  Object.entries(SIGNATURES).map(([kind, { target, signature }]) => [
    kind,
    { target, signature, selector: toFunctionSelector(signature) },
  ]),
);

/** kind → 허용 항목. 표에 없으면 undefined(대납 거절). */
export function actionFor(kind: string): ActionEntry | undefined {
  return ACTION_ALLOWLIST[kind];
}
