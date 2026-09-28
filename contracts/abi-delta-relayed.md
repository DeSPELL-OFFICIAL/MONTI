# Ticket ABI delta — relayed attendee actions + slim storage

Batch A (commit `eee7660` A1–A3, this batch A4). This file is the contract for the backend / web /
indexer agents. Everything here is measured against the pre-relay `Ticket.sol`.

Source of truth: `contracts/src/Ticket.sol`. Exported ABI: `packages/shared/src/abi/Ticket.json`
(135 entries). All gas numbers are local `osaka` (real EIP-7951 P-256 precompile at 0x100).

---

## 1. Removed functions (callers must migrate)

| Removed | Replaced by |
| --- | --- |
| `claim(uint256 eventId, uint8 tier, bytes voucher) returns (uint256)` | `claimFor(ClaimAuth, bytes deviceSig)` |
| `requestClaim(uint256 eventId, uint8 tier) returns (uint256)` | `requestClaimFor(ClaimAuth, bytes deviceSig)` |
| `checkIn(uint256 tokenId, GateCode, bytes deviceSig)` | `checkInFor(uint256 tokenId, GateCode, bytes gateSig, bytes deviceSig)` |
| `checkInLate(uint256 tokenId, GateCode, bytes deviceSig)` | `checkInForLate(uint256 tokenId, GateCode, bytes gateSig, bytes deviceSig)` |

The four new entry points are **permissionless**: `msg.sender` is not used for authorization. Any
relayer EOA may submit them; authority is proven by the attendee device P-256 signature (claim) and,
additionally, by the gate-key P-256 signature (check-in).

## 2. Added functions

| Signature | Notes |
| --- | --- |
| `claimFor(ClaimAuth a, bytes deviceSig) returns (uint256 tokenId)` | verifies auth, mints; approval-mode events revert `ApprovalRequired` |
| `requestClaimFor(ClaimAuth a, bytes deviceSig) returns (uint256 requestId)` | approval-mode only; emits `ClaimRequested` |
| `checkInFor(uint256 tokenId, GateCode g, bytes gateSig, bytes deviceSig)` | live door |
| `checkInForLate(uint256 tokenId, GateCode g, bytes gateSig, bytes deviceSig)` | offline-queue flush; gate need not be open, must not be revoked |
| `claimAuthDigest(ClaimAuth a) view returns (bytes32)` | cross-check digest for wallet/backend |
| `claimNonce(uint256 eventId, address account) view returns (uint256)` | read the next auth nonce |
| `usedAt(uint256 tokenId) view returns (uint32)` | admission timestamp; 0 = not used |

## 3. Changed reads

- `eventOf(uint256 tokenId)` / `tierOf(uint256 tokenId)` are now **`pure` decoders** of `tokenId`
  (no per-token storage).
- `checkInOf(uint256 tokenId) view returns (CheckIn)` keeps its shape and wire order, but under slim
  storage only `ts` is populated. `gateId = 0`, `nonceHash = 0x0`, `manual = false`, `late = false`
  **always**. Read `gateId` / `nonceHash` / `role` / `late` from the events instead.

## 4. Errors added

`BadGateSignature`, `AuthExpired`, `BadNonce`, `SerialOverflow`, `EventIdOverflow`. Staff/backend map
each to a DENY code by name.

## 5. Events (unchanged signatures, changed authority)

`Claimed`, `ClaimRequested`, `ClaimApproved`, `ClaimRejected`, `CheckedIn`, `CheckedInLate`,
`ManualOverride`, `OverrideRequested`, `Revoked`, `Migrated`, `Offer*` — all unchanged. Because slim
storage no longer keeps them, these events are now the **only** source of: `gateId`, `nonceHash`
(`CheckedIn`), `late` (`CheckedInLate`), and `role` (`ManualOverride`).

## 6. `ClaimAuth` struct + digest (exact, load-bearing)

```solidity
struct ClaimAuth {
    uint256 eventId;   // field 0
    uint8   tier;      // field 1
    address account;   // field 2 — the smart account that receives the ticket
    uint256 nonce;     // field 3 — == claimNonce(eventId, account)
    uint64  deadline;  // field 4 — block.timestamp <= deadline
}
```

`CLAIM_AUTH_TAG = keccak256("MONTI:CLAIM_AUTH:v1")`

Digest the attendee device key signs (P-256, low-s), **abi.encode order and types**:

```
claimAuthDigest = sha256(abi.encode(
    bytes32 CLAIM_AUTH_TAG,
    uint256 block.chainid,      // filled by the contract, not the caller
    address address(this),      // the Ticket address, filled by the contract
    uint256 a.eventId,
    uint8   a.tier,
    address a.account,
    uint256 a.nonce,
    uint64  a.deadline
))
```

`deviceSig = abi.encode(bytes32 r, bytes32 s)` (64 bytes; must be low-s, i.e. `s <= N/2`).

Verify flow (`_verifyClaimAuth`, in order): `deadline` → `nonce == claimNonce` (`BadNonce`) →
`isMember(account)` (`NotMember`) → `!isLocked(account)` (`DeviceLocked`) → P-256 over
`claimAuthDigest` against `activeDevice(account)` (`BadDeviceSignature`) → **nonce consumed** (+1)
before mint.

## 7. Check-in signatures (unchanged digests, gate sig now on-chain)

- **Gate signature** (`gateSig`, new arg) — gate-key P-256 over the staff gate-code digest:
  `sha256(abi.encode(uint256 g.gateId, uint256 g.eventId, uint64 g.issuedAt, bytes32 g.nonce))`.
  Verified against the gate's registered `(kx, ky)` from `Organizers.gateInfo`. Wrong key →
  `BadGateSignature`.
- **Device signature** (`deviceSig`) — unchanged from A-pre:
  `deviceDigest = sha256(abi.encode(block.chainid, address(this), tokenId, g.gateId, g.eventId, g.nonce, g.issuedAt))`.
- `GateCode { uint256 gateId; uint256 eventId; uint64 issuedAt; bytes32 nonce; }` — unchanged.

## 8. `tokenId` bit layout (slim storage §12-1)

```
tokenId = (eventId << 96) | (uint256(tier) << 88) | serial
```
| Field | Bits | Decode |
| --- | --- | --- |
| `serial` | `[0, 88)` | `tokenId & ((1 << 88) - 1)` — global mint counter, key of the usedAt packing |
| `tier`   | `[88, 96)` | `uint8((tokenId >> 88) & 0xff)` |
| `eventId`| `[96, 256)` | `tokenId >> 96` |

Guards: `SerialOverflow` if `serial > 2^88-1`, `EventIdOverflow` if `eventId > 2^160-1`.
**The first ticket's id is not 1** — it is `(eventId << 96) | 1`.

## 9. `usedAt` packing (slim storage §12-2)

`uint32 usedAt` is packed **8 per storage word**: word key `serial >> 3`, lane offset
`(serial & 7) * 32` bits. `usedAt == 0` means not used. Neighbours in the same word are preserved by
a read-modify-write. The first write in a fresh word pays a cold `0 -> nonzero` SSTORE; the next 7
share the word cheaply (measured saving ≈ 34.4k gas, §10).

`(eventId, account)` claim state is one packed `Wallet` slot: `uint64 nonce | uint32 held | uint32
pending`. `held == balanceOfEvent`, `nonce == claimNonce`. Bounded by `maxPerWallet`(uint16) /
`supply`(uint32), so the packed fields cannot overflow.

## 10. Gas (local osaka, execution gas)

| Action | Gas |
| --- | --- |
| `claimFor` | 133,021 |
| `requestClaimFor` | 138,961 |
| `checkInFor` (live) | ~89,078 (< 200k ceiling; margin ~111k) |
| `checkInForLate` | 91,492 (margin 108,508 under 200k) |
| `approveClaims` marginal / item | 60,371 |
| usedAt 8-pack — first write in a slot (cold) | 68,078 |
| usedAt 8-pack — later write in same slot (warm) | 33,680 (saving 34,398) |

Contract size: Ticket runtime 30,771 B / initcode 32,106 B (Monad limit 131,072 B; margin ~100k /
~99k). No library extraction needed.

## 11. Not in this batch (follow-up)

- **Paymaster sponsorship allowlist** still seeds the pre-relay selectors (`claim`, `checkIn`,
  `checkInLate`, `requestClaim` strings) in `MontiPaymaster._seedSelectors` and
  `DeployTicket.installApprovalSelectors`. Relayed actions are EOA txs, so how (and whether) 4337
  sponsorship covers them is a design decision left to a dedicated paymaster batch. Tests reference
  these selectors by string literal so they compile and the allowlist assertions still hold.
- `rotateAccount` does not register a device key for the new account; relayed `claimFor` verifies a
  device sig, so a rotated-to account must first `Identity.setActiveDevice(...)` (models "new passkey
  registered"). Tests do this via `_giveDeviceKey`.
