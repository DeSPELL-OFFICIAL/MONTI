// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {Script} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {console2} from "forge-std/console2.sol";
import {SettlementVault} from "../src/SettlementVault.sol";

/// @title DeploySettlement
/// @notice Deploys the programmable-settlement layer (plan 2026-10-01 §A3). The core four
///         (Identity/Organizers/Ticket/MontiForwarder) are **not** redeployed — this reads their existing
///         addresses from `deployments/<chainid>.json` (the 09-30 redeploy) and deploys one new
///         `SettlementVault` pointed at them, with the treasury adapter allowlisted to deposit and the
///         token (Circle test USDC) allowlisted. It then adds two keys, `settlementVault` and `usdc`, to
///         the same JSON **in place** — the core-4 addresses and the `previous[]` history are untouched
///         (there is no core redeploy, so `previous[]` is irrelevant here).
///
/// @dev    Inputs from the environment only (no key in the repo):
///           DEPLOYER_PK       broadcast key; becomes the vault `owner` (pause + allowlists)
///           TREASURY_ADDRESS  the deposit adapter (MONTI treasury / PG), allowlisted as depositor
///           USDC_ADDRESS      the token to allowlist (default: Circle test USDC on Monad testnet 10143
///                             0x534b2f3A21130d7a60830c2Df862319e593943A3, 6 decimals)
///         Core-4 addresses come from `deployments/<chainid>.json`; the RPC is a `--rpc-url` flag.
///         The vault constructor makes no external calls, so a dry run succeeds even on a fresh local EVM
///         where those addresses hold no code. Only a real `--broadcast` writes the JSON keys.
contract DeploySettlement is Script {
    address internal constant CIRCLE_USDC_10143 = 0x534b2f3A21130d7a60830c2Df862319e593943A3;

    SettlementVault public vault;
    address public usdc;
    address public treasury;
    address public ticketAddr;
    address public organizersAddr;
    address public identityAddr;

    function run() external {
        string memory path = string.concat("deployments/", vm.toString(block.chainid), ".json");
        string memory json = vm.readFile(path);
        ticketAddr = vm.parseJsonAddress(json, ".ticket");
        organizersAddr = vm.parseJsonAddress(json, ".organizers");
        identityAddr = vm.parseJsonAddress(json, ".identity");

        treasury = vm.envOr("TREASURY_ADDRESS", address(0));
        usdc = vm.envOr("USDC_ADDRESS", CIRCLE_USDC_10143);

        uint256 pk = vm.envUint("DEPLOYER_PK");
        vm.startBroadcast(pk);
        vault = new SettlementVault(ticketAddr, organizersAddr, identityAddr, treasury, usdc);
        vm.stopBroadcast();

        console2.log("settlementVault", address(vault));
        console2.log("usdc           ", usdc);
        console2.log("treasury       ", treasury);
        console2.log("ticket (kept)  ", ticketAddr);

        record(path);
    }

    /// @notice Adds `settlementVault` and `usdc` to the deployment JSON in place (keys only; the rest of
    ///         the file is left byte-identical). A dry run leaves nothing on chain, so it records nothing.
    function record(string memory path) public {
        if (!vm.isContext(VmSafe.ForgeContext.ScriptBroadcast)) {
            console2.log("not a broadcast: nothing was recorded");
            return;
        }
        vm.writeJson(vm.toString(address(vault)), path, ".settlementVault");
        vm.writeJson(vm.toString(usdc), path, ".usdc");
        console2.log("added settlementVault + usdc to", path);
    }
}
