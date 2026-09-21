// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {LibString} from "solady/utils/LibString.sol";
import {P256} from "solady/utils/P256.sol";
import {IIdentity} from "./interfaces/IIdentity.sol";
import {IOrganizers} from "./interfaces/IOrganizers.sol";
import {ITicket} from "./interfaces/ITicket.sol";

/// @title Ticket
/// @notice ERC-721 where every transfer rule lives in one _update override and every admission is an
///         append-only CheckIn record. The chain is the authority for the ADMIT decision (spec 7.4).
contract Ticket is ERC721, ITicket {
    using Strings for uint256;

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

    /// @notice 6.3 T11: 어테스터가 계정을 바꾼 뒤 티켓이 따라가기까지 본인에게 주는 유예.
    ///         본인은 Identity.cancelRotation() 으로 그 안에 되돌릴 수 있다.
    uint256 public constant MIGRATE_DELAY = 1 days;

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
    event EventMetaUpdated(uint256 indexed eventId);
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
    error RotationPending();

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

        emit EventMetaUpdated(eventId);
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

    function isRevoked(uint256 tokenId) external view returns (bool) {
        return _revoked[tokenId];
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
        // Same boundary as _update: at the cutoff instant itself the handoff is already closed, so an
        // offer opened here could never be collected.
        if (block.timestamp + m.transferCutoffSeconds >= m.startsAt) revert TransferCutoffPassed();
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
        // eventStatus promotes to Ended only from Published, so Ended and Cancelled are mutually
        // exclusive states, not a precedence: swapping these two lines would change nothing.
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

        // 회전된 계정이 티켓을 아직 들고 있을 수 있다. 잠금만으로도 막히지만(I2가 회전 시
        // 잠그므로) 두 컨트랙트의 불변식을 서로에게 기대지 않도록 여기서도 직접 묻는다.
        if (!identity.isMember(holder)) revert NotMember();
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

        if (_revoked[tokenId]) revert TicketRevoked();
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

    /// @notice Spec 5.5: an organizer voids a ticket and the chain keeps why. The reason code is the
    ///         organizer's own (chargeback, fraud, duplicate); the contract only records it. Voiding is
    ///         a state, not a toggle, so repeating it is not an error — it files a fresh reason — and a
    ///         ticket that already walked in can still be voided, because the record is the point.
    function revoke(uint256 tokenId, uint8 reason) external {
        if (_ownerOf(tokenId) == address(0)) revert NoSuchTicket();
        _requireEventPermission(_eventOf[tokenId], PERM_CREATE_EVENT);
        _revoked[tokenId] = true;
        emit Revoked(tokenId, reason);
    }

    /// @notice Spec 5.5: the attester rotated this person's account, so the ticket follows the person.
    ///         Transfer rules do not apply — nobody else is receiving anything, so the cutoff, the
    ///         transfer limit and maxPerWallet are all beside the point and transfersOf stays put.
    ///         Two checks survive anyway: a voided ticket must never move, and a spent one has nowhere
    ///         to go. Identity enforces the 7-day cooldown, so this only reads the result.
    function migrate(uint256 tokenId) external {
        address holder = _ownerOf(tokenId);
        if (holder == address(0)) revert NoSuchTicket();

        // Defensive: every path that hands a token to an account checks isMember first and personOf is
        // never cleared, so a live token's holder always has a personId. Kept so a future mint path
        // cannot silently report NotRotatedAccount for what is really an unregistered holder.
        bytes32 personId = identity.personOf(holder);
        if (personId == bytes32(0)) revert NotMember();
        address current = identity.accountOf(personId);
        if (current != msg.sender) revert NotRotatedAccount();
        if (current == holder) revert NothingToMigrate();
        // 침해된 어테스터의 조용한 즉시 절도를, 눈에 보이고 되돌릴 수 있는 절도로 바꾼다(C3).
        if (block.timestamp < uint256(identity.rotatedAt(personId)) + MIGRATE_DELAY) revert RotationPending();

        if (_revoked[tokenId]) revert TicketRevoked();
        if (_checkIns[tokenId].ts != 0) revert AlreadyCheckedIn();

        // _update clears any pending offer on the way through, so the old account's handoff dies here.
        _internalMove = true;
        _update(msg.sender, tokenId, address(0));
        _internalMove = false;

        emit Migrated(tokenId, holder, msg.sender);
    }

    /// @notice Everything the ticket shows comes from the chain (spec 10.2) — no server, no IPFS
    ///         metadata file, nothing to go stale. The status attribute is the one visible thing
    ///         admission changes: 입장 전 -> 입장 완료. A voided ticket reads 취소됨 whether or not it
    ///         ever walked in, which is the order the attendee app derives its state in too.
    ///         Tier names and image CIDs are typed by organizers, so both are JSON-escaped: a bare
    ///         quote would close the string early and let an organizer forge the attributes after it.
    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        if (_ownerOf(tokenId) == address(0)) revert NoSuchTicket();

        uint256 eventId = _eventOf[tokenId];
        EventMeta storage m = _events[eventId];
        Tier storage t = _tiers[eventId][_tierOf[tokenId]];

        // 5.8: 행사가 취소되면 그 행사의 티켓은 전부 취소됨이다. 일괄 revoke 루프는 티켓 수만큼
        // 가스가 드는 무한 확장이라 애초에 선택지가 아니므로, 상태를 만들지 않고 파생한다.
        // 우선순위는 무효(티켓 단위) -> 취소(행사 단위) -> 입장 완료 -> 입장 전이다.
        string memory status = unicode"입장 전";
        if (_revoked[tokenId] || eventStatus(eventId) == EventStatus.Cancelled) {
            status = unicode"취소됨";
        } else if (_checkIns[tokenId].ts != 0) {
            status = unicode"입장 완료";
        }

        string memory attributes = string.concat(
            '[{"trait_type":"Event","value":"',
            eventId.toString(),
            '"},{"trait_type":"Tier","value":"',
            LibString.escapeJSON(t.name),
            '"},{"trait_type":"Starts","display_type":"date","value":',
            uint256(m.startsAt).toString(),
            '},{"trait_type":"Seated","value":"',
            t.seated ? "true" : "false",
            '"},{"trait_type":"Transferable","value":"',
            m.transferable ? "true" : "false",
            unicode'"},{"trait_type":"상태","value":"',
            status,
            '"}]'
        );

        string memory json = string.concat(
            '{"name":"MONTI Ticket #',
            tokenId.toString(),
            '","description":"MONTI on-chain admission. The chain decides, not our server.',
            '","image":"ipfs://',
            LibString.escapeJSON(m.imageCid),
            '","attributes":',
            attributes,
            "}"
        );

        return string.concat("data:application/json;base64,", Base64.encode(bytes(json)));
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
                // 보내는 쪽부터 본다. "내 기기 잠금"(5.5)은 입장만이 아니라 자산도 얼려야 하고,
                // 회전으로 밀려난 계정은 migrate 전에 티켓을 빼돌릴 수 없어야 한다(I1).
                // 이 두 줄이 _internalMove 분기 '안'에 있는 것이 중요하다: migrate 자신이
                // 바로 그 잠기고 탈퇴한 계정에서 빼오는 동작이므로, 밖에 두면 복구가 죽는다.
                // isMember 를 isLocked 보다 먼저 묻는다 — 회전은 둘 다 참으로 만들고,
                // 그때 알려줄 사실은 "계정이 바뀌었다"이지 "키가 얼었다"가 아니다.
                if (!identity.isMember(from)) revert NotMember();
                if (identity.isLocked(from)) revert DeviceLocked();

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
