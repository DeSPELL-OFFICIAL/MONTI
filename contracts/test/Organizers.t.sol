// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {Test} from "forge-std/Test.sol";
import {Organizers} from "../src/Organizers.sol";

contract OrganizersTest is Test {
    Organizers internal orgs;
    address internal constant OWNER = address(0x01);
    address internal constant OTHER = address(0x02);
    /// @dev v2 D7: organizer ids start at 1001.
    uint256 internal constant ORG = 1001;

    event OrganizerCreated(uint256 indexed orgId, address indexed owner);
    event OwnerTransferred(uint256 indexed orgId, address indexed from, address indexed to);
    event AdminSet(uint256 indexed orgId, address indexed admin, uint32 bits);
    event ManagerSet(uint256 indexed orgId, address indexed manager, bool exists, bool canApprove);

    function setUp() public {
        orgs = new Organizers(address(0));
        vm.warp(1_800_000_000);
    }

    function test_createOrganizerStartsAt1001AndIncrements() public {
        vm.expectEmit(true, true, false, false);
        emit OrganizerCreated(ORG, OWNER);
        uint256 a = orgs.createOrganizer(OWNER);
        uint256 b = orgs.createOrganizer(OTHER);
        assertEq(a, ORG);
        assertEq(b, ORG + 1);
        assertEq(orgs.ownerOf(ORG), OWNER);
        assertEq(orgs.ownerOf(ORG + 1), OTHER);
    }

    function test_ownerTransfer() public {
        orgs.createOrganizer(OWNER);
        vm.expectEmit(true, true, true, false);
        emit OwnerTransferred(ORG, OWNER, OTHER);
        vm.prank(OWNER);
        orgs.transferOwner(ORG, OTHER);
        assertEq(orgs.ownerOf(ORG), OTHER);
    }

    function test_nonOwnerCannotTransfer() public {
        orgs.createOrganizer(OWNER);
        vm.prank(OTHER);
        vm.expectRevert(Organizers.NotOwner.selector);
        orgs.transferOwner(ORG, OTHER);
    }

    function test_setTicketOnlyOnceAndOnlyDeployer() public {
        orgs.setTicket(address(0x7107));
        assertEq(orgs.ticket(), address(0x7107));
        vm.expectRevert(Organizers.TicketAlreadySet.selector);
        orgs.setTicket(address(0xBEEF));
        Organizers fresh = new Organizers(address(0));
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
        assertTrue(orgs.hasPermission(ORG, OWNER, orgs.PERM_CREATE_EVENT()));
        assertTrue(orgs.hasPermission(ORG, OWNER, orgs.PERM_MANAGE_BUDGET()));
        assertFalse(orgs.hasPermission(ORG, OTHER, orgs.PERM_CREATE_EVENT()));
    }

    function test_setAdminGrantsOnlyTheGivenBits() public {
        orgs.createOrganizer(OWNER);
        uint32 permBits = orgs.PERM_CREATE_EVENT() | orgs.PERM_MANAGE_GATES();
        vm.expectEmit(true, true, false, true);
        emit AdminSet(ORG, OTHER, 3);
        vm.prank(OWNER);
        orgs.setAdmin(ORG, OTHER, permBits);

        assertTrue(orgs.hasPermission(ORG, OTHER, orgs.PERM_CREATE_EVENT()));
        assertTrue(orgs.hasPermission(ORG, OTHER, orgs.PERM_MANAGE_GATES()));
        assertFalse(orgs.hasPermission(ORG, OTHER, orgs.PERM_APPROVE_OVERRIDE()));
        assertFalse(orgs.hasPermission(ORG, OTHER, orgs.PERM_MANAGE_MANAGERS()));
    }

    function test_setAdminCanRevokeByPassingZero() public {
        orgs.createOrganizer(OWNER);
        vm.startPrank(OWNER);
        orgs.setAdmin(ORG, OTHER, orgs.PERM_MANAGE_GATES());
        orgs.setAdmin(ORG, OTHER, 0);
        vm.stopPrank();
        assertFalse(orgs.hasPermission(ORG, OTHER, orgs.PERM_MANAGE_GATES()));
    }

    function test_onlyOwnerSetsAdmin() public {
        orgs.createOrganizer(OWNER);
        vm.prank(OTHER);
        vm.expectRevert(Organizers.NotOwner.selector);
        orgs.setAdmin(ORG, OTHER, 1);
    }

    function test_ownerAppointsManagerWithApprovalRight() public {
        orgs.createOrganizer(OWNER);
        vm.expectEmit(true, true, false, true);
        emit ManagerSet(ORG, OTHER, true, true);
        vm.prank(OWNER);
        orgs.setManager(ORG, OTHER, true, true);

        (bool exists, bool canApprove) = orgs.managerOf(ORG, OTHER);
        assertTrue(exists);
        assertTrue(canApprove);
    }

    function test_requestOnlyManagerHasNoApprovalRight() public {
        orgs.createOrganizer(OWNER);
        vm.prank(OWNER);
        orgs.setManager(ORG, OTHER, true, false);
        (bool exists, bool canApprove) = orgs.managerOf(ORG, OTHER);
        assertTrue(exists);
        assertFalse(canApprove);
    }

    function test_managerCanBeRemoved() public {
        orgs.createOrganizer(OWNER);
        vm.startPrank(OWNER);
        orgs.setManager(ORG, OTHER, true, true);
        orgs.setManager(ORG, OTHER, false, false);
        vm.stopPrank();
        (bool exists, bool canApprove) = orgs.managerOf(ORG, OTHER);
        assertFalse(exists);
        assertFalse(canApprove);
    }

    function test_adminWithManageManagersBitCanAppoint() public {
        orgs.createOrganizer(OWNER);
        address admin = address(0x0A);
        vm.startPrank(OWNER);
        orgs.setAdmin(ORG, admin, orgs.PERM_MANAGE_MANAGERS());
        vm.stopPrank();

        vm.prank(admin);
        orgs.setManager(ORG, OTHER, true, false);
        (bool exists,) = orgs.managerOf(ORG, OTHER);
        assertTrue(exists);
    }

    function test_adminWithoutTheBitCannotAppoint() public {
        orgs.createOrganizer(OWNER);
        address admin = address(0x0A);
        vm.startPrank(OWNER);
        orgs.setAdmin(ORG, admin, orgs.PERM_MANAGE_GATES());
        vm.stopPrank();

        vm.prank(admin);
        vm.expectRevert(Organizers.Unauthorized.selector);
        orgs.setManager(ORG, OTHER, true, false);
    }
}
