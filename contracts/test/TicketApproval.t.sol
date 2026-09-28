// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {MontiTest} from "./Base.t.sol";
import {Ticket} from "../src/Ticket.sol";

/// @notice 승인제(01c) — requestClaim / approveClaims / rejectClaims / cancelRequest.
///         선례는 TicketOverride.t.sol(권한 축)과 TicketClaim.t.sol(자격 검사)이다.
contract TicketApprovalTest is MontiTest {
    uint256 internal orgId;
    uint256 internal eventId;

    /// @dev Ticket.PERM_APPROVE_CLAIM 은 private 이라 여기 같은 값을 둔다. 이 값이 32 인 것이
    ///      요점이다 — 8(PERM_MANAGE_MANAGERS)·16(PERM_MANAGE_BUDGET)과 충돌하지 않는 다음 빈 비트.
    uint32 internal constant PERM_APPROVE_CLAIM = 32;

    address internal constant ADMIN_APPROVE = address(0x0A1);
    address internal constant ADMIN_OTHER = address(0x0A2);
    address internal constant MANAGER_YES = address(0x0B1);
    address internal constant MANAGER_NO = address(0x0B2);

    function setUp() public {
        _deployMonti();
        _member(ALICE, 0xA1A1);
        _member(BOB, 0xB0B0);
        _member(CAROL, 0xCACA);
        orgId = _org();
        eventId = _approvalEvent(orgId, 100, 1, false);

        vm.startPrank(ORG_OWNER);
        organizers.setAdmin(orgId, ADMIN_APPROVE, PERM_APPROVE_CLAIM);
        organizers.setAdmin(orgId, ADMIN_OTHER, organizers.PERM_MANAGE_MANAGERS());
        organizers.setManager(orgId, MANAGER_YES, true, true);
        organizers.setManager(orgId, MANAGER_NO, true, false);
        vm.stopPrank();
    }

    // --- request -------------------------------------------------------------------------------

    function test_requestClaimStoresPendingAndReservesSupplyWithoutMinting() public {
        vm.expectEmit(true, true, true, true);
        emit Ticket.ClaimRequested(eventId, 1, ALICE, 0);
        vm.prank(ALICE);
        uint256 rid = ticket.requestClaim(eventId, 0);

        assertEq(rid, 1);
        Ticket.ClaimRequest memory r = ticket.claimRequest(eventId, rid);
        assertEq(r.requester, ALICE);
        assertEq(r.tier, 0);
        assertEq(r.status, 0, "pending");
        assertEq(ticket.pendingCount(eventId), 1);
        // 예약만 됐고 발급은 없다.
        assertEq(ticket.balanceOfEvent(ALICE, eventId), 0, "no token yet");
        assertEq(ticket.tiers(eventId)[0].minted, 1, "supply reserved on request");
    }

    function test_requestIdIncrementsPerEvent() public {
        vm.prank(ALICE);
        assertEq(ticket.requestClaim(eventId, 0), 1);
        vm.prank(BOB);
        assertEq(ticket.requestClaim(eventId, 0), 2);
        assertEq(ticket.pendingCount(eventId), 2);
    }

    function test_claimRevertsApprovalRequired() public {
        vm.prank(ALICE);
        vm.expectRevert(Ticket.ApprovalRequired.selector);
        ticket.claim(eventId, 0, "");
    }

    function test_requestClaimRevertsOnFirstComeEvent() public {
        uint256 openId = _freeEvent(orgId, 1, 1, true); // approvalRequired == false
        vm.prank(ALICE);
        vm.expectRevert(Ticket.ApprovalNotRequired.selector);
        ticket.requestClaim(openId, 0);
    }

    function test_requestClaimEligibilityMirrorsClaim() public {
        // non-member
        vm.prank(address(0xDEAD));
        vm.expectRevert(Ticket.NotMember.selector);
        ticket.requestClaim(eventId, 0);

        // unknown tier
        vm.prank(ALICE);
        vm.expectRevert(Ticket.UnknownTier.selector);
        ticket.requestClaim(eventId, 5);

        // outside sale window
        vm.warp(T0 + 1 days + 1);
        vm.prank(ALICE);
        vm.expectRevert(Ticket.SaleClosed.selector);
        ticket.requestClaim(eventId, 0);

        // after end
        vm.warp(T0 + 2 days + 1);
        vm.prank(ALICE);
        vm.expectRevert(Ticket.EventEnded.selector);
        ticket.requestClaim(eventId, 0);
    }

    function test_requestClaimRejectsDraftPaidAndKyc() public {
        // draft
        Ticket.EventMeta memory m = ticket.eventMeta(eventId);
        Ticket.Tier[] memory t = ticket.tiers(eventId);
        vm.prank(ORG_OWNER);
        uint256 draftId = ticket.createEvent(m, t);
        vm.prank(ALICE);
        vm.expectRevert(Ticket.EventNotPublished.selector);
        ticket.requestClaim(draftId, 0);

        // paid tier on an approval event
        uint256 paidId = _paidApprovalEvent();
        vm.prank(ALICE);
        vm.expectRevert(Ticket.PaidTiersNotEnabled.selector);
        ticket.requestClaim(paidId, 0);

        // kyc required, requester at level 0
        uint256 kycId = _approvalEvent(orgId, 100, 1, true);
        _memberWithLevel(address(0xD0), 0xD0D0, 0);
        vm.prank(address(0xD0));
        vm.expectRevert(Ticket.KycRequired.selector);
        ticket.requestClaim(kycId, 0);
    }

    // --- approve -------------------------------------------------------------------------------

    function test_approveMintsViaSamePathAndEmitsClaimed() public {
        vm.prank(ALICE);
        uint256 rid = ticket.requestClaim(eventId, 0);

        uint256[] memory ids = _ids(rid);
        vm.expectEmit(true, true, true, true);
        emit Ticket.Claimed(1, eventId, ALICE, 0);
        vm.expectEmit(true, true, false, true);
        emit Ticket.ClaimApproved(eventId, rid, 1);
        vm.prank(ORG_OWNER);
        ticket.approveClaims(eventId, ids);

        assertEq(ticket.ownerOf(1), ALICE);
        assertEq(ticket.eventOf(1), eventId);
        assertEq(ticket.tierOf(1), 0);
        assertEq(ticket.balanceOfEvent(ALICE, eventId), 1);
        assertEq(ticket.claimRequest(eventId, rid).status, 1, "approved");
        assertEq(ticket.pendingCount(eventId), 0);
        // 예약이 발급으로 전환됐을 뿐, 공급을 두 번 세지 않는다.
        assertEq(ticket.tiers(eventId)[0].minted, 1);
    }

    function test_approveSkipsNonPendingWithoutRevertingBatch() public {
        // rid1 pending -> will be approved earlier; rid2 pending; rid3 rejected beforehand.
        vm.prank(ALICE);
        uint256 rid1 = ticket.requestClaim(eventId, 0);
        vm.prank(BOB);
        uint256 rid2 = ticket.requestClaim(eventId, 0);
        vm.prank(CAROL);
        uint256 rid3 = ticket.requestClaim(eventId, 0);

        // reject rid3 up front, approve rid1 up front.
        vm.prank(ORG_OWNER);
        ticket.rejectClaims(eventId, _ids(rid3));
        vm.prank(ORG_OWNER);
        ticket.approveClaims(eventId, _ids(rid1));
        assertEq(ticket.pendingCount(eventId), 1);

        // now a batch mixing approved(rid1), rejected(rid3), missing(999) and pending(rid2):
        uint256[] memory batch = new uint256[](4);
        batch[0] = rid1;
        batch[1] = rid3;
        batch[2] = 999;
        batch[3] = rid2;
        vm.prank(ORG_OWNER);
        ticket.approveClaims(eventId, batch); // must not revert

        // only rid2 newly minted (rid1 already had token #1).
        assertEq(ticket.balanceOfEvent(BOB, eventId), 1);
        assertEq(ticket.claimRequest(eventId, rid2).status, 1);
        assertEq(ticket.pendingCount(eventId), 0);
    }

    // --- reject / cancel -----------------------------------------------------------------------

    function test_rejectReleasesReservation() public {
        vm.prank(ALICE);
        uint256 rid = ticket.requestClaim(eventId, 0);
        assertEq(ticket.tiers(eventId)[0].minted, 1);

        vm.expectEmit(true, true, false, true);
        emit Ticket.ClaimRejected(eventId, rid);
        vm.prank(ORG_OWNER);
        ticket.rejectClaims(eventId, _ids(rid));

        assertEq(ticket.claimRequest(eventId, rid).status, 2, "rejected");
        assertEq(ticket.pendingCount(eventId), 0);
        assertEq(ticket.tiers(eventId)[0].minted, 0, "supply released");
        // 풀렸으니 다시 신청 가능(지갑 한도도 되돌아왔다).
        vm.prank(ALICE);
        ticket.requestClaim(eventId, 0);
        assertEq(ticket.pendingCount(eventId), 1);
    }

    function test_cancelByRequesterReleasesAndGuards() public {
        vm.prank(ALICE);
        uint256 rid = ticket.requestClaim(eventId, 0);

        // stranger cannot cancel
        vm.prank(BOB);
        vm.expectRevert(Ticket.Unauthorized.selector);
        ticket.cancelRequest(eventId, rid);

        vm.expectEmit(true, true, false, true);
        emit Ticket.ClaimRejected(eventId, rid);
        vm.prank(ALICE);
        ticket.cancelRequest(eventId, rid);

        assertEq(ticket.claimRequest(eventId, rid).status, 2);
        assertEq(ticket.tiers(eventId)[0].minted, 0, "supply released");
        assertEq(ticket.pendingCount(eventId), 0);

        // cannot cancel again (not pending)
        vm.prank(ALICE);
        vm.expectRevert(Ticket.RequestNotPending.selector);
        ticket.cancelRequest(eventId, rid);
    }

    // --- caps and oversell ---------------------------------------------------------------------

    function test_capCountsPendingPlusMinted() public {
        // maxPerWallet == 1 on the shared fixture.
        vm.prank(ALICE);
        ticket.requestClaim(eventId, 0);

        // second request while first still pending -> cap hit.
        vm.prank(ALICE);
        vm.expectRevert(Ticket.MaxPerWalletExceeded.selector);
        ticket.requestClaim(eventId, 0);

        // approve the first, still at cap (now via balance).
        vm.prank(ORG_OWNER);
        ticket.approveClaims(eventId, _ids(1));
        vm.prank(ALICE);
        vm.expectRevert(Ticket.MaxPerWalletExceeded.selector);
        ticket.requestClaim(eventId, 0);
    }

    function test_reservationPreventsOversell() public {
        uint256 oneSeat = _approvalEvent(orgId, 1, 1, false); // supply 1
        vm.prank(ALICE);
        uint256 rid = ticket.requestClaim(oneSeat, 0);

        // the single seat is reserved -> the next requester is turned away.
        vm.prank(BOB);
        vm.expectRevert(Ticket.SoldOut.selector);
        ticket.requestClaim(oneSeat, 0);

        // approving the held request mints exactly one; supply stays at 1.
        vm.prank(ORG_OWNER);
        ticket.approveClaims(oneSeat, _ids(rid));
        assertEq(ticket.tiers(oneSeat)[0].minted, 1);
        assertEq(ticket.balanceOfEvent(ALICE, oneSeat), 1);

        // still sold out for everyone else.
        vm.prank(BOB);
        vm.expectRevert(Ticket.SoldOut.selector);
        ticket.requestClaim(oneSeat, 0);
    }

    // --- permissions ---------------------------------------------------------------------------

    function test_ownerAdminBitAndManagerCanApprove() public {
        // owner
        vm.prank(ALICE);
        ticket.requestClaim(eventId, 0);
        vm.prank(ORG_OWNER);
        ticket.approveClaims(eventId, _ids(1));
        assertEq(ticket.balanceOfEvent(ALICE, eventId), 1);

        // admin holding PERM_APPROVE_CLAIM
        vm.prank(BOB);
        ticket.requestClaim(eventId, 0);
        vm.prank(ADMIN_APPROVE);
        ticket.approveClaims(eventId, _ids(2));
        assertEq(ticket.balanceOfEvent(BOB, eventId), 1);

        // manager with canApprove
        vm.prank(CAROL);
        ticket.requestClaim(eventId, 0);
        vm.prank(MANAGER_YES);
        ticket.approveClaims(eventId, _ids(3));
        assertEq(ticket.balanceOfEvent(CAROL, eventId), 1);
    }

    function test_strangerManagerNoAndWrongAdminBitAllRejected() public {
        vm.prank(ALICE);
        uint256 rid = ticket.requestClaim(eventId, 0);
        uint256[] memory ids = _ids(rid);

        // stranger
        vm.prank(BOB);
        vm.expectRevert(Ticket.Unauthorized.selector);
        ticket.approveClaims(eventId, ids);

        // manager without canApprove
        vm.prank(MANAGER_NO);
        vm.expectRevert(Ticket.Unauthorized.selector);
        ticket.approveClaims(eventId, ids);

        // admin holding a DIFFERENT bit (PERM_MANAGE_MANAGERS == 8) — proves bit 32 does not collide.
        vm.prank(ADMIN_OTHER);
        vm.expectRevert(Ticket.Unauthorized.selector);
        ticket.approveClaims(eventId, ids);

        // reject path shares the same gate.
        vm.prank(BOB);
        vm.expectRevert(Ticket.Unauthorized.selector);
        ticket.rejectClaims(eventId, ids);
        vm.prank(ADMIN_OTHER);
        vm.expectRevert(Ticket.Unauthorized.selector);
        ticket.rejectClaims(eventId, ids);

        // the request is untouched by the failed attempts.
        assertEq(ticket.claimRequest(eventId, rid).status, 0);
        assertEq(ticket.pendingCount(eventId), 1);
    }

    // --- gas -----------------------------------------------------------------------------------

    /// @dev 배치 승인의 항목당 가스. 고정 오버헤드를 빼려고 1건 배치와 6건 배치를 각각 재고
    ///      그 차이를 5로 나눠 한계 비용(2~6번째 항목)을 낸다.
    function test_batchApproveGasPerItem() public {
        // event A: one pending request.
        uint256 evA = _approvalEvent(orgId, 100, 1, false);
        address a0 = address(uint160(0x2000));
        _member(a0, 0x2000);
        vm.prank(a0);
        ticket.requestClaim(evA, 0);
        uint256[] memory oneId = _ids(1);

        // event B: six pending requests, one per distinct member.
        uint256 evB = _approvalEvent(orgId, 100, 1, false);
        address[6] memory accts =
            [address(0x3001), address(0x3002), address(0x3003), address(0x3004), address(0x3005), address(0x3006)];
        uint256[] memory sixIds = new uint256[](6);
        for (uint256 i; i < 6; ++i) {
            _member(accts[i], 0x30000 + i);
            vm.prank(accts[i]);
            sixIds[i] = ticket.requestClaim(evB, 0);
        }

        vm.prank(ORG_OWNER);
        uint256 g0 = gasleft();
        ticket.approveClaims(evA, oneId);
        uint256 usedOne = g0 - gasleft();

        vm.prank(ORG_OWNER);
        uint256 g1 = gasleft();
        ticket.approveClaims(evB, sixIds);
        uint256 usedSix = g1 - gasleft();

        uint256 marginal = (usedSix - usedOne) / 5;
        emit log_named_uint("approveClaims gas, 1-item batch", usedOne);
        emit log_named_uint("approveClaims gas, 6-item batch", usedSix);
        emit log_named_uint("approveClaims marginal gas per item", marginal);
        assertGt(marginal, 0);
    }

    // --- helpers -------------------------------------------------------------------------------

    function _ids(uint256 a) internal pure returns (uint256[] memory ids) {
        ids = new uint256[](1);
        ids[0] = a;
    }

    function _approvalEvent(uint256 orgId_, uint32 supply, uint16 maxPerWallet, bool requireKyc)
        internal
        returns (uint256 eventId_)
    {
        Ticket.EventMeta memory m = Ticket.EventMeta({
            orgId: orgId_,
            titleHash: keccak256("Approval Night"),
            descHash: keccak256("approval event"),
            imageCid: "bafyApprovalCid",
            startsAt: T0 + 1 days,
            endsAt: T0 + 2 days,
            venueHash: keccak256("Seoul"),
            saleStart: T0,
            saleEnd: T0 + 1 days,
            transferable: true,
            transferCutoffSeconds: 2 hours,
            maxTransfers: 1,
            approvalRequired: true,
            category: 0,
            regionCode: keccak256("KR-11"),
            requireKyc: requireKyc
        });
        Ticket.Tier[] memory t = new Ticket.Tier[](1);
        t[0] = Ticket.Tier({
            name: "General", priceUsdCents: 0, supply: supply, minted: 0, maxPerWallet: maxPerWallet, seated: false
        });
        vm.prank(ORG_OWNER);
        eventId_ = ticket.createEvent(m, t);
        vm.prank(ORG_OWNER);
        ticket.publishEvent(eventId_);
    }

    function _paidApprovalEvent() internal returns (uint256 eventId_) {
        Ticket.EventMeta memory m = ticket.eventMeta(eventId);
        Ticket.Tier[] memory t = new Ticket.Tier[](1);
        t[0] = Ticket.Tier({name: "VIP", priceUsdCents: 5000, supply: 100, minted: 0, maxPerWallet: 1, seated: false});
        vm.prank(ORG_OWNER);
        eventId_ = ticket.createEvent(m, t);
        vm.prank(ORG_OWNER);
        ticket.publishEvent(eventId_);
    }
}
