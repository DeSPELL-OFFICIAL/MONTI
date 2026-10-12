// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {Test} from "forge-std/Test.sol";
import {Organizers} from "../src/Organizers.sol";
import {MockTicket} from "./mocks/MockTicket.sol";

contract OrganizersGatesTest is Test {
    Organizers internal orgs;
    MockTicket internal ticket;

    address internal constant OWNER = address(0x01);
    address internal constant GATEKEEPER = address(0x0A);
    address internal constant STRANGER = address(0x02);
    address internal constant GATE_ACCOUNT = address(0x6A7E);
    bytes32 internal constant KX = bytes32(uint256(0xAAA1));
    bytes32 internal constant KY = bytes32(uint256(0xAAA2));

    event GateRegistered(
        uint256 indexed gateId, uint256 indexed eventId, address indexed gateAccount, bytes32 kx, bytes32 ky
    );
    event GateOpened(uint256 indexed gateId);
    event GateClosed(uint256 indexed gateId);
    event GateRevoked(uint256 indexed gateId);

    uint256 internal orgId;

    function setUp() public {
        orgs = new Organizers(address(0));
        ticket = new MockTicket();
        orgs.setTicket(address(ticket));
        orgId = orgs.createOrganizer(OWNER);
        ticket.setEventOrg(7, orgId);
        uint32 gateBit = orgs.PERM_MANAGE_GATES();
        vm.prank(OWNER);
        orgs.setAdmin(orgId, GATEKEEPER, gateBit);
        vm.warp(1_800_000_000);
    }

    /// @dev v2 D7: organizer ids start at 1001 so v2 Firestore keys never collide with v1.
    function test_firstOrgIdIs1001() public {
        assertEq(orgId, 1001);
        assertEq(orgs.createOrganizer(STRANGER), 1002);
    }

    /// @dev v2 D3: approval is opening. GateRegistered then GateOpened, in that order, and the gate is
    ///      open straight away (gate ids are not offset — they key no Firestore document).
    function test_adminWithGateBitRegistersGate() public {
        vm.expectEmit(true, true, true, true);
        emit GateRegistered(1, 7, GATE_ACCOUNT, KX, KY);
        vm.expectEmit(true, false, false, true);
        emit GateOpened(1);
        vm.prank(GATEKEEPER);
        uint256 gateId = orgs.registerGate(7, GATE_ACCOUNT, KX, KY);

        assertEq(gateId, 1);
        assertEq(orgs.gateOf(GATE_ACCOUNT), 1);
        (uint256 eventId, address account, bytes32 kx, bytes32 ky, bool open, bool revoked) = orgs.gateInfo(1);
        assertEq(eventId, 7);
        assertEq(account, GATE_ACCOUNT);
        assertEq(kx, KX);
        assertEq(ky, KY);
        assertTrue(open, "v2: gates start open");
        assertFalse(revoked);
        assertTrue(orgs.isOpenGate(7, GATE_ACCOUNT));
    }

    function test_unknownAccountHasGateIdZero() public view {
        assertEq(orgs.gateOf(STRANGER), 0);
    }

    function test_strangerCannotRegisterGate() public {
        vm.prank(STRANGER);
        vm.expectRevert(Organizers.Unauthorized.selector);
        orgs.registerGate(7, GATE_ACCOUNT, KX, KY);
    }

    function test_sameGateAccountCannotBeRegisteredTwice() public {
        vm.startPrank(GATEKEEPER);
        orgs.registerGate(7, GATE_ACCOUNT, KX, KY);
        vm.expectRevert(Organizers.GateAccountInUse.selector);
        orgs.registerGate(7, GATE_ACCOUNT, KX, KY);
        vm.stopPrank();
    }

    function test_registerGateNeedsTicketWired() public {
        Organizers fresh = new Organizers(address(0));
        fresh.createOrganizer(OWNER);
        vm.prank(OWNER);
        vm.expectRevert(Organizers.TicketNotSet.selector);
        fresh.registerGate(7, GATE_ACCOUNT, KX, KY);
    }

    function test_registerGateRejectsAllZeroKey() public {
        vm.prank(GATEKEEPER);
        vm.expectRevert(Organizers.InvalidGateKey.selector);
        orgs.registerGate(7, GATE_ACCOUNT, bytes32(0), bytes32(0));
    }

    function _registered() internal returns (uint256 gateId) {
        vm.prank(GATEKEEPER);
        gateId = orgs.registerGate(7, GATE_ACCOUNT, KX, KY);
    }

    function test_openAndCloseFlipIsOpenGate() public {
        uint256 gateId = _registered();
        assertTrue(orgs.isOpenGate(7, GATE_ACCOUNT), "open on register");

        vm.expectEmit(true, false, false, false);
        emit GateClosed(gateId);
        vm.prank(GATEKEEPER);
        orgs.closeGate(gateId);
        assertFalse(orgs.isOpenGate(7, GATE_ACCOUNT));

        vm.expectEmit(true, false, false, false);
        emit GateOpened(gateId);
        vm.prank(GATEKEEPER);
        orgs.openGate(gateId);
        assertTrue(orgs.isOpenGate(7, GATE_ACCOUNT));
    }

    function test_isOpenGateIsFalseForAnotherEvent() public {
        uint256 gateId = _registered();
        vm.prank(GATEKEEPER);
        orgs.openGate(gateId);
        assertFalse(orgs.isOpenGate(8, GATE_ACCOUNT), "gate belongs to event 7 only");
    }

    function test_isOpenGateIsFalseForAnUnknownAccount() public {
        uint256 gateId = _registered();
        vm.prank(GATEKEEPER);
        orgs.openGate(gateId);
        assertFalse(orgs.isOpenGate(7, STRANGER), "T14: a fake gate is not on the allowlist");
    }

    function test_revokedGateStopsBeingOpen() public {
        uint256 gateId = _registered();
        vm.startPrank(GATEKEEPER);
        orgs.openGate(gateId);
        vm.expectEmit(true, false, false, false);
        emit GateRevoked(gateId);
        orgs.revokeGate(gateId);
        vm.stopPrank();

        assertFalse(orgs.isOpenGate(7, GATE_ACCOUNT));
        vm.prank(GATEKEEPER);
        vm.expectRevert(Organizers.GateIsRevoked.selector);
        orgs.openGate(gateId);
    }

    /// @dev An id nobody ever registered is its own error, not a permission failure -- the staff app
    ///      needs to tell "wrong gate id" apart from "not your gate".
    function test_openGateRejectsAnUnknownGateId() public {
        vm.prank(GATEKEEPER);
        vm.expectRevert(Organizers.UnknownGate.selector);
        orgs.openGate(4242);
    }

    /// @dev The gate bit is granted per organizer: holding it for another project opens nothing here.
    function test_gateAdminOfAnotherOrganizerCannotOpenThisGate() public {
        uint256 gateId = _registered();

        address otherOwner = address(0x03);
        address otherAdmin = address(0x0B);
        uint32 gateBit = orgs.PERM_MANAGE_GATES();
        uint256 otherOrgId = orgs.createOrganizer(otherOwner);
        vm.prank(otherOwner);
        orgs.setAdmin(otherOrgId, otherAdmin, gateBit);

        vm.prank(otherAdmin);
        vm.expectRevert(Organizers.Unauthorized.selector);
        orgs.openGate(gateId);
    }

    function test_strangerCannotOpenGate() public {
        uint256 gateId = _registered();
        vm.prank(STRANGER);
        vm.expectRevert(Organizers.Unauthorized.selector);
        orgs.openGate(gateId);
    }

    /// @dev T14 의 대응 수단은 revokeGate 다. 폐기된 게이트 계정은 페이마스터가 더 이상
    ///      스폰서하지 않아야 하고(gateOf == 0), 그 주소를 새 단말기로 다시 쓸 수 있어야 한다.
    function test_revokeGateReleasesTheAccount() public {
        uint256 gateId = _registerGate(GATE_ACCOUNT);
        assertEq(orgs.gateOf(GATE_ACCOUNT), gateId);

        vm.prank(GATEKEEPER);
        orgs.revokeGate(gateId);

        assertEq(orgs.gateOf(GATE_ACCOUNT), 0, "a revoked gate is no longer a sponsored sender");
        (,,,, bool open, bool revoked) = orgs.gateInfo(gateId);
        assertFalse(open);
        assertTrue(revoked, "the record survives; only the live mapping goes");
    }

    function test_aRevokedAccountCanBeRegisteredAgain() public {
        uint256 first = _registerGate(GATE_ACCOUNT);
        vm.prank(GATEKEEPER);
        orgs.revokeGate(first);

        uint256 second = _registerGate(GATE_ACCOUNT);
        assertGt(second, first, "a fresh gate id, not the old one");
        assertEq(orgs.gateOf(GATE_ACCOUNT), second);
        assertTrue(orgs.isOpenGate(7, GATE_ACCOUNT), "a fresh gate starts open (v2 D3)");
    }

    function test_theOldGateIdStaysRevokedAfterReRegistration() public {
        uint256 first = _registerGate(GATE_ACCOUNT);
        vm.prank(GATEKEEPER);
        orgs.revokeGate(first);
        _registerGate(GATE_ACCOUNT);

        vm.prank(GATEKEEPER);
        vm.expectRevert(Organizers.GateIsRevoked.selector);
        orgs.openGate(first);
    }

    /// @dev Minor 2. 반쪽 0 키는 관객 폰의 게이트 서명 검증(T14 방어 1)을 깬다. Identity 와 맞춘다.
    function test_registerGateRejectsAHalfZeroKey() public {
        vm.startPrank(GATEKEEPER);
        vm.expectRevert(Organizers.InvalidGateKey.selector);
        orgs.registerGate(7, GATE_ACCOUNT, bytes32(0), KY);
        vm.expectRevert(Organizers.InvalidGateKey.selector);
        orgs.registerGate(7, GATE_ACCOUNT, KX, bytes32(0));
        vm.stopPrank();
    }

    function _registerGate(address account) internal returns (uint256 gateId) {
        vm.prank(GATEKEEPER);
        gateId = orgs.registerGate(7, account, KX, KY);
    }
}
