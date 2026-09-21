// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {MontiTest} from "./Base.t.sol";
import {Ticket} from "../src/Ticket.sol";
import {P256Vectors} from "./utils/P256Vectors.sol";

/// @notice Runs only when MONAD_TESTNET_RPC is set. Forking gives us the real EIP-7951 precompile at
///         0x100 (6,900 gas), which is the whole point: a mock would report a meaningless number.
///         Monad charges the gas limit rather than the gas used, so the number this test prints is
///         what MONTI actually pays for every single admission.
contract CheckInGasTest is MontiTest {
    /// @dev Spec 8.3 budgets 275k for the whole sponsored user op; the call itself gets 200k.
    uint256 internal constant CHECK_IN_GAS_CEILING = 200_000;

    uint256 internal eventId;
    uint256 internal tokenId;
    uint256 internal gateId;
    bool internal forked;

    function setUp() public {
        string memory rpc = vm.envOr("MONAD_TESTNET_RPC", string(""));
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc);
        forked = true;

        // No vm.etch here on purpose: nothing mocks 0x100 in this suite, so the precompile the fork
        // runs is the genuine one.
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
    }

    function test_checkInCostsLessThan200kGasOnTheRealPrecompile() public {
        if (!forked) {
            emit log("skipped: set MONAD_TESTNET_RPC to measure real check-in gas");
            return;
        }

        assertEq(eventId, P256Vectors.EVENT_ID, "vectors were generated for event 1");
        assertEq(tokenId, P256Vectors.TOKEN_ID, "vectors were generated for token 1");
        assertEq(gateId, P256Vectors.GATE1_ID, "vectors were generated for gate 1");

        Ticket.GateCode memory g = Ticket.GateCode({
            gateId: gateId, eventId: P256Vectors.EVENT_ID, issuedAt: P256Vectors.ISSUED_AT, nonce: P256Vectors.NONCE
        });
        bytes memory sig = abi.encode(P256Vectors.GATE1_R, P256Vectors.GATE1_S);

        vm.prank(GATE_A);
        uint256 before = gasleft();
        ticket.checkIn(tokenId, g, sig);
        uint256 used = before - gasleft();

        emit log_named_uint("fork block", block.number);
        emit log_named_uint("checkIn gas", used);
        assertEq(ticket.checkInOf(tokenId).gateId, gateId, "the measured call must be a real check-in");
        assertLt(used, CHECK_IN_GAS_CEILING, "spec 8.3 budgets 275k for the whole user op; the call must be < 200k");
    }
}
