// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {MontiTest} from "./Base.t.sol";
import {Ticket} from "../src/Ticket.sol";

contract TicketOverrideTest is MontiTest {
    uint256 internal orgId;
    uint256 internal eventId;
    uint256 internal tokenId;
    uint256 internal gateId;

    uint256 internal closedGateId;
    uint256 internal otherEventId;
    uint256 internal otherGateId;
    uint8 internal roleApprover;
    uint8 internal roleManager;

    address internal constant ADMIN = address(0x0A);
    address internal constant MANAGER_YES = address(0x0B);
    address internal constant MANAGER_NO = address(0x0C);
    address internal constant GATE_C = address(0x6A80);

    event ManualOverride(
        uint256 indexed tokenId, uint256 indexed gateId, address indexed approver, uint8 role, uint8 reason
    );
    event CheckedIn(
        uint256 indexed tokenId, uint256 indexed eventId, uint256 indexed gateId, bytes32 nonceHash, uint64 ts
    );

    function setUp() public {
        _deployMonti();
        _memberWithDeviceKey(ALICE, 0xA1A1);
        orgId = _org();
        eventId = _freeEvent(orgId, 1, 1, true);
        tokenId = _claimForFixture(ALICE, eventId, 0);

        vm.startPrank(ORG_OWNER);
        organizers.setAdmin(orgId, ADMIN, organizers.PERM_APPROVE_OVERRIDE());
        organizers.setManager(orgId, MANAGER_YES, true, true);
        organizers.setManager(orgId, MANAGER_NO, true, false);
        gateId = organizers.registerGate(eventId, GATE_A, GATE_KX, GATE_KY);
        // Closed on purpose (v2 registers open): an override is not a tap, so it does not need an open door.
        closedGateId = organizers.registerGate(eventId, GATE_B, bytes32(uint256(0x6B01)), bytes32(uint256(0x6B02)));
        organizers.closeGate(closedGateId);
        vm.stopPrank();

        otherEventId = _freeEvent(orgId, 1, 1, true);
        vm.prank(ORG_OWNER);
        otherGateId = organizers.registerGate(otherEventId, GATE_C, bytes32(uint256(0x6C01)), bytes32(uint256(0x6C02)));

        roleApprover = ticket.ROLE_APPROVER();
        roleManager = ticket.ROLE_MANAGER();
    }

    /// @dev v2 D5: the request is an off-chain record; on chain a manager without canApprove admits nobody.
    function test_managerWithoutApprovalCannotAdmit() public {
        vm.prank(MANAGER_NO);
        vm.expectRevert(Ticket.Unauthorized.selector);
        ticket.manualOverride(tokenId, gateId, 3);
        assertEq(ticket.checkInOf(tokenId).ts, 0);
    }

    function test_managerWithApprovalAdmitsWithRoleTwo() public {
        vm.expectEmit(true, true, true, true);
        emit ManualOverride(tokenId, gateId, MANAGER_YES, roleManager, 3);
        vm.prank(MANAGER_YES);
        ticket.manualOverride(tokenId, gateId, 3);

        // 슬림 저장: role·gateId 는 ManualOverride 이벤트(위 expectEmit)가 검증한다. 저장에는
        // usedAt(ts)만 남고 gateId·nonceHash·manual 은 0/false 다(설계 §12-2).
        Ticket.CheckIn memory c = ticket.checkInOf(tokenId);
        assertEq(c.ts, uint64(block.timestamp));
        assertEq(c.gateId, 0);
        assertFalse(c.manual);
        assertEq(c.nonceHash, bytes32(0));
    }

    function test_adminWithApproveBitAdmitsWithRoleOne() public {
        vm.expectEmit(true, true, true, true);
        emit ManualOverride(tokenId, gateId, ADMIN, roleApprover, 5);
        vm.prank(ADMIN);
        ticket.manualOverride(tokenId, gateId, 5);
        assertTrue(ticket.usedAt(tokenId) != 0);
    }

    function test_strangerCannotApprove() public {
        vm.prank(BOB);
        vm.expectRevert(Ticket.Unauthorized.selector);
        ticket.manualOverride(tokenId, gateId, 1);
    }

    function test_manualOverrideCannotDoubleAdmit() public {
        vm.prank(MANAGER_YES);
        ticket.manualOverride(tokenId, gateId, 3);
        vm.prank(ADMIN);
        vm.expectRevert(Ticket.AlreadyCheckedIn.selector);
        ticket.manualOverride(tokenId, gateId, 3);
    }

    /// @dev The owner implicitly holds every permission bit, so they admit as role 1 like an admin.
    function test_orgOwnerAdmitsWithRoleOne() public {
        vm.expectEmit(true, true, true, true);
        emit ManualOverride(tokenId, gateId, ORG_OWNER, roleApprover, 7);
        vm.prank(ORG_OWNER);
        ticket.manualOverride(tokenId, gateId, 7);
        assertTrue(ticket.usedAt(tokenId) != 0);
    }

    /// @dev Overrides come from a staff passkey account, never from the gate account itself.
    function test_gateAccountCannotApprove() public {
        vm.prank(GATE_A);
        vm.expectRevert(Ticket.Unauthorized.selector);
        ticket.manualOverride(tokenId, gateId, 2);
        assertEq(ticket.checkInOf(tokenId).ts, 0);
    }

    /// @dev The indexer subscribes to CheckedIn only; a manual admit has to show up there too.
    function test_manualOverrideAlsoEmitsCheckedIn() public {
        vm.expectEmit(true, true, true, true);
        emit CheckedIn(tokenId, eventId, gateId, bytes32(0), uint64(block.timestamp));
        vm.prank(MANAGER_YES);
        ticket.manualOverride(tokenId, gateId, 3);
        assertEq(ticket.checkInOf(tokenId).ts, uint64(block.timestamp));
    }

    /// @dev After a manual admit the ticket is as frozen as after a normal check-in.
    function test_manualOverrideFreezesTransfers() public {
        _member(BOB, 0xB0B0);
        vm.prank(MANAGER_YES);
        ticket.manualOverride(tokenId, gateId, 3);

        vm.prank(ALICE);
        vm.expectRevert(Ticket.AlreadyCheckedIn.selector);
        ticket.transferFrom(ALICE, BOB, tokenId);
    }

    function test_unknownTicketReverts() public {
        vm.prank(MANAGER_YES);
        vm.expectRevert(Ticket.NoSuchTicket.selector);
        ticket.manualOverride(999, gateId, 1);
    }

    /// @dev A spent ticket must not still carry a live handoff, exactly as after a tap.
    function test_manualOverrideCancelsAPendingOffer() public {
        vm.prank(ALICE);
        ticket.createOffer(tokenId, keccak256("010-1234-5678"), uint64(block.timestamp + 1 hours));

        vm.expectEmit(true, false, false, false);
        emit Ticket.OfferCancelled(tokenId);
        vm.prank(MANAGER_YES);
        ticket.manualOverride(tokenId, gateId, 3);

        assertEq(ticket.offerOf(tokenId).from, address(0));
    }

    function test_manualOverrideRejectsCancelledEvent() public {
        vm.prank(ORG_OWNER);
        ticket.cancelEvent(eventId);
        vm.prank(MANAGER_YES);
        vm.expectRevert(Ticket.EventCancelled.selector);
        ticket.manualOverride(tokenId, gateId, 3);
    }

    function test_manualOverrideRejectsEndedEvent() public {
        vm.warp(T0 + 2 days + 1);
        vm.prank(MANAGER_YES);
        vm.expectRevert(Ticket.EventEnded.selector);
        ticket.manualOverride(tokenId, gateId, 3);
    }

    /// @dev The gate on the record has to be a door of this event, or the audit trail lies.
    function test_gateOfAnotherEventRejected() public {
        vm.prank(MANAGER_YES);
        vm.expectRevert(Ticket.GateMismatch.selector);
        ticket.manualOverride(tokenId, otherGateId, 3);
        assertEq(ticket.checkInOf(tokenId).ts, 0);
    }

    function test_unregisteredGateRejected() public {
        vm.prank(MANAGER_YES);
        vm.expectRevert(Ticket.GateMismatch.selector);
        ticket.manualOverride(tokenId, 0, 3);
        assertEq(ticket.checkInOf(tokenId).ts, 0);
    }

    /// @dev A voided ticket cannot be waved in by hand either (Task 23).
    function test_revokedTicketRejected() public {
        vm.prank(ORG_OWNER);
        ticket.revoke(tokenId, 2);

        vm.prank(MANAGER_YES);
        vm.expectRevert(Ticket.TicketRevoked.selector);
        ticket.manualOverride(tokenId, gateId, 3);
        assertEq(ticket.checkInOf(tokenId).ts, 0);
    }

    /// @dev An override is a human decision, not a tap, so a closed door of this event still counts.
    function test_closedGateOfTheSameEventIsAccepted() public {
        (,,,, bool open,) = organizers.gateInfo(closedGateId);
        assertFalse(open, "fixture gate is closed");
        vm.expectEmit(true, true, true, true);
        emit ManualOverride(tokenId, closedGateId, MANAGER_YES, roleManager, 3);
        vm.prank(MANAGER_YES);
        ticket.manualOverride(tokenId, closedGateId, 3);
        assertTrue(ticket.usedAt(tokenId) != 0);
    }

    /// @dev v2 D5: the on-chain request path is gone.
    function test_requestOverrideIsGone() public {
        (bool ok,) =
            address(ticket).call(abi.encodeWithSignature("requestOverride(uint256,uint256,uint8)", tokenId, gateId, 1));
        assertFalse(ok, "no requestOverride selector on v2 Ticket");
    }
}
