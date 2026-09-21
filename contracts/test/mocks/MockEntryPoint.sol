// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {UserOperation} from "account-abstraction/interfaces/UserOperation.sol";
import {IPaymaster} from "account-abstraction/interfaces/IPaymaster.sol";
import {IStakeManager} from "account-abstraction/interfaces/IStakeManager.sol";

/// @notice Just enough EntryPoint v0.6 for the paymaster tests: it holds deposits, tracks stake and
///         can call validatePaymasterUserOp as the real EntryPoint would (msg.sender == entryPoint).
/// @dev    The stake functions mirror v0.6 `StakeManager` rule for rule, revert string included, so a
///         Deploy script that would revert on chain (`addStake(0)`, a shortened delay, a withdrawal
///         before the delay is due) reverts here too.
contract MockEntryPoint {
    mapping(address => uint256) public deposits;
    mapping(address => uint256) public stakeOf;
    mapping(address => uint32) public unstakeDelayOf;
    /// @dev First timestamp at which `withdrawStake` may be called; 0 while the stake is locked.
    mapping(address => uint48) public withdrawTimeOf;

    function depositTo(address account) external payable {
        deposits[account] += msg.value;
    }

    function withdrawTo(address payable to, uint256 amount) external {
        deposits[msg.sender] -= amount;
        (bool ok,) = to.call{value: amount}("");
        require(ok, "withdraw failed");
    }

    /// @dev StakeManager.addStake: the delay may only grow, and any pending unstake is cancelled.
    function addStake(uint32 unstakeDelaySec) external payable {
        require(unstakeDelaySec > 0, "must specify unstake delay");
        require(unstakeDelaySec >= unstakeDelayOf[msg.sender], "cannot decrease unstake time");
        uint256 stake = stakeOf[msg.sender] + msg.value;
        require(stake > 0, "no stake specified");
        stakeOf[msg.sender] = stake;
        unstakeDelayOf[msg.sender] = unstakeDelaySec;
        withdrawTimeOf[msg.sender] = 0;
    }

    function unlockStake() external {
        require(unstakeDelayOf[msg.sender] != 0, "not staked");
        require(withdrawTimeOf[msg.sender] == 0, "already unstaking");
        withdrawTimeOf[msg.sender] = uint48(block.timestamp) + unstakeDelayOf[msg.sender];
    }

    function withdrawStake(address payable to) external {
        uint256 amount = stakeOf[msg.sender];
        require(amount > 0, "No stake to withdraw");
        require(withdrawTimeOf[msg.sender] > 0, "must call unlockStake() first");
        require(withdrawTimeOf[msg.sender] <= block.timestamp, "Stake withdrawal is not due");
        unstakeDelayOf[msg.sender] = 0;
        withdrawTimeOf[msg.sender] = 0;
        stakeOf[msg.sender] = 0;
        (bool ok,) = to.call{value: amount}("");
        require(ok, "failed to withdraw stake");
    }

    /// @dev `staked` is v0.6's flag: true from `addStake` until `unlockStake` schedules the withdrawal.
    function getDepositInfo(address account) external view returns (IStakeManager.DepositInfo memory) {
        return IStakeManager.DepositInfo({
            deposit: uint112(deposits[account]),
            staked: unstakeDelayOf[account] != 0 && withdrawTimeOf[account] == 0,
            stake: uint112(stakeOf[account]),
            unstakeDelaySec: unstakeDelayOf[account],
            withdrawTime: withdrawTimeOf[account]
        });
    }

    /// @dev ERC-7562 OP-054 forbids a validation frame from calling the EntryPoint at all. Arm this and
    ///      any such call fails the way a compliant bundler's tracer would reject the operation.
    bool public refuseValidationReads;

    function setRefuseValidationReads(bool on) external {
        refuseValidationReads = on;
    }

    function balanceOf(address account) external view returns (uint256) {
        require(!refuseValidationReads, "OP-054: EntryPoint called from validation");
        return deposits[account];
    }

    function callValidate(address paymaster, UserOperation calldata op, bytes32 opHash, uint256 maxCost)
        external
        returns (bytes memory context, uint256 validationData)
    {
        return IPaymaster(paymaster).validatePaymasterUserOp(op, opHash, maxCost);
    }

    /// @notice EntryPoint v0.6 charges the paymaster's deposit the real cost and then runs postOp.
    function callPostOp(address paymaster, IPaymaster.PostOpMode mode, bytes calldata context, uint256 actualGasCost)
        external
    {
        deposits[paymaster] -= actualGasCost;
        IPaymaster(paymaster).postOp(mode, context, actualGasCost);
    }

    receive() external payable {}
}
