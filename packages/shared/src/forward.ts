import { encodeAbiParameters, encodeFunctionData, keccak256, parseAbiParameters, sha256, toHex } from 'viem';
import { forwarderAbi } from './abi.js';
import type { Address } from 'viem';
import type { Hex } from './types.js';

/**
 * `MontiForwarder` 릴레이 요청의 목적 태그. MontiForwarder.sol 의
 * `bytes32 private constant FORWARD_TAG = keccak256("MONTI:FORWARD:v1")` 와 같은 값이다.
 * 다이제스트 선두에 이 32바이트가 오므로 발급 승인서(`MONTI:CLAIM_AUTH:v1`)나 게이트/체크인 경로의
 * 서명을 이 전달자에 재사용할 수 없다(설계 §7).
 */
export const FORWARD_TAG: Hex = keccak256(toHex('MONTI:FORWARD:v1'));

/**
 * ERC-2771 릴레이 전달 요청(설계 §1). 관객·주최자 기기 키(P-256)가 {@link forwardDigest} 에 서명하고
 * MONTI 릴레이어 EOA 가 대신 `MontiForwarder.execute` 로 제출한다. `from` 은 행위 주체 스마트 계정,
 * `to` 는 대상 컨트랙트(ticket · organizers · identity 중 하나), `nonce` 는 `from` 별 단일 순번
 * (== `MontiForwarder.nonces(from)`), `deadline` 은 미제출 요청의 수명(block.timestamp <= deadline),
 * `data` 는 대상 함수 calldata(`from` 미포함 — execute 가 뒤에 덧붙인다)이다.
 */
export type ForwardRequest = {
  from: Address;
  to: Address;
  nonce: bigint;
  deadline: bigint;
  data: Hex;
};

function assertAddress(value: string, label: string): void {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error(label);
}

function assertBytes(value: string, label: string): void {
  if (typeof value !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(value)) throw new Error(label);
}

/**
 * `forwardDigest` 가 서명하는 **원문 바이트열**. `claimAuthPreimage` 와 같은 이유로 따로 내보낸다:
 * 웹 WebCrypto 의 `ECDSA`/`SHA-256` 검증은 다이제스트가 아니라 원문을 받아 자기가 해싱하므로,
 * 소프트웨어 키 클라이언트는 이 프리이미지에 서명하고 네이티브 키 클라이언트는 {@link forwardDigest}
 * (그 sha256)에 서명한다. MontiForwarder.forwardDigest 가 abi.encode 하는 8개 워드를 그 순서·타입
 * 그대로 인코딩한다: `(bytes32 tag, uint256 chainId, address forwarder, address from, address to,
 * uint256 nonce, uint64 deadline, bytes32 keccak256(data))`. chainId 와 forwarder 는 요청이 아니라
 * 호출부(현재 체인·배포된 전달자 주소)가 채운다 — 그래야 교차체인·교차전달자 재생이 막힌다.
 */
export function forwardPreimage(chainId: bigint, forwarder: Address, req: ForwardRequest): Hex {
  assertAddress(forwarder, 'BAD_FORWARDER_ADDRESS');
  assertAddress(req.from, 'BAD_FROM');
  assertAddress(req.to, 'BAD_TO');
  assertBytes(req.data, 'BAD_DATA');
  return encodeAbiParameters(
    parseAbiParameters(
      'bytes32 tag, uint256 chainId, address forwarder, address from, address to, uint256 nonce, uint64 deadline, bytes32 dataHash',
    ),
    [FORWARD_TAG, chainId, forwarder, req.from, req.to, req.nonce, req.deadline, keccak256(req.data)],
  );
}

/**
 * 기기 키가 서명해야 하는 릴레이 요청의 32바이트. `MontiForwarder.forwardDigest(req)` 와
 * byte-identical 이다 — 지갑·백엔드가 자기 계산을 체인과 대조할 수 있어야 하므로 공개한다(설계 §1).
 */
export function forwardDigest(chainId: bigint, forwarder: Address, req: ForwardRequest): Hex {
  return sha256(forwardPreimage(chainId, forwarder, req));
}

/**
 * `execute` 에 넘기는 `ForwardRequest` 튜플의 JSON 안전 표현. 릴레이어 백엔드로 오가는 페이로드라서
 * bigint 는 십진 문자열로 직렬화한다. 필드 순서는 온체인 struct 순서(from, to, nonce, deadline, data)를
 * 그대로 따른다 — 다이제스트의 abi.encode 순서(tag·chainId·forwarder 가 앞에 붙는)와 다르다.
 */
export type ForwardRequestWire = {
  from: Address;
  to: Address;
  nonce: string;
  deadline: string;
  data: Hex;
};

/** {@link ForwardRequest} 를 릴레이어로 보낼 JSON 안전 페이로드로 바꾼다. */
export function encodeForwardRequestStruct(req: ForwardRequest): ForwardRequestWire {
  assertAddress(req.from, 'BAD_FROM');
  assertAddress(req.to, 'BAD_TO');
  assertBytes(req.data, 'BAD_DATA');
  if (req.nonce < 0n || req.deadline < 0n) throw new Error('NEGATIVE_FIELD');
  return {
    from: req.from,
    to: req.to,
    nonce: req.nonce.toString(),
    deadline: req.deadline.toString(),
    data: req.data,
  };
}

/** {@link encodeForwardRequestStruct} 의 역함수. 릴레이어가 받은 페이로드를 온체인 호출용으로 되돌린다. */
export function decodeForwardRequestStruct(wire: ForwardRequestWire): ForwardRequest {
  assertAddress(wire.from, 'BAD_FROM');
  assertAddress(wire.to, 'BAD_TO');
  assertBytes(wire.data, 'BAD_DATA');
  if (!/^\d+$/.test(wire.nonce) || !/^\d+$/.test(wire.deadline)) throw new Error('BAD_DECIMAL');
  return {
    from: wire.from,
    to: wire.to,
    nonce: BigInt(wire.nonce),
    deadline: BigInt(wire.deadline),
    data: wire.data,
  };
}

/**
 * `MontiForwarder.execute(ForwardRequest req, bytes deviceSig)` 호출 calldata. 릴레이어가 대신 낼
 * 트랜잭션의 data 다. 생성 ABI(`forwarderAbi`, sub-plan 01의 export-abi.sh 산출물)로 인코딩한다.
 * `deviceSig` 는 r‖s 64바이트(`abi.encode(bytes32,bytes32)`)로, 기기 서명 형식은 Phase 1 과 같다.
 */

export function encodeExecuteCalldata(req: ForwardRequest, deviceSig: Hex): Hex {
  assertAddress(req.from, 'BAD_FROM');
  assertAddress(req.to, 'BAD_TO');
  assertBytes(req.data, 'BAD_DATA');
  assertBytes(deviceSig, 'BAD_DEVICE_SIG');
  return encodeFunctionData({
    abi: forwarderAbi,
    functionName: 'execute',
    args: [{ from: req.from, to: req.to, nonce: req.nonce, deadline: req.deadline, data: req.data }, deviceSig],
  });
}

/**
 * `execute` 경로가 되돌릴 수 있는 커스텀 에러 이름들(MontiForwarder.sol). 콜러블/릴레이어가 revert
 * 데이터를 이 이름들로 되짚어 DENY 코드로 옮긴다. 배선 전용 에러(NotDeployer·AlreadyWired)는 제외한다.
 */
export const FORWARDER_ERRORS = [
  'TargetNotAllowed',
  'Expired',
  'BadNonce',
  'NotMember',
  'DeviceLocked',
  'BadDeviceSignature',
] as const;

export type ForwarderError = (typeof FORWARDER_ERRORS)[number];
