// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {MontiTest} from "./Base.t.sol";
import {Ticket} from "../src/Ticket.sol";
import {SettlementVault} from "../src/SettlementVault.sol";
import {ITicket} from "../src/interfaces/ITicket.sol";
import {ISettlementVault} from "../src/interfaces/ISettlementVault.sol";
import {MockUSD} from "../src/mocks/MockUSD.sol";
import {P256Vectors} from "./utils/P256Vectors.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {ReentrancyGuard} from "solady/utils/ReentrancyGuard.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";

/// @notice A deployed receiving account that tries to re-enter the vault from onERC721Received, i.e. from
///         inside vault.purchase → Ticket.mintPaid → _safeMint.
contract ReenteringReceiver is IERC721Receiver {
    SettlementVault public vault;
    bytes public refundRevert;
    bytes public mintPaidRevert;

    constructor(SettlementVault vault_) {
        vault = vault_;
    }

    function onERC721Received(address, address, uint256 tokenId, bytes calldata) external returns (bytes4) {
        try vault.refund(tokenId) {}
        catch (bytes memory r) {
            refundRevert = r;
        }
        ITicket.ClaimAuth memory a;
        try Ticket(msg.sender).mintPaid(a, "") {}
        catch (bytes memory r) {
            mintPaidRevert = r;
        }
        return IERC721Receiver.onERC721Received.selector;
    }
}

/// @notice v2 C2 — atomic paid purchase (v2 design D1, §3): `SettlementVault.purchase` mints through the
///         vault-only `Ticket.mintPaid` and escrows the on-chain price × 1e4 in one call; `claimFor` stays
///         free-tier only.
contract SettlementPurchaseTest is MontiTest {
    uint256 internal orgId;
    uint256 internal paidId;
    uint256 internal freeId;

    uint256 internal constant PRICE_CENTS = 1000; // $10.00
    uint128 internal constant AMOUNT = 10_000_000; // 10 USDC (6dp)

    function setUp() public {
        _deployMonti();
        _member(ALICE, 0xA1A1);
        orgId = _org();
        paidId = _paidEvent(orgId, PRICE_CENTS, _goodPolicy());
        freeId = _freeEvent(orgId, 2, 1, true);
    }

    function _tokenId(uint256 eventId, uint8 tier, uint256 serial) internal pure returns (uint256) {
        return (eventId << 96) | (uint256(tier) << 88) | serial;
    }

    // --- success ---------------------------------------------------------------------------------

    function test_purchase_mintsAndEscrowsInOneCall() public {
        (ITicket.ClaimAuth memory a, bytes memory sig) = _signClaimAuth(ALICE, paidId, 0);
        uint256 expected = _tokenId(paidId, 0, 1);
        uint256 treasuryBefore = usd.balanceOf(TREASURY);

        vm.expectEmit(true, true, true, true, address(ticket));
        emit IERC721.Transfer(address(0), ALICE, expected);
        vm.expectEmit(true, true, true, true, address(ticket));
        emit Ticket.Claimed(expected, paidId, ALICE, 0);
        vm.expectEmit(true, true, false, true, address(vault));
        emit ISettlementVault.Deposited(paidId, expected, address(usd), AMOUNT, TREASURY);
        vm.prank(TREASURY);
        uint256 tokenId = vault.purchase(a, sig, address(usd));

        assertEq(tokenId, expected);
        assertEq(ticket.ownerOf(tokenId), ALICE);
        (address token, uint128 amount, address payer, uint64 depositedAt, uint8 status) = vault.escrowOf(tokenId);
        assertEq(token, address(usd));
        assertEq(amount, AMOUNT, "price x UNITS_PER_CENT");
        assertEq(payer, TREASURY);
        assertEq(depositedAt, block.timestamp);
        assertEq(status, 1, "HELD");
        assertEq(usd.balanceOf(address(vault)), AMOUNT);
        assertEq(usd.balanceOf(TREASURY), treasuryBefore - AMOUNT);
        assertEq(ticket.claimNonce(paidId, ALICE), 1, "nonce consumed");
        assertEq(ticket.tiers(paidId)[0].minted, 1);
    }

    /// @dev The escrowed amount is always the on-chain tier price: there is no caller-supplied amount.
    function test_purchase_amountFollowsOnChainTierPrice() public {
        Ticket.Tier[] memory t = new Ticket.Tier[](2);
        t[0] = Ticket.Tier({name: "A", priceUsdCents: 1000, supply: 10, minted: 0, maxPerWallet: 2, seated: false});
        t[1] = Ticket.Tier({name: "B", priceUsdCents: 2550, supply: 10, minted: 0, maxPerWallet: 2, seated: false});
        vm.prank(ORG_OWNER);
        uint256 id = ticket.publishEvent(_meta(orgId, 1, true, false), t, _goodPolicy());

        uint256 a = _purchase(ALICE, id, 0);
        uint256 b = _purchase(ALICE, id, 1);
        (, uint128 amountA,,,) = vault.escrowOf(a);
        (, uint128 amountB,,,) = vault.escrowOf(b);
        assertEq(amountA, 10_000_000);
        assertEq(amountB, 25_500_000);
        assertEq(ticket.tierOf(b), 1);
    }

    /// @dev Full money path: purchase → check-in at a gate that was never explicitly opened (v2 D3) →
    ///      release splits 5/60/20/15 exactly.
    function test_purchase_thenCheckInWithoutOpenGate_thenRelease() public {
        uint256 tokenId = _purchase(ALICE, paidId, 0);
        uint256 gateId = _openRealGate(paidId, GATE_A); // registerGate only — no openGate call
        Ticket.GateCode memory g =
            Ticket.GateCode({gateId: gateId, eventId: paidId, issuedAt: uint64(block.timestamp), nonce: bytes32("n1")});
        _checkInFor(tokenId, g);
        assertGt(ticket.usedAt(tokenId), 0);

        vault.release(tokenId);
        assertEq(usd.balanceOf(R_PLATFORM), 500_000);
        assertEq(usd.balanceOf(R_ARTIST), 6_000_000);
        assertEq(usd.balanceOf(R_VENUE), 2_000_000);
        assertEq(usd.balanceOf(R_ORG), 1_500_000);
        assertEq(usd.balanceOf(address(vault)), 0);
    }

    function test_purchase_refundReturnsToTreasury() public {
        uint256 tokenId = _purchase(ALICE, paidId, 0);
        uint256 before = usd.balanceOf(TREASURY);
        vm.prank(TREASURY);
        vault.refund(tokenId);
        assertEq(usd.balanceOf(TREASURY), before + AMOUNT);
        (,,,, uint8 status) = vault.escrowOf(tokenId);
        assertEq(status, 3, "REFUNDED");
    }

    // --- tier/path rules -------------------------------------------------------------------------

    function test_claimFor_paidTier_reverts() public {
        (ITicket.ClaimAuth memory a, bytes memory sig) = _signClaimAuth(ALICE, paidId, 0);
        vm.prank(RELAYER);
        vm.expectRevert(Ticket.PaidTiersNotEnabled.selector);
        ticket.claimFor(a, sig);
    }

    function test_claimFor_freeTier_stillWorks() public {
        uint256 tokenId = _claimForFixture(ALICE, freeId, 0);
        assertEq(ticket.ownerOf(tokenId), ALICE);
    }

    function test_purchase_freeTier_reverts() public {
        (ITicket.ClaimAuth memory a, bytes memory sig) = _signClaimAuth(ALICE, freeId, 0);
        vm.prank(TREASURY);
        vm.expectRevert(Ticket.NotPaidTier.selector);
        vault.purchase(a, sig, address(usd));
    }

    function test_mintPaid_onlyVault() public {
        (ITicket.ClaimAuth memory a, bytes memory sig) = _signClaimAuth(ALICE, paidId, 0);
        vm.prank(TREASURY);
        vm.expectRevert(Ticket.NotVault.selector);
        ticket.mintPaid(a, sig);
        vm.prank(ALICE);
        vm.expectRevert(Ticket.NotVault.selector);
        ticket.mintPaid(a, sig);
    }

    function test_purchase_nonDepositor_reverts() public {
        (ITicket.ClaimAuth memory a, bytes memory sig) = _signClaimAuth(ALICE, paidId, 0);
        vm.prank(RELAYER);
        vm.expectRevert(ISettlementVault.NotDepositor.selector);
        vault.purchase(a, sig, address(usd));
    }

    function test_purchase_tokenNotAllowed_reverts() public {
        MockUSD other = new MockUSD();
        (ITicket.ClaimAuth memory a, bytes memory sig) = _signClaimAuth(ALICE, paidId, 0);
        vm.prank(TREASURY);
        vm.expectRevert(ISettlementVault.TokenNotAllowed.selector);
        vault.purchase(a, sig, address(other));
    }

    function test_purchase_paused_reverts() public {
        vault.setPaused(true);
        (ITicket.ClaimAuth memory a, bytes memory sig) = _signClaimAuth(ALICE, paidId, 0);
        vm.prank(TREASURY);
        vm.expectRevert(ISettlementVault.Paused.selector);
        vault.purchase(a, sig, address(usd));
    }

    function test_purchase_badSignature_reverts() public {
        (ITicket.ClaimAuth memory a,) = _signClaimAuth(ALICE, paidId, 0);
        (bytes32 r, bytes32 s) = vm.signP256(P256Vectors.OTHER_PRIV, ticket.claimAuthDigest(a));
        vm.prank(TREASURY);
        vm.expectRevert(Ticket.BadDeviceSignature.selector);
        vault.purchase(a, abi.encode(r, s), address(usd));
    }

    // --- atomicity -------------------------------------------------------------------------------

    function _assertNothingHappened() internal view {
        assertEq(ticket.balanceOf(ALICE), 0, "no ticket");
        assertEq(ticket.claimNonce(paidId, ALICE), 0, "nonce not consumed");
        assertEq(ticket.tiers(paidId)[0].minted, 0, "supply untouched");
        assertEq(usd.balanceOf(address(vault)), 0, "no money moved");
    }

    function test_purchase_noAllowance_revertsWholePurchase() public {
        vm.prank(TREASURY);
        usd.approve(address(vault), 0);
        (ITicket.ClaimAuth memory a, bytes memory sig) = _signClaimAuth(ALICE, paidId, 0);
        vm.prank(TREASURY);
        vm.expectRevert(SafeTransferLib.TransferFromFailed.selector);
        vault.purchase(a, sig, address(usd));
        _assertNothingHappened();
    }

    function test_purchase_insufficientBalance_revertsWholePurchase() public {
        uint256 bal = usd.balanceOf(TREASURY);
        vm.prank(TREASURY);
        usd.transfer(BOB, bal - (AMOUNT - 1));
        (ITicket.ClaimAuth memory a, bytes memory sig) = _signClaimAuth(ALICE, paidId, 0);
        vm.prank(TREASURY);
        vm.expectRevert(SafeTransferLib.TransferFromFailed.selector);
        vault.purchase(a, sig, address(usd));
        _assertNothingHappened();
        // the same authorisation is still usable once funded (nonce was not consumed)
        vm.prank(BOB);
        usd.transfer(TREASURY, 1);
        vm.prank(TREASURY);
        vault.purchase(a, sig, address(usd));
        assertEq(ticket.balanceOf(ALICE), 1);
    }

    function test_purchase_soldOut_takesNoMoney() public {
        Ticket.Tier[] memory t = new Ticket.Tier[](1);
        t[0] = Ticket.Tier({name: "One", priceUsdCents: 1000, supply: 1, minted: 0, maxPerWallet: 5, seated: false});
        vm.prank(ORG_OWNER);
        uint256 id = ticket.publishEvent(_meta(orgId, 1, true, false), t, _goodPolicy());
        _purchase(ALICE, id, 0);
        uint256 before = usd.balanceOf(TREASURY);

        (ITicket.ClaimAuth memory a, bytes memory sig) = _signClaimAuth(ALICE, id, 0);
        vm.prank(TREASURY);
        vm.expectRevert(Ticket.SoldOut.selector);
        vault.purchase(a, sig, address(usd));
        assertEq(usd.balanceOf(TREASURY), before);
    }

    // --- reentrancy ------------------------------------------------------------------------------

    /// @dev A deployed receiver gets onERC721Received from inside purchase → mintPaid → _safeMint. Its
    ///      attempt to reach vault money (refund) hits the vault's reentrancy guard, and calling mintPaid
    ///      itself is NotVault. The purchase still completes and escrows exactly once.
    function test_purchase_receiverCallbackCannotReenterVault() public {
        ReenteringReceiver rx = new ReenteringReceiver(vault);
        vm.prank(attester);
        identity.register(bytes32(uint256(0xBEEF)), address(rx), P256Vectors.DEVICE_X, P256Vectors.DEVICE_Y, 1);

        uint256 tokenId = _purchase(address(rx), paidId, 0);

        assertEq(ticket.ownerOf(tokenId), address(rx));
        assertEq(bytes4(rx.refundRevert()), ReentrancyGuard.Reentrancy.selector);
        assertEq(bytes4(rx.mintPaidRevert()), Ticket.NotVault.selector);
        (, uint128 amount,,, uint8 status) = vault.escrowOf(tokenId);
        assertEq(amount, AMOUNT);
        assertEq(status, 1);
        assertEq(usd.balanceOf(address(vault)), AMOUNT);
    }

    // --- gas (logged for abi-delta-v2.md; run with --isolate for per-tx numbers) ------------------

    function test_gas_purchase_vs_claimFor() public {
        _member(BOB, 0xB0B0);
        (ITicket.ClaimAuth memory a, bytes memory sig) = _signClaimAuth(ALICE, paidId, 0);
        vm.prank(TREASURY);
        uint256 g0 = gasleft();
        vault.purchase(a, sig, address(usd));
        uint256 purchaseGas = g0 - gasleft();

        (ITicket.ClaimAuth memory b, bytes memory sig2) = _signClaimAuth(BOB, freeId, 0);
        vm.prank(RELAYER);
        g0 = gasleft();
        ticket.claimFor(b, sig2);
        uint256 claimGas = g0 - gasleft();

        emit log_named_uint("purchase (first, cold) gas", purchaseGas);
        emit log_named_uint("claimFor free (first, cold) gas", claimGas);
    }
}
