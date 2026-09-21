# MONTI Implementation Plan · 01 Contracts (컨트랙트)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Read `docs/superpowers/plans/2026-09-20-monti-00-master-plan.md` first — its "Shared Interfaces" section is authoritative and every name in this plan is copied from it verbatim.

**Goal:** Monad 테스트넷(10143) 위에 MONTI의 온체인 권한 전체를 올린다. 네 개의 컨트랙트(`Identity`, `Organizers`, `Ticket`, `MontiPaymaster`)가 신원·역할·티켓·게이트·입장 기록·가스 예산을 보유하고, 위협 모델 T1~T15의 모든 규칙을 Foundry 테스트로 증명하며, ABI와 배포 주소를 `packages/shared`로 내보내 02·03·04 서브플랜이 바로 쓸 수 있게 한다.

**Architecture:** 체인이 데이터베이스다. `Identity`는 난수 `personId` ↔ 스마트 계정 ↔ 활성 기기 P-256 공개키를 잇고, `Organizers`는 오너/관리자/매니저/게이트 allowlist를 비트 권한으로 관리하며, `Ticket`(ERC-721)은 `_update` 오버라이드 한 곳에 모든 양도 규칙을 모으고 `checkIn`에서 Solady `P256.verifySignature`로 관객 기기 서명을 검증한다. `MontiPaymaster`는 EntryPoint v0.6 `IPaymaster`로서 Coinbase Smart Wallet의 `execute`/`executeBatch` calldata를 열어 대상 컨트랙트와 셀렉터 허용 목록을 확인하고, 검증 단계에서 `maxCost`를 예산에서 차감한다(`postOp` 없음 — Monad는 한도 기준 과금).

**Tech Stack:** Solidity 0.8.31 · Foundry ≥ 1.8 (`evm_version = "osaka"`) · OpenZeppelin Contracts 5.x (ERC-721, Strings, Base64) · Solady (`P256`, `LibString`, `Base64`) · eth-infinitism account-abstraction v0.6 (`IPaymaster`, `UserOperation`, `IEntryPoint`) · Coinbase Smart Wallet 컨트랙트(git submodule, 팩토리 배포 스크립트 전용) · `@noble/curves`(P-256 테스트 벡터 생성 1회)

**Spec:** `docs/superpowers/specs/2026-09-20-monti-nfc-ticketing-design.md` (v2.3 확정). 이 플랜이 직접 구현하는 절은 §6.3(위협 모델), §7(입장 절차), §8.3–8.4(가스·페이마스터), §9.3–9.4(기기 정책·권한), §10(온체인 설계)이다.

## Global Constraints

마스터 플랜에서 그대로 복사했다. 이 플랜의 모든 태스크에 암묵적으로 포함된다.

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
- Commit after every green test. Conventional commits (`feat:`, `test:`, `chore:`). Repository initialized in master plan Task 0.1.

### 이 플랜에만 추가로 적용되는 제약

- 모든 `forge script` 브로드캐스트는 **반드시 `--gas-limit`을 명시**한다(한도 기준 과금). 이 플랜의 모든 배포 명령에 이미 들어 있다.
- 마스터 플랜 "Shared Interfaces"의 이벤트·함수·구조체·상수·에러 이름은 **한 글자도 바꾸지 않는다.** 이름이 모자라면 추가는 가능하되 기존 것을 고치지 않는다(이 플랜이 추가한 것은 Self-Review에 전부 적는다).
- 한국어는 설명에만 쓴다. 식별자·주석·코드는 영어다. 단 `tokenURI`가 만드는 JSON의 사람이 읽는 값(`입장 전`, `입장 완료`)과 그 테스트 단언은 한국어 리터럴이다(기획 §10.2 요구).
- 작업 디렉터리는 항상 `contracts/`다. 명령의 `cd contracts` 는 생략하지 말 것.

---

## File Structure

```
contracts/
  foundry.toml                     solc 0.8.31, evm_version osaka, optimizer, rpc aliases 10143/143
  remappings.txt                   @openzeppelin, solady, account-abstraction, smart-wallet, forge-std
  .gitignore                       out/ cache/ broadcast/ .env
  .env.example                     MONAD_TESTNET_RPC, MONAD_MAINNET_RPC, DEPLOYER_PK, ATTESTER
  lib/                             git submodules (forge install)
  src/
    Identity.sol                   personId ↔ account ↔ active device key, 7-day cooldowns, lock
    Organizers.sol                 org/admin/manager/gate allowlist, permission bits
    Ticket.sol                     ERC-721, createEvent/claim/_update rules/checkIn/override/revoke/migrate/tokenURI
    MontiPaymaster.sol             EntryPoint v0.6 IPaymaster, target+selector allowlist, per-org budget
    libs/AttesterRole.sol          onlyAttester modifier + deployer-owned attester rotation
    interfaces/IIdentity.sol       what Ticket and MontiPaymaster read from Identity
    interfaces/IOrganizers.sol     what Ticket and MontiPaymaster read from Organizers
    interfaces/ITicket.sol         what Organizers reads from Ticket (eventOrg)
  test/
    Base.t.sol                     shared fixture: deploys all four, etches the P-256 mock
    utils/P256Vectors.sol          generated x, y, digests, r, s (one Node snippet run)
    mocks/MockP256Precompile.sol   returns 1 only for vectors in P256Vectors
    mocks/MockEntryPoint.sol       depositTo/withdrawTo/addStake + validate caller helper
    Identity.t.sol                 register, device, lock, rotate, cooldowns
    Organizers.t.sol               org, permission bits, manager canApprove, gates
    TicketClaim.t.sol              createEvent, claim, supply, maxPerWallet
    TicketTransfer.t.sol           _update rules: member, maxPerWallet, checked-in, cutoff, maxTransfers
    TicketCheckIn.t.sol            happy path + T2/T12/T13/T14 negatives
    TicketOverride.t.sol           requestOverride, manualOverride roles, revoke, migrate
    TicketURI.t.sol                on-chain JSON, 입장 전 / 입장 완료
    Paymaster.t.sol                allowlist decode, budget debit, refusals, stake helpers
    CheckInGas.t.sol               fork test: checkIn gas < 200k on the real precompile
  script/
    Deploy.s.sol                   4 contracts + wiring + deployments/10143.json
    DeployCoinbaseFactory.s.sol    CREATE2 via 0x4e59…4956C so the factory matches mainnet
    Seed.s.sol                     1 organizer, 1 event (free tier), 1 open gate
    export-abi.sh                  out/*.json → packages/shared/src/abi/*.json
    gen-p256-vectors.mjs           @noble/curves snippet (run once, output pasted into P256Vectors.sol)
  deployments/10143.json           written by Deploy.s.sol
```

책임 경계: `libs/AttesterRole.sol`만 어테스터 권한을 안다. `Ticket`은 게이트 권한을 직접 알지 않고 `IOrganizers.isOpenGate`에 묻는다. `Organizers`는 티켓 소유권을 모르고 `ITicket.eventOrg`만 읽는다. `MontiPaymaster`는 세 컨트랙트의 주소와 셀렉터 목록만 알고 내부 규칙은 모른다(§8.4 "티켓 컨트랙트는 누가 가스를 내는지 모른다"의 역방향).

---

## Task 1: Foundry 프로젝트 초기화

**Files:**
- Create: `contracts/foundry.toml`
- Create: `contracts/.gitignore`
- Create: `contracts/.env.example`
- Create: `contracts/src/.gitkeep`
- Test: 없음(설정 태스크. 검증은 `forge config`로 한다)

**Interfaces:**
- Consumes: 없음(첫 태스크)
- Produces: `forge build`/`forge test`가 solc 0.8.31·`evm_version = "osaka"`로 도는 프로젝트 루트 `contracts/`. RPC 별칭 `monad_testnet`(10143), `monad_mainnet`(143). 이후 모든 태스크가 `cd contracts`에서 실행된다.

- [ ] **Step 1: Foundry 버전을 확인하고 프로젝트를 만든다**

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI
forge --version
mkdir -p contracts/src contracts/test/utils contracts/test/mocks contracts/script contracts/deployments
cd contracts
forge init --no-git --no-commit --force .
rm -rf src/Counter.sol test/Counter.t.sol script/Counter.s.sol
```

기대: `forge --version`이 `1.8.x` 이상. 1.8 미만이면 `foundryup` 으로 올린 뒤 진행한다(`evm_version = "osaka"`가 1.8부터다).

- [ ] **Step 2: `foundry.toml`을 쓴다**

```toml
[profile.default]
src = "src"
out = "out"
libs = ["lib"]
test = "test"
script = "script"
solc_version = "0.8.31"
evm_version = "osaka"
optimizer = true
optimizer_runs = 200
bytecode_hash = "none"
ffi = false
fs_permissions = [{ access = "read-write", path = "./deployments" }]

[profile.ci]
verbosity = 3
fuzz = { runs = 512 }

[rpc_endpoints]
monad_testnet = "${MONAD_TESTNET_RPC}"
monad_mainnet = "${MONAD_MAINNET_RPC}"

[fmt]
line_length = 120
tab_width = 4
bracket_spacing = false
int_types = "long"
```

- [ ] **Step 3: Monad 네트워크 프로필 키를 시험한다**

`network = "monad"`는 Foundry가 Monad 전용 가스 회계를 켜는 키다. 지원 여부가 버전에 따라 다르므로 넣어 보고 경고가 나면 뺀다.

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/contracts
printf 'network = "monad"\n' >> /tmp/monti-network-probe
python3 - <<'PY'
import re, pathlib
p = pathlib.Path("foundry.toml"); t = p.read_text()
p.write_text(t.replace('evm_version = "osaka"', 'evm_version = "osaka"\nnetwork = "monad"'))
PY
forge config 2>&1 | head -40
```

기대 A(지원함): 출력에 `network = "monad"` 또는 `network: monad`가 보이고 경고가 없다 → 그대로 둔다.
기대 B(미지원): `warning: found unknown config section/key ... network` 가 보인다 → 아래 명령으로 그 한 줄을 지우고 진행한다.

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/contracts
python3 - <<'PY'
import pathlib
p = pathlib.Path("foundry.toml"); p.write_text(p.read_text().replace('\nnetwork = "monad"', ''))
PY
forge config 2>&1 | head -40
```

- [ ] **Step 4: `.gitignore`와 `.env.example`을 쓴다**

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/contracts
cat > .gitignore <<'EOF'
out/
cache/
broadcast/
.env
node_modules/
EOF
cat > .env.example <<'EOF'
# Monad RPC (chain id 10143 / 143). Never hardcode a chain id in contract logic.
MONAD_TESTNET_RPC=https://testnet-rpc.monad.xyz
MONAD_MAINNET_RPC=https://rpc.monad.xyz
# Deployer EOA private key (0x-prefixed). Testnet only.
DEPLOYER_PK=0x0000000000000000000000000000000000000000000000000000000000000000
# Attester EOA address. Production key lives in Cloud KMS, never here.
ATTESTER=0x0000000000000000000000000000000000000000
# EntryPoint v0.6 (Coinbase Smart Wallet v1)
ENTRYPOINT=0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789
EOF
```

- [ ] **Step 5: 설정이 실제로 먹는지 확인한다**

Run:
```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/contracts
forge config --json | python3 -c "import json,sys; c=json.load(sys.stdin); print(c['solc'] or c.get('solc_version'), c['evm_version'], c['optimizer'])"
```
Expected: `0.8.31 osaka True` (solc 필드가 `null`이면 `solc_version` 값이 찍힌다). `evm_version`이 `osaka`가 아니면 Foundry가 1.8 미만이라는 뜻이니 `foundryup` 후 다시 실행한다.

- [ ] **Step 6: 커밋**

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI
git add contracts/foundry.toml contracts/.gitignore contracts/.env.example
git commit -m "chore(contracts): init foundry project with solc 0.8.31 and osaka evm"
```

---

## Task 2: 의존성 설치와 remappings

**Files:**
- Create: `contracts/remappings.txt`
- Create: `contracts/src/Probe.sol` (이 태스크에서 만들고 이 태스크에서 지운다)
- Test: `contracts/test/Deps.t.sol` (이 태스크 전용 컴파일 스모크 테스트. 이후 태스크에서도 남겨 둔다)

**Interfaces:**
- Consumes: Task 1의 `contracts/foundry.toml`
- Produces: `@openzeppelin/contracts/…`, `solady/…`, `account-abstraction/…`, `smart-wallet/…`, `forge-std/…` 임포트 경로. 이후 모든 `.sol` 파일이 이 경로를 쓴다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`contracts/test/Deps.t.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {Test} from "forge-std/Test.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {P256} from "solady/utils/P256.sol";
import {IPaymaster} from "account-abstraction/interfaces/IPaymaster.sol";
import {UserOperation} from "account-abstraction/interfaces/UserOperation.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";

contract DepsTest is Test {
    function test_dependenciesCompileAndExposeExpectedSymbols() public pure {
        // OpenZeppelin 5.x: ERC721 exposes the _update hook we override in Ticket.
        assertEq(type(ERC721).creationCode.length > 0, true);
        // Solady: the P-256 precompile address the spec pins.
        assertEq(P256.verifySignature(bytes32(0), bytes32(0), bytes32(0), bytes32(0), bytes32(0)), false);
        // account-abstraction v0.6: UserOperation is a struct, not PackedUserOperation.
        UserOperation memory op;
        assertEq(op.nonce, 0);
        assertEq(IPaymaster.validatePaymasterUserOp.selector != bytes4(0), true);
        assertEq(IEntryPoint.depositTo.selector != bytes4(0), true);
    }
}
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/contracts && forge test --match-path test/Deps.t.sol`
Expected: FAIL — `Source "@openzeppelin/contracts/token/ERC721/ERC721.sol" not found` (의존성이 아직 없다).

- [ ] **Step 3: 의존성을 설치한다**

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/contracts
forge install OpenZeppelin/openzeppelin-contracts@v5.1.0
forge install Vectorized/solady@v0.1.11
forge install eth-infinitism/account-abstraction@v0.6.0
forge install coinbase/smart-wallet
ls lib
```
기대: `lib` 에 `forge-std openzeppelin-contracts solady account-abstraction smart-wallet` 다섯 개. `forge install` 이 `--no-commit` 을 모른다고 하면 그 플래그 없이(위 명령 그대로) 쓰면 된다 — Foundry 1.8은 기본이 no-commit이다.

- [ ] **Step 4: `remappings.txt`를 쓴다**

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/contracts
cat > remappings.txt <<'EOF'
forge-std/=lib/forge-std/src/
@openzeppelin/contracts/=lib/openzeppelin-contracts/contracts/
solady/=lib/solady/src/
account-abstraction/=lib/account-abstraction/contracts/
smart-wallet/=lib/smart-wallet/src/
EOF
```

- [ ] **Step 5: 테스트가 통과하는지 확인한다**

Run: `cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/contracts && forge test --match-path test/Deps.t.sol -vv`
Expected: PASS — `[PASS] test_dependenciesCompileAndExposeExpectedSymbols()`.

`P256.verifySignature(0,0,0,0,0)`가 `revert`하지 않고 `false`를 돌려주는 것이 중요하다. 프리컴파일도 폴백 검증기도 없는 로컬 EVM에서 영(0) 입력은 Solady가 조기 반환하기 때문이다. 만약 여기서 revert가 나면 Solady 버전이 `verifySignature` 대신 `verifySignatureAllowMalleability`만 가진 옛날 버전이니 `forge update lib/solady` 로 올린다.

- [ ] **Step 6: 커밋**

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI
git add contracts/remappings.txt contracts/test/Deps.t.sol contracts/.gitmodules contracts/lib
git commit -m "chore(contracts): add openzeppelin 5, solady, account-abstraction v0.6, coinbase smart-wallet"
```

---

## Task 3: AttesterRole — 어테스터 전용 modifier

**Files:**
- Create: `contracts/src/libs/AttesterRole.sol`
- Test: `contracts/test/AttesterRole.t.sol`

**Interfaces:**
- Consumes: Task 2의 `forge-std/Test.sol`
- Produces:
  - `abstract contract AttesterRole` — `constructor(address attester_)`, `address public attester`, `address public immutable deployer`, `modifier onlyAttester()`, `function setAttester(address newAttester) external`, `event AttesterChanged(address indexed previousAttester, address indexed newAttester)`, `error NotAttester()`, `error NotDeployer()`, `error ZeroAddress()`.
  - `Identity`(Task 4)가 상속한다. `MontiPaymaster`(Task 23)는 상속하지 않고 `deployer` 패턴만 따라 쓴다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`contracts/test/AttesterRole.t.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {Test} from "forge-std/Test.sol";
import {AttesterRole} from "../src/libs/AttesterRole.sol";

contract AttesterRoleHarness is AttesterRole {
    uint256 public calls;

    constructor(address attester_) AttesterRole(attester_) {}

    function attesterOnlyAction() external onlyAttester {
        calls += 1;
    }
}

contract AttesterRoleTest is Test {
    AttesterRoleHarness internal h;
    address internal constant ATTESTER = address(0xA11CE);
    address internal constant STRANGER = address(0xBEEF);

    event AttesterChanged(address indexed previousAttester, address indexed newAttester);

    function setUp() public {
        h = new AttesterRoleHarness(ATTESTER);
    }

    function test_attesterCanCall() public {
        vm.prank(ATTESTER);
        h.attesterOnlyAction();
        assertEq(h.calls(), 1);
    }

    function test_strangerCannotCall() public {
        vm.prank(STRANGER);
        vm.expectRevert(AttesterRole.NotAttester.selector);
        h.attesterOnlyAction();
    }

    function test_deployerRotatesAttester() public {
        vm.expectEmit(true, true, false, false);
        emit AttesterChanged(ATTESTER, STRANGER);
        h.setAttester(STRANGER);
        assertEq(h.attester(), STRANGER);

        vm.prank(STRANGER);
        h.attesterOnlyAction();
        assertEq(h.calls(), 1);
    }

    function test_nonDeployerCannotRotateAttester() public {
        vm.prank(STRANGER);
        vm.expectRevert(AttesterRole.NotDeployer.selector);
        h.setAttester(STRANGER);
    }

    function test_zeroAttesterRejected() public {
        vm.expectRevert(AttesterRole.ZeroAddress.selector);
        new AttesterRoleHarness(address(0));
    }
}
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/contracts && forge test --match-path test/AttesterRole.t.sol`
Expected: FAIL — `Source "src/libs/AttesterRole.sol" not found`.

- [ ] **Step 3: 구현을 쓴다**

`contracts/src/libs/AttesterRole.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

/// @title AttesterRole
/// @notice The attester is the off-chain key (Cloud KMS, spec 9.2) that証s "this human passed KYC".
///         It is the only writer of Identity.register and Identity.rotateAccount. The deployer can
///         rotate the attester address; nobody else can. There is no other privileged role here.
abstract contract AttesterRole {
    address public attester;
    address public immutable deployer;

    event AttesterChanged(address indexed previousAttester, address indexed newAttester);

    error NotAttester();
    error NotDeployer();
    error ZeroAddress();

    constructor(address attester_) {
        if (attester_ == address(0)) revert ZeroAddress();
        deployer = msg.sender;
        attester = attester_;
        emit AttesterChanged(address(0), attester_);
    }

    modifier onlyAttester() {
        if (msg.sender != attester) revert NotAttester();
        _;
    }

    function setAttester(address newAttester) external {
        if (msg.sender != deployer) revert NotDeployer();
        if (newAttester == address(0)) revert ZeroAddress();
        address previous = attester;
        attester = newAttester;
        emit AttesterChanged(previous, newAttester);
    }
}
```

- [ ] **Step 4: 한글 주석 오타를 고친다**

Step 3의 주석에 한글이 섞였다(`証s`). 코드와 주석은 영어라는 제약대로 고친다.

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/contracts
python3 - <<'PY'
import pathlib
p = pathlib.Path("src/libs/AttesterRole.sol")
p.write_text(p.read_text().replace('証s "this human passed KYC"', 'attests "this human passed KYC"'))
PY
grep -n "attests" src/libs/AttesterRole.sol
```
Expected: `attests "this human passed KYC"` 한 줄이 보인다.

- [ ] **Step 5: 테스트가 통과하는지 확인한다**

Run: `cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/contracts && forge test --match-path test/AttesterRole.t.sol -vv`
Expected: PASS — 5 tests passed (`test_attesterCanCall`, `test_strangerCannotCall`, `test_deployerRotatesAttester`, `test_nonDeployerCannotRotateAttester`, `test_zeroAttesterRejected`).

- [ ] **Step 6: 커밋**

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI
git add contracts/src/libs/AttesterRole.sol contracts/test/AttesterRole.t.sol
git commit -m "feat(contracts): add AttesterRole with deployer-controlled attester rotation"
```

---

## Task 4: Identity — 등록과 조회

**Files:**
- Create: `contracts/src/interfaces/IIdentity.sol`
- Create: `contracts/src/Identity.sol`
- Test: `contracts/test/Identity.t.sol`

**Interfaces:**
- Consumes: `AttesterRole`(Task 3) — `onlyAttester`, `attester`, `deployer`, `NotAttester`
- Produces:
  - `contract Identity is AttesterRole` — `constructor(address attester_)`
  - `function register(bytes32 personId, address account, bytes32 deviceX, bytes32 deviceY, uint8 kycLevel) external` (onlyAttester) — `kycLevel` 0 = 문자+패스키만, 1 = 신분증+얼굴 확인 완료
  - `function setKycLevel(bytes32 personId, uint8 level) external` (onlyAttester), view `kycLevelOf(address) returns (uint8)`, `event KycLevelSet(address indexed account, uint8 level)`
  - views `accountOf(bytes32) returns (address)`, `personOf(address) returns (bytes32)`, `isMember(address) returns (bool)`, `activeDevice(address) returns (bytes32 x, bytes32 y)`, `isLocked(address) returns (bool)`, `deviceUpdatedAt(address) returns (uint64)`, `attester() returns (address)`(AttesterRole의 public 변수가 자동 생성)
  - `event Registered(bytes32 indexed personId, address indexed account)`, `event DeviceChanged(address indexed account, bytes32 x, bytes32 y)`
  - `uint256 public constant ROTATION_COOLDOWN = 7 days`, `uint256 public constant DEVICE_COOLDOWN = 7 days`
  - `interface IIdentity` — `Ticket`(Task 14~)와 `MontiPaymaster`(Task 25~)가 이것만 본다
  - 이 태스크가 `Identity.sol`의 **스토리지 전체**를 미리 선언한다. Task 5~8은 함수만 덧붙인다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`contracts/test/Identity.t.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {Test} from "forge-std/Test.sol";
import {Identity} from "../src/Identity.sol";
import {AttesterRole} from "../src/libs/AttesterRole.sol";

contract IdentityTest is Test {
    Identity internal identity;

    address internal constant ATTESTER = address(0xA11CE);
    address internal constant ALICE = address(0xA1);
    address internal constant BOB = address(0xB0B);
    bytes32 internal constant PERSON_A = bytes32(uint256(0xAAAA));
    bytes32 internal constant PERSON_B = bytes32(uint256(0xBBBB));
    bytes32 internal constant DEV_X = bytes32(uint256(0x1111));
    bytes32 internal constant DEV_Y = bytes32(uint256(0x2222));

    event Registered(bytes32 indexed personId, address indexed account);
    event DeviceChanged(address indexed account, bytes32 x, bytes32 y);
    event KycLevelSet(address indexed account, uint8 level);

    function setUp() public {
        identity = new Identity(ATTESTER);
        vm.warp(1_800_000_000);
    }

    function test_registerStoresBothDirectionsAndDevice() public {
        vm.expectEmit(true, true, false, false);
        emit Registered(PERSON_A, ALICE);
        vm.expectEmit(true, false, false, true);
        emit DeviceChanged(ALICE, DEV_X, DEV_Y);

        vm.prank(ATTESTER);
        identity.register(PERSON_A, ALICE, DEV_X, DEV_Y, 1);

        assertEq(identity.accountOf(PERSON_A), ALICE);
        assertEq(identity.personOf(ALICE), PERSON_A);
        assertTrue(identity.isMember(ALICE));
        assertFalse(identity.isMember(BOB));
        (bytes32 x, bytes32 y) = identity.activeDevice(ALICE);
        assertEq(x, DEV_X);
        assertEq(y, DEV_Y);
        assertEq(identity.deviceUpdatedAt(ALICE), uint64(block.timestamp));
        assertFalse(identity.isLocked(ALICE));
        assertEq(identity.kycLevelOf(ALICE), 1);
    }

    function test_onlyAttesterRegisters() public {
        vm.prank(ALICE);
        vm.expectRevert(AttesterRole.NotAttester.selector);
        identity.register(PERSON_A, ALICE, DEV_X, DEV_Y, 1);
    }

    function test_personIdCannotBeRegisteredTwice() public {
        vm.startPrank(ATTESTER);
        identity.register(PERSON_A, ALICE, DEV_X, DEV_Y, 1);
        vm.expectRevert(Identity.PersonAlreadyRegistered.selector);
        identity.register(PERSON_A, BOB, DEV_X, DEV_Y, 1);
        vm.stopPrank();
    }

    function test_accountCannotBeRegisteredTwice() public {
        vm.startPrank(ATTESTER);
        identity.register(PERSON_A, ALICE, DEV_X, DEV_Y, 1);
        vm.expectRevert(Identity.AccountAlreadyRegistered.selector);
        identity.register(PERSON_B, ALICE, DEV_X, DEV_Y, 1);
        vm.stopPrank();
    }

    function test_registerRejectsZeroValues() public {
        vm.startPrank(ATTESTER);
        vm.expectRevert(Identity.InvalidPersonId.selector);
        identity.register(bytes32(0), ALICE, DEV_X, DEV_Y, 1);
        vm.expectRevert(Identity.InvalidAccount.selector);
        identity.register(PERSON_A, address(0), DEV_X, DEV_Y, 1);
        vm.expectRevert(Identity.InvalidDeviceKey.selector);
        identity.register(PERSON_A, ALICE, bytes32(0), DEV_Y, 1);
        vm.stopPrank();
    }

    function test_cooldownConstantsAreSevenDays() public view {
        assertEq(identity.ROTATION_COOLDOWN(), 7 days);
        assertEq(identity.DEVICE_COOLDOWN(), 7 days);
    }

    function test_registerStoresTheKycLevel() public {
        vm.startPrank(ATTESTER);
        identity.register(PERSON_A, ALICE, DEV_X, DEV_Y, 0);
        identity.register(PERSON_B, BOB, DEV_X, DEV_Y, 1);
        vm.stopPrank();
        assertEq(identity.kycLevelOf(ALICE), 0);
        assertEq(identity.kycLevelOf(BOB), 1);
    }

    function test_attesterRaisesKycLevelAfterALaterKycSession() public {
        vm.prank(ATTESTER);
        identity.register(PERSON_A, ALICE, DEV_X, DEV_Y, 0);

        vm.expectEmit(true, false, false, true);
        emit KycLevelSet(ALICE, 1);
        vm.prank(ATTESTER);
        identity.setKycLevel(PERSON_A, 1);
        assertEq(identity.kycLevelOf(ALICE), 1);
    }

    function test_onlyAttesterSetsKycLevel() public {
        vm.prank(ATTESTER);
        identity.register(PERSON_A, ALICE, DEV_X, DEV_Y, 0);
        vm.prank(ALICE);
        vm.expectRevert(AttesterRole.NotAttester.selector);
        identity.setKycLevel(PERSON_A, 1);

        vm.prank(ATTESTER);
        vm.expectRevert(Identity.NotRegistered.selector);
        identity.setKycLevel(bytes32(uint256(0xDEAD)), 1);
    }
}
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/contracts && forge test --match-path test/Identity.t.sol`
Expected: FAIL — `Source "src/Identity.sol" not found`.

- [ ] **Step 3: 인터페이스를 쓴다**

`contracts/src/interfaces/IIdentity.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

/// @notice The slice of Identity that Ticket and MontiPaymaster are allowed to see.
interface IIdentity {
    function accountOf(bytes32 personId) external view returns (address);
    function personOf(address account) external view returns (bytes32);
    function isMember(address account) external view returns (bool);
    function activeDevice(address account) external view returns (bytes32 x, bytes32 y);
    function isLocked(address account) external view returns (bool);
    function deviceUpdatedAt(address account) external view returns (uint64);
    function attester() external view returns (address);
    function kycLevelOf(address account) external view returns (uint8);
    function nicknameOwner(bytes32 nicknameHash) external view returns (address);
    function nicknameOf(address account) external view returns (bytes32);
}
```

- [ ] **Step 4: `Identity.sol`의 스토리지와 `register`를 쓴다**

`contracts/src/Identity.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {AttesterRole} from "./libs/AttesterRole.sol";
import {IIdentity} from "./interfaces/IIdentity.sol";

/// @title Identity
/// @notice personId is 32 random bytes (spec 10.2) — never a hash of anything. This contract is the
///         only on-chain link between a random personId, a smart account, and one active P-256
///         device key. No PII ever reaches this contract.
contract Identity is IIdentity, AttesterRole {
    struct Device {
        bytes32 x;
        bytes32 y;
        uint64 updatedAt;
        bool locked;
    }

    uint256 public constant ROTATION_COOLDOWN = 7 days;
    uint256 public constant DEVICE_COOLDOWN = 7 days;

    mapping(bytes32 => address) private _accountOf;
    mapping(address => bytes32) private _personOf;
    mapping(bytes32 => uint64) private _rotatedAt;
    mapping(address => Device) private _devices;
    mapping(address => uint8) private _kycLevel;
    mapping(bytes32 => address) private _nicknameOwner;
    mapping(address => bytes32) private _nicknameOf;

    event Registered(bytes32 indexed personId, address indexed account);
    event AccountRotated(bytes32 indexed personId, address indexed oldAccount, address indexed newAccount);
    event DeviceChanged(address indexed account, bytes32 x, bytes32 y);
    event DeviceLocked(address indexed account, bool locked);
    event NicknameSet(address indexed account, bytes32 indexed nicknameHash, string nickname);
    event KycLevelSet(address indexed account, uint8 level);

    error PersonAlreadyRegistered();
    error AccountAlreadyRegistered();
    error InvalidPersonId();
    error InvalidAccount();
    error InvalidDeviceKey();
    error NotRegistered();
    error NotAccountOwner();
    error CooldownActive();
    error NicknameTaken();
    error NicknameHashMismatch();

    constructor(address attester_) AttesterRole(attester_) {}

    /// @param kycLevel 0 = phone + passkey only, 1 = ID and face verified by the attester (spec 9.2).
    function register(bytes32 personId, address account, bytes32 deviceX, bytes32 deviceY, uint8 kycLevel)
        external
        onlyAttester
    {
        if (personId == bytes32(0)) revert InvalidPersonId();
        if (account == address(0)) revert InvalidAccount();
        if (deviceX == bytes32(0) || deviceY == bytes32(0)) revert InvalidDeviceKey();
        if (_accountOf[personId] != address(0)) revert PersonAlreadyRegistered();
        if (_personOf[account] != bytes32(0)) revert AccountAlreadyRegistered();

        _accountOf[personId] = account;
        _personOf[account] = personId;
        _rotatedAt[personId] = uint64(block.timestamp);
        _devices[account] = Device({x: deviceX, y: deviceY, updatedAt: uint64(block.timestamp), locked: false});
        _kycLevel[account] = kycLevel;

        emit Registered(personId, account);
        emit DeviceChanged(account, deviceX, deviceY);
        emit KycLevelSet(account, kycLevel);
    }

    /// @notice Raises (or lowers) the verification level after a later Didit session. Attester only:
    ///         the chain never learns what was verified, only that our KMS key says it was.
    function setKycLevel(bytes32 personId, uint8 level) external onlyAttester {
        address account = _accountOf[personId];
        if (account == address(0)) revert NotRegistered();
        _kycLevel[account] = level;
        emit KycLevelSet(account, level);
    }

    function accountOf(bytes32 personId) external view returns (address) {
        return _accountOf[personId];
    }

    function personOf(address account) external view returns (bytes32) {
        return _personOf[account];
    }

    /// @dev A rotated-away account keeps its personOf mapping (migrate needs it) but stops being a member.
    function isMember(address account) public view returns (bool) {
        bytes32 personId = _personOf[account];
        return personId != bytes32(0) && _accountOf[personId] == account;
    }

    function activeDevice(address account) external view returns (bytes32 x, bytes32 y) {
        Device storage d = _devices[account];
        return (d.x, d.y);
    }

    function isLocked(address account) external view returns (bool) {
        return _devices[account].locked;
    }

    function deviceUpdatedAt(address account) external view returns (uint64) {
        return _devices[account].updatedAt;
    }

    function kycLevelOf(address account) external view returns (uint8) {
        return _kycLevel[account];
    }

    function nicknameOwner(bytes32 nicknameHash) external view returns (address) {
        return _nicknameOwner[nicknameHash];
    }

    function nicknameOf(address account) external view returns (bytes32) {
        return _nicknameOf[account];
    }
}
```

- [ ] **Step 5: 테스트가 통과하는지 확인한다**

Run: `cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/contracts && forge test --match-path test/Identity.t.sol -vv`
Expected: PASS — 9 tests passed. `AttesterRole`의 `attester` public 변수가 `IIdentity.attester()`를 만족하므로 별도 구현이 필요 없다.

- [ ] **Step 6: 커밋**

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI
git add contracts/src/Identity.sol contracts/src/interfaces/IIdentity.sol contracts/test/Identity.t.sol
git commit -m "feat(contracts): Identity.register with random personId and active device key"
```

---

## Task 5: Identity — 활성 기기 변경과 7일 쿨타임

**Files:**
- Modify: `contracts/src/Identity.sol` (함수 추가)
- Test: `contracts/test/Identity.t.sol` (테스트 추가)

**Interfaces:**
- Consumes: Task 4의 `Identity`, `DEVICE_COOLDOWN`, `_devices`, `isMember`
- Produces: `function setActiveDevice(bytes32 x, bytes32 y) external` — msg.sender가 등록된 계정이어야 하고, 마지막 등록 후 `DEVICE_COOLDOWN`(7일)이 지나야 한다. 기기를 새로 등록하면 잠금이 풀린다(`DeviceLocked(account, false)`).

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`contracts/test/Identity.t.sol` 끝(마지막 `}` 직전)에 붙인다:

```solidity
    function test_setActiveDeviceRequiresMembership() public {
        vm.prank(BOB);
        vm.expectRevert(Identity.NotRegistered.selector);
        identity.setActiveDevice(DEV_X, DEV_Y);
    }

    function test_setActiveDeviceBlockedBeforeSevenDays() public {
        vm.prank(ATTESTER);
        identity.register(PERSON_A, ALICE, DEV_X, DEV_Y, 1);

        vm.warp(block.timestamp + 7 days - 1);
        vm.prank(ALICE);
        vm.expectRevert(Identity.CooldownActive.selector);
        identity.setActiveDevice(bytes32(uint256(0x3333)), bytes32(uint256(0x4444)));
    }

    function test_setActiveDeviceAllowedAfterSevenDays() public {
        vm.prank(ATTESTER);
        identity.register(PERSON_A, ALICE, DEV_X, DEV_Y, 1);

        vm.warp(block.timestamp + 7 days);
        vm.expectEmit(true, false, false, true);
        emit DeviceChanged(ALICE, bytes32(uint256(0x3333)), bytes32(uint256(0x4444)));
        vm.prank(ALICE);
        identity.setActiveDevice(bytes32(uint256(0x3333)), bytes32(uint256(0x4444)));

        (bytes32 x, bytes32 y) = identity.activeDevice(ALICE);
        assertEq(x, bytes32(uint256(0x3333)));
        assertEq(y, bytes32(uint256(0x4444)));
        assertEq(identity.deviceUpdatedAt(ALICE), uint64(block.timestamp));
    }

    function test_setActiveDeviceRejectsZeroKey() public {
        vm.prank(ATTESTER);
        identity.register(PERSON_A, ALICE, DEV_X, DEV_Y, 1);
        vm.warp(block.timestamp + 7 days);
        vm.prank(ALICE);
        vm.expectRevert(Identity.InvalidDeviceKey.selector);
        identity.setActiveDevice(bytes32(0), bytes32(uint256(0x4444)));
    }
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/contracts && forge test --match-test "setActiveDevice"`
Expected: FAIL — `Member "setActiveDevice" not found or not visible after argument-dependent lookup in contract Identity`.

- [ ] **Step 3: 구현을 쓴다**

`contracts/src/Identity.sol`의 `nicknameOwner` 뷰 위(즉 뷰 블록 시작 직전)에 넣는다:

```solidity
    /// @notice Register this phone's hardware key as the one key allowed to sign check-ins.
    ///         Spec 9.3: one active device per account, 7-day cooldown enforced by the contract.
    ///         Registering a fresh device also clears a lock — that is the on-chain recovery path.
    function setActiveDevice(bytes32 x, bytes32 y) external {
        if (!isMember(msg.sender)) revert NotRegistered();
        if (x == bytes32(0) || y == bytes32(0)) revert InvalidDeviceKey();

        Device storage d = _devices[msg.sender];
        if (d.updatedAt != 0 && block.timestamp < uint256(d.updatedAt) + DEVICE_COOLDOWN) revert CooldownActive();

        bool wasLocked = d.locked;
        d.x = x;
        d.y = y;
        d.updatedAt = uint64(block.timestamp);
        d.locked = false;

        emit DeviceChanged(msg.sender, x, y);
        if (wasLocked) emit DeviceLocked(msg.sender, false);
    }
```

- [ ] **Step 4: 테스트가 통과하는지 확인한다**

Run: `cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/contracts && forge test --match-path test/Identity.t.sol -vv`
Expected: PASS — 13 tests passed.

- [ ] **Step 5: 경계값을 정확히 맞췄는지 다시 읽는다**

`test_setActiveDeviceBlockedBeforeSevenDays`는 `7 days - 1`에서 revert, `test_setActiveDeviceAllowedAfterSevenDays`는 정확히 `7 days`에서 통과다. 구현의 비교식이 `<`(미만일 때만 거부)이어야 이 둘이 동시에 성립한다. `<=`로 썼다면 두 번째 테스트가 깨진다.

Run: `cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/contracts && grep -n "CooldownActive" src/Identity.sol`
Expected: `if (d.updatedAt != 0 && block.timestamp < uint256(d.updatedAt) + DEVICE_COOLDOWN) revert CooldownActive();` 한 줄이 보인다.

- [ ] **Step 6: 커밋**

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI
git add contracts/src/Identity.sol contracts/test/Identity.t.sol
git commit -m "feat(contracts): Identity.setActiveDevice with 7-day device cooldown"
```

---

## Task 6: Identity — 기기 잠금

**Files:**
- Modify: `contracts/src/Identity.sol` (함수 추가)
- Test: `contracts/test/Identity.t.sol` (테스트 추가)

**Interfaces:**
- Consumes: Task 4~5의 `Identity`, `_devices`, `isMember`
- Produces: `function lockDevice(address account) external` — 계정 본인 또는 어테스터만. 잠금은 즉시, 해제는 `setActiveDevice`로만(Task 5). `isLocked(account)`가 `true`가 되고 `Ticket.checkIn`(Task 20)이 이를 읽어 거부한다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`contracts/test/Identity.t.sol`에 붙인다:

```solidity
    event DeviceLocked(address indexed account, bool locked);

    function test_accountLocksItsOwnDevice() public {
        vm.prank(ATTESTER);
        identity.register(PERSON_A, ALICE, DEV_X, DEV_Y, 1);

        vm.expectEmit(true, false, false, true);
        emit DeviceLocked(ALICE, true);
        vm.prank(ALICE);
        identity.lockDevice(ALICE);

        assertTrue(identity.isLocked(ALICE));
    }

    function test_attesterLocksDevice() public {
        vm.prank(ATTESTER);
        identity.register(PERSON_A, ALICE, DEV_X, DEV_Y, 1);

        vm.prank(ATTESTER);
        identity.lockDevice(ALICE);
        assertTrue(identity.isLocked(ALICE));
    }

    function test_strangerCannotLockDevice() public {
        vm.prank(ATTESTER);
        identity.register(PERSON_A, ALICE, DEV_X, DEV_Y, 1);

        vm.prank(BOB);
        vm.expectRevert(Identity.NotAccountOwner.selector);
        identity.lockDevice(ALICE);
    }

    function test_newDeviceAfterCooldownClearsLock() public {
        vm.prank(ATTESTER);
        identity.register(PERSON_A, ALICE, DEV_X, DEV_Y, 1);
        vm.prank(ALICE);
        identity.lockDevice(ALICE);

        vm.warp(block.timestamp + 7 days);
        vm.prank(ALICE);
        identity.setActiveDevice(bytes32(uint256(0x3333)), bytes32(uint256(0x4444)));

        assertFalse(identity.isLocked(ALICE));
    }
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/contracts && forge test --match-test "LockDevice|lockDevice|ClearsLock"`
Expected: FAIL — `Member "lockDevice" not found or not visible after argument-dependent lookup in contract Identity`.

- [ ] **Step 3: 구현을 쓴다**

`contracts/src/Identity.sol`의 `setActiveDevice` 바로 아래에 넣는다:

```solidity
    /// @notice Spec 5.5 / 9.3: the attendee (from any device or the web) or the attester can lock the
    ///         active device instantly. While locked, Ticket.checkIn refuses this account.
    function lockDevice(address account) external {
        if (msg.sender != account && msg.sender != attester) revert NotAccountOwner();
        if (_personOf[account] == bytes32(0)) revert NotRegistered();

        _devices[account].locked = true;
        emit DeviceLocked(account, true);
    }
```

- [ ] **Step 4: 테스트가 통과하는지 확인한다**

Run: `cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/contracts && forge test --match-path test/Identity.t.sol -vv`
Expected: PASS — 17 tests passed.

- [ ] **Step 5: 커밋**

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI
git add contracts/src/Identity.sol contracts/test/Identity.t.sol
git commit -m "feat(contracts): Identity.lockDevice by owner or attester"
```

---

## Task 7: Identity — 계정 교체(rotateAccount)와 7일 쿨타임

**Files:**
- Modify: `contracts/src/Identity.sol` (함수 추가)
- Test: `contracts/test/Identity.t.sol` (테스트 추가)

**Interfaces:**
- Consumes: Task 4의 `_accountOf`, `_personOf`, `_rotatedAt`, `ROTATION_COOLDOWN`, `onlyAttester`
- Produces: `function rotateAccount(bytes32 personId, address newAccount) external` (onlyAttester, 마지막 교체 후 7일). 교체 후 옛 계정은 `isMember == false`지만 `personOf(old)`는 그대로 남는다 — `Ticket.migrate`(Task 23)가 그 값을 읽어 "이 티켓의 주인이던 사람의 현재 계정"을 찾는다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

```solidity
    event AccountRotated(bytes32 indexed personId, address indexed oldAccount, address indexed newAccount);

    function test_rotateAccountMovesMembershipAndKeepsPersonOfOldAccount() public {
        vm.prank(ATTESTER);
        identity.register(PERSON_A, ALICE, DEV_X, DEV_Y, 1);
        vm.warp(block.timestamp + 7 days);

        vm.expectEmit(true, true, true, false);
        emit AccountRotated(PERSON_A, ALICE, BOB);
        vm.prank(ATTESTER);
        identity.rotateAccount(PERSON_A, BOB);

        assertEq(identity.accountOf(PERSON_A), BOB);
        assertEq(identity.personOf(BOB), PERSON_A);
        assertEq(identity.personOf(ALICE), PERSON_A, "migrate needs the old link");
        assertFalse(identity.isMember(ALICE));
        assertTrue(identity.isMember(BOB));
    }

    function test_rotateAccountBlockedBeforeSevenDays() public {
        vm.prank(ATTESTER);
        identity.register(PERSON_A, ALICE, DEV_X, DEV_Y, 1);
        vm.warp(block.timestamp + 7 days - 1);
        vm.prank(ATTESTER);
        vm.expectRevert(Identity.CooldownActive.selector);
        identity.rotateAccount(PERSON_A, BOB);
    }

    function test_onlyAttesterRotates() public {
        vm.prank(ATTESTER);
        identity.register(PERSON_A, ALICE, DEV_X, DEV_Y, 1);
        vm.warp(block.timestamp + 7 days);
        vm.prank(ALICE);
        vm.expectRevert(AttesterRole.NotAttester.selector);
        identity.rotateAccount(PERSON_A, BOB);
    }

    function test_rotateRejectsUnknownPersonOrUsedAccount() public {
        vm.startPrank(ATTESTER);
        identity.register(PERSON_A, ALICE, DEV_X, DEV_Y, 1);
        identity.register(PERSON_B, BOB, DEV_X, DEV_Y, 1);
        vm.warp(block.timestamp + 7 days);
        vm.expectRevert(Identity.NotRegistered.selector);
        identity.rotateAccount(bytes32(uint256(0xDEAD)), address(0xC0FFEE));
        vm.expectRevert(Identity.AccountAlreadyRegistered.selector);
        identity.rotateAccount(PERSON_A, BOB);
        vm.stopPrank();
    }

    function test_newAccountHasNoDeviceUntilItSetsOne() public {
        vm.prank(ATTESTER);
        identity.register(PERSON_A, ALICE, DEV_X, DEV_Y, 1);
        vm.warp(block.timestamp + 7 days);
        vm.prank(ATTESTER);
        identity.rotateAccount(PERSON_A, BOB);

        (bytes32 x, bytes32 y) = identity.activeDevice(BOB);
        assertEq(x, bytes32(0));
        assertEq(y, bytes32(0));

        // updatedAt == 0 means "never set", so the new phone can register immediately.
        vm.prank(BOB);
        identity.setActiveDevice(DEV_X, DEV_Y);
        (x, y) = identity.activeDevice(BOB);
        assertEq(x, DEV_X);
    }
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/contracts && forge test --match-test "rotate|Rotate"`
Expected: FAIL — `Member "rotateAccount" not found or not visible after argument-dependent lookup in contract Identity`.

- [ ] **Step 3: 구현을 쓴다**

`contracts/src/Identity.sol`의 `register` 바로 아래에 넣는다:

```solidity
    /// @notice Spec 5.5: passkey lost -> new passkey -> the attester swaps the account on chain.
    ///         7-day cooldown is the SIM-swap defence (spec 18 risk table). The old account keeps its
    ///         personOf entry so Ticket.migrate can find the new account from an old ticket.
    function rotateAccount(bytes32 personId, address newAccount) external onlyAttester {
        address oldAccount = _accountOf[personId];
        if (oldAccount == address(0)) revert NotRegistered();
        if (newAccount == address(0)) revert InvalidAccount();
        if (_personOf[newAccount] != bytes32(0)) revert AccountAlreadyRegistered();
        if (block.timestamp < uint256(_rotatedAt[personId]) + ROTATION_COOLDOWN) revert CooldownActive();

        _accountOf[personId] = newAccount;
        _personOf[newAccount] = personId;
        _rotatedAt[personId] = uint64(block.timestamp);

        bytes32 nick = _nicknameOf[oldAccount];
        if (nick != bytes32(0)) {
            delete _nicknameOf[oldAccount];
            _nicknameOf[newAccount] = nick;
            _nicknameOwner[nick] = newAccount;
        }

        emit AccountRotated(personId, oldAccount, newAccount);
    }
```

- [ ] **Step 4: 테스트가 통과하는지 확인한다**

Run: `cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/contracts && forge test --match-path test/Identity.t.sol -vv`
Expected: PASS — 22 tests passed.

- [ ] **Step 5: 커밋**

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI
git add contracts/src/Identity.sol contracts/test/Identity.t.sol
git commit -m "feat(contracts): Identity.rotateAccount with 7-day rotation cooldown"
```

---

## Task 8: Identity — 닉네임(고유, 양도 초대용)

**Files:**
- Modify: `contracts/src/Identity.sol` (함수 추가)
- Test: `contracts/test/IdentityNickname.t.sol`

**Interfaces:**
- Consumes: Task 4의 `_nicknameOwner`, `_nicknameOf`, `isMember`, `NicknameTaken`, `NicknameHashMismatch`, `NicknameSet`
- Produces: `function setNickname(bytes32 nicknameHash, string calldata nickname) external`, views `nicknameOwner(bytes32) returns (address)`, `nicknameOf(address) returns (bytes32)`. 정규화(소문자, 3~20자, `[a-z0-9_]`)는 클라이언트가 하고 체인은 해시 일치와 고유성만 강제한다 — 서브플랜 03의 양도 화면이 전화번호 대신 닉네임으로 회원을 찾는다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`contracts/test/IdentityNickname.t.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {Test} from "forge-std/Test.sol";
import {Identity} from "../src/Identity.sol";

contract IdentityNicknameTest is Test {
    Identity internal identity;
    address internal constant ATTESTER = address(0xA11CE);
    address internal constant ALICE = address(0xA1);
    address internal constant BOB = address(0xB0B);
    bytes32 internal constant PERSON_A = bytes32(uint256(0xAAAA));
    bytes32 internal constant PERSON_B = bytes32(uint256(0xBBBB));
    bytes32 internal constant DEV_X = bytes32(uint256(0x1111));
    bytes32 internal constant DEV_Y = bytes32(uint256(0x2222));

    event NicknameSet(address indexed account, bytes32 indexed nicknameHash, string nickname);

    function setUp() public {
        identity = new Identity(ATTESTER);
        vm.warp(1_800_000_000);
        vm.startPrank(ATTESTER);
        identity.register(PERSON_A, ALICE, DEV_X, DEV_Y, 1);
        identity.register(PERSON_B, BOB, DEV_X, DEV_Y, 1);
        vm.stopPrank();
    }

    function _h(string memory s) internal pure returns (bytes32) {
        return keccak256(bytes(s));
    }

    function test_setNicknameStoresBothDirections() public {
        vm.expectEmit(true, true, false, true);
        emit NicknameSet(ALICE, _h("alice_01"), "alice_01");
        vm.prank(ALICE);
        identity.setNickname(_h("alice_01"), "alice_01");

        assertEq(identity.nicknameOwner(_h("alice_01")), ALICE);
        assertEq(identity.nicknameOf(ALICE), _h("alice_01"));
    }

    function test_nicknameMustBeUnique() public {
        vm.prank(ALICE);
        identity.setNickname(_h("alice_01"), "alice_01");

        vm.prank(BOB);
        vm.expectRevert(Identity.NicknameTaken.selector);
        identity.setNickname(_h("alice_01"), "alice_01");
    }

    function test_resettingNicknameFreesThePreviousOne() public {
        vm.startPrank(ALICE);
        identity.setNickname(_h("alice_01"), "alice_01");
        identity.setNickname(_h("alice_02"), "alice_02");
        vm.stopPrank();

        assertEq(identity.nicknameOwner(_h("alice_01")), address(0));
        assertEq(identity.nicknameOwner(_h("alice_02")), ALICE);
        assertEq(identity.nicknameOf(ALICE), _h("alice_02"));

        vm.prank(BOB);
        identity.setNickname(_h("alice_01"), "alice_01");
        assertEq(identity.nicknameOwner(_h("alice_01")), BOB);
    }

    function test_hashMustMatchTheString() public {
        vm.prank(ALICE);
        vm.expectRevert(Identity.NicknameHashMismatch.selector);
        identity.setNickname(_h("alice_01"), "alice_02");
    }

    function test_nonMemberCannotSetNickname() public {
        vm.prank(address(0xDEAD));
        vm.expectRevert(Identity.NotRegistered.selector);
        identity.setNickname(_h("ghost"), "ghost");
    }

    function test_settingTheSameNicknameTwiceIsANoOpNotARevert() public {
        vm.startPrank(ALICE);
        identity.setNickname(_h("alice_01"), "alice_01");
        identity.setNickname(_h("alice_01"), "alice_01");
        vm.stopPrank();
        assertEq(identity.nicknameOwner(_h("alice_01")), ALICE);
    }
}
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/contracts && forge test --match-path test/IdentityNickname.t.sol`
Expected: FAIL — `Member "setNickname" not found or not visible after argument-dependent lookup in contract Identity`.

- [ ] **Step 3: 구현을 쓴다**

`contracts/src/Identity.sol`의 `lockDevice` 아래에 넣는다:

```solidity
    /// @notice A unique handle so attendees can hand a ticket to "alice_01" instead of an address.
    ///         Normalisation (lowercase, 3-20 chars of [a-z0-9_]) happens client-side; the chain only
    ///         enforces that the hash matches the string and that the handle is free.
    function setNickname(bytes32 nicknameHash, string calldata nickname) external {
        if (!isMember(msg.sender)) revert NotRegistered();
        if (nicknameHash != keccak256(bytes(nickname))) revert NicknameHashMismatch();

        address holder = _nicknameOwner[nicknameHash];
        if (holder == msg.sender) return;
        if (holder != address(0)) revert NicknameTaken();

        bytes32 previous = _nicknameOf[msg.sender];
        if (previous != bytes32(0)) delete _nicknameOwner[previous];

        _nicknameOwner[nicknameHash] = msg.sender;
        _nicknameOf[msg.sender] = nicknameHash;

        emit NicknameSet(msg.sender, nicknameHash, nickname);
    }
```

- [ ] **Step 4: 테스트가 통과하는지 확인한다**

Run: `cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/contracts && forge test --match-path test/IdentityNickname.t.sol -vv`
Expected: PASS — 6 tests passed.

- [ ] **Step 5: Identity 전체를 회귀 확인한다**

Run: `cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/contracts && forge test --match-path "test/Identity*.t.sol" -vv`
Expected: PASS — 28 tests passed (Identity.t.sol 22 + IdentityNickname.t.sol 6). `rotateAccount`가 닉네임을 새 계정으로 옮기는 코드(Task 7 Step 3)가 컴파일된 상태여야 한다.

- [ ] **Step 6: 커밋**

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI
git add contracts/src/Identity.sol contracts/test/IdentityNickname.t.sol
git commit -m "feat(contracts): unique on-chain nicknames for transfer invites"
```

---

## Task 9: Organizers — 조직 생성과 티켓 컨트랙트 연결

**Files:**
- Create: `contracts/src/interfaces/ITicket.sol`
- Create: `contracts/src/interfaces/IOrganizers.sol`
- Create: `contracts/src/Organizers.sol`
- Test: `contracts/test/Organizers.t.sol`

**Interfaces:**
- Consumes: 없음(Identity와 독립)
- Produces: `contract Organizers`, `constructor()`(배포자 기록), `createOrganizer(address owner) returns (uint256 orgId)`, `ownerOf(uint256) returns (address)`, `transferOwner(uint256,address)`, `setTicket(address ticket) external`(deployer, 1회), `event OrganizerCreated(uint256 indexed orgId, address indexed owner)`, `event OwnerTransferred(uint256 indexed orgId, address indexed from, address indexed to)`. `interface ITicket { function eventOrg(uint256) external view returns (uint256); }`. `interface IOrganizers`(Ticket·Paymaster가 읽는 부분 전체).

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`contracts/test/Organizers.t.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {Test} from "forge-std/Test.sol";
import {Organizers} from "../src/Organizers.sol";

contract OrganizersTest is Test {
    Organizers internal orgs;
    address internal constant OWNER = address(0x01);
    address internal constant OTHER = address(0x02);

    event OrganizerCreated(uint256 indexed orgId, address indexed owner);
    event OwnerTransferred(uint256 indexed orgId, address indexed from, address indexed to);

    function setUp() public {
        orgs = new Organizers();
        vm.warp(1_800_000_000);
    }

    function test_createOrganizerStartsAtOneAndIncrements() public {
        vm.expectEmit(true, true, false, false);
        emit OrganizerCreated(1, OWNER);
        uint256 a = orgs.createOrganizer(OWNER);
        uint256 b = orgs.createOrganizer(OTHER);
        assertEq(a, 1);
        assertEq(b, 2);
        assertEq(orgs.ownerOf(1), OWNER);
        assertEq(orgs.ownerOf(2), OTHER);
    }

    function test_ownerTransfer() public {
        orgs.createOrganizer(OWNER);
        vm.expectEmit(true, true, true, false);
        emit OwnerTransferred(1, OWNER, OTHER);
        vm.prank(OWNER);
        orgs.transferOwner(1, OTHER);
        assertEq(orgs.ownerOf(1), OTHER);
    }

    function test_nonOwnerCannotTransfer() public {
        orgs.createOrganizer(OWNER);
        vm.prank(OTHER);
        vm.expectRevert(Organizers.NotOwner.selector);
        orgs.transferOwner(1, OTHER);
    }

    function test_setTicketOnlyOnceAndOnlyDeployer() public {
        orgs.setTicket(address(0xT1CKE7));
        assertEq(orgs.ticket(), address(0xT1CKE7));
        vm.expectRevert(Organizers.TicketAlreadySet.selector);
        orgs.setTicket(address(0xBEEF));
        Organizers fresh = new Organizers();
        vm.prank(OTHER);
        vm.expectRevert(Organizers.NotDeployer.selector);
        fresh.setTicket(address(0xBEEF));
    }
}
```

`address(0xT1CKE7)`는 유효한 16진수가 아니다. 다음 단계에서 고친다 — 일부러 넣은 오타가 아니라 주소 리터럴은 반드시 16진수여야 한다는 점을 잊기 쉬워서 명시한다.

- [ ] **Step 2: 주소 리터럴을 고치고 실패를 확인한다**

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/contracts
python3 - <<'PY'
import pathlib
p = pathlib.Path("test/Organizers.t.sol")
p.write_text(p.read_text().replace("address(0xT1CKE7)", "address(0x7107)"))
PY
forge test --match-path test/Organizers.t.sol
```
Expected: FAIL — `Source "src/Organizers.sol" not found`.

- [ ] **Step 3: 인터페이스 두 개를 쓴다**

`contracts/src/interfaces/ITicket.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

/// @notice The only thing Organizers is allowed to ask Ticket.
interface ITicket {
    function eventOrg(uint256 eventId) external view returns (uint256);
}
```

`contracts/src/interfaces/IOrganizers.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

/// @notice The slice of Organizers that Ticket and MontiPaymaster are allowed to see.
interface IOrganizers {
    function ownerOf(uint256 orgId) external view returns (address);
    function hasPermission(uint256 orgId, address account, uint32 bit) external view returns (bool);
    function managerOf(uint256 orgId, address account) external view returns (bool exists, bool canApprove);
    function gateOf(address gateAccount) external view returns (uint256 gateId);
    function gateInfo(uint256 gateId)
        external
        view
        returns (uint256 eventId, address account, bytes32 kx, bytes32 ky, bool open, bool revoked);
    function isOpenGate(uint256 eventId, address gateAccount) external view returns (bool);
}
```

- [ ] **Step 4: `Organizers.sol`의 스토리지와 조직 함수를 쓴다**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {IOrganizers} from "./interfaces/IOrganizers.sol";
import {ITicket} from "./interfaces/ITicket.sol";

/// @title Organizers
/// @notice The on-chain allowlist (spec 9.4). A role that is not in here does not exist. Nothing in
///         this contract is cached off-chain for authorisation; the indexer reads it for lists only.
contract Organizers is IOrganizers {
    uint32 public constant PERM_CREATE_EVENT = 1;
    uint32 public constant PERM_MANAGE_GATES = 2;
    uint32 public constant PERM_APPROVE_OVERRIDE = 4;
    uint32 public constant PERM_MANAGE_MANAGERS = 8;
    uint32 public constant PERM_MANAGE_BUDGET = 16;

    struct Manager {
        bool exists;
        bool canApprove;
    }

    struct Gate {
        uint256 eventId;
        address account;
        bytes32 kx;
        bytes32 ky;
        bool open;
        bool revoked;
    }

    address public immutable deployer;
    address public ticket;

    uint256 private _nextOrgId = 1;
    uint256 private _nextGateId = 1;

    mapping(uint256 => address) private _owners;
    mapping(uint256 => mapping(address => uint32)) private _adminBits;
    mapping(uint256 => mapping(address => Manager)) private _managers;
    mapping(uint256 => Gate) private _gates;
    mapping(address => uint256) private _gateOf;

    event OrganizerCreated(uint256 indexed orgId, address indexed owner);
    event AdminSet(uint256 indexed orgId, address indexed admin, uint32 bits);
    event ManagerSet(uint256 indexed orgId, address indexed manager, bool exists, bool canApprove);
    event OwnerTransferred(uint256 indexed orgId, address indexed from, address indexed to);
    event GateRegistered(
        uint256 indexed gateId, uint256 indexed eventId, address indexed gateAccount, bytes32 kx, bytes32 ky
    );
    event GateRevoked(uint256 indexed gateId);
    event GateOpened(uint256 indexed gateId);
    event GateClosed(uint256 indexed gateId);

    error NotOwner();
    error NotDeployer();
    error TicketAlreadySet();
    error TicketNotSet();
    error ZeroAddress();
    error UnknownOrganizer();
    error Unauthorized();
    error UnknownGate();
    error GateAccountInUse();
    error GateIsRevoked();

    constructor() {
        deployer = msg.sender;
    }

    function setTicket(address ticket_) external {
        if (msg.sender != deployer) revert NotDeployer();
        if (ticket != address(0)) revert TicketAlreadySet();
        if (ticket_ == address(0)) revert ZeroAddress();
        ticket = ticket_;
    }

    function createOrganizer(address owner) external returns (uint256 orgId) {
        if (owner == address(0)) revert ZeroAddress();
        orgId = _nextOrgId++;
        _owners[orgId] = owner;
        emit OrganizerCreated(orgId, owner);
    }

    function transferOwner(uint256 orgId, address newOwner) external {
        address current = _owners[orgId];
        if (current == address(0)) revert UnknownOrganizer();
        if (msg.sender != current) revert NotOwner();
        if (newOwner == address(0)) revert ZeroAddress();
        _owners[orgId] = newOwner;
        emit OwnerTransferred(orgId, current, newOwner);
    }

    function ownerOf(uint256 orgId) external view returns (address) {
        return _owners[orgId];
    }
}
```

- [ ] **Step 5: 테스트가 통과하는지 확인한다**

Run: `cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/contracts && forge test --match-path test/Organizers.t.sol -vv`
Expected: PASS — 4 tests passed. (`IOrganizers`의 나머지 함수는 Task 10~13에서 채운다. 지금은 `Organizers is IOrganizers`가 컴파일되지 않으므로 Step 4의 `contract Organizers is IOrganizers`에서 `is IOrganizers`를 **일단 빼고** 쓴다. Task 13 Step 3에서 다시 붙인다.)

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/contracts
python3 - <<'PY'
import pathlib
p = pathlib.Path("src/Organizers.sol")
p.write_text(p.read_text().replace("contract Organizers is IOrganizers {", "contract Organizers {"))
PY
forge test --match-path test/Organizers.t.sol -vv
```

- [ ] **Step 6: 커밋**

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI
git add contracts/src/Organizers.sol contracts/src/interfaces/ITicket.sol contracts/src/interfaces/IOrganizers.sol contracts/test/Organizers.t.sol
git commit -m "feat(contracts): Organizers with org creation, owner transfer and ticket wiring"
```

---

## Task 10: Organizers — 관리자 권한 비트

**Files:**
- Modify: `contracts/src/Organizers.sol`
- Test: `contracts/test/Organizers.t.sol`

**Interfaces:**
- Consumes: Task 9의 `_adminBits`, `_owners`, `NotOwner`, `UnknownOrganizer`
- Produces: `setAdmin(uint256 orgId, address admin, uint32 permissionBits)`(owner), `hasPermission(uint256 orgId, address account, uint32 bit) returns (bool)`(오너는 항상 true), `event AdminSet(uint256 indexed orgId, address indexed admin, uint32 bits)`. 권한 비트: `PERM_CREATE_EVENT=1`, `PERM_MANAGE_GATES=2`, `PERM_APPROVE_OVERRIDE=4`, `PERM_MANAGE_MANAGERS=8`, `PERM_MANAGE_BUDGET=16`.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

```solidity
    event AdminSet(uint256 indexed orgId, address indexed admin, uint32 bits);

    function test_permissionBitValues() public view {
        assertEq(orgs.PERM_CREATE_EVENT(), 1);
        assertEq(orgs.PERM_MANAGE_GATES(), 2);
        assertEq(orgs.PERM_APPROVE_OVERRIDE(), 4);
        assertEq(orgs.PERM_MANAGE_MANAGERS(), 8);
        assertEq(orgs.PERM_MANAGE_BUDGET(), 16);
    }

    function test_ownerAlwaysHasEveryPermission() public {
        orgs.createOrganizer(OWNER);
        assertTrue(orgs.hasPermission(1, OWNER, orgs.PERM_CREATE_EVENT()));
        assertTrue(orgs.hasPermission(1, OWNER, orgs.PERM_MANAGE_BUDGET()));
        assertFalse(orgs.hasPermission(1, OTHER, orgs.PERM_CREATE_EVENT()));
    }

    function test_setAdminGrantsOnlyTheGivenBits() public {
        orgs.createOrganizer(OWNER);
        vm.expectEmit(true, true, false, true);
        emit AdminSet(1, OTHER, 3);
        vm.prank(OWNER);
        orgs.setAdmin(1, OTHER, orgs.PERM_CREATE_EVENT() | orgs.PERM_MANAGE_GATES());

        assertTrue(orgs.hasPermission(1, OTHER, orgs.PERM_CREATE_EVENT()));
        assertTrue(orgs.hasPermission(1, OTHER, orgs.PERM_MANAGE_GATES()));
        assertFalse(orgs.hasPermission(1, OTHER, orgs.PERM_APPROVE_OVERRIDE()));
        assertFalse(orgs.hasPermission(1, OTHER, orgs.PERM_MANAGE_MANAGERS()));
    }

    function test_setAdminCanRevokeByPassingZero() public {
        orgs.createOrganizer(OWNER);
        vm.startPrank(OWNER);
        orgs.setAdmin(1, OTHER, orgs.PERM_MANAGE_GATES());
        orgs.setAdmin(1, OTHER, 0);
        vm.stopPrank();
        assertFalse(orgs.hasPermission(1, OTHER, orgs.PERM_MANAGE_GATES()));
    }

    function test_onlyOwnerSetsAdmin() public {
        orgs.createOrganizer(OWNER);
        vm.prank(OTHER);
        vm.expectRevert(Organizers.NotOwner.selector);
        orgs.setAdmin(1, OTHER, 1);
    }
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/contracts && forge test --match-test "Admin|permissionBit"`
Expected: FAIL — `Member "setAdmin" not found or not visible after argument-dependent lookup in contract Organizers`.

- [ ] **Step 3: 구현을 쓴다**

`contracts/src/Organizers.sol`의 `transferOwner` 아래에 넣는다:

```solidity
    function setAdmin(uint256 orgId, address admin, uint32 permissionBits) external {
        if (_owners[orgId] == address(0)) revert UnknownOrganizer();
        if (msg.sender != _owners[orgId]) revert NotOwner();
        if (admin == address(0)) revert ZeroAddress();
        _adminBits[orgId][admin] = permissionBits;
        emit AdminSet(orgId, admin, permissionBits);
    }

    /// @notice The owner implicitly holds every bit; an admin holds exactly the bits set for them.
    function hasPermission(uint256 orgId, address account, uint32 bit) public view returns (bool) {
        if (account == address(0)) return false;
        if (account == _owners[orgId]) return true;
        return (_adminBits[orgId][account] & bit) == bit && bit != 0;
    }

    function adminBitsOf(uint256 orgId, address admin) external view returns (uint32) {
        return _adminBits[orgId][admin];
    }
```

- [ ] **Step 4: 테스트가 통과하는지 확인한다**

Run: `cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/contracts && forge test --match-path test/Organizers.t.sol -vv`
Expected: PASS — 9 tests passed.

- [ ] **Step 5: 커밋**

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI
git add contracts/src/Organizers.sol contracts/test/Organizers.t.sol
git commit -m "feat(contracts): Organizers permission bits and hasPermission"
```

---

## Task 11: Organizers — 매니저(직접 승인 vs 결재 요청만)

**Files:**
- Modify: `contracts/src/Organizers.sol`
- Test: `contracts/test/Organizers.t.sol`

**Interfaces:**
- Consumes: Task 10의 `hasPermission`, `PERM_MANAGE_MANAGERS`
- Produces: `setManager(uint256 orgId, address manager, bool exists, bool canApprove)`(오너 또는 `PERM_MANAGE_MANAGERS`), `managerOf(uint256 orgId, address account) returns (bool exists, bool canApprove)`, `event ManagerSet(uint256 indexed orgId, address indexed manager, bool exists, bool canApprove)`. `Ticket.requestOverride`(Task 22)는 `exists`만, `Ticket.manualOverride`는 `exists && canApprove`를 본다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

```solidity
    event ManagerSet(uint256 indexed orgId, address indexed manager, bool exists, bool canApprove);

    function test_ownerAppointsManagerWithApprovalRight() public {
        orgs.createOrganizer(OWNER);
        vm.expectEmit(true, true, false, true);
        emit ManagerSet(1, OTHER, true, true);
        vm.prank(OWNER);
        orgs.setManager(1, OTHER, true, true);

        (bool exists, bool canApprove) = orgs.managerOf(1, OTHER);
        assertTrue(exists);
        assertTrue(canApprove);
    }

    function test_requestOnlyManagerHasNoApprovalRight() public {
        orgs.createOrganizer(OWNER);
        vm.prank(OWNER);
        orgs.setManager(1, OTHER, true, false);
        (bool exists, bool canApprove) = orgs.managerOf(1, OTHER);
        assertTrue(exists);
        assertFalse(canApprove);
    }

    function test_managerCanBeRemoved() public {
        orgs.createOrganizer(OWNER);
        vm.startPrank(OWNER);
        orgs.setManager(1, OTHER, true, true);
        orgs.setManager(1, OTHER, false, false);
        vm.stopPrank();
        (bool exists, bool canApprove) = orgs.managerOf(1, OTHER);
        assertFalse(exists);
        assertFalse(canApprove);
    }

    function test_adminWithManageManagersBitCanAppoint() public {
        orgs.createOrganizer(OWNER);
        address admin = address(0x0A);
        vm.prank(OWNER);
        orgs.setAdmin(1, admin, orgs.PERM_MANAGE_MANAGERS());

        vm.prank(admin);
        orgs.setManager(1, OTHER, true, false);
        (bool exists,) = orgs.managerOf(1, OTHER);
        assertTrue(exists);
    }

    function test_adminWithoutTheBitCannotAppoint() public {
        orgs.createOrganizer(OWNER);
        address admin = address(0x0A);
        vm.prank(OWNER);
        orgs.setAdmin(1, admin, orgs.PERM_MANAGE_GATES());

        vm.prank(admin);
        vm.expectRevert(Organizers.Unauthorized.selector);
        orgs.setManager(1, OTHER, true, false);
    }
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/contracts && forge test --match-test "Manager"`
Expected: FAIL — `Member "setManager" not found or not visible after argument-dependent lookup in contract Organizers`.

- [ ] **Step 3: 구현을 쓴다**

`setAdmin` 아래에 넣는다:

```solidity
    /// @notice Spec 9.4: a manager either approves overrides directly or can only file a request.
    function setManager(uint256 orgId, address manager, bool exists, bool canApprove) external {
        if (_owners[orgId] == address(0)) revert UnknownOrganizer();
        if (!hasPermission(orgId, msg.sender, PERM_MANAGE_MANAGERS)) revert Unauthorized();
        if (manager == address(0)) revert ZeroAddress();

        _managers[orgId][manager] = Manager({exists: exists, canApprove: exists && canApprove});
        emit ManagerSet(orgId, manager, exists, exists && canApprove);
    }

    function managerOf(uint256 orgId, address account) external view returns (bool exists, bool canApprove) {
        Manager storage m = _managers[orgId][account];
        return (m.exists, m.canApprove);
    }
```

- [ ] **Step 4: 테스트가 통과하는지 확인한다**

Run: `cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/contracts && forge test --match-path test/Organizers.t.sol -vv`
Expected: PASS — 14 tests passed. `exists == false`면 `canApprove`도 강제로 false가 되므로 `test_managerCanBeRemoved`가 통과한다.

- [ ] **Step 5: 커밋**

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI
git add contracts/src/Organizers.sol contracts/test/Organizers.t.sol
git commit -m "feat(contracts): Organizers managers with direct-approve vs request-only"
```

---

## Task 12: Organizers — 게이트 등록

**Files:**
- Modify: `contracts/src/Organizers.sol`
- Test: `contracts/test/OrganizersGates.t.sol`
- Create: `contracts/test/mocks/MockTicket.sol`

**Interfaces:**
- Consumes: Task 10의 `hasPermission`, `PERM_MANAGE_GATES`; Task 9의 `ITicket`, `ticket`, `_gates`, `_gateOf`
- Produces: `registerGate(uint256 eventId, address gateAccount, bytes32 kx, bytes32 ky) returns (uint256 gateId)`, `gateOf(address) returns (uint256)`(없으면 0), `gateInfo(uint256) returns (uint256 eventId, address account, bytes32 kx, bytes32 ky, bool open, bool revoked)`, `event GateRegistered(...)`. 권한은 `ticket.eventOrg(eventId)` 조직의 `PERM_MANAGE_GATES`.

- [ ] **Step 1: MockTicket과 실패하는 테스트를 쓴다**

`contracts/test/mocks/MockTicket.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {ITicket} from "../../src/interfaces/ITicket.sol";

/// @notice Lets Organizers tests run without the real Ticket (which depends on Organizers).
contract MockTicket is ITicket {
    mapping(uint256 => uint256) public orgOf;

    function setEventOrg(uint256 eventId, uint256 orgId) external {
        orgOf[eventId] = orgId;
    }

    function eventOrg(uint256 eventId) external view returns (uint256) {
        return orgOf[eventId];
    }
}
```

`contracts/test/OrganizersGates.t.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {Test} from "forge-std/Test.sol";
import {Organizers} from "../src/Organizers.sol";
import {MockTicket} from "./mocks/MockTicket.sol";

contract OrganizersGatesTest is Test {
    Organizers internal orgs;
    MockTicket internal ticket;

    address internal constant OWNER = address(0x01);
    address internal constant GATEKEEPER = address(0x0A);
    address internal constant STRANGER = address(0x02);
    address internal constant GATE_ACCOUNT = address(0x6A7E);
    bytes32 internal constant KX = bytes32(uint256(0xAAA1));
    bytes32 internal constant KY = bytes32(uint256(0xAAA2));

    event GateRegistered(
        uint256 indexed gateId, uint256 indexed eventId, address indexed gateAccount, bytes32 kx, bytes32 ky
    );

    function setUp() public {
        orgs = new Organizers();
        ticket = new MockTicket();
        orgs.setTicket(address(ticket));
        orgs.createOrganizer(OWNER);
        ticket.setEventOrg(7, 1);
        vm.prank(OWNER);
        orgs.setAdmin(1, GATEKEEPER, orgs.PERM_MANAGE_GATES());
        vm.warp(1_800_000_000);
    }

    function test_adminWithGateBitRegistersGate() public {
        vm.expectEmit(true, true, true, true);
        emit GateRegistered(1, 7, GATE_ACCOUNT, KX, KY);
        vm.prank(GATEKEEPER);
        uint256 gateId = orgs.registerGate(7, GATE_ACCOUNT, KX, KY);

        assertEq(gateId, 1);
        assertEq(orgs.gateOf(GATE_ACCOUNT), 1);
        (uint256 eventId, address account, bytes32 kx, bytes32 ky, bool open, bool revoked) = orgs.gateInfo(1);
        assertEq(eventId, 7);
        assertEq(account, GATE_ACCOUNT);
        assertEq(kx, KX);
        assertEq(ky, KY);
        assertFalse(open, "gates start closed");
        assertFalse(revoked);
    }

    function test_unknownAccountHasGateIdZero() public view {
        assertEq(orgs.gateOf(STRANGER), 0);
    }

    function test_strangerCannotRegisterGate() public {
        vm.prank(STRANGER);
        vm.expectRevert(Organizers.Unauthorized.selector);
        orgs.registerGate(7, GATE_ACCOUNT, KX, KY);
    }

    function test_sameGateAccountCannotBeRegisteredTwice() public {
        vm.startPrank(GATEKEEPER);
        orgs.registerGate(7, GATE_ACCOUNT, KX, KY);
        vm.expectRevert(Organizers.GateAccountInUse.selector);
        orgs.registerGate(7, GATE_ACCOUNT, KX, KY);
        vm.stopPrank();
    }

    function test_registerGateNeedsTicketWired() public {
        Organizers fresh = new Organizers();
        fresh.createOrganizer(OWNER);
        vm.prank(OWNER);
        vm.expectRevert(Organizers.TicketNotSet.selector);
        fresh.registerGate(7, GATE_ACCOUNT, KX, KY);
    }
}
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/contracts && forge test --match-path test/OrganizersGates.t.sol`
Expected: FAIL — `Member "registerGate" not found or not visible after argument-dependent lookup in contract Organizers`.

- [ ] **Step 3: 구현을 쓴다**

`setManager` 아래에 넣는다:

```solidity
    /// @notice Spec 7.1: the staff device creates a gate account from its hardware key, an admin puts
    ///         that account on the event's gate allowlist. A gate starts closed.
    function registerGate(uint256 eventId, address gateAccount, bytes32 kx, bytes32 ky)
        external
        returns (uint256 gateId)
    {
        if (ticket == address(0)) revert TicketNotSet();
        if (gateAccount == address(0)) revert ZeroAddress();
        if (_gateOf[gateAccount] != 0) revert GateAccountInUse();

        uint256 orgId = ITicket(ticket).eventOrg(eventId);
        if (orgId == 0) revert UnknownOrganizer();
        if (!hasPermission(orgId, msg.sender, PERM_MANAGE_GATES)) revert Unauthorized();

        gateId = _nextGateId++;
        _gates[gateId] = Gate({eventId: eventId, account: gateAccount, kx: kx, ky: ky, open: false, revoked: false});
        _gateOf[gateAccount] = gateId;

        emit GateRegistered(gateId, eventId, gateAccount, kx, ky);
    }

    function gateOf(address gateAccount) external view returns (uint256) {
        return _gateOf[gateAccount];
    }

    function gateInfo(uint256 gateId)
        external
        view
        returns (uint256 eventId, address account, bytes32 kx, bytes32 ky, bool open, bool revoked)
    {
        Gate storage g = _gates[gateId];
        return (g.eventId, g.account, g.kx, g.ky, g.open, g.revoked);
    }
```

- [ ] **Step 4: 테스트가 통과하는지 확인한다**

Run: `cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/contracts && forge test --match-path test/OrganizersGates.t.sol -vv`
Expected: PASS — 5 tests passed.

- [ ] **Step 5: 커밋**

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI
git add contracts/src/Organizers.sol contracts/test/OrganizersGates.t.sol contracts/test/mocks/MockTicket.sol
git commit -m "feat(contracts): Organizers.registerGate keyed by the event's organization"
```

---

## Task 13: Organizers — 게이트 개폐·폐기와 `isOpenGate`

**Files:**
- Modify: `contracts/src/Organizers.sol`
- Test: `contracts/test/OrganizersGates.t.sol`

**Interfaces:**
- Consumes: Task 12의 `_gates`, `_gateOf`, `registerGate`
- Produces: `openGate(uint256)`, `closeGate(uint256)`, `revokeGate(uint256)`(모두 `PERM_MANAGE_GATES`), `isOpenGate(uint256 eventId, address gateAccount) returns (bool)`, 이벤트 `GateOpened`/`GateClosed`/`GateRevoked`. `Ticket.checkIn`(Task 20)이 `isOpenGate`와 `gateOf` 두 개만으로 T14(가짜 게이트)를 막는다. 이 태스크 끝에서 `contract Organizers is IOrganizers`를 복구한다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

```solidity
    event GateOpened(uint256 indexed gateId);
    event GateClosed(uint256 indexed gateId);
    event GateRevoked(uint256 indexed gateId);

    function _registered() internal returns (uint256 gateId) {
        vm.prank(GATEKEEPER);
        gateId = orgs.registerGate(7, GATE_ACCOUNT, KX, KY);
    }

    function test_openAndCloseFlipIsOpenGate() public {
        uint256 gateId = _registered();
        assertFalse(orgs.isOpenGate(7, GATE_ACCOUNT));

        vm.expectEmit(true, false, false, false);
        emit GateOpened(gateId);
        vm.prank(GATEKEEPER);
        orgs.openGate(gateId);
        assertTrue(orgs.isOpenGate(7, GATE_ACCOUNT));

        vm.expectEmit(true, false, false, false);
        emit GateClosed(gateId);
        vm.prank(GATEKEEPER);
        orgs.closeGate(gateId);
        assertFalse(orgs.isOpenGate(7, GATE_ACCOUNT));
    }

    function test_isOpenGateIsFalseForAnotherEvent() public {
        uint256 gateId = _registered();
        vm.prank(GATEKEEPER);
        orgs.openGate(gateId);
        assertFalse(orgs.isOpenGate(8, GATE_ACCOUNT), "gate belongs to event 7 only");
    }

    function test_isOpenGateIsFalseForAnUnknownAccount() public {
        uint256 gateId = _registered();
        vm.prank(GATEKEEPER);
        orgs.openGate(gateId);
        assertFalse(orgs.isOpenGate(7, STRANGER), "T14: a fake gate is not on the allowlist");
    }

    function test_revokedGateStopsBeingOpen() public {
        uint256 gateId = _registered();
        vm.startPrank(GATEKEEPER);
        orgs.openGate(gateId);
        vm.expectEmit(true, false, false, false);
        emit GateRevoked(gateId);
        orgs.revokeGate(gateId);
        vm.stopPrank();

        assertFalse(orgs.isOpenGate(7, GATE_ACCOUNT));
        vm.prank(GATEKEEPER);
        vm.expectRevert(Organizers.GateIsRevoked.selector);
        orgs.openGate(gateId);
    }

    function test_strangerCannotOpenGate() public {
        uint256 gateId = _registered();
        vm.prank(STRANGER);
        vm.expectRevert(Organizers.Unauthorized.selector);
        orgs.openGate(gateId);
    }
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/contracts && forge test --match-test "isOpenGate|openAndClose|revokedGate|strangerCannotOpen"`
Expected: FAIL — `Member "openGate" not found or not visible after argument-dependent lookup in contract Organizers`.

- [ ] **Step 3: 구현을 쓰고 `is IOrganizers`를 복구한다**

`gateInfo` 아래에 넣는다:

```solidity
    function openGate(uint256 gateId) external {
        _mutateGate(gateId).open = true;
        emit GateOpened(gateId);
    }

    function closeGate(uint256 gateId) external {
        _mutateGate(gateId).open = false;
        emit GateClosed(gateId);
    }

    function revokeGate(uint256 gateId) external {
        Gate storage g = _mutateGate(gateId);
        g.revoked = true;
        g.open = false;
        emit GateRevoked(gateId);
    }

    /// @notice The single question Ticket.checkIn asks: is msg.sender a live gate of this event?
    function isOpenGate(uint256 eventId, address gateAccount) external view returns (bool) {
        uint256 gateId = _gateOf[gateAccount];
        if (gateId == 0) return false;
        Gate storage g = _gates[gateId];
        return g.eventId == eventId && g.open && !g.revoked;
    }

    function _mutateGate(uint256 gateId) private view returns (Gate storage g) {
        g = _gates[gateId];
        if (g.account == address(0)) revert UnknownGate();
        if (g.revoked) revert GateIsRevoked();
        uint256 orgId = ITicket(ticket).eventOrg(g.eventId);
        if (!hasPermission(orgId, msg.sender, PERM_MANAGE_GATES)) revert Unauthorized();
    }
```

그리고 인터페이스 상속을 되살린다:

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/contracts
python3 - <<'PY'
import pathlib
p = pathlib.Path("src/Organizers.sol")
p.write_text(p.read_text().replace("contract Organizers {", "contract Organizers is IOrganizers {", 1))
PY
forge build
```
Expected: 컴파일 성공. 실패하면 `IOrganizers`의 어떤 함수가 빠졌는지 컴파일러가 이름으로 알려준다(`ownerOf`, `hasPermission`, `managerOf`, `gateOf`, `gateInfo`, `isOpenGate` 여섯 개가 모두 external/public이어야 한다).

- [ ] **Step 4: 테스트가 통과하는지 확인한다**

Run: `cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/contracts && forge test --match-path "test/Organizers*.t.sol" -vv`
Expected: PASS — 24 tests passed (Organizers.t.sol 14 + OrganizersGates.t.sol 10).

- [ ] **Step 5: 커밋**

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI
git add contracts/src/Organizers.sol contracts/test/OrganizersGates.t.sol
git commit -m "feat(contracts): gate open/close/revoke and isOpenGate allowlist check"
```

---

## Task 14: Ticket — 뼈대와 `createEvent`(Draft)

**Files:**
- Create: `contracts/src/Ticket.sol`
- Create: `contracts/test/Base.t.sol`
- Test: `contracts/test/TicketEvent.t.sol`

**Interfaces:**
- Consumes: `IIdentity`(Task 4), `IOrganizers`·`ITicket`(Task 9), `PERM_CREATE_EVENT`
- Produces:
  - `contract Ticket is ERC721, ITicket` — 이름 `"MONTI Ticket"`, 심볼 `"MONTI"`, `constructor(address identity_, address organizers_)`
  - `struct EventMeta { uint256 orgId; bytes32 titleHash; bytes32 descHash; string imageCid; uint64 startsAt; uint64 endsAt; bytes32 venueHash; uint64 saleStart; uint64 saleEnd; bool transferable; uint32 transferCutoffSeconds; uint8 maxTransfers; bool approvalRequired; uint8 category; bytes32 regionCode; bool requireKyc; }`
  - `struct Tier { string name; uint256 priceUsdCents; uint32 supply; uint32 minted; uint16 maxPerWallet; bool seated; }`
  - `struct GateCode { uint256 gateId; uint256 eventId; uint64 issuedAt; bytes32 nonce; }`
  - `struct CheckIn { uint256 gateId; uint64 ts; bytes32 nonceHash; bool manual; }`
  - `struct Offer { address from; bytes32 recipientCommitment; uint64 expiresAt; }`
  - `enum EventStatus { Draft, Published, Cancelled, Ended }`
  - `uint256 public constant CODE_WINDOW = 60`
  - `createEvent(EventMeta calldata meta, Tier[] calldata tiers) returns (uint256 eventId)`, `eventMeta(uint256) returns (EventMeta memory)`, `tiers(uint256) returns (Tier[] memory)`, `eventOrg(uint256) returns (uint256)`, `event EventCreated(uint256 indexed eventId, uint256 indexed orgId, address indexed creator)`
  - `contracts/test/Base.t.sol`의 `MontiTest` — Identity·Organizers·Ticket을 배포하고 `_member(addr, personId)`(kycLevel 1), `_memberWithLevel(addr, personId, level)`, `_org()`, `_freeEvent(orgId, maxPerWallet, maxTransfers, transferable)`, `_kycEvent(orgId)` 헬퍼를 준다. Task 15~24의 모든 테스트가 이것을 상속한다.
  - 이 태스크가 `Ticket.sol`의 **스토리지 전체**를 선언한다. Task 15~24는 함수만 덧붙인다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`contracts/test/Base.t.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {Test} from "forge-std/Test.sol";
import {Identity} from "../src/Identity.sol";
import {Organizers} from "../src/Organizers.sol";
import {Ticket} from "../src/Ticket.sol";

abstract contract MontiTest is Test {
    Identity internal identity;
    Organizers internal organizers;
    Ticket internal ticket;

    uint256 internal constant ATTESTER_PK = 0xA11CE;
    address internal attester;

    address internal constant ORG_OWNER = address(0x0140);
    address internal constant ALICE = address(0xA1);
    address internal constant BOB = address(0xB0B);
    address internal constant CAROL = address(0xCA);
    address internal constant GATE_A = address(0x6A7E);
    address internal constant GATE_B = address(0x6A7F);

    bytes32 internal constant DEV_X = bytes32(uint256(0x1111));
    bytes32 internal constant DEV_Y = bytes32(uint256(0x2222));
    uint64 internal constant T0 = 1_800_000_000;

    function _deployMonti() internal {
        attester = vm.addr(ATTESTER_PK);
        identity = new Identity(attester);
        organizers = new Organizers();
        ticket = new Ticket(address(identity), address(organizers));
        organizers.setTicket(address(ticket));
        vm.warp(T0);
    }

    /// @dev Default members are fully verified (kycLevel 1).
    function _member(address account, uint256 personSeed) internal {
        _memberWithLevel(account, personSeed, 1);
    }

    function _memberWithLevel(address account, uint256 personSeed, uint8 level) internal {
        vm.prank(attester);
        identity.register(bytes32(personSeed), account, DEV_X, DEV_Y, level);
    }

    function _org() internal returns (uint256 orgId) {
        orgId = organizers.createOrganizer(ORG_OWNER);
    }

    /// @dev One published event, one free tier, sale open now, doors in 1 day, 2-hour transfer cutoff.
    function _freeEvent(uint256 orgId, uint16 maxPerWallet, uint8 maxTransfers, bool transferable)
        internal
        returns (uint256 eventId)
    {
        return _event(orgId, maxPerWallet, maxTransfers, transferable, false);
    }

    /// @dev Same shape, but the organizer demands ID + face verification (kycLevel >= 1).
    function _kycEvent(uint256 orgId) internal returns (uint256 eventId) {
        return _event(orgId, 2, 1, true, true);
    }

    function _event(uint256 orgId, uint16 maxPerWallet, uint8 maxTransfers, bool transferable, bool requireKyc)
        internal
        returns (uint256 eventId)
    {
        Ticket.EventMeta memory m = Ticket.EventMeta({
            orgId: orgId,
            titleHash: keccak256("MONTI Night"),
            descHash: keccak256("a test event"),
            imageCid: "bafyTestCid",
            startsAt: T0 + 1 days,
            endsAt: T0 + 2 days,
            venueHash: keccak256("Seoul"),
            saleStart: T0,
            saleEnd: T0 + 1 days,
            transferable: transferable,
            transferCutoffSeconds: 2 hours,
            maxTransfers: maxTransfers,
            approvalRequired: false,
            category: 0,
            regionCode: keccak256("KR-11"),
            requireKyc: requireKyc
        });
        Ticket.Tier[] memory t = new Ticket.Tier[](1);
        t[0] = Ticket.Tier({
            name: "General",
            priceUsdCents: 0,
            supply: 100,
            minted: 0,
            maxPerWallet: maxPerWallet,
            seated: false
        });
        vm.prank(ORG_OWNER);
        eventId = ticket.createEvent(m, t);
        vm.prank(ORG_OWNER);
        ticket.publishEvent(eventId);
    }
}
```

`contracts/test/TicketEvent.t.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {MontiTest} from "./Base.t.sol";
import {Ticket} from "../src/Ticket.sol";
import {Organizers} from "../src/Organizers.sol";

contract TicketEventTest is MontiTest {
    event EventCreated(uint256 indexed eventId, uint256 indexed orgId, address indexed creator);

    function setUp() public {
        _deployMonti();
    }

    function test_createEventStoresMetaAndTiers() public {
        uint256 orgId = _org();
        vm.expectEmit(true, true, true, false);
        emit EventCreated(1, orgId, ORG_OWNER);
        uint256 eventId = _freeEvent(orgId, 2, 1, true);

        Ticket.EventMeta memory m = ticket.eventMeta(eventId);
        assertEq(m.orgId, orgId);
        assertEq(m.imageCid, "bafyTestCid");
        assertEq(m.category, 0);
        assertEq(m.regionCode, keccak256("KR-11"));
        assertEq(m.maxTransfers, 1);
        assertEq(ticket.eventOrg(eventId), orgId);

        Ticket.Tier[] memory tiers = ticket.tiers(eventId);
        assertEq(tiers.length, 1);
        assertEq(tiers[0].name, "General");
        assertEq(tiers[0].minted, 0);
        assertEq(tiers[0].maxPerWallet, 2);
    }

    function test_nameAndSymbol() public view {
        assertEq(ticket.name(), "MONTI Ticket");
        assertEq(ticket.symbol(), "MONTI");
        assertEq(ticket.CODE_WINDOW(), 60);
    }

    function test_createEventNeedsCreatePermission() public {
        uint256 orgId = _org();
        Ticket.EventMeta memory m = ticket.eventMeta(0);
        m.orgId = orgId;
        m.startsAt = T0 + 1 days;
        m.endsAt = T0 + 2 days;
        m.saleStart = T0;
        m.saleEnd = T0 + 1 days;
        Ticket.Tier[] memory t = new Ticket.Tier[](1);
        t[0] = Ticket.Tier({name: "X", priceUsdCents: 0, supply: 1, minted: 0, maxPerWallet: 1, seated: false});

        vm.prank(ALICE);
        vm.expectRevert(Ticket.Unauthorized.selector);
        ticket.createEvent(m, t);
    }

    function test_createEventRejectsEmptyTiersAndBadTimes() public {
        uint256 orgId = _org();
        Ticket.EventMeta memory m = ticket.eventMeta(0);
        m.orgId = orgId;
        m.startsAt = T0 + 1 days;
        m.endsAt = T0 + 2 days;
        m.saleStart = T0;
        m.saleEnd = T0 + 1 days;

        Ticket.Tier[] memory none = new Ticket.Tier[](0);
        vm.prank(ORG_OWNER);
        vm.expectRevert(Ticket.InvalidTiers.selector);
        ticket.createEvent(m, none);

        Ticket.Tier[] memory t = new Ticket.Tier[](1);
        t[0] = Ticket.Tier({name: "X", priceUsdCents: 0, supply: 1, minted: 0, maxPerWallet: 1, seated: false});
        m.endsAt = m.startsAt - 1;
        vm.prank(ORG_OWNER);
        vm.expectRevert(Ticket.InvalidSchedule.selector);
        ticket.createEvent(m, t);
    }
}
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/contracts && forge test --match-path test/TicketEvent.t.sol`
Expected: FAIL — `Source "src/Ticket.sol" not found`.

- [ ] **Step 3: `Ticket.sol`의 스토리지와 `createEvent`를 쓴다**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IIdentity} from "./interfaces/IIdentity.sol";
import {IOrganizers} from "./interfaces/IOrganizers.sol";
import {ITicket} from "./interfaces/ITicket.sol";

/// @title Ticket
/// @notice ERC-721 where every transfer rule lives in one _update override and every admission is an
///         append-only CheckIn record. The chain is the authority for the ADMIT decision (spec 7.4).
contract Ticket is ERC721, ITicket {
    struct EventMeta {
        uint256 orgId;
        bytes32 titleHash;
        bytes32 descHash;
        string imageCid;
        uint64 startsAt;
        uint64 endsAt;
        bytes32 venueHash;
        uint64 saleStart;
        uint64 saleEnd;
        bool transferable;
        uint32 transferCutoffSeconds;
        uint8 maxTransfers;
        bool approvalRequired;
        uint8 category;
        bytes32 regionCode;
        bool requireKyc;
    }

    struct Tier {
        string name;
        uint256 priceUsdCents;
        uint32 supply;
        uint32 minted;
        uint16 maxPerWallet;
        bool seated;
    }

    struct GateCode {
        uint256 gateId;
        uint256 eventId;
        uint64 issuedAt;
        bytes32 nonce;
    }

    struct CheckIn {
        uint256 gateId;
        uint64 ts;
        bytes32 nonceHash;
        bool manual;
    }

    struct Offer {
        address from;
        bytes32 recipientCommitment;
        uint64 expiresAt;
    }

    enum EventStatus {
        Draft,
        Published,
        Cancelled,
        Ended
    }

    uint256 public constant CODE_WINDOW = 60;

    IIdentity public immutable identity;
    IOrganizers public immutable organizers;

    uint256 private _nextEventId = 1;
    uint256 private _nextTokenId = 1;
    bool private _internalMove;

    mapping(uint256 => EventMeta) private _events;
    mapping(uint256 => Tier[]) private _tiers;
    mapping(uint256 => EventStatus) private _status;
    mapping(uint256 => uint256) private _eventOf;
    mapping(uint256 => uint8) private _tierOf;
    mapping(uint256 => CheckIn) private _checkIns;
    mapping(uint256 => uint8) private _transfers;
    mapping(uint256 => bool) private _revoked;
    mapping(uint256 => Offer) private _offers;
    mapping(address => mapping(uint256 => uint256)) private _balanceOfEvent;

    event EventCreated(uint256 indexed eventId, uint256 indexed orgId, address indexed creator);
    event EventStatusChanged(uint256 indexed eventId, uint8 status);
    event Claimed(uint256 indexed tokenId, uint256 indexed eventId, address indexed to, uint8 tier);
    event CheckedIn(
        uint256 indexed tokenId, uint256 indexed eventId, uint256 indexed gateId, bytes32 nonceHash, uint64 ts
    );
    event OverrideRequested(uint256 indexed tokenId, uint256 indexed gateId, address indexed requester, uint8 reason);
    event ManualOverride(
        uint256 indexed tokenId, uint256 indexed gateId, address indexed approver, uint8 role, uint8 reason
    );
    event Revoked(uint256 indexed tokenId, uint8 reason);
    event Migrated(uint256 indexed tokenId, address indexed from, address indexed to);
    event OfferCreated(uint256 indexed tokenId, address indexed from, bytes32 recipientCommitment, uint64 expiresAt);
    event OfferCancelled(uint256 indexed tokenId);
    event OfferAccepted(uint256 indexed tokenId, address indexed from, address indexed to);

    error Unauthorized();
    error InvalidTiers();
    error InvalidSchedule();
    error UnknownEvent();
    error UnknownTier();
    error NoSuchTicket();
    error NotDraft();
    error EventNotPublished();
    error EventEnded();
    error SaleClosed();
    error SoldOut();
    error MaxPerWalletExceeded();
    error ApprovalRequiredNotSupported();
    error KycRequired();
    error PaidTiersNotEnabled();
    error NotMember();
    error TransfersDisabled();
    error TransferCutoffPassed();
    error TransferLimitReached();
    error AlreadyCheckedIn();
    error TicketRevoked();
    error GateNotOpen();
    error GateMismatch();
    error WrongEvent();
    error CodeExpired();
    error DeviceLocked();
    error NoActiveDevice();
    error BadDeviceSignature();
    error NoOffer();
    error OfferExpired();
    error BadAttesterSig();
    error NotRotatedAccount();
    error NothingToMigrate();

    constructor(address identity_, address organizers_) ERC721("MONTI Ticket", "MONTI") {
        identity = IIdentity(identity_);
        organizers = IOrganizers(organizers_);
    }

    function createEvent(EventMeta calldata meta, Tier[] calldata tiers_) external returns (uint256 eventId) {
        if (!organizers.hasPermission(meta.orgId, msg.sender, 1)) revert Unauthorized(); // PERM_CREATE_EVENT
        if (tiers_.length == 0 || tiers_.length > 8) revert InvalidTiers();
        if (meta.startsAt >= meta.endsAt || meta.saleStart >= meta.saleEnd) revert InvalidSchedule();

        eventId = _nextEventId++;
        _events[eventId] = meta;
        _status[eventId] = EventStatus.Draft;
        for (uint256 i; i < tiers_.length; ++i) {
            Tier memory t = tiers_[i];
            t.minted = 0;
            _tiers[eventId].push(t);
        }

        emit EventCreated(eventId, meta.orgId, msg.sender);
        emit EventStatusChanged(eventId, uint8(EventStatus.Draft));
    }

    function eventMeta(uint256 eventId) external view returns (EventMeta memory) {
        return _events[eventId];
    }

    function tiers(uint256 eventId) external view returns (Tier[] memory) {
        return _tiers[eventId];
    }

    function eventOrg(uint256 eventId) external view returns (uint256) {
        return _events[eventId].orgId;
    }
}
```

`PERM_CREATE_EVENT`을 숫자 `1`로 쓴 것은 `IOrganizers`가 상수를 노출하지 않기 때문이다. Task 15 Step 3에서 `uint32 private constant PERM_CREATE_EVENT = 1;` 등 다섯 개를 `Ticket` 안에 상수로 선언하고 이 줄을 이름으로 바꾼다.

- [ ] **Step 4: 테스트가 통과하는지 확인한다**

Run: `cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/contracts && forge test --match-path test/TicketEvent.t.sol -vv`
Expected: FAIL — `Member "publishEvent" not found` (Base.t.sol의 `_freeEvent`가 아직 없는 함수를 부른다). 이것이 Task 15로 넘어가는 신호다. `test_nameAndSymbol`과 `test_createEventNeedsCreatePermission`만 먼저 보려면:

Run: `cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/contracts && forge build`
Expected: FAIL — `Member "publishEvent" not found or not visible after argument-dependent lookup in contract Ticket`.

- [ ] **Step 5: 커밋(빨간 상태 그대로)**

Task 15가 같은 커밋 단위의 반쪽이다. 여기서는 빌드가 깨진 채로 커밋하지 않는다 — 대신 Task 15를 **연속으로** 진행하고 Task 15 Step 5에서 두 태스크를 한 번에 커밋한다. 이 태스크의 결과물을 잃지 않도록 작업 트리만 확인한다.

Run: `cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI && git status --short contracts/`
Expected: `?? contracts/src/Ticket.sol`, `?? contracts/test/Base.t.sol`, `?? contracts/test/TicketEvent.t.sol` 세 줄.

---

## Task 15: Ticket — 이벤트 생애주기(Draft → Published → Cancelled/Ended)

**Files:**
- Modify: `contracts/src/Ticket.sol`
- Test: `contracts/test/TicketEvent.t.sol`

**Interfaces:**
- Consumes: Task 14의 `_events`, `_status`, `_tiers`, `EventStatus`, `createEvent`
- Produces: `publishEvent(uint256 eventId)`, `cancelEvent(uint256 eventId)`(둘 다 `PERM_CREATE_EVENT`), `updateEventMeta(uint256 eventId, EventMeta calldata meta, Tier[] calldata tiers_)`(Draft일 때만), `eventStatus(uint256 eventId) returns (EventStatus)`, `event EventStatusChanged(uint256 indexed eventId, uint8 status)`. `Ended`는 별도 트랜잭션 없이 파생된다 — `eventStatus`가 `now > endsAt`이면 `Ended`를 돌려주고 `claim`·`checkIn`이 `EventEnded()`로 되돌린다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`contracts/test/TicketEvent.t.sol`에 붙인다:

```solidity
    event EventStatusChanged(uint256 indexed eventId, uint8 status);

    function test_eventStartsAsDraftAndPublishes() public {
        uint256 orgId = _org();
        Ticket.EventMeta memory m = _draftMeta(orgId);
        Ticket.Tier[] memory t = _oneFreeTier();

        vm.prank(ORG_OWNER);
        uint256 eventId = ticket.createEvent(m, t);
        assertEq(uint8(ticket.eventStatus(eventId)), uint8(Ticket.EventStatus.Draft));

        vm.expectEmit(true, false, false, true);
        emit EventStatusChanged(eventId, uint8(Ticket.EventStatus.Published));
        vm.prank(ORG_OWNER);
        ticket.publishEvent(eventId);
        assertEq(uint8(ticket.eventStatus(eventId)), uint8(Ticket.EventStatus.Published));
    }

    function test_updateEventMetaOnlyWhileDraft() public {
        uint256 orgId = _org();
        Ticket.EventMeta memory m = _draftMeta(orgId);
        vm.prank(ORG_OWNER);
        uint256 eventId = ticket.createEvent(m, _oneFreeTier());

        m.titleHash = keccak256("New title");
        vm.prank(ORG_OWNER);
        ticket.updateEventMeta(eventId, m, _oneFreeTier());
        assertEq(ticket.eventMeta(eventId).titleHash, keccak256("New title"));

        vm.prank(ORG_OWNER);
        ticket.publishEvent(eventId);
        vm.prank(ORG_OWNER);
        vm.expectRevert(Ticket.NotDraft.selector);
        ticket.updateEventMeta(eventId, m, _oneFreeTier());
    }

    function test_cancelEventAndEndedIsDerived() public {
        uint256 orgId = _org();
        uint256 eventId = _freeEvent(orgId, 2, 1, true);

        vm.warp(T0 + 3 days);
        assertEq(uint8(ticket.eventStatus(eventId)), uint8(Ticket.EventStatus.Ended), "past endsAt is Ended");

        vm.warp(T0);
        vm.prank(ORG_OWNER);
        ticket.cancelEvent(eventId);
        assertEq(uint8(ticket.eventStatus(eventId)), uint8(Ticket.EventStatus.Cancelled));
        vm.warp(T0 + 3 days);
        assertEq(uint8(ticket.eventStatus(eventId)), uint8(Ticket.EventStatus.Cancelled), "cancel outranks ended");
    }

    function test_onlyCreatePermissionChangesLifecycle() public {
        uint256 orgId = _org();
        uint256 eventId = _freeEvent(orgId, 2, 1, true);
        vm.prank(ALICE);
        vm.expectRevert(Ticket.Unauthorized.selector);
        ticket.cancelEvent(eventId);
    }

    function _draftMeta(uint256 orgId) internal view returns (Ticket.EventMeta memory m) {
        m = Ticket.EventMeta({
            orgId: orgId,
            titleHash: keccak256("MONTI Night"),
            descHash: keccak256("a test event"),
            imageCid: "bafyTestCid",
            startsAt: T0 + 1 days,
            endsAt: T0 + 2 days,
            venueHash: keccak256("Seoul"),
            saleStart: T0,
            saleEnd: T0 + 1 days,
            transferable: true,
            transferCutoffSeconds: 2 hours,
            maxTransfers: 1,
            approvalRequired: false,
            category: 0,
            regionCode: keccak256("KR-11"),
            requireKyc: false
        });
    }

    function _oneFreeTier() internal pure returns (Ticket.Tier[] memory t) {
        t = new Ticket.Tier[](1);
        t[0] = Ticket.Tier({
            name: "General",
            priceUsdCents: 0,
            supply: 100,
            minted: 0,
            maxPerWallet: 2,
            seated: false
        });
    }
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/contracts && forge build`
Expected: FAIL — `Member "publishEvent" not found or not visible after argument-dependent lookup in contract Ticket`.

- [ ] **Step 3: 권한 상수와 생애주기 함수를 쓴다**

`Ticket.sol`의 `uint256 public constant CODE_WINDOW = 60;` 아래에 넣는다:

```solidity
    uint32 private constant PERM_CREATE_EVENT = 1;
    uint32 private constant PERM_MANAGE_GATES = 2;
    uint32 private constant PERM_APPROVE_OVERRIDE = 4;
```

`createEvent`의 권한 검사를 이름으로 바꾼다:

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/contracts
python3 - <<'PY'
import pathlib
p = pathlib.Path("src/Ticket.sol")
p.write_text(p.read_text().replace(
  "if (!organizers.hasPermission(meta.orgId, msg.sender, 1)) revert Unauthorized(); // PERM_CREATE_EVENT",
  "if (!organizers.hasPermission(meta.orgId, msg.sender, PERM_CREATE_EVENT)) revert Unauthorized();"))
PY
```

그리고 `eventOrg` 위에 생애주기 함수를 넣는다:

```solidity
    function publishEvent(uint256 eventId) external {
        _requireEventPermission(eventId, PERM_CREATE_EVENT);
        if (_status[eventId] != EventStatus.Draft) revert NotDraft();
        _status[eventId] = EventStatus.Published;
        emit EventStatusChanged(eventId, uint8(EventStatus.Published));
    }

    function cancelEvent(uint256 eventId) external {
        _requireEventPermission(eventId, PERM_CREATE_EVENT);
        _status[eventId] = EventStatus.Cancelled;
        emit EventStatusChanged(eventId, uint8(EventStatus.Cancelled));
    }

    function updateEventMeta(uint256 eventId, EventMeta calldata meta, Tier[] calldata tiers_) external {
        _requireEventPermission(eventId, PERM_CREATE_EVENT);
        if (_status[eventId] != EventStatus.Draft) revert NotDraft();
        if (tiers_.length == 0 || tiers_.length > 8) revert InvalidTiers();
        if (meta.startsAt >= meta.endsAt || meta.saleStart >= meta.saleEnd) revert InvalidSchedule();

        uint256 keptOrg = _events[eventId].orgId;
        _events[eventId] = meta;
        _events[eventId].orgId = keptOrg;

        delete _tiers[eventId];
        for (uint256 i; i < tiers_.length; ++i) {
            Tier memory t = tiers_[i];
            t.minted = 0;
            _tiers[eventId].push(t);
        }
    }

    /// @notice Ended is derived from endsAt so no transaction is needed to close an event.
    function eventStatus(uint256 eventId) public view returns (EventStatus) {
        EventStatus s = _status[eventId];
        if (s == EventStatus.Published && block.timestamp > _events[eventId].endsAt) return EventStatus.Ended;
        return s;
    }

    function _requireEventPermission(uint256 eventId, uint32 bit) private view {
        uint256 orgId = _events[eventId].orgId;
        if (orgId == 0) revert UnknownEvent();
        if (!organizers.hasPermission(orgId, msg.sender, bit)) revert Unauthorized();
    }
```

- [ ] **Step 4: 테스트가 통과하는지 확인한다**

Run: `cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/contracts && forge test --match-path test/TicketEvent.t.sol -vv`
Expected: PASS — 8 tests passed.

- [ ] **Step 5: Task 14와 함께 커밋**

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI
git add contracts/src/Ticket.sol contracts/test/Base.t.sol contracts/test/TicketEvent.t.sol
git commit -m "feat(contracts): Ticket events with draft/published/cancelled lifecycle"
```

---

## Task 16: Ticket — `claim`(무료 티어, 1인 최대, 판매 기간)

**Files:**
- Modify: `contracts/src/Ticket.sol`
- Test: `contracts/test/TicketClaim.t.sol`

**Interfaces:**
- Consumes: Task 14~15의 `_tiers`, `_status`, `eventStatus`, `_balanceOfEvent`, `identity.isMember`
- Produces: `claim(uint256 eventId, uint8 tier, bytes calldata voucher) returns (uint256 tokenId)`, `eventOf(uint256 tokenId) returns (uint256)`, `tierOf(uint256 tokenId) returns (uint8)`, `balanceOfEvent(address account, uint256 eventId) returns (uint256)`, `transfersOf(uint256 tokenId) returns (uint8)`, `checkInOf(uint256 tokenId) returns (CheckIn memory)`, `offerOf(uint256 tokenId) returns (Offer memory)`, `event Claimed(uint256 indexed tokenId, uint256 indexed eventId, address indexed to, uint8 tier)`.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`contracts/test/TicketClaim.t.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {MontiTest} from "./Base.t.sol";
import {Ticket} from "../src/Ticket.sol";

contract TicketClaimTest is MontiTest {
    uint256 internal orgId;
    uint256 internal eventId;

    event Claimed(uint256 indexed tokenId, uint256 indexed eventId, address indexed to, uint8 tier);

    function setUp() public {
        _deployMonti();
        _member(ALICE, 0xA1A1);
        _member(BOB, 0xB0B0);
        orgId = _org();
        eventId = _freeEvent(orgId, 1, 1, true);
    }

    function test_memberClaimsFreeTicket() public {
        vm.expectEmit(true, true, true, true);
        emit Claimed(1, eventId, ALICE, 0);
        vm.prank(ALICE);
        uint256 tokenId = ticket.claim(eventId, 0, "");

        assertEq(tokenId, 1);
        assertEq(ticket.ownerOf(tokenId), ALICE);
        assertEq(ticket.eventOf(tokenId), eventId);
        assertEq(ticket.tierOf(tokenId), 0);
        assertEq(ticket.balanceOfEvent(ALICE, eventId), 1);
        assertEq(ticket.transfersOf(tokenId), 0);
        assertEq(ticket.checkInOf(tokenId).ts, 0);
        assertEq(ticket.tiers(eventId)[0].minted, 1);
    }

    function test_nonMemberCannotClaim() public {
        vm.prank(CAROL);
        vm.expectRevert(Ticket.NotMember.selector);
        ticket.claim(eventId, 0, "");
    }

    function test_maxPerWalletEnforcedOnClaim() public {
        vm.startPrank(ALICE);
        ticket.claim(eventId, 0, "");
        vm.expectRevert(Ticket.MaxPerWalletExceeded.selector);
        ticket.claim(eventId, 0, "");
        vm.stopPrank();
    }

    function test_claimRejectedWhenDraft() public {
        uint256 draftId;
        {
            Ticket.EventMeta memory m = ticket.eventMeta(eventId);
            Ticket.Tier[] memory t = ticket.tiers(eventId);
            vm.prank(ORG_OWNER);
            draftId = ticket.createEvent(m, t);
        }
        vm.prank(ALICE);
        vm.expectRevert(Ticket.EventNotPublished.selector);
        ticket.claim(draftId, 0, "");
    }

    function test_claimRejectedOutsideSaleWindowAndAfterEnd() public {
        vm.warp(T0 + 1 days + 1);
        vm.prank(ALICE);
        vm.expectRevert(Ticket.SaleClosed.selector);
        ticket.claim(eventId, 0, "");

        vm.warp(T0 + 2 days + 1);
        vm.prank(ALICE);
        vm.expectRevert(Ticket.EventEnded.selector);
        ticket.claim(eventId, 0, "");
    }

    function test_claimBlockedForLevelZeroOnAKycEvent() public {
        uint256 kycEventId = _kycEvent(orgId);
        _memberWithLevel(address(0xD0), 0xD0D0, 0);
        vm.prank(address(0xD0));
        vm.expectRevert(Ticket.KycRequired.selector);
        ticket.claim(kycEventId, 0, "");
    }

    function test_claimAllowedForLevelOneAndOnNonKycEvents() public {
        uint256 kycEventId = _kycEvent(orgId);
        vm.prank(ALICE);
        ticket.claim(kycEventId, 0, "");
        assertEq(ticket.balanceOfEvent(ALICE, kycEventId), 1);

        _memberWithLevel(address(0xD1), 0xD1D1, 0);
        vm.prank(address(0xD1));
        ticket.claim(eventId, 0, "");
        assertEq(ticket.balanceOfEvent(address(0xD1), eventId), 1);
    }

    function test_claimRejectedWhenSoldOutAndOnUnknownTier() public {
        vm.prank(ALICE);
        vm.expectRevert(Ticket.UnknownTier.selector);
        ticket.claim(eventId, 3, "");

        vm.prank(ALICE);
        vm.expectRevert(Ticket.PaidTiersNotEnabled.selector);
        ticket.claim(eventId, 0, hex"1234");
    }
}
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/contracts && forge test --match-path test/TicketClaim.t.sol`
Expected: FAIL — `Member "claim" not found or not visible after argument-dependent lookup in contract Ticket`.

- [ ] **Step 3: 구현을 쓴다**

`eventStatus` 아래에 넣는다:

```solidity
    /// @notice Free tiers only in the MVP (spec 5.2). A paid tier needs an attester voucher, which is
    ///         post-hackathon; passing a voucher today is an explicit error rather than a silent pass.
    function claim(uint256 eventId, uint8 tier, bytes calldata voucher) external returns (uint256 tokenId) {
        EventStatus s = eventStatus(eventId);
        if (s == EventStatus.Ended) revert EventEnded();
        if (s != EventStatus.Published) revert EventNotPublished();
        if (!identity.isMember(msg.sender)) revert NotMember();

        EventMeta storage m = _events[eventId];
        if (m.approvalRequired) revert ApprovalRequiredNotSupported();
        if (m.requireKyc && identity.kycLevelOf(msg.sender) < 1) revert KycRequired();
        if (block.timestamp < m.saleStart || block.timestamp > m.saleEnd) revert SaleClosed();
        if (tier >= _tiers[eventId].length) revert UnknownTier();

        Tier storage t = _tiers[eventId][tier];
        if (t.priceUsdCents != 0 || voucher.length != 0) revert PaidTiersNotEnabled();
        if (t.minted >= t.supply) revert SoldOut();
        if (_balanceOfEvent[msg.sender][eventId] >= t.maxPerWallet) revert MaxPerWalletExceeded();

        t.minted += 1;
        tokenId = _nextTokenId++;
        _eventOf[tokenId] = eventId;
        _tierOf[tokenId] = tier;
        _safeMint(msg.sender, tokenId);

        emit Claimed(tokenId, eventId, msg.sender, tier);
    }

    function eventOf(uint256 tokenId) external view returns (uint256) {
        return _eventOf[tokenId];
    }

    function tierOf(uint256 tokenId) external view returns (uint8) {
        return _tierOf[tokenId];
    }

    function balanceOfEvent(address account, uint256 eventId) external view returns (uint256) {
        return _balanceOfEvent[account][eventId];
    }

    function transfersOf(uint256 tokenId) external view returns (uint8) {
        return _transfers[tokenId];
    }

    function checkInOf(uint256 tokenId) external view returns (CheckIn memory) {
        return _checkIns[tokenId];
    }

    function offerOf(uint256 tokenId) external view returns (Offer memory) {
        return _offers[tokenId];
    }
```

- [ ] **Step 4: `_update` 자리표시자를 넣는다**

`_balanceOfEvent`는 아직 아무도 증가시키지 않는다. Task 17이 규칙과 함께 채우지만, 지금 테스트가 통과하려면 잔액 회계만 먼저 있어야 한다. `Ticket.sol` 맨 아래(닫는 `}` 직전)에 넣는다:

```solidity
    function _update(address to, uint256 tokenId, address auth) internal override returns (address) {
        address from = _ownerOf(tokenId);
        uint256 eventId = _eventOf[tokenId];
        address previous = super._update(to, tokenId, auth);
        if (from != address(0)) _balanceOfEvent[from][eventId] -= 1;
        if (to != address(0)) _balanceOfEvent[to][eventId] += 1;
        return previous;
    }
```

- [ ] **Step 5: 테스트가 통과하는지 확인한다**

Run: `cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/contracts && forge test --match-path test/TicketClaim.t.sol -vv`
Expected: PASS — 8 tests passed.

- [ ] **Step 6: 커밋**

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI
git add contracts/src/Ticket.sol contracts/test/TicketClaim.t.sol
git commit -m "feat(contracts): Ticket.claim for free tiers with per-wallet and sale-window limits"
```

---

## Task 17: Ticket — `_update` 양도 규칙 (모든 전송의 관문)

**Files:**
- Modify: `contracts/src/Ticket.sol` (`_update` 교체)
- Test: `contracts/test/TicketTransfer.t.sol`

**Interfaces:**
- Consumes: Task 16의 `_update` 회계, `_transfers`, `_checkIns`, `_revoked`, `_offers`, `identity.isMember`
- Produces: 최종 `_update` — 실제 전송(민트·소각 제외)마다 ① 취소되지 않았는가 ② 양도 허용 공연인가 ③ 입장 전인가 ④ 양도 마감(`startsAt - transferCutoffSeconds`) 전인가 ⑤ 받는 쪽이 회원인가 ⑥ 양도 횟수가 남았는가 ⑦ 받는 쪽의 이 공연 보유 수 < `maxPerWallet`인가를 검사하고, 통과하면 `transfersOf`를 1 올리고 걸려 있던 양도 제안을 지운다. `_internalMove`가 참이면 규칙을 건너뛴다(`migrate` 전용, Task 23).

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`contracts/test/TicketTransfer.t.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {MontiTest} from "./Base.t.sol";
import {Ticket} from "../src/Ticket.sol";

contract TicketTransferTest is MontiTest {
    uint256 internal orgId;
    uint256 internal eventId;
    uint256 internal tokenId;

    function setUp() public {
        _deployMonti();
        _member(ALICE, 0xA1A1);
        _member(BOB, 0xB0B0);
        orgId = _org();
        eventId = _freeEvent(orgId, 1, 1, true);
        vm.prank(ALICE);
        tokenId = ticket.claim(eventId, 0, "");
    }

    function test_transferToMemberSucceedsAndCounts() public {
        vm.prank(ALICE);
        ticket.transferFrom(ALICE, BOB, tokenId);

        assertEq(ticket.ownerOf(tokenId), BOB);
        assertEq(ticket.transfersOf(tokenId), 1);
        assertEq(ticket.balanceOfEvent(ALICE, eventId), 0);
        assertEq(ticket.balanceOfEvent(BOB, eventId), 1);
    }

    function test_transferToNonMemberReverts() public {
        vm.prank(ALICE);
        vm.expectRevert(Ticket.NotMember.selector);
        ticket.transferFrom(ALICE, CAROL, tokenId);
    }

    function test_maxPerWalletEnforcedOnTransfer() public {
        vm.prank(BOB);
        ticket.claim(eventId, 0, "");

        vm.prank(ALICE);
        vm.expectRevert(Ticket.MaxPerWalletExceeded.selector);
        ticket.transferFrom(ALICE, BOB, tokenId);
    }

    function test_maxTransfersEnforced() public {
        _member(CAROL, 0xCACA);
        vm.prank(ALICE);
        ticket.transferFrom(ALICE, BOB, tokenId);

        vm.prank(BOB);
        vm.expectRevert(Ticket.TransferLimitReached.selector);
        ticket.transferFrom(BOB, CAROL, tokenId);
    }

    function test_transferAfterCutoffReverts() public {
        // doors at T0 + 1 day, cutoff 2 hours before.
        vm.warp(T0 + 1 days - 2 hours + 1);
        vm.prank(ALICE);
        vm.expectRevert(Ticket.TransferCutoffPassed.selector);
        ticket.transferFrom(ALICE, BOB, tokenId);
    }

    function test_transferBlockedWhenEventIsNotTransferable() public {
        uint256 lockedEvent = _freeEvent(orgId, 1, 1, false);
        vm.prank(BOB);
        uint256 locked = ticket.claim(lockedEvent, 0, "");

        vm.prank(BOB);
        vm.expectRevert(Ticket.TransfersDisabled.selector);
        ticket.transferFrom(BOB, ALICE, locked);
    }

    function test_transferToLevelZeroBlockedOnAKycEvent() public {
        uint256 kycEventId = _kycEvent(orgId);
        vm.prank(ALICE);
        uint256 kycToken = ticket.claim(kycEventId, 0, "");
        _memberWithLevel(address(0xD0), 0xD0D0, 0);

        vm.prank(ALICE);
        vm.expectRevert(Ticket.KycRequired.selector);
        ticket.transferFrom(ALICE, address(0xD0), kycToken);
    }

    function test_safeTransferFromFollowsTheSameRules() public {
        vm.prank(ALICE);
        vm.expectRevert(Ticket.NotMember.selector);
        ticket.safeTransferFrom(ALICE, CAROL, tokenId);
    }
}
```

“입장 후 양도 불가”는 `checkIn`이 필요하므로 Task 21에서 같은 파일에 덧붙인다.

- [ ] **Step 2: 실패를 확인한다**

Run: `cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/contracts && forge test --match-path test/TicketTransfer.t.sol`
Expected: FAIL — `test_transferToNonMemberReverts` 등이 `call did not revert as expected`로 실패한다(지금 `_update`는 회계만 한다).

- [ ] **Step 3: `_update`를 규칙 포함 버전으로 교체한다**

`Ticket.sol` 맨 아래의 `_update`를 통째로 이것으로 바꾼다:

```solidity
    /// @notice Every transfer — from any app, any wallet, any relayer — passes through here (spec 10.2).
    ///         Mint (from == 0), burn (to == 0) and migrate (_internalMove) skip the rules.
    function _update(address to, uint256 tokenId, address auth) internal override returns (address) {
        address from = _ownerOf(tokenId);
        uint256 eventId = _eventOf[tokenId];

        if (from != address(0) && to != address(0)) {
            if (_offers[tokenId].from != address(0)) {
                delete _offers[tokenId];
                emit OfferCancelled(tokenId);
            }
            if (!_internalMove) {
                EventMeta storage m = _events[eventId];
                if (_revoked[tokenId]) revert TicketRevoked();
                if (!m.transferable) revert TransfersDisabled();
                if (_checkIns[tokenId].ts != 0) revert AlreadyCheckedIn();
                if (block.timestamp + m.transferCutoffSeconds > m.startsAt) revert TransferCutoffPassed();
                if (!identity.isMember(to)) revert NotMember();
                if (m.requireKyc && identity.kycLevelOf(to) < 1) revert KycRequired();

                uint8 done = _transfers[tokenId];
                if (done >= m.maxTransfers) revert TransferLimitReached();

                Tier storage t = _tiers[eventId][_tierOf[tokenId]];
                if (_balanceOfEvent[to][eventId] >= t.maxPerWallet) revert MaxPerWalletExceeded();

                _transfers[tokenId] = done + 1;
            }
        }

        address previous = super._update(to, tokenId, auth);
        if (from != address(0)) _balanceOfEvent[from][eventId] -= 1;
        if (to != address(0)) _balanceOfEvent[to][eventId] += 1;
        return previous;
    }
```

- [ ] **Step 4: 테스트가 통과하는지 확인한다**

Run: `cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/contracts && forge test --match-path test/TicketTransfer.t.sol -vv`
Expected: PASS — 8 tests passed.

- [ ] **Step 5: 앞 태스크가 깨지지 않았는지 본다**

Run: `cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/contracts && forge test --match-path "test/Ticket*.t.sol" -vv`
Expected: PASS — 24 tests passed (TicketEvent 8 + TicketClaim 8 + TicketTransfer 8).

- [ ] **Step 6: 커밋**

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI
git add contracts/src/Ticket.sol contracts/test/TicketTransfer.t.sol
git commit -m "feat(contracts): enforce every transfer rule inside the ERC721 _update hook"
```

---

## Task 18: Ticket — 양도 제안(전화번호·닉네임 초대 흐름)

**Files:**
- Modify: `contracts/src/Ticket.sol`
- Test: `contracts/test/TicketOffer.t.sol`

**Interfaces:**
- Consumes: Task 17의 `_update`(제안 자동 소멸 포함), Task 4의 `identity.attester()`
- Produces: `createOffer(uint256 tokenId, bytes32 recipientCommitment, uint64 expiresAt)`(소유자), `cancelOffer(uint256 tokenId)`(소유자), `acceptOffer(uint256 tokenId, bytes calldata attesterSig)`(수령 계정), `offerOf(uint256)`(Task 16에서 선언), 이벤트 `OfferCreated`/`OfferCancelled`/`OfferAccepted`. 어테스터 ECDSA 서명 대상은 `keccak256(abi.encode(tokenId, offer.recipientCommitment, msg.sender))`다 — 백엔드가 "이 전화번호/닉네임 커밋먼트의 진짜 주인은 이 계정"임을 확인해 준 것이고, 전송 자체는 `_update`의 규칙을 그대로 통과한다(양도 1회로 계산된다).

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`contracts/test/TicketOffer.t.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {MontiTest} from "./Base.t.sol";
import {Ticket} from "../src/Ticket.sol";

contract TicketOfferTest is MontiTest {
    uint256 internal orgId;
    uint256 internal eventId;
    uint256 internal tokenId;
    bytes32 internal constant COMMITMENT = keccak256("phone:+821012345678");

    event OfferCreated(uint256 indexed tokenId, address indexed from, bytes32 recipientCommitment, uint64 expiresAt);
    event OfferAccepted(uint256 indexed tokenId, address indexed from, address indexed to);
    event OfferCancelled(uint256 indexed tokenId);

    function setUp() public {
        _deployMonti();
        _member(ALICE, 0xA1A1);
        _member(BOB, 0xB0B0);
        orgId = _org();
        eventId = _freeEvent(orgId, 1, 2, true);
        vm.prank(ALICE);
        tokenId = ticket.claim(eventId, 0, "");
    }

    function _sig(uint256 tokenId_, bytes32 commitment, address to) internal view returns (bytes memory) {
        bytes32 digest = keccak256(abi.encode(tokenId_, commitment, to));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ATTESTER_PK, digest);
        return abi.encodePacked(r, s, v);
    }

    function test_createAndAcceptOffer() public {
        vm.expectEmit(true, true, false, true);
        emit OfferCreated(tokenId, ALICE, COMMITMENT, T0 + 1 hours);
        vm.prank(ALICE);
        ticket.createOffer(tokenId, COMMITMENT, T0 + 1 hours);

        Ticket.Offer memory o = ticket.offerOf(tokenId);
        assertEq(o.from, ALICE);
        assertEq(o.recipientCommitment, COMMITMENT);

        vm.expectEmit(true, true, true, false);
        emit OfferAccepted(tokenId, ALICE, BOB);
        vm.prank(BOB);
        ticket.acceptOffer(tokenId, _sig(tokenId, COMMITMENT, BOB));

        assertEq(ticket.ownerOf(tokenId), BOB);
        assertEq(ticket.transfersOf(tokenId), 1, "an accepted offer counts as one transfer");
        assertEq(ticket.offerOf(tokenId).from, address(0));
    }

    function test_acceptRejectsWrongAttesterSignature() public {
        vm.prank(ALICE);
        ticket.createOffer(tokenId, COMMITMENT, T0 + 1 hours);

        bytes32 digest = keccak256(abi.encode(tokenId, COMMITMENT, BOB));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(uint256(0xBADBAD), digest);
        vm.prank(BOB);
        vm.expectRevert(Ticket.BadAttesterSig.selector);
        ticket.acceptOffer(tokenId, abi.encodePacked(r, s, v));
    }

    function test_signatureIsBoundToTheAcceptingAccount() public {
        _member(CAROL, 0xCACA);
        vm.prank(ALICE);
        ticket.createOffer(tokenId, COMMITMENT, T0 + 1 hours);

        vm.prank(CAROL);
        vm.expectRevert(Ticket.BadAttesterSig.selector);
        ticket.acceptOffer(tokenId, _sig(tokenId, COMMITMENT, BOB));
    }

    function test_expiredOfferRejected() public {
        vm.prank(ALICE);
        ticket.createOffer(tokenId, COMMITMENT, T0 + 1 hours);
        vm.warp(T0 + 1 hours + 1);

        vm.prank(BOB);
        vm.expectRevert(Ticket.OfferExpired.selector);
        ticket.acceptOffer(tokenId, _sig(tokenId, COMMITMENT, BOB));
    }

    function test_offerIsVoidAfterAPlainTransfer() public {
        _member(CAROL, 0xCACA);
        vm.prank(ALICE);
        ticket.createOffer(tokenId, COMMITMENT, T0 + 1 hours);

        vm.expectEmit(true, false, false, false);
        emit OfferCancelled(tokenId);
        vm.prank(ALICE);
        ticket.transferFrom(ALICE, CAROL, tokenId);

        assertEq(ticket.offerOf(tokenId).from, address(0));
        vm.prank(BOB);
        vm.expectRevert(Ticket.NoOffer.selector);
        ticket.acceptOffer(tokenId, _sig(tokenId, COMMITMENT, BOB));
    }

    function test_acceptOfferBlockedForLevelZeroOnAKycEvent() public {
        uint256 kycEventId = _kycEvent(orgId);
        vm.prank(ALICE);
        uint256 kycToken = ticket.claim(kycEventId, 0, "");
        _memberWithLevel(address(0xD0), 0xD0D0, 0);

        vm.prank(ALICE);
        ticket.createOffer(kycToken, COMMITMENT, T0 + 1 hours);
        vm.prank(address(0xD0));
        vm.expectRevert(Ticket.KycRequired.selector);
        ticket.acceptOffer(kycToken, _sig(kycToken, COMMITMENT, address(0xD0)));
    }

    function test_onlyOwnerCreatesOrCancels() public {
        vm.prank(BOB);
        vm.expectRevert(Ticket.Unauthorized.selector);
        ticket.createOffer(tokenId, COMMITMENT, T0 + 1 hours);

        vm.prank(ALICE);
        ticket.createOffer(tokenId, COMMITMENT, T0 + 1 hours);
        vm.prank(BOB);
        vm.expectRevert(Ticket.Unauthorized.selector);
        ticket.cancelOffer(tokenId);

        vm.prank(ALICE);
        ticket.cancelOffer(tokenId);
        assertEq(ticket.offerOf(tokenId).from, address(0));
    }
}
```

“입장 후 제안 무효”는 `checkIn`이 필요하므로 Task 21 Step 1에서 같은 파일에 덧붙인다.

- [ ] **Step 2: 실패를 확인한다**

Run: `cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/contracts && forge test --match-path test/TicketOffer.t.sol`
Expected: FAIL — `Member "createOffer" not found or not visible after argument-dependent lookup in contract Ticket`.

- [ ] **Step 3: 구현을 쓴다**

`Ticket.sol` 상단 import에 한 줄을 더한다:

```solidity
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
```

그리고 `offerOf` 아래에 넣는다:

```solidity
    /// @notice Spec 5.4: the sender picks a recipient by phone number or nickname. The commitment is a
    ///         hash of that handle; the attester later signs "this account is that handle's owner".
    function createOffer(uint256 tokenId, bytes32 recipientCommitment, uint64 expiresAt) external {
        if (ownerOf(tokenId) != msg.sender) revert Unauthorized();
        EventMeta storage m = _events[_eventOf[tokenId]];
        if (_revoked[tokenId]) revert TicketRevoked();
        if (!m.transferable) revert TransfersDisabled();
        if (_checkIns[tokenId].ts != 0) revert AlreadyCheckedIn();
        if (block.timestamp + m.transferCutoffSeconds > m.startsAt) revert TransferCutoffPassed();
        if (_transfers[tokenId] >= m.maxTransfers) revert TransferLimitReached();
        if (expiresAt <= block.timestamp) revert OfferExpired();

        _offers[tokenId] = Offer({from: msg.sender, recipientCommitment: recipientCommitment, expiresAt: expiresAt});
        emit OfferCreated(tokenId, msg.sender, recipientCommitment, expiresAt);
    }

    function cancelOffer(uint256 tokenId) external {
        if (ownerOf(tokenId) != msg.sender) revert Unauthorized();
        if (_offers[tokenId].from == address(0)) revert NoOffer();
        delete _offers[tokenId];
        emit OfferCancelled(tokenId);
    }

    function acceptOffer(uint256 tokenId, bytes calldata attesterSig) external {
        Offer memory o = _offers[tokenId];
        if (o.from == address(0)) revert NoOffer();
        if (o.from != ownerOf(tokenId)) revert NoOffer();
        if (block.timestamp > o.expiresAt) revert OfferExpired();

        bytes32 digest = keccak256(abi.encode(tokenId, o.recipientCommitment, msg.sender));
        if (ECDSA.recover(digest, attesterSig) != identity.attester()) revert BadAttesterSig();

        delete _offers[tokenId];
        _update(msg.sender, tokenId, address(0));
        emit OfferAccepted(tokenId, o.from, msg.sender);
    }
```

`_update`가 이미 `_offers[tokenId]`를 지우고 `OfferCancelled`를 쏘므로 여기서 먼저 지워 중복 이벤트를 막는다.

- [ ] **Step 4: 테스트가 통과하는지 확인한다**

Run: `cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/contracts && forge test --match-path test/TicketOffer.t.sol -vv`
Expected: PASS — 7 tests passed.

- [ ] **Step 5: 커밋**

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI
git add contracts/src/Ticket.sol contracts/test/TicketOffer.t.sol
git commit -m "feat(contracts): attester-signed transfer offers for phone and nickname invites"
```

---

## Task 19: P-256 테스트 벡터 생성과 프리컴파일 목

**Files:**
- Create: `contracts/script/gen-p256-vectors.mjs`
- Create: `contracts/test/utils/P256Vectors.sol`
- Create: `contracts/test/mocks/MockP256Precompile.sol`
- Modify: `contracts/test/Base.t.sol` (목 etch + 기기 키 회원 헬퍼)

**Interfaces:**
- Consumes: Task 14의 `MontiTest`
- Produces:
  - `library P256Vectors` — `DEVICE_X`, `DEVICE_Y`, `OTHER_X`, `OTHER_Y`, `GATE1_DIGEST`, `GATE1_R`, `GATE1_S`, `GATE2_DIGEST`, `GATE2_R`, `GATE2_S`, `OTHER_R`, `OTHER_S`, 그리고 서명 대상 입력 `TOKEN_ID=1`, `EVENT_ID=1`, `GATE1_ID=1`, `GATE2_ID=2`, `NONCE`, `ISSUED_AT`
  - `contract MockP256Precompile` — 0x100에 etch되어 위 벡터에만 `1`을 돌려준다
  - `MontiTest._memberWithDeviceKey(account, personSeed)` — `P256Vectors.DEVICE_X/Y`로 등록
- **이 태스크의 Step 2가 이 플랜 전체에서 유일하게 "실행해서 값을 얻는" 단계다.** 다른 모든 값은 문서에 그대로 적혀 있다.

- [ ] **Step 1: 생성 스크립트를 쓴다**

`contracts/script/gen-p256-vectors.mjs`:

```javascript
// Run once:  cd contracts && npm i --no-save @noble/curves && node script/gen-p256-vectors.mjs
// Prints a complete Solidity library. Paste the output over test/utils/P256Vectors.sol.
import {p256} from '@noble/curves/nist';
import {sha256} from '@noble/hashes/sha2';

const TOKEN_ID = 1n;
const EVENT_ID = 1n;
const GATE1_ID = 1n;
const GATE2_ID = 2n;
const NONCE = '11'.repeat(32);
const ISSUED_AT = 1800000000n;

const DEVICE_PRIV = Uint8Array.from(Array.from({length: 32}, (_, i) => i + 1));
const OTHER_PRIV = Uint8Array.from(Array.from({length: 32}, (_, i) => 200 - i));

const word = (v) => v.toString(16).padStart(64, '0');
const hex = (u8) => Buffer.from(u8).toString('hex');

// abi.encode(uint256 tokenId, uint256 gateId, uint256 eventId, bytes32 nonce, uint64 issuedAt)
function digest(gateId) {
  const body = word(TOKEN_ID) + word(gateId) + word(EVENT_ID) + NONCE + word(ISSUED_AT);
  return sha256(Buffer.from(body, 'hex'));
}

function pub(priv) {
  const p = p256.getPublicKey(priv, false); // 0x04 || X(32) || Y(32)
  return {x: hex(p.slice(1, 33)), y: hex(p.slice(33, 65))};
}

function sign(priv, d) {
  const sig = p256.sign(d, priv, {lowS: true, prehash: false});
  return {r: sig.r.toString(16).padStart(64, '0'), s: sig.s.toString(16).padStart(64, '0')};
}

const dev = pub(DEVICE_PRIV);
const other = pub(OTHER_PRIV);
const d1 = digest(GATE1_ID);
const d2 = digest(GATE2_ID);
const s1 = sign(DEVICE_PRIV, d1);
const s2 = sign(DEVICE_PRIV, d2);
const s3 = sign(OTHER_PRIV, d1);

console.log(`// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

/// @notice Generated by script/gen-p256-vectors.mjs. Do not edit by hand.
library P256Vectors {
    uint256 internal constant TOKEN_ID = ${TOKEN_ID};
    uint256 internal constant EVENT_ID = ${EVENT_ID};
    uint256 internal constant GATE1_ID = ${GATE1_ID};
    uint256 internal constant GATE2_ID = ${GATE2_ID};
    bytes32 internal constant NONCE = 0x${NONCE};
    uint64 internal constant ISSUED_AT = ${ISSUED_AT};

    bytes32 internal constant DEVICE_X = 0x${dev.x};
    bytes32 internal constant DEVICE_Y = 0x${dev.y};
    bytes32 internal constant OTHER_X = 0x${other.x};
    bytes32 internal constant OTHER_Y = 0x${other.y};

    bytes32 internal constant GATE1_DIGEST = 0x${hex(d1)};
    bytes32 internal constant GATE1_R = 0x${s1.r};
    bytes32 internal constant GATE1_S = 0x${s1.s};

    bytes32 internal constant GATE2_DIGEST = 0x${hex(d2)};
    bytes32 internal constant GATE2_R = 0x${s2.r};
    bytes32 internal constant GATE2_S = 0x${s2.s};

    bytes32 internal constant OTHER_R = 0x${s3.r};
    bytes32 internal constant OTHER_S = 0x${s3.s};
}`);
```

- [ ] **Step 2: 스크립트를 한 번 돌려 벡터를 얻는다 (이 플랜의 유일한 "실행해서 값 얻기")**

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/contracts
npm i --no-save @noble/curves
node script/gen-p256-vectors.mjs > test/utils/P256Vectors.sol
head -20 test/utils/P256Vectors.sol
```
기대 형태: `DEVICE_X`/`DEVICE_Y`/`GATE1_R` 등이 전부 `0x` + 64자리 16진수. 하나라도 64자리가 아니면 패딩이 깨진 것이니 `word()`/`padStart`를 확인한다. `@noble/curves` v2는 `@noble/curves/nist`에서 `p256`을, v1은 `@noble/curves/p256`에서 내보낸다 — import 오류가 나면 경로를 `@noble/curves/p256`으로 바꿔 다시 돌린다.

Run: `cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/contracts && grep -c "0x[0-9a-f]\{64\}" test/utils/P256Vectors.sol`
Expected: `11` (DEVICE_X, DEVICE_Y, OTHER_X, OTHER_Y, GATE1_DIGEST/R/S, GATE2_DIGEST/R/S, OTHER_R, OTHER_S 중 `NONCE`를 제외한 개수 — 12에서 NONCE 한 줄이 `11`로 시작하는 동일 패턴이므로 실제 출력은 `12`가 나온다. 둘 중 어느 쪽이든 10 이상이면 정상이다.)

- [ ] **Step 3: 목 프리컴파일을 쓴다**

`contracts/test/mocks/MockP256Precompile.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {P256Vectors} from "../utils/P256Vectors.sol";

/// @notice Etched at 0x100 so the local EVM answers the EIP-7951 precompile the way Monad does.
///         It returns 1 only for the generated vectors, so "wrong device key" really fails.
///         The gas test (CheckInGas.t.sol) does NOT use this — it forks Monad testnet for the real
///         6,900-gas precompile, because a mock cannot tell us anything true about gas.
contract MockP256Precompile {
    fallback(bytes calldata input) external returns (bytes memory) {
        if (input.length != 160) return abi.encode(uint256(0));
        (bytes32 h, bytes32 r, bytes32 s, bytes32 x, bytes32 y) =
            abi.decode(input, (bytes32, bytes32, bytes32, bytes32, bytes32));

        bool ok;
        if (x == P256Vectors.DEVICE_X && y == P256Vectors.DEVICE_Y) {
            ok = (h == P256Vectors.GATE1_DIGEST && r == P256Vectors.GATE1_R && s == P256Vectors.GATE1_S)
                || (h == P256Vectors.GATE2_DIGEST && r == P256Vectors.GATE2_R && s == P256Vectors.GATE2_S);
        } else if (x == P256Vectors.OTHER_X && y == P256Vectors.OTHER_Y) {
            ok = (h == P256Vectors.GATE1_DIGEST && r == P256Vectors.OTHER_R && s == P256Vectors.OTHER_S);
        }
        return abi.encode(ok ? uint256(1) : uint256(0));
    }
}
```

- [ ] **Step 4: `Base.t.sol`에 etch와 헬퍼를 더한다**

`contracts/test/Base.t.sol`의 import에 두 줄을 더하고, `_deployMonti` 끝과 새 헬퍼를 넣는다:

```solidity
import {MockP256Precompile} from "./mocks/MockP256Precompile.sol";
import {P256Vectors} from "./utils/P256Vectors.sol";
```

```solidity
    address internal constant P256_PRECOMPILE = address(0x100);

    function _etchP256Mock() internal {
        MockP256Precompile mock = new MockP256Precompile();
        vm.etch(P256_PRECOMPILE, address(mock).code);
        vm.label(P256_PRECOMPILE, "P256Precompile");
    }

    function _memberWithDeviceKey(address account, uint256 personSeed) internal {
        vm.prank(attester);
        identity.register(bytes32(personSeed), account, P256Vectors.DEVICE_X, P256Vectors.DEVICE_Y, 1);
    }
```

`_deployMonti()`의 `vm.warp(T0);` 바로 앞에 `_etchP256Mock();` 한 줄을 넣는다.

- [ ] **Step 5: 목이 Solady 경로에서 실제로 동작하는지 확인한다**

`contracts/test/P256Mock.t.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {MontiTest} from "./Base.t.sol";
import {P256} from "solady/utils/P256.sol";
import {P256Vectors} from "./utils/P256Vectors.sol";

contract P256MockTest is MontiTest {
    function setUp() public {
        _deployMonti();
    }

    function test_mockAcceptsTheGeneratedVector() public view {
        assertTrue(
            P256.verifySignature(
                P256Vectors.GATE1_DIGEST,
                P256Vectors.GATE1_R,
                P256Vectors.GATE1_S,
                P256Vectors.DEVICE_X,
                P256Vectors.DEVICE_Y
            )
        );
    }

    function test_mockRejectsAnotherKeysSignature() public view {
        assertFalse(
            P256.verifySignature(
                P256Vectors.GATE1_DIGEST,
                P256Vectors.OTHER_R,
                P256Vectors.OTHER_S,
                P256Vectors.DEVICE_X,
                P256Vectors.DEVICE_Y
            )
        );
    }
}
```

Run: `cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/contracts && forge test --match-path test/P256Mock.t.sol -vv`
Expected: PASS — 2 tests passed. 첫 테스트가 실패하면 Solady가 s의 malleability를 거부한 것이므로 Step 2의 스크립트에서 `lowS: true`가 켜져 있는지 확인한다.

- [ ] **Step 6: 커밋**

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI
git add contracts/script/gen-p256-vectors.mjs contracts/test/utils/P256Vectors.sol contracts/test/mocks/MockP256Precompile.sol contracts/test/Base.t.sol contracts/test/P256Mock.t.sol
git commit -m "test(contracts): real P-256 vectors and an etched precompile mock at 0x100"
```

---

## Task 20: Ticket — `checkIn` 정상 경로

**Files:**
- Modify: `contracts/src/Ticket.sol`
- Test: `contracts/test/TicketCheckIn.t.sol`

**Interfaces:**
- Consumes: Task 19의 `P256Vectors`·목 프리컴파일, Task 13의 `isOpenGate`/`gateOf`, Task 4~6의 `activeDevice`/`isLocked`
- Produces: `checkIn(uint256 tokenId, GateCode calldata g, bytes calldata deviceSig) external` — 서명 대상은 마스터 플랜 그대로 `bytes32 h = sha256(abi.encode(tokenId, g.gateId, g.eventId, g.nonce, g.issuedAt))`이고, `deviceSig`는 `abi.decode(deviceSig, (bytes32, bytes32))`로 `(r, s)`를 얻는다. 통과하면 `CheckIn{gateId, ts, nonceHash: keccak256(abi.encode(g.nonce)), manual: false}`를 기록하고 `CheckedIn`을 쏜다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`contracts/test/TicketCheckIn.t.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {MontiTest} from "./Base.t.sol";
import {Ticket} from "../src/Ticket.sol";
import {P256Vectors} from "./utils/P256Vectors.sol";

contract TicketCheckInTest is MontiTest {
    uint256 internal orgId;
    uint256 internal eventId;
    uint256 internal tokenId;
    uint256 internal gateAId;
    uint256 internal gateBId;

    event CheckedIn(
        uint256 indexed tokenId, uint256 indexed eventId, uint256 indexed gateId, bytes32 nonceHash, uint64 ts
    );

    function setUp() public {
        _deployMonti();
        _memberWithDeviceKey(ALICE, 0xA1A1);
        orgId = _org();
        eventId = _freeEvent(orgId, 1, 1, true);
        assertEq(eventId, P256Vectors.EVENT_ID, "vectors were generated for event 1");

        vm.prank(ALICE);
        tokenId = ticket.claim(eventId, 0, "");
        assertEq(tokenId, P256Vectors.TOKEN_ID, "vectors were generated for token 1");

        vm.startPrank(ORG_OWNER);
        gateAId = organizers.registerGate(eventId, GATE_A, bytes32(uint256(0xGA)), bytes32(uint256(0xGB)));
        gateBId = organizers.registerGate(eventId, GATE_B, bytes32(uint256(0xGC)), bytes32(uint256(0xGD)));
        organizers.openGate(gateAId);
        organizers.openGate(gateBId);
        vm.stopPrank();

        vm.warp(P256Vectors.ISSUED_AT + 5);
    }

    function _code(uint256 gateId) internal pure returns (Ticket.GateCode memory) {
        return Ticket.GateCode({
            gateId: gateId,
            eventId: P256Vectors.EVENT_ID,
            issuedAt: P256Vectors.ISSUED_AT,
            nonce: P256Vectors.NONCE
        });
    }

    function _sigA() internal pure returns (bytes memory) {
        return abi.encode(P256Vectors.GATE1_R, P256Vectors.GATE1_S);
    }

    function _sigB() internal pure returns (bytes memory) {
        return abi.encode(P256Vectors.GATE2_R, P256Vectors.GATE2_S);
    }

    function test_openGateChecksInWithTheDeviceSignature() public {
        vm.expectEmit(true, true, true, true);
        emit CheckedIn(
            tokenId, eventId, gateAId, keccak256(abi.encode(P256Vectors.NONCE)), uint64(P256Vectors.ISSUED_AT + 5)
        );
        vm.prank(GATE_A);
        ticket.checkIn(tokenId, _code(gateAId), _sigA());

        Ticket.CheckIn memory c = ticket.checkInOf(tokenId);
        assertEq(c.gateId, gateAId);
        assertEq(c.ts, uint64(P256Vectors.ISSUED_AT + 5));
        assertEq(c.nonceHash, keccak256(abi.encode(P256Vectors.NONCE)));
        assertFalse(c.manual);
    }

    function test_digestMatchesTheSpecFormula() public view {
        bytes32 expected = sha256(
            abi.encode(
                P256Vectors.TOKEN_ID,
                P256Vectors.GATE1_ID,
                P256Vectors.EVENT_ID,
                P256Vectors.NONCE,
                P256Vectors.ISSUED_AT
            )
        );
        assertEq(expected, P256Vectors.GATE1_DIGEST, "generator and contract must hash the same bytes");
    }
}
```

`bytes32(uint256(0xGA))`는 16진수가 아니다. 다음 단계에서 고친다.

- [ ] **Step 2: 게이트 키 리터럴을 고치고 실패를 확인한다**

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/contracts
python3 - <<'PY'
import pathlib
p = pathlib.Path("test/TicketCheckIn.t.sol")
t = p.read_text()
for bad, good in (("0xGA", "0x6A01"), ("0xGB", "0x6A02"), ("0xGC", "0x6B01"), ("0xGD", "0x6B02")):
    t = t.replace(bad, good)
p.write_text(t)
PY
forge test --match-path test/TicketCheckIn.t.sol
```
Expected: FAIL — `Member "checkIn" not found or not visible after argument-dependent lookup in contract Ticket`.

- [ ] **Step 3: 구현을 쓴다**

`Ticket.sol` 상단 import에 한 줄을 더한다:

```solidity
import {P256} from "solady/utils/P256.sol";
```

`acceptOffer` 아래에 넣는다:

```solidity
    /// @notice Spec 7.2 step 6, checks in order: gate authority, ticket state, code freshness, device
    ///         signature. Only an open gate of this event may call it. The staff device maps each of
    ///         these errors to a DENY code on screen (sub-plan 04), so the names are part of the ABI.
    function checkIn(uint256 tokenId, GateCode calldata g, bytes calldata deviceSig) external {
        address holder = _ownerOf(tokenId);
        if (holder == address(0)) revert NoSuchTicket();

        uint256 eventId = _eventOf[tokenId];
        if (g.eventId != eventId) revert WrongEvent();
        if (eventStatus(eventId) == EventStatus.Ended) revert EventEnded();
        if (_revoked[tokenId]) revert TicketRevoked();
        if (_checkIns[tokenId].ts != 0) revert AlreadyCheckedIn();

        if (!organizers.isOpenGate(eventId, msg.sender)) revert GateNotOpen();
        if (organizers.gateOf(msg.sender) != g.gateId) revert GateMismatch();
        if (block.timestamp < g.issuedAt || block.timestamp - g.issuedAt > CODE_WINDOW) revert CodeExpired();

        if (identity.isLocked(holder)) revert DeviceLocked();
        (bytes32 x, bytes32 y) = identity.activeDevice(holder);
        if (x == bytes32(0) && y == bytes32(0)) revert NoActiveDevice();

        bytes32 h = sha256(abi.encode(tokenId, g.gateId, g.eventId, g.nonce, g.issuedAt));
        (bytes32 r, bytes32 s) = abi.decode(deviceSig, (bytes32, bytes32));
        if (!P256.verifySignature(h, r, s, x, y)) revert BadDeviceSignature();

        bytes32 nonceHash = keccak256(abi.encode(g.nonce));
        _checkIns[tokenId] =
            CheckIn({gateId: g.gateId, ts: uint64(block.timestamp), nonceHash: nonceHash, manual: false});
        if (_offers[tokenId].from != address(0)) {
            delete _offers[tokenId];
            emit OfferCancelled(tokenId);
        }

        emit CheckedIn(tokenId, eventId, g.gateId, nonceHash, uint64(block.timestamp));
    }
```

- [ ] **Step 4: 테스트가 통과하는지 확인한다**

Run: `cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/contracts && forge test --match-path test/TicketCheckIn.t.sol -vv`
Expected: PASS — 2 tests passed. `test_digestMatchesTheSpecFormula`가 실패하면 생성 스크립트의 바이트 순서가 컨트랙트와 다르다는 뜻이므로 Task 19 Step 1의 `digest()` 순서를 `tokenId, gateId, eventId, nonce, issuedAt`으로 다시 맞춘다.

- [ ] **Step 5: 커밋**

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI
git add contracts/src/Ticket.sol contracts/test/TicketCheckIn.t.sol
git commit -m "feat(contracts): checkIn verifies the device P-256 signature over the gate code"
```

---

## Task 21: Ticket — `checkIn` 거부 경로 전부(위협 모델 T2·T12·T13·T14)

**Files:**
- Test: `contracts/test/TicketCheckIn.t.sol` (테스트만 추가)
- Test: `contracts/test/TicketTransfer.t.sol` (입장 후 양도 금지 추가)
- Test: `contracts/test/TicketOffer.t.sol` (입장 후 제안 무효 추가)

**Interfaces:**
- Consumes: Task 20의 `checkIn`과 모든 커스텀 에러
- Produces: 새 프로덕션 코드 없음. 스태프 단말기(서브플랜 04)가 화면에 띄울 DENY 코드마다 하나씩 대응되는 테스트. 이 태스크가 끝나면 `Ticket`의 에러 이름이 ABI에 고정되어 04가 `selector → DENY` 표를 만들 수 있다.

- [ ] **Step 1: 거부 경로 테스트를 쓴다**

`contracts/test/TicketCheckIn.t.sol`에 붙인다:

```solidity
    function test_T14_fakeGateRejected() public {
        vm.prank(address(0xFA4E));
        vm.expectRevert(Ticket.GateNotOpen.selector);
        ticket.checkIn(tokenId, _code(gateAId), _sigA());
    }

    function test_closedGateRejected() public {
        vm.prank(ORG_OWNER);
        organizers.closeGate(gateAId);
        vm.prank(GATE_A);
        vm.expectRevert(Ticket.GateNotOpen.selector);
        ticket.checkIn(tokenId, _code(gateAId), _sigA());
    }

    function test_revokedGateRejected() public {
        vm.prank(ORG_OWNER);
        organizers.revokeGate(gateAId);
        vm.prank(GATE_A);
        vm.expectRevert(Ticket.GateNotOpen.selector);
        ticket.checkIn(tokenId, _code(gateAId), _sigA());
    }

    function test_gateCannotUseAnotherGatesId() public {
        vm.prank(GATE_A);
        vm.expectRevert(Ticket.GateMismatch.selector);
        ticket.checkIn(tokenId, _code(gateBId), _sigB());
    }

    function test_T2_staleCodeRejectedAfterSixtySeconds() public {
        vm.warp(P256Vectors.ISSUED_AT + 61);
        vm.prank(GATE_A);
        vm.expectRevert(Ticket.CodeExpired.selector);
        ticket.checkIn(tokenId, _code(gateAId), _sigA());
    }

    function test_codeAtExactlySixtySecondsStillWorks() public {
        vm.warp(P256Vectors.ISSUED_AT + 60);
        vm.prank(GATE_A);
        ticket.checkIn(tokenId, _code(gateAId), _sigA());
        assertEq(ticket.checkInOf(tokenId).gateId, gateAId);
    }

    function test_futureCodeRejected() public {
        vm.warp(P256Vectors.ISSUED_AT - 1);
        vm.prank(GATE_A);
        vm.expectRevert(Ticket.CodeExpired.selector);
        ticket.checkIn(tokenId, _code(gateAId), _sigA());
    }

    function test_T6_wrongDeviceKeyRejected() public {
        vm.prank(GATE_A);
        vm.expectRevert(Ticket.BadDeviceSignature.selector);
        ticket.checkIn(tokenId, _code(gateAId), abi.encode(P256Vectors.OTHER_R, P256Vectors.OTHER_S));
    }

    function test_T12_doubleCheckInRejected() public {
        vm.prank(GATE_A);
        ticket.checkIn(tokenId, _code(gateAId), _sigA());
        vm.prank(GATE_A);
        vm.expectRevert(Ticket.AlreadyCheckedIn.selector);
        ticket.checkIn(tokenId, _code(gateAId), _sigA());
    }

    function test_T13_secondGateRevertsForTheSameTicket() public {
        vm.prank(GATE_A);
        ticket.checkIn(tokenId, _code(gateAId), _sigA());
        vm.prank(GATE_B);
        vm.expectRevert(Ticket.AlreadyCheckedIn.selector);
        ticket.checkIn(tokenId, _code(gateBId), _sigB());
    }

    function test_T7_lockedDeviceRejected() public {
        vm.prank(ALICE);
        identity.lockDevice(ALICE);
        vm.prank(GATE_A);
        vm.expectRevert(Ticket.DeviceLocked.selector);
        ticket.checkIn(tokenId, _code(gateAId), _sigA());
    }

    function test_wrongEventRejected() public {
        Ticket.GateCode memory bad = _code(gateAId);
        bad.eventId = 99;
        vm.prank(GATE_A);
        vm.expectRevert(Ticket.WrongEvent.selector);
        ticket.checkIn(tokenId, bad, _sigA());
    }

    function test_unknownTicketRejected() public {
        vm.prank(GATE_A);
        vm.expectRevert(Ticket.NoSuchTicket.selector);
        ticket.checkIn(4242, _code(gateAId), _sigA());
    }

    function test_endedEventRejected() public {
        vm.warp(T0 + 2 days + 1);
        vm.prank(GATE_A);
        vm.expectRevert(Ticket.EventEnded.selector);
        ticket.checkIn(tokenId, _code(gateAId), _sigA());
    }
```

- [ ] **Step 2: 실행해서 전부 초록인지 본다**

Run: `cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/contracts && forge test --match-path test/TicketCheckIn.t.sol -vv`
Expected: PASS — 16 tests passed. 프로덕션 코드는 건드리지 않는다. 하나라도 빨간색이면 Task 20 Step 3의 검사 **순서**가 다른 것이다(예: `test_unknownTicketRejected`가 `WrongEvent`로 실패하면 `NoSuchTicket` 검사가 뒤로 밀린 것).

- [ ] **Step 3: 입장 후 양도 금지 테스트를 더한다**

`contracts/test/TicketTransfer.t.sol`에 붙인다:

```solidity
    function test_transferAfterCheckInReverts() public {
        _memberWithDeviceKey(address(0xD1), 0xD1D1);
        uint256 gateId;
        vm.startPrank(ORG_OWNER);
        gateId = organizers.registerGate(eventId, GATE_A, bytes32(uint256(0x6A01)), bytes32(uint256(0x6A02)));
        organizers.openGate(gateId);
        vm.stopPrank();

        // ALICE holds token 1 for event 1 — exactly what the vectors were generated for.
        vm.warp(P256Vectors.ISSUED_AT + 5);
        vm.prank(GATE_A);
        ticket.checkIn(
            tokenId,
            Ticket.GateCode({
                gateId: gateId,
                eventId: P256Vectors.EVENT_ID,
                issuedAt: P256Vectors.ISSUED_AT,
                nonce: P256Vectors.NONCE
            }),
            abi.encode(P256Vectors.GATE1_R, P256Vectors.GATE1_S)
        );

        vm.prank(ALICE);
        vm.expectRevert(Ticket.AlreadyCheckedIn.selector);
        ticket.transferFrom(ALICE, BOB, tokenId);
    }
```

이 테스트가 돌려면 `TicketTransfer.t.sol`의 `setUp`에서 ALICE가 기기 키 회원이어야 한다. import 두 줄과 `_member(ALICE, 0xA1A1)` → `_memberWithDeviceKey(ALICE, 0xA1A1)` 치환을 함께 적용한다:

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/contracts
python3 - <<'PY'
import pathlib
p = pathlib.Path("test/TicketTransfer.t.sol")
t = p.read_text()
t = t.replace('import {Ticket} from "../src/Ticket.sol";',
              'import {Ticket} from "../src/Ticket.sol";\nimport {P256Vectors} from "./utils/P256Vectors.sol";')
t = t.replace("_member(ALICE, 0xA1A1);", "_memberWithDeviceKey(ALICE, 0xA1A1);")
p.write_text(t)
PY
forge test --match-path test/TicketTransfer.t.sol -vv
```
Expected: PASS — 9 tests passed.

- [ ] **Step 4: 입장 후 제안 무효 테스트를 더한다**

`contracts/test/TicketOffer.t.sol`에 붙인다:

```solidity
    function test_offerIsVoidAfterCheckIn() public {
        vm.prank(ALICE);
        ticket.createOffer(tokenId, COMMITMENT, uint64(P256Vectors.ISSUED_AT + 1 hours));

        uint256 gateId;
        vm.startPrank(ORG_OWNER);
        gateId = organizers.registerGate(eventId, GATE_A, bytes32(uint256(0x6A01)), bytes32(uint256(0x6A02)));
        organizers.openGate(gateId);
        vm.stopPrank();

        vm.warp(P256Vectors.ISSUED_AT + 5);
        vm.prank(GATE_A);
        ticket.checkIn(
            tokenId,
            Ticket.GateCode({
                gateId: gateId,
                eventId: P256Vectors.EVENT_ID,
                issuedAt: P256Vectors.ISSUED_AT,
                nonce: P256Vectors.NONCE
            }),
            abi.encode(P256Vectors.GATE1_R, P256Vectors.GATE1_S)
        );

        assertEq(ticket.offerOf(tokenId).from, address(0));
        vm.prank(BOB);
        vm.expectRevert(Ticket.NoOffer.selector);
        ticket.acceptOffer(tokenId, _sig(tokenId, COMMITMENT, BOB));
    }
```

그리고 이 파일도 기기 키 회원과 import가 필요하다:

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/contracts
python3 - <<'PY'
import pathlib
p = pathlib.Path("test/TicketOffer.t.sol")
t = p.read_text()
t = t.replace('import {Ticket} from "../src/Ticket.sol";',
              'import {Ticket} from "../src/Ticket.sol";\nimport {P256Vectors} from "./utils/P256Vectors.sol";')
t = t.replace("_member(ALICE, 0xA1A1);", "_memberWithDeviceKey(ALICE, 0xA1A1);")
p.write_text(t)
PY
forge test --match-path test/TicketOffer.t.sol -vv
```
Expected: PASS — 8 tests passed.

- [ ] **Step 5: 전체 회귀**

Run: `cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/contracts && forge test -vv`
Expected: PASS — 이 시점 누적 86 tests passed, 0 failed.

- [ ] **Step 6: 커밋**

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI
git add contracts/test/TicketCheckIn.t.sol contracts/test/TicketTransfer.t.sol contracts/test/TicketOffer.t.sol
git commit -m "test(contracts): every checkIn denial path reverts with its own named error"
```

---

## Task 22: Ticket — 수동 승인과 결재 요청

**Files:**
- Modify: `contracts/src/Ticket.sol`
- Test: `contracts/test/TicketOverride.t.sol`

**Interfaces:**
- Consumes: Task 11의 `managerOf`, Task 10의 `hasPermission(PERM_APPROVE_OVERRIDE)`
- Produces: `requestOverride(uint256 tokenId, uint256 gateId, uint8 reason)`(매니저이기만 하면 됨), `manualOverride(uint256 tokenId, uint256 gateId, uint8 reason)`(`PERM_APPROVE_OVERRIDE` 보유자는 role 1, `canApprove` 매니저는 role 2). `manualOverride`는 `CheckedIn`도 함께 쏜다 — 스태프 화면과 인덱서가 입장 이벤트 하나만 구독하면 되게 하기 위해서다(`nonceHash`는 `bytes32(0)`, `manual`은 `true`).

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`contracts/test/TicketOverride.t.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {MontiTest} from "./Base.t.sol";
import {Ticket} from "../src/Ticket.sol";

contract TicketOverrideTest is MontiTest {
    uint256 internal orgId;
    uint256 internal eventId;
    uint256 internal tokenId;
    uint256 internal gateId;

    address internal constant ADMIN = address(0x0A);
    address internal constant MANAGER_YES = address(0x0B);
    address internal constant MANAGER_NO = address(0x0C);

    event OverrideRequested(uint256 indexed tokenId, uint256 indexed gateId, address indexed requester, uint8 reason);
    event ManualOverride(
        uint256 indexed tokenId, uint256 indexed gateId, address indexed approver, uint8 role, uint8 reason
    );

    function setUp() public {
        _deployMonti();
        _memberWithDeviceKey(ALICE, 0xA1A1);
        orgId = _org();
        eventId = _freeEvent(orgId, 1, 1, true);
        vm.prank(ALICE);
        tokenId = ticket.claim(eventId, 0, "");

        vm.startPrank(ORG_OWNER);
        organizers.setAdmin(orgId, ADMIN, organizers.PERM_APPROVE_OVERRIDE());
        organizers.setManager(orgId, MANAGER_YES, true, true);
        organizers.setManager(orgId, MANAGER_NO, true, false);
        gateId = organizers.registerGate(eventId, GATE_A, bytes32(uint256(0x6A01)), bytes32(uint256(0x6A02)));
        organizers.openGate(gateId);
        vm.stopPrank();
    }

    function test_managerWithoutApprovalCanOnlyRequest() public {
        vm.expectEmit(true, true, true, true);
        emit OverrideRequested(tokenId, gateId, MANAGER_NO, 3);
        vm.prank(MANAGER_NO);
        ticket.requestOverride(tokenId, gateId, 3);

        vm.prank(MANAGER_NO);
        vm.expectRevert(Ticket.Unauthorized.selector);
        ticket.manualOverride(tokenId, gateId, 3);
        assertEq(ticket.checkInOf(tokenId).ts, 0);
    }

    function test_managerWithApprovalAdmitsWithRoleTwo() public {
        vm.expectEmit(true, true, true, true);
        emit ManualOverride(tokenId, gateId, MANAGER_YES, 2, 3);
        vm.prank(MANAGER_YES);
        ticket.manualOverride(tokenId, gateId, 3);

        Ticket.CheckIn memory c = ticket.checkInOf(tokenId);
        assertEq(c.gateId, gateId);
        assertTrue(c.manual);
        assertEq(c.nonceHash, bytes32(0));
    }

    function test_adminWithApproveBitAdmitsWithRoleOne() public {
        vm.expectEmit(true, true, true, true);
        emit ManualOverride(tokenId, gateId, ADMIN, 1, 5);
        vm.prank(ADMIN);
        ticket.manualOverride(tokenId, gateId, 5);
        assertTrue(ticket.checkInOf(tokenId).manual);
    }

    function test_strangerCanNeitherRequestNorApprove() public {
        vm.prank(BOB);
        vm.expectRevert(Ticket.Unauthorized.selector);
        ticket.requestOverride(tokenId, gateId, 1);
        vm.prank(BOB);
        vm.expectRevert(Ticket.Unauthorized.selector);
        ticket.manualOverride(tokenId, gateId, 1);
    }

    function test_manualOverrideCannotDoubleAdmit() public {
        vm.prank(MANAGER_YES);
        ticket.manualOverride(tokenId, gateId, 3);
        vm.prank(ADMIN);
        vm.expectRevert(Ticket.AlreadyCheckedIn.selector);
        ticket.manualOverride(tokenId, gateId, 3);
    }
}
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/contracts && forge test --match-path test/TicketOverride.t.sol`
Expected: FAIL — `Member "requestOverride" not found or not visible after argument-dependent lookup in contract Ticket`.

- [ ] **Step 3: 구현을 쓴다**

`checkIn` 아래에 넣는다:

```solidity
    /// @notice Spec 13: a manager without approval rights files a request; someone with rights admits.
    function requestOverride(uint256 tokenId, uint256 gateId, uint8 reason) external {
        uint256 orgId = _events[_eventOf[tokenId]].orgId;
        if (orgId == 0) revert NoSuchTicket();
        (bool exists,) = organizers.managerOf(orgId, msg.sender);
        if (!exists && !organizers.hasPermission(orgId, msg.sender, PERM_APPROVE_OVERRIDE)) revert Unauthorized();
        emit OverrideRequested(tokenId, gateId, msg.sender, reason);
    }

    /// @notice role 1 = admin (or owner) holding PERM_APPROVE_OVERRIDE, role 2 = manager with canApprove.
    ///         Emits CheckedIn as well so the staff screen and the indexer watch one event only.
    function manualOverride(uint256 tokenId, uint256 gateId, uint8 reason) external {
        if (_ownerOf(tokenId) == address(0)) revert NoSuchTicket();
        uint256 eventId = _eventOf[tokenId];
        uint256 orgId = _events[eventId].orgId;

        uint8 role;
        if (organizers.hasPermission(orgId, msg.sender, PERM_APPROVE_OVERRIDE)) {
            role = 1;
        } else {
            (bool exists, bool canApprove) = organizers.managerOf(orgId, msg.sender);
            if (exists && canApprove) role = 2;
        }
        if (role == 0) revert Unauthorized();
        if (_revoked[tokenId]) revert TicketRevoked();
        if (_checkIns[tokenId].ts != 0) revert AlreadyCheckedIn();

        _checkIns[tokenId] = CheckIn({gateId: gateId, ts: uint64(block.timestamp), nonceHash: bytes32(0), manual: true});

        emit ManualOverride(tokenId, gateId, msg.sender, role, reason);
        emit CheckedIn(tokenId, eventId, gateId, bytes32(0), uint64(block.timestamp));
    }
```

- [ ] **Step 4: 테스트가 통과하는지 확인한다**

Run: `cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/contracts && forge test --match-path test/TicketOverride.t.sol -vv`
Expected: PASS — 5 tests passed.

- [ ] **Step 5: 커밋**

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI
git add contracts/src/Ticket.sol contracts/test/TicketOverride.t.sol
git commit -m "feat(contracts): manual override with on-chain approver role and reason"
```

---

## Task 23: Ticket — `revoke`와 `migrate`

**Files:**
- Modify: `contracts/src/Ticket.sol`
- Test: `contracts/test/TicketMigrate.t.sol`

**Interfaces:**
- Consumes: Task 7의 `rotateAccount`, Task 17의 `_internalMove`
- Produces: `revoke(uint256 tokenId, uint8 reason)`(`PERM_CREATE_EVENT`), `migrate(uint256 tokenId)` — `identity.accountOf(identity.personOf(ownerOf(tokenId))) == msg.sender`일 때만. 규칙(`maxTransfers`, 마감, `maxPerWallet`)을 건너뛰고 `transfersOf`도 올리지 않는다. 같은 사람의 새 계정으로 옮기는 것이지 양도가 아니기 때문이다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`contracts/test/TicketMigrate.t.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {MontiTest} from "./Base.t.sol";
import {Ticket} from "../src/Ticket.sol";

contract TicketMigrateTest is MontiTest {
    uint256 internal orgId;
    uint256 internal eventId;
    uint256 internal tokenId;

    event Migrated(uint256 indexed tokenId, address indexed from, address indexed to);
    event Revoked(uint256 indexed tokenId, uint8 reason);

    function setUp() public {
        _deployMonti();
        _memberWithDeviceKey(ALICE, 0xA1A1);
        orgId = _org();
        eventId = _freeEvent(orgId, 1, 0, true);
        vm.prank(ALICE);
        tokenId = ticket.claim(eventId, 0, "");
    }

    function _rotateAliceTo(address newAccount) internal {
        vm.warp(T0 + 7 days);
        vm.prank(attester);
        identity.rotateAccount(bytes32(uint256(0xA1A1)), newAccount);
    }

    function test_migrateMovesTheTicketToTheRotatedAccount() public {
        _rotateAliceTo(BOB);

        vm.expectEmit(true, true, true, false);
        emit Migrated(tokenId, ALICE, BOB);
        vm.prank(BOB);
        ticket.migrate(tokenId);

        assertEq(ticket.ownerOf(tokenId), BOB);
        assertEq(ticket.transfersOf(tokenId), 0, "migrate is not a transfer");
        assertEq(ticket.balanceOfEvent(BOB, eventId), 1);
        assertEq(ticket.balanceOfEvent(ALICE, eventId), 0);
    }

    function test_onlyTheRotatedAccountCanMigrate() public {
        _rotateAliceTo(BOB);
        vm.prank(CAROL);
        vm.expectRevert(Ticket.NotRotatedAccount.selector);
        ticket.migrate(tokenId);
        vm.prank(ALICE);
        vm.expectRevert(Ticket.NotRotatedAccount.selector);
        ticket.migrate(tokenId);
    }

    function test_migrateIsANoOpErrorWhenNothingRotated() public {
        vm.prank(ALICE);
        vm.expectRevert(Ticket.NothingToMigrate.selector);
        ticket.migrate(tokenId);
    }

    function test_migrateIgnoresMaxTransfersAndCutoff() public {
        // maxTransfers is 0 for this event and we are past the transfer cutoff.
        _rotateAliceTo(BOB);
        vm.warp(T0 + 1 days - 1 minutes);
        vm.prank(BOB);
        ticket.migrate(tokenId);
        assertEq(ticket.ownerOf(tokenId), BOB);
    }

    function test_revokeBlocksTransferAndCheckIn() public {
        vm.expectEmit(true, false, false, true);
        emit Revoked(tokenId, 2);
        vm.prank(ORG_OWNER);
        ticket.revoke(tokenId, 2);

        _member(CAROL, 0xCACA);
        vm.prank(ALICE);
        vm.expectRevert(Ticket.TicketRevoked.selector);
        ticket.transferFrom(ALICE, CAROL, tokenId);
    }

    function test_onlyCreateEventPermissionRevokes() public {
        vm.prank(BOB);
        vm.expectRevert(Ticket.Unauthorized.selector);
        ticket.revoke(tokenId, 1);
    }
}
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/contracts && forge test --match-path test/TicketMigrate.t.sol`
Expected: FAIL — `Member "migrate" not found or not visible after argument-dependent lookup in contract Ticket`.

- [ ] **Step 3: 구현을 쓴다**

`manualOverride` 아래에 넣는다:

```solidity
    function revoke(uint256 tokenId, uint8 reason) external {
        if (_ownerOf(tokenId) == address(0)) revert NoSuchTicket();
        _requireEventPermission(_eventOf[tokenId], PERM_CREATE_EVENT);
        _revoked[tokenId] = true;
        emit Revoked(tokenId, reason);
    }

    /// @notice Spec 5.5: the attester rotated this person's account, so the ticket follows the person.
    ///         Transfer rules do not apply — nobody else is receiving anything.
    function migrate(uint256 tokenId) external {
        address holder = _ownerOf(tokenId);
        if (holder == address(0)) revert NoSuchTicket();

        bytes32 personId = identity.personOf(holder);
        if (personId == bytes32(0)) revert NotMember();
        address current = identity.accountOf(personId);
        if (current != msg.sender) revert NotRotatedAccount();
        if (current == holder) revert NothingToMigrate();

        _internalMove = true;
        _update(msg.sender, tokenId, address(0));
        _internalMove = false;

        emit Migrated(tokenId, holder, msg.sender);
    }
```

- [ ] **Step 4: 테스트가 통과하는지 확인한다**

Run: `cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/contracts && forge test --match-path test/TicketMigrate.t.sol -vv`
Expected: PASS — 6 tests passed.

- [ ] **Step 5: 커밋**

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI
git add contracts/src/Ticket.sol contracts/test/TicketMigrate.t.sol
git commit -m "feat(contracts): revoke and migrate for rotated accounts"
```

---

## Task 24: Ticket — 온체인 `tokenURI` (입장 전 / 입장 완료)

**Files:**
- Modify: `contracts/src/Ticket.sol`
- Test: `contracts/test/TicketURI.t.sol`

**Interfaces:**
- Consumes: Task 16의 `_tierOf`·`_checkIns`, Task 14의 `imageCid`
- Produces: `tokenURI(uint256 tokenId) public view override returns (string memory)` — 체인 데이터만으로 JSON을 조립해 `data:application/json;base64,…`로 돌려준다. 속성에 **상태**가 들어가고 값은 입장 전에는 `입장 전`, 입장 후에는 `입장 완료`다(기획 §10.2). 서브플랜 03의 티켓 화면과 블록 탐색기가 같은 것을 본다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`contracts/test/TicketURI.t.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {MontiTest} from "./Base.t.sol";
import {Ticket} from "../src/Ticket.sol";
import {P256Vectors} from "./utils/P256Vectors.sol";
import {Base64} from "solady/utils/Base64.sol";
import {LibString} from "solady/utils/LibString.sol";

contract TicketURITest is MontiTest {
    uint256 internal eventId;
    uint256 internal tokenId;
    uint256 internal gateId;

    function setUp() public {
        _deployMonti();
        _memberWithDeviceKey(ALICE, 0xA1A1);
        uint256 orgId = _org();
        eventId = _freeEvent(orgId, 1, 1, true);
        vm.prank(ALICE);
        tokenId = ticket.claim(eventId, 0, "");
        vm.startPrank(ORG_OWNER);
        gateId = organizers.registerGate(eventId, GATE_A, bytes32(uint256(0x6A01)), bytes32(uint256(0x6A02)));
        organizers.openGate(gateId);
        vm.stopPrank();
    }

    function _json(uint256 id) internal view returns (string memory) {
        string memory uri = ticket.tokenURI(id);
        assertTrue(LibString.startsWith(uri, "data:application/json;base64,"), "must be an on-chain data URI");
        return string(Base64.decode(LibString.slice(uri, 29)));
    }

    function test_uriCarriesNameImageAndNotYetEnteredStatus() public view {
        string memory json = _json(tokenId);
        assertTrue(LibString.contains(json, "MONTI Ticket #1"));
        assertTrue(LibString.contains(json, "ipfs://bafyTestCid"));
        assertTrue(LibString.contains(json, "General"));
        assertTrue(LibString.contains(json, unicode"입장 전"));
        assertFalse(LibString.contains(json, unicode"입장 완료"));
    }

    function test_uriFlipsToEnteredAfterCheckIn() public {
        vm.warp(P256Vectors.ISSUED_AT + 5);
        vm.prank(GATE_A);
        ticket.checkIn(
            tokenId,
            Ticket.GateCode({
                gateId: gateId,
                eventId: P256Vectors.EVENT_ID,
                issuedAt: P256Vectors.ISSUED_AT,
                nonce: P256Vectors.NONCE
            }),
            abi.encode(P256Vectors.GATE1_R, P256Vectors.GATE1_S)
        );

        string memory json = _json(tokenId);
        assertTrue(LibString.contains(json, unicode"입장 완료"));
    }

    function test_uriForUnknownTokenReverts() public {
        vm.expectRevert();
        ticket.tokenURI(999);
    }
}
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/contracts && forge test --match-path test/TicketURI.t.sol`
Expected: FAIL — `assertion failed: must be an on-chain data URI` (ERC721 기본 `tokenURI`는 빈 문자열을 돌려준다).

- [ ] **Step 3: 구현을 쓴다**

`Ticket.sol` 상단 import에 두 줄을 더한다:

```solidity
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
```

`migrate` 아래에 넣는다:

```solidity
    using Strings for uint256;

    /// @notice Everything the ticket shows comes from the chain (spec 10.2). The status attribute is
    ///         the one visible thing checkIn changes: 입장 전 -> 입장 완료.
    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        address holder = _ownerOf(tokenId);
        if (holder == address(0)) revert NoSuchTicket();

        uint256 eventId = _eventOf[tokenId];
        EventMeta storage m = _events[eventId];
        Tier storage t = _tiers[eventId][_tierOf[tokenId]];
        bool entered = _checkIns[tokenId].ts != 0;

        string memory attributes = string.concat(
            '[{"trait_type":"Event","value":"', eventId.toString(),
            '"},{"trait_type":"Tier","value":"', t.name,
            '"},{"trait_type":"Starts","display_type":"date","value":', uint256(m.startsAt).toString(),
            '},{"trait_type":"Seated","value":"', t.seated ? "true" : "false",
            '"},{"trait_type":"Transferable","value":"', m.transferable ? "true" : "false",
            unicode'"},{"trait_type":"상태","value":"', entered ? unicode"입장 완료" : unicode"입장 전",
            '"}]'
        );

        string memory json = string.concat(
            '{"name":"MONTI Ticket #', tokenId.toString(),
            '","description":"MONTI on-chain admission. The chain decides, not our server.',
            '","image":"ipfs://', m.imageCid,
            '","attributes":', attributes, "}"
        );

        return string.concat("data:application/json;base64,", Base64.encode(bytes(json)));
    }
```

`using Strings for uint256;`는 컨트랙트 최상단(구조체 선언 위)으로 옮겨야 컴파일된다 — 함수 안이 아니라 컨트랙트 바디의 첫 줄들에 두는 것이 Solidity 문법이다.

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/contracts
python3 - <<'PY'
import pathlib
p = pathlib.Path("src/Ticket.sol")
t = p.read_text()
t = t.replace("    using Strings for uint256;\n\n", "", 1)
t = t.replace("contract Ticket is ERC721, ITicket {\n", "contract Ticket is ERC721, ITicket {\n    using Strings for uint256;\n\n", 1)
p.write_text(t)
PY
forge build
```
Expected: 컴파일 성공.

- [ ] **Step 4: 테스트가 통과하는지 확인한다**

Run: `cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/contracts && forge test --match-path test/TicketURI.t.sol -vv`
Expected: PASS — 3 tests passed. `LibString.contains`가 없다는 컴파일 오류가 나면 Solady 버전이 낮은 것이니 `LibString.indexOf(json, needle) != LibString.NOT_FOUND`로 바꾼다.

- [ ] **Step 5: 런타임 크기를 확인한다**

Run: `cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/contracts && forge build --sizes | grep -E "Ticket|Identity|Organizers"`
Expected: `Ticket`의 runtime size가 128 KB(131,072 B) 한참 아래(대략 12~18 KB). 24 KB를 넘어도 Monad에서는 문제없지만 숫자를 기록해 둔다.

- [ ] **Step 6: 커밋**

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI
git add contracts/src/Ticket.sol contracts/test/TicketURI.t.sol
git commit -m "feat(contracts): on-chain tokenURI with 입장 전/입장 완료 status"
```

---

## Task 25: MontiPaymaster — 예산 칸과 MockEntryPoint

**Files:**
- Create: `contracts/src/MontiPaymaster.sol`
- Create: `contracts/test/mocks/MockEntryPoint.sol`
- Test: `contracts/test/Paymaster.t.sol`

**Interfaces:**
- Consumes: `IEntryPoint`/`IPaymaster`/`UserOperation`(v0.6, Task 2), `IOrganizers.ownerOf`(Task 9)
- Produces:
  - `contract MontiPaymaster is IPaymaster` — `constructor(IEntryPoint entryPoint_, IOrganizers organizers_)`, `uint256 public constant PLATFORM = 0`
  - `depositPlatform() payable`, `deposit(uint256 orgId) payable`, `withdraw(uint256 orgId, uint256 amount)`, `setSelfSponsored(uint256 orgId, bool on)`, `budgetOf(uint256 orgId) view returns (uint256)`, `selfSponsored(uint256) view returns (bool)`
  - `event Deposited(uint256 indexed orgId, uint256 amount)`, `event BudgetDebited(uint256 indexed orgId, address indexed sender, uint256 amount)`, `event SponsorModeSet(uint256 indexed orgId, bool selfSponsored)`
  - `setTargets(address ticket_, address identity_)`(deployer, 1회) — Task 26이 쓴다
  - `MockEntryPoint` — `depositTo`, `withdrawTo`, `balanceOf`, `addStake`, `unlockStake`, `withdrawStake`, 그리고 테스트가 EntryPoint 행세를 하도록 `callValidate(...)`

- [ ] **Step 1: MockEntryPoint를 쓴다**

`contracts/test/mocks/MockEntryPoint.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {UserOperation} from "account-abstraction/interfaces/UserOperation.sol";
import {IPaymaster} from "account-abstraction/interfaces/IPaymaster.sol";

/// @notice Just enough EntryPoint v0.6 for the paymaster tests: it holds deposits, tracks stake and
///         can call validatePaymasterUserOp as the real EntryPoint would (msg.sender == entryPoint).
contract MockEntryPoint {
    mapping(address => uint256) public balanceOf;
    mapping(address => uint256) public stakeOf;
    mapping(address => uint32) public unstakeDelayOf;
    mapping(address => bool) public unlocked;

    function depositTo(address account) external payable {
        balanceOf[account] += msg.value;
    }

    function withdrawTo(address payable to, uint256 amount) external {
        balanceOf[msg.sender] -= amount;
        (bool ok,) = to.call{value: amount}("");
        require(ok, "withdraw failed");
    }

    function addStake(uint32 unstakeDelaySec) external payable {
        stakeOf[msg.sender] += msg.value;
        unstakeDelayOf[msg.sender] = unstakeDelaySec;
        unlocked[msg.sender] = false;
    }

    function unlockStake() external {
        unlocked[msg.sender] = true;
    }

    function withdrawStake(address payable to) external {
        require(unlocked[msg.sender], "not unlocked");
        uint256 amount = stakeOf[msg.sender];
        stakeOf[msg.sender] = 0;
        (bool ok,) = to.call{value: amount}("");
        require(ok, "withdraw failed");
    }

    function callValidate(address paymaster, UserOperation calldata op, bytes32 opHash, uint256 maxCost)
        external
        returns (bytes memory context, uint256 validationData)
    {
        return IPaymaster(paymaster).validatePaymasterUserOp(op, opHash, maxCost);
    }

    receive() external payable {}
}
```

- [ ] **Step 2: 실패하는 테스트를 쓴다**

`contracts/test/Paymaster.t.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {MontiTest} from "./Base.t.sol";
import {MontiPaymaster} from "../src/MontiPaymaster.sol";
import {MockEntryPoint} from "./mocks/MockEntryPoint.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {IOrganizers} from "../src/interfaces/IOrganizers.sol";

contract PaymasterTest is MontiTest {
    MockEntryPoint internal ep;
    MontiPaymaster internal paymaster;
    uint256 internal orgId;

    event Deposited(uint256 indexed orgId, uint256 amount);
    event SponsorModeSet(uint256 indexed orgId, bool selfSponsored);

    function setUp() public {
        _deployMonti();
        ep = new MockEntryPoint();
        paymaster = new MontiPaymaster(IEntryPoint(address(ep)), IOrganizers(address(organizers)));
        paymaster.setTargets(address(ticket), address(identity));
        orgId = _org();
        vm.deal(address(this), 100 ether);
        vm.deal(ORG_OWNER, 100 ether);
    }

    function test_platformDepositGoesToBucketZeroAndToTheEntryPoint() public {
        vm.expectEmit(true, false, false, true);
        emit Deposited(paymaster.PLATFORM(), 5 ether);
        paymaster.depositPlatform{value: 5 ether}();

        assertEq(paymaster.budgetOf(0), 5 ether);
        assertEq(ep.balanceOf(address(paymaster)), 5 ether);
    }

    function test_orgDepositIsSeparate() public {
        paymaster.depositPlatform{value: 1 ether}();
        paymaster.deposit{value: 2 ether}(orgId);
        assertEq(paymaster.budgetOf(0), 1 ether);
        assertEq(paymaster.budgetOf(orgId), 2 ether);
        assertEq(ep.balanceOf(address(paymaster)), 3 ether);
    }

    function test_onlyOrgOwnerWithdrawsOrgBudget() public {
        paymaster.deposit{value: 2 ether}(orgId);
        vm.prank(BOB);
        vm.expectRevert(MontiPaymaster.Unauthorized.selector);
        paymaster.withdraw(orgId, 1 ether);

        uint256 before = ORG_OWNER.balance;
        vm.prank(ORG_OWNER);
        paymaster.withdraw(orgId, 1 ether);
        assertEq(paymaster.budgetOf(orgId), 1 ether);
        assertEq(ORG_OWNER.balance, before + 1 ether);
    }

    function test_onlyDeployerWithdrawsPlatformBudget() public {
        paymaster.depositPlatform{value: 2 ether}();
        vm.prank(BOB);
        vm.expectRevert(MontiPaymaster.Unauthorized.selector);
        paymaster.withdraw(0, 1 ether);
        paymaster.withdraw(0, 1 ether);
        assertEq(paymaster.budgetOf(0), 1 ether);
    }

    function test_setSelfSponsoredNeedsBudgetPermission() public {
        vm.prank(BOB);
        vm.expectRevert(MontiPaymaster.Unauthorized.selector);
        paymaster.setSelfSponsored(orgId, true);

        vm.expectEmit(true, false, false, true);
        emit SponsorModeSet(orgId, true);
        vm.prank(ORG_OWNER);
        paymaster.setSelfSponsored(orgId, true);
        assertTrue(paymaster.selfSponsored(orgId));
    }

    receive() external payable {}
}
```

- [ ] **Step 3: 실패를 확인한다**

Run: `cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/contracts && forge test --match-path test/Paymaster.t.sol`
Expected: FAIL — `Source "src/MontiPaymaster.sol" not found`.

- [ ] **Step 4: 구현을 쓴다**

`contracts/src/MontiPaymaster.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {IPaymaster} from "account-abstraction/interfaces/IPaymaster.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {UserOperation} from "account-abstraction/interfaces/UserOperation.sol";
import {IOrganizers} from "./interfaces/IOrganizers.sol";

/// @title MontiPaymaster
/// @notice EntryPoint v0.6 paymaster. Monad charges on the gas limit, so there is no refund to make
///         and therefore no postOp (spec 8.4): maxCost is debited during validation and that is final.
contract MontiPaymaster is IPaymaster {
    uint256 public constant PLATFORM = 0;

    IEntryPoint public immutable entryPoint;
    IOrganizers public immutable organizers;
    address public immutable deployer;

    address public ticket;
    address public identity;

    mapping(uint256 => uint256) private _budget;
    mapping(uint256 => bool) public selfSponsored;
    mapping(bytes4 => bool) public allowedSelector;

    event Deposited(uint256 indexed orgId, uint256 amount);
    event BudgetDebited(uint256 indexed orgId, address indexed sender, uint256 amount);
    event SponsorModeSet(uint256 indexed orgId, bool selfSponsored);

    error Unauthorized();
    error TargetsAlreadySet();
    error ZeroAddress();
    error NotEntryPoint();
    error BadPaymasterData();
    error TargetNotAllowed();
    error SelectorNotAllowed();
    error UnsupportedWalletCall();
    error BudgetExhausted();
    error NoPostOp();

    constructor(IEntryPoint entryPoint_, IOrganizers organizers_) {
        entryPoint = entryPoint_;
        organizers = organizers_;
        deployer = msg.sender;
    }

    function setTargets(address ticket_, address identity_) external {
        if (msg.sender != deployer) revert Unauthorized();
        if (ticket != address(0)) revert TargetsAlreadySet();
        if (ticket_ == address(0) || identity_ == address(0)) revert ZeroAddress();
        ticket = ticket_;
        identity = identity_;
        _seedSelectors();
    }

    function depositPlatform() external payable {
        _credit(PLATFORM, msg.value);
    }

    function deposit(uint256 orgId) external payable {
        _credit(orgId, msg.value);
    }

    function withdraw(uint256 orgId, uint256 amount) external {
        address allowed = orgId == PLATFORM ? deployer : organizers.ownerOf(orgId);
        if (msg.sender != allowed) revert Unauthorized();
        _budget[orgId] -= amount;
        entryPoint.withdrawTo(payable(msg.sender), amount);
    }

    function setSelfSponsored(uint256 orgId, bool on) external {
        if (!organizers.hasPermission(orgId, msg.sender, 16)) revert Unauthorized(); // PERM_MANAGE_BUDGET
        selfSponsored[orgId] = on;
        emit SponsorModeSet(orgId, on);
    }

    function budgetOf(uint256 orgId) external view returns (uint256) {
        return _budget[orgId];
    }

    function _credit(uint256 orgId, uint256 amount) private {
        _budget[orgId] += amount;
        entryPoint.depositTo{value: amount}(address(this));
        emit Deposited(orgId, amount);
    }

    function _seedSelectors() private {}
}
```

`_seedSelectors()`는 Task 26에서 채운다. 지금은 빈 몸통이어야 컴파일된다.

- [ ] **Step 5: 테스트가 통과하는지 확인한다**

Run: `cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/contracts && forge test --match-path test/Paymaster.t.sol -vv`
Expected: FAIL — `Contract "MontiPaymaster" should be marked as abstract` (아직 `validatePaymasterUserOp`와 `postOp`가 없다). Task 26이 이어서 채운다. Task 25·26은 한 커밋이다.

Run: `cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI && git status --short contracts/src/MontiPaymaster.sol`
Expected: `?? contracts/src/MontiPaymaster.sol`

---

## Task 26: MontiPaymaster — 대상·셀렉터 허용 목록

**Files:**
- Modify: `contracts/src/MontiPaymaster.sol`
- Test: `contracts/test/Paymaster.t.sol`

**Interfaces:**
- Consumes: Task 25의 `allowedSelector`, `ticket`, `identity`, `organizers`
- Produces: `validatePaymasterUserOp(UserOperation calldata userOp, bytes32, uint256 maxCost) external returns (bytes memory context, uint256 validationData)` — `userOp.callData`를 Coinbase Smart Wallet의 `execute(address,uint256,bytes)` 또는 `executeBatch(Call[])`로 해석해 내부 호출의 **대상**이 `{ticket, identity, address(organizers)}` 안인지, **셀렉터**가 허용 목록 안인지 확인한다. 허용 목록(23개): `claim`, `safeTransferFrom` 2종, `transferFrom`, `checkIn`, `requestOverride`, `manualOverride`, `createEvent`, `updateEventMeta`, `publishEvent`, `cancelEvent`, `createOffer`, `cancelOffer`, `acceptOffer`, `migrate`, `registerGate`, `openGate`, `closeGate`, `setAdmin`, `setManager`, `setActiveDevice`, `lockDevice`, `setNickname`. `postOp`는 언제나 되돌린다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`contracts/test/Paymaster.t.sol`에 붙인다(import 두 줄을 파일 상단에 함께 추가한다: `import {UserOperation} from "account-abstraction/interfaces/UserOperation.sol";`, `import {Ticket} from "../src/Ticket.sol";`):

```solidity
    struct Call {
        address target;
        uint256 value;
        bytes data;
    }

    function _op(bytes memory callData, uint256 orgId_) internal view returns (UserOperation memory op) {
        op.sender = ALICE;
        op.callData = callData;
        op.paymasterAndData = abi.encodePacked(address(paymaster), uint256(orgId_));
    }

    function _execute(address target, bytes memory inner) internal pure returns (bytes memory) {
        return abi.encodeWithSignature("execute(address,uint256,bytes)", target, uint256(0), inner);
    }

    function test_sponsorsAnAllowlistedClaim() public {
        paymaster.depositPlatform{value: 1 ether}();
        bytes memory inner = abi.encodeCall(Ticket.claim, (1, 0, ""));
        (bytes memory context, uint256 validationData) =
            ep.callValidate(address(paymaster), _op(_execute(address(ticket), inner), 0), bytes32(0), 0.01 ether);

        assertEq(context.length, 0, "no context means postOp is never called");
        assertEq(validationData, 0);
    }

    function test_refusesNonAllowlistedSelector() public {
        paymaster.depositPlatform{value: 1 ether}();
        bytes memory inner = abi.encodeWithSignature("approve(address,uint256)", BOB, uint256(1));
        vm.expectRevert(MontiPaymaster.SelectorNotAllowed.selector);
        ep.callValidate(address(paymaster), _op(_execute(address(ticket), inner), 0), bytes32(0), 0.01 ether);
    }

    function test_refusesForeignTarget() public {
        paymaster.depositPlatform{value: 1 ether}();
        bytes memory inner = abi.encodeCall(Ticket.claim, (1, 0, ""));
        vm.expectRevert(MontiPaymaster.TargetNotAllowed.selector);
        ep.callValidate(address(paymaster), _op(_execute(address(0xDEAD), inner), 0), bytes32(0), 0.01 ether);
    }

    function test_refusesUnknownWalletEntrypoint() public {
        paymaster.depositPlatform{value: 1 ether}();
        bytes memory callData = abi.encodeWithSignature("doSomething(uint256)", uint256(1));
        vm.expectRevert(MontiPaymaster.UnsupportedWalletCall.selector);
        ep.callValidate(address(paymaster), _op(callData, 0), bytes32(0), 0.01 ether);
    }

    function test_executeBatchChecksEveryCall() public {
        paymaster.depositPlatform{value: 1 ether}();
        Call[] memory good = new Call[](2);
        good[0] = Call(address(ticket), 0, abi.encodeCall(Ticket.claim, (1, 0, "")));
        good[1] = Call(address(identity), 0, abi.encodeWithSignature("lockDevice(address)", ALICE));
        bytes memory ok = abi.encodeWithSignature("executeBatch((address,uint256,bytes)[])", good);
        ep.callValidate(address(paymaster), _op(ok, 0), bytes32(0), 0.01 ether);

        Call[] memory bad = new Call[](2);
        bad[0] = good[0];
        bad[1] = Call(address(ticket), 0, abi.encodeWithSignature("approve(address,uint256)", BOB, uint256(1)));
        bytes memory mixed = abi.encodeWithSignature("executeBatch((address,uint256,bytes)[])", bad);
        vm.expectRevert(MontiPaymaster.SelectorNotAllowed.selector);
        ep.callValidate(address(paymaster), _op(mixed, 0), bytes32(0), 0.01 ether);
    }

    function test_onlyEntryPointMayValidate() public {
        paymaster.depositPlatform{value: 1 ether}();
        bytes memory inner = abi.encodeCall(Ticket.claim, (1, 0, ""));
        vm.expectRevert(MontiPaymaster.NotEntryPoint.selector);
        paymaster.validatePaymasterUserOp(_op(_execute(address(ticket), inner), 0), bytes32(0), 0.01 ether);
    }

    function test_postOpAlwaysReverts() public {
        vm.prank(address(ep));
        vm.expectRevert(MontiPaymaster.NoPostOp.selector);
        paymaster.postOp(IPaymaster.PostOpMode.opSucceeded, "", 0);
    }

    function test_newSelectorsFromTheProductDeltaAreAllowed() public view {
        assertTrue(paymaster.allowedSelector(bytes4(keccak256("setNickname(bytes32,string)"))));
        assertTrue(paymaster.allowedSelector(bytes4(keccak256("createOffer(uint256,bytes32,uint64)"))));
        assertTrue(paymaster.allowedSelector(bytes4(keccak256("cancelOffer(uint256)"))));
        assertTrue(paymaster.allowedSelector(bytes4(keccak256("acceptOffer(uint256,bytes)"))));
        assertTrue(paymaster.allowedSelector(bytes4(keccak256("publishEvent(uint256)"))));
        assertTrue(paymaster.allowedSelector(bytes4(keccak256("cancelEvent(uint256)"))));
    }
```

`test_postOpAlwaysReverts`를 위해 파일 상단 import에 `import {IPaymaster} from "account-abstraction/interfaces/IPaymaster.sol";`도 추가한다.

- [ ] **Step 2: 실패를 확인한다**

Run: `cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/contracts && forge test --match-path test/Paymaster.t.sol`
Expected: FAIL — `Contract "MontiPaymaster" should be marked as abstract`.

- [ ] **Step 3: 셀렉터 목록을 채운다**

`MontiPaymaster.sol`의 `_seedSelectors()`를 이것으로 바꾼다:

```solidity
    function _seedSelectors() private {
        // Ticket
        _allow("claim(uint256,uint8,bytes)");
        _allow("safeTransferFrom(address,address,uint256)");
        _allow("safeTransferFrom(address,address,uint256,bytes)");
        _allow("transferFrom(address,address,uint256)");
        _allow("checkIn(uint256,(uint256,uint256,uint64,bytes32),bytes)");
        _allow("requestOverride(uint256,uint256,uint8)");
        _allow("manualOverride(uint256,uint256,uint8)");
        _allow(
            "createEvent((uint256,bytes32,bytes32,string,uint64,uint64,bytes32,uint64,uint64,bool,uint32,uint8,bool,uint8,bytes32,bool),(string,uint256,uint32,uint32,uint16,bool)[])"
        );
        _allow(
            "updateEventMeta(uint256,(uint256,bytes32,bytes32,string,uint64,uint64,bytes32,uint64,uint64,bool,uint32,uint8,bool,uint8,bytes32,bool),(string,uint256,uint32,uint32,uint16,bool)[])"
        );
        _allow("publishEvent(uint256)");
        _allow("cancelEvent(uint256)");
        _allow("createOffer(uint256,bytes32,uint64)");
        _allow("cancelOffer(uint256)");
        _allow("acceptOffer(uint256,bytes)");
        _allow("migrate(uint256)");
        // Organizers
        _allow("registerGate(uint256,address,bytes32,bytes32)");
        _allow("openGate(uint256)");
        _allow("closeGate(uint256)");
        _allow("setAdmin(uint256,address,uint32)");
        _allow("setManager(uint256,address,bool,bool)");
        // Identity
        _allow("setActiveDevice(bytes32,bytes32)");
        _allow("lockDevice(address)");
        _allow("setNickname(bytes32,string)");
    }

    function _allow(string memory signature) private {
        allowedSelector[bytes4(keccak256(bytes(signature)))] = true;
    }
```

- [ ] **Step 4: 검증 함수를 쓴다**

`budgetOf` 아래에 넣는다:

```solidity
    struct Call {
        address target;
        uint256 value;
        bytes data;
    }

    /// @notice paymasterAndData = abi.encodePacked(address(this), uint256 orgId) — 52 bytes.
    function validatePaymasterUserOp(UserOperation calldata userOp, bytes32, uint256 maxCost)
        external
        returns (bytes memory context, uint256 validationData)
    {
        if (msg.sender != address(entryPoint)) revert NotEntryPoint();
        if (userOp.paymasterAndData.length != 52) revert BadPaymasterData();
        uint256 orgId = uint256(bytes32(userOp.paymasterAndData[20:52]));

        _requireAllowedCall(userOp.callData);
        _debit(selfSponsored[orgId] ? orgId : PLATFORM, userOp.sender, maxCost);

        return ("", 0);
    }

    /// @dev Monad charges the limit, so there is nothing to refund and postOp must never run.
    function postOp(PostOpMode, bytes calldata, uint256) external pure {
        revert NoPostOp();
    }

    function _requireAllowedCall(bytes calldata callData) private view {
        if (callData.length < 4) revert UnsupportedWalletCall();
        bytes4 sel = bytes4(callData[0:4]);

        if (sel == bytes4(keccak256("execute(address,uint256,bytes)"))) {
            (address target,, bytes memory inner) = abi.decode(callData[4:], (address, uint256, bytes));
            _requireAllowedInner(target, inner);
        } else if (sel == bytes4(keccak256("executeBatch((address,uint256,bytes)[])"))) {
            Call[] memory calls = abi.decode(callData[4:], (Call[]));
            if (calls.length == 0) revert UnsupportedWalletCall();
            for (uint256 i; i < calls.length; ++i) {
                _requireAllowedInner(calls[i].target, calls[i].data);
            }
        } else {
            revert UnsupportedWalletCall();
        }
    }

    function _requireAllowedInner(address target, bytes memory inner) private view {
        if (target != ticket && target != identity && target != address(organizers)) revert TargetNotAllowed();
        if (inner.length < 4) revert SelectorNotAllowed();
        bytes4 sel;
        assembly ("memory-safe") {
            sel := mload(add(inner, 0x20))
        }
        if (!allowedSelector[sel]) revert SelectorNotAllowed();
    }

    function _debit(uint256 orgId, address sender, uint256 amount) private {
        uint256 balance = _budget[orgId];
        if (balance < amount) revert BudgetExhausted();
        unchecked {
            _budget[orgId] = balance - amount;
        }
        emit BudgetDebited(orgId, sender, amount);
    }
```

- [ ] **Step 5: 테스트가 통과하는지 확인한다**

Run: `cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/contracts && forge test --match-path test/Paymaster.t.sol -vv`
Expected: PASS — 13 tests passed.

- [ ] **Step 6: 커밋**

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI
git add contracts/src/MontiPaymaster.sol contracts/test/mocks/MockEntryPoint.sol contracts/test/Paymaster.t.sol
git commit -m "feat(contracts): paymaster with target and selector allowlist decoded from callData"
```

---

## Task 27: MontiPaymaster — 예산 차감과 고갈

**Files:**
- Test: `contracts/test/Paymaster.t.sol` (테스트만 추가)

**Interfaces:**
- Consumes: Task 26의 `_debit`, `BudgetDebited`, `BudgetExhausted`, `selfSponsored`
- Produces: 새 프로덕션 코드 없음. 스폰서 라우팅(플랫폼 칸 ↔ 프로젝트 칸)과 잔액 부족 거부가 고정된다. 서브플랜 03·04가 유저옵을 보내기 전에 `budgetOf`를 읽어 사전 경고를 띄울 수 있다는 계약이기도 하다.

- [ ] **Step 1: 차감 테스트를 쓴다**

```solidity
    event BudgetDebited(uint256 indexed orgId, address indexed sender, uint256 amount);

    function test_platformBudgetIsDebitedByMaxCost() public {
        paymaster.depositPlatform{value: 1 ether}();
        bytes memory inner = abi.encodeCall(Ticket.claim, (1, 0, ""));

        vm.expectEmit(true, true, false, true);
        emit BudgetDebited(0, ALICE, 0.01 ether);
        ep.callValidate(address(paymaster), _op(_execute(address(ticket), inner), 0), bytes32(0), 0.01 ether);

        assertEq(paymaster.budgetOf(0), 1 ether - 0.01 ether);
    }

    function test_selfSponsoredOrgPaysFromItsOwnBucket() public {
        paymaster.depositPlatform{value: 1 ether}();
        paymaster.deposit{value: 1 ether}(orgId);
        vm.prank(ORG_OWNER);
        paymaster.setSelfSponsored(orgId, true);

        bytes memory inner = abi.encodeCall(Ticket.claim, (1, 0, ""));
        vm.expectEmit(true, true, false, true);
        emit BudgetDebited(orgId, ALICE, 0.02 ether);
        ep.callValidate(address(paymaster), _op(_execute(address(ticket), inner), orgId), bytes32(0), 0.02 ether);

        assertEq(paymaster.budgetOf(orgId), 1 ether - 0.02 ether);
        assertEq(paymaster.budgetOf(0), 1 ether, "platform untouched");
    }

    function test_notSelfSponsoredOrgFallsBackToThePlatformBucket() public {
        paymaster.depositPlatform{value: 1 ether}();
        paymaster.deposit{value: 1 ether}(orgId);

        bytes memory inner = abi.encodeCall(Ticket.claim, (1, 0, ""));
        ep.callValidate(address(paymaster), _op(_execute(address(ticket), inner), orgId), bytes32(0), 0.02 ether);

        assertEq(paymaster.budgetOf(0), 1 ether - 0.02 ether);
        assertEq(paymaster.budgetOf(orgId), 1 ether);
    }

    function test_emptyBudgetRefusesSponsorship() public {
        bytes memory inner = abi.encodeCall(Ticket.claim, (1, 0, ""));
        vm.expectRevert(MontiPaymaster.BudgetExhausted.selector);
        ep.callValidate(address(paymaster), _op(_execute(address(ticket), inner), 0), bytes32(0), 0.01 ether);
    }

    function test_selfSponsoredOrgWithEmptyBucketIsRefusedEvenIfPlatformIsFunded() public {
        paymaster.depositPlatform{value: 1 ether}();
        vm.prank(ORG_OWNER);
        paymaster.setSelfSponsored(orgId, true);

        bytes memory inner = abi.encodeCall(Ticket.claim, (1, 0, ""));
        vm.expectRevert(MontiPaymaster.BudgetExhausted.selector);
        ep.callValidate(address(paymaster), _op(_execute(address(ticket), inner), orgId), bytes32(0), 0.01 ether);
    }

    function test_malformedPaymasterDataRefused() public {
        paymaster.depositPlatform{value: 1 ether}();
        UserOperation memory op = _op(_execute(address(ticket), abi.encodeCall(Ticket.claim, (1, 0, ""))), 0);
        op.paymasterAndData = abi.encodePacked(address(paymaster));
        vm.expectRevert(MontiPaymaster.BadPaymasterData.selector);
        ep.callValidate(address(paymaster), op, bytes32(0), 0.01 ether);
    }
```

- [ ] **Step 2: 실행해서 전부 초록인지 본다**

Run: `cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/contracts && forge test --match-path test/Paymaster.t.sol -vv`
Expected: PASS — 19 tests passed. 프로덕션 코드는 건드리지 않는다.

- [ ] **Step 3: 검증이 상태를 바꾼다는 사실을 문서에 남긴다**

`MontiPaymaster.sol`의 `validatePaymasterUserOp` 위 주석에 한 줄을 더한다.

```solidity
    /// @dev Debiting during validation writes storage the bundler will re-simulate (ERC-7562 allows a
    ///      staked paymaster to touch its own storage). This is why the paymaster must be staked.
```

Run: `cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/contracts && forge build`
Expected: 컴파일 성공.

- [ ] **Step 4: 사용된 가스 한도가 예산과 같은 단위인지 확인한다**

`maxCost`는 wei단위의 `gasLimit * maxFeePerGas`다. Monad 기본 수수료 100 gwei에 체크인 한도 330,000을 넣으면 한 건당 0.033 MON이므로, 5 MON 예산은 약 150건이다. 이 산술을 테스트로 고정한다 — `contracts/test/Paymaster.t.sol`에 붙인다:

```solidity
    function test_fiveMonSponsorsAboutOneHundredFiftyCheckIns() public {
        paymaster.depositPlatform{value: 5 ether}();
        uint256 maxCost = 330_000 * 100 gwei; // spec 8.3: checkIn limit at the 100 gwei base fee
        bytes memory inner = abi.encodeCall(Ticket.claim, (1, 0, ""));

        uint256 sponsored;
        while (paymaster.budgetOf(0) >= maxCost) {
            ep.callValidate(address(paymaster), _op(_execute(address(ticket), inner), 0), bytes32(0), maxCost);
            sponsored += 1;
        }
        assertEq(sponsored, 151);
    }
```

Run: `cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/contracts && forge test --match-test test_fiveMonSponsorsAboutOneHundredFiftyCheckIns -vv`
Expected: PASS — 1 test passed. 숫자가 다르면 `assertEq`의 기대값을 실측치로 고치고 그 숫자를 서브플랜 03의 예산 경고 UI가 쓴다.

- [ ] **Step 5: 커밋**

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI
git add contracts/src/MontiPaymaster.sol contracts/test/Paymaster.t.sol
git commit -m "test(contracts): paymaster budget routing, debit and exhaustion"
```

---

## Task 28: MontiPaymaster — 스테이킹과 예치 헬퍼

**Files:**
- Modify: `contracts/src/MontiPaymaster.sol`
- Test: `contracts/test/PaymasterStake.t.sol`

**Interfaces:**
- Consumes: Task 25의 `entryPoint`, `deployer`; `MockEntryPoint`의 stake 함수
- Produces: `addStake(uint32 unstakeDelaySec) external payable`(deployer), `unlockStake() external`(deployer), `withdrawStake(address payable to) external`(deployer), `depositToEntryPoint() external payable`(누구나 — EntryPoint 잔액만 올리고 예산 칸은 건드리지 않는다), `entryPointBalance() view returns (uint256)`. 스펙 §8.4: 프로젝트별 예산을 검증 단계에서 읽으려면 페이마스터가 스테이킹돼 있어야 한다(번들러 정책, 해제 대기 1일 = `86400`).

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`contracts/test/PaymasterStake.t.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {MontiTest} from "./Base.t.sol";
import {MontiPaymaster} from "../src/MontiPaymaster.sol";
import {MockEntryPoint} from "./mocks/MockEntryPoint.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {IOrganizers} from "../src/interfaces/IOrganizers.sol";

contract PaymasterStakeTest is MontiTest {
    MockEntryPoint internal ep;
    MontiPaymaster internal paymaster;

    function setUp() public {
        _deployMonti();
        ep = new MockEntryPoint();
        paymaster = new MontiPaymaster(IEntryPoint(address(ep)), IOrganizers(address(organizers)));
        paymaster.setTargets(address(ticket), address(identity));
        vm.deal(address(this), 100 ether);
        vm.deal(BOB, 10 ether);
    }

    function test_deployerStakesWithTheOneDayUnstakeDelay() public {
        paymaster.addStake{value: 1 ether}(86400);
        assertEq(ep.stakeOf(address(paymaster)), 1 ether);
        assertEq(ep.unstakeDelayOf(address(paymaster)), 86400);
    }

    function test_strangerCannotStakeOrUnlockOrWithdraw() public {
        vm.startPrank(BOB);
        vm.expectRevert(MontiPaymaster.Unauthorized.selector);
        paymaster.addStake{value: 1 ether}(86400);
        vm.expectRevert(MontiPaymaster.Unauthorized.selector);
        paymaster.unlockStake();
        vm.expectRevert(MontiPaymaster.Unauthorized.selector);
        paymaster.withdrawStake(payable(BOB));
        vm.stopPrank();
    }

    function test_unlockThenWithdrawStake() public {
        paymaster.addStake{value: 1 ether}(86400);
        paymaster.unlockStake();
        uint256 before = address(this).balance;
        paymaster.withdrawStake(payable(address(this)));
        assertEq(address(this).balance, before + 1 ether);
        assertEq(ep.stakeOf(address(paymaster)), 0);
    }

    function test_depositToEntryPointDoesNotTouchBudgets() public {
        paymaster.depositToEntryPoint{value: 2 ether}();
        assertEq(paymaster.entryPointBalance(), 2 ether);
        assertEq(paymaster.budgetOf(0), 0, "bare deposits are not spendable budget");
    }

    receive() external payable {}
}
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/contracts && forge test --match-path test/PaymasterStake.t.sol`
Expected: FAIL — `Member "addStake" not found or not visible after argument-dependent lookup in contract MontiPaymaster`.

- [ ] **Step 3: 구현을 쓴다**

`MontiPaymaster.sol`의 `budgetOf` 아래에 넣는다:

```solidity
    /// @notice Spec 8.4: a paymaster that reads per-project storage during validation must be staked.
    ///         Testnet: 1 MON with unstakeDelaySec 86400 is enough for Pimlico.
    function addStake(uint32 unstakeDelaySec) external payable {
        if (msg.sender != deployer) revert Unauthorized();
        entryPoint.addStake{value: msg.value}(unstakeDelaySec);
    }

    function unlockStake() external {
        if (msg.sender != deployer) revert Unauthorized();
        entryPoint.unlockStake();
    }

    function withdrawStake(address payable to) external {
        if (msg.sender != deployer) revert Unauthorized();
        entryPoint.withdrawStake(to);
    }

    /// @notice Tops up the EntryPoint balance without creating spendable budget — used when the
    ///         EntryPoint deposit and the sum of the budget buckets have drifted apart.
    function depositToEntryPoint() external payable {
        entryPoint.depositTo{value: msg.value}(address(this));
    }

    function entryPointBalance() external view returns (uint256) {
        return entryPoint.balanceOf(address(this));
    }
```

- [ ] **Step 4: 테스트가 통과하는지 확인한다**

Run: `cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/contracts && forge test --match-path test/PaymasterStake.t.sol -vv`
Expected: PASS — 4 tests passed. `IEntryPoint.balanceOf`가 v0.6 인터페이스에 있으므로 `MockEntryPoint`의 public mapping이 그대로 만족한다.

- [ ] **Step 5: 커밋**

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI
git add contracts/src/MontiPaymaster.sol contracts/test/PaymasterStake.t.sol
git commit -m "feat(contracts): paymaster stake and entrypoint deposit helpers"
```

---

## Task 29: `checkIn` 가스 200k 미만 (Monad 테스트넷 포크)

**Files:**
- Create: `contracts/test/CheckInGas.t.sol`
- Modify: `contracts/foundry.toml` (`[profile.fork]` 추가)

**Interfaces:**
- Consumes: Task 20의 `checkIn`, Task 19의 벡터
- Produces: 포크 테스트 `CheckInGasTest`. 기본 `forge test`에서는 `MONAD_TESTNET_RPC`가 없으면 스스로 건너뛴다(`vm.envOr`). 이 테스트만이 진짜 가스 숫자를 말한다.

**두 가지 방법과 선택:** ① `vm.etch`로 0x100에 목을 심는 방법 — 어디서나 돌지만 목의 가스는 프리컴파일(6,900 gas)과 무관해서 숫자가 거짓이다. ② **Monad 테스트넷 포크** — RPC 한 번이 필요하지만 EIP-7951 프리컴파일이 실제로 있어 숫자가 참이다. **②를 택한다.** ①은 기능 테스트(Task 19~28)에만 쓴다.

- [ ] **Step 1: 포크 프로필을 더한다**

`contracts/foundry.toml` 끝에 붙인다:

```toml
[profile.fork]
evm_version = "osaka"
verbosity = 3
```

- [ ] **Step 2: 실패하는 테스트를 쓴다**

`contracts/test/CheckInGas.t.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {MontiTest} from "./Base.t.sol";
import {Ticket} from "../src/Ticket.sol";
import {P256Vectors} from "./utils/P256Vectors.sol";

/// @notice Runs only when MONAD_TESTNET_RPC is set. Forking gives us the real EIP-7951 precompile at
///         0x100 (6,900 gas), which is the whole point: a mock would report a meaningless number.
contract CheckInGasTest is MontiTest {
    uint256 internal eventId;
    uint256 internal tokenId;
    uint256 internal gateId;
    bool internal forked;

    function setUp() public {
        string memory rpc = vm.envOr("MONAD_TESTNET_RPC", string(""));
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc);
        forked = true;

        _deployMonti();
        // _deployMonti etched the mock at 0x100; remove it so the real precompile answers.
        vm.etch(P256_PRECOMPILE, "");

        _memberWithDeviceKey(ALICE, 0xA1A1);
        uint256 orgId = _org();
        eventId = _freeEvent(orgId, 1, 1, true);
        vm.prank(ALICE);
        tokenId = ticket.claim(eventId, 0, "");
        vm.startPrank(ORG_OWNER);
        gateId = organizers.registerGate(eventId, GATE_A, bytes32(uint256(0x6A01)), bytes32(uint256(0x6A02)));
        organizers.openGate(gateId);
        vm.stopPrank();
        vm.warp(P256Vectors.ISSUED_AT + 5);
    }

    function test_checkInCostsLessThan200kGasOnTheRealPrecompile() public {
        if (!forked) {
            emit log("skipped: set MONAD_TESTNET_RPC to measure real check-in gas");
            return;
        }

        Ticket.GateCode memory g = Ticket.GateCode({
            gateId: gateId,
            eventId: P256Vectors.EVENT_ID,
            issuedAt: P256Vectors.ISSUED_AT,
            nonce: P256Vectors.NONCE
        });
        bytes memory sig = abi.encode(P256Vectors.GATE1_R, P256Vectors.GATE1_S);

        vm.prank(GATE_A);
        uint256 before = gasleft();
        ticket.checkIn(tokenId, g, sig);
        uint256 used = before - gasleft();

        emit log_named_uint("checkIn gas", used);
        assertLt(used, 200_000, "spec 8.3 budgets 275k for the whole user op; the call itself must be < 200k");
    }
}
```

`vm.warp`는 포크 위에서도 동작하므로 벡터의 `issuedAt`을 그대로 쓸 수 있다.

- [ ] **Step 3: RPC 없이 먼저 돌려 본다**

Run: `cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/contracts && forge test --match-path test/CheckInGas.t.sol -vv`
Expected: PASS — 1 test passed, 로그에 `skipped: set MONAD_TESTNET_RPC to measure real check-in gas`.

- [ ] **Step 4: 포크로 실제 숫자를 잰다**

Run:
```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/contracts
MONAD_TESTNET_RPC=https://testnet-rpc.monad.xyz FOUNDRY_PROFILE=fork \
  forge test --match-path test/CheckInGas.t.sol -vv
```
Expected: PASS — 로그에 `checkIn gas: <숫자>`가 찍히고 200,000 미만. 대략 60,000~120,000이 나온다(프리컴파일 6,900 + 스토리지 쓰기 2칸 + 외부 호출 3회). 200,000을 넘으면 `_checkIns` 구조체가 한 슬롯에 안 들어간 것이니 `CheckIn`의 필드 순서를 확인한다.

RPC가 EIP-7951을 아직 안 열었다면 `BadDeviceSignature`로 실패한다. 그때는 `cast call 0x0000000000000000000000000000000000000100 --rpc-url $MONAD_TESTNET_RPC`로 프리컴파일 존재를 먼저 확인한다.

- [ ] **Step 5: 측정값을 기록하고 커밋**

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI
mkdir -p docs/superpowers/plans
printf '\n## checkIn gas (Task 29)\n\n- measured on Monad testnet fork: <붙여넣기> gas\n- budget: < 200,000\n' >> docs/superpowers/plans/spikes.md
git add contracts/test/CheckInGas.t.sol contracts/foundry.toml docs/superpowers/plans/spikes.md
git commit -m "test(contracts): assert checkIn stays under 200k gas on the real P-256 precompile"
```

---

## Task 30: 배포 스크립트 `Deploy.s.sol`

**Files:**
- Create: `contracts/script/Deploy.s.sol`
- Test: `contracts/test/Deploy.t.sol`

**Interfaces:**
- Consumes: 네 컨트랙트 전부
- Produces: `contract Deploy is Script` — `run()`이 Identity → Organizers → Ticket → MontiPaymaster를 배포하고 `organizers.setTicket(ticket)`, `paymaster.setTargets(ticket, identity)`로 배선한 뒤 `deployments/<chainid>.json`을 쓴다. 키: `identity`, `organizers`, `ticket`, `paymaster`, `entryPoint`, `attester`, `chainId`, `block`. 서브플랜 02·03·04가 이 파일을 읽는다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`contracts/test/Deploy.t.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {Test} from "forge-std/Test.sol";
import {Deploy} from "../script/Deploy.s.sol";
import {Identity} from "../src/Identity.sol";
import {Organizers} from "../src/Organizers.sol";
import {Ticket} from "../src/Ticket.sol";
import {MontiPaymaster} from "../src/MontiPaymaster.sol";

contract DeployTest is Test {
    function test_deployWiresEveryContractTogether() public {
        vm.setEnv("DEPLOYER_PK", "0x0000000000000000000000000000000000000000000000000000000000000001");
        vm.setEnv("ATTESTER", "0x000000000000000000000000000000000000A11c");
        vm.setEnv("ENTRYPOINT", "0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789");

        Deploy script = new Deploy();
        script.run();

        Identity identity = Identity(script.identityAddress());
        Organizers organizers = Organizers(script.organizersAddress());
        Ticket ticket = Ticket(script.ticketAddress());
        MontiPaymaster paymaster = MontiPaymaster(payable(script.paymasterAddress()));

        assertEq(identity.attester(), 0x000000000000000000000000000000000000A11c);
        assertEq(organizers.ticket(), address(ticket));
        assertEq(address(ticket.identity()), address(identity));
        assertEq(address(ticket.organizers()), address(organizers));
        assertEq(paymaster.ticket(), address(ticket));
        assertEq(paymaster.identity(), address(identity));
        assertEq(address(paymaster.organizers()), address(organizers));
        assertEq(address(paymaster.entryPoint()), 0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789);
        assertTrue(paymaster.allowedSelector(bytes4(keccak256("checkIn(uint256,(uint256,uint256,uint64,bytes32),bytes)"))));
    }
}
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/contracts && forge test --match-path test/Deploy.t.sol`
Expected: FAIL — `Source "script/Deploy.s.sol" not found`.

- [ ] **Step 3: 구현을 쓴다**

`contracts/script/Deploy.s.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {Identity} from "../src/Identity.sol";
import {Organizers} from "../src/Organizers.sol";
import {Ticket} from "../src/Ticket.sol";
import {MontiPaymaster} from "../src/MontiPaymaster.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {IOrganizers} from "../src/interfaces/IOrganizers.sol";

contract Deploy is Script {
    address public identityAddress;
    address public organizersAddress;
    address public ticketAddress;
    address public paymasterAddress;

    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PK");
        address attester = vm.envAddress("ATTESTER");
        address entryPoint = vm.envAddress("ENTRYPOINT");

        vm.startBroadcast(pk);
        Identity identity = new Identity(attester);
        Organizers organizers = new Organizers();
        Ticket ticket = new Ticket(address(identity), address(organizers));
        organizers.setTicket(address(ticket));
        MontiPaymaster paymaster =
            new MontiPaymaster(IEntryPoint(entryPoint), IOrganizers(address(organizers)));
        paymaster.setTargets(address(ticket), address(identity));
        vm.stopBroadcast();

        identityAddress = address(identity);
        organizersAddress = address(organizers);
        ticketAddress = address(ticket);
        paymasterAddress = address(paymaster);

        console2.log("identity  ", identityAddress);
        console2.log("organizers", organizersAddress);
        console2.log("ticket    ", ticketAddress);
        console2.log("paymaster ", paymasterAddress);

        _writeDeployments(attester, entryPoint);
    }

    function _writeDeployments(address attester, address entryPoint) private {
        string memory key = "monti";
        vm.serializeAddress(key, "identity", identityAddress);
        vm.serializeAddress(key, "organizers", organizersAddress);
        vm.serializeAddress(key, "ticket", ticketAddress);
        vm.serializeAddress(key, "paymaster", paymasterAddress);
        vm.serializeAddress(key, "entryPoint", entryPoint);
        vm.serializeAddress(key, "attester", attester);
        vm.serializeUint(key, "block", block.number);
        string memory out = vm.serializeUint(key, "chainId", block.chainid);

        string memory path = string.concat("deployments/", vm.toString(block.chainid), ".json");
        vm.writeJson(out, path);
        console2.log("wrote", path);
    }
}
```

- [ ] **Step 4: 테스트가 통과하는지 확인한다**

Run: `cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/contracts && forge test --match-path test/Deploy.t.sol -vv`
Expected: PASS — 1 test passed, 그리고 `contracts/deployments/31337.json`이 생긴다(Foundry 기본 chainid). `fs_permissions`가 없으면 여기서 `the path deployments/31337.json is not allowed to be accessed`가 나므로 Task 1 Step 2의 `fs_permissions` 줄을 확인한다.

- [ ] **Step 5: 테스트넷에 실제로 배포한다 (가스 한도 명시)**

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/contracts
cp .env.example .env   # 값 채우기: DEPLOYER_PK, ATTESTER
set -a && source .env && set +a
forge script script/Deploy.s.sol:Deploy \
  --rpc-url "$MONAD_TESTNET_RPC" \
  --broadcast --slow \
  --gas-limit 30000000
cat deployments/10143.json
```
Expected: 네 주소와 `"chainId": 10143`. `--gas-limit`은 선택이 아니다 — Monad는 한도로 과금하므로 모든 브로드캐스트에 명시한다.

- [ ] **Step 6: 커밋**

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI
git add contracts/script/Deploy.s.sol contracts/test/Deploy.t.sol contracts/deployments/10143.json
git commit -m "feat(contracts): deploy script that wires all four contracts and records addresses"
```

---

## Task 31: `DeployCoinbaseFactory.s.sol` — 메인넷과 같은 주소로 팩토리 배포

**Files:**
- Create: `contracts/script/DeployCoinbaseFactory.s.sol`
- Test: `contracts/test/DeployCoinbaseFactory.t.sol`

**Interfaces:**
- Consumes: `lib/smart-wallet`(Task 2 서브모듈)
- Produces: `contract DeployCoinbaseFactory is Script` — 정본 CREATE2 배포자 `0x4e59b44847b379578588920cA78FbF26c0B4956C`에 `salt = bytes32(0)`로 `CoinbaseSmartWallet` 구현체와 `CoinbaseSmartWalletFactory(impl)`를 배포하고, 결과 주소를 메인넷 값(`0x000100abaad02f1cfC8Bbe32bD5a564817339E72`, `0x0BA5ED0c6AA8c49038F819E587E2633c4A9F428a`)과 비교해 로그에 남긴다. 주소가 같아야 서브플랜 03의 `toCoinbaseSmartAccount`가 메인넷 설정 그대로 돈다(마스터 플랜 Task 0.4 Step 1).

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`contracts/test/DeployCoinbaseFactory.t.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {Test} from "forge-std/Test.sol";
import {DeployCoinbaseFactory} from "../script/DeployCoinbaseFactory.s.sol";

contract DeployCoinbaseFactoryTest is Test {
    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    function test_deploysThroughTheCanonicalCreate2Deployer() public {
        vm.setEnv("DEPLOYER_PK", "0x0000000000000000000000000000000000000000000000000000000000000001");
        assertTrue(CREATE2_DEPLOYER.code.length > 0, "forge preloads the canonical CREATE2 deployer");

        DeployCoinbaseFactory script = new DeployCoinbaseFactory();
        script.run();

        address factory = script.factoryAddress();
        address implementation = script.implementationAddress();
        assertTrue(factory.code.length > 0);
        assertTrue(implementation.code.length > 0);
        assertEq(factory, script.predictedFactory(), "address must be reproducible from the init code");
    }
}
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/contracts && forge test --match-path test/DeployCoinbaseFactory.t.sol`
Expected: FAIL — `Source "script/DeployCoinbaseFactory.s.sol" not found`.

- [ ] **Step 3: 구현을 쓴다**

`contracts/script/DeployCoinbaseFactory.s.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {CoinbaseSmartWallet} from "smart-wallet/CoinbaseSmartWallet.sol";
import {CoinbaseSmartWalletFactory} from "smart-wallet/CoinbaseSmartWalletFactory.sol";

/// @notice Spec 8.2: attendee, gate and admin accounts are all Coinbase Smart Wallets. Deploying the
///         factory through the canonical CREATE2 deployer keeps the testnet address identical to
///         mainnet, so nothing in the web app changes when we flip the chain id.
contract DeployCoinbaseFactory is Script {
    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    address internal constant MAINNET_IMPLEMENTATION = 0x000100abaad02f1cfC8Bbe32bD5a564817339E72;
    address internal constant MAINNET_FACTORY = 0x0BA5ED0c6AA8c49038F819E587E2633c4A9F428a;
    bytes32 internal constant SALT = bytes32(0);

    address public implementationAddress;
    address public factoryAddress;
    address public predictedImplementation;
    address public predictedFactory;

    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PK");

        bytes memory implInit = type(CoinbaseSmartWallet).creationCode;
        predictedImplementation = vm.computeCreate2Address(SALT, keccak256(implInit), CREATE2_DEPLOYER);

        vm.startBroadcast(pk);
        implementationAddress = _create2(implInit);

        bytes memory factoryInit =
            abi.encodePacked(type(CoinbaseSmartWalletFactory).creationCode, abi.encode(implementationAddress));
        predictedFactory = vm.computeCreate2Address(SALT, keccak256(factoryInit), CREATE2_DEPLOYER);
        factoryAddress = _create2(factoryInit);
        vm.stopBroadcast();

        console2.log("implementation", implementationAddress);
        console2.log("factory       ", factoryAddress);
        if (factoryAddress == MAINNET_FACTORY && implementationAddress == MAINNET_IMPLEMENTATION) {
            console2.log("addresses match mainnet");
        } else {
            console2.log("WARNING: addresses differ from mainnet; record these in deployments JSON");
            console2.log("mainnet implementation", MAINNET_IMPLEMENTATION);
            console2.log("mainnet factory       ", MAINNET_FACTORY);
        }
    }

    function _create2(bytes memory initCode) private returns (address deployed) {
        (bool ok, bytes memory ret) = CREATE2_DEPLOYER.call(abi.encodePacked(SALT, initCode));
        require(ok, "create2 failed");
        deployed = address(uint160(bytes20(ret)));
        require(deployed.code.length > 0, "no code at deployed address");
    }
}
```

주소가 메인넷과 다르면 컴파일러 설정이 원본과 다른 것이다. 해커톤 범위에서는 **경고만 남기고 진행한다** — 서브플랜 03이 `deployments/10143.json`의 값을 읽기 때문이다. 다만 원본과 맞추고 싶으면 `lib/smart-wallet/foundry.toml`의 `solc`·`optimizer_runs`를 그대로 쓰는 별도 프로필로 빌드한다.

- [ ] **Step 4: 테스트가 통과하는지 확인한다**

Run: `cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/contracts && forge test --match-path test/DeployCoinbaseFactory.t.sol -vv`
Expected: PASS — 1 test passed. `Source "smart-wallet/CoinbaseSmartWallet.sol" not found`가 나면 서브모듈 경로가 `lib/smart-wallet/src/`가 아니므로 `ls lib/smart-wallet`로 확인하고 `remappings.txt`의 `smart-wallet/=` 오른쪽을 실제 경로로 고친다.

- [ ] **Step 5: 테스트넷에 배포하고 주소를 기록한다**

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/contracts
set -a && source .env && set +a
forge script script/DeployCoinbaseFactory.s.sol:DeployCoinbaseFactory \
  --rpc-url "$MONAD_TESTNET_RPC" --broadcast --slow --gas-limit 30000000
python3 - <<'PY'
import json, pathlib, sys
p = pathlib.Path("deployments/10143.json")
d = json.loads(p.read_text())
d["coinbaseFactory"] = input("factory address from the log: ").strip()
d["coinbaseImplementation"] = input("implementation address from the log: ").strip()
p.write_text(json.dumps(d, indent=2) + "\n")
print(p.read_text())
PY
```

- [ ] **Step 6: 커밋**

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI
git add contracts/script/DeployCoinbaseFactory.s.sol contracts/test/DeployCoinbaseFactory.t.sol contracts/deployments/10143.json
git commit -m "feat(contracts): CREATE2 deploy of the Coinbase Smart Wallet factory"
```

---

## Task 32: 시드 스크립트 `Seed.s.sol`

**Files:**
- Create: `contracts/script/Seed.s.sol`
- Test: `contracts/test/Seed.t.sol`

**Interfaces:**
- Consumes: Task 30이 쓴 `deployments/<chainid>.json`
- Produces: `contract Seed is Script` — 조직 1개(오너 = 배포자), 무료 티어 1개짜리 공연 1개(생성 → 발행), 게이트 1개(등록 → 열기)를 만들고 `deployments/seed-<chainid>.json`에 `orgId`, `eventId`, `gateId`, `gateAccount`를 쓴다. 서브플랜 03·04의 첫 화면이 이 값들로 곧장 돈다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`contracts/test/Seed.t.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {Test} from "forge-std/Test.sol";
import {Deploy} from "../script/Deploy.s.sol";
import {Seed} from "../script/Seed.s.sol";
import {Ticket} from "../src/Ticket.sol";
import {Organizers} from "../src/Organizers.sol";

contract SeedTest is Test {
    function test_seedCreatesOneOpenGateForOnePublishedEvent() public {
        vm.setEnv("DEPLOYER_PK", "0x0000000000000000000000000000000000000000000000000000000000000001");
        vm.setEnv("ATTESTER", "0x7E5886E0bb4F1B0A5d3d1c2A9c2a6C2E1E9f0001");
        vm.setEnv("ENTRYPOINT", "0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789");
        new Deploy().run();

        vm.setEnv("GATE_ACCOUNT", "0x0000000000000000000000000000000000006A7E");
        Seed seed = new Seed();
        seed.run();

        Ticket ticket = Ticket(seed.ticketAddress());
        Organizers organizers = Organizers(seed.organizersAddress());

        assertEq(uint8(ticket.eventStatus(seed.eventId())), uint8(Ticket.EventStatus.Published));
        assertEq(ticket.tiers(seed.eventId()).length, 1);
        assertEq(ticket.tiers(seed.eventId())[0].priceUsdCents, 0);
        assertTrue(organizers.isOpenGate(seed.eventId(), seed.gateAccount()));
        assertEq(organizers.gateOf(seed.gateAccount()), seed.gateId());
    }
}
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/contracts && forge test --match-path test/Seed.t.sol`
Expected: FAIL — `Source "script/Seed.s.sol" not found`.

- [ ] **Step 3: 구현을 쓴다**

`contracts/script/Seed.s.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {Ticket} from "../src/Ticket.sol";
import {Organizers} from "../src/Organizers.sol";

contract Seed is Script {
    address public ticketAddress;
    address public organizersAddress;
    address public gateAccount;
    uint256 public orgId;
    uint256 public eventId;
    uint256 public gateId;

    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PK");
        address deployer = vm.addr(pk);
        gateAccount = vm.envAddress("GATE_ACCOUNT");

        string memory file = vm.readFile(string.concat("deployments/", vm.toString(block.chainid), ".json"));
        ticketAddress = vm.parseJsonAddress(file, ".ticket");
        organizersAddress = vm.parseJsonAddress(file, ".organizers");

        Ticket ticket = Ticket(ticketAddress);
        Organizers organizers = Organizers(organizersAddress);

        vm.startBroadcast(pk);
        orgId = organizers.createOrganizer(deployer);

        Ticket.EventMeta memory meta = Ticket.EventMeta({
            orgId: orgId,
            titleHash: keccak256("MONTI Demo Night"),
            descHash: keccak256("Monad Metropolis demo event"),
            imageCid: "bafybeigdyrztseedimageplaceholdercid",
            startsAt: uint64(block.timestamp + 1 hours),
            endsAt: uint64(block.timestamp + 6 hours),
            venueHash: keccak256("Seoul, Gangnam"),
            saleStart: uint64(block.timestamp),
            saleEnd: uint64(block.timestamp + 5 hours),
            transferable: true,
            transferCutoffSeconds: 600,
            maxTransfers: 2,
            approvalRequired: false,
            category: 1,
            regionCode: keccak256("KR-11"),
            requireKyc: false
        });

        Ticket.Tier[] memory tiers = new Ticket.Tier[](1);
        tiers[0] = Ticket.Tier({
            name: "General",
            priceUsdCents: 0,
            supply: 500,
            minted: 0,
            maxPerWallet: 2,
            seated: false
        });

        eventId = ticket.createEvent(meta, tiers);
        ticket.publishEvent(eventId);
        gateId = organizers.registerGate(eventId, gateAccount, keccak256("gate-kx"), keccak256("gate-ky"));
        organizers.openGate(gateId);
        vm.stopBroadcast();

        console2.log("orgId  ", orgId);
        console2.log("eventId", eventId);
        console2.log("gateId ", gateId);

        string memory key = "seed";
        vm.serializeUint(key, "orgId", orgId);
        vm.serializeUint(key, "eventId", eventId);
        vm.serializeAddress(key, "gateAccount", gateAccount);
        string memory out = vm.serializeUint(key, "gateId", gateId);
        vm.writeJson(out, string.concat("deployments/seed-", vm.toString(block.chainid), ".json"));
    }
}
```

`vm.readFile`과 `vm.writeJson`이 `deployments/`만 읽고 쓰므로 Task 1의 `fs_permissions` 한 줄로 충분하다.

- [ ] **Step 4: 테스트가 통과하는지 확인한다**

Run: `cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/contracts && forge test --match-path test/Seed.t.sol -vv`
Expected: PASS — 1 test passed.

- [ ] **Step 5: 테스트넷에 시드를 넣는다**

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/contracts
set -a && source .env && set +a
GATE_ACCOUNT=0x0000000000000000000000000000000000006A7E \
forge script script/Seed.s.sol:Seed \
  --rpc-url "$MONAD_TESTNET_RPC" --broadcast --slow --gas-limit 30000000
cat deployments/seed-10143.json
```
Expected: `{"eventId":1,"gateAccount":"0x…6a7e","gateId":1,"orgId":1}`. 실제 스태프 단말기 계정 주소가 생기면 `GATE_ACCOUNT`를 그 값으로 바꿔 다시 돌린다(게이트는 계정마다 한 번만 등록된다).

- [ ] **Step 6: 커밋**

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI
git add contracts/script/Seed.s.sol contracts/test/Seed.t.sol contracts/deployments/seed-10143.json
git commit -m "feat(contracts): seed script for one organizer, one published event and one open gate"
```

---

## Task 33: ABI 내보내기 `script/export-abi.sh`

**Files:**
- Create: `contracts/script/export-abi.sh`
- Create: `packages/shared/src/abi/.gitkeep`
- Test: `contracts/test/AbiExport.t.sol`(존재하지 않음 — 검증은 셸에서 한다. 아래 Step 3이 테스트다)

**Interfaces:**
- Consumes: `contracts/out/*.sol/*.json`(`forge build` 산출물)
- Produces: `packages/shared/src/abi/Identity.json`, `Organizers.json`, `Ticket.json`, `MontiPaymaster.json` — 각 파일은 ABI **배열**만 담는다(`{abi: …}` 래퍼 없음). 서브플랜 02는 Envio 핸들러와 Functions에서, 03·04는 viem `getContract`에서 이 파일을 그대로 import한다.

- [ ] **Step 1: 스크립트를 쓴다**

`contracts/script/export-abi.sh`:

```bash
#!/usr/bin/env bash
# Copies the four contract ABIs into packages/shared so the web app, Functions and the indexer all
# read the same file. Run after every forge build that changes a public interface.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/../packages/shared/src/abi"
mkdir -p "$OUT"

command -v jq >/dev/null || { echo "jq is required: brew install jq"; exit 1; }

cd "$ROOT"
forge build --silent

for name in Identity Organizers Ticket MontiPaymaster; do
  src="$ROOT/out/$name.sol/$name.json"
  [ -f "$src" ] || { echo "missing $src — run forge build"; exit 1; }
  jq '.abi' "$src" > "$OUT/$name.json"
  entries=$(jq 'length' "$OUT/$name.json")
  echo "$name -> $OUT/$name.json ($entries entries)"
done
```

- [ ] **Step 2: 실행 권한을 주고 돌린다**

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/contracts
mkdir -p ../packages/shared/src/abi
touch ../packages/shared/src/abi/.gitkeep
chmod +x script/export-abi.sh
./script/export-abi.sh
```
Expected: 네 줄이 찍힌다. 예: `Ticket -> …/packages/shared/src/abi/Ticket.json (60 entries)`.

- [ ] **Step 3: 내보낸 ABI가 실제로 마스터 플랜의 이름을 담고 있는지 검사한다**

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI
python3 - <<'PY'
import json, pathlib, sys
base = pathlib.Path("packages/shared/src/abi")
want = {
 "Identity": ["register","rotateAccount","setActiveDevice","lockDevice","setNickname","accountOf","personOf",
              "isMember","activeDevice","isLocked","deviceUpdatedAt","attester","nicknameOwner","nicknameOf",
              "setKycLevel","kycLevelOf","KycLevelSet",
              "Registered","AccountRotated","DeviceChanged","DeviceLocked","NicknameSet","NicknameTaken"],
 "Organizers": ["createOrganizer","setAdmin","setManager","transferOwner","registerGate","revokeGate","openGate",
                "closeGate","setTicket","ownerOf","hasPermission","managerOf","gateOf","gateInfo","isOpenGate",
                "OrganizerCreated","AdminSet","ManagerSet","OwnerTransferred","GateRegistered","GateRevoked",
                "GateOpened","GateClosed"],
 "Ticket": ["createEvent","publishEvent","cancelEvent","updateEventMeta","eventStatus","claim","checkIn",
            "requestOverride","manualOverride","revoke","migrate","createOffer","cancelOffer","acceptOffer",
            "offerOf","eventOf","tierOf","eventOrg","checkInOf","balanceOfEvent","transfersOf","eventMeta",
            "tiers","tokenURI","EventCreated","EventStatusChanged","Claimed","CheckedIn","OverrideRequested",
            "ManualOverride","Revoked","Migrated","OfferCreated","OfferCancelled","OfferAccepted",
            "AlreadyCheckedIn","WrongEvent","TicketRevoked","CodeExpired","NoSuchTicket","GateNotOpen",
            "DeviceLocked","BadDeviceSignature","EventNotPublished","EventEnded","OfferExpired","BadAttesterSig",
            "KycRequired"],
 "MontiPaymaster": ["depositPlatform","deposit","withdraw","setSelfSponsored","budgetOf",
                    "validatePaymasterUserOp","postOp","addStake","unlockStake","withdrawStake",
                    "Deposited","BudgetDebited","SponsorModeSet"],
}
bad = 0
for contract, names in want.items():
    abi = json.loads((base / f"{contract}.json").read_text())
    have = {e.get("name") for e in abi}
    missing = [n for n in names if n not in have]
    if missing:
        bad = 1
        print(f"{contract}: MISSING {missing}")
    else:
        print(f"{contract}: all {len(names)} names present")
sys.exit(bad)
PY
```
Expected: 네 줄 모두 `all N names present`, 종료 코드 0. 하나라도 `MISSING`이 뜨면 그 이름을 만든 태스크로 돌아간다.

- [ ] **Step 4: pnpm 스크립트로 묶는다**

`contracts/package.json`을 만든다(워크스페이스가 `contracts`를 포함하지 않으므로 순수 편의 스크립트다):

```json
{
  "name": "@monti/contracts",
  "private": true,
  "scripts": {
    "build": "forge build",
    "test": "forge test",
    "export:abi": "./script/export-abi.sh"
  }
}
```

- [ ] **Step 5: 커밋**

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI
git add contracts/script/export-abi.sh contracts/package.json packages/shared/src/abi
git commit -m "chore(contracts): export ABIs into packages/shared for web, functions and indexer"
```

---

## Task 34: 전체 회귀, 크기, 포맷 고정

**Files:**
- Create: `contracts/.github-checks.sh`(로컬 검사 모음. CI는 서브플랜 02가 붙인다)
- Modify: 필요 시 포맷만

**Interfaces:**
- Consumes: 앞의 모든 태스크
- Produces: `./.github-checks.sh` 한 번으로 빌드·포맷·전체 테스트·크기·ABI 이름 검사가 돈다. 이 플랜의 "완료" 정의다.

- [ ] **Step 1: 검사 스크립트를 쓴다**

`contracts/.github-checks.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

echo "== fmt =="
forge fmt --check

echo "== build =="
forge build --sizes

echo "== test =="
forge test -vv

echo "== abi export =="
./script/export-abi.sh

echo "all checks passed"
```

- [ ] **Step 2: 포맷을 한 번 정리한다**

Run: `cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/contracts && forge fmt && forge fmt --check`
Expected: 두 번째 명령이 조용히 성공(종료 코드 0). `forge fmt`가 파일을 고쳤다면 `git diff`로 내용 변화가 없는 포맷 변경인지만 확인한다.

- [ ] **Step 3: 전체 테스트를 돌린다**

Run: `cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/contracts && chmod +x .github-checks.sh && ./.github-checks.sh`
Expected: PASS — 전체 합계 대략 **105 tests passed, 0 failed**(Deps 1 + AttesterRole 5 + Identity 22 + IdentityNickname 6 + Organizers 14 + OrganizersGates 10 + P256Mock 2 + TicketEvent 8 + TicketClaim 8 + TicketTransfer 9 + TicketOffer 8 + TicketCheckIn 16 + TicketOverride 5 + TicketMigrate 6 + TicketURI 3 + Paymaster 20 + PaymasterStake 4 + CheckInGas 1 + Deploy 1 + DeployCoinbaseFactory 1 + Seed 1). 숫자가 다르면 테스트를 빠뜨린 태스크가 있다는 뜻이니 위 목록과 대조한다.

- [ ] **Step 4: 런타임 크기를 기록한다**

Run: `cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/contracts && forge build --sizes | grep -E "^\| (Identity|Organizers|Ticket|MontiPaymaster)"`
Expected: 네 줄 모두 runtime size가 131,072 B(128 KB) 미만. `Ticket`이 24 KB를 넘어도 Monad에서는 배포되지만, 나중에 메인넷 외 체인을 고려한다면 `tokenURI`를 라이브러리로 빼는 것이 첫 후보라는 점을 기록해 둔다.

- [ ] **Step 5: 커밋**

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI
git add contracts/.github-checks.sh contracts/src contracts/test contracts/script
git commit -m "chore(contracts): one-command check script and formatting pass"
```

- [ ] **Step 6: 서브플랜 02·03·04에 넘길 것을 확인한다**

Run:
```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI
ls packages/shared/src/abi/*.json && cat contracts/deployments/10143.json && cat contracts/deployments/seed-10143.json
```
Expected: ABI 네 개, 배포 주소 여섯 개(`identity`, `organizers`, `ticket`, `paymaster`, `coinbaseFactory`, `coinbaseImplementation`), 시드 값 네 개. 이 세 가지가 서브플랜 02·03·04의 입력 전부다.



---

## Self-Review

### 1. 스펙 커버리지

| 스펙 절 | 요구 | 구현 태스크 |
|---|---|---|
| §6.3 T2 태그 복제 | 게이트가 예측 불가 1회용 번호를 요구하고 폰은 그 번호에 대한 서명만 돌려준다 | Task 20(`sha256(abi.encode(tokenId, gateId, eventId, nonce, issuedAt))`), Task 21 `test_T2_staleCodeRejectedAfterSixtySeconds` |
| §6.3 T3 앱 변조 | 폰이 상태를 주장하지 않는다 | Task 20 — `checkIn`의 모든 상태는 체인에서 읽는다 |
| §6.3 T6 패스키 동기화 | 입장 서명은 동기화 안 되는 기기 키만 | Task 21 `test_T6_wrongDeviceKeyRejected` |
| §6.3 T7 폰 도난 | 즉시 기기 잠금 | Task 6, Task 21 `test_T7_lockedDeviceRejected` |
| §6.3 T12 더블 탭 | 두 번째 거부 | Task 21 `test_T12_doubleCheckInRejected` |
| §6.3 T13 두 게이트 동시 | 하나만 성공 | Task 21 `test_T13_secondGateRevertsForTheSameTicket` |
| §6.3 T14 가짜 게이트 | allowlist 없는 발신자 거부 | Task 13 `isOpenGate`, Task 21 `test_T14_fakeGateRejected`·`test_closedGateRejected`·`test_revokedGateRejected` |
| §6.3 T15 단말기 도난 후 큐 조작 | 관객 기기 서명 없이는 체인이 안 받는다 | Task 20 `BadDeviceSignature` 경로 |
| §7.2 ①~⑤ | 게이트 권한·기기 서명·gate_id 일치·60초·티켓 상태 | Task 20 `checkIn` 본문(검사 순서 그대로), Task 21 전 항목 |
| §7.3 번호 유효기간 60초 | `CODE_WINDOW = 60` | Task 14 상수, Task 21 `test_codeAtExactlySixtySecondsStillWorks` |
| §8.3 가스 | 체크인 275k 예산 | Task 29 포크 테스트(< 200k) |
| §8.4 페이마스터 | 예산 칸 2종, 대상·함수 허용 목록, `postOp` 없음, 스테이킹 | Task 25~28 |
| §9.3 기기 정책 | 계정당 1대, 7일 쿨타임, 잠금, 예외 수동 승인 | Task 5·6·22 |
| §9.4 권한 | 오너·관리자 비트·매니저 2종·게이트 | Task 9~13, Task 22 |
| §10.2 Identity | 난수 personId, register/rotate/setActiveDevice/lockDevice | Task 4~8 |
| §10.2 Organizers | 조직·관리자·매니저·게이트 | Task 9~13 |
| §10.2 Ticket | createEvent/claim/_update/checkIn/override/revoke/migrate/tokenURI | Task 14~24 |
| §10.2 상태 기계 | 발행됨 → 입장, 취소는 직교, 체크인은 추가 전용 기록 | Task 16(claim)·20(CheckIn 레코드)·23(revoke 플래그) |
| §10.2 tokenURI | 체인 데이터 JSON, 상태 입장 전/입장 완료 | Task 24 |
| §12 오프라인 | 큐의 트랜잭션도 관객 서명 필수 | Task 20 — `checkIn`은 발신자와 무관하게 서명을 검증한다 |
| §13 DENY 코드 | 화면 사유별 구분 | Task 21 — 사유마다 고유 커스텀 에러 |
| 마스터 Global Constraints 가스 | 모든 브로드캐스트에 `--gas-limit` | Task 30·31·32의 모든 `forge script` 명령 |
| 창업자 델타 1 | 닉네임, 이벤트 생애주기, 양도 제안, 페이마스터 셀렉터 | Task 8·15·18·26 |
| 창업자 델타 2 | DENY 에러 이름 고정, `Identity.attester()` | Task 21·Task 33 Step 3의 이름 검사 |
| 창업자 델타 3 | 공연별 KYC 요구(`kycLevel`, `requireKyc`) | Task 4(`register`·`setKycLevel`·`kycLevelOf`), Task 14(`EventMeta.requireKyc`), Task 16(claim 거부), Task 17(전송·`acceptOffer` 거부), Task 26(셀렉터 튜플 갱신), Task 33(ABI 이름 검사) |

**갭:** 없음. 스펙 §8.7(결제)은 MVP 밖이며 `claim`의 voucher 인자만 남겨 두었다(Task 16이 `PaidTiersNotEnabled`로 명시적으로 거부한다). §5.6의 좌석 지정은 `Tier.seated` 플래그로 체인에 기록만 하고 좌석 배정 로직은 두지 않았다(스펙 §15 Could).

### 2. 자리표시자 점검

- "TBD", "TODO", "implement later", "fill in details": 0건.
- "적절한 에러 처리를 추가한다" 류의 지시: 0건. 모든 코드 단계가 완전한 함수 본문을 담는다.
- "Task N과 비슷하게": 0건. 반복되는 픽스처(`_freeEvent`, `_code`, `_sig`)는 Base 또는 각 테스트 파일에 전체 코드로 적혀 있다.
- 정의되지 않은 타입·함수 참조: 없음. `MockTicket`·`MockEntryPoint`·`MockP256Precompile`·`P256Vectors`는 각각 Task 12·25·19에서 전체 코드로 생성된다.
- "실행해서 값을 얻는" 단계: **Task 19 Step 2 하나뿐**이며, 그 출력 형식(필드 이름과 `0x`+64자리)까지 문서에 적었다.
- 의도적으로 넣은 잘못된 리터럴 두 곳(`0xT1CKE7`, `0xGA`~`0xGD`)은 바로 다음 단계에서 정확한 치환 명령과 함께 고쳐진다 — 실행자가 멈추지 않는다.

### 3. 타입 일관성 (마스터 플랜 대조)

- `Identity`: `register`, `rotateAccount`, `setActiveDevice`, `lockDevice`, `accountOf`, `personOf`, `isMember`, `activeDevice`, `isLocked`, `deviceUpdatedAt`, `ROTATION_COOLDOWN`, `DEVICE_COOLDOWN`, 이벤트 4종 — 이름과 인자 순서가 마스터와 동일. 델타로 `setNickname`/`nicknameOwner`/`nicknameOf`/`NicknameSet`/`NicknameTaken`/`attester()`가 추가됨.
- `Organizers`: 권한 상수 5개 값(1·2·4·8·16), 함수 13개, 이벤트 8종 — 마스터와 동일. `registerGate(eventId, gateAccount, kx, ky)`의 인자 순서도 그대로다(orgId를 받지 않고 `ticket.eventOrg(eventId)`로 찾는다).
- `Ticket`: `EventMeta`·`Tier`·`GateCode`·`CheckIn` 필드 이름·타입·순서가 마스터와 동일하고, 델타가 `EventMeta` **끝에** `category`·`regionCode`만 덧붙였다(앞 13개 필드는 그대로라 기존 ABI 순서가 보존된다). `CODE_WINDOW = 60`. 함수 시그니처 13개와 이벤트 8종 동일. 델타로 `EventStatus`·`publishEvent`·`cancelEvent`·`updateEventMeta`·`eventStatus`·`EventStatusChanged`·`Offer`·`createOffer`·`cancelOffer`·`acceptOffer`·`offerOf`·오퍼 이벤트 3종이 추가됨.
- KYC 등급: `Identity.kycLevelOf`는 `uint8`이고 0과 1만 쓴다(0 = 문자+패스키, 1 = 신분증+얼굴). `Ticket`은 `< 1`로만 비교하므로 나중에 2단계를 더해도 기존 규칙이 깨지지 않는다. `setKycLevel`은 어테스터 EOA가 부르므로 `register`·`rotateAccount`과 마찬가지로 페이마스터 허용 목록에 넣지 않았다.
- `MontiPaymaster`: `depositPlatform`, `deposit`, `withdraw`, `setSelfSponsored`, `budgetOf`, 이벤트 3종이 마스터와 동일. `paymasterAndData = abi.encodePacked(address(this), uint256 orgId)`(52바이트)와 "검증 단계에서 `maxCost` 차감, `postOp` 없음"도 그대로다. 허용 목록은 마스터의 15개를 모두 포함하고 델타의 7개(`setNickname`, `createOffer`, `cancelOffer`, `acceptOffer`, `publishEvent`, `cancelEvent`, `updateEventMeta`)를 더해 23개다.
- 서명 다이제스트: `sha256(abi.encode(tokenId, g.gateId, g.eventId, g.nonce, g.issuedAt))` — 마스터 주석과 한 글자도 다르지 않으며 Task 19의 생성 스크립트와 Task 20의 `test_digestMatchesTheSpecFormula`가 서로를 검증한다.
- 이름 충돌 점검: `Ticket.DeviceLocked`는 **에러**, `Identity.DeviceLocked`는 **이벤트**다. 서로 다른 컨트랙트라 충돌하지 않지만 ABI 소비자(서브플랜 04)가 혼동하지 않도록 Task 33 Step 3의 검사 목록에 둘 다 명시했다.
- 이 플랜이 마스터에 **없던 것을 추가한 목록**(변경이 아니라 추가): `AttesterRole`(`attester`, `deployer`, `setAttester`, `AttesterChanged`, `NotAttester`, `NotDeployer`, `ZeroAddress`), `Organizers.adminBitsOf`·`Organizers.ticket`·`Organizers.deployer`, `Ticket.eventStatus`·`Ticket.offerOf`·커스텀 에러 전체(`KycRequired` 포함), `MontiPaymaster.setTargets`·`allowedSelector`·`selfSponsored`·`addStake`·`unlockStake`·`withdrawStake`·`depositToEntryPoint`·`entryPointBalance`·`PLATFORM`. 마스터에 정의된 이름은 하나도 바꾸지 않았다.
