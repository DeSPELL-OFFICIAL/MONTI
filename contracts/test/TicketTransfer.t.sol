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
        tokenId = _claimForFixture(ALICE, eventId, 0);
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
        _claimForFixture(BOB, eventId, 0);

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
        uint256 locked = _claimForFixture(BOB, lockedEvent, 0);

        vm.prank(BOB);
        vm.expectRevert(Ticket.TransfersDisabled.selector);
        ticket.transferFrom(BOB, ALICE, locked);
    }

    function test_transferToLevelZeroBlockedOnAKycEvent() public {
        uint256 kycEventId = _kycEvent(orgId);
        uint256 kycToken = _claimForFixture(ALICE, kycEventId, 0);
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
        gateId = organizers.registerGate(eventId, GATE_A, GATE_KX, GATE_KY);
        organizers.openGate(gateId);
        vm.stopPrank();

        // ALICE holds token 1 for event 1 — exactly what the vectors were generated for.
        vm.warp(P256Vectors.ISSUED_AT + 5);
        Ticket.GateCode memory code = Ticket.GateCode({
            gateId: gateId, eventId: P256Vectors.EVENT_ID, issuedAt: P256Vectors.ISSUED_AT, nonce: P256Vectors.NONCE
        });
        // 릴레이 입장: 게이트 서명 + 관객 기기 서명을 임의 RELAYER 가 대신 제출한다.
        _checkInFor(tokenId, code);

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

    /// @dev 잠금은 양쪽 끝을 다 얼린다. 잠긴 계정으로 받은 티켓은 문에서 DeviceLocked 로 막히므로
    ///      (checkIn), 받는 것 자체를 여기서 거절하는 편이 "왜 내 티켓이 안 먹히지"를 없앤다.
    function test_lockedRecipientCannotReceive() public {
        vm.prank(BOB);
        identity.lockDevice(BOB);

        vm.prank(ALICE);
        vm.expectRevert(Ticket.DeviceLocked.selector);
        ticket.transferFrom(ALICE, BOB, tokenId);
        assertEq(ticket.ownerOf(tokenId), ALICE);
    }

    /// @dev 받는 쪽 잠금이 풀리면 전송은 정상적으로 끝난다 — 위 거절이 잠금 때문이지 다른
    ///      이유가 아니었음을 같은 픽스처로 증명한다.
    function test_transferSucceedsOnceTheRecipientsLockIsCleared() public {
        vm.prank(BOB);
        identity.lockDevice(BOB);
        vm.warp(T0 + 7 days);
        vm.prank(BOB);
        identity.setActiveDevice(DEV_X, DEV_Y);
        assertFalse(identity.isLocked(BOB));

        // 이 시점엔 양도 마감이 지났으므로 시계를 픽스처의 창 안으로 되돌린다.
        vm.warp(T0 + 1 hours);
        vm.prank(ALICE);
        ticket.transferFrom(ALICE, BOB, tokenId);
        assertEq(ticket.ownerOf(tokenId), BOB);
    }

    /// @dev migrate 는 _internalMove 라 양쪽 가드를 모두 건너뛴다. 회전은 옛 계정을 잠그므로
    ///      (I2) 보내는 쪽은 언제나 잠겨 있고, 받는 쪽도 잠겨 있을 수 있다 — 그런데도 복구는
    ///      끝까지 간다. 받는 쪽 가드가 분기 '안'에 있다는 사실이 이 테스트다.
    function test_migrateIsExemptFromBothLockGuards() public {
        vm.warp(T0 + 7 days);
        vm.prank(attester);
        identity.rotateAccount(bytes32(uint256(0xA1A1)), CAROL);
        vm.prank(CAROL);
        identity.lockDevice(CAROL);
        assertTrue(identity.isLocked(ALICE), "the rotation locked the old account");
        assertTrue(identity.isLocked(CAROL), "and the new one locked itself too");

        vm.warp(block.timestamp + ticket.MIGRATE_DELAY());
        vm.prank(CAROL);
        ticket.migrate(tokenId);
        assertEq(ticket.ownerOf(tokenId), CAROL);
    }

    /// @dev T1-3 리뷰 지적. 취소된 행사의 티켓으로는 문을 통과할 수 없으므로(checkIn 의
    ///      EventCancelled) 그것을 남에게 넘기는 것은 쓸모없는 것을 떠넘기는 일이다.
    function test_aCancelledEventsTicketCannotBeTransferred() public {
        vm.prank(ORG_OWNER);
        ticket.cancelEvent(eventId);

        vm.prank(ALICE);
        vm.expectRevert(Ticket.EventCancelled.selector);
        ticket.transferFrom(ALICE, BOB, tokenId);
        assertEq(ticket.ownerOf(tokenId), ALICE, "the ticket stays where it was");
        assertEq(ticket.transfersOf(tokenId), 0);
    }

    /// @dev 끝난 행사는 취소된 행사가 아니다. 양도를 닫는 것은 이미 transferCutoff 이고,
    ///      새 줄은 Cancelled 하나만 본다 — Ended 로 번지지 않았음을 고정한다.
    function test_anEndedEventIsNotCancelledSoTheCutoffIsStillTheOnlyBar() public {
        vm.warp(T0 + 3 days);
        vm.prank(ALICE);
        vm.expectRevert(Ticket.TransferCutoffPassed.selector);
        ticket.transferFrom(ALICE, BOB, tokenId);
    }
}
