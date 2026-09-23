// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {MontiTest} from "./Base.t.sol";
import {Ticket} from "../src/Ticket.sol";

contract TicketEventTest is MontiTest {
    event EventCreated(uint256 indexed eventId, uint256 indexed orgId, address indexed creator);

    function setUp() public {
        _deployMonti();
    }

    function test_createEventStoresMetaAndTiers() public {
        uint256 orgId = _org();
        vm.expectEmit(true, true, true, false);
        emit EventCreated(1, orgId, ORG_OWNER);
        uint256 eventId = _freeEvent(orgId, 2, 1, true);

        Ticket.EventMeta memory m = ticket.eventMeta(eventId);
        assertEq(m.orgId, orgId);
        assertEq(m.imageCid, "bafyTestCid");
        assertEq(m.category, 0);
        assertEq(m.regionCode, keccak256("KR-11"));
        assertEq(m.maxTransfers, 1);
        assertEq(ticket.eventOrg(eventId), orgId);

        Ticket.Tier[] memory tiers = ticket.tiers(eventId);
        assertEq(tiers.length, 1);
        assertEq(tiers[0].name, "General");
        assertEq(tiers[0].minted, 0);
        assertEq(tiers[0].maxPerWallet, 2);
    }

    function test_nameAndSymbol() public view {
        assertEq(ticket.name(), "MONTI Ticket");
        assertEq(ticket.symbol(), "MONTI");
        assertEq(ticket.CODE_WINDOW(), 60);
        // Both windows are part of the ABI surface the staff device hard-codes against (spec 7.3).
        assertEq(ticket.CLOCK_SKEW(), 5);
    }

    function test_createEventNeedsCreatePermission() public {
        uint256 orgId = _org();
        Ticket.EventMeta memory m = ticket.eventMeta(0);
        m.orgId = orgId;
        m.startsAt = T0 + 1 days;
        m.endsAt = T0 + 2 days;
        m.saleStart = T0;
        m.saleEnd = T0 + 1 days;
        Ticket.Tier[] memory t = new Ticket.Tier[](1);
        t[0] = Ticket.Tier({name: "X", priceUsdCents: 0, supply: 1, minted: 0, maxPerWallet: 1, seated: false});

        vm.prank(ALICE);
        vm.expectRevert(Ticket.Unauthorized.selector);
        ticket.createEvent(m, t);
    }

    function test_createEventRejectsEmptyTiersAndBadTimes() public {
        uint256 orgId = _org();
        Ticket.EventMeta memory m = ticket.eventMeta(0);
        m.orgId = orgId;
        m.startsAt = T0 + 1 days;
        m.endsAt = T0 + 2 days;
        m.saleStart = T0;
        m.saleEnd = T0 + 1 days;

        Ticket.Tier[] memory none = new Ticket.Tier[](0);
        vm.prank(ORG_OWNER);
        vm.expectRevert(Ticket.InvalidTiers.selector);
        ticket.createEvent(m, none);

        Ticket.Tier[] memory t = new Ticket.Tier[](1);
        t[0] = Ticket.Tier({name: "X", priceUsdCents: 0, supply: 1, minted: 0, maxPerWallet: 1, seated: false});
        m.endsAt = m.startsAt - 1;
        vm.prank(ORG_OWNER);
        vm.expectRevert(Ticket.InvalidSchedule.selector);
        ticket.createEvent(m, t);
    }

    event EventStatusChanged(uint256 indexed eventId, uint8 status);

    function test_eventStartsAsDraftAndPublishes() public {
        uint256 orgId = _org();
        Ticket.EventMeta memory m = _draftMeta(orgId);
        Ticket.Tier[] memory t = _oneFreeTier();

        vm.prank(ORG_OWNER);
        uint256 eventId = ticket.createEvent(m, t);
        assertEq(uint8(ticket.eventStatus(eventId)), uint8(Ticket.EventStatus.Draft));

        vm.expectEmit(true, false, false, true);
        emit EventStatusChanged(eventId, uint8(Ticket.EventStatus.Published));
        vm.prank(ORG_OWNER);
        ticket.publishEvent(eventId);
        assertEq(uint8(ticket.eventStatus(eventId)), uint8(Ticket.EventStatus.Published));
    }

    function test_updateEventMetaOnlyWhileDraft() public {
        uint256 orgId = _org();
        Ticket.EventMeta memory m = _draftMeta(orgId);
        vm.prank(ORG_OWNER);
        uint256 eventId = ticket.createEvent(m, _oneFreeTier());

        m.titleHash = keccak256("New title");
        vm.prank(ORG_OWNER);
        ticket.updateEventMeta(eventId, m, _oneFreeTier());
        assertEq(ticket.eventMeta(eventId).titleHash, keccak256("New title"));

        vm.prank(ORG_OWNER);
        ticket.publishEvent(eventId);
        vm.prank(ORG_OWNER);
        vm.expectRevert(Ticket.NotDraft.selector);
        ticket.updateEventMeta(eventId, m, _oneFreeTier());
    }

    event EventMetaUpdated(uint256 indexed eventId);

    /// @notice A Draft edit rewrites meta and tiers in place, so the indexer only learns about it if the
    ///         write announces itself. The emit is the whole change: the stored state must be what it was.
    function test_updateEventMetaEmitsEventMetaUpdated() public {
        uint256 orgId = _org();
        Ticket.EventMeta memory m = _draftMeta(orgId);
        vm.prank(ORG_OWNER);
        uint256 eventId = ticket.createEvent(m, _oneFreeTier());

        m.titleHash = keccak256("Second title");
        m.venueHash = keccak256("Busan");
        Ticket.Tier[] memory t = _oneFreeTier();
        t[0].supply = 42;

        vm.expectEmit(true, false, false, false);
        emit EventMetaUpdated(eventId);
        vm.prank(ORG_OWNER);
        ticket.updateEventMeta(eventId, m, t);

        Ticket.EventMeta memory stored = ticket.eventMeta(eventId);
        assertEq(stored.titleHash, keccak256("Second title"));
        assertEq(stored.venueHash, keccak256("Busan"));
        assertEq(stored.orgId, orgId, "orgId stays the one createEvent recorded");
        assertEq(uint8(ticket.eventStatus(eventId)), uint8(Ticket.EventStatus.Draft), "still a draft");

        Ticket.Tier[] memory tiers = ticket.tiers(eventId);
        assertEq(tiers.length, 1);
        assertEq(tiers[0].supply, 42);
        assertEq(tiers[0].minted, 0, "a replaced tier starts unminted");
    }

    function test_cancelEventAndEndedIsDerived() public {
        uint256 orgId = _org();
        uint256 eventId = _freeEvent(orgId, 2, 1, true);

        vm.warp(T0 + 3 days);
        assertEq(uint8(ticket.eventStatus(eventId)), uint8(Ticket.EventStatus.Ended), "past endsAt is Ended");

        vm.warp(T0);
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
