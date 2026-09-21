# MONTI Implementation Plan · 00 Master (마스터 계획)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This master plan defines shared interfaces and ordering; the four sub-plans (01–04) contain the bite-sized TDD tasks. Read this file first, then the sub-plan you are assigned.

**Goal:** Ship the MONTI hackathon MVP by 2026-10-12: a web app (Capacitor-wrapped) where a KYC-verified attendee arms a ticket with Face ID, taps an Android staff device over NFC, and the staff device writes the check-in to Monad, which is the sole authority for the ADMIT decision.

**Architecture:** Chain-first. Four Solidity contracts on Monad testnet (chain 10143) hold events, tickets, roles/allowlist, gates, check-ins and the gas budget. One React/TypeScript web codebase serves attendee, organizer and staff screens; Capacitor shells add NFC read/write, a passkey bridge, a hardware device key (attendee) and HCE emission plus write reception (staff Android). Firebase (Auth, Firestore, Storage, Functions, KMS) holds only encrypted PII and mappings. Envio indexes the chain for lists; Pimlico bundles ERC-4337 user operations; a platform-funded paymaster pays all gas.

**Tech Stack:** Solidity 0.8.31 (Foundry ≥ 1.8, `evm_version = "osaka"`), Coinbase Smart Wallet contracts (MIT, EntryPoint v0.6), Solady `P256`/`WebAuthn`, viem + ox, React 19 + Vite + TypeScript, Capacitor 8 (`@capgo/capacitor-nfc`, `@capgo/capacitor-passkey`, `@perfood/capacitor-crypto-api` or own plugin), Kotlin `HostApduService` plugin, Firebase (Auth phone, Firestore, Storage, Cloud Functions v2 Node 22, Cloud KMS), Didit RN/web hosted link, Envio HyperIndex, Pimlico bundler, Tenderly (RPC, simulation, alerts).

**Spec:** `docs/superpowers/specs/2026-09-20-monti-nfc-ticketing-design.md` (v2.3, 확정). Every task argues from the spec; executors read both.

## Global Constraints

Copied from the spec. Every task in every sub-plan implicitly includes these.

- Monad testnet chain id **10143**, RPC `https://testnet-rpc.monad.xyz`; mainnet **143** is one env var away (`VITE_CHAIN_ID`, `CHAIN_ID`). Never hardcode a chain id in logic.
- **Gas is charged on `gas_limit`, not `gas_used`.** Every transaction and user operation sets an explicit limit = simulated estimate × 1.075 (Monad-recommended 7.5%); tests assert limits are set.
- P-256 precompile at `0x0000000000000000000000000000000000000100` (EIP-7951, 6,900 gas). Use Solady `P256.verifySignature` (precompile first, verifier fallback).
- EntryPoint **v0.6** `0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789` (Coinbase Smart Wallet v1). Bundler: Pimlico (`https://api.pimlico.io/v2/10143/rpc?apikey=…`).
- Contracts: Solidity **0.8.31**, `evm_version = "osaka"`, OpenZeppelin 5.x ERC-721, Solady for P-256/WebAuthn. Max runtime size 128 KB.
- **No crypto vocabulary in attendee-facing copy.** Banned strings (Korean and English, case-insensitive) in `apps/web/src/**/*.tsx` attendee routes: `지갑, NFT, 민팅, 가스, 체인, 토큰, 트랜잭션, wallet, NFT, mint, gas, chain, token, transaction, blockchain, Monad`. A lint script fails CI if any appears outside `organizer/` and `staff/` folders.
- **PII never on chain.** `personId` is `bytes32` **random** (`crypto.getRandomValues(32)`), not a hash of anything. Names, document data and photos are encrypted app-side with Cloud KMS before Firestore/Storage.
- **Chain values are never stored as authority in Firestore.** Firestore documents are keyed by on-chain ids (`personId`, account address, `tokenId`). Any cached chain value carries `block` and is rebuildable.
- Firebase region **asia-northeast3**. Firestore, Storage, Functions all in that region.
- HCE: AID **`D2760000850101`**, `CATEGORY_OTHER`, SELECT AID responds **`9000` with no FCI**, Type 4 Tag with CC file `E103`, NDEF file writable (`HCE_STATE_WRITE_FULL`), UPDATE BINARY accepted. **Reader mode is never enabled while HCE is active.**
- Gate code rotates every **3 s**; on-chain freshness window **60 s**; device-key arming window **60 s**.
- Device key: iOS Secure Enclave `kSecAttrTokenIDSecureEnclave` + `biometryCurrentSet`, authenticated `LAContext` retained for 60 s; Android `KeyGenParameterSpec` EC P-256, `setUserAuthenticationParameters(60, AUTH_BIOMETRIC_STRONG)`, `setIsStrongBoxBacked(true)` with fallback to TEE.
- Passkeys: RP ID = production domain (set once in `RP_ID`). AASA and `assetlinks.json` are published on day 0. Android WebAuthn origin `android:apk-key-hash:<hash>` is accepted by the server alongside `https://<RP_ID>`. **Never call `signalAllAcceptedCredentials`** (iOS 26 bug).
- Commit after every green test. Conventional commits (`feat:`, `test:`, `chore:`). Repository initialized in Task 0.1 below.

---

## Repository Layout (monorepo, pnpm workspaces)

```
MONTI/
  package.json                 pnpm workspaces: apps/*, packages/*, functions, indexer, plugins/*
  contracts/                   Foundry project (sub-plan 01)
    src/Identity.sol  src/Organizers.sol  src/Ticket.sol  src/MontiPaymaster.sol
    src/interfaces/  src/libs/  test/  script/Deploy.s.sol  script/Seed.s.sol
  packages/shared/             TypeScript types + ABIs + constants shared by web, functions, indexer (sub-plan 01 emits ABIs; 02 owns the package)
    src/abi/*.json  src/types.ts  src/constants.ts  src/encoding.ts  src/copy-lint.ts
  functions/                   Firebase Cloud Functions v2 (sub-plan 02)
  indexer/                     Envio HyperIndex (sub-plan 02)
  apps/web/                    React + Vite + TS, Capacitor project root (sub-plan 03 attendee/organizer/staff UI; sub-plan 04 staff native)
    src/attendee/  src/organizer/  src/staff/  src/shared/
    ios/  android/              Capacitor shells
  plugins/hce-android/         Capacitor plugin, Kotlin HostApduService (sub-plan 04)
  plugins/device-key/          Capacitor plugin, Swift + Kotlin P-256 biometric signing (sub-plan 03; used only if @perfood/capacitor-crypto-api fails S3)
  docs/superpowers/specs/      spec
  docs/superpowers/plans/      this file + 01..04
```

## Sub-plans and ordering

| Plan | File | Produces | Depends on |
|---|---|---|---|
| 01 Contracts | `2026-09-20-monti-01-contracts.md` | 4 contracts, tests, testnet deploy script, ABIs into `packages/shared/src/abi` | none |
| 02 Backend | `2026-09-20-monti-02-firebase-indexer.md` | Firebase project, Functions (signup, Didit webhook, attester, snapshot, Tenderly webhook, reconcile, daily export), Envio indexer, `packages/shared` | 01 ABIs and deployed addresses |
| 03 Web + attendee shell | `2026-09-20-monti-03-web-attendee.md` | Web app (attendee, organizer wizard, staff console UI), Capacitor iOS/Android attendee shells with NFC read/write, passkey bridge, device key, smart account, claim, transfer, arm-and-tap | 01 ABIs, 02 Functions |
| 04 Staff device | `2026-09-20-monti-04-staff-android.md` | HCE plugin, gate account, gate code emission, signature reception, `checkIn` user op, chain subscription verdict screen, snapshot, offline queue, QR fallback, override | 01, 02, 03 (staff console UI shell) |

Execution order for a team of 1–3: **01 → 02 and 03 in parallel → 04**. Day-0 spikes (S0–S6 in spec §16) are Task 0.x below and run before 01 finishes.

---

## Task 0: Repository and spikes (do first, 9/20–9/22)

### Task 0.1: Initialize monorepo

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `.gitignore`, `.nvmrc` (`22`), `README.md`

- [ ] **Step 1: Init git and workspace**

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI
git init -b main
printf 'node_modules\ndist\n.env*\n!.env.example\ncontracts/out\ncontracts/cache\ncontracts/broadcast\nios/App/Pods\nandroid/.gradle\nandroid/app/build\n.firebase\n' > .gitignore
echo 22 > .nvmrc
cat > pnpm-workspace.yaml <<'EOF'
packages:
  - apps/*
  - packages/*
  - functions
  - indexer
  - plugins/*
EOF
cat > package.json <<'EOF'
{ "name": "monti", "private": true, "packageManager": "pnpm@9",
  "scripts": { "lint:copy": "node packages/shared/dist/copy-lint.js apps/web/src/attendee" } }
EOF
git add -A && git commit -m "chore: init monorepo"
```

- [ ] **Step 2: Verify**

Run: `git log --oneline` → one commit. `pnpm -v` → 9.x.

### Task 0.2: Spike S0 — domain, AASA, assetlinks, Apple enrollment

**Files:** hosted at `https://<RP_ID>/.well-known/apple-app-site-association` and `/.well-known/assetlinks.json` (static hosting on Firebase Hosting; sub-plan 02 owns hosting config, but this spike publishes minimal files first).

- [ ] **Step 1:** Start Apple Developer Program enrollment (individual). Record Team ID in `docs/superpowers/plans/spikes.md`.
- [ ] **Step 2:** Publish AASA with `webcredentials` and `applinks` for bundle id `<TEAMID>.app.monti`, and `assetlinks.json` with `delegate_permission/common.get_login_creds` and `common.handle_all_urls` for package `app.monti` with the debug and release SHA-256 fingerprints.
- [ ] **Step 3:** Verify: `curl -s https://<RP_ID>/.well-known/apple-app-site-association | jq .webcredentials` returns the app id; Android `adb shell pm get-app-links app.monti` shows `verified` after install (may take up to 24 h).
- [ ] **Step 4:** Commit `apps/web/public/.well-known/*` with `chore(spike): publish AASA and assetlinks`.

### Task 0.3: Spike S1 — NFC read + write-back (iPhone ↔ Android HCE)

Go/No-Go for the whole gate design. Uses sub-plan 04 Task 1 (HCE plugin skeleton) and sub-plan 03 Task 9 (NFC wrapper) in throwaway form.

- [ ] **Step 1:** On the Android staff device run the HCE plugin demo emitting a static NDEF external record `monti.app:g` with 120 bytes payload, writable NDEF file.
- [ ] **Step 2:** On iPhone (Capacitor demo with `@capgo/capacitor-nfc`) read the record, then `write` a 130-byte external record `monti.app:s` in the same session. Repeat 20 times per iPhone model, staff screen ON.
- [ ] **Step 3:** Record success rate in `spikes.md`. **Go** if ≥ 90% read+write on ≥ 3 handsets. If write fails but read passes → set `GATE_RETURN_CHANNEL=qr` default in shared constants and keep NFC read. Note whether Apple Pay UI appeared.
- [ ] **Step 4:** Also test Android Chrome Web NFC (`NDEFReader.scan()` then `.write()`) against the same HCE device; record result (decides whether browser-only Android users get NFC).

### Task 0.4: Spike S2 — passkey user operation on Monad testnet

- [ ] **Step 1:** Deploy Coinbase Smart Wallet `CoinbaseSmartWalletFactory` to 10143 with the canonical CREATE2 deployer `0x4e59b44847b379578588920cA78FbF26c0B4956C` so the address matches mainnet (sub-plan 01 Task 31 has the script; run it early).
- [ ] **Step 2:** In a throwaway web page: `createWebAuthnCredential` → `toWebAuthnAccount` → `toCoinbaseSmartAccount({ owners: [webAuthnAccount] })` → `sendUserOperation` via Pimlico calling `Identity.register` **is not allowed** (attester only), so call a `Counter.increment()` test contract. Verify inclusion on MonadVision, and gas used for validation ≈ 25–35k (precompile path). Record `preVerificationGas`, `verificationGasLimit`, `callGasLimit`.
- [ ] **Step 3:** Repeat inside the Capacitor iOS shell with `@capgo/capacitor-passkey` and in Android shell; confirm Android `origin` is `android:apk-key-hash:…`. **Go** if both platforms produce a valid user op. If not within 2 days → switch sub-plan 03 to ZeroDev Kernel v3.3 (validator `0x7ab16Ff354AcB328452F1D445b3Ddee9a91e9e69`).

### Task 0.5: Spike S3 — device key

- [ ] **Step 1:** Using `@perfood/capacitor-crypto-api`: generate P-256 key with biometric requirement on iOS and Android; sign `sha256("monti-spike")`; verify signature with Solady `P256.verifySignature` in a Foundry test (paste x, y, r, s).
- [ ] **Step 2:** Confirm a second `sign` within 60 s of biometric does not prompt again on iOS (retained `LAContext`) and Android (`setUserAuthenticationParameters(60,…)`). If the plugin cannot retain context → sub-plan 03 uses `plugins/device-key/` (own plugin) instead. Record Go/No-Go.

### Task 0.6: Spikes S4, S5, S6 — Didit, Firebase phone, paymaster

- [ ] **S4:** Didit sandbox: create a workflow with ID + passive liveness + face match + Face Search; open hosted link in the system browser (`@capacitor/browser`), return via deep link `monti://kyc/callback?session=…`; run two sessions with the same face → second is `Declined` with duplicate reason. Check Console → Countries: 주민등록증/운전면허증/여권/외국인등록증 and Korean UI; record. Turn OFF "Help improve Didit's models"; set retention 24 months; enable auto-refill.
- [ ] **S5:** Firebase project `monti-dev` (asia-northeast3), Blaze plan, Phone sign-in enabled, SMS regions allowlist KR, US, JP, GB, DE, SG. Test OTP to one KR and one US number from the web app; on an Android device confirm instant verification path (no SMS) at least once.
- [ ] **S6:** Deploy `MontiPaymaster` (sub-plan 01 Tasks 25–28) to 10143, `addStake(86400)` with 1 MON and `depositPlatform` 5 MON from the faucet, send one sponsored user op through Pimlico; confirm `BudgetDebited` event. Simulate the op with Tenderly `tenderly_simulateBundle` and record the gas numbers in `spikes.md`.

---

## Shared Interfaces (authoritative; sub-plans must use these names and types verbatim)

### Contracts (Solidity)

```solidity
// Identity.sol
event Registered(bytes32 indexed personId, address indexed account);
event AccountRotated(bytes32 indexed personId, address indexed oldAccount, address indexed newAccount);
event DeviceChanged(address indexed account, bytes32 x, bytes32 y);
event DeviceLocked(address indexed account, bool locked);

function register(bytes32 personId, address account, bytes32 deviceX, bytes32 deviceY) external; // onlyAttester
function rotateAccount(bytes32 personId, address newAccount) external;                            // onlyAttester, 7 days since last rotation
function setActiveDevice(bytes32 x, bytes32 y) external;   // msg.sender must be a registered account; 7 days since deviceUpdatedAt
function lockDevice(address account) external;             // account itself or attester
function accountOf(bytes32 personId) external view returns (address);
function personOf(address account) external view returns (bytes32);
function isMember(address account) external view returns (bool);      // registered and not rotated away
function activeDevice(address account) external view returns (bytes32 x, bytes32 y);
function isLocked(address account) external view returns (bool);
function deviceUpdatedAt(address account) external view returns (uint64);
uint256 constant ROTATION_COOLDOWN = 7 days; uint256 constant DEVICE_COOLDOWN = 7 days;

// Organizers.sol
uint32 constant PERM_CREATE_EVENT = 1; uint32 constant PERM_MANAGE_GATES = 2; uint32 constant PERM_APPROVE_OVERRIDE = 4;
uint32 constant PERM_MANAGE_MANAGERS = 8; uint32 constant PERM_MANAGE_BUDGET = 16;
event OrganizerCreated(uint256 indexed orgId, address indexed owner);
event AdminSet(uint256 indexed orgId, address indexed admin, uint32 bits);
event ManagerSet(uint256 indexed orgId, address indexed manager, bool exists, bool canApprove);
event OwnerTransferred(uint256 indexed orgId, address indexed from, address indexed to);
event GateRegistered(uint256 indexed gateId, uint256 indexed eventId, address indexed gateAccount, bytes32 kx, bytes32 ky);
event GateRevoked(uint256 indexed gateId); event GateOpened(uint256 indexed gateId); event GateClosed(uint256 indexed gateId);

function createOrganizer(address owner) external returns (uint256 orgId);
function setAdmin(uint256 orgId, address admin, uint32 permissionBits) external;     // owner
function setManager(uint256 orgId, address manager, bool exists, bool canApprove) external; // owner or PERM_MANAGE_MANAGERS
function transferOwner(uint256 orgId, address newOwner) external;
function registerGate(uint256 eventId, address gateAccount, bytes32 kx, bytes32 ky) external returns (uint256 gateId); // PERM_MANAGE_GATES of ticket.eventOrg(eventId)
function revokeGate(uint256 gateId) external; function openGate(uint256 gateId) external; function closeGate(uint256 gateId) external;
function setTicket(address ticket) external;                                          // deployer, once
function ownerOf(uint256 orgId) external view returns (address);
function hasPermission(uint256 orgId, address account, uint32 bit) external view returns (bool); // owner => true
function managerOf(uint256 orgId, address account) external view returns (bool exists, bool canApprove);
function gateOf(address gateAccount) external view returns (uint256 gateId);          // 0 if none
function gateInfo(uint256 gateId) external view returns (uint256 eventId, address account, bytes32 kx, bytes32 ky, bool open, bool revoked);
function isOpenGate(uint256 eventId, address gateAccount) external view returns (bool);

// Ticket.sol (ERC-721, name "MONTI Ticket", symbol "MONTI")
struct EventMeta { uint256 orgId; bytes32 titleHash; bytes32 descHash; string imageCid; uint64 startsAt; uint64 endsAt;
  bytes32 venueHash; uint64 saleStart; uint64 saleEnd; bool transferable; uint32 transferCutoffSeconds; uint8 maxTransfers; bool approvalRequired; }
struct Tier { string name; uint256 priceUsdCents; uint32 supply; uint32 minted; uint16 maxPerWallet; bool seated; }
struct GateCode { uint256 gateId; uint256 eventId; uint64 issuedAt; bytes32 nonce; }
struct CheckIn { uint256 gateId; uint64 ts; bytes32 nonceHash; bool manual; }
uint256 constant CODE_WINDOW = 60;
event EventCreated(uint256 indexed eventId, uint256 indexed orgId, address indexed creator);
event Claimed(uint256 indexed tokenId, uint256 indexed eventId, address indexed to, uint8 tier);
event CheckedIn(uint256 indexed tokenId, uint256 indexed eventId, uint256 indexed gateId, bytes32 nonceHash, uint64 ts);
event OverrideRequested(uint256 indexed tokenId, uint256 indexed gateId, address indexed requester, uint8 reason);
event ManualOverride(uint256 indexed tokenId, uint256 indexed gateId, address indexed approver, uint8 role, uint8 reason); // role: 1 admin, 2 manager
event Revoked(uint256 indexed tokenId, uint8 reason);
event Migrated(uint256 indexed tokenId, address indexed from, address indexed to);

function createEvent(EventMeta calldata meta, Tier[] calldata tiers) external returns (uint256 eventId); // PERM_CREATE_EVENT
function claim(uint256 eventId, uint8 tier, bytes calldata voucher) external returns (uint256 tokenId);   // msg.sender isMember; voucher empty if price 0
function checkIn(uint256 tokenId, GateCode calldata g, bytes calldata deviceSig) external;                // msg.sender must be open gate of eventOf(tokenId)
function requestOverride(uint256 tokenId, uint256 gateId, uint8 reason) external;                          // manager exists
function manualOverride(uint256 tokenId, uint256 gateId, uint8 reason) external;                           // manager canApprove or PERM_APPROVE_OVERRIDE
function revoke(uint256 tokenId, uint8 reason) external;                                                   // PERM_CREATE_EVENT of event's org
function migrate(uint256 tokenId) external;                                                                // identity.accountOf(identity.personOf(ownerOf(tokenId))) == msg.sender
function eventOf(uint256 tokenId) external view returns (uint256); function tierOf(uint256 tokenId) external view returns (uint8);
function eventOrg(uint256 eventId) external view returns (uint256);
function checkInOf(uint256 tokenId) external view returns (CheckIn memory);
function balanceOfEvent(address account, uint256 eventId) external view returns (uint256);
function transfersOf(uint256 tokenId) external view returns (uint8);
function eventMeta(uint256 eventId) external view returns (EventMeta memory);
function tiers(uint256 eventId) external view returns (Tier[] memory);
// deviceSig verification: bytes32 h = sha256(abi.encode(tokenId, g.gateId, g.eventId, g.nonce, g.issuedAt));
//   (bytes32 r, bytes32 s) = abi.decode(deviceSig, (bytes32, bytes32)); (x, y) = identity.activeDevice(ownerOf(tokenId));
//   require(P256.verifySignature(h, r, s, x, y)) — Solady P256, precompile 0x100 first.
// voucher (paid tiers, post-MVP): attester ECDSA over keccak256(abi.encode(eventId, tier, msg.sender, orderId)); orderId consumed.

// MontiPaymaster.sol (EntryPoint v0.6 IPaymaster)
event Deposited(uint256 indexed orgId, uint256 amount);  // orgId 0 = platform
event BudgetDebited(uint256 indexed orgId, address indexed sender, uint256 amount);
event SponsorModeSet(uint256 indexed orgId, bool selfSponsored);
function depositPlatform() external payable; function deposit(uint256 orgId) external payable;
function withdraw(uint256 orgId, uint256 amount) external;            // organizers.ownerOf(orgId)
function setSelfSponsored(uint256 orgId, bool on) external;           // PERM_MANAGE_BUDGET
function budgetOf(uint256 orgId) external view returns (uint256);
// paymasterAndData = abi.encodePacked(address(this), uint256 orgId). Sponsors only if userOp.callData target ∈ {ticket, identity, organizers}
// and selector ∈ allowlist {claim, safeTransferFrom, transferFrom, checkIn, requestOverride, manualOverride, createEvent, registerGate,
// openGate, closeGate, setAdmin, setManager, setActiveDevice, lockDevice, migrate}. Debits maxCost at validation; no postOp.
```

### Off-chain data formats (TypeScript, `packages/shared/src/types.ts`)

```ts
export type Hex = `0x${string}`;
export interface GateCodeWire { v: 1; gateId: string; eventId: string; issuedAt: number; nonce: Hex; kx: Hex; ky: Hex; sig: Hex /* r||s 64B by gate device key over sha256(abi.encode(gateId,eventId,issuedAt,nonce)) */ }
export interface GateResponseWire { v: 1; tokenId: string; deviceSig: Hex /* r||s 64B over sha256(abi.encode(tokenId,gateId,eventId,nonce,issuedAt)) */ }
// NDEF: external type records. Gate emits `monti.app:g` (CBOR of GateCodeWire); attendee writes `monti.app:s` (CBOR of GateResponseWire).
// QR fallback: base64url(CBOR(GateResponseWire)) prefixed "MONTI1:".
export interface SnapshotWire { v: 1; eventId: string; epoch: number; expiresAt: number;
  tickets: Array<{ tokenId: string; account: Hex; deviceX: Hex; deviceY: Hex; photoJpegB64: string; displayName: string; tier: number; checkedIn: boolean }>;
  attesterSig: Hex /* secp256k1 over keccak256(canonical JSON without attesterSig) */ }
export const BANNED_ATTENDEE_WORDS = ['지갑','NFT','민팅','가스','체인','토큰','트랜잭션','wallet','mint','gas','chain','token','transaction','blockchain','monad'];
```

### Firestore (collections, all in `asia-northeast3`)

| Collection / doc | Fields | Written by |
|---|---|---|
| `persons/{personId}` | `status: 'pending'\|'kyc_ok'\|'active'\|'rotated'`, `account: Hex`, `kyc: { provider:'didit', sessionId, verifiedAt, faceSearchOk: boolean }`, `enc: { name: string(b64 ciphertext), docNumber: string }`, `photoPath: string`, `chain: { registerTx?: Hex, block?: number }`, `createdAt`, `updatedAt` | Functions only |
| `users/{firebaseUid}` | `personId`, `phoneE164`, `createdAt` | Functions only |
| `passkeys/{credentialId}` | `personId`, `publicKeyCose: b64`, `counter: number`, `transports: string[]`, `createdAt` | Functions only |
| `devices/{account}` | `deviceX: Hex`, `deviceY: Hex`, `platform: 'ios'\|'android'\|'web'`, `pushToken?: string`, `updatedAt` | Functions only |
| `invites/{inviteId}` | `orgId`, `role: 'admin'\|'manager'`, `phoneE164`, `permissionBits?`, `canApprove?`, `status: 'sent'\|'accepted'\|'expired'`, `acceptedAccount?` | Functions only |
| `kycSessions/{sessionId}` | `personId`, `status`, `decision`, `raw: (redacted) object`, `receivedAt` | Didit webhook |

Clients never read `persons`, `passkeys` or `kycSessions` directly. Security rules deny all client access except `devices/{account}.pushToken` write by the authenticated owner.

### Cloud Functions (v2, region asia-northeast3, Node 22, TypeScript) — names are the API

| Function | Type | Input → Output |
|---|---|---|
| `startSignup` | callable (auth: Firebase phone user) | `{}` → `{ personId, kycUrl }` creates `persons` pending, `users` doc, Didit session |
| `diditWebhook` | HTTPS | Didit HMAC-signed body → updates `kycSessions`, `persons.status='kyc_ok'` or `'rejected'` |
| `registerPasskey` | callable | `{ personId, attestation (WebAuthn registration response) }` → `{ ok }` verifies with `@simplewebauthn/server`, stores `passkeys`, computes smart account address via `eth_call factory.getAddress([pubkey],0)` and stores `persons.account` |
| `registerIdentity` | callable | `{ personId, deviceX, deviceY }` → `{ txHash }` attester EOA sends `Identity.register`; sets `persons.status='active'` after `finalized` (via `awaitFinalized`) |
| `loginChallenge` / `loginVerify` | callable | WebAuthn assertion flow → Firebase custom token for existing users (login is passkey-only) |
| `lockDevice` | callable | `{}` → attester sends `Identity.lockDevice(account)` |
| `startDeviceChange` | callable | `{ method: 'sms'\|'kyc' }` → verifies (phone re-auth or new Didit session) → returns `{ allowedAt }` (7-day cooldown read from chain) |
| `issueSnapshot` | callable (staff) | `{ eventId }` → `SnapshotWire` if `organizers.isOpenGate(eventId, callerGateAccount)` or manager; decrypts photos via KMS |
| `getPhotoForGate` | callable (staff) | `{ tokenId }` → `{ photoJpegB64, displayName }` same auth as above |
| `tenderlyWebhook` | HTTPS | Tenderly alert payload → on `CheckedIn` push "입장 완료" to `devices/{owner}.pushToken`; on `Registered` mark person active; on `AdminSet/ManagerSet/GateRegistered` publish cache-invalidation topic |
| `reconcilePending` | scheduled every 5 min | persons `pending`/`kyc_ok` with `chain.registerTx` older than 2 min → check receipt/finality, repair status |
| `dailyExport` | scheduled 03:00 KST | Envio GraphQL → newline JSON to `gs://monti-exports/{date}/*.jsonl` and BigQuery load |
| `createInvite` / `acceptInvite` | callable | organizer invites by phone; acceptance returns the calldata for `setAdmin`/`setManager` the owner signs from the web |

### Envio entities (`indexer/schema.graphql`)

`Organizer(id=orgId, owner)`, `Admin(id=orgId-account, bits)`, `Manager(id=orgId-account, canApprove)`, `Gate(id=gateId, eventId, account, kx, ky, open, revoked)`, `Event(id=eventId, orgId, titleHash, descHash, imageCid, startsAt, endsAt, venueHash, saleStart, saleEnd, transferable, transferCutoffSeconds, maxTransfers, approvalRequired)`, `Tier(id=eventId-idx, name, priceUsdCents, supply, minted, maxPerWallet, seated)`, `Ticket(id=tokenId, eventId, tier, owner, transfers, revoked)`, `CheckIn(id=tokenId, gateId, ts, nonceHash, manual, txHash, block)`, `Override(id=txHash-logIndex, tokenId, gateId, approver, role, reason, requested: Boolean)`, `IdentityAccount(id=account, personId, deviceX, deviceY, locked, deviceUpdatedAt)`. No PII.

### Web app module boundaries (`apps/web/src`)

| Folder | Responsibility | Public API (TypeScript) |
|---|---|---|
| `shared/chain/` | viem clients, ABIs, `readOrganizers()`, `readTicket()`, `readIdentity()`, `subscribeLogs(topic)` via `monadLogs` | `getPublicClient()`, `getBundlerClient()`, `getSmartAccount(webAuthnAccount)` |
| `shared/passkey/` | `@capgo/capacitor-passkey` on native, `navigator.credentials` on web | `createPasskey(name): Promise<WebAuthnCredential>`, `getPasskeyAccount(): Promise<WebAuthnAccount>` |
| `shared/deviceKey/` | P-256 hardware key | `ensureDeviceKey(): Promise<{x:Hex,y:Hex}>`, `armDeviceKey(): Promise<void>` (biometric), `signWithDeviceKey(hash: Hex): Promise<{r:Hex,s:Hex}>` |
| `shared/nfc/` | `@capgo/capacitor-nfc` native, Web NFC on Android Chrome, none on iOS web | `readGateCode(): Promise<GateCodeWire>`, `writeGateResponse(r: GateResponseWire): Promise<void>`, `nfcCapability(): 'native'\|'webnfc'\|'none'` |
| `shared/api/` | Firebase callable wrappers with the names above | one function per callable |
| `attendee/` | signup, kyc, passkey, tickets, claim, transfer, arm-and-tap, results | routes `/`, `/signup/*`, `/tickets`, `/tickets/:id`, `/tickets/:id/transfer`, `/tickets/:id/enter` |
| `organizer/` | wizard (6 steps), dashboard, invites, gates | routes `/org/*` |
| `staff/` | gate console UI (state machine: idle, ready, received, confirming, admit, offlineAdmit, deny, override) consumed by sub-plan 04 | route `/staff/*` |

---

## Acceptance (what "done" means for the MVP, demo script spec §17)

1. Phone A: phone OTP → Didit → passkey → account deployed → `Registered` on MonadVision. Same face on Phone B → "이미 계정이 있습니다".
2. Organizer web: wizard creates an event on chain; manager invited and appears in `ManagerSet`; gate registered and opened.
3. Phone A claims a free ticket (`Claimed`).
4. Phone A in airplane mode: 입장하기 → Face ID → tap → staff device turns green with photo within 3 s; `CheckedIn` visible on explorer. Second tap → red ALREADY_USED.
5. Transfer to a non-member address blocked client-side with an alert; transfer to member C succeeds (`Transfer`) and C can enter.
6. Backend functions disabled: entry still works.
7. Staff device airplane mode: OFFLINE 승인 with photo from snapshot; after reconnect the queued `checkIn` lands on chain.
8. Copy lint passes: zero banned words in attendee routes.

---

## Delta 2026-09-20 (spec v2.4) — authoritative, supersedes overlapping items above

Founder additions: transfer by nickname / EVM address / phone number with invite for non-members; event chat per event until the event ends; mobile-only UI with bottom tabs and FABs; discovery by date/region/theme; event lifecycle; nickname; card payments start with PayPal KR (free to open) and move to Eximbay after the prize.

### Contracts additions

```solidity
// Identity.sol
error NicknameTaken();
event NicknameSet(address indexed account, bytes32 indexed nicknameHash, string nickname);
function setNickname(bytes32 nicknameHash, string calldata nickname) external; // account; hash == keccak256(bytes(nickname)); unique
function nicknameOwner(bytes32 nicknameHash) external view returns (address);
function nicknameOf(address account) external view returns (bytes32);
function attester() external view returns (address);

// Ticket.sol
// EventMeta gains, at the END: uint8 category; bytes32 regionCode;   // category 0 공연 1 모임 2 전시 3 기타; regionCode = keccak256("KR-11")
enum EventStatus { Draft, Published, Cancelled, Ended }               // Ended derived from endsAt, never stored
error EventNotPublished(); error EventEnded(); error OfferExpired(); error BadAttesterSig();
event EventStatusChanged(uint256 indexed eventId, uint8 status);
event OfferCreated(uint256 indexed tokenId, address indexed from, bytes32 recipientCommitment, uint64 expiresAt);
event OfferCancelled(uint256 indexed tokenId);
event OfferAccepted(uint256 indexed tokenId, address indexed from, address indexed to);
struct Offer { address from; bytes32 recipientCommitment; uint64 expiresAt; }
function publishEvent(uint256 eventId) external;                        // PERM_CREATE_EVENT
function cancelEvent(uint256 eventId) external;                         // PERM_CREATE_EVENT
function updateEventMeta(uint256 eventId, EventMeta calldata meta, Tier[] calldata tiers) external; // Draft only
function eventStatus(uint256 eventId) external view returns (EventStatus);
function createOffer(uint256 tokenId, bytes32 recipientCommitment, uint64 expiresAt) external; // owner; transferable, not checked in, before cutoff
function cancelOffer(uint256 tokenId) external;                          // owner
function acceptOffer(uint256 tokenId, bytes calldata attesterSig) external; // recipient; attester ECDSA over keccak256(abi.encode(tokenId, commitment, msg.sender)); transfer via _update
function offerOf(uint256 tokenId) external view returns (Offer memory);
// claim requires eventStatus == Published and saleStart <= now <= saleEnd. checkIn/_update clear offers[tokenId].
// Paymaster allowlist adds: setNickname, createOffer, cancelOffer, acceptOffer, publishEvent, cancelEvent, updateEventMeta.
```

### Off-chain additions

- `imageCid` on chain now holds the CID of a metadata JSON `{ title, description, image (CID), venue, category, region }`; the wizard pins both the image and the JSON to Pinata. Envio exposes `Event.imageCid`; clients fetch the JSON from an IPFS gateway for titles and search.
- Firestore: `phoneIndex/{hmacPhone}` → `{ personId }` (`hmacPhone = HMAC-SHA256(PHONE_INDEX_KEY, phoneE164)`); `transferInvites/{inviteId}` → `{ tokenId, fromAccount, hmacPhone, commitment: keccak256(hmacPhone), status, createdAt, expiresAt }`; `eventChats/{eventId}` → `{ closed, endsAt, orgId }`, `members/{uid}` → `{ account, joinedAt }`, `messages/{msgId}` → `{ uid, text ≤ 500, createdAt, pinned: boolean, reported: number }`; `users/{uid}` gains `nickname`, `locale: 'en'|'ko'`, `chatOrder: string[]` (owner-writable).
- Callables: `resolveRecipient({ type:'phone'|'nickname'|'address', value }) → { member, account?, nickname?, commitment? }`; `createTransferInvite({ tokenId, phoneE164 }) → { inviteId, commitment, expiresAt, smsText, smsUri }` (the sender's own phone sends the SMS via `sms:` composer; no SMS provider); `pendingOffers() → Array<{ tokenId, attesterSig }>`; `joinEventChat({ eventId })`; `reportMessage({ eventId, msgId })`; `listAttendees({ eventId }) → Array<{ tokenId, nickname, tier, checkedIn }>` (organizer roles only; no phone/name); `getSignupStatus() → { status }`; `listPendingGates({ eventId })`.
- Scheduled: `closeEndedChats` (10 min). `tenderlyWebhook` also handles `Transfer` (drop chat membership when balance hits 0), `OfferAccepted` (mark invite accepted), `EventStatusChanged` (create/close chat doc), `NicknameSet` (mirror to `users.nickname` for display).
- Envio additions: `IdentityAccount.nickname`, `Offer(id=tokenId, from, commitment, expiresAt, status)`, `Event.category`, `Event.regionCode`, `Event.status`.

### Web additions

- Mobile-only layout (max 480px content, safe areas). Attendee bottom tabs: 탐색 `/`, 내 티켓 `/tickets`, 대화 `/chats`, 프로필 `/me`. FAB: "입장하기" on `/tickets/:id`, "만들기" on `/org`. i18n `en`/`ko` via i18next; copy lint on both locales.
- Discovery filters: date, region, category, text search over IPFS metadata titles (client-side over the Envio page).
- Ticket states: 입장 전 / 입장 완료 / 양도 대기 / 양도됨 / 취소됨.
- Transfer: three recipient routes; phone route creates an on-chain offer and opens the SMS composer; recipient inbox accepts pending offers after signup.
- Chat: list (reorderable, `@dnd-kit/sortable`), room (Firestore realtime), closed banner, organizer pinned announcements.
- Organizer: lifecycle (초안/게시/취소), category/region in step 1, dashboard (sold/remaining per tier, check-ins, attendee list), team, gates, announcements.

### Reconciliation after sub-plan 04 (authoritative)

- Ticket custom errors: `AlreadyCheckedIn, WrongEvent, TicketRevoked, CodeExpired, NoSuchTicket, GateNotOpen, GateMismatch, DeviceLocked, BadDeviceSignature, EventNotPublished, EventEnded, EventCancelled, OfferExpired, BadAttesterSig` (Delta after 01 T20/T21: `GateMismatch → GATE_MISMATCH`, `EventCancelled → EVENT_CANCELLED`; `NoActiveDevice` removed as unreachable; `checkIn` accepts `issuedAt ≤ block.timestamp + 5` forward skew); Identity: `NicknameTaken`. Staff DENY map keys off these selectors.
- `Identity.attester()` view exists; `packages/shared` also exports `ATTESTER_ADDRESS`.
- `SnapshotWire.attesterSig` = raw secp256k1 (r||s||v) over `keccak256(utf8(canonicalJson(snapshot without attesterSig)))`; `canonicalJson` and `snapshotDigest` live in `packages/shared/src/encoding.ts`.
- Web shared signatures (used by 03 and 04): `sendSponsoredOp({ account, calls, orgId }) → { userOpHash, wait() }`; `subscribeLogs({ address, topics, onLog }) → unsubscribe` with `ChainLog.stage: 'speculative'|'finalized'`; `ensureDeviceKey({ alias, requireAuth, strongBox })`, `armDeviceKey({ alias })`, `signWithDeviceKey(digest, { alias })` signing the digest raw; aliases `'monti-attendee'` (requireAuth true) and `'monti-gate'` (requireAuth false); `getStaffAccount()`; staff console components `StaffShell, TapPrompt, ReceivedCard, ConfirmingCard, AdmitCard, OfflineAdmitCard, DenyCard, OverrideDialog, OfflineBadge` exported from `src/staff/components/index.ts`.
- Check-ins are sent from the **gate device account**; overrides from the **staff member's passkey account**.

### Reconciliation after sub-plans 01–02 (authoritative)

- `Identity.register` also emits `DeviceChanged(account, deviceX, deviceY)`.
- Copy lint: English banned words match on **word boundaries** (so `tokenId`, `gasLimit`, `chainId` in code do not trip it); Korean words match as substrings. Lint scans only user-visible string literals in attendee routes and the `copy/{en,ko}.ts` files.
- `persons.status` union: `'pending' | 'kyc_ok' | 'rejected' | 'active' | 'rotated'`.
- New Firestore collection `authChallenges/{challenge}` → `{ personId?, purpose: 'register'|'login', expiresAt }` consumed once by `registerPasskey` / `loginVerify`.
- `issueSnapshot({ eventId, gateAccount })` and `getPhotoForGate({ tokenId, gateAccount })` are called with the **staff member's** Firebase session. Auth: caller's account is a manager of `eventOrg(eventId)` or an admin with `PERM_MANAGE_GATES` or `PERM_APPROVE_OVERRIDE`, and `gateAccount` is a registered, non-revoked gate for the event. The gate device account never authenticates to Firebase.
- `GateResponseWire` CBOR payload is ≈160 bytes (hex string fields); within Type 4 limits.

### Reconciliation after cross-plan review (authoritative)

- Callables added to 02: `getSignupStatus() → { status, account?, kycUrl? }`, `submitPendingGate({ eventId, gateAccount, kx, ky, deviceLabel })`, `listPendingGates({ eventId })`, `pinMessage({ eventId, msgId, pinned })`, `requestAccountDeletion({ reason? })` + scheduled `processDeletions`. Collections added: `pendingGates/{gateAccount}`, `deletionRequests/{personId}`, `authChallenges/{challenge}`.
- `sendSponsoredOp` receipt: `{ success, txHash, blockNumber, revertReason? }`, `wait(timeoutMs = 15000)`.
- Staff console props: 03's Task 31 set is canonical, plus `onDone` on Admit/OfflineAdmit/Deny cards and `finalized` on `AdmitCard`. DENY codes: the nine in spec §13 plus `EVENT_ENDED`.
- `canonicalJson` / `snapshotDigest` exist only in `packages/shared`; 04 imports them.
- Envio `Event.status` is a String (`Draft|Published|Cancelled|Ended`); `Tier` has `eventId` for filtering.
- Chat message create payload is exactly `{ uid, text, createdAt, reported: 0 }`; `pinned` is server-written only.
- `getStaffAccount` lives in `shared/chain/accounts.ts`.

### Delta 2026-09-20 (spec v2.5) — per-event KYC (authoritative)

- Identity: `register(personId, account, deviceX, deviceY, uint8 kycLevel)`; `setKycLevel(personId, level)` attester; `kycLevelOf(account) → uint8`; event `KycLevelSet(account, level)` (also emitted inside `register`). Level 0 = phone + passkey; 1 = ID + face verified (Didit, Face Search dedup).
- Ticket: `EventMeta` gains `bool requireKyc` appended after `regionCode`; `claim` and `_update` (incl. `acceptOffer`) revert `KycRequired()` when the event requires KYC and the receiving account's level < 1.
- Signup = phone → passkey → device key → `registerIdentity` (level 0). KYC is on demand: `startKyc() → { kycUrl, sessionId }`; webhook approval → `setKycLevel(1)`. `getSignupStatus() → { status, kycLevel, account?, kycUrl? }`.
- UI: badge `KYC 필요` / `KYC required` on event cards and detail; claim sheet prompts verification; wizard step 4 toggle "본인인증 필수 (암표 방지)"; profile shows 인증 상태; staff screens show avatar placeholder + nickname for non-KYC events.
- Envio: `Event.requireKyc`, `IdentityAccount.kycLevel`. `listAttendees` adds `kycLevel`.
- Dedup for level-0 accounts is one account per phone number only.
- `SnapshotWire` final shape: `{ v: 1, eventId, eventTitle, requireKyc, epoch, expiresAt, tickets: Array<{ tokenId, account, deviceX, deviceY, photoJpegB64, displayName, tier, tierName, seat, checkedIn }>, attesterSig }`.

## Self-review notes (master)

- Spec coverage: §5 journeys → sub-plans 02/03; §7 protocol → 03 (attendee side), 04 (gate side), 01 (`checkIn`); §8.1 shell → 03/04; §8.3–8.5 gas/paymaster/bundler → 01 (`MontiPaymaster`), 03/04 (bundler client); §9 identity/KYC/device/roles → 01/02/03; §10.4 storage rules → 02; §12 offline → 04; §13 staff screen → 03 UI + 04 logic; §15 Must list → all covered; §8.7 payments → out of MVP (voucher path in `claim` only).
- Type consistency: all sub-plans must import names from this file; a reviewer task at the end of sub-plan 04 diffs every ABI/function/type name used in 02–04 against `packages/shared` generated from 01.

## Delta after 03 Task 11 (sendSponsoredOp receipt)

- `sendSponsoredOp` receipt stays `{ success, txHash, blockNumber, revertReason? }`, but `revertReason` is now `Hex | 'TIMEOUT'`. `wait(timeoutMs)` never throws: on deadline it resolves `{ success: false, txHash: '0x', blockNumber: 0n, revertReason: 'TIMEOUT' }`; transient RPC errors inside the poll are swallowed until the deadline. The `SponsoredOpTimeout` class in plan 03 §Task 11 "Produces" no longer exists.
- Consumers in plan 04 (`mapRevertToDenyCode`, gate queue `lastError`): `'TIMEOUT'` is not a deny. Treat it as "confirmation pending" — keep the chain-event subscription as the source of truth and show the neutral "확인 중 / Confirming" state, never a red screen. Only a `Hex` revert reason maps to a DENY code.
- viem's default `baseFeeMultiplier` is kept (fee cap only; effective price is base + priority on Monad), so it does not compound with the ×1.075 gas-limit headroom.

## Delta after 01 Tasks 25–26 review (MontiPaymaster hardening)

- `orgId` is derived from the verified inner call (per-selector arg-kind table → `Ticket.eventOf/eventOrg`), never from `paymasterAndData`. Slot = `selfSponsored[orgId] ? orgId : 0`.
- `postOp` IS implemented (overrides spec §8.4 "no postOp"): validation checks `budget[slot] >= maxCost` and returns `abi.encode(slot, maxCost)`; `postOp` debits `actualGasCost`. Without it a single op with an inflated `maxFeePerGas` zeroes a slot while the EntryPoint refunds the excess to the deposit (stranded funds).
- Validation also rejects `value != 0`, batches longer than 8, truncated calldata (named errors), and non-member senders (`Identity.isMember`). Targets are immutable constructor args; `setTargets` removed; `deposit(orgId)` requires an existing organizer.
- Web/staff consumers: nothing in `paymasterAndData` beyond the paymaster address (no orgId hint); `sendSponsoredOp({ orgId })` keeps the field only for pre-flight budget warnings via `budgetOf`.
