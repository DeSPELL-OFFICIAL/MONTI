// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title MockUSD
/// @notice A 6-decimal test stablecoin standing in for Circle test USDC (10143)
///         `0x534b2f3A21130d7a60830c2Df862319e593943A3`. The demo default is the real Circle token;
///         this mock is the unit-test token and the demo-day fallback if the Circle faucet is down
///         (design 2026-10-01 §8). `mint` is open so test harnesses can fund the treasury adapter.
///
/// @dev    `setBlocked` lets a test flag a recipient so `transfer`/`transferFrom` to it reverts — the
///         simplest faithful stand-in for a USDC blacklist. A real ERC-20 transfer to a plain contract
///         does not "reject"; a blacklisted recipient is a token that reverts on transfer to a flagged
///         address, which is exactly what this models, exercising the vault's per-recipient pull fallback.
contract MockUSD is ERC20 {
    error Blocked();

    mapping(address => bool) public blocked;

    constructor() ERC20("Mock USD", "mUSD") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /// @notice Flag `account` as blacklisted: any transfer to it reverts (USDC-blacklist simulation).
    function setBlocked(address account, bool isBlocked) external {
        blocked[account] = isBlocked;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (blocked[to]) revert Blocked();
        super._update(from, to, value);
    }
}
