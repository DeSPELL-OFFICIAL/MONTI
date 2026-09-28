// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {MontiTest} from "./Base.t.sol";
import {P256} from "solady/utils/P256.sol";
import {Ticket} from "../src/Ticket.sol";
import {P256Vectors} from "./utils/P256Vectors.sol";

/// @notice 릴레이된 현장 입장(설계 §4). 게이트 권한은 이제 msg.sender 가 아니라 게이트 키(kx,ky)에
///         대한 게이트 코드 P-256 서명이 증명하므로, 입장은 게이트도 관객도 아닌 임의 RELAYER 가
///         제출한다(permissionless). 슬림 저장(§12)으로 checkInOf 는 ts(== usedAt)만 채우고
///         gateId·nonceHash 는 0 이며, 그 둘은 CheckedIn 이벤트에서만 읽는다 — 그래서 성공 경로는
///         expectEmit(CheckedIn) 으로 gateId·nonceHash 를 검증한다.
contract TicketCheckInTest is MontiTest {
    uint256 internal orgId;
    uint256 internal eventId;
    uint256 internal tokenId;
    uint256 internal gateAId;
    uint256 internal gateBId;

    /// @dev 서명은 setUp 에서 한 번 만들어 들고 있는다. 게이트/기기 서명 모두 sha256 프리컴파일과
    ///      vm.signP256 을 부르므로, 본문에서 prank/expectRevert 뒤에 만들면 그 치트코드를 먹는다.
    bytes internal sigA;
    bytes internal sigB;
    bytes internal foreignSigA;
    bytes internal gsigA;
    bytes internal gsigB;

    bytes32 internal constant NONCE_HASH = keccak256(abi.encode(P256Vectors.NONCE));

    event CheckedIn(
        uint256 indexed tokenId, uint256 indexed eventId, uint256 indexed gateId, bytes32 nonceHash, uint64 ts
    );

    function setUp() public {
        _deployMonti();
        _memberWithDeviceKey(ALICE, 0xA1A1);
        orgId = _org();
        eventId = _freeEvent(orgId, 1, 1, true);
        assertEq(eventId, P256Vectors.EVENT_ID, "vectors were generated for event 1");

        tokenId = _claimForFixture(ALICE, eventId, 0);

        // 릴레이 전환 후 게이트는 진짜 P-256 키(GATE_KX/GATE_KY)로 등록해야 게이트 서명이 통과한다.
        vm.startPrank(ORG_OWNER);
        gateAId = organizers.registerGate(eventId, GATE_A, GATE_KX, GATE_KY);
        gateBId = organizers.registerGate(eventId, GATE_B, GATE_KX, GATE_KY);
        organizers.openGate(gateAId);
        organizers.openGate(gateBId);
        vm.stopPrank();
        assertEq(gateAId, P256Vectors.GATE1_ID, "vectors were generated for gate 1");
        assertEq(gateBId, P256Vectors.GATE2_ID, "vectors were generated for gate 2");

        vm.warp(P256Vectors.ISSUED_AT + 5);

        sigA = _deviceSig(tokenId, _code(gateAId));
        sigB = _deviceSig(tokenId, _code(gateBId));
        foreignSigA = _foreignDeviceSig(tokenId, _code(gateAId));
        gsigA = _gateSig(_code(gateAId));
        gsigB = _gateSig(_code(gateBId));
    }

    function _code(uint256 gateId) internal pure returns (Ticket.GateCode memory) {
        return Ticket.GateCode({
            gateId: gateId, eventId: P256Vectors.EVENT_ID, issuedAt: P256Vectors.ISSUED_AT, nonce: P256Vectors.NONCE
        });
    }

    function test_openGateChecksInWithTheDeviceSignature() public {
        vm.expectEmit(true, true, true, true);
        emit CheckedIn(tokenId, eventId, gateAId, NONCE_HASH, uint64(P256Vectors.ISSUED_AT + 5));
        vm.prank(RELAYER);
        ticket.checkInFor(tokenId, _code(gateAId), gsigA, sigA);

        // 슬림 저장: 온체인에 남는 것은 usedAt(ts)뿐, gateId·nonceHash 는 0 이다(설계 §12-2).
        Ticket.CheckIn memory c = ticket.checkInOf(tokenId);
        assertEq(c.ts, uint64(P256Vectors.ISSUED_AT + 5));
        assertEq(c.gateId, 0, "slim storage keeps no gateId");
        assertEq(c.nonceHash, bytes32(0), "slim storage keeps no nonceHash");
        assertFalse(c.manual);
        assertEq(ticket.usedAt(tokenId), uint32(P256Vectors.ISSUED_AT + 5));
    }

    /// @dev The vectors carry a second gate so the happy path is not accidentally hard-wired to gate 1:
    ///      the digest covers gateId, so gate B needs its own signature and gets its own record.
    function test_theSecondOpenGateChecksInWithItsOwnSignature() public {
        vm.expectEmit(true, true, true, true);
        emit CheckedIn(tokenId, eventId, gateBId, NONCE_HASH, uint64(P256Vectors.ISSUED_AT + 5));
        vm.prank(RELAYER);
        ticket.checkInFor(tokenId, _code(gateBId), gsigB, sigB);

        assertEq(ticket.usedAt(tokenId), uint32(P256Vectors.ISSUED_AT + 5));
    }

    /// @dev 게이트도 관객도 아닌 임의 EOA 가 유효한 (게이트 서명, 기기 서명) 튜플을 대신 제출할 수
    ///      있다 — msg.sender 는 인가에 쓰이지 않는다(설계 §4, permissionless).
    function test_anArbitraryRelayerCanSubmitTheTuple() public {
        address randomRelayer = address(0xBEEF);
        vm.prank(randomRelayer);
        ticket.checkInFor(tokenId, _code(gateAId), gsigA, sigA);
        assertEq(ticket.usedAt(tokenId), uint32(P256Vectors.ISSUED_AT + 5));
    }

    /// @dev A live offer must not survive admission: the ticket is spent, so the pending handoff dies
    ///      with it rather than letting the recipient accept a ticket that is already inside.
    function test_checkInCancelsAPendingOffer() public {
        vm.prank(ALICE);
        ticket.createOffer(tokenId, keccak256("010-1234-5678"), uint64(block.timestamp + 1 hours));

        vm.expectEmit(true, false, false, false);
        emit Ticket.OfferCancelled(tokenId);
        vm.prank(RELAYER);
        ticket.checkInFor(tokenId, _code(gateAId), gsigA, sigA);

        assertEq(ticket.offerOf(tokenId).from, address(0));
    }

    /// @dev 다이제스트 정의가 컨트랙트 안(_deviceDigest)과 테스트 헬퍼 안 두 곳에 있으므로,
    ///      둘이 같은 바이트를 만든다는 것을 여기서 증명한다. 증명 방법은 우회로가 없다: 컨트랙트
    ///      쪽 정의로 만든 서명이 실제로 문을 통과하는지 본다. 어긋나면 이 한 줄이 빨개진다.
    function test_theDigestIsBoundToThisChainAndThisTicket() public {
        Ticket.GateCode memory g = _code(gateAId);
        bytes32 expected =
            sha256(abi.encode(block.chainid, address(ticket), tokenId, g.gateId, g.eventId, g.nonce, g.issuedAt));
        assertEq(_deviceDigest(tokenId, g), expected, "the helper must hash what the spec says");
        // 03/04 가 자기 계산을 대조할 창구. 셋이 같은 값이어야 한다.
        assertEq(
            ticket.deviceDigest(tokenId, g.gateId, g.eventId, g.nonce, g.issuedAt),
            expected,
            "the public view must hand out the same bytes"
        );

        vm.prank(RELAYER);
        ticket.checkInFor(tokenId, g, gsigA, sigA);
        assertEq(ticket.usedAt(tokenId), uint32(P256Vectors.ISSUED_AT + 5), "and the contract must hash the same bytes");
    }

    /// @dev Gap 2 의 본론. 도메인 두 워드가 없던 시절의 다이제스트로 서명하면 들어올 수 없다.
    ///      게이트 서명은 유효하므로 revert 는 기기 서명 단계에서 난다.
    function test_aSignatureOverTheOldFiveFieldDigestIsRefused() public {
        Ticket.GateCode memory g = _code(gateAId);
        bytes32 old5 = sha256(abi.encode(tokenId, g.gateId, g.eventId, g.nonce, g.issuedAt));
        (bytes32 r, bytes32 s) = vm.signP256(P256Vectors.DEVICE_PRIV, old5);

        vm.expectRevert(Ticket.BadDeviceSignature.selector);
        ticket.checkInFor(tokenId, g, gsigA, abi.encode(r, s));
    }

    /// @dev 다른 체인이나 다른 배포본을 위해 만든 서명도 마찬가지다.
    function test_aSignatureForAnotherChainOrAnotherTicketIsRefused() public {
        Ticket.GateCode memory g = _code(gateAId);

        bytes32 otherChain =
            sha256(abi.encode(uint256(1), address(ticket), tokenId, g.gateId, g.eventId, g.nonce, g.issuedAt));
        (bytes32 r, bytes32 s) = vm.signP256(P256Vectors.DEVICE_PRIV, otherChain);
        vm.expectRevert(Ticket.BadDeviceSignature.selector);
        ticket.checkInFor(tokenId, g, gsigA, abi.encode(r, s));

        bytes32 otherTicket =
            sha256(abi.encode(block.chainid, address(0xDEAD), tokenId, g.gateId, g.eventId, g.nonce, g.issuedAt));
        (r, s) = vm.signP256(P256Vectors.DEVICE_PRIV, otherTicket);
        vm.expectRevert(Ticket.BadDeviceSignature.selector);
        ticket.checkInFor(tokenId, g, gsigA, abi.encode(r, s));
    }

    /// @dev `checkInOf` 의 **와이어 순서**를 못박는다. 슬림 저장으로 gateId·nonceHash 는 0 이지만
    ///      viem·Envio 가 디코딩하는 순서는 그대로여야 한다:
    ///      (uint256 gateId, bytes32 nonceHash, uint64 ts, bool manual, bool late).
    function test_checkInOfDecodesInTheDocumentedOrder() public {
        vm.prank(RELAYER);
        ticket.checkInFor(tokenId, _code(gateAId), gsigA, sigA);

        (bool ok, bytes memory ret) = address(ticket).staticcall(abi.encodeWithSignature("checkInOf(uint256)", tokenId));
        assertTrue(ok);
        (uint256 gateId_, bytes32 nonceHash_, uint64 ts_, bool manual_, bool late_) =
            abi.decode(ret, (uint256, bytes32, uint64, bool, bool));

        assertEq(gateId_, 0, "word 0 is the gateId (zero under slim storage)");
        assertEq(nonceHash_, bytes32(0), "word 1 is the nonce hash (zero under slim storage)");
        assertEq(ts_, uint64(P256Vectors.ISSUED_AT + 5), "word 2 is the timestamp");
        assertFalse(manual_, "word 3 is manual");
        assertFalse(late_, "word 4 is late");
    }

    /// @dev 등록되지 않은(가짜) 게이트 id 는 gateInfo 가 eventId 0 으로 보고하므로 막힌다(T14).
    function test_T14_unregisteredGateRejected() public {
        Ticket.GateCode memory g = _code(4242);
        bytes memory gs = _gateSig(g);
        bytes memory ds = _deviceSig(tokenId, g);
        vm.expectRevert(Ticket.GateNotOpen.selector);
        ticket.checkInFor(tokenId, g, gs, ds);
    }

    /// @dev 게이트 코드에 게이트 키가 아닌 키로 서명하면(위조 게이트 서명) 문이 막힌다(설계 §4).
    function test_forgedGateSignatureRejected() public {
        bytes memory forgedGate = _foreignGateSig(_code(gateAId));
        vm.expectRevert(Ticket.BadGateSignature.selector);
        ticket.checkInFor(tokenId, _code(gateAId), forgedGate, sigA);
    }

    /// @dev 길이가 틀린 게이트 서명도 이름 있는 DENY 다(디코더 패닉이 아니라).
    function test_malformedGateSignatureRejected() public {
        vm.expectRevert(Ticket.BadGateSignature.selector);
        ticket.checkInFor(tokenId, _code(gateAId), new bytes(63), sigA);
    }

    function test_closedGateRejected() public {
        vm.prank(ORG_OWNER);
        organizers.closeGate(gateAId);
        vm.expectRevert(Ticket.GateNotOpen.selector);
        ticket.checkInFor(tokenId, _code(gateAId), gsigA, sigA);
    }

    function test_revokedGateRejected() public {
        vm.prank(ORG_OWNER);
        organizers.revokeGate(gateAId);
        vm.expectRevert(Ticket.GateNotOpen.selector);
        ticket.checkInFor(tokenId, _code(gateAId), gsigA, sigA);
    }

    function test_T2_staleCodeRejectedAfterSixtySeconds() public {
        vm.warp(P256Vectors.ISSUED_AT + 61);
        vm.expectRevert(Ticket.CodeExpired.selector);
        ticket.checkInFor(tokenId, _code(gateAId), gsigA, sigA);
    }

    function test_codeAtExactlySixtySecondsStillWorks() public {
        vm.warp(P256Vectors.ISSUED_AT + 60);
        vm.prank(RELAYER);
        ticket.checkInFor(tokenId, _code(gateAId), gsigA, sigA);
        assertEq(ticket.usedAt(tokenId), uint32(P256Vectors.ISSUED_AT + 60));
    }

    /// @dev A gate phone whose clock runs ahead of the chain still admits: the code may be stamped up
    ///      to CLOCK_SKEW seconds in the future before it is treated as a fake.
    function test_codeFiveSecondsAheadOfTheChainStillWorks() public {
        vm.warp(P256Vectors.ISSUED_AT - 5);
        vm.prank(RELAYER);
        ticket.checkInFor(tokenId, _code(gateAId), gsigA, sigA);
        assertEq(ticket.usedAt(tokenId), uint32(P256Vectors.ISSUED_AT - 5));
    }

    function test_futureCodeBeyondTheSkewGraceRejected() public {
        vm.warp(P256Vectors.ISSUED_AT - 6);
        vm.expectRevert(Ticket.CodeExpired.selector);
        ticket.checkInFor(tokenId, _code(gateAId), gsigA, sigA);
    }

    /// @dev 회전 뒤 티켓은 잠시 옛 계정에 남아 있다(새 계정이 migrate 하기 전까지).
    ///      그 사이에 옛 폰이 걸어 들어오면 안 된다.
    function test_rotatedAwayHolderCannotCheckIn() public {
        vm.warp(P256Vectors.ISSUED_AT + 7 days);
        vm.prank(attester);
        identity.rotateAccount(bytes32(uint256(0xA1A1)), CAROL);
        vm.warp(P256Vectors.ISSUED_AT + 5);

        vm.expectRevert(Ticket.NotMember.selector);
        ticket.checkInFor(tokenId, _code(gateAId), gsigA, sigA);
    }

    /// @dev C2. (r, N - s) 는 같은 메시지·같은 키에 대해 암호학적으로 유효한 서명이라 0x100 은
    ///      1을 돌려준다. 그런데도 거절된다면 그 거절은 Solady 의 low-s 검사가 한 것이다.
    function test_C2_highSSignatureRejected() public {
        (bytes32 r, bytes32 s) = _deviceRS(P256Vectors.DEVICE_PRIV, tokenId, _code(gateAId));
        uint256 highS = P256.N - uint256(s);
        assertGt(highS, P256.N / 2, "the counterpart of a low-s signature is high-s");

        vm.expectRevert(Ticket.BadDeviceSignature.selector);
        ticket.checkInFor(tokenId, _code(gateAId), gsigA, abi.encode(r, bytes32(highS)));
    }

    /// @dev 같은 벡터의 low-s 쪽은 통과한다. 위 테스트가 '서명이 틀려서'가 아니라 '고-s 라서'
    ///      거절됐음을 이 한 쌍이 함께 증명한다.
    function test_C2_theLowSCounterpartOfTheSameSignatureIsAccepted() public {
        (, bytes32 s) = _deviceRS(P256Vectors.DEVICE_PRIV, tokenId, _code(gateAId));
        assertLt(uint256(s), P256.N / 2, "vm.signP256 normalises to low-s, as 03/04 must");
        vm.prank(RELAYER);
        ticket.checkInFor(tokenId, _code(gateAId), gsigA, sigA);
        assertEq(ticket.usedAt(tokenId), uint32(P256Vectors.ISSUED_AT + 5));
    }

    function test_T6_wrongDeviceKeyRejected() public {
        vm.expectRevert(Ticket.BadDeviceSignature.selector);
        ticket.checkInFor(tokenId, _code(gateAId), gsigA, foreignSigA);
    }

    /// @dev A malformed blob is a DENY with a name, not a decoder panic the staff screen cannot map.
    function test_malformedDeviceSignatureRejected() public {
        vm.expectRevert(Ticket.BadDeviceSignature.selector);
        ticket.checkInFor(tokenId, _code(gateAId), gsigA, new bytes(63));
    }

    /// @dev T2 (spec 6.3): the nonce is inside both signed digests. A valid gate signature over the
    ///      mutated code passes the gate, and then the attendee signature (bound to the old nonce)
    ///      refuses it — so a captured device tap does not travel to a freshly issued number.
    function test_T2_validSignatureWithAMutatedNonceRejected() public {
        Ticket.GateCode memory replayed = _code(gateAId);
        replayed.nonce = keccak256("a number the phone never signed");
        bytes memory gsReplayed = _gateSig(replayed);
        vm.expectRevert(Ticket.BadDeviceSignature.selector);
        ticket.checkInFor(tokenId, replayed, gsReplayed, sigA);
        assertEq(ticket.usedAt(tokenId), 0);
    }

    function test_T12_doubleCheckInRejected() public {
        vm.prank(RELAYER);
        ticket.checkInFor(tokenId, _code(gateAId), gsigA, sigA);
        vm.expectRevert(Ticket.AlreadyCheckedIn.selector);
        ticket.checkInFor(tokenId, _code(gateAId), gsigA, sigA);
    }

    function test_T13_secondGateRevertsForTheSameTicket() public {
        vm.prank(RELAYER);
        ticket.checkInFor(tokenId, _code(gateAId), gsigA, sigA);
        vm.expectRevert(Ticket.AlreadyCheckedIn.selector);
        ticket.checkInFor(tokenId, _code(gateBId), gsigB, sigB);
    }

    function test_T7_lockedDeviceRejected() public {
        vm.prank(ALICE);
        identity.lockDevice(ALICE);
        vm.expectRevert(Ticket.DeviceLocked.selector);
        ticket.checkInFor(tokenId, _code(gateAId), gsigA, sigA);
    }

    function test_wrongEventRejected() public {
        Ticket.GateCode memory bad = _code(gateAId);
        bad.eventId = 99;
        vm.expectRevert(Ticket.WrongEvent.selector);
        ticket.checkInFor(tokenId, bad, gsigA, sigA);
    }

    function test_unknownTicketRejected() public {
        vm.expectRevert(Ticket.NoSuchTicket.selector);
        ticket.checkInFor(4242, _code(gateAId), gsigA, sigA);
    }

    function test_endedEventRejected() public {
        vm.warp(T0 + 2 days + 1);
        vm.expectRevert(Ticket.EventEnded.selector);
        ticket.checkInFor(tokenId, _code(gateAId), gsigA, sigA);
    }

    function test_cancelledEventRejected() public {
        vm.prank(ORG_OWNER);
        ticket.cancelEvent(eventId);
        vm.expectRevert(Ticket.EventCancelled.selector);
        ticket.checkInFor(tokenId, _code(gateAId), gsigA, sigA);
    }

    /// @dev A voided ticket is a DENY at the door even with a perfect tap (Task 23).
    function test_revokedTicketRejected() public {
        vm.prank(ORG_OWNER);
        ticket.revoke(tokenId, 2);
        vm.expectRevert(Ticket.TicketRevoked.selector);
        ticket.checkInFor(tokenId, _code(gateAId), gsigA, sigA);
        assertEq(ticket.usedAt(tokenId), 0);
    }
}
