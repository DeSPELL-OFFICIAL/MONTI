import { parseAbi } from 'viem';

/**
 * `MontiForwarder`(설계 §1)의 **최소** ABI. relayAction 이 쓰는 것만 담는다:
 *  - `execute(req, deviceSig)` — 가스 쓰기 전 시뮬 + 실제 전송 calldata 인코딩.
 *  - `nonces(from)` — 전송 전 nonce 재대조(진부/중복 조기 거절).
 *  - `forwardDigest(req)` — 클라가 서명한 다이제스트(서버는 참고용).
 *  - `Forwarded` 이벤트 — 확정 영수증에서 릴레이 성사 확인.
 *  - 6개 커스텀 에러 — 시뮬 revert → 코드 매핑(설계 §4).
 *
 * 시그니처는 **동결 계약(task)** 을 따른다: nonce 게터는 `nonces`, 만료 에러는 `Expired`.
 * B2 가 `export-abi.sh` 로 뽑은 생성 ABI 로 이 파일을 통째로 교체한다 — 그때까지의 손서명 스텁이다.
 */
export const forwarderAbi = parseAbi([
  'function execute((address from, address to, uint256 nonce, uint64 deadline, bytes data) req, bytes deviceSig) returns (bytes ret)',
  'function nonces(address from) view returns (uint256)',
  'function forwardDigest((address from, address to, uint256 nonce, uint64 deadline, bytes data) req) view returns (bytes32)',
  'event Forwarded(address indexed from, address indexed to, uint256 nonce)',
  'error TargetNotAllowed()',
  'error Expired()',
  'error BadNonce()',
  'error NotMember()',
  'error DeviceLocked()',
  'error BadDeviceSignature()',
]);
