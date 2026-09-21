// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {MontiTest} from "./Base.t.sol";
import {MontiPaymaster} from "../src/MontiPaymaster.sol";
import {MockEntryPoint} from "./mocks/MockEntryPoint.sol";
import {Ticket} from "../src/Ticket.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {IPaymaster} from "account-abstraction/interfaces/IPaymaster.sol";
import {UserOperation} from "account-abstraction/interfaces/UserOperation.sol";
import {IOrganizers} from "../src/interfaces/IOrganizers.sol";

contract PaymasterTest is MontiTest {
    MockEntryPoint internal ep;
    MontiPaymaster internal paymaster;
    uint256 internal orgId;

    event Deposited(uint256 indexed orgId, uint256 amount);
    event SponsorModeSet(uint256 indexed orgId, bool selfSponsored);

    function setUp() public {
        _deployMonti();
        ep = new MockEntryPoint();
        paymaster = new MontiPaymaster(IEntryPoint(address(ep)), IOrganizers(address(organizers)));
        paymaster.setTargets(address(ticket), address(identity));
        orgId = _org();
        vm.deal(address(this), 100 ether);
        vm.deal(ORG_OWNER, 100 ether);
    }

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
        assertEq(paymaster.budgetOf(0), 1 ether);
        assertEq(paymaster.budgetOf(orgId), 2 ether);
        assertEq(ep.balanceOf(address(paymaster)), 3 ether);
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
        paymaster.withdraw(0, 1 ether);
        paymaster.withdraw(0, 1 ether);
        assertEq(paymaster.budgetOf(0), 1 ether);
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

    struct Call {
        address target;
        uint256 value;
        bytes data;
    }

    function _op(bytes memory callData, uint256 orgId_) internal view returns (UserOperation memory op) {
        op.sender = ALICE;
        op.callData = callData;
        op.paymasterAndData = abi.encodePacked(address(paymaster), uint256(orgId_));
    }

    function _execute(address target, bytes memory inner) internal pure returns (bytes memory) {
        return abi.encodeWithSignature("execute(address,uint256,bytes)", target, uint256(0), inner);
    }

    function test_sponsorsAnAllowlistedClaim() public {
        paymaster.depositPlatform{value: 1 ether}();
        bytes memory inner = abi.encodeCall(Ticket.claim, (1, 0, ""));
        (bytes memory context, uint256 validationData) =
            ep.callValidate(address(paymaster), _op(_execute(address(ticket), inner), 0), bytes32(0), 0.01 ether);

        assertEq(context.length, 0, "no context means postOp is never called");
        assertEq(validationData, 0);
    }

    function test_refusesNonAllowlistedSelector() public {
        paymaster.depositPlatform{value: 1 ether}();
        bytes memory inner = abi.encodeWithSignature("approve(address,uint256)", BOB, uint256(1));
        vm.expectRevert(MontiPaymaster.SelectorNotAllowed.selector);
        ep.callValidate(address(paymaster), _op(_execute(address(ticket), inner), 0), bytes32(0), 0.01 ether);
    }

    function test_refusesForeignTarget() public {
        paymaster.depositPlatform{value: 1 ether}();
        bytes memory inner = abi.encodeCall(Ticket.claim, (1, 0, ""));
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
        good[0] = Call(address(ticket), 0, abi.encodeCall(Ticket.claim, (1, 0, "")));
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

    function test_onlyEntryPointMayValidate() public {
        paymaster.depositPlatform{value: 1 ether}();
        bytes memory inner = abi.encodeCall(Ticket.claim, (1, 0, ""));
        vm.expectRevert(MontiPaymaster.NotEntryPoint.selector);
        paymaster.validatePaymasterUserOp(_op(_execute(address(ticket), inner), 0), bytes32(0), 0.01 ether);
    }

    function test_postOpAlwaysReverts() public {
        vm.prank(address(ep));
        vm.expectRevert(MontiPaymaster.NoPostOp.selector);
        paymaster.postOp(IPaymaster.PostOpMode.opSucceeded, "", 0);
    }

    function test_newSelectorsFromTheProductDeltaAreAllowed() public view {
        assertTrue(paymaster.allowedSelector(bytes4(keccak256("setNickname(bytes32,string)"))));
        assertTrue(paymaster.allowedSelector(bytes4(keccak256("createOffer(uint256,bytes32,uint64)"))));
        assertTrue(paymaster.allowedSelector(bytes4(keccak256("cancelOffer(uint256)"))));
        assertTrue(paymaster.allowedSelector(bytes4(keccak256("acceptOffer(uint256,bytes)"))));
        assertTrue(paymaster.allowedSelector(bytes4(keccak256("publishEvent(uint256)"))));
        assertTrue(paymaster.allowedSelector(bytes4(keccak256("cancelEvent(uint256)"))));
    }

    receive() external payable {}
}
