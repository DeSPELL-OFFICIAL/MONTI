// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {MontiTest} from "./Base.t.sol";
import {Ticket} from "../src/Ticket.sol";
import {P256Vectors} from "./utils/P256Vectors.sol";

/// @notice Pins what one admission costs. Monad charges the gas limit rather than the gas used and
///         MONTI sponsors every check-in, so this number is a product constraint, not a micro-
///         optimisation.
///
///         The offline measurement is the authoritative one. `evm_version = "osaka"` gives the local
///         EVM the genuine EIP-7951 P-256 precompile at 0x100 (6,900 gas), which is what solady's
///         `P256.verifySignature` staticcalls; nothing in this suite mocks 0x100. Had the precompile
///         been absent, solady would fall through to the undeployed `VERIFIER` and every check-in
///         test would revert with `BadDeviceSignature` — so a passing suite proves it is real.
///
///         `CheckInGasForkTest` adds confirmation, not fidelity: forking pulls Monad's chain state,
///         but these tests deploy Identity/Organizers/Ticket themselves and read no forked state, and
///         the EVM is the same local one either way. That is why both numbers come out identical.
abstract contract CheckInGasBase is MontiTest {
    /// @dev Spec 8.3 budgets 275k for the whole sponsored user op; the call itself gets 200k.
    uint256 internal constant CHECK_IN_GAS_CEILING = 200_000;

    uint256 internal eventId;
    uint256 internal tokenId;
    uint256 internal gateId;

    /// @dev One holder with the vector device key, one published free event, one claimed ticket, one
    ///      open gate. This must run in `setUp`, i.e. in a transaction of its own: run it in the same
    ///      transaction as the measurement and every account and slot it touched is already warm,
    ///      which reports roughly 30k less than a gate phone really pays.
    ///      No `vm.etch` here on purpose: nothing mocks 0x100, so the precompile is the genuine one.
    function _setUpCheckInFixture() internal {
        _deployMonti();
        _memberWithDeviceKey(ALICE, 0xA1A1);
        uint256 orgId = _org();
        eventId = _freeEvent(orgId, 1, 1, true);
        vm.prank(ALICE);
        tokenId = ticket.claim(eventId, 0, "");
        vm.startPrank(ORG_OWNER);
        gateId = organizers.registerGate(eventId, GATE_A, bytes32(uint256(0x6A01)), bytes32(uint256(0x6A02)));
        organizers.openGate(gateId);
        vm.stopPrank();
        vm.warp(P256Vectors.ISSUED_AT + 5);

        assertEq(eventId, P256Vectors.EVENT_ID, "vectors were generated for event 1");
        assertEq(tokenId, P256Vectors.TOKEN_ID, "vectors were generated for token 1");
        assertEq(gateId, P256Vectors.GATE1_ID, "vectors were generated for gate 1");
    }

    /// @dev Only the `checkIn` call sits inside the window; the fixture does not. The window does
    ///      include ABI-encoding the arguments into calldata and the CALL itself, so `used`
    ///      overstates the pure execution cost by a few hundred gas — conservative for a ceiling.
    function _measureCheckIn() internal returns (uint256 used) {
        Ticket.GateCode memory g = Ticket.GateCode({
            gateId: gateId, eventId: P256Vectors.EVENT_ID, issuedAt: P256Vectors.ISSUED_AT, nonce: P256Vectors.NONCE
        });
        bytes memory sig = abi.encode(P256Vectors.GATE1_R, P256Vectors.GATE1_S);
        // Cache the test's own bookkeeping so its SLOADs are not billed to `checkIn`.
        Ticket t = ticket;
        uint256 id = tokenId;

        vm.prank(GATE_A);
        uint256 before = gasleft();
        t.checkIn(id, g, sig);
        used = before - gasleft();

        // A reverted call is cheap; make sure we priced a check-in that actually happened.
        assertEq(ticket.checkInOf(tokenId).gateId, gateId, "the measured call must be a real check-in");
    }

    function _assertUnderCeiling(uint256 used) internal pure {
        assertLt(used, CHECK_IN_GAS_CEILING, "spec 8.3 budgets 275k for the whole user op; the call must be < 200k");
    }
}

/// @notice The ceiling, enforced on every `forge test` — no RPC, no env var, no opt-in.
contract CheckInGasTest is CheckInGasBase {
    function setUp() public {
        _setUpCheckInFixture();
    }

    function test_checkInGasLocal() public {
        uint256 used = _measureCheckIn();
        emit log_named_uint("checkIn gas (local osaka)", used);
        _assertUnderCeiling(used);
    }
}

/// @notice The same assertion re-run on Monad testnet state. Skips itself when MONAD_TESTNET_RPC is
///         unset so the default suite stays offline and fast; the ceiling above is unaffected either
///         way. The fork has to be selected before the fixture is deployed, which is why this lives
///         in its own contract rather than as a second test above.
contract CheckInGasForkTest is CheckInGasBase {
    bool internal forked;

    function setUp() public {
        string memory rpc = vm.envOr("MONAD_TESTNET_RPC", string(""));
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc);
        forked = true;
        _setUpCheckInFixture();
    }

    function test_checkInGasFork() public {
        if (!forked) {
            emit log("skipped: set MONAD_TESTNET_RPC to re-confirm the ceiling on Monad testnet");
            return;
        }
        uint256 used = _measureCheckIn();
        emit log_named_uint("fork block", block.number);
        emit log_named_uint("checkIn gas (monad fork)", used);
        _assertUnderCeiling(used);
    }
}
