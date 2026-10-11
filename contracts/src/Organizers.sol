// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {IOrganizers} from "./interfaces/IOrganizers.sol";
import {ITicket} from "./interfaces/ITicket.sol";
import {ERC2771Context} from "@openzeppelin/contracts/metatx/ERC2771Context.sol";

/// @title Organizers
/// @notice The on-chain allowlist (spec 9.4). A role that is not in here does not exist. Nothing in
///         this contract is cached off-chain for authorisation; the indexer reads it for lists only.
contract Organizers is IOrganizers, ERC2771Context {
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

    /// @dev v2 ids start at 1001 (v2 design D7) so v2 Firestore keys (orgProfiles/{orgId},
    ///      usage/org:{orgId}) never collide with v1 documents.
    uint256 private _nextOrgId = 1001;
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
    error InvalidGateKey();

    constructor(address forwarder_) ERC2771Context(forwarder_) {
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
        if (_msgSender() != current) revert NotOwner();
        if (newOwner == address(0)) revert ZeroAddress();
        _owners[orgId] = newOwner;
        emit OwnerTransferred(orgId, current, newOwner);
    }

    function setAdmin(uint256 orgId, address admin, uint32 permissionBits) external {
        if (_owners[orgId] == address(0)) revert UnknownOrganizer();
        if (_msgSender() != _owners[orgId]) revert NotOwner();
        if (admin == address(0)) revert ZeroAddress();
        _adminBits[orgId][admin] = permissionBits;
        emit AdminSet(orgId, admin, permissionBits);
    }

    /// @notice Spec 9.4: a manager either approves overrides directly or can only file a request.
    function setManager(uint256 orgId, address manager, bool exists, bool canApprove) external {
        if (_owners[orgId] == address(0)) revert UnknownOrganizer();
        if (!hasPermission(orgId, _msgSender(), PERM_MANAGE_MANAGERS)) revert Unauthorized();
        if (manager == address(0)) revert ZeroAddress();

        _managers[orgId][manager] = Manager({exists: exists, canApprove: exists && canApprove});
        emit ManagerSet(orgId, manager, exists, exists && canApprove);
    }

    function managerOf(uint256 orgId, address account) external view override returns (bool exists, bool canApprove) {
        Manager storage m = _managers[orgId][account];
        return (m.exists, m.canApprove);
    }

    /// @notice Spec 7.1: the staff device creates a gate account from its hardware key, an admin puts
    ///         that account on the event's gate allowlist. Approval is opening (v2 D3): a gate starts
    ///         open, emitting GateRegistered then GateOpened. closeGate/openGate remain for a pause.
    function registerGate(uint256 eventId, address gateAccount, bytes32 kx, bytes32 ky)
        external
        returns (uint256 gateId)
    {
        if (ticket == address(0)) revert TicketNotSet();
        if (gateAccount == address(0)) revert ZeroAddress();
        if (kx == 0 || ky == 0) revert InvalidGateKey();
        if (_gateOf[gateAccount] != 0) revert GateAccountInUse();

        uint256 orgId = ITicket(ticket).eventOrg(eventId);
        if (orgId == 0) revert UnknownOrganizer();
        if (!hasPermission(orgId, _msgSender(), PERM_MANAGE_GATES)) revert Unauthorized();

        gateId = _nextGateId++;
        _gates[gateId] = Gate({eventId: eventId, account: gateAccount, kx: kx, ky: ky, open: true, revoked: false});
        _gateOf[gateAccount] = gateId;

        emit GateRegistered(gateId, eventId, gateAccount, kx, ky);
        emit GateOpened(gateId);
    }

    function gateOf(address gateAccount) external view override returns (uint256) {
        return _gateOf[gateAccount];
    }

    function gateInfo(uint256 gateId)
        external
        view
        override
        returns (uint256 eventId, address account, bytes32 kx, bytes32 ky, bool open, bool revoked)
    {
        Gate storage g = _gates[gateId];
        return (g.eventId, g.account, g.kx, g.ky, g.open, g.revoked);
    }

    function openGate(uint256 gateId) external {
        _mutateGate(gateId).open = true;
        emit GateOpened(gateId);
    }

    function closeGate(uint256 gateId) external {
        _mutateGate(gateId).open = false;
        emit GateClosed(gateId);
    }

    /// @notice T14 의 대응 수단. 도난당한 단말기를 여기서 끊는다.
    /// @dev    _gateOf 를 지우는 것이 핵심이다(I3): 남겨두면 그 주소를 두 번 다시 게이트로 등록할
    ///         수 없다. 게이트 기록 자체(gateInfo)는 남으므로 지난 입장 기록의 gateId 는 계속
    ///         해석된다.
    function revokeGate(uint256 gateId) external {
        Gate storage g = _mutateGate(gateId);
        g.revoked = true;
        g.open = false;
        delete _gateOf[g.account];
        emit GateRevoked(gateId);
    }

    /// @notice The single question Ticket.checkIn asks: is msg.sender a live gate of this event?
    function isOpenGate(uint256 eventId, address gateAccount) external view override returns (bool) {
        uint256 gateId = _gateOf[gateAccount];
        if (gateId == 0) return false;
        Gate storage g = _gates[gateId];
        return g.eventId == eventId && g.open && !g.revoked;
    }

    function _mutateGate(uint256 gateId) private view returns (Gate storage g) {
        g = _gates[gateId];
        if (g.account == address(0)) revert UnknownGate();
        if (g.revoked) revert GateIsRevoked();
        uint256 orgId = ITicket(ticket).eventOrg(g.eventId);
        if (!hasPermission(orgId, _msgSender(), PERM_MANAGE_GATES)) revert Unauthorized();
    }

    /// @notice The owner implicitly holds every bit; an admin holds exactly the bits set for them.
    function hasPermission(uint256 orgId, address account, uint32 bit) public view override returns (bool) {
        if (account == address(0)) return false;
        if (account == _owners[orgId]) return true;
        return (_adminBits[orgId][account] & bit) == bit && bit != 0;
    }

    function adminBitsOf(uint256 orgId, address admin) external view returns (uint32) {
        return _adminBits[orgId][admin];
    }

    function ownerOf(uint256 orgId) external view override returns (address) {
        return _owners[orgId];
    }
}
