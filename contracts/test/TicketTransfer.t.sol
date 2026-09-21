// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {MontiTest} from "./Base.t.sol";
import {Ticket} from "../src/Ticket.sol";

contract TicketTransferTest is MontiTest {
    uint256 internal orgId;
    uint256 internal eventId;
    uint256 internal tokenId;

    function setUp() public {
        _deployMonti();
        _member(ALICE, 0xA1A1);
        _member(BOB, 0xB0B0);
        orgId = _org();
        eventId = _freeEvent(orgId, 1, 1, true);
        vm.prank(ALICE);
        tokenId = ticket.claim(eventId, 0, "");
    }

    function test_transferToMemberSucceedsAndCounts() public {
        vm.prank(ALICE);
        ticket.transferFrom(ALICE, BOB, tokenId);

        assertEq(ticket.ownerOf(tokenId), BOB);
        assertEq(ticket.transfersOf(tokenId), 1);
        assertEq(ticket.balanceOfEvent(ALICE, eventId), 0);
        assertEq(ticket.balanceOfEvent(BOB, eventId), 1);
    }

    function test_transferToNonMemberReverts() public {
        vm.prank(ALICE);
        vm.expectRevert(Ticket.NotMember.selector);
        ticket.transferFrom(ALICE, CAROL, tokenId);
    }

    function test_maxPerWalletEnforcedOnTransfer() public {
        vm.prank(BOB);
        ticket.claim(eventId, 0, "");

        vm.prank(ALICE);
        vm.expectRevert(Ticket.MaxPerWalletExceeded.selector);
        ticket.transferFrom(ALICE, BOB, tokenId);
    }

    function test_maxTransfersEnforced() public {
        _member(CAROL, 0xCACA);
        vm.prank(ALICE);
        ticket.transferFrom(ALICE, BOB, tokenId);

        vm.prank(BOB);
        vm.expectRevert(Ticket.TransferLimitReached.selector);
        ticket.transferFrom(BOB, CAROL, tokenId);
    }

    function test_transferAfterCutoffReverts() public {
        // doors at T0 + 1 day, cutoff 2 hours before.
        vm.warp(T0 + 1 days - 2 hours + 1);
        vm.prank(ALICE);
        vm.expectRevert(Ticket.TransferCutoffPassed.selector);
        ticket.transferFrom(ALICE, BOB, tokenId);
    }

    function test_transferAtExactCutoffReverts() public {
        // The cutoff instant itself is closed: transfer is allowed only while now < startsAt - cutoff.
        vm.warp(T0 + 1 days - 2 hours);
        vm.prank(ALICE);
        vm.expectRevert(Ticket.TransferCutoffPassed.selector);
        ticket.transferFrom(ALICE, BOB, tokenId);
    }

    function test_transferBlockedWhenEventIsNotTransferable() public {
        uint256 lockedEvent = _freeEvent(orgId, 1, 1, false);
        vm.prank(BOB);
        uint256 locked = ticket.claim(lockedEvent, 0, "");

        vm.prank(BOB);
        vm.expectRevert(Ticket.TransfersDisabled.selector);
        ticket.transferFrom(BOB, ALICE, locked);
    }

    function test_transferToLevelZeroBlockedOnAKycEvent() public {
        uint256 kycEventId = _kycEvent(orgId);
        vm.prank(ALICE);
        uint256 kycToken = ticket.claim(kycEventId, 0, "");
        _memberWithLevel(address(0xD0), 0xD0D0, 0);

        vm.prank(ALICE);
        vm.expectRevert(Ticket.KycRequired.selector);
        ticket.transferFrom(ALICE, address(0xD0), kycToken);
    }

    function test_safeTransferFromFollowsTheSameRules() public {
        vm.prank(ALICE);
        vm.expectRevert(Ticket.NotMember.selector);
        ticket.safeTransferFrom(ALICE, CAROL, tokenId);
    }
}
