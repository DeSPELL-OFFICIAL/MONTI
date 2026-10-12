// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {MontiTest} from "./Base.t.sol";
import {Ticket} from "../src/Ticket.sol";

/// @notice Event lifecycle on v2: publishEvent creates an event already Published (no on-chain draft, design
///         D2 — the publish-specific paths live in TicketPublish.t.sol); cancel and the derived Ended status.
contract TicketEventTest is MontiTest {
    event EventCreated(uint256 indexed eventId, uint256 indexed orgId, address indexed creator);
    event EventStatusChanged(uint256 indexed eventId, uint8 status);

    function setUp() public {
        _deployMonti();
    }

    function test_publishEventStoresMetaAndTiers() public {
        uint256 orgId = _org();
        vm.expectEmit(true, true, true, false);
        emit EventCreated(1001, orgId, ORG_OWNER);
        vm.expectEmit(true, false, false, true);
        emit EventStatusChanged(1001, uint8(Ticket.EventStatus.Published));
        uint256 eventId = _freeEvent(orgId, 2, 1, true);

        Ticket.EventMeta memory m = ticket.eventMeta(eventId);
        assertEq(m.orgId, orgId);
        assertEq(m.imageCid, "bafyTestCid");
        assertEq(m.category, 0);
        assertEq(m.regionCode, keccak256("KR-11"));
        assertEq(m.maxTransfers, 1);
        assertEq(ticket.eventOrg(eventId), orgId);
        assertEq(uint8(ticket.eventStatus(eventId)), uint8(Ticket.EventStatus.Published));

        Ticket.Tier[] memory tiers = ticket.tiers(eventId);
        assertEq(tiers.length, 1);
        assertEq(tiers[0].name, "General");
        assertEq(tiers[0].minted, 0);
        assertEq(tiers[0].maxPerWallet, 2);
    }

    function test_publishedTierStartsUnmintedWhateverTheCallerSends() public {
        uint256 orgId = _org();
        Ticket.Tier[] memory t = _oneFreeTier();
        t[0].minted = 77;
        vm.prank(ORG_OWNER);
        uint256 eventId = ticket.publishEvent(_draftMeta(orgId), t, _emptyPolicy());
        assertEq(ticket.tiers(eventId)[0].minted, 0);
    }

    function test_unknownEventReadsAsDraft() public view {
        assertEq(uint8(ticket.eventStatus(424242)), uint8(Ticket.EventStatus.Draft));
        assertEq(ticket.eventOrg(424242), 0);
    }

    function test_nameAndSymbol() public view {
        assertEq(ticket.name(), "MONTI Ticket");
        assertEq(ticket.symbol(), "MONTI");
        assertEq(ticket.CODE_WINDOW(), 60);
        // Both windows are part of the ABI surface the staff device hard-codes against (spec 7.3).
        assertEq(ticket.CLOCK_SKEW(), 5);
    }

    function test_publishEventNeedsCreatePermission() public {
        uint256 orgId = _org();
        vm.prank(ALICE);
        vm.expectRevert(Ticket.Unauthorized.selector);
        ticket.publishEvent(_draftMeta(orgId), _oneFreeTier(), _emptyPolicy());

        // an admin with only PERM_MANAGE_GATES (2) cannot publish either
        vm.prank(ORG_OWNER);
        organizers.setAdmin(orgId, ALICE, 2);
        vm.prank(ALICE);
        vm.expectRevert(Ticket.Unauthorized.selector);
        ticket.publishEvent(_draftMeta(orgId), _oneFreeTier(), _emptyPolicy());
    }

    function test_publishEventRejectsEmptyOrTooManyTiersAndBadTimes() public {
        uint256 orgId = _org();
        Ticket.EventMeta memory m = _draftMeta(orgId);

        vm.prank(ORG_OWNER);
        vm.expectRevert(Ticket.InvalidTiers.selector);
        ticket.publishEvent(m, new Ticket.Tier[](0), _emptyPolicy());

        Ticket.Tier[] memory nine = new Ticket.Tier[](9);
        for (uint256 i; i < 9; ++i) {
            nine[i] = Ticket.Tier({name: "X", priceUsdCents: 0, supply: 1, minted: 0, maxPerWallet: 1, seated: false});
        }
        vm.prank(ORG_OWNER);
        vm.expectRevert(Ticket.InvalidTiers.selector);
        ticket.publishEvent(m, nine, _emptyPolicy());

        m.endsAt = m.startsAt - 1;
        vm.prank(ORG_OWNER);
        vm.expectRevert(Ticket.InvalidSchedule.selector);
        ticket.publishEvent(m, _oneFreeTier(), _emptyPolicy());

        m = _draftMeta(orgId);
        m.saleEnd = m.saleStart;
        vm.prank(ORG_OWNER);
        vm.expectRevert(Ticket.InvalidSchedule.selector);
        ticket.publishEvent(m, _oneFreeTier(), _emptyPolicy());
    }

    function test_cancelEventAndEndedIsDerived() public {
        uint256 orgId = _org();
        uint256 eventId = _freeEvent(orgId, 2, 1, true);

        vm.warp(T0 + 3 days);
        assertEq(uint8(ticket.eventStatus(eventId)), uint8(Ticket.EventStatus.Ended), "past endsAt is Ended");

        vm.warp(T0);
        vm.expectEmit(true, false, false, true);
        emit EventStatusChanged(eventId, uint8(Ticket.EventStatus.Cancelled));
        vm.prank(ORG_OWNER);
        ticket.cancelEvent(eventId);
        assertEq(uint8(ticket.eventStatus(eventId)), uint8(Ticket.EventStatus.Cancelled));
        vm.warp(T0 + 3 days);
        assertEq(uint8(ticket.eventStatus(eventId)), uint8(Ticket.EventStatus.Cancelled), "cancel outranks ended");
    }

    function test_onlyCreatePermissionChangesLifecycle() public {
        uint256 orgId = _org();
        uint256 eventId = _freeEvent(orgId, 2, 1, true);
        vm.prank(ALICE);
        vm.expectRevert(Ticket.Unauthorized.selector);
        ticket.cancelEvent(eventId);
    }

    function test_cancelUnknownEventRejected() public {
        vm.prank(ORG_OWNER);
        vm.expectRevert(Ticket.UnknownEvent.selector);
        ticket.cancelEvent(424242);
    }

    function test_cancelEventRejectedWhenAlreadyClosed() public {
        uint256 orgId = _org();
        uint256 eventId = _freeEvent(orgId, 2, 1, true);

        vm.prank(ORG_OWNER);
        ticket.cancelEvent(eventId);
        vm.prank(ORG_OWNER);
        vm.expectRevert(Ticket.EventAlreadyClosed.selector);
        ticket.cancelEvent(eventId);

        uint256 endedId = _freeEvent(orgId, 2, 1, true);
        vm.warp(T0 + 3 days);
        vm.prank(ORG_OWNER);
        vm.expectRevert(Ticket.EventAlreadyClosed.selector);
        ticket.cancelEvent(endedId);
    }

    function _draftMeta(uint256 orgId) internal pure returns (Ticket.EventMeta memory m) {
        m = Ticket.EventMeta({
            orgId: orgId,
            titleHash: keccak256("MONTI Night"),
            descHash: keccak256("a test event"),
            imageCid: "bafyTestCid",
            startsAt: T0 + 1 days,
            endsAt: T0 + 2 days,
            venueHash: keccak256("Seoul"),
            saleStart: T0,
            saleEnd: T0 + 1 days,
            transferable: true,
            transferCutoffSeconds: 2 hours,
            maxTransfers: 1,
            approvalRequired: false,
            category: 0,
            regionCode: keccak256("KR-11"),
            requireKyc: false
        });
    }

    function _oneFreeTier() internal pure returns (Ticket.Tier[] memory t) {
        t = new Ticket.Tier[](1);
        t[0] = Ticket.Tier({name: "General", priceUsdCents: 0, supply: 100, minted: 0, maxPerWallet: 2, seated: false});
    }
}
