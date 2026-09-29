// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {P256} from "solady/utils/P256.sol";
import {IIdentity} from "./interfaces/IIdentity.sol";

/// @title MontiForwarder
/// @notice ERC-2771 메타트랜잭션 전달자를 MONTI 기기 키(P-256)에 맞춰 각색한 것(설계 §1). 관객·주최자의
///         남은 스폰서드 동작(주최자 라이프사이클·게이트·팀·승인, 관객 양도/신청취소/닉네임/migrate)을
///         **기기 키가 서명하고 릴레이어가 대신 내는 일반 트랜잭션**으로 옮긴다. Phase 1 의 고빈도
///         발급(`claimFor`/`requestClaimFor`)·입장(`checkInFor`/`checkInForLate`)은 이 전달자 밖(현행
///         유지, (eventId,account) nonce·이중서명)이다 — 하이브리드 경계(설계 §1).
///
///         OZ `ERC2771Forwarder.execute` 를 그대로 따르되 서명계만 프로젝트 것으로 바꿨다: EIP-712
///         keccak 대신 Phase 1 `claimAuthDigest` 와 같은 **sha256 + 목적 태그** 를 써서, 클라이언트의
///         `signWithDeviceKey`(raw 32B 다이제스트 서명)가 한 줄도 안 바뀌고 재사용된다.
///
///         대상 컨트랙트(Ticket·Organizers·Identity)는 ERC2771Context 를 상속하고 이 전달자를
///         trustedForwarder 로 신뢰한다. `to.call(data ‖ from)` 로 마지막 20바이트에 `from` 을 덧붙이면,
///         대상의 `_msgSender()` 가 그 20바이트(=진짜 요청자)를 돌려주므로 기존 권한 검사가 그대로 통과한다.
contract MontiForwarder {
    /// @param from     행위 주체(관객/주최자 스마트 계정 주소). Identity 에 등록된 기기 키의 소유자다.
    /// @param to       대상 컨트랙트(ticket · organizers · identity 중 하나 — 아래 allowlist).
    /// @param nonce    == nonces[from]. 재생 방지 순번.
    /// @param deadline block.timestamp <= deadline. 미제출 요청의 수명 제한.
    /// @param data     대상 함수 calldata(from 미포함 — execute 가 뒤에 붙인다).
    struct ForwardRequest {
        address from;
        address to;
        uint256 nonce;
        uint64 deadline;
        bytes data;
    }

    /// @dev 발급/입장(CLAIM_AUTH·게이트/기기 다이제스트)과 프리이미지를 갈라 놓는 목적 태그. 다이제스트
    ///      선두에 이 32바이트가 오므로 한 경로의 서명을 다른 경로에 재사용할 수 없다(설계 §7). shared/
    ///      backend 가 같은 문자열을 쓴다 — abi-delta-phase2.md 에 고정한다.
    bytes32 private constant FORWARD_TAG = keccak256("MONTI:FORWARD:v1");

    /// @notice activeDevice/isMember/isLocked 를 읽는 Identity. 배포 순서상 먼저 존재하므로 immutable.
    IIdentity public immutable identity;
    /// @notice setTargets 를 1회 부를 수 있는 배포자. 전달자 주소를 대상들이 알아야 배선되므로 대상은
    ///         생성자에 못 넣는다 — 그래서 배포자만 1회 배선하는 2단계 구조다.
    address public immutable deployer;

    /// @notice 대상 allowlist(설계 §7). ERC2771 미인지 컨트랙트에 20바이트가 덧붙는 혼동을 막는다.
    ///         setTargets 로 1회 고정한다.
    address public ticket;
    address public organizers;
    /// @dev setTargets 를 두 번 부르지 못하게 막는 플래그.
    bool private _wired;

    /// @notice from 별 단일 순번. 클라이언트가 다음 요청의 nonce 로 읽는다(자동 getter).
    mapping(address => uint256) public nonces;

    event Forwarded(address indexed from, address indexed to, uint256 nonce, bytes4 selector);

    error NotDeployer();
    error AlreadyWired();
    error Expired();
    error TargetNotAllowed();
    error BadNonce();
    error NotMember();
    error DeviceLocked();
    error BadDeviceSignature();

    /// @dev identity 는 배포 순서상 먼저 존재하므로 즉시 immutable 주입. ticket/organizers 는 이 전달자
    ///      주소를 trustedForwarder 로 알아야 배포되므로 생성자에 못 넣고 setTargets 로 배선한다.
    constructor(IIdentity identity_, address deployer_) {
        identity = identity_;
        deployer = deployer_;
    }

    /// @notice ticket·organizers 대상을 1회 고정한다(identity 는 이미 안다). 배포자만, 단 한 번.
    ///         이후 allowlist 는 {identity, organizers, ticket} 로 고정된다(설계 §8, abi-delta).
    function setTargets(address ticket_, address organizers_) external {
        if (msg.sender != deployer) revert NotDeployer();
        if (_wired) revert AlreadyWired();
        _wired = true;
        ticket = ticket_;
        organizers = organizers_;
    }

    /// @notice 기기 키가 서명해야 하는 32바이트(설계 §1). 03 의 지갑과 백엔드가 자기 계산을 체인과
    ///         대조할 수 있게 공개한다. chainid·address(this)·keccak256(data) 로 체인·전달자·호출 전체를
    ///         바인딩해 교차체인·교차전달자·교차호출 재사용을 막는다.
    function forwardDigest(ForwardRequest calldata req) public view returns (bytes32) {
        return sha256(
            abi.encode(
                FORWARD_TAG,
                block.chainid,
                address(this),
                req.from,
                req.to,
                req.nonce,
                req.deadline,
                keccak256(req.data)
            )
        );
    }

    /// @notice 서명된 요청을 대상 함수로 전달한다. 누구나 제출할 수 있다(permissionless) — msg.sender 는
    ///         인가에 쓰이지 않고, 권한은 기기 P-256 서명이 증명한다. 검사: 대상 allowlist → deadline →
    ///         nonce → isMember → !isLocked → 기기 서명. 통과하면 nonce 를 소비(호출 전, CEI)한 뒤
    ///         `to.call(data ‖ from)` 로 부르고, 대상 revert 는 원문 그대로 버블한다.
    /// @param deviceSig r‖s 64바이트(abi.encode(bytes32,bytes32) 와 동일). Phase 1 과 같은 형식.
    function execute(ForwardRequest calldata req, bytes calldata deviceSig) external returns (bytes memory ret) {
        if (req.to == address(0)) revert TargetNotAllowed(); // 배선 전 ticket/organizers 가 0 이라 0 대상이 새는 것을 막는다
        if (req.to != ticket && req.to != organizers && req.to != address(identity)) revert TargetNotAllowed();
        if (block.timestamp > req.deadline) revert Expired();
        if (req.nonce != nonces[req.from]) revert BadNonce();
        if (!identity.isMember(req.from)) revert NotMember();
        if (identity.isLocked(req.from)) revert DeviceLocked();

        (bytes32 x, bytes32 y) = identity.activeDevice(req.from);
        if (deviceSig.length != 64) revert BadDeviceSignature();
        (bytes32 r, bytes32 s) = abi.decode(deviceSig, (bytes32, bytes32));
        if (!P256.verifySignature(forwardDigest(req), r, s, x, y)) revert BadDeviceSignature();

        nonces[req.from] += 1; // 소비(호출 전, checks-effects-interactions)

        bytes4 selector = req.data.length >= 4 ? bytes4(req.data[:4]) : bytes4(0);
        bool ok;
        // ERC-2771: 대상의 _msgSender() 가 읽는 마지막 20바이트로 from 을 덧붙인다.
        (ok, ret) = req.to.call(abi.encodePacked(req.data, req.from));
        if (!ok) {
            // 대상 revert 데이터를 그대로 버블한다(콜러블이 고유 revert 를 DENY 코드로 옮긴다).
            assembly {
                revert(add(ret, 0x20), mload(ret))
            }
        }

        emit Forwarded(req.from, req.to, req.nonce, selector);
    }
}
