// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {Identity} from "../src/Identity.sol";
import {AttesterRole} from "../src/libs/AttesterRole.sol";

contract IdentityTest is Test {
    Identity internal identity;

    address internal constant ATTESTER = address(0xA11CE);
    address internal constant ALICE = address(0xA1);
    address internal constant BOB = address(0xB0B);
    address internal constant CAROL = address(0xCA);
    bytes32 internal constant PERSON_A = bytes32(uint256(0xAAAA));
    bytes32 internal constant PERSON_B = bytes32(uint256(0xBBBB));
    bytes32 internal constant DEV_X = bytes32(uint256(0x1111));
    bytes32 internal constant DEV_Y = bytes32(uint256(0x2222));

    event Registered(bytes32 indexed personId, address indexed account);
    event AccountRotated(bytes32 indexed personId, address indexed oldAccount, address indexed newAccount);
    event DeviceChanged(address indexed account, bytes32 x, bytes32 y);
    event KycLevelSet(address indexed account, uint8 level);
    event DeviceLocked(address indexed account, bool locked);
    event RotationCancelled(bytes32 indexed personId, address indexed account);

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

    /// @dev 회전은 폰을 잃어버려서 하는 절차다(5.5). 잃어버린 폰은 그 순간부터 문에서 막힌다.
    function test_rotateAccountLocksTheOldDevice() public {
        vm.prank(ATTESTER);
        identity.register(PERSON_A, ALICE, DEV_X, DEV_Y, 1);
        assertFalse(identity.isLocked(ALICE));
        vm.warp(block.timestamp + 7 days);

        vm.prank(ATTESTER);
        identity.rotateAccount(PERSON_A, BOB);

        assertTrue(identity.isLocked(ALICE), "the lost phone is locked at rotation, not at migrate");
        assertFalse(identity.isLocked(BOB), "the new account is not locked");
    }

    /// @dev 이미 잠겨 있었으면 중복 이벤트를 내지 않는다.
    function test_rotateDoesNotRelockAnAlreadyLockedDevice() public {
        vm.prank(ATTESTER);
        identity.register(PERSON_A, ALICE, DEV_X, DEV_Y, 1);
        vm.prank(ALICE);
        identity.lockDevice(ALICE);
        vm.warp(block.timestamp + 7 days);

        vm.recordLogs();
        vm.prank(ATTESTER);
        identity.rotateAccount(PERSON_A, BOB);

        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 locks;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == keccak256("DeviceLocked(address,bool)")) ++locks;
        }
        assertEq(locks, 0, "already locked: no second DeviceLocked");
        assertTrue(identity.isLocked(ALICE));
    }

    function test_rotatedAtStampsRegistrationAndRotation() public {
        uint64 registeredAt = uint64(block.timestamp);
        vm.prank(ATTESTER);
        identity.register(PERSON_A, ALICE, DEV_X, DEV_Y, 1);
        assertEq(identity.rotatedAt(PERSON_A), registeredAt);

        vm.warp(block.timestamp + 7 days);
        uint64 rotatedAt = uint64(block.timestamp);
        vm.prank(ATTESTER);
        identity.rotateAccount(PERSON_A, BOB);
        assertEq(identity.rotatedAt(PERSON_A), rotatedAt);
    }

    /// @dev 6.3 T11. 어테스터가 털려도 직전 계정 본인이 하루 안에 되돌릴 수 있다.
    function test_cancelRotationRestoresTheOldAccount() public {
        vm.prank(ATTESTER);
        identity.register(PERSON_A, ALICE, DEV_X, DEV_Y, 1);
        vm.warp(block.timestamp + 7 days);
        vm.prank(ATTESTER);
        identity.rotateAccount(PERSON_A, BOB);
        assertTrue(identity.isMember(BOB));
        assertEq(identity.rotatedFrom(PERSON_A), ALICE, "the rotation records who it pushed aside");

        vm.expectEmit(true, true, true, false);
        emit AccountRotated(PERSON_A, BOB, ALICE);
        vm.expectEmit(true, true, false, false);
        emit RotationCancelled(PERSON_A, ALICE);
        vm.prank(ALICE);
        identity.cancelRotation();

        assertEq(identity.accountOf(PERSON_A), ALICE);
        assertTrue(identity.isMember(ALICE));
        assertFalse(identity.isMember(BOB));
        assertEq(identity.personOf(BOB), bytes32(0), "the other address is freed, not burned");
        assertEq(identity.rotatedFrom(PERSON_A), address(0), "one undo per rotation");
    }

    /// @dev 취소는 잠금을 풀지 않는다. 되살아난 계정은 정상적인 기기 변경 경로로만 다시 열린다 —
    ///      동기화된 패스키가 취소만으로 문을 열 수 있으면 T6 의 잔존 위험이 커진다.
    function test_cancelRotationLeavesTheRotationLockInPlace() public {
        vm.prank(ATTESTER);
        identity.register(PERSON_A, ALICE, DEV_X, DEV_Y, 1);
        vm.warp(block.timestamp + 7 days);
        vm.prank(ATTESTER);
        identity.rotateAccount(PERSON_A, BOB);
        assertTrue(identity.isLocked(ALICE));

        vm.prank(ALICE);
        identity.cancelRotation();
        assertTrue(identity.isLocked(ALICE), "the lock survives the undo");

        // 정상 경로로만 풀린다. 마지막 기기 변경이 7일 넘게 지났으므로 지금 바로 된다.
        vm.prank(ALICE);
        identity.setActiveDevice(DEV_X, DEV_Y);
        assertFalse(identity.isLocked(ALICE));
    }

    /// @dev 창이 닫히면 끝이다. 이게 없으면 _personOf 가 영원히 남는 성질 때문에
    ///      "그 사람이 지금까지 가져본 모든 계정"이 시한 없이 되돌릴 수 있게 된다.
    function test_cancelRotationClosesAfterTheUndoWindow() public {
        vm.prank(ATTESTER);
        identity.register(PERSON_A, ALICE, DEV_X, DEV_Y, 1);
        vm.warp(block.timestamp + 7 days);
        vm.prank(ATTESTER);
        identity.rotateAccount(PERSON_A, BOB);

        vm.warp(block.timestamp + identity.ROTATION_UNDO_WINDOW());
        vm.prank(ALICE);
        vm.expectRevert(Identity.NoRotationToCancel.selector);
        identity.cancelRotation();

        assertEq(identity.accountOf(PERSON_A), BOB, "the recovery stands");
    }

    /// @dev 창의 마지막 1초는 아직 열려 있다. 경계가 `>=` 인지 `>` 인지를 위 테스트와 한 쌍으로 고정한다.
    function test_cancelRotationStillWorksOneSecondBeforeTheWindowCloses() public {
        vm.prank(ATTESTER);
        identity.register(PERSON_A, ALICE, DEV_X, DEV_Y, 1);
        vm.warp(block.timestamp + 7 days);
        vm.prank(ATTESTER);
        identity.rotateAccount(PERSON_A, BOB);

        vm.warp(block.timestamp + identity.ROTATION_UNDO_WINDOW() - 1);
        vm.prank(ALICE);
        identity.cancelRotation();
        assertEq(identity.accountOf(PERSON_A), ALICE);
    }

    /// @dev 두 번 회전한 뒤 가장 오래된 계정은 아무 권한도 없다. A 가 몇 년 뒤에 C 를 쫓아내
    ///      C 의 티켓을 얼려버리는 경로가 바로 이것이었다.
    function test_anOlderAccountCannotCancelALaterRotation() public {
        vm.prank(ATTESTER);
        identity.register(PERSON_A, ALICE, DEV_X, DEV_Y, 1);
        vm.warp(block.timestamp + 7 days);
        vm.prank(ATTESTER);
        identity.rotateAccount(PERSON_A, BOB);
        vm.warp(block.timestamp + 7 days);
        vm.prank(ATTESTER);
        identity.rotateAccount(PERSON_A, CAROL);

        assertEq(identity.rotatedFrom(PERSON_A), BOB, "only the immediately previous account");
        vm.prank(ALICE);
        vm.expectRevert(Identity.NoRotationToCancel.selector);
        identity.cancelRotation();
        assertEq(identity.accountOf(PERSON_A), CAROL);
    }

    /// @dev 되돌리기는 회전 하나당 한 번이다. 두 번째 호출은 자격 자체가 사라져 있다.
    function test_cancelRotationCannotBeRunTwice() public {
        vm.prank(ATTESTER);
        identity.register(PERSON_A, ALICE, DEV_X, DEV_Y, 1);
        vm.warp(block.timestamp + 7 days);
        vm.prank(ATTESTER);
        identity.rotateAccount(PERSON_A, BOB);

        vm.prank(ALICE);
        identity.cancelRotation();

        vm.prank(ALICE);
        vm.expectRevert(Identity.NoRotationToCancel.selector);
        identity.cancelRotation();
        assertEq(identity.accountOf(PERSON_A), ALICE);
        assertEq(identity.personOf(BOB), bytes32(0), "the second call changes nothing");
    }

    /// @dev 취소해도 쿨다운 스탬프는 되감지 않는다. 공격자는 다음 시도까지 7일을 꼬박 기다린다.
    function test_cancelRotationDoesNotRewindTheCooldown() public {
        vm.prank(ATTESTER);
        identity.register(PERSON_A, ALICE, DEV_X, DEV_Y, 1);
        vm.warp(block.timestamp + 7 days);
        uint64 attemptedAt = uint64(block.timestamp);
        vm.prank(ATTESTER);
        identity.rotateAccount(PERSON_A, BOB);
        vm.prank(ALICE);
        identity.cancelRotation();

        assertEq(identity.rotatedAt(PERSON_A), attemptedAt);
        vm.prank(ATTESTER);
        vm.expectRevert(Identity.CooldownActive.selector);
        identity.rotateAccount(PERSON_A, BOB);
    }

    function test_cancelRotationTakesTheNicknameBack() public {
        vm.prank(ATTESTER);
        identity.register(PERSON_A, ALICE, DEV_X, DEV_Y, 1);
        bytes32 nick = keccak256(bytes("alice_01"));
        vm.prank(ALICE);
        identity.setNickname(nick, "alice_01");
        vm.warp(block.timestamp + 7 days);
        vm.prank(ATTESTER);
        identity.rotateAccount(PERSON_A, BOB);

        vm.prank(ALICE);
        identity.cancelRotation();

        assertEq(identity.nicknameOf(ALICE), nick);
        assertEq(identity.nicknameOwner(nick), ALICE);
        assertEq(identity.nicknameOf(BOB), bytes32(0));
    }

    function test_cancelRotationRejectsTheCurrentAccountAndStrangers() public {
        vm.prank(ATTESTER);
        identity.register(PERSON_A, ALICE, DEV_X, DEV_Y, 1);

        // 회전한 적이 없으므로 되돌릴 것도 없다.
        vm.prank(ALICE);
        vm.expectRevert(Identity.NoRotationToCancel.selector);
        identity.cancelRotation();

        vm.prank(BOB);
        vm.expectRevert(Identity.NotRegistered.selector);
        identity.cancelRotation();
    }

    /// @dev 회전으로 들어온 새 계정은 자기 회전을 스스로 되돌릴 수 없다.
    function test_theNewAccountCannotCancelItsOwnRotation() public {
        vm.prank(ATTESTER);
        identity.register(PERSON_A, ALICE, DEV_X, DEV_Y, 1);
        vm.warp(block.timestamp + 7 days);
        vm.prank(ATTESTER);
        identity.rotateAccount(PERSON_A, BOB);

        vm.prank(BOB);
        vm.expectRevert(Identity.NoRotationToCancel.selector);
        identity.cancelRotation();
    }
}
