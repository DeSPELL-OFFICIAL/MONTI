import { parseAbi } from 'viem';

/**
 * 릴레이 콜러블(C2: relayClaim/relayCheckIn)이 쓰는 **최소** Ticket ABI.
 *
 * 리디플로이(A4)가 아직 생성된 ABI JSON 을 내보내지 않아, 권위 소스인 Solidity 시그니처
 * (`MONTI-01b` `eee7660:contracts/src/Ticket.sol`)에서 **이 콜러블이 실제로 부르는 항목만**
 * 손으로 짠다. 함수·이벤트·에러의 이름과 시그니처는 컨트랙트와 글자 그대로 같다.
 *
 * **B2 가 생성된 ABI(`@monti/shared` 의 `ticketAbi`)로 교체한다.** 그때 이 파일을 지우고
 * `relay.ts`·`ticketAbi.ts` 를 참조하는 곳의 import 만 `@monti/shared` 로 바꾸면 된다 —
 * 시그니처가 동일하므로 인코딩/디코딩/시뮬레이션 동작은 바뀌지 않는다.
 *
 * 에러 항목은 시뮬레이션 revert 를 사람이 읽을 코드로 옮기는 **디코딩 키**다(설계 §5). viem 이
 * revert 데이터의 4바이트 셀렉터를 이 목록과 대조해 `errorName` 을 돌려주고, `relay.ts` 가 그
 * 이름을 `details.code` 로 매핑한다. 이름이 곧 ABI 이므로 컨트랙트가 에러를 개명하면 매핑이
 * 조용히 빗나가는 대신 여기(그리고 매핑 표)를 함께 고쳐야 한다.
 */
export const ticketRelayAbi = parseAbi([
  // --- 구조체 (릴레이 발급 승인서 · 게이트 코드) ---
  'struct ClaimAuth { uint256 eventId; uint8 tier; address account; uint256 nonce; uint64 deadline; }',
  'struct GateCode { uint256 gateId; uint256 eventId; uint64 issuedAt; bytes32 nonce; }',

  // --- 읽기 (가스 쓰기 전 검증) ---
  'function claimNonce(uint256 eventId, address account) view returns (uint256)',
  'function usedAt(uint256 tokenId) view returns (uint32)',
  'function eventOf(uint256 tokenId) pure returns (uint256)',
  'function tierOf(uint256 tokenId) pure returns (uint8)',

  // --- 릴레이 제출 (릴레이어 EOA 가 일반 tx 로 보낸다) ---
  'function claimFor(ClaimAuth a, bytes deviceSig) returns (uint256 tokenId)',
  'function requestClaimFor(ClaimAuth a, bytes deviceSig) returns (uint256 requestId)',
  'function checkInFor(uint256 tokenId, GateCode g, bytes gateSig, bytes deviceSig)',
  'function checkInForLate(uint256 tokenId, GateCode g, bytes gateSig, bytes deviceSig)',

  // --- 확정 영수증에서 tokenId/requestId/usedAt 을 뽑는 이벤트 ---
  'event Claimed(uint256 indexed tokenId, uint256 indexed eventId, address indexed to, uint8 tier)',
  'event ClaimRequested(uint256 indexed eventId, uint256 indexed requestId, address indexed requester, uint8 tier)',
  'event CheckedIn(uint256 indexed tokenId, uint256 indexed eventId, uint256 indexed gateId, bytes32 nonceHash, uint64 ts)',
  'event CheckedInLate(uint256 indexed tokenId, uint256 indexed gateId, uint64 issuedAt, uint64 ts)',

  // --- 시뮬레이션 revert 디코딩용 커스텀 에러 (이름 = details.code 매핑 키) ---
  'error AuthExpired()',
  'error BadNonce()',
  'error NotMember()',
  'error DeviceLocked()',
  'error BadDeviceSignature()',
  'error BadGateSignature()',
  'error ApprovalRequired()',
  'error ApprovalNotRequired()',
  'error KycRequired()',
  'error SaleClosed()',
  'error SoldOut()',
  'error MaxPerWalletExceeded()',
  'error PaidTiersNotEnabled()',
  'error UnknownTier()',
  'error UnknownEvent()',
  'error EventNotPublished()',
  'error EventEnded()',
  'error EventCancelled()',
  'error NoSuchTicket()',
  'error WrongEvent()',
  'error TicketRevoked()',
  'error GateNotOpen()',
  'error GateMismatch()',
  'error CodeExpired()',
  'error AlreadyCheckedIn()',
  'error Unauthorized()',
]);
