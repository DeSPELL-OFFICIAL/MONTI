// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {MontiTest} from "./Base.t.sol";
import {Ticket} from "../src/Ticket.sol";
import {SettlementVault} from "../src/SettlementVault.sol";
import {ISettlementVault} from "../src/interfaces/ISettlementVault.sol";
import {MockUSD} from "../src/mocks/MockUSD.sol";
import {P256Vectors} from "./utils/P256Vectors.sol";

/// @notice Batch A / A3 — measured execution gas for the settlement ops (plan 2026-10-01 §A3), replacing
///         the design §6 estimates with real numbers for relayer-limit sizing. Methodology mirrors
///         ForwardGas: every P-256 signature (vm.signP256) and sha256 is built in setUp, OUTSIDE the
///         `gasleft()` window, so a cold precompile is not pre-warmed into the measurement.
///
///         ── P-256 normalisation ──────────────────────────────────────────────────────────────
///         Local EVM (evm_version "osaka") has the real P256VERIFY precompile at 6,900 gas/verify; Monad's
///         RIP-7212 does it in 3,450. Only `setPolicy` verifies a P-256 signature (exactly once), so only
///         it is normalised: monad-eq = local − 3,450. deposit/release/settleNoShows/refund do no P-256
///         work (they read Ticket.usedAt/eventStatus), so their Monad equivalent is the local number.
contract SettlementGasTest is MontiTest {
    uint256 internal constant LOCAL_P256_VERIFY = 6_900;
    uint256 internal constant MONAD_P256_VERIFY = 3_450;
    uint256 internal constant P256_DELTA = LOCAL_P256_VERIFY - MONAD_P256_VERIFY; // 3,450

    SettlementVault internal vault;
    MockUSD internal usd;
    uint256 internal orgId;
    uint256 internal eventId;
    uint256 internal eventId2; // fresh (no policy) for the setPolicy measurement
    uint256 internal gateId;

    address internal constant TREASURY = address(0x7EA50);
    address internal constant R_ARTIST = address(0xA4715);
    address internal constant R_VENUE = address(0xACE);
    address internal constant R_ORG = address(0x0B6);
    address internal constant R_PLATFORM = address(0x9147);
    uint128 internal constant PRICE = 30_000_000;

    uint256 internal tokenRelease; // deposited + admitted
    uint256 internal tokenDeposit; // claimed, not deposited
    uint256 internal tokenRefund; // deposited
    uint256[] internal tokensNoShow; // 10 deposited, not admitted

    // pre-built setPolicy authorisation (signature outside the gas window)
    ISettlementVault.PolicyAuth internal auth2;
    bytes internal sig2;

    function setUp() public {
        _deployMonti();
        _memberWithDeviceKey(ORG_OWNER, 0x0140);
        _memberWithDeviceKey(ALICE, 0xA1A1);

        orgId = organizers.createOrganizer(ORG_OWNER);
        eventId = _event(orgId, 50, 2, true, false);
        eventId2 = _event(orgId, 50, 2, true, false);
        gateId = _openRealGate(eventId, GATE_A);

        usd = new MockUSD();
        vault = new SettlementVault(address(ticket), address(organizers), address(identity), TREASURY, address(usd));
        usd.mint(TREASURY, 100_000_000_000);
        vm.prank(TREASURY);
        usd.approve(address(vault), type(uint256).max);

        // policy on eventId (frozen by the first staged deposit below)
        ISettlementVault.SplitPolicy memory p = _policy();
        (ISettlementVault.PolicyAuth memory a, bytes memory s) = _signPolicy(eventId, p, 0);
        vault.setPolicy(eventId, p, a, s);

        // stage release target: claim, deposit, admit
        tokenRelease = _claim();
        _deposit(tokenRelease);
        _admit(tokenRelease);

        // stage deposit target (post-freeze, steady state)
        tokenDeposit = _claim();

        // stage refund target
        tokenRefund = _claim();
        _deposit(tokenRefund);

        // stage 10 no-show targets
        for (uint256 i; i < 10; ++i) {
            uint256 t = _claim();
            _deposit(t);
            tokensNoShow.push(t);
        }

        // pre-build the setPolicy authorisation for eventId2 (signature OUTSIDE the gas window)
        ISettlementVault.SplitPolicy memory p2 = _policy();
        (auth2, sig2) = _signPolicy(eventId2, p2, 0);
    }

    // --- helpers --------------------------------------------------------------------------------

    function _policy() internal pure returns (ISettlementVault.SplitPolicy memory p) {
        ISettlementVault.Recipient[] memory r = new ISettlementVault.Recipient[](4);
        r[0] = ISettlementVault.Recipient(R_ARTIST, 6000, keccak256("appearance fee"), "artist");
        r[1] = ISettlementVault.Recipient(R_VENUE, 2000, keccak256("venue rental"), "venue");
        r[2] = ISettlementVault.Recipient(R_ORG, 1500, keccak256("organizing fee"), "organizer");
        r[3] = ISettlementVault.Recipient(R_PLATFORM, 500, keccak256("platform fee"), "platform");
        p.recipients = r;
        p.platformBps = 500;
    }

    function _signPolicy(uint256 ev, ISettlementVault.SplitPolicy memory p, uint256 nonceOverride)
        internal
        view
        returns (ISettlementVault.PolicyAuth memory auth, bytes memory sig)
    {
        uint256 nonce = nonceOverride == 0 ? vault.policyNonce(ORG_OWNER) : nonceOverride;
        auth = ISettlementVault.PolicyAuth({organizer: ORG_OWNER, nonce: nonce, deadline: uint64(block.timestamp + 1 hours)});
        bytes32 digest = vault.setPolicyDigest(ev, vault.hashPolicy(p), auth.nonce, auth.deadline);
        (bytes32 r, bytes32 s) = vm.signP256(P256Vectors.DEVICE_PRIV, digest);
        sig = abi.encode(r, s);
    }

    function _claim() internal returns (uint256) {
        return _claimForFixture(ALICE, eventId, 0);
    }

    function _deposit(uint256 tokenId) internal {
        vm.prank(TREASURY);
        vault.deposit(eventId, tokenId, address(usd), PRICE);
    }

    function _admit(uint256 tokenId) internal {
        Ticket.GateCode memory g =
            Ticket.GateCode({gateId: gateId, eventId: eventId, issuedAt: uint64(block.timestamp), nonce: P256Vectors.NONCE});
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

    function test_gas_setPolicy() public {
        uint256 g = gasleft();
        vault.setPolicy(eventId2, _policy(), auth2, sig2);
        _logP256("setPolicy(4 recipients + P-256)", g - gasleft());
    }

    function test_gas_deposit() public {
        vm.prank(TREASURY);
        uint256 g = gasleft();
        vault.deposit(eventId, tokenDeposit, address(usd), PRICE);
        _logFlat("deposit", g - gasleft());
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
