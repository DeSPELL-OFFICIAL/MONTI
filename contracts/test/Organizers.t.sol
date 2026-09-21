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
}
