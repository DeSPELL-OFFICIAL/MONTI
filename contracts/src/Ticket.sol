// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {P256} from "solady/utils/P256.sol";
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
    uint256 public constant CLOCK_SKEW = 5;

    /// @notice The role tag carried by ManualOverride. ROLE_APPROVER is the owner or an admin holding
    ///         PERM_APPROVE_OVERRIDE; ROLE_MANAGER is a manager with canApprove. ROLE_NONE never admits.
    uint8 public constant ROLE_NONE = 0;
    uint8 public constant ROLE_APPROVER = 1;
    uint8 public constant ROLE_MANAGER = 2;

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
    error EventCancelled();
    error EventAlreadyClosed();
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
        EventStatus s = eventStatus(eventId);
        if (s == EventStatus.Cancelled || s == EventStatus.Ended) revert EventAlreadyClosed();
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

    /// @notice Free tiers only in the MVP (spec 5.2). A paid tier needs an attester voucher, which is
    ///         post-hackathon; passing a voucher today is an explicit error rather than a silent pass.
    function claim(uint256 eventId, uint8 tier, bytes calldata voucher) external returns (uint256 tokenId) {
        EventStatus s = eventStatus(eventId);
        if (s == EventStatus.Ended) revert EventEnded();
        if (s != EventStatus.Published) revert EventNotPublished();
        if (!identity.isMember(msg.sender)) revert NotMember();

        EventMeta storage m = _events[eventId];
        if (m.approvalRequired) revert ApprovalRequiredNotSupported();
        if (m.requireKyc && identity.kycLevelOf(msg.sender) < 1) revert KycRequired();
        if (block.timestamp < m.saleStart || block.timestamp > m.saleEnd) revert SaleClosed();
        if (tier >= _tiers[eventId].length) revert UnknownTier();

        Tier storage t = _tiers[eventId][tier];
        if (t.priceUsdCents != 0 || voucher.length != 0) revert PaidTiersNotEnabled();
        if (t.minted >= t.supply) revert SoldOut();
        if (_balanceOfEvent[msg.sender][eventId] >= t.maxPerWallet) revert MaxPerWalletExceeded();

        t.minted += 1;
        tokenId = _nextTokenId++;
        _eventOf[tokenId] = eventId;
        _tierOf[tokenId] = tier;
        _safeMint(msg.sender, tokenId);

        emit Claimed(tokenId, eventId, msg.sender, tier);
    }

    function eventOf(uint256 tokenId) external view returns (uint256) {
        return _eventOf[tokenId];
    }

    function tierOf(uint256 tokenId) external view returns (uint8) {
        return _tierOf[tokenId];
    }

    function balanceOfEvent(address account, uint256 eventId) external view returns (uint256) {
        return _balanceOfEvent[account][eventId];
    }

    function transfersOf(uint256 tokenId) external view returns (uint8) {
        return _transfers[tokenId];
    }

    function checkInOf(uint256 tokenId) external view returns (CheckIn memory) {
        return _checkIns[tokenId];
    }

    function offerOf(uint256 tokenId) external view returns (Offer memory) {
        return _offers[tokenId];
    }

    /// @notice Spec 5.4: the sender picks a recipient by phone number or nickname. The commitment is a
    ///         hash of that handle; the attester later signs "this account is that handle's owner".
    function createOffer(uint256 tokenId, bytes32 recipientCommitment, uint64 expiresAt) external {
        if (ownerOf(tokenId) != msg.sender) revert Unauthorized();
        EventMeta storage m = _events[_eventOf[tokenId]];
        if (_revoked[tokenId]) revert TicketRevoked();
        if (!m.transferable) revert TransfersDisabled();
        if (_checkIns[tokenId].ts != 0) revert AlreadyCheckedIn();
        if (block.timestamp + m.transferCutoffSeconds > m.startsAt) revert TransferCutoffPassed();
        if (_transfers[tokenId] >= m.maxTransfers) revert TransferLimitReached();
        if (expiresAt <= block.timestamp) revert OfferExpired();

        _offers[tokenId] = Offer({from: msg.sender, recipientCommitment: recipientCommitment, expiresAt: expiresAt});
        emit OfferCreated(tokenId, msg.sender, recipientCommitment, expiresAt);
    }

    function cancelOffer(uint256 tokenId) external {
        if (ownerOf(tokenId) != msg.sender) revert Unauthorized();
        if (_offers[tokenId].from == address(0)) revert NoOffer();
        delete _offers[tokenId];
        emit OfferCancelled(tokenId);
    }

    function acceptOffer(uint256 tokenId, bytes calldata attesterSig) external {
        Offer memory o = _offers[tokenId];
        if (o.from == address(0)) revert NoOffer();
        if (o.from != ownerOf(tokenId)) revert NoOffer();
        if (block.timestamp > o.expiresAt) revert OfferExpired();

        bytes32 digest = keccak256(abi.encode(tokenId, o.recipientCommitment, msg.sender));
        if (ECDSA.recover(digest, attesterSig) != identity.attester()) revert BadAttesterSig();

        delete _offers[tokenId];
        _update(msg.sender, tokenId, address(0));
        emit OfferAccepted(tokenId, o.from, msg.sender);
    }

    /// @notice Spec 7.2 step 6, checks in order: the ticket exists, it belongs to this event, the event
    ///         is still running, the ticket is spendable, the caller is this event's open gate, the code
    ///         is fresh, the device signature holds. Only an open gate of this event may call it. The
    ///         staff device maps each of these errors to a DENY code on screen (sub-plan 04), so the
    ///         names are part of the ABI.
    function checkIn(uint256 tokenId, GateCode calldata g, bytes calldata deviceSig) external {
        address holder = _ownerOf(tokenId);
        if (holder == address(0)) revert NoSuchTicket();

        uint256 eventId = _eventOf[tokenId];
        if (g.eventId != eventId) revert WrongEvent();
        EventStatus status = eventStatus(eventId);
        if (status == EventStatus.Ended) revert EventEnded();
        if (status == EventStatus.Cancelled) revert EventCancelled();
        if (_revoked[tokenId]) revert TicketRevoked();
        if (_checkIns[tokenId].ts != 0) revert AlreadyCheckedIn();

        if (!organizers.isOpenGate(eventId, msg.sender)) revert GateNotOpen();
        if (organizers.gateOf(msg.sender) != g.gateId) revert GateMismatch();
        // The gate phone's clock may run up to CLOCK_SKEW seconds ahead of the chain; past that the
        // stamp is a forgery, and CODE_WINDOW seconds behind it is a replay.
        if (g.issuedAt > block.timestamp + CLOCK_SKEW) revert CodeExpired();
        if (uint256(g.issuedAt) + CODE_WINDOW < block.timestamp) revert CodeExpired();

        if (identity.isLocked(holder)) revert DeviceLocked();
        (bytes32 x, bytes32 y) = identity.activeDevice(holder);

        if (deviceSig.length != 64) revert BadDeviceSignature();
        bytes32 h = sha256(abi.encode(tokenId, g.gateId, g.eventId, g.nonce, g.issuedAt));
        (bytes32 r, bytes32 s) = abi.decode(deviceSig, (bytes32, bytes32));
        if (!P256.verifySignature(h, r, s, x, y)) revert BadDeviceSignature();

        bytes32 nonceHash = keccak256(abi.encode(g.nonce));
        _checkIns[tokenId] =
            CheckIn({gateId: g.gateId, ts: uint64(block.timestamp), nonceHash: nonceHash, manual: false});
        if (_offers[tokenId].from != address(0)) {
            delete _offers[tokenId];
            emit OfferCancelled(tokenId);
        }

        emit CheckedIn(tokenId, eventId, g.gateId, nonceHash, uint64(block.timestamp));
    }

    /// @notice Spec 13: a manager without approval rights files a request; someone with rights admits.
    ///         Checks run authority first, so nothing about the ticket or the door is told to a stranger:
    ///         the ticket must exist (its event is what authority is measured against), the caller must
    ///         belong to that organizer, and only then must the gate be one of this event's gates — open
    ///         or closed, since a request is not a tap. An unregistered gateId (0 included) reports
    ///         eventId 0 and is rejected.
    function requestOverride(uint256 tokenId, uint256 gateId, uint8 reason) external {
        if (_ownerOf(tokenId) == address(0)) revert NoSuchTicket();
        uint256 eventId = _eventOf[tokenId];
        uint256 orgId = _events[eventId].orgId;

        (bool exists,) = organizers.managerOf(orgId, msg.sender);
        if (!exists && !organizers.hasPermission(orgId, msg.sender, PERM_APPROVE_OVERRIDE)) revert Unauthorized();

        (uint256 gateEventId,,,,,) = organizers.gateInfo(gateId);
        if (gateEventId != eventId) revert GateMismatch();
        emit OverrideRequested(tokenId, gateId, msg.sender, reason);
    }

    /// @notice ROLE_APPROVER = admin (or owner) holding PERM_APPROVE_OVERRIDE, ROLE_MANAGER = manager
    ///         with canApprove. The event and ticket must be admissible for the same reasons checkIn
    ///         demands; only the NFC tap itself is waived. Checks run authority first — the ticket has
    ///         to exist for its organizer to be known, then the caller must have approval rights, and
    ///         only then are the ticket's state, the event's status and the gate examined, so an
    ///         unauthorised caller learns nothing about the ticket. Emits CheckedIn as well so the
    ///         staff screen and the indexer watch one event only.
    function manualOverride(uint256 tokenId, uint256 gateId, uint8 reason) external {
        if (_ownerOf(tokenId) == address(0)) revert NoSuchTicket();
        uint256 eventId = _eventOf[tokenId];
        uint256 orgId = _events[eventId].orgId;

        uint8 role = ROLE_NONE;
        if (organizers.hasPermission(orgId, msg.sender, PERM_APPROVE_OVERRIDE)) {
            role = ROLE_APPROVER;
        } else {
            (bool exists, bool canApprove) = organizers.managerOf(orgId, msg.sender);
            if (exists && canApprove) role = ROLE_MANAGER;
        }
        if (role == ROLE_NONE) revert Unauthorized();

        if (_revoked[tokenId]) revert TicketRevoked();
        if (_checkIns[tokenId].ts != 0) revert AlreadyCheckedIn();
        EventStatus status = eventStatus(eventId);
        if (status == EventStatus.Ended) revert EventEnded();
        if (status == EventStatus.Cancelled) revert EventCancelled();
        (uint256 gateEventId,,,,,) = organizers.gateInfo(gateId);
        if (gateEventId != eventId) revert GateMismatch();

        _checkIns[tokenId] = CheckIn({gateId: gateId, ts: uint64(block.timestamp), nonceHash: bytes32(0), manual: true});
        if (_offers[tokenId].from != address(0)) {
            delete _offers[tokenId];
            emit OfferCancelled(tokenId);
        }

        emit ManualOverride(tokenId, gateId, msg.sender, role, reason);
        emit CheckedIn(tokenId, eventId, gateId, bytes32(0), uint64(block.timestamp));
    }

    function _requireEventPermission(uint256 eventId, uint32 bit) private view {
        uint256 orgId = _events[eventId].orgId;
        if (orgId == 0) revert UnknownEvent();
        if (!organizers.hasPermission(orgId, msg.sender, bit)) revert Unauthorized();
    }

    function eventOrg(uint256 eventId) external view returns (uint256) {
        return _events[eventId].orgId;
    }

    /// @notice Every transfer — from any app, any wallet, any relayer — passes through here (spec 10.2).
    ///         Mint (from == 0), burn (to == 0) and migrate (_internalMove) skip the rules.
    function _update(address to, uint256 tokenId, address auth) internal override returns (address) {
        address from = _ownerOf(tokenId);
        uint256 eventId = _eventOf[tokenId];

        if (from != address(0) && to != address(0)) {
            if (_offers[tokenId].from != address(0)) {
                delete _offers[tokenId];
                emit OfferCancelled(tokenId);
            }
            if (!_internalMove) {
                EventMeta storage m = _events[eventId];
                if (_revoked[tokenId]) revert TicketRevoked();
                if (!m.transferable) revert TransfersDisabled();
                if (_checkIns[tokenId].ts != 0) revert AlreadyCheckedIn();
                if (block.timestamp + m.transferCutoffSeconds >= m.startsAt) revert TransferCutoffPassed();
                if (!identity.isMember(to)) revert NotMember();
                if (m.requireKyc && identity.kycLevelOf(to) < 1) revert KycRequired();

                uint8 done = _transfers[tokenId];
                if (done >= m.maxTransfers) revert TransferLimitReached();

                Tier storage t = _tiers[eventId][_tierOf[tokenId]];
                if (_balanceOfEvent[to][eventId] >= t.maxPerWallet) revert MaxPerWalletExceeded();

                _transfers[tokenId] = done + 1;
            }
        }

        address previous = super._update(to, tokenId, auth);
        if (from != address(0)) _balanceOfEvent[from][eventId] -= 1;
        if (to != address(0)) _balanceOfEvent[to][eventId] += 1;
        return previous;
    }
}
