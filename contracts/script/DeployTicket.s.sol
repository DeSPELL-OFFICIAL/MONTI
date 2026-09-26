// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {Script} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {console2} from "forge-std/console2.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {Ticket} from "../src/Ticket.sol";
import {MontiPaymaster} from "../src/MontiPaymaster.sol";
import {IIdentity} from "../src/interfaces/IIdentity.sol";
import {IOrganizers} from "../src/interfaces/IOrganizers.sol";
import {ITicket} from "../src/interfaces/ITicket.sol";

/// @title DeployTicket
/// @notice The 01c redeploy: a new Ticket and a new MontiPaymaster on an Identity and Organizers that
///         already exist on chain. Identity holds the attester and the registered members; Organizers
///         holds the orgs, admins and the demo gate -- neither is touched here, so no account is reset.
///
/// @dev    Why a new paymaster and not just a new Ticket: MontiPaymaster.ticket is immutable and
///         _slotOfInnerCall refuses every target that is not that Ticket (TargetNotAllowed). A Ticket
///         redeployed to a new address is unsponsored by the old paymaster, so the paymaster is
///         redeployed against the new Ticket. Its constructor re-seeds the whole 2026-09-23 allow-list;
///         the four 01c approval-mode selectors, which that constructor predates, are added afterwards
///         with setAllowed (the I7 path -- one tx, no redeploy).
///
///         Why Organizers is NOT re-pointed: Organizers.setTicket is once-only (TicketAlreadySet) and
///         already points at the retired Ticket. It does not need re-pointing -- Ticket reads Organizers
///         (hasPermission/ownerOf/isOpenGate/gateInfo/gateOf/managerOf) and none of those read
///         Organizers.ticket. Organizers reads Ticket only in registerGate/openGate/closeGate/revokeGate
///         to resolve an event's org for the gate permission check; for the reused org 1 / event 1 the
///         retired Ticket answers eventOrg(1) = 1 exactly as the new one does, so gate management for
///         event 1 is unaffected. A gate for an event that lives only on the new Ticket cannot be
///         registered through this Organizers -- out of scope for the demo, noted for the record.
///
///         Inputs from the environment only:
///           DEPLOYER_PK   broadcast key; becomes MontiPaymaster.deployer and pays stake + deposit
///           IDENTITY      the kept Identity
///           ORGANIZERS    the kept Organizers
///           ENTRY_POINT   optional, defaults to the v0.6 singleton
///           STAKE_WEI     optional, defaults to 1 MON
///           DEPOSIT_WEI   optional, defaults to 1 MON
contract DeployTicket is Script {
    address public constant ENTRY_POINT_V06 = 0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789;
    uint32 public constant UNSTAKE_DELAY_SEC = 1 days;
    uint256 public constant DEFAULT_STAKE_WEI = 1 ether;
    uint256 public constant DEFAULT_DEPOSIT_WEI = 1 ether;

    Ticket public ticket;
    MontiPaymaster public paymaster;

    address public identity;
    address public organizers;
    address public entryPoint;

    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PK");
        uint256 stakeWei = vm.envOr("STAKE_WEI", DEFAULT_STAKE_WEI);
        uint256 depositWei = vm.envOr("DEPOSIT_WEI", DEFAULT_DEPOSIT_WEI);

        vm.startBroadcast(pk);
        deploy(
            vm.envAddress("IDENTITY"),
            vm.envAddress("ORGANIZERS"),
            vm.envOr("ENTRY_POINT", ENTRY_POINT_V06),
            stakeWei,
            depositWei
        );
        vm.stopBroadcast();

        console2.log("identity      ", identity);
        console2.log("organizers    ", organizers);
        console2.log("ticket        ", address(ticket));
        console2.log("paymaster     ", address(paymaster));
        console2.log("entryPoint    ", entryPoint);
        console2.log("stake (wei)   ", stakeWei);
        console2.log("deposit (wei) ", depositWei);

        record();
    }

    /// @notice Deploys the new Ticket and paymaster on the given Identity/Organizers, stakes and funds
    ///         the paymaster, and installs the four 01c selectors. Separate from run so the test drives
    ///         it without a broadcast.
    function deploy(address identity_, address organizers_, address entryPoint_, uint256 stakeWei, uint256 depositWei)
        public
    {
        identity = identity_;
        organizers = organizers_;
        entryPoint = entryPoint_;

        ticket = new Ticket(identity_, organizers_);
        paymaster = new MontiPaymaster(
            IEntryPoint(entryPoint_), IOrganizers(organizers_), ITicket(address(ticket)), IIdentity(identity_)
        );

        paymaster.addStake{value: stakeWei}(UNSTAKE_DELAY_SEC);
        paymaster.depositPlatform{value: depositWei}();

        installApprovalSelectors(paymaster);
    }

    /// @notice The four 01c approval-mode selectors, each billed to the event named by its first word.
    /// @dev    All ArgKind.EventId, word 0: eventId is the first argument of every one, so even where a
    ///         dynamic array follows (approve/rejectClaims) the paymaster reads only the head word. The
    ///         constructor already seeded the 2026-09-23 list, so this adds only the four new rows.
    function installApprovalSelectors(MontiPaymaster paymaster_) public {
        paymaster_.setAllowed(Ticket.requestClaim.selector, MontiPaymaster.ArgKind.EventId, 0);
        paymaster_.setAllowed(Ticket.approveClaims.selector, MontiPaymaster.ArgKind.EventId, 0);
        paymaster_.setAllowed(Ticket.rejectClaims.selector, MontiPaymaster.ArgKind.EventId, 0);
        paymaster_.setAllowed(Ticket.cancelRequest.selector, MontiPaymaster.ArgKind.EventId, 0);
    }

    function record() public {
        if (!vm.isContext(VmSafe.ForgeContext.ScriptBroadcast)) {
            console2.log("not a broadcast: nothing was recorded");
            return;
        }
        _record(string.concat("deployments/", vm.toString(block.chainid), ".json"));
    }

    /// @dev Keeps identity/organizers/entryPoint/coinbaseFactory/attester from the existing file and
    ///      updates ticket/paymaster/block. The retired ticket/paymaster/block are appended as a single
    ///      `previous` entry for the record; a re-run replaces that entry.
    function _record(string memory path) internal {
        string memory existing = vm.readFile(path);
        address prevTicket = vm.parseJsonAddress(existing, ".ticket");
        address prevPaymaster = vm.parseJsonAddress(existing, ".paymaster");
        uint256 prevBlock = vm.parseJsonUint(existing, ".block");
        address coinbaseFactory = vm.parseJsonAddress(existing, ".coinbaseFactory");
        address attester = vm.parseJsonAddress(existing, ".attester");

        string memory obj = "monti";
        vm.serializeUint(obj, "chainId", block.chainid);
        vm.serializeAddress(obj, "identity", identity);
        vm.serializeAddress(obj, "organizers", organizers);
        vm.serializeAddress(obj, "ticket", address(ticket));
        vm.serializeAddress(obj, "paymaster", address(paymaster));
        vm.serializeAddress(obj, "attester", attester);
        vm.serializeAddress(obj, "coinbaseFactory", coinbaseFactory);
        vm.serializeAddress(obj, "entryPoint", entryPoint);
        string memory out = vm.serializeUint(obj, "block", block.number);
        vm.writeJson(out, path);

        string memory prev = string.concat(
            "[{\"ticket\":\"",
            vm.toString(prevTicket),
            "\",\"paymaster\":\"",
            vm.toString(prevPaymaster),
            "\",\"block\":",
            vm.toString(prevBlock),
            "}]"
        );
        vm.writeJson(prev, path, ".previous");

        console2.log("wrote", path);
    }
}
