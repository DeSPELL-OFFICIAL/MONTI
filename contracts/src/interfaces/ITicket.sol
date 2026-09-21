// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

/// @notice The only thing Organizers is allowed to ask Ticket.
interface ITicket {
    function eventOrg(uint256 eventId) external view returns (uint256);
}
