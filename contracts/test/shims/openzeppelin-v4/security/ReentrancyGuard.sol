// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

// account-abstraction v0.6 is an npm package: its EntryPoint imports OpenZeppelin v4's
// `@openzeppelin/contracts/security/ReentrancyGuard.sol`, a path v5 moved to `utils/`. This repo pins
// OpenZeppelin v5.1, so `remappings.txt` points that one import — and only inside lib/account-abstraction
// — at this file, which hands back the v5 guard. The contract is unchanged between the two versions
// apart from the revert reason, which nothing here asserts on.
//
// It exists so `Deploy.t.sol` can run the deploy script against the *real* EntryPoint v0.6 rather than a
// hand-written stand-in: the stake and deposit the script sends are the only chance to catch a v0.6
// StakeManager rule before mainnet money is involved.
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
