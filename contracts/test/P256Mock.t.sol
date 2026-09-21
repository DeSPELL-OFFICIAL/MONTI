// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {MontiTest} from "./Base.t.sol";
import {P256} from "solady/utils/P256.sol";
import {P256Vectors} from "./utils/P256Vectors.sol";

contract P256MockTest is MontiTest {
    /// @dev Cross-plan device-signature digest from packages/shared (02-firebase-indexer task 4).
    ///      Inputs (task-4-report.md): tokenId=7, gateId=3, eventId=11, nonce=0x11*32, issuedAt=1789862400.
    bytes32 internal constant SHARED_DEVICE_SIG_HASH =
        0xc99dfaef599235b36414480bc53054182d5f7fc67a33c60233f3f73f7fc560c7;

    function setUp() public {
        _deployMonti();
    }

    function test_mockAcceptsTheGeneratedVector() public view {
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

    function test_mockRejectsAnotherKeysSignature() public view {
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
    function test_deviceSigDigestMatchesSharedVector() public pure {
        bytes32 onChain = sha256(abi.encode(uint256(7), uint256(3), uint256(11), P256Vectors.NONCE, uint64(1789862400)));
        assertEq(onChain, SHARED_DEVICE_SIG_HASH);
    }

    /// @dev The generated GATE1_DIGEST is reproducible on-chain from the library's signing inputs,
    ///      proving script/gen-p256-vectors.mjs's sha256(abi.encode(...)) matches Solidity's.
    function test_generatedDigestIsReproducibleOnChain() public pure {
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
