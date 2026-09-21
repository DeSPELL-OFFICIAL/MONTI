// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IIdentity} from "./interfaces/IIdentity.sol";
import {IOrganizers} from "./interfaces/IOrganizers.sol";
import {ITicket} from "./interfaces/ITicket.sol";

/// @title Ticket
/// @notice ERC-721 where every transfer rule lives in one _update override and every admission is an
///         append-only CheckIn record. The chain is the authority for the ADMIT decision (spec 7.4).
contract Ticket is ERC721, ITicket {
    struct EventMeta {
        uint256 orgId;
        bytes32 titleHash;
        bytes32 descHash;
        string imageCid;
        uint64 startsAt;
        uint64 endsAt;
        bytes32 venueHash;
        uint64 saleStart;
        uint64 saleEnd;
        bool transferable;
        uint32 transferCutoffSeconds;
        uint8 maxTransfers;
        bool approvalRequired;
        uint8 category;
        bytes32 regionCode;
        bool requireKyc;
    }

    struct Tier {
        string name;
        uint256 priceUsdCents;
        uint32 supply;
        uint32 minted;
        uint16 maxPerWallet;
        bool seated;
    }

    struct GateCode {
        uint256 gateId;
        uint256 eventId;
        uint64 issuedAt;
        bytes32 nonce;
    }

    struct CheckIn {
        uint256 gateId;
        uint64 ts;
        bytes32 nonceHash;
        bool manual;
    }

    struct Offer {
        address from;
        bytes32 recipientCommitment;
        uint64 expiresAt;
    }

    enum EventStatus {
        Draft,
        Published,
        Cancelled,
        Ended
    }

    uint256 public constant CODE_WINDOW = 60;

    uint32 private constant PERM_CREATE_EVENT = 1;
    uint32 private constant PERM_MANAGE_GATES = 2;
    uint32 private constant PERM_APPROVE_OVERRIDE = 4;

    IIdentity public immutable identity;
    IOrganizers public immutable organizers;

    uint256 private _nextEventId = 1;
    uint256 private _nextTokenId = 1;
    bool private _internalMove;

    mapping(uint256 => EventMeta) private _events;
    mapping(uint256 => Tier[]) private _tiers;
    mapping(uint256 => EventStatus) private _status;
    mapping(uint256 => uint256) private _eventOf;
    mapping(uint256 => uint8) private _tierOf;
    mapping(uint256 => CheckIn) private _checkIns;
    mapping(uint256 => uint8) private _transfers;
    mapping(uint256 => bool) private _revoked;
    mapping(uint256 => Offer) private _offers;
    mapping(address => mapping(uint256 => uint256)) private _balanceOfEvent;

    event EventCreated(uint256 indexed eventId, uint256 indexed orgId, address indexed creator);
    event EventStatusChanged(uint256 indexed eventId, uint8 status);
    event Claimed(uint256 indexed tokenId, uint256 indexed eventId, address indexed to, uint8 tier);
    event CheckedIn(
        uint256 indexed tokenId, uint256 indexed eventId, uint256 indexed gateId, bytes32 nonceHash, uint64 ts
    );
    event OverrideRequested(uint256 indexed tokenId, uint256 indexed gateId, address indexed requester, uint8 reason);
    event ManualOverride(
        uint256 indexed tokenId, uint256 indexed gateId, address indexed approver, uint8 role, uint8 reason
    );
    event Revoked(uint256 indexed tokenId, uint8 reason);
    event Migrated(uint256 indexed tokenId, address indexed from, address indexed to);
    event OfferCreated(uint256 indexed tokenId, address indexed from, bytes32 recipientCommitment, uint64 expiresAt);
    event OfferCancelled(uint256 indexed tokenId);
    event OfferAccepted(uint256 indexed tokenId, address indexed from, address indexed to);

    error Unauthorized();
    error InvalidTiers();
    error InvalidSchedule();
    error UnknownEvent();
    error UnknownTier();
    error NoSuchTicket();
    error NotDraft();
    error EventNotPublished();
    error EventEnded();
    error SaleClosed();
    error SoldOut();
    error MaxPerWalletExceeded();
    error ApprovalRequiredNotSupported();
    error KycRequired();
    error PaidTiersNotEnabled();
    error NotMember();
    error TransfersDisabled();
    error TransferCutoffPassed();
    error TransferLimitReached();
    error AlreadyCheckedIn();
    error TicketRevoked();
    error GateNotOpen();
    error GateMismatch();
    error WrongEvent();
    error CodeExpired();
    error DeviceLocked();
    error NoActiveDevice();
    error BadDeviceSignature();
    error NoOffer();
    error OfferExpired();
    error BadAttesterSig();
    error NotRotatedAccount();
    error NothingToMigrate();

    constructor(address identity_, address organizers_) ERC721("MONTI Ticket", "MONTI") {
        identity = IIdentity(identity_);
        organizers = IOrganizers(organizers_);
    }

    function createEvent(EventMeta calldata meta, Tier[] calldata tiers_) external returns (uint256 eventId) {
        if (!organizers.hasPermission(meta.orgId, msg.sender, PERM_CREATE_EVENT)) revert Unauthorized();
        if (tiers_.length == 0 || tiers_.length > 8) revert InvalidTiers();
        if (meta.startsAt >= meta.endsAt || meta.saleStart >= meta.saleEnd) revert InvalidSchedule();

        eventId = _nextEventId++;
        _events[eventId] = meta;
        _status[eventId] = EventStatus.Draft;
        for (uint256 i; i < tiers_.length; ++i) {
            Tier memory t = tiers_[i];
            t.minted = 0;
            _tiers[eventId].push(t);
        }

        emit EventCreated(eventId, meta.orgId, msg.sender);
        emit EventStatusChanged(eventId, uint8(EventStatus.Draft));
    }

    function eventMeta(uint256 eventId) external view returns (EventMeta memory) {
        return _events[eventId];
    }

    function tiers(uint256 eventId) external view returns (Tier[] memory) {
        return _tiers[eventId];
    }

    function publishEvent(uint256 eventId) external {
        _requireEventPermission(eventId, PERM_CREATE_EVENT);
        if (_status[eventId] != EventStatus.Draft) revert NotDraft();
        _status[eventId] = EventStatus.Published;
        emit EventStatusChanged(eventId, uint8(EventStatus.Published));
    }

    function cancelEvent(uint256 eventId) external {
        _requireEventPermission(eventId, PERM_CREATE_EVENT);
        _status[eventId] = EventStatus.Cancelled;
        emit EventStatusChanged(eventId, uint8(EventStatus.Cancelled));
    }

    function updateEventMeta(uint256 eventId, EventMeta calldata meta, Tier[] calldata tiers_) external {
        _requireEventPermission(eventId, PERM_CREATE_EVENT);
        if (_status[eventId] != EventStatus.Draft) revert NotDraft();
        if (tiers_.length == 0 || tiers_.length > 8) revert InvalidTiers();
        if (meta.startsAt >= meta.endsAt || meta.saleStart >= meta.saleEnd) revert InvalidSchedule();

        uint256 keptOrg = _events[eventId].orgId;
        _events[eventId] = meta;
        _events[eventId].orgId = keptOrg;

        delete _tiers[eventId];
        for (uint256 i; i < tiers_.length; ++i) {
            Tier memory t = tiers_[i];
            t.minted = 0;
            _tiers[eventId].push(t);
        }
    }

    /// @notice Ended is derived from endsAt so no transaction is needed to close an event.
    function eventStatus(uint256 eventId) public view returns (EventStatus) {
        EventStatus s = _status[eventId];
        if (s == EventStatus.Published && block.timestamp > _events[eventId].endsAt) return EventStatus.Ended;
        return s;
    }

    function _requireEventPermission(uint256 eventId, uint32 bit) private view {
        uint256 orgId = _events[eventId].orgId;
        if (orgId == 0) revert UnknownEvent();
        if (!organizers.hasPermission(orgId, msg.sender, bit)) revert Unauthorized();
    }

    function eventOrg(uint256 eventId) external view returns (uint256) {
        return _events[eventId].orgId;
    }
}
