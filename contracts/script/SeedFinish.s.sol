// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {Identity} from "../src/Identity.sol";
import {Ticket} from "../src/Ticket.sol";
import {P256Vectors} from "../test/utils/P256Vectors.sol";

/// @title SeedFinish
/// @notice Completes an interrupted `Seed` run: registers the demo members and mints their tickets on an
///         event that already exists, without re-creating the organizer, event or gate. Used on
///         2026-09-29 after a Monad basefee-drift failure ("gas price is less than basefee") stopped
///         `Seed.s.sol` mid-run -- the organizer, event (published) and gate (open) were already on chain,
///         but no member was registered and no ticket was claimed.
///
/// @dev    Deliberately narrow: it reuses `Seed`'s member/person key derivation and the public demo
///         device key (`P256Vectors.DEVICE_*`) so the token ids match what `Seed` already wrote to
///         `deployments/seed-<chainid>.json`. Claims go through `Ticket.claimFor`, submitted by the
///         deployer acting as the relayer (claimFor is permissionless), so the counterfactual demo
///         members never need a balance. Idempotent: a member already registered is skipped, and a member
///         that has already claimed (`claimNonce > 0`) is skipped so a re-run cannot double-mint.
///
///           DEPLOYER_PK    broadcast key; the relayer that submits each claim
///           ATTESTER_PK    the key behind Identity.attester; the only account that may register
///           SEED_EVENT_ID  optional, defaults to 1 — the published event whose gate is open
contract SeedFinish is Script {
    uint256 public constant DEMO_MEMBERS = 3;
    uint8 public constant DEMO_KYC_LEVEL = 1;
    string internal constant MEMBER_LABEL = "monti.seed.demo.member";
    string internal constant PERSON_LABEL = "monti.seed.demo.person";

    function run() external {
        uint256 deployerPk = vm.envUint("DEPLOYER_PK");
        uint256 attesterPk = vm.envUint("ATTESTER_PK");
        uint256 eventId = vm.envOr("SEED_EVENT_ID", uint256(1));

        string memory raw = vm.readFile(string.concat("deployments/", vm.toString(block.chainid), ".json"));
        Identity identity = Identity(vm.parseJsonAddress(raw, ".identity"));
        Ticket ticket = Ticket(vm.parseJsonAddress(raw, ".ticket"));

        require(vm.addr(attesterPk) == identity.attester(), "ATTESTER_PK does not match Identity.attester()");

        // Register any demo member not yet registered (attester only).
        vm.startBroadcast(attesterPk);
        for (uint256 i; i < DEMO_MEMBERS; ++i) {
            address m = vm.addr(memberKey(i));
            if (!identity.isMember(m)) {
                identity.register(personId(i), m, P256Vectors.DEVICE_X, P256Vectors.DEVICE_Y, DEMO_KYC_LEVEL);
            }
        }
        vm.stopBroadcast();

        // Each member's ticket is claimed with the member's device signature and submitted by the relayer.
        for (uint256 i; i < DEMO_MEMBERS; ++i) {
            address m = vm.addr(memberKey(i));
            uint256 nonce = ticket.claimNonce(eventId, m);
            if (nonce != 0) {
                console2.log("member", m, "already claimed; skipping");
                continue;
            }
            Ticket.ClaimAuth memory auth = Ticket.ClaimAuth({
                eventId: eventId, tier: 0, account: m, nonce: nonce, deadline: uint64(block.timestamp + 1 hours)
            });
            (bytes32 r, bytes32 s) = vm.signP256(P256Vectors.DEVICE_PRIV, ticket.claimAuthDigest(auth));
            vm.broadcast(deployerPk);
            uint256 tokenId = ticket.claimFor(auth, abi.encode(r, s));
            console2.log("member", m, "holds ticket", tokenId);
        }
    }

    /// @dev Identical to Seed.memberKey / Seed.personId so the accounts and person ids line up.
    function memberKey(uint256 index) public pure returns (uint256) {
        return uint256(keccak256(abi.encodePacked(MEMBER_LABEL, index)));
    }

    function personId(uint256 index) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(PERSON_LABEL, index));
    }
}
