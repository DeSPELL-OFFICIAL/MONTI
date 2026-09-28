// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {MontiTest} from "./Base.t.sol";
import {Ticket} from "../src/Ticket.sol";
import {P256Vectors} from "./utils/P256Vectors.sol";

/// @notice 릴레이된 발급(설계 §2-3). claimFor/requestClaimFor 는 관객 기기 P-256 서명(ClaimAuth)이
///         증명하고 누구나 제출한다(permissionless) — 직접 claim/requestClaim 은 제거됐다.
contract TicketClaimForTest is MontiTest {
    uint256 internal orgId;
    uint256 internal eventId;

    event Claimed(uint256 indexed tokenId, uint256 indexed eventId, address indexed to, uint8 tier);

    function setUp() public {
        _deployMonti();
        _member(ALICE, 0xA1A1);
        _member(BOB, 0xB0B0);
        orgId = _org();
        eventId = _freeEvent(orgId, 1, 1, true);
    }

    /// @dev 명시적 nonce·deadline 로 승인서 + 기기 서명을 만든다(개별 revert 케이스용).
    function _auth(address account, uint256 eventId_, uint8 tier, uint256 nonce, uint64 deadline)
        internal
        view
        returns (Ticket.ClaimAuth memory a, bytes memory sig)
    {
        a = Ticket.ClaimAuth({eventId: eventId_, tier: tier, account: account, nonce: nonce, deadline: deadline});
        (bytes32 r, bytes32 s) = vm.signP256(P256Vectors.DEVICE_PRIV, ticket.claimAuthDigest(a));
        sig = abi.encode(r, s);
    }

    // --- happy path ----------------------------------------------------------------------------

    function test_memberClaimsFreeTicket() public {
        // tokenId 는 eventId<<96 | tier<<88 | serial 로 인코딩된다(설계 §12-1). 첫 티켓의 serial 은 1.
        uint256 expectedId = (eventId << 96) | uint256(1);
        (Ticket.ClaimAuth memory a, bytes memory sig) = _signClaimAuth(ALICE, eventId, 0);
        vm.expectEmit(true, true, true, true);
        emit Claimed(expectedId, eventId, ALICE, 0);
        vm.prank(RELAYER);
        uint256 tokenId = ticket.claimFor(a, sig);

        assertEq(tokenId, expectedId, "tokenId encodes eventId and serial");
        assertEq(ticket.ownerOf(tokenId), ALICE);
        assertEq(ticket.eventOf(tokenId), eventId);
        assertEq(ticket.tierOf(tokenId), 0);
        assertEq(ticket.balanceOfEvent(ALICE, eventId), 1);
        assertEq(ticket.transfersOf(tokenId), 0);
        assertEq(ticket.usedAt(tokenId), 0);
        assertEq(ticket.checkInOf(tokenId).ts, 0);
        assertEq(ticket.tiers(eventId)[0].minted, 1);
        assertEq(ticket.claimNonce(eventId, ALICE), 1, "nonce consumed exactly once");
    }

    /// @dev 게이트도 관객도 아닌 임의 EOA 가 유효한 승인서를 대신 제출할 수 있다(permissionless).
    function test_anyRelayerCanSubmit() public {
        (Ticket.ClaimAuth memory a, bytes memory sig) = _signClaimAuth(ALICE, eventId, 0);
        vm.prank(address(0xBEEF));
        uint256 tokenId = ticket.claimFor(a, sig);
        assertEq(ticket.ownerOf(tokenId), ALICE);
    }

    /// @dev 직접 claim/requestClaim 심볼은 사라졌다. 옛 selector 로의 호출은 매칭되는 함수가 없어
    ///      실패한다(fallback 없음).
    function test_directClaimAndRequestClaimSymbolsAreGone() public {
        (bool ok1,) = address(ticket)
            .call(abi.encodeWithSelector(bytes4(keccak256("claim(uint256,uint8,bytes)")), eventId, uint8(0), bytes("")));
        assertFalse(ok1, "direct claim(uint256,uint8,bytes) no longer exists");
        (bool ok2,) = address(ticket)
            .call(abi.encodeWithSelector(bytes4(keccak256("requestClaim(uint256,uint8)")), eventId, uint8(0)));
        assertFalse(ok2, "direct requestClaim(uint256,uint8) no longer exists");
    }

    // --- signature / auth failures -------------------------------------------------------------

    function test_badNonceRejected() public {
        (Ticket.ClaimAuth memory a, bytes memory sig) =
            _auth(ALICE, eventId, 0, 7, uint64(block.timestamp + 10 minutes));
        vm.expectRevert(Ticket.BadNonce.selector);
        ticket.claimFor(a, sig);
    }

    function test_expiredDeadlineRejected() public {
        vm.warp(T0 + 100);
        (Ticket.ClaimAuth memory a, bytes memory sig) = _auth(ALICE, eventId, 0, 0, uint64(block.timestamp - 1));
        vm.expectRevert(Ticket.AuthExpired.selector);
        ticket.claimFor(a, sig);
    }

    function test_deviceLockedRejected() public {
        vm.prank(ALICE);
        identity.lockDevice(ALICE);
        (Ticket.ClaimAuth memory a, bytes memory sig) = _signClaimAuth(ALICE, eventId, 0);
        vm.expectRevert(Ticket.DeviceLocked.selector);
        ticket.claimFor(a, sig);
    }

    function test_nonMemberRejected() public {
        (Ticket.ClaimAuth memory a, bytes memory sig) = _signClaimAuth(CAROL, eventId, 0);
        vm.expectRevert(Ticket.NotMember.selector);
        ticket.claimFor(a, sig);
    }

    function test_forgedSignatureRejected() public {
        Ticket.ClaimAuth memory a = Ticket.ClaimAuth({
            eventId: eventId,
            tier: 0,
            account: ALICE,
            nonce: ticket.claimNonce(eventId, ALICE),
            deadline: uint64(block.timestamp + 10 minutes)
        });
        // 관객 기기 키가 아닌 키로 승인서에 서명 = 위조.
        (bytes32 r, bytes32 s) = vm.signP256(P256Vectors.OTHER_PRIV, ticket.claimAuthDigest(a));
        vm.expectRevert(Ticket.BadDeviceSignature.selector);
        ticket.claimFor(a, abi.encode(r, s));
    }

    function test_malformedSignatureRejected() public {
        (Ticket.ClaimAuth memory a,) = _signClaimAuth(ALICE, eventId, 0);
        vm.expectRevert(Ticket.BadDeviceSignature.selector);
        ticket.claimFor(a, new bytes(63));
    }

    /// @dev 같은 승인서를 두 번 제출하면 두 번째는 nonce 가 이미 소비돼(BadNonce) 막힌다.
    function test_replayOfTheSameAuthRejected() public {
        (Ticket.ClaimAuth memory a, bytes memory sig) = _signClaimAuth(ALICE, eventId, 0);
        ticket.claimFor(a, sig);
        vm.expectRevert(Ticket.BadNonce.selector);
        ticket.claimFor(a, sig);
    }

    // --- eligibility ---------------------------------------------------------------------------

    function test_perWalletLimitEnforced() public {
        (Ticket.ClaimAuth memory a1, bytes memory s1) = _signClaimAuth(ALICE, eventId, 0);
        ticket.claimFor(a1, s1);
        (Ticket.ClaimAuth memory a2, bytes memory s2) = _signClaimAuth(ALICE, eventId, 0);
        vm.expectRevert(Ticket.MaxPerWalletExceeded.selector);
        ticket.claimFor(a2, s2);
    }

    function test_soldOutRejected() public {
        uint256 soldOut = _oneSeatEvent();
        (Ticket.ClaimAuth memory a1, bytes memory s1) = _signClaimAuth(ALICE, soldOut, 0);
        ticket.claimFor(a1, s1);
        assertEq(ticket.tiers(soldOut)[0].minted, 1);

        (Ticket.ClaimAuth memory a2, bytes memory s2) = _signClaimAuth(BOB, soldOut, 0);
        vm.expectRevert(Ticket.SoldOut.selector);
        ticket.claimFor(a2, s2);
    }

    function test_saleWindowEnforced() public {
        vm.warp(T0 + 1 days + 1);
        {
            (Ticket.ClaimAuth memory a, bytes memory sig) = _signClaimAuth(ALICE, eventId, 0);
            vm.expectRevert(Ticket.SaleClosed.selector);
            ticket.claimFor(a, sig);
        }
        vm.warp(T0 + 2 days + 1);
        {
            (Ticket.ClaimAuth memory a, bytes memory sig) = _signClaimAuth(ALICE, eventId, 0);
            vm.expectRevert(Ticket.EventEnded.selector);
            ticket.claimFor(a, sig);
        }
    }

    function test_unknownTierRejected() public {
        (Ticket.ClaimAuth memory a, bytes memory sig) = _signClaimAuth(ALICE, eventId, 3);
        vm.expectRevert(Ticket.UnknownTier.selector);
        ticket.claimFor(a, sig);
    }

    function test_draftEventRejected() public {
        Ticket.EventMeta memory m = ticket.eventMeta(eventId);
        Ticket.Tier[] memory t = ticket.tiers(eventId);
        vm.prank(ORG_OWNER);
        uint256 draftId = ticket.createEvent(m, t);
        (Ticket.ClaimAuth memory a, bytes memory sig) = _signClaimAuth(ALICE, draftId, 0);
        vm.expectRevert(Ticket.EventNotPublished.selector);
        ticket.claimFor(a, sig);
    }

    function test_kycRequiredRejectedForLevelZero() public {
        uint256 kycEventId = _kycEvent(orgId);
        _memberWithLevel(address(0xD0), 0xD0D0, 0);
        (Ticket.ClaimAuth memory a, bytes memory sig) = _signClaimAuth(address(0xD0), kycEventId, 0);
        vm.expectRevert(Ticket.KycRequired.selector);
        ticket.claimFor(a, sig);
    }

    function test_kycEventAllowsLevelOne() public {
        uint256 kycEventId = _kycEvent(orgId);
        uint256 tokenId = _claimForFixture(ALICE, kycEventId, 0);
        assertEq(ticket.ownerOf(tokenId), ALICE);
    }

    // --- approval mode -------------------------------------------------------------------------

    /// @dev 승인제 이벤트는 claimFor 로 직접 발급되지 않고(ApprovalRequired) requestClaimFor 만
    ///      신청을 남기며, 주최자의 approveClaims 가 실제 민팅을 한다.
    function test_approvalModeRequestThenApprove() public {
        uint256 apId = _approvalEvent();
        // 직접 발급은 막힌다.
        {
            (Ticket.ClaimAuth memory a, bytes memory sig) = _signClaimAuth(ALICE, apId, 0);
            vm.expectRevert(Ticket.ApprovalRequired.selector);
            ticket.claimFor(a, sig);
        }
        // 신청은 ClaimRequested 를 남긴다.
        (Ticket.ClaimAuth memory ra, bytes memory rsig) = _signClaimAuth(ALICE, apId, 0);
        vm.expectEmit(true, true, true, true);
        emit Ticket.ClaimRequested(apId, 1, ALICE, 0);
        uint256 rid = ticket.requestClaimFor(ra, rsig);
        assertEq(ticket.balanceOfEvent(ALICE, apId), 0, "not minted yet");

        // 승인이 민팅한다.
        uint256[] memory ids = new uint256[](1);
        ids[0] = rid;
        vm.prank(ORG_OWNER);
        ticket.approveClaims(apId, ids);
        assertEq(ticket.balanceOfEvent(ALICE, apId), 1, "approved and minted");
    }

    // --- helpers -------------------------------------------------------------------------------

    function _oneSeatEvent() internal returns (uint256 soldOutEventId) {
        Ticket.EventMeta memory m = ticket.eventMeta(eventId);
        Ticket.Tier[] memory t = new Ticket.Tier[](1);
        t[0] = Ticket.Tier({name: "Only seat", priceUsdCents: 0, supply: 1, minted: 0, maxPerWallet: 1, seated: false});
        vm.prank(ORG_OWNER);
        soldOutEventId = ticket.createEvent(m, t);
        vm.prank(ORG_OWNER);
        ticket.publishEvent(soldOutEventId);
    }

    function _approvalEvent() internal returns (uint256 apId) {
        Ticket.EventMeta memory m = ticket.eventMeta(eventId);
        m.approvalRequired = true;
        Ticket.Tier[] memory t = ticket.tiers(eventId);
        vm.prank(ORG_OWNER);
        apId = ticket.createEvent(m, t);
        vm.prank(ORG_OWNER);
        ticket.publishEvent(apId);
    }
}
