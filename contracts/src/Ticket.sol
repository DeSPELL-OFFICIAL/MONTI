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
/// @notice ERC-721 where every transfer rule lives in one _update override and every admission is a
///         packed `usedAt` timestamp. The chain is the authority for the ADMIT decision (spec 7.4).
///
///         관객의 두 고빈도 동작(발급·입장)이 릴레이된 일반 트랜잭션으로 옮겨졌다(2026-09-28 설계).
///         관객 폰은 기기 키로 짧은 승인서/탭에 서명하고, MONTI 릴레이어 EOA 가 그 서명을 대신
///         제출한다. 그래서 `claimFor`/`requestClaimFor`/`checkInFor`/`checkInForLate` 는 전부
///         **permissionless** 다 — msg.sender 를 인가에 쓰지 않고, 권한은 서명이 증명한다.
///
///         슬림 저장 구조(설계 §12, 창업자 승인):
///         - tokenId 가 `eventId·tier·serial` 을 인코딩한다. 토큰별 eventOf/tierOf 저장 슬롯은 없다.
///           비트 레이아웃: [96..256) eventId · [88..96) tier · [0..88) serial.
///         - (eventId, account) 당 슬롯 하나에 claim nonce + 보유 수 + 대기 수를 패킹한다(`Wallet`).
///         - 입장 시각은 티켓별 `uint32 usedAt` 으로, 한 슬롯에 8장씩 패킹한다(`_usedAtWords`).
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

    /// @notice 릴레이된 발급의 승인서. 관객 기기 키(P-256)가 `claimAuthDigest` 에 서명한다.
    ///         `account` 는 티켓을 받을 스마트 계정(수신자)이고, `nonce` 는 (eventId, account) 별
    ///         claim nonce(== claimNonce(eventId, account))다. `deadline` 은 미제출 승인서의 수명을
    ///         제한한다(block.timestamp <= deadline).
    struct ClaimAuth {
        uint256 eventId;
        uint8 tier;
        address account;
        uint256 nonce;
        uint64 deadline;
    }

    /// @notice `checkInOf` 의 반환 튜플. 슬림 저장(설계 §12-2)으로 실제 온체인에 남는 것은 `ts`
    ///         (== usedAt) 뿐이고, gateId·nonceHash·manual·late 는 항상 0/false 로 돌려준다 —
    ///         그 정보는 CheckedIn / CheckedInLate / ManualOverride 이벤트에만 남는다. 와이어
    ///         순서(viem·Envio 가 디코딩하는 순서)를 고정하려고 필드 순서를 유지한다.
    struct CheckIn {
        uint256 gateId;
        bytes32 nonceHash;
        uint64 ts;
        bool manual;
        bool late;
    }

    struct Offer {
        address from;
        bytes32 recipientCommitment;
        uint64 expiresAt;
    }

    /// @notice (eventId, account) 당 한 슬롯. `nonce` 는 릴레이 발급 승인서의 재생 방지 카운터,
    ///         `held` 는 그 행사에서 지금 보유한 티켓 수(== balanceOfEvent), `pending` 은 승인제
    ///         대기 신청 수. 세 값이 uint64+uint32+uint32 = 128비트로 한 슬롯에 든다. 첫 발급 때
    ///         콜드 슬롯 하나만 연다(설계 §12-1). 재생 방지 강도는 승인서에 eventId 가 이미
    ///         들어 있으므로 전역 nonce 와 동일하다.
    struct Wallet {
        uint64 nonce;
        uint32 held;
        uint32 pending;
    }

    /// @notice 승인제(01c) 신청 레코드. `eventId` 는 바깥 매핑의 키이므로 구조체에 두지 않는다.
    ///         status: 0 대기(pending) · 1 승인(approved) · 2 거절/취소(rejected). 세 필드가 한
    ///         슬롯에 들어간다(address 20B + uint8 + uint8).
    struct ClaimRequest {
        address requester;
        uint8 tier;
        uint8 status;
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

    /// @notice 릴레이 발급 승인서의 목적 태그. claim 다이제스트를 게이트 코드/체크인 다이제스트와
    ///         구조적으로 분리한다(설계 §2). 다이제스트 선두에 이 32바이트 상수가 오므로 한 서명을
    ///         다른 경로에 재사용하는 것이 불가능하다.
    bytes32 private constant CLAIM_AUTH_TAG = keccak256("MONTI:CLAIM_AUTH:v1");

    // --- tokenId 비트 레이아웃 (설계 §12-1) ---------------------------------------------------------
    // [0..88)   serial   — 전역 발급 순번(usedAt 패킹의 키). ≥ 2^32 보장(88비트).
    // [88..96)  tier     — uint8 티어.
    // [96..256) eventId  — 행사 id. ≥ 2^64 보장(160비트).
    uint256 private constant _TIER_SHIFT = 88;
    uint256 private constant _EVENT_SHIFT = 96;
    uint256 private constant _SERIAL_MASK = (uint256(1) << 88) - 1;
    uint256 private constant _MAX_EVENT_ID = (uint256(1) << 160) - 1;

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
    /// @notice 승인제(01c)에서 approveClaims/rejectClaims 를 부를 수 있는 관리자 권한 비트.
    ///         권한 비트는 Organizers 의 `_adminBits` 한 네임스페이스를 Ticket 과 Organizers 가
    ///         함께 쓴다: 1·2·4 는 여기, 8(PERM_MANAGE_MANAGERS)·16(PERM_MANAGE_BUDGET)은
    ///         Organizers 가 이미 잡고 있으므로 다음 빈 비트는 32 다. 소유자는 언제나 전 비트를
    ///         가지므로(Organizers.hasPermission) 소유자용 분기는 따로 두지 않는다.
    uint32 private constant PERM_APPROVE_CLAIM = 32;

    IIdentity public immutable identity;
    IOrganizers public immutable organizers;

    uint256 private _nextEventId = 1;
    /// @notice 다음 티켓의 전역 순번(serial). tokenId 에 인코딩되고 usedAt 패킹의 키가 된다.
    uint256 private _nextSerial = 1;
    bool private _internalMove;

    mapping(uint256 => EventMeta) private _events;
    mapping(uint256 => Tier[]) private _tiers;
    mapping(uint256 => EventStatus) private _status;
    mapping(uint256 => uint8) private _transfers;
    mapping(uint256 => bool) private _revoked;
    mapping(uint256 => Offer) private _offers;

    /// @notice (eventId, account) => 패킹된 nonce/held/pending. balanceOfEvent·claimNonce·대기 카운트가
    ///         전부 여기서 나온다(설계 §12-1).
    mapping(uint256 => mapping(address => Wallet)) private _wallet;

    /// @notice 입장 시각 압축 저장(설계 §12-2). 키 = serial/8, 워드 하나에 uint32 usedAt 8장이
    ///         `(serial % 8) * 32bit` 오프셋으로 들어간다. usedAt == 0 이 미사용, != 0 이 사용됨.
    ///         8의 배수가 아니어도(부분 마지막 슬롯) 동작한다.
    mapping(uint256 => uint256) private _usedAtWords;

    /// @notice 승인제(01c): eventId => requestId => 신청. requestId 는 이벤트마다 1부터 증가한다.
    mapping(uint256 => mapping(uint256 => ClaimRequest)) private _claimRequests;
    /// @notice eventId => 마지막으로 발급한 requestId. 다음 신청은 여기에 +1 한 값을 받는다.
    mapping(uint256 => uint256) private _lastRequestId;
    /// @notice eventId => 아직 대기(status 0)인 신청 수. 주최자 화면의 뱃지·목록 크기에 쓴다.
    mapping(uint256 => uint256) private _pendingCount;

    event EventCreated(uint256 indexed eventId, uint256 indexed orgId, address indexed creator);
    event EventStatusChanged(uint256 indexed eventId, uint8 status);
    event EventMetaUpdated(uint256 indexed eventId);
    event Claimed(uint256 indexed tokenId, uint256 indexed eventId, address indexed to, uint8 tier);
    /// @notice 승인제(01c). 신청이 접수됐다. 아직 민팅은 없다. eventId·requestId·requester 셋을
    ///         인덱싱해 인덱서가 이벤트·요청·신청자별로 거를 수 있게 한다.
    event ClaimRequested(uint256 indexed eventId, uint256 indexed requestId, address indexed requester, uint8 tier);
    /// @notice 승인제(01c). 신청이 승인돼 tokenId 가 민팅됐다. 같은 트랜잭션에서 Claimed 도 나가므로
    ///         인덱서의 Ticket 행은 직접 claim 과 동일하게 만들어진다.
    event ClaimApproved(uint256 indexed eventId, uint256 indexed requestId, uint256 tokenId);
    /// @notice 승인제(01c). 신청이 거절되거나 신청자가 취소했다. 어느 쪽이든 예약한 공급·지갑 한도가
    ///         풀린다(취소도 같은 종료 이벤트를 써서 인덱서가 이벤트 하나만 보면 되게 한다).
    event ClaimRejected(uint256 indexed eventId, uint256 indexed requestId);
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
    error ApprovalRequired();
    error ApprovalNotRequired();
    error RequestNotPending();
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
    error BadGateSignature();
    error AuthExpired();
    error BadNonce();
    error SerialOverflow();
    error EventIdOverflow();
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
        if (eventId > _MAX_EVENT_ID) revert EventIdOverflow();
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

    // --- 릴레이된 발급 (claimFor / requestClaimFor) --------------------------------------------------

    /// @notice 관객 기기가 서명해야 하는 발급 승인서의 32바이트. `offerDigest`·`deviceDigest` 와
    ///         같은 이유로 공개한다: 03 의 지갑과 백엔드가 자기 계산을 체인과 대조할 수 있어야 한다.
    /// @dev    선두의 CLAIM_AUTH_TAG + chainid + 이 컨트랙트 주소가 게이트 코드/체크인 다이제스트와
    ///         프리이미지를 갈라 놓아 한 서명의 타 경로 재사용을 막는다(설계 §2/§8). chainid 와
    ///         address(this) 는 인자가 아니라 안에서 채운다 — 호출자가 고를 수 있으면 교차검증용으로
    ///         아무것도 증명하지 못한다.
    function claimAuthDigest(ClaimAuth calldata a) public view returns (bytes32) {
        return sha256(
            abi.encode(CLAIM_AUTH_TAG, block.chainid, address(this), a.eventId, a.tier, a.account, a.nonce, a.deadline)
        );
    }

    /// @notice (eventId, account) 별 발급 nonce. 클라이언트가 다음 승인서의 nonce 로 읽는다.
    function claimNonce(uint256 eventId, address account) external view returns (uint256) {
        return _wallet[eventId][account].nonce;
    }

    /// @notice 릴레이된 발급. 누구나 제출할 수 있다(permissionless) — msg.sender 는 인가에 쓰이지
    ///         않고, 권한은 관객 기기 서명이 증명한다(설계 §3). 승인제 이벤트는 여기서 막히고
    ///         requestClaimFor 경로만 발급한다.
    function claimFor(ClaimAuth calldata a, bytes calldata deviceSig) external returns (uint256 tokenId) {
        _verifyClaimAuth(a, deviceSig);
        return _claimTo(a.eventId, a.tier, a.account);
    }

    /// @notice 릴레이된 승인제 신청. claimFor 와 같은 검증 후 requestClaim 본문을 실행한다.
    function requestClaimFor(ClaimAuth calldata a, bytes calldata deviceSig) external returns (uint256 requestId) {
        _verifyClaimAuth(a, deviceSig);
        return _requestClaimFrom(a.eventId, a.tier, a.account);
    }

    /// @dev 승인서 검증(설계 §2/§3). deadline·nonce·isMember·!isLocked·기기 P-256 을 확인하고,
    ///      민팅 전에 nonce 를 소비한다(checks-effects-interactions). 검증 실패 사유는 스태프/백엔드가
    ///      DENY 코드로 옮기므로 이름이 곧 ABI 다.
    function _verifyClaimAuth(ClaimAuth calldata a, bytes calldata deviceSig) private {
        if (block.timestamp > a.deadline) revert AuthExpired();
        Wallet storage w = _wallet[a.eventId][a.account];
        if (a.nonce != w.nonce) revert BadNonce();
        if (!identity.isMember(a.account)) revert NotMember();
        if (identity.isLocked(a.account)) revert DeviceLocked();
        (bytes32 x, bytes32 y) = identity.activeDevice(a.account);
        if (deviceSig.length != 64) revert BadDeviceSignature();
        (bytes32 r, bytes32 s) = abi.decode(deviceSig, (bytes32, bytes32));
        if (!P256.verifySignature(claimAuthDigest(a), r, s, x, y)) revert BadDeviceSignature();
        w.nonce += 1; // 소비(민팅 전)
    }

    /// @dev 직접 발급 본문(기존 claim 을 msg.sender→to 로 추출). 자격 검사는 발행·판매창·KYC·티어·
    ///      무료 전용·품절·지갑 한도. 멤버 여부는 호출 전 _verifyClaimAuth 가 이미 확인했다. 티켓
    ///      순번은 전역 serial 이며 tokenId 에 인코딩된다.
    function _claimTo(uint256 eventId, uint8 tier, address to) private returns (uint256 tokenId) {
        EventStatus s = eventStatus(eventId);
        if (s == EventStatus.Ended) revert EventEnded();
        if (s != EventStatus.Published) revert EventNotPublished();

        EventMeta storage m = _events[eventId];
        if (m.approvalRequired) revert ApprovalRequired();
        if (m.requireKyc && identity.kycLevelOf(to) < 1) revert KycRequired();
        if (block.timestamp < m.saleStart || block.timestamp > m.saleEnd) revert SaleClosed();
        if (tier >= _tiers[eventId].length) revert UnknownTier();

        Tier storage t = _tiers[eventId][tier];
        if (t.priceUsdCents != 0) revert PaidTiersNotEnabled();
        if (t.minted >= t.supply) revert SoldOut();
        if (_wallet[eventId][to].held >= t.maxPerWallet) revert MaxPerWalletExceeded();

        t.minted += 1;
        tokenId = _mintTo(eventId, tier, to);
    }

    /// @notice 승인제(01c). approvalRequired 이벤트는 직접 발급이 막혀 있으므로, 관객은 여기서
    ///         신청만 하고 실제 민팅은 주최자의 approveClaims 가 한다. 자격 검사는 발급과 같다
    ///         (발행·판매창·KYC·티어 존재·무료 전용·품절·지갑 한도). 다른 점은 둘뿐이다:
    ///         (1) 공급을 신청 시점에 예약해(`t.minted += 1`) 승인 단계에서 초과 발행이 날 수 없게
    ///         하고, (2) 지갑 한도를 발급분 + 대기분 합으로 센다. 거절·취소가 그 예약을 되돌린다.
    function _requestClaimFrom(uint256 eventId, uint8 tier, address requester) private returns (uint256 requestId) {
        EventStatus s = eventStatus(eventId);
        if (s == EventStatus.Ended) revert EventEnded();
        if (s != EventStatus.Published) revert EventNotPublished();

        EventMeta storage m = _events[eventId];
        if (!m.approvalRequired) revert ApprovalNotRequired();
        if (m.requireKyc && identity.kycLevelOf(requester) < 1) revert KycRequired();
        if (block.timestamp < m.saleStart || block.timestamp > m.saleEnd) revert SaleClosed();
        if (tier >= _tiers[eventId].length) revert UnknownTier();

        Tier storage t = _tiers[eventId][tier];
        if (t.priceUsdCents != 0) revert PaidTiersNotEnabled();
        if (t.minted >= t.supply) revert SoldOut();
        Wallet storage w = _wallet[eventId][requester];
        if (uint256(w.held) + w.pending >= t.maxPerWallet) revert MaxPerWalletExceeded();

        t.minted += 1; // 공급 예약: 대기 + 발급이 supply 를 넘지 못한다(초과 발행 방지).
        w.pending += 1;
        _pendingCount[eventId] += 1;
        requestId = ++_lastRequestId[eventId];
        _claimRequests[eventId][requestId] = ClaimRequest({requester: requester, tier: tier, status: 0});

        emit ClaimRequested(eventId, requestId, requester, tier);
    }

    /// @dev 발급·승인 공통 민팅 코어. tokenId 인코딩과 Claimed 방출을 한 곳에 모아 두 경로가
    ///      같은 id 규칙을 쓰게 한다(id 인코딩이 갈라지면 usedAt 패킹·eventOf 파생이 깨진다).
    function _mintTo(uint256 eventId, uint8 tier, address to) private returns (uint256 tokenId) {
        tokenId = _encodeTokenId(eventId, tier, _nextSerial++);
        _safeMint(to, tokenId);
        emit Claimed(tokenId, eventId, to, tier);
    }

    /// @notice 승인제(01c). 소유자, PERM_APPROVE_CLAIM 을 가진 admin, canApprove 매니저가 부른다.
    ///         각 대기 신청을 발급과 같은 내부 민팅 코어(_mintTo)로 민팅한다 — 공급은 신청 때
    ///         예약됐으므로 여기서 다시 세지 않는다. 이미 대기가 아닌 요청(승인·거절·취소·미존재)은
    ///         배치를 되돌리지 않고 건너뛴다 — 부분 승인·중복 제출·경합에 강하다.
    function approveClaims(uint256 eventId, uint256[] calldata requestIds) external {
        _requireApprovalPermission(eventId);
        for (uint256 i; i < requestIds.length; ++i) {
            uint256 rid = requestIds[i];
            ClaimRequest storage r = _claimRequests[eventId][rid];
            if (r.status != 0 || r.requester == address(0)) continue;

            address to = r.requester;
            uint8 tier = r.tier;
            r.status = 1;
            _pendingCount[eventId] -= 1;
            _wallet[eventId][to].pending -= 1;

            uint256 tokenId = _mintTo(eventId, tier, to);
            emit ClaimApproved(eventId, rid, tokenId);
        }
    }

    /// @notice 승인제(01c). 거절은 신청이 잡아둔 예약(공급·대기·지갑 한도)을 되돌리고 요청을 거절
    ///         상태로 만든다. approveClaims 와 같은 권한, 같은 skip 규약이다.
    function rejectClaims(uint256 eventId, uint256[] calldata requestIds) external {
        _requireApprovalPermission(eventId);
        for (uint256 i; i < requestIds.length; ++i) {
            uint256 rid = requestIds[i];
            ClaimRequest storage r = _claimRequests[eventId][rid];
            if (r.status != 0 || r.requester == address(0)) continue;
            r.status = 2;
            _releaseReservation(eventId, r);
            emit ClaimRejected(eventId, rid);
        }
    }

    /// @notice 승인제(01c). 신청자 본인이 대기 중인 자기 요청을 거둔다. 예약을 되돌리고 거절과 같은
    ///         종료 이벤트(ClaimRejected)를 낸다. 대기 상태가 아니면(이미 승인·거절) 되돌릴 것이 없다.
    function cancelRequest(uint256 eventId, uint256 requestId) external {
        ClaimRequest storage r = _claimRequests[eventId][requestId];
        if (r.requester != msg.sender) revert Unauthorized();
        if (r.status != 0) revert RequestNotPending();
        r.status = 2;
        _releaseReservation(eventId, r);
        emit ClaimRejected(eventId, requestId);
    }

    function claimRequest(uint256 eventId, uint256 requestId) external view returns (ClaimRequest memory) {
        return _claimRequests[eventId][requestId];
    }

    function pendingCount(uint256 eventId) external view returns (uint256) {
        return _pendingCount[eventId];
    }

    /// @notice tokenId 에 인코딩된 행사 id. 저장 슬롯이 아니라 id 에서 계산한다(설계 §12-1).
    function eventOf(uint256 tokenId) external pure returns (uint256) {
        return _decodeEvent(tokenId);
    }

    /// @notice tokenId 에 인코딩된 티어. 저장 슬롯이 아니라 id 에서 계산한다(설계 §12-1).
    function tierOf(uint256 tokenId) external pure returns (uint8) {
        return _decodeTier(tokenId);
    }

    function balanceOfEvent(address account, uint256 eventId) external view returns (uint256) {
        return _wallet[eventId][account].held;
    }

    function transfersOf(uint256 tokenId) external view returns (uint8) {
        return _transfers[tokenId];
    }

    /// @notice 입장 시각(Unix 초). 0 이면 미사용. 다른 컨트랙트가 "특정 시각 이전 입장자" 같은
    ///         온체인 로직을 짤 수 있게 공개한다(설계 §12-2, 창업자 요구).
    function usedAt(uint256 tokenId) public view returns (uint32) {
        uint256 serial = _decodeSerial(tokenId);
        return uint32(_usedAtWords[serial >> 3] >> ((serial & 7) << 5));
    }

    /// @notice 이름·시그니처 유지. 슬림 저장으로 실제 남는 것은 ts(== usedAt)뿐이고 나머지 필드는
    ///         0/false 다 — gateId·nonceHash·late/manual 은 CheckedIn/CheckedInLate/ManualOverride
    ///         이벤트에서 읽는다(설계 §12-2).
    function checkInOf(uint256 tokenId) external view returns (CheckIn memory) {
        return CheckIn({gateId: 0, nonceHash: bytes32(0), ts: usedAt(tokenId), manual: false, late: false});
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
        EventMeta storage m = _events[_decodeEvent(tokenId)];
        if (_revoked[tokenId]) revert TicketRevoked();
        if (!m.transferable) revert TransfersDisabled();
        if (usedAt(tokenId) != 0) revert AlreadyCheckedIn();
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

    // --- 릴레이된 입장 (checkInFor / checkInForLate) -------------------------------------------------

    /// @notice 스펙 7.2 6단계 + 릴레이 전환(설계 §4). 누구나 제출할 수 있다(permissionless) —
    ///         게이트 권한은 msg.sender 가 아니라 게이트 키(kx,ky)의 서명이 증명한다. 검사 순서:
    ///         티켓이 있고, 이 행사 것이고, 행사가 살아 있고, 티켓이 쓸 수 있고, 게이트가 이 행사의
    ///         (열린) 게이트이며 서명이 맞고, 코드가 신선하고, 관객 기기 서명이 맞는가.
    function checkInFor(uint256 tokenId, GateCode calldata g, bytes calldata gateSig, bytes calldata deviceSig)
        external
    {
        _admit(tokenId, g, gateSig, deviceSig, false);
    }

    /// @notice 스펙 12: 단말기가 인터넷을 잃으면 서명된 스냅샷으로 로컬 검증하고 "OFFLINE 승인"을
    ///         띄운 뒤 트랜잭션을 큐에 쌓아 복구 후 보낸다. 큐에 담긴 코드의 issuedAt 은 탭한
    ///         그때 그대로라 60초 창으로는 영영 들어올 수 없다(C1). 증명은 똑같다 — 게이트 서명과
    ///         관객 기기 서명이 여전히 필수이므로 단말기 혼자서는 만들 수 없다(T15). 다른 것은
    ///         시계뿐이다: 코드는 개장 LATE_WINDOW 전부터 유효하고, 제출은 폐장 LATE_WINDOW 후까지
    ///         받는다. 게이트가 '열려' 있을 필요는 없다. 폐기된 게이트는 여전히 어느 경로로도 못
    ///         쓴다(T14).
    function checkInForLate(uint256 tokenId, GateCode calldata g, bytes calldata gateSig, bytes calldata deviceSig)
        external
    {
        _admit(tokenId, g, gateSig, deviceSig, true);
    }

    /// @dev 두 입장 경로의 공통 본문. 복사본을 두지 않는 이유는 크기가 아니라 안전이다:
    ///      두 경로의 검사 순서가 한 글자라도 갈라지면 한쪽에만 있는 구멍이 생긴다.
    ///
    ///      관객 기기가 서명하는 다이제스트는 이 체인과 이 Ticket 에 묶여 있다(_deviceDigest,
    ///      무변경). 게이트 서명은 스태프가 이미 서명하는 게이트 코드 다이제스트를 온체인에서도
    ///      검증할 뿐이다(설계 §4).
    function _admit(uint256 tokenId, GateCode calldata g, bytes calldata gateSig, bytes calldata deviceSig, bool late)
        private
    {
        address holder = _ownerOf(tokenId);
        if (holder == address(0)) revert NoSuchTicket();

        uint256 eventId = _decodeEvent(tokenId);
        if (g.eventId != eventId) revert WrongEvent();

        EventMeta storage m = _events[eventId];
        // 살아 있는 토큰의 행사는 Published 이거나 Cancelled 뿐이다(발급이 Published 만 받고
        // 상태는 Draft 로 되돌아가지 않는다). 그래서 eventStatus() 대신 두 가지만 직접 본다.
        if (_status[eventId] == EventStatus.Cancelled) revert EventCancelled();
        if (block.timestamp > uint256(m.endsAt) + (late ? LATE_WINDOW : 0)) revert EventEnded();
        if (_revoked[tokenId]) revert TicketRevoked();
        if (usedAt(tokenId) != 0) revert AlreadyCheckedIn();

        // 게이트 권한은 이제 msg.sender 가 아니라 게이트 키 서명이 증명한다(릴레이 전환, 설계 §4).
        // gateInfo 로 이 행사의 게이트인지, 폐기되지 않았는지, (현장 경로면) 열려 있는지 확인하고
        // 게이트 코드 다이제스트에 대한 P-256 서명을 검증한다. 블록으로 지역변수를 가둬 legacy
        // 코드젠의 stack too deep 을 피한다.
        {
            (uint256 gateEventId,, bytes32 kx, bytes32 ky, bool open, bool gateRevoked) = organizers.gateInfo(g.gateId);
            if (gateEventId != eventId || gateRevoked) revert GateNotOpen();
            if (!late && !open) revert GateNotOpen();
            _verifyGate(g, gateSig, kx, ky);
        }

        // 게이트 폰의 시계는 체인보다 CLOCK_SKEW 초까지 앞설 수 있다. 그 너머는 위조다.
        if (g.issuedAt > block.timestamp + CLOCK_SKEW) revert CodeExpired();
        if (late) {
            // 개장 LATE_WINDOW 전보다 옛 코드는 받지 않는다. 넓은 창이 만드는 단 하나의 새 위험이
            // 게이트의 서명 사전 수확이고, 이 줄이 그것을 죽인다.
            if (uint256(g.issuedAt) + LATE_WINDOW < m.startsAt) revert CodeExpired();
        } else if (uint256(g.issuedAt) + CODE_WINDOW < block.timestamp) {
            revert CodeExpired();
        }

        // 중괄호는 스타일이 아니라 필요다: 이 지역변수들이 다음 문장까지 살아 있으면 legacy
        // 코드젠이 stack too deep 으로 죽는다. 블록을 닫아 죽은 변수를 버린다.
        {
            // 회전된 계정이 티켓을 아직 들고 있을 수 있다. 잠금만으로도 막히지만(I2가 회전 시
            // 잠그므로) 두 컨트랙트의 불변식을 서로에게 기대지 않도록 여기서도 직접 묻는다.
            if (!identity.isMember(holder)) revert NotMember();
            if (identity.isLocked(holder)) revert DeviceLocked();
            (bytes32 x, bytes32 y) = identity.activeDevice(holder);

            if (deviceSig.length != 64) revert BadDeviceSignature();
            bytes32 h = _deviceDigest(tokenId, g);
            (bytes32 r, bytes32 s) = abi.decode(deviceSig, (bytes32, bytes32));
            if (!P256.verifySignature(h, r, s, x, y)) revert BadDeviceSignature();
        }

        bytes32 nonceHash = keccak256(abi.encode(g.nonce));
        _setUsedAt(tokenId, uint32(block.timestamp));
        if (_offers[tokenId].from != address(0)) {
            delete _offers[tokenId];
            emit OfferCancelled(tokenId);
        }

        if (late) emit CheckedInLate(tokenId, g.gateId, g.issuedAt, uint64(block.timestamp));
        emit CheckedIn(tokenId, eventId, g.gateId, nonceHash, uint64(block.timestamp));
    }

    /// @dev 게이트 코드 다이제스트에 대한 게이트 키 P-256 검증(설계 §4). 스태프 앱이 이미 서명하는
    ///      그 값(gateCodeHash)을 온체인에서도 검증할 뿐이라 클라이언트 서명 코드는 안 바뀐다.
    function _verifyGate(GateCode calldata g, bytes calldata gateSig, bytes32 kx, bytes32 ky) private view {
        if (gateSig.length != 64) revert BadGateSignature();
        bytes32 gh = sha256(abi.encode(g.gateId, g.eventId, g.issuedAt, g.nonce));
        (bytes32 gr, bytes32 gs) = abi.decode(gateSig, (bytes32, bytes32));
        if (!P256.verifySignature(gh, gr, gs, kx, ky)) revert BadGateSignature();
    }

    /// @notice 관객 기기가 서명해야 하는 그 32바이트. `offerDigest` 와 같은 이유로 공개한다:
    ///         03 의 지갑과 04 의 단말기가 자기 계산을 체인과 대조할 수 있어야 하고, 대조할 수
    ///         없으면 어긋남은 현장에서 DENY DEVICE_MISMATCH 로만 드러난다.
    /// @dev    `chainid` 와 이 컨트랙트 주소는 인자가 아니라 안에서 채운다 — 호출자가 고를 수
    ///         있으면 교차검증용으로서 아무것도 증명하지 못한다. 상태는 읽지 않으므로 `view` 인
    ///         이유는 그 두 값뿐이다.
    function deviceDigest(uint256 tokenId, uint256 gateId, uint256 eventId, bytes32 nonce, uint64 issuedAt)
        public
        view
        returns (bytes32)
    {
        return sha256(abi.encode(block.chainid, address(this), tokenId, gateId, eventId, nonce, issuedAt));
    }

    /// @dev 두 입장 경로가 부르는 얇은 껍데기. `_admit` 안에서 다섯 인자를 직접 펼치면 legacy
    ///      코드젠이 다시 stack too deep 으로 죽는다.
    function _deviceDigest(uint256 tokenId, GateCode calldata g) private view returns (bytes32) {
        return deviceDigest(tokenId, g.gateId, g.eventId, g.nonce, g.issuedAt);
    }

    /// @notice Spec 13: a manager without approval rights files a request; someone with rights admits.
    ///         Checks run authority first, so nothing about the ticket or the door is told to a stranger:
    ///         the ticket must exist (its event is what authority is measured against), the caller must
    ///         belong to that organizer, and only then must the gate be one of this event's gates — open
    ///         or closed, since a request is not a tap. An unregistered gateId (0 included) reports
    ///         eventId 0 and is rejected.
    function requestOverride(uint256 tokenId, uint256 gateId, uint8 reason) external {
        if (_ownerOf(tokenId) == address(0)) revert NoSuchTicket();
        uint256 eventId = _decodeEvent(tokenId);
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
    ///         with canApprove. The event and ticket must be admissible for the same reasons check-in
    ///         demands; only the NFC tap itself is waived. Checks run authority first — the ticket has
    ///         to exist for its organizer to be known, then the caller must have approval rights, and
    ///         only then are the ticket's state, the event's status and the gate examined, so an
    ///         unauthorised caller learns nothing about the ticket. Emits CheckedIn as well so the
    ///         staff screen and the indexer watch one event only.
    function manualOverride(uint256 tokenId, uint256 gateId, uint8 reason) external {
        if (_ownerOf(tokenId) == address(0)) revert NoSuchTicket();
        uint256 eventId = _decodeEvent(tokenId);
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
        if (usedAt(tokenId) != 0) revert AlreadyCheckedIn();
        EventStatus status = eventStatus(eventId);
        if (status == EventStatus.Ended) revert EventEnded();
        if (status == EventStatus.Cancelled) revert EventCancelled();
        (uint256 gateEventId,,,,,) = organizers.gateInfo(gateId);
        if (gateEventId != eventId) revert GateMismatch();

        _setUsedAt(tokenId, uint32(block.timestamp));
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
        _requireEventPermission(_decodeEvent(tokenId), PERM_CREATE_EVENT);
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
        if (usedAt(tokenId) != 0) revert AlreadyCheckedIn();

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

        uint256 eventId = _decodeEvent(tokenId);
        EventMeta storage m = _events[eventId];
        Tier storage t = _tiers[eventId][_decodeTier(tokenId)];

        // 5.8: 행사가 취소되면 그 행사의 티켓은 전부 취소됨이다. 일괄 revoke 루프는 티켓 수만큼
        // 가스가 드는 무한 확장이라 애초에 선택지가 아니므로, 상태를 만들지 않고 파생한다.
        // 우선순위는 무효(티켓 단위) -> 취소(행사 단위) -> 입장 완료 -> 입장 전이다.
        string memory status = unicode"입장 전";
        if (_revoked[tokenId] || eventStatus(eventId) == EventStatus.Cancelled) {
            status = unicode"취소됨";
        } else if (usedAt(tokenId) != 0) {
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

    /// @notice approveClaims/rejectClaims 의 권한 게이트(01c). 소유자와 PERM_APPROVE_CLAIM 를 가진
    ///         admin 은 hasPermission 이 함께 참으로 잡고(소유자는 전 비트 보유), 그 밖에는
    ///         canApprove 매니저만 통과한다 — manualOverride 의 ROLE_APPROVER/ROLE_MANAGER 와 같은 축.
    function _requireApprovalPermission(uint256 eventId) private view {
        uint256 orgId = _events[eventId].orgId;
        if (orgId == 0) revert UnknownEvent();
        if (organizers.hasPermission(orgId, msg.sender, PERM_APPROVE_CLAIM)) return;
        (bool exists, bool canApprove) = organizers.managerOf(orgId, msg.sender);
        if (exists && canApprove) return;
        revert Unauthorized();
    }

    /// @notice 거절·취소 공통(01c): 신청이 잡아둔 공급 예약·대기 카운트·지갑 한도 몫을 한 번에 푼다.
    function _releaseReservation(uint256 eventId, ClaimRequest storage r) private {
        _tiers[eventId][r.tier].minted -= 1;
        _pendingCount[eventId] -= 1;
        _wallet[eventId][r.requester].pending -= 1;
    }

    function eventOrg(uint256 eventId) external view returns (uint256) {
        return _events[eventId].orgId;
    }

    // --- tokenId 인코딩 / usedAt 패킹 (설계 §12) ----------------------------------------------------

    /// @dev tokenId = eventId<<96 | tier<<88 | serial. 오버플로 가드는 사실상 발생하지 않지만
    ///      (eventId 160비트, serial 88비트) 잘못된 값이 조용히 다른 토큰으로 접히지 않도록 건다.
    function _encodeTokenId(uint256 eventId, uint8 tier, uint256 serial) internal pure returns (uint256) {
        if (serial > _SERIAL_MASK) revert SerialOverflow();
        if (eventId > _MAX_EVENT_ID) revert EventIdOverflow();
        return (eventId << _EVENT_SHIFT) | (uint256(tier) << _TIER_SHIFT) | serial;
    }

    function _decodeEvent(uint256 tokenId) internal pure returns (uint256) {
        return tokenId >> _EVENT_SHIFT;
    }

    function _decodeTier(uint256 tokenId) internal pure returns (uint8) {
        return uint8((tokenId >> _TIER_SHIFT) & 0xff);
    }

    function _decodeSerial(uint256 tokenId) internal pure returns (uint256) {
        return tokenId & _SERIAL_MASK;
    }

    /// @dev serial/8 슬롯의 (serial%8)*32비트 칸에 usedAt 을 read-modify-write 로 넣는다. 같은 워드의
    ///      다른 티켓 값은 보존된다(부분 슬롯·띄엄띄엄 serial 모두 안전).
    function _setUsedAt(uint256 tokenId, uint32 ts) internal {
        uint256 serial = _decodeSerial(tokenId);
        uint256 slot = serial >> 3;
        uint256 shift = (serial & 7) << 5;
        _usedAtWords[slot] = (_usedAtWords[slot] & ~(uint256(type(uint32).max) << shift)) | (uint256(ts) << shift);
    }

    /// @notice Every transfer — from any app, any wallet, any relayer — passes through here (spec 10.2).
    ///         Mint (from == 0), burn (to == 0) and migrate (_internalMove) skip the rules.
    function _update(address to, uint256 tokenId, address auth) internal override returns (address) {
        address from = _ownerOf(tokenId);
        uint256 eventId = _decodeEvent(tokenId);

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
                if (usedAt(tokenId) != 0) revert AlreadyCheckedIn();
                if (block.timestamp + m.transferCutoffSeconds >= m.startsAt) revert TransferCutoffPassed();
                if (!identity.isMember(to)) revert NotMember();
                // 받는 쪽도 같은 기준으로 얼린다. 잠긴 계정은 그 티켓으로 문을 통과할 수 없으므로
                // (checkIn 의 DeviceLocked), 거기로 밀어 넣는 것은 티켓을 잠금이 풀릴 때까지
                // 묶어두는 일일 뿐이다. 순서는 보내는 쪽과 같다 — 먼저 멤버인지, 다음에 잠겼는지.
                if (identity.isLocked(to)) revert DeviceLocked();
                if (m.requireKyc && identity.kycLevelOf(to) < 1) revert KycRequired();

                uint8 done = _transfers[tokenId];
                if (done >= m.maxTransfers) revert TransferLimitReached();

                Tier storage t = _tiers[eventId][_decodeTier(tokenId)];
                if (_wallet[eventId][to].held >= t.maxPerWallet) revert MaxPerWalletExceeded();

                _transfers[tokenId] = done + 1;
            }
        }

        address previous = super._update(to, tokenId, auth);
        if (from != address(0)) _wallet[eventId][from].held -= 1;
        if (to != address(0)) _wallet[eventId][to].held += 1;
        return previous;
    }
}
