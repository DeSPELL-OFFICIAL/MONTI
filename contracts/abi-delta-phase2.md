# ABI delta — phase 2 (relayed: ERC-2771 forwarder, retire 4337)

Branch `mvp-01b`. This is the interface contract for shared/backend/web against the phase-2 stack:
a P-256 device-key **ERC-2771 forwarder** (`MontiForwarder`) replaces the ERC-4337 paymaster + Coinbase
smart-wallet pre-deploy. High-frequency claim/check-in stay on their own dual-signature path (unchanged);
the forwarder carries the remaining sponsored organizer/attendee actions. Pin every string, type order and
selector below verbatim — the client `signWithDeviceKey` (raw 32-byte digest, r‖s 64 bytes) is reused as is.

## 1. MontiForwarder interface

Contract `contracts/src/MontiForwarder.sol`. ABI: `packages/shared/src/abi/MontiForwarder.json` (18 entries).

### Request struct

```solidity
struct ForwardRequest {
    address from;      // actor (attendee/organizer smart account) — an Identity member with an active device key
    address to;        // target: ticket | organizers | identity (allowlist)
    uint256 nonce;     // == nonces(from); replay counter
    uint64  deadline;  // block.timestamp <= deadline
    bytes   data;      // target calldata (WITHOUT the from suffix — execute appends it)
}
```

### Digest (exact — do not reorder)

```
FORWARD_TAG = keccak256("MONTI:FORWARD:v1")   // bytes32, 32-byte purpose tag, leads the preimage

forwardDigest(req) = sha256(abi.encode(
    FORWARD_TAG,            // bytes32
    block.chainid,          // uint256
    address(this),          // address  (the forwarder)
    req.from,               // address
    req.to,                 // address
    req.nonce,              // uint256
    req.deadline,           // uint64
    keccak256(req.data)     // bytes32
))
```

`sha256` (not keccak) + the leading tag mirror phase-1 `claimAuthDigest`, so the same device-key signer is
reused with no change. chainid + `address(this)` + `keccak256(data)` bind the signature to this chain, this
forwarder and this exact call — no cross-chain / cross-forwarder / cross-call reuse.

### Functions (selectors via `cast sig` / artifact `methodIdentifiers`)

| Selector | Signature | Notes |
|---|---|---|
| `0x65ae10bc` | `execute((address,address,uint256,uint64,bytes),bytes)` | permissionless relay; 2nd arg = device sig r‖s (64 B); returns target return data |
| `0x7cb60f91` | `forwardDigest((address,address,uint256,uint64,bytes))` | view; client cross-checks its own digest |
| `0x7ecebe00` | `nonces(address)` | **per-`from` single counter** — read for the next request's `nonce` |
| `0xe1aa84f7` | `setTargets(address,address)` | deployer-only, once (`ticket_, organizers_`) |
| `0x2c159a1a` | `identity()` | immutable |
| `0x6cc25db7` | `ticket()` | set by `setTargets` |
| `0x35ac6ec6` | `organizers()` | set by `setTargets` |
| `0xd5f39488` | `deployer()` | immutable; may call `setTargets` once |

`execute` check order: `TargetNotAllowed` → `Expired` → `BadNonce` → `NotMember` → `DeviceLocked` →
`BadDeviceSignature`. Then `nonces[from] += 1` (CEI, before the call), `to.call(data ‖ from)` (ERC-2771
sender suffix), verbatim revert bubbling on failure, `emit Forwarded`.

### Event

```solidity
event Forwarded(address indexed from, address indexed to, uint256 nonce, bytes4 selector);
```

### Errors

`NotDeployer()` · `AlreadyWired()` · `Expired()` · `TargetNotAllowed()` · `BadNonce()` · `NotMember()` ·
`DeviceLocked()` · `BadDeviceSignature()`.

`deviceSig` is exactly 64 bytes: `abi.encode(bytes32 r, bytes32 s)` (low-s normalised), same as phase-1.

## 2. Relayed actions — kind → target → signature → selector

`from` is the acting device-key member; `to` is the allowlisted target; `data = abi.encodeWithSelector(sel, …)`
(the forwarder appends `from`). Targets swapped `msg.sender → _msgSender()` in phase 2 (ERC-2771 context).

| Kind | Target | Function signature | Selector |
|---|---|---|---|
| organizer / create | organizers | `createOrganizer(address)` | `0x49cd9846` |
| organizer / team | organizers | `transferOwner(uint256,address)` | `0x1ebe85ba` |
| organizer / team | organizers | `setAdmin(uint256,address,uint32)` | `0x7bf24b9a` |
| organizer / team | organizers | `setManager(uint256,address,bool,bool)` | `0x79ef4eff` |
| gate | organizers | `registerGate(uint256,address,bytes32,bytes32)` | `0x3e93259c` |
| gate | organizers | `openGate(uint256)` | `0x396d45c4` |
| gate | organizers | `closeGate(uint256)` | `0x6eac22c3` |
| gate | organizers | `revokeGate(uint256)` | `0x761227ea` |
| event / lifecycle | ticket | `createEvent((uint256,bytes32,bytes32,string,uint64,uint64,bytes32,uint64,uint64,bool,uint32,uint8,bool,uint8,bytes32,bool),(string,uint256,uint32,uint32,uint16,bool)[])` | `0x3e29e118` |
| event / lifecycle | ticket | `publishEvent(uint256)` | `0xcfd9f3da` |
| event / lifecycle | ticket | `cancelEvent(uint256)` | `0x3f69babd` |
| event / lifecycle | ticket | `updateEventMeta(uint256,(…EventMeta…),(…Tier…)[])` | `0x3b671ffa` |
| approval | ticket | `approveClaims(uint256,uint256[])` | `0x0b177ad6` |
| approval | ticket | `rejectClaims(uint256,uint256[])` | `0x2c261b04` |
| attendee / request | ticket | `cancelRequest(uint256,uint256)` | `0xd586d2e4` |
| attendee / transfer | ticket | `createOffer(uint256,bytes32,uint64)` | `0xb9d92e7f` |
| attendee / transfer | ticket | `cancelOffer(uint256)` | `0xef706adf` |
| attendee / transfer | ticket | `acceptOffer(uint256,bytes)` | `0x8f7150d0` |
| attendee / transfer | ticket | `migrate(uint256)` | `0x454b0608` |
| override | ticket | `requestOverride(uint256,uint256,uint8)` | `0xba9479cc` |
| override | ticket | `manualOverride(uint256,uint256,uint8)` | `0xb8c563eb` |
| ticket / revoke | ticket | `revoke(uint256,uint8)` | `0x14f6b1fb` |
| identity | identity | `setNickname(bytes32,string)` | `0x38ce6ad7` |
| identity | identity | `setActiveDevice(bytes32,bytes32)` | `0xe8bffdb3` |
| identity | identity | `cancelRotation()` | `0xc64bf27a` |
| identity | identity | `lockDevice(address)` (account branch) | `0xff5b0572` |

**Not relayed (own path, unchanged):** `claimFor` / `requestClaimFor` / `checkInFor` / `checkInForLate`
(permissionless, dual-signature, (eventId,account) nonce) and deployer/attester-only calls
(`Organizers.setTicket`, `Identity.register/rotateAccount/setKycLevel`, `Identity.lockDevice` attester branch).

## 3. Removed (retire 4337)

- **Contract:** `src/MontiPaymaster.sol`.
- **Scripts:** `script/DeployCoinbaseFactory.s.sol`, `script/DeployTicket.s.sol` (01c partial redeploy is
  unwireable under the once-only forwarder wiring — full fresh redeploy instead).
- **Tests:** `test/Paymaster.t.sol`, `test/PaymasterStake.t.sol`, `test/DeployCoinbaseFactory.t.sol`,
  `test/DeployTicket.t.sol`, `test/mocks/MockEntryPoint.sol`,
  `test/shims/openzeppelin-v4/security/ReentrancyGuard.sol`.
- **ABIs:** `packages/shared/src/abi/MontiPaymaster.json`, `packages/shared/src/abi/CoinbaseSmartWalletFactory.json`.
- **deployments JSON keys:** `paymaster`, `entryPoint`, `coinbaseFactory` (dropped).
- **Config:** `remappings.txt` reduced to `forge-std / @openzeppelin/contracts / solady`; the
  account-abstraction + smart-wallet contexts are gone. `export-abi.sh` now exports
  `Identity Organizers Ticket MontiForwarder`.

No event / storage-layout change on the targets — indexers/Envio schema unaffected. Identity only gains
`_forwarder` storage + `setForwarder`/`trustedForwarder`; Organizers/Ticket only gain a forwarder ctor arg.

## 4. Deploy order + one-shot wiring

`identity.deployer()` is passed as the forwarder's `deployer_`, so the same sender that built the stack can
call the once-only `setTargets` under both broadcast and a direct test call.

```solidity
identity   = new Identity(attester);
forwarder  = new MontiForwarder(IIdentity(address(identity)), identity.deployer());
organizers = new Organizers(address(forwarder));                       // forwarder is a ctor immutable
ticket     = new Ticket(address(identity), address(organizers), address(forwarder)); // ctor immutable
identity.setForwarder(address(forwarder));   // once-only (deployer): Identity learns the forwarder
forwarder.setTargets(address(ticket), address(organizers)); // once-only (deployer): allowlist {identity,ticket,organizers}
organizers.setTicket(address(ticket));       // once-only (deployer)
```

Forwarder is deployed **after** Identity (it reads Identity) and **before** Organizers/Ticket (they take it as
a ctor immutable), so its targets can't be immutables — hence the once-only `setTargets`. Identity is deployed
before the forwarder, so it can't bind it as an immutable either — hence `setForwarder` + a `trustedForwarder()`
override reading one-shot storage.

## 5. deployments/&lt;chainid&gt;.json keys

`Deploy.s.sol` writes 7 keys (alphabetised by `vm.writeJson`):
`attester`, `block`, `chainId`, `forwarder`, `identity`, `organizers`, `ticket`.
Env inputs: `DEPLOYER_PK`, `ATTESTER_ADDRESS` (RPC is a `--rpc-url` flag).

## 6. Gas — forwarder vs direct (precompile-normalised)

**Measured** `test/ForwardGas.t.sol` (25 tests), local `evm_version = "osaka"`. The osaka EVM has a **genuine**
EIP-7951 P256VERIFY precompile at `0x100` (~6,900 gas/verify; measured **7,234** including the solady wrapper) —
there is **no** ~100–330k Solidity fallback (`test_p256Baseline` asserts a live verify < 10k). `execute` does
**exactly one** verify, so the Monad-equivalent column subtracts the per-verify chain delta once:
**`monad-eq = local − (6,900 − 3,450 RIP-7212) = local − 3,450`**. The solady wrapper (~300) is chain-independent
and not subtracted. Direct calls do no P-256 verify (they are authorised by `_msgSender()`), so they are not
normalised; `acceptOffer`'s attester `ecrecover` is secp256k1 (`0x01`, 3,000) — identical on both chains.

| Action | Target | Direct (local) | Fwd (local) | Fwd overhead | **Fwd Monad-eq (−3,450)** |
|---|---|---:|---:|---:|---:|
| createOrganizer | organizers | 32,224 | 89,483 | 57,259 | **86,033** |
| createEvent | ticket | 275,257 | 331,318 | 56,061 | **327,868** |
| publishEvent | ticket | 35,215 | 90,446 | 55,231 | **86,996** |
| registerGate | organizers | 134,501 | 192,106 | 57,605 | **188,656** |
| openGate | organizers | 41,007 | 98,555 | 57,548 | **95,105** |
| approveClaims(1) | ticket | 82,083 | 135,163 | 53,080 | **131,713** |
| approveClaims(5) | ticket | 242,867 | 297,225 | 54,358 | **293,775** |
| approveClaims(10) | ticket | 443,851 | 499,803 | 55,952 | **496,353** |
| createOffer | ticket | 86,508 | 142,370 | 55,862 | **138,920** |
| acceptOffer | ticket | 161,754 | 209,172 | 47,418 | **205,722** |
| cancelRequest | ticket | 28,999 | 84,242 | 55,243 | **80,792** |
| setNickname | identity | 59,180 | 111,998 | 52,818 | **108,548** |

Forwarder overhead is a stable **~53–58k** (verify 6,900 + `nonces` SLOAD/SSTORE + 3 Identity reads
`isMember`/`isLocked`/`activeDevice` + the `data‖from` call hop + `Forwarded` event). approveClaims is linear:
~54k marginal per approved request on top of the fixed forwarder + event cost. These are execution-gas figures
(`gasleft()` deltas); Monad charges the gas **limit**, so the relayer budget per action should sit above the
Monad-eq column with headroom.

## 7. Notes for backend and web

**Backend (shared):**
- `packages/shared/src/abi.ts` — remove `montiPaymasterAbi` + `coinbaseFactoryAbi` (their JSONs are deleted);
  add `import montiForwarderAbiJson from './abi/MontiForwarder.json'` and
  `export const forwarderAbi = montiForwarderAbiJson as Abi`. (i.e. the `forwarderAbi.ts` swap.)
- Backend that builds/relays requests: read `nonces(from)` for the next `nonce`, build `ForwardRequest`,
  compute/verify `forwardDigest`, have the device sign the raw 32-byte digest → 64-byte r‖s, submit via
  any relayer EOA (`execute` is permissionless). Drop all paymaster/bundler/EntryPoint code and the
  `coinbaseFactory` env; if off-chain account derivation is still wanted, carry the factory address as a
  static config value (it is no longer on chain or in the deployments JSON).

**Web (`apps/web`):**
- `buildForwardRequest` target resolution: map each relayed action to its target from §2
  (organizers → `createOrganizer/transferOwner/setAdmin/setManager/registerGate/openGate/closeGate/revokeGate`;
  ticket → event lifecycle / approvals / offers / overrides / migrate / revoke; identity → nickname / device).
- Env: replace `VITE_ADDR_PAYMASTER` with **`VITE_ADDR_FORWARDER`** in `apps/web/.env.example` and
  `apps/web/src/shared/config.ts` (and its test doubles); the forwarder address comes from the deployments
  JSON `forwarder` key.
