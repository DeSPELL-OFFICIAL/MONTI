// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

/// @notice The read slice of Ticket that SettlementVault binds to. The vault only ever *reads* Ticket
///         (design 2026-10-01 §3: "금고가 Ticket 을 읽는다, Ticket 은 금고를 모른다") so check-in can
///         never revert because of settlement. The shared `interfaces/ITicket.sol` is deliberately
///         narrow (eventOrg/eventOf/isRevoked) and is implemented by MockTicket, so it is left untouched;
///         this is the wider read view the vault needs. `eventStatus` returns the raw uint8 of
///         Ticket.EventStatus (Draft 0 · Published 1 · Cancelled 2 · Ended 3).
interface ITicketReader {
    function usedAt(uint256 tokenId) external view returns (uint32);
    function eventOf(uint256 tokenId) external view returns (uint256);
    function eventOrg(uint256 eventId) external view returns (uint256);
    function eventStatus(uint256 eventId) external view returns (uint8);
}

/// @title ISettlementVault
/// @notice Types, events and errors of the MONTI programmable-settlement layer (design 2026-10-01,
///         Q1–Q3). The vault is a standalone contract that reads the live Ticket/Organizers/Identity
///         and holds per-ticket USDC escrow released on real admission. The canonical ABI for off-chain
///         consumers is the compiled artifact (`packages/shared/src/abi/SettlementVault.json`); this
///         Solidity interface is the typed contract the vault is checked against at compile time.
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

    /// @notice A frozen-on-first-sale split (0xSplits "immutable split" as the safe default). `platformBps`
    ///         mirrors the bps of the recipient tagged "platform" for validation + public visibility.
    ///         `reserveBps` is a fiat/PG-layer refund-buffer mirror (demo 0, not applied to the on-chain
    ///         split). `noShowRefund` chooses the no-show rule: false = settle no-show share to recipients
    ///         (default), true = refund it to the payer. `version` increments on each (pre-freeze) set.
    struct SplitPolicy {
        Recipient[] recipients;
        uint16 platformBps;
        uint16 reserveBps;
        bool noShowRefund;
        bool frozen;
        uint32 version;
    }

    /// @notice The replay-safe authorisation that an organizer's device key signs over the policy.
    ///         `organizer` is the account whose P-256 device key signs and whose Organizers permission is
    ///         checked; `nonce` == policyNonce(organizer); `deadline` bounds an unsubmitted auth.
    struct PolicyAuth {
        address organizer;
        uint256 nonce;
        uint64 deadline;
    }

    /// @notice Per-ticket escrow. `payer` is the depositing adapter (refunds return here). `status`:
    ///         0 None · 1 Held · 2 Released · 3 Refunded.
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
    event Paid(uint256 indexed eventId, uint256 indexed tokenId, address indexed recipient, uint256 amount, bytes32 reasonHash);
    /// @notice A recipient transfer failed (e.g. USDC blacklist) so its share was credited for pull.
    event PayoutDeferred(uint256 indexed eventId, uint256 indexed tokenId, address indexed recipient, address token, uint256 amount);
    event Withdrawn(address indexed recipient, address indexed token, uint256 amount);
    event TokenAllowed(address indexed token, bool allowed);
    event DepositorSet(address indexed account, bool allowed);
    event PausedSet(bool paused);

    // --- errors ---------------------------------------------------------------------------------

    error NotOwner();
    error NotDepositor();
    error NotPolicyAuthorizer();
    error Paused();
    error UnknownEvent();
    error EventMismatch();
    error TokenNotAllowed();
    error ZeroAmount();
    error AlreadyDeposited();
    error NoPolicy();
    error PolicyFrozen();
    error AuthExpired();
    error BadNonce();
    error BadDeviceSignature();
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

    function setPolicy(uint256 eventId, SplitPolicy calldata policy, PolicyAuth calldata auth, bytes calldata deviceSig)
        external;
    function hashPolicy(SplitPolicy calldata policy) external pure returns (bytes32);
    function setPolicyDigest(uint256 eventId, bytes32 policyHash, uint256 nonce, uint64 deadline)
        external
        view
        returns (bytes32);
    function getPolicy(uint256 eventId) external view returns (SplitPolicy memory);

    function deposit(uint256 eventId, uint256 tokenId, address token, uint128 amount) external;
    function release(uint256 tokenId) external;
    function releaseMany(uint256[] calldata tokenIds) external;
    function settleNoShows(uint256 eventId, uint256[] calldata tokenIds) external;
    function refund(uint256 tokenId) external;
    function withdraw(address token) external;

    function setTokenAllowed(address token, bool allowed) external;
    function setDepositor(address account, bool allowed) external;
    function setPaused(bool paused) external;
}
