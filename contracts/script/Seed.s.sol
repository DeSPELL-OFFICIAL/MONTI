// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {Script} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {console2} from "forge-std/console2.sol";
import {Identity} from "../src/Identity.sol";
import {Organizers} from "../src/Organizers.sol";
import {Ticket} from "../src/Ticket.sol";
import {P256Vectors} from "../test/utils/P256Vectors.sol";

/// @title Seed
/// @notice The demo MONTI runs on: one organizer owned by the deployer, one published event with one
///         free tier, one open gate, and a handful of registered members each holding a ticket on it.
///         The ids land in `deployments/seed-<chainid>.json`, which is the file sub-plans 03 (attendee
///         app) and 04 (staff device) open on — their first screens run on these values with nothing
///         else to set up.
///
/// @dev    Reads the stack out of Task 30's `deployments/<chainid>.json`, so it is run after Deploy and
///         never instead of it.
///
///         Three senders, because the chain will not take these transactions from one account:
///         `Organizers` and `Ticket` answer to the organizer's owner, `Identity.register` answers to the
///         attester and nobody else (spec 9.2), and `Ticket.claim` mints to `msg.sender`, so each demo
///         member has to send their own claim. The members' keys are derived from a public label below
///         and the deployer wires them enough gas to pay for that one transaction.
///
///         Inputs come from the environment only, so no key is ever written into this repository:
///           DEPLOYER_PK      broadcast key; owns the demo organizer and pays for the demo members' gas
///           ATTESTER_PK      the key behind Identity's attester; the only account that may register
///           GATE_ACCOUNT     the staff device's account, which becomes this event's open gate
///           MEMBER_FUND_WEI  optional, defaults to 0.02 MON per demo member
contract Seed is Script {
    /// @notice Enough demo attendees to show a list rather than a single row, few enough to seed in one
    ///         run on a testnet.
    uint256 public constant DEMO_MEMBERS = 3;

    /// @notice One claim costs well under this at any testnet gas price; the rest stays in the account
    ///         for whatever sub-plan 03 demos next.
    uint256 public constant DEFAULT_MEMBER_FUND_WEI = 0.02 ether;

    /// @notice Spec 9.2's verified level: the demo attendees pass an event that demands ID and face.
    uint8 public constant DEMO_KYC_LEVEL = 1;

    /// @notice The demo event opens its doors a month out and sells until then, so one seeding lasts the
    ///         hackathon. An event that ended the same afternoon would take sub-plans 03 and 04 down
    ///         with it — `claim` closes with the sale and `checkIn` refuses an event that has ended.
    uint64 public constant DOORS_IN = 30 days;
    uint64 public constant RUNS_FOR = 1 days;

    /// @dev Demo accounts, and nothing else, ever: the label is public, so anyone can derive these keys.
    ///      They exist so the seed can send a claim from each member without the founder minding three
    ///      more secrets, and they hold nothing but a free ticket and a few cents of testnet gas. The
    ///      real attendee phone registers its own passkey account through the app (sub-plan 03).
    string internal constant MEMBER_LABEL = "monti.seed.demo.member";
    string internal constant PERSON_LABEL = "monti.seed.demo.person";

    Identity public identity;
    Organizers public organizers;
    Ticket public ticket;

    address public gateAccount;
    uint256 public orgId;
    uint256 public eventId;
    uint256 public gateId;

    address[] public members;
    uint256[] public tokenIds;

    /// @notice The deployments file still holds zeros, so Deploy has not run on this chain yet.
    error StackNotDeployed();
    error MemberFundingFailed();

    function run() external {
        uint256 deployerPk = vm.envUint("DEPLOYER_PK");
        uint256 attesterPk = vm.envUint("ATTESTER_PK");
        address gate = vm.envAddress("GATE_ACCOUNT");
        uint256 memberFundWei = vm.envOr("MEMBER_FUND_WEI", DEFAULT_MEMBER_FUND_WEI);

        string memory raw = vm.readFile(string.concat("deployments/", vm.toString(block.chainid), ".json"));
        seed(
            vm.parseJsonAddress(raw, ".identity"),
            vm.parseJsonAddress(raw, ".organizers"),
            vm.parseJsonAddress(raw, ".ticket"),
            gate,
            deployerPk,
            attesterPk,
            memberFundWei
        );

        console2.log("orgId       ", orgId);
        console2.log("eventId     ", eventId);
        console2.log("gateId      ", gateId);
        console2.log("gateAccount ", gateAccount);
        for (uint256 i; i < members.length; ++i) {
            console2.log("member      ", members[i], "holds ticket", tokenIds[i]);
        }

        // A dry run simulates the whole seeding but leaves nothing on chain, so recording its ids would
        // replace the tracked record with an event that does not exist. Only a real broadcast earns the
        // write; the tests call `record()` themselves.
        if (vm.isContext(VmSafe.ForgeContext.ScriptBroadcast)) record();
    }

    /// @notice Creates the organizer, the event, the gate and the demo members' tickets.
    /// @dev    Separate from `run` so the tests can drive it without the deployments file. Re-running is
    ///         part of the job: the founder seeds again with the real staff device's account once it
    ///         exists, because `Organizers.registerGate` takes a gate account exactly once. That second
    ///         run gets its own organizer, event and gate, and steps over the members and the funding
    ///         the first run already put in place.
    function seed(
        address identity_,
        address organizers_,
        address ticket_,
        address gateAccount_,
        uint256 deployerPk,
        uint256 attesterPk,
        uint256 memberFundWei
    ) public {
        if (identity_ == address(0) || organizers_ == address(0) || ticket_ == address(0)) {
            revert StackNotDeployed();
        }

        identity = Identity(identity_);
        organizers = Organizers(organizers_);
        ticket = Ticket(ticket_);
        gateAccount = gateAccount_;

        address deployer = vm.addr(deployerPk);
        delete members;
        delete tokenIds;
        for (uint256 i; i < DEMO_MEMBERS; ++i) {
            members.push(vm.addr(memberKey(i)));
        }

        vm.startBroadcast(deployerPk);
        orgId = organizers.createOrganizer(deployer);
        eventId = ticket.createEvent(_meta(), _tiers());
        ticket.publishEvent(eventId);
        gateId = organizers.registerGate(eventId, gateAccount, keccak256("gate-kx"), keccak256("gate-ky"));
        organizers.openGate(gateId);
        for (uint256 i; i < members.length; ++i) {
            if (members[i].balance >= memberFundWei) continue;
            (bool sent,) = payable(members[i]).call{value: memberFundWei - members[i].balance}("");
            if (!sent) revert MemberFundingFailed();
        }
        vm.stopBroadcast();

        vm.startBroadcast(attesterPk);
        for (uint256 i; i < members.length; ++i) {
            if (identity.isMember(members[i])) continue;
            identity.register(personId(i), members[i], P256Vectors.DEVICE_X, P256Vectors.DEVICE_Y, DEMO_KYC_LEVEL);
        }
        vm.stopBroadcast();

        // Tier 0, and no voucher: the MVP mints free tiers only (spec 5.2).
        for (uint256 i; i < members.length; ++i) {
            vm.startBroadcast(memberKey(i));
            tokenIds.push(ticket.claim(eventId, 0, ""));
            vm.stopBroadcast();
        }
    }

    /// @notice Records the demo where sub-plans 03 and 04 look for it.
    /// @dev    Public, and called by `run` only under a broadcast, so the tests can write the file on
    ///         their own chain id without a dry run ever reaching the tracked one.
    function record() public {
        string memory path = string.concat("deployments/seed-", vm.toString(block.chainid), ".json");

        string memory obj = "seed";
        vm.serializeUint(obj, "orgId", orgId);
        vm.serializeUint(obj, "eventId", eventId);
        vm.serializeUint(obj, "gateId", gateId);
        vm.serializeAddress(obj, "gateAccount", gateAccount);
        vm.serializeAddress(obj, "members", members);
        string memory out = vm.serializeUint(obj, "tokenIds", tokenIds);

        vm.writeJson(out, path);
        console2.log("wrote", path);
    }

    function memberCount() external view returns (uint256) {
        return members.length;
    }

    /// @dev Deterministic so a re-run finds the same accounts instead of stranding the last run's.
    function memberKey(uint256 index) public pure returns (uint256) {
        return uint256(keccak256(abi.encodePacked(MEMBER_LABEL, index)));
    }

    /// @dev Spec 10.2: a personId is 32 opaque bytes and never a hash of anything about the person.
    ///      These are hashes of a demo label and a counter — no PII goes near them.
    function personId(uint256 index) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(PERSON_LABEL, index));
    }

    function _meta() private view returns (Ticket.EventMeta memory) {
        uint64 nowTs = uint64(block.timestamp);
        return Ticket.EventMeta({
            orgId: orgId,
            titleHash: keccak256("MONTI Demo Night"),
            descHash: keccak256("Monad Metropolis demo event"),
            imageCid: "bafybeigdyrztseedimageplaceholdercid",
            startsAt: nowTs + DOORS_IN,
            endsAt: nowTs + DOORS_IN + RUNS_FOR,
            venueHash: keccak256("Seoul, Gangnam"),
            saleStart: nowTs,
            saleEnd: nowTs + DOORS_IN,
            transferable: true,
            transferCutoffSeconds: 600,
            maxTransfers: 2,
            approvalRequired: false,
            category: 1,
            regionCode: keccak256("KR-11"),
            requireKyc: false
        });
    }

    function _tiers() private pure returns (Ticket.Tier[] memory tiers_) {
        tiers_ = new Ticket.Tier[](1);
        tiers_[0] =
            Ticket.Tier({name: "General", priceUsdCents: 0, supply: 500, minted: 0, maxPerWallet: 2, seated: false});
    }
}
