// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {LibString} from "solady/utils/LibString.sol";
import {P256} from "solady/utils/P256.sol";
import {IIdentity} from "./interfaces/IIdentity.sol";
import {IOrganizers} from "./interfaces/IOrganizers.sol";
import {ITicket} from "./interfaces/ITicket.sol";

/// @title Ticket
/// @notice ERC-721 where every transfer rule lives in one _update override and every admission is an
///         append-only CheckIn record. The chain is the authority for the ADMIT decision (spec 7.4).
contract Ticket is ERC721, EIP712, ITicket {
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
        /// @dev 스펙 12 의 오프라인 큐가 복구 후에 밀어 넣은 기록이다. manual 과 같은 슬롯에
        ///      들어가므로 저장 비용은 0이다.
        bool late;
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
    /// @notice 스펙 12 의 오프라인 큐가 살 수 있는 시간. 큐에 담긴 코드는 개장 이 시간 전부터
    ///         유효하고, 큐는 폐장 이 시간 뒤까지 흘릴 수 있다. 현장 창(CODE_WINDOW)과 무관하다.
    uint256 public constant LATE_WINDOW = 12 hours;

    /// @dev I8: 양도 승인 서명에 도메인을 묶는다. 이게 없으면 같은 서명이 테스트넷·메인넷·모든
    ///      재배포본에서 유효하고, 어테스터가 접두 없는 메시지 계열 두 개(이것과 오프라인
    ///      스냅샷)에 서명하는 상태가 된다. 도메인 분리자는 OZ EIP712 가 들고 있고, chainid 가
    ///      캐시와 다르면 스스로 다시 계산하므로 포크에서도 맞다.
    bytes32 private constant _TRANSFER_APPROVAL_TYPEHASH =
        keccak256("TransferApproval(uint256 tokenId,bytes32 recipientCommitment,address recipient)");

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
    /// @notice 큐에서 흘러들어온 입장. 같은 트랜잭션에서 CheckedIn 도 함께 나가므로, 입장 수를
    ///         세는 쪽은 CheckedIn 하나만 보면 되고 오프라인 비율을 세는 쪽만 이걸 본다(스펙 12).
    event CheckedInLate(uint256 indexed tokenId, uint256 indexed gateId, uint64 issuedAt, uint64 ts);
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

    constructor(address identity_, address organizers_) ERC721("MONTI Ticket", "MONTI") EIP712("MONTI Ticket", "1") {
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

    /// @notice acceptOffer 가 검증하는 그 값. 어테스터(02)가 자기 서명을 교차검증하는 데 쓴다.
    /// @dev    만료나 nonce 를 넣지 않는다: 어테스터가 서명하는 사실은 "이 계정이 그 핸들의
    ///         주인이다"이고 그건 지속되는 사실이며, 오퍼의 만료는 이미 온체인 Offer.expiresAt
    ///         이 강제한다. 같은 세 값에 대한 재사용은 같은 사람에게만 유효하므로 피해가 없다.
    function offerDigest(uint256 tokenId, bytes32 recipientCommitment, address recipient)
        public
        view
        returns (bytes32)
    {
        return _hashTypedDataV4(
            keccak256(abi.encode(_TRANSFER_APPROVAL_TYPEHASH, tokenId, recipientCommitment, recipient))
        );
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

        bytes32 digest = offerDigest(tokenId, o.recipientCommitment, msg.sender);
        if (ECDSA.recover(digest, attesterSig) != identity.attester()) revert BadAttesterSig();

        delete _offers[tokenId];
        _update(msg.sender, tokenId, address(0));
        emit OfferAccepted(tokenId, o.from, msg.sender);
    }

    /// @notice 스펙 7.2 6단계. 검사 순서: 티켓이 있고, 이 행사 것이고, 행사가 살아 있고, 티켓이
    ///         쓸 수 있고, 부르는 쪽이 이 행사의 열린 게이트이고, 코드가 신선하고, 기기 서명이
    ///         맞는가. 스태프 단말기가 이 에러들을 화면의 DENY 코드로 옮기므로(04) 이름이 ABI 다.
    function checkIn(uint256 tokenId, GateCode calldata g, bytes calldata deviceSig) external {
        _admit(tokenId, g, deviceSig, false);
    }

    /// @notice 스펙 12: 단말기가 인터넷을 잃으면 서명된 스냅샷으로 로컬 검증하고 "OFFLINE 승인"을
    ///         띄운 뒤 트랜잭션을 큐에 쌓아 복구 후 보낸다. 큐에 담긴 코드의 issuedAt 은 탭한
    ///         그때 그대로라 60초 창으로는 영영 들어올 수 없다(C1). 증명은 똑같다 — 관객 기기 키
    ///         서명이 여전히 필수이므로 단말기 혼자서는 만들 수 없다(T15). 다른 것은 시계뿐이다:
    ///         코드는 개장 LATE_WINDOW 전부터 유효하고, 제출은 폐장 LATE_WINDOW 후까지 받는다.
    ///         게이트가 '열려' 있을 필요는 없다 — 열림은 문을 여닫는 스위치이고, 늦은 제출은
    ///         문이 아니라 장부다. 폐기된 게이트는 여전히 어느 경로로도 못 쓴다(T14).
    /// @dev    이 경로는 현장 경로보다 느슨하므로 등록된 게이트는 60초 규칙을 피해 갈 수 있다.
    ///         얻을 것은 없고(관객은 어차피 들어오려던 참이다) 남는 것은 그리핑이며, 대응은 T14 와
    ///         같은 revokeGate 다. 며칠 전에 서명을 수확해 두는 공격은 issuedAt 하한이 막는다.
    function checkInLate(uint256 tokenId, GateCode calldata g, bytes calldata deviceSig) external {
        _admit(tokenId, g, deviceSig, true);
    }

    /// @dev 두 입장 경로의 공통 본문. 복사본을 두지 않는 이유는 크기가 아니라 안전이다:
    ///      두 경로의 검사 순서가 한 글자라도 갈라지면 한쪽에만 있는 구멍이 생긴다.
    function _admit(uint256 tokenId, GateCode calldata g, bytes calldata deviceSig, bool late) private {
        address holder = _ownerOf(tokenId);
        if (holder == address(0)) revert NoSuchTicket();

        uint256 eventId = _eventOf[tokenId];
        if (g.eventId != eventId) revert WrongEvent();

        EventMeta storage m = _events[eventId];
        // 살아 있는 토큰의 행사는 Published 이거나 Cancelled 뿐이다(claim 이 Published 만 받고
        // 상태는 Draft 로 되돌아가지 않는다). 그래서 eventStatus() 대신 두 가지만 직접 본다.
        if (_status[eventId] == EventStatus.Cancelled) revert EventCancelled();
        if (block.timestamp > uint256(m.endsAt) + (late ? LATE_WINDOW : 0)) revert EventEnded();
        if (_revoked[tokenId]) revert TicketRevoked();
        if (_checkIns[tokenId].ts != 0) revert AlreadyCheckedIn();

        if (late) {
            // 열려 있는지는 묻지 않는다. 폐기 여부는 묻는다(T14).
            (uint256 gateEventId,,,,, bool gateRevoked) = organizers.gateInfo(g.gateId);
            if (gateEventId != eventId || gateRevoked) revert GateNotOpen();
        } else if (!organizers.isOpenGate(eventId, msg.sender)) {
            revert GateNotOpen();
        }
        if (organizers.gateOf(msg.sender) != g.gateId) revert GateMismatch();

        // 게이트 폰의 시계는 체인보다 CLOCK_SKEW 초까지 앞설 수 있다. 그 너머는 위조다.
        if (g.issuedAt > block.timestamp + CLOCK_SKEW) revert CodeExpired();
        if (late) {
            // 개장 LATE_WINDOW 전보다 옛 코드는 받지 않는다. 넓은 창이 만드는 단 하나의 새 위험이
            // 게이트의 서명 사전 수확이고, 이 줄이 그것을 죽인다.
            if (uint256(g.issuedAt) + LATE_WINDOW < m.startsAt) revert CodeExpired();
        } else if (uint256(g.issuedAt) + CODE_WINDOW < block.timestamp) {
            revert CodeExpired();
        }

        // 중괄호는 스타일이 아니라 필요다: `late` 가 한 슬롯을 더 먹어서 이 다섯 지역변수가
        // 다음 문장까지 살아 있으면 legacy 코드젠이 stack too deep 으로 죽는다. 블록을 닫아
        // 죽은 변수를 버린다 — 검사 순서는 한 줄도 바뀌지 않았다.
        {
            // 회전된 계정이 티켓을 아직 들고 있을 수 있다. 잠금만으로도 막히지만(I2가 회전 시
            // 잠그므로) 두 컨트랙트의 불변식을 서로에게 기대지 않도록 여기서도 직접 묻는다.
            if (!identity.isMember(holder)) revert NotMember();
            if (identity.isLocked(holder)) revert DeviceLocked();
            (bytes32 x, bytes32 y) = identity.activeDevice(holder);

            if (deviceSig.length != 64) revert BadDeviceSignature();
            bytes32 h = sha256(abi.encode(tokenId, g.gateId, g.eventId, g.nonce, g.issuedAt));
            (bytes32 r, bytes32 s) = abi.decode(deviceSig, (bytes32, bytes32));
            if (!P256.verifySignature(h, r, s, x, y)) revert BadDeviceSignature();
        }

        bytes32 nonceHash = keccak256(abi.encode(g.nonce));
        _checkIns[tokenId] =
            CheckIn({gateId: g.gateId, ts: uint64(block.timestamp), nonceHash: nonceHash, manual: false, late: late});
        if (_offers[tokenId].from != address(0)) {
            delete _offers[tokenId];
            emit OfferCancelled(tokenId);
        }

        if (late) emit CheckedInLate(tokenId, g.gateId, g.issuedAt, uint64(block.timestamp));
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
        // manualOverride 와 같은 기준이다: 승인할 수 없는 요청은 올라가지 않는다(Minor 5).
        EventStatus status = eventStatus(eventId);
        if (status == EventStatus.Ended) revert EventEnded();
        if (status == EventStatus.Cancelled) revert EventCancelled();
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

        _checkIns[tokenId] =
            CheckIn({gateId: gateId, ts: uint64(block.timestamp), nonceHash: bytes32(0), manual: true, late: false});
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

        // Gap B. cancelRotation 은 밀려난 계정을 되살리면서 _personOf[새 계정] 을 지운다. 그래서
        // 되돌리기 창이 열려 있는 동안 새 계정이 받아 둔 티켓은 취소 한 번에 벽돌이 된다 — 그
        // 계정은 더 이상 멤버가 아니므로 _update(NotMember) 로도, checkIn(NotMember) 으로도,
        // migrate(NotRotatedAccount) 로도 구할 수 없다. 그래서 창이 닫힐 때까지 아무것도 받지
        // 않는다. 잃는 것은 없고 밀리는 것은 24시간, 즉 migrate 가 이미 기다리는 그 시간이다.
        //
        // 판정은 rotatedAt 하나로 하지 않는다. register 도 그 스탬프를 찍고(Identity:77),
        // cancelRotation 은 그것을 일부러 되감지 않으므로(어테스터에게 7일 쿨다운을 그대로
        // 물리기 위해서다), 스탬프만 보면 갓 등록한 사람과 이미 되돌린 사람까지 묶인다.
        // "지금 되돌릴 수 있는 회전" 은 rotatedFrom 한 칸이 들고 있고 취소가 그것을 비운다.
        //
        // _internalMove(migrate) 는 면제다 — migrate 자신이 MIGRATE_DELAY 로 같은 창을 기다리고,
        // 창이 닫힌 뒤에만 통한다. 소각(to == 0)도 받는 계정이 없으므로 해당 없다.
        if (to != address(0) && !_internalMove) {
            bytes32 personId = identity.personOf(to);
            if (personId != bytes32(0) && identity.rotatedFrom(personId) != address(0)) {
                uint256 opened = uint256(identity.rotatedAt(personId));
                if (block.timestamp < opened + identity.ROTATION_UNDO_WINDOW()) revert RotationPending();
            }
        }

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
                // 취소된 행사의 티켓으로는 문을 통과할 수 없으므로(checkIn 의 EventCancelled),
                // 그것을 남에게 넘기는 것은 쓸모없는 것을 떠넘기는 일이다. Ended 는 보지 않는다 —
                // 끝난 행사의 양도는 이미 transferCutoff 가 훨씬 앞에서 닫는다. migrate 는 이
                // 블록 자체를 건너뛰므로(_internalMove) 계정 복구는 행사 상태와 무관하다.
                if (_status[eventId] == EventStatus.Cancelled) revert EventCancelled();
                if (!m.transferable) revert TransfersDisabled();
                if (_checkIns[tokenId].ts != 0) revert AlreadyCheckedIn();
                if (block.timestamp + m.transferCutoffSeconds >= m.startsAt) revert TransferCutoffPassed();
                if (!identity.isMember(to)) revert NotMember();
                // 받는 쪽도 같은 기준으로 얼린다. 잠긴 계정은 그 티켓으로 문을 통과할 수 없으므로
                // (checkIn 의 DeviceLocked), 거기로 밀어 넣는 것은 티켓을 잠금이 풀릴 때까지
                // 묶어두는 일일 뿐이다. 순서는 보내는 쪽과 같다 — 먼저 멤버인지, 다음에 잠겼는지.
                if (identity.isLocked(to)) revert DeviceLocked();
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
