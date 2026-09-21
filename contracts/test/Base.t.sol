// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {Test} from "forge-std/Test.sol";
import {Identity} from "../src/Identity.sol";
import {Organizers} from "../src/Organizers.sol";
import {Ticket} from "../src/Ticket.sol";
import {P256Vectors} from "./utils/P256Vectors.sol";

abstract contract MontiTest is Test {
    Identity internal identity;
    Organizers internal organizers;
    Ticket internal ticket;

    uint256 internal constant ATTESTER_PK = 0xA11CE;
    address internal attester;

    address internal constant ORG_OWNER = address(0x0140);
    address internal constant ALICE = address(0xA1);
    address internal constant BOB = address(0xB0B);
    address internal constant CAROL = address(0xCA);
    address internal constant GATE_A = address(0x6A7E);
    address internal constant GATE_B = address(0x6A7F);

    bytes32 internal constant DEV_X = bytes32(uint256(0x1111));
    bytes32 internal constant DEV_Y = bytes32(uint256(0x2222));
    uint64 internal constant T0 = 1_800_000_000;

    function _deployMonti() internal {
        attester = vm.addr(ATTESTER_PK);
        identity = new Identity(attester);
        organizers = new Organizers();
        ticket = new Ticket(address(identity), address(organizers));
        organizers.setTicket(address(ticket));
        vm.warp(T0);
    }

    /// @dev Registers a member whose device key is the generated P-256 vector key, so check-in
    ///      tests (Task 20+) can present real signatures the live 0x100 precompile verifies.
    function _memberWithDeviceKey(address account, uint256 personSeed) internal {
        vm.prank(attester);
        identity.register(bytes32(personSeed), account, P256Vectors.DEVICE_X, P256Vectors.DEVICE_Y, 1);
    }

    /// @dev Default members are fully verified (kycLevel 1).
    function _member(address account, uint256 personSeed) internal {
        _memberWithLevel(account, personSeed, 1);
    }

    function _memberWithLevel(address account, uint256 personSeed, uint8 level) internal {
        vm.prank(attester);
        identity.register(bytes32(personSeed), account, DEV_X, DEV_Y, level);
    }

    function _org() internal returns (uint256 orgId) {
        orgId = organizers.createOrganizer(ORG_OWNER);
    }

    /// @dev One published event, one free tier, sale open now, doors in 1 day, 2-hour transfer cutoff.
    function _freeEvent(uint256 orgId, uint16 maxPerWallet, uint8 maxTransfers, bool transferable)
        internal
        returns (uint256 eventId)
    {
        return _event(orgId, maxPerWallet, maxTransfers, transferable, false);
    }

    /// @dev Same shape, but the organizer demands ID + face verification (kycLevel >= 1).
    function _kycEvent(uint256 orgId) internal returns (uint256 eventId) {
        return _event(orgId, 2, 1, true, true);
    }

    function _event(uint256 orgId, uint16 maxPerWallet, uint8 maxTransfers, bool transferable, bool requireKyc)
        internal
        returns (uint256 eventId)
    {
        Ticket.EventMeta memory m = Ticket.EventMeta({
            orgId: orgId,
            titleHash: keccak256("MONTI Night"),
            descHash: keccak256("a test event"),
            imageCid: "bafyTestCid",
            startsAt: T0 + 1 days,
            endsAt: T0 + 2 days,
            venueHash: keccak256("Seoul"),
            saleStart: T0,
            saleEnd: T0 + 1 days,
            transferable: transferable,
            transferCutoffSeconds: 2 hours,
            maxTransfers: maxTransfers,
            approvalRequired: false,
            category: 0,
            regionCode: keccak256("KR-11"),
            requireKyc: requireKyc
        });
        Ticket.Tier[] memory t = new Ticket.Tier[](1);
        t[0] = Ticket.Tier({
            name: "General", priceUsdCents: 0, supply: 100, minted: 0, maxPerWallet: maxPerWallet, seated: false
        });
        vm.prank(ORG_OWNER);
        eventId = ticket.createEvent(m, t);
        vm.prank(ORG_OWNER);
        ticket.publishEvent(eventId);
    }
}
