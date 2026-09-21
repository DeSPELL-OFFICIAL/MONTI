// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {Test} from "forge-std/Test.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {P256} from "solady/utils/P256.sol";
import {LibString} from "solady/utils/LibString.sol";
import {IPaymaster} from "account-abstraction/interfaces/IPaymaster.sol";
import {UserOperation} from "account-abstraction/interfaces/UserOperation.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";

/// @notice Compile smoke test: every external dependency must import through its
/// remapping, so a missing remapping fails the build. (Controller ruling R2.)
contract DepsTest is Test {
    function test_dependenciesCompileAndExposeExpectedSymbols() public view {
        // OpenZeppelin 5.x: ERC721 is abstract; reference the type without deploying it.
        assertEq(type(ERC721).name, "ERC721");
        // OpenZeppelin utils used by the tokenURI builder in later tasks.
        assertEq(Strings.toString(1), "1");
        assertEq(Base64.encode(bytes("a")), "YQ==");
        // Solady utils resolve through the solady/ remapping.
        assertEq(LibString.toString(uint256(1)), "1");
        // Solady P-256: zero inputs early-return false (no precompile, no revert).
        assertEq(P256.verifySignature(bytes32(0), bytes32(0), bytes32(0), bytes32(0), bytes32(0)), false);
        // account-abstraction v0.6: UserOperation is a struct, not PackedUserOperation.
        UserOperation memory op;
        assertEq(op.nonce, 0);
        assertEq(IPaymaster.validatePaymasterUserOp.selector != bytes4(0), true);
        assertEq(IEntryPoint.getUserOpHash.selector != bytes4(0), true);
    }
}
