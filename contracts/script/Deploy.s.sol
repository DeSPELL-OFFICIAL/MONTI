// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {Script} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {console2} from "forge-std/console2.sol";
import {Identity} from "../src/Identity.sol";
import {Organizers} from "../src/Organizers.sol";
import {Ticket} from "../src/Ticket.sol";
import {MontiForwarder} from "../src/MontiForwarder.sol";
import {IIdentity} from "../src/interfaces/IIdentity.sol";

/// @title Deploy
/// @notice The one deployment of MONTI: Identity, the ERC-2771 forwarder, Organizers and Ticket, wired to
///         each other, with every address recorded in `deployments/<chainid>.json` — the file sub-plans
///         02, 03 and 04 read their addresses from.
///
/// @dev    Order is not a preference here (design 2026-09-29 relayed phase 2, section 8). The forwarder
///         reads Identity, so Identity is deployed first and learns the forwarder through a one-shot
///         `setForwarder` rather than a constructor immutable. Organizers and Ticket take the forwarder as
///         a constructor immutable, so they come after it. `Forwarder.setTargets` and
///         `Organizers.setTicket` are each once-only and need their targets to exist, so they come last:
///
///           Identity
///           -> Forwarder(identity, identity.deployer())
///           -> Organizers(forwarder)
///           -> Ticket(identity, organizers, forwarder)
///           -> Identity.setForwarder(forwarder)
///           -> Forwarder.setTargets(ticket, organizers)
///           -> Organizers.setTicket(ticket)
///
///         The ERC-4337 sponsorship layer is gone (design section 3): claims and organizer actions now
///         travel through the forwarder as ordinary relayer transactions, so there is no stake, no gas
///         deposit and no bundler to satisfy. Nothing here needs configuring beyond the wiring above —
///         the attester is an Identity constructor argument.
///
///         Inputs come from the environment only, so no key is ever written into this repository:
///           DEPLOYER_PK       broadcast key; becomes `deployer` on Identity, the forwarder and Organizers
///           ATTESTER_ADDRESS  the attester key's address (spec 9.2); the only writer of Identity.register.
///                             MVP: raw EOA key in Secret Manager (ATTESTER_PK); KMS signing is the
///                             production path
///         The RPC is a `forge script --rpc-url` flag, not read here.
contract Deploy is Script {
    Identity public identity;
    Organizers public organizers;
    Ticket public ticket;
    MontiForwarder public forwarder;

    /// @notice Kept alongside the contracts because `record` writes it into the same file.
    address public attester;

    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PK");

        vm.startBroadcast(pk);
        deploy(vm.envAddress("ATTESTER_ADDRESS"));
        vm.stopBroadcast();

        console2.log("identity       ", address(identity));
        console2.log("forwarder      ", address(forwarder));
        console2.log("organizers     ", address(organizers));
        console2.log("ticket         ", address(ticket));
        console2.log("attester       ", attester);

        record();
    }

    /// @notice Deploys and wires the four contracts.
    /// @dev    Separate from `run` so the tests can drive it without a broadcast. Every privileged role
    ///         (`Identity.deployer`, `MontiForwarder.deployer`, `Organizers.deployer`) is whoever sends
    ///         these transactions, which under `run` is the DEPLOYER_PK account. `identity.deployer()` is
    ///         passed as the forwarder's `deployer_` so the same sender that created the stack can call
    ///         `setTargets` below under both a broadcast and a direct test call.
    function deploy(address attester_) public {
        attester = attester_;

        identity = new Identity(attester_);
        forwarder = new MontiForwarder(IIdentity(address(identity)), identity.deployer());
        organizers = new Organizers(address(forwarder));
        ticket = new Ticket(address(identity), address(organizers), address(forwarder));
        identity.setForwarder(address(forwarder));
        forwarder.setTargets(address(ticket), address(organizers));
        // Once-only by design (Organizers.TicketAlreadySet): the Organizers above is brand new, so this
        // is the single call that will ever succeed on it.
        organizers.setTicket(address(ticket));
    }

    /// @notice Records the deployment where sub-plans 02, 03 and 04 look for it.
    /// @dev    A dry run simulates the whole deployment but leaves nothing on chain, so recording its
    ///         addresses would replace the tracked record with contracts that do not exist. The guard
    ///         is inside this function rather than at its call site because
    ///         `forge script --sig 'record()'` reaches it directly -- the same hazard the Seed's
    ///         `record` already guards against. Only a real broadcast earns the write; the tests reach
    ///         the writing half through a harness, so no public entry point can be pointed at an
    ///         arbitrary path.
    function record() public {
        if (!vm.isContext(VmSafe.ForgeContext.ScriptBroadcast)) {
            console2.log("not a broadcast: nothing was recorded");
            return;
        }
        _record(string.concat("deployments/", vm.toString(block.chainid), ".json"));
    }

    /// @dev `block` is `block.number` as the *simulation* saw it, which under `--broadcast` is the latest
    ///      block at simulation time, a few blocks before the transactions land. Indexers should treat it
    ///      as a safe lower bound to start from, not as the deployment block; the exact number is in the
    ///      broadcast receipt if anyone needs it. **This is the key sub-plan 02's config generator turns
    ///      into the indexer's `start_block`** -- it is named `block`, not `startBlock`, and
    ///      `packages/shared`'s `Deployment` interface spells it that way too. Renaming it silently
    ///      restarts the indexer from block 0.
    function _record(string memory path) internal {
        string memory obj = "monti";
        vm.serializeUint(obj, "chainId", block.chainid);
        vm.serializeAddress(obj, "identity", address(identity));
        vm.serializeAddress(obj, "forwarder", address(forwarder));
        vm.serializeAddress(obj, "organizers", address(organizers));
        vm.serializeAddress(obj, "ticket", address(ticket));
        vm.serializeAddress(obj, "attester", attester);
        string memory out = vm.serializeUint(obj, "block", block.number);

        vm.writeJson(out, path);
        console2.log("wrote", path);
    }
}
