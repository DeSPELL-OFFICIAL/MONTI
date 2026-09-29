// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {MontiTest} from "./Base.t.sol";
import {MontiForwarder} from "../src/MontiForwarder.sol";
import {IIdentity} from "../src/interfaces/IIdentity.sol";
import {P256Vectors} from "./utils/P256Vectors.sol";

/// @notice ERC-2771 대상 흉내를 내는 최소 목. 트러스티드 포워더가 부를 때만 마지막 20바이트를
///         `_msgSender()` 로 해석하고(그 밖에는 raw msg.sender), 관측용으로 호출자·해석된 발신자·
///         인자를 저장한다. `boom` 은 커스텀 에러로 되돌려 버블링을 검증한다.
contract MockTarget {
    error Boom(uint256 code);

    address public immutable trustedForwarder;
    address public lastCaller; // raw msg.sender (= 포워더)
    address public lastSender; // ERC-2771 로 해석된 발신자 (= req.from)
    uint256 public lastValue;
    uint256 public calls;

    constructor(address forwarder_) {
        trustedForwarder = forwarder_;
    }

    function ping(uint256 value) external returns (uint256) {
        lastCaller = msg.sender;
        lastSender = _msgSender();
        lastValue = value;
        calls += 1;
        return value * 2;
    }

    function boom(uint256 code) external {
        revert Boom(code);
    }

    function _msgSender() internal view returns (address sender) {
        if (msg.sender == trustedForwarder && msg.data.length >= 20) {
            assembly {
                sender := shr(96, calldataload(sub(calldatasize(), 20)))
            }
        } else {
            sender = msg.sender;
        }
    }
}

/// @notice A1 — MontiForwarder(ERC-2771 P-256 릴레이 전달자)의 검증. 실제 Identity(관객 기기 키
///         P-256)를 쓰고, ticket·organizers 대상 자리에는 append 된 발신자를 관측하는 MockTarget 을
///         배선한다. 서명은 Base.t.sol 의 vm.signP256 경로(발급/입장과 같은 raw 32B 다이제스트 서명)를
///         재사용한다. 검사 순서·재생·버블링·다이제스트 동치·홉 가스를 못박는다(설계 §1/§7).
contract ForwarderTest is MontiTest {
    MontiForwarder internal forwarder;
    MockTarget internal target; // allowlist 의 ticket 자리
    MockTarget internal organizersTarget; // allowlist 의 organizers 자리

    /// @dev MontiForwarder.Forwarded 와 시그니처가 같아야 한다(토픽0 일치용 로컬 선언).
    event Forwarded(address indexed from, address indexed to, uint256 nonce, bytes4 selector);

    function setUp() public {
        _deployMonti();
        _member(ALICE, 0xA1A1);
        _member(BOB, 0xB0B0);

        // deployer = 이 테스트 컨트랙트. 대상은 포워더 주소를 알아야 배선되므로 2단계.
        forwarder = new MontiForwarder(IIdentity(address(identity)), address(this));
        target = new MockTarget(address(forwarder));
        organizersTarget = new MockTarget(address(forwarder));
        forwarder.setTargets(address(target), address(organizersTarget));
    }

    // --- helpers ---------------------------------------------------------------------------------

    function _req(address from, address to, bytes memory data)
        internal
        view
        returns (MontiForwarder.ForwardRequest memory r)
    {
        r = MontiForwarder.ForwardRequest({
            from: from,
            to: to,
            nonce: forwarder.nonces(from),
            deadline: uint64(block.timestamp + 10 minutes),
            data: data
        });
    }

    function _sign(uint256 pk, MontiForwarder.ForwardRequest memory r) internal view returns (bytes memory) {
        (bytes32 sr, bytes32 ss) = vm.signP256(pk, forwarder.forwardDigest(r));
        return abi.encode(sr, ss);
    }

    function _pingData(uint256 value) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(MockTarget.ping.selector, value);
    }

    // --- valid path ------------------------------------------------------------------------------

    function test_execute_valid_appendsSenderAndBumpsNonce() public {
        MontiForwarder.ForwardRequest memory r = _req(ALICE, address(target), _pingData(42));
        bytes memory sig = _sign(P256Vectors.DEVICE_PRIV, r);

        vm.expectEmit(true, true, false, true, address(forwarder));
        emit Forwarded(ALICE, address(target), 0, MockTarget.ping.selector);

        // 임의의 릴레이 EOA 가 제출한다(permissionless — msg.sender 는 인가에 쓰이지 않는다).
        vm.prank(RELAYER);
        bytes memory ret = forwarder.execute(r, sig);

        assertEq(target.lastCaller(), address(forwarder), "target sees forwarder as raw msg.sender");
        assertEq(target.lastSender(), ALICE, "target _msgSender() sees the appended from");
        assertEq(target.lastValue(), 42, "call payload arrived intact");
        assertEq(target.calls(), 1, "target invoked exactly once");
        assertEq(forwarder.nonces(ALICE), 1, "nonce consumed");
        assertEq(abi.decode(ret, (uint256)), 84, "target return bubbled back");
    }

    function test_execute_worksForOrganizersTarget() public {
        MontiForwarder.ForwardRequest memory r = _req(ALICE, address(organizersTarget), _pingData(3));
        bytes memory sig = _sign(P256Vectors.DEVICE_PRIV, r);

        vm.prank(RELAYER);
        forwarder.execute(r, sig);

        assertEq(organizersTarget.lastSender(), ALICE, "second allowlisted target also strips from");
    }

    // --- guard checks ----------------------------------------------------------------------------

    function test_execute_badNonce() public {
        MontiForwarder.ForwardRequest memory r = _req(ALICE, address(target), _pingData(1));
        r.nonce = 7; // != nonces[ALICE] (0)
        bytes memory sig = _sign(P256Vectors.DEVICE_PRIV, r);

        vm.expectRevert(MontiForwarder.BadNonce.selector);
        forwarder.execute(r, sig);
    }

    function test_execute_expired() public {
        MontiForwarder.ForwardRequest memory r = _req(ALICE, address(target), _pingData(1));
        r.deadline = uint64(block.timestamp - 1);
        bytes memory sig = _sign(P256Vectors.DEVICE_PRIV, r);

        vm.expectRevert(MontiForwarder.Expired.selector);
        forwarder.execute(r, sig);
    }

    function test_execute_wrongTarget() public {
        MontiForwarder.ForwardRequest memory r = _req(ALICE, address(0xDEAD), _pingData(1));
        bytes memory sig = _sign(P256Vectors.DEVICE_PRIV, r);

        vm.expectRevert(MontiForwarder.TargetNotAllowed.selector);
        forwarder.execute(r, sig);
    }

    function test_execute_forgedSignature() public {
        MontiForwarder.ForwardRequest memory r = _req(ALICE, address(target), _pingData(1));
        // ALICE 의 등록된 기기 키가 아닌 키로 서명한다.
        bytes memory sig = _sign(P256Vectors.OTHER_PRIV, r);

        vm.expectRevert(MontiForwarder.BadDeviceSignature.selector);
        forwarder.execute(r, sig);
    }

    function test_execute_lockedMember() public {
        vm.prank(ALICE);
        identity.lockDevice(ALICE);

        MontiForwarder.ForwardRequest memory r = _req(ALICE, address(target), _pingData(1));
        bytes memory sig = _sign(P256Vectors.DEVICE_PRIV, r);

        vm.expectRevert(MontiForwarder.DeviceLocked.selector);
        forwarder.execute(r, sig);
    }

    function test_execute_nonMember() public {
        // CAROL 은 한 번도 등록되지 않았다.
        MontiForwarder.ForwardRequest memory r = _req(CAROL, address(target), _pingData(1));
        bytes memory sig = _sign(P256Vectors.DEVICE_PRIV, r);

        vm.expectRevert(MontiForwarder.NotMember.selector);
        forwarder.execute(r, sig);
    }

    function test_execute_replayReverts() public {
        MontiForwarder.ForwardRequest memory r = _req(ALICE, address(target), _pingData(5));
        bytes memory sig = _sign(P256Vectors.DEVICE_PRIV, r);

        forwarder.execute(r, sig); // nonce 0 소비
        assertEq(forwarder.nonces(ALICE), 1);

        // 같은 요청 재제출: req.nonce(0) != nonces[ALICE](1).
        vm.expectRevert(MontiForwarder.BadNonce.selector);
        forwarder.execute(r, sig);
    }

    function test_execute_bubblesTargetRevert() public {
        bytes memory data = abi.encodeWithSelector(MockTarget.boom.selector, uint256(7));
        MontiForwarder.ForwardRequest memory r = _req(ALICE, address(target), data);
        bytes memory sig = _sign(P256Vectors.DEVICE_PRIV, r);

        // 대상 커스텀 에러가 원문 그대로 표면화되어야 한다.
        vm.expectRevert(abi.encodeWithSelector(MockTarget.Boom.selector, uint256(7)));
        forwarder.execute(r, sig);

        // 되돌림이므로 nonce 소비도 롤백된다 — 재시도가 막히면 안 된다.
        assertEq(forwarder.nonces(ALICE), 0, "reverted call rolls back nonce");
    }

    // --- setTargets wiring -----------------------------------------------------------------------

    function test_setTargets_twiceReverts() public {
        // setUp 이 이미 1회 배선했다.
        vm.expectRevert(MontiForwarder.AlreadyWired.selector);
        forwarder.setTargets(address(target), address(organizersTarget));
    }

    function test_setTargets_onlyDeployer() public {
        MontiForwarder fresh = new MontiForwarder(IIdentity(address(identity)), address(this));
        vm.prank(ALICE);
        vm.expectRevert(MontiForwarder.NotDeployer.selector);
        fresh.setTargets(address(target), address(organizersTarget));
    }

    // --- digest equivalence ----------------------------------------------------------------------

    function test_forwardDigest_matchesIndependentComputation() public view {
        MontiForwarder.ForwardRequest memory r = _req(ALICE, address(target), _pingData(9));

        bytes32 expected = sha256(
            abi.encode(
                keccak256("MONTI:FORWARD:v1"),
                block.chainid,
                address(forwarder),
                r.from,
                r.to,
                r.nonce,
                r.deadline,
                keccak256(r.data)
            )
        );

        assertEq(forwarder.forwardDigest(r), expected, "digest must match independent sha256/abi.encode");
    }

    // --- gas log ---------------------------------------------------------------------------------

    function test_forwardGas_noop() public {
        // 서명은 측정 창 밖에서 만든다(sha256 프리컴파일이 미리 따뜻해지면 콜드 비용이 사라진다).
        MontiForwarder.ForwardRequest memory r = _req(ALICE, address(target), _pingData(0));
        bytes memory sig = _sign(P256Vectors.DEVICE_PRIV, r);
        MontiForwarder f = forwarder;

        vm.prank(RELAYER);
        uint256 before = gasleft();
        f.execute(r, sig);
        uint256 used = before - gasleft();

        assertEq(target.calls(), 1, "the measured call must be a real forward");
        emit log_named_uint("forward overhead gas (local osaka, ping no-op)", used);
    }
}
