// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {MontiTest} from "./Base.t.sol";
import {Ticket} from "../src/Ticket.sol";
import {SettlementVault} from "../src/SettlementVault.sol";
import {ISettlementVault} from "../src/interfaces/ISettlementVault.sol";
import {MockUSD} from "../src/mocks/MockUSD.sol";
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

/// @notice Batch A / A2 — SettlementVault unit tests (plan 2026-10-01 §A1-A2). Policy set/validate/freeze/
///         permission/nonce/expired/forged; deposit allowlists; release gated on real admission with exact
///         4-recipient bps math + dust; double release; blacklist pull fallback + withdraw; no-show settle
///         after end (and rejected before); refund rules; pause; reentrancy. Uses the Base fixtures to
///         actually admit tickets through Ticket.checkInFor.
contract SettlementVaultTest is MontiTest {
    SettlementVault internal vault;
    MockUSD internal usd;

    uint256 internal orgId;
    uint256 internal eventId;
    uint256 internal gateId;

    address internal constant TREASURY = address(0x7EA50); // the allowlisted deposit adapter
    address internal constant R_ARTIST = address(0xA4715);
    address internal constant R_VENUE = address(0xACE);
    address internal constant R_ORG = address(0x0B6);
    address internal constant R_PLATFORM = address(0x9147); // MONTI

    uint128 internal constant PRICE = 30_000_000; // 30 USDC (6dp)

    function setUp() public {
        _deployMonti();
        _memberWithDeviceKey(ORG_OWNER, 0x0140); // organizer signs the policy with the DEVICE key
        _memberWithDeviceKey(ALICE, 0xA1A1); // ticket holder

        orgId = organizers.createOrganizer(ORG_OWNER);
        eventId = _event(orgId, 10, 2, true, false); // published, maxPerWallet 10

        gateId = _openRealGate(eventId, GATE_A);

        usd = new MockUSD();
        vault = new SettlementVault(address(ticket), address(organizers), address(identity), TREASURY, address(usd));

        usd.mint(TREASURY, 1_000_000_000);
        vm.prank(TREASURY);
        usd.approve(address(vault), type(uint256).max);
    }

    // --- helpers --------------------------------------------------------------------------------

    function _recipients() internal pure returns (ISettlementVault.Recipient[] memory r) {
        r = new ISettlementVault.Recipient[](4);
        r[0] = ISettlementVault.Recipient(R_ARTIST, 6000, keccak256("appearance fee"), "artist");
        r[1] = ISettlementVault.Recipient(R_VENUE, 2000, keccak256("venue rental"), "venue");
        r[2] = ISettlementVault.Recipient(R_ORG, 1500, keccak256("organizing fee"), "organizer");
        r[3] = ISettlementVault.Recipient(R_PLATFORM, 500, keccak256("platform fee"), "platform");
    }

    function _policy(ISettlementVault.Recipient[] memory r, bool noShowRefund)
        internal
        pure
        returns (ISettlementVault.SplitPolicy memory p)
    {
        p.recipients = r;
        p.platformBps = 500;
        p.reserveBps = 0;
        p.noShowRefund = noShowRefund;
    }

    function _signPolicy(uint256 eventId_, ISettlementVault.SplitPolicy memory p, address organizer, uint256 pk)
        internal
        view
        returns (ISettlementVault.PolicyAuth memory auth, bytes memory sig)
    {
        auth = ISettlementVault.PolicyAuth({
            organizer: organizer,
            nonce: vault.policyNonce(organizer),
            deadline: uint64(block.timestamp + 10 minutes)
        });
        bytes32 policyHash = vault.hashPolicy(p);
        bytes32 digest = vault.setPolicyDigest(eventId_, policyHash, auth.nonce, auth.deadline);
        (bytes32 r, bytes32 s) = vm.signP256(pk, digest);
        sig = abi.encode(r, s);
    }

    function _setGoodPolicy() internal {
        ISettlementVault.SplitPolicy memory p = _policy(_recipients(), false);
        (ISettlementVault.PolicyAuth memory auth, bytes memory sig) = _signPolicy(eventId, p, ORG_OWNER, P256Vectors.DEVICE_PRIV);
        vault.setPolicy(eventId, p, auth, sig);
    }

    function _claim() internal returns (uint256 tokenId) {
        return _claimForFixture(ALICE, eventId, 0);
    }

    function _deposit(uint256 tokenId) internal {
        vm.prank(TREASURY);
        vault.deposit(eventId, tokenId, address(usd), PRICE);
    }

    function _admit(uint256 tokenId) internal {
        Ticket.GateCode memory g = Ticket.GateCode({
            gateId: gateId,
            eventId: eventId,
            issuedAt: uint64(block.timestamp),
            nonce: P256Vectors.NONCE
        });
        bytes memory gs = _gateSig(g);
        bytes memory ds = _deviceSig(tokenId, g);
        vm.prank(RELAYER);
        ticket.checkInFor(tokenId, g, gs, ds);
    }

    // --- policy ---------------------------------------------------------------------------------

    function test_setPolicyDigestMatchesDesignBytes() public view {
        ISettlementVault.SplitPolicy memory p = _policy(_recipients(), false);
        bytes32 policyHash = vault.hashPolicy(p);
        uint256 nonce = 3;
        uint64 deadline = uint64(block.timestamp + 1 hours);
        bytes32 expected = sha256(
            abi.encode(vault.SETTLE_POLICY_TAG(), block.chainid, address(vault), eventId, policyHash, nonce, deadline)
        );
        assertEq(vault.setPolicyDigest(eventId, policyHash, nonce, deadline), expected);
    }

    function test_setPolicyHappyPathStoresAndBumpsNonce() public {
        vm.expectEmit(true, true, false, false);
        emit ISettlementVault.PolicySet(eventId, ORG_OWNER, bytes32(0), 1);
        _setGoodPolicy();

        ISettlementVault.SplitPolicy memory got = vault.getPolicy(eventId);
        assertEq(got.recipients.length, 4);
        assertEq(got.platformBps, 500);
        assertEq(got.version, 1);
        assertFalse(got.frozen, "not frozen until first deposit");
        assertEq(vault.policyNonce(ORG_OWNER), 1);
    }

    function test_setPolicyRejectsBadSplitSum() public {
        ISettlementVault.Recipient[] memory r = _recipients();
        r[0].bps = 5000; // sum now 9000
        ISettlementVault.SplitPolicy memory p = _policy(r, false);
        (ISettlementVault.PolicyAuth memory auth, bytes memory sig) = _signPolicy(eventId, p, ORG_OWNER, P256Vectors.DEVICE_PRIV);
        vm.expectRevert(ISettlementVault.BadSplitSum.selector);
        vault.setPolicy(eventId, p, auth, sig);
    }

    function test_setPolicyRejectsPlatformShareTooLow() public {
        ISettlementVault.Recipient[] memory r = new ISettlementVault.Recipient[](2);
        r[0] = ISettlementVault.Recipient(R_ARTIST, 9900, keccak256("fee"), "artist");
        r[1] = ISettlementVault.Recipient(R_PLATFORM, 100, keccak256("platform"), "platform");
        ISettlementVault.SplitPolicy memory p = _policy(r, false);
        p.platformBps = 100; // below MIN 500
        (ISettlementVault.PolicyAuth memory auth, bytes memory sig) = _signPolicy(eventId, p, ORG_OWNER, P256Vectors.DEVICE_PRIV);
        vm.expectRevert(ISettlementVault.PlatformShareTooLow.selector);
        vault.setPolicy(eventId, p, auth, sig);
    }

    function test_setPolicyRejectsPlatformMirrorMismatch() public {
        ISettlementVault.SplitPolicy memory p = _policy(_recipients(), false);
        p.platformBps = 600; // declared 600 but the platform line is 500
        (ISettlementVault.PolicyAuth memory auth, bytes memory sig) = _signPolicy(eventId, p, ORG_OWNER, P256Vectors.DEVICE_PRIV);
        vm.expectRevert(ISettlementVault.PlatformMirrorMismatch.selector);
        vault.setPolicy(eventId, p, auth, sig);
    }

    function test_setPolicyRejectsNoPermission() public {
        ISettlementVault.SplitPolicy memory p = _policy(_recipients(), false);
        // BOB is not the org owner/admin
        (ISettlementVault.PolicyAuth memory auth, bytes memory sig) = _signPolicy(eventId, p, BOB, P256Vectors.DEVICE_PRIV);
        vm.expectRevert(ISettlementVault.NotPolicyAuthorizer.selector);
        vault.setPolicy(eventId, p, auth, sig);
    }

    function test_setPolicyRejectsForgedSignature() public {
        ISettlementVault.SplitPolicy memory p = _policy(_recipients(), false);
        (ISettlementVault.PolicyAuth memory auth, bytes memory sig) = _signPolicy(eventId, p, ORG_OWNER, P256Vectors.OTHER_PRIV);
        vm.expectRevert(ISettlementVault.BadDeviceSignature.selector);
        vault.setPolicy(eventId, p, auth, sig);
    }

    function test_setPolicyRejectsBadNonce() public {
        ISettlementVault.SplitPolicy memory p = _policy(_recipients(), false);
        ISettlementVault.PolicyAuth memory auth = ISettlementVault.PolicyAuth({
            organizer: ORG_OWNER, nonce: 7, deadline: uint64(block.timestamp + 10 minutes)
        });
        bytes32 digest = vault.setPolicyDigest(eventId, vault.hashPolicy(p), auth.nonce, auth.deadline);
        (bytes32 r, bytes32 s) = vm.signP256(P256Vectors.DEVICE_PRIV, digest);
        vm.expectRevert(ISettlementVault.BadNonce.selector);
        vault.setPolicy(eventId, p, auth, abi.encode(r, s));
    }

    function test_setPolicyRejectsExpiredAuth() public {
        ISettlementVault.SplitPolicy memory p = _policy(_recipients(), false);
        ISettlementVault.PolicyAuth memory auth = ISettlementVault.PolicyAuth({
            organizer: ORG_OWNER, nonce: 0, deadline: uint64(block.timestamp - 1)
        });
        bytes32 digest = vault.setPolicyDigest(eventId, vault.hashPolicy(p), auth.nonce, auth.deadline);
        (bytes32 r, bytes32 s) = vm.signP256(P256Vectors.DEVICE_PRIV, digest);
        vm.expectRevert(ISettlementVault.AuthExpired.selector);
        vault.setPolicy(eventId, p, auth, abi.encode(r, s));
    }

    function test_setPolicyFrozenAfterFirstDeposit() public {
        _setGoodPolicy();
        uint256 tokenId = _claim();
        _deposit(tokenId); // freezes
        assertTrue(vault.getPolicy(eventId).frozen);

        ISettlementVault.SplitPolicy memory p = _policy(_recipients(), false);
        (ISettlementVault.PolicyAuth memory auth, bytes memory sig) = _signPolicy(eventId, p, ORG_OWNER, P256Vectors.DEVICE_PRIV);
        vm.expectRevert(ISettlementVault.PolicyFrozen.selector);
        vault.setPolicy(eventId, p, auth, sig);
    }

    // --- deposit --------------------------------------------------------------------------------

    function test_depositPullsFundsAndFreezes() public {
        _setGoodPolicy();
        uint256 tokenId = _claim();

        vm.expectEmit(true, true, false, true);
        emit ISettlementVault.Deposited(eventId, tokenId, address(usd), PRICE, TREASURY);
        _deposit(tokenId);

        assertEq(usd.balanceOf(address(vault)), PRICE);
        (address token, uint128 amount, address payer,, uint8 status) = vault.escrowOf(tokenId);
        assertEq(token, address(usd));
        assertEq(amount, PRICE);
        assertEq(payer, TREASURY);
        assertEq(status, 1); // Held
        assertTrue(vault.getPolicy(eventId).frozen);
    }

    function test_depositByNonAdapterRejected() public {
        _setGoodPolicy();
        uint256 tokenId = _claim();
        vm.expectRevert(ISettlementVault.NotDepositor.selector);
        vm.prank(BOB);
        vault.deposit(eventId, tokenId, address(usd), PRICE);
    }

    function test_depositUnallowlistedTokenRejected() public {
        _setGoodPolicy();
        uint256 tokenId = _claim();
        MockUSD other = new MockUSD();
        other.mint(TREASURY, PRICE);
        vm.prank(TREASURY);
        vault.deposit(eventId, tokenId, address(usd), PRICE); // sanity: allowlisted works elsewhere
        uint256 tokenId2 = _claim();
        vm.expectRevert(ISettlementVault.TokenNotAllowed.selector);
        vm.prank(TREASURY);
        vault.deposit(eventId, tokenId2, address(other), PRICE);
    }

    function test_depositWithoutPolicyRejected() public {
        uint256 tokenId = _claim();
        vm.expectRevert(ISettlementVault.NoPolicy.selector);
        vm.prank(TREASURY);
        vault.deposit(eventId, tokenId, address(usd), PRICE);
    }

    function test_doubleDepositRejected() public {
        _setGoodPolicy();
        uint256 tokenId = _claim();
        _deposit(tokenId);
        vm.expectRevert(ISettlementVault.AlreadyDeposited.selector);
        vm.prank(TREASURY);
        vault.deposit(eventId, tokenId, address(usd), PRICE);
    }

    // --- release --------------------------------------------------------------------------------

    function test_releaseBeforeCheckInRejected() public {
        _setGoodPolicy();
        uint256 tokenId = _claim();
        _deposit(tokenId);
        vm.expectRevert(ISettlementVault.NotCheckedIn.selector);
        vault.release(tokenId);
    }

    function test_releaseWithoutEscrowRejected() public {
        _setGoodPolicy();
        uint256 tokenId = _claim();
        vm.expectRevert(ISettlementVault.NoEscrow.selector);
        vault.release(tokenId);
    }

    function test_releasePaysFourRecipientsExactly() public {
        _setGoodPolicy();
        uint256 tokenId = _claim();
        _deposit(tokenId);
        _admit(tokenId);

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

    function test_releaseRoutesDustToLastRecipient() public {
        // 100 wei of USDC over 6000/2000/1500/500 → 60/20/15/last=5(+dust). 100-(60+20+15)=5, exact here,
        // so use a value that leaves dust: 101 → 60/20/15/last 6 (101-95). Last recipient absorbs dust.
        _setGoodPolicy();
        uint256 tokenId = _claim();
        vm.prank(TREASURY);
        vault.deposit(eventId, tokenId, address(usd), 101);
        _admit(tokenId);
        vault.release(tokenId);
        assertEq(usd.balanceOf(R_ARTIST), 60);
        assertEq(usd.balanceOf(R_VENUE), 20);
        assertEq(usd.balanceOf(R_ORG), 15);
        assertEq(usd.balanceOf(R_PLATFORM), 6, "last recipient absorbs the 1 wei dust");
    }

    function test_doubleReleaseRejected() public {
        _setGoodPolicy();
        uint256 tokenId = _claim();
        _deposit(tokenId);
        _admit(tokenId);
        vault.release(tokenId);
        vm.expectRevert(ISettlementVault.AlreadySettled.selector);
        vault.release(tokenId);
    }

    function test_releaseManyTolerantOfNonHeld() public {
        _setGoodPolicy();
        uint256 a = _claim();
        uint256 b = _claim();
        _deposit(a);
        _deposit(b);
        _admit(a); // b not admitted
        uint256[] memory ids = new uint256[](2);
        ids[0] = a;
        ids[1] = b;
        vault.releaseMany(ids); // releases a, skips b
        (,,,, uint8 sa) = vault.escrowOf(a);
        (,,,, uint8 sb) = vault.escrowOf(b);
        assertEq(sa, 2); // Released
        assertEq(sb, 1); // still Held
    }

    // --- pull fallback (blacklist) --------------------------------------------------------------

    function test_blacklistedRecipientFallsBackToPullThenWithdraw() public {
        _setGoodPolicy();
        uint256 tokenId = _claim();
        _deposit(tokenId);
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
        _setGoodPolicy();
        uint256 tokenId = _claim();
        _deposit(tokenId);
        uint256[] memory ids = new uint256[](1);
        ids[0] = tokenId;
        vm.expectRevert(ISettlementVault.EventNotEnded.selector);
        vault.settleNoShows(eventId, ids);
    }

    function test_settleNoShowsAfterEndDistributes() public {
        _setGoodPolicy();
        uint256 tokenId = _claim();
        _deposit(tokenId); // never admitted

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

    function test_settleNoShowsRefundPolicyRefundsPayer() public {
        // a second event whose policy refunds no-shows
        uint256 eventId2 = _event(orgId, 10, 2, true, false);
        ISettlementVault.SplitPolicy memory p = _policy(_recipients(), true); // noShowRefund = true
        (ISettlementVault.PolicyAuth memory auth, bytes memory sig) = _signPolicy(eventId2, p, ORG_OWNER, P256Vectors.DEVICE_PRIV);
        vault.setPolicy(eventId2, p, auth, sig);

        uint256 tokenId = _claimForFixture(ALICE, eventId2, 0);
        vm.prank(TREASURY);
        vault.deposit(eventId2, tokenId, address(usd), PRICE);
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
        _setGoodPolicy();
        uint256 tokenId = _claim();
        _deposit(tokenId);
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
        _setGoodPolicy();
        uint256 tokenId = _claim();
        _deposit(tokenId);
        _admit(tokenId);
        vm.expectRevert(ISettlementVault.AlreadyCheckedIn.selector);
        vm.prank(TREASURY);
        vault.refund(tokenId);
    }

    function test_refundAfterReleaseRejected() public {
        _setGoodPolicy();
        uint256 tokenId = _claim();
        _deposit(tokenId);
        _admit(tokenId);
        vault.release(tokenId);
        vm.expectRevert(ISettlementVault.NothingToRefund.selector);
        vm.prank(TREASURY);
        vault.refund(tokenId);
    }

    function test_refundOnCancelledEventIsPermissionless() public {
        _setGoodPolicy();
        uint256 tokenId = _claim();
        _deposit(tokenId);

        vm.prank(ORG_OWNER);
        ticket.cancelEvent(eventId);

        uint256 treasuryBefore = usd.balanceOf(TREASURY);
        vm.prank(BOB); // anyone can trigger on a cancelled event
        vault.refund(tokenId);
        assertEq(usd.balanceOf(TREASURY), treasuryBefore + PRICE, "refund returns to payer");
    }

    function test_refundByStrangerOnLiveEventRejected() public {
        _setGoodPolicy();
        uint256 tokenId = _claim();
        _deposit(tokenId);
        vm.expectRevert(ISettlementVault.NotDepositor.selector);
        vm.prank(BOB);
        vault.refund(tokenId);
    }

    // --- pause ----------------------------------------------------------------------------------

    function test_pauseBlocksMoneyPathsButNotWithdraw() public {
        _setGoodPolicy();
        uint256 tokenId = _claim();
        _deposit(tokenId);
        _admit(tokenId);

        vault.setPaused(true);
        vm.expectRevert(ISettlementVault.Paused.selector);
        vault.release(tokenId);

        vm.expectRevert(ISettlementVault.Paused.selector);
        vm.prank(TREASURY);
        vault.refund(tokenId);
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
        ISettlementVault.SplitPolicy memory p = _policy(r, false);
        (ISettlementVault.PolicyAuth memory auth, bytes memory sig) = _signPolicy(eventId, p, ORG_OWNER, P256Vectors.DEVICE_PRIV);
        vault.setPolicy(eventId, p, auth, sig);

        uint256 tokenId = _claim();
        vm.prank(TREASURY);
        vault.deposit(eventId, tokenId, address(rtoken), PRICE);
        _admit(tokenId);

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
