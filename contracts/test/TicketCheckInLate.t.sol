// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {MontiTest} from "./Base.t.sol";
import {Ticket} from "../src/Ticket.sol";
import {P256} from "solady/utils/P256.sol";
import {P256Vectors} from "./utils/P256Vectors.sol";

/// @notice 스펙 12 의 오프라인 큐 + 릴레이 전환(설계 §4). 게이트 권한은 게이트 키 서명이 증명하고,
///         입장은 임의 RELAYER 가 제출한다. 슬림 저장(§12)으로 checkInOf.late 는 항상 false 이고
///         '늦음'은 CheckedInLate 이벤트에만 남으므로, 큐 플러시는 현장 경로가 같은 시각에 막힌다는
///         것(또는 CheckedInLate 방출)으로 증명한다.
abstract contract CheckInLateBase is MontiTest {
    uint256 internal orgId;
    uint256 internal eventId;
    uint256 internal tokenId;
    uint256 internal gateId;

    uint64 internal constant ISSUED = uint64(P256Vectors.ISSUED_AT);
    bytes32 internal constant NONCE_HASH = keccak256(abi.encode(P256Vectors.NONCE));

    /// @dev TicketCheckIn.t.sol 과 같은 이유로 setUp 에서 한 번 만들어 들고 있는다: 서명 헬퍼는
    ///      치트코드를 부르므로 prank/expectRevert 뒤에 두면 그것을 먹는다.
    bytes internal deviceSig;
    bytes internal foreignSig;
    bytes internal gsig;

    event CheckedIn(
        uint256 indexed tokenId, uint256 indexed eventId, uint256 indexed gateId, bytes32 nonceHash, uint64 ts
    );
    event CheckedInLate(uint256 indexed tokenId, uint256 indexed gateId, uint64 issuedAt, uint64 ts);

    /// @dev `_deployMonti` 가 시계를 T0 == P256Vectors.ISSUED_AT 으로 맞추므로, 여기서 만드는 것은
    ///      전부 코드가 발급된 바로 그 순간에 존재한다.
    function _setUpLate(uint64 startsAt, uint64 endsAt) internal {
        _deployMonti();
        _memberWithDeviceKey(ALICE, 0xA1A1);
        orgId = _org();

        Ticket.EventMeta memory m = Ticket.EventMeta({
            orgId: orgId,
            titleHash: keccak256("MONTI Late Night"),
            descHash: keccak256("an event the gate queued taps for"),
            imageCid: "bafyTestCid",
            startsAt: startsAt,
            endsAt: endsAt,
            venueHash: keccak256("Seoul"),
            saleStart: ISSUED - 1 days,
            saleEnd: ISSUED + 1 hours,
            transferable: true,
            transferCutoffSeconds: 600,
            maxTransfers: 1,
            approvalRequired: false,
            category: 0,
            regionCode: keccak256("KR-11"),
            requireKyc: false
        });
        Ticket.Tier[] memory t = new Ticket.Tier[](1);
        t[0] = Ticket.Tier({name: "General", priceUsdCents: 0, supply: 100, minted: 0, maxPerWallet: 1, seated: false});

        vm.startPrank(ORG_OWNER);
        eventId = ticket.publishEvent(m, t, _emptyPolicy());
        vm.stopPrank();

        tokenId = _claimForFixture(ALICE, eventId, 0);

        vm.startPrank(ORG_OWNER);
        gateId = organizers.registerGate(eventId, GATE_A, GATE_KX, GATE_KY);
        organizers.openGate(gateId);
        vm.stopPrank();

        assertEq(eventId, P256Vectors.EVENT_ID, "vectors were generated for event 1001");
        assertEq(gateId, P256Vectors.GATE1_ID, "vectors were generated for gate 1");

        deviceSig = _deviceSig(tokenId, _code());
        foreignSig = _foreignDeviceSig(tokenId, _code());
        gsig = _gateSig(_code());
    }

    function _code() internal pure returns (Ticket.GateCode memory) {
        return Ticket.GateCode({
            gateId: P256Vectors.GATE1_ID,
            eventId: P256Vectors.EVENT_ID,
            issuedAt: P256Vectors.ISSUED_AT,
            nonce: P256Vectors.NONCE
        });
    }

    function _sig() internal view returns (bytes memory) {
        return deviceSig;
    }
}

/// @notice 문이 코드 발급과 동시에 열린 행사. 창의 오른쪽 끝(제출 기한)을 본다.
contract TicketCheckInLateTest is CheckInLateBase {
    function setUp() public {
        _setUpLate(ISSUED, ISSUED + 6 hours);
    }

    /// @dev C1 의 핵심 회귀. 같은 코드·같은 서명이 현장 경로에서는 만료되고 큐 경로에서는 들어온다.
    function test_C1_aQueuedTapLandsAnHourLater() public {
        vm.warp(ISSUED + 1 hours);

        vm.expectRevert(Ticket.CodeExpired.selector);
        ticket.checkInFor(tokenId, _code(), gsig, _sig());

        vm.expectEmit(true, true, false, true);
        emit CheckedInLate(tokenId, gateId, ISSUED, ISSUED + 1 hours);
        vm.expectEmit(true, true, true, true);
        emit CheckedIn(tokenId, eventId, gateId, NONCE_HASH, ISSUED + 1 hours);
        vm.prank(RELAYER);
        ticket.checkInForLate(tokenId, _code(), gsig, _sig());

        Ticket.CheckIn memory c = ticket.checkInOf(tokenId);
        assertEq(c.ts, ISSUED + 1 hours);
        assertEq(c.gateId, 0, "slim storage keeps no gateId");
        assertEq(c.nonceHash, bytes32(0), "slim storage keeps no nonceHash");
        assertFalse(c.manual, "a queued tap is not a manual override");
        assertFalse(c.late, "late lives in the event, not slim storage");
        assertEq(ticket.usedAt(tokenId), uint32(ISSUED + 1 hours));
    }

    function test_theQueueStillFlushesAfterTheEventEnds() public {
        vm.warp(ISSUED + 6 hours + 11 hours);
        vm.prank(RELAYER);
        ticket.checkInForLate(tokenId, _code(), gsig, _sig());
        assertTrue(ticket.usedAt(tokenId) != 0, "the queue flushed it");
    }

    function test_theFlushDeadlineIsExactlyLateWindowAfterTheEventEnds() public {
        vm.warp(ISSUED + 6 hours + 12 hours);
        vm.prank(RELAYER);
        ticket.checkInForLate(tokenId, _code(), gsig, _sig());
        assertTrue(ticket.usedAt(tokenId) != 0, "the queue flushed it at the deadline");
    }

    function test_oneSecondPastTheFlushDeadlineIsRejected() public {
        vm.warp(ISSUED + 6 hours + 12 hours + 1);
        vm.expectRevert(Ticket.EventEnded.selector);
        ticket.checkInForLate(tokenId, _code(), gsig, _sig());
    }

    /// @dev 현장 경로는 폐장 순간 그대로 닫힌다. 넓어진 것은 기록 경로뿐이다.
    function test_theLiveDoorStillClosesAtEndsAt() public {
        vm.warp(ISSUED + 6 hours + 1);
        vm.expectRevert(Ticket.EventEnded.selector);
        ticket.checkInFor(tokenId, _code(), gsig, _sig());
    }

    /// @dev 열림은 문을 여닫는 스위치이지 권한이 아니다. 닫힌 게이트도 자기 장부는 정리한다.
    function test_aClosedGateCanStillFlushItsQueue() public {
        vm.prank(ORG_OWNER);
        organizers.closeGate(gateId);
        vm.warp(ISSUED + 2 hours);

        vm.expectRevert(Ticket.GateNotOpen.selector);
        ticket.checkInFor(tokenId, _code(), gsig, _sig());

        vm.prank(RELAYER);
        ticket.checkInForLate(tokenId, _code(), gsig, _sig());
        assertTrue(ticket.usedAt(tokenId) != 0, "a closed gate still flushes its queue");
    }

    /// @dev T14: 도난당한 단말기는 폐기하면 큐도 못 흘린다.
    function test_T14_aRevokedGateCannotFlush() public {
        vm.prank(ORG_OWNER);
        organizers.revokeGate(gateId);
        vm.warp(ISSUED + 2 hours);

        vm.expectRevert(Ticket.GateNotOpen.selector);
        ticket.checkInForLate(tokenId, _code(), gsig, _sig());
    }

    /// @dev 게이트 코드에 게이트 키가 아닌 키로 서명하면 큐도 못 흘린다(위조 게이트 서명, 설계 §4).
    ///      릴레이 전환 전의 "게이트가 남의 큐를 흘린다" 개념(msg.sender 바인딩)은 사라졌고, 그
    ///      자리를 게이트 서명 위조 방지가 대신한다.
    function test_forgedGateSignatureRejectedOnTheLatePath() public {
        vm.warp(ISSUED + 2 hours);
        bytes memory forgedGate = _foreignGateSig(_code());
        vm.expectRevert(Ticket.BadGateSignature.selector);
        ticket.checkInForLate(tokenId, _code(), forgedGate, _sig());
    }

    /// @dev T12: 04 의 큐는 이 revert 를 '이미 기록됨 = 성공'으로 처리한다.
    function test_T12_flushingAnAlreadyAdmittedTicketReverts() public {
        vm.warp(ISSUED + 5);
        vm.prank(RELAYER);
        ticket.checkInFor(tokenId, _code(), gsig, _sig());

        vm.warp(ISSUED + 2 hours);
        vm.expectRevert(Ticket.AlreadyCheckedIn.selector);
        ticket.checkInForLate(tokenId, _code(), gsig, _sig());
        assertEq(ticket.usedAt(tokenId), uint32(ISSUED + 5), "the live record stands");
    }

    /// @dev T15: 단말기 혼자서는 큐 항목을 만들 수 없다. 관객 기기 서명이 여전히 필수다.
    function test_T15_theQueueStillNeedsTheAttendeeSignature() public {
        vm.warp(ISSUED + 2 hours);
        vm.expectRevert(Ticket.BadDeviceSignature.selector);
        ticket.checkInForLate(tokenId, _code(), gsig, foreignSig);
    }

    /// @dev Gap 2. 늦은 경로가 payload 의 수명을 60초에서 행사 창 전체로 늘리므로, 도메인
    ///      묶음이 실제로 필요해지는 곳이 바로 여기다. 옛 5필드 다이제스트로는 못 들어온다.
    function test_aSignatureOverTheOldFiveFieldDigestIsRefusedOnTheLatePath() public {
        vm.warp(ISSUED + 2 hours);
        Ticket.GateCode memory g = _code();
        bytes32 old5 = sha256(abi.encode(tokenId, g.gateId, g.eventId, g.nonce, g.issuedAt));
        (bytes32 r, bytes32 s) = vm.signP256(P256Vectors.DEVICE_PRIV, old5);

        vm.expectRevert(Ticket.BadDeviceSignature.selector);
        ticket.checkInForLate(tokenId, g, gsig, abi.encode(r, s));
    }

    /// @dev 다른 체인 / 다른 배포본을 위한 서명도 마찬가지다.
    function test_aSignatureForAnotherChainOrAnotherTicketIsRefusedOnTheLatePath() public {
        vm.warp(ISSUED + 2 hours);
        Ticket.GateCode memory g = _code();

        bytes32 otherChain =
            sha256(abi.encode(uint256(1), address(ticket), tokenId, g.gateId, g.eventId, g.nonce, g.issuedAt));
        (bytes32 r, bytes32 s) = vm.signP256(P256Vectors.DEVICE_PRIV, otherChain);
        vm.expectRevert(Ticket.BadDeviceSignature.selector);
        ticket.checkInForLate(tokenId, g, gsig, abi.encode(r, s));

        bytes32 otherTicket =
            sha256(abi.encode(block.chainid, address(0xDEAD), tokenId, g.gateId, g.eventId, g.nonce, g.issuedAt));
        (r, s) = vm.signP256(P256Vectors.DEVICE_PRIV, otherTicket);
        vm.expectRevert(Ticket.BadDeviceSignature.selector);
        ticket.checkInForLate(tokenId, g, gsig, abi.encode(r, s));
    }

    /// @dev C2 의 요구는 늦은 경로에도 그대로 붙는다.
    function test_C2_highSRejectedOnTheLatePathToo() public {
        vm.warp(ISSUED + 2 hours);
        (bytes32 r, bytes32 s) = _deviceRS(P256Vectors.DEVICE_PRIV, tokenId, _code());

        vm.expectRevert(Ticket.BadDeviceSignature.selector);
        ticket.checkInForLate(tokenId, _code(), gsig, abi.encode(r, bytes32(P256.N - uint256(s))));
    }

    function test_aCancelledEventRejectsTheQueueToo() public {
        vm.prank(ORG_OWNER);
        ticket.cancelEvent(eventId);
        vm.warp(ISSUED + 2 hours);

        vm.expectRevert(Ticket.EventCancelled.selector);
        ticket.checkInForLate(tokenId, _code(), gsig, _sig());
    }

    /// @dev 앞선 시계는 두 경로 모두에서 위조다. CLOCK_SKEW 는 넓히지 않았다.
    function test_aFutureCodeIsStillAForgeryOnTheLatePath() public {
        vm.warp(ISSUED - 6);
        vm.expectRevert(Ticket.CodeExpired.selector);
        ticket.checkInForLate(tokenId, _code(), gsig, _sig());
    }

    /// @dev 잠긴 기기는 두 경로 모두에서 막힌다(I1/I2 와 짝).
    function test_aLockedHolderIsRejectedOnTheLatePathToo() public {
        vm.prank(ALICE);
        identity.lockDevice(ALICE);
        vm.warp(ISSUED + 2 hours);

        vm.expectRevert(Ticket.DeviceLocked.selector);
        ticket.checkInForLate(tokenId, _code(), gsig, _sig());
    }
}

/// @notice 문이 코드 발급보다 13시간 늦게 열리는 행사 — 즉 코드가 창이 열리기 전에 발급됐다.
///         넓은 창이 만드는 유일한 새 위험(게이트의 서명 사전 수확)을 issuedAt 하한이 막는다.
contract TicketCheckInLatePreHarvestTest is CheckInLateBase {
    function setUp() public {
        _setUpLate(ISSUED + 13 hours, ISSUED + 20 hours);
    }

    function test_aCodeIssuedBeforeTheWindowOpensIsRejected() public {
        vm.warp(ISSUED + 14 hours);
        vm.expectRevert(Ticket.CodeExpired.selector);
        ticket.checkInForLate(tokenId, _code(), gsig, _sig());
    }
}

/// @notice 하한이 '<' 이지 '<=' 가 아님을 고정한다: 정확히 LATE_WINDOW 만큼 이른 코드는 받는다.
contract TicketCheckInLateBoundaryTest is CheckInLateBase {
    function setUp() public {
        _setUpLate(ISSUED + 12 hours, ISSUED + 20 hours);
    }

    function test_aCodeIssuedExactlyLateWindowBeforeDoorsIsAccepted() public {
        vm.warp(ISSUED + 13 hours);
        vm.prank(RELAYER);
        ticket.checkInForLate(tokenId, _code(), gsig, _sig());
        assertTrue(ticket.usedAt(tokenId) != 0, "a code issued exactly LATE_WINDOW before doors is accepted");
    }
}

/// @notice 04 가 UserOp 의 네 가스 필드를 잡을 때 쓰는 출발점(I10). 두 경로를 **같은 픽스처
///         위에서** 나란히 잰다. 픽스처는 setUp 에, 즉 별도 트랜잭션에 둔다 — 같은 트랜잭션에서
///         재면 계정과 슬롯이 이미 따뜻해서 게이트 폰이 실제로 내는 값보다 한참 낮게 나온다.
contract CheckInLateGasTest is CheckInLateBase {
    /// @dev 스펙 8.3 은 스폰서된 UserOp 전체에 275k 를 준다. 호출 자체에 200k 를 주는 배분이며,
    ///      아래 로그가 실제 여유를 그대로 찍는다.
    uint256 internal constant CHECK_IN_GAS_CEILING = 200_000;

    function setUp() public {
        _setUpLate(ISSUED, ISSUED + 6 hours);
    }

    /// @dev 대조군. 같은 코드·같은 서명이 발급 직후에 도착하면 이만큼 든다.
    function test_checkInGasOnThisFixture() public {
        vm.warp(ISSUED + 5);
        Ticket.GateCode memory g = _code();
        bytes memory gs = gsig;
        bytes memory sig = _sig();
        Ticket t = ticket;
        uint256 id = tokenId;

        vm.prank(RELAYER);
        uint256 before = gasleft();
        t.checkInFor(id, g, gs, sig);
        uint256 used = before - gasleft();

        assertTrue(ticket.usedAt(id) != 0, "the measured call must be a real check-in");
        emit log_named_uint("checkInFor gas (local osaka, shared fixture)", used);
        assertLt(used, CHECK_IN_GAS_CEILING, "spec 8.3 budgets 275k for the whole user op; the call gets 200k");
    }

    /// @dev 늦은 경로. 같은 `_admit` 을 타지만 제출 기한을 재느라 `endsAt` 을 한 번 더 읽는다.
    function test_checkInLateGas() public {
        vm.warp(ISSUED + 1 hours);
        Ticket.GateCode memory g = _code();
        bytes memory gs = gsig;
        bytes memory sig = _sig();
        Ticket t = ticket;
        uint256 id = tokenId;

        vm.prank(RELAYER);
        uint256 before = gasleft();
        t.checkInForLate(id, g, gs, sig);
        uint256 used = before - gasleft();

        assertTrue(ticket.usedAt(id) != 0, "the measured call must be a real late check-in");
        emit log_named_uint("checkInForLate gas (local osaka)", used);
        emit log_named_uint("margin under the 200k call budget (gas)", CHECK_IN_GAS_CEILING - used);
        assertLt(used, CHECK_IN_GAS_CEILING, "spec 8.3 budgets 275k for the whole user op; the call gets 200k");
    }
}
