// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

/// @notice The slice of Identity that Ticket and MontiPaymaster are allowed to see.
interface IIdentity {
    function accountOf(bytes32 personId) external view returns (address);
    function personOf(address account) external view returns (bytes32);
    function rotatedAt(bytes32 personId) external view returns (uint64);
    function rotatedFrom(bytes32 personId) external view returns (address);
    function isMember(address account) external view returns (bool);
    function activeDevice(address account) external view returns (bytes32 x, bytes32 y);
    function isLocked(address account) external view returns (bool);
    function deviceUpdatedAt(address account) external view returns (uint64);
    function attester() external view returns (address);
    function kycLevelOf(address account) external view returns (uint8);
    function nicknameOwner(bytes32 nicknameHash) external view returns (address);
    function nicknameOf(address account) external view returns (bytes32);
}
