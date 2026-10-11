// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {ITicket} from "./ITicket.sol";

/// @notice The slice of Ticket that SettlementVault binds to (v2 design §2). The vault reads Ticket
///         (`usedAt/eventOf/eventOrg/eventStatus`) and is the only caller allowed to mint a paid ticket
///         (`mintPaid`) — the contract that takes the money is the one that mints (Zora 1155 minter
///         pattern). Admission paths never call the vault, so check-in can never revert because of
///         settlement. `eventStatus` returns the raw uint8 of Ticket.EventStatus (Draft 0 · Published 1 ·
///         Cancelled 2 · Ended 3).
interface ITicketReader {
    function usedAt(uint256 tokenId) external view returns (uint32);
    function eventOf(uint256 tokenId) external view returns (uint256);
    function eventOrg(uint256 eventId) external view returns (uint256);
    function eventStatus(uint256 eventId) external view returns (uint8);
    function mintPaid(ITicket.ClaimAuth calldata a, bytes calldata deviceSig)
        external
        returns (uint256 tokenId, uint256 priceUsdCents);
}

/// @title ISettlementVault
/// @notice Types, events and errors of the MONTI programmable-settlement layer (design 2026-10-01,
///         v2 design 2026-10-12 §3–§4). The canonical ABI for off-chain consumers is the compiled
///         artifact (`packages/shared/src/abi/SettlementVault.json`); this Solidity interface is the
///         typed contract the vault is checked against at compile time.
interface ISettlementVault {
    // --- types ----------------------------------------------------------------------------------

    /// @notice One payout line. `bps` is basis points (10_000 = 100%); `reasonHash` is keccak256 of the
    ///         off-chain reason text (provable, cheap); `tag` is a short on-chain classifier (e.g.
    ///         "artist"/"venue"/"platform") the public ledger filters by.
    struct Recipient {
        address account;
        uint16 bps;
        bytes32 reasonHash;
        bytes32 tag;
    }

    /// @notice An event's split, set once by Ticket.publishEvent and frozen at that moment (v2 D2).
    ///         `platformBps` mirrors the bps of the recipient tagged "platform" for validation + public
    ///         visibility. `reserveBps` is a fiat/PG-layer refund-buffer mirror (demo 0, not applied to the
    ///         on-chain split). `noShowRefund` chooses the no-show rule: false = settle no-show share to
    ///         recipients (default), true = refund it to the payer. `frozen`/`version` are lifecycle state
    ///         the vault writes (true / 1); values passed in by the caller are ignored.
    struct SplitPolicy {
        Recipient[] recipients;
        uint16 platformBps;
        uint16 reserveBps;
        bool noShowRefund;
        bool frozen;
        uint32 version;
    }

    /// @notice Per-ticket escrow. `payer` is the depositor that bought the ticket (refunds return here).
    ///         `status`: 0 None · 1 Held · 2 Released · 3 Refunded.
    struct Escrow {
        address token;
        uint128 amount;
        address payer;
        uint64 depositedAt;
        uint8 status;
    }

    // --- events ---------------------------------------------------------------------------------

    event PolicySet(uint256 indexed eventId, address indexed organizer, bytes32 policyHash, uint32 version);
    event Deposited(uint256 indexed eventId, uint256 indexed tokenId, address token, uint128 amount, address payer);
    event Released(uint256 indexed eventId, uint256 indexed tokenId, address token, uint256 amount);
    event NoShowSettled(uint256 indexed eventId, uint256 indexed tokenId, address token, uint256 amount);
    event Refunded(uint256 indexed eventId, uint256 indexed tokenId, address token, uint256 amount, address payer);
    /// @notice One payout line of a release/settle. The public ledger's per-recipient row, carrying the
    ///         reason hash so anyone can re-derive keccak256(reason) and prove it was not altered.
    event Paid(
        uint256 indexed eventId, uint256 indexed tokenId, address indexed recipient, uint256 amount, bytes32 reasonHash
    );
    /// @notice A recipient transfer failed (e.g. USDC blacklist) so its share was credited for pull.
    event PayoutDeferred(
        uint256 indexed eventId, uint256 indexed tokenId, address indexed recipient, address token, uint256 amount
    );
    event Withdrawn(address indexed recipient, address indexed token, uint256 amount);
    event TokenAllowed(address indexed token, bool allowed);
    event DepositorSet(address indexed account, bool allowed);
    event PausedSet(bool paused);

    // --- errors ---------------------------------------------------------------------------------

    error NotOwner();
    error NotDepositor();
    error NotTicket();
    error NotPolicyAuthorizer();
    error Paused();
    error EventMismatch();
    error TokenNotAllowed();
    error UnsupportedDecimals();
    error PolicyFrozen();
    error InvalidRecipients();
    error ZeroRecipient();
    error ZeroBps();
    error BadSplitSum();
    error PlatformShareTooLow();
    error PlatformMirrorMismatch();
    error BadReserve();
    error NoEscrow();
    error NotCheckedIn();
    error AlreadySettled();
    error EventNotEnded();
    error EventEnded();
    error AlreadyCheckedIn();
    error NothingToRefund();
    error NothingToWithdraw();

    // --- functions ------------------------------------------------------------------------------

    function setPolicyByTicket(uint256 eventId, SplitPolicy calldata policy, address organizer) external;
    function hashPolicy(SplitPolicy calldata policy) external pure returns (bytes32);
    function getPolicy(uint256 eventId) external view returns (SplitPolicy memory);

    function purchase(ITicket.ClaimAuth calldata a, bytes calldata deviceSig, address token)
        external
        returns (uint256 tokenId);
    function release(uint256 tokenId) external;
    function releaseMany(uint256[] calldata tokenIds) external;
    function settleNoShows(uint256 eventId, uint256[] calldata tokenIds) external;
    function refund(uint256 tokenId) external;
    function withdraw(address token) external;

    function setTokenAllowed(address token, bool allowed) external;
    function setDepositor(address account, bool allowed) external;
    function setPaused(bool paused) external;
}
