// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {Script} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {console2} from "forge-std/console2.sol";
import {LibString} from "solady/utils/LibString.sol";
import {Identity} from "../src/Identity.sol";
import {Organizers} from "../src/Organizers.sol";
import {Ticket} from "../src/Ticket.sol";
import {MontiForwarder} from "../src/MontiForwarder.sol";
import {P256Vectors} from "../test/utils/P256Vectors.sol";

/// @title Seed
/// @notice The demo MONTI runs on: one organizer, one published event with one free tier, one open gate,
///         and a handful of registered members each holding a ticket on it. The ids land in
///         `deployments/seed-<chainid>.json`, which is the file sub-plans 03 (attendee app) and 04 (staff
///         device) open on — their first screens run on these values with nothing else to set up.
///
/// @dev    Reads the stack out of Task 30's `deployments/<chainid>.json`, so it is run after Deploy and
///         never instead of it.
///
///         Everything runs the way Phase 2 does on chain (design 2026-09-29 relayed phase 2, sections 2
///         and 3): there is no smart-account pre-deploy and no per-member gas funding. The organizer owner
///         and every demo member are counterfactual addresses the attester registers in Identity, each
///         bound to the public demo device key. Organizer actions (createOrganizer, createEvent,
///         publishEvent, registerGate, openGate) go through `MontiForwarder.execute`, signed by the
///         owner's device key and submitted by the deployer acting as the relayer. Ticket claims go
///         through `Ticket.claimFor` with each member's device signature, also submitted by the deployer.
///         Because both the forward requests and the claims are permissionless, the deployer pays every
///         transaction and the counterfactual accounts never need a balance.
///
///         Inputs come from the environment only, so no key is ever written into this repository:
///           DEPLOYER_PK      broadcast key; the relayer that submits every forward request and claim
///           ATTESTER_PK      the key behind Identity's attester; the only account that may register
///           GATE_ACCOUNT     the staff device's account, which becomes this event's open gate
///           SEED_GATE_KX     the gate device's P-256 public key X, as 0x-prefixed 32 bytes. The
///           SEED_GATE_KY     attendee phone verifies the gate's signature against these before it
///                            writes anything back (spec 7.2 step 3, T14 defence 1), so a placeholder
///                            here means that defence does not exist on the demo gate. Required, and
///                            generated on the Android device by sub-plan 04
///           SEED_IMAGE_CID   the demo event's metadata JSON, pinned to Pinata before the seed is run:
///                            `{ name, description, image }`, which is where the attendee app reads the
///                            event's name and picture from. Required — the chain has only the hashes
contract Seed is Script {
    /// @notice Enough demo attendees to show a list rather than a single row, few enough to seed in one
    ///         run on a testnet.
    uint256 public constant DEMO_MEMBERS = 3;

    /// @notice Spec 9.2's verified level: the demo attendees pass an event that demands ID and face.
    uint8 public constant DEMO_KYC_LEVEL = 1;

    /// @notice A base32 CIDv1 of a sha2-256 digest, which is what Pinata hands back.
    uint256 public constant CID_LENGTH = 59;

    /// @notice The demo event opens its doors a month out and sells until then, so one seeding lasts the
    ///         hackathon. An event that ended the same afternoon would take sub-plans 03 and 04 down
    ///         with it — `claim` closes with the sale and `checkIn` refuses an event that has ended.
    uint64 public constant DOORS_IN = 30 days;
    uint64 public constant RUNS_FOR = 1 days;

    /// @dev Demo accounts, and nothing else, ever: the labels are public, so anyone can derive these keys.
    ///      The organizer owner and all three members are registered with the same public P-256 device key
    ///      (P256Vectors.DEVICE_X/Y), whose private key is printed in script/gen-p256-vectors.mjs. Anyone
    ///      who reads this repository can sign a forward request or a check-in for any of them. **This
    ///      must never reach mainnet** -- it is a fixture for sub-plans 03 and 04 to tap against, not an
    ///      account model. The real organizer and attendee phones register their own passkey accounts.
    string internal constant OWNER_LABEL = "monti.seed.demo.organizer";
    string internal constant MEMBER_LABEL = "monti.seed.demo.member";
    string internal constant PERSON_LABEL = "monti.seed.demo.person";

    Identity public identity;
    Organizers public organizers;
    Ticket public ticket;
    MontiForwarder public forwarder;

    address public organizerOwner;
    address public gateAccount;
    uint256 public orgId;
    uint256 public eventId;
    uint256 public gateId;

    address[] public members;
    uint256[] public tokenIds;

    /// @notice The deployments file still holds zeros, so Deploy has not run on this chain yet.
    error StackNotDeployed();

    function run() external {
        uint256 deployerPk = vm.envUint("DEPLOYER_PK");
        uint256 attesterPk = vm.envUint("ATTESTER_PK");
        address gate = vm.envAddress("GATE_ACCOUNT");
        // No default, and no placeholder: see the header. A gate the attendee phone cannot verify is a
        // gate that check-in defence 1 does not cover.
        bytes32 gateKx = vm.envBytes32("SEED_GATE_KX");
        bytes32 gateKy = vm.envBytes32("SEED_GATE_KY");
        // No default: an event whose metadata is not pinned yet has no name and no image on the
        // attendee's screen, and the founder is the only one who can pin it.
        string memory imageCid = vm.envString("SEED_IMAGE_CID");

        string memory raw = vm.readFile(string.concat("deployments/", vm.toString(block.chainid), ".json"));
        seed(
            vm.parseJsonAddress(raw, ".identity"),
            vm.parseJsonAddress(raw, ".organizers"),
            vm.parseJsonAddress(raw, ".ticket"),
            vm.parseJsonAddress(raw, ".forwarder"),
            gate,
            gateKx,
            gateKy,
            imageCid,
            deployerPk,
            attesterPk
        );

        console2.log("organizerOwner", organizerOwner);
        console2.log("orgId       ", orgId);
        console2.log("eventId     ", eventId);
        console2.log("gateId      ", gateId);
        console2.log("gateAccount ", gateAccount);
        for (uint256 i; i < members.length; ++i) {
            console2.log("member      ", members[i], "holds ticket", tokenIds[i]);
        }

        record();
    }

    /// @notice Registers the organizer owner and the demo members, then creates the organizer, event and
    ///         gate through the forwarder and claims a ticket for each member.
    /// @dev    Separate from `run` so the tests can drive it without the deployments file. Re-running is
    ///         part of the job: the founder seeds again with the real staff device's account once it
    ///         exists, because `Organizers.registerGate` takes a gate account exactly once. That second
    ///         run gets its own organizer, event and gate, and steps over the members the first run
    ///         already registered.
    function seed(
        address identity_,
        address organizers_,
        address ticket_,
        address forwarder_,
        address gateAccount_,
        bytes32 gateKx_,
        bytes32 gateKy_,
        string memory imageCid_,
        uint256 deployerPk,
        uint256 attesterPk
    ) public {
        if (identity_ == address(0) || organizers_ == address(0) || ticket_ == address(0) || forwarder_ == address(0)) {
            revert StackNotDeployed();
        }
        _requireGateKey(gateKx_, gateKy_);
        _requireCid(imageCid_);

        identity = Identity(identity_);
        organizers = Organizers(organizers_);
        ticket = Ticket(ticket_);
        forwarder = MontiForwarder(forwarder_);
        gateAccount = gateAccount_;

        // Identity.register takes writes from the attester and nobody else, so a mismatched key does not
        // fail here but many calls deep, on the first member, as an opaque NotAttester.
        require(vm.addr(attesterPk) == identity.attester(), "ATTESTER_PK does not match Identity.attester()");

        organizerOwner = vm.addr(ownerKey());
        delete members;
        delete tokenIds;
        for (uint256 i; i < DEMO_MEMBERS; ++i) {
            members.push(vm.addr(memberKey(i)));
        }

        // A redeploy keeps the Organizers, whose org and demo gate already exist. SEED_REUSE_ORG makes
        // the seed reuse org SEED_ORG_ID (default 1, owned by the demo organizer owner) instead of
        // creating a second one -- createOrganizer would otherwise orphan org 1 and misnumber
        // seed-<chainid>.json.
        bool reuseOrg = vm.envOr("SEED_REUSE_ORG", false);

        // The attester registers the organizer owner and every member as counterfactual accounts, all
        // bound to the public demo device key so their forward-request and claim signatures verify. This
        // must precede the forward requests: the forwarder rejects a `from` that is not an Identity member.
        vm.startBroadcast(attesterPk);
        if (!identity.isMember(organizerOwner)) {
            identity.register(
                ownerPersonId(), organizerOwner, P256Vectors.DEVICE_X, P256Vectors.DEVICE_Y, DEMO_KYC_LEVEL
            );
        }
        for (uint256 i; i < members.length; ++i) {
            if (identity.isMember(members[i])) continue;
            identity.register(personId(i), members[i], P256Vectors.DEVICE_X, P256Vectors.DEVICE_Y, DEMO_KYC_LEVEL);
        }
        vm.stopBroadcast();

        // Organizer actions run through the forwarder, signed by the owner's device key and submitted by
        // the deployer as the relayer. createOrganizer is permissionless; the rest resolve `_msgSender()`
        // to the owner, who owns the org and so passes every permission check.
        if (reuseOrg) {
            orgId = vm.envOr("SEED_ORG_ID", uint256(1));
        } else {
            orgId = abi.decode(
                _relay(deployerPk, organizers_, abi.encodeCall(Organizers.createOrganizer, (organizerOwner))), (uint256)
            );
        }
        eventId = abi.decode(
            _relay(deployerPk, ticket_, abi.encodeCall(Ticket.createEvent, (_meta(imageCid_), _tiers()))), (uint256)
        );
        _relay(deployerPk, ticket_, abi.encodeCall(Ticket.publishEvent, (eventId)));

        // registerGate takes a gate account exactly once (GateAccountInUse). On a kept Organizers the
        // demo gate is already registered and bound to event 1 -- which the new Ticket's first event also
        // is -- so it is reused rather than re-registered; a fresh Organizers has none and registers one.
        uint256 existingGate = organizers.gateOf(gateAccount);
        if (existingGate != 0) {
            gateId = existingGate;
        } else {
            gateId = abi.decode(
                _relay(
                    deployerPk,
                    organizers_,
                    abi.encodeCall(Organizers.registerGate, (eventId, gateAccount, gateKx_, gateKy_))
                ),
                (uint256)
            );
            _relay(deployerPk, organizers_, abi.encodeCall(Organizers.openGate, (gateId)));
        }

        // Tier 0, and no voucher: the MVP mints free tiers only (spec 5.2). Every demo member is
        // registered with the public demo device key (P256Vectors.DEVICE_*), so signing the ClaimAuth
        // with that key (DEVICE_PRIV) lets the relayer submit the claim on the member's behalf.
        // **메인넷 금지** — 공개 키 픽스처다.
        for (uint256 i; i < members.length; ++i) {
            Ticket.ClaimAuth memory auth = Ticket.ClaimAuth({
                eventId: eventId,
                tier: 0,
                account: members[i],
                nonce: ticket.claimNonce(eventId, members[i]),
                deadline: uint64(block.timestamp + 1 hours)
            });
            (bytes32 r, bytes32 s) = vm.signP256(P256Vectors.DEVICE_PRIV, ticket.claimAuthDigest(auth));
            vm.broadcast(deployerPk);
            tokenIds.push(ticket.claimFor(auth, abi.encode(r, s)));
        }
    }

    /// @notice Records the demo where sub-plans 03 and 04 look for it.
    /// @dev    The broadcast gate is inside this function rather than at its call site, because
    ///         `forge script --sig 'record()'` reaches it directly: a dry run of that signature would
    ///         otherwise flatten the tracked deployments/seed-10143.json with the zeros of a script that
    ///         seeded nothing. A dry run of `run` is the same hazard — it simulates the whole seeding but
    ///         leaves no event on chain. Only a real broadcast earns the write. Tests reach the writing
    ///         half through a harness, so no public entry point can be pointed at an arbitrary path.
    function record() public {
        if (!vm.isContext(VmSafe.ForgeContext.ScriptBroadcast)) {
            console2.log("not a broadcast: nothing was recorded");
            return;
        }
        _record(string.concat("deployments/seed-", vm.toString(block.chainid), ".json"));
    }

    function _record(string memory path) internal {
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

    /// @dev Deterministic so a re-run finds the same organizer instead of stranding the last run's.
    function ownerKey() public pure returns (uint256) {
        return uint256(keccak256(abi.encodePacked(OWNER_LABEL)));
    }

    /// @dev Deterministic so a re-run finds the same accounts instead of stranding the last run's.
    function memberKey(uint256 index) public pure returns (uint256) {
        return uint256(keccak256(abi.encodePacked(MEMBER_LABEL, index)));
    }

    /// @dev Spec 10.2: a personId is 32 opaque bytes and never a hash of anything about the person.
    ///      These are hashes of a demo label and a counter — no PII goes near them.
    function ownerPersonId() public pure returns (bytes32) {
        return keccak256(abi.encodePacked(PERSON_LABEL, OWNER_LABEL));
    }

    function personId(uint256 index) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(PERSON_LABEL, index));
    }

    /// @dev Signs a forward request as the organizer owner's device key and submits it as the relayer.
    ///      The nonce and digest are read outside the broadcast window so the cheatcodes do not consume
    ///      it; the single broadcast is the `execute` transaction itself. Returns the target's return
    ///      data (the forwarder bubbles it verbatim), which the caller decodes for createOrganizer /
    ///      createEvent / registerGate and ignores for the void calls.
    function _relay(uint256 relayerPk, address to, bytes memory data) internal returns (bytes memory) {
        MontiForwarder.ForwardRequest memory req = MontiForwarder.ForwardRequest({
            from: organizerOwner,
            to: to,
            nonce: forwarder.nonces(organizerOwner),
            deadline: uint64(block.timestamp + 1 hours),
            data: data
        });
        (bytes32 r, bytes32 s) = vm.signP256(P256Vectors.DEVICE_PRIV, forwarder.forwardDigest(req));
        vm.broadcast(relayerPk);
        return forwarder.execute(req, abi.encode(r, s));
    }

    /// @dev Organizers.registerGate refuses a half-zero key, but only after the organizer, the event
    ///      and the gate are already on chain, and as an opaque InvalidGateKey. An unset
    ///      SEED_GATE_KX/KY arrives here as a zero word, so this is where the founder is told which
    ///      variable is empty -- before anything is broadcast.
    function _requireGateKey(bytes32 kx, bytes32 ky) private pure {
        require(
            kx != bytes32(0) && ky != bytes32(0),
            "SEED_GATE_KX and SEED_GATE_KY must be the gate device's P-256 public key"
        );
    }

    /// @dev The chain carries only `titleHash` and `descHash`, so this CID is where the attendee app
    ///      gets the event's name and picture from (sub-plan 03 reads it as the metadata JSON's CID).
    ///      A base32 CIDv1 of a sha2-256 digest is 59 characters and starts with `bafy` (dag-pb) or
    ///      `bafk` (raw leaf, what Pinata's v3 upload returns for small files) — anything else is a
    ///      placeholder that would leave the demo event nameless on the first screen.
    function _requireCid(string memory cid) private pure {
        require(bytes(cid).length == CID_LENGTH, "SEED_IMAGE_CID must be a 59-character base32 CIDv1");
        require(
            LibString.startsWith(cid, "bafy") || LibString.startsWith(cid, "bafk"),
            "SEED_IMAGE_CID must be a base32 CIDv1 starting with bafy or bafk"
        );
    }

    function _meta(string memory imageCid_) private view returns (Ticket.EventMeta memory) {
        uint64 nowTs = uint64(block.timestamp);
        return Ticket.EventMeta({
            orgId: orgId,
            titleHash: keccak256("MONTI Demo Night"),
            descHash: keccak256("Monad Metropolis demo event"),
            imageCid: imageCid_,
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
