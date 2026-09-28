// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {Ticket} from "../src/Ticket.sol";
import {P256Vectors} from "../test/utils/P256Vectors.sol";

/// @title MeasureRelayed
/// @notice Measurement tool for plan task F2 (chain-side): produces the exact calldata for the two
///         relayed attendee actions — `claimFor` and `checkInFor` — signed with the public demo device
///         key and the placeholder gate key, so a relayer-like EOA (the deployer) can submit them and
///         the real Monad-testnet gas/MON cost can be read from `cast estimate` + the balance delta.
///
/// @dev    This script never broadcasts. It only *emits calldata* (via console2) that the surrounding
///         shell submits with `cast send`, which is what gives per-tx control over the gas limit
///         (estimate x 1.03), the gas price, and a clean before/after balance delta per transaction.
///
///         Signing lives here because only forge has `vm.signP256`. The digests it signs are exactly the
///         ones the deployed Ticket verifies:
///           - claim  : Ticket.claimAuthDigest(auth)                          <- device key (DEVICE_PRIV)
///           - gate   : sha256(abi.encode(gateId,eventId,issuedAt,nonce))     <- gate key (GATE_PRIV)
///           - device : Ticket.deviceDigest(tokenId,gateId,eventId,nonce,issuedAt) <- device key
///
///         Inputs (env, never written to disk):
///           TICKET     deployed Ticket address (chain 10143)
///           GATE_PRIV  placeholder gate P-256 private scalar, derived from seed-gate-placeholder.pem
///
///         The demo members and their device key are the public seed fixtures (see Seed.s.sol): all
///         three are registered with P256Vectors.DEVICE_* and their private key is public, so anyone can
///         sign a claim/check-in for them. Fixture only — never mainnet.
contract MeasureRelayed is Script {
    uint256 internal constant EVENT_ID = 1;
    uint256 internal constant GATE_ID = 1;
    string internal constant MEMBER_LABEL = "monti.seed.demo.member";
    string internal constant PERSON_LABEL = "monti.seed.demo.person";

    /// @dev Identical to Seed.memberKey so the derived member accounts match the seeded holders.
    function memberKey(uint256 index) public pure returns (uint256) {
        return uint256(keccak256(abi.encodePacked(MEMBER_LABEL, index)));
    }

    /// @dev Identical to Seed.personId; used only to register the extra measurement member.
    function personId(uint256 index) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(PERSON_LABEL, index));
    }

    /// @notice Emits the member address, its personId, and one `claimFor` calldata for member `index`.
    ///         Used to measure a true FIRST claim (cold wallet + cold ERC721 balance slots) with a fresh
    ///         member (index 3), which the seed did not use.
    function genFirstClaim(uint256 index) external view {
        Ticket ticket = Ticket(vm.envAddress("TICKET"));
        address member = vm.addr(memberKey(index));
        console2.log(string.concat("MEMBER ", vm.toString(member)));
        console2.log(string.concat("PERSONID ", vm.toString(personId(index))));
        Ticket.ClaimAuth memory auth = Ticket.ClaimAuth({
            eventId: EVENT_ID,
            tier: 0,
            account: member,
            nonce: ticket.claimNonce(EVENT_ID, member),
            deadline: uint64(block.timestamp + 1 hours)
        });
        (bytes32 r, bytes32 s) = vm.signP256(P256Vectors.DEVICE_PRIV, ticket.claimAuthDigest(auth));
        bytes memory data = abi.encodeCall(Ticket.claimFor, (auth, abi.encode(r, s)));
        console2.log(string.concat("CLAIM ", vm.toString(member), " ", vm.toString(data)));
    }

    /// @notice Emits three `claimFor` calldatas (a 2nd free ticket for each seed member, tier 0).
    function genClaims() external view {
        Ticket ticket = Ticket(vm.envAddress("TICKET"));
        console2.log("MODE claims");
        for (uint256 i; i < 3; ++i) {
            address member = vm.addr(memberKey(i));
            Ticket.ClaimAuth memory auth = Ticket.ClaimAuth({
                eventId: EVENT_ID,
                tier: 0,
                account: member,
                nonce: ticket.claimNonce(EVENT_ID, member),
                deadline: uint64(block.timestamp + 1 hours)
            });
            (bytes32 r, bytes32 s) = vm.signP256(P256Vectors.DEVICE_PRIV, ticket.claimAuthDigest(auth));
            bytes memory data = abi.encodeCall(Ticket.claimFor, (auth, abi.encode(r, s)));
            console2.log(string.concat("CLAIM ", vm.toString(member), " ", vm.toString(data)));
        }
    }

    /// @notice Emits three `checkInFor` calldatas for the seeded unused tokens (1<<96)|1..3, all in
    ///         usedAt serial-word 0. issuedAt is set to the fork's current block time; submit promptly
    ///         (CODE_WINDOW is 60s).
    function genCheckins() external view {
        Ticket ticket = Ticket(vm.envAddress("TICKET"));
        uint256 gatePriv = vm.envUint("GATE_PRIV");
        uint64 issuedAt = uint64(block.timestamp);
        console2.log("MODE checkins");
        console2.log(string.concat("ISSUED_AT ", vm.toString(uint256(issuedAt))));
        for (uint256 i; i < 3; ++i) {
            uint256 tokenId = (EVENT_ID << 96) | (i + 1);
            bytes32 nonce = keccak256(abi.encodePacked("monti.f2.checkin", i, uint256(issuedAt)));
            Ticket.GateCode memory g =
                Ticket.GateCode({gateId: GATE_ID, eventId: EVENT_ID, issuedAt: issuedAt, nonce: nonce});

            bytes32 gateDigest = sha256(abi.encode(g.gateId, g.eventId, g.issuedAt, g.nonce));
            (bytes32 gr, bytes32 gs) = vm.signP256(gatePriv, gateDigest);

            bytes32 devDigest = ticket.deviceDigest(tokenId, GATE_ID, EVENT_ID, nonce, issuedAt);
            (bytes32 dr, bytes32 ds) = vm.signP256(P256Vectors.DEVICE_PRIV, devDigest);

            bytes memory data =
                abi.encodeCall(Ticket.checkInFor, (tokenId, g, abi.encode(gr, gs), abi.encode(dr, ds)));
            console2.log(string.concat("CHECKIN ", vm.toString(tokenId), " ", vm.toString(data)));
        }
    }
}
