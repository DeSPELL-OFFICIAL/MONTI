// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {Script} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {console2} from "forge-std/console2.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {Identity} from "../src/Identity.sol";
import {Organizers} from "../src/Organizers.sol";
import {Ticket} from "../src/Ticket.sol";
import {MontiPaymaster} from "../src/MontiPaymaster.sol";
import {IIdentity} from "../src/interfaces/IIdentity.sol";
import {IOrganizers} from "../src/interfaces/IOrganizers.sol";
import {ITicket} from "../src/interfaces/ITicket.sol";

/// @title Deploy
/// @notice The one deployment of MONTI: Identity, Organizers, Ticket and MontiPaymaster, wired to each
///         other, with the paymaster staked and funded, and every address recorded in
///         `deployments/<chainid>.json` — the file sub-plans 02, 03 and 04 read their addresses from.
///
/// @dev    Order is not a preference here. Ticket's constructor needs Identity and Organizers, and
///         `Organizers.setTicket` may be called exactly once, so the Ticket must exist before Organizers
///         can be pointed at it. The paymaster comes last because it takes all three.
///
///         Nothing is configured in this script that the contracts do not already configure themselves:
///         the attester is an Identity constructor argument, and the paymaster's sponsored selectors are
///         seeded in its own constructor. What is left is the money — spec 8.4's stake, without which a
///         bundler drops every sponsored operation before it reaches the chain, and the EntryPoint
///         deposit, which is the platform gas budget MONTI pays attendees' gas out of.
///
///         Inputs come from the environment only, so no key is ever written into this repository:
///           DEPLOYER_PK       broadcast key; becomes `deployer` on Identity, Organizers and the paymaster
///           ATTESTER_ADDRESS  the attester key's address (spec 9.2); the only writer of Identity.register.
///                             MVP: raw EOA key in Secret Manager (ATTESTER_PK); KMS signing is the
///                             production path
///           ENTRY_POINT       optional, defaults to the v0.6 singleton
///           STAKE_WEI         optional, defaults to 1 MON
///           DEPOSIT_WEI       optional, defaults to 1 MON
contract Deploy is Script {
    /// @notice EntryPoint v0.6, the same address on every chain Coinbase Smart Wallet v1 supports.
    address public constant ENTRY_POINT_V06 = 0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789;

    /// @notice Spec 8.4: one day, which is what a testnet bundler policy asks of a paymaster.
    uint32 public constant UNSTAKE_DELAY_SEC = 1 days;

    uint256 public constant DEFAULT_STAKE_WEI = 1 ether;
    uint256 public constant DEFAULT_DEPOSIT_WEI = 1 ether;

    Identity public identity;
    Organizers public organizers;
    Ticket public ticket;
    MontiPaymaster public paymaster;

    /// @notice Kept alongside the contracts because `record` writes them into the same file.
    address public attester;
    address public entryPoint;

    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PK");
        uint256 stakeWei = vm.envOr("STAKE_WEI", DEFAULT_STAKE_WEI);
        uint256 depositWei = vm.envOr("DEPOSIT_WEI", DEFAULT_DEPOSIT_WEI);

        vm.startBroadcast(pk);
        deploy(vm.envAddress("ATTESTER_ADDRESS"), vm.envOr("ENTRY_POINT", ENTRY_POINT_V06), stakeWei, depositWei);
        vm.stopBroadcast();

        console2.log("identity       ", address(identity));
        console2.log("organizers     ", address(organizers));
        console2.log("ticket         ", address(ticket));
        console2.log("paymaster      ", address(paymaster));
        console2.log("entryPoint     ", entryPoint);
        console2.log("attester       ", attester);
        console2.log("stake (wei)    ", stakeWei);
        console2.log("deposit (wei)  ", depositWei);

        // A dry run simulates the whole deployment but leaves nothing on chain, so recording its
        // addresses would replace the tracked record with contracts that do not exist. Only a real
        // broadcast earns the write; the tests call `record()` themselves.
        if (vm.isContext(VmSafe.ForgeContext.ScriptBroadcast)) record();
    }

    /// @notice Deploys and wires the four contracts, then stakes and funds the paymaster.
    /// @dev    Separate from `run` so the tests can drive it without a broadcast. Every privileged role
    ///         (`Identity.deployer`, `Organizers.deployer`, `MontiPaymaster.deployer`) is whoever sends
    ///         these transactions, which under `run` is the DEPLOYER_PK account.
    function deploy(address attester_, address entryPoint_, uint256 stakeWei, uint256 depositWei) public {
        attester = attester_;
        entryPoint = entryPoint_;

        identity = new Identity(attester_);
        organizers = new Organizers();
        ticket = new Ticket(address(identity), address(organizers));
        // Once-only by design (Organizers.TicketAlreadySet): the Organizers above is brand new, so this
        // is the single call that will ever succeed on it.
        organizers.setTicket(address(ticket));

        paymaster = new MontiPaymaster(
            IEntryPoint(entryPoint_),
            IOrganizers(address(organizers)),
            ITicket(address(ticket)),
            IIdentity(address(identity))
        );

        // Stake buys the bundler's acceptance (ERC-7562: only a staked entity may read other contracts'
        // storage during validation). Deposit is the gas itself. They are not interchangeable.
        paymaster.addStake{value: stakeWei}(UNSTAKE_DELAY_SEC);
        paymaster.depositPlatform{value: depositWei}();
    }

    /// @notice Records the deployment where sub-plans 02, 03 and 04 look for it.
    /// @dev    Task 31's `DeployCoinbaseFactory` writes `coinbaseFactory` into this same file, so an
    ///         existing value is read back and carried over instead of being overwritten with a zero.
    ///         Public, and called by `run` only under a broadcast, so the tests can write the file on
    ///         their own chain id without a dry run ever reaching the tracked one.
    function record() public {
        string memory path = string.concat("deployments/", vm.toString(block.chainid), ".json");

        address coinbaseFactory;
        if (vm.exists(path)) {
            string memory existing = vm.readFile(path);
            if (vm.keyExistsJson(existing, ".coinbaseFactory")) {
                coinbaseFactory = vm.parseJsonAddress(existing, ".coinbaseFactory");
            }
        }

        string memory obj = "monti";
        vm.serializeUint(obj, "chainId", block.chainid);
        vm.serializeAddress(obj, "identity", address(identity));
        vm.serializeAddress(obj, "organizers", address(organizers));
        vm.serializeAddress(obj, "ticket", address(ticket));
        vm.serializeAddress(obj, "paymaster", address(paymaster));
        vm.serializeAddress(obj, "attester", attester);
        vm.serializeAddress(obj, "coinbaseFactory", coinbaseFactory);
        vm.serializeAddress(obj, "entryPoint", entryPoint);
        string memory out = vm.serializeUint(obj, "block", block.number);

        vm.writeJson(out, path);
        console2.log("wrote", path);
    }
}
