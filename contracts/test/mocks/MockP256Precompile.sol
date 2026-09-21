// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {P256Vectors} from "../utils/P256Vectors.sol";

/// @notice Etched at 0x100 so the local EVM answers the EIP-7951 precompile the way Monad does.
///         It returns 1 only for the generated vectors, so "wrong device key" really fails.
///         The gas test (CheckInGas.t.sol) does NOT use this — it forks Monad testnet for the real
///         6,900-gas precompile, because a mock cannot tell us anything true about gas.
contract MockP256Precompile {
    fallback(bytes calldata input) external returns (bytes memory) {
        if (input.length != 160) return abi.encode(uint256(0));
        (bytes32 h, bytes32 r, bytes32 s, bytes32 x, bytes32 y) =
            abi.decode(input, (bytes32, bytes32, bytes32, bytes32, bytes32));

        bool ok;
        if (x == P256Vectors.DEVICE_X && y == P256Vectors.DEVICE_Y) {
            ok = (h == P256Vectors.GATE1_DIGEST && r == P256Vectors.GATE1_R && s == P256Vectors.GATE1_S)
                || (h == P256Vectors.GATE2_DIGEST && r == P256Vectors.GATE2_R && s == P256Vectors.GATE2_S);
        } else if (x == P256Vectors.OTHER_X && y == P256Vectors.OTHER_Y) {
            ok = (h == P256Vectors.GATE1_DIGEST && r == P256Vectors.OTHER_R && s == P256Vectors.OTHER_S);
        }
        return abi.encode(ok ? uint256(1) : uint256(0));
    }
}
