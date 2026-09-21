// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {MontiTest} from "./Base.t.sol";
import {Ticket} from "../src/Ticket.sol";
import {P256Vectors} from "./utils/P256Vectors.sol";

contract TicketOfferTest is MontiTest {
    uint256 internal orgId;
    uint256 internal eventId;
    uint256 internal tokenId;
    bytes32 internal constant COMMITMENT = keccak256("phone:+821012345678");

    event OfferCreated(uint256 indexed tokenId, address indexed from, bytes32 recipientCommitment, uint64 expiresAt);
    event OfferAccepted(uint256 indexed tokenId, address indexed from, address indexed to);
    event OfferCancelled(uint256 indexed tokenId);

    function setUp() public {
        _deployMonti();
        _memberWithDeviceKey(ALICE, 0xA1A1);
        _member(BOB, 0xB0B0);
        orgId = _org();
        eventId = _freeEvent(orgId, 1, 2, true);
        vm.prank(ALICE);
        tokenId = ticket.claim(eventId, 0, "");
    }

    function _sig(uint256 tokenId_, bytes32 commitment, address to) internal pure returns (bytes memory) {
        bytes32 digest = keccak256(abi.encode(tokenId_, commitment, to));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ATTESTER_PK, digest);
        return abi.encodePacked(r, s, v);
    }

    function test_createAndAcceptOffer() public {
        vm.expectEmit(true, true, false, true);
        emit OfferCreated(tokenId, ALICE, COMMITMENT, T0 + 1 hours);
        vm.prank(ALICE);
        ticket.createOffer(tokenId, COMMITMENT, T0 + 1 hours);

        Ticket.Offer memory o = ticket.offerOf(tokenId);
        assertEq(o.from, ALICE);
        assertEq(o.recipientCommitment, COMMITMENT);

        vm.expectEmit(true, true, true, false);
        emit OfferAccepted(tokenId, ALICE, BOB);
        vm.prank(BOB);
        ticket.acceptOffer(tokenId, _sig(tokenId, COMMITMENT, BOB));

        assertEq(ticket.ownerOf(tokenId), BOB);
        assertEq(ticket.transfersOf(tokenId), 1, "an accepted offer counts as one transfer");
        assertEq(ticket.offerOf(tokenId).from, address(0));
    }

    function test_acceptRejectsWrongAttesterSignature() public {
        vm.prank(ALICE);
        ticket.createOffer(tokenId, COMMITMENT, T0 + 1 hours);

        bytes32 digest = keccak256(abi.encode(tokenId, COMMITMENT, BOB));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(uint256(0xBADBAD), digest);
        vm.prank(BOB);
        vm.expectRevert(Ticket.BadAttesterSig.selector);
        ticket.acceptOffer(tokenId, abi.encodePacked(r, s, v));
    }

    function test_signatureIsBoundToTheAcceptingAccount() public {
        _member(CAROL, 0xCACA);
        vm.prank(ALICE);
        ticket.createOffer(tokenId, COMMITMENT, T0 + 1 hours);

        vm.prank(CAROL);
        vm.expectRevert(Ticket.BadAttesterSig.selector);
        ticket.acceptOffer(tokenId, _sig(tokenId, COMMITMENT, BOB));
    }

    function test_expiredOfferRejected() public {
        vm.prank(ALICE);
        ticket.createOffer(tokenId, COMMITMENT, T0 + 1 hours);
        vm.warp(T0 + 1 hours + 1);

        vm.prank(BOB);
        vm.expectRevert(Ticket.OfferExpired.selector);
        ticket.acceptOffer(tokenId, _sig(tokenId, COMMITMENT, BOB));
    }

    function test_offerIsVoidAfterAPlainTransfer() public {
        _member(CAROL, 0xCACA);
        vm.prank(ALICE);
        ticket.createOffer(tokenId, COMMITMENT, T0 + 1 hours);

        vm.expectEmit(true, false, false, false);
        emit OfferCancelled(tokenId);
        vm.prank(ALICE);
        ticket.transferFrom(ALICE, CAROL, tokenId);

        assertEq(ticket.offerOf(tokenId).from, address(0));
        vm.prank(BOB);
        vm.expectRevert(Ticket.NoOffer.selector);
        ticket.acceptOffer(tokenId, _sig(tokenId, COMMITMENT, BOB));
    }

    function test_acceptOfferBlockedForLevelZeroOnAKycEvent() public {
        uint256 kycEventId = _kycEvent(orgId);
        vm.prank(ALICE);
        uint256 kycToken = ticket.claim(kycEventId, 0, "");
        _memberWithLevel(address(0xD0), 0xD0D0, 0);

        vm.prank(ALICE);
        ticket.createOffer(kycToken, COMMITMENT, T0 + 1 hours);
        vm.prank(address(0xD0));
        vm.expectRevert(Ticket.KycRequired.selector);
        ticket.acceptOffer(kycToken, _sig(kycToken, COMMITMENT, address(0xD0)));
    }

    function test_onlyOwnerCreatesOrCancels() public {
        vm.prank(BOB);
        vm.expectRevert(Ticket.Unauthorized.selector);
        ticket.createOffer(tokenId, COMMITMENT, T0 + 1 hours);

        vm.prank(ALICE);
        ticket.createOffer(tokenId, COMMITMENT, T0 + 1 hours);
        vm.prank(BOB);
        vm.expectRevert(Ticket.Unauthorized.selector);
        ticket.cancelOffer(tokenId);

        vm.prank(ALICE);
        ticket.cancelOffer(tokenId);
        assertEq(ticket.offerOf(tokenId).from, address(0));
    }

    /// @dev The cutoff instant itself is closed for a transfer, so an offer created at that instant
    ///      could never be collected. `createOffer` closes on the same boundary `_update` does.
    function test_createOfferAtExactCutoffReverts() public {
        vm.warp(T0 + 1 days - 2 hours);
        vm.prank(ALICE);
        vm.expectRevert(Ticket.TransferCutoffPassed.selector);
        ticket.createOffer(tokenId, COMMITMENT, T0 + 1 days);
    }

    /// @dev One second earlier the handoff still completes, which is the boundary's other side.
    function test_offerCreatedOneSecondBeforeTheCutoffIsStillCollectable() public {
        vm.warp(T0 + 1 days - 2 hours - 1);
        vm.prank(ALICE);
        ticket.createOffer(tokenId, COMMITMENT, T0 + 1 days);

        vm.prank(BOB);
        ticket.acceptOffer(tokenId, _sig(tokenId, COMMITMENT, BOB));
        assertEq(ticket.ownerOf(tokenId), BOB);
    }

    /// @dev Admission kills a live offer, so the recipient cannot accept a ticket that is already inside.
    function test_offerIsVoidAfterCheckIn() public {
        vm.prank(ALICE);
        ticket.createOffer(tokenId, COMMITMENT, uint64(P256Vectors.ISSUED_AT + 1 hours));

        uint256 gateId;
        vm.startPrank(ORG_OWNER);
        gateId = organizers.registerGate(eventId, GATE_A, bytes32(uint256(0x6A01)), bytes32(uint256(0x6A02)));
        organizers.openGate(gateId);
        vm.stopPrank();

        vm.warp(P256Vectors.ISSUED_AT + 5);
        vm.prank(GATE_A);
        ticket.checkIn(
            tokenId,
            Ticket.GateCode({
                gateId: gateId, eventId: P256Vectors.EVENT_ID, issuedAt: P256Vectors.ISSUED_AT, nonce: P256Vectors.NONCE
            }),
            abi.encode(P256Vectors.GATE1_R, P256Vectors.GATE1_S)
        );

        assertEq(ticket.offerOf(tokenId).from, address(0));
        vm.prank(BOB);
        vm.expectRevert(Ticket.NoOffer.selector);
        ticket.acceptOffer(tokenId, _sig(tokenId, COMMITMENT, BOB));
    }
}
