// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {Identity} from "../src/Identity.sol";
import {Organizers} from "../src/Organizers.sol";
import {Ticket} from "../src/Ticket.sol";
import {MontiForwarder} from "../src/MontiForwarder.sol";
import {SettlementVault} from "../src/SettlementVault.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

/// @title Verify
/// @notice Read-only wiring check of a recorded v2 deployment (plan O3 step 4). Reads
///         `deployments/<chainid>.json`, performs every wiring read against the live chain, prints one
///         `OK`/`FAIL` line per check and reverts if any check failed. Sends no transaction.
///
///         forge script script/Verify.s.sol --rpc-url $RPC
///
///         Env: TREASURY_ADDRESS (required, the expected vault depositor); DEPLOYER_ADDRESS (optional,
///         the expected vault owner / contract deployer — when unset, the vault owner is only required to
///         equal Ticket.deployer()).
contract Verify is Script {
    uint256 internal failures;

    function run() external {
        string memory path = string.concat("deployments/", vm.toString(block.chainid), ".json");
        verify(path, vm.envAddress("TREASURY_ADDRESS"), vm.envOr("DEPLOYER_ADDRESS", address(0)));
    }

    /// @notice Runs every check against the deployment recorded at `path`. Public so the tests can drive it.
    function verify(string memory path, address treasury, address expectedOwner) public returns (uint256) {
        failures = 0;
        string memory raw = vm.readFile(path);
        Identity identity = Identity(vm.parseJsonAddress(raw, ".identity"));
        MontiForwarder forwarder = MontiForwarder(vm.parseJsonAddress(raw, ".forwarder"));
        Organizers organizers = Organizers(vm.parseJsonAddress(raw, ".organizers"));
        Ticket ticket = Ticket(vm.parseJsonAddress(raw, ".ticket"));
        SettlementVault vault = SettlementVault(vm.parseJsonAddress(raw, ".settlementVault"));
        address usdc = vm.parseJsonAddress(raw, ".usdc");
        address attester = vm.parseJsonAddress(raw, ".attester");
        address owner = expectedOwner == address(0) ? ticket.deployer() : expectedOwner;

        // The 12 wiring reads of plan O3 step 4.
        _eq("01 ticket.vault() == settlementVault", ticket.vault(), address(vault));
        _eq("02 vault.ticket() == ticket", address(vault.ticket()), address(ticket));
        _eq("03 vault.organizers() == organizers", address(vault.organizers()), address(organizers));
        _eq("04 vault.owner() == deployer", vault.owner(), owner);
        _true("05 vault.tokenAllowed(usdc)", vault.tokenAllowed(usdc));
        _true("06 vault.depositor(treasury)", vault.depositor(treasury));
        _eq("07 identity.attester() == attester", identity.attester(), attester);
        _eq("08 identity.trustedForwarder() == forwarder", identity.trustedForwarder(), address(forwarder));
        _eq("09 forwarder.ticket() == ticket", forwarder.ticket(), address(ticket));
        _eq("10 forwarder.organizers() == organizers", forwarder.organizers(), address(organizers));
        _eq("11 organizers.ticket() == ticket", organizers.ticket(), address(ticket));
        _eq("12a ticket.trustedForwarder() == forwarder", ticket.trustedForwarder(), address(forwarder));
        _eq("12b organizers.trustedForwarder() == forwarder", organizers.trustedForwarder(), address(forwarder));

        // Extra consistency reads (cheap, catch a half-wired or mixed-version record).
        _eq("x1 forwarder.identity() == identity", address(forwarder.identity()), address(identity));
        _eq("x2 ticket.identity() == identity", address(ticket.identity()), address(identity));
        _eq("x3 ticket.organizers() == organizers", address(ticket.organizers()), address(organizers));
        _eq("x4 organizers.deployer() == ticket.deployer()", organizers.deployer(), ticket.deployer());
        _true("x5 usdc.decimals() == 6", IERC20Metadata(usdc).decimals() == 6);
        _true("x6 vault not paused", !vault.paused());
        _true("x7 UNITS_PER_CENT == 1e4", vault.UNITS_PER_CENT() == 1e4);

        if (failures != 0) {
            console2.log("FAILED checks:", failures);
            revert("wiring check failed");
        }
        console2.log("all wiring checks passed");
        return failures;
    }

    function _eq(string memory name, address got, address want) internal {
        if (got == want) {
            console2.log(string.concat("OK   ", name), got);
        } else {
            failures++;
            console2.log(string.concat("FAIL ", name, " got"), got);
            console2.log("     want", want);
        }
    }

    function _true(string memory name, bool ok) internal {
        if (ok) {
            console2.log(string.concat("OK   ", name));
        } else {
            failures++;
            console2.log(string.concat("FAIL ", name));
        }
    }
}
