// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {Test} from "forge-std/Test.sol";
import {EntryPoint} from "account-abstraction/core/EntryPoint.sol";
import {IStakeManager} from "account-abstraction/interfaces/IStakeManager.sol";
import {DeployTicket} from "../script/DeployTicket.s.sol";
import {Identity} from "../src/Identity.sol";
import {Organizers} from "../src/Organizers.sol";
import {Ticket} from "../src/Ticket.sol";
import {MontiPaymaster} from "../src/MontiPaymaster.sol";

/// @notice Reaches _record without giving the script a public entry point that could be pointed at the
///         tracked deployments/10143.json.
contract DeployTicketHarness is DeployTicket {
    function recordAt(string memory path) external {
        _record(path);
    }
}

/// @notice The 01c redeploy against a real EntryPoint, in process: a new Ticket and paymaster stand on
///         a kept Identity/Organizers, the paymaster is staked and funded, the four approval selectors
///         are added on top of the constructor's 2026-09-23 list, and the kept Organizers is never
///         re-pointed (its setTicket is once-only and already spent).
contract DeployTicketTest is Test {
    EntryPoint internal entryPoint;
    DeployTicketHarness internal script;

    uint256 internal constant PK = 0xD3910C;
    address internal deployer;

    address internal constant ATTESTER = 0x000000000000000000000000000000000000a11c;
    address internal constant FACTORY = 0x00000000000000000000000000000000000fAc70;
    uint256 internal constant STAKE = 1.5 ether;
    uint256 internal constant DEPOSIT = 2.5 ether;

    Identity internal identity;
    Organizers internal organizers;

    string internal constant PATH = "deployments/31341.json";

    bytes4 internal constant CHECK_IN = bytes4(keccak256("checkIn(uint256,(uint256,uint256,uint64,bytes32),bytes)"));

    function setUp() public {
        // Pin the chain id so recordAt writes the gitignored local file, never the tracked 10143.json.
        vm.chainId(31341);

        entryPoint = new EntryPoint();
        script = new DeployTicketHarness();
        deployer = vm.addr(PK);
        vm.deal(deployer, 100 ether);
        vm.deal(address(script), 100 ether);

        identity = new Identity(ATTESTER);
        organizers = new Organizers();
    }

    function test_deploysNewTicketAndPaymasterOnTheKeptStack() public {
        _deploy();
        Ticket ticket = script.ticket();
        MontiPaymaster paymaster = script.paymaster();

        assertEq(address(ticket.identity()), address(identity), "ticket.identity kept");
        assertEq(address(ticket.organizers()), address(organizers), "ticket.organizers kept");
        assertEq(address(paymaster.ticket()), address(ticket), "paymaster.ticket = new ticket");
        assertEq(address(paymaster.identity()), address(identity), "paymaster.identity kept");
        assertEq(address(paymaster.organizers()), address(organizers), "paymaster.organizers kept");
        assertEq(address(paymaster.entryPoint()), address(entryPoint), "paymaster.entryPoint");
        assertEq(paymaster.deployer(), address(script), "paymaster.deployer is the caller of deploy");
    }

    /// @notice Organizers.setTicket is once-only and, on chain, already spent on the retired Ticket. The
    ///         redeploy must not touch it -- proven here by the kept Organizers staying where it pointed.
    function test_doesNotRepointOrganizers() public {
        assertEq(organizers.ticket(), address(0), "precondition: this fresh Organizers points nowhere");
        _deploy();
        assertEq(organizers.ticket(), address(0), "the redeploy left Organizers.ticket untouched");
    }

    /// @notice Spec 8.4: an unstaked paymaster has its ops dropped before they reach the chain.
    function test_stakesAndFundsTheNewPaymaster() public {
        _deploy();
        MontiPaymaster paymaster = script.paymaster();
        IStakeManager.DepositInfo memory info = entryPoint.getDepositInfo(address(paymaster));

        assertEq(info.stake, STAKE, "stake");
        assertTrue(info.staked, "staked");
        assertEq(info.unstakeDelaySec, script.UNSTAKE_DELAY_SEC(), "unstake delay");
        assertEq(info.deposit, DEPOSIT, "deposit");
        assertEq(paymaster.budgetOf(paymaster.PLATFORM()), DEPOSIT, "platform budget");
        assertEq(address(paymaster).balance, 0, "everything went to the EntryPoint");
    }

    /// @notice The four 01c selectors, added after the constructor, all bill the event named in word 0.
    ///         The hex is pinned so a signature typo in the script is caught here, not at the door.
    function test_installsTheFourApprovalSelectorsAsEventIdWord0() public {
        _deploy();
        MontiPaymaster paymaster = script.paymaster();

        _assertEventIdWord0(paymaster, bytes4(keccak256("requestClaim(uint256,uint8)")), 0x85563044, "requestClaim");
        _assertEventIdWord0(paymaster, Ticket.approveClaims.selector, 0x0b177ad6, "approveClaims");
        _assertEventIdWord0(paymaster, Ticket.rejectClaims.selector, 0x2c261b04, "rejectClaims");
        _assertEventIdWord0(paymaster, Ticket.cancelRequest.selector, 0xd586d2e4, "cancelRequest");
    }

    /// @notice The four new rows sit on top of the 2026-09-23 list the constructor seeds, not in place of
    ///         it: one spot of each ArgKind proves the old table survived.
    function test_keepsTheConstructorSeededAllowList() public {
        _deploy();
        MontiPaymaster paymaster = script.paymaster();

        assertEq(
            uint8(paymaster.argKindOf(Ticket.createEvent.selector)),
            uint8(MontiPaymaster.ArgKind.Platform),
            "createEvent Platform"
        );
        assertEq(
            uint8(paymaster.argKindOf(bytes4(keccak256("claim(uint256,uint8,bytes)")))),
            uint8(MontiPaymaster.ArgKind.EventId),
            "claim EventId"
        );
        assertEq(uint8(paymaster.argKindOf(CHECK_IN)), uint8(MontiPaymaster.ArgKind.TokenId), "checkIn TokenId");
        assertEq(
            uint8(paymaster.argKindOf(Organizers.createOrganizer.selector)),
            uint8(MontiPaymaster.ArgKind.Platform),
            "createOrganizer Platform"
        );
        assertEq(
            uint8(paymaster.argKindOf(Organizers.transferOwner.selector)),
            uint8(MontiPaymaster.ArgKind.OrgId),
            "transferOwner OrgId"
        );
    }

    /// @notice _record keeps every reused key (identity, organizers, entryPoint, attester and Task 31's
    ///         coinbaseFactory), updates ticket/paymaster/block, and files the retired pair under
    ///         `previous`. Exactly one test touches the filesystem, as forge runs these in parallel.
    function test_recordKeepsTheKeptAddressesAndFilesThePrevious() public {
        vm.writeFile(
            PATH,
            string.concat(
                '{"attester":"',
                vm.toString(ATTESTER),
                '","coinbaseFactory":"',
                vm.toString(FACTORY),
                '","entryPoint":"',
                vm.toString(address(entryPoint)),
                '","identity":"',
                vm.toString(address(identity)),
                '","organizers":"',
                vm.toString(address(organizers)),
                '","ticket":"0x4B8353C9F3503Cdbd011E8f35da0a955D95b1367",',
                '"paymaster":"0xBDDBDaA9811C8944AF82319b19169A209A0928B2",',
                '"block":64921775}'
            )
        );

        _deploy();
        script.recordAt(PATH);

        string memory raw = vm.readFile(PATH);
        assertEq(vm.parseJsonAddress(raw, ".ticket"), address(script.ticket()), "ticket updated");
        assertEq(vm.parseJsonAddress(raw, ".paymaster"), address(script.paymaster()), "paymaster updated");
        assertEq(vm.parseJsonAddress(raw, ".identity"), address(identity), "identity kept");
        assertEq(vm.parseJsonAddress(raw, ".organizers"), address(organizers), "organizers kept");
        assertEq(vm.parseJsonAddress(raw, ".attester"), ATTESTER, "attester carried over");
        assertEq(vm.parseJsonAddress(raw, ".coinbaseFactory"), FACTORY, "factory survived");
        assertEq(vm.parseJsonUint(raw, ".block"), block.number, "block updated");
        assertEq(
            vm.parseJsonAddress(raw, ".previous[0].ticket"),
            0x4B8353C9F3503Cdbd011E8f35da0a955D95b1367,
            "previous ticket recorded"
        );
        assertEq(
            vm.parseJsonAddress(raw, ".previous[0].paymaster"),
            0xBDDBDaA9811C8944AF82319b19169A209A0928B2,
            "previous paymaster recorded"
        );
        assertEq(vm.parseJsonUint(raw, ".previous[0].block"), 64921775, "previous block recorded");

        if (vm.exists(PATH)) vm.removeFile(PATH);
    }

    function _assertEventIdWord0(MontiPaymaster paymaster, bytes4 selector, bytes4 expected, string memory what)
        private
        view
    {
        assertEq(selector, expected, string.concat(what, " selector hex"));
        assertTrue(paymaster.allowedSelector(selector), string.concat(what, " sponsored"));
        assertEq(
            uint8(paymaster.argKindOf(selector)), uint8(MontiPaymaster.ArgKind.EventId), string.concat(what, " kind")
        );
        assertEq(paymaster.argWordOf(selector), 0, string.concat(what, " word"));
    }

    function _deploy() private {
        script.deploy(address(identity), address(organizers), address(entryPoint), STAKE, DEPOSIT);
    }
}
