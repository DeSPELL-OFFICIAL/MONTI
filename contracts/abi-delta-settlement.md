# ABI delta — programmable settlement (SettlementVault)

Branch `mvp-settle`. Interface contract for shared/backend/web/indexer against Batch A. One **new**
contract, `contracts/src/SettlementVault.sol`; the core four (Ticket/Organizers/Identity/MontiForwarder)
are **unchanged** — no core redeploy. ABI: `packages/shared/src/abi/SettlementVault.json` (71 entries).
Pin every string, type order and selector below verbatim.

Design: `docs/superpowers/plans/2026-10-01-monti-settlement-split-design.md` (Q1–Q3). Plan A1–A3:
`docs/superpowers/plans/2026-10-01-monti-settlement-split-plan.md`.

## 1. Deploy key additions

`DeploySettlement.s.sol` deploys only the vault (pointed at the existing core-4 read from
`deployments/<chainid>.json`) and adds **two keys in place** to that JSON — core-4 addresses and
`previous[]` untouched:

```jsonc
{
  // ...existing identity/forwarder/organizers/ticket/attester/block/previous kept as-is...
  "settlementVault": "0x…",   // new: SettlementVault
  "usdc":            "0x534b2f3A21130d7a60830c2Df862319e593943A3"  // Circle test USDC (10143), 6 decimals
}
```

Constructor: `SettlementVault(address ticket, address organizers, address identity, address initialDepositor, address initialToken)`.
`initialDepositor` = MONTI treasury/PG adapter (allowlisted to deposit); `initialToken` = USDC (allowlisted).
Deployer becomes `owner` (pause + allowlists). Env for the real deploy (A4): `DEPLOYER_PK`,
`TREASURY_ADDRESS`, `USDC_ADDRESS` (defaults to the Circle address above).

## 2. Permission

`PERM_MANAGE_SETTLEMENT = 64` (bits 1/2/4/8/16 used; Ticket uses 32 → next free is 64). **Organizers is
unchanged**: `hasPermission(orgId, account, 64)` already works (owner holds every bit; delegate with the
existing `setAdmin(orgId, admin, 64)`).

## 3. Types (pin field order — used by `abi.encode` in the digest)

```solidity
struct Recipient  { address account; uint16 bps; bytes32 reasonHash; bytes32 tag; } // sum(bps) == 10_000
struct SplitPolicy{ Recipient[] recipients; uint16 platformBps; uint16 reserveBps; bool noShowRefund; bool frozen; uint32 version; }
struct PolicyAuth { address organizer; uint256 nonce; uint64 deadline; }
struct Escrow     { address token; uint128 amount; address payer; uint64 depositedAt; uint8 status; } // status: 0 None·1 Held·2 Released·3 Refunded
```

- `platformBps` must equal the bps of the recipient tagged `"platform"` and be ≥ `MIN_PLATFORM_BPS` (500).
- `reserveBps` is a fiat/PG refund-buffer mirror; **not applied to the on-chain split** (demo 0).
- `noShowRefund`: false (default) = no-show share distributed to recipients; true = refunded to payer.
- `tag` is `bytes32` (right-padded ASCII, e.g. `"platform"`, `"artist"`); `reasonHash` = `keccak256(reason text)`.

## 4. Policy digest (self-verify — exact, do not reorder)

```
SETTLE_POLICY_TAG = keccak256("MONTI:SETTLE_POLICY:v1")   // bytes32, leads the preimage

hashPolicy(policy) = keccak256(abi.encode(
    policy.recipients,     // Recipient[]
    policy.platformBps,    // uint16
    policy.reserveBps,     // uint16
    policy.noShowRefund    // bool
))   // frozen/version are lifecycle state, NOT signed

setPolicyDigest(eventId, policyHash, nonce, deadline) = sha256(abi.encode(
    SETTLE_POLICY_TAG,     // bytes32
    block.chainid,         // uint256
    address(this),         // address (the vault)
    eventId,               // uint256
    policyHash,            // bytes32
    nonce,                 // uint256  (== policyNonce(organizer))
    deadline               // uint64
))
```

The organizer's P-256 **device key** (Identity `activeDevice(organizer)`) signs `setPolicyDigest`;
`deviceSig` is 64 bytes `abi.encode(r, s)` — the same client signing primitive as `claimFor`. Both
`hashPolicy` and `setPolicyDigest` are public views for client/shared cross-check (shared/B1 must produce
identical bytes). Replay-safe per `policyNonce[organizer]`.

## 5. Functions

```solidity
// policy (frozen on first deposit; permissionless submit, organizer device-key authorised)
function setPolicy(uint256 eventId, SplitPolicy policy, PolicyAuth auth, bytes deviceSig) external;
function hashPolicy(SplitPolicy policy) external pure returns (bytes32);
function setPolicyDigest(uint256 eventId, bytes32 policyHash, uint256 nonce, uint64 deadline) external view returns (bytes32);
function getPolicy(uint256 eventId) external view returns (SplitPolicy);   // returns recipients too
function policyNonce(address organizer) external view returns (uint256);

// money
function deposit(uint256 eventId, uint256 tokenId, address token, uint128 amount) external; // onlyDepositor
function release(uint256 tokenId) external;                 // permissionless; requires usedAt(tokenId)!=0; single-shot
function releaseMany(uint256[] tokenIds) external;          // relayer batch; skips non-Held / not-yet-admitted
function settleNoShows(uint256 eventId, uint256[] tokenIds) external;  // after eventStatus==Ended
function refund(uint256 tokenId) external;                  // cancelled event (anyone) | payer before check-in
function withdraw(address token) external;                  // pull fallback (not pausable)
function escrowOf(uint256 tokenId) external view returns (Escrow);

// admin (owner)
function setTokenAllowed(address token, bool allowed) external;
function setDepositor(address account, bool allowed) external;
function setPaused(bool paused) external;
```

Naming note for backend/web: the release function is **`release` / `releaseMany`** (the design draft
called it `releaseOnCheckIn`). The relayer, on a `CheckedIn` event, submits `release(tokenId)` (or
`releaseMany`). `release` is single-shot (reverts `AlreadySettled` on a second call); `releaseMany` is
the tolerant batch that skips entries that are not Held or not yet admitted.

## 6. Events (public ledger)

```solidity
event PolicySet(uint256 indexed eventId, address indexed organizer, bytes32 policyHash, uint32 version);
event Deposited(uint256 indexed eventId, uint256 indexed tokenId, address token, uint128 amount, address payer);
event Released(uint256 indexed eventId, uint256 indexed tokenId, address token, uint256 amount);
event NoShowSettled(uint256 indexed eventId, uint256 indexed tokenId, address token, uint256 amount);
event Refunded(uint256 indexed eventId, uint256 indexed tokenId, address token, uint256 amount, address payer);
event Paid(uint256 indexed eventId, uint256 indexed tokenId, address indexed recipient, uint256 amount, bytes32 reasonHash);
event PayoutDeferred(uint256 indexed eventId, uint256 indexed tokenId, address indexed recipient, address token, uint256 amount);
event Withdrawn(address indexed recipient, address indexed token, uint256 amount);
event TokenAllowed(address indexed token, bool allowed);
event DepositorSet(address indexed account, bool allowed);
event PausedSet(bool paused);
```

The design's single "Settled" is realised as `Released` (per ticket) + `Paid` (per recipient, carrying
`reasonHash` so anyone can re-derive `keccak256(reason)` and prove it was not altered). A failed push
emits `PayoutDeferred` **and** `Paid` (the share is credited to `pendingWithdrawals[recipient][token]`
for `withdraw`).

## 7. Measured gas (SettlementGas.t.sol — replaces design §6 estimates)

Local = `evm_version "osaka"` real P256VERIFY (6,900/verify). monad-eq subtracts the Monad RIP-7212 delta
(3,450) only for the one op that verifies P-256 (`setPolicy`); the rest do no P-256 work.

| op | local gas | monad-eq | note |
|---|---:|---:|---|
| setPolicy (4 recipients + P-256) | 385,380 | 381,930 | fresh policy = 4 recipient structs stored; higher than the §6 ~200k estimate |
| deposit | 119,736 | 119,736 | steady state (post-freeze); ~§6 ~100k |
| release (4 recipients, cold) | 185,317 | 185,317 | 4 ERC-20 transfers + distribution; below §6 ~220k |
| settleNoShows(1) | 193,617 | 193,617 | one no-show distributed |
| settleNoShows(10) | 605,801 | 605,801 | ≈ 46k marginal per extra no-show |
| refund | 56,443 | 56,443 | below §6 ~70k |

Relayer-limit sizing: all ops fit comfortably; fees cover gas ~650× (design §4). setPolicy is the most
expensive (one-time per event); the per-ticket steady state is deposit + release ≈ 305k.

## 8. Deviations from the design (and why)

- **`release`/`releaseMany`** instead of `releaseOnCheckIn` (task A spec). `release` reverts on double
  release (task AC); `releaseMany` carries the design's tolerant/idempotent batch behaviour for the relayer.
- **Escrow status 0=None** (design listed 0=Held) so a never-deposited ticket (`NoEscrow`) is distinct
  from a held one. Values: 0 None · 1 Held · 2 Released · 3 Refunded.
- **No-show gate = `eventStatus == Ended`** (design authoritative), which is itself derived from
  `endsAt`, so no separate `grace` or reading the 17-field `EventMeta` struct is needed.
- **refund** gates on `usedAt==0 && status==Held && not Ended` (and the cancelled-event path) rather than
  reading `startsAt`; the "before sale/event start" window is enforced off-chain by the adapter.
- **`reserveBps`** kept in the signed policy for the fiat/PG layer but not applied to the on-chain split.
- Tag string is `SETTLE_POLICY_TAG = "MONTI:SETTLE_POLICY:v1"` (task spec; the design draft wrote
  `MONTI:SET_POLICY:v1`).

## 9. Open questions for backend (C) / web (D/E)

- Confirm the `release`/`releaseMany` naming in the relayer and shared client (not `releaseOnCheckIn`).
- No-show default is settle-to-recipients (`noShowRefund=false`); business/legal may flip per event.
- Reason **text** → `reasonHash` mapping is stored off-chain (Firestore); the public page re-derives
  `keccak256(reason)` to prove integrity. Shared/B1 must encode `hashPolicy`/`setPolicyDigest` to match.
