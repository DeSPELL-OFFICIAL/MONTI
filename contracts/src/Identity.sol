// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {AttesterRole} from "./libs/AttesterRole.sol";
import {IIdentity} from "./interfaces/IIdentity.sol";
import {ERC2771Context} from "@openzeppelin/contracts/metatx/ERC2771Context.sol";

/// @title Identity
/// @notice personId is 32 random bytes (spec 10.2) — never a hash of anything. This contract is the
///         only on-chain link between a random personId, a smart account, and one active P-256
///         device key. No PII ever reaches this contract.
contract Identity is IIdentity, AttesterRole, ERC2771Context {
    struct Device {
        bytes32 x;
        bytes32 y;
        uint64 updatedAt;
        bool locked;
    }

    uint256 public constant ROTATION_COOLDOWN = 7 days;
    uint256 public constant DEVICE_COOLDOWN = 7 days;

    /// @notice 회전을 되돌릴 수 있는 시간(6.3 T11). Ticket.MIGRATE_DELAY 와 같은 값이어야 한다 —
    ///         두 창이 어긋나면 되돌릴 수도 없는데 티켓은 아직 안 넘어간 구간이 생기거나, 반대로
    ///         티켓이 넘어간 뒤에도 되돌릴 수 있는 구간이 생긴다. TicketMigrate.t.sol 이 단언한다.
    uint256 public constant override ROTATION_UNDO_WINDOW = 1 days;

    mapping(bytes32 => address) private _accountOf;
    mapping(address => bytes32) private _personOf;
    mapping(bytes32 => uint64) private _rotatedAt;
    /// @dev 직전 회전에서 밀려난 계정 하나. cancelRotation 의 유일한 자격 조건이다.
    mapping(bytes32 => address) private _rotatedFrom;
    mapping(address => Device) private _devices;
    mapping(bytes32 => uint8) private _kycLevel;
    /// @dev ERC-2771 trusted forwarder, wired once. Zero until setForwarder → _msgSender()==msg.sender.
    address private _forwarder;

    event Registered(bytes32 indexed personId, address indexed account);
    event AccountRotated(bytes32 indexed personId, address indexed oldAccount, address indexed newAccount);
    event DeviceChanged(address indexed account, bytes32 x, bytes32 y);
    event DeviceLocked(address indexed account, bool locked);
    event KycLevelSet(address indexed account, uint8 level);
    event RotationCancelled(bytes32 indexed personId, address indexed account);

    error PersonAlreadyRegistered();
    error AccountAlreadyRegistered();
    error InvalidPersonId();
    error InvalidAccount();
    error InvalidDeviceKey();
    error NotRegistered();
    error NotAccountOwner();
    error CooldownActive();
    error NoRotationToCancel();
    error ForwarderAlreadySet();

    constructor(address attester_) AttesterRole(attester_) ERC2771Context(address(0)) {}

    /// @notice ERC-2771 trusted forwarder. Identity is deployed before the forwarder (the forwarder
    ///         reads Identity), so it cannot be an immutable — the deployer wires it once, mirroring
    ///         Organizers.setTicket (design §2).
    function trustedForwarder() public view override returns (address) {
        return _forwarder;
    }

    function setForwarder(address forwarder_) external {
        if (msg.sender != deployer) revert NotDeployer();
        if (_forwarder != address(0)) revert ForwarderAlreadySet();
        if (forwarder_ == address(0)) revert ZeroAddress();
        _forwarder = forwarder_;
    }

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
        _rotatedFrom[personId] = oldAccount;

        emit AccountRotated(personId, oldAccount, newAccount);

        // 회전은 폰을 잃어버려서 하는 절차다(5.5). 잃어버린 폰이 Ticket.migrate 전까지 계속
        // 입장하던 구멍을 여기서 닫는다(I2). cancelRotation 이 이 잠금을 되돌린다.
        Device storage lost = _devices[oldAccount];
        if (!lost.locked) {
            lost.locked = true;
            emit DeviceLocked(oldAccount, true);
        }
    }

    /// @notice 6.3 T11: 어테스터 키가 털리면 본인 동의 없이 계정이 바뀔 수 있다. 밀려난 계정이 —
    ///         도둑이 가지고 있지 않은 바로 그 계정이 — ROTATION_UNDO_WINDOW 안에 직접 되돌린다.
    ///         폰을 정말 잃어버린 정상 복구에서는 아무도 이걸 부르지 않으므로, 창이 닫히면 새
    ///         계정이 예정대로 티켓을 가져간다.
    /// @dev    자격을 _personOf 로 판정하면 안 된다. 그 매핑은 밀려난 계정에서 영원히 지워지지
    ///         않으므로(:79 가 그렇게 설계했다 — migrate 가 옛 티켓에서 새 계정을 찾아야 한다),
    ///         "지금까지 가져본 모든 계정"이 시한 없이 되돌릴 수 있게 된다. A→B→C 뒤 A 가 C 를
    ///         쫓아내면 C 의 티켓은 전부 얼고(_update 의 NotMember) C 는 migrate 도 못 한다.
    ///         그래서 자격은 _rotatedFrom 한 칸(직전 계정)이고 창은 24시간이다.
    ///
    ///         쿨다운 스탬프(_rotatedAt)는 일부러 되감지 않는다: 거절된 회전도 어테스터에게
    ///         ROTATION_COOLDOWN 을 통째로 물리므로, 취소는 공격자가 따라잡을 루프가 아니다.
    ///
    ///         잠금도 일부러 풀지 않는다. 회전이 건 잠금(I2)이 그대로 남아야, 동기화된 패스키가
    ///         취소 하나로 문까지 여는 일이 없다. 본인은 setActiveDevice 라는 정상 경로로 푼다.
    ///
    ///         migrate 성공 시 _rotatedFrom 을 비울 필요는 없다: migrate 는 창이 닫힌 뒤에만,
    ///         cancelRotation 은 창이 열린 동안에만 통하므로 두 경로는 상호 배타다.
    function cancelRotation() external {
        bytes32 personId = _personOf[_msgSender()];
        if (personId == bytes32(0)) revert NotRegistered();
        // 자격 없음과 창 만료를 같은 에러로 둔다: 구분해 알려주면 어느 계정이 언제 회전했는지
        // 모르는 사람에게 흘리게 된다.
        if (_rotatedFrom[personId] != _msgSender()) revert NoRotationToCancel();
        if (block.timestamp >= uint256(_rotatedAt[personId]) + ROTATION_UNDO_WINDOW) revert NoRotationToCancel();

        address current = _accountOf[personId];
        _accountOf[personId] = _msgSender();
        delete _personOf[current];
        delete _rotatedFrom[personId];

        emit AccountRotated(personId, current, _msgSender());
        emit RotationCancelled(personId, _msgSender());
    }

    /// @notice Raises (or lowers) the verification level after a later Didit session. Attester only:
    ///         the chain never learns what was verified, only that our attester key says it was. MVP: raw
    ///         EOA key in Secret Manager (ATTESTER_PK); KMS signing is the production path.
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

    /// @notice 마지막 등록 또는 회전 시각. Ticket.migrate 의 타임락 기준이자 되돌리기 창의
    ///         시작점이며, 취소해도 되감기지 않아 어테스터가 7일 쿨다운을 다시 기다리게 만든다.
    function rotatedAt(bytes32 personId) external view returns (uint64) {
        return _rotatedAt[personId];
    }

    /// @notice 직전 회전에서 밀려난 계정. 되돌린 뒤에는 0이다. 03 의 복구 화면이 이것과
    ///         rotatedAt 으로 "지금 되돌릴 수 있는가"를 계산한다.
    function rotatedFrom(bytes32 personId) external view returns (address) {
        return _rotatedFrom[personId];
    }

    /// @notice Register this phone's hardware key as the one key allowed to sign check-ins.
    ///         Spec 9.3: one active device per account, 7-day cooldown enforced by the contract.
    ///         Registering a fresh device also clears a lock — that is the on-chain recovery path.
    function setActiveDevice(bytes32 x, bytes32 y) external {
        if (!isMember(_msgSender())) revert NotRegistered();
        if (x == bytes32(0) || y == bytes32(0)) revert InvalidDeviceKey();

        Device storage d = _devices[_msgSender()];
        if (d.updatedAt != 0 && block.timestamp < uint256(d.updatedAt) + DEVICE_COOLDOWN) revert CooldownActive();

        bool wasLocked = d.locked;
        d.x = x;
        d.y = y;
        d.updatedAt = uint64(block.timestamp);
        d.locked = false;

        emit DeviceChanged(_msgSender(), x, y);
        if (wasLocked) emit DeviceLocked(_msgSender(), false);
    }

    /// @notice Spec 5.5 / 9.3: the attendee (from any device or the web) or the attester can lock the
    ///         active device instantly. While locked, Ticket.checkIn refuses this account.
    function lockDevice(address account) external {
        if (_msgSender() != account && msg.sender != attester()) revert NotAccountOwner();
        if (_personOf[account] == bytes32(0)) revert NotRegistered();

        _devices[account].locked = true;
        emit DeviceLocked(account, true);
    }
}
