// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

/// @notice The slice of Organizers that Ticket is allowed to see.
interface IOrganizers {
    function ownerOf(uint256 orgId) external view returns (address);
    function hasPermission(uint256 orgId, address account, uint32 bit) external view returns (bool);
    function managerOf(uint256 orgId, address account) external view returns (bool exists, bool canApprove);
    function gateOf(address gateAccount) external view returns (uint256 gateId);
    function gateInfo(uint256 gateId)
        external
        view
        returns (uint256 eventId, address account, bytes32 kx, bytes32 ky, bool open, bool revoked);
    function isOpenGate(uint256 eventId, address gateAccount) external view returns (bool);
}
