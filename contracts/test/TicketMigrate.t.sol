// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {MontiTest} from "./Base.t.sol";
import {Ticket} from "../src/Ticket.sol";

contract TicketMigrateTest is MontiTest {
    uint256 internal orgId;
    uint256 internal eventId;
    uint256 internal tokenId;

    event Migrated(uint256 indexed tokenId, address indexed from, address indexed to);
    event Revoked(uint256 indexed tokenId, uint8 reason);
    event OfferCancelled(uint256 indexed tokenId);

    function setUp() public {
        _deployMonti();
        _memberWithDeviceKey(ALICE, 0xA1A1);
        orgId = _org();
        eventId = _freeEvent(orgId, 1, 0, true);
        vm.prank(ALICE);
        tokenId = ticket.claim(eventId, 0, "");
    }

    function _rotateAliceTo(address newAccount) internal {
        vm.warp(T0 + 7 days);
        vm.prank(attester);
        identity.rotateAccount(bytes32(uint256(0xA1A1)), newAccount);
    }

    /// @dev setUp's event allows no handoff at all (maxTransfers 0), so offer-shaped cases need an
    ///      event that permits exactly one.
    function _offerableTicket() internal returns (uint256 otherTokenId) {
        uint256 otherEventId = _freeEvent(orgId, 1, 1, true);
        vm.prank(ALICE);
        otherTokenId = ticket.claim(otherEventId, 0, "");
    }

    function _attesterSig(uint256 tokenId_, bytes32 commitment, address to) internal pure returns (bytes memory) {
        bytes32 digest = keccak256(abi.encode(tokenId_, commitment, to));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ATTESTER_PK, digest);
        return abi.encodePacked(r, s, v);
    }

    /// @dev A door of this event, so the check-in shaped cases can spend a ticket without a passkey.
    function _openGate() internal returns (uint256 gateId) {
        vm.startPrank(ORG_OWNER);
        gateId = organizers.registerGate(eventId, GATE_A, bytes32(uint256(0x6A01)), bytes32(uint256(0x6A02)));
        organizers.openGate(gateId);
        vm.stopPrank();
    }

    function test_migrateMovesTheTicketToTheRotatedAccount() public {
        _rotateAliceTo(BOB);

        vm.expectEmit(true, true, true, false);
        emit Migrated(tokenId, ALICE, BOB);
        vm.prank(BOB);
        ticket.migrate(tokenId);

        assertEq(ticket.ownerOf(tokenId), BOB);
        assertEq(ticket.transfersOf(tokenId), 0, "migrate is not a transfer");
        assertEq(ticket.balanceOfEvent(BOB, eventId), 1);
        assertEq(ticket.balanceOfEvent(ALICE, eventId), 0);
    }

    function test_onlyTheRotatedAccountCanMigrate() public {
        _rotateAliceTo(BOB);
        vm.prank(CAROL);
        vm.expectRevert(Ticket.NotRotatedAccount.selector);
        ticket.migrate(tokenId);
        vm.prank(ALICE);
        vm.expectRevert(Ticket.NotRotatedAccount.selector);
        ticket.migrate(tokenId);
    }

    function test_migrateIsANoOpErrorWhenNothingRotated() public {
        vm.prank(ALICE);
        vm.expectRevert(Ticket.NothingToMigrate.selector);
        ticket.migrate(tokenId);
    }

    function test_migrateIgnoresMaxTransfersAndCutoff() public {
        // maxTransfers is 0 for this event and we are past the transfer cutoff.
        _rotateAliceTo(BOB);
        vm.warp(T0 + 1 days - 1 minutes);
        vm.prank(BOB);
        ticket.migrate(tokenId);
        assertEq(ticket.ownerOf(tokenId), BOB);
    }

    function test_revokeBlocksTransferAndCheckIn() public {
        vm.expectEmit(true, false, false, true);
        emit Revoked(tokenId, 2);
        vm.prank(ORG_OWNER);
        ticket.revoke(tokenId, 2);

        _member(CAROL, 0xCACA);
        vm.prank(ALICE);
        vm.expectRevert(Ticket.TicketRevoked.selector);
        ticket.transferFrom(ALICE, CAROL, tokenId);
    }

    function test_onlyCreateEventPermissionRevokes() public {
        vm.prank(BOB);
        vm.expectRevert(Ticket.Unauthorized.selector);
        ticket.revoke(tokenId, 1);
    }

    function test_revokeRejectsUnknownTicket() public {
        vm.prank(ORG_OWNER);
        vm.expectRevert(Ticket.NoSuchTicket.selector);
        ticket.revoke(4242, 1);
    }

    function test_migrateRejectsUnknownTicket() public {
        vm.prank(ALICE);
        vm.expectRevert(Ticket.NoSuchTicket.selector);
        ticket.migrate(4242);
    }

    /// @dev A voided ticket must never move, not even to the same person's new account.
    function test_migrateRefusesARevokedTicket() public {
        vm.prank(ORG_OWNER);
        ticket.revoke(tokenId, 2);

        _rotateAliceTo(BOB);
        vm.prank(BOB);
        vm.expectRevert(Ticket.TicketRevoked.selector);
        ticket.migrate(tokenId);
        assertEq(ticket.ownerOf(tokenId), ALICE);
    }

    /// @dev A spent ticket has nowhere to go: the person is already inside.
    function test_migrateRefusesACheckedInTicket() public {
        uint256 gateId = _openGate();
        vm.prank(ORG_OWNER);
        ticket.manualOverride(tokenId, gateId, 3);

        _rotateAliceTo(BOB);
        vm.prank(BOB);
        vm.expectRevert(Ticket.AlreadyCheckedIn.selector);
        ticket.migrate(tokenId);
    }

    /// @dev The old account's pending handoff dies with the move, exactly as it does on a check-in.
    function test_migrateCancelsAPendingOffer() public {
        uint256 offered = _offerableTicket();
        vm.prank(ALICE);
        ticket.createOffer(offered, keccak256("010-1234-5678"), uint64(block.timestamp + 1 hours));

        _rotateAliceTo(BOB);
        vm.expectEmit(true, false, false, false);
        emit OfferCancelled(offered);
        vm.prank(BOB);
        ticket.migrate(offered);

        assertEq(ticket.offerOf(offered).from, address(0));
        assertEq(ticket.ownerOf(offered), BOB);
        assertEq(ticket.transfersOf(offered), 0, "migrate is not a transfer");
    }

    /// @dev Rotating twice is still the same person, so the counter still reads zero.
    function test_asecondMigrateStillCostsNoTransfer() public {
        _rotateAliceTo(BOB);
        vm.prank(BOB);
        ticket.migrate(tokenId);

        vm.warp(T0 + 14 days);
        vm.prank(attester);
        identity.rotateAccount(bytes32(uint256(0xA1A1)), CAROL);
        vm.prank(CAROL);
        ticket.migrate(tokenId);

        assertEq(ticket.ownerOf(tokenId), CAROL);
        assertEq(ticket.transfersOf(tokenId), 0, "migrate is never a transfer");
        assertEq(ticket.balanceOfEvent(CAROL, eventId), 1);
        assertEq(ticket.balanceOfEvent(BOB, eventId), 0);
    }

    /// @dev _internalMove is switched back off: a real handoff after a migrate still pays the rules.
    function test_transferRulesStillApplyAfterAMigrate() public {
        uint256 offered = _offerableTicket();
        uint256 offeredEvent = ticket.eventOf(offered);
        _rotateAliceTo(BOB);
        vm.warp(T0 + 1 hours);

        vm.prank(BOB);
        ticket.migrate(offered);

        _member(CAROL, 0xCACA);
        vm.prank(BOB);
        ticket.transferFrom(BOB, CAROL, offered);
        assertEq(ticket.transfersOf(offered), 1, "a real handoff still counts");
        assertEq(ticket.balanceOfEvent(CAROL, offeredEvent), 1);

        address dave = address(0xDA7E);
        _member(dave, 0xDADA);
        vm.prank(CAROL);
        vm.expectRevert(Ticket.TransferLimitReached.selector);
        ticket.transferFrom(CAROL, dave, offered);
    }

    /// @dev Revoke is a state, not a toggle: saying it twice is not an error, and the second reason
    ///      code is recorded for the audit trail just like the first.
    function test_revokeTwiceIsRecordedTwice() public {
        vm.prank(ORG_OWNER);
        ticket.revoke(tokenId, 2);

        vm.expectEmit(true, false, false, true);
        emit Revoked(tokenId, 4);
        vm.prank(ORG_OWNER);
        ticket.revoke(tokenId, 4);
    }

    /// @dev An organizer may still void a ticket after the holder walked in — the record is the point.
    function test_revokeAfterCheckInIsAllowed() public {
        uint256 gateId = _openGate();
        vm.prank(ORG_OWNER);
        ticket.manualOverride(tokenId, gateId, 3);

        vm.expectEmit(true, false, false, true);
        emit Revoked(tokenId, 9);
        vm.prank(ORG_OWNER);
        ticket.revoke(tokenId, 9);
    }

    /// @dev The recipient of a live offer cannot collect a ticket the organizer has voided.
    function test_revokedTicketCannotBeAcceptedFromAnOffer() public {
        uint256 offered = _offerableTicket();
        bytes32 commitment = keccak256("010-1234-5678");
        vm.prank(ALICE);
        ticket.createOffer(offered, commitment, uint64(block.timestamp + 1 hours));

        vm.prank(ORG_OWNER);
        ticket.revoke(offered, 2);

        _member(BOB, 0xB0B0);
        vm.prank(BOB);
        vm.expectRevert(Ticket.TicketRevoked.selector);
        ticket.acceptOffer(offered, _attesterSig(offered, commitment, BOB));
        assertEq(ticket.ownerOf(offered), ALICE);
    }
}
