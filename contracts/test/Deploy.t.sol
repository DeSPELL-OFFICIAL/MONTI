// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {Test} from "forge-std/Test.sol";
import {Deploy} from "../script/Deploy.s.sol";
import {Verify} from "../script/Verify.s.sol";
import {Identity} from "../src/Identity.sol";
import {Organizers} from "../src/Organizers.sol";
import {Ticket} from "../src/Ticket.sol";
import {MontiForwarder} from "../src/MontiForwarder.sol";
import {SettlementVault} from "../src/SettlementVault.sol";
import {ISettlementVault} from "../src/interfaces/ISettlementVault.sol";
import {MockUSD} from "../src/mocks/MockUSD.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice The deploy script, plus the one recording entry point the tests need and the script must not
///         have.
/// @dev    `record()` writes only under a broadcast, and `forge test` is not one. This is how the tests
///         reach the writing half without giving the script itself a public entry point that could be
///         pointed at the tracked deployments/10143.json.
contract DeployHarness is Deploy {
    function recordAt(string memory path) external {
        _record(path);
    }
}

contract Token18 is ERC20 {
    constructor() ERC20("Eighteen", "E18") {}
}

/// @notice Runs the real v2 deploy script in process (design 2026-10-12 §8). What is proved here is what the
///         founder cannot afford to discover on chain: the five contracts point at each other and at the
///         forwarder, the vault is owned by the broadcaster with the treasury as depositor and USDC
///         allowlisted, and the deployments file carries exactly the keys `packages/shared` reads.
/// @dev    Forge runs the test functions of one contract in parallel, so exactly one of them touches the
///         filesystem. The path written is `deployments/31337.json` (the local chain id), never the
///         committed `10143.json`; it is gitignored.
contract DeployTest is Test {
    DeployHarness internal deployScript;
    MockUSD internal usdc;

    uint256 internal constant PK = 0xD3910;
    address internal deployer;

    address internal constant ATTESTER = 0x000000000000000000000000000000000000a11c;
    address internal constant TREASURY = 0x0000000000000000000000000000000000007EA5;

    string internal constant PATH = "deployments/31337.json";

    /// @dev The keys `packages/shared`'s `Deployment` reads out of deployments/<chainid>.json, in the order
    ///      `vm.parseJsonKeys` returns them (alphabetical). No `previous`, no `settlementVaultBlock` (v2).
    string[9] internal RECORDED_KEYS =
        ["attester", "block", "chainId", "forwarder", "identity", "organizers", "settlementVault", "ticket", "usdc"];

    function setUp() public {
        // Pin the chain id: on a forked run `block.chainid` would be Monad's, and `run()` would write
        // the tracked deployments/10143.json instead of the gitignored local one.
        vm.chainId(31337);

        deployScript = new DeployHarness();
        usdc = new MockUSD();
        deployer = vm.addr(PK);

        // A broadcast inside `forge test` only re-labels the sender.
        vm.deal(deployer, 100 ether);

        vm.setEnv("DEPLOYER_PK", vm.toString(PK));
        vm.setEnv("ATTESTER_ADDRESS", vm.toString(ATTESTER));
        vm.setEnv("TREASURY_ADDRESS", vm.toString(TREASURY));
        vm.setEnv("USDC_ADDRESS", vm.toString(address(usdc)));
    }

    function test_deployWiresEveryContractTogether() public {
        _deploy();

        Identity identity = deployScript.identity();
        Organizers organizers = deployScript.organizers();
        Ticket ticket = deployScript.ticket();
        MontiForwarder forwarder = deployScript.forwarder();
        SettlementVault vault = deployScript.vault();

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

        // v2: Ticket <-> SettlementVault.
        assertEq(ticket.vault(), address(vault), "ticket.vault");
        assertEq(address(vault.ticket()), address(ticket), "vault.ticket");
        assertEq(address(vault.organizers()), address(organizers), "vault.organizers");
        assertTrue(vault.depositor(TREASURY), "treasury is the depositor");
        assertTrue(vault.tokenAllowed(address(usdc)), "usdc allowlisted");
        assertFalse(vault.paused(), "not paused");
    }

    /// @notice Each run gets its own Organizers/Ticket (both setters are once-only), so a re-run must not
    ///         revert on contracts it wired last time.
    function test_deployIsRepeatableBecauseEachRunGetsItsOwnContracts() public {
        _deploy();
        Organizers first = deployScript.organizers();
        Ticket firstTicket = deployScript.ticket();

        _deploy();
        Organizers second = deployScript.organizers();

        assertTrue(address(first) != address(second), "a second run gets its own Organizers");
        assertTrue(address(firstTicket) != address(deployScript.ticket()), "and its own Ticket");
        assertEq(second.ticket(), address(deployScript.ticket()), "and wires it to the new Ticket");
        vm.prank(second.deployer());
        vm.expectRevert(Organizers.TicketAlreadySet.selector);
        second.setTicket(address(0xBEEF));
        Ticket t = deployScript.ticket();
        vm.prank(t.deployer());
        vm.expectRevert(Ticket.VaultAlreadySet.selector);
        t.setVault(address(0xBEEF));
    }

    /// @notice The vault refuses a token whose decimals are not 6, so a mistyped USDC_ADDRESS fails the
    ///         deploy instead of mispricing every escrow by 10^12.
    function test_deployRejectsANon6DecimalToken() public {
        Token18 t18 = new Token18();
        vm.expectRevert(ISettlementVault.UnsupportedDecimals.selector);
        deployScript.deploy(ATTESTER, TREASURY, address(t18));
    }

    /// @notice The whole of `run`: the environment is read, the broadcasting key ends up holding every
    ///         privileged role, the deployments file carries every key `packages/shared` reads, and the
    ///         Verify script passes against that file (and fails against the wrong treasury).
    function test_runRecordsEverythingAndVerifyPasses() public {
        if (vm.exists(PATH)) vm.removeFile(PATH);

        deployScript.run();

        // `run` records only under `--broadcast`, and neither `forge test` nor a dry run is that.
        assertFalse(vm.exists(PATH), "a run that is not a broadcast records nothing");
        deployScript.record();
        assertFalse(vm.exists(PATH), "nor does record() called on its own");
        deployScript.recordAt(PATH);

        // Privileged roles must land on the broadcasting key, not on the script contract.
        assertEq(deployScript.identity().deployer(), deployer, "identity.deployer");
        assertEq(deployScript.forwarder().deployer(), deployer, "forwarder.deployer");
        assertEq(deployScript.organizers().deployer(), deployer, "organizers.deployer");
        assertEq(deployScript.ticket().deployer(), deployer, "ticket.deployer");
        assertEq(deployScript.vault().owner(), deployer, "vault.owner");

        string memory raw = vm.readFile(PATH);
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
        assertEq(vm.parseJsonAddress(raw, ".settlementVault"), address(deployScript.vault()), "settlementVault");
        assertEq(vm.parseJsonAddress(raw, ".usdc"), address(usdc), "usdc");
        assertEq(vm.parseJsonAddress(raw, ".attester"), ATTESTER, "attester");
        assertEq(vm.parseJsonUint(raw, ".block"), block.number, "block");

        Verify verifier = new Verify();
        assertEq(verifier.verify(PATH, TREASURY, deployer), 0, "every wiring check passes");
        assertEq(verifier.verify(PATH, TREASURY, address(0)), 0, "owner defaults to ticket.deployer()");
        vm.expectRevert(bytes("wiring check failed"));
        verifier.verify(PATH, address(0xBAD), deployer);
    }

    function _deploy() private {
        deployScript.deploy(ATTESTER, TREASURY, address(usdc));
    }
}
