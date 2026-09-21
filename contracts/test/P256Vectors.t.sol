// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {MontiTest} from "./Base.t.sol";
import {P256} from "solady/utils/P256.sol";
import {P256Vectors} from "./utils/P256Vectors.sol";

/// @dev Under the repo's `evm_version = "osaka"`, forge ships the real EIP-7951 P256VERIFY
///      precompile at 0x100, so these tests exercise the real precompile against real vectors.
contract P256VectorsTest is MontiTest {
    // Cross-plan device-signature inputs from packages/shared (02-firebase-indexer task 4).
    // Named so the assertion below and this documentation cannot drift apart.
    uint256 internal constant SHARED_TOKEN_ID = 7;
    uint256 internal constant SHARED_GATE_ID = 3;
    uint256 internal constant SHARED_EVENT_ID = 11;
    bytes32 internal constant SHARED_NONCE = 0x1111111111111111111111111111111111111111111111111111111111111111;
    uint64 internal constant SHARED_ISSUED_AT = 1789862400;
    bytes32 internal constant SHARED_DEVICE_SIG_HASH =
        0xc99dfaef599235b36414480bc53054182d5f7fc67a33c60233f3f73f7fc560c7;

    function setUp() public {
        _deployMonti();
    }

    function test_precompile_acceptsDeviceVector() public view {
        assertTrue(
            P256.verifySignature(
                P256Vectors.GATE1_DIGEST,
                P256Vectors.GATE1_R,
                P256Vectors.GATE1_S,
                P256Vectors.DEVICE_X,
                P256Vectors.DEVICE_Y
            )
        );
    }

    function test_precompile_rejectsOtherKey() public view {
        assertFalse(
            P256.verifySignature(
                P256Vectors.GATE1_DIGEST,
                P256Vectors.OTHER_R,
                P256Vectors.OTHER_S,
                P256Vectors.DEVICE_X,
                P256Vectors.DEVICE_Y
            )
        );
    }

    /// @dev The on-chain digest must be byte-identical to the off-chain packages/shared deviceSigHash
    ///      for the SAME inputs, so a QR minted off-chain verifies against Ticket.checkIn on-chain.
    function test_digest_matchesSharedVector() public pure {
        bytes32 onChain =
            sha256(abi.encode(SHARED_TOKEN_ID, SHARED_GATE_ID, SHARED_EVENT_ID, SHARED_NONCE, SHARED_ISSUED_AT));
        assertEq(onChain, SHARED_DEVICE_SIG_HASH);
    }

    /// @dev The generated GATE1_DIGEST is reproducible on-chain from the library's signing inputs,
    ///      proving script/gen-p256-vectors.mjs's sha256(abi.encode(...)) matches Solidity's.
    function test_digest_reproducesGate1() public pure {
        bytes32 onChain = sha256(
            abi.encode(
                P256Vectors.TOKEN_ID,
                P256Vectors.GATE1_ID,
                P256Vectors.EVENT_ID,
                P256Vectors.NONCE,
                P256Vectors.ISSUED_AT
            )
        );
        assertEq(onChain, P256Vectors.GATE1_DIGEST);
    }
}
