import { encodeAbiParameters, keccak256, parseAbiParameters, sha256, toHex } from 'viem';
import type { Address } from 'viem';
import type { Hex } from './types.js';

/**
 * 릴레이 발급 승인서의 목적 태그. Ticket.sol 의
 * `bytes32 private constant CLAIM_AUTH_TAG = keccak256("MONTI:CLAIM_AUTH:v1")` 와 같은 값이다.
 * 다이제스트 선두에 이 32바이트가 오므로 한 서명을 게이트 코드/체크인 경로에 재사용할 수 없다(설계 §2).
 */
export const CLAIM_AUTH_TAG: Hex = keccak256(toHex('MONTI:CLAIM_AUTH:v1'));

/**
 * 릴레이된 발급 승인서(설계 §2/§3). 관객 기기 키(P-256)가 {@link claimAuthDigest} 에 서명하고
 * MONTI 릴레이어 EOA 가 대신 `claimFor`/`requestClaimFor` 로 제출한다. `account` 는 티켓을 받을
 * 스마트 계정이고, `nonce` 는 (eventId, account) 별 claim nonce(== `Ticket.claimNonce(eventId, account)`)
 * 이며, `deadline` 은 미제출 승인서의 수명(block.timestamp <= deadline)이다.
 */
export type ClaimAuth = {
  eventId: bigint;
  tier: number;
  account: Address;
  nonce: bigint;
  deadline: bigint;
};

function assertAddress(value: string, label: string): void {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error(label);
}

function assertTier(tier: number): void {
  if (!Number.isInteger(tier) || tier < 0 || tier > 255) throw new Error('BAD_TIER');
}

/**
 * `claimAuthDigest` 가 서명하는 **원문 바이트열**. `gateCodePreimage`·`deviceDigestPreimage` 와 같은
 * 이유로 따로 내보낸다: WebCrypto 의 `ECDSA`/`SHA-256` 검증은 다이제스트가 아니라 원문을 받아 자기가
 * 해싱한다. Ticket.claimAuthDigest 가 abi.encode 하는 8개 워드를 그 순서·타입 그대로 인코딩한다:
 * `(bytes32 tag, uint256 chainId, address ticket, uint256 eventId, uint8 tier, address account,
 * uint256 nonce, uint64 deadline)`. chainId 와 ticket 은 승인서가 아니라 호출부(현재 체인·배포본)가
 * 채운다 — 그래야 한 체인·한 배포본에서 거둔 서명이 다른 곳에서 재생되지 않는다.
 */
export function claimAuthPreimage(chainId: bigint, ticket: Address, auth: ClaimAuth): Hex {
  assertAddress(ticket, 'BAD_TICKET_ADDRESS');
  assertAddress(auth.account, 'BAD_ACCOUNT');
  assertTier(auth.tier);
  return encodeAbiParameters(
    parseAbiParameters(
      'bytes32 tag, uint256 chainId, address ticket, uint256 eventId, uint8 tier, address account, uint256 nonce, uint64 deadline',
    ),
    [CLAIM_AUTH_TAG, chainId, ticket, auth.eventId, auth.tier, auth.account, auth.nonce, auth.deadline],
  );
}

/**
 * 관객 기기가 서명해야 하는 발급 승인서의 32바이트. `Ticket.claimAuthDigest(a)` 와 byte-identical 이다
 * — 03 의 지갑·백엔드가 자기 계산을 체인과 대조할 수 있어야 하므로 공개한다(설계 §2).
 */
export function claimAuthDigest(chainId: bigint, ticket: Address, auth: ClaimAuth): Hex {
  return sha256(claimAuthPreimage(chainId, ticket, auth));
}

/**
 * `claimFor`/`requestClaimFor` 에 넘기는 `ClaimAuth` 튜플의 JSON 안전 표현. 릴레이어 백엔드로 오가는
 * 페이로드라서 bigint 는 십진 문자열로 직렬화한다. 필드 순서는 온체인 struct 순서(eventId, tier,
 * account, nonce, deadline)를 그대로 따른다 — 다이제스트의 abi.encode 순서(tag·chainId·ticket 이 앞에
 * 붙는)와 다르다.
 */
export type ClaimAuthWire = {
  eventId: string;
  tier: number;
  account: Address;
  nonce: string;
  deadline: string;
};

/** {@link ClaimAuth} 를 릴레이어로 보낼 JSON 안전 페이로드로 바꾼다. */
export function encodeClaimAuthStruct(auth: ClaimAuth): ClaimAuthWire {
  assertAddress(auth.account, 'BAD_ACCOUNT');
  assertTier(auth.tier);
  if (auth.eventId < 0n || auth.nonce < 0n || auth.deadline < 0n) throw new Error('NEGATIVE_FIELD');
  return {
    eventId: auth.eventId.toString(),
    tier: auth.tier,
    account: auth.account,
    nonce: auth.nonce.toString(),
    deadline: auth.deadline.toString(),
  };
}

/** {@link encodeClaimAuthStruct} 의 역함수. 릴레이어가 받은 페이로드를 온체인 호출용으로 되돌린다. */
export function decodeClaimAuthStruct(wire: ClaimAuthWire): ClaimAuth {
  assertAddress(wire.account, 'BAD_ACCOUNT');
  assertTier(wire.tier);
  if (!/^\d+$/.test(wire.eventId) || !/^\d+$/.test(wire.nonce) || !/^\d+$/.test(wire.deadline)) {
    throw new Error('BAD_DECIMAL');
  }
  return {
    eventId: BigInt(wire.eventId),
    tier: wire.tier,
    account: wire.account,
    nonce: BigInt(wire.nonce),
    deadline: BigInt(wire.deadline),
  };
}
