// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {MontiTest} from "./Base.t.sol";
import {Ticket} from "../src/Ticket.sol";
import {P256} from "solady/utils/P256.sol";
import {P256Vectors} from "./utils/P256Vectors.sol";

/// @notice 스펙 12 의 오프라인 큐. 벡터가 event 1 / token 1 / gate 1 에 묶여 있으므로 각 시나리오는
///         자기 배포 위에서 그 세 id 를 처음부터 만든다. 행사 일정만 바꿔 가며 창의 양 끝을 본다.
abstract contract CheckInLateBase is MontiTest {
    uint256 internal orgId;
    uint256 internal eventId;
    uint256 internal tokenId;
    uint256 internal gateId;

    uint64 internal constant ISSUED = uint64(P256Vectors.ISSUED_AT);

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
        eventId = ticket.createEvent(m, t);
        ticket.publishEvent(eventId);
        vm.stopPrank();

        vm.prank(ALICE);
        tokenId = ticket.claim(eventId, 0, "");

        vm.startPrank(ORG_OWNER);
        gateId = organizers.registerGate(eventId, GATE_A, bytes32(uint256(0x6A01)), bytes32(uint256(0x6A02)));
        organizers.openGate(gateId);
        vm.stopPrank();

        assertEq(eventId, P256Vectors.EVENT_ID, "vectors were generated for event 1");
        assertEq(tokenId, P256Vectors.TOKEN_ID, "vectors were generated for token 1");
        assertEq(gateId, P256Vectors.GATE1_ID, "vectors were generated for gate 1");
    }

    function _code() internal pure returns (Ticket.GateCode memory) {
        return Ticket.GateCode({
            gateId: P256Vectors.GATE1_ID,
            eventId: P256Vectors.EVENT_ID,
            issuedAt: P256Vectors.ISSUED_AT,
            nonce: P256Vectors.NONCE
        });
    }

    function _sig() internal pure returns (bytes memory) {
        return abi.encode(P256Vectors.GATE1_R, P256Vectors.GATE1_S);
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

        vm.prank(GATE_A);
        vm.expectRevert(Ticket.CodeExpired.selector);
        ticket.checkIn(tokenId, _code(), _sig());

        vm.expectEmit(true, true, false, true);
        emit CheckedInLate(tokenId, gateId, ISSUED, ISSUED + 1 hours);
        vm.expectEmit(true, true, true, true);
        emit CheckedIn(tokenId, eventId, gateId, keccak256(abi.encode(P256Vectors.NONCE)), ISSUED + 1 hours);
        vm.prank(GATE_A);
        ticket.checkInLate(tokenId, _code(), _sig());

        Ticket.CheckIn memory c = ticket.checkInOf(tokenId);
        assertEq(c.gateId, gateId);
        assertEq(c.ts, ISSUED + 1 hours);
        assertEq(c.nonceHash, keccak256(abi.encode(P256Vectors.NONCE)));
        assertFalse(c.manual, "a queued tap is not a manual override");
        assertTrue(c.late, "the record says the queue flushed it");
    }

    function test_theQueueStillFlushesAfterTheEventEnds() public {
        vm.warp(ISSUED + 6 hours + 11 hours);
        vm.prank(GATE_A);
        ticket.checkInLate(tokenId, _code(), _sig());
        assertTrue(ticket.checkInOf(tokenId).late);
    }

    function test_theFlushDeadlineIsExactlyLateWindowAfterTheEventEnds() public {
        vm.warp(ISSUED + 6 hours + 12 hours);
        vm.prank(GATE_A);
        ticket.checkInLate(tokenId, _code(), _sig());
        assertTrue(ticket.checkInOf(tokenId).late);
    }

    function test_oneSecondPastTheFlushDeadlineIsRejected() public {
        vm.warp(ISSUED + 6 hours + 12 hours + 1);
        vm.prank(GATE_A);
        vm.expectRevert(Ticket.EventEnded.selector);
        ticket.checkInLate(tokenId, _code(), _sig());
    }

    /// @dev 현장 경로는 폐장 순간 그대로 닫힌다. 넓어진 것은 기록 경로뿐이다.
    function test_theLiveDoorStillClosesAtEndsAt() public {
        vm.warp(ISSUED + 6 hours + 1);
        vm.prank(GATE_A);
        vm.expectRevert(Ticket.EventEnded.selector);
        ticket.checkIn(tokenId, _code(), _sig());
    }

    /// @dev 열림은 문을 여닫는 스위치이지 권한이 아니다. 닫힌 게이트도 자기 장부는 정리한다.
    function test_aClosedGateCanStillFlushItsQueue() public {
        vm.prank(ORG_OWNER);
        organizers.closeGate(gateId);
        vm.warp(ISSUED + 2 hours);

        vm.prank(GATE_A);
        vm.expectRevert(Ticket.GateNotOpen.selector);
        ticket.checkIn(tokenId, _code(), _sig());

        vm.prank(GATE_A);
        ticket.checkInLate(tokenId, _code(), _sig());
        assertTrue(ticket.checkInOf(tokenId).late);
    }

    /// @dev T14: 도난당한 단말기는 폐기하면 큐도 못 흘린다.
    function test_T14_aRevokedGateCannotFlush() public {
        vm.prank(ORG_OWNER);
        organizers.revokeGate(gateId);
        vm.warp(ISSUED + 2 hours);

        vm.prank(GATE_A);
        vm.expectRevert(Ticket.GateNotOpen.selector);
        ticket.checkInLate(tokenId, _code(), _sig());
    }

    /// @dev 게이트 id 는 다이제스트에 묶여 있다. 다른 게이트의 큐를 대신 흘릴 수 없다.
    function test_T13_aGateCannotFlushAnotherGatesQueue() public {
        vm.startPrank(ORG_OWNER);
        uint256 gateBId = organizers.registerGate(eventId, GATE_B, bytes32(uint256(0x6B01)), bytes32(uint256(0x6B02)));
        organizers.openGate(gateBId);
        vm.stopPrank();
        vm.warp(ISSUED + 2 hours);

        vm.prank(GATE_B);
        vm.expectRevert(Ticket.GateMismatch.selector);
        ticket.checkInLate(tokenId, _code(), _sig());
    }

    /// @dev T12: 04 의 큐는 이 revert 를 '이미 기록됨 = 성공'으로 처리한다.
    function test_T12_flushingAnAlreadyAdmittedTicketReverts() public {
        vm.warp(ISSUED + 5);
        vm.prank(GATE_A);
        ticket.checkIn(tokenId, _code(), _sig());

        vm.warp(ISSUED + 2 hours);
        vm.prank(GATE_A);
        vm.expectRevert(Ticket.AlreadyCheckedIn.selector);
        ticket.checkInLate(tokenId, _code(), _sig());
        assertFalse(ticket.checkInOf(tokenId).late, "the live record stands");
    }

    /// @dev T15: 단말기 혼자서는 큐 항목을 만들 수 없다. 관객 기기 서명이 여전히 필수다.
    function test_T15_theQueueStillNeedsTheAttendeeSignature() public {
        vm.warp(ISSUED + 2 hours);
        vm.prank(GATE_A);
        vm.expectRevert(Ticket.BadDeviceSignature.selector);
        ticket.checkInLate(tokenId, _code(), abi.encode(P256Vectors.OTHER_R, P256Vectors.OTHER_S));
    }

    /// @dev C2 의 요구는 늦은 경로에도 그대로 붙는다.
    function test_C2_highSRejectedOnTheLatePathToo() public {
        vm.warp(ISSUED + 2 hours);
        vm.prank(GATE_A);
        vm.expectRevert(Ticket.BadDeviceSignature.selector);
        ticket.checkInLate(
            tokenId, _code(), abi.encode(P256Vectors.GATE1_R, bytes32(P256.N - uint256(P256Vectors.GATE1_S)))
        );
    }

    function test_aCancelledEventRejectsTheQueueToo() public {
        vm.prank(ORG_OWNER);
        ticket.cancelEvent(eventId);
        vm.warp(ISSUED + 2 hours);

        vm.prank(GATE_A);
        vm.expectRevert(Ticket.EventCancelled.selector);
        ticket.checkInLate(tokenId, _code(), _sig());
    }

    /// @dev 앞선 시계는 두 경로 모두에서 위조다. CLOCK_SKEW 는 넓히지 않았다.
    function test_aFutureCodeIsStillAForgeryOnTheLatePath() public {
        vm.warp(ISSUED - 6);
        vm.prank(GATE_A);
        vm.expectRevert(Ticket.CodeExpired.selector);
        ticket.checkInLate(tokenId, _code(), _sig());
    }

    /// @dev 잠긴 기기는 두 경로 모두에서 막힌다(I1/I2 와 짝).
    function test_aLockedHolderIsRejectedOnTheLatePathToo() public {
        vm.prank(ALICE);
        identity.lockDevice(ALICE);
        vm.warp(ISSUED + 2 hours);

        vm.prank(GATE_A);
        vm.expectRevert(Ticket.DeviceLocked.selector);
        ticket.checkInLate(tokenId, _code(), _sig());
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
        vm.prank(GATE_A);
        vm.expectRevert(Ticket.CodeExpired.selector);
        ticket.checkInLate(tokenId, _code(), _sig());
    }
}

/// @notice 하한이 '<' 이지 '<=' 가 아님을 고정한다: 정확히 LATE_WINDOW 만큼 이른 코드는 받는다.
contract TicketCheckInLateBoundaryTest is CheckInLateBase {
    function setUp() public {
        _setUpLate(ISSUED + 12 hours, ISSUED + 20 hours);
    }

    function test_aCodeIssuedExactlyLateWindowBeforeDoorsIsAccepted() public {
        vm.warp(ISSUED + 13 hours);
        vm.prank(GATE_A);
        ticket.checkInLate(tokenId, _code(), _sig());
        assertTrue(ticket.checkInOf(tokenId).late);
    }
}
