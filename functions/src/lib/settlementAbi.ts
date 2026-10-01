import { encodeAbiParameters, keccak256, parseAbi, stringToHex, toHex, type Hex } from 'viem';

/**
 * SettlementVault 의 ABI(설계 2026-10-01 §3). **인터페이스에서 손으로 뽑은 parseAbi** 다 —
 * 컨트랙트(01b 워크트리의 `contracts/src/interfaces/ISettlementVault.sol`)가 아직 재배포 전이라
 * 생성 ABI(`packages/shared/src/abi/SettlementVault.json`)가 없다. B2 가 컴파일 산출물을 뽑아
 * 이 모듈을 그 생성 ABI 로 교체한다 — 그때까지 함수/이벤트/에러 시그니처는 인터페이스와 1:1 이다.
 */
export const settlementAbi = parseAbi([
  'struct Recipient { address account; uint16 bps; bytes32 reasonHash; bytes32 tag; }',
  'struct SplitPolicy { Recipient[] recipients; uint16 platformBps; uint16 reserveBps; bool noShowRefund; bool frozen; uint32 version; }',
  'struct PolicyAuth { address organizer; uint256 nonce; uint64 deadline; }',
  'function setPolicy(uint256 eventId, SplitPolicy policy, PolicyAuth auth, bytes deviceSig)',
  'function hashPolicy(SplitPolicy policy) pure returns (bytes32)',
  'function setPolicyDigest(uint256 eventId, bytes32 policyHash, uint256 nonce, uint64 deadline) view returns (bytes32)',
  'function getPolicy(uint256 eventId) view returns (SplitPolicy)',
  'function policyNonce(address organizer) view returns (uint256)',
  'function escrowOf(uint256 tokenId) view returns (address token, uint128 amount, address payer, uint64 depositedAt, uint8 status)',
  'function deposit(uint256 eventId, uint256 tokenId, address token, uint128 amount)',
  'function release(uint256 tokenId)',
  'function releaseMany(uint256[] tokenIds)',
  'function settleNoShows(uint256 eventId, uint256[] tokenIds)',
  'function refund(uint256 tokenId)',
  'function withdraw(address token)',
  'function setTokenAllowed(address token, bool allowed)',
  'function setDepositor(address account, bool allowed)',
  'function setPaused(bool paused)',
  'event PolicySet(uint256 indexed eventId, address indexed organizer, bytes32 policyHash, uint32 version)',
  'event Deposited(uint256 indexed eventId, uint256 indexed tokenId, address token, uint128 amount, address payer)',
  'event Released(uint256 indexed eventId, uint256 indexed tokenId, address token, uint256 amount)',
  'event NoShowSettled(uint256 indexed eventId, uint256 indexed tokenId, address token, uint256 amount)',
  'event Refunded(uint256 indexed eventId, uint256 indexed tokenId, address token, uint256 amount, address payer)',
  'event Paid(uint256 indexed eventId, uint256 indexed tokenId, address indexed recipient, uint256 amount, bytes32 reasonHash)',
  'event PayoutDeferred(uint256 indexed eventId, uint256 indexed tokenId, address indexed recipient, address token, uint256 amount)',
  'event Withdrawn(address indexed recipient, address indexed token, uint256 amount)',
  'event TokenAllowed(address indexed token, bool allowed)',
  'event DepositorSet(address indexed account, bool allowed)',
  'event PausedSet(bool paused)',
  'error NotOwner()',
  'error NotDepositor()',
  'error NotPolicyAuthorizer()',
  'error Paused()',
  'error UnknownEvent()',
  'error EventMismatch()',
  'error TokenNotAllowed()',
  'error ZeroAmount()',
  'error AlreadyDeposited()',
  'error NoPolicy()',
  'error PolicyFrozen()',
  'error AuthExpired()',
  'error BadNonce()',
  'error BadDeviceSignature()',
  'error InvalidRecipients()',
  'error ZeroRecipient()',
  'error ZeroBps()',
  'error BadSplitSum()',
  'error PlatformShareTooLow()',
  'error PlatformMirrorMismatch()',
  'error BadReserve()',
  'error NoEscrow()',
  'error NotCheckedIn()',
  'error AlreadySettled()',
  'error EventNotEnded()',
  'error EventEnded()',
  'error AlreadyCheckedIn()',
  'error NothingToRefund()',
  'error NothingToWithdraw()',
]);

/** 금고가 쓰는 escrow status 코드(ISettlementVault.Escrow.status). */
export const ESCROW_STATUS = { none: 0, held: 1, released: 2, refunded: 3 } as const;

/** 온체인에 올라가는 수취인 한 줄(해시·태그는 이미 bytes32 로 변환된 값). */
export interface OnChainRecipient {
  account: Hex;
  bps: number;
  reasonHash: Hex;
  tag: Hex;
}
/** `hashPolicy` 가 서명 대상으로 삼는 네 칸(frozen/version 은 수명 상태라 서명하지 않는다). */
export interface SignedPolicy {
  recipients: OnChainRecipient[];
  platformBps: number;
  reserveBps: number;
  noShowRefund: boolean;
}

const RECIPIENTS_TUPLE = {
  type: 'tuple[]',
  components: [
    { name: 'account', type: 'address' },
    { name: 'bps', type: 'uint16' },
    { name: 'reasonHash', type: 'bytes32' },
    { name: 'tag', type: 'bytes32' },
  ],
} as const;

/**
 * `SettlementVault.hashPolicy` 와 **바이트 단위로 같은** 해시를 오프체인에서 계산한다:
 * `keccak256(abi.encode(recipients, platformBps, reserveBps, noShowRefund))`. 서버는 금고의
 * `hashPolicy` view 로도 교차검증하지만, view 가 없거나(배포 전) 테스트에서도 이 함수로 해시 패리티를
 * 증명한다. `abi.encode(a,b,c,d)` 는 같은 순서의 파라미터 묶음에 대한 `encodeAbiParameters` 와 동치다.
 */
export function hashPolicy(policy: SignedPolicy): Hex {
  return keccak256(
    encodeAbiParameters(
      [RECIPIENTS_TUPLE, { type: 'uint16' }, { type: 'uint16' }, { type: 'bool' }],
      [policy.recipients, policy.platformBps, policy.reserveBps, policy.noShowRefund],
    ),
  );
}

/** 짧은 분류 태그(예: "platform")를 Solidity `bytes32` 리터럴과 같게 우측 0 패딩한다. */
export function tagToBytes32(tag: string): Hex {
  return stringToHex(tag, { size: 32 });
}

/** 사유 원문의 keccak256(utf8). 온체인에는 이 해시만, 원문은 settlements 거울에 둔다(설계 §1). */
export function reasonHashOf(reason: string): Hex {
  return keccak256(toHex(reason));
}
