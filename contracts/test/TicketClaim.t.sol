// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {MontiTest} from "./Base.t.sol";
import {Ticket} from "../src/Ticket.sol";

contract TicketClaimTest is MontiTest {
    uint256 internal orgId;
    uint256 internal eventId;

    event Claimed(uint256 indexed tokenId, uint256 indexed eventId, address indexed to, uint8 tier);

    function setUp() public {
        _deployMonti();
        _member(ALICE, 0xA1A1);
        _member(BOB, 0xB0B0);
        orgId = _org();
        eventId = _freeEvent(orgId, 1, 1, true);
    }

    function test_memberClaimsFreeTicket() public {
        vm.expectEmit(true, true, true, true);
        emit Claimed(1, eventId, ALICE, 0);
        vm.prank(ALICE);
        uint256 tokenId = ticket.claim(eventId, 0, "");

        assertEq(tokenId, 1);
        assertEq(ticket.ownerOf(tokenId), ALICE);
        assertEq(ticket.eventOf(tokenId), eventId);
        assertEq(ticket.tierOf(tokenId), 0);
        assertEq(ticket.balanceOfEvent(ALICE, eventId), 1);
        assertEq(ticket.transfersOf(tokenId), 0);
        assertEq(ticket.checkInOf(tokenId).ts, 0);
        assertEq(ticket.tiers(eventId)[0].minted, 1);
    }

    function test_nonMemberCannotClaim() public {
        vm.prank(CAROL);
        vm.expectRevert(Ticket.NotMember.selector);
        ticket.claim(eventId, 0, "");
    }

    function test_maxPerWalletEnforcedOnClaim() public {
        vm.startPrank(ALICE);
        ticket.claim(eventId, 0, "");
        vm.expectRevert(Ticket.MaxPerWalletExceeded.selector);
        ticket.claim(eventId, 0, "");
        vm.stopPrank();
    }

    function test_claimRejectedWhenDraft() public {
        uint256 draftId;
        {
            Ticket.EventMeta memory m = ticket.eventMeta(eventId);
            Ticket.Tier[] memory t = ticket.tiers(eventId);
            vm.prank(ORG_OWNER);
            draftId = ticket.createEvent(m, t);
        }
        vm.prank(ALICE);
        vm.expectRevert(Ticket.EventNotPublished.selector);
        ticket.claim(draftId, 0, "");
    }

    function test_claimRejectedOutsideSaleWindowAndAfterEnd() public {
        vm.warp(T0 + 1 days + 1);
        vm.prank(ALICE);
        vm.expectRevert(Ticket.SaleClosed.selector);
        ticket.claim(eventId, 0, "");

        vm.warp(T0 + 2 days + 1);
        vm.prank(ALICE);
        vm.expectRevert(Ticket.EventEnded.selector);
        ticket.claim(eventId, 0, "");
    }

    function test_claimBlockedForLevelZeroOnAKycEvent() public {
        uint256 kycEventId = _kycEvent(orgId);
        _memberWithLevel(address(0xD0), 0xD0D0, 0);
        vm.prank(address(0xD0));
        vm.expectRevert(Ticket.KycRequired.selector);
        ticket.claim(kycEventId, 0, "");
    }

    function test_claimAllowedForLevelOneAndOnNonKycEvents() public {
        uint256 kycEventId = _kycEvent(orgId);
        vm.prank(ALICE);
        ticket.claim(kycEventId, 0, "");
        assertEq(ticket.balanceOfEvent(ALICE, kycEventId), 1);

        _memberWithLevel(address(0xD1), 0xD1D1, 0);
        vm.prank(address(0xD1));
        ticket.claim(eventId, 0, "");
        assertEq(ticket.balanceOfEvent(address(0xD1), eventId), 1);
    }

    function test_claimRejectedOnUnknownTierAndWithAVoucher() public {
        vm.prank(ALICE);
        vm.expectRevert(Ticket.UnknownTier.selector);
        ticket.claim(eventId, 3, "");

        vm.prank(ALICE);
        vm.expectRevert(Ticket.PaidTiersNotEnabled.selector);
        ticket.claim(eventId, 0, hex"1234");
    }

    /// @dev The shared fixture sells 100 seats, so running a tier out needs an event of its own.
    function _oneSeatEvent() internal returns (uint256 soldOutEventId) {
        Ticket.EventMeta memory m = ticket.eventMeta(eventId);
        Ticket.Tier[] memory t = new Ticket.Tier[](1);
        t[0] = Ticket.Tier({name: "Only seat", priceUsdCents: 0, supply: 1, minted: 0, maxPerWallet: 1, seated: false});
        vm.prank(ORG_OWNER);
        soldOutEventId = ticket.createEvent(m, t);
        vm.prank(ORG_OWNER);
        ticket.publishEvent(soldOutEventId);
    }

    function test_claimRejectedWhenTheTierIsSoldOut() public {
        uint256 soldOut = _oneSeatEvent();

        vm.prank(ALICE);
        ticket.claim(soldOut, 0, "");
        assertEq(ticket.tiers(soldOut)[0].minted, 1);

        vm.prank(BOB);
        vm.expectRevert(Ticket.SoldOut.selector);
        ticket.claim(soldOut, 0, "");
    }
}
