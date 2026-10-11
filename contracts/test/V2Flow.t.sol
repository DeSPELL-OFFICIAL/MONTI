// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {Vm} from "forge-std/Vm.sol";
import {MontiTest} from "./Base.t.sol";
import {Ticket} from "../src/Ticket.sol";
import {Organizers} from "../src/Organizers.sol";
import {ITicket} from "../src/interfaces/ITicket.sol";
import {ISettlementVault} from "../src/interfaces/ISettlementVault.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {P256Vectors} from "./utils/P256Vectors.sol";

/// @notice v2 end-to-end inside the EVM (design 2026-10-12 §13 V1, plan C7). Every organizer action goes the
///         production way — the organizer's device key signs a forward request and the RELAYER submits it
///         through MontiForwarder — and every attendee action is a device-signed ClaimAuth / check-in
///         submitted by the relayer (free) or the treasury (paid). Covers: organizer → paid publish (policy
///         frozen v1) → gate (open on register) → atomic purchase (Transfer+Claimed+Deposited in one tx,
///         amount = price × 1e4) → check-in / forwarded manualOverride → release (5/60/20/15 exact);
///         free publish → claimFor; attendee refund; cancelled-event refund; no-show settle; the two
///         free-mint bypasses; insufficient-USDC atomic revert.
contract V2FlowTest is MontiTest {
    uint256 internal constant PRICE_CENTS = 1000; // $10 (E2E_PRICE_USD=10)
    uint128 internal constant AMOUNT = 10_000_000; // 10 USDC

    bytes32 internal constant TOPIC_TRANSFER = keccak256("Transfer(address,address,uint256)");
    bytes32 internal constant TOPIC_CLAIMED = keccak256("Claimed(uint256,uint256,address,uint8)");
    bytes32 internal constant TOPIC_DEPOSITED = keccak256("Deposited(uint256,uint256,address,uint128,address)");

    uint256 internal orgId;

    function setUp() public {
        _deployMonti();
        _memberWithDeviceKey(ORG_OWNER, 0x0140); // the organizer signs forward requests with the DEVICE key
        _memberWithDeviceKey(ALICE, 0xA1A1);
        _memberWithDeviceKey(BOB, 0xB0B0);
        // createOrganizer is sent by the attester EOA in production; the contract lets anyone call it.
        vm.prank(attester);
        orgId = organizers.createOrganizer(ORG_OWNER);
        assertEq(orgId, 1001, "v2 organizer ids start at 1001");
    }

    // --- organizer actions through the forwarder ------------------------------------------------

    function _publishFwd(uint256 priceCents, ISettlementVault.SplitPolicy memory p) internal returns (uint256 id) {
        Ticket.Tier[] memory t = new Ticket.Tier[](1);
        t[0] = Ticket.Tier({
            name: "General", priceUsdCents: priceCents, supply: 100, minted: 0, maxPerWallet: 4, seated: false
        });
        bytes memory ret = _execFwd(
            ORG_OWNER, address(ticket), abi.encodeCall(Ticket.publishEvent, (_meta(orgId, 2, true, false), t, p))
        );
        id = abi.decode(ret, (uint256));
    }

    function _registerGateFwd(uint256 eventId, address gateAccount) internal returns (uint256 gateId) {
        bytes memory ret = _execFwd(
            ORG_OWNER,
            address(organizers),
            abi.encodeCall(Organizers.registerGate, (eventId, gateAccount, GATE_KX, GATE_KY))
        );
        gateId = abi.decode(ret, (uint256));
    }

    function _manualOverrideFwd(uint256 tokenId, uint256 gateId) internal {
        _execFwd(ORG_OWNER, address(ticket), abi.encodeCall(Ticket.manualOverride, (tokenId, gateId, 1)));
    }

    function _gateCode(uint256 gateId, uint256 eventId, bytes32 nonce) internal view returns (Ticket.GateCode memory) {
        return Ticket.GateCode({gateId: gateId, eventId: eventId, issuedAt: uint64(block.timestamp), nonce: nonce});
    }

    function _assertSplit(uint256 platform, uint256 artist, uint256 venue, uint256 org_) internal view {
        assertEq(usd.balanceOf(R_PLATFORM), platform, "platform 5%");
        assertEq(usd.balanceOf(R_ARTIST), artist, "artist 60%");
        assertEq(usd.balanceOf(R_VENUE), venue, "venue 20%");
        assertEq(usd.balanceOf(R_ORG), org_, "organizer 15%");
    }

    // --- paid: publish → gate → purchase → check-in → release ------------------------------------

    function test_paid_publish_gate_purchase_checkIn_release() public {
        // publish: one forwarded tx, Published at once, policy frozen v1
        uint256 eventId = _publishFwd(PRICE_CENTS, _goodPolicy());
        assertEq(eventId, 1001, "v2 event ids start at 1001");
        assertEq(uint8(ticket.eventStatus(eventId)), 1);
        ISettlementVault.SplitPolicy memory pol = vault.getPolicy(eventId);
        assertTrue(pol.frozen);
        assertEq(pol.version, 1);

        // gate: one forwarded tx, open on register
        uint256 gateId = _registerGateFwd(eventId, GATE_A);
        (,,,, bool open,) = organizers.gateInfo(gateId);
        assertTrue(open, "gate open on register");

        // purchase: one treasury tx; Transfer → Claimed → Deposited in the same receipt
        uint256 tokenId = _purchaseAndCheckReceipt(eventId);

        // check-in at the door (gate never explicitly opened), submitted by the relayer
        _checkInFor(tokenId, _gateCode(gateId, eventId, P256Vectors.NONCE));
        assertGt(ticket.usedAt(tokenId), 0);

        // release: permissionless, exact split, nothing left behind
        vm.prank(RELAYER);
        vault.release(tokenId);
        _assertSplit(500_000, 6_000_000, 2_000_000, 1_500_000);
        assertEq(usd.balanceOf(address(vault)), 0);
    }

    /// @dev One treasury tx; Transfer → Claimed → Deposited in the same receipt; escrow = price × 1e4.
    function _purchaseAndCheckReceipt(uint256 eventId) internal returns (uint256 tokenId) {
        uint256 treasuryBefore = usd.balanceOf(TREASURY);
        (ITicket.ClaimAuth memory a, bytes memory sig) = _signClaimAuth(ALICE, eventId, 0);
        vm.recordLogs();
        vm.prank(TREASURY);
        tokenId = vault.purchase(a, sig, address(usd));
        _assertReceiptOrder(vm.getRecordedLogs(), tokenId);

        (, uint128 amount, address payer,, uint8 status) = vault.escrowOf(tokenId);
        assertEq(amount, AMOUNT, "amount = on-chain price x 1e4");
        assertEq(payer, TREASURY);
        assertEq(status, 1);
        assertEq(usd.balanceOf(TREASURY), treasuryBefore - AMOUNT);
        assertEq(ticket.ownerOf(tokenId), ALICE);
    }

    function _assertReceiptOrder(Vm.Log[] memory logs, uint256 tokenId) internal view {
        uint256 iT = type(uint256).max;
        uint256 iC = type(uint256).max;
        uint256 iD = type(uint256).max;
        for (uint256 i; i < logs.length; ++i) {
            bytes32 t0 = logs[i].topics[0];
            if (t0 == TOPIC_TRANSFER && logs[i].emitter == address(ticket)) iT = i;
            else if (t0 == TOPIC_CLAIMED) iC = i;
            else if (t0 == TOPIC_DEPOSITED) iD = i;
        }
        assertTrue(iT < iC && iC < iD && iD != type(uint256).max, "Transfer -> Claimed -> Deposited in one tx");
        assertEq(uint256(logs[iD].topics[2]), tokenId);
    }

    function test_paid_manualOverrideViaForwarder_thenRelease() public {
        uint256 eventId = _publishFwd(PRICE_CENTS, _goodPolicy());
        uint256 gateId = _registerGateFwd(eventId, GATE_A);
        uint256 tokenId = _purchase(ALICE, eventId, 0);

        vm.expectEmit(true, true, true, true, address(ticket));
        emit Ticket.ManualOverride(tokenId, gateId, ORG_OWNER, ticket.ROLE_APPROVER(), 1);
        _manualOverrideFwd(tokenId, gateId);
        assertGt(ticket.usedAt(tokenId), 0);

        vault.release(tokenId);
        _assertSplit(500_000, 6_000_000, 2_000_000, 1_500_000);
    }

    // --- free: publish → claimFor → check-in -----------------------------------------------------

    function test_free_publish_claimFor_checkIn() public {
        uint256 eventId = _publishFwd(0, _emptyPolicy());
        assertEq(vault.getPolicy(eventId).version, 0, "free events have no policy");
        uint256 gateId = _registerGateFwd(eventId, GATE_A);

        uint256 tokenId = _claimForFixture(ALICE, eventId, 0); // permissionless: any relayer EOA submits
        assertEq(ticket.ownerOf(tokenId), ALICE);

        (ITicket.ClaimAuth memory a, bytes memory sig) = _signClaimAuth(ALICE, eventId, 0);
        vm.prank(TREASURY);
        vm.expectRevert(Ticket.NotPaidTier.selector);
        vault.purchase(a, sig, address(usd));

        _checkInFor(tokenId, _gateCode(gateId, eventId, P256Vectors.NONCE));
        assertGt(ticket.usedAt(tokenId), 0);
        vm.expectRevert(ISettlementVault.NoEscrow.selector);
        vault.release(tokenId);
    }

    // --- refunds ---------------------------------------------------------------------------------

    function test_refund_attendeeCancellationReturnsToTreasury() public {
        uint256 eventId = _publishFwd(PRICE_CENTS, _goodPolicy());
        uint256 before = usd.balanceOf(TREASURY);
        uint256 tokenId = _purchase(ALICE, eventId, 0);

        vm.prank(TREASURY);
        vault.refund(tokenId);
        assertEq(usd.balanceOf(TREASURY), before, "treasury made whole");
        (,,,, uint8 status) = vault.escrowOf(tokenId);
        assertEq(status, 3);
        vm.expectRevert(ISettlementVault.AlreadySettled.selector);
        vault.release(tokenId);
    }

    function test_refund_cancelledEventIsPermissionlessAndBlocksTheDoor() public {
        uint256 eventId = _publishFwd(PRICE_CENTS, _goodPolicy());
        uint256 gateId = _registerGateFwd(eventId, GATE_A);
        uint256 before = usd.balanceOf(TREASURY);
        uint256 t1 = _purchase(ALICE, eventId, 0);
        uint256 t2 = _purchase(BOB, eventId, 0);

        _execFwd(ORG_OWNER, address(ticket), abi.encodeCall(Ticket.cancelEvent, (eventId)));
        assertEq(uint8(ticket.eventStatus(eventId)), 2);

        Ticket.GateCode memory g = _gateCode(gateId, eventId, P256Vectors.NONCE);
        bytes memory gs = _gateSig(g);
        bytes memory ds = _deviceSig(t1, g);
        vm.prank(RELAYER);
        vm.expectRevert(Ticket.EventCancelled.selector);
        ticket.checkInFor(t1, g, gs, ds);

        vm.prank(CAROL); // anyone
        vault.refund(t1);
        vm.prank(RELAYER);
        vault.refund(t2);
        assertEq(usd.balanceOf(TREASURY), before, "both refunds returned to the payer");
        assertEq(usd.balanceOf(address(vault)), 0);
    }

    // --- no-show ---------------------------------------------------------------------------------

    function test_noShow_settledToRecipientsAfterEnd() public {
        uint256 eventId = _publishFwd(PRICE_CENTS, _goodPolicy());
        uint256 tokenId = _purchase(ALICE, eventId, 0);
        vm.warp(uint256(T0) + 2 days + 1);
        uint256[] memory ids = new uint256[](1);
        ids[0] = tokenId;
        vm.prank(RELAYER);
        vault.settleNoShows(eventId, ids);
        _assertSplit(500_000, 6_000_000, 2_000_000, 1_500_000);
    }

    // --- bypasses and atomicity ------------------------------------------------------------------

    function test_noFreeMintOfAPaidTier() public {
        uint256 eventId = _publishFwd(PRICE_CENTS, _goodPolicy());
        (ITicket.ClaimAuth memory a, bytes memory sig) = _signClaimAuth(ALICE, eventId, 0);

        vm.prank(BOB); // any EOA with faucet MON
        vm.expectRevert(Ticket.PaidTiersNotEnabled.selector);
        ticket.claimFor(a, sig);

        vm.prank(TREASURY);
        vm.expectRevert(Ticket.NotVault.selector);
        ticket.mintPaid(a, sig);

        assertEq(ticket.balanceOf(ALICE), 0);
    }

    function test_insufficientUsdc_revertsWholePurchase() public {
        uint256 eventId = _publishFwd(PRICE_CENTS, _goodPolicy());
        uint256 bal = usd.balanceOf(TREASURY);
        vm.prank(TREASURY);
        usd.transfer(CAROL, bal - 1); // 0.000001 USDC left
        (ITicket.ClaimAuth memory a, bytes memory sig) = _signClaimAuth(ALICE, eventId, 0);

        vm.prank(TREASURY);
        vm.expectRevert(SafeTransferLib.TransferFromFailed.selector);
        vault.purchase(a, sig, address(usd));

        assertEq(ticket.balanceOf(ALICE), 0, "no ticket");
        assertEq(ticket.claimNonce(eventId, ALICE), 0, "nonce untouched - the same auth can be retried");
        assertEq(ticket.tiers(eventId)[0].minted, 0);
        assertEq(usd.balanceOf(address(vault)), 0);
    }

    // --- gas (one representative tx per step; `forge test --match-contract V2FlowTest --gas-report --isolate`)

    function test_gas_v2_organizerAndAttendeeSteps() public {
        // publish (paid, forwarded)
        Ticket.Tier[] memory t = new Ticket.Tier[](1);
        t[0] = Ticket.Tier({
            name: "General", priceUsdCents: PRICE_CENTS, supply: 100, minted: 0, maxPerWallet: 4, seated: false
        });
        bytes memory pubData = abi.encodeCall(Ticket.publishEvent, (_meta(orgId, 2, true, false), t, _goodPolicy()));
        uint256 g = gasleft();
        bytes memory ret = _execFwd(ORG_OWNER, address(ticket), pubData);
        emit log_named_uint("publishEvent(paid) via forwarder [incl. sign+view overhead]", g - gasleft());
        uint256 eventId = abi.decode(ret, (uint256));

        (ITicket.ClaimAuth memory a, bytes memory sig) = _signClaimAuth(ALICE, eventId, 0);
        vm.prank(TREASURY);
        g = gasleft();
        uint256 tokenId = vault.purchase(a, sig, address(usd));
        emit log_named_uint("purchase (treasury)", g - gasleft());

        uint256 gateId = _registerGateFwd(eventId, GATE_A);
        Ticket.GateCode memory gc = _gateCode(gateId, eventId, P256Vectors.NONCE);
        bytes memory gs = _gateSig(gc);
        bytes memory ds = _deviceSig(tokenId, gc);
        vm.prank(RELAYER);
        g = gasleft();
        ticket.checkInFor(tokenId, gc, gs, ds);
        emit log_named_uint("checkInFor (relayer)", g - gasleft());

        g = gasleft();
        vault.release(tokenId);
        emit log_named_uint("release (4 rows)", g - gasleft());
    }
}
