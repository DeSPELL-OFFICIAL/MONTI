// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {MontiTest} from "./Base.t.sol";
import {MontiPaymaster} from "../src/MontiPaymaster.sol";
import {MockEntryPoint} from "./mocks/MockEntryPoint.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {IIdentity} from "../src/interfaces/IIdentity.sol";
import {IOrganizers} from "../src/interfaces/IOrganizers.sol";
import {ITicket} from "../src/interfaces/ITicket.sol";

/// @notice Spec 8.4: the paymaster reads Identity, Organizers and Ticket storage during validation and
///         writes its own, which ERC-7562 only allows a staked entity to do. Staking is therefore a deploy
///         prerequisite, and these are the wrappers the Deploy script and the retirement path call.
contract PaymasterStakeTest is MontiTest {
    MockEntryPoint internal ep;
    MontiPaymaster internal paymaster;

    /// @dev Spec 8.4: one day, which is what Pimlico's bundler policy asks of a testnet paymaster.
    uint32 internal constant ONE_DAY = 86_400;

    event StakeAdded(uint256 amount, uint32 unstakeDelaySec);
    event StakeUnlocked();
    event StakeWithdrawn(address indexed to, uint256 amount);

    function setUp() public {
        _deployMonti();
        ep = new MockEntryPoint();
        paymaster = new MontiPaymaster(
            IEntryPoint(address(ep)),
            IOrganizers(address(organizers)),
            ITicket(address(ticket)),
            IIdentity(address(identity))
        );
        vm.deal(address(this), 100 ether);
        vm.deal(BOB, 10 ether);
    }

    function test_deployerStakesWithTheOneDayUnstakeDelay() public {
        vm.expectEmit(false, false, false, true);
        emit StakeAdded(1 ether, ONE_DAY);
        paymaster.addStake{value: 1 ether}(ONE_DAY);

        assertEq(ep.stakeOf(address(paymaster)), 1 ether);
        assertEq(ep.unstakeDelayOf(address(paymaster)), ONE_DAY);
        assertEq(address(paymaster).balance, 0, "the whole value goes to the EntryPoint");
    }

    function test_strangerCannotStakeOrUnlockOrWithdraw() public {
        vm.startPrank(BOB);
        vm.expectRevert(MontiPaymaster.Unauthorized.selector);
        paymaster.addStake{value: 1 ether}(ONE_DAY);
        vm.expectRevert(MontiPaymaster.Unauthorized.selector);
        paymaster.unlockStake();
        vm.expectRevert(MontiPaymaster.Unauthorized.selector);
        paymaster.withdrawStake(payable(BOB));
        vm.stopPrank();

        assertEq(ep.stakeOf(address(paymaster)), 0);
    }

    function test_unlockThenWithdrawStake() public {
        paymaster.addStake{value: 1 ether}(ONE_DAY);

        vm.expectEmit(false, false, false, true);
        emit StakeUnlocked();
        paymaster.unlockStake();
        vm.warp(block.timestamp + ONE_DAY);

        uint256 before = BOB.balance;
        vm.expectEmit(true, false, false, true);
        emit StakeWithdrawn(BOB, 1 ether);
        paymaster.withdrawStake(payable(BOB));

        assertEq(BOB.balance, before + 1 ether, "the stake goes where the deployer names");
        assertEq(ep.stakeOf(address(paymaster)), 0);

        vm.expectRevert(bytes("No stake to withdraw"));
        paymaster.withdrawStake(payable(BOB));
    }

    /// @dev The two halves of v0.6's rule are the EntryPoint's to enforce; the wrapper must not paper
    ///      over either revert, because that is what a Deploy or retirement script hits on chain.
    function test_stakeCannotBeWithdrawnBeforeItIsUnlocked() public {
        paymaster.addStake{value: 1 ether}(ONE_DAY);

        vm.expectRevert(bytes("must call unlockStake() first"));
        paymaster.withdrawStake(payable(address(this)));
        assertEq(ep.stakeOf(address(paymaster)), 1 ether);
    }

    function test_stakeCannotBeWithdrawnBeforeTheDelayIsDue() public {
        paymaster.addStake{value: 1 ether}(ONE_DAY);
        paymaster.unlockStake();
        assertEq(ep.withdrawTimeOf(address(paymaster)), block.timestamp + ONE_DAY, "one day from the unlock");

        vm.warp(block.timestamp + ONE_DAY - 1);
        vm.expectRevert(bytes("Stake withdrawal is not due"));
        paymaster.withdrawStake(payable(address(this)));

        vm.warp(block.timestamp + 1);
        uint256 before = address(this).balance;
        paymaster.withdrawStake(payable(address(this)));
        assertEq(address(this).balance, before + 1 ether, "due to the second");
        assertEq(ep.stakeOf(address(paymaster)), 0);
    }

    function test_stakeCannotBeWithdrawnToTheZeroAddress() public {
        paymaster.addStake{value: 1 ether}(ONE_DAY);
        paymaster.unlockStake();
        vm.warp(block.timestamp + ONE_DAY);

        vm.expectRevert(MontiPaymaster.ZeroAddress.selector);
        paymaster.withdrawStake(payable(address(0)));
        assertEq(ep.stakeOf(address(paymaster)), 1 ether, "the stake is still there to withdraw properly");
    }

    /// @dev v0.6 rejects a zero delay outright. A Deploy script calling `addStake{value: x}(0)` must fail
    ///      here exactly as it would on chain, at the moment the deployment is blocked on staking.
    function test_stakingWithoutAnUnstakeDelayIsRefused() public {
        vm.expectRevert(bytes("must specify unstake delay"));
        paymaster.addStake{value: 1 ether}(0);
        assertEq(ep.stakeOf(address(paymaster)), 0);
    }

    function test_stakingNothingIsRefused() public {
        vm.expectRevert(bytes("no stake specified"));
        paymaster.addStake{value: 0}(ONE_DAY);
    }

    /// @dev The delay may only grow: re-staking at a shorter one would otherwise shorten the window a
    ///      bundler relies on. Topping the same delay up is the legitimate call.
    function test_theUnstakeDelayCannotBeShortenedButTheStakeCanBeToppedUp() public {
        paymaster.addStake{value: 1 ether}(ONE_DAY);

        vm.expectRevert(bytes("cannot decrease unstake time"));
        paymaster.addStake{value: 1 ether}(ONE_DAY - 1);

        paymaster.addStake{value: 1 ether}(ONE_DAY);
        assertEq(ep.stakeOf(address(paymaster)), 2 ether, "a top-up adds to the stake");
        assertEq(ep.unstakeDelayOf(address(paymaster)), ONE_DAY);
    }

    /// @dev Stake and deposit are two different pots at the EntryPoint. Staking buys the bundler's
    ///      acceptance and pays for no operation; the deposit is what `budgetOf(PLATFORM)` reads and what
    ///      gas actually comes out of. A deploy that stakes but forgets to deposit sponsors nothing.
    function test_stakeIsNotSpendableBudget() public {
        paymaster.addStake{value: 1 ether}(ONE_DAY);
        assertEq(paymaster.budgetOf(paymaster.PLATFORM()), 0, "staking funds no operation");
        assertEq(ep.balanceOf(address(paymaster)), 0);

        paymaster.depositPlatform{value: 2 ether}();
        assertEq(paymaster.budgetOf(paymaster.PLATFORM()), 2 ether, "the deposit is the platform slot");
        assertEq(ep.stakeOf(address(paymaster)), 1 ether, "and a deposit is not stake either");
    }

    receive() external payable {}
}
