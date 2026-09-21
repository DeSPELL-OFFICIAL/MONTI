// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {MontiTest} from "./Base.t.sol";
import {Ticket} from "../src/Ticket.sol";
import {P256Vectors} from "./utils/P256Vectors.sol";

contract TicketTransferTest is MontiTest {
    uint256 internal orgId;
    uint256 internal eventId;
    uint256 internal tokenId;

    function setUp() public {
        _deployMonti();
        _memberWithDeviceKey(ALICE, 0xA1A1);
        _member(BOB, 0xB0B0);
        orgId = _org();
        eventId = _freeEvent(orgId, 1, 1, true);
        vm.prank(ALICE);
        tokenId = ticket.claim(eventId, 0, "");
    }

    function test_transferToMemberSucceedsAndCounts() public {
        vm.prank(ALICE);
        ticket.transferFrom(ALICE, BOB, tokenId);

        assertEq(ticket.ownerOf(tokenId), BOB);
        assertEq(ticket.transfersOf(tokenId), 1);
        assertEq(ticket.balanceOfEvent(ALICE, eventId), 0);
        assertEq(ticket.balanceOfEvent(BOB, eventId), 1);
    }

    function test_transferToNonMemberReverts() public {
        vm.prank(ALICE);
        vm.expectRevert(Ticket.NotMember.selector);
        ticket.transferFrom(ALICE, CAROL, tokenId);
    }

    function test_maxPerWalletEnforcedOnTransfer() public {
        vm.prank(BOB);
        ticket.claim(eventId, 0, "");

        vm.prank(ALICE);
        vm.expectRevert(Ticket.MaxPerWalletExceeded.selector);
        ticket.transferFrom(ALICE, BOB, tokenId);
    }

    function test_maxTransfersEnforced() public {
        _member(CAROL, 0xCACA);
        vm.prank(ALICE);
        ticket.transferFrom(ALICE, BOB, tokenId);

        vm.prank(BOB);
        vm.expectRevert(Ticket.TransferLimitReached.selector);
        ticket.transferFrom(BOB, CAROL, tokenId);
    }

    function test_transferAfterCutoffReverts() public {
        // doors at T0 + 1 day, cutoff 2 hours before.
        vm.warp(T0 + 1 days - 2 hours + 1);
        vm.prank(ALICE);
        vm.expectRevert(Ticket.TransferCutoffPassed.selector);
        ticket.transferFrom(ALICE, BOB, tokenId);
    }

    function test_transferAtExactCutoffReverts() public {
        // The cutoff instant itself is closed: transfer is allowed only while now < startsAt - cutoff.
        vm.warp(T0 + 1 days - 2 hours);
        vm.prank(ALICE);
        vm.expectRevert(Ticket.TransferCutoffPassed.selector);
        ticket.transferFrom(ALICE, BOB, tokenId);
    }

    function test_transferBlockedWhenEventIsNotTransferable() public {
        uint256 lockedEvent = _freeEvent(orgId, 1, 1, false);
        vm.prank(BOB);
        uint256 locked = ticket.claim(lockedEvent, 0, "");

        vm.prank(BOB);
        vm.expectRevert(Ticket.TransfersDisabled.selector);
        ticket.transferFrom(BOB, ALICE, locked);
    }

    function test_transferToLevelZeroBlockedOnAKycEvent() public {
        uint256 kycEventId = _kycEvent(orgId);
        vm.prank(ALICE);
        uint256 kycToken = ticket.claim(kycEventId, 0, "");
        _memberWithLevel(address(0xD0), 0xD0D0, 0);

        vm.prank(ALICE);
        vm.expectRevert(Ticket.KycRequired.selector);
        ticket.transferFrom(ALICE, address(0xD0), kycToken);
    }

    function test_safeTransferFromFollowsTheSameRules() public {
        vm.prank(ALICE);
        vm.expectRevert(Ticket.NotMember.selector);
        ticket.safeTransferFrom(ALICE, CAROL, tokenId);
    }

    /// @dev A ticket that is already inside the venue can never move again: the admission record is the
    ///      end of its transfer life (spec 10.2).
    function test_transferAfterCheckInReverts() public {
        uint256 gateId;
        vm.startPrank(ORG_OWNER);
        gateId = organizers.registerGate(eventId, GATE_A, bytes32(uint256(0x6A01)), bytes32(uint256(0x6A02)));
        organizers.openGate(gateId);
        vm.stopPrank();

        // ALICE holds token 1 for event 1 — exactly what the vectors were generated for.
        vm.warp(P256Vectors.ISSUED_AT + 5);
        vm.prank(GATE_A);
        ticket.checkIn(
            tokenId,
            Ticket.GateCode({
                gateId: gateId, eventId: P256Vectors.EVENT_ID, issuedAt: P256Vectors.ISSUED_AT, nonce: P256Vectors.NONCE
            }),
            abi.encode(P256Vectors.GATE1_R, P256Vectors.GATE1_S)
        );

        vm.prank(ALICE);
        vm.expectRevert(Ticket.AlreadyCheckedIn.selector);
        ticket.transferFrom(ALICE, BOB, tokenId);
    }

    /// @dev 5.5 패닉 버튼. 기기 잠금은 입장만이 아니라 자산도 얼린다.
    function test_lockedSenderCannotTransferOut() public {
        vm.prank(ALICE);
        identity.lockDevice(ALICE);

        vm.prank(ALICE);
        vm.expectRevert(Ticket.DeviceLocked.selector);
        ticket.transferFrom(ALICE, BOB, tokenId);
    }

    /// @dev 회전으로 밀려난 계정은 더 이상 멤버가 아니다. 새 계정이 migrate 하기 전에
    ///      옛 계정이 티켓을 빼돌릴 수 없어야 한다.
    function test_rotatedAwaySenderCannotTransferOut() public {
        vm.warp(T0 + 7 days);
        vm.prank(attester);
        identity.rotateAccount(bytes32(uint256(0xA1A1)), CAROL);

        vm.prank(ALICE);
        vm.expectRevert(Ticket.NotMember.selector);
        ticket.transferFrom(ALICE, BOB, tokenId);
    }

    /// @dev 잠금이 풀리면 보내는 쪽 가드를 통과한다. 그 뒤에 걸리는 것은 양도 마감이지
    ///      잠금이 아니다 — 가드가 마감 검사보다 앞에 놓인다는 사실까지 이 한 줄이 고정한다.
    ///      (새 기기 등록에 7일 쿨타임이 필요해 시계를 감으므로, 이 시점엔 마감이 이미 지났다.)
    function test_transferWorksAgainAfterTheLockIsCleared() public {
        vm.prank(ALICE);
        identity.lockDevice(ALICE);
        vm.warp(T0 + 7 days);
        vm.prank(ALICE);
        identity.setActiveDevice(DEV_X, DEV_Y);

        vm.prank(ALICE);
        vm.expectRevert(Ticket.TransferCutoffPassed.selector);
        ticket.transferFrom(ALICE, BOB, tokenId);
    }
}
