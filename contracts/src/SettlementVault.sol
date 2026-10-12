// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {ISettlementVault, ITicketReader} from "./interfaces/ISettlementVault.sol";
import {ITicket} from "./interfaces/ITicket.sol";
import {IOrganizers} from "./interfaces/IOrganizers.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {ReentrancyGuard} from "solady/utils/ReentrancyGuard.sol";
import {SafeCastLib} from "solady/utils/SafeCastLib.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";

/// @title SettlementVault
/// @notice MONTI's programmable-settlement layer (design 2026-10-01; v2 design 2026-10-12 §3–§4).
///         Ticket.publishEvent writes a paid event's split policy here in the same transaction, frozen
///         from that moment (`setPolicyByTicket`). A paid ticket exists only through `purchase`: the vault
///         mints it via `Ticket.mintPaid` (vault-only) and escrows the on-chain tier price in the same call,
///         so "minted but not paid" is not a reachable state. On real admission (`Ticket.usedAt != 0`)
///         anyone releases that ticket's escrow, splitting it to the recipients by bps with a per-recipient
///         pull fallback. No-shows settle after the event ends; deposits refund before release.
///
/// @dev    Admission paths never call the vault, so check-in can never revert because of settlement
///         (founder requirement). The vault is not an ERC-2771 target: the organizer's authority reaches it
///         as an argument from Ticket (`_msgSender()` there), and the vault re-checks PERM_MANAGE_SETTLEMENT
///         itself. Money paths are `nonReentrant` with checks-effects-interactions (status flipped before
///         any transfer) and use solady SafeTransferLib for USDC's non-standard bool return.
contract SettlementVault is ISettlementVault, ReentrancyGuard {
    // --- constants ------------------------------------------------------------------------------

    /// @notice Organizers permission bit for settlement management. Bits 1/2/4/8/16 are in use and
    ///         Ticket uses 32, so the next free bit is 64 (design §1). Organizers is unchanged:
    ///         `hasPermission` takes any bitmask and the org owner implicitly holds every bit, so the
    ///         demo's "owner sets the policy" passes with no change there.
    uint32 public constant PERM_MANAGE_SETTLEMENT = 64;

    /// @notice Token base units per US cent. The on-chain tier price (`Tier.priceUsdCents`) is canonical;
    ///         escrow = price × UNITS_PER_CENT. 1e4 is right only for a 6-decimal USD stable (Circle USDC),
    ///         so the allowlist refuses any token whose decimals() is not 6.
    uint256 public constant UNITS_PER_CENT = 1e4;
    uint8 internal constant TOKEN_DECIMALS = 6;

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

    // --- state ----------------------------------------------------------------------------------

    address public owner;
    bool public paused;

    mapping(uint256 => Escrow) public escrowOf; // tokenId => escrow
    mapping(address => bool) public tokenAllowed; // USDC allowlist (6-decimal USD stables only)
    mapping(address => bool) public depositor; // purchase/adapter-refund allowlist (treasury/PG)
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

    /// @param ticket_ live Ticket (the only `setPolicyByTicket` caller and the `mintPaid` callee).
    /// @param organizers_ live Organizers (PERM_MANAGE_SETTLEMENT is re-checked here).
    /// @param initialDepositor the treasury/PG adapter allowed to purchase (optional; 0 to skip).
    /// @param initialToken a 6-decimal token to allowlist at deploy, e.g. Circle USDC (optional; 0 to skip).
    constructor(address ticket_, address organizers_, address initialDepositor, address initialToken) {
        owner = msg.sender;
        ticket = ITicketReader(ticket_);
        organizers = IOrganizers(organizers_);
        if (initialDepositor != address(0)) {
            depositor[initialDepositor] = true;
            emit DepositorSet(initialDepositor, true);
        }
        if (initialToken != address(0)) _setTokenAllowed(initialToken, true);
    }

    // --- policy ---------------------------------------------------------------------------------

    /// @notice Record a paid event's split, called by Ticket.publishEvent in the publishing transaction
    ///         (v2 D2). `organizer` is Ticket's `_msgSender()` (the forwarded organizer); the vault checks
    ///         its PERM_MANAGE_SETTLEMENT itself rather than trusting Ticket's PERM_CREATE_EVENT check.
    ///         Set exactly once and frozen at once: publishing is the public promise, so there is no
    ///         post-publish edit path (edits happen in the off-chain draft).
    function setPolicyByTicket(uint256 eventId, SplitPolicy calldata policy, address organizer) external whenNotPaused {
        if (msg.sender != address(ticket)) revert NotTicket();
        // Ticket stored the event meta before calling, so eventOrg is the real organizer id here.
        uint256 orgId = ticket.eventOrg(eventId);
        if (!organizers.hasPermission(orgId, organizer, PERM_MANAGE_SETTLEMENT)) revert NotPolicyAuthorizer();
        SplitPolicy storage sp = _policyOf[eventId];
        if (sp.version != 0) revert PolicyFrozen();
        _validatePolicy(policy);

        uint256 n = policy.recipients.length;
        for (uint256 i; i < n; ++i) {
            sp.recipients.push(policy.recipients[i]);
        }
        sp.platformBps = policy.platformBps;
        sp.reserveBps = policy.reserveBps;
        sp.noShowRefund = policy.noShowRefund;
        sp.frozen = true;
        sp.version = 1;

        emit PolicySet(eventId, organizer, hashPolicy(policy), 1);
    }

    /// @notice keccak256 over the policy content. frozen/version are lifecycle state, not content.
    function hashPolicy(SplitPolicy calldata policy) public pure returns (bytes32) {
        return keccak256(abi.encode(policy.recipients, policy.platformBps, policy.reserveBps, policy.noShowRefund));
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

    // --- purchase -------------------------------------------------------------------------------

    /// @notice Atomic paid purchase (v2 D1). An allowlisted adapter (treasury/PG) submits the attendee's
    ///         device-signed ClaimAuth; the vault mints through `Ticket.mintPaid` (vault-only — it runs every
    ///         claim check and the paid-tier rule) and escrows the on-chain tier price × UNITS_PER_CENT,
    ///         pulled from the adapter, in the same call. Any failure (allowance, balance, sold out, limits,
    ///         bad signature) reverts the whole purchase — the ticket and the nonce consumption included.
    ///         One receipt carries Transfer(0→account) → Claimed → Deposited.
    /// @dev    The escrow write follows the mint because the tokenId is only known after it. The mint can
    ///         call back into a deployed receiver (`_safeMint`), but every vault money path is
    ///         `nonReentrant`, so the callback cannot reach vault funds; the escrow slot for a fresh tokenId
    ///         is necessarily empty, so there is nothing to double-write.
    function purchase(ITicket.ClaimAuth calldata a, bytes calldata deviceSig, address token)
        external
        onlyDepositor
        whenNotPaused
        nonReentrant
        returns (uint256 tokenId)
    {
        if (!tokenAllowed[token]) revert TokenNotAllowed();
        uint256 priceUsdCents;
        (tokenId, priceUsdCents) = ticket.mintPaid(a, deviceSig);
        uint128 amount = SafeCastLib.toUint128(priceUsdCents * UNITS_PER_CENT);

        escrowOf[tokenId] = Escrow({
            token: token, amount: amount, payer: msg.sender, depositedAt: uint64(block.timestamp), status: ESC_HELD
        });

        SafeTransferLib.safeTransferFrom(token, msg.sender, address(this), amount);
        emit Deposited(a.eventId, tokenId, token, amount, msg.sender);
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
        _setTokenAllowed(token, allowed);
    }

    /// @dev Allowlisting checks decimals() == 6: UNITS_PER_CENT assumes it, and an 18-decimal token would
    ///      silently escrow 10^-12 of the price. Removing a token needs no check.
    function _setTokenAllowed(address token, bool allowed) internal {
        if (allowed && IERC20Metadata(token).decimals() != TOKEN_DECIMALS) revert UnsupportedDecimals();
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
