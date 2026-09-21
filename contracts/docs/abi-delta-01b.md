# 01b redeploy bundle — ABI and behaviour delta

The hand-off from the contracts branch (`mvp-01b`) to the three consumer branches. Everything here
moved between **`c5bc4e4`** — the tree the live deployment `b68a686` was built from, still what `mvp`
carries — and the head of this branch. **Nothing below is deployed yet**: Task 15 redeploys the four
contracts and re-seeds, and only then does `mvp` move.

Read it as three things in order: what changed in the ABI (§1–§4), what changed **without** changing
the ABI (§5–§6), and what each consumer branch has to do about it (§8).

**Regenerating this by hand:**

```bash
git diff c5bc4e4 -- packages/shared/src/abi          # the machine-checkable half
cast sig  'checkInLate(uint256,(uint256,uint256,uint64,bytes32),bytes)'
cast keccak 'CheckedInLate(uint256,uint256,uint64,uint64)'
```

Every selector and topic0 in this document was re-derived that way from the committed export, not
copied out of a report.

---

## 1. `Identity` — 41 → 47 entries

Pure additions. Nothing was removed or re-typed.

| Kind | Signature | Selector / topic0 | What it is |
|---|---|---|---|
| function | `cancelRotation()` | `0xc64bf27a` | The account a rotation pushed aside undoes it, within the window. Callable only by `rotatedFrom(personId)`. Sponsored by the paymaster (§3) |
| function | `rotatedAt(bytes32)` → `uint64` | `0x923216fc` | When the person's account last moved. **`register` stamps it too**, so it is not on its own a "there is a rotation to undo" flag — pair it with `rotatedFrom` |
| function | `rotatedFrom(bytes32)` → `address` | `0xea381443` | The account that was pushed aside, or `0` once the window closed or the undo happened. This is the flag |
| function | `ROTATION_UNDO_WINDOW()` → `uint256` | `0x2e8be7d1` | `86400` (1 day). Equal to `Ticket.MIGRATE_DELAY` by construction — a test asserts it |
| event | `RotationCancelled(bytes32 indexed personId, address indexed account)` | `0x005278b10e944aba402cf70cce776a5b96a9aea1bae0d9c35771d37fe1e01ede` | The undo landed; `account` is the restored one |
| error | `NoRotationToCancel()` | `0xb9217881` | No rotation on that person, or the 24 h window has closed |

"Can I undo right now?" is, for the account asking:

```
rotatedFrom(personId) == myAddress && block.timestamp < rotatedAt(personId) + 86400
```

## 2. `Ticket` — 105 → 116 entries

| Kind | Signature | Selector / topic0 | What it is |
|---|---|---|---|
| function | `checkInLate(uint256,(uint256,uint256,uint64,bytes32),bytes)` | `0x47a7fad1` | The offline queue's flush path. Same arguments as `checkIn`, same **12** revert reasons, and it accepts a code issued up to `LATE_WINDOW` before doors and submitted up to `LATE_WINDOW` after the event ended |
| function | `LATE_WINDOW()` → `uint256` | `0x4d9fef3e` | `43200` (12 h). Both the lower bound on the code and the upper bound on the submission |
| function | `MIGRATE_DELAY()` → `uint256` | `0x098d32e6` | `86400` (1 day). How long a ticket waits before it follows a rotated account |
| function | `offerDigest(uint256,bytes32,address)` → `bytes32` | `0x50ba8511` | The EIP-712 digest the attester signs for `acceptOffer` (§7.1) |
| function | `eip712Domain()` → ERC-5267 tuple | `0x84b0196e` | `("MONTI Ticket", "1", chainid, address(this))` |
| function | `deviceDigest(uint256,uint256,uint256,bytes32,uint64)` → `bytes32` | `0x7c23b77a` | **The parity target.** The exact bytes the attendee phone must sign (§7.2). `chainid` and the Ticket address are filled in by the contract, not passed |
| function | `checkInOf(uint256)` | `0xdb7b7d7e` | Selector unchanged, **return tuple changed twice** — see §5 |
| event | `CheckedInLate(uint256 indexed tokenId, uint256 indexed gateId, uint64 issuedAt, uint64 ts)` | `0xad3c23d74f79b6306db7acb45e49e960632c823ee84714ce5616a798913fb782` | Emitted **in addition to** `CheckedIn` on the late path. Counting admissions still means counting `CheckedIn` alone |
| event | `EIP712DomainChanged()` | `0x0a6387c9ea3628b88a633bb4f3b151770f70085117a15f9bf3787cda53f13d31` | ERC-5267 boilerplate; never emitted by us |
| error | `RotationPending()` | `0x31fb4801` | `migrate` inside the timelock, **and** the new-account quarantine on `_update` (§6) |
| error | `InvalidShortString()` | `0xb3512b0c` | OpenZeppelin `ShortStrings`; unreachable with our domain |
| error | `StringTooLong(string)` | `0x305a27a9` | Same |

Unchanged and worth stating because they look like they should have moved:
`checkIn(uint256,(uint256,uint256,uint64,bytes32),bytes)` is still `0x7e0c0c2c`,
`acceptOffer(uint256,bytes)` is still `0x8f7150d0`, and
`CheckedIn(uint256,uint256,uint256,bytes32,uint64)` is still
`0x31153c5749598c1f2cae42f39536cc5f39abb9ffc68e311b92c6a9bc0a5d438b`.
Both of those functions changed **meaning** (§6, §7) without changing shape.

## 3. `MontiPaymaster` — 42 → 45 entries

| Kind | Signature | Selector / topic0 | What it is |
|---|---|---|---|
| function | `setAllowed(bytes4,uint8,uint8)` | `0x4343c290` | Deployer-only kill switch **per selector**: `(selector, ArgKind, argWord)`. `ArgKind` is `uint8` on the wire: `0 = None, 1 = Platform, 2 = EventId, 3 = TokenId, 4 = OrgId` (`MontiPaymaster.ArgKind` in `src/MontiPaymaster.sol` is the source of truth). `0` is not a kind but a removal: it deletes the selector and its word together, so a later re-allow cannot inherit a stale word. The six rows below are therefore `3, 3, 1, 1, 4, 1` on the wire, which is what `argKindOf(bytes4)` returns. Reverts `Unauthorized` for anyone else |
| function | `argWordOf(bytes4)` → `uint8` | `0x3a3d7a3d` | Which calldata word the id is read from |
| event | `SelectorAllowed(bytes4 indexed selector, uint8 kind, uint8 word)` | `0xa18b45dfce741880437353feb0dcb69330ea4783821a3a3c16cb9edfae4b9e76` | Emitted by the constructor for each seeded row and by every `setAllowed` |

The **targets** (Ticket, Identity, Organizers) are still immutable constructor arguments; only the
selector table moves. Six selectors were added to the constructor's seed:

| Selector | `ArgKind` | Why |
|---|---|---|
| `Ticket.checkInLate` | TokenId | the offline flush is sponsored like the online tap |
| `Ticket.revoke` | TokenId | organizers revoke without holding gas |
| `Organizers.revokeGate` | Platform | a lost staff device is disabled without gas |
| `Organizers.createOrganizer` | Platform | onboarding an organizer |
| `Organizers.transferOwner` | OrgId | billed to the organizer being handed over |
| `Identity.cancelRotation()` | Platform | **the undo has to work from an account with a zero balance** — that is the whole point of C3 |

## 4. `Organizers` (43) and `CoinbaseSmartWalletFactory` (8) — unchanged

Byte-identical exports. `Organizers` changed behaviour twice all the same (§6).

---

## 5. `checkInOf` — same selector, a different tuple, twice

This is the one change in the bundle that **cannot** show up as a compile error anywhere.

```
c5bc4e4      (uint256 gateId, uint64 ts, bytes32 nonceHash, bool manual)
Task 8       (uint256 gateId, uint64 ts, bytes32 nonceHash, bool manual, bool late)
HEAD (E)     (uint256 gateId, bytes32 nonceHash, uint64 ts, bool manual, bool late)
```

The final order is `gateId, nonceHash, ts, manual, late`. `nonceHash` moved **in front of** `ts` so
that `ts + manual + late` share one storage slot; that is what took `checkInLate` from 154,407 to
132,607 gas. Solidity reads the struct by field name and never noticed; viem and Envio decode
positionally and will silently mis-read if they are handed the old ABI.

- Anything that decodes through the committed `packages/shared/src/abi/Ticket.json` is correct for
  free — take the snapshot.
- Anything that destructures the tuple by position **by hand** must be edited. Grep for `checkInOf`
  on every consumer branch.

---

## 6. Behaviour deltas with no ABI signal

Same selectors, same shapes, new outcomes. These are the ones that only show up as a revert on a real
device.

| Path | What is new | Error |
|---|---|---|
| `Ticket.checkIn` | the holder must still be a **member**; a rotation pushes the old account out | `NotMember()` |
| `Ticket.checkIn` / `checkInLate` | the device signature is now over a **7-word, domain-separated** digest (§7.2). Old signatures fail here | `BadDeviceSignature()` |
| `Ticket.transferFrom` / `safeTransferFrom` / `acceptOffer` | the **recipient** is refused if their device is locked (the freeze is bidirectional now) | `DeviceLocked()` |
| `Ticket.transferFrom` / `safeTransferFrom` / `acceptOffer` | a **Cancelled** event's ticket no longer moves. Ended is *not* Cancelled — the transfer cutoff still governs that | `EventCancelled()` |
| `Ticket._update` (mint **and** transfer) | **rotation quarantine**: while `rotatedFrom(personOf(to)) != 0` and the undo window is open, `to` receives nothing. `migrate` is exempt (it already waits the same 24 h) | `RotationPending()` |
| `Ticket.migrate` | refuses inside `rotatedAt + MIGRATE_DELAY` | `RotationPending()` |
| `Ticket.requestOverride` | now checks the event status the way `manualOverride` always did | `EventEnded()` / `EventCancelled()` |
| `Ticket.acceptOffer` | the attester signature is over the **EIP-712** digest (§7.1). Every signature made against the old deployment is dead | `BadAttesterSig()` |
| `Identity.rotateAccount` | additionally emits `DeviceLocked(oldAccount, true)` right after `AccountRotated` — unless that account was already locked, in which case no second event |  |
| `Organizers.registerGate` | a **half-zero** P-256 key is refused (was: only both-zero) | `InvalidGateKey()` |
| `Organizers.revokeGate` | clears `gateOf(account)`, so the same account can be registered again under a fresh `gateId` | |

Two product consequences that belong on a screen, not in a mapping:

1. **A genuine recovery receives nothing for 24 h.** The quarantine applies to honest rotations as
   well as stolen ones. The recovery screen has to say so.
2. **`cancelRotation` deliberately does not clear the lock**, and `setActiveDevice` carries a 7-day
   cooldown. A user who is rotated away and undoes it within their first week can end up locked for
   the remainder of that cooldown. Show `deviceUpdatedAt + 7 days`.

---

## 7. The two pinned vectors

Both name the same imaginary deployment — chain `31337`, Ticket `0x7111…1111` — so the two halves of
a client can be tested against one fixture.

### 7.1 Offer digest — EIP-712, `Ticket.offerDigest`

```
domain    name "MONTI Ticket", version "1", chainId, verifyingContract = the Ticket
type      TransferApproval(uint256 tokenId,bytes32 recipientCommitment,address recipient)
```

| Input | Value |
|---|---|
| chainId | `31337` |
| verifyingContract | `0x7111111111111111111111111111111111111111` |
| tokenId | `7` |
| recipientCommitment | `0x1111111111111111111111111111111111111111111111111111111111111111` |
| recipient | `0x0000000000000000000000000000000000000001` |
| **digest** | **`0x7171ab3831d8e0d4a58ce6d8076a10c080c5a97849229aecf84c801dcafbc88d`** |

On-chain this is asserted by `test/TicketOffer.t.sol::test_theFixedVectorSharedWithTheTypescriptHalf`.
The TypeScript half is **not on this branch** (see the commit that dropped the temporary
`@monti/shared`); it is reproduced here verbatim so each consumer branch can paste the function —
**the function only**, into its existing `packages/shared/src/encoding.ts`, which also holds the CBOR,
QR and DER encoders. Do not overwrite that file.

```ts
import { hashTypedData } from 'viem';
import type { Hex } from './types.js';

function assertBytes32(value: Hex, label: string): void {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error(label);
}

/**
 * 어테스터가 acceptOffer 용으로 서명하는 다이제스트.
 * EIP-712 다. 도메인이 chainId 와 Ticket 주소를 묶으므로, 테스트넷 서명은 메인넷에서,
 * 옛 배포본의 서명은 새 배포본에서 쓸 수 없다. Ticket.offerDigest(...) 와 같은 값이어야 한다.
 */
export function offerDigest(input: {
  chainId: number;
  ticket: Hex;
  tokenId: bigint;
  recipientCommitment: Hex;
  recipientAccount: Hex;
}): Hex {
  assertBytes32(input.recipientCommitment, 'BAD_COMMITMENT');
  if (!/^0x[0-9a-fA-F]{40}$/.test(input.recipientAccount)) throw new Error('BAD_ACCOUNT');
  if (!/^0x[0-9a-fA-F]{40}$/.test(input.ticket)) throw new Error('BAD_TICKET');
  return hashTypedData({
    domain: {
      name: 'MONTI Ticket',
      version: '1',
      chainId: input.chainId,
      verifyingContract: input.ticket,
    },
    types: {
      TransferApproval: [
        { name: 'tokenId', type: 'uint256' },
        { name: 'recipientCommitment', type: 'bytes32' },
        { name: 'recipient', type: 'address' },
      ],
    },
    primaryType: 'TransferApproval',
    message: {
      tokenId: input.tokenId,
      recipientCommitment: input.recipientCommitment,
      recipient: input.recipientAccount,
    },
  });
}
```

**The digest this replaces is the raw keccak one, and its vector
`0x90244cd7dea2e76fcbe10bb1f52ca2fe9bf143d9f9943bc8f792e664d052ed0a` must be deleted, not kept
alongside.** Two digests in one repo is how a signature gets made against the wrong one.

### 7.2 Device digest — `Ticket.deviceDigest`

```
sha256(abi.encode(
    uint256  block.chainid,
    address  address(this),   // this Ticket
    uint256  tokenId,
    uint256  gateId,
    uint256  eventId,
    bytes32  nonce,
    uint64   issuedAt))
```

Seven words, **224 bytes**; `address` and `uint64` are left-zero-padded to 32. The first two words are
new — the old digest was the five fields from `tokenId` onward and said nothing about which chain or
which deployment it belonged to. That was survivable at a 60-second code lifetime and is not at
`checkInLate`'s event-span + 12 h.

| Input | Value |
|---|---|
| chainId | `31337` |
| Ticket | `0x7111111111111111111111111111111111111111` |
| tokenId | `7` |
| gateId | `3` |
| eventId | `11` |
| nonce | `0x1111111111111111111111111111111111111111111111111111111111111111` |
| issuedAt | `1789862400` |
| **digest** | **`0xca378ab2af0962bff66d23c4ebb20198fb1a80fe94957e6520368bacae1ffe66`** |
| (the old 5-field value, now dead) | `0xc99dfaef599235b36414480bc53054182d5f7fc67a33c60233f3f73f7fc560c7` |
| r (P256Vectors.DEVICE key) | `0x05e3300c3c562e464cd027f1c265309f2bfbd7f524eb9d1fe0d7eb4a9f43961e` |
| s | `0x155e84de23d6b7220abf334701e9a5c3e607f41992e67c8a9932d1dc0096d786` |

`s` is low-`s`; the contract rejects the malleable twin, and so should any client-side check.

**`deviceDigest(...)` is a public view — call it.** A consumer's own implementation is only trustworthy
once one vector has been asserted against the deployed contract's answer, because the two inputs the
client cannot choose (`chainid`, the Ticket address) are exactly the ones a local re-implementation
gets wrong.

---

## 8. What each consumer branch has to do

### 02 · backend (`MONTI-backend`) — the canonical `packages/shared`

- [ ] Copy `Identity.json`, `Organizers.json`, `Ticket.json`, `MontiPaymaster.json` from this branch's
      `packages/shared/src/abi`. `CoinbaseSmartWalletFactory.json` did not change.
- [ ] `packages/shared/src/abi.test.ts` asserts sets with `arrayContaining`, so a missing name is
      invisible until runtime. Add: Ticket functions `checkInLate`, `offerDigest`, `eip712Domain`,
      `deviceDigest`, `LATE_WINDOW`, `MIGRATE_DELAY`; Ticket event `CheckedInLate`; Identity functions
      `cancelRotation`, `rotatedAt`, `rotatedFrom`, `ROTATION_UNDO_WINDOW`; Identity event
      `RotationCancelled`; MontiPaymaster functions `setAllowed`, `argWordOf`; MontiPaymaster event
      `SelectorAllowed`.
- [ ] `packages/shared/src/constants.ts`, under `CODE_WINDOW_SECONDS`:
      `LATE_WINDOW_SECONDS = 43_200` and `MIGRATE_DELAY_SECONDS = 86_400`.
- [ ] `packages/shared/src/encoding.ts` — replace the body of `offerDigest` with §7.1. Delete the raw
      keccak construction and, in `encoding.hash.test.ts`, the vector `0x90244cd7…ed0a`; assert
      `0x7171ab38…bc88d` instead.
- [ ] `packages/shared/src/encoding.ts` — **`deviceSigHash` moves to the seven-word form of §7.2.**
      It currently hashes five fields and `encoding.hash.test.ts:35` pins the dead value
      `0xc99dfaef…60c7`. Re-pin it to `0xca378ab2…fe66` with the §7.2 inputs, and grep
      `functions/src` and `packages/shared/src` for any other `deviceSig` helper before declaring it
      done — a second copy of the old formula is a silent DENY at the door.
- [ ] `functions/src/functions/transferInvites.ts` — `pendingOffers` signs `offerDigest(...)` at
      `:240`. It now needs `chainId` and the Ticket address in scope (they are in the deployment
      record). Same for `functions/test/transferInvites.test.ts`.
- [ ] Indexer handlers: `CheckedInLate` sets `CheckIn.late = true` on the row `CheckedIn` created in
      the same transaction — do not count it as a second admission. `RotationCancelled` reverses
      whatever `AccountRotated` wrote and clears the pending-rotation flag.
- [ ] Any `checkInOf` destructuring moves to the §5 order. **The tuple's shape is the one change here
      that no compiler will catch.**

### 03 · web (`MONTI-web`)

- [ ] Same ABI copy, same `abi.test.ts` and `constants.ts` edits as 02.
- [ ] `apps/web/src/shared/chain/reads.ts` — `CHECK_IN_FIELDS` is
      `['gateId', 'ts', 'nonceHash', 'manual']`. It becomes
      `['gateId', 'nonceHash', 'ts', 'manual', 'late']` (§5), and `CheckInStruct` gains `late: boolean`.
      The same file's `STRUCT_SHAPES` pins every struct's component names **and order** against the ABI;
      its `Ticket.checkInOf` row moves with `CHECK_IN_FIELDS` or the pin fails.
- [ ] `apps/web/src/shared/chain/abis.test.ts` — the `USED_ABI` conformance test, and the one that
      reads `STRUCT_SHAPES`. It is the only thing between this branch and a silently mis-decoded
      `checkInOf`, so it has to list the new views (`deviceDigest`, `offerDigest`, `eip712Domain`,
      `LATE_WINDOW`, `MIGRATE_DELAY`, the three rotation views) and the new events.
- [ ] `apps/web/src/shared/chain/abis.ts` — `USED_ABI.Ticket` needs whatever this branch now reads
      (`deviceDigest: 5` for the parity check below; `offerDigest: 3` if the app ever previews one),
      and the events it decodes must include **both** `CheckedIn` and `CheckedInLate`.
- [ ] `deviceSigDigest` (or whatever the attendee-side helper is called) moves to the 7-field form of
      §7.2, and **one test pins it against the deployed `deviceDigest(...)` view.** That view is the
      parity target; a hand-rolled sha256 that omits `chainid` or the Ticket address passes every
      local test and fails at the door.
- [ ] Revert mapping on the receiving side: `RotationPending` ("your new account can take tickets from
      <time>") and `DeviceLocked` ("unlock this device first" — this now fires on **accepting** an
      offer, not just on sending).
- [ ] `readIdentity()` gains the rotation views: `rotatedAt`, `rotatedFrom`, `ROTATION_UNDO_WINDOW`,
      and the recovery screen computes the undo window from them (§1) while showing the 24 h wait and
      the `deviceUpdatedAt + 7 days` unlock (§6).

### 04 · staff (`MONTI-staff`)

- [ ] Same ABI copy, same `abi.test.ts` and `constants.ts` edits as 02 — `MONTI-staff` is a full peer
      of `MONTI-web`, not a subset.
- [ ] `checkInLate` is the operation the offline queue flushes to **after** the 12 h window, with the
      same arguments as `checkIn`. The wire carries the signature only, so there is no digest code to
      move here — but the **code itself** is now valid from `startsAt - 12 h` and submittable until
      `endsAt + 12 h`, which is what makes the queue land at all.
- [ ] UserOp gas fields start from the measured numbers, not from the old ones:
      `checkIn` **123,800**, `checkInLate` **132,607**, both against a 200,000 call budget.
      The two paths differ by ~8.8 k (`gateInfo` over `isOpenGate`, plus one extra log).
- [ ] **The 12 check-in errors are unchanged.** `checkInLate` reverts with exactly the same set as
      `checkIn`: `NoSuchTicket, WrongEvent, EventCancelled, EventEnded, TicketRevoked,
      AlreadyCheckedIn, GateNotOpen, GateMismatch, CodeExpired, NotMember, DeviceLocked,
      BadDeviceSignature`. The frozen DENY table does not move.
- [ ] Pin one vector against the deployed `deviceDigest(...)` view anyway, if the staff device ever
      recomputes a digest to compare — same reasoning as 03.

---

## 9. What the redeploy invalidates

`Ticket` is past EIP-170 (26,351 B runtime / 27,665 B initcode) and is a **Monad-only** contract from
this bundle on; `test/ContractSize.t.sol` holds the real 128 KB limit.

Every signature made against the current deployment dies with it:

- attester signatures for `acceptOffer` — the domain now binds chainId and the Ticket address;
- device signatures for `checkIn`/`checkInLate` — two new words in the digest;
- gate registrations — a gate account can be registered once, so re-seeding needs the real staff
  device account and its real P-256 key (`SEED_GATE_KX` / `SEED_GATE_KY`).

None of these has a production caller today. That is the premise the bundle was written on, and Task
15 is where it stops being true.
