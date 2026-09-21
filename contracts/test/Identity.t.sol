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
    event AccountRotated(bytes32 indexed personId, address indexed oldAccount, address indexed newAccount);
    event DeviceChanged(address indexed account, bytes32 x, bytes32 y);
    event KycLevelSet(address indexed account, uint8 level);
    event DeviceLocked(address indexed account, bool locked);

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

    function test_setActiveDeviceRequiresMembership() public {
        vm.prank(BOB);
        vm.expectRevert(Identity.NotRegistered.selector);
        identity.setActiveDevice(DEV_X, DEV_Y);
    }

    function test_setActiveDeviceBlockedBeforeSevenDays() public {
        vm.prank(ATTESTER);
        identity.register(PERSON_A, ALICE, DEV_X, DEV_Y, 1);

        vm.warp(block.timestamp + 7 days - 1);
        vm.prank(ALICE);
        vm.expectRevert(Identity.CooldownActive.selector);
        identity.setActiveDevice(bytes32(uint256(0x3333)), bytes32(uint256(0x4444)));
    }

    function test_setActiveDeviceAllowedAfterSevenDays() public {
        vm.prank(ATTESTER);
        identity.register(PERSON_A, ALICE, DEV_X, DEV_Y, 1);

        vm.warp(block.timestamp + 7 days);
        vm.expectEmit(true, false, false, true);
        emit DeviceChanged(ALICE, bytes32(uint256(0x3333)), bytes32(uint256(0x4444)));
        vm.prank(ALICE);
        identity.setActiveDevice(bytes32(uint256(0x3333)), bytes32(uint256(0x4444)));

        (bytes32 x, bytes32 y) = identity.activeDevice(ALICE);
        assertEq(x, bytes32(uint256(0x3333)));
        assertEq(y, bytes32(uint256(0x4444)));
        assertEq(identity.deviceUpdatedAt(ALICE), uint64(block.timestamp));
    }

    function test_setActiveDeviceRejectsZeroKey() public {
        vm.prank(ATTESTER);
        identity.register(PERSON_A, ALICE, DEV_X, DEV_Y, 1);
        vm.warp(block.timestamp + 7 days);
        vm.prank(ALICE);
        vm.expectRevert(Identity.InvalidDeviceKey.selector);
        identity.setActiveDevice(bytes32(0), bytes32(uint256(0x4444)));
    }

    function test_accountLocksItsOwnDevice() public {
        vm.prank(ATTESTER);
        identity.register(PERSON_A, ALICE, DEV_X, DEV_Y, 1);

        vm.expectEmit(true, false, false, true);
        emit DeviceLocked(ALICE, true);
        vm.prank(ALICE);
        identity.lockDevice(ALICE);

        assertTrue(identity.isLocked(ALICE));
    }

    function test_attesterLocksDevice() public {
        vm.prank(ATTESTER);
        identity.register(PERSON_A, ALICE, DEV_X, DEV_Y, 1);

        vm.prank(ATTESTER);
        identity.lockDevice(ALICE);
        assertTrue(identity.isLocked(ALICE));
    }

    function test_strangerCannotLockDevice() public {
        vm.prank(ATTESTER);
        identity.register(PERSON_A, ALICE, DEV_X, DEV_Y, 1);

        vm.prank(BOB);
        vm.expectRevert(Identity.NotAccountOwner.selector);
        identity.lockDevice(ALICE);
    }

    function test_newDeviceAfterCooldownClearsLock() public {
        vm.prank(ATTESTER);
        identity.register(PERSON_A, ALICE, DEV_X, DEV_Y, 1);
        vm.prank(ALICE);
        identity.lockDevice(ALICE);

        vm.warp(block.timestamp + 7 days);
        vm.prank(ALICE);
        identity.setActiveDevice(bytes32(uint256(0x3333)), bytes32(uint256(0x4444)));

        assertFalse(identity.isLocked(ALICE));
    }

    function test_rotateAccountMovesMembershipAndKeepsPersonOfOldAccount() public {
        vm.prank(ATTESTER);
        identity.register(PERSON_A, ALICE, DEV_X, DEV_Y, 1);
        vm.warp(block.timestamp + 7 days);

        vm.expectEmit(true, true, true, false);
        emit AccountRotated(PERSON_A, ALICE, BOB);
        vm.prank(ATTESTER);
        identity.rotateAccount(PERSON_A, BOB);

        assertEq(identity.accountOf(PERSON_A), BOB);
        assertEq(identity.personOf(BOB), PERSON_A);
        assertEq(identity.personOf(ALICE), PERSON_A, "migrate needs the old link");
        assertFalse(identity.isMember(ALICE));
        assertTrue(identity.isMember(BOB));
    }

    function test_rotateAccountBlockedBeforeSevenDays() public {
        vm.prank(ATTESTER);
        identity.register(PERSON_A, ALICE, DEV_X, DEV_Y, 1);
        vm.warp(block.timestamp + 7 days - 1);
        vm.prank(ATTESTER);
        vm.expectRevert(Identity.CooldownActive.selector);
        identity.rotateAccount(PERSON_A, BOB);
    }

    function test_onlyAttesterRotates() public {
        vm.prank(ATTESTER);
        identity.register(PERSON_A, ALICE, DEV_X, DEV_Y, 1);
        vm.warp(block.timestamp + 7 days);
        vm.prank(ALICE);
        vm.expectRevert(AttesterRole.NotAttester.selector);
        identity.rotateAccount(PERSON_A, BOB);
    }

    function test_rotateRejectsUnknownPersonOrUsedAccount() public {
        vm.startPrank(ATTESTER);
        identity.register(PERSON_A, ALICE, DEV_X, DEV_Y, 1);
        identity.register(PERSON_B, BOB, DEV_X, DEV_Y, 1);
        vm.warp(block.timestamp + 7 days);
        vm.expectRevert(Identity.NotRegistered.selector);
        identity.rotateAccount(bytes32(uint256(0xDEAD)), address(0xC0FFEE));
        vm.expectRevert(Identity.AccountAlreadyRegistered.selector);
        identity.rotateAccount(PERSON_A, BOB);
        vm.stopPrank();
    }

    function test_newAccountHasNoDeviceUntilItSetsOne() public {
        vm.prank(ATTESTER);
        identity.register(PERSON_A, ALICE, DEV_X, DEV_Y, 1);
        vm.warp(block.timestamp + 7 days);
        vm.prank(ATTESTER);
        identity.rotateAccount(PERSON_A, BOB);

        (bytes32 x, bytes32 y) = identity.activeDevice(BOB);
        assertEq(x, bytes32(0));
        assertEq(y, bytes32(0));

        // updatedAt == 0 means "never set", so the new phone can register immediately.
        vm.prank(BOB);
        identity.setActiveDevice(DEV_X, DEV_Y);
        (x, y) = identity.activeDevice(BOB);
        assertEq(x, DEV_X);
    }

    function test_rotateAccountPreservesKycLevel() public {
        vm.startPrank(ATTESTER);
        identity.register(PERSON_A, ALICE, DEV_X, DEV_Y, 0);
        assertEq(identity.kycLevelOf(ALICE), 0);

        // Attester raises KYC level for ALICE
        identity.setKycLevel(PERSON_A, 1);
        assertEq(identity.kycLevelOf(ALICE), 1);

        vm.warp(block.timestamp + 7 days);
        identity.rotateAccount(PERSON_A, BOB);
        vm.stopPrank();

        // KYC level should be preserved on new account
        assertEq(identity.kycLevelOf(BOB), 1);
        // Old account still has the level (linked via personOf)
        assertEq(identity.kycLevelOf(ALICE), 1);
    }

    function test_rotateAccountTransfersNickname() public {
        vm.prank(ATTESTER);
        identity.register(PERSON_A, ALICE, DEV_X, DEV_Y, 1);

        // Alice sets a nickname
        bytes32 nicknameHash = keccak256(bytes("alice_01"));
        vm.prank(ALICE);
        identity.setNickname(nicknameHash, "alice_01");

        vm.warp(block.timestamp + 7 days);

        vm.prank(ATTESTER);
        identity.rotateAccount(PERSON_A, BOB);

        // Nickname should be transferred to BOB
        assertEq(identity.nicknameOf(BOB), nicknameHash);
        assertEq(identity.nicknameOwner(nicknameHash), BOB);
        assertEq(identity.nicknameOf(ALICE), bytes32(0));
    }
}
