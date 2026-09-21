// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {ITicket} from "../../src/interfaces/ITicket.sol";

/// @notice Lets Organizers tests run without the real Ticket (which depends on Organizers).
contract MockTicket is ITicket {
    mapping(uint256 => uint256) public orgOf;

    function setEventOrg(uint256 eventId, uint256 orgId) external {
        orgOf[eventId] = orgId;
    }

    function eventOrg(uint256 eventId) external view returns (uint256) {
        return orgOf[eventId];
    }

    function isRevoked(uint256) external pure returns (bool) {
        return false;
    }
}
