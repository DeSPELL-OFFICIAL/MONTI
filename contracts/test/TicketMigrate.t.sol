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

    /// @dev 회전에는 7일 쿨다운이, migrate 에는 그 뒤로 MIGRATE_DELAY(24시간)가 더 걸린다(C3).
    ///      타임락 자체를 보는 테스트는 아래 _rotateAliceToWithoutWaiting 을 쓴다.
    function _rotateAliceTo(address newAccount) internal {
        _rotateAliceToWithoutWaiting(newAccount);
        vm.warp(block.timestamp + ticket.MIGRATE_DELAY());
    }

    function _rotateAliceToWithoutWaiting(address newAccount) internal {
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

    function _attesterSig(uint256 tokenId_, bytes32 commitment, address to) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ATTESTER_PK, ticket.offerDigest(tokenId_, commitment, to));
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
        // maxTransfers is 0 for this event, and the 7-day cooldown plus MIGRATE_DELAY already put us
        // days past the transfer cutoff (doors were T0 + 1 day). A real handoff here would revert.
        _rotateAliceTo(BOB);
        assertGt(block.timestamp + 2 hours, T0 + 1 days, "the migrate runs past the transfer cutoff");
        vm.prank(BOB);
        ticket.migrate(tokenId);
        assertEq(ticket.ownerOf(tokenId), BOB);
    }

    /// @dev Both halves of the name. The transfer leg runs on an event that permits a handoff, so the
    ///      void flag is the only thing in the way (setUp's event has maxTransfers 0 and would refuse
    ///      the move regardless); the admission leg uses the override door, which needs no passkey.
    ///      The NFC tap itself is covered by TicketCheckIn.t.sol's test_revokedTicketRejected.
    function test_revokeBlocksTransferAndCheckIn() public {
        uint256 offered = _offerableTicket();
        uint256 gateId = _openGate();
        _member(CAROL, 0xCACA);

        vm.expectEmit(true, false, false, true);
        emit Revoked(offered, 2);
        vm.prank(ORG_OWNER);
        ticket.revoke(offered, 2);
        vm.prank(ORG_OWNER);
        ticket.revoke(tokenId, 2);

        vm.prank(ALICE);
        vm.expectRevert(Ticket.TicketRevoked.selector);
        ticket.transferFrom(ALICE, CAROL, offered);

        vm.prank(ORG_OWNER);
        vm.expectRevert(Ticket.TicketRevoked.selector);
        ticket.manualOverride(tokenId, gateId, 3);
    }

    /// @dev A stranger is the easy case; the one that catches a wrong bitmask is an admin of this very
    ///      organizer who holds a different permission. Both must be refused.
    function test_onlyCreateEventPermissionRevokes() public {
        vm.prank(BOB);
        vm.expectRevert(Ticket.Unauthorized.selector);
        ticket.revoke(tokenId, 1);

        // Read both bits first: an argument that is itself a call would eat the prank below.
        uint32 gateBit = organizers.PERM_MANAGE_GATES();
        uint32 createBit = organizers.PERM_CREATE_EVENT();

        address gateAdmin = address(0x6AD3);
        vm.prank(ORG_OWNER);
        organizers.setAdmin(orgId, gateAdmin, gateBit);
        vm.prank(gateAdmin);
        vm.expectRevert(Ticket.Unauthorized.selector);
        ticket.revoke(tokenId, 1);

        vm.prank(ORG_OWNER);
        organizers.setAdmin(orgId, gateAdmin, createBit);
        vm.prank(gateAdmin);
        ticket.revoke(tokenId, 1);
        assertTrue(ticket.isRevoked(tokenId), "the right bit does revoke");
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
        // Every rotation opens its own undo window, so the second migrate waits the same day (C3).
        vm.warp(block.timestamp + ticket.MIGRATE_DELAY());
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

        vm.prank(BOB);
        ticket.migrate(offered);

        // The migrate had to wait out the rotation timelock, which lands well past this event's
        // transfer cutoff; wind back inside the window so the handoff leg is about the rules, not the clock.
        vm.warp(T0 + 1 hours);
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
        bytes memory sig = _attesterSig(offered, commitment, BOB);
        vm.prank(BOB);
        vm.expectRevert(Ticket.TicketRevoked.selector);
        ticket.acceptOffer(offered, sig);
        assertEq(ticket.ownerOf(offered), ALICE);
    }

    /// @dev 6.3 T11: 침해된 어테스터가 계정을 바꿔도 티켓은 하루 동안 따라가지 않는다.
    function test_migrateBlockedUntilTheRotationTimelockPasses() public {
        _rotateAliceToWithoutWaiting(BOB);

        vm.prank(BOB);
        vm.expectRevert(Ticket.RotationPending.selector);
        ticket.migrate(tokenId);

        vm.warp(block.timestamp + ticket.MIGRATE_DELAY() - 1);
        vm.prank(BOB);
        vm.expectRevert(Ticket.RotationPending.selector);
        ticket.migrate(tokenId);

        vm.warp(block.timestamp + 1);
        vm.prank(BOB);
        ticket.migrate(tokenId);
        assertEq(ticket.ownerOf(tokenId), BOB);
    }

    /// @dev 되돌리면 절도가 끝난다. 도둑은 더 이상 그 personId 의 계정이 아니다.
    function test_cancelledRotationStopsTheMigrationForGood() public {
        _rotateAliceToWithoutWaiting(BOB);
        vm.prank(ALICE);
        identity.cancelRotation();
        vm.warp(block.timestamp + ticket.MIGRATE_DELAY());

        vm.prank(BOB);
        vm.expectRevert(Ticket.NotRotatedAccount.selector);
        ticket.migrate(tokenId);
        assertEq(ticket.ownerOf(tokenId), ALICE);
    }

    /// @dev 되돌리면 멤버십은 돌아오지만 잠금은 남는다. 그래서 되살아난 계정은 문에서도(I2)
    ///      양도에서도(I1) 여전히 막혀 있고, setActiveDevice 라는 정상 경로를 타야 풀린다.
    ///      "취소는 복구를 늦출 뿐 신원을 빼앗지 못한다"가 이 두 줄이다.
    function test_cancelledRotationRestoresMembershipButNotTheDevice() public {
        _rotateAliceToWithoutWaiting(BOB);
        vm.prank(ALICE);
        identity.cancelRotation();

        assertTrue(identity.isMember(ALICE));
        assertTrue(identity.isLocked(ALICE), "the rotation lock survives the undo");

        vm.prank(ALICE);
        vm.expectRevert(Ticket.DeviceLocked.selector);
        ticket.transferFrom(ALICE, BOB, tokenId);
    }

    /// @dev 두 창은 같은 길이여야 한다. 어긋나면 되돌릴 수도 없는데 티켓은 아직 안 넘어간
    ///      구간이 생기거나, 티켓이 넘어간 뒤에도 되돌릴 수 있는 구간이 생긴다.
    function test_theUndoWindowAndTheMigrateTimelockAreTheSameLength() public view {
        assertEq(ticket.MIGRATE_DELAY(), identity.ROTATION_UNDO_WINDOW());
    }
}
