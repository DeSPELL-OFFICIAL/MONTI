// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {MontiTest} from "./Base.t.sol";
import {Ticket} from "../src/Ticket.sol";
import {SettlementVault} from "../src/SettlementVault.sol";
import {ISettlementVault} from "../src/interfaces/ISettlementVault.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice v2 C1 — `Ticket.publishEvent(meta, tiers, policy)`: create + (paid) frozen policy + publish in one
///         call (v2 design D2, §4), the one-time vault wiring, and the 1001 event-id offset (D7).
contract TicketPublishTest is MontiTest {
    uint256 internal orgId;
    address internal constant ADMIN = address(0xAD);

    function setUp() public {
        _deployMonti();
        orgId = _org();
    }

    function _tiers(uint256 price) internal pure returns (Ticket.Tier[] memory t) {
        t = new Ticket.Tier[](1);
        t[0] = Ticket.Tier({
            name: "General", priceUsdCents: price, supply: 100, minted: 0, maxPerWallet: 4, seated: false
        });
    }

    // --- free ------------------------------------------------------------------------------------

    function test_freePublish_isPublishedAt1001_andEmitsCreatedThenStatus() public {
        vm.expectEmit(true, true, true, true, address(ticket));
        emit Ticket.EventCreated(1001, orgId, ORG_OWNER);
        vm.expectEmit(true, false, false, true, address(ticket));
        emit Ticket.EventStatusChanged(1001, 1);
        vm.prank(ORG_OWNER);
        uint256 id = ticket.publishEvent(_meta(orgId, 1, true, false), _tiers(0), _emptyPolicy());

        assertEq(id, 1001, "v2 event ids start at 1001");
        assertEq(uint8(ticket.eventStatus(id)), 1, "Published at once, no Draft");
        assertEq(ticket.eventOrg(id), orgId);
        assertEq(ticket.tiers(id)[0].minted, 0);
        assertEq(vault.getPolicy(id).version, 0, "a free event has no policy");

        vm.prank(ORG_OWNER);
        assertEq(ticket.publishEvent(_meta(orgId, 1, true, false), _tiers(0), _emptyPolicy()), 1002);
    }

    function test_freePublish_withPolicy_reverts() public {
        vm.prank(ORG_OWNER);
        vm.expectRevert(Ticket.UnexpectedPolicy.selector);
        ticket.publishEvent(_meta(orgId, 1, true, false), _tiers(0), _goodPolicy());
    }

    function test_freePublish_needsNoVaultCall() public {
        // A free event never touches the vault: publishing works even while the vault is paused.
        vault.setPaused(true);
        vm.prank(ORG_OWNER);
        uint256 id = ticket.publishEvent(_meta(orgId, 1, true, false), _tiers(0), _emptyPolicy());
        assertEq(uint8(ticket.eventStatus(id)), 1);
    }

    // --- paid ------------------------------------------------------------------------------------

    function test_paidPublish_recordsFrozenPolicyInSameTx() public {
        ISettlementVault.SplitPolicy memory p = _goodPolicy();
        p.frozen = false; // caller-supplied lifecycle fields are ignored
        p.version = 7;
        bytes32 h = vault.hashPolicy(p);

        vm.expectEmit(true, true, true, true, address(ticket));
        emit Ticket.EventCreated(1001, orgId, ORG_OWNER);
        vm.expectEmit(true, false, false, true, address(ticket));
        emit Ticket.EventStatusChanged(1001, 1);
        vm.expectEmit(true, true, false, true, address(vault));
        emit ISettlementVault.PolicySet(1001, ORG_OWNER, h, 1);
        vm.prank(ORG_OWNER);
        uint256 id = ticket.publishEvent(_meta(orgId, 1, true, false), _tiers(1000), p);

        ISettlementVault.SplitPolicy memory got = vault.getPolicy(id);
        assertTrue(got.frozen, "frozen at publish");
        assertEq(got.version, 1);
        assertEq(got.recipients.length, 4);
        assertEq(got.recipients[0].account, R_PLATFORM, "row order kept: platform first");
        assertEq(got.platformBps, 500);
        assertEq(ticket.tiers(id)[0].priceUsdCents, 1000, "on-chain price is canonical");
    }

    function test_paidPublish_withoutPolicy_reverts() public {
        vm.prank(ORG_OWNER);
        vm.expectRevert(Ticket.PolicyRequired.selector);
        ticket.publishEvent(_meta(orgId, 1, true, false), _tiers(1000), _emptyPolicy());
    }

    function test_paidPublish_approvalRequired_reverts() public {
        Ticket.EventMeta memory m = _meta(orgId, 1, true, false);
        m.approvalRequired = true;
        vm.prank(ORG_OWNER);
        vm.expectRevert(Ticket.PaidApprovalUnsupported.selector);
        ticket.publishEvent(m, _tiers(1000), _goodPolicy());
    }

    function test_paidPublish_mixedTiers_isPaid() public {
        Ticket.Tier[] memory t = new Ticket.Tier[](2);
        t[0] = Ticket.Tier({name: "Free", priceUsdCents: 0, supply: 10, minted: 0, maxPerWallet: 1, seated: false});
        t[1] = Ticket.Tier({name: "VIP", priceUsdCents: 2500, supply: 10, minted: 0, maxPerWallet: 1, seated: false});
        vm.prank(ORG_OWNER);
        vm.expectRevert(Ticket.PolicyRequired.selector);
        ticket.publishEvent(_meta(orgId, 1, true, false), t, _emptyPolicy());

        vm.prank(ORG_OWNER);
        uint256 id = ticket.publishEvent(_meta(orgId, 1, true, false), t, _goodPolicy());
        assertEq(vault.getPolicy(id).version, 1);
    }

    function test_paidPublish_invalidPolicy_revertsWholePublish() public {
        ISettlementVault.SplitPolicy memory p = _goodPolicy();
        p.recipients[1].bps = 5999; // sum 9999
        vm.prank(ORG_OWNER);
        vm.expectRevert(ISettlementVault.BadSplitSum.selector);
        ticket.publishEvent(_meta(orgId, 1, true, false), _tiers(1000), p);

        // nothing was created: the next id is still 1001
        vm.prank(ORG_OWNER);
        assertEq(ticket.publishEvent(_meta(orgId, 1, true, false), _tiers(0), _emptyPolicy()), 1001);
    }

    function test_paidPublish_platformBelow5pct_reverts() public {
        ISettlementVault.SplitPolicy memory p = _goodPolicy();
        p.recipients[0].bps = 400;
        p.recipients[1].bps = 6100;
        p.platformBps = 400;
        vm.prank(ORG_OWNER);
        vm.expectRevert(ISettlementVault.PlatformShareTooLow.selector);
        ticket.publishEvent(_meta(orgId, 1, true, false), _tiers(1000), p);
    }

    function test_paidPublish_whileVaultPaused_reverts() public {
        vault.setPaused(true);
        vm.prank(ORG_OWNER);
        vm.expectRevert(ISettlementVault.Paused.selector);
        ticket.publishEvent(_meta(orgId, 1, true, false), _tiers(1000), _goodPolicy());
    }

    /// @dev An admin with PERM_CREATE_EVENT (1) but not PERM_MANAGE_SETTLEMENT (64): free publish is fine,
    ///      paid publish is refused by the vault's own permission check.
    function test_paidPublish_adminWithoutSettlementBit_reverts() public {
        vm.prank(ORG_OWNER);
        organizers.setAdmin(orgId, ADMIN, 1);

        vm.prank(ADMIN);
        vm.expectRevert(ISettlementVault.NotPolicyAuthorizer.selector);
        ticket.publishEvent(_meta(orgId, 1, true, false), _tiers(1000), _goodPolicy());

        vm.prank(ADMIN);
        ticket.publishEvent(_meta(orgId, 1, true, false), _tiers(0), _emptyPolicy());

        vm.prank(ORG_OWNER);
        organizers.setAdmin(orgId, ADMIN, 1 | 64);
        vm.prank(ADMIN);
        uint256 id = ticket.publishEvent(_meta(orgId, 1, true, false), _tiers(1000), _goodPolicy());
        assertEq(vault.getPolicy(id).version, 1);
    }

    function test_nonOrganizer_reverts() public {
        vm.prank(BOB);
        vm.expectRevert(Ticket.Unauthorized.selector);
        ticket.publishEvent(_meta(orgId, 1, true, false), _tiers(0), _emptyPolicy());
    }

    function test_invalidTiersAndSchedule_revert() public {
        vm.startPrank(ORG_OWNER);
        vm.expectRevert(Ticket.InvalidTiers.selector);
        ticket.publishEvent(_meta(orgId, 1, true, false), new Ticket.Tier[](0), _emptyPolicy());
        Ticket.EventMeta memory m = _meta(orgId, 1, true, false);
        m.endsAt = m.startsAt;
        vm.expectRevert(Ticket.InvalidSchedule.selector);
        ticket.publishEvent(m, _tiers(0), _emptyPolicy());
        vm.stopPrank();
    }

    /// @dev The organizer's device key signs a forward request; Ticket sees the organizer as _msgSender()
    ///      and hands it to the vault, which records it as the PolicySet organizer.
    function test_paidPublish_viaForwarder() public {
        _memberWithDeviceKey(ORG_OWNER, 0x0140);
        ISettlementVault.SplitPolicy memory p = _goodPolicy();
        bytes memory data = abi.encodeCall(ticket.publishEvent, (_meta(orgId, 1, true, false), _tiers(1000), p));

        vm.expectEmit(true, true, true, true, address(ticket));
        emit Ticket.EventCreated(1001, orgId, ORG_OWNER);
        vm.expectEmit(true, true, false, true, address(vault));
        emit ISettlementVault.PolicySet(1001, ORG_OWNER, vault.hashPolicy(p), 1);
        bytes memory ret = _execFwd(ORG_OWNER, address(ticket), data);

        assertEq(abi.decode(ret, (uint256)), 1001);
        assertEq(uint8(ticket.eventStatus(1001)), 1);
    }

    function test_setPolicyByTicket_onlyTicket() public {
        vm.prank(ORG_OWNER);
        uint256 id = ticket.publishEvent(_meta(orgId, 1, true, false), _tiers(0), _emptyPolicy());
        vm.prank(ORG_OWNER);
        vm.expectRevert(ISettlementVault.NotTicket.selector);
        vault.setPolicyByTicket(id, _goodPolicy(), ORG_OWNER);
    }

    // --- wiring ----------------------------------------------------------------------------------

    function test_setVault_deployerOnce() public {
        assertEq(ticket.deployer(), address(this));
        assertEq(ticket.vault(), address(vault));

        vm.prank(BOB);
        vm.expectRevert(Ticket.NotDeployer.selector);
        ticket.setVault(address(0xBEEF));

        vm.expectRevert(Ticket.VaultAlreadySet.selector);
        ticket.setVault(address(0xBEEF));

        Ticket fresh = new Ticket(address(identity), address(organizers), address(fwd));
        vm.expectRevert(Ticket.ZeroAddress.selector);
        fresh.setVault(address(0));
    }

    function test_vault_rejectsNon6DecimalToken() public {
        MockUSD18 t18 = new MockUSD18();
        vm.expectRevert(ISettlementVault.UnsupportedDecimals.selector);
        vault.setTokenAllowed(address(t18), true);
        vm.expectRevert(ISettlementVault.UnsupportedDecimals.selector);
        new SettlementVault(address(ticket), address(organizers), TREASURY, address(t18));
        vault.setTokenAllowed(address(t18), false); // removal needs no check
    }
}

contract MockUSD18 is ERC20 {
    constructor() ERC20("Eighteen", "E18") {}
}
