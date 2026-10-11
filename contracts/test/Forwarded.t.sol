// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {MontiTest} from "./Base.t.sol";
import {MontiForwarder} from "../src/MontiForwarder.sol";
import {Organizers} from "../src/Organizers.sol";
import {Ticket} from "../src/Ticket.sol";
import {P256Vectors} from "./utils/P256Vectors.sol";

/// @notice A2 — the relayed actions routed through _msgSender() on the REAL targets. Base.t.sol wires a
///         live MontiForwarder (fwd) to the real Ticket/Organizers/Identity, so these prove that the
///         appended 20-byte `from` is the address the permission checks see (design §2), and that a
///         direct EOA cannot spoof by appending 20 bytes to its own call (only the forwarder is trusted).
contract ForwardedTest is MontiTest {
    address internal constant ATTACKER = address(0xBADBAD);

    function setUp() public {
        _deployMonti();
        _member(ALICE, 0xA1A1);
        _member(BOB, 0xB0B0);
        _member(ORG_OWNER, 0x0140);
    }

    function _meta(uint256 orgId) internal view returns (Ticket.EventMeta memory m, Ticket.Tier[] memory t) {
        m = Ticket.EventMeta({
            orgId: orgId,
            titleHash: keccak256("Relayed Night"),
            descHash: keccak256("forwarded"),
            imageCid: "bafyTestCid",
            startsAt: T0 + 1 days,
            endsAt: T0 + 2 days,
            venueHash: keccak256("Seoul"),
            saleStart: T0,
            saleEnd: T0 + 1 days,
            transferable: true,
            transferCutoffSeconds: 2 hours,
            maxTransfers: 2,
            approvalRequired: false,
            category: 0,
            regionCode: keccak256("KR-11"),
            requireKyc: false
        });
        t = new Ticket.Tier[](1);
        t[0] = Ticket.Tier({name: "General", priceUsdCents: 0, supply: 100, minted: 0, maxPerWallet: 5, seated: false});
    }

    // --- happy paths through the forwarder --------------------------------------------------------

    /// @notice An organizer owner publishes an event in one forwarded call (v2 D2); the Ticket sees the
    ///         appended owner in _msgSender(), so the permission check passes.
    function test_forwarded_organizerCreatesAndPublishesEvent() public {
        uint256 orgId = _org();
        (Ticket.EventMeta memory m, Ticket.Tier[] memory t) = _meta(orgId);

        bytes memory ret =
            _execFwd(ORG_OWNER, address(ticket), abi.encodeCall(Ticket.publishEvent, (m, t, _emptyPolicy())));
        uint256 eventId = abi.decode(ret, (uint256));

        assertEq(ticket.eventOrg(eventId), orgId, "event bound to the org the owner controls");
        assertEq(uint8(ticket.eventStatus(eventId)), uint8(Ticket.EventStatus.Published), "published via forwarder");
    }

    /// @notice An attendee opens a transfer offer via execute; the offer records the appended sender as
    ///         its owner, proving ownerOf(tokenId) == _msgSender() saw the attendee, not the relayer.
    function test_forwarded_attendeeCreatesOffer() public {
        uint256 orgId = _org();
        uint256 eventId = _freeEvent(orgId, 5, 2, true);
        uint256 tokenId = _claimForFixture(ALICE, eventId);

        bytes memory data = abi.encodeCall(Ticket.createOffer, (tokenId, keccak256("recipient"), uint64(T0 + 12 hours)));
        _execFwd(ALICE, address(ticket), data);

        assertEq(ticket.offerOf(tokenId).from, ALICE, "offer attributed to the appended attendee, not RELAYER");
    }

    // --- permission is enforced against the appended sender ---------------------------------------

    /// @notice A member with no create permission is rejected when the request carries their address,
    ///         and the target's Unauthorized error bubbles back through the forwarder unchanged.
    function test_forwarded_memberWithoutPermissionRejected() public {
        uint256 orgId = _org();
        (Ticket.EventMeta memory m, Ticket.Tier[] memory t) = _meta(orgId);

        // Build the request/signature outside the expectRevert window (their view calls would eat it).
        MontiForwarder.ForwardRequest memory r =
            _fwdReq(BOB, address(ticket), abi.encodeCall(Ticket.publishEvent, (m, t, _emptyPolicy())));
        bytes memory sig = _fwdSign(r);

        vm.prank(RELAYER);
        vm.expectRevert(Ticket.Unauthorized.selector);
        fwd.execute(r, sig);
    }

    // --- direct EOA calls (no forwarder) ----------------------------------------------------------

    /// @notice A deployer-guarded setter still works as a plain direct call (raw msg.sender kept).
    function test_direct_deployerPathStillWorks() public {
        Organizers fresh = new Organizers(address(fwd)); // deployer = this test contract
        fresh.setTicket(address(ticket));
        assertEq(fresh.ticket(), address(ticket), "deployer's direct setTicket still succeeds");
    }

    /// @notice A random EOA that appends 20 bytes to its OWN call cannot impersonate the owner: only the
    ///         trusted forwarder's suffix is honoured, so _msgSender() stays the attacker and it reverts.
    function test_direct_randomEOACannotSpoofAppendedSender() public {
        uint256 orgId = _org(); // owner = ORG_OWNER

        // Same shape the forwarder uses: data ‖ from. But the caller is not the trusted forwarder.
        bytes memory spoof =
            abi.encodePacked(abi.encodeCall(Organizers.setAdmin, (orgId, ATTACKER, uint32(0xFFFF))), ORG_OWNER);

        vm.prank(ATTACKER);
        (bool ok,) = address(organizers).call(spoof);

        assertFalse(ok, "appended sender is ignored for a non-forwarder caller");
        assertEq(organizers.adminBitsOf(orgId, ATTACKER), 0, "attacker gained no admin bits");
    }
}
