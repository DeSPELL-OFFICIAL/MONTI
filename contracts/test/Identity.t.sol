// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {Test} from "forge-std/Test.sol";
import {Identity} from "../src/Identity.sol";
import {AttesterRole} from "../src/libs/AttesterRole.sol";

contract IdentityTest is Test {
    Identity internal identity;

    address internal constant ATTESTER = address(0xA11CE);
    address internal constant ALICE = address(0xA1);
    address internal constant BOB = address(0xB0B);
    bytes32 internal constant PERSON_A = bytes32(uint256(0xAAAA));
    bytes32 internal constant PERSON_B = bytes32(uint256(0xBBBB));
    bytes32 internal constant DEV_X = bytes32(uint256(0x1111));
    bytes32 internal constant DEV_Y = bytes32(uint256(0x2222));

    event Registered(bytes32 indexed personId, address indexed account);
    event DeviceChanged(address indexed account, bytes32 x, bytes32 y);
    event KycLevelSet(address indexed account, uint8 level);

    function setUp() public {
        identity = new Identity(ATTESTER);
        vm.warp(1_800_000_000);
    }

    function test_registerStoresBothDirectionsAndDevice() public {
        vm.expectEmit(true, true, false, false);
        emit Registered(PERSON_A, ALICE);
        vm.expectEmit(true, false, false, true);
        emit DeviceChanged(ALICE, DEV_X, DEV_Y);
        vm.expectEmit(true, false, false, true);
        emit KycLevelSet(ALICE, 1);

        vm.prank(ATTESTER);
        identity.register(PERSON_A, ALICE, DEV_X, DEV_Y, 1);

        assertEq(identity.accountOf(PERSON_A), ALICE);
        assertEq(identity.personOf(ALICE), PERSON_A);
        assertTrue(identity.isMember(ALICE));
        assertFalse(identity.isMember(BOB));
        (bytes32 x, bytes32 y) = identity.activeDevice(ALICE);
        assertEq(x, DEV_X);
        assertEq(y, DEV_Y);
        assertEq(identity.deviceUpdatedAt(ALICE), uint64(block.timestamp));
        assertFalse(identity.isLocked(ALICE));
        assertEq(identity.kycLevelOf(ALICE), 1);
    }

    function test_onlyAttesterRegisters() public {
        vm.prank(ALICE);
        vm.expectRevert(AttesterRole.NotAttester.selector);
        identity.register(PERSON_A, ALICE, DEV_X, DEV_Y, 1);
    }

    function test_personIdCannotBeRegisteredTwice() public {
        vm.startPrank(ATTESTER);
        identity.register(PERSON_A, ALICE, DEV_X, DEV_Y, 1);
        vm.expectRevert(Identity.PersonAlreadyRegistered.selector);
        identity.register(PERSON_A, BOB, DEV_X, DEV_Y, 1);
        vm.stopPrank();
    }

    function test_accountCannotBeRegisteredTwice() public {
        vm.startPrank(ATTESTER);
        identity.register(PERSON_A, ALICE, DEV_X, DEV_Y, 1);
        vm.expectRevert(Identity.AccountAlreadyRegistered.selector);
        identity.register(PERSON_B, ALICE, DEV_X, DEV_Y, 1);
        vm.stopPrank();
    }

    function test_registerRejectsZeroValues() public {
        vm.startPrank(ATTESTER);
        vm.expectRevert(Identity.InvalidPersonId.selector);
        identity.register(bytes32(0), ALICE, DEV_X, DEV_Y, 1);
        vm.expectRevert(Identity.InvalidAccount.selector);
        identity.register(PERSON_A, address(0), DEV_X, DEV_Y, 1);
        vm.expectRevert(Identity.InvalidDeviceKey.selector);
        identity.register(PERSON_A, ALICE, bytes32(0), DEV_Y, 1);
        vm.stopPrank();
    }

    function test_cooldownConstantsAreSevenDays() public view {
        assertEq(identity.ROTATION_COOLDOWN(), 7 days);
        assertEq(identity.DEVICE_COOLDOWN(), 7 days);
    }

    function test_registerStoresTheKycLevel() public {
        vm.startPrank(ATTESTER);
        identity.register(PERSON_A, ALICE, DEV_X, DEV_Y, 0);
        identity.register(PERSON_B, BOB, DEV_X, DEV_Y, 1);
        vm.stopPrank();
        assertEq(identity.kycLevelOf(ALICE), 0);
        assertEq(identity.kycLevelOf(BOB), 1);
    }

    function test_attesterRaisesKycLevelAfterALaterKycSession() public {
        vm.prank(ATTESTER);
        identity.register(PERSON_A, ALICE, DEV_X, DEV_Y, 0);

        vm.expectEmit(true, false, false, true);
        emit KycLevelSet(ALICE, 1);
        vm.prank(ATTESTER);
        identity.setKycLevel(PERSON_A, 1);
        assertEq(identity.kycLevelOf(ALICE), 1);
    }

    function test_onlyAttesterSetsKycLevel() public {
        vm.prank(ATTESTER);
        identity.register(PERSON_A, ALICE, DEV_X, DEV_Y, 0);
        vm.prank(ALICE);
        vm.expectRevert(AttesterRole.NotAttester.selector);
        identity.setKycLevel(PERSON_A, 1);

        vm.prank(ATTESTER);
        vm.expectRevert(Identity.NotRegistered.selector);
        identity.setKycLevel(bytes32(uint256(0xDEAD)), 1);
    }
}
