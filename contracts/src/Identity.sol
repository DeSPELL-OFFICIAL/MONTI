// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {AttesterRole} from "./libs/AttesterRole.sol";
import {IIdentity} from "./interfaces/IIdentity.sol";

/// @title Identity
/// @notice personId is 32 random bytes (spec 10.2) — never a hash of anything. This contract is the
///         only on-chain link between a random personId, a smart account, and one active P-256
///         device key. No PII ever reaches this contract.
contract Identity is IIdentity, AttesterRole {
    struct Device {
        bytes32 x;
        bytes32 y;
        uint64 updatedAt;
        bool locked;
    }

    uint256 public constant ROTATION_COOLDOWN = 7 days;
    uint256 public constant DEVICE_COOLDOWN = 7 days;

    mapping(bytes32 => address) private _accountOf;
    mapping(address => bytes32) private _personOf;
    mapping(bytes32 => uint64) private _rotatedAt;
    mapping(address => Device) private _devices;
    mapping(bytes32 => uint8) private _kycLevel;
    mapping(bytes32 => address) private _nicknameOwner;
    mapping(address => bytes32) private _nicknameOf;

    event Registered(bytes32 indexed personId, address indexed account);
    event AccountRotated(bytes32 indexed personId, address indexed oldAccount, address indexed newAccount);
    event DeviceChanged(address indexed account, bytes32 x, bytes32 y);
    event DeviceLocked(address indexed account, bool locked);
    event NicknameSet(address indexed account, bytes32 indexed nicknameHash, string nickname);
    event KycLevelSet(address indexed account, uint8 level);

    error PersonAlreadyRegistered();
    error AccountAlreadyRegistered();
    error InvalidPersonId();
    error InvalidAccount();
    error InvalidDeviceKey();
    error NotRegistered();
    error NotAccountOwner();
    error CooldownActive();
    error NicknameTaken();
    error NicknameHashMismatch();

    constructor(address attester_) AttesterRole(attester_) {}

    /// @dev Resolves the diamond between IIdentity.attester and AttesterRole.attester (spec 9.2).
    function attester() public view override(IIdentity, AttesterRole) returns (address) {
        return super.attester();
    }

    /// @param kycLevel 0 = phone + passkey only, 1 = ID and face verified by the attester (spec 9.2).
    function register(bytes32 personId, address account, bytes32 deviceX, bytes32 deviceY, uint8 kycLevel)
        external
        onlyAttester
    {
        if (personId == bytes32(0)) revert InvalidPersonId();
        if (account == address(0)) revert InvalidAccount();
        if (deviceX == bytes32(0) || deviceY == bytes32(0)) revert InvalidDeviceKey();
        if (_accountOf[personId] != address(0)) revert PersonAlreadyRegistered();
        if (_personOf[account] != bytes32(0)) revert AccountAlreadyRegistered();

        _accountOf[personId] = account;
        _personOf[account] = personId;
        _rotatedAt[personId] = uint64(block.timestamp);
        _devices[account] = Device({x: deviceX, y: deviceY, updatedAt: uint64(block.timestamp), locked: false});
        _kycLevel[personId] = kycLevel;

        emit Registered(personId, account);
        emit DeviceChanged(account, deviceX, deviceY);
        emit KycLevelSet(account, kycLevel);
    }

    /// @notice Spec 5.5: passkey lost -> new passkey -> the attester swaps the account on chain.
    ///         7-day cooldown is the SIM-swap defence (spec 18 risk table). The old account keeps its
    ///         personOf entry so Ticket.migrate can find the new account from an old ticket.
    function rotateAccount(bytes32 personId, address newAccount) external onlyAttester {
        address oldAccount = _accountOf[personId];
        if (oldAccount == address(0)) revert NotRegistered();
        if (newAccount == address(0)) revert InvalidAccount();
        if (_personOf[newAccount] != bytes32(0)) revert AccountAlreadyRegistered();
        if (block.timestamp < uint256(_rotatedAt[personId]) + ROTATION_COOLDOWN) revert CooldownActive();

        _accountOf[personId] = newAccount;
        _personOf[newAccount] = personId;
        _rotatedAt[personId] = uint64(block.timestamp);

        bytes32 nick = _nicknameOf[oldAccount];
        if (nick != bytes32(0)) {
            delete _nicknameOf[oldAccount];
            _nicknameOf[newAccount] = nick;
            _nicknameOwner[nick] = newAccount;
        }

        emit AccountRotated(personId, oldAccount, newAccount);
    }

    /// @notice Raises (or lowers) the verification level after a later Didit session. Attester only:
    ///         the chain never learns what was verified, only that our KMS key says it was.
    function setKycLevel(bytes32 personId, uint8 level) external onlyAttester {
        address account = _accountOf[personId];
        if (account == address(0)) revert NotRegistered();
        _kycLevel[personId] = level;
        emit KycLevelSet(account, level);
    }

    function accountOf(bytes32 personId) external view returns (address) {
        return _accountOf[personId];
    }

    function personOf(address account) external view returns (bytes32) {
        return _personOf[account];
    }

    /// @dev A rotated-away account keeps its personOf mapping (migrate needs it) but stops being a member.
    function isMember(address account) public view returns (bool) {
        bytes32 personId = _personOf[account];
        return personId != bytes32(0) && _accountOf[personId] == account;
    }

    function activeDevice(address account) external view returns (bytes32 x, bytes32 y) {
        Device storage d = _devices[account];
        return (d.x, d.y);
    }

    function isLocked(address account) external view returns (bool) {
        return _devices[account].locked;
    }

    function deviceUpdatedAt(address account) external view returns (uint64) {
        return _devices[account].updatedAt;
    }

    function kycLevelOf(address account) external view returns (uint8) {
        return _kycLevel[_personOf[account]];
    }

    /// @notice Register this phone's hardware key as the one key allowed to sign check-ins.
    ///         Spec 9.3: one active device per account, 7-day cooldown enforced by the contract.
    ///         Registering a fresh device also clears a lock — that is the on-chain recovery path.
    function setActiveDevice(bytes32 x, bytes32 y) external {
        if (!isMember(msg.sender)) revert NotRegistered();
        if (x == bytes32(0) || y == bytes32(0)) revert InvalidDeviceKey();

        Device storage d = _devices[msg.sender];
        if (d.updatedAt != 0 && block.timestamp < uint256(d.updatedAt) + DEVICE_COOLDOWN) revert CooldownActive();

        bool wasLocked = d.locked;
        d.x = x;
        d.y = y;
        d.updatedAt = uint64(block.timestamp);
        d.locked = false;

        emit DeviceChanged(msg.sender, x, y);
        if (wasLocked) emit DeviceLocked(msg.sender, false);
    }

    /// @notice Spec 5.5 / 9.3: the attendee (from any device or the web) or the attester can lock the
    ///         active device instantly. While locked, Ticket.checkIn refuses this account.
    function lockDevice(address account) external {
        if (msg.sender != account && msg.sender != attester()) revert NotAccountOwner();
        if (_personOf[account] == bytes32(0)) revert NotRegistered();

        _devices[account].locked = true;
        emit DeviceLocked(account, true);
    }

    function nicknameOwner(bytes32 nicknameHash) external view returns (address) {
        return _nicknameOwner[nicknameHash];
    }

    function nicknameOf(address account) external view returns (bytes32) {
        return _nicknameOf[account];
    }
}
