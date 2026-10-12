# MONTI v2 ABI delta (K1 freeze, 2026-10-12)

Design: `docs/superpowers/specs/2026-10-12-monti-v2-tx-diet-design.md` (D1–D8, §8).
Canonical ABI: `packages/shared/src/abi/{Ticket,SettlementVault,Identity,Organizers,MontiForwarder}.json`
(generated from `contracts/out/*` with the `script/export-abi.sh` jq step). **Any signature change from here on
needs orchestrator approval.**

| Contract | ABI file changed? |
|---|---|
| Ticket | yes |
| SettlementVault | yes |
| Identity | yes (removals only) |
| Organizers | **no** (behaviour change only: open on register, ids from 1001) |
| MontiForwarder | **no** (redeploy only) |

## Ticket

### Added
| Kind | Signature | Selector |
|---|---|---|
| function | `publishEvent((uint256,bytes32,bytes32,string,uint64,uint64,bytes32,uint64,uint64,bool,uint32,uint8,bool,uint8,bytes32,bool) meta, (string,uint256,uint32,uint32,uint16,bool)[] tiers_, ((address,uint16,bytes32,bytes32)[],uint16,uint16,bool,bool,uint32) policy) returns (uint256 eventId)` | `0x7254c158` |
| function | `mintPaid((uint256,uint8,address,uint256,uint64) a, bytes deviceSig) returns (uint256 tokenId, uint256 priceUsdCents)` — **SettlementVault only** (`msg.sender == vault`) | `0x00e32071` |
| function | `setVault(address vault_)` — deployer only, once, non-zero | `0x6817031b` |
| function | `vault() view returns (address)` | `0xfbfa77cf` |
| function | `deployer() view returns (address)` | `0xd5f39488` |
| error | `NotDeployer()` | `0x8b906c97` |
| error | `VaultAlreadySet()` | `0x1bb0ddfb` |
| error | `ZeroAddress()` | `0xd92e233d` |
| error | `NotVault()` | `0x62df0545` |
| error | `NotPaidTier()` — `purchase` on a free tier | `0x150b9a8f` |
| error | `PolicyRequired()` — paid publish with 0 recipients | `0xaa056e56` |
| error | `UnexpectedPolicy()` — free publish with ≥1 recipient | `0x8e8ffa98` |
| error | `PaidApprovalUnsupported()` — paid publish with `approvalRequired` | `0x33fb956a` |

Solidity names: `meta` is `Ticket.EventMeta`, `tiers_` is `Ticket.Tier[]`, `policy` is `ISettlementVault.SplitPolicy`.

### Removed
| Kind | Signature |
|---|---|
| function | `createEvent(EventMeta meta, Tier[] tiers_) returns (uint256)` |
| function | `publishEvent(uint256 eventId)` |
| function | `updateEventMeta(uint256 eventId, EventMeta meta, Tier[] tiers_)` |
| function | `requestOverride(uint256 tokenId, uint256 gateId, uint8 reason)` |
| event | `EventMetaUpdated(uint256 indexed eventId)` |
| event | `OverrideRequested(uint256 indexed tokenId, uint256 indexed gateId, address indexed requester, uint8 reason)` |
| error | `NotDraft()` |

### Behaviour changes (same signature)
- `publishEvent` = create + publish (+ policy if paid) in one tx. Permission: `_msgSender()` needs PERM_CREATE_EVENT (1)
  on `meta.orgId`; for a paid event the vault additionally requires PERM_MANAGE_SETTLEMENT (64) for the same account
  (owner has all bits). Paid = any tier `priceUsdCents > 0`. Checks in order: `Unauthorized` → `InvalidTiers` (1–8) →
  `InvalidSchedule` → `PaidApprovalUnsupported` / `PolicyRequired` / `UnexpectedPolicy` → vault errors (bubbled).
  Receipt order: `EventCreated(eventId, orgId, organizer)` → `EventStatusChanged(eventId, 1)` → (paid)
  `SettlementVault.PolicySet(eventId, organizer, policyHash, 1)`. Paid publish while the vault is paused reverts `Paused()`.
  `policy.frozen` / `policy.version` from the caller are ignored (stored as `true` / `1`).
- **Event ids start at 1001** (`_nextEventId = 1001`). `EventStatus` numbering unchanged (Draft=0 now only means "no such event").
- `claimFor` is free-tier only: a paid tier reverts `PaidTiersNotEnabled()` (`0x42b49f58`). Shape unchanged.
- `ClaimAuth` is now declared in `ITicket` (`ITicket.ClaimAuth`); the ABI tuple `(uint256 eventId, uint8 tier,
  address account, uint256 nonce, uint64 deadline)` and `claimAuthDigest` are unchanged. In Solidity tests use
  `ITicket.ClaimAuth` (`Ticket.ClaimAuth` no longer resolves).
- Unchanged events the indexer relies on: `EventCreated`, `EventStatusChanged`, `Claimed`, `ClaimRequested`,
  `ClaimApproved`, `ClaimRejected`, `CheckedIn`, `CheckedInLate`, `ManualOverride`, `Revoked`, `Migrated`, `Offer*`, `Transfer`.

## SettlementVault

### Constructor
`constructor(address ticket_, address organizers_, address initialDepositor, address initialToken)`
(was `(ticket_, organizers_, identity_, initialDepositor, initialToken)`). `initialToken` (if non-zero) must report
`decimals() == 6` or the deploy reverts `UnsupportedDecimals()`.

### Added
| Kind | Signature | Selector |
|---|---|---|
| function | `purchase((uint256,uint8,address,uint256,uint64) a, bytes deviceSig, address token) returns (uint256 tokenId)` — `onlyDepositor`, `whenNotPaused`, `nonReentrant` | `0xbff81841` |
| function | `setPolicyByTicket(uint256 eventId, ((address,uint16,bytes32,bytes32)[],uint16,uint16,bool,bool,uint32) policy, address organizer)` — Ticket only, `whenNotPaused` | `0x5eedc13d` |
| function | `UNITS_PER_CENT() view returns (uint256)` = `1e4` | `0x8e9294a8` |
| error | `NotTicket()` | `0xbcfcfe36` |
| error | `UnsupportedDecimals()` — **not in design §8** (design §3 "권장" decimals guard; see Deviations) | `0xd4f1d302` |

### Removed
| Kind | Signature |
|---|---|
| function | `setPolicy(uint256 eventId, SplitPolicy policy, (address organizer,uint256 nonce,uint64 deadline) auth, bytes deviceSig)` |
| function | `setPolicyDigest(uint256 eventId, bytes32 policyHash, uint256 nonce, uint64 deadline) view returns (bytes32)` |
| function | `SETTLE_POLICY_TAG() view returns (bytes32)` |
| function | `policyNonce(address) view returns (uint256)` |
| function | `deposit(uint256 eventId, uint256 tokenId, address token, uint128 amount)` |
| function | `identity() view returns (address)` (constructor arg removed) |
| struct | `PolicyAuth` |
| error | `AuthExpired()`, `BadNonce()`, `BadDeviceSignature()`, `AlreadyDeposited()`, `ZeroAmount()`, `NoPolicy()`, `UnknownEvent()` |

### Behaviour changes
- `purchase`: `tokenAllowed[token]` (`TokenNotAllowed`) → `ticket.mintPaid(a, deviceSig)` (all Ticket claim errors
  bubble: `AuthExpired, BadNonce, NotMember, DeviceLocked, BadDeviceSignature, EventEnded, EventNotPublished,
  ApprovalRequired, KycRequired, SaleClosed, UnknownTier, NotPaidTier, SoldOut, MaxPerWalletExceeded,
  RotationPending`) → `amount = priceUsdCents * 1e4` (uint128, SafeCast) → escrow `{token, amount, payer=msg.sender,
  now, HELD}` → `safeTransferFrom(msg.sender → vault, amount)` (solady `TransferFromFailed()` `0x7939f424` on missing
  allowance/balance) → `Deposited`. Any revert undoes the mint and the nonce consumption (same ClaimAuth can be retried).
  Receipt order: `Ticket.Transfer(0 → account, tokenId)` → `Ticket.Claimed(tokenId, eventId, account, tier)` →
  `SettlementVault.Deposited(eventId, tokenId, token, amount, payer)`.
  The amount is **always the on-chain tier price**; there is no amount argument (backend pre-checks
  `tiers(eventId)[tier].priceUsdCents == payment.amountUsdCents` for a friendly error only).
- Simulation ABI for `purchase` must include Ticket + SettlementVault + `error TransferFromFailed()`.
- `setPolicyByTicket`: `NotTicket` → `NotPolicyAuthorizer` (organizer lacks bit 64 on `ticket.eventOrg(eventId)`) →
  `PolicyFrozen` (already set; `version != 0`) → `_validatePolicy` errors (`InvalidRecipients, ZeroRecipient, ZeroBps,
  BadSplitSum, PlatformShareTooLow, PlatformMirrorMismatch, BadReserve`). Stores `frozen = true, version = 1`.
  Policy is frozen at publish; there is no edit path.
- `setTokenAllowed(token, true)` reverts `UnsupportedDecimals()` unless `decimals() == 6`.
- Unchanged: `hashPolicy`, `getPolicy`, `escrowOf`, `release`, `releaseMany`, `settleNoShows`, `refund`, `withdraw`,
  `pendingWithdrawals`, `tokenAllowed`, `depositor`, admin functions, all events (`PolicySet`, `Deposited`, `Released`,
  `NoShowSettled`, `Refunded`, `Paid`, `PayoutDeferred`, `Withdrawn`, `TokenAllowed`, `DepositorSet`, `PausedSet`).
  Split math unchanged: rows paid in policy order, rounding dust to the last row.

## Identity
Removed: `setNickname(bytes32 nicknameHash, string nickname)`, `nicknameOwner(bytes32) view returns (address)`,
`nicknameOf(address) view returns (bytes32)`, event `NicknameSet(address indexed account, bytes32 indexed nicknameHash,
string nickname)`, errors `NicknameTaken()`, `NicknameHashMismatch()`. `rotateAccount`/`cancelRotation` no longer move
a nickname. `IIdentity` drops `nicknameOwner`/`nicknameOf`.

## Organizers (ABI unchanged)
- `registerGate(uint256 eventId, address gateAccount, bytes32 kx, bytes32 ky) returns (uint256 gateId)` now stores
  `open: true` and emits `GateRegistered(...)` then `GateOpened(gateId)` in the same tx. `openGate/closeGate/revokeGate` unchanged.
- **Organizer ids start at 1001** (`_nextOrgId = 1001`). Gate ids still start at 1.

## Deployment record (C6, design §8)
`deployments/10143.json` = `{chainId, block, identity, forwarder, organizers, ticket, settlementVault, usdc, attester}`
(no `previous[]`, no `settlementVaultBlock`). Order: Identity → MontiForwarder → Organizers → Ticket → SettlementVault →
`identity.setForwarder` → `fwd.setTargets(ticket, organizers)` → `organizers.setTicket` → `ticket.setVault(vault)`.

## Gas (forge `--isolate --gas-report`, single-tier event, 4-row split, first purchase in event; not Monad-measured)
| Call | Gas |
|---|---|
| `SettlementVault.purchase` (mint + escrow + USDC pull, 1 tx) | 300,521 |
| `Ticket.claimFor` free tier (reference; ≈ v1 paid-path relayer mint) | 157,536 |
| `Ticket.publishEvent` free / paid (direct call, not forwarded) | 320,568 / 681,347 |
| `Organizers.registerGate` (now incl. open) | 174,978 |
| `Ticket.checkInFor` | 110,173 |
| `SettlementVault.release` (4 rows) | 191,873 |

v1 paid path = mint (~157k, relayer) + `deposit` (~254k, treasury) ≈ 411k in 2 tx → v2 `purchase` ≈ 301k in 1 tx
(~27% less gas; all paid by the treasury now). Monad bills the gas **limit**, so the backend's estimate buffer drives cost.

## C7 measured gas (2026-10-12, in-EVM; ForwardGas/SettlementGas/V2Flow suites)
Execution gas (no 21k intrinsic, no calldata), local osaka; "monad-eq" subtracts 3,450 per P-256 verify (Monad RIP-7212).

| Step (who sends) | Execution gas | Monad-eq |
|---|---|---|
| `publishEvent` free, via forwarder (relayer) | 351,806 | 348,356 |
| `publishEvent` paid, 1 tier + 4-row split, via forwarder (relayer) | 708,804 | 705,354 |
| `registerGate` (opens), via forwarder (relayer) | 213,391 | 209,941 |
| `purchase`, steady state (treasury) | 216,289 | 212,839 |
| `purchase`, first in event, full tx incl. intrinsic (`--isolate`) | 300,521 tx gas | — |
| `checkInFor` (relayer), full tx (`--isolate`) | 110,521 tx gas | — |
| `release` 4 rows, cold | 185,384 | same |
| `refund` | 56,627 | same |
| `settleNoShows` 1 / 10 | 193,757 / 606,337 | same |

Organizer to first sale = `createOrganizer` + paid `publishEvent` + `registerGate` = 3 tx (v1: 6).

## K3 deploy (testnet rc1) — operator runs this
Dry-run verified 2026-10-12 against a 10143 fork (simulation only): 9 transactions, ≈16.1M gas, ≈3.3 MON at ~205 gwei.
`--code-size-limit 131072` is required (Ticket runtime 30,831 B > EIP-170; without it forge stops at a confirmation prompt).

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/MONTI-prod/contracts
export RPC=<monad testnet rpc>
DEPLOYER_PK=$DEPLOYER_PK_V2 \
ATTESTER_ADDRESS=0x6af898aA4d99375839d7069431A7019a6D84C4Ed \
TREASURY_ADDRESS=0xAe6D18fA7dC1e2512a2dC7DaE1d4640D7D786Bb2 \
USDC_ADDRESS=0x534b2f3A21130d7a60830c2Df862319e593943A3 \
forge script script/Deploy.s.sol:Deploy --rpc-url $RPC --broadcast --slow --non-interactive --code-size-limit 131072
# writes deployments/10143.json = {attester, block, chainId, forwarder, identity, organizers, settlementVault, ticket, usdc}

TREASURY_ADDRESS=0xAe6D18fA7dC1e2512a2dC7DaE1d4640D7D786Bb2 DEPLOYER_ADDRESS=<new deployer address> \
forge script script/Verify.s.sol:Verify --rpc-url $RPC
# read-only; prints OK/FAIL for the 12 O3 wiring reads (+7 consistency reads), reverts if any fails
```
