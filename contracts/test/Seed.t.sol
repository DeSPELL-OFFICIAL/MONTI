// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {Test} from "forge-std/Test.sol";
import {EntryPoint} from "account-abstraction/core/EntryPoint.sol";
import {DeployHarness} from "./Deploy.t.sol";
import {Seed} from "../script/Seed.s.sol";
import {Identity} from "../src/Identity.sol";
import {Organizers} from "../src/Organizers.sol";
import {Ticket} from "../src/Ticket.sol";
import {P256Vectors} from "./utils/P256Vectors.sol";

/// @notice The seed, plus the one entry point the tests need and the script must not have.
/// @dev    `record()` writes only under a broadcast, and `forge test` is not one. This is how the tests
///         reach the writing half without giving the script itself a public entry point that could be
///         pointed at the tracked deployments/seed-10143.json.
contract SeedHarness is Seed {
    function recordAt(string memory path) external {
        _record(path);
    }
}

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
    DeployHarness internal deployScript;
    SeedHarness internal seedScript;

    Identity internal identity;
    Organizers internal organizers;
    Ticket internal ticket;

    uint256 internal constant DEPLOYER_PK = 0xD3910;
    uint256 internal constant ATTESTER_PK = 0xA11CE;
    address internal deployer;
    address internal attester;

    address internal constant GATE = address(0x6A7E);
    address internal constant SECOND_GATE = address(0x6A7F);
    /// @dev Matches Seed.DEFAULT_MEMBER_FUND_WEI. Monad charges gas_limit x 100 gwei, so 0.02 MON did
    ///      not cover a claim on the 2026-09-22 testnet seed.
    uint256 internal constant FUND = 0.1 ether;
    /// @dev Stands in for the staff device's real P-256 public key. What matters is that it is a value
    ///      the founder supplies, not one this repository can derive.
    bytes32 internal constant GATE_KX = bytes32(uint256(0x6A11));
    bytes32 internal constant GATE_KY = bytes32(uint256(0x6A22));
    /// @dev A real base32 CIDv1 of a sha2-256 digest, which is the shape Pinata hands the founder back.
    string internal constant CID = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";

    string internal constant DEPLOY_PATH = "deployments/31340.json";
    string internal constant SEED_PATH = "deployments/seed-31340.json";

    function setUp() public {
        // Pin the chain id: on a forked run this would be Monad's, and `run()` would write the tracked
        // deployments/seed-10143.json instead of the gitignored local one.
        vm.chainId(31340);

        entryPoint = new EntryPoint();
        deployScript = new DeployHarness();
        seedScript = new SeedHarness();

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

        assertEq(uint256(ticket.tiers(eventId)[0].minted), count, "one ticket per demo member");
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
        deployScript.recordAt(DEPLOY_PATH);

        vm.setEnv("DEPLOYER_PK", vm.toString(DEPLOYER_PK));
        vm.setEnv("ATTESTER_PK", vm.toString(ATTESTER_PK));
        vm.setEnv("GATE_ACCOUNT", vm.toString(GATE));
        vm.setEnv("SEED_GATE_KX", vm.toString(GATE_KX));
        vm.setEnv("SEED_GATE_KY", vm.toString(GATE_KY));
        vm.setEnv("MEMBER_FUND_WEI", vm.toString(FUND));
        vm.setEnv("SEED_IMAGE_CID", CID);

        // `vm.setEnv` is process-global and forge runs this contract's test functions in parallel, so
        // the unset-variable case lives here rather than in a test of its own: an unset SEED_GATE_KX
        // reaches the script as a zero word, and the founder is told which variable is empty instead of
        // being handed an InvalidGateKey from eight calls deep, after the organizer and the event are
        // already on chain.
        vm.setEnv("SEED_GATE_KX", vm.toString(bytes32(0)));
        vm.expectRevert(bytes("SEED_GATE_KX and SEED_GATE_KY must be the gate device's P-256 public key"));
        seedScript.run();
        vm.setEnv("SEED_GATE_KX", vm.toString(GATE_KX));

        seedScript.run();

        // `run` records only under `--broadcast`, and neither `forge test` nor a dry run is that.
        // Without this gate a `forge script --rpc-url <monad>` rehearsal would overwrite the tracked
        // deployments/seed-10143.json with ids that were never seeded.
        assertFalse(vm.exists(SEED_PATH), "a run that is not a broadcast records nothing");

        // The gate lives inside `record` itself, so the signature a founder can reach directly --
        // `forge script --sig 'record()'` -- writes nothing either.
        seedScript.record();
        assertFalse(vm.exists(SEED_PATH), "nor does record() called on its own");
        seedScript.recordAt(SEED_PATH);

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

    /// @notice The chain carries only hashes of the title and the description, so the metadata CID is
    ///         the whole of what sub-plan 03 has to show a name and a picture with. A placeholder that
    ///         is not a real CID leaves the demo event blank on the first screen it was seeded for.
    function test_seedPutsTheRealMetadataCidOnTheEvent() public {
        _seed(GATE);

        assertEq(ticket.eventMeta(seedScript.eventId()).imageCid, CID, "the pinned CID reached the chain");
        assertEq(bytes(CID).length, seedScript.CID_LENGTH(), "a base32 CIDv1 is 59 characters");
    }

    function test_seedRefusesAnImageCidThatIsNotACid() public {
        vm.expectRevert(bytes("SEED_IMAGE_CID must be a 59-character base32 CIDv1"));
        _seedWithCid("bafybeigdyrztseedimageplaceholdercid");

        // 59 characters, but not a CID: the length alone would have let this through.
        vm.expectRevert(bytes("SEED_IMAGE_CID must be a base32 CIDv1 starting with bafy or bafk"));
        _seedWithCid("Qmabbeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi");
    }

    function test_seedAcceptsARawLeafCidFromPinata() public {
        // Pinata's v3 upload returns a raw-codec CIDv1 (`bafk...`) for files under the chunk size.
        _seedWithCid("bafkreiepv7iydmisqmk2qrht7zwfeaxtf7sljdzfbfhtthjgpovrknn754");
        assertEq(ticket.eventMeta(1).imageCid, "bafkreiepv7iydmisqmk2qrht7zwfeaxtf7sljdzfbfhtthjgpovrknn754");
    }

    /// @notice Identity.register answers to the attester and nobody else, so the wrong key does not fail
    ///         at the call site but on the first demo member, as an opaque NotAttester from inside
    ///         Identity. The founder is told which key is wrong before anything is broadcast.
    function test_seedRefusesAnAttesterKeyThatIsNotTheAttester() public {
        vm.expectRevert(bytes("ATTESTER_PK does not match Identity.attester()"));
        seedScript.seed(
            address(identity),
            address(organizers),
            address(ticket),
            GATE,
            GATE_KX,
            GATE_KY,
            CID,
            DEPLOYER_PK,
            ATTESTER_PK + 1,
            FUND
        );
    }

    /// @notice Seeding a stack that was never deployed would otherwise fail deep inside an empty
    ///         address with no message. The committed deployments/10143.json is zeroed until the
    ///         founder deploys, so this is the first thing a mistimed run hits.
    function test_seedRefusesAStackThatIsNotDeployedYet() public {
        vm.expectRevert(Seed.StackNotDeployed.selector);
        seedScript.seed(
            address(0),
            address(organizers),
            address(ticket),
            GATE,
            GATE_KX,
            GATE_KY,
            CID,
            DEPLOYER_PK,
            ATTESTER_PK,
            FUND
        );
    }

    /// @notice Review Minor 4. A gate registered under a placeholder key cannot be verified by the
    ///         attendee phone, so spec 7.2 step 3 -- T14 defence 1, the phone checking the gate's
    ///         signature before it writes anything back -- simply does not exist on that gate. The seed
    ///         has to register the real device key the founder generated on the staff Android.
    function test_seedRegistersTheGateWithTheSuppliedKey() public {
        bytes32 kx = bytes32(uint256(0x6A11));
        bytes32 ky = bytes32(uint256(0x6A22));
        _seedWithGateKey(GATE, kx, ky);

        (,, bytes32 gotX, bytes32 gotY,,) = organizers.gateInfo(seedScript.gateId());
        assertEq(gotX, kx, "the gate key is the one the founder supplied");
        assertEq(gotY, ky);
        assertTrue(gotX != keccak256("gate-kx"), "no placeholder survives");
        assertTrue(gotY != keccak256("gate-ky"), "neither half of one");
    }

    /// @notice An unset SEED_GATE_KX/KY reaches `seed` as a zero word. Organizers.registerGate would
    ///         refuse it too (InvalidGateKey), but eight calls deep and after the organizer and the
    ///         event are already on chain -- the founder is told which variable is empty before
    ///         anything is broadcast.
    function test_seedRefusesAGateKeyThatIsMissing() public {
        vm.expectRevert(bytes("SEED_GATE_KX and SEED_GATE_KY must be the gate device's P-256 public key"));
        _seedWithGateKey(GATE, bytes32(0), GATE_KY);

        vm.expectRevert(bytes("SEED_GATE_KX and SEED_GATE_KY must be the gate device's P-256 public key"));
        _seedWithGateKey(GATE, GATE_KX, bytes32(0));
    }

    /// @notice Monad charges on `gas_limit x 100 gwei`, not on gas used, so a demo member funded with
    ///         0.02 MON could not send its own claim: the 2026-09-22 testnet seed had to finish three
    ///         of them by hand with `cast`.
    function test_theDefaultMemberFundIsEnoughForAClaimOnMonad() public view {
        assertEq(seedScript.DEFAULT_MEMBER_FUND_WEI(), 0.1 ether, "0.02 MON did not cover a claim");
    }

    function _seedWithCid(string memory cid) private {
        seedScript.seed(
            address(identity),
            address(organizers),
            address(ticket),
            GATE,
            GATE_KX,
            GATE_KY,
            cid,
            DEPLOYER_PK,
            ATTESTER_PK,
            FUND
        );
    }

    function _seed(address gateAccount) private {
        _seedWithGateKey(gateAccount, GATE_KX, GATE_KY);
    }

    function _seedWithGateKey(address gateAccount, bytes32 kx, bytes32 ky) private {
        seedScript.seed(
            address(identity),
            address(organizers),
            address(ticket),
            gateAccount,
            kx,
            ky,
            CID,
            DEPLOYER_PK,
            ATTESTER_PK,
            FUND
        );
    }
}
