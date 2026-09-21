// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {Test} from "forge-std/Test.sol";
import {AttesterRole} from "../src/libs/AttesterRole.sol";

contract AttesterRoleHarness is AttesterRole {
    uint256 public calls;

    constructor(address attester_) AttesterRole(attester_) {}

    function attesterOnlyAction() external onlyAttester {
        calls += 1;
    }
}

contract AttesterRoleTest is Test {
    AttesterRoleHarness internal h;
    address internal constant ATTESTER = address(0xA11CE);
    address internal constant STRANGER = address(0xBEEF);

    event AttesterChanged(address indexed previousAttester, address indexed newAttester);

    function setUp() public {
        h = new AttesterRoleHarness(ATTESTER);
    }

    function test_attesterCanCall() public {
        vm.prank(ATTESTER);
        h.attesterOnlyAction();
        assertEq(h.calls(), 1);
    }

    function test_strangerCannotCall() public {
        vm.prank(STRANGER);
        vm.expectRevert(AttesterRole.NotAttester.selector);
        h.attesterOnlyAction();
    }

    function test_deployerRotatesAttester() public {
        vm.expectEmit(true, true, false, false);
        emit AttesterChanged(ATTESTER, STRANGER);
        h.setAttester(STRANGER);
        assertEq(h.attester(), STRANGER);

        vm.prank(STRANGER);
        h.attesterOnlyAction();
        assertEq(h.calls(), 1);
    }

    function test_nonDeployerCannotRotateAttester() public {
        vm.prank(STRANGER);
        vm.expectRevert(AttesterRole.NotDeployer.selector);
        h.setAttester(STRANGER);
    }

    function test_zeroAttesterRejected() public {
        vm.expectRevert(AttesterRole.ZeroAddress.selector);
        new AttesterRoleHarness(address(0));
    }
}
