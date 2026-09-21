// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {IOrganizers} from "./interfaces/IOrganizers.sol";
import {ITicket} from "./interfaces/ITicket.sol";

/// @title Organizers
/// @notice The on-chain allowlist (spec 9.4). A role that is not in here does not exist. Nothing in
///         this contract is cached off-chain for authorisation; the indexer reads it for lists only.
contract Organizers {
    uint32 public constant PERM_CREATE_EVENT = 1;
    uint32 public constant PERM_MANAGE_GATES = 2;
    uint32 public constant PERM_APPROVE_OVERRIDE = 4;
    uint32 public constant PERM_MANAGE_MANAGERS = 8;
    uint32 public constant PERM_MANAGE_BUDGET = 16;

    struct Manager {
        bool exists;
        bool canApprove;
    }

    struct Gate {
        uint256 eventId;
        address account;
        bytes32 kx;
        bytes32 ky;
        bool open;
        bool revoked;
    }

    address public immutable deployer;
    address public ticket;

    uint256 private _nextOrgId = 1;
    uint256 private _nextGateId = 1;

    mapping(uint256 => address) private _owners;
    mapping(uint256 => mapping(address => uint32)) private _adminBits;
    mapping(uint256 => mapping(address => Manager)) private _managers;
    mapping(uint256 => Gate) private _gates;
    mapping(address => uint256) private _gateOf;

    event OrganizerCreated(uint256 indexed orgId, address indexed owner);
    event AdminSet(uint256 indexed orgId, address indexed admin, uint32 bits);
    event ManagerSet(uint256 indexed orgId, address indexed manager, bool exists, bool canApprove);
    event OwnerTransferred(uint256 indexed orgId, address indexed from, address indexed to);
    event GateRegistered(
        uint256 indexed gateId, uint256 indexed eventId, address indexed gateAccount, bytes32 kx, bytes32 ky
    );
    event GateRevoked(uint256 indexed gateId);
    event GateOpened(uint256 indexed gateId);
    event GateClosed(uint256 indexed gateId);

    error NotOwner();
    error NotDeployer();
    error TicketAlreadySet();
    error TicketNotSet();
    error ZeroAddress();
    error UnknownOrganizer();
    error Unauthorized();
    error UnknownGate();
    error GateAccountInUse();
    error GateIsRevoked();

    constructor() {
        deployer = msg.sender;
    }

    function setTicket(address ticket_) external {
        if (msg.sender != deployer) revert NotDeployer();
        if (ticket != address(0)) revert TicketAlreadySet();
        if (ticket_ == address(0)) revert ZeroAddress();
        ticket = ticket_;
    }

    function createOrganizer(address owner) external returns (uint256 orgId) {
        if (owner == address(0)) revert ZeroAddress();
        orgId = _nextOrgId++;
        _owners[orgId] = owner;
        emit OrganizerCreated(orgId, owner);
    }

    function transferOwner(uint256 orgId, address newOwner) external {
        address current = _owners[orgId];
        if (current == address(0)) revert UnknownOrganizer();
        if (msg.sender != current) revert NotOwner();
        if (newOwner == address(0)) revert ZeroAddress();
        _owners[orgId] = newOwner;
        emit OwnerTransferred(orgId, current, newOwner);
    }

    function ownerOf(uint256 orgId) external view returns (address) {
        return _owners[orgId];
    }
}
