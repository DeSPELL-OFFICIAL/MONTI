// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {MontiTest} from "./Base.t.sol";
import {Ticket} from "../src/Ticket.sol";
import {ITicket} from "../src/interfaces/ITicket.sol";
import {P256Vectors} from "./utils/P256Vectors.sol";

/// @notice Measured execution gas for the v2 settlement ops (v2 design §14), for relayer/treasury gas-limit
///         sizing. Methodology mirrors ForwardGas: every P-256 signature (vm.signP256) and sha256 is built in
///         setUp, OUTSIDE the `gasleft()` window, so a cold precompile is not pre-warmed into the measurement.
///
///         ── P-256 normalisation ──────────────────────────────────────────────────────────────
///         Local EVM (evm_version "osaka") has the real P256VERIFY precompile at 6,900 gas/verify; Monad's
///         RIP-7212 does it in 3,450. Only `purchase` verifies a P-256 signature (the attendee's ClaimAuth,
///         exactly once inside Ticket.mintPaid), so only it is normalised: monad-eq = local − 3,450.
///         publishEvent (direct)/release/settleNoShows/refund do no P-256 work.
contract SettlementGasTest is MontiTest {
    uint256 internal constant LOCAL_P256_VERIFY = 6_900;
    uint256 internal constant MONAD_P256_VERIFY = 3_450;
    uint256 internal constant P256_DELTA = LOCAL_P256_VERIFY - MONAD_P256_VERIFY; // 3,450

    uint256 internal constant PRICE_CENTS = 3000; // $30

    uint256 internal orgId;
    uint256 internal eventId;
    uint256 internal gateId;

    uint256 internal tokenRelease; // purchased + admitted
    uint256 internal tokenRefund; // purchased
    uint256[] internal tokensNoShow; // 10 purchased, not admitted

    // pre-built purchase authorisation (signature outside the gas window)
    ITicket.ClaimAuth internal purchaseAuth;
    bytes internal purchaseSig;
    Ticket.EventMeta internal publishMeta;

    function setUp() public {
        _deployMonti();
        _memberWithDeviceKey(ALICE, 0xA1A1);

        orgId = organizers.createOrganizer(ORG_OWNER);
        eventId = _paidEventCap(PRICE_CENTS, 50);
        gateId = _openRealGate(eventId, GATE_A);

        // stage release target: purchase, admit
        tokenRelease = _purchase(ALICE, eventId, 0);
        _admit(tokenRelease);

        // stage refund target
        tokenRefund = _purchase(ALICE, eventId, 0);

        // stage 10 no-show targets
        for (uint256 i; i < 10; ++i) {
            tokensNoShow.push(_purchase(ALICE, eventId, 0));
        }

        // pre-build the next purchase (steady state: event slots already warm on chain)
        (ITicket.ClaimAuth memory a, bytes memory s) = _signClaimAuth(ALICE, eventId, 0);
        purchaseAuth = a;
        purchaseSig = s;
        publishMeta = _meta(orgId, 2, true, false);
    }

    // --- helpers --------------------------------------------------------------------------------

    function _paidEventCap(uint256 price, uint16 maxPerWallet) internal returns (uint256 id) {
        Ticket.Tier[] memory t = new Ticket.Tier[](1);
        t[0] = Ticket.Tier({
            name: "General", priceUsdCents: price, supply: 100, minted: 0, maxPerWallet: maxPerWallet, seated: false
        });
        vm.prank(ORG_OWNER);
        id = ticket.publishEvent(_meta(orgId, 2, true, false), t, _goodPolicy());
    }

    function _admit(uint256 tokenId) internal {
        Ticket.GateCode memory g = Ticket.GateCode({
            gateId: gateId, eventId: eventId, issuedAt: uint64(block.timestamp), nonce: P256Vectors.NONCE
        });
        bytes memory gs = _gateSig(g);
        bytes memory ds = _deviceSig(tokenId, g);
        vm.prank(RELAYER);
        ticket.checkInFor(tokenId, g, gs, ds);
    }

    function _logP256(string memory name, uint256 used) internal {
        emit log_named_uint(string.concat(name, " | local"), used);
        emit log_named_uint(string.concat(name, " | monad-eq (-3450)"), used - P256_DELTA);
    }

    function _logFlat(string memory name, uint256 used) internal {
        emit log_named_uint(string.concat(name, " | local == monad-eq (no P-256)"), used);
    }

    // --- measurements ---------------------------------------------------------------------------

    function test_gas_publishEvent_paid() public {
        Ticket.Tier[] memory t = new Ticket.Tier[](1);
        t[0] =
            Ticket.Tier({name: "General", priceUsdCents: 1000, supply: 100, minted: 0, maxPerWallet: 4, seated: false});
        Ticket.EventMeta memory m = publishMeta;
        vm.prank(ORG_OWNER);
        uint256 g = gasleft();
        ticket.publishEvent(m, t, _goodPolicy());
        _logFlat("publishEvent(paid, 1 tier, 4 recipients, direct)", g - gasleft());
    }

    function test_gas_purchase() public {
        ITicket.ClaimAuth memory a = purchaseAuth;
        bytes memory s = purchaseSig;
        vm.prank(TREASURY);
        uint256 g = gasleft();
        vault.purchase(a, s, address(usd));
        _logP256("purchase(mint + escrow + USDC pull)", g - gasleft());
    }

    function test_gas_release() public {
        uint256 g = gasleft();
        vault.release(tokenRelease);
        _logFlat("release (4 recipients, cold)", g - gasleft());
    }

    function test_gas_settleNoShows_1() public {
        vm.warp(uint256(T0) + 2 days + 1);
        uint256[] memory ids = new uint256[](1);
        ids[0] = tokensNoShow[0];
        uint256 g = gasleft();
        vault.settleNoShows(eventId, ids);
        _logFlat("settleNoShows(1)", g - gasleft());
    }

    function test_gas_settleNoShows_10() public {
        vm.warp(uint256(T0) + 2 days + 1);
        uint256[] memory ids = new uint256[](10);
        for (uint256 i; i < 10; ++i) {
            ids[i] = tokensNoShow[i];
        }
        uint256 g = gasleft();
        vault.settleNoShows(eventId, ids);
        _logFlat("settleNoShows(10)", g - gasleft());
    }

    function test_gas_refund() public {
        vm.prank(TREASURY);
        uint256 g = gasleft();
        vault.refund(tokenRefund);
        _logFlat("refund", g - gasleft());
    }
}
