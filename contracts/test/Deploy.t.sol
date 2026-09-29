// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {Test} from "forge-std/Test.sol";
import {Deploy} from "../script/Deploy.s.sol";
import {Identity} from "../src/Identity.sol";
import {Organizers} from "../src/Organizers.sol";
import {Ticket} from "../src/Ticket.sol";
import {MontiForwarder} from "../src/MontiForwarder.sol";

/// @notice The deploy script, plus the one recording entry point the tests need and the script must not
///         have.
/// @dev    `record()` writes only under a broadcast, and `forge test` is not one. This is how the tests
///         reach the writing half without giving the script itself a public entry point that could be
///         pointed at the tracked deployments/10143.json. Seed.t.sol drives the same harness.
contract DeployHarness is Deploy {
    function recordAt(string memory path) external {
        _record(path);
    }
}

/// @notice Runs the real deploy script in process. What is proved here is what the founder cannot afford
///         to discover on chain: the four contracts point at each other and at the forwarder, and the
///         deployments file that sub-plans 02, 03 and 04 read carries every key they look up.
/// @dev    Forge runs the test functions of one contract in parallel, so exactly one of them touches the
///         filesystem. The rest call `deploy` directly, which is the same code path without the broadcast
///         and the file write. The path written is `deployments/31337.json` (the local chain id), never
///         the committed `10143.json`; it is gitignored.
contract DeployTest is Test {
    DeployHarness internal deployScript;

    uint256 internal constant PK = 0xD3910;
    address internal deployer;

    address internal constant ATTESTER = 0x000000000000000000000000000000000000a11c;

    string internal constant PATH = "deployments/31337.json";

    /// @dev The keys sub-plans 02, 03 and 04 read out of deployments/<chainid>.json, in the order
    ///      `vm.parseJsonKeys` returns them (alphabetical).
    string[7] internal RECORDED_KEYS =
        ["attester", "block", "chainId", "forwarder", "identity", "organizers", "ticket"];

    function setUp() public {
        // Pin the chain id: on a forked run `block.chainid` would be Monad's, and `run()` would write
        // the tracked deployments/10143.json instead of the gitignored local one.
        vm.chainId(31337);

        deployScript = new DeployHarness();
        deployer = vm.addr(PK);

        // A broadcast inside `forge test` only re-labels the sender.
        vm.deal(deployer, 100 ether);

        vm.setEnv("DEPLOYER_PK", vm.toString(PK));
        vm.setEnv("ATTESTER_ADDRESS", vm.toString(ATTESTER));
    }

    function test_deployWiresEveryContractTogether() public {
        _deploy();

        Identity identity = deployScript.identity();
        Organizers organizers = deployScript.organizers();
        Ticket ticket = deployScript.ticket();
        MontiForwarder forwarder = deployScript.forwarder();

        assertEq(identity.attester(), ATTESTER, "attester");
        assertEq(organizers.ticket(), address(ticket), "organizers.ticket");
        assertEq(address(ticket.identity()), address(identity), "ticket.identity");
        assertEq(address(ticket.organizers()), address(organizers), "ticket.organizers");

        // The forwarder reads Identity and relays to the two allowlisted targets; each of the three
        // contracts trusts it as its ERC-2771 forwarder.
        assertEq(address(forwarder.identity()), address(identity), "forwarder.identity");
        assertEq(forwarder.ticket(), address(ticket), "forwarder target: ticket");
        assertEq(forwarder.organizers(), address(organizers), "forwarder target: organizers");
        assertEq(identity.trustedForwarder(), address(forwarder), "identity trusts the forwarder");
        assertEq(ticket.trustedForwarder(), address(forwarder), "ticket trusts the forwarder");
        assertEq(organizers.trustedForwarder(), address(forwarder), "organizers trusts the forwarder");
    }

    /// @notice `Organizers.setTicket` may be called once and never again, so the script has to hand it a
    ///         freshly deployed Organizers every time. Re-running the script must not revert on the
    ///         organizers it wired last time.
    function test_deployIsRepeatableBecauseEachRunGetsItsOwnOrganizers() public {
        _deploy();
        Organizers first = deployScript.organizers();

        _deploy();
        Organizers second = deployScript.organizers();

        assertTrue(address(first) != address(second), "a second run gets its own Organizers");
        assertEq(second.ticket(), address(deployScript.ticket()), "and wires it to the new Ticket");
        vm.prank(second.deployer());
        vm.expectRevert(Organizers.TicketAlreadySet.selector);
        second.setTicket(address(0xBEEF));
    }

    /// @notice The whole of `run`: the environment is read, the broadcasting key ends up holding every
    ///         privileged role, and the deployments file carries every key sub-plans 02, 03 and 04 read.
    function test_runRecordsEverythingTheOtherSubPlansRead() public {
        if (vm.exists(PATH)) vm.removeFile(PATH);

        deployScript.run();

        // `run` records only under `--broadcast`, and neither `forge test` nor a dry run is that.
        // Without this gate a `forge script --rpc-url <monad>` rehearsal would overwrite the tracked
        // deployments/10143.json with addresses that were never deployed.
        assertFalse(vm.exists(PATH), "a run that is not a broadcast records nothing");

        // The guard lives inside `record` itself, so the signature a founder can reach directly --
        // `forge script --sig 'record()'` -- writes nothing either.
        deployScript.record();
        assertFalse(vm.exists(PATH), "nor does record() called on its own");
        deployScript.recordAt(PATH);

        // Privileged roles must land on the broadcasting key, not on the script contract — otherwise
        // nobody can rotate the attester after the deploy.
        assertEq(deployScript.identity().deployer(), deployer, "identity.deployer");
        assertEq(deployScript.forwarder().deployer(), deployer, "forwarder.deployer");
        assertEq(deployScript.organizers().deployer(), deployer, "organizers.deployer");

        string memory raw = vm.readFile(PATH);

        // Sub-plan 02's indexer config generator turns one of these keys into `start_block`, and it
        // reads it as `block` -- `packages/shared`'s `Deployment` interface has no `startBlock` and the
        // plan pins the names letter for letter. Pinning the whole set is what catches a key that is
        // added, dropped or renamed here and then read as `undefined` three repositories away.
        string[] memory keys = vm.parseJsonKeys(raw, "$");
        assertEq(keys.length, RECORDED_KEYS.length, "a key was added or dropped");
        for (uint256 i; i < keys.length; ++i) {
            assertEq(keys[i], RECORDED_KEYS[i], "recorded key");
        }

        assertEq(vm.parseJsonUint(raw, ".chainId"), block.chainid, "chainId");
        assertEq(vm.parseJsonAddress(raw, ".identity"), address(deployScript.identity()), "identity");
        assertEq(vm.parseJsonAddress(raw, ".forwarder"), address(deployScript.forwarder()), "forwarder");
        assertEq(vm.parseJsonAddress(raw, ".organizers"), address(deployScript.organizers()), "organizers");
        assertEq(vm.parseJsonAddress(raw, ".ticket"), address(deployScript.ticket()), "ticket");
        assertEq(vm.parseJsonAddress(raw, ".attester"), ATTESTER, "attester");
        assertEq(vm.parseJsonUint(raw, ".block"), block.number, "block");
    }

    function _deploy() private {
        deployScript.deploy(ATTESTER);
    }
}
