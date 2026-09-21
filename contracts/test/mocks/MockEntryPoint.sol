// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {UserOperation} from "account-abstraction/interfaces/UserOperation.sol";
import {IPaymaster} from "account-abstraction/interfaces/IPaymaster.sol";

/// @notice Just enough EntryPoint v0.6 for the paymaster tests: it holds deposits, tracks stake and
///         can call validatePaymasterUserOp as the real EntryPoint would (msg.sender == entryPoint).
contract MockEntryPoint {
    mapping(address => uint256) public balanceOf;
    mapping(address => uint256) public stakeOf;
    mapping(address => uint32) public unstakeDelayOf;
    mapping(address => bool) public unlocked;

    function depositTo(address account) external payable {
        balanceOf[account] += msg.value;
    }

    function withdrawTo(address payable to, uint256 amount) external {
        balanceOf[msg.sender] -= amount;
        (bool ok,) = to.call{value: amount}("");
        require(ok, "withdraw failed");
    }

    function addStake(uint32 unstakeDelaySec) external payable {
        stakeOf[msg.sender] += msg.value;
        unstakeDelayOf[msg.sender] = unstakeDelaySec;
        unlocked[msg.sender] = false;
    }

    function unlockStake() external {
        unlocked[msg.sender] = true;
    }

    function withdrawStake(address payable to) external {
        require(unlocked[msg.sender], "not unlocked");
        uint256 amount = stakeOf[msg.sender];
        stakeOf[msg.sender] = 0;
        (bool ok,) = to.call{value: amount}("");
        require(ok, "withdraw failed");
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
        balanceOf[paymaster] -= actualGasCost;
        IPaymaster(paymaster).postOp(mode, context, actualGasCost);
    }

    receive() external payable {}
}
