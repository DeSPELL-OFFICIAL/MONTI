// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {Test} from "forge-std/Test.sol";
import {Organizers} from "../src/Organizers.sol";

contract OrganizersTest is Test {
    Organizers internal orgs;
    address internal constant OWNER = address(0x01);
    address internal constant OTHER = address(0x02);

    event OrganizerCreated(uint256 indexed orgId, address indexed owner);
    event OwnerTransferred(uint256 indexed orgId, address indexed from, address indexed to);
    event AdminSet(uint256 indexed orgId, address indexed admin, uint32 bits);
    event ManagerSet(uint256 indexed orgId, address indexed manager, bool exists, bool canApprove);

    function setUp() public {
        orgs = new Organizers();
        vm.warp(1_800_000_000);
    }

    function test_createOrganizerStartsAtOneAndIncrements() public {
        vm.expectEmit(true, true, false, false);
        emit OrganizerCreated(1, OWNER);
        uint256 a = orgs.createOrganizer(OWNER);
        uint256 b = orgs.createOrganizer(OTHER);
        assertEq(a, 1);
        assertEq(b, 2);
        assertEq(orgs.ownerOf(1), OWNER);
        assertEq(orgs.ownerOf(2), OTHER);
    }

    function test_ownerTransfer() public {
        orgs.createOrganizer(OWNER);
        vm.expectEmit(true, true, true, false);
        emit OwnerTransferred(1, OWNER, OTHER);
        vm.prank(OWNER);
        orgs.transferOwner(1, OTHER);
        assertEq(orgs.ownerOf(1), OTHER);
    }

    function test_nonOwnerCannotTransfer() public {
        orgs.createOrganizer(OWNER);
        vm.prank(OTHER);
        vm.expectRevert(Organizers.NotOwner.selector);
        orgs.transferOwner(1, OTHER);
    }

    function test_setTicketOnlyOnceAndOnlyDeployer() public {
        orgs.setTicket(address(0x7107));
        assertEq(orgs.ticket(), address(0x7107));
        vm.expectRevert(Organizers.TicketAlreadySet.selector);
        orgs.setTicket(address(0xBEEF));
        Organizers fresh = new Organizers();
        vm.prank(OTHER);
        vm.expectRevert(Organizers.NotDeployer.selector);
        fresh.setTicket(address(0xBEEF));
    }

    function test_permissionBitValues() public view {
        assertEq(orgs.PERM_CREATE_EVENT(), 1);
        assertEq(orgs.PERM_MANAGE_GATES(), 2);
        assertEq(orgs.PERM_APPROVE_OVERRIDE(), 4);
        assertEq(orgs.PERM_MANAGE_MANAGERS(), 8);
        assertEq(orgs.PERM_MANAGE_BUDGET(), 16);
    }

    function test_ownerAlwaysHasEveryPermission() public {
        orgs.createOrganizer(OWNER);
        assertTrue(orgs.hasPermission(1, OWNER, orgs.PERM_CREATE_EVENT()));
        assertTrue(orgs.hasPermission(1, OWNER, orgs.PERM_MANAGE_BUDGET()));
        assertFalse(orgs.hasPermission(1, OTHER, orgs.PERM_CREATE_EVENT()));
    }

    function test_setAdminGrantsOnlyTheGivenBits() public {
        orgs.createOrganizer(OWNER);
        uint32 permBits = orgs.PERM_CREATE_EVENT() | orgs.PERM_MANAGE_GATES();
        vm.expectEmit(true, true, false, true);
        emit AdminSet(1, OTHER, 3);
        vm.prank(OWNER);
        orgs.setAdmin(1, OTHER, permBits);

        assertTrue(orgs.hasPermission(1, OTHER, orgs.PERM_CREATE_EVENT()));
        assertTrue(orgs.hasPermission(1, OTHER, orgs.PERM_MANAGE_GATES()));
        assertFalse(orgs.hasPermission(1, OTHER, orgs.PERM_APPROVE_OVERRIDE()));
        assertFalse(orgs.hasPermission(1, OTHER, orgs.PERM_MANAGE_MANAGERS()));
    }

    function test_setAdminCanRevokeByPassingZero() public {
        orgs.createOrganizer(OWNER);
        vm.startPrank(OWNER);
        orgs.setAdmin(1, OTHER, orgs.PERM_MANAGE_GATES());
        orgs.setAdmin(1, OTHER, 0);
        vm.stopPrank();
        assertFalse(orgs.hasPermission(1, OTHER, orgs.PERM_MANAGE_GATES()));
    }

    function test_onlyOwnerSetsAdmin() public {
        orgs.createOrganizer(OWNER);
        vm.prank(OTHER);
        vm.expectRevert(Organizers.NotOwner.selector);
        orgs.setAdmin(1, OTHER, 1);
    }

    function test_ownerAppointsManagerWithApprovalRight() public {
        orgs.createOrganizer(OWNER);
        vm.expectEmit(true, true, false, true);
        emit ManagerSet(1, OTHER, true, true);
        vm.prank(OWNER);
        orgs.setManager(1, OTHER, true, true);

        (bool exists, bool canApprove) = orgs.managerOf(1, OTHER);
        assertTrue(exists);
        assertTrue(canApprove);
    }

    function test_requestOnlyManagerHasNoApprovalRight() public {
        orgs.createOrganizer(OWNER);
        vm.prank(OWNER);
        orgs.setManager(1, OTHER, true, false);
        (bool exists, bool canApprove) = orgs.managerOf(1, OTHER);
        assertTrue(exists);
        assertFalse(canApprove);
    }

    function test_managerCanBeRemoved() public {
        orgs.createOrganizer(OWNER);
        vm.startPrank(OWNER);
        orgs.setManager(1, OTHER, true, true);
        orgs.setManager(1, OTHER, false, false);
        vm.stopPrank();
        (bool exists, bool canApprove) = orgs.managerOf(1, OTHER);
        assertFalse(exists);
        assertFalse(canApprove);
    }

    function test_adminWithManageManagersBitCanAppoint() public {
        orgs.createOrganizer(OWNER);
        address admin = address(0x0A);
        vm.startPrank(OWNER);
        orgs.setAdmin(1, admin, orgs.PERM_MANAGE_MANAGERS());
        vm.stopPrank();

        vm.prank(admin);
        orgs.setManager(1, OTHER, true, false);
        (bool exists,) = orgs.managerOf(1, OTHER);
        assertTrue(exists);
    }

    function test_adminWithoutTheBitCannotAppoint() public {
        orgs.createOrganizer(OWNER);
        address admin = address(0x0A);
        vm.startPrank(OWNER);
        orgs.setAdmin(1, admin, orgs.PERM_MANAGE_GATES());
        vm.stopPrank();

        vm.prank(admin);
        vm.expectRevert(Organizers.Unauthorized.selector);
        orgs.setManager(1, OTHER, true, false);
    }
}
