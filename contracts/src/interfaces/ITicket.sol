// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

/// @notice The slice of Ticket its callers bind to. On chain that is two readers: Organizers resolves
///         an event to its organizer with `eventOrg`, and MontiPaymaster resolves a token to its event
///         with `eventOf` before doing the same. `isRevoked` has no on-chain caller — it rides along so
///         the mocks and sub-plan 04's readers share one typed view of a ticket's void flag.
interface ITicket {
    function eventOrg(uint256 eventId) external view returns (uint256);
    function eventOf(uint256 tokenId) external view returns (uint256);
    function isRevoked(uint256 tokenId) external view returns (bool);
}
