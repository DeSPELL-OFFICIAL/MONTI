// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {MontiTest} from "./Base.t.sol";
import {MontiPaymaster} from "../src/MontiPaymaster.sol";
import {MockEntryPoint} from "./mocks/MockEntryPoint.sol";
import {Ticket} from "../src/Ticket.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {IPaymaster} from "account-abstraction/interfaces/IPaymaster.sol";
import {UserOperation} from "account-abstraction/interfaces/UserOperation.sol";
import {IIdentity} from "../src/interfaces/IIdentity.sol";
import {IOrganizers} from "../src/interfaces/IOrganizers.sol";
import {ITicket} from "../src/interfaces/ITicket.sol";

contract PaymasterTest is MontiTest {
    MockEntryPoint internal ep;
    MontiPaymaster internal paymaster;
    uint256 internal orgId;
    uint256 internal eventId;
    uint256 internal tokenId;

    event Deposited(uint256 indexed orgId, uint256 amount);
    event BudgetDebited(uint256 indexed orgId, uint256 amount);
    event SponsorModeSet(uint256 indexed orgId, bool selfSponsored);

    function setUp() public {
        _deployMonti();
        ep = new MockEntryPoint();
        paymaster = new MontiPaymaster(
            IEntryPoint(address(ep)),
            IOrganizers(address(organizers)),
            ITicket(address(ticket)),
            IIdentity(address(identity))
        );
        orgId = _org();
        eventId = _freeEvent(orgId, 2, 1, true);
        _member(ALICE, 0xA11CE);
        vm.prank(ALICE);
        tokenId = ticket.claim(eventId, 0, "");

        vm.deal(address(this), 100 ether);
        vm.deal(ORG_OWNER, 100 ether);
    }

    // --- helpers -------------------------------------------------------------------------------------

    struct Call {
        address target;
        uint256 value;
        bytes data;
    }

    /// @dev The trailing orgId is deliberate: the paymaster must ignore everything after its address.
    function _op(bytes memory callData, uint256 orgId_) internal view returns (UserOperation memory op) {
        op.sender = ALICE;
        op.callData = callData;
        op.paymasterAndData = abi.encodePacked(address(paymaster), uint256(orgId_));
    }

    function _execute(address target, bytes memory inner) internal pure returns (bytes memory) {
        return abi.encodeWithSignature("execute(address,uint256,bytes)", target, uint256(0), inner);
    }

    function _claimCall() internal view returns (bytes memory) {
        return _execute(address(ticket), abi.encodeCall(Ticket.claim, (eventId, 0, "")));
    }

    function _selfSponsor() internal {
        vm.prank(ORG_OWNER);
        paymaster.setSelfSponsored(orgId, true);
    }

    // --- budgets -------------------------------------------------------------------------------------

    function test_platformDepositGoesToBucketZeroAndToTheEntryPoint() public {
        vm.expectEmit(true, false, false, true);
        emit Deposited(paymaster.PLATFORM(), 5 ether);
        paymaster.depositPlatform{value: 5 ether}();

        assertEq(paymaster.budgetOf(0), 5 ether);
        assertEq(ep.balanceOf(address(paymaster)), 5 ether);
    }

    function test_orgDepositIsSeparate() public {
        paymaster.depositPlatform{value: 1 ether}();
        paymaster.deposit{value: 2 ether}(orgId);
        assertEq(paymaster.budgetOf(orgId), 2 ether);
        assertEq(ep.balanceOf(address(paymaster)), 3 ether);
        assertEq(paymaster.budgetOf(0), 3 ether, "the platform slot is the EntryPoint deposit itself");
    }

    function test_depositToAnOrganizerThatDoesNotExistIsRefused() public {
        vm.expectRevert(MontiPaymaster.NoSuchOrganizer.selector);
        paymaster.deposit{value: 1 ether}(999);

        vm.expectRevert(MontiPaymaster.NoSuchOrganizer.selector);
        paymaster.deposit{value: 1 ether}(0);
    }

    function test_onlyOrgOwnerWithdrawsOrgBudget() public {
        paymaster.deposit{value: 2 ether}(orgId);
        vm.prank(BOB);
        vm.expectRevert(MontiPaymaster.Unauthorized.selector);
        paymaster.withdraw(orgId, 1 ether);

        uint256 before = ORG_OWNER.balance;
        vm.prank(ORG_OWNER);
        paymaster.withdraw(orgId, 1 ether);
        assertEq(paymaster.budgetOf(orgId), 1 ether);
        assertEq(ORG_OWNER.balance, before + 1 ether);
    }

    function test_onlyDeployerWithdrawsPlatformBudget() public {
        paymaster.depositPlatform{value: 2 ether}();
        vm.prank(BOB);
        vm.expectRevert(MontiPaymaster.Unauthorized.selector);
        paymaster.withdrawPlatform(BOB, 1 ether);

        paymaster.withdrawPlatform(address(this), 1 ether);
        assertEq(paymaster.budgetOf(0), 1 ether);
    }

    function test_platformWithdrawCannotTouchProjectMoney() public {
        paymaster.depositPlatform{value: 1 ether}();
        paymaster.deposit{value: 2 ether}(orgId);
        vm.expectRevert(MontiPaymaster.BudgetExhausted.selector);
        paymaster.withdrawPlatform(address(this), 1 ether + 1);
    }

    function test_setSelfSponsoredNeedsBudgetPermission() public {
        vm.prank(BOB);
        vm.expectRevert(MontiPaymaster.Unauthorized.selector);
        paymaster.setSelfSponsored(orgId, true);

        vm.expectEmit(true, false, false, true);
        emit SponsorModeSet(orgId, true);
        vm.prank(ORG_OWNER);
        paymaster.setSelfSponsored(orgId, true);
        assertTrue(paymaster.selfSponsored(orgId));
    }

    // --- allowlist -----------------------------------------------------------------------------------

    function test_sponsorsAnAllowlistedClaim() public {
        paymaster.depositPlatform{value: 1 ether}();
        (bytes memory context, uint256 validationData) =
            ep.callValidate(address(paymaster), _op(_claimCall(), 0), bytes32(0), 0.01 ether);

        (uint256 slot, uint256 maxCost) = abi.decode(context, (uint256, uint256));
        assertEq(slot, 0, "platform pays while the org is not self-sponsored");
        assertEq(maxCost, 0.01 ether);
        assertEq(validationData, 0);
        assertEq(paymaster.budgetOf(0), 1 ether, "validation debits nothing");
    }

    function test_refusesNonAllowlistedSelector() public {
        paymaster.depositPlatform{value: 1 ether}();
        bytes memory inner = abi.encodeWithSignature("approve(address,uint256)", BOB, uint256(1));
        vm.expectRevert(MontiPaymaster.SelectorNotAllowed.selector);
        ep.callValidate(address(paymaster), _op(_execute(address(ticket), inner), 0), bytes32(0), 0.01 ether);
    }

    function test_refusesForeignTarget() public {
        paymaster.depositPlatform{value: 1 ether}();
        bytes memory inner = abi.encodeCall(Ticket.claim, (eventId, 0, ""));
        vm.expectRevert(MontiPaymaster.TargetNotAllowed.selector);
        ep.callValidate(address(paymaster), _op(_execute(address(0xDEAD), inner), 0), bytes32(0), 0.01 ether);
    }

    function test_refusesUnknownWalletEntrypoint() public {
        paymaster.depositPlatform{value: 1 ether}();
        bytes memory callData = abi.encodeWithSignature("doSomething(uint256)", uint256(1));
        vm.expectRevert(MontiPaymaster.UnsupportedWalletCall.selector);
        ep.callValidate(address(paymaster), _op(callData, 0), bytes32(0), 0.01 ether);
    }

    function test_executeBatchChecksEveryCall() public {
        paymaster.depositPlatform{value: 1 ether}();
        Call[] memory good = new Call[](2);
        good[0] = Call(address(ticket), 0, abi.encodeCall(Ticket.claim, (eventId, 0, "")));
        good[1] = Call(address(identity), 0, abi.encodeWithSignature("lockDevice(address)", ALICE));
        bytes memory ok = abi.encodeWithSignature("executeBatch((address,uint256,bytes)[])", good);
        ep.callValidate(address(paymaster), _op(ok, 0), bytes32(0), 0.01 ether);

        Call[] memory bad = new Call[](2);
        bad[0] = good[0];
        bad[1] = Call(address(ticket), 0, abi.encodeWithSignature("approve(address,uint256)", BOB, uint256(1)));
        bytes memory mixed = abi.encodeWithSignature("executeBatch((address,uint256,bytes)[])", bad);
        vm.expectRevert(MontiPaymaster.SelectorNotAllowed.selector);
        ep.callValidate(address(paymaster), _op(mixed, 0), bytes32(0), 0.01 ether);
    }

    function test_newSelectorsFromTheProductDeltaAreAllowed() public view {
        assertTrue(paymaster.allowedSelector(bytes4(keccak256("setNickname(bytes32,string)"))));
        assertTrue(paymaster.allowedSelector(bytes4(keccak256("createOffer(uint256,bytes32,uint64)"))));
        assertTrue(paymaster.allowedSelector(bytes4(keccak256("cancelOffer(uint256)"))));
        assertTrue(paymaster.allowedSelector(bytes4(keccak256("acceptOffer(uint256,bytes)"))));
        assertTrue(paymaster.allowedSelector(bytes4(keccak256("publishEvent(uint256)"))));
        assertTrue(paymaster.allowedSelector(bytes4(keccak256("cancelEvent(uint256)"))));
        assertFalse(paymaster.allowedSelector(bytes4(keccak256("createOrganizer(address)"))));
    }

    function test_argKindTableNamesWhereEachIdSits() public view {
        assertEq(
            uint8(paymaster.argKindOf(bytes4(keccak256("claim(uint256,uint8,bytes)")))),
            uint8(MontiPaymaster.ArgKind.EventId)
        );
        assertEq(
            uint8(paymaster.argKindOf(bytes4(keccak256("transferFrom(address,address,uint256)")))),
            uint8(MontiPaymaster.ArgKind.TokenId)
        );
        assertEq(
            uint8(paymaster.argKindOf(bytes4(keccak256("setAdmin(uint256,address,uint32)")))),
            uint8(MontiPaymaster.ArgKind.OrgId)
        );
        assertEq(
            uint8(paymaster.argKindOf(bytes4(keccak256("lockDevice(address)")))), uint8(MontiPaymaster.ArgKind.Platform)
        );
        assertEq(
            uint8(paymaster.argKindOf(bytes4(keccak256("approve(address,uint256)")))),
            uint8(MontiPaymaster.ArgKind.None)
        );
    }

    // --- routing -------------------------------------------------------------------------------------

    function test_platformPaysWhileTheOrgIsNotSelfSponsored() public {
        paymaster.depositPlatform{value: 1 ether}();
        paymaster.deposit{value: 1 ether}(orgId);

        (bytes memory context,) = ep.callValidate(address(paymaster), _op(_claimCall(), 0), bytes32(0), 0.01 ether);
        (uint256 slot,) = abi.decode(context, (uint256, uint256));
        assertEq(slot, 0);

        ep.callPostOp(address(paymaster), IPaymaster.PostOpMode.opSucceeded, context, 0.004 ether);
        assertEq(paymaster.budgetOf(orgId), 1 ether, "project slot untouched");
        assertEq(ep.balanceOf(address(paymaster)), 2 ether - 0.004 ether, "the EntryPoint took the cost");
    }

    function test_selfSponsoredOrgPaysFromItsOwnSlot() public {
        paymaster.depositPlatform{value: 1 ether}();
        paymaster.deposit{value: 1 ether}(orgId);
        _selfSponsor();

        (bytes memory context,) = ep.callValidate(address(paymaster), _op(_claimCall(), 0), bytes32(0), 0.01 ether);
        (uint256 slot,) = abi.decode(context, (uint256, uint256));
        assertEq(slot, orgId, "the event's own project pays");
        assertEq(paymaster.budgetOf(orgId), 1 ether - 0.01 ether, "maxCost is reserved until postOp settles");

        vm.expectEmit(true, false, false, true);
        emit BudgetDebited(orgId, 0.004 ether);
        ep.callPostOp(address(paymaster), IPaymaster.PostOpMode.opSucceeded, context, 0.004 ether);

        assertEq(paymaster.budgetOf(orgId), 1 ether - 0.004 ether, "settled at the real cost, not maxCost");
    }

    function test_senderCannotSpoofTheProjectThroughPaymasterAndData() public {
        // A second, self-sponsored and funded project the sender does not belong to.
        uint256 victim = organizers.createOrganizer(ORG_OWNER);
        paymaster.deposit{value: 1 ether}(victim);
        vm.prank(ORG_OWNER);
        paymaster.setSelfSponsored(victim, true);
        paymaster.depositPlatform{value: 1 ether}();

        // The sender names the victim in paymasterAndData; the call itself names our own event.
        (bytes memory context,) = ep.callValidate(address(paymaster), _op(_claimCall(), victim), bytes32(0), 0.01 ether);
        (uint256 slot,) = abi.decode(context, (uint256, uint256));
        assertEq(slot, 0, "the trailing orgId is ignored");

        ep.callPostOp(address(paymaster), IPaymaster.PostOpMode.opSucceeded, context, 0.004 ether);
        assertEq(paymaster.budgetOf(victim), 1 ether, "another project's budget is untouchable");
    }

    function test_selfSponsoredOrgCannotPushItsCostOntoThePlatform() public {
        paymaster.depositPlatform{value: 1 ether}();
        paymaster.deposit{value: 1 ether}(orgId);
        _selfSponsor();

        // The sender asks for the platform slot; the derived project overrides it.
        (bytes memory context,) = ep.callValidate(address(paymaster), _op(_claimCall(), 0), bytes32(0), 0.01 ether);
        (uint256 slot,) = abi.decode(context, (uint256, uint256));
        assertEq(slot, orgId);
    }

    function test_tokenIdCallsResolveThroughTheTicketsEvent() public {
        paymaster.depositPlatform{value: 1 ether}();
        paymaster.deposit{value: 1 ether}(orgId);
        _selfSponsor();

        bytes memory inner = abi.encodeWithSignature("transferFrom(address,address,uint256)", ALICE, BOB, tokenId);
        (bytes memory context,) =
            ep.callValidate(address(paymaster), _op(_execute(address(ticket), inner), 0), bytes32(0), 0.01 ether);
        (uint256 slot,) = abi.decode(context, (uint256, uint256));
        assertEq(slot, orgId, "tokenId -> eventOf -> eventOrg");
    }

    function test_unknownTicketOrEventIsRefused() public {
        paymaster.depositPlatform{value: 1 ether}();

        bytes memory noToken =
            abi.encodeWithSignature("transferFrom(address,address,uint256)", ALICE, BOB, uint256(999));
        vm.expectRevert(MontiPaymaster.UnknownSponsorTarget.selector);
        ep.callValidate(address(paymaster), _op(_execute(address(ticket), noToken), 0), bytes32(0), 0.01 ether);

        bytes memory noEvent = abi.encodeCall(Ticket.claim, (999, 0, ""));
        vm.expectRevert(MontiPaymaster.UnknownSponsorTarget.selector);
        ep.callValidate(address(paymaster), _op(_execute(address(ticket), noEvent), 0), bytes32(0), 0.01 ether);

        bytes memory noOrg = abi.encodeWithSignature("setAdmin(uint256,address,uint32)", uint256(999), BOB, uint32(1));
        vm.expectRevert(MontiPaymaster.UnknownSponsorTarget.selector);
        ep.callValidate(address(paymaster), _op(_execute(address(organizers), noOrg), 0), bytes32(0), 0.01 ether);
    }

    function test_batchNamingTwoProjectsIsRefused() public {
        paymaster.depositPlatform{value: 1 ether}();
        _selfSponsor();
        uint256 other = organizers.createOrganizer(ORG_OWNER);
        paymaster.deposit{value: 1 ether}(other);
        vm.prank(ORG_OWNER);
        paymaster.setSelfSponsored(other, true);

        Call[] memory calls = new Call[](2);
        calls[0] = Call(address(ticket), 0, abi.encodeCall(Ticket.claim, (eventId, 0, "")));
        calls[1] = Call(
            address(organizers), 0, abi.encodeWithSignature("setAdmin(uint256,address,uint32)", other, BOB, uint32(1))
        );
        bytes memory batch = abi.encodeWithSignature("executeBatch((address,uint256,bytes)[])", calls);

        vm.expectRevert(MontiPaymaster.MixedBatch.selector);
        ep.callValidate(address(paymaster), _op(batch, 0), bytes32(0), 0.01 ether);
    }

    /// @dev Otherwise one cheap call naming a self-sponsored org would bill it for seven platform calls.
    function test_batchMixingAProjectCallWithPlatformCallsIsRefused() public {
        paymaster.depositPlatform{value: 1 ether}();
        paymaster.deposit{value: 1 ether}(orgId);
        _selfSponsor();

        Call[] memory calls = new Call[](2);
        calls[0] = Call(address(ticket), 0, abi.encodeCall(Ticket.claim, (eventId, 0, "")));
        calls[1] = Call(address(identity), 0, abi.encodeWithSignature("lockDevice(address)", ALICE));
        bytes memory batch = abi.encodeWithSignature("executeBatch((address,uint256,bytes)[])", calls);

        vm.expectRevert(MontiPaymaster.MixedBatch.selector);
        ep.callValidate(address(paymaster), _op(batch, 0), bytes32(0), 0.01 ether);
    }

    // --- refusals ------------------------------------------------------------------------------------

    function test_projectBudgetBelowMaxCostIsRefused() public {
        paymaster.deposit{value: 0.01 ether}(orgId);
        _selfSponsor();
        vm.expectRevert(MontiPaymaster.BudgetExhausted.selector);
        ep.callValidate(address(paymaster), _op(_claimCall(), 0), bytes32(0), 0.01 ether + 1);
    }

    /// @dev v0.6 validates every operation of a bundle before executing any of them, so a reservation is
    ///      the only thing that stops one project's slot being promised twice over.
    function test_oneBundleCannotOverCommitAProjectSlot() public {
        paymaster.depositPlatform{value: 10 ether}();
        paymaster.deposit{value: 0.015 ether}(orgId);
        _selfSponsor();

        ep.callValidate(address(paymaster), _op(_claimCall(), 0), bytes32(0), 0.01 ether);
        assertEq(paymaster.budgetOf(orgId), 0.005 ether);

        vm.expectRevert(MontiPaymaster.BudgetExhausted.selector);
        ep.callValidate(address(paymaster), _op(_claimCall(), 0), bytes32(0), 0.01 ether);
    }

    function test_validationNeverCallsTheEntryPoint() public {
        paymaster.depositPlatform{value: 1 ether}();
        paymaster.deposit{value: 1 ether}(orgId);

        // Any EntryPoint call from a validation frame is what a compliant bundler drops (OP-054).
        ep.setRefuseValidationReads(true);
        ep.callValidate(address(paymaster), _op(_claimCall(), 0), bytes32(0), 0.01 ether);

        _selfSponsor();
        ep.callValidate(address(paymaster), _op(_claimCall(), 0), bytes32(0), 0.01 ether);
        ep.setRefuseValidationReads(false);
    }

    function test_senderThatIsNeitherMemberNorGateIsRefused() public {
        paymaster.depositPlatform{value: 1 ether}();
        UserOperation memory op = _op(_claimCall(), 0);
        op.sender = BOB;
        vm.expectRevert(MontiPaymaster.UnknownSender.selector);
        ep.callValidate(address(paymaster), op, bytes32(0), 0.01 ether);
    }

    function test_registeredGateAccountNeedNotBeAMember() public {
        paymaster.depositPlatform{value: 1 ether}();
        vm.prank(ORG_OWNER);
        organizers.registerGate(eventId, GATE_A, DEV_X, DEV_Y);
        assertFalse(identity.isMember(GATE_A), "a gate device is not a person");

        Ticket.GateCode memory g =
            Ticket.GateCode({gateId: organizers.gateOf(GATE_A), eventId: eventId, issuedAt: T0, nonce: bytes32(0)});
        UserOperation memory op = _op(_execute(address(ticket), abi.encodeCall(Ticket.checkIn, (tokenId, g, ""))), 0);
        op.sender = GATE_A;

        (bytes memory context,) = ep.callValidate(address(paymaster), op, bytes32(0), 0.01 ether);
        (uint256 slot,) = abi.decode(context, (uint256, uint256));
        assertEq(slot, 0, "the gate's check-in is sponsored");
    }

    function test_valueBearingCallIsRefused() public {
        paymaster.depositPlatform{value: 1 ether}();
        bytes memory inner = abi.encodeCall(Ticket.claim, (eventId, 0, ""));
        bytes memory withValue =
            abi.encodeWithSignature("execute(address,uint256,bytes)", address(ticket), uint256(1), inner);
        vm.expectRevert(MontiPaymaster.ValueNotAllowed.selector);
        ep.callValidate(address(paymaster), _op(withValue, 0), bytes32(0), 0.01 ether);

        Call[] memory calls = new Call[](1);
        calls[0] = Call(address(ticket), 1 wei, inner);
        bytes memory batch = abi.encodeWithSignature("executeBatch((address,uint256,bytes)[])", calls);
        vm.expectRevert(MontiPaymaster.ValueNotAllowed.selector);
        ep.callValidate(address(paymaster), _op(batch, 0), bytes32(0), 0.01 ether);
    }

    function test_batchLongerThanTheCapIsRefused() public {
        paymaster.depositPlatform{value: 1 ether}();
        uint256 n = paymaster.MAX_BATCH() + 1;
        Call[] memory calls = new Call[](n);
        for (uint256 i; i < n; ++i) {
            calls[i] = Call(address(identity), 0, abi.encodeWithSignature("lockDevice(address)", ALICE));
        }
        bytes memory batch = abi.encodeWithSignature("executeBatch((address,uint256,bytes)[])", calls);
        vm.expectRevert(MontiPaymaster.BatchTooLong.selector);
        ep.callValidate(address(paymaster), _op(batch, 0), bytes32(0), 0.01 ether);

        Call[] memory full = new Call[](paymaster.MAX_BATCH());
        for (uint256 i; i < full.length; ++i) {
            full[i] = Call(address(identity), 0, abi.encodeWithSignature("lockDevice(address)", ALICE));
        }
        ep.callValidate(
            address(paymaster),
            _op(abi.encodeWithSignature("executeBatch((address,uint256,bytes)[])", full), 0),
            bytes32(0),
            0.01 ether
        );
    }

    function test_truncatedCallDataIsRefusedByName() public {
        paymaster.depositPlatform{value: 1 ether}();

        bytes memory shortExecute = abi.encodePacked(bytes4(keccak256("execute(address,uint256,bytes)")), uint256(0));
        vm.expectRevert(MontiPaymaster.BadCallData.selector);
        ep.callValidate(address(paymaster), _op(shortExecute, 0), bytes32(0), 0.01 ether);

        bytes memory shortBatch =
            abi.encodePacked(bytes4(keccak256("executeBatch((address,uint256,bytes)[])")), uint256(32));
        vm.expectRevert(MontiPaymaster.BadCallData.selector);
        ep.callValidate(address(paymaster), _op(shortBatch, 0), bytes32(0), 0.01 ether);
    }

    function test_innerCallWithoutItsArgumentIsRefused() public {
        paymaster.depositPlatform{value: 1 ether}();
        bytes memory inner = abi.encodePacked(bytes4(keccak256("publishEvent(uint256)")));
        vm.expectRevert(MontiPaymaster.BadCallData.selector);
        ep.callValidate(address(paymaster), _op(_execute(address(ticket), inner), 0), bytes32(0), 0.01 ether);
    }

    function test_onlyEntryPointMayValidate() public {
        paymaster.depositPlatform{value: 1 ether}();
        vm.expectRevert(MontiPaymaster.NotEntryPoint.selector);
        paymaster.validatePaymasterUserOp(_op(_claimCall(), 0), bytes32(0), 0.01 ether);
    }

    function test_onlyEntryPointMayCallPostOp() public {
        vm.expectRevert(MontiPaymaster.NotEntryPoint.selector);
        paymaster.postOp(IPaymaster.PostOpMode.opSucceeded, abi.encode(uint256(0), uint256(0)), 0);
    }

    // --- postOp --------------------------------------------------------------------------------------

    function test_postOpNeverSettlesMoreThanWasReserved() public {
        paymaster.deposit{value: 1 ether}(orgId);
        _selfSponsor();

        (bytes memory context,) = ep.callValidate(address(paymaster), _op(_claimCall(), 0), bytes32(0), 0.01 ether);
        // The EntryPoint cannot report more than the prefund it took, but the cap is what enforces it.
        vm.prank(address(ep));
        paymaster.postOp(IPaymaster.PostOpMode.opSucceeded, context, 0.5 ether);
        assertEq(paymaster.budgetOf(orgId), 1 ether - 0.01 ether, "the reservation is the ceiling");
    }

    function test_postOpSettlesInEveryMode() public {
        paymaster.deposit{value: 1 ether}(orgId);
        _selfSponsor();

        (bytes memory first,) = ep.callValidate(address(paymaster), _op(_claimCall(), 0), bytes32(0), 0.01 ether);
        ep.callPostOp(address(paymaster), IPaymaster.PostOpMode.opReverted, first, 0.004 ether);

        (bytes memory second,) = ep.callValidate(address(paymaster), _op(_claimCall(), 0), bytes32(0), 0.01 ether);
        ep.callPostOp(address(paymaster), IPaymaster.PostOpMode.postOpReverted, second, 0.004 ether);

        assertEq(paymaster.budgetOf(orgId), 1 ether - 0.008 ether, "a reverted op still burned gas");
    }

    function testFuzz_postOpNeverReverts(uint8 rawMode, uint256 slot, uint256 maxCost, uint256 actualGasCost) public {
        paymaster.deposit{value: 1 ether}(orgId);
        IPaymaster.PostOpMode mode = IPaymaster.PostOpMode(rawMode % 3);

        vm.prank(address(ep));
        paymaster.postOp(mode, abi.encode(slot, maxCost), actualGasCost);
    }

    receive() external payable {}
}
