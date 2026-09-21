// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {Test} from "forge-std/Test.sol";
import {Identity} from "../src/Identity.sol";

contract IdentityNicknameTest is Test {
    Identity internal identity;
    address internal constant ATTESTER = address(0xA11CE);
    address internal constant ALICE = address(0xA1);
    address internal constant BOB = address(0xB0B);
    bytes32 internal constant PERSON_A = bytes32(uint256(0xAAAA));
    bytes32 internal constant PERSON_B = bytes32(uint256(0xBBBB));
    bytes32 internal constant DEV_X = bytes32(uint256(0x1111));
    bytes32 internal constant DEV_Y = bytes32(uint256(0x2222));

    event NicknameSet(address indexed account, bytes32 indexed nicknameHash, string nickname);

    function setUp() public {
        identity = new Identity(ATTESTER);
        vm.warp(1_800_000_000);
        vm.startPrank(ATTESTER);
        identity.register(PERSON_A, ALICE, DEV_X, DEV_Y, 1);
        identity.register(PERSON_B, BOB, DEV_X, DEV_Y, 1);
        vm.stopPrank();
    }

    function _h(string memory s) internal pure returns (bytes32) {
        return keccak256(bytes(s));
    }

    function test_setNicknameStoresBothDirections() public {
        vm.expectEmit(true, true, false, true);
        emit NicknameSet(ALICE, _h("alice_01"), "alice_01");
        vm.prank(ALICE);
        identity.setNickname(_h("alice_01"), "alice_01");

        assertEq(identity.nicknameOwner(_h("alice_01")), ALICE);
        assertEq(identity.nicknameOf(ALICE), _h("alice_01"));
    }

    function test_nicknameMustBeUnique() public {
        vm.prank(ALICE);
        identity.setNickname(_h("alice_01"), "alice_01");

        vm.prank(BOB);
        vm.expectRevert(Identity.NicknameTaken.selector);
        identity.setNickname(_h("alice_01"), "alice_01");
    }

    function test_resettingNicknameFreesThePreviousOne() public {
        vm.startPrank(ALICE);
        identity.setNickname(_h("alice_01"), "alice_01");
        identity.setNickname(_h("alice_02"), "alice_02");
        vm.stopPrank();

        assertEq(identity.nicknameOwner(_h("alice_01")), address(0));
        assertEq(identity.nicknameOwner(_h("alice_02")), ALICE);
        assertEq(identity.nicknameOf(ALICE), _h("alice_02"));

        vm.prank(BOB);
        identity.setNickname(_h("alice_01"), "alice_01");
        assertEq(identity.nicknameOwner(_h("alice_01")), BOB);
    }

    function test_hashMustMatchTheString() public {
        vm.prank(ALICE);
        vm.expectRevert(Identity.NicknameHashMismatch.selector);
        identity.setNickname(_h("alice_01"), "alice_02");
    }

    function test_nonMemberCannotSetNickname() public {
        vm.prank(address(0xDEAD));
        vm.expectRevert(Identity.NotRegistered.selector);
        identity.setNickname(_h("ghost"), "ghost");
    }

    function test_settingTheSameNicknameTwiceIsANoOpNotARevert() public {
        vm.startPrank(ALICE);
        identity.setNickname(_h("alice_01"), "alice_01");
        identity.setNickname(_h("alice_01"), "alice_01");
        vm.stopPrank();
        assertEq(identity.nicknameOwner(_h("alice_01")), ALICE);
    }
}
