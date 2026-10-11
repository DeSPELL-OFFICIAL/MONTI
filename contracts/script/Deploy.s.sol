// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {Script} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {console2} from "forge-std/console2.sol";
import {Identity} from "../src/Identity.sol";
import {Organizers} from "../src/Organizers.sol";
import {Ticket} from "../src/Ticket.sol";
import {MontiForwarder} from "../src/MontiForwarder.sol";
import {SettlementVault} from "../src/SettlementVault.sol";
import {IIdentity} from "../src/interfaces/IIdentity.sol";

/// @title Deploy
/// @notice The one deployment of MONTI v2 (design 2026-10-12 §8, D8): Identity, the ERC-2771 forwarder,
///         Organizers, Ticket and SettlementVault, wired to each other, with every address recorded in
///         `deployments/<chainid>.json` — the file `packages/shared`'s `sync:deployments` copies.
///
/// @dev    Order is forced by the constructors and the once-only setters:
///
///           Identity(attester)
///           -> MontiForwarder(identity, identity.deployer())
///           -> Organizers(forwarder)
///           -> Ticket(identity, organizers, forwarder)
///           -> SettlementVault(ticket, organizers, treasury, usdc)   (owner = broadcaster; treasury = depositor;
///                                                                    usdc allowlisted, must be 6 decimals)
///           -> Identity.setForwarder(forwarder)
///           -> Forwarder.setTargets(ticket, organizers)
///           -> Organizers.setTicket(ticket)
///           -> Ticket.setVault(vault)
///
///         Inputs come from the environment only, so no key is ever written into this repository:
///           DEPLOYER_PK       broadcast key; becomes `deployer` on every contract and the vault `owner`
///           ATTESTER_ADDRESS  the attester key's address (Identity.register/setKycLevel/rotateAccount)
///           TREASURY_ADDRESS  the purchase/refund adapter EOA (vault depositor)
///           USDC_ADDRESS      the 6-decimal settlement token (Circle test USDC on 10143)
///         The RPC is a `forge script --rpc-url` flag, not read here.
contract Deploy is Script {
    Identity public identity;
    Organizers public organizers;
    Ticket public ticket;
    MontiForwarder public forwarder;
    SettlementVault public vault;

    /// @notice Kept alongside the contracts because `record` writes them into the same file.
    address public attester;
    address public usdc;

    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PK");
        address attester_ = vm.envAddress("ATTESTER_ADDRESS");
        address treasury = vm.envAddress("TREASURY_ADDRESS");
        address usdc_ = vm.envAddress("USDC_ADDRESS");

        vm.startBroadcast(pk);
        deploy(attester_, treasury, usdc_);
        vm.stopBroadcast();

        console2.log("identity       ", address(identity));
        console2.log("forwarder      ", address(forwarder));
        console2.log("organizers     ", address(organizers));
        console2.log("ticket         ", address(ticket));
        console2.log("settlementVault", address(vault));
        console2.log("usdc           ", usdc);
        console2.log("attester       ", attester);
        console2.log("treasury       ", treasury);

        record();
    }

    /// @notice Deploys and wires the five contracts.
    /// @dev    Separate from `run` so the tests can drive it without a broadcast. Every privileged role
    ///         (`deployer` on Identity/Forwarder/Organizers/Ticket, the vault `owner`) is whoever sends these
    ///         transactions, which under `run` is the DEPLOYER_PK account.
    function deploy(address attester_, address treasury, address usdc_) public {
        attester = attester_;
        usdc = usdc_;

        identity = new Identity(attester_);
        forwarder = new MontiForwarder(IIdentity(address(identity)), identity.deployer());
        organizers = new Organizers(address(forwarder));
        ticket = new Ticket(address(identity), address(organizers), address(forwarder));
        vault = new SettlementVault(address(ticket), address(organizers), treasury, usdc_);
        identity.setForwarder(address(forwarder));
        forwarder.setTargets(address(ticket), address(organizers));
        // Once-only by design (Organizers.TicketAlreadySet / Ticket.VaultAlreadySet): both contracts are
        // brand new, so these are the single calls that will ever succeed on them.
        organizers.setTicket(address(ticket));
        ticket.setVault(address(vault));
    }

    /// @notice Records the deployment where `packages/shared` (and through it the backend, web and indexer)
    ///         looks for it.
    /// @dev    A dry run simulates the whole deployment but leaves nothing on chain, so recording its
    ///         addresses would replace the tracked record with contracts that do not exist. The guard is
    ///         inside this function because `forge script --sig 'record()'` reaches it directly. The tests
    ///         reach the writing half through a harness.
    function record() public {
        if (!vm.isContext(VmSafe.ForgeContext.ScriptBroadcast)) {
            console2.log("not a broadcast: nothing was recorded");
            return;
        }
        _record(string.concat("deployments/", vm.toString(block.chainid), ".json"));
    }

    /// @dev `block` is `block.number` as the *simulation* saw it — a safe lower bound for the indexer's
    ///      `start_block` (the key is `block`, not `startBlock`; `packages/shared`'s `Deployment` spells it
    ///      that way). All five contracts share it: there is no separate `settlementVaultBlock` and no
    ///      `previous[]` in v2 (v1 addresses live in git history and the v1-final tags).
    function _record(string memory path) internal {
        string memory obj = "monti";
        vm.serializeUint(obj, "chainId", block.chainid);
        vm.serializeAddress(obj, "identity", address(identity));
        vm.serializeAddress(obj, "forwarder", address(forwarder));
        vm.serializeAddress(obj, "organizers", address(organizers));
        vm.serializeAddress(obj, "ticket", address(ticket));
        vm.serializeAddress(obj, "settlementVault", address(vault));
        vm.serializeAddress(obj, "usdc", usdc);
        vm.serializeAddress(obj, "attester", attester);
        string memory out = vm.serializeUint(obj, "block", block.number);

        vm.writeJson(out, path);
        console2.log("wrote", path);
    }
}
