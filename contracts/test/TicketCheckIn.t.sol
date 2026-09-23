// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {MontiTest} from "./Base.t.sol";
import {P256} from "solady/utils/P256.sol";
import {Ticket} from "../src/Ticket.sol";
import {P256Vectors} from "./utils/P256Vectors.sol";

contract TicketCheckInTest is MontiTest {
    uint256 internal orgId;
    uint256 internal eventId;
    uint256 internal tokenId;
    uint256 internal gateAId;
    uint256 internal gateBId;

    /// @dev 서명은 setUp 에서 한 번 만들어 들고 있는다. _deviceSig 는 sha256 프리컴파일과
    ///      vm.signP256 을 부르므로, 테스트 본문에서 prank/expectRevert 뒤에 부르면 그 치트코드를
    ///      먹어 치운다. 캐시는 그 함정을 통째로 없앤다 — 그리고 다이제스트가 이 배포본에 묶여
    ///      있으므로 setUp 이 배포를 마친 뒤에 만들어야 한다.
    bytes internal sigA;
    bytes internal sigB;
    bytes internal foreignSigA;

    event CheckedIn(
        uint256 indexed tokenId, uint256 indexed eventId, uint256 indexed gateId, bytes32 nonceHash, uint64 ts
    );

    function setUp() public {
        _deployMonti();
        _memberWithDeviceKey(ALICE, 0xA1A1);
        orgId = _org();
        eventId = _freeEvent(orgId, 1, 1, true);
        assertEq(eventId, P256Vectors.EVENT_ID, "vectors were generated for event 1");

        vm.prank(ALICE);
        tokenId = ticket.claim(eventId, 0, "");
        assertEq(tokenId, P256Vectors.TOKEN_ID, "vectors were generated for token 1");

        vm.startPrank(ORG_OWNER);
        gateAId = organizers.registerGate(eventId, GATE_A, bytes32(uint256(0x6A01)), bytes32(uint256(0x6A02)));
        gateBId = organizers.registerGate(eventId, GATE_B, bytes32(uint256(0x6B01)), bytes32(uint256(0x6B02)));
        organizers.openGate(gateAId);
        organizers.openGate(gateBId);
        vm.stopPrank();
        assertEq(gateAId, P256Vectors.GATE1_ID, "vectors were generated for gate 1");
        assertEq(gateBId, P256Vectors.GATE2_ID, "vectors were generated for gate 2");

        vm.warp(P256Vectors.ISSUED_AT + 5);

        sigA = _deviceSig(tokenId, _code(gateAId));
        sigB = _deviceSig(tokenId, _code(gateBId));
        foreignSigA = _foreignDeviceSig(tokenId, _code(gateAId));
    }

    function _code(uint256 gateId) internal pure returns (Ticket.GateCode memory) {
        return Ticket.GateCode({
            gateId: gateId, eventId: P256Vectors.EVENT_ID, issuedAt: P256Vectors.ISSUED_AT, nonce: P256Vectors.NONCE
        });
    }

    function _sigA() internal view returns (bytes memory) {
        return sigA;
    }

    function _sigB() internal view returns (bytes memory) {
        return sigB;
    }

    function test_openGateChecksInWithTheDeviceSignature() public {
        vm.expectEmit(true, true, true, true);
        emit CheckedIn(
            tokenId, eventId, gateAId, keccak256(abi.encode(P256Vectors.NONCE)), uint64(P256Vectors.ISSUED_AT + 5)
        );
        vm.prank(GATE_A);
        ticket.checkIn(tokenId, _code(gateAId), _sigA());

        Ticket.CheckIn memory c = ticket.checkInOf(tokenId);
        assertEq(c.gateId, gateAId);
        assertEq(c.ts, uint64(P256Vectors.ISSUED_AT + 5));
        assertEq(c.nonceHash, keccak256(abi.encode(P256Vectors.NONCE)));
        assertFalse(c.manual);
    }

    /// @dev The vectors carry a second gate so the happy path is not accidentally hard-wired to gate 1:
    ///      the digest covers gateId, so gate B needs its own signature and gets its own record.
    function test_theSecondOpenGateChecksInWithItsOwnSignature() public {
        vm.prank(GATE_B);
        ticket.checkIn(tokenId, _code(gateBId), _sigB());

        Ticket.CheckIn memory c = ticket.checkInOf(tokenId);
        assertEq(c.gateId, gateBId);
        assertEq(c.nonceHash, keccak256(abi.encode(P256Vectors.NONCE)));
        assertFalse(c.manual);
    }

    /// @dev A live offer must not survive admission: the ticket is spent, so the pending handoff dies
    ///      with it rather than letting the recipient accept a ticket that is already inside.
    function test_checkInCancelsAPendingOffer() public {
        vm.prank(ALICE);
        ticket.createOffer(tokenId, keccak256("010-1234-5678"), uint64(block.timestamp + 1 hours));

        vm.expectEmit(true, false, false, false);
        emit Ticket.OfferCancelled(tokenId);
        vm.prank(GATE_A);
        ticket.checkIn(tokenId, _code(gateAId), _sigA());

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

        vm.prank(GATE_A);
        ticket.checkIn(tokenId, g, sigA);
        assertEq(ticket.checkInOf(tokenId).gateId, gateAId, "and the contract must hash the same bytes");
    }

    /// @dev Gap 2 의 본론. 도메인 두 워드가 없던 시절의 다이제스트로 서명하면 들어올 수 없다.
    function test_aSignatureOverTheOldFiveFieldDigestIsRefused() public {
        Ticket.GateCode memory g = _code(gateAId);
        bytes32 old5 = sha256(abi.encode(tokenId, g.gateId, g.eventId, g.nonce, g.issuedAt));
        (bytes32 r, bytes32 s) = vm.signP256(P256Vectors.DEVICE_PRIV, old5);

        vm.prank(GATE_A);
        vm.expectRevert(Ticket.BadDeviceSignature.selector);
        ticket.checkIn(tokenId, g, abi.encode(r, s));
    }

    /// @dev 다른 체인이나 다른 배포본을 위해 만든 서명도 마찬가지다. 그것이 이 변경의 목적이다:
    ///      붙잡아 둔 탭 하나를 재배포본이나 다른 체인에 되풀어 넣을 수 없다.
    function test_aSignatureForAnotherChainOrAnotherTicketIsRefused() public {
        Ticket.GateCode memory g = _code(gateAId);

        bytes32 otherChain =
            sha256(abi.encode(uint256(1), address(ticket), tokenId, g.gateId, g.eventId, g.nonce, g.issuedAt));
        (bytes32 r, bytes32 s) = vm.signP256(P256Vectors.DEVICE_PRIV, otherChain);
        vm.prank(GATE_A);
        vm.expectRevert(Ticket.BadDeviceSignature.selector);
        ticket.checkIn(tokenId, g, abi.encode(r, s));

        bytes32 otherTicket =
            sha256(abi.encode(block.chainid, address(0xDEAD), tokenId, g.gateId, g.eventId, g.nonce, g.issuedAt));
        (r, s) = vm.signP256(P256Vectors.DEVICE_PRIV, otherTicket);
        vm.prank(GATE_A);
        vm.expectRevert(Ticket.BadDeviceSignature.selector);
        ticket.checkIn(tokenId, g, abi.encode(r, s));
    }

    /// @dev `checkInOf` 의 **와이어 순서**를 못박는다. 구조체 필드 이름으로 읽는 Solidity 쪽은
    ///      순서가 바뀌어도 조용히 통과하지만, viem 과 Envio 는 ABI 순서 그대로 디코딩한다.
    ///      순서: (uint256 gateId, bytes32 nonceHash, uint64 ts, bool manual, bool late).
    function test_checkInOfDecodesInTheDocumentedOrder() public {
        vm.prank(GATE_A);
        ticket.checkIn(tokenId, _code(gateAId), sigA);

        (bool ok, bytes memory ret) = address(ticket).staticcall(abi.encodeWithSignature("checkInOf(uint256)", tokenId));
        assertTrue(ok);
        (uint256 gateId_, bytes32 nonceHash_, uint64 ts_, bool manual_, bool late_) =
            abi.decode(ret, (uint256, bytes32, uint64, bool, bool));

        assertEq(gateId_, gateAId, "word 0 is the gateId");
        assertEq(nonceHash_, keccak256(abi.encode(P256Vectors.NONCE)), "word 1 is the nonce hash");
        assertEq(ts_, uint64(P256Vectors.ISSUED_AT + 5), "word 2 is the timestamp");
        assertFalse(manual_, "word 3 is manual");
        assertFalse(late_, "word 4 is late");
    }

    function test_T14_fakeGateRejected() public {
        vm.prank(address(0xFA4E));
        vm.expectRevert(Ticket.GateNotOpen.selector);
        ticket.checkIn(tokenId, _code(gateAId), _sigA());
    }

    function test_closedGateRejected() public {
        vm.prank(ORG_OWNER);
        organizers.closeGate(gateAId);
        vm.prank(GATE_A);
        vm.expectRevert(Ticket.GateNotOpen.selector);
        ticket.checkIn(tokenId, _code(gateAId), _sigA());
    }

    function test_revokedGateRejected() public {
        vm.prank(ORG_OWNER);
        organizers.revokeGate(gateAId);
        vm.prank(GATE_A);
        vm.expectRevert(Ticket.GateNotOpen.selector);
        ticket.checkIn(tokenId, _code(gateAId), _sigA());
    }

    function test_gateCannotUseAnotherGatesId() public {
        vm.prank(GATE_A);
        vm.expectRevert(Ticket.GateMismatch.selector);
        ticket.checkIn(tokenId, _code(gateBId), _sigB());
    }

    function test_T2_staleCodeRejectedAfterSixtySeconds() public {
        vm.warp(P256Vectors.ISSUED_AT + 61);
        vm.prank(GATE_A);
        vm.expectRevert(Ticket.CodeExpired.selector);
        ticket.checkIn(tokenId, _code(gateAId), _sigA());
    }

    function test_codeAtExactlySixtySecondsStillWorks() public {
        vm.warp(P256Vectors.ISSUED_AT + 60);
        vm.prank(GATE_A);
        ticket.checkIn(tokenId, _code(gateAId), _sigA());
        assertEq(ticket.checkInOf(tokenId).gateId, gateAId);
    }

    /// @dev A gate phone whose clock runs ahead of the chain still admits: the code may be stamped up
    ///      to CLOCK_SKEW seconds in the future before it is treated as a fake.
    function test_codeFiveSecondsAheadOfTheChainStillWorks() public {
        vm.warp(P256Vectors.ISSUED_AT - 5);
        vm.prank(GATE_A);
        ticket.checkIn(tokenId, _code(gateAId), _sigA());
        assertEq(ticket.checkInOf(tokenId).gateId, gateAId);
    }

    function test_futureCodeBeyondTheSkewGraceRejected() public {
        vm.warp(P256Vectors.ISSUED_AT - 6);
        vm.prank(GATE_A);
        vm.expectRevert(Ticket.CodeExpired.selector);
        ticket.checkIn(tokenId, _code(gateAId), _sigA());
    }

    /// @dev 회전 뒤 티켓은 잠시 옛 계정에 남아 있다(새 계정이 migrate 하기 전까지).
    ///      그 사이에 옛 폰이 걸어 들어오면 안 된다.
    function test_rotatedAwayHolderCannotCheckIn() public {
        vm.warp(P256Vectors.ISSUED_AT + 7 days);
        vm.prank(attester);
        identity.rotateAccount(bytes32(uint256(0xA1A1)), CAROL);
        vm.warp(P256Vectors.ISSUED_AT + 5);

        vm.prank(GATE_A);
        vm.expectRevert(Ticket.NotMember.selector);
        ticket.checkIn(tokenId, _code(gateAId), _sigA());
    }

    /// @dev C2. (r, N - s) 는 같은 메시지·같은 키에 대해 암호학적으로 유효한 서명이라 0x100 은
    ///      1을 돌려준다. 그런데도 거절된다면 그 거절은 Solady 의 low-s 검사가 한 것이다 —
    ///      그 검사를 지우는 뮤테이션(M6)이 바로 이 테스트를 깨뜨린다.
    ///      이 요구는 클라이언트에도 그대로 간다: 03/04 는 서명 직후 s > N/2 면 s = N - s 로
    ///      정규화해야 한다. 안 하면 정상 탭의 절반이 DENY DEVICE_MISMATCH 로 떨어진다.
    function test_C2_highSSignatureRejected() public {
        (bytes32 r, bytes32 s) = _deviceRS(P256Vectors.DEVICE_PRIV, tokenId, _code(gateAId));
        uint256 highS = P256.N - uint256(s);
        // 위 두 줄은 치트코드를 쓰므로 아래 prank 보다 반드시 먼저 와야 한다.
        assertGt(highS, P256.N / 2, "the counterpart of a low-s signature is high-s");

        vm.prank(GATE_A);
        vm.expectRevert(Ticket.BadDeviceSignature.selector);
        ticket.checkIn(tokenId, _code(gateAId), abi.encode(r, bytes32(highS)));
    }

    /// @dev 같은 벡터의 low-s 쪽은 통과한다. 위 테스트가 '서명이 틀려서'가 아니라 '고-s 라서'
    ///      거절됐음을 이 한 쌍이 함께 증명한다.
    function test_C2_theLowSCounterpartOfTheSameSignatureIsAccepted() public {
        (, bytes32 s) = _deviceRS(P256Vectors.DEVICE_PRIV, tokenId, _code(gateAId));
        assertLt(uint256(s), P256.N / 2, "vm.signP256 normalises to low-s, as 03/04 must");
        vm.prank(GATE_A);
        ticket.checkIn(tokenId, _code(gateAId), _sigA());
        assertEq(ticket.checkInOf(tokenId).gateId, gateAId);
    }

    function test_T6_wrongDeviceKeyRejected() public {
        vm.prank(GATE_A);
        vm.expectRevert(Ticket.BadDeviceSignature.selector);
        ticket.checkIn(tokenId, _code(gateAId), foreignSigA);
    }

    /// @dev A malformed blob is a DENY with a name, not a decoder panic the staff screen cannot map.
    function test_malformedDeviceSignatureRejected() public {
        vm.prank(GATE_A);
        vm.expectRevert(Ticket.BadDeviceSignature.selector);
        ticket.checkIn(tokenId, _code(gateAId), new bytes(63));
    }

    /// @dev T2 (spec 6.3): the nonce is inside the signed digest, so a valid signature captured at the
    ///      door does not travel to a freshly issued number. Without that binding this would admit.
    function test_T2_validSignatureWithAMutatedNonceRejected() public {
        Ticket.GateCode memory replayed = _code(gateAId);
        replayed.nonce = keccak256("a number the phone never signed");
        vm.prank(GATE_A);
        vm.expectRevert(Ticket.BadDeviceSignature.selector);
        ticket.checkIn(tokenId, replayed, _sigA());
        assertEq(ticket.checkInOf(tokenId).ts, 0);
    }

    function test_T12_doubleCheckInRejected() public {
        vm.prank(GATE_A);
        ticket.checkIn(tokenId, _code(gateAId), _sigA());
        vm.prank(GATE_A);
        vm.expectRevert(Ticket.AlreadyCheckedIn.selector);
        ticket.checkIn(tokenId, _code(gateAId), _sigA());
    }

    function test_T13_secondGateRevertsForTheSameTicket() public {
        vm.prank(GATE_A);
        ticket.checkIn(tokenId, _code(gateAId), _sigA());
        vm.prank(GATE_B);
        vm.expectRevert(Ticket.AlreadyCheckedIn.selector);
        ticket.checkIn(tokenId, _code(gateBId), _sigB());
    }

    function test_T7_lockedDeviceRejected() public {
        vm.prank(ALICE);
        identity.lockDevice(ALICE);
        vm.prank(GATE_A);
        vm.expectRevert(Ticket.DeviceLocked.selector);
        ticket.checkIn(tokenId, _code(gateAId), _sigA());
    }

    function test_wrongEventRejected() public {
        Ticket.GateCode memory bad = _code(gateAId);
        bad.eventId = 99;
        vm.prank(GATE_A);
        vm.expectRevert(Ticket.WrongEvent.selector);
        ticket.checkIn(tokenId, bad, _sigA());
    }

    function test_unknownTicketRejected() public {
        vm.prank(GATE_A);
        vm.expectRevert(Ticket.NoSuchTicket.selector);
        ticket.checkIn(4242, _code(gateAId), _sigA());
    }

    function test_endedEventRejected() public {
        vm.warp(T0 + 2 days + 1);
        vm.prank(GATE_A);
        vm.expectRevert(Ticket.EventEnded.selector);
        ticket.checkIn(tokenId, _code(gateAId), _sigA());
    }

    function test_cancelledEventRejected() public {
        vm.prank(ORG_OWNER);
        ticket.cancelEvent(eventId);
        vm.prank(GATE_A);
        vm.expectRevert(Ticket.EventCancelled.selector);
        ticket.checkIn(tokenId, _code(gateAId), _sigA());
    }

    /// @dev A voided ticket is a DENY at the door even with a perfect tap (Task 23).
    function test_revokedTicketRejected() public {
        vm.prank(ORG_OWNER);
        ticket.revoke(tokenId, 2);
        vm.prank(GATE_A);
        vm.expectRevert(Ticket.TicketRevoked.selector);
        ticket.checkIn(tokenId, _code(gateAId), _sigA());
        assertEq(ticket.checkInOf(tokenId).ts, 0);
    }
}
