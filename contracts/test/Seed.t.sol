// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {Test} from "forge-std/Test.sol";
import {EntryPoint} from "account-abstraction/core/EntryPoint.sol";
import {Deploy} from "../script/Deploy.s.sol";
import {Seed} from "../script/Seed.s.sol";
import {Identity} from "../src/Identity.sol";
import {Organizers} from "../src/Organizers.sol";
import {Ticket} from "../src/Ticket.sol";
import {P256Vectors} from "./utils/P256Vectors.sol";

/// @notice Runs the seed against a stack the real deploy script just built in process, because what the
///         founder needs from this script is not that it compiles but that sub-plans 03 and 04 have
///         something to open on: a published event with a free tier, an open gate, and members holding
///         tickets that the staff device's own P-256 vectors can check in.
/// @dev    One test function touches the filesystem; the rest call `seed` directly, which is the same
///         code path without the deployments file. The chain id is pinned to 31340 — Deploy.t.sol has
///         31337 and DeployCoinbaseFactory.t.sol 31338/31339 — so the files written here are the
///         gitignored local ones and never the tracked 10143 pair.
contract SeedTest is Test {
    EntryPoint internal entryPoint;
    Deploy internal deployScript;
    Seed internal seedScript;

    Identity internal identity;
    Organizers internal organizers;
    Ticket internal ticket;

    uint256 internal constant DEPLOYER_PK = 0xD3910;
    uint256 internal constant ATTESTER_PK = 0xA11CE;
    address internal deployer;
    address internal attester;

    address internal constant GATE = address(0x6A7E);
    address internal constant SECOND_GATE = address(0x6A7F);
    uint256 internal constant FUND = 0.02 ether;

    string internal constant DEPLOY_PATH = "deployments/31340.json";
    string internal constant SEED_PATH = "deployments/seed-31340.json";

    function setUp() public {
        // Pin the chain id: on a forked run this would be Monad's, and `run()` would write the tracked
        // deployments/seed-10143.json instead of the gitignored local one.
        vm.chainId(31340);

        entryPoint = new EntryPoint();
        deployScript = new Deploy();
        seedScript = new Seed();

        deployer = vm.addr(DEPLOYER_PK);
        attester = vm.addr(ATTESTER_PK);

        // A broadcast inside `forge test` only re-labels the sender; the value still leaves the script.
        vm.deal(deployer, 100 ether);
        vm.deal(address(deployScript), 100 ether);
        vm.deal(address(seedScript), 100 ether);

        deployScript.deploy(attester, address(entryPoint), 1 ether, 1 ether);
        identity = deployScript.identity();
        organizers = deployScript.organizers();
        ticket = deployScript.ticket();
    }

    /// @notice The three ids sub-plans 03 and 04 are built on: an organizer the deployer owns, an event
    ///         that is published with one free tier, and a gate that is open on that event.
    function test_seedCreatesOnePublishedEventWithOneOpenGate() public {
        _seed(GATE);

        uint256 eventId = seedScript.eventId();

        assertEq(seedScript.orgId(), 1, "first organizer");
        assertEq(eventId, 1, "first event");
        assertEq(seedScript.gateId(), 1, "first gate");
        assertEq(organizers.ownerOf(seedScript.orgId()), deployer, "the deployer owns the demo organizer");
        assertEq(ticket.eventOrg(eventId), seedScript.orgId(), "the event belongs to that organizer");

        assertEq(uint8(ticket.eventStatus(eventId)), uint8(Ticket.EventStatus.Published), "published");
        assertEq(ticket.tiers(eventId).length, 1, "one tier");
        assertEq(ticket.tiers(eventId)[0].priceUsdCents, 0, "free: the MVP claims nothing paid");

        assertTrue(organizers.isOpenGate(eventId, GATE), "the gate is open on this event");
        assertEq(organizers.gateOf(GATE), seedScript.gateId(), "and is the gate the script recorded");
    }

    /// @notice The sale has to be open the moment the seed returns, or the first screen of sub-plan 03
    ///         shows a closed event; the doors have to stay open long enough that one seeding lasts the
    ///         hackathon rather than an afternoon.
    function test_seededEventIsOpenForBusinessNowAndStillOpenInTwoWeeks() public {
        _seed(GATE);

        Ticket.EventMeta memory meta = ticket.eventMeta(seedScript.eventId());
        assertLe(meta.saleStart, block.timestamp, "the sale is already open");
        assertGt(meta.saleEnd, block.timestamp + 14 days, "and is still open in two weeks");
        assertGt(meta.endsAt, block.timestamp + 14 days, "the event has not ended by then either");
        assertGt(meta.startsAt, block.timestamp + uint256(meta.transferCutoffSeconds), "transfers are open");
        assertTrue(meta.transferable, "sub-plan 03 demos handing a ticket over");
        assertFalse(meta.requireKyc, "a demo attendee is phone + passkey only");
    }

    /// @notice Every demo member is a member of Identity, carries the device key the staff-device test
    ///         vectors sign with, holds one ticket on the seeded event, and has the gas to have claimed
    ///         it — which on a real testnet is what the funding step buys.
    function test_seedRegistersDemoMembersWhoEachHoldATicket() public {
        _seed(GATE);

        uint256 eventId = seedScript.eventId();
        uint256 count = seedScript.memberCount();
        assertEq(count, seedScript.DEMO_MEMBERS(), "every demo member was seeded");
        assertGt(count, 0, "a seed with no attendee is not a demo");

        for (uint256 i; i < count; ++i) {
            address member = seedScript.members(i);
            uint256 tokenId = seedScript.tokenIds(i);

            assertTrue(identity.isMember(member), "registered");
            assertEq(identity.kycLevelOf(member), 1, "verified, so a KYC-gated event would let them in");
            (bytes32 x, bytes32 y) = identity.activeDevice(member);
            assertEq(x, P256Vectors.DEVICE_X, "device x is the vector key sub-plan 04 signs with");
            assertEq(y, P256Vectors.DEVICE_Y, "device y is the vector key sub-plan 04 signs with");

            assertEq(ticket.ownerOf(tokenId), member, "holds the ticket");
            assertEq(ticket.eventOf(tokenId), eventId, "on the seeded event");
            assertEq(ticket.tierOf(tokenId), 0, "in the free tier");
            assertEq(member.balance, FUND, "funded to pay for its own claim");
        }

        assertEq(ticket.tiers(eventId)[0].minted, uint32(count), "one ticket per demo member");
    }

    /// @notice A gate account may be registered exactly once, so the founder re-runs the seed with the
    ///         real staff device's account once it exists. That second run must not trip over the
    ///         members the first one registered.
    function test_seedIsRerunnableForTheRealGateAccount() public {
        _seed(GATE);
        uint256 firstEvent = seedScript.eventId();
        address firstMember = seedScript.members(0);

        _seed(SECOND_GATE);
        uint256 secondEvent = seedScript.eventId();

        assertEq(secondEvent, firstEvent + 1, "a second run gets its own event");
        assertEq(seedScript.gateId(), 2, "and its own gate");
        assertTrue(organizers.isOpenGate(secondEvent, SECOND_GATE), "open on the new event");
        assertFalse(organizers.isOpenGate(secondEvent, GATE), "the old gate is not on it");

        assertEq(seedScript.members(0), firstMember, "the demo members are the same accounts");
        assertEq(ticket.ownerOf(seedScript.tokenIds(0)), firstMember, "who now hold a ticket on both events");
        assertEq(ticket.balanceOf(firstMember), 2, "one from each run");
    }

    /// @notice The whole of `run`: the addresses come out of the deployments file Task 30 wrote, and the
    ///         seed file carries every id sub-plans 03 and 04 read.
    function test_runReadsTheDeploymentAndRecordsWhatTheAppsRead() public {
        if (vm.exists(SEED_PATH)) vm.removeFile(SEED_PATH);
        deployScript.record();

        vm.setEnv("DEPLOYER_PK", vm.toString(DEPLOYER_PK));
        vm.setEnv("ATTESTER_PK", vm.toString(ATTESTER_PK));
        vm.setEnv("GATE_ACCOUNT", vm.toString(GATE));
        vm.setEnv("MEMBER_FUND_WEI", vm.toString(FUND));

        seedScript.run();

        // `run` records only under `--broadcast`, and neither `forge test` nor a dry run is that.
        // Without this gate a `forge script --rpc-url <monad>` rehearsal would overwrite the tracked
        // deployments/seed-10143.json with ids that were never seeded.
        assertFalse(vm.exists(SEED_PATH), "a run that is not a broadcast records nothing");
        seedScript.record();

        // The stack came out of the file, not out of this test.
        assertEq(address(seedScript.identity()), address(identity), "identity");
        assertEq(address(seedScript.organizers()), address(organizers), "organizers");
        assertEq(address(seedScript.ticket()), address(ticket), "ticket");
        assertEq(seedScript.gateAccount(), GATE, "gate account");

        string memory raw = vm.readFile(SEED_PATH);
        assertEq(vm.parseJsonUint(raw, ".orgId"), seedScript.orgId(), "orgId");
        assertEq(vm.parseJsonUint(raw, ".eventId"), seedScript.eventId(), "eventId");
        assertEq(vm.parseJsonUint(raw, ".gateId"), seedScript.gateId(), "gateId");
        assertEq(vm.parseJsonAddress(raw, ".gateAccount"), GATE, "gateAccount");

        address[] memory members = vm.parseJsonAddressArray(raw, ".members");
        uint256[] memory tokenIds = vm.parseJsonUintArray(raw, ".tokenIds");
        assertEq(members.length, seedScript.memberCount(), "every member is listed");
        assertEq(tokenIds.length, members.length, "with the ticket each one holds");
        for (uint256 i; i < members.length; ++i) {
            assertEq(members[i], seedScript.members(i), "member");
            assertEq(ticket.ownerOf(tokenIds[i]), members[i], "ticket");
        }
    }

    /// @notice Seeding a stack that was never deployed would otherwise fail deep inside an empty
    ///         address with no message. The committed deployments/10143.json is zeroed until the
    ///         founder deploys, so this is the first thing a mistimed run hits.
    function test_seedRefusesAStackThatIsNotDeployedYet() public {
        vm.expectRevert(Seed.StackNotDeployed.selector);
        seedScript.seed(address(0), address(organizers), address(ticket), GATE, DEPLOYER_PK, ATTESTER_PK, FUND);
    }

    function _seed(address gateAccount) private {
        seedScript.seed(
            address(identity), address(organizers), address(ticket), gateAccount, DEPLOYER_PK, ATTESTER_PK, FUND
        );
    }
}
