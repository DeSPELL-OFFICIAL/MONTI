// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {MontiTest} from "./Base.t.sol";
import {Ticket} from "../src/Ticket.sol";
import {P256Vectors} from "./utils/P256Vectors.sol";

contract TicketCheckInTest is MontiTest {
    uint256 internal orgId;
    uint256 internal eventId;
    uint256 internal tokenId;
    uint256 internal gateAId;
    uint256 internal gateBId;

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
    }

    function _code(uint256 gateId) internal pure returns (Ticket.GateCode memory) {
        return Ticket.GateCode({
            gateId: gateId, eventId: P256Vectors.EVENT_ID, issuedAt: P256Vectors.ISSUED_AT, nonce: P256Vectors.NONCE
        });
    }

    function _sigA() internal pure returns (bytes memory) {
        return abi.encode(P256Vectors.GATE1_R, P256Vectors.GATE1_S);
    }

    function _sigB() internal pure returns (bytes memory) {
        return abi.encode(P256Vectors.GATE2_R, P256Vectors.GATE2_S);
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

    function test_digestMatchesTheSpecFormula() public pure {
        bytes32 expected = sha256(
            abi.encode(
                P256Vectors.TOKEN_ID,
                P256Vectors.GATE1_ID,
                P256Vectors.EVENT_ID,
                P256Vectors.NONCE,
                P256Vectors.ISSUED_AT
            )
        );
        assertEq(expected, P256Vectors.GATE1_DIGEST, "generator and contract must hash the same bytes");
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

    function test_T6_wrongDeviceKeyRejected() public {
        vm.prank(GATE_A);
        vm.expectRevert(Ticket.BadDeviceSignature.selector);
        ticket.checkIn(tokenId, _code(gateAId), abi.encode(P256Vectors.OTHER_R, P256Vectors.OTHER_S));
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
