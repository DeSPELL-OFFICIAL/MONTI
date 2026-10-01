// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {ISettlementVault, ITicketReader} from "./interfaces/ISettlementVault.sol";
import {IOrganizers} from "./interfaces/IOrganizers.sol";
import {IIdentity} from "./interfaces/IIdentity.sol";
import {P256} from "solady/utils/P256.sol";
import {ReentrancyGuard} from "solady/utils/ReentrancyGuard.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";

/// @title SettlementVault
/// @notice MONTI's programmable-settlement layer (design 2026-10-01, Q1–Q3). A single standalone
///         contract — the core four (Ticket/Organizers/Identity/MontiForwarder) are **not changed**.
///         Per event an organizer sets a frozen-on-first-sale split policy; a treasury/PG adapter
///         deposits USDC per ticket into escrow; on real admission (`Ticket.usedAt(tokenId) != 0`) anyone
///         releases that ticket's escrow, splitting it to the recipients by bps with a per-recipient pull
///         fallback. No-shows settle after the event ends; deposits refund before release.
///
/// @dev    The vault only ever *reads* Ticket, so admission can never revert because of settlement
///         (design §3, founder requirement). It is not a forwarder target, so `setPolicy` cannot use
///         `_msgSender()`; instead the organizer's P-256 device key self-verifies over `setPolicyDigest`,
///         the same pattern as `Ticket.claimFor` (design §3). Money paths are `nonReentrant` with
///         checks-effects-interactions (status flipped before any transfer) and use solady SafeTransferLib
///         for USDC's non-standard bool return.
contract SettlementVault is ISettlementVault, ReentrancyGuard {
    // --- constants ------------------------------------------------------------------------------

    /// @notice Organizers permission bit for settlement management. Bits 1/2/4/8/16 are in use and
    ///         Ticket uses 32, so the next free bit is 64 (design §1). Organizers is unchanged:
    ///         `hasPermission` takes any bitmask and the org owner implicitly holds every bit, so the
    ///         demo's "owner sets the policy" passes with no change there.
    uint32 public constant PERM_MANAGE_SETTLEMENT = 64;

    /// @notice Purpose tag leading the policy preimage, splitting it from every other MONTI digest so a
    ///         signature cannot be replayed onto another path (design §2/§3 style).
    bytes32 public constant SETTLE_POLICY_TAG = keccak256("MONTI:SETTLE_POLICY:v1");

    /// @notice The on-chain tag the platform (MONTI) recipient must carry; `platformBps` must equal its
    ///         bps, and it must be at least MIN_PLATFORM_BPS (5%), guaranteeing the business-model fee.
    bytes32 public constant TAG_PLATFORM = "platform";
    uint16 public constant MIN_PLATFORM_BPS = 500;
    uint16 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant MAX_RECIPIENTS = 10;

    uint8 internal constant ESC_NONE = 0;
    uint8 internal constant ESC_HELD = 1;
    uint8 internal constant ESC_RELEASED = 2;
    uint8 internal constant ESC_REFUNDED = 3;

    uint8 internal constant EVT_CANCELLED = 2;
    uint8 internal constant EVT_ENDED = 3;

    // --- immutable wiring -----------------------------------------------------------------------

    ITicketReader public immutable ticket;
    IOrganizers public immutable organizers;
    IIdentity public immutable identity;

    // --- state ----------------------------------------------------------------------------------

    address public owner;
    bool public paused;

    mapping(uint256 => Escrow) public escrowOf; // tokenId => escrow
    mapping(address => bool) public tokenAllowed; // USDC allowlist (room for a KRW stable later)
    mapping(address => bool) public depositor; // deposit/adapter-refund allowlist (treasury/PG)
    mapping(address => uint256) public policyNonce; // per-organizer replay counter
    mapping(address => mapping(address => uint256)) public pendingWithdrawals; // recipient => token => owed

    mapping(uint256 => SplitPolicy) internal _policyOf; // eventId => policy (explicit getter: getPolicy)

    // --- modifiers ------------------------------------------------------------------------------

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyDepositor() {
        if (!depositor[msg.sender]) revert NotDepositor();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    /// @param ticket_ live Ticket, organizers_ live Organizers, identity_ live Identity (all unchanged).
    /// @param initialDepositor the treasury/PG adapter allowed to deposit (optional; 0 to skip).
    /// @param initialToken a token to allowlist at deploy, e.g. Circle USDC (optional; 0 to skip).
    constructor(address ticket_, address organizers_, address identity_, address initialDepositor, address initialToken) {
        owner = msg.sender;
        ticket = ITicketReader(ticket_);
        organizers = IOrganizers(organizers_);
        identity = IIdentity(identity_);
        if (initialDepositor != address(0)) {
            depositor[initialDepositor] = true;
            emit DepositorSet(initialDepositor, true);
        }
        if (initialToken != address(0)) {
            tokenAllowed[initialToken] = true;
            emit TokenAllowed(initialToken, true);
        }
    }

    // --- policy ---------------------------------------------------------------------------------

    /// @notice Set (or replace, before the first deposit) an event's split policy. Permissionless to
    ///         submit — the relayer carries it — but authorised by the organizer's P-256 device key over
    ///         `setPolicyDigest`, plus `Organizers.hasPermission(eventOrg, organizer, PERM_MANAGE_SETTLEMENT)`.
    ///         Frozen once the first deposit lands.
    function setPolicy(uint256 eventId, SplitPolicy calldata policy, PolicyAuth calldata auth, bytes calldata deviceSig)
        external
        whenNotPaused
    {
        uint256 orgId = ticket.eventOrg(eventId);
        if (orgId == 0) revert UnknownEvent();
        if (!organizers.hasPermission(orgId, auth.organizer, PERM_MANAGE_SETTLEMENT)) revert NotPolicyAuthorizer();
        if (_policyOf[eventId].frozen) revert PolicyFrozen();
        if (block.timestamp > auth.deadline) revert AuthExpired();
        if (auth.nonce != policyNonce[auth.organizer]) revert BadNonce();

        bytes32 policyHash = hashPolicy(policy);
        bytes32 digest = setPolicyDigest(eventId, policyHash, auth.nonce, auth.deadline);
        (bytes32 x, bytes32 y) = identity.activeDevice(auth.organizer);
        if (deviceSig.length != 64) revert BadDeviceSignature();
        (bytes32 r, bytes32 s) = abi.decode(deviceSig, (bytes32, bytes32));
        if (!P256.verifySignature(digest, r, s, x, y)) revert BadDeviceSignature();

        _validatePolicy(policy);
        policyNonce[auth.organizer] += 1; // consume (effects before store)

        SplitPolicy storage sp = _policyOf[eventId];
        delete sp.recipients;
        uint256 n = policy.recipients.length;
        for (uint256 i; i < n; ++i) {
            sp.recipients.push(policy.recipients[i]);
        }
        sp.platformBps = policy.platformBps;
        sp.reserveBps = policy.reserveBps;
        sp.noShowRefund = policy.noShowRefund;
        sp.frozen = false;
        sp.version += 1;

        emit PolicySet(eventId, auth.organizer, policyHash, sp.version);
    }

    /// @notice keccak256 over the signed policy content. frozen/version are lifecycle state, not signed.
    function hashPolicy(SplitPolicy calldata policy) public pure returns (bytes32) {
        return keccak256(
            abi.encode(policy.recipients, policy.platformBps, policy.reserveBps, policy.noShowRefund)
        );
    }

    /// @notice The 32 bytes the organizer device key signs. chainid and address(this) are filled in here,
    ///         not passed, so a cross-checking client proves something (design §3). Public so
    ///         packages/shared and the web app can verify their own encoding against the contract.
    function setPolicyDigest(uint256 eventId, bytes32 policyHash, uint256 nonce, uint64 deadline)
        public
        view
        returns (bytes32)
    {
        return sha256(abi.encode(SETTLE_POLICY_TAG, block.chainid, address(this), eventId, policyHash, nonce, deadline));
    }

    function getPolicy(uint256 eventId) external view returns (SplitPolicy memory) {
        return _policyOf[eventId];
    }

    function _validatePolicy(SplitPolicy calldata policy) internal pure {
        uint256 n = policy.recipients.length;
        if (n == 0 || n > MAX_RECIPIENTS) revert InvalidRecipients();
        uint256 sum;
        uint256 platformSum;
        for (uint256 i; i < n; ++i) {
            Recipient calldata rc = policy.recipients[i];
            if (rc.account == address(0)) revert ZeroRecipient();
            if (rc.bps == 0) revert ZeroBps();
            sum += rc.bps;
            if (rc.tag == TAG_PLATFORM) platformSum += rc.bps;
        }
        if (sum != BPS_DENOMINATOR) revert BadSplitSum();
        if (policy.platformBps < MIN_PLATFORM_BPS) revert PlatformShareTooLow();
        if (platformSum != policy.platformBps) revert PlatformMirrorMismatch();
        if (policy.reserveBps >= BPS_DENOMINATOR) revert BadReserve();
    }

    // --- deposit --------------------------------------------------------------------------------

    /// @notice An allowlisted adapter (treasury/PG) deposits a ticket's USDC into escrow and freezes the
    ///         event policy on the first deposit. `token` must be allowlisted; the adapter must have
    ///         approved the vault for `amount`.
    function deposit(uint256 eventId, uint256 tokenId, address token, uint128 amount)
        external
        onlyDepositor
        whenNotPaused
        nonReentrant
    {
        if (!tokenAllowed[token]) revert TokenNotAllowed();
        if (amount == 0) revert ZeroAmount();
        if (escrowOf[tokenId].status != ESC_NONE) revert AlreadyDeposited();
        if (ticket.eventOf(tokenId) != eventId) revert EventMismatch();

        SplitPolicy storage sp = _policyOf[eventId];
        if (!sp.frozen) {
            if (sp.recipients.length == 0) revert NoPolicy();
            sp.frozen = true;
        }

        escrowOf[tokenId] = Escrow({
            token: token,
            amount: amount,
            payer: msg.sender,
            depositedAt: uint64(block.timestamp),
            status: ESC_HELD
        });

        SafeTransferLib.safeTransferFrom(token, msg.sender, address(this), amount);
        emit Deposited(eventId, tokenId, token, amount, msg.sender);
    }

    // --- release --------------------------------------------------------------------------------

    /// @notice Release one ticket's escrow once it has been admitted (`Ticket.usedAt(tokenId) != 0`).
    ///         Permissionless — anyone can recover a release the relayer missed. Reverts on an already
    ///         released/refunded ticket (`release` is single-shot; `releaseMany` is the tolerant batch).
    function release(uint256 tokenId) external whenNotPaused nonReentrant {
        Escrow storage e = escrowOf[tokenId];
        uint8 st = e.status;
        if (st == ESC_NONE) revert NoEscrow();
        if (st != ESC_HELD) revert AlreadySettled();

        uint256 eventId = ticket.eventOf(tokenId);
        if (ticket.usedAt(tokenId) == 0) revert NotCheckedIn();

        e.status = ESC_RELEASED; // effect before interaction
        (address token, uint256 amount) = (e.token, e.amount);
        _distribute(eventId, tokenId, token, amount);
        emit Released(eventId, tokenId, token, amount);
    }

    /// @notice Batch release for the relayer. Tolerant: a ticket that is not Held (already released, never
    ///         deposited) or not yet admitted is skipped, so one bad entry never reverts the batch.
    function releaseMany(uint256[] calldata tokenIds) external whenNotPaused nonReentrant {
        for (uint256 i; i < tokenIds.length; ++i) {
            uint256 tokenId = tokenIds[i];
            Escrow storage e = escrowOf[tokenId];
            if (e.status != ESC_HELD) continue;
            if (ticket.usedAt(tokenId) == 0) continue;
            uint256 eventId = ticket.eventOf(tokenId);
            e.status = ESC_RELEASED;
            (address token, uint256 amount) = (e.token, e.amount);
            _distribute(eventId, tokenId, token, amount);
            emit Released(eventId, tokenId, token, amount);
        }
    }

    // --- no-show settle -------------------------------------------------------------------------

    /// @notice After the event has ended, settle tickets that were never admitted. Per the event's policy:
    ///         by default the no-show share is distributed to the recipients; if `noShowRefund` is set it
    ///         is refunded to the payer instead (design §2). Permissionless; a bounded caller-sized batch.
    ///         Admitted or already-settled/refunded tickets in the list are skipped.
    function settleNoShows(uint256 eventId, uint256[] calldata tokenIds) external whenNotPaused nonReentrant {
        if (ticket.eventStatus(eventId) != EVT_ENDED) revert EventNotEnded();
        SplitPolicy storage sp = _policyOf[eventId];
        bool refundNoShow = sp.noShowRefund;

        for (uint256 i; i < tokenIds.length; ++i) {
            uint256 tokenId = tokenIds[i];
            Escrow storage e = escrowOf[tokenId];
            if (e.status != ESC_HELD) continue;
            if (ticket.eventOf(tokenId) != eventId) revert EventMismatch();
            if (ticket.usedAt(tokenId) != 0) continue; // admitted → use release(), not settleNoShows

            (address token, uint256 amount, address payer) = (e.token, e.amount, e.payer);
            if (refundNoShow) {
                e.status = ESC_REFUNDED;
                SafeTransferLib.safeTransfer(token, payer, amount);
                emit Refunded(eventId, tokenId, token, amount, payer);
            } else {
                e.status = ESC_RELEASED;
                _distribute(eventId, tokenId, token, amount);
                emit NoShowSettled(eventId, tokenId, token, amount);
            }
        }
    }

    // --- refund ---------------------------------------------------------------------------------

    /// @notice Refund a held deposit to its payer before it is released. Two paths (design §2):
    ///         (a) cancelled event (`eventStatus == Cancelled`) — permissionless, anyone can trigger;
    ///         (b) attendee cancellation — only the paying adapter, while the ticket is unused and the
    ///         event has not ended (a no-show after end goes through `settleNoShows`). An admitted or
    ///         already-settled ticket cannot be refunded (its money is gone / committed).
    function refund(uint256 tokenId) external whenNotPaused nonReentrant {
        Escrow storage e = escrowOf[tokenId];
        uint8 st = e.status;
        if (st == ESC_NONE) revert NoEscrow();
        if (st != ESC_HELD) revert NothingToRefund();

        uint256 eventId = ticket.eventOf(tokenId);
        uint8 evt = ticket.eventStatus(eventId);

        if (evt != EVT_CANCELLED) {
            if (msg.sender != e.payer) revert NotDepositor();
            if (ticket.usedAt(tokenId) != 0) revert AlreadyCheckedIn();
            if (evt == EVT_ENDED) revert EventEnded();
        }

        e.status = ESC_REFUNDED; // effect before interaction
        (address token, uint256 amount, address payer) = (e.token, e.amount, e.payer);
        SafeTransferLib.safeTransfer(token, payer, amount);
        emit Refunded(eventId, tokenId, token, amount, payer);
    }

    // --- pull fallback --------------------------------------------------------------------------

    /// @notice Withdraw a recipient's pull-fallback balance for a token (credited when a push transfer
    ///         failed, e.g. a USDC blacklist). Not gated by pause — a recipient can always retrieve owed
    ///         funds.
    function withdraw(address token) external nonReentrant {
        uint256 amount = pendingWithdrawals[msg.sender][token];
        if (amount == 0) revert NothingToWithdraw();
        pendingWithdrawals[msg.sender][token] = 0; // effect before interaction
        SafeTransferLib.safeTransfer(token, msg.sender, amount);
        emit Withdrawn(msg.sender, token, amount);
    }

    // --- internal split -------------------------------------------------------------------------

    /// @dev Split `amount` of `token` among the event's recipients by bps, routing rounding dust to the
    ///      last recipient (place the platform line last to collect it). Pushes each share; a failed push
    ///      (blacklisted/reverting recipient) is credited to `pendingWithdrawals` so one recipient can
    ///      never block the rest. Callers set escrow status before calling (CEI).
    function _distribute(uint256 eventId, uint256 tokenId, address token, uint256 amount) internal {
        SplitPolicy storage sp = _policyOf[eventId];
        uint256 n = sp.recipients.length;
        uint256 distributed;
        for (uint256 i; i < n; ++i) {
            Recipient storage rc = sp.recipients[i];
            uint256 share = (i == n - 1) ? (amount - distributed) : (amount * rc.bps) / BPS_DENOMINATOR;
            distributed += share;
            if (share == 0) continue;
            address account = rc.account;
            if (_tryTransfer(token, account, share)) {
                emit Paid(eventId, tokenId, account, share, rc.reasonHash);
            } else {
                pendingWithdrawals[account][token] += share;
                emit PayoutDeferred(eventId, tokenId, account, token, share);
                emit Paid(eventId, tokenId, account, share, rc.reasonHash);
            }
        }
    }

    /// @dev A transfer that returns false instead of reverting, so a single blacklisted/reverting
    ///      recipient falls back to pull without reverting the whole release. Handles both a revert and a
    ///      `false`/empty return. solady has `trySafeTransferFrom` but no `trySafeTransfer`, so this is the
    ///      transfer-side equivalent.
    function _tryTransfer(address token, address to, uint256 amount) internal returns (bool) {
        (bool success, bytes memory ret) = token.call(abi.encodeWithSelector(0xa9059cbb, to, amount));
        return success && (ret.length == 0 || abi.decode(ret, (bool)));
    }

    // --- admin ----------------------------------------------------------------------------------

    function setTokenAllowed(address token, bool allowed) external onlyOwner {
        tokenAllowed[token] = allowed;
        emit TokenAllowed(token, allowed);
    }

    function setDepositor(address account, bool allowed) external onlyOwner {
        depositor[account] = allowed;
        emit DepositorSet(account, allowed);
    }

    function setPaused(bool paused_) external onlyOwner {
        paused = paused_;
        emit PausedSet(paused_);
    }
}
