// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {Test} from "forge-std/Test.sol";
import {EntryPoint} from "account-abstraction/core/EntryPoint.sol";
import {IStakeManager} from "account-abstraction/interfaces/IStakeManager.sol";
import {Deploy} from "../script/Deploy.s.sol";
import {Identity} from "../src/Identity.sol";
import {Organizers} from "../src/Organizers.sol";
import {Ticket} from "../src/Ticket.sol";
import {MontiPaymaster} from "../src/MontiPaymaster.sol";

/// @notice The deploy script, plus the one entry point the tests need and the script must not have.
/// @dev    `record()` writes only under a broadcast, and `forge test` is not one. This is how the tests
///         reach the writing half without giving the script itself a public entry point that could be
///         pointed at the tracked deployments/10143.json. Seed.t.sol drives the same harness.
contract DeployHarness is Deploy {
    function recordAt(string memory path) external {
        _record(path);
    }
}

/// @notice Runs the real deploy script against the real EntryPoint v0.6, in process. What is proved here
///         is what the founder cannot afford to discover on chain: the four contracts point at each other,
///         the paymaster is staked and funded before anything is sponsored, and the deployments file that
///         sub-plans 02, 03 and 04 read carries every key they look up — Task 31's `coinbaseFactory`
///         included, which this script must carry over rather than erase.
/// @dev    Forge runs the test functions of one contract in parallel, so exactly one of them touches the
///         filesystem. The rest call `deploy` directly, which is the same code path without the broadcast
///         and the file write. The path written is `deployments/31337.json` (the local chain id), never
///         the committed `10143.json`; it is gitignored.
contract DeployTest is Test {
    EntryPoint internal entryPoint;
    DeployHarness internal deployScript;

    uint256 internal constant PK = 0xD3910;
    address internal deployer;

    address internal constant ATTESTER = 0x000000000000000000000000000000000000a11c;
    /// @dev Stands in for what Task 31's script writes into the same file after this one has run.
    address internal constant FACTORY = 0x00000000000000000000000000000000000fAc70;

    /// @dev Deliberately not the script's defaults, so the assertions below prove the env is read.
    uint256 internal constant STAKE = 1.5 ether;
    uint256 internal constant DEPOSIT = 2.5 ether;

    string internal constant PATH = "deployments/31337.json";

    bytes4 internal constant CHECK_IN = bytes4(keccak256("checkIn(uint256,(uint256,uint256,uint64,bytes32),bytes)"));
    bytes4 internal constant CHECK_IN_LATE =
        bytes4(keccak256("checkInLate(uint256,(uint256,uint256,uint64,bytes32),bytes)"));

    /// @dev The keys sub-plans 02, 03 and 04 read out of deployments/<chainid>.json, in the order
    ///      `vm.writeJson` emits them.
    string[9] internal RECORDED_KEYS = [
        "attester", "block", "chainId", "coinbaseFactory", "entryPoint", "identity", "organizers", "paymaster", "ticket"
    ];

    function setUp() public {
        // Pin the chain id: on a forked run `block.chainid` would be Monad's, and `run()` would write
        // the tracked deployments/10143.json instead of the gitignored local one.
        vm.chainId(31337);

        entryPoint = new EntryPoint();
        deployScript = new DeployHarness();
        deployer = vm.addr(PK);

        // A broadcast inside `forge test` only re-labels the sender; the value still leaves the script.
        vm.deal(deployer, 100 ether);
        vm.deal(address(deployScript), 100 ether);

        vm.setEnv("DEPLOYER_PK", vm.toString(PK));
        vm.setEnv("ATTESTER_ADDRESS", vm.toString(ATTESTER));
        vm.setEnv("ENTRY_POINT", vm.toString(address(entryPoint)));
        vm.setEnv("STAKE_WEI", vm.toString(STAKE));
        vm.setEnv("DEPOSIT_WEI", vm.toString(DEPOSIT));
    }

    function test_deployWiresEveryContractTogether() public {
        _deploy();

        Identity identity = deployScript.identity();
        Organizers organizers = deployScript.organizers();
        Ticket ticket = deployScript.ticket();
        MontiPaymaster paymaster = deployScript.paymaster();

        assertEq(identity.attester(), ATTESTER, "attester");
        assertEq(organizers.ticket(), address(ticket), "organizers.ticket");
        assertEq(address(ticket.identity()), address(identity), "ticket.identity");
        assertEq(address(ticket.organizers()), address(organizers), "ticket.organizers");
        assertEq(address(paymaster.entryPoint()), address(entryPoint), "paymaster.entryPoint");
        assertEq(address(paymaster.ticket()), address(ticket), "paymaster.ticket");
        assertEq(address(paymaster.identity()), address(identity), "paymaster.identity");
        assertEq(address(paymaster.organizers()), address(organizers), "paymaster.organizers");
        assertTrue(paymaster.allowedSelector(CHECK_IN), "checkIn is sponsored");
        // One selector proves the constructor ran; a second one over a different ArgKind proves the
        // whole table was seeded rather than its first few rows.
        assertEq(uint8(paymaster.argKindOf(CHECK_IN)), uint8(MontiPaymaster.ArgKind.TokenId), "checkIn kind");
        assertTrue(paymaster.allowedSelector(Organizers.openGate.selector), "openGate is sponsored");
        assertEq(
            uint8(paymaster.argKindOf(Organizers.openGate.selector)),
            uint8(MontiPaymaster.ArgKind.Platform),
            "openGate kind"
        );

        // The six rows Task 11 added (I4). A constructor that seeded an older table would still pass
        // the two assertions above, so each of them is named here with the slot it bills.
        _assertSponsored(paymaster, CHECK_IN_LATE, MontiPaymaster.ArgKind.TokenId, "checkInLate");
        _assertSponsored(paymaster, Ticket.revoke.selector, MontiPaymaster.ArgKind.TokenId, "revoke");
        _assertSponsored(paymaster, Organizers.revokeGate.selector, MontiPaymaster.ArgKind.Platform, "revokeGate");
        _assertSponsored(
            paymaster, Organizers.createOrganizer.selector, MontiPaymaster.ArgKind.Platform, "createOrganizer"
        );
        _assertSponsored(paymaster, Organizers.transferOwner.selector, MontiPaymaster.ArgKind.OrgId, "transferOwner");
        // C3's undo has to work from an account with a zero balance, which is the whole point of it.
        _assertSponsored(paymaster, Identity.cancelRotation.selector, MontiPaymaster.ArgKind.Platform, "cancelRotation");
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

    /// @notice Spec 8.4: an unstaked paymaster has its operations dropped by the bundler before they ever
    ///         reach the chain, so the deploy is not finished until the stake and the deposit are in.
    function test_deployStakesAndFundsThePaymaster() public {
        _deploy();

        MontiPaymaster paymaster = deployScript.paymaster();
        IStakeManager.DepositInfo memory info = entryPoint.getDepositInfo(address(paymaster));

        assertEq(info.stake, STAKE, "stake");
        assertTrue(info.staked, "staked");
        assertEq(info.unstakeDelaySec, deployScript.UNSTAKE_DELAY_SEC(), "unstake delay");
        assertGt(info.unstakeDelaySec, 0, "a zero delay is not a stake");
        assertEq(info.deposit, DEPOSIT, "deposit");
        assertEq(paymaster.budgetOf(paymaster.PLATFORM()), DEPOSIT, "platform budget");
        assertEq(address(paymaster).balance, 0, "everything went to the EntryPoint");
    }

    /// @notice The whole of `run`: the environment is read, the broadcasting key ends up holding every
    ///         privileged role, and the deployments file carries every key sub-plans 02, 03 and 04 read.
    function test_runRecordsEverythingTheOtherSubPlansRead() public {
        if (vm.exists(PATH)) vm.removeFile(PATH);

        uint256 deployerBefore = deployer.balance;
        deployScript.run();

        // The stake and the deposit leave the broadcasting key, not the script contract. On chain that
        // is the whole funding requirement: a deployer holding less than STAKE + DEPOSIT + gas reverts
        // inside `addStake`, which is exactly how the first testnet rehearsal failed.
        assertEq(deployerBefore - deployer.balance, STAKE + DEPOSIT, "the deployer funds stake and deposit");

        // `run` records only under `--broadcast`, and neither `forge test` nor a dry run is that.
        // Without this gate a `forge script --rpc-url <monad>` rehearsal would overwrite the tracked
        // deployments/10143.json with addresses that were never deployed.
        assertFalse(vm.exists(PATH), "a run that is not a broadcast records nothing");

        // The guard lives inside `record` itself, so the signature a founder can reach directly --
        // `forge script --sig 'record()'` -- writes nothing either. Unguarded, that dry run would put
        // the zero addresses of a script that deployed nothing into the tracked 10143.json.
        deployScript.record();
        assertFalse(vm.exists(PATH), "nor does record() called on its own");
        deployScript.recordAt(PATH);

        // Privileged roles must land on the broadcasting key, not on the script contract — otherwise
        // nobody can rotate the attester or top the paymaster up after the deploy.
        assertEq(deployScript.identity().deployer(), deployer, "identity.deployer");
        assertEq(deployScript.organizers().deployer(), deployer, "organizers.deployer");
        assertEq(deployScript.paymaster().deployer(), deployer, "paymaster.deployer");

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
        assertEq(vm.parseJsonAddress(raw, ".organizers"), address(deployScript.organizers()), "organizers");
        assertEq(vm.parseJsonAddress(raw, ".ticket"), address(deployScript.ticket()), "ticket");
        assertEq(vm.parseJsonAddress(raw, ".paymaster"), address(deployScript.paymaster()), "paymaster");
        assertEq(vm.parseJsonAddress(raw, ".attester"), ATTESTER, "attester");
        assertEq(vm.parseJsonAddress(raw, ".entryPoint"), address(entryPoint), "entryPoint");
        assertEq(vm.parseJsonUint(raw, ".block"), block.number, "block");
        // Nothing had written the factory yet, so its slot is present and empty rather than missing.
        assertEq(vm.parseJsonAddress(raw, ".coinbaseFactory"), address(0), "coinbaseFactory");

        // Task 31 fills that slot in this same file. A later run of this script must not erase it, or
        // sub-plan 03 loses the account factory it creates attendee wallets with.
        vm.writeFile(PATH, string.concat('{"coinbaseFactory":"', vm.toString(FACTORY), '"}'));
        deployScript.run();
        deployScript.recordAt(PATH);

        raw = vm.readFile(PATH);
        assertEq(vm.parseJsonAddress(raw, ".coinbaseFactory"), FACTORY, "coinbaseFactory survived");
        assertEq(vm.parseJsonAddress(raw, ".identity"), address(deployScript.identity()), "identity is fresh");
    }

    function test_defaultsMatchTheTestnetDeployment() public view {
        assertEq(deployScript.ENTRY_POINT_V06(), 0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789, "EntryPoint v0.6");
        assertEq(deployScript.DEFAULT_STAKE_WEI(), 1 ether, "default stake");
        assertEq(deployScript.DEFAULT_DEPOSIT_WEI(), 1 ether, "default deposit");
        assertEq(deployScript.UNSTAKE_DELAY_SEC(), 1 days, "one-day unstake delay");
    }

    function _assertSponsored(
        MontiPaymaster paymaster,
        bytes4 selector,
        MontiPaymaster.ArgKind kind,
        string memory what
    ) private view {
        assertTrue(paymaster.allowedSelector(selector), string.concat(what, " is sponsored"));
        assertEq(uint8(paymaster.argKindOf(selector)), uint8(kind), string.concat(what, " kind"));
    }

    function _deploy() private {
        deployScript.deploy(ATTESTER, address(entryPoint), STAKE, DEPOSIT);
    }
}
