// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {MontiTest} from "./Base.t.sol";
import {Ticket} from "../src/Ticket.sol";
import {SettlementVault} from "../src/SettlementVault.sol";
import {ITicket} from "../src/interfaces/ITicket.sol";
import {ISettlementVault} from "../src/interfaces/ISettlementVault.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {P256Vectors} from "./utils/P256Vectors.sol";

/// @notice A 6-decimal token that re-enters the vault on transfer to a flagged attacker, used to prove
///         a reentrant release cannot double-spend (the share is deferred to pull instead).
contract ReentrantToken is ERC20 {
    SettlementVault public vault;
    address public attacker;
    uint256 public reId;
    bool public armed;

    constructor() ERC20("Reentrant USD", "rUSD") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function arm(SettlementVault vault_, address attacker_, uint256 reId_) external {
        vault = vault_;
        attacker = attacker_;
        reId = reId_;
        armed = true;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (armed && to == attacker) {
            // Re-enter: the vault's guard + CEI must stop this from paying twice. The revert bubbles,
            // so the vault's push fails and the share is routed to the pull fallback instead.
            vault.release(reId);
        }
        super._update(from, to, value);
    }
}

/// @notice SettlementVault unit tests on the v2 flow (design 2026-10-12 §3–§4): the policy arrives with
///         Ticket.publishEvent (validated, frozen, set once), escrow arrives with `purchase`. Release gated on
///         real admission with exact 4-recipient bps math; double release; blacklist pull fallback + withdraw;
///         no-show settle after end (and rejected before); refund rules; pause; reentrancy. Purchase-specific
///         paths (atomicity, tier rules, NotVault) live in SettlementPurchase.t.sol.
contract SettlementVaultTest is MontiTest {
    uint256 internal orgId;
    uint256 internal eventId;
    uint256 internal gateId;

    uint256 internal constant PRICE_CENTS = 3000; // $30
    uint128 internal constant PRICE = 30_000_000; // 30 USDC (6dp) = PRICE_CENTS * UNITS_PER_CENT

    function setUp() public {
        _deployMonti();
        _memberWithDeviceKey(ALICE, 0xA1A1); // ticket holder

        orgId = organizers.createOrganizer(ORG_OWNER);
        eventId = _paidEvent(orgId, PRICE_CENTS, _goodPolicy()); // published, maxPerWallet 10
        gateId = _openRealGate(eventId, GATE_A);
    }

    // --- helpers --------------------------------------------------------------------------------

    function _buy() internal returns (uint256 tokenId) {
        return _purchase(ALICE, eventId, 0);
    }

    function _publishPaid(ISettlementVault.SplitPolicy memory p) internal returns (uint256) {
        return _paidEvent(orgId, PRICE_CENTS, p);
    }

    function _admit(uint256 tokenId) internal {
        _admitAt(tokenId, eventId, gateId);
    }

    function _admitAt(uint256 tokenId, uint256 eventId_, uint256 gateId_) internal {
        Ticket.GateCode memory g = Ticket.GateCode({
            gateId: gateId_, eventId: eventId_, issuedAt: uint64(block.timestamp), nonce: P256Vectors.NONCE
        });
        bytes memory gs = _gateSig(g);
        bytes memory ds = _deviceSig(tokenId, g);
        vm.prank(RELAYER);
        ticket.checkInFor(tokenId, g, gs, ds);
    }

    // --- policy (arrives via publishEvent) ------------------------------------------------------

    function test_policyStoredFrozenAtPublish() public view {
        ISettlementVault.SplitPolicy memory got = vault.getPolicy(eventId);
        assertEq(got.recipients.length, 4);
        assertEq(got.platformBps, 500);
        assertEq(got.version, 1);
        assertTrue(got.frozen, "frozen at publish, before any sale");
    }

    function test_policyRejectsBadSplitSum() public {
        ISettlementVault.Recipient[] memory r = _recipients();
        r[1].bps = 5000; // sum now 9000
        vm.expectRevert(ISettlementVault.BadSplitSum.selector);
        _publishPaid(_policy(r, false));
    }

    function test_policyRejectsPlatformShareTooLow() public {
        ISettlementVault.Recipient[] memory r = new ISettlementVault.Recipient[](2);
        r[0] = ISettlementVault.Recipient(R_PLATFORM, 100, keccak256("platform"), "platform");
        r[1] = ISettlementVault.Recipient(R_ARTIST, 9900, keccak256("fee"), "artist");
        ISettlementVault.SplitPolicy memory p = _policy(r, false);
        p.platformBps = 100; // below MIN 500
        vm.expectRevert(ISettlementVault.PlatformShareTooLow.selector);
        _publishPaid(p);
    }

    function test_policyRejectsPlatformMirrorMismatch() public {
        ISettlementVault.SplitPolicy memory p = _policy(_recipients(), false);
        p.platformBps = 600; // declared 600 but the platform line is 500
        vm.expectRevert(ISettlementVault.PlatformMirrorMismatch.selector);
        _publishPaid(p);
    }

    function test_policyRejectsZeroRecipientAndZeroBpsAndTooMany() public {
        ISettlementVault.Recipient[] memory r = _recipients();
        r[1].account = address(0);
        vm.expectRevert(ISettlementVault.ZeroRecipient.selector);
        _publishPaid(_policy(r, false));

        r = _recipients();
        r[3].bps = 0;
        r[1].bps = 7500;
        vm.expectRevert(ISettlementVault.ZeroBps.selector);
        _publishPaid(_policy(r, false));

        ISettlementVault.Recipient[] memory many = new ISettlementVault.Recipient[](11);
        for (uint256 i; i < 11; ++i) {
            many[i] = ISettlementVault.Recipient(address(uint160(0x1000 + i)), 1, bytes32(0), "x");
        }
        vm.expectRevert(ISettlementVault.InvalidRecipients.selector);
        _publishPaid(_policy(many, false));
    }

    function test_policyRejectsBadReserve() public {
        ISettlementVault.SplitPolicy memory p = _policy(_recipients(), false);
        p.reserveBps = 10_000;
        vm.expectRevert(ISettlementVault.BadReserve.selector);
        _publishPaid(p);
    }

    function test_policyRejectsNoPermission() public {
        // BOB is an admin with PERM_CREATE_EVENT only — not PERM_MANAGE_SETTLEMENT (64)
        vm.prank(ORG_OWNER);
        organizers.setAdmin(orgId, BOB, 1);
        Ticket.Tier[] memory t = new Ticket.Tier[](1);
        t[0] =
            Ticket.Tier({name: "G", priceUsdCents: PRICE_CENTS, supply: 10, minted: 0, maxPerWallet: 1, seated: false});
        Ticket.EventMeta memory m = _meta(orgId, 2, true, false);
        ISettlementVault.SplitPolicy memory p = _goodPolicy();
        vm.prank(BOB);
        vm.expectRevert(ISettlementVault.NotPolicyAuthorizer.selector);
        ticket.publishEvent(m, t, p);
    }

    /// @dev Set once: even the Ticket cannot write a second policy for the same event.
    function test_policyFrozenCannotBeRewritten() public {
        ISettlementVault.SplitPolicy memory p = _goodPolicy();
        vm.prank(address(ticket));
        vm.expectRevert(ISettlementVault.PolicyFrozen.selector);
        vault.setPolicyByTicket(eventId, p, ORG_OWNER);
    }

    function test_hashPolicyIgnoresLifecycleFields() public view {
        ISettlementVault.SplitPolicy memory a = _goodPolicy();
        ISettlementVault.SplitPolicy memory b = _goodPolicy();
        b.frozen = true;
        b.version = 9;
        assertEq(vault.hashPolicy(a), vault.hashPolicy(b));
        assertEq(vault.hashPolicy(a), keccak256(abi.encode(a.recipients, a.platformBps, a.reserveBps, a.noShowRefund)));
    }

    // --- release --------------------------------------------------------------------------------

    function test_releaseBeforeCheckInRejected() public {
        uint256 tokenId = _buy();
        vm.expectRevert(ISettlementVault.NotCheckedIn.selector);
        vault.release(tokenId);
    }

    function test_releaseWithoutEscrowRejected() public {
        uint256 freeId = _freeEvent(orgId, 2, 1, true);
        uint256 tokenId = _claimForFixture(ALICE, freeId, 0);
        vm.expectRevert(ISettlementVault.NoEscrow.selector);
        vault.release(tokenId);
    }

    function test_releasePaysFourRecipientsExactly() public {
        uint256 tokenId = _buy();
        _admit(tokenId);

        vm.expectEmit(true, true, true, true);
        emit ISettlementVault.Paid(eventId, tokenId, R_PLATFORM, 1_500_000, keccak256("platform fee"));
        vm.expectEmit(true, true, true, true);
        emit ISettlementVault.Paid(eventId, tokenId, R_ARTIST, 18_000_000, keccak256("appearance fee"));
        vm.expectEmit(true, true, false, true);
        emit ISettlementVault.Released(eventId, tokenId, address(usd), PRICE);
        vault.release(tokenId);

        assertEq(usd.balanceOf(R_ARTIST), 18_000_000);
        assertEq(usd.balanceOf(R_VENUE), 6_000_000);
        assertEq(usd.balanceOf(R_ORG), 4_500_000);
        assertEq(usd.balanceOf(R_PLATFORM), 1_500_000);
        assertEq(usd.balanceOf(address(vault)), 0, "escrow fully distributed");
        (,,,, uint8 status) = vault.escrowOf(tokenId);
        assertEq(status, 2); // Released
    }

    /// @dev With UNITS_PER_CENT = 1e4 every escrow is a multiple of 10,000 units, so any bps share is
    ///      exact: the last-row dust branch is unreachable for a 6-decimal token. An odd price proves it.
    function test_releaseOddPriceIsExact() public {
        uint256 oddId = _paidEvent(orgId, 101, _goodPolicy()); // $1.01
        uint256 oddGate = _openRealGate(oddId, GATE_B);
        uint256 tokenId = _purchase(ALICE, oddId, 0);
        _admitAt(tokenId, oddId, oddGate);
        vault.release(tokenId);
        assertEq(usd.balanceOf(R_PLATFORM), 50_500);
        assertEq(usd.balanceOf(R_ARTIST), 606_000);
        assertEq(usd.balanceOf(R_VENUE), 202_000);
        assertEq(usd.balanceOf(R_ORG), 151_500);
        assertEq(usd.balanceOf(address(vault)), 0);
    }

    function test_doubleReleaseRejected() public {
        uint256 tokenId = _buy();
        _admit(tokenId);
        vault.release(tokenId);
        vm.expectRevert(ISettlementVault.AlreadySettled.selector);
        vault.release(tokenId);
    }

    function test_releaseManyTolerantOfNonHeld() public {
        uint256 a = _buy();
        uint256 b = _buy();
        _admit(a); // b not admitted
        uint256[] memory ids = new uint256[](3);
        ids[0] = a;
        ids[1] = b;
        ids[2] = 12345; // never escrowed
        vault.releaseMany(ids); // releases a, skips b and the unknown id
        (,,,, uint8 sa) = vault.escrowOf(a);
        (,,,, uint8 sb) = vault.escrowOf(b);
        assertEq(sa, 2); // Released
        assertEq(sb, 1); // still Held
    }

    // --- pull fallback (blacklist) --------------------------------------------------------------

    function test_blacklistedRecipientFallsBackToPullThenWithdraw() public {
        uint256 tokenId = _buy();
        _admit(tokenId);

        usd.setBlocked(R_ARTIST, true); // USDC blacklist simulation

        vm.expectEmit(true, true, true, true);
        emit ISettlementVault.PayoutDeferred(eventId, tokenId, R_ARTIST, address(usd), 18_000_000);
        vault.release(tokenId);

        // artist deferred, others paid, release still succeeded
        assertEq(usd.balanceOf(R_ARTIST), 0);
        assertEq(vault.pendingWithdrawals(R_ARTIST, address(usd)), 18_000_000);
        assertEq(usd.balanceOf(R_VENUE), 6_000_000);
        assertEq(usd.balanceOf(R_PLATFORM), 1_500_000);

        // once un-blacklisted the artist pulls their share
        usd.setBlocked(R_ARTIST, false);
        vm.prank(R_ARTIST);
        vault.withdraw(address(usd));
        assertEq(usd.balanceOf(R_ARTIST), 18_000_000);
        assertEq(vault.pendingWithdrawals(R_ARTIST, address(usd)), 0);
    }

    function test_withdrawNothingRejected() public {
        vm.expectRevert(ISettlementVault.NothingToWithdraw.selector);
        vm.prank(R_ARTIST);
        vault.withdraw(address(usd));
    }

    // --- no-show settle -------------------------------------------------------------------------

    function test_settleNoShowsBeforeEndRejected() public {
        uint256 tokenId = _buy();
        uint256[] memory ids = new uint256[](1);
        ids[0] = tokenId;
        vm.expectRevert(ISettlementVault.EventNotEnded.selector);
        vault.settleNoShows(eventId, ids);
    }

    function test_settleNoShowsAfterEndDistributes() public {
        uint256 tokenId = _buy(); // never admitted

        vm.warp(uint256(T0) + 2 days + 1); // past endsAt → Ended
        uint256[] memory ids = new uint256[](1);
        ids[0] = tokenId;

        vm.expectEmit(true, true, false, true);
        emit ISettlementVault.NoShowSettled(eventId, tokenId, address(usd), PRICE);
        vault.settleNoShows(eventId, ids);

        assertEq(usd.balanceOf(R_ARTIST), 18_000_000);
        assertEq(usd.balanceOf(R_PLATFORM), 1_500_000);
        (,,,, uint8 status) = vault.escrowOf(tokenId);
        assertEq(status, 2); // Released
    }

    function test_settleNoShowsSkipsAdmittedAndRejectsForeignEvent() public {
        uint256 admitted = _buy();
        _admit(admitted);
        uint256 otherId = _publishPaid(_goodPolicy());
        uint256 foreign = _purchase(ALICE, otherId, 0);

        vm.warp(uint256(T0) + 2 days + 1);
        uint256[] memory ids = new uint256[](1);
        ids[0] = admitted;
        vault.settleNoShows(eventId, ids); // skipped, not settled
        (,,,, uint8 status) = vault.escrowOf(admitted);
        assertEq(status, 1, "admitted ticket left for release()");

        ids[0] = foreign;
        vm.expectRevert(ISettlementVault.EventMismatch.selector);
        vault.settleNoShows(eventId, ids);
    }

    function test_settleNoShowsRefundPolicyRefundsPayer() public {
        // a second event whose policy refunds no-shows
        uint256 eventId2 = _publishPaid(_policy(_recipients(), true)); // noShowRefund = true
        uint256 tokenId = _purchase(ALICE, eventId2, 0);
        uint256 treasuryBefore = usd.balanceOf(TREASURY);

        vm.warp(uint256(T0) + 2 days + 1);
        uint256[] memory ids = new uint256[](1);
        ids[0] = tokenId;
        vault.settleNoShows(eventId2, ids);

        assertEq(usd.balanceOf(TREASURY), treasuryBefore + PRICE, "no-show refunded to payer");
        (,,,, uint8 status) = vault.escrowOf(tokenId);
        assertEq(status, 3); // Refunded
    }

    // --- refund ---------------------------------------------------------------------------------

    function test_refundByAdapterBeforeRelease() public {
        uint256 tokenId = _buy();
        uint256 treasuryBefore = usd.balanceOf(TREASURY);

        vm.expectEmit(true, true, false, true);
        emit ISettlementVault.Refunded(eventId, tokenId, address(usd), PRICE, TREASURY);
        vm.prank(TREASURY);
        vault.refund(tokenId);

        assertEq(usd.balanceOf(TREASURY), treasuryBefore + PRICE);
        (,,,, uint8 status) = vault.escrowOf(tokenId);
        assertEq(status, 3); // Refunded
    }

    function test_refundAfterCheckInByAdapterRejected() public {
        uint256 tokenId = _buy();
        _admit(tokenId);
        vm.expectRevert(ISettlementVault.AlreadyCheckedIn.selector);
        vm.prank(TREASURY);
        vault.refund(tokenId);
    }

    function test_refundAfterEndByAdapterRejected() public {
        uint256 tokenId = _buy();
        vm.warp(uint256(T0) + 2 days + 1);
        vm.expectRevert(ISettlementVault.EventEnded.selector);
        vm.prank(TREASURY);
        vault.refund(tokenId);
    }

    function test_refundAfterReleaseRejected() public {
        uint256 tokenId = _buy();
        _admit(tokenId);
        vault.release(tokenId);
        vm.expectRevert(ISettlementVault.NothingToRefund.selector);
        vm.prank(TREASURY);
        vault.refund(tokenId);
    }

    function test_refundWithoutEscrowRejected() public {
        vm.expectRevert(ISettlementVault.NoEscrow.selector);
        vault.refund(42);
    }

    function test_refundOnCancelledEventIsPermissionless() public {
        uint256 tokenId = _buy();

        vm.prank(ORG_OWNER);
        ticket.cancelEvent(eventId);

        uint256 treasuryBefore = usd.balanceOf(TREASURY);
        vm.prank(BOB); // anyone can trigger on a cancelled event
        vault.refund(tokenId);
        assertEq(usd.balanceOf(TREASURY), treasuryBefore + PRICE, "refund returns to payer");
    }

    function test_refundByStrangerOnLiveEventRejected() public {
        uint256 tokenId = _buy();
        vm.expectRevert(ISettlementVault.NotDepositor.selector);
        vm.prank(BOB);
        vault.refund(tokenId);
    }

    // --- pause / admin --------------------------------------------------------------------------

    function test_pauseBlocksMoneyPathsButNotWithdraw() public {
        uint256 tokenId = _buy();
        _admit(tokenId);

        vault.setPaused(true);
        vm.expectRevert(ISettlementVault.Paused.selector);
        vault.release(tokenId);

        vm.expectRevert(ISettlementVault.Paused.selector);
        vm.prank(TREASURY);
        vault.refund(tokenId);

        (ITicket.ClaimAuth memory a, bytes memory sig) = _signClaimAuth(ALICE, eventId, 0);
        vm.expectRevert(ISettlementVault.Paused.selector);
        vm.prank(TREASURY);
        vault.purchase(a, sig, address(usd));

        // withdraw is not gated by pause (nothing owed here, so the guard it reaches is NothingToWithdraw)
        vm.expectRevert(ISettlementVault.NothingToWithdraw.selector);
        vm.prank(R_ARTIST);
        vault.withdraw(address(usd));
    }

    function test_setPausedOnlyOwner() public {
        vm.expectRevert(ISettlementVault.NotOwner.selector);
        vm.prank(BOB);
        vault.setPaused(true);
    }

    function test_setDepositorOnlyOwner() public {
        vm.expectRevert(ISettlementVault.NotOwner.selector);
        vm.prank(BOB);
        vault.setDepositor(BOB, true);
    }

    function test_setTokenAllowedOnlyOwner() public {
        vm.expectRevert(ISettlementVault.NotOwner.selector);
        vm.prank(BOB);
        vault.setTokenAllowed(address(usd), false);
    }

    function test_constructorWiring() public view {
        assertEq(address(vault.ticket()), address(ticket));
        assertEq(address(vault.organizers()), address(organizers));
        assertEq(vault.owner(), address(this));
        assertTrue(vault.depositor(TREASURY));
        assertTrue(vault.tokenAllowed(address(usd)));
        assertEq(vault.UNITS_PER_CENT(), 1e4);
    }

    // --- reentrancy -----------------------------------------------------------------------------

    function test_reentrantReleaseCannotDoubleSpend() public {
        ReentrantToken rtoken = new ReentrantToken();
        vault.setTokenAllowed(address(rtoken), true);
        rtoken.mint(TREASURY, 1_000_000_000);
        vm.prank(TREASURY);
        rtoken.approve(address(vault), type(uint256).max);

        // policy whose last (platform) recipient is the attacking token's flagged address
        ISettlementVault.Recipient[] memory r = new ISettlementVault.Recipient[](2);
        address attacker = address(0xBADBAD);
        r[0] = ISettlementVault.Recipient(R_VENUE, 9500, keccak256("venue"), "venue");
        r[1] = ISettlementVault.Recipient(attacker, 500, keccak256("platform"), "platform");
        uint256 ev = _publishPaid(_policy(r, false));
        uint256 gate = _openRealGate(ev, GATE_B);

        (ITicket.ClaimAuth memory a, bytes memory sig) = _signClaimAuth(ALICE, ev, 0);
        vm.prank(TREASURY);
        uint256 tokenId = vault.purchase(a, sig, address(rtoken));
        _admitAt(tokenId, ev, gate);

        rtoken.arm(vault, attacker, tokenId); // re-enter release(tokenId) on transfer to attacker

        vault.release(tokenId);

        // reentry was blocked: attacker paid once, via the pull fallback (its push reverted), venue paid once
        (,,,, uint8 status) = vault.escrowOf(tokenId);
        assertEq(status, 2, "released exactly once");
        assertEq(rtoken.balanceOf(R_VENUE), 28_500_000);
        assertEq(vault.pendingWithdrawals(attacker, address(rtoken)), 1_500_000, "attacker share deferred, not doubled");
        assertEq(rtoken.balanceOf(address(vault)), 1_500_000, "only the deferred share remains");
    }
}
