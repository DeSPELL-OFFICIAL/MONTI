// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

/// @notice The slice of Ticket that Organizers and MontiPaymaster are allowed to see.
interface ITicket {
    function eventOrg(uint256 eventId) external view returns (uint256);
    function eventOf(uint256 tokenId) external view returns (uint256);
}
