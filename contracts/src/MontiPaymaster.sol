// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {IPaymaster} from "account-abstraction/interfaces/IPaymaster.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {UserOperation} from "account-abstraction/interfaces/UserOperation.sol";
import {IOrganizers} from "./interfaces/IOrganizers.sol";

/// @title MontiPaymaster
/// @notice EntryPoint v0.6 paymaster. Monad charges on the gas limit, so there is no refund to make
///         and therefore no postOp (spec 8.4): maxCost is debited during validation and that is final.
contract MontiPaymaster is IPaymaster {
    uint256 public constant PLATFORM = 0;

    IEntryPoint public immutable entryPoint;
    IOrganizers public immutable organizers;
    address public immutable deployer;

    address public ticket;
    address public identity;

    mapping(uint256 => uint256) private _budget;
    mapping(uint256 => bool) public selfSponsored;
    mapping(bytes4 => bool) public allowedSelector;

    event Deposited(uint256 indexed orgId, uint256 amount);
    event BudgetDebited(uint256 indexed orgId, address indexed sender, uint256 amount);
    event SponsorModeSet(uint256 indexed orgId, bool selfSponsored);

    error Unauthorized();
    error TargetsAlreadySet();
    error ZeroAddress();
    error NotEntryPoint();
    error BadPaymasterData();
    error TargetNotAllowed();
    error SelectorNotAllowed();
    error UnsupportedWalletCall();
    error BudgetExhausted();
    error NoPostOp();

    constructor(IEntryPoint entryPoint_, IOrganizers organizers_) {
        entryPoint = entryPoint_;
        organizers = organizers_;
        deployer = msg.sender;
    }

    function setTargets(address ticket_, address identity_) external {
        if (msg.sender != deployer) revert Unauthorized();
        if (ticket != address(0)) revert TargetsAlreadySet();
        if (ticket_ == address(0) || identity_ == address(0)) revert ZeroAddress();
        ticket = ticket_;
        identity = identity_;
        _seedSelectors();
    }

    function depositPlatform() external payable {
        _credit(PLATFORM, msg.value);
    }

    function deposit(uint256 orgId) external payable {
        _credit(orgId, msg.value);
    }

    function withdraw(uint256 orgId, uint256 amount) external {
        address allowed = orgId == PLATFORM ? deployer : organizers.ownerOf(orgId);
        if (msg.sender != allowed) revert Unauthorized();
        _budget[orgId] -= amount;
        entryPoint.withdrawTo(payable(msg.sender), amount);
    }

    function setSelfSponsored(uint256 orgId, bool on) external {
        if (!organizers.hasPermission(orgId, msg.sender, 16)) revert Unauthorized(); // PERM_MANAGE_BUDGET
        selfSponsored[orgId] = on;
        emit SponsorModeSet(orgId, on);
    }

    function budgetOf(uint256 orgId) external view returns (uint256) {
        return _budget[orgId];
    }

    struct Call {
        address target;
        uint256 value;
        bytes data;
    }

    /// @notice paymasterAndData = abi.encodePacked(address(this), uint256 orgId) — 52 bytes.
    function validatePaymasterUserOp(UserOperation calldata userOp, bytes32, uint256 maxCost)
        external
        returns (bytes memory context, uint256 validationData)
    {
        if (msg.sender != address(entryPoint)) revert NotEntryPoint();
        if (userOp.paymasterAndData.length != 52) revert BadPaymasterData();
        uint256 orgId = uint256(bytes32(userOp.paymasterAndData[20:52]));

        _requireAllowedCall(userOp.callData);
        _debit(selfSponsored[orgId] ? orgId : PLATFORM, userOp.sender, maxCost);

        return ("", 0);
    }

    /// @dev Monad charges the limit, so there is nothing to refund and postOp must never run.
    function postOp(PostOpMode, bytes calldata, uint256) external pure {
        revert NoPostOp();
    }

    function _requireAllowedCall(bytes calldata callData) private view {
        if (callData.length < 4) revert UnsupportedWalletCall();
        bytes4 sel = bytes4(callData[0:4]);

        if (sel == bytes4(keccak256("execute(address,uint256,bytes)"))) {
            (address target,, bytes memory inner) = abi.decode(callData[4:], (address, uint256, bytes));
            _requireAllowedInner(target, inner);
        } else if (sel == bytes4(keccak256("executeBatch((address,uint256,bytes)[])"))) {
            Call[] memory calls = abi.decode(callData[4:], (Call[]));
            if (calls.length == 0) revert UnsupportedWalletCall();
            for (uint256 i; i < calls.length; ++i) {
                _requireAllowedInner(calls[i].target, calls[i].data);
            }
        } else {
            revert UnsupportedWalletCall();
        }
    }

    function _requireAllowedInner(address target, bytes memory inner) private view {
        if (target != ticket && target != identity && target != address(organizers)) revert TargetNotAllowed();
        if (inner.length < 4) revert SelectorNotAllowed();
        bytes4 sel;
        assembly ("memory-safe") {
            sel := mload(add(inner, 0x20))
        }
        if (!allowedSelector[sel]) revert SelectorNotAllowed();
    }

    function _debit(uint256 orgId, address sender, uint256 amount) private {
        uint256 balance = _budget[orgId];
        if (balance < amount) revert BudgetExhausted();
        unchecked {
            _budget[orgId] = balance - amount;
        }
        emit BudgetDebited(orgId, sender, amount);
    }

    function _credit(uint256 orgId, uint256 amount) private {
        _budget[orgId] += amount;
        entryPoint.depositTo{value: amount}(address(this));
        emit Deposited(orgId, amount);
    }

    function _seedSelectors() private {
        // Ticket
        _allow("claim(uint256,uint8,bytes)");
        _allow("safeTransferFrom(address,address,uint256)");
        _allow("safeTransferFrom(address,address,uint256,bytes)");
        _allow("transferFrom(address,address,uint256)");
        _allow("checkIn(uint256,(uint256,uint256,uint64,bytes32),bytes)");
        _allow("requestOverride(uint256,uint256,uint8)");
        _allow("manualOverride(uint256,uint256,uint8)");
        _allow(
            "createEvent((uint256,bytes32,bytes32,string,uint64,uint64,bytes32,uint64,uint64,bool,uint32,uint8,bool,uint8,bytes32,bool),(string,uint256,uint32,uint32,uint16,bool)[])"
        );
        _allow(
            "updateEventMeta(uint256,(uint256,bytes32,bytes32,string,uint64,uint64,bytes32,uint64,uint64,bool,uint32,uint8,bool,uint8,bytes32,bool),(string,uint256,uint32,uint32,uint16,bool)[])"
        );
        _allow("publishEvent(uint256)");
        _allow("cancelEvent(uint256)");
        _allow("createOffer(uint256,bytes32,uint64)");
        _allow("cancelOffer(uint256)");
        _allow("acceptOffer(uint256,bytes)");
        _allow("migrate(uint256)");
        // Organizers
        _allow("registerGate(uint256,address,bytes32,bytes32)");
        _allow("openGate(uint256)");
        _allow("closeGate(uint256)");
        _allow("setAdmin(uint256,address,uint32)");
        _allow("setManager(uint256,address,bool,bool)");
        // Identity
        _allow("setActiveDevice(bytes32,bytes32)");
        _allow("lockDevice(address)");
        _allow("setNickname(bytes32,string)");
    }

    function _allow(string memory signature) private {
        allowedSelector[bytes4(keccak256(bytes(signature)))] = true;
    }
}
