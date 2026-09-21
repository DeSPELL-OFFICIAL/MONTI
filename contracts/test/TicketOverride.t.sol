// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {MontiTest} from "./Base.t.sol";
import {Ticket} from "../src/Ticket.sol";

contract TicketOverrideTest is MontiTest {
    uint256 internal orgId;
    uint256 internal eventId;
    uint256 internal tokenId;
    uint256 internal gateId;

    address internal constant ADMIN = address(0x0A);
    address internal constant MANAGER_YES = address(0x0B);
    address internal constant MANAGER_NO = address(0x0C);

    event OverrideRequested(uint256 indexed tokenId, uint256 indexed gateId, address indexed requester, uint8 reason);
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
        vm.prank(ALICE);
        tokenId = ticket.claim(eventId, 0, "");

        vm.startPrank(ORG_OWNER);
        organizers.setAdmin(orgId, ADMIN, organizers.PERM_APPROVE_OVERRIDE());
        organizers.setManager(orgId, MANAGER_YES, true, true);
        organizers.setManager(orgId, MANAGER_NO, true, false);
        gateId = organizers.registerGate(eventId, GATE_A, bytes32(uint256(0x6A01)), bytes32(uint256(0x6A02)));
        organizers.openGate(gateId);
        vm.stopPrank();
    }

    function test_managerWithoutApprovalCanOnlyRequest() public {
        vm.expectEmit(true, true, true, true);
        emit OverrideRequested(tokenId, gateId, MANAGER_NO, 3);
        vm.prank(MANAGER_NO);
        ticket.requestOverride(tokenId, gateId, 3);

        vm.prank(MANAGER_NO);
        vm.expectRevert(Ticket.Unauthorized.selector);
        ticket.manualOverride(tokenId, gateId, 3);
        assertEq(ticket.checkInOf(tokenId).ts, 0);
    }

    function test_managerWithApprovalAdmitsWithRoleTwo() public {
        vm.expectEmit(true, true, true, true);
        emit ManualOverride(tokenId, gateId, MANAGER_YES, 2, 3);
        vm.prank(MANAGER_YES);
        ticket.manualOverride(tokenId, gateId, 3);

        Ticket.CheckIn memory c = ticket.checkInOf(tokenId);
        assertEq(c.gateId, gateId);
        assertTrue(c.manual);
        assertEq(c.nonceHash, bytes32(0));
    }

    function test_adminWithApproveBitAdmitsWithRoleOne() public {
        vm.expectEmit(true, true, true, true);
        emit ManualOverride(tokenId, gateId, ADMIN, 1, 5);
        vm.prank(ADMIN);
        ticket.manualOverride(tokenId, gateId, 5);
        assertTrue(ticket.checkInOf(tokenId).manual);
    }

    function test_strangerCanNeitherRequestNorApprove() public {
        vm.prank(BOB);
        vm.expectRevert(Ticket.Unauthorized.selector);
        ticket.requestOverride(tokenId, gateId, 1);
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
        emit ManualOverride(tokenId, gateId, ORG_OWNER, 1, 7);
        vm.prank(ORG_OWNER);
        ticket.manualOverride(tokenId, gateId, 7);
        assertTrue(ticket.checkInOf(tokenId).manual);
    }

    /// @dev Overrides come from a staff passkey account, never from the gate account itself.
    function test_gateAccountCanNeitherRequestNorApprove() public {
        vm.prank(GATE_A);
        vm.expectRevert(Ticket.Unauthorized.selector);
        ticket.requestOverride(tokenId, gateId, 2);
        vm.prank(GATE_A);
        vm.expectRevert(Ticket.Unauthorized.selector);
        ticket.manualOverride(tokenId, gateId, 2);
        assertEq(ticket.checkInOf(tokenId).ts, 0);
    }

    /// @dev Someone who may approve may also file a request, so the staff screen needs no branch.
    function test_approverCanAlsoFileRequest() public {
        vm.expectEmit(true, true, true, true);
        emit OverrideRequested(tokenId, gateId, ADMIN, 4);
        vm.prank(ADMIN);
        ticket.requestOverride(tokenId, gateId, 4);
        assertEq(ticket.checkInOf(tokenId).ts, 0, "a request admits nobody");
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

    function test_unknownTicketRevertsForBothPaths() public {
        vm.prank(MANAGER_YES);
        vm.expectRevert(Ticket.NoSuchTicket.selector);
        ticket.requestOverride(999, gateId, 1);
        vm.prank(MANAGER_YES);
        vm.expectRevert(Ticket.NoSuchTicket.selector);
        ticket.manualOverride(999, gateId, 1);
    }
}
