// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {Test} from "forge-std/Test.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {ERC2771Context} from "@openzeppelin/contracts/metatx/ERC2771Context.sol";
import {P256} from "solady/utils/P256.sol";
import {LibString} from "solady/utils/LibString.sol";

/// @notice Compile smoke test: every external dependency must import through its
/// remapping, so a missing remapping fails the build. (Controller ruling R2.)
contract DepsTest is Test {
    function test_dependenciesCompileAndExposeExpectedSymbols() public view {
        // OpenZeppelin 5.x: ERC721 is abstract; reference the type without deploying it.
        assertEq(type(ERC721).name, "ERC721");
        // OpenZeppelin utils used by the tokenURI builder.
        assertEq(Strings.toString(1), "1");
        assertEq(Base64.encode(bytes("a")), "YQ==");
        // ERC-2771: the meta-tx mixin Ticket/Organizers inherit and Identity mirrors resolves through the
        // OpenZeppelin remapping (design section 2, the forwarder wiring).
        assertEq(type(ERC2771Context).name, "ERC2771Context");
        // Solady utils resolve through the solady/ remapping.
        assertEq(LibString.toString(uint256(1)), "1");
        // Solady P-256: zero inputs early-return false (no precompile, no revert).
        assertEq(P256.verifySignature(bytes32(0), bytes32(0), bytes32(0), bytes32(0), bytes32(0)), false);
    }
}
