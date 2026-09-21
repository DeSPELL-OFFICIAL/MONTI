// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {IPaymaster} from "account-abstraction/interfaces/IPaymaster.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {UserOperation} from "account-abstraction/interfaces/UserOperation.sol";
import {IIdentity} from "./interfaces/IIdentity.sol";
import {IOrganizers} from "./interfaces/IOrganizers.sol";
import {ITicket} from "./interfaces/ITicket.sol";

/// @title MontiPaymaster
/// @notice EntryPoint v0.6 paymaster: MONTI pays the gas so an attendee never sees a balance.
///
///         There are two kinds of budget slot. The platform slot (`PLATFORM` = 0) is what MONTI funds and
///         is the default payer; `budget[orgId]` is a per-project slot used only while that organization
///         has opted in with `setSelfSponsored`. Which slot pays is **derived from the call the paymaster
///         has just verified** — never taken from the user operation — so a sender cannot spend another
///         project's budget or push its own costs onto MONTI.
///
/// @dev    The paymaster must be staked on the EntryPoint (ERC-7562): validation reads storage owned by
///         Identity, Organizers and Ticket, and `postOp` writes this contract's storage. Task 28 adds
///         `addStake`. Validation itself is `view` — nothing is debited until the EntryPoint reports the
///         real cost in `postOp`, which is what keeps a user-chosen `maxCost` from draining a slot.
contract MontiPaymaster is IPaymaster {
    /// @notice How an allowlisted selector names the project that should pay.
    enum ArgKind {
        None, // not sponsored
        Platform, // MONTI always pays: the call names no project
        EventId, // the argument is an eventId
        TokenId, // the argument is a tokenId
        OrgId // the argument is an orgId
    }

    /// @notice One inner call of a Coinbase Smart Wallet `executeBatch`.
    struct Call {
        address target;
        uint256 value;
        bytes data;
    }

    uint256 public constant PLATFORM = 0;
    uint256 public constant MAX_BATCH = 8;

    uint32 private constant PERM_MANAGE_BUDGET = 16;
    bytes4 private constant EXECUTE = bytes4(keccak256("execute(address,uint256,bytes)"));
    bytes4 private constant EXECUTE_BATCH = bytes4(keccak256("executeBatch((address,uint256,bytes)[])"));

    IEntryPoint public immutable entryPoint;
    IOrganizers public immutable organizers;
    ITicket public immutable ticket;
    IIdentity public immutable identity;
    address public immutable deployer;

    /// @dev Project slots only. The platform slot is not stored: see `budgetOf`.
    mapping(uint256 => uint256) private _orgBudget;
    /// @dev Sum of every project slot, so the platform slot can be derived from the EntryPoint deposit.
    uint256 private _orgBudgetTotal;

    mapping(uint256 => bool) public selfSponsored;
    mapping(bytes4 => ArgKind) public argKindOf;
    /// @dev Which 32-byte argument word carries the id named by `argKindOf` (0 unless stated).
    mapping(bytes4 => uint8) private _argWord;

    event Deposited(uint256 indexed orgId, uint256 amount);
    event BudgetDebited(uint256 indexed orgId, uint256 amount);
    event SponsorModeSet(uint256 indexed orgId, bool selfSponsored);

    error Unauthorized();
    error ZeroAddress();
    error NotEntryPoint();
    error NotMember();
    error TargetNotAllowed();
    error SelectorNotAllowed();
    error UnsupportedWalletCall();
    error BadCallData();
    error ValueNotAllowed();
    error BatchTooLong();
    error MixedBatchOrg();
    error UnknownSponsorTarget();
    error BudgetExhausted();
    error NoSuchOrganizer();

    constructor(IEntryPoint entryPoint_, IOrganizers organizers_, ITicket ticket_, IIdentity identity_) {
        if (
            address(entryPoint_) == address(0) || address(organizers_) == address(0) || address(ticket_) == address(0)
                || address(identity_) == address(0)
        ) revert ZeroAddress();
        entryPoint = entryPoint_;
        organizers = organizers_;
        ticket = ticket_;
        identity = identity_;
        deployer = msg.sender;
        _seedSelectors();
    }

    // --- Budgets -------------------------------------------------------------------------------------

    /// @notice The platform slot is whatever the EntryPoint holds beyond the projects' reserved wei, so
    ///         EntryPoint accounting drift lands here instead of stranding funds nobody can withdraw.
    function budgetOf(uint256 orgId) public view returns (uint256) {
        if (orgId != PLATFORM) return _orgBudget[orgId];
        uint256 deposited = entryPoint.balanceOf(address(this));
        uint256 reserved = _orgBudgetTotal;
        return deposited > reserved ? deposited - reserved : 0;
    }

    function depositPlatform() external payable {
        entryPoint.depositTo{value: msg.value}(address(this));
        emit Deposited(PLATFORM, msg.value);
    }

    function deposit(uint256 orgId) external payable {
        if (organizers.ownerOf(orgId) == address(0)) revert NoSuchOrganizer();
        _orgBudget[orgId] += msg.value;
        _orgBudgetTotal += msg.value;
        entryPoint.depositTo{value: msg.value}(address(this));
        emit Deposited(orgId, msg.value);
    }

    /// @dev Project slots are owner-only by design: `PERM_MANAGE_BUDGET` lets an admin flip
    ///      `setSelfSponsored`, but only the organization's owner may pull the money back out.
    function withdraw(uint256 orgId, uint256 amount) external {
        if (msg.sender != organizers.ownerOf(orgId)) revert Unauthorized();
        _orgBudget[orgId] -= amount;
        _orgBudgetTotal -= amount;
        entryPoint.withdrawTo(payable(msg.sender), amount);
    }

    function withdrawPlatform(address to, uint256 amount) external {
        if (msg.sender != deployer) revert Unauthorized();
        if (to == address(0)) revert ZeroAddress();
        if (amount > budgetOf(PLATFORM)) revert BudgetExhausted();
        entryPoint.withdrawTo(payable(to), amount);
    }

    function setSelfSponsored(uint256 orgId, bool on) external {
        if (!organizers.hasPermission(orgId, msg.sender, PERM_MANAGE_BUDGET)) revert Unauthorized();
        selfSponsored[orgId] = on;
        emit SponsorModeSet(orgId, on);
    }

    // --- Sponsorship ---------------------------------------------------------------------------------

    /// @notice `paymasterAndData` carries nothing but this contract's 20-byte address; anything appended
    ///         is ignored, because the paying slot comes from the verified call and not from the sender.
    function validatePaymasterUserOp(UserOperation calldata userOp, bytes32, uint256 maxCost)
        external
        view
        returns (bytes memory context, uint256 validationData)
    {
        if (msg.sender != address(entryPoint)) revert NotEntryPoint();
        if (!identity.isMember(userOp.sender)) revert NotMember();

        uint256 orgId = _requireAllowedCall(userOp.callData);
        uint256 slot = selfSponsored[orgId] ? orgId : PLATFORM;
        if (budgetOf(slot) < maxCost) revert BudgetExhausted();

        return (abi.encode(slot, maxCost), 0);
    }

    /// @notice Debits the real cost the EntryPoint reports, never the sender's `maxCost`.
    /// @dev    Must not revert whatever the mode: the gas is already spent, and a reverting `postOp` only
    ///         burns more of it. The platform slot needs no store — the EntryPoint has already taken
    ///         `actualGasCost` out of this paymaster's deposit, which is what `budgetOf(PLATFORM)` reads.
    function postOp(PostOpMode, bytes calldata context, uint256 actualGasCost) external {
        if (msg.sender != address(entryPoint)) revert NotEntryPoint();
        (uint256 slot,) = abi.decode(context, (uint256, uint256));

        if (slot != PLATFORM) {
            uint256 balance = _orgBudget[slot];
            uint256 debit = actualGasCost < balance ? actualGasCost : balance;
            unchecked {
                _orgBudget[slot] = balance - debit;
                _orgBudgetTotal -= debit;
            }
        }
        emit BudgetDebited(slot, actualGasCost);
    }

    function allowedSelector(bytes4 selector) public view returns (bool) {
        return argKindOf[selector] != ArgKind.None;
    }

    // --- Call inspection -----------------------------------------------------------------------------

    /// @dev Reads the wallet's `execute`/`executeBatch` payload and returns the project every inner call
    ///      agrees on (`PLATFORM` when none of them names one).
    function _requireAllowedCall(bytes calldata callData) private view returns (uint256 orgId) {
        if (callData.length < 4) revert UnsupportedWalletCall();
        bytes4 sel = bytes4(callData[0:4]);

        if (sel == EXECUTE) {
            // address + value + offset + length
            if (callData.length < 4 + 128) revert BadCallData();
            (address target, uint256 value, bytes memory inner) = abi.decode(callData[4:], (address, uint256, bytes));
            if (value != 0) revert ValueNotAllowed();
            return _checkInner(target, inner);
        }

        if (sel == EXECUTE_BATCH) {
            // offset + length
            if (callData.length < 4 + 64) revert BadCallData();
            Call[] memory calls = abi.decode(callData[4:], (Call[]));
            uint256 n = calls.length;
            if (n == 0) revert UnsupportedWalletCall();
            if (n > MAX_BATCH) revert BatchTooLong();

            bool named;
            for (uint256 i; i < n; ++i) {
                if (calls[i].value != 0) revert ValueNotAllowed();
                uint256 called = _checkInner(calls[i].target, calls[i].data);
                if (called == PLATFORM) continue;
                if (!named) {
                    orgId = called;
                    named = true;
                } else if (called != orgId) {
                    revert MixedBatchOrg();
                }
            }
            return orgId;
        }

        revert UnsupportedWalletCall();
    }

    function _checkInner(address target, bytes memory inner) private view returns (uint256 orgId) {
        if (target != address(ticket) && target != address(identity) && target != address(organizers)) {
            revert TargetNotAllowed();
        }
        if (inner.length < 4) revert SelectorNotAllowed();

        // casting to 'bytes4' is safe because the length check above guarantees a full selector
        // forge-lint: disable-next-line(unsafe-typecast)
        bytes4 sel = bytes4(inner);
        ArgKind kind = argKindOf[sel];
        if (kind == ArgKind.None) revert SelectorNotAllowed();
        if (kind == ArgKind.Platform) return PLATFORM;

        uint256 arg = _argAt(inner, _argWord[sel]);
        if (kind == ArgKind.TokenId) {
            uint256 eventId = ticket.eventOf(arg);
            if (eventId == 0) revert UnknownSponsorTarget();
            orgId = ticket.eventOrg(eventId);
        } else if (kind == ArgKind.EventId) {
            orgId = ticket.eventOrg(arg);
        } else {
            orgId = arg;
            if (organizers.ownerOf(orgId) == address(0)) revert UnknownSponsorTarget();
        }
        if (orgId == PLATFORM) revert UnknownSponsorTarget();
    }

    /// @dev The `word`-th 32-byte argument of an ABI-encoded call, bounds-checked.
    function _argAt(bytes memory inner, uint256 word) private pure returns (uint256 value) {
        uint256 offset = 4 + word * 32;
        if (inner.length < offset + 32) revert BadCallData();
        assembly ("memory-safe") {
            value := mload(add(add(inner, 0x20), offset))
        }
    }

    // --- Allowlist -----------------------------------------------------------------------------------

    function _seedSelectors() private {
        // Ticket — attendee
        _allow("claim(uint256,uint8,bytes)", ArgKind.EventId);
        _allow("safeTransferFrom(address,address,uint256)", ArgKind.TokenId, 2);
        _allow("safeTransferFrom(address,address,uint256,bytes)", ArgKind.TokenId, 2);
        _allow("transferFrom(address,address,uint256)", ArgKind.TokenId, 2);
        _allow("createOffer(uint256,bytes32,uint64)", ArgKind.TokenId);
        _allow("cancelOffer(uint256)", ArgKind.TokenId);
        _allow("acceptOffer(uint256,bytes)", ArgKind.TokenId);
        _allow("migrate(uint256)", ArgKind.TokenId);
        // Ticket — gate
        _allow("checkIn(uint256,(uint256,uint256,uint64,bytes32),bytes)", ArgKind.TokenId);
        _allow("requestOverride(uint256,uint256,uint8)", ArgKind.TokenId);
        _allow("manualOverride(uint256,uint256,uint8)", ArgKind.TokenId);
        // Ticket — organizer. createEvent names its org inside a dynamically offset struct, so it is not
        // decodable here without binding to Ticket's layout: MONTI pays for creating an event.
        _allow(
            "createEvent((uint256,bytes32,bytes32,string,uint64,uint64,bytes32,uint64,uint64,bool,uint32,uint8,bool,uint8,bytes32,bool),(string,uint256,uint32,uint32,uint16,bool)[])",
            ArgKind.Platform
        );
        _allow(
            "updateEventMeta(uint256,(uint256,bytes32,bytes32,string,uint64,uint64,bytes32,uint64,uint64,bool,uint32,uint8,bool,uint8,bytes32,bool),(string,uint256,uint32,uint32,uint16,bool)[])",
            ArgKind.EventId
        );
        _allow("publishEvent(uint256)", ArgKind.EventId);
        _allow("cancelEvent(uint256)", ArgKind.EventId);
        // Organizers. registerGate is keyed by the event, while openGate/closeGate name a gateId, which
        // resolves to a project only through a second lookup: MONTI pays for opening and closing gates.
        _allow("registerGate(uint256,address,bytes32,bytes32)", ArgKind.EventId);
        _allow("openGate(uint256)", ArgKind.Platform);
        _allow("closeGate(uint256)", ArgKind.Platform);
        _allow("setAdmin(uint256,address,uint32)", ArgKind.OrgId);
        _allow("setManager(uint256,address,bool,bool)", ArgKind.OrgId);
        // Identity — a person's own device and nickname, which belong to no project.
        _allow("setActiveDevice(bytes32,bytes32)", ArgKind.Platform);
        _allow("lockDevice(address)", ArgKind.Platform);
        _allow("setNickname(bytes32,string)", ArgKind.Platform);
    }

    function _allow(string memory signature, ArgKind kind) private {
        _allow(signature, kind, 0);
    }

    function _allow(string memory signature, ArgKind kind, uint8 word) private {
        bytes4 sel = bytes4(keccak256(bytes(signature)));
        argKindOf[sel] = kind;
        _argWord[sel] = word;
    }
}
