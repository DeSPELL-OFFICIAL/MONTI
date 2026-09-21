# MONTI Implementation Plan · 04 스태프 안드로이드 단말기 (HCE 플러그인 · 게이트 계정 · 체크인 · 판정 · 오프라인 큐)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **Read `docs/superpowers/plans/2026-09-20-monti-00-master-plan.md` first** (공유 인터페이스와 Global Constraints가 거기 있다), 그다음 이 파일. 스펙은 `docs/superpowers/specs/2026-09-20-monti-nfc-ticketing-design.md` v2.3.

**Goal:** 안드로이드 스태프 단말기가 3초마다 게이트 1회용 번호를 HCE로 내보내고, 관객 폰이 같은 탭 안에서 써넣은 기기 키 서명을 받아 게이트 스마트 계정으로 `Ticket.checkIn`을 체인에 보내고, `CheckedIn` 이벤트를 직접 구독해 초록(사진)·빨강(사유)을 띄우며, 인터넷이 끊겨도 서명된 스냅샷으로 로컬 검증하고 큐에 쌓아 복구 후 전송하는 단말기를 만든다.

**Architecture:** 네이티브는 한 곳에만 얇게 붙는다 — `plugins/hce-android/`의 Kotlin `HostApduService`가 NFC Forum Type 4 Tag 상태 기계를 구현하고, 페이로드는 base64 NDEF 메시지로 주고받는 순수 바이트 통로다. 나머지 전부(게이트 계정, 코드 생성, 판정 상태 기계, 스냅샷, 큐, QR, 수동 승인)는 `apps/web/src/staff/`의 TypeScript이고, 같은 웹 코드베이스를 `capacitor.staff.config.ts`(app id `app.monti.staff`)로 한 번 더 빌드해 안드로이드 전용 껍데기에 넣는다. 판정의 권한은 언제나 체인이다 — 단말기는 `monadLogs`로 이벤트를 직접 보고, 서버는 사진과 스냅샷만 준다.

**Tech Stack:** Kotlin 2.0 + Android Gradle Plugin 8.7 (`HostApduService`, `CardEmulation`), JUnit 4 (APDU 상태 기계 단위 테스트), Capacitor 8 플러그인 규약, React 19 + Vite + TypeScript, viem + ox (`toCoinbaseSmartAccount`, `WebAuthnP256`), `@noble/curves` P-256 (오프라인 검증), `cborg` (CBOR), `idb` (IndexedDB), `@capacitor-mlkit/barcode-scanning` (QR 폴백), Vitest.

**Spec:** `docs/superpowers/specs/2026-09-20-monti-nfc-ticketing-design.md` (v2.3, 확정). 이 계획이 구현하는 절: §5.7, §6.3(T2·T9·T10·T12~T15), §7(2·5~8단계와 파라미터 표), §9.4, §11 HCE 세부, §12, §13, §16 W3 필드 테스트, §18 단말기 간섭 리스크.

## Global Constraints

마스터 플랜에서 그대로 옮겼다. 이 계획의 모든 태스크가 암묵적으로 포함한다.

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

### 이 계획에만 추가로 적용되는 제약

- **스태프 코드는 NFC 리더 API를 절대 부르지 않는다.** `NfcAdapter.enableReaderMode`, `enableForegroundDispatch`, `@capgo/capacitor-nfc` import가 `apps/web/src/staff/**`와 `plugins/hce-android/**`에 한 글자도 없어야 한다(Task 19가 테스트로 강제). 스펙 §11, §18.
- **페이로드 교체는 탭과 탭 사이에만.** 세션 중(SELECT AID ~ `onDeactivated`) 들어온 새 게이트 코드는 대기열에 두고 다음 세션 시작에 승격한다(Task 5).
- **시간 초과로 소프트 승인 금지.** 2초까지 "확인 중", 5초 넘으면 "다시 대세요". 어떤 타임아웃도 `admit`으로 가지 않는다(Task 23, 스펙 §7.3).
- **게이트 기기 키는 생체 인증을 요구하지 않는다.** 3초마다 서명해야 하므로 `requireAuth: false`로 만든 별도 별칭(`monti-gate`)을 쓴다. 관객 기기 키(생체 60초)와 다른 키다.
- **체크인은 게이트 계정이, 수동 승인은 스태프 본인 패스키 계정이 보낸다.** 두 계정을 절대 섞지 않는다(Task 35).
- 스태프 화면은 크립토 단어 금지 대상이 **아니다**(마스터 플랜 카피 린트가 `staff/`를 제외한다). 그래도 "블록 번호", "체인 확인 중"만 쓰고 "지갑·가스"는 쓰지 않는다.

---

## 사전 조건 (01~03에서 와야 하는 것)

| # | 필요한 것 | 어디서 | 없으면 |
|---|---|---|---|
| P1 | `packages/shared`의 `ticketAbi`, `organizersAbi`, `identityAbi`, `CONTRACTS`, `ATTESTER_ADDRESS`, `ENTRYPOINT_V06`, `CHAIN_ID` | 01 ABI + 02 패키지 | Task 10에서 로컬 상수로 임시 고정하고 Task 37이 diff |
| P2 | `apps/web/src/shared/chain/`의 `getPublicClient()`, `getBundlerClient()`, `sendSponsoredOp()`, `subscribeLogs()` | 03 | Task 22·24가 어댑터를 직접 정의(아래 "가정한 인터페이스") |
| P3 | `apps/web/src/shared/deviceKey/`의 `ensureDeviceKey()`, `signWithDeviceKey()` | 03 | Task 15가 옵션 인자를 추가 |
| P4 | `apps/web/src/shared/api/`의 `issueSnapshot({ eventId, gateAccount })`, `getPhotoForGate({ tokenId, gateAccount })`, `submitPendingGate({ eventId, gateAccount, kx, ky, deviceLabel })` | 02 Functions + 03 래퍼 | Task 15·25·30이 호출 래퍼를 직접 정의 |
| P8 | **스태프 본인이 패스키로 로그인한 Firebase 세션** — 두 callable 의 인증 주체다 | 03 로그인 | 게이트 화면 진입 전에 로그인 게이트를 세운다(Task 30) |
| P5 | `apps/web/src/staff/components/`의 콘솔 컴포넌트(스펙 §13 8개 상태, 빈 `photoJpegB64` 면 아바타 플레이스홀더 + 닉네임 + "본인인증 없음" 칩) | 03 | Task 30이 마크업까지 직접 작성 |
| P6 | `apps/web/android` (Capacitor 안드로이드 프로젝트 + gradle wrapper) | 03 | Task 1 Step 2가 `npx cap add android`로 먼저 만든다 |
| P7 | 루트 vitest (`pnpm vitest run <path>`가 리포 루트에서 동작) | 03 | Task 1 Step 1이 `vitest.workspace.ts`에 플러그인을 추가 |

### 가정한 인터페이스 (01~03에 아직 없어서 이 계획이 확정한 것)

아래 시그니처는 **이 계획이 확정**한다. 01~03이 다른 이름으로 만들면 Task 37이 잡아 고친다.

```ts
// apps/web/src/shared/chain/sponsored.ts — 03 소유, 이 계획이 시그니처를 확정
export interface SponsoredCall { to: `0x${string}`; data: `0x${string}`; value?: bigint }
export interface SponsoredOpRequest { account: import('viem/account-abstraction').SmartAccount; calls: SponsoredCall[]; orgId: bigint }
export interface SponsoredOpReceipt { success: boolean; txHash: `0x${string}`; blockNumber: bigint; revertReason?: `0x${string}` }
export interface SponsoredOpHandle { userOpHash: `0x${string}`; wait(timeoutMs?: number): Promise<SponsoredOpReceipt> }
export function sendSponsoredOp(req: SponsoredOpRequest): Promise<SponsoredOpHandle>

// apps/web/src/shared/chain/subscribeLogs.ts — 03 소유. 마스터 플랜은 subscribeLogs(topic)만 적었다.
export type LogStage = 'speculative' | 'finalized'
export interface ChainLog { address: `0x${string}`; topics: `0x${string}`[]; data: `0x${string}`; blockNumber: bigint; transactionHash: `0x${string}`; stage: LogStage }
export type LogSubscription = () => void   // 구독 해제 함수 그 자체다(03 `subscribeLogs` 가 반환하는 클로저)
export function subscribeLogs(p: { address: `0x${string}`; topics: (`0x${string}` | `0x${string}`[] | null)[]; onLog: (l: ChainLog) => void; onError?: (e: Error) => void }): LogSubscription

// apps/web/src/shared/deviceKey/index.ts — 03 소유. 마스터 플랜은 인자 없는 ensureDeviceKey()만 적었다.
export interface DeviceKeyOptions { alias?: string; requireAuth?: boolean; strongBox?: boolean }
export function ensureDeviceKey(o?: DeviceKeyOptions): Promise<{ x: `0x${string}`; y: `0x${string}` }>
export function signWithDeviceKey(hash: `0x${string}`, o?: { alias?: string }): Promise<{ r: `0x${string}`; s: `0x${string}` }>
// 계약: hash 는 이미 계산된 32바이트 다이제스트이고, 구현은 그 위에 raw ECDSA(NONEwithECDSA)를 수행한다. 내부에서 다시 해시하지 않는다.

// packages/shared/src/constants.ts — 02 소유
export const ATTESTER_ADDRESS: `0x${string}`   // 마스터 플랜 Reconciliation: Identity.attester() view 와 ATTESTER_ADDRESS 상수가 둘 다 있다. 오프라인에서도 되도록 상수로 읽는다
export const CONTRACTS: { identity: `0x${string}`; organizers: `0x${string}`; ticket: `0x${string}`; paymaster: `0x${string}` }
export const ENTRYPOINT_V06 = '0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789' as const
export const CHAIN_ID: number

// apps/web/src/shared/api/functions.ts — 02 Functions + 03 래퍼
// 두 callable 은 **스태프 본인의 Firebase 세션**으로 인증된다(게이트 기기 계정이 아니다).
// 서버가 검사하는 것: ① 호출자가 이 공연 org 의 매니저 또는 관리자인가
//                  ② gateAccount 가 그 공연에 등록된 게이트인가 (Organizers.gateOf / isOpenGate)
// gateAccount 는 신원이 아니라 "어느 게이트 화면에 띄울 사진인가"를 서버가 감사 로그에 남기기 위한 값이다.
export function issueSnapshot(p: { eventId: string; gateAccount: `0x${string}` }): Promise<SnapshotWire>
export function getPhotoForGate(p: { tokenId: string; gateAccount: `0x${string}` }): Promise<{ photoJpegB64: string; displayName: string }>
// 게이트 등록 신청. 단말기가 키를 만든 직후 한 번 부른다. QR 은 폴백 표시용으로만 남는다.
export function submitPendingGate(p: { eventId: string; gateAccount: `0x${string}`; kx: `0x${string}`; ky: `0x${string}`; deviceLabel: string }): Promise<{ ok: boolean }>

// Ticket.sol 커스텀 에러 이름 (01 소유). Task 26의 셀렉터 매핑이 이 이름에 의존한다.
// error AlreadyCheckedIn(); error WrongEvent(); error TicketRevoked(); error EventEnded(); error EventNotPublished();
// error CodeExpired(); error NoSuchTicket(); error GateNotOpen(); error DeviceLocked(); error BadDeviceSignature();

// packages/shared/src/encoding.ts — 02 소유. 로컬에 복제하지 않는다.
//  canonicalJson: 키 정렬 + 공백 없음 + `0x…` 문자열 소문자화 + 정수가 아닌 number 는 예외.
//  snapshotDigest: **attesterSig 가 빠진 객체**를 받는다. 넘기기 전에 반드시 제거한다.
export function canonicalJson(value: unknown): string
export function snapshotDigest(body: Omit<SnapshotWire, 'attesterSig'>): `0x${string}`

// SnapshotWire 에 최상위 `eventTitle: string` 과 `requireKyc: boolean` 이, 각 tickets[] 항목에
// `tierName: string` 과 `seat: string`(없으면 "")이 실린다. Ticket.EventMeta 에도 `requireKyc` 가 있다.
// requireKyc == false 면 photoJpegB64 가 "" 이고 getPhotoForGate 도 빈 사진을 준다.
// 단말기는 스냅샷을 1순위로 읽고, 스냅샷이 아직 없을 때만 eventMeta 로 떨어진다.
// 마스터 플랜 Shared Interfaces 의 SnapshotWire 와 EventMeta 에 이 필드들을 추가해야 한다.

// apps/web/src/shared/staffSession.ts — 03 소유(패스키 로그인 세션)
export function useStaffSession(): { displayName: string; selectedEventId?: string }

// apps/web/src/staff/components/* (03 소유) — Task 30이 쓰는 컴포넌트 이름과 props (03 정본)
// StaffShell({ gateName, eventTitle, staffName, chainStage, speculativeBlock, finalizedBlock, snapshotAgeSec, entriesCount, children })
// TapPrompt({ rotating })
// ReceivedCard({ tokenIdMasked, precheck })
// ConfirmingCard({ elapsedMs })
// AdmitCard({ photoJpegB64, displayName, tierLabel, seat, entryNumber, timestamp, blockNumber, deviceChangedRecently, finalized, onDone })
// OfflineAdmitCard({ photoJpegB64, displayName, tierLabel, seat, queuedCount, onDone })
// DenyCard({ code, detail, onDone })
// OverrideDialog({ canApprove, onSubmit, onCancel })
// OfflineBadge({ snapshotAgeSec, queuedCount })
// photoJpegB64 가 빈 문자열이면 AdmitCard·OfflineAdmitCard 는 사진 대신 아바타 플레이스홀더와
// displayName(닉네임), 그리고 "본인인증 없음 · 사진 대조 불가" 칩을 렌더한다(requireKyc == false 행사).
```

---

## File Structure

```
plugins/hce-android/
  package.json                          @monti/hce-android, Capacitor 8 plugin 규약
  tsconfig.json  rollup.config.mjs
  src/definitions.ts                    HcePlugin 인터페이스 + HceWriteEvent
  src/index.ts                          registerPlugin('Hce')
  src/web.ts                            웹 스텁(unavailable)
  src/index.test.ts                     TS 정의 계약 테스트
  android/settings.gradle  android/build.gradle  android/gradle.properties
  android/src/main/AndroidManifest.xml  HostApduService 등록
  android/src/main/res/xml/monti_apduservice.xml   AID 그룹 D2760000850101, category other
  android/src/main/res/values/strings.xml
  android/src/main/java/app/monti/hce/ApduStatus.kt        상태어 상수
  android/src/main/java/app/monti/hce/Type4Files.kt        CC 파일 15바이트 + NDEF 파일 버퍼
  android/src/main/java/app/monti/hce/ApduStateMachine.kt  Type 4 상태 기계(읽기·쓰기)
  android/src/main/java/app/monti/hce/HceBridge.kt         서비스 ↔ 플러그인 단일 접점
  android/src/main/java/app/monti/hce/MontiHostApduService.kt
  android/src/main/java/app/monti/hce/HcePlugin.kt         @CapacitorPlugin(name="Hce")
  android/src/test/java/app/monti/hce/Type4FilesTest.kt
  android/src/test/java/app/monti/hce/ApduStateMachineTest.kt        iOS CoreNFC 기록 시퀀스
  android/src/test/java/app/monti/hce/ApduWriteTest.kt               Android 리더 기록 시퀀스
  android/src/test/java/app/monti/hce/PayloadSwapTest.kt
  android/src/test/java/app/monti/hce/ApduServiceManifestTest.kt

apps/web/
  capacitor.staff.config.ts             app.monti.staff, android.path = android-staff
  vite.staff.config.ts                  dist-staff, staff.html → index.html
  staff.html                            스태프 전용 엔트리
  android-staff/                        npx cap add android --config … 이 만든다
  src/staffMain.tsx                     MemoryRouter로 StaffRoutes 마운트
  src/staff/StaffRoutes.tsx             /staff/setup, /staff/gate, /staff/queue
  src/staff/constants.ts                AID, 회전 주기, 타임아웃, NDEF 타입, QR 프리픽스
  src/staff/types.ts                    GateState, DenyCode, PreflightResult, QueueEntry
  src/staff/gate/gateKey.ts             ensureGateDeviceKey / signWithGateKey
  src/staff/gate/gateCode.ts            GateCodeWire 생성 + 서명
  src/staff/gate/emitter.ts             3초 회전 루프 + Hce.start/setPayload/stop
  src/staff/gate/decodeResponse.ts      monti.app:s → GateResponseWire
  src/staff/gate/preflight.ts           스냅샷 사전 검증
  src/staff/gate/checkInOp.ts           Ticket.checkIn 유저옵
  src/staff/gate/denyMap.ts             revert → DenyCode
  src/staff/gate/verdict.ts             CheckedIn 구독 + nonceHash 매칭
  src/staff/gate/machine.ts             idle/ready/received/confirming/admit/offlineAdmit/deny/override
  src/staff/gate/GateScreen.tsx         상태 기계 ↔ UI 배선
  src/staff/setup/GateSetupScreen.tsx   게이트 계정 주소 QR/텍스트 + gateOf 폴링
  src/staff/snapshot/verify.ts          attesterSig 복구 검증
  src/staff/snapshot/store.ts           IndexedDB 저장 + 10분 갱신
  src/staff/snapshot/offlineVerify.ts   @noble/curves P-256 로컬 검증
  src/staff/net/online.ts               오프라인 감지
  src/staff/queue/db.ts                 IndexedDB 스키마(idb)
  src/staff/queue/opQueue.ts            내구 큐 + 백오프
  src/staff/queue/reconcile.ts          ALREADY_USED 대사
  src/staff/queue/QueueScreen.tsx       대기 건수·대사 결과
  src/staff/qr/scan.ts                  MONTI1: QR → 같은 수신 경로
  src/staff/override/pin.ts             PBKDF2 PIN
  src/staff/override/route.ts           requestOverride vs manualOverride
  src/shared/chain/gateSigner.ts        WebAuthn 모양 서명(webauthn-sol 호환)
  src/shared/chain/gateAccount.ts       게이트 스마트 계정
  src/shared/nfc/ndef.ts                NDEF external record 인코더·디코더

docs/superpowers/plans/fieldtest-w3.md  Task 36이 만드는 필드 테스트 기록지
```

---

## Task 1: HCE 플러그인 스캐폴드와 TypeScript 정의

**Files:**
- Create: `plugins/hce-android/package.json`, `plugins/hce-android/tsconfig.json`, `plugins/hce-android/src/definitions.ts`, `plugins/hce-android/src/index.ts`, `plugins/hce-android/src/web.ts`
- Test: `plugins/hce-android/src/index.test.ts`
- Modify: `vitest.workspace.ts` (리포 루트)

**Interfaces:**
- Consumes: 없음 (이 계획의 첫 태스크)
- Produces: `Hce` 객체와 `HcePlugin` 타입 — `Hce.start({ aid: string })`, `Hce.setPayload({ ndef: string })`, `Hce.stop()`, `Hce.addListener('write', (e: HceWriteEvent) => void)`. `HceWriteEvent = { ndef: string }` (base64 표준 인코딩, 패딩 포함). Task 18·20이 쓴다.

- [ ] **Step 1: 패키지 뼈대와 워크스페이스 등록**

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI
mkdir -p plugins/hce-android/src
cat > plugins/hce-android/package.json <<'EOF'
{
  "name": "@monti/hce-android",
  "version": "0.1.0",
  "description": "MONTI gate HCE plugin (NFC Forum Type 4 Tag, writable NDEF)",
  "main": "dist/plugin.cjs.js",
  "module": "dist/esm/index.js",
  "types": "dist/esm/index.d.ts",
  "files": ["android/src/main/", "android/build.gradle", "dist/", "MontiHce.podspec"],
  "scripts": {
    "build": "tsc"
  },
  "capacitor": {
    "android": {
      "src": "android"
    }
  },
  "peerDependencies": {
    "@capacitor/core": "^8.0.0"
  },
  "devDependencies": {
    "@capacitor/android": "^8.0.0",
    "@capacitor/core": "^8.0.0",
    "typescript": "^5.6.0"
  }
}
EOF
cat > plugins/hce-android/tsconfig.json <<'EOF'
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "declaration": true,
    "strict": true,
    "outDir": "dist/esm",
    "rootDir": "src",
    "skipLibCheck": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["src/**/*.test.ts"]
}
EOF
cat > vitest.workspace.ts <<'EOF'
import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  'apps/web',
  'plugins/hce-android',
]);
EOF
pnpm install
```

Expected: `pnpm install` ends with `Done in …`, and `plugins/hce-android/node_modules/@capacitor/android` exists.

- [ ] **Step 2: 실패하는 테스트를 쓴다**

```ts
// plugins/hce-android/src/index.test.ts
import { describe, expect, it, vi, beforeEach } from 'vitest';

const registered: Record<string, unknown> = {};
vi.mock('@capacitor/core', () => ({
  registerPlugin: (name: string, impl: unknown) => {
    registered[name] = impl;
    return { __name: name } as unknown;
  },
}));

describe('@monti/hce-android', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('registers under the name "Hce"', async () => {
    const mod = await import('./index');
    expect((mod.Hce as unknown as { __name: string }).__name).toBe('Hce');
    expect(registered.Hce).toBeDefined();
  });

  it('the web fallback refuses every method so no silent no-op ships', async () => {
    const { HceWeb } = await import('./web');
    const web = new HceWeb();
    await expect(web.start({ aid: 'D2760000850101' })).rejects.toThrow('HCE is Android-only');
    await expect(web.setPayload({ ndef: 'AA==' })).rejects.toThrow('HCE is Android-only');
    await expect(web.stop()).rejects.toThrow('HCE is Android-only');
  });
});
```

- [ ] **Step 3: 테스트가 실패하는지 확인**

Run: `pnpm vitest run plugins/hce-android/src/index.test.ts`
Expected: FAIL — `Failed to load url ./index` / `Cannot find module './web'`.

- [ ] **Step 4: 정의와 구현을 쓴다**

```ts
// plugins/hce-android/src/definitions.ts
import type { PluginListenerHandle } from '@capacitor/core';

/** Base64(표준, 패딩 포함)로 인코딩된 완전한 NDEF 메시지 한 개. */
export interface HceWriteEvent {
  ndef: string;
}

export interface HceStartOptions {
  /** 대문자 16진 AID. 매니페스트에 등록된 값과 같아야 한다. */
  aid: string;
}

export interface HceSetPayloadOptions {
  /** Base64(표준, 패딩 포함) NDEF 메시지. 다음 탭부터 적용된다. */
  ndef: string;
}

export interface HcePlugin {
  /** 전면 서비스를 우선 서비스로 잡고 상태 기계를 켠다. */
  start(options: HceStartOptions): Promise<void>;
  /** 다음 세션에 내보낼 NDEF 메시지를 예약한다. 세션 중에는 교체되지 않는다. */
  setPayload(options: HceSetPayloadOptions): Promise<void>;
  /** 우선 서비스를 해제하고 상태 기계를 끈다. */
  stop(): Promise<void>;
  addListener(
    eventName: 'write',
    listenerFunc: (event: HceWriteEvent) => void,
  ): Promise<PluginListenerHandle>;
  removeAllListeners(): Promise<void>;
}
```

```ts
// plugins/hce-android/src/index.ts
import { registerPlugin } from '@capacitor/core';

import type { HcePlugin } from './definitions';

const Hce = registerPlugin<HcePlugin>('Hce', {
  web: () => import('./web').then((m) => new m.HceWeb()),
});

export * from './definitions';
export { Hce };
```

```ts
// plugins/hce-android/src/web.ts
import { WebPlugin } from '@capacitor/core';
import type { PluginListenerHandle } from '@capacitor/core';

import type { HcePlugin, HceSetPayloadOptions, HceStartOptions } from './definitions';

const MESSAGE = 'HCE is Android-only; this build has no card emulation.';

export class HceWeb extends WebPlugin implements HcePlugin {
  async start(_options: HceStartOptions): Promise<void> {
    throw this.unavailable(MESSAGE);
  }

  async setPayload(_options: HceSetPayloadOptions): Promise<void> {
    throw this.unavailable(MESSAGE);
  }

  async stop(): Promise<void> {
    throw this.unavailable(MESSAGE);
  }

  async addListener(
    _eventName: 'write',
    _listenerFunc: (event: { ndef: string }) => void,
  ): Promise<PluginListenerHandle> {
    throw this.unavailable(MESSAGE);
  }
}
```

- [ ] **Step 5: 테스트가 통과하는지 확인**

Run: `pnpm vitest run plugins/hce-android/src/index.test.ts`
Expected: PASS — `Test Files  1 passed (1)` / `Tests  2 passed (2)`.

- [ ] **Step 6: 커밋**

```bash
git add plugins/hce-android vitest.workspace.ts pnpm-lock.yaml
git commit -m "feat(hce): scaffold @monti/hce-android plugin with TypeScript definitions"
```

---

## Task 2: Type 4 Tag 파일 모델 (CC 15바이트 + NDEF 파일 버퍼)

**Files:**
- Create: `plugins/hce-android/android/settings.gradle`, `plugins/hce-android/android/build.gradle`, `plugins/hce-android/android/gradle.properties`, `plugins/hce-android/android/src/main/java/app/monti/hce/ApduStatus.kt`, `plugins/hce-android/android/src/main/java/app/monti/hce/Type4Files.kt`
- Test: `plugins/hce-android/android/src/test/java/app/monti/hce/Type4FilesTest.kt`

**Interfaces:**
- Consumes: Task 1의 패키지 디렉터리, 03이 만든 `apps/web/android`의 gradle wrapper
- Produces: `app.monti.hce.ApduStatus` (`SW_OK`, `SW_FILE_NOT_FOUND`, `SW_SECURITY`, `SW_WRONG_P1P2`, `SW_INS_NOT_SUPPORTED`, `SW_CLASS_NOT_SUPPORTED` — 모두 `ByteArray`), `app.monti.hce.Type4Files` (`CC_FILE_ID`, `NDEF_FILE_ID`, `MAX_NDEF_SIZE`, `capabilityContainer(): ByteArray`, `ndefFileBytes(message: ByteArray): ByteArray`). Task 3·4·5가 쓴다.

- [ ] **Step 1: gradle 프로젝트와 wrapper를 만든다**

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI
mkdir -p plugins/hce-android/android/src/main/java/app/monti/hce
mkdir -p plugins/hce-android/android/src/test/java/app/monti/hce
mkdir -p plugins/hce-android/android/src/main/res/xml
mkdir -p plugins/hce-android/android/src/main/res/values
cp -R apps/web/android/gradle plugins/hce-android/android/gradle
cp apps/web/android/gradlew plugins/hce-android/android/gradlew
chmod +x plugins/hce-android/android/gradlew
cat > plugins/hce-android/android/settings.gradle <<'EOF'
include ':capacitor-android'
project(':capacitor-android').projectDir = new File('../node_modules/@capacitor/android/capacitor')
EOF
cat > plugins/hce-android/android/gradle.properties <<'EOF'
android.useAndroidX=true
org.gradle.jvmargs=-Xmx2048m
EOF
cat > plugins/hce-android/android/build.gradle <<'EOF'
buildscript {
    repositories {
        google()
        mavenCentral()
    }
    dependencies {
        classpath 'com.android.tools.build:gradle:8.7.2'
        classpath 'org.jetbrains.kotlin:kotlin-gradle-plugin:2.0.21'
    }
}

apply plugin: 'com.android.library'
apply plugin: 'kotlin-android'

android {
    namespace 'app.monti.hce'
    compileSdk 35
    defaultConfig {
        minSdk 23
        targetSdk 35
    }
    compileOptions {
        sourceCompatibility JavaVersion.VERSION_21
        targetCompatibility JavaVersion.VERSION_21
    }
    kotlinOptions {
        jvmTarget = '21'
    }
    testOptions {
        unitTests.returnDefaultValues = true
    }
}

repositories {
    google()
    mavenCentral()
}

dependencies {
    implementation 'androidx.appcompat:appcompat:1.7.0'
    implementation project(':capacitor-android')
    testImplementation 'junit:junit:4.13.2'
}
EOF
```

Expected: `ls plugins/hce-android/android/gradlew` prints the path (P6 전제가 충족됐다는 뜻).

- [ ] **Step 2: 실패하는 테스트를 쓴다**

```kotlin
// plugins/hce-android/android/src/test/java/app/monti/hce/Type4FilesTest.kt
package app.monti.hce

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test

class Type4FilesTest {

    private fun hex(bytes: ByteArray): String =
        bytes.joinToString("") { String.format("%02X", it) }

    @Test
    fun capabilityContainerIsExactlyFifteenBytes() {
        assertEquals(15, Type4Files.capabilityContainer().size)
    }

    @Test
    fun capabilityContainerMatchesTheNfcForumLayout() {
        // CCLEN 000F | mapping 20 | MLe 00FF | MLc 00FF | TLV 04 06 E104 0800 00 00
        assertEquals("000F2000FF00FF0406E104080000", hex(Type4Files.capabilityContainer()).dropLast(2))
        assertEquals("000F2000FF00FF0406E1040800" + "00" + "00", hex(Type4Files.capabilityContainer()))
    }

    @Test
    fun fileIdsAreTheSpecifiedOnes() {
        assertArrayEquals(byteArrayOf(0xE1.toByte(), 0x03), Type4Files.CC_FILE_ID)
        assertArrayEquals(byteArrayOf(0xE1.toByte(), 0x04), Type4Files.NDEF_FILE_ID)
        assertEquals(2048, Type4Files.MAX_NDEF_SIZE)
    }

    @Test
    fun ndefFileIsNlenPrefixedBigEndian() {
        val message = ByteArray(300) { 0x41 }
        val file = Type4Files.ndefFileBytes(message)
        assertEquals(302, file.size)
        assertEquals(0x01, file[0].toInt())
        assertEquals(0x2C, file[1].toInt())
        assertEquals(0x41, file[2].toInt())
    }

    @Test
    fun emptyNdefFileIsTwoZeroBytes() {
        assertArrayEquals(byteArrayOf(0x00, 0x00), Type4Files.ndefFileBytes(ByteArray(0)))
    }

    @Test
    fun statusWordsAreTwoBytesEach() {
        assertArrayEquals(byteArrayOf(0x90.toByte(), 0x00), ApduStatus.SW_OK)
        assertArrayEquals(byteArrayOf(0x6A, 0x82.toByte()), ApduStatus.SW_FILE_NOT_FOUND)
        assertArrayEquals(byteArrayOf(0x69, 0x82.toByte()), ApduStatus.SW_SECURITY)
        assertArrayEquals(byteArrayOf(0x6A, 0x86.toByte()), ApduStatus.SW_WRONG_P1P2)
    }
}
```

- [ ] **Step 3: 테스트가 실패하는지 확인**

Run: `cd plugins/hce-android/android && ./gradlew test --tests 'app.monti.hce.Type4FilesTest'`
Expected: FAIL — `e: ... Unresolved reference: Type4Files` 와 `BUILD FAILED`.

- [ ] **Step 4: 구현을 쓴다**

```kotlin
// plugins/hce-android/android/src/main/java/app/monti/hce/ApduStatus.kt
package app.monti.hce

/** ISO 7816-4 상태어. 모두 응답 끝 2바이트로 붙는다. */
object ApduStatus {
    val SW_OK = byteArrayOf(0x90.toByte(), 0x00)
    val SW_FILE_NOT_FOUND = byteArrayOf(0x6A, 0x82.toByte())
    val SW_SECURITY = byteArrayOf(0x69, 0x82.toByte())
    val SW_WRONG_P1P2 = byteArrayOf(0x6A, 0x86.toByte())
    val SW_WRONG_LENGTH = byteArrayOf(0x67, 0x00)
    val SW_INS_NOT_SUPPORTED = byteArrayOf(0x6D, 0x00)
    val SW_CLASS_NOT_SUPPORTED = byteArrayOf(0x6E, 0x00)
}
```

```kotlin
// plugins/hce-android/android/src/main/java/app/monti/hce/Type4Files.kt
package app.monti.hce

/**
 * NFC Forum Type 4 Tag (mapping version 2.0) 파일 모델.
 *
 * CC 파일은 15바이트 고정이다:
 *   CCLEN      000F
 *   mapping    20        (2.0)
 *   MLe        00FF      (READ BINARY 한 번에 255바이트)
 *   MLc        00FF      (UPDATE BINARY 한 번에 255바이트)
 *   NDEF TLV   04 06 E104 0800 00 00
 *              T=04, L=06, fileId=E104, maxSize=2048, read=00(자유), write=00(자유)
 */
object Type4Files {
    val CC_FILE_ID = byteArrayOf(0xE1.toByte(), 0x03)
    val NDEF_FILE_ID = byteArrayOf(0xE1.toByte(), 0x04)

    const val MAX_NDEF_SIZE = 2048

    fun capabilityContainer(): ByteArray = byteArrayOf(
        0x00, 0x0F,                                     // CCLEN
        0x20,                                           // mapping version 2.0
        0x00, 0xFF.toByte(),                            // MLe
        0x00, 0xFF.toByte(),                            // MLc
        0x04, 0x06,                                     // NDEF File Control TLV: T, L
        0xE1.toByte(), 0x04,                            // NDEF file id
        ((MAX_NDEF_SIZE shr 8) and 0xFF).toByte(),      // max NDEF size hi
        (MAX_NDEF_SIZE and 0xFF).toByte(),              // max NDEF size lo
        0x00,                                           // read access: 자유
        0x00,                                           // write access: 자유 (HCE_STATE_WRITE_FULL)
    )

    /** NLEN(빅엔디언 2바이트) + 메시지. 빈 메시지는 0000 두 바이트다. */
    fun ndefFileBytes(message: ByteArray): ByteArray {
        require(message.size <= MAX_NDEF_SIZE) { "NDEF message exceeds $MAX_NDEF_SIZE bytes" }
        val out = ByteArray(message.size + 2)
        out[0] = ((message.size shr 8) and 0xFF).toByte()
        out[1] = (message.size and 0xFF).toByte()
        message.copyInto(out, 2)
        return out
    }
}
```

- [ ] **Step 5: 테스트가 통과하는지 확인**

Run: `cd plugins/hce-android/android && ./gradlew test --tests 'app.monti.hce.Type4FilesTest'`
Expected: PASS — `BUILD SUCCESSFUL in ...`, 6 tests, 0 failures.

- [ ] **Step 6: 커밋**

```bash
git add plugins/hce-android/android
git commit -m "feat(hce): add Type 4 Tag capability container and status words"
```

---

## Task 3: APDU 상태 기계 — 읽기 경로 (iOS CoreNFC 기록 시퀀스)

**Files:**
- Create: `plugins/hce-android/android/src/main/java/app/monti/hce/ApduStateMachine.kt`
- Test: `plugins/hce-android/android/src/test/java/app/monti/hce/ApduStateMachineTest.kt`

**Interfaces:**
- Consumes: `ApduStatus`, `Type4Files` (Task 2)
- Produces: `class ApduStateMachine(private val onMessage: (ByteArray) -> Unit)` with `fun process(apdu: ByteArray): ByteArray`, `fun setPendingPayload(ndef: ByteArray)`, `fun onDeactivated()`, `val activePayload: ByteArray`. Task 4·5·6이 쓴다.

- [ ] **Step 1: 실패하는 테스트를 쓴다 (iOS CoreNFC가 실제로 보내는 순서)**

```kotlin
// plugins/hce-android/android/src/test/java/app/monti/hce/ApduStateMachineTest.kt
package app.monti.hce

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test

class ApduStateMachineTest {

    private fun bytes(vararg v: Int): ByteArray = ByteArray(v.size) { v[it].toByte() }

    private fun hex(b: ByteArray): String = b.joinToString("") { String.format("%02X", it) }

    /** monti.app:g 외부 타입 레코드 한 개, 페이로드 4바이트. */
    private val payload = bytes(
        0xD4, 0x0B, 0x04, // MB|ME|SR|TNF=4(external), TYPE_LENGTH=11, PAYLOAD_LENGTH=4
        0x6D, 0x6F, 0x6E, 0x74, 0x69, 0x2E, 0x61, 0x70, 0x70, 0x3A, 0x67, // "monti.app:g"
        0x01, 0x02, 0x03, 0x04,
    )

    private fun machine(sink: MutableList<ByteArray> = mutableListOf()): ApduStateMachine {
        val m = ApduStateMachine { sink.add(it) }
        m.setPendingPayload(payload)
        return m
    }

    @Test
    fun selectAidAnswersNineThousandWithNoFci() {
        val m = machine()
        // iOS: 00 A4 04 00 07 D2760000850101 00  (Le 바이트 포함)
        val r = m.process(bytes(0x00, 0xA4, 0x04, 0x00, 0x07, 0xD2, 0x76, 0x00, 0x00, 0x85, 0x01, 0x01, 0x00))
        assertArrayEquals(ApduStatus.SW_OK, r)
        assertEquals("9000", hex(r))
    }

    @Test
    fun theFullIosCoreNfcReadSequenceSucceeds() {
        val m = machine()
        assertArrayEquals(ApduStatus.SW_OK, m.process(bytes(0x00, 0xA4, 0x04, 0x00, 0x07, 0xD2, 0x76, 0x00, 0x00, 0x85, 0x01, 0x01, 0x00)))
        // SELECT CC file E103
        assertArrayEquals(ApduStatus.SW_OK, m.process(bytes(0x00, 0xA4, 0x00, 0x0C, 0x02, 0xE1, 0x03)))
        // READ BINARY CC, 15 bytes
        val cc = m.process(bytes(0x00, 0xB0, 0x00, 0x00, 0x0F))
        assertEquals(17, cc.size)
        assertArrayEquals(Type4Files.capabilityContainer(), cc.copyOfRange(0, 15))
        assertArrayEquals(ApduStatus.SW_OK, cc.copyOfRange(15, 17))
        // SELECT NDEF file E104
        assertArrayEquals(ApduStatus.SW_OK, m.process(bytes(0x00, 0xA4, 0x00, 0x0C, 0x02, 0xE1, 0x04)))
        // READ BINARY NLEN (2 bytes)
        val nlen = m.process(bytes(0x00, 0xB0, 0x00, 0x00, 0x02))
        assertEquals("0012" + "9000", hex(nlen))
        // READ BINARY message (18 bytes at offset 2)
        val msg = m.process(bytes(0x00, 0xB0, 0x00, 0x02, 0x12))
        assertArrayEquals(payload, msg.copyOfRange(0, payload.size))
        assertArrayEquals(ApduStatus.SW_OK, msg.copyOfRange(payload.size, msg.size))
    }

    @Test
    fun readBinaryTruncatesToLeAndNeverOverruns() {
        val m = machine()
        m.process(bytes(0x00, 0xA4, 0x04, 0x00, 0x07, 0xD2, 0x76, 0x00, 0x00, 0x85, 0x01, 0x01, 0x00))
        m.process(bytes(0x00, 0xA4, 0x00, 0x0C, 0x02, 0xE1, 0x04))
        // 파일은 20바이트뿐인데 255를 달라고 한다 → 있는 만큼만 준다
        val r = m.process(bytes(0x00, 0xB0, 0x00, 0x00, 0xFF))
        assertEquals(20 + 2, r.size)
    }

    @Test
    fun readingBeforeSelectingTheApplicationIsRefused() {
        val m = machine()
        assertArrayEquals(ApduStatus.SW_SECURITY, m.process(bytes(0x00, 0xB0, 0x00, 0x00, 0x0F)))
    }

    @Test
    fun readingWithNoFileSelectedIsRefused() {
        val m = machine()
        m.process(bytes(0x00, 0xA4, 0x04, 0x00, 0x07, 0xD2, 0x76, 0x00, 0x00, 0x85, 0x01, 0x01, 0x00))
        assertArrayEquals(ApduStatus.SW_SECURITY, m.process(bytes(0x00, 0xB0, 0x00, 0x00, 0x0F)))
    }

    @Test
    fun selectingAnUnknownFileIsFileNotFound() {
        val m = machine()
        m.process(bytes(0x00, 0xA4, 0x04, 0x00, 0x07, 0xD2, 0x76, 0x00, 0x00, 0x85, 0x01, 0x01, 0x00))
        assertArrayEquals(ApduStatus.SW_FILE_NOT_FOUND, m.process(bytes(0x00, 0xA4, 0x00, 0x0C, 0x02, 0xE1, 0x05)))
    }

    @Test
    fun selectWithWrongP1P2IsRejected() {
        val m = machine()
        m.process(bytes(0x00, 0xA4, 0x04, 0x00, 0x07, 0xD2, 0x76, 0x00, 0x00, 0x85, 0x01, 0x01, 0x00))
        assertArrayEquals(ApduStatus.SW_WRONG_P1P2, m.process(bytes(0x00, 0xA4, 0x02, 0x00, 0x02, 0xE1, 0x04)))
    }

    @Test
    fun readBinaryPastTheEndOfTheFileIsWrongP1P2() {
        val m = machine()
        m.process(bytes(0x00, 0xA4, 0x04, 0x00, 0x07, 0xD2, 0x76, 0x00, 0x00, 0x85, 0x01, 0x01, 0x00))
        m.process(bytes(0x00, 0xA4, 0x00, 0x0C, 0x02, 0xE1, 0x03))
        assertArrayEquals(ApduStatus.SW_WRONG_P1P2, m.process(bytes(0x00, 0xB0, 0x00, 0x40, 0x01)))
    }

    @Test
    fun anUnknownInstructionIsRejectedWithoutCrashing() {
        val m = machine()
        m.process(bytes(0x00, 0xA4, 0x04, 0x00, 0x07, 0xD2, 0x76, 0x00, 0x00, 0x85, 0x01, 0x01, 0x00))
        assertArrayEquals(ApduStatus.SW_INS_NOT_SUPPORTED, m.process(bytes(0x00, 0xCA, 0x00, 0x00, 0x00)))
        // 세션은 살아 있어야 한다: 다음 SELECT 가 계속 동작한다
        assertArrayEquals(ApduStatus.SW_OK, m.process(bytes(0x00, 0xA4, 0x00, 0x0C, 0x02, 0xE1, 0x03)))
    }
}
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

Run: `cd plugins/hce-android/android && ./gradlew test --tests 'app.monti.hce.ApduStateMachineTest'`
Expected: FAIL — `Unresolved reference: ApduStateMachine`, `BUILD FAILED`.

- [ ] **Step 3: 상태 기계를 쓴다 (읽기 경로만)**

```kotlin
// plugins/hce-android/android/src/main/java/app/monti/hce/ApduStateMachine.kt
package app.monti.hce

/**
 * NFC Forum Type 4 Tag 상태 기계.
 *
 * 규칙 세 개가 이 파일의 전부다.
 *  1. SELECT AID 응답은 FCI 없이 9000 두 바이트뿐이다. 아이폰은 FCI가 붙으면 세션을 끊는다(스펙 §11).
 *  2. 파일을 고르기 전에는 아무것도 읽거나 쓸 수 없다(6982).
 *  3. 내보낼 페이로드는 세션 밖에서만 바뀐다(Task 5).
 */
class ApduStateMachine(private val onMessage: (ByteArray) -> Unit) {

    private enum class Selected { NONE, CC, NDEF }

    private val aid = byteArrayOf(
        0xD2.toByte(), 0x76, 0x00, 0x00, 0x85.toByte(), 0x01, 0x01,
    )

    private var appSelected = false
    private var selected = Selected.NONE
    private var pendingPayload: ByteArray = ByteArray(0)

    /** 지금 세션이 읽어 가는 NDEF 메시지. */
    var activePayload: ByteArray = ByteArray(0)
        private set

    /** 리더가 써 넣는 중인 NDEF 파일 버퍼(NLEN 제외한 메시지 영역). */
    private var writeBuffer = ByteArray(Type4Files.MAX_NDEF_SIZE)
    private var writeHighWater = 0
    private var declaredLength = -1

    fun setPendingPayload(ndef: ByteArray) {
        require(ndef.size <= Type4Files.MAX_NDEF_SIZE) { "payload exceeds ${Type4Files.MAX_NDEF_SIZE} bytes" }
        pendingPayload = ndef.copyOf()
        if (!appSelected) promotePendingPayload()
    }

    fun onDeactivated() {
        appSelected = false
        selected = Selected.NONE
        resetWriteState()
        promotePendingPayload()
    }

    private fun promotePendingPayload() {
        activePayload = pendingPayload.copyOf()
    }

    private fun resetWriteState() {
        writeHighWater = 0
        declaredLength = -1
    }

    fun process(apdu: ByteArray): ByteArray {
        if (apdu.size < 4) return ApduStatus.SW_WRONG_LENGTH
        val cla = apdu[0].toInt() and 0xFF
        val ins = apdu[1].toInt() and 0xFF
        if (cla != 0x00) return ApduStatus.SW_CLASS_NOT_SUPPORTED
        return when (ins) {
            0xA4 -> handleSelect(apdu)
            0xB0 -> handleReadBinary(apdu)
            0xD6 -> handleUpdateBinary(apdu)
            else -> ApduStatus.SW_INS_NOT_SUPPORTED
        }
    }

    private fun handleSelect(apdu: ByteArray): ByteArray {
        val p1 = apdu[2].toInt() and 0xFF
        val p2 = apdu[3].toInt() and 0xFF
        val lc = if (apdu.size > 4) apdu[4].toInt() and 0xFF else 0
        if (apdu.size < 5 + lc) return ApduStatus.SW_WRONG_LENGTH
        val data = apdu.copyOfRange(5, 5 + lc)

        // SELECT by name (AID)
        if (p1 == 0x04 && p2 == 0x00) {
            if (!data.contentEquals(aid)) return ApduStatus.SW_FILE_NOT_FOUND
            // 새 세션의 시작. 여기서만 페이로드가 승격된다.
            promotePendingPayload()
            appSelected = true
            selected = Selected.NONE
            resetWriteState()
            return ApduStatus.SW_OK // FCI 없음
        }

        // SELECT by file id
        if (p1 == 0x00 && p2 == 0x0C) {
            if (!appSelected) return ApduStatus.SW_SECURITY
            if (lc != 2) return ApduStatus.SW_WRONG_LENGTH
            return when {
                data.contentEquals(Type4Files.CC_FILE_ID) -> {
                    selected = Selected.CC
                    ApduStatus.SW_OK
                }
                data.contentEquals(Type4Files.NDEF_FILE_ID) -> {
                    selected = Selected.NDEF
                    ApduStatus.SW_OK
                }
                else -> ApduStatus.SW_FILE_NOT_FOUND
            }
        }

        return ApduStatus.SW_WRONG_P1P2
    }

    private fun currentFile(): ByteArray? = when (selected) {
        Selected.CC -> Type4Files.capabilityContainer()
        Selected.NDEF -> Type4Files.ndefFileBytes(activePayload)
        Selected.NONE -> null
    }

    private fun handleReadBinary(apdu: ByteArray): ByteArray {
        if (!appSelected) return ApduStatus.SW_SECURITY
        val file = currentFile() ?: return ApduStatus.SW_SECURITY
        val offset = ((apdu[2].toInt() and 0xFF) shl 8) or (apdu[3].toInt() and 0xFF)
        if (offset > file.size) return ApduStatus.SW_WRONG_P1P2
        var le = if (apdu.size > 4) apdu[4].toInt() and 0xFF else 0
        if (le == 0) le = 256
        val length = minOf(le, file.size - offset)
        val out = ByteArray(length + 2)
        file.copyInto(out, 0, offset, offset + length)
        ApduStatus.SW_OK.copyInto(out, length)
        return out
    }

    private fun handleUpdateBinary(apdu: ByteArray): ByteArray {
        if (!appSelected) return ApduStatus.SW_SECURITY
        if (selected != Selected.NDEF) return ApduStatus.SW_SECURITY
        return ApduStatus.SW_OK
    }
}
```

- [ ] **Step 4: 테스트가 통과하는지 확인**

Run: `cd plugins/hce-android/android && ./gradlew test --tests 'app.monti.hce.ApduStateMachineTest'`
Expected: PASS — `BUILD SUCCESSFUL`, 9 tests, 0 failures.

- [ ] **Step 5: 커밋**

```bash
git add plugins/hce-android/android/src/main/java/app/monti/hce/ApduStateMachine.kt plugins/hce-android/android/src/test/java/app/monti/hce/ApduStateMachineTest.kt
git commit -m "feat(hce): APDU state machine read path with SELECT AID answering 9000 without FCI"
```

---

## Task 4: UPDATE BINARY 수신 — 완성된 메시지에서만 write 이벤트

**Files:**
- Modify: `plugins/hce-android/android/src/main/java/app/monti/hce/ApduStateMachine.kt` (`handleUpdateBinary`)
- Test: `plugins/hce-android/android/src/test/java/app/monti/hce/ApduWriteTest.kt`

**Interfaces:**
- Consumes: `ApduStateMachine.process`, 생성자 콜백 `onMessage: (ByteArray) -> Unit` (Task 3)
- Produces: 완성된 NDEF 메시지 한 개마다 정확히 한 번 호출되는 `onMessage`. Task 6의 `MontiHostApduService`가 이걸 플러그인 `write` 이벤트로 올린다.

- [ ] **Step 1: 실패하는 테스트를 쓴다 (안드로이드 리더 기록 시퀀스 + 분할 쓰기)**

```kotlin
// plugins/hce-android/android/src/test/java/app/monti/hce/ApduWriteTest.kt
package app.monti.hce

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ApduWriteTest {

    private fun bytes(vararg v: Int): ByteArray = ByteArray(v.size) { v[it].toByte() }

    private val selectAidWithLe = bytes(0x00, 0xA4, 0x04, 0x00, 0x07, 0xD2, 0x76, 0x00, 0x00, 0x85, 0x01, 0x01, 0x00)
    private val selectAidNoLe = bytes(0x00, 0xA4, 0x04, 0x00, 0x07, 0xD2, 0x76, 0x00, 0x00, 0x85, 0x01, 0x01)
    private val selectNdef = bytes(0x00, 0xA4, 0x00, 0x0C, 0x02, 0xE1, 0x04)

    /** monti.app:s 외부 타입 레코드, 페이로드 3바이트 → 전체 17바이트. */
    private val response = bytes(
        0xD4, 0x0B, 0x03,
        0x6D, 0x6F, 0x6E, 0x74, 0x69, 0x2E, 0x61, 0x70, 0x70, 0x3A, 0x73,
        0xAA, 0xBB, 0xCC,
    )

    private fun updateBinary(offset: Int, data: ByteArray): ByteArray {
        val head = bytes(0x00, 0xD6, (offset shr 8) and 0xFF, offset and 0xFF, data.size)
        return head + data
    }

    @Test
    fun theIosThreeStepWriteEmitsExactlyOneMessage() {
        val got = mutableListOf<ByteArray>()
        val m = ApduStateMachine { got.add(it) }
        m.process(selectAidWithLe)
        m.process(selectNdef)
        // 1) NLEN = 0000
        assertArrayEquals(ApduStatus.SW_OK, m.process(updateBinary(0, bytes(0x00, 0x00))))
        assertTrue(got.isEmpty())
        // 2) 데이터
        assertArrayEquals(ApduStatus.SW_OK, m.process(updateBinary(2, response)))
        assertTrue(got.isEmpty())
        // 3) NLEN = 0011 (17)
        assertArrayEquals(ApduStatus.SW_OK, m.process(updateBinary(0, bytes(0x00, 0x11))))
        assertEquals(1, got.size)
        assertArrayEquals(response, got[0])
    }

    @Test
    fun theAndroidReaderSingleShotWriteEmitsOneMessage() {
        val got = mutableListOf<ByteArray>()
        val m = ApduStateMachine { got.add(it) }
        // 안드로이드 리더는 Le 바이트 없이 SELECT AID 를 보낸다
        assertArrayEquals(ApduStatus.SW_OK, m.process(selectAidNoLe))
        m.process(selectNdef)
        // NLEN + 메시지를 한 번에
        val combined = bytes(0x00, 0x11) + response
        assertArrayEquals(ApduStatus.SW_OK, m.process(updateBinary(0, combined)))
        assertEquals(1, got.size)
        assertArrayEquals(response, got[0])
    }

    @Test
    fun chunkedDataIsReassembledBeforeEmitting() {
        val got = mutableListOf<ByteArray>()
        val m = ApduStateMachine { got.add(it) }
        m.process(selectAidWithLe)
        m.process(selectNdef)
        m.process(updateBinary(0, bytes(0x00, 0x00)))
        m.process(updateBinary(2, response.copyOfRange(0, 9)))
        m.process(updateBinary(11, response.copyOfRange(9, 17)))
        assertTrue(got.isEmpty())
        m.process(updateBinary(0, bytes(0x00, 0x11)))
        assertEquals(1, got.size)
        assertArrayEquals(response, got[0])
    }

    @Test
    fun aTruncatedWriteNeverEmits() {
        val got = mutableListOf<ByteArray>()
        val m = ApduStateMachine { got.add(it) }
        m.process(selectAidWithLe)
        m.process(selectNdef)
        m.process(updateBinary(0, bytes(0x00, 0x00)))
        m.process(updateBinary(2, response.copyOfRange(0, 9)))
        // 리더가 사라졌다
        m.onDeactivated()
        assertTrue(got.isEmpty())
    }

    @Test
    fun writingBeforeSelectingTheNdefFileIsRefused() {
        val m = ApduStateMachine { }
        m.process(selectAidWithLe)
        assertArrayEquals(ApduStatus.SW_SECURITY, m.process(updateBinary(0, bytes(0x00, 0x00))))
    }

    @Test
    fun writingPastTheMaxSizeIsWrongP1P2() {
        val m = ApduStateMachine { }
        m.process(selectAidWithLe)
        m.process(selectNdef)
        assertArrayEquals(ApduStatus.SW_WRONG_P1P2, m.process(updateBinary(2100, bytes(0x01))))
    }

    @Test
    fun aDeclaredLengthLargerThanTheMaxSizeIsRejected() {
        val m = ApduStateMachine { }
        m.process(selectAidWithLe)
        m.process(selectNdef)
        assertArrayEquals(ApduStatus.SW_WRONG_P1P2, m.process(updateBinary(0, bytes(0x0F, 0xFF))))
    }

    @Test
    fun twoConsecutiveWritesInOneSessionEmitTwice() {
        val got = mutableListOf<ByteArray>()
        val m = ApduStateMachine { got.add(it) }
        m.process(selectAidWithLe)
        m.process(selectNdef)
        m.process(updateBinary(0, bytes(0x00, 0x00)))
        m.process(updateBinary(2, response))
        m.process(updateBinary(0, bytes(0x00, 0x11)))
        m.process(updateBinary(0, bytes(0x00, 0x00)))
        m.process(updateBinary(2, response))
        m.process(updateBinary(0, bytes(0x00, 0x11)))
        assertEquals(2, got.size)
    }
}
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

Run: `cd plugins/hce-android/android && ./gradlew test --tests 'app.monti.hce.ApduWriteTest'`
Expected: FAIL — `theIosThreeStepWriteEmitsExactlyOneMessage` 에서 `expected:<1> but was:<0>`.

- [ ] **Step 3: `handleUpdateBinary` 를 구현으로 바꾼다**

```kotlin
    private fun handleUpdateBinary(apdu: ByteArray): ByteArray {
        if (!appSelected) return ApduStatus.SW_SECURITY
        if (selected != Selected.NDEF) return ApduStatus.SW_SECURITY
        val offset = ((apdu[2].toInt() and 0xFF) shl 8) or (apdu[3].toInt() and 0xFF)
        val lc = if (apdu.size > 4) apdu[4].toInt() and 0xFF else 0
        if (apdu.size < 5 + lc) return ApduStatus.SW_WRONG_LENGTH
        val data = apdu.copyOfRange(5, 5 + lc)

        if (offset == 0) {
            if (lc < 2) return ApduStatus.SW_WRONG_LENGTH
            val declared = ((data[0].toInt() and 0xFF) shl 8) or (data[1].toInt() and 0xFF)
            if (declared > Type4Files.MAX_NDEF_SIZE) return ApduStatus.SW_WRONG_P1P2
            if (lc > 2) {
                // 안드로이드 리더의 단발 쓰기: NLEN 과 본문이 한 APDU 안에 있다
                val body = data.copyOfRange(2, lc)
                if (body.size > Type4Files.MAX_NDEF_SIZE) return ApduStatus.SW_WRONG_P1P2
                body.copyInto(writeBuffer, 0)
                writeHighWater = maxOf(writeHighWater, body.size)
            }
            declaredLength = declared
            if (declared == 0) {
                // 아이폰의 1단계: 파일을 비우고 본문을 기다린다
                writeHighWater = 0
                return ApduStatus.SW_OK
            }
            if (writeHighWater >= declared) {
                emitAndReset(declared)
            }
            return ApduStatus.SW_OK
        }

        val bodyOffset = offset - 2
        if (bodyOffset < 0 || bodyOffset + lc > Type4Files.MAX_NDEF_SIZE) return ApduStatus.SW_WRONG_P1P2
        data.copyInto(writeBuffer, bodyOffset)
        writeHighWater = maxOf(writeHighWater, bodyOffset + lc)
        if (declaredLength > 0 && writeHighWater >= declaredLength) {
            emitAndReset(declaredLength)
        }
        return ApduStatus.SW_OK
    }

    private fun emitAndReset(length: Int) {
        val message = writeBuffer.copyOfRange(0, length)
        resetWriteState()
        onMessage(message)
    }
```

`ApduStateMachine.kt` 안의 기존 `handleUpdateBinary` 세 줄짜리 스텁을 위 두 함수로 교체한다.

- [ ] **Step 4: 테스트가 통과하는지 확인**

Run: `cd plugins/hce-android/android && ./gradlew test --tests 'app.monti.hce.ApduWriteTest'`
Expected: PASS — `BUILD SUCCESSFUL`, 8 tests, 0 failures.

- [ ] **Step 5: 읽기 테스트가 여전히 통과하는지 확인**

Run: `cd plugins/hce-android/android && ./gradlew test`
Expected: PASS — `BUILD SUCCESSFUL`, 23 tests total, 0 failures.

- [ ] **Step 6: 커밋**

```bash
git add plugins/hce-android/android/src/main/java/app/monti/hce/ApduStateMachine.kt plugins/hce-android/android/src/test/java/app/monti/hce/ApduWriteTest.kt
git commit -m "feat(hce): accept UPDATE BINARY and emit a write event only on a complete NDEF message"
```

---

## Task 5: 페이로드 교체는 탭과 탭 사이에만

**Files:**
- Test: `plugins/hce-android/android/src/test/java/app/monti/hce/PayloadSwapTest.kt`
- Modify: `plugins/hce-android/android/src/main/java/app/monti/hce/ApduStateMachine.kt` (필요 시)

**Interfaces:**
- Consumes: `ApduStateMachine.setPendingPayload`, `onDeactivated`, `activePayload` (Task 3)
- Produces: 불변식 — "세션 중 `setPendingPayload` 는 지금 읽히는 바이트를 절대 바꾸지 않는다". Task 18의 3초 회전 루프가 이 보장 위에 서 있다.

- [ ] **Step 1: 실패할 수 있는 테스트를 쓴다**

```kotlin
// plugins/hce-android/android/src/test/java/app/monti/hce/PayloadSwapTest.kt
package app.monti.hce

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test

class PayloadSwapTest {

    private fun bytes(vararg v: Int): ByteArray = ByteArray(v.size) { v[it].toByte() }

    private val selectAid = bytes(0x00, 0xA4, 0x04, 0x00, 0x07, 0xD2, 0x76, 0x00, 0x00, 0x85, 0x01, 0x01, 0x00)
    private val selectNdef = bytes(0x00, 0xA4, 0x00, 0x0C, 0x02, 0xE1, 0x04)

    private fun record(tag: Int): ByteArray = bytes(
        0xD4, 0x0B, 0x01,
        0x6D, 0x6F, 0x6E, 0x74, 0x69, 0x2E, 0x61, 0x70, 0x70, 0x3A, 0x67,
        tag,
    )

    private fun readMessage(m: ApduStateMachine): ByteArray {
        m.process(selectNdef)
        val nlen = m.process(bytes(0x00, 0xB0, 0x00, 0x00, 0x02))
        val len = ((nlen[0].toInt() and 0xFF) shl 8) or (nlen[1].toInt() and 0xFF)
        val body = m.process(bytes(0x00, 0xB0, 0x00, 0x02, len))
        return body.copyOfRange(0, len)
    }

    @Test
    fun aPayloadSetMidSessionIsNotVisibleUntilTheNextSession() {
        val m = ApduStateMachine { }
        m.setPendingPayload(record(0xA1))
        m.process(selectAid)
        assertArrayEquals(record(0xA1), readMessage(m))

        // 회전 타이머가 세션 한가운데서 새 코드를 넣는다
        m.setPendingPayload(record(0xB2))
        assertArrayEquals(record(0xA1), readMessage(m))
        assertArrayEquals(record(0xA1), m.activePayload)
    }

    @Test
    fun deactivationPromotesThePendingPayload() {
        val m = ApduStateMachine { }
        m.setPendingPayload(record(0xA1))
        m.process(selectAid)
        m.setPendingPayload(record(0xB2))
        m.onDeactivated()
        assertArrayEquals(record(0xB2), m.activePayload)
    }

    @Test
    fun aNewSelectAidPromotesThePendingPayloadEvenWithoutDeactivation() {
        val m = ApduStateMachine { }
        m.setPendingPayload(record(0xA1))
        m.process(selectAid)
        m.setPendingPayload(record(0xB2))
        // 아이폰이 세션을 끊었다는 콜백 없이 다시 붙은 경우
        m.process(selectAid)
        assertArrayEquals(record(0xB2), readMessage(m))
    }

    @Test
    fun rotatingWhileIdlePromotesImmediately() {
        val m = ApduStateMachine { }
        m.setPendingPayload(record(0xA1))
        assertArrayEquals(record(0xA1), m.activePayload)
        m.setPendingPayload(record(0xB2))
        assertArrayEquals(record(0xB2), m.activePayload)
    }

    @Test
    fun settingAPayloadDoesNotAliasTheCallersArray() {
        val m = ApduStateMachine { }
        val mutable = record(0xA1)
        m.setPendingPayload(mutable)
        mutable[14] = 0xFF.toByte()   // 레코드는 15바이트, 마지막 인덱스가 페이로드다
        assertEquals(0xA1, m.activePayload[14].toInt() and 0xFF)
    }

    @Test
    fun anOversizedPayloadIsRejectedLoudly() {
        val m = ApduStateMachine { }
        var threw = false
        try {
            m.setPendingPayload(ByteArray(Type4Files.MAX_NDEF_SIZE + 1))
        } catch (e: IllegalArgumentException) {
            threw = true
        }
        assertEquals(true, threw)
    }
}
```

- [ ] **Step 2: 테스트를 돌린다**

Run: `cd plugins/hce-android/android && ./gradlew test --tests 'app.monti.hce.PayloadSwapTest'`
Expected: PASS — Task 3의 `promotePendingPayload` 호출 위치가 이미 옳다면 `BUILD SUCCESSFUL`, 6 tests. FAIL 이 나오면 Step 3으로 간다.

- [ ] **Step 3: 실패한 경우에만 — 승격 지점을 고친다**

승격은 정확히 세 곳에서만 일어난다. `ApduStateMachine.kt` 가 아래와 같은지 확인하고 다르면 맞춘다.

```kotlin
    fun setPendingPayload(ndef: ByteArray) {
        require(ndef.size <= Type4Files.MAX_NDEF_SIZE) { "payload exceeds ${Type4Files.MAX_NDEF_SIZE} bytes" }
        pendingPayload = ndef.copyOf()          // 호출자 배열을 별칭으로 잡지 않는다
        if (!appSelected) promotePendingPayload() // 유휴 상태면 즉시
    }
```

`handleSelect` 의 AID 분기 첫 줄이 `promotePendingPayload()` 이고, `onDeactivated()` 의 마지막 줄이 `promotePendingPayload()` 여야 한다. 그 외 어디에서도 `activePayload` 를 쓰지 않는다.

- [ ] **Step 4: 전체 유닛 테스트를 돌린다**

Run: `cd plugins/hce-android/android && ./gradlew test`
Expected: PASS — `BUILD SUCCESSFUL`, 29 tests total, 0 failures.

- [ ] **Step 5: 커밋**

```bash
git add plugins/hce-android/android/src/test/java/app/monti/hce/PayloadSwapTest.kt plugins/hce-android/android/src/main/java/app/monti/hce/ApduStateMachine.kt
git commit -m "test(hce): pin the invariant that the gate code swaps only between taps"
```

---

## Task 6: HostApduService 등록 — 매니페스트, apduservice.xml, 서비스 클래스

**Files:**
- Create: `plugins/hce-android/android/src/main/AndroidManifest.xml`, `.../res/xml/monti_apduservice.xml`, `.../res/values/strings.xml`, `.../java/app/monti/hce/HceBridge.kt`, `.../java/app/monti/hce/MontiHostApduService.kt`
- Test: `plugins/hce-android/android/src/test/java/app/monti/hce/ApduServiceManifestTest.kt`

**Interfaces:**
- Consumes: `ApduStateMachine` (Task 3·4)
- Produces: `object HceBridge` — `val machine: ApduStateMachine`, `var onWrite: ((ByteArray) -> Unit)?`, `fun setPayload(ndef: ByteArray)`, `fun reset()`. Task 7의 `HcePlugin` 이 유일한 소비자다.

- [ ] **Step 1: 매니페스트 계약을 검사하는 실패 테스트를 쓴다**

```kotlin
// plugins/hce-android/android/src/test/java/app/monti/hce/ApduServiceManifestTest.kt
package app.monti.hce

import java.io.File
import org.junit.Assert.assertTrue
import org.junit.Test

class ApduServiceManifestTest {

    private fun read(path: String): String = File(path).readText()

    @Test
    fun apduServiceDeclaresTheMontiAidInTheOtherCategory() {
        val xml = read("src/main/res/xml/monti_apduservice.xml").replace("\\s+".toRegex(), " ")
        assertTrue(xml.contains("android:category=\"other\""))
        assertTrue(xml.contains("android:name=\"D2760000850101\""))
        assertTrue(xml.contains("android:requireDeviceUnlock=\"false\""))
    }

    @Test
    fun apduServiceIsNotRegisteredForPayment() {
        val xml = read("src/main/res/xml/monti_apduservice.xml")
        assertTrue(!xml.contains("category=\"payment\""))
    }

    @Test
    fun manifestBindsTheServiceWithTheNfcPermission() {
        val xml = read("src/main/AndroidManifest.xml").replace("\\s+".toRegex(), " ")
        assertTrue(xml.contains("app.monti.hce.MontiHostApduService"))
        assertTrue(xml.contains("android:permission=\"android.permission.BIND_NFC_SERVICE\""))
        assertTrue(xml.contains("android.nfc.cardemulation.action.HOST_APDU_SERVICE"))
        assertTrue(xml.contains("android:resource=\"@xml/monti_apduservice\""))
    }

    @Test
    fun noReaderModeApiAppearsAnywhereInThePlugin() {
        val offenders = File("src/main").walkTopDown()
            .filter { it.isFile && (it.extension == "kt" || it.extension == "xml") }
            .filter { it.readText().contains("enableReaderMode") || it.readText().contains("enableForegroundDispatch") }
            .map { it.path }
            .toList()
        assertTrue("reader mode API found in $offenders", offenders.isEmpty())
    }
}
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

Run: `cd plugins/hce-android/android && ./gradlew test --tests 'app.monti.hce.ApduServiceManifestTest'`
Expected: FAIL — `java.io.FileNotFoundException: src/main/res/xml/monti_apduservice.xml`.

- [ ] **Step 3: 리소스와 매니페스트를 쓴다**

```xml
<!-- plugins/hce-android/android/src/main/res/xml/monti_apduservice.xml -->
<host-apdu-service xmlns:android="http://schemas.android.com/apk/res/android"
    android:description="@string/monti_hce_description"
    android:requireDeviceUnlock="false">
    <aid-group
        android:description="@string/monti_hce_aid_group"
        android:category="other">
        <aid-filter android:name="D2760000850101" />
    </aid-group>
</host-apdu-service>
```

```xml
<!-- plugins/hce-android/android/src/main/res/values/strings.xml -->
<resources>
    <string name="monti_hce_description">MONTI gate</string>
    <string name="monti_hce_aid_group">MONTI gate code</string>
</resources>
```

```xml
<!-- plugins/hce-android/android/src/main/AndroidManifest.xml -->
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <uses-permission android:name="android.permission.NFC" />
    <uses-feature android:name="android.hardware.nfc.hce" android:required="true" />
    <application>
        <service
            android:name="app.monti.hce.MontiHostApduService"
            android:exported="true"
            android:permission="android.permission.BIND_NFC_SERVICE">
            <intent-filter>
                <action android:name="android.nfc.cardemulation.action.HOST_APDU_SERVICE" />
            </intent-filter>
            <meta-data
                android:name="android.nfc.cardemulation.host_apdu_service"
                android:resource="@xml/monti_apduservice" />
        </service>
    </application>
</manifest>
```

- [ ] **Step 4: 브리지와 서비스를 쓴다**

```kotlin
// plugins/hce-android/android/src/main/java/app/monti/hce/HceBridge.kt
package app.monti.hce

/**
 * HostApduService 는 OS 가 만들고 파괴한다. 플러그인 인스턴스와 수명이 다르므로
 * 상태 기계는 프로세스 싱글턴에 둔다. 이 객체가 둘 사이의 유일한 접점이다.
 */
object HceBridge {

    @Volatile
    var onWrite: ((ByteArray) -> Unit)? = null

    val machine: ApduStateMachine = ApduStateMachine { message ->
        onWrite?.invoke(message)
    }

    fun setPayload(ndef: ByteArray) = machine.setPendingPayload(ndef)

    fun reset() {
        machine.setPendingPayload(ByteArray(0))
        machine.onDeactivated()
    }
}
```

```kotlin
// plugins/hce-android/android/src/main/java/app/monti/hce/MontiHostApduService.kt
package app.monti.hce

import android.nfc.cardemulation.HostApduService
import android.os.Bundle

class MontiHostApduService : HostApduService() {

    override fun processCommandApdu(commandApdu: ByteArray?, extras: Bundle?): ByteArray {
        val apdu = commandApdu ?: return ApduStatus.SW_WRONG_LENGTH
        return HceBridge.machine.process(apdu)
    }

    override fun onDeactivated(reason: Int) {
        HceBridge.machine.onDeactivated()
    }
}
```

- [ ] **Step 5: 테스트가 통과하는지 확인**

Run: `cd plugins/hce-android/android && ./gradlew test`
Expected: PASS — `BUILD SUCCESSFUL`, 33 tests total, 0 failures.

- [ ] **Step 6: 커밋**

```bash
git add plugins/hce-android/android/src/main plugins/hce-android/android/src/test/java/app/monti/hce/ApduServiceManifestTest.kt
git commit -m "feat(hce): register MontiHostApduService with AID D2760000850101 in category other"
```

---

## Task 7: Capacitor 플러그인 클래스 — start / setPayload / stop / write 이벤트

**Files:**
- Create: `plugins/hce-android/android/src/main/java/app/monti/hce/HcePlugin.kt`
- Test: `plugins/hce-android/android/src/test/java/app/monti/hce/HceBridgeTest.kt`

**Interfaces:**
- Consumes: `HceBridge` (Task 6), `HcePlugin` TS 정의 (Task 1)
- Produces: JS 에서 보이는 `Hce` 구현체. `start` 는 `CardEmulation.setPreferredService` 로 다른 HCE 앱(예: 지갑 앱)이 같은 AID 를 가로채지 못하게 막고, `stop` 은 해제한다. `write` 이벤트 페이로드는 `{ ndef: <base64 NO_WRAP 아님, 표준 패딩> }`.

- [ ] **Step 1: 브리지 계약 테스트를 쓴다**

```kotlin
// plugins/hce-android/android/src/test/java/app/monti/hce/HceBridgeTest.kt
package app.monti.hce

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class HceBridgeTest {

    private fun bytes(vararg v: Int): ByteArray = ByteArray(v.size) { v[it].toByte() }

    private val selectAid = bytes(0x00, 0xA4, 0x04, 0x00, 0x07, 0xD2, 0x76, 0x00, 0x00, 0x85, 0x01, 0x01, 0x00)
    private val selectNdef = bytes(0x00, 0xA4, 0x00, 0x0C, 0x02, 0xE1, 0x04)

    @Test
    fun aWrittenMessageReachesTheRegisteredListener() {
        val seen = mutableListOf<ByteArray>()
        HceBridge.reset()
        HceBridge.onWrite = { seen.add(it) }
        HceBridge.setPayload(bytes(0xD4, 0x0B, 0x01, 0x6D, 0x6F, 0x6E, 0x74, 0x69, 0x2E, 0x61, 0x70, 0x70, 0x3A, 0x67, 0x01))
        HceBridge.machine.process(selectAid)
        HceBridge.machine.process(selectNdef)
        HceBridge.machine.process(bytes(0x00, 0xD6, 0x00, 0x00, 0x02, 0x00, 0x00))
        HceBridge.machine.process(bytes(0x00, 0xD6, 0x00, 0x02, 0x03, 0x11, 0x22, 0x33))
        HceBridge.machine.process(bytes(0x00, 0xD6, 0x00, 0x00, 0x02, 0x00, 0x03))
        assertEquals(1, seen.size)
        assertArrayEquals(bytes(0x11, 0x22, 0x33), seen[0])
        HceBridge.onWrite = null
    }

    @Test
    fun resetClearsThePayloadSoAStoppedGateEmitsNothing() {
        HceBridge.setPayload(bytes(0xD4, 0x01, 0x00, 0x67))
        HceBridge.reset()
        assertEquals(0, HceBridge.machine.activePayload.size)
    }

    @Test
    fun withNoListenerAWriteIsDroppedWithoutThrowing() {
        HceBridge.reset()
        HceBridge.onWrite = null
        HceBridge.machine.process(selectAid)
        HceBridge.machine.process(selectNdef)
        HceBridge.machine.process(bytes(0x00, 0xD6, 0x00, 0x00, 0x03, 0x00, 0x01, 0x42))
        assertNull(HceBridge.onWrite)
    }
}
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

Run: `cd plugins/hce-android/android && ./gradlew test --tests 'app.monti.hce.HceBridgeTest'`
Expected: PASS (브리지는 Task 6에서 이미 만들었다). FAIL 이면 `HceBridge.reset()` 이 `activePayload` 를 비우지 않는 것이므로 Task 6 Step 4의 `reset()` 을 위 코드대로 맞춘다.

- [ ] **Step 3: 플러그인 클래스를 쓴다**

```kotlin
// plugins/hce-android/android/src/main/java/app/monti/hce/HcePlugin.kt
package app.monti.hce

import android.content.ComponentName
import android.nfc.NfcAdapter
import android.nfc.cardemulation.CardEmulation
import android.util.Base64
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

@CapacitorPlugin(name = "Hce")
class HcePlugin : Plugin() {

    private val serviceComponent: ComponentName
        get() = ComponentName(context, MontiHostApduService::class.java)

    private var started = false

    @PluginMethod
    fun start(call: PluginCall) {
        val aid = call.getString("aid")
        if (aid == null || !aid.equals(REGISTERED_AID, ignoreCase = true)) {
            call.reject("aid must be $REGISTERED_AID; it is fixed in the manifest")
            return
        }
        val adapter = NfcAdapter.getDefaultAdapter(context)
        if (adapter == null) {
            call.reject("this device has no NFC adapter")
            return
        }
        if (!adapter.isEnabled) {
            call.reject("NFC is turned off")
            return
        }
        HceBridge.onWrite = { message ->
            val payload = JSObject()
            payload.put("ndef", Base64.encodeToString(message, Base64.NO_WRAP))
            notifyListeners("write", payload)
        }
        val emulation = CardEmulation.getInstance(adapter)
        activity?.let { emulation.setPreferredService(it, serviceComponent) }
        started = true
        call.resolve()
    }

    @PluginMethod
    fun setPayload(call: PluginCall) {
        if (!started) {
            call.reject("call start() before setPayload()")
            return
        }
        val ndef = call.getString("ndef")
        if (ndef == null) {
            call.reject("ndef is required")
            return
        }
        try {
            HceBridge.setPayload(Base64.decode(ndef, Base64.DEFAULT))
            call.resolve()
        } catch (e: IllegalArgumentException) {
            call.reject("ndef is not valid base64 or is too large: ${e.message}")
        }
    }

    @PluginMethod
    fun stop(call: PluginCall) {
        val adapter = NfcAdapter.getDefaultAdapter(context)
        if (adapter != null) {
            val emulation = CardEmulation.getInstance(adapter)
            activity?.let { emulation.unsetPreferredService(it) }
        }
        HceBridge.onWrite = null
        HceBridge.reset()
        started = false
        call.resolve()
    }

    companion object {
        const val REGISTERED_AID = "D2760000850101"
    }
}
```

- [ ] **Step 4: 컴파일과 전체 테스트를 확인**

Run: `cd plugins/hce-android/android && ./gradlew test`
Expected: PASS — `BUILD SUCCESSFUL`, 36 tests total, 0 failures.

- [ ] **Step 5: TS 빌드를 확인**

Run: `pnpm --filter @monti/hce-android run build`
Expected: 종료 코드 0, `plugins/hce-android/dist/esm/index.d.ts` 생성.

- [ ] **Step 6: 커밋**

```bash
git add plugins/hce-android
git commit -m "feat(hce): Capacitor plugin bridge with preferred-service claim and base64 write events"
```

---

## Task 8: 대안 — `@capawesome-team/capacitor-nfc` HCE (스파이크 S1c 실패 시에만)

> **이 태스크는 조건부다.** 마스터 플랜 Task 0.3(스파이크 S1c)이 "이틀 안에 자체 Kotlin HCE 플러그인 동작"에 **실패했을 때만** 실행한다. 성공했다면 Task 1~7이 정답이고 이 태스크는 건너뛴다. 스펙 §8.1 표와 §16 S1c.

**Files:**
- Create: `apps/web/src/staff/gate/hceAdapter.ts`
- Test: `apps/web/src/staff/gate/hceAdapter.test.ts`
- Modify: `apps/web/package.json`

**Interfaces:**
- Consumes: Task 1의 `HcePlugin` 타입
- Produces: `hce: HcePlugin` — Task 18이 `@monti/hce-android` 대신 import 하는 단일 어댑터. 어느 구현을 쓰든 호출부는 바뀌지 않는다.

- [ ] **Step 1: 어댑터 계약 테스트를 쓴다**

```ts
// apps/web/src/staff/gate/hceAdapter.test.ts
import { describe, expect, it, vi } from 'vitest';

const calls: Array<[string, unknown]> = [];
vi.mock('@capawesome-team/capacitor-nfc', () => ({
  Nfc: {
    startHostCardEmulation: (o: unknown) => { calls.push(['start', o]); return Promise.resolve(); },
    setHostCardEmulationNdefMessage: (o: unknown) => { calls.push(['payload', o]); return Promise.resolve(); },
    stopHostCardEmulation: () => { calls.push(['stop', null]); return Promise.resolve(); },
    addListener: (n: string, f: unknown) => { calls.push(['listen', n]); return Promise.resolve({ remove: async () => {} }); },
  },
}));

describe('capawesome HCE adapter', () => {
  it('maps the MONTI plugin surface onto the vendor API', async () => {
    const { hce } = await import('./hceAdapter');
    await hce.start({ aid: 'D2760000850101' });
    await hce.setPayload({ ndef: 'AQID' });
    await hce.addListener('write', () => {});
    await hce.stop();
    expect(calls.map((c) => c[0])).toEqual(['start', 'payload', 'listen', 'stop']);
    expect(calls[0][1]).toEqual({ aid: 'D2760000850101' });
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm vitest run apps/web/src/staff/gate/hceAdapter.test.ts`
Expected: FAIL — `Cannot find module './hceAdapter'`.

- [ ] **Step 3: 의존성을 넣고 어댑터를 쓴다**

```bash
pnpm --filter @monti/web add @capawesome-team/capacitor-nfc
```

```ts
// apps/web/src/staff/gate/hceAdapter.ts
import { Nfc } from '@capawesome-team/capacitor-nfc';
import type { PluginListenerHandle } from '@capacitor/core';

import type { HcePlugin, HceSetPayloadOptions, HceStartOptions, HceWriteEvent } from '@monti/hce-android';

/**
 * S1c 가 실패했을 때만 쓰는 유료 대체 경로(월 $99, 독점 라이선스).
 * 호출부(Task 18)는 이 파일 이름만 바꿔 끼운다.
 */
export const hce: HcePlugin = {
  async start(options: HceStartOptions): Promise<void> {
    await Nfc.startHostCardEmulation({ aid: options.aid });
  },
  async setPayload(options: HceSetPayloadOptions): Promise<void> {
    await Nfc.setHostCardEmulationNdefMessage({ ndef: options.ndef });
  },
  async stop(): Promise<void> {
    await Nfc.stopHostCardEmulation();
  },
  async addListener(
    eventName: 'write',
    listenerFunc: (event: HceWriteEvent) => void,
  ): Promise<PluginListenerHandle> {
    return Nfc.addListener('hostCardEmulationNdefMessageReceived', (e: { ndef: string }) =>
      listenerFunc({ ndef: e.ndef }),
    ) as unknown as Promise<PluginListenerHandle>;
  },
  async removeAllListeners(): Promise<void> {
    await Nfc.removeAllListeners();
  },
};
```

- [ ] **Step 4: 통과 확인**

Run: `pnpm vitest run apps/web/src/staff/gate/hceAdapter.test.ts`
Expected: PASS — 1 passed.

- [ ] **Step 5: 커밋**

```bash
git add apps/web/src/staff/gate/hceAdapter.ts apps/web/src/staff/gate/hceAdapter.test.ts apps/web/package.json pnpm-lock.yaml
git commit -m "feat(staff): vendor HCE adapter used only if spike S1c fails"
```

---

## Task 9: NDEF external record 인코더·디코더

**Files:**
- Create: `apps/web/src/shared/nfc/ndef.ts`
- Test: `apps/web/src/shared/nfc/ndef.test.ts`

**Interfaces:**
- Consumes: 없음
- Produces: `encodeExternalRecord(type: string, payload: Uint8Array): Uint8Array`, `decodeExternalRecord(message: Uint8Array): { type: string; payload: Uint8Array }`, `NdefDecodeError`. Task 16(코드 송출)·Task 20(응답 수신)이 쓴다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

```ts
// apps/web/src/shared/nfc/ndef.test.ts
import { describe, expect, it } from 'vitest';

import { decodeExternalRecord, encodeExternalRecord, NdefDecodeError } from './ndef';

describe('NDEF external type records', () => {
  it('encodes a short record with MB|ME|SR and TNF 4', () => {
    const out = encodeExternalRecord('monti.app:g', new Uint8Array([1, 2, 3]));
    expect(out[0]).toBe(0xd4);
    expect(out[1]).toBe(11);
    expect(out[2]).toBe(3);
    expect(new TextDecoder().decode(out.slice(3, 14))).toBe('monti.app:g');
    expect([...out.slice(14)]).toEqual([1, 2, 3]);
  });

  it('switches to a long record above 255 payload bytes', () => {
    const out = encodeExternalRecord('monti.app:s', new Uint8Array(300));
    expect(out[0]).toBe(0xc4);
    expect([...out.slice(2, 6)]).toEqual([0, 0, 1, 44]);
    expect(out.length).toBe(1 + 1 + 4 + 11 + 300);
  });

  it('round-trips', () => {
    const payload = new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd]);
    const decoded = decodeExternalRecord(encodeExternalRecord('monti.app:s', payload));
    expect(decoded.type).toBe('monti.app:s');
    expect([...decoded.payload]).toEqual([...payload]);
  });

  it('refuses a record that is not an external type', () => {
    const wellKnown = new Uint8Array([0xd1, 0x01, 0x01, 0x54, 0x41]);
    expect(() => decodeExternalRecord(wellKnown)).toThrow(NdefDecodeError);
  });

  it('refuses a truncated record', () => {
    const good = encodeExternalRecord('monti.app:g', new Uint8Array([1, 2, 3]));
    expect(() => decodeExternalRecord(good.slice(0, good.length - 1))).toThrow(NdefDecodeError);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm vitest run apps/web/src/shared/nfc/ndef.test.ts`
Expected: FAIL — `Cannot find module './ndef'`.

- [ ] **Step 3: 구현을 쓴다**

```ts
// apps/web/src/shared/nfc/ndef.ts

/** NDEF 디코딩 실패. 게이트는 이 예외를 "잘못된 태그"로만 취급하고 판정에 쓰지 않는다. */
export class NdefDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NdefDecodeError';
  }
}

const TNF_EXTERNAL = 0x04;

/** 단일 레코드 메시지를 만든다. MB|ME 가 서고, 255바이트 이하면 SR 을 쓴다. */
export function encodeExternalRecord(type: string, payload: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  if (typeBytes.length > 255) throw new NdefDecodeError('external type name too long');
  const short = payload.length < 256;
  const header = 0xc0 | (short ? 0x10 : 0x00) | TNF_EXTERNAL; // MB=1 ME=1 CF=0 SR IL=0 TNF=4
  const lengthBytes = short
    ? new Uint8Array([payload.length])
    : new Uint8Array([
        (payload.length >>> 24) & 0xff,
        (payload.length >>> 16) & 0xff,
        (payload.length >>> 8) & 0xff,
        payload.length & 0xff,
      ]);
  const out = new Uint8Array(1 + 1 + lengthBytes.length + typeBytes.length + payload.length);
  let i = 0;
  out[i++] = header;
  out[i++] = typeBytes.length;
  out.set(lengthBytes, i);
  i += lengthBytes.length;
  out.set(typeBytes, i);
  i += typeBytes.length;
  out.set(payload, i);
  return out;
}

export function decodeExternalRecord(message: Uint8Array): { type: string; payload: Uint8Array } {
  if (message.length < 3) throw new NdefDecodeError('message shorter than a record header');
  const header = message[0];
  if ((header & 0x07) !== TNF_EXTERNAL) throw new NdefDecodeError('not an external type record');
  if ((header & 0x20) !== 0) throw new NdefDecodeError('chunked records are not supported'); // CF
  if ((header & 0x08) !== 0) throw new NdefDecodeError('ID field is not supported'); // IL
  const short = (header & 0x10) !== 0; // SR
  let i = 1;
  const typeLength = message[i++];
  let payloadLength: number;
  if (short) {
    payloadLength = message[i++];
  } else {
    if (message.length < i + 4) throw new NdefDecodeError('truncated long record length');
    payloadLength = (message[i] << 24) | (message[i + 1] << 16) | (message[i + 2] << 8) | message[i + 3];
    i += 4;
  }
  if (message.length < i + typeLength + payloadLength) throw new NdefDecodeError('truncated record');
  const type = new TextDecoder().decode(message.subarray(i, i + typeLength));
  i += typeLength;
  return { type, payload: message.subarray(i, i + payloadLength) };
}
```

- [ ] **Step 4: 통과 확인**

Run: `pnpm vitest run apps/web/src/shared/nfc/ndef.test.ts`
Expected: PASS — 5 passed.

- [ ] **Step 5: 커밋**

```bash
git add apps/web/src/shared/nfc/ndef.ts apps/web/src/shared/nfc/ndef.test.ts
git commit -m "feat(nfc): NDEF external type record encoder and decoder"
```

---

## Task 10: 스태프 전용 Capacitor 빌드 (`app.monti.staff`)

**Files:**
- Create: `apps/web/capacitor.staff.config.ts`, `apps/web/vite.staff.config.ts`, `apps/web/staff.html`, `apps/web/src/staffMain.tsx`, `apps/web/src/staff/StaffRoutes.tsx`, `apps/web/src/staff/constants.ts`
- Test: `apps/web/src/staff/constants.test.ts`
- Modify: `apps/web/package.json`

**Interfaces:**
- Consumes: 03의 `apps/web` Vite 설정과 React 19 의존성
- Produces: `apps/web/src/staff/constants.ts` — `MONTI_AID`, `NDEF_TYPE_GATE`, `NDEF_TYPE_RESPONSE`, `QR_PREFIX`, `GATE_KEY_ALIAS`, `GATE_CODE_ROTATE_MS`, `CODE_WINDOW_SECONDS`, `SNAPSHOT_REFRESH_MS`, `CONFIRM_SPINNER_MS`, `RETAP_PROMPT_MS`, `STAFF_DB_NAME`. 이후 모든 스태프 태스크가 여기서 값을 읽는다. 하드코딩 금지.

- [ ] **Step 1: 상수 계약 테스트를 쓴다**

```ts
// apps/web/src/staff/constants.test.ts
import { describe, expect, it } from 'vitest';

import * as C from './constants';

describe('staff constants match the spec parameter table (§7.3, §11)', () => {
  it('pins the HCE and NDEF identifiers', () => {
    expect(C.MONTI_AID).toBe('D2760000850101');
    expect(C.NDEF_TYPE_GATE).toBe('monti.app:g');
    expect(C.NDEF_TYPE_RESPONSE).toBe('monti.app:s');
    expect(C.QR_PREFIX).toBe('MONTI1:');
  });

  it('pins the timing parameters', () => {
    expect(C.GATE_CODE_ROTATE_MS).toBe(3000);
    expect(C.CODE_WINDOW_SECONDS).toBe(60);
    expect(C.SNAPSHOT_REFRESH_MS).toBe(600_000);
    expect(C.CONFIRM_SPINNER_MS).toBe(2000);
    expect(C.RETAP_PROMPT_MS).toBe(5000);
  });

  it('keeps the gate key alias distinct from the attendee device key', () => {
    expect(C.GATE_KEY_ALIAS).toBe('monti-gate');
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm vitest run apps/web/src/staff/constants.test.ts`
Expected: FAIL — `Cannot find module './constants'`.

- [ ] **Step 3: 상수와 라우트 뼈대를 쓴다**

```ts
// apps/web/src/staff/constants.ts
export const MONTI_AID = 'D2760000850101' as const;
export const NDEF_TYPE_GATE = 'monti.app:g' as const;
export const NDEF_TYPE_RESPONSE = 'monti.app:s' as const;
export const QR_PREFIX = 'MONTI1:' as const;

/** 게이트 단말기 키. 생체 인증 없이 3초마다 서명해야 하므로 관객 기기 키와 별칭이 다르다. */
export const GATE_KEY_ALIAS = 'monti-gate' as const;

export const GATE_CODE_ROTATE_MS = 3000;
export const CODE_WINDOW_SECONDS = 60;
export const SNAPSHOT_REFRESH_MS = 600_000;
export const CONFIRM_SPINNER_MS = 2000;
export const RETAP_PROMPT_MS = 5000;

export const STAFF_DB_NAME = 'monti-staff' as const;
export const STAFF_DB_VERSION = 1;
```

```tsx
// apps/web/src/staff/StaffRoutes.tsx
import { Navigate, Route, Routes } from 'react-router-dom';

import { GateScreen } from './gate/GateScreen';
import { QueueScreen } from './queue/QueueScreen';
import { GateSetupScreen } from './setup/GateSetupScreen';

export function StaffRoutes() {
  return (
    <Routes>
      <Route path="setup" element={<GateSetupScreen />} />
      <Route path="gate" element={<GateScreen />} />
      <Route path="queue" element={<QueueScreen />} />
      <Route path="*" element={<Navigate to="setup" replace />} />
    </Routes>
  );
}
```

```tsx
// apps/web/src/staffMain.tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import { StaffRoutes } from './staff/StaffRoutes';

const root = document.getElementById('root');
if (!root) throw new Error('#root missing from staff.html');

createRoot(root).render(
  <StrictMode>
    <MemoryRouter initialEntries={['/staff/setup']}>
      <Routes>
        <Route path="/staff/*" element={<StaffRoutes />} />
      </Routes>
    </MemoryRouter>
  </StrictMode>,
);
```

- [ ] **Step 4: 빌드 설정을 쓴다**

```html
<!-- apps/web/staff.html -->
<!doctype html>
<html lang="ko">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
    <title>MONTI Staff</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/staffMain.tsx"></script>
  </body>
</html>
```

```ts
// apps/web/vite.staff.config.ts
import { renameSync } from 'node:fs';
import { resolve } from 'node:path';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'staff-html-entry',
      closeBundle() {
        renameSync(resolve(__dirname, 'dist-staff/staff.html'), resolve(__dirname, 'dist-staff/index.html'));
      },
    },
  ],
  define: { 'import.meta.env.VITE_APP_FLAVOR': JSON.stringify('staff') },
  build: {
    outDir: 'dist-staff',
    emptyOutDir: true,
    rollupOptions: { input: resolve(__dirname, 'staff.html') },
  },
});
```

```ts
// apps/web/capacitor.staff.config.ts
import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'app.monti.staff',
  appName: 'MONTI Staff',
  webDir: 'dist-staff',
  android: {
    path: 'android-staff',
  },
  plugins: {
    CapacitorHttp: { enabled: true },
  },
};

export default config;
```

`apps/web/package.json` 의 `scripts` 에 세 줄을 더한다.

```json
    "build:staff": "vite build --config vite.staff.config.ts",
    "sync:staff": "pnpm build:staff && cap sync android --config capacitor.staff.config.ts",
    "run:staff": "pnpm sync:staff && cap run android --config capacitor.staff.config.ts"
```

- [ ] **Step 5: 안드로이드 프로젝트를 만든다**

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/apps/web
pnpm build:staff
npx cap add android --config capacitor.staff.config.ts
```

Expected: `✔ Adding native android project in android-staff`, `✔ add in ...`, 그리고 `apps/web/android-staff/app/build.gradle` 안에 `applicationId "app.monti.staff"`.
`--config` 플래그를 이 CLI 버전이 모른다면(`unknown option`), `capacitor.config.ts` 를 잠시 교체하는 대신 `CAPACITOR_CONFIG_FILE=capacitor.staff.config.ts npx cap add android` 를 쓰고, 이 사실을 `docs/superpowers/plans/spikes.md` 에 적는다.

- [ ] **Step 6: 통과 확인**

Run: `pnpm vitest run apps/web/src/staff/constants.test.ts`
Expected: PASS — 3 passed.

- [ ] **Step 7: 커밋**

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI
git add apps/web/capacitor.staff.config.ts apps/web/vite.staff.config.ts apps/web/staff.html apps/web/src/staffMain.tsx apps/web/src/staff apps/web/package.json apps/web/android-staff
git commit -m "feat(staff): Android-only Capacitor build app.monti.staff from the shared web codebase"
```

---

## Task 11: 게이트 기기 키 (StrongBox, 생체 없음)

**Files:**
- Create: `apps/web/src/staff/gate/gateKey.ts`
- Test: `apps/web/src/staff/gate/gateKey.test.ts`

**Interfaces:**
- Consumes: `ensureDeviceKey(o?: DeviceKeyOptions)`, `signWithDeviceKey(hash, o?)` (03, 가정한 인터페이스 절 참조), `GATE_KEY_ALIAS` (Task 10)
- Produces: `ensureGateKey(): Promise<{ x: Hex; y: Hex }>`, `signWithGateKey(hash: Hex): Promise<{ r: Hex; s: Hex }>`, `gatePublicKeyUncompressed(k): Hex`. Task 12·16이 쓴다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

```ts
// apps/web/src/staff/gate/gateKey.test.ts
import { describe, expect, it, vi, beforeEach } from 'vitest';

const ensureDeviceKey = vi.fn();
const signWithDeviceKey = vi.fn();
vi.mock('../../shared/deviceKey', () => ({ ensureDeviceKey, signWithDeviceKey }));

import { ensureGateKey, gatePublicKeyUncompressed, signWithGateKey } from './gateKey';

describe('gate device key', () => {
  beforeEach(() => {
    ensureDeviceKey.mockReset();
    signWithDeviceKey.mockReset();
  });

  it('creates a StrongBox key that never asks for biometrics', async () => {
    ensureDeviceKey.mockResolvedValue({ x: `0x${'11'.repeat(32)}`, y: `0x${'22'.repeat(32)}` });
    await ensureGateKey();
    expect(ensureDeviceKey).toHaveBeenCalledWith({
      alias: 'monti-gate',
      requireAuth: false,
      strongBox: true,
    });
  });

  it('signs with the gate alias, never the attendee alias', async () => {
    signWithDeviceKey.mockResolvedValue({ r: `0x${'aa'.repeat(32)}`, s: `0x${'bb'.repeat(32)}` });
    await signWithGateKey(`0x${'cc'.repeat(32)}`);
    expect(signWithDeviceKey).toHaveBeenCalledWith(`0x${'cc'.repeat(32)}`, { alias: 'monti-gate' });
  });

  it('builds the 65-byte uncompressed SEC1 point used for local P-256 checks', () => {
    const pk = gatePublicKeyUncompressed({ x: `0x${'11'.repeat(32)}`, y: `0x${'22'.repeat(32)}` });
    expect(pk).toBe(`0x04${'11'.repeat(32)}${'22'.repeat(32)}`);
    expect(pk.length).toBe(2 + 130);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm vitest run apps/web/src/staff/gate/gateKey.test.ts`
Expected: FAIL — `Cannot find module './gateKey'`.

- [ ] **Step 3: 구현을 쓴다**

```ts
// apps/web/src/staff/gate/gateKey.ts
import type { Hex } from 'viem';

import { ensureDeviceKey, signWithDeviceKey } from '../../shared/deviceKey';
import { GATE_KEY_ALIAS } from '../constants';

export interface GatePublicKey {
  x: Hex;
  y: Hex;
}

/**
 * 게이트 키는 관객 기기 키와 다르다.
 *  - 생체 인증을 요구하지 않는다. 3초마다 서명해야 하고 스태프가 그때마다 지문을 댈 수는 없다.
 *  - StrongBox 를 먼저 시도하고 없으면 TEE 로 떨어진다(Global Constraints 의 기기 키 항목).
 *  - 단말기를 도난당해도 게이트 계정은 관리자가 allowlist 에서 빼면 즉시 무력화된다(T14).
 */
export async function ensureGateKey(): Promise<GatePublicKey> {
  return ensureDeviceKey({ alias: GATE_KEY_ALIAS, requireAuth: false, strongBox: true });
}

export async function signWithGateKey(hash: Hex): Promise<{ r: Hex; s: Hex }> {
  return signWithDeviceKey(hash, { alias: GATE_KEY_ALIAS });
}

/** SEC1 uncompressed point (0x04 ‖ x ‖ y). @noble/curves 검증과 Coinbase owner 인코딩에 쓴다. */
export function gatePublicKeyUncompressed(key: GatePublicKey): Hex {
  return `0x04${key.x.slice(2)}${key.y.slice(2)}`;
}
```

- [ ] **Step 4: 통과 확인**

Run: `pnpm vitest run apps/web/src/staff/gate/gateKey.test.ts`
Expected: PASS — 3 passed.

- [ ] **Step 5: 커밋**

```bash
git add apps/web/src/staff/gate/gateKey.ts apps/web/src/staff/gate/gateKey.test.ts
git commit -m "feat(staff): gate device key on a dedicated StrongBox alias with no biometric gate"
```

---

## Task 12: 기기 키로 WebAuthn 모양 서명 만들기 (`webauthn-sol` 호환)

**Files:**
- Create: `apps/web/src/shared/chain/gateSigner.ts`
- Test: `apps/web/src/shared/chain/gateSigner.test.ts`

**Interfaces:**
- Consumes: `signWithGateKey` (Task 11)
- Produces: `buildWebAuthnAuth(challenge: Hex, sign: (digest: Hex) => Promise<{r:Hex;s:Hex}>): Promise<WebAuthnAuth>`, `encodeWebAuthnSignature(auth: WebAuthnAuth, ownerIndex: bigint): Hex`, `signUserOpWithDeviceKey(userOpHash: Hex): Promise<Hex>`. `WebAuthnAuth = { authenticatorData: Hex; clientDataJSON: string; challengeIndex: bigint; typeIndex: bigint; r: bigint; s: bigint }`. Task 13이 쓴다.

**왜 이렇게 하는가:** Coinbase Smart Wallet 의 owner 는 **이더리움 주소이거나 64바이트 WebAuthn 공개키**, 둘뿐이다. 게이트 단말기의 P-256 기기 키를 그대로 64바이트 owner 로 올리고, 서명은 `webauthn-sol` 의 `WebAuthn.verify()` 가 받아들이는 모양으로 합성한다. 그 함수가 실제로 검사하는 것은 네 가지뿐이다: ① `clientDataJSON[typeIndex..]` 가 `"type":"webauthn.get"`, ② `clientDataJSON[challengeIndex..]` 가 `"challenge":"<base64url(challenge)>"`, ③ `authenticatorData[32] & 0x01`(UP), 필요 시 `& 0x04`(UV), ④ `P256.verifySignature(sha256(authenticatorData ‖ sha256(clientDataJSON)), r, s, x, y)` 와 low-s. rpIdHash 는 검사하지 않는다. 따라서 진짜 인증기 없이도 정직하게 만족시킬 수 있다.

- [ ] **Step 1: 실패하는 테스트를 쓴다 (ox 의 WebAuthnP256.verify 로 교차 검증)**

```ts
// apps/web/src/shared/chain/gateSigner.test.ts
import { p256 } from '@noble/curves/p256';
import { WebAuthnP256 } from 'ox';
import { bytesToHex, hexToBytes, decodeAbiParameters } from 'viem';
import { describe, expect, it } from 'vitest';

import { buildWebAuthnAuth, encodeWebAuthnSignature } from './gateSigner';

const priv = hexToBytes(`0x${'42'.repeat(32)}`);
const pub = p256.getPublicKey(priv, false);
const x = bytesToHex(pub.slice(1, 33));
const y = bytesToHex(pub.slice(33, 65));

const sign = async (digest: `0x${string}`) => {
  const sig = p256.sign(hexToBytes(digest), priv, { prehash: false });
  return { r: `0x${sig.r.toString(16).padStart(64, '0')}` as const, s: `0x${sig.s.toString(16).padStart(64, '0')}` as const };
};

describe('synthetic WebAuthn signature over the device key', () => {
  const challenge = `0x${'7e'.repeat(32)}` as const;

  it('produces clientDataJSON whose indices point at the checked substrings', async () => {
    const auth = await buildWebAuthnAuth(challenge, sign);
    expect(auth.clientDataJSON.slice(Number(auth.typeIndex), Number(auth.typeIndex) + 21)).toBe('"type":"webauthn.get"');
    expect(auth.clientDataJSON.slice(Number(auth.challengeIndex))).toMatch(/^"challenge":"[A-Za-z0-9_-]+"/);
  });

  it('sets UP and UV in authenticatorData', async () => {
    const auth = await buildWebAuthnAuth(challenge, sign);
    const bytes = hexToBytes(auth.authenticatorData);
    expect(bytes.length).toBe(37);
    expect(bytes[32] & 0x01).toBe(0x01);
    expect(bytes[32] & 0x04).toBe(0x04);
  });

  it('normalises s below n/2 so webauthn-sol accepts it', async () => {
    const auth = await buildWebAuthnAuth(challenge, sign);
    expect(auth.s <= p256.CURVE.n / 2n).toBe(true);
  });

  it('verifies with ox WebAuthnP256.verify', async () => {
    const auth = await buildWebAuthnAuth(challenge, sign);
    const ok = WebAuthnP256.verify({
      challenge,
      metadata: {
        authenticatorData: auth.authenticatorData,
        clientDataJSON: auth.clientDataJSON,
        challengeIndex: Number(auth.challengeIndex),
        typeIndex: Number(auth.typeIndex),
        userVerificationRequired: false,
      },
      publicKey: { prefix: 4, x: BigInt(x), y: BigInt(y) },
      signature: { r: auth.r, s: auth.s },
    });
    expect(ok).toBe(true);
  });

  it('wraps the struct in the Coinbase SignatureWrapper', async () => {
    const auth = await buildWebAuthnAuth(challenge, sign);
    const wrapped = encodeWebAuthnSignature(auth, 0n);
    const [decoded] = decodeAbiParameters(
      [{ type: 'tuple', components: [{ name: 'ownerIndex', type: 'uint256' }, { name: 'signatureData', type: 'bytes' }] }],
      wrapped,
    );
    expect((decoded as { ownerIndex: bigint }).ownerIndex).toBe(0n);
    expect((decoded as { signatureData: string }).signatureData.length).toBeGreaterThan(100);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm vitest run apps/web/src/shared/chain/gateSigner.test.ts`
Expected: FAIL — `Cannot find module './gateSigner'`.

- [ ] **Step 3: 구현을 쓴다**

```ts
// apps/web/src/shared/chain/gateSigner.ts
import { p256 } from '@noble/curves/p256';
import { concatHex, encodeAbiParameters, hexToBytes, sha256, stringToHex, type Hex } from 'viem';

import { signWithGateKey } from '../../staff/gate/gateKey';

export interface WebAuthnAuth {
  authenticatorData: Hex;
  clientDataJSON: string;
  challengeIndex: bigint;
  typeIndex: bigint;
  r: bigint;
  s: bigint;
}

/** RP ID 해시는 webauthn-sol 이 검사하지 않지만 현실적인 값으로 채운다. */
const RP_ID = import.meta.env.VITE_RP_ID ?? 'monti.app';
const FLAG_UP = 0x01;
const FLAG_UV = 0x04;

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function authenticatorData(): Hex {
  const rpIdHash = hexToBytes(sha256(stringToHex(RP_ID)));
  const out = new Uint8Array(37);
  out.set(rpIdHash, 0);
  out[32] = FLAG_UP | FLAG_UV;
  // signCount 0: 합성 서명이므로 카운터를 주장하지 않는다.
  return `0x${[...out].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

const WEBAUTHN_AUTH_ABI = [
  {
    type: 'tuple',
    components: [
      { name: 'authenticatorData', type: 'bytes' },
      { name: 'clientDataJSON', type: 'string' },
      { name: 'challengeIndex', type: 'uint256' },
      { name: 'typeIndex', type: 'uint256' },
      { name: 'r', type: 'uint256' },
      { name: 's', type: 'uint256' },
    ],
  },
] as const;

const SIGNATURE_WRAPPER_ABI = [
  {
    type: 'tuple',
    components: [
      { name: 'ownerIndex', type: 'uint256' },
      { name: 'signatureData', type: 'bytes' },
    ],
  },
] as const;

export async function buildWebAuthnAuth(
  challenge: Hex,
  sign: (digest: Hex) => Promise<{ r: Hex; s: Hex }>,
): Promise<WebAuthnAuth> {
  const encodedChallenge = base64Url(hexToBytes(challenge));
  const clientDataJSON =
    `{"type":"webauthn.get","challenge":"${encodedChallenge}","origin":"https://${RP_ID}","crossOrigin":false}`;
  const typeIndex = BigInt(clientDataJSON.indexOf('"type":"webauthn.get"'));
  const challengeIndex = BigInt(clientDataJSON.indexOf('"challenge":"'));

  const authData = authenticatorData();
  const digest = sha256(concatHex([authData, sha256(stringToHex(clientDataJSON))]));
  const { r, s } = await sign(digest);

  // webauthn-sol 은 malleable 한 high-s 서명을 거부한다.
  const n = p256.CURVE.n;
  let sBig = BigInt(s);
  if (sBig > n / 2n) sBig = n - sBig;

  return { authenticatorData: authData, clientDataJSON, challengeIndex, typeIndex, r: BigInt(r), s: sBig };
}

export function encodeWebAuthnSignature(auth: WebAuthnAuth, ownerIndex: bigint): Hex {
  const signatureData = encodeAbiParameters(WEBAUTHN_AUTH_ABI, [auth]);
  return encodeAbiParameters(SIGNATURE_WRAPPER_ABI, [{ ownerIndex, signatureData }]);
}

/**
 * CoinbaseSmartWallet.validateUserOp 은 userOpHash 를 그대로 challenge 로 쓴다
 * (replaySafeHash 는 ERC-1271 경로 전용이다). ownerIndex 0 = 게이트 기기 키.
 */
export async function signUserOpWithDeviceKey(userOpHash: Hex): Promise<Hex> {
  const auth = await buildWebAuthnAuth(userOpHash, signWithGateKey);
  return encodeWebAuthnSignature(auth, 0n);
}
```

- [ ] **Step 4: 통과 확인**

Run: `pnpm vitest run apps/web/src/shared/chain/gateSigner.test.ts`
Expected: PASS — 5 passed. `ox` 가 없으면 `pnpm --filter @monti/web add ox @noble/curves` 후 재실행.

- [ ] **Step 5: Foundry 교차 검증 (01의 P256 테스트 벡터와 맞추기)**

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI
pnpm vitest run apps/web/src/shared/chain/gateSigner.test.ts --reporter verbose 2>&1 | tail -20
```

Expected: 다섯 케이스 모두 `✓`. 이 벡터(x, y, r, s, digest)를 `docs/superpowers/plans/spikes.md` 의 "S3 device key" 절에 붙여 01 Task의 Solidity `P256.verifySignature` 테스트와 같은 값인지 사람이 한 번 대조한다.

- [ ] **Step 6: 커밋**

```bash
git add apps/web/src/shared/chain/gateSigner.ts apps/web/src/shared/chain/gateSigner.test.ts apps/web/package.json pnpm-lock.yaml
git commit -m "feat(chain): sign user ops with the gate device key in a webauthn-sol compatible shape"
```

---

## Task 13: 게이트 스마트 계정

**Files:**
- Create: `apps/web/src/shared/chain/gateAccount.ts`
- Test: `apps/web/src/shared/chain/gateAccount.test.ts`

**Interfaces:**
- Consumes: `ensureGateKey`, `gatePublicKeyUncompressed` (Task 11), `signUserOpWithDeviceKey` (Task 12), `getPublicClient()` (03), `ENTRYPOINT_V06`·`CHAIN_ID` (02)
- Produces: `getGateSmartAccount(): Promise<SmartAccount>`, `getGateAddress(): Promise<Address>`. Task 14·22가 쓴다. 반환 계정의 `signUserOperation` 은 언제나 Task 12의 합성 WebAuthn 서명을 낸다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

```ts
// apps/web/src/shared/chain/gateAccount.test.ts
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../staff/gate/gateKey', () => ({
  ensureGateKey: async () => ({ x: `0x${'11'.repeat(32)}`, y: `0x${'22'.repeat(32)}` }),
  gatePublicKeyUncompressed: (k: { x: string; y: string }) => `0x04${k.x.slice(2)}${k.y.slice(2)}`,
  signWithGateKey: async () => ({ r: `0x${'33'.repeat(32)}`, s: `0x${'44'.repeat(32)}` }),
}));
vi.mock('./gateSigner', () => ({ signUserOpWithDeviceKey: async () => '0xdeadbeef' }));

const toCoinbaseSmartAccount = vi.fn(async (args: { owners: Array<{ publicKey?: string }> }) => ({
  address: '0x1111111111111111111111111111111111111111',
  __owners: args.owners,
  async signUserOperation() { return '0xNOTOVERRIDDEN'; },
  async encodeCalls() { return '0x'; },
}));
vi.mock('viem/account-abstraction', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  toCoinbaseSmartAccount,
}));
vi.mock('./client', () => ({ getPublicClient: () => ({ chain: { id: 10143 } }) }));

import { getGateAddress, getGateSmartAccount } from './gateAccount';

describe('gate smart account', () => {
  it('uses the raw P-256 key as a 64-byte WebAuthn owner', async () => {
    await getGateSmartAccount();
    const owners = toCoinbaseSmartAccount.mock.calls[0][0].owners;
    expect(owners).toHaveLength(1);
    expect(owners[0].publicKey).toBe(`0x${'11'.repeat(32)}${'22'.repeat(32)}`);
    expect(owners[0].publicKey!.length).toBe(2 + 128);
  });

  it('overrides signUserOperation with the device-key signature', async () => {
    const account = await getGateSmartAccount();
    const sig = await account.signUserOperation({ callData: '0x', nonce: 0n, sender: '0x1111111111111111111111111111111111111111' } as never);
    expect(sig).toBe('0xdeadbeef');
  });

  it('exposes the address for gate registration', async () => {
    expect(await getGateAddress()).toBe('0x1111111111111111111111111111111111111111');
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm vitest run apps/web/src/shared/chain/gateAccount.test.ts`
Expected: FAIL — `Cannot find module './gateAccount'`.

- [ ] **Step 3: 구현을 쓴다**

```ts
// apps/web/src/shared/chain/gateAccount.ts
import type { Address, Hex } from 'viem';
import { getUserOperationHash, toCoinbaseSmartAccount, type SmartAccount } from 'viem/account-abstraction';

import { ENTRYPOINT_V06 } from '@monti/shared';

import { ensureGateKey } from '../../staff/gate/gateKey';
import { getPublicClient } from './client';
import { buildWebAuthnAuth, encodeWebAuthnSignature, signUserOpWithDeviceKey } from './gateSigner';
import { signWithGateKey } from '../../staff/gate/gateKey';

let cached: Promise<SmartAccount> | null = null;

/**
 * Coinbase Smart Wallet 의 owner 는 주소 아니면 64바이트 WebAuthn 공개키다.
 * 게이트 단말기에는 패스키가 없으므로 기기 키 (x‖y) 를 WebAuthn owner 로 올리고,
 * 서명만 WebAuthn 모양으로 합성한다(Task 12).
 */
export function getGateSmartAccount(): Promise<SmartAccount> {
  if (!cached) cached = build();
  return cached;
}

async function build(): Promise<SmartAccount> {
  const client = getPublicClient();
  const key = await ensureGateKey();
  const publicKey = `0x${key.x.slice(2)}${key.y.slice(2)}` as Hex;

  const owner = {
    id: 'monti-gate-device-key',
    publicKey,
    type: 'webAuthn' as const,
    async sign({ hash }: { hash: Hex }) {
      const auth = await buildWebAuthnAuth(hash, signWithGateKey);
      return {
        signature: encodeWebAuthnSignature(auth, 0n),
        webauthn: {
          authenticatorData: auth.authenticatorData,
          clientDataJSON: auth.clientDataJSON,
          challengeIndex: Number(auth.challengeIndex),
          typeIndex: Number(auth.typeIndex),
          userVerificationRequired: false,
        },
        raw: {} as never,
      };
    },
    async signMessage(): Promise<Hex> {
      throw new Error('the gate account signs user operations only');
    },
    async signTypedData(): Promise<Hex> {
      throw new Error('the gate account signs user operations only');
    },
  };

  const base = await toCoinbaseSmartAccount({ client, owners: [owner], version: '1' });

  return {
    ...base,
    async signUserOperation(parameters) {
      const userOpHash = getUserOperationHash({
        chainId: client.chain.id,
        entryPointAddress: ENTRYPOINT_V06,
        entryPointVersion: '0.6',
        userOperation: { ...parameters, sender: await base.getAddress() } as never,
      });
      return signUserOpWithDeviceKey(userOpHash);
    },
  } as SmartAccount;
}

export async function getGateAddress(): Promise<Address> {
  const account = await getGateSmartAccount();
  return account.address;
}
```

- [ ] **Step 4: 통과 확인**

Run: `pnpm vitest run apps/web/src/shared/chain/gateAccount.test.ts`
Expected: PASS — 3 passed.

- [ ] **Step 5: 커밋**

```bash
git add apps/web/src/shared/chain/gateAccount.ts apps/web/src/shared/chain/gateAccount.test.ts
git commit -m "feat(chain): gate smart account owned by the raw P-256 device key"
```

---

## Task 14: 스태프 상태 타입 한 벌

**Files:**
- Create: `apps/web/src/staff/types.ts`
- Test: `apps/web/src/staff/types.test.ts`

**Interfaces:**
- Consumes: `GateCodeWire`, `GateResponseWire`, `SnapshotWire` (`@monti/shared`, 마스터 플랜 그대로)
- Produces: `DenyCode`, `GateState`, `PreflightResult`, `QueueEntry`, `GateContext`. Task 20~32가 전부 여기서 타입을 읽는다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

```ts
// apps/web/src/staff/types.test.ts
import { describe, expect, it } from 'vitest';

import { DENY_CODES, GATE_STATES } from './types';

describe('staff types mirror spec §13', () => {
  it('lists the nine spec §13 DENY codes plus EVENT_ENDED', () => {
    expect([...DENY_CODES]).toEqual([
      'ALREADY_USED', 'WRONG_EVENT', 'REVOKED', 'EXPIRED_CODE', 'NO_TICKET',
      'GATE_CLOSED', 'EVENT_ENDED', 'DEVICE_LOCKED', 'DEVICE_MISMATCH', 'TX_FAILED',
    ]);
  });

  it('lists exactly the eight gate states from the web module table', () => {
    expect([...GATE_STATES]).toEqual([
      'idle', 'ready', 'received', 'confirming', 'admit', 'offlineAdmit', 'deny', 'override',
    ]);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm vitest run apps/web/src/staff/types.test.ts` → FAIL, `Cannot find module './types'`.

- [ ] **Step 3: 타입을 쓴다**

```ts
// apps/web/src/staff/types.ts
import type { GateCodeWire, GateResponseWire, Hex, SnapshotWire } from '@monti/shared';

export const DENY_CODES = [
  'ALREADY_USED', 'WRONG_EVENT', 'REVOKED', 'EXPIRED_CODE', 'NO_TICKET',
  'GATE_CLOSED', 'EVENT_ENDED', 'DEVICE_LOCKED', 'DEVICE_MISMATCH', 'TX_FAILED',
] as const;
export type DenyCode = (typeof DENY_CODES)[number];

export const GATE_STATES = [
  'idle', 'ready', 'received', 'confirming', 'admit', 'offlineAdmit', 'deny', 'override',
] as const;
export type GateState = (typeof GATE_STATES)[number];

export type SnapshotTicket = SnapshotWire['tickets'][number];

export interface PreflightResult {
  ok: boolean;
  deny?: DenyCode;
  ticket?: SnapshotTicket;
}

export interface QueueEntry {
  id: string;
  tokenId: string;
  gateCode: GateCodeWire;
  response: GateResponseWire;
  createdAt: number;
  attempts: number;
  nextAttemptAt: number;
  status: 'pending' | 'sent' | 'confirmed' | 'conflict' | 'failed';
  lastError?: string;
  userOpHash?: Hex;
}

export interface GateContext {
  state: GateState;
  gateId: bigint;
  eventId: bigint;
  orgId: bigint;
  deny?: DenyCode;
  denyDetail?: string;
  ticket?: SnapshotTicket;
  blockNumber?: bigint;
  finalized: boolean;
  pendingCount: number;
  snapshotAgeMs: number;
  online: boolean;
}
```

- [ ] **Step 4: 통과 확인**

Run: `pnpm vitest run apps/web/src/staff/types.test.ts` → PASS, 2 passed.

- [ ] **Step 5: 커밋**

```bash
git add apps/web/src/staff/types.ts apps/web/src/staff/types.test.ts
git commit -m "feat(staff): gate state and deny code types from spec section 13"
```

---

## Task 15: 게이트 등록 화면 — 주소 QR/텍스트 + `gateOf` 폴링

**Files:**
- Create: `apps/web/src/staff/setup/GateSetupScreen.tsx`, `apps/web/src/staff/setup/useGateRegistration.ts`
- Test: `apps/web/src/staff/setup/useGateRegistration.test.ts`

**Interfaces:**
- Consumes: `getGateAddress()` (Task 13), `ensureGateKey()` (Task 11), `submitPendingGate()` (02 callable, 스태프 세션), `useStaffSession()` (03), `getPublicClient()` (03), `organizersAbi`·`ticketAbi`·`CONTRACTS` (02)
- Produces: `useGateRegistration(p?: { eventId?: string; pollMs?: number; deviceLabel?: string }): { address?: Address; gateId?: bigint; eventId?: bigint; orgId?: bigint; open: boolean; revoked: boolean; submitted: boolean; status: 'creating'|'submitting'|'waiting'|'registered' }`. `eventId` 가 주어지면 `submitPendingGate` 를 한 번 부르고, 그 뒤 `gateOf` 를 폴링한다. QR 은 관리자가 신청을 못 받았을 때를 위한 **폴백 표시**로 남는다. Task 30의 게이트 화면이 `eventId`·`gateId`·`orgId` 를 여기서 받는다. 스펙 §5.7-1.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

```ts
// apps/web/src/staff/setup/useGateRegistration.test.ts
import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const ADDR = '0xAAaAaAaaaAaaAAAAaAAAAaAaaAAaaAAaAaAaAAaa';
const readContract = vi.fn();
const submitPendingGate = vi.fn(async () => ({ ok: true }));
vi.mock('../../shared/chain/client', () => ({ getPublicClient: () => ({ readContract }) }));
vi.mock('../../shared/chain/gateAccount', () => ({ getGateAddress: async () => ADDR }));
vi.mock('../gate/gateKey', () => ({ ensureGateKey: async () => ({ x: `0x${'11'.repeat(32)}`, y: `0x${'22'.repeat(32)}` }) }));
vi.mock('../../shared/api/functions', () => ({ submitPendingGate }));

import { useGateRegistration } from './useGateRegistration';

describe('gate registration', () => {
  it('submits the pending gate once with the device key, then polls gateOf', async () => {
    readContract
      .mockResolvedValueOnce(0n)
      .mockResolvedValueOnce(7n)
      .mockResolvedValueOnce([42n, ADDR, `0x${'11'.repeat(32)}`, `0x${'22'.repeat(32)}`, true, false])
      .mockResolvedValueOnce(5n);
    const { result } = renderHook(() => useGateRegistration({ eventId: '42', pollMs: 10, deviceLabel: 'Pixel 8 · 정문' }));
    await waitFor(() => expect(submitPendingGate).toHaveBeenCalledTimes(1));
    expect(submitPendingGate).toHaveBeenCalledWith({
      eventId: '42', gateAccount: ADDR, kx: `0x${'11'.repeat(32)}`, ky: `0x${'22'.repeat(32)}`, deviceLabel: 'Pixel 8 · 정문',
    });
    await waitFor(() => expect(result.current.status).toBe('registered'), { timeout: 2000 });
    expect(result.current.gateId).toBe(7n);
    expect(result.current.eventId).toBe(42n);
    expect(result.current.orgId).toBe(5n);
    expect(result.current.open).toBe(true);
  });

  it('polls without submitting when no eventId is selected yet', async () => {
    submitPendingGate.mockClear();
    readContract.mockResolvedValue(0n);
    const { result } = renderHook(() => useGateRegistration({ pollMs: 10 }));
    await waitFor(() => expect(result.current.status).toBe('waiting'));
    expect(submitPendingGate).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm vitest run apps/web/src/staff/setup/useGateRegistration.test.ts` → FAIL, `Cannot find module './useGateRegistration'`.

- [ ] **Step 3: 훅을 쓴다**

```ts
// apps/web/src/staff/setup/useGateRegistration.ts
import { useEffect, useState } from 'react';
import type { Address } from 'viem';

import { CONTRACTS, organizersAbi, ticketAbi } from '@monti/shared';

import { submitPendingGate } from '../../shared/api/functions';
import { getPublicClient } from '../../shared/chain/client';
import { getGateAddress } from '../../shared/chain/gateAccount';
import { ensureGateKey } from '../gate/gateKey';

export interface GateRegistration {
  address?: Address;
  gateId?: bigint;
  eventId?: bigint;
  orgId?: bigint;
  open: boolean;
  revoked: boolean;
  submitted: boolean;
  status: 'creating' | 'submitting' | 'waiting' | 'registered';
}

export interface UseGateRegistrationParams {
  /** 스태프가 고른 공연. 있으면 등록 신청을 보낸다. */
  eventId?: string;
  pollMs?: number;
  deviceLabel?: string;
}

/**
 * 단말기가 키를 만든 뒤 `submitPendingGate` 로 **등록 신청을 직접 보낸다**(스태프 Firebase 세션).
 * 관리자는 자기 화면에서 신청 목록을 보고 registerGate 를 부른다. QR 은 신청이 도달하지 못했을 때를
 * 위한 폴백 표시로만 남는다. 등록 여부의 진실은 언제나 체인의 `gateOf` 다(스펙 §5.7-1, §9.4).
 */
export function useGateRegistration(params: UseGateRegistrationParams = {}): GateRegistration {
  const { eventId, pollMs = 3000, deviceLabel } = params;
  const [reg, setReg] = useState<GateRegistration>({ open: false, revoked: false, submitted: false, status: 'creating' });

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    let submitted = false;
    const client = getPublicClient();
    const label = deviceLabel ?? navigator.userAgent.slice(0, 120);

    const tick = async (address: Address) => {
      const gateId = (await client.readContract({
        address: CONTRACTS.organizers, abi: organizersAbi, functionName: 'gateOf', args: [address],
      })) as bigint;
      if (!alive) return;
      if (gateId === 0n) {
        setReg((r) => ({ ...r, address, gateId: undefined, open: false, revoked: false, status: 'waiting' }));
      } else {
        const info = (await client.readContract({
          address: CONTRACTS.organizers, abi: organizersAbi, functionName: 'gateInfo', args: [gateId],
        })) as [bigint, Address, `0x${string}`, `0x${string}`, boolean, boolean];
        if (!alive) return;
        const orgId = (await client.readContract({
          address: CONTRACTS.ticket, abi: ticketAbi, functionName: 'eventOrg', args: [info[0]],
        })) as bigint;
        if (!alive) return;
        setReg((r) => ({ ...r, address, gateId, eventId: info[0], orgId, open: info[4], revoked: info[5], status: 'registered' }));
      }
      timer = setTimeout(() => void tick(address), pollMs);
    };

    void (async () => {
      const address = await getGateAddress();
      if (!alive) return;
      if (eventId && !submitted) {
        submitted = true;
        setReg((r) => ({ ...r, address, status: 'submitting' }));
        const key = await ensureGateKey();
        try {
          await submitPendingGate({ eventId, gateAccount: address, kx: key.x, ky: key.y, deviceLabel: label });
          if (!alive) return;
          setReg((r) => ({ ...r, submitted: true }));
        } catch {
          // 신청이 막히면 QR 폴백으로 관리자가 직접 입력한다. 폴링은 계속한다.
          if (!alive) return;
          setReg((r) => ({ ...r, submitted: false }));
        }
      }
      if (!alive) return;
      setReg((r) => ({ ...r, address, status: r.status === 'registered' ? r.status : 'waiting' }));
      void tick(address);
    })();

    return () => { alive = false; clearTimeout(timer); };
  }, [eventId, pollMs, deviceLabel]);

  return reg;
}
```

```tsx
// apps/web/src/staff/setup/GateSetupScreen.tsx
import { QRCodeSVG } from 'qrcode.react';
import { Navigate } from 'react-router-dom';

import { useStaffSession } from '../../shared/staffSession';
import { useGateRegistration } from './useGateRegistration';

export function GateSetupScreen() {
  const session = useStaffSession();
  const reg = useGateRegistration({ eventId: session.selectedEventId });
  if (reg.status === 'registered' && !reg.revoked) return <Navigate to="../gate" replace />;
  return (
    <main className="staff-setup">
      <h1>게이트 단말기 등록</h1>
      {reg.address ? (
        <>
          <p>
            {reg.submitted
              ? '등록 신청을 보냈습니다. 관리자가 승인하면 자동으로 다음 화면으로 넘어갑니다.'
              : '등록 신청을 보내지 못했습니다. 아래 주소를 관리자에게 직접 전달하세요.'}
          </p>
          <QRCodeSVG value={reg.address} size={220} />
          <p className="mono selectable">{reg.address}</p>
        </>
      ) : (
        <p>단말기 보안 칩에 게이트 키를 만드는 중…</p>
      )}
      {!session.selectedEventId && <p className="warn">먼저 공연을 선택하세요.</p>}
      {reg.revoked && <p className="error">이 게이트는 폐기되었습니다. 관리자에게 문의하세요.</p>}
    </main>
  );
}
```

- [ ] **Step 4: 의존성과 통과 확인**

```bash
pnpm --filter @monti/web add qrcode.react
pnpm vitest run apps/web/src/staff/setup/useGateRegistration.test.ts
```

Expected: PASS — 1 passed.

- [ ] **Step 5: 커밋**

```bash
git add apps/web/src/staff/setup apps/web/package.json pnpm-lock.yaml
git commit -m "feat(staff): gate registration screen showing the account address until gateOf is non-zero"
```

---

## Task 16: 게이트 1회용 번호 생성과 서명

**Files:**
- Create: `apps/web/src/staff/gate/gateCode.ts`
- Test: `apps/web/src/staff/gate/gateCode.test.ts`

**Interfaces:**
- Consumes: `signWithGateKey`, `ensureGateKey` (Task 11), `GateCodeWire` (`@monti/shared`)
- Produces: `gateCodeDigest(gateId, eventId, issuedAt, nonce): Hex`, `buildGateCode(params): Promise<GateCodeWire>`. Task 17이 3초마다 부른다. `sig` 는 `r‖s` 64바이트, 다이제스트는 `sha256(abi.encode(uint256 gateId, uint256 eventId, uint64 issuedAt, bytes32 nonce))` — 마스터 플랜의 `GateCodeWire` 주석 그대로.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

```ts
// apps/web/src/staff/gate/gateCode.test.ts
import { encodeAbiParameters, sha256 } from 'viem';
import { describe, expect, it, vi } from 'vitest';

vi.mock('./gateKey', () => ({
  ensureGateKey: async () => ({ x: `0x${'11'.repeat(32)}`, y: `0x${'22'.repeat(32)}` }),
  signWithGateKey: async (h: string) => ({ r: h as `0x${string}`, s: `0x${'44'.repeat(32)}` as const }),
}));

import { buildGateCode, gateCodeDigest } from './gateCode';

describe('gate code', () => {
  it('digests exactly the four fields in the wire order', () => {
    const nonce = `0x${'ab'.repeat(16)}${'00'.repeat(16)}` as const;
    expect(gateCodeDigest(7n, 42n, 1_700_000_000, nonce)).toBe(
      sha256(encodeAbiParameters(
        [{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint64' }, { type: 'bytes32' }],
        [7n, 42n, 1_700_000_000n, nonce],
      )),
    );
  });

  it('builds a wire object with a 16-byte random nonce and a 64-byte signature', async () => {
    const code = await buildGateCode({ gateId: 7n, eventId: 42n, now: 1_700_000_000_500 });
    expect(code.v).toBe(1);
    expect(code.gateId).toBe('7');
    expect(code.eventId).toBe('42');
    expect(code.issuedAt).toBe(1_700_000_000);
    expect(code.nonce).toMatch(/^0x[0-9a-f]{64}$/);
    expect(code.nonce.slice(34)).toBe('0'.repeat(30));
    expect(code.sig.length).toBe(2 + 128);
    expect(code.kx).toBe(`0x${'11'.repeat(32)}`);
  });

  it('never repeats a nonce', async () => {
    const a = await buildGateCode({ gateId: 1n, eventId: 1n, now: 1_700_000_000_000 });
    const b = await buildGateCode({ gateId: 1n, eventId: 1n, now: 1_700_000_000_000 });
    expect(a.nonce).not.toBe(b.nonce);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm vitest run apps/web/src/staff/gate/gateCode.test.ts` → FAIL, `Cannot find module './gateCode'`.

- [ ] **Step 3: 구현을 쓴다**

```ts
// apps/web/src/staff/gate/gateCode.ts
import { bytesToHex, encodeAbiParameters, sha256, type Hex } from 'viem';

import type { GateCodeWire } from '@monti/shared';

import { ensureGateKey, signWithGateKey } from './gateKey';

/** 128비트 난수를 bytes32 의 상위 16바이트에 넣는다. 하위 16바이트는 0. */
function randomNonce(): Hex {
  const raw = new Uint8Array(32);
  crypto.getRandomValues(raw.subarray(0, 16));
  return bytesToHex(raw);
}

export function gateCodeDigest(gateId: bigint, eventId: bigint, issuedAt: number, nonce: Hex): Hex {
  return sha256(
    encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint64' }, { type: 'bytes32' }],
      [gateId, eventId, BigInt(issuedAt), nonce],
    ),
  );
}

export interface BuildGateCodeParams {
  gateId: bigint;
  eventId: bigint;
  /** 밀리초. 단말기 시계는 NTP 동기화 전제(스펙 §7.3). */
  now?: number;
}

export async function buildGateCode(params: BuildGateCodeParams): Promise<GateCodeWire> {
  const key = await ensureGateKey();
  const issuedAt = Math.floor((params.now ?? Date.now()) / 1000);
  const nonce = randomNonce();
  const { r, s } = await signWithGateKey(gateCodeDigest(params.gateId, params.eventId, issuedAt, nonce));
  return {
    v: 1,
    gateId: params.gateId.toString(),
    eventId: params.eventId.toString(),
    issuedAt,
    nonce,
    kx: key.x,
    ky: key.y,
    sig: `0x${r.slice(2)}${s.slice(2)}`,
  };
}
```

- [ ] **Step 4: 통과 확인**

Run: `pnpm vitest run apps/web/src/staff/gate/gateCode.test.ts` → PASS, 3 passed.

- [ ] **Step 5: 커밋**

```bash
git add apps/web/src/staff/gate/gateCode.ts apps/web/src/staff/gate/gateCode.test.ts
git commit -m "feat(staff): build and sign the rotating gate code"
```

---

## Task 17: 3초 회전 송출 루프

**Files:**
- Create: `apps/web/src/staff/gate/emitter.ts`
- Test: `apps/web/src/staff/gate/emitter.test.ts`

**Interfaces:**
- Consumes: `buildGateCode` (Task 16), `encodeExternalRecord` (Task 9), `Hce` (Task 1), `GATE_CODE_ROTATE_MS`·`NDEF_TYPE_GATE`·`MONTI_AID` (Task 10)
- Produces: `startGateEmitter(p: { gateId: bigint; eventId: bigint; onWrite: (ndef: Uint8Array) => void }): Promise<GateEmitter>`, `interface GateEmitter { stop(): Promise<void>; lastCode(): GateCodeWire | undefined }`. Task 25가 쓴다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

```ts
// apps/web/src/staff/gate/emitter.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hce = { start: vi.fn(async () => {}), setPayload: vi.fn(async () => {}), stop: vi.fn(async () => {}),
  addListener: vi.fn(async () => ({ remove: async () => {} })), removeAllListeners: vi.fn(async () => {}) };
vi.mock('@monti/hce-android', () => ({ Hce: hce }));
vi.mock('./gateKey', () => ({
  ensureGateKey: async () => ({ x: `0x${'11'.repeat(32)}`, y: `0x${'22'.repeat(32)}` }),
  signWithGateKey: async () => ({ r: `0x${'33'.repeat(32)}`, s: `0x${'44'.repeat(32)}` }),
}));

import { startGateEmitter } from './emitter';

describe('gate emitter', () => {
  beforeEach(() => { vi.useFakeTimers(); Object.values(hce).forEach((f) => f.mockClear()); });
  afterEach(() => { vi.useRealTimers(); });

  it('claims the AID and pushes a first payload immediately', async () => {
    await startGateEmitter({ gateId: 7n, eventId: 42n, onWrite: () => {} });
    expect(hce.start).toHaveBeenCalledWith({ aid: 'D2760000850101' });
    expect(hce.setPayload).toHaveBeenCalledTimes(1);
    expect(typeof hce.setPayload.mock.calls[0][0].ndef).toBe('string');
  });

  it('rotates every 3000 ms', async () => {
    await startGateEmitter({ gateId: 7n, eventId: 42n, onWrite: () => {} });
    await vi.advanceTimersByTimeAsync(9000);
    expect(hce.setPayload).toHaveBeenCalledTimes(4);
  });

  it('stops the timer and releases the AID', async () => {
    const e = await startGateEmitter({ gateId: 7n, eventId: 42n, onWrite: () => {} });
    await e.stop();
    await vi.advanceTimersByTimeAsync(9000);
    expect(hce.setPayload).toHaveBeenCalledTimes(1);
    expect(hce.stop).toHaveBeenCalledTimes(1);
  });

  it('forwards a write event as raw NDEF bytes', async () => {
    const seen: Uint8Array[] = [];
    await startGateEmitter({ gateId: 7n, eventId: 42n, onWrite: (b) => seen.push(b) });
    const handler = hce.addListener.mock.calls[0][1] as (e: { ndef: string }) => void;
    handler({ ndef: btoa(String.fromCharCode(1, 2, 3)) });
    expect([...seen[0]]).toEqual([1, 2, 3]);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm vitest run apps/web/src/staff/gate/emitter.test.ts` → FAIL, `Cannot find module './emitter'`.

- [ ] **Step 3: 구현을 쓴다**

```ts
// apps/web/src/staff/gate/emitter.ts
import { encode as cborEncode } from 'cborg';

import { Hce } from '@monti/hce-android';
import type { GateCodeWire } from '@monti/shared';

import { encodeExternalRecord } from '../../shared/nfc/ndef';
import { GATE_CODE_ROTATE_MS, MONTI_AID, NDEF_TYPE_GATE } from '../constants';
import { buildGateCode } from './gateCode';

export interface GateEmitter {
  stop(): Promise<void>;
  lastCode(): GateCodeWire | undefined;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

export interface StartGateEmitterParams {
  gateId: bigint;
  eventId: bigint;
  onWrite: (ndef: Uint8Array) => void;
}

/**
 * HCE 를 켜고 3초마다 새 1회용 번호를 예약한다.
 * 교체는 플러그인이 탭과 탭 사이에서만 적용한다(Task 5). 여기서는 무조건 밀어넣으면 된다.
 * 이 파일은 NFC 리더 API 를 절대 부르지 않는다(스펙 §11, §18).
 */
export async function startGateEmitter(params: StartGateEmitterParams): Promise<GateEmitter> {
  let last: GateCodeWire | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;

  const handle = await Hce.addListener('write', (event) => {
    params.onWrite(fromBase64(event.ndef));
  });
  await Hce.start({ aid: MONTI_AID });

  const rotate = async () => {
    const code = await buildGateCode({ gateId: params.gateId, eventId: params.eventId });
    last = code;
    const record = encodeExternalRecord(NDEF_TYPE_GATE, cborEncode(code));
    await Hce.setPayload({ ndef: toBase64(record) });
  };

  await rotate();
  timer = setInterval(() => { void rotate(); }, GATE_CODE_ROTATE_MS);

  return {
    async stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
      await handle.remove();
      await Hce.stop();
    },
    lastCode: () => last,
  };
}
```

- [ ] **Step 4: 통과 확인**

```bash
pnpm --filter @monti/web add cborg
pnpm vitest run apps/web/src/staff/gate/emitter.test.ts
```

Expected: PASS — 4 passed.

- [ ] **Step 5: 커밋**

```bash
git add apps/web/src/staff/gate/emitter.ts apps/web/src/staff/gate/emitter.test.ts apps/web/package.json pnpm-lock.yaml
git commit -m "feat(staff): rotate the gate code into HCE every 3 s and forward writes"
```

---

## Task 18: 리더 모드 금지를 테스트로 강제

**Files:**
- Create: `apps/web/src/staff/noReaderMode.test.ts`

**Interfaces:**
- Consumes: 없음 (소스 트리를 읽는다)
- Produces: 회귀 방지 테스트. 스펙 §11("HCE 동작 중에는 절대 읽기 모드를 켜지 않는다")과 §18(아이폰 탭 50% 실패 리스크)을 코드로 고정한다.

- [ ] **Step 1: 테스트를 쓴다**

```ts
// apps/web/src/staff/noReaderMode.test.ts
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const FORBIDDEN = [
  'enableReaderMode',
  'enableForegroundDispatch',
  'NfcAdapter.ACTION_',
  '@capgo/capacitor-nfc',
  'NDEFReader',
];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.(ts|tsx)$/.test(full) ? [full] : [];
  });
}

describe('the staff device never enables NFC reader mode', () => {
  const roots = [resolve(__dirname), resolve(__dirname, '../../../../plugins/hce-android/src')];

  it.each(FORBIDDEN)('never mentions %s', (needle) => {
    const offenders = roots
      .flatMap(walk)
      .filter((f) => !f.endsWith('noReaderMode.test.ts'))
      .filter((f) => readFileSync(f, 'utf8').includes(needle));
    expect(offenders, `${needle} found in:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('the staff Capacitor config does not register the attendee NFC plugin', () => {
    const config = readFileSync(resolve(__dirname, '../../capacitor.staff.config.ts'), 'utf8');
    expect(config).not.toContain('capacitor-nfc');
    expect(config).toContain('app.monti.staff');
  });
});
```

- [ ] **Step 2: 통과 확인 (처음부터 초록이어야 한다)**

Run: `pnpm vitest run apps/web/src/staff/noReaderMode.test.ts`
Expected: PASS — 6 passed. 만약 실패한다면 해당 파일에서 리더 API 를 즉시 제거한다. 예외는 없다.

- [ ] **Step 3: 의도적으로 깨뜨려 테스트가 진짜 잡는지 확인**

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI
printf '\n// enableReaderMode\n' >> apps/web/src/staff/constants.ts
pnpm vitest run apps/web/src/staff/noReaderMode.test.ts || true
git checkout -- apps/web/src/staff/constants.ts
```

Expected: 위 실행에서 `never mentions enableReaderMode` 가 FAIL, `git checkout` 후 파일이 원래대로.

- [ ] **Step 4: 다시 통과 확인**

Run: `pnpm vitest run apps/web/src/staff/noReaderMode.test.ts` → PASS, 6 passed.

- [ ] **Step 5: 커밋**

```bash
git add apps/web/src/staff/noReaderMode.test.ts
git commit -m "test(staff): forbid every NFC reader-mode API in staff and plugin source"
```

---

## Task 19: 응답 수신 — `monti.app:s` 디코딩

**Files:**
- Create: `apps/web/src/staff/gate/decodeResponse.ts`
- Test: `apps/web/src/staff/gate/decodeResponse.test.ts`

**Interfaces:**
- Consumes: `decodeExternalRecord` (Task 9), `GateResponseWire` (`@monti/shared`), `NDEF_TYPE_RESPONSE`·`QR_PREFIX` (Task 10)
- Produces: `decodeGateResponse(ndef: Uint8Array): GateResponseWire`, `decodeQrResponse(text: string): GateResponseWire`, `class ResponseDecodeError`. Task 23·31이 쓴다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

```ts
// apps/web/src/staff/gate/decodeResponse.test.ts
import { encode as cborEncode } from 'cborg';
import { describe, expect, it } from 'vitest';

import { encodeExternalRecord } from '../../shared/nfc/ndef';
import { decodeGateResponse, decodeQrResponse, ResponseDecodeError } from './decodeResponse';

const wire = { v: 1, tokenId: '123', deviceSig: `0x${'ab'.repeat(64)}` } as const;

describe('gate response decoding', () => {
  it('decodes a monti.app:s record', () => {
    expect(decodeGateResponse(encodeExternalRecord('monti.app:s', cborEncode(wire)))).toEqual(wire);
  });

  it('refuses the gate record type coming back at us', () => {
    expect(() => decodeGateResponse(encodeExternalRecord('monti.app:g', cborEncode(wire))))
      .toThrow(ResponseDecodeError);
  });

  it('refuses a wrong version or a malformed signature length', () => {
    expect(() => decodeGateResponse(encodeExternalRecord('monti.app:s', cborEncode({ ...wire, v: 2 }))))
      .toThrow(ResponseDecodeError);
    expect(() => decodeGateResponse(encodeExternalRecord('monti.app:s', cborEncode({ ...wire, deviceSig: '0xab' }))))
      .toThrow(ResponseDecodeError);
  });

  it('decodes the MONTI1: QR fallback into the same object', () => {
    const b64url = btoa(String.fromCharCode(...cborEncode(wire)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(decodeQrResponse(`MONTI1:${b64url}`)).toEqual(wire);
  });

  it('refuses a QR payload without the prefix', () => {
    expect(() => decodeQrResponse('https://example.com')).toThrow(ResponseDecodeError);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm vitest run apps/web/src/staff/gate/decodeResponse.test.ts` → FAIL, `Cannot find module './decodeResponse'`.

- [ ] **Step 3: 구현을 쓴다**

```ts
// apps/web/src/staff/gate/decodeResponse.ts
import { decode as cborDecode } from 'cborg';

import type { GateResponseWire } from '@monti/shared';

import { decodeExternalRecord, NdefDecodeError } from '../../shared/nfc/ndef';
import { NDEF_TYPE_RESPONSE, QR_PREFIX } from '../constants';

export class ResponseDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResponseDecodeError';
  }
}

function assertWire(value: unknown): GateResponseWire {
  const wire = value as Partial<GateResponseWire>;
  if (!wire || typeof wire !== 'object') throw new ResponseDecodeError('payload is not a CBOR map');
  if (wire.v !== 1) throw new ResponseDecodeError(`unsupported wire version ${String(wire.v)}`);
  if (typeof wire.tokenId !== 'string' || !/^\d+$/.test(wire.tokenId)) {
    throw new ResponseDecodeError('tokenId must be a decimal string');
  }
  if (typeof wire.deviceSig !== 'string' || !/^0x[0-9a-fA-F]{128}$/.test(wire.deviceSig)) {
    throw new ResponseDecodeError('deviceSig must be 64 bytes of r‖s');
  }
  return { v: 1, tokenId: wire.tokenId, deviceSig: wire.deviceSig as GateResponseWire['deviceSig'] };
}

export function decodeGateResponse(ndef: Uint8Array): GateResponseWire {
  let record: { type: string; payload: Uint8Array };
  try {
    record = decodeExternalRecord(ndef);
  } catch (e) {
    throw new ResponseDecodeError(e instanceof NdefDecodeError ? e.message : 'unreadable NDEF message');
  }
  if (record.type !== NDEF_TYPE_RESPONSE) {
    throw new ResponseDecodeError(`expected ${NDEF_TYPE_RESPONSE}, got ${record.type}`);
  }
  return assertWire(cborDecode(record.payload));
}

export function decodeQrResponse(text: string): GateResponseWire {
  if (!text.startsWith(QR_PREFIX)) throw new ResponseDecodeError('not a MONTI QR code');
  const body = text.slice(QR_PREFIX.length).replace(/-/g, '+').replace(/_/g, '/');
  const padded = body + '='.repeat((4 - (body.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return assertWire(cborDecode(bytes));
}
```

- [ ] **Step 4: 통과 확인**

Run: `pnpm vitest run apps/web/src/staff/gate/decodeResponse.test.ts` → PASS, 5 passed.

- [ ] **Step 5: 커밋**

```bash
git add apps/web/src/staff/gate/decodeResponse.ts apps/web/src/staff/gate/decodeResponse.test.ts
git commit -m "feat(staff): decode NFC and QR gate responses into GateResponseWire"
```

---

## Task 20: 스냅샷 사전 검증 (preflight)

**Files:**
- Create: `apps/web/src/staff/gate/preflight.ts`
- Test: `apps/web/src/staff/gate/preflight.test.ts`

**Interfaces:**
- Consumes: `SnapshotWire`, `GateCodeWire`, `GateResponseWire` (`@monti/shared`), `PreflightResult`·`DenyCode` (Task 14), `CODE_WINDOW_SECONDS` (Task 10)
- Produces: `preflight(p: { snapshot: SnapshotWire; code: GateCodeWire; response: GateResponseWire; now?: number }): PreflightResult`. Task 21이 전송 전에, Task 29가 오프라인 승인 전에 부른다. 스펙 §7.2-5("전송 전 캐시된 스냅샷으로 사전 검증해 실패 트랜잭션을 줄인다").

- [ ] **Step 1: 실패하는 테스트를 쓴다**

```ts
// apps/web/src/staff/gate/preflight.test.ts
import { describe, expect, it } from 'vitest';

import { preflight } from './preflight';

const ticket = {
  tokenId: '123', account: `0x${'aa'.repeat(20)}` as const,
  deviceX: `0x${'11'.repeat(32)}` as const, deviceY: `0x${'22'.repeat(32)}` as const,
  photoJpegB64: 'x', displayName: '김입장', tier: 0, checkedIn: false, tierName: '일반', seat: '',
};
const snapshot = { v: 1 as const, eventId: '42', eventTitle: '가을 밤 콘서트', requireKyc: true, epoch: 1, expiresAt: 2_000_000_000, tickets: [ticket], attesterSig: '0x00' as const };
const code = { v: 1 as const, gateId: '7', eventId: '42', issuedAt: 1_700_000_000, nonce: `0x${'ab'.repeat(32)}` as const,
  kx: `0x${'11'.repeat(32)}` as const, ky: `0x${'22'.repeat(32)}` as const, sig: `0x${'cd'.repeat(64)}` as const };
const response = { v: 1 as const, tokenId: '123', deviceSig: `0x${'ef'.repeat(64)}` as const };
const now = 1_700_000_010_000;

describe('preflight', () => {
  it('passes a fresh, unused ticket of this event', () => {
    expect(preflight({ snapshot, code, response, now })).toEqual({ ok: true, ticket });
  });

  it('NO_TICKET when the token is not in the snapshot', () => {
    expect(preflight({ snapshot, code, response: { ...response, tokenId: '999' }, now }).deny).toBe('NO_TICKET');
  });

  it('WRONG_EVENT when the snapshot is for another event', () => {
    expect(preflight({ snapshot: { ...snapshot, eventId: '43' }, code, response, now }).deny).toBe('WRONG_EVENT');
  });

  it('ALREADY_USED when the snapshot already has the check-in', () => {
    const used = { ...snapshot, tickets: [{ ...ticket, checkedIn: true }] };
    expect(preflight({ snapshot: used, code, response, now }).deny).toBe('ALREADY_USED');
  });

  it('EXPIRED_CODE past the 60 s window', () => {
    expect(preflight({ snapshot, code, response, now: now + 61_000 }).deny).toBe('EXPIRED_CODE');
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm vitest run apps/web/src/staff/gate/preflight.test.ts` → FAIL, `Cannot find module './preflight'`.

- [ ] **Step 3: 구현을 쓴다**

```ts
// apps/web/src/staff/gate/preflight.ts
import type { GateCodeWire, GateResponseWire, SnapshotWire } from '@monti/shared';

import { CODE_WINDOW_SECONDS } from '../constants';
import type { PreflightResult } from '../types';

export interface PreflightParams {
  snapshot: SnapshotWire;
  code: GateCodeWire;
  response: GateResponseWire;
  now?: number;
}

/**
 * 체인이 checkIn 안에서 하는 검사(스펙 §7.2-6 ①~⑤)를 로컬 스냅샷으로 미리 흉내 낸다.
 * 여기서 통과해도 판정은 아니다. 실패 트랜잭션을 줄이고 DENY 를 빨리 띄우는 용도다.
 * 기기 키 서명의 암호학적 검증은 오프라인 승인 경로(Task 29)에서만 한다.
 */
export function preflight({ snapshot, code, response, now = Date.now() }: PreflightParams): PreflightResult {
  if (Math.floor(now / 1000) - code.issuedAt > CODE_WINDOW_SECONDS) return { ok: false, deny: 'EXPIRED_CODE' };
  if (snapshot.eventId !== code.eventId) return { ok: false, deny: 'WRONG_EVENT' };

  const ticket = snapshot.tickets.find((t) => t.tokenId === response.tokenId);
  if (!ticket) return { ok: false, deny: 'NO_TICKET' };
  if (ticket.checkedIn) return { ok: false, deny: 'ALREADY_USED', ticket };
  if (ticket.deviceX === `0x${'00'.repeat(32)}`) return { ok: false, deny: 'DEVICE_LOCKED', ticket };

  return { ok: true, ticket };
}
```

- [ ] **Step 4: 통과 확인**

Run: `pnpm vitest run apps/web/src/staff/gate/preflight.test.ts` → PASS, 5 passed.

- [ ] **Step 5: 커밋**

```bash
git add apps/web/src/staff/gate/preflight.ts apps/web/src/staff/gate/preflight.test.ts
git commit -m "feat(staff): snapshot preflight before sending a check-in"
```

---

## Task 21: `Ticket.checkIn` 유저옵 전송

**Files:**
- Create: `apps/web/src/staff/gate/checkInOp.ts`
- Test: `apps/web/src/staff/gate/checkInOp.test.ts`

**Interfaces:**
- Consumes: `getGateSmartAccount()` (Task 13), `sendSponsoredOp()` (03, 가정), `ticketAbi`·`CONTRACTS` (02)
- Produces: `encodeCheckInCall(code: GateCodeWire, response: GateResponseWire): Hex`, `sendCheckIn(p: { code; response; orgId: bigint }): Promise<SponsoredOpHandle>`. Task 23·30이 쓴다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

```ts
// apps/web/src/staff/gate/checkInOp.test.ts
import { decodeFunctionData } from 'viem';
import { describe, expect, it, vi } from 'vitest';

import { ticketAbi } from '@monti/shared';

const sendSponsoredOp = vi.fn(async () => ({ userOpHash: '0xfeed', wait: async (_t?: number) => ({ success: true, blockNumber: 1n, txHash: '0xabc' }) }));
vi.mock('../../shared/chain/sponsored', () => ({ sendSponsoredOp }));
vi.mock('../../shared/chain/gateAccount', () => ({ getGateSmartAccount: async () => ({ address: `0x${'aa'.repeat(20)}` }) }));

import { encodeCheckInCall, sendCheckIn } from './checkInOp';

const code = { v: 1 as const, gateId: '7', eventId: '42', issuedAt: 1_700_000_000, nonce: `0x${'ab'.repeat(32)}` as const,
  kx: `0x${'11'.repeat(32)}` as const, ky: `0x${'22'.repeat(32)}` as const, sig: `0x${'cd'.repeat(64)}` as const };
const response = { v: 1 as const, tokenId: '123', deviceSig: `0x${'ef'.repeat(64)}` as const };

describe('checkIn user operation', () => {
  it('encodes checkIn(tokenId, GateCode, deviceSig) with the struct field order from the master plan', () => {
    const { functionName, args } = decodeFunctionData({ abi: ticketAbi, data: encodeCheckInCall(code, response) });
    expect(functionName).toBe('checkIn');
    expect(args?.[0]).toBe(123n);
    expect(args?.[1]).toEqual({ gateId: 7n, eventId: 42n, issuedAt: 1_700_000_000n, nonce: code.nonce });
    expect(args?.[2]).toBe(response.deviceSig);
  });

  it('sends the call from the gate account with the event org as sponsor', async () => {
    await sendCheckIn({ code, response, orgId: 5n });
    const req = sendSponsoredOp.mock.calls[0][0] as { orgId: bigint; calls: Array<{ to: string }> };
    expect(req.orgId).toBe(5n);
    expect(req.calls).toHaveLength(1);
    expect(req.calls[0].to.toLowerCase()).toBe(String((await import('@monti/shared')).CONTRACTS.ticket).toLowerCase());
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm vitest run apps/web/src/staff/gate/checkInOp.test.ts` → FAIL, `Cannot find module './checkInOp'`.

- [ ] **Step 3: 구현을 쓴다**

```ts
// apps/web/src/staff/gate/checkInOp.ts
import { encodeFunctionData, type Hex } from 'viem';

import { CONTRACTS, ticketAbi, type GateCodeWire, type GateResponseWire } from '@monti/shared';

import { getGateSmartAccount } from '../../shared/chain/gateAccount';
import { sendSponsoredOp, type SponsoredOpHandle } from '../../shared/chain/sponsored';

export function encodeCheckInCall(code: GateCodeWire, response: GateResponseWire): Hex {
  return encodeFunctionData({
    abi: ticketAbi,
    functionName: 'checkIn',
    args: [
      BigInt(response.tokenId),
      {
        gateId: BigInt(code.gateId),
        eventId: BigInt(code.eventId),
        issuedAt: BigInt(code.issuedAt),
        nonce: code.nonce,
      },
      response.deviceSig,
    ],
  });
}

export interface SendCheckInParams {
  code: GateCodeWire;
  response: GateResponseWire;
  /** Ticket.eventOrg(eventId). 페이마스터가 이 예산 칸에서 차감한다. */
  orgId: bigint;
}

/** 체크인은 언제나 게이트 계정이 보낸다. 스태프 본인 패스키 계정이 아니다. */
export async function sendCheckIn(params: SendCheckInParams): Promise<SponsoredOpHandle> {
  const account = await getGateSmartAccount();
  return sendSponsoredOp({
    account,
    orgId: params.orgId,
    calls: [{ to: CONTRACTS.ticket, data: encodeCheckInCall(params.code, params.response) }],
  });
}
```

- [ ] **Step 4: 통과 확인**

Run: `pnpm vitest run apps/web/src/staff/gate/checkInOp.test.ts` → PASS, 2 passed.

- [ ] **Step 5: 커밋**

```bash
git add apps/web/src/staff/gate/checkInOp.ts apps/web/src/staff/gate/checkInOp.test.ts
git commit -m "feat(staff): send Ticket.checkIn as a sponsored user op from the gate account"
```

---

## Task 22: revert 사유 → DENY 코드 매핑

**Files:**
- Create: `apps/web/src/staff/gate/denyMap.ts`
- Test: `apps/web/src/staff/gate/denyMap.test.ts`

**Interfaces:**
- Consumes: `DenyCode` (Task 14)
- Produces: `mapRevertToDenyCode(revertReason?: Hex, message?: string): { code: DenyCode; detail: string }`, `DENY_LABELS: Record<DenyCode, string>` (10개). Task 23·29·30이 쓴다. 스펙 §13 DENY 행 + `EVENT_ENDED`.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

```ts
// apps/web/src/staff/gate/denyMap.test.ts
import { toFunctionSelector } from 'viem';
import { describe, expect, it } from 'vitest';

import { DENY_LABELS, mapRevertToDenyCode } from './denyMap';

const sel = (sig: string) => toFunctionSelector(sig);

describe('revert to DENY mapping (spec §13)', () => {
  it.each([
    ['AlreadyCheckedIn()', 'ALREADY_USED'],
    ['WrongEvent()', 'WRONG_EVENT'],
    ['TicketRevoked()', 'REVOKED'],
    ['CodeExpired()', 'EXPIRED_CODE'],
    ['NoSuchTicket()', 'NO_TICKET'],
    ['GateNotOpen()', 'GATE_CLOSED'],
    ['DeviceLocked()', 'DEVICE_LOCKED'],
    ['BadDeviceSignature()', 'DEVICE_MISMATCH'],
    ['EventEnded()', 'EVENT_ENDED'],
  ])('%s becomes %s', (sig, expected) => {
    expect(mapRevertToDenyCode(`${sel(sig)}${'00'.repeat(32)}`).code).toBe(expected);
  });

  it('EventNotPublished is a TX_FAILED with its own detail, not its own screen', () => {
    const r = mapRevertToDenyCode(`${sel('EventNotPublished()')}${'00'.repeat(32)}`);
    expect(r.code).toBe('TX_FAILED');
    expect(r.detail).toContain('공개');
  });

  it('falls back to TX_FAILED and keeps the raw reason visible to staff', () => {
    const r = mapRevertToDenyCode('0xdeadbeef', 'AA23 reverted (or OOG)');
    expect(r.code).toBe('TX_FAILED');
    expect(r.detail).toContain('AA23');
  });

  it('never invents an admit', () => {
    expect(mapRevertToDenyCode(undefined, undefined).code).toBe('TX_FAILED');
    expect(Object.keys(DENY_LABELS)).toHaveLength(10);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm vitest run apps/web/src/staff/gate/denyMap.test.ts` → FAIL, `Cannot find module './denyMap'`.

- [ ] **Step 3: 구현을 쓴다**

```ts
// apps/web/src/staff/gate/denyMap.ts
import { toFunctionSelector, type Hex } from 'viem';

import type { DenyCode } from '../types';

export const DENY_LABELS: Record<DenyCode, string> = {
  ALREADY_USED: '이미 입장',
  WRONG_EVENT: '다른 공연 티켓',
  REVOKED: '취소된 티켓',
  EXPIRED_CODE: '시간 초과 · 다시 대세요',
  NO_TICKET: '티켓 없음',
  GATE_CLOSED: '게이트가 닫혀 있음',
  EVENT_ENDED: '행사 종료',
  DEVICE_LOCKED: '기기 잠김',
  DEVICE_MISMATCH: '등록된 기기가 아님',
  TX_FAILED: '전송 실패',
};

/**
 * Ticket.sol 커스텀 에러 → 스태프 화면 코드. 01이 에러 이름을 바꾸면 Task 34가 잡는다.
 * 세 번째 칸은 기본 라벨 대신 쓸 상세 문구다 — 화면을 따로 만들 만큼 흔하지 않지만
 * 스태프가 원인을 알아야 하는 경우(EventNotPublished)에 쓴다.
 */
const SELECTORS: Array<[string, DenyCode, string?]> = [
  ['AlreadyCheckedIn()', 'ALREADY_USED'],
  ['WrongEvent()', 'WRONG_EVENT'],
  ['TicketRevoked()', 'REVOKED'],
  ['CodeExpired()', 'EXPIRED_CODE'],
  ['NoSuchTicket()', 'NO_TICKET'],
  ['ERC721NonexistentToken(uint256)', 'NO_TICKET'],
  ['GateNotOpen()', 'GATE_CLOSED'],
  ['EventEnded()', 'EVENT_ENDED'],
  ['DeviceLocked()', 'DEVICE_LOCKED'],
  ['BadDeviceSignature()', 'DEVICE_MISMATCH'],
  ['EventNotPublished()', 'TX_FAILED', '아직 공개되지 않은 공연입니다. 주최자에게 문의하세요.'],
];

const TABLE: Record<string, { code: DenyCode; detail: string }> = Object.fromEntries(
  SELECTORS.map(([sig, code, detail]) => [
    toFunctionSelector(sig).toLowerCase(),
    { code, detail: detail ?? DENY_LABELS[code] },
  ]),
);

export function mapRevertToDenyCode(revertReason?: Hex, message?: string): { code: DenyCode; detail: string } {
  if (revertReason && revertReason.length >= 10) {
    const hit = TABLE[revertReason.slice(0, 10).toLowerCase()];
    if (hit) return hit;
  }
  return { code: 'TX_FAILED', detail: message ?? revertReason ?? '원인 미상' };
}
```

- [ ] **Step 4: 통과 확인**

Run: `pnpm vitest run apps/web/src/staff/gate/denyMap.test.ts` → PASS, 13 passed.

- [ ] **Step 5: 커밋**

```bash
git add apps/web/src/staff/gate/denyMap.ts apps/web/src/staff/gate/denyMap.test.ts
git commit -m "feat(staff): map check-in revert reasons to the spec section 13 deny codes"
```

---

## Task 23: 게이트 상태 기계 — 2초 "확인 중", 5초 "다시 대세요", 소프트 승인 없음

**Files:**
- Create: `apps/web/src/staff/gate/machine.ts`
- Test: `apps/web/src/staff/gate/machine.test.ts`

**Interfaces:**
- Consumes: `GateState`·`DenyCode`·`PreflightResult` (Task 14), `CONFIRM_SPINNER_MS`·`RETAP_PROMPT_MS` (Task 10)
- Produces: `createGateMachine(deps): GateMachine` — `GateMachine = { state(): GateState; snapshot(): GateContext; onResponse(r): void; onPreflight(p): void; onSent(h): void; onVerdict(v): void; onTimeout(): void; reset(): void; subscribe(fn): () => void }`. Task 25가 쓴다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

```ts
// apps/web/src/staff/gate/machine.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createGateMachine } from './machine';

const base = { gateId: 7n, eventId: 42n, orgId: 5n };
const ticket = { tokenId: '123', account: `0x${'aa'.repeat(20)}` as const, deviceX: `0x${'11'.repeat(32)}` as const,
  deviceY: `0x${'22'.repeat(32)}` as const, photoJpegB64: 'x', displayName: '김입장', tier: 0, checkedIn: false, tierName: '일반', seat: '' };

describe('gate state machine', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('idle → ready → received → confirming → admit', () => {
    const m = createGateMachine(base);
    expect(m.state()).toBe('idle');
    m.onReady();
    expect(m.state()).toBe('ready');
    m.onResponse();
    expect(m.state()).toBe('received');
    m.onPreflight({ ok: true, ticket });
    m.onSent();
    expect(m.state()).toBe('confirming');
    m.onVerdict({ kind: 'admit', blockNumber: 99n, finalized: false });
    expect(m.state()).toBe('admit');
    expect(m.snapshot().finalized).toBe(false);
    m.onVerdict({ kind: 'admit', blockNumber: 99n, finalized: true });
    expect(m.snapshot().finalized).toBe(true);
  });

  it('a failed preflight denies without ever sending', () => {
    const m = createGateMachine(base);
    m.onReady();
    m.onResponse();
    m.onPreflight({ ok: false, deny: 'ALREADY_USED', ticket });
    expect(m.state()).toBe('deny');
    expect(m.snapshot().deny).toBe('ALREADY_USED');
  });

  it('never soft-admits: 5 s without a verdict becomes EXPIRED_CODE, not admit', () => {
    const m = createGateMachine(base);
    m.onReady(); m.onResponse(); m.onPreflight({ ok: true, ticket }); m.onSent();
    vi.advanceTimersByTime(2000);
    expect(m.state()).toBe('confirming');
    expect(m.snapshot().denyDetail).toBeUndefined();
    vi.advanceTimersByTime(3001);
    expect(m.state()).toBe('deny');
    expect(m.snapshot().deny).toBe('EXPIRED_CODE');
  });

  it('a double tap keeps the first verdict (T12)', () => {
    const m = createGateMachine(base);
    m.onReady(); m.onResponse(); m.onPreflight({ ok: true, ticket }); m.onSent();
    m.onVerdict({ kind: 'admit', blockNumber: 99n, finalized: true });
    m.onResponse();
    expect(m.state()).toBe('admit');
  });

  it('offlineAdmit is a state of its own, not admit', () => {
    const m = createGateMachine(base);
    m.onReady(); m.onResponse(); m.onPreflight({ ok: true, ticket });
    m.onOfflineAdmit(3);
    expect(m.state()).toBe('offlineAdmit');
    expect(m.snapshot().pendingCount).toBe(3);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm vitest run apps/web/src/staff/gate/machine.test.ts` → FAIL, `Cannot find module './machine'`.

- [ ] **Step 3: 구현을 쓴다**

```ts
// apps/web/src/staff/gate/machine.ts
import { CONFIRM_SPINNER_MS, RETAP_PROMPT_MS } from '../constants';
import type { DenyCode, GateContext, GateState, PreflightResult, SnapshotTicket } from '../types';

export type Verdict =
  | { kind: 'admit'; blockNumber: bigint; finalized: boolean }
  | { kind: 'deny'; code: DenyCode; detail: string };

export interface GateMachine {
  state(): GateState;
  snapshot(): GateContext;
  subscribe(listener: (ctx: GateContext) => void): () => void;
  onReady(): void;
  onResponse(): void;
  onPreflight(result: PreflightResult): void;
  onSent(): void;
  onVerdict(v: Verdict): void;
  onOfflineAdmit(pendingCount: number): void;
  onOverride(): void;
  reset(): void;
}

export interface GateMachineDeps {
  gateId: bigint;
  eventId: bigint;
  orgId: bigint;
}

/**
 * 스펙 §7.3: 2초까지 "확인 중", 5초를 넘으면 "다시 대세요".
 * 어떤 타임아웃도 admit 으로 가지 않는다 — 소프트 승인 금지가 이 파일의 핵심 불변식이다.
 */
export function createGateMachine(deps: GateMachineDeps): GateMachine {
  let ctx: GateContext = {
    state: 'idle', gateId: deps.gateId, eventId: deps.eventId, orgId: deps.orgId,
    finalized: false, pendingCount: 0, snapshotAgeMs: 0, online: true,
  };
  const listeners = new Set<(c: GateContext) => void>();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const emit = (patch: Partial<GateContext>) => {
    ctx = { ...ctx, ...patch };
    for (const l of listeners) l(ctx);
  };
  const clear = () => { if (timer) clearTimeout(timer); timer = undefined; };
  const settled = () => ctx.state === 'admit' || ctx.state === 'offlineAdmit' || ctx.state === 'deny';

  return {
    state: () => ctx.state,
    snapshot: () => ctx,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    onReady() { clear(); emit({ state: 'ready', deny: undefined, denyDetail: undefined, ticket: undefined, finalized: false }); },
    onResponse() {
      if (settled()) return; // 더블 탭은 첫 판정을 유지한다(T12)
      emit({ state: 'received' });
    },
    onPreflight(result: PreflightResult) {
      if (result.ok) { emit({ ticket: result.ticket as SnapshotTicket }); return; }
      clear();
      emit({ state: 'deny', deny: result.deny, ticket: result.ticket });
    },
    onSent() {
      emit({ state: 'confirming' });
      clear();
      timer = setTimeout(() => {
        // 5초가 지났다. 체인이 아직 말하지 않았으므로 승인하지 않는다.
        emit({ state: 'deny', deny: 'EXPIRED_CODE', denyDetail: '체인 응답이 없습니다. 다시 대세요.' });
      }, RETAP_PROMPT_MS);
    },
    onVerdict(v) {
      clear();
      if (v.kind === 'admit') emit({ state: 'admit', blockNumber: v.blockNumber, finalized: v.finalized });
      else emit({ state: 'deny', deny: v.code, denyDetail: v.detail });
    },
    onOfflineAdmit(pendingCount) { clear(); emit({ state: 'offlineAdmit', online: false, pendingCount }); },
    onOverride() { clear(); emit({ state: 'override' }); },
    reset() { clear(); emit({ state: 'ready', deny: undefined, denyDetail: undefined, ticket: undefined, blockNumber: undefined, finalized: false }); },
  };
}

/** 스피너를 언제까지 조용히 돌릴지. UI 가 읽는다. */
export const SPINNER_UNTIL_MS = CONFIRM_SPINNER_MS;
```

- [ ] **Step 4: 통과 확인**

Run: `pnpm vitest run apps/web/src/staff/gate/machine.test.ts` → PASS, 5 passed.

- [ ] **Step 5: 커밋**

```bash
git add apps/web/src/staff/gate/machine.ts apps/web/src/staff/gate/machine.test.ts
git commit -m "feat(staff): gate state machine that never soft-admits on timeout"
```

---

## Task 24: 체인 판정 — `CheckedIn` 구독과 `nonceHash` 매칭

**Files:**
- Create: `apps/web/src/staff/gate/verdict.ts`
- Test: `apps/web/src/staff/gate/verdict.test.ts`

**Interfaces:**
- Consumes: `subscribeLogs` (03, 가정), `ticketAbi`·`CONTRACTS` (02), `Verdict` (Task 23)
- Produces: `watchCheckedIn(p: { gateId: bigint; onVerdict: (v: Verdict, nonceHash: Hex) => void }): LogSubscription`, `nonceHashOf(nonce: Hex): Hex`. Task 25가 쓴다. 스펙 §7.2-8("추측 실행 단계에서 켜고, 확정되면 굳힌다").

- [ ] **Step 1: 실패하는 테스트를 쓴다**

```ts
// apps/web/src/staff/gate/verdict.test.ts
import { encodeAbiParameters, keccak256, numberToHex, toEventSelector } from 'viem';
import { describe, expect, it, vi } from 'vitest';

const subscribeLogs = vi.fn(() => () => {});
vi.mock('../../shared/chain/subscribeLogs', () => ({ subscribeLogs }));

import { nonceHashOf, watchCheckedIn } from './verdict';

const nonce = `0x${'ab'.repeat(32)}` as const;

describe('CheckedIn verdict subscription', () => {
  it('filters by the CheckedIn topic and the gateId in topic 3', () => {
    watchCheckedIn({ gateId: 7n, onVerdict: () => {} });
    const p = subscribeLogs.mock.calls[0][0] as { topics: unknown[] };
    expect(p.topics[0]).toBe(toEventSelector('CheckedIn(uint256,uint256,uint256,bytes32,uint64)'));
    expect(p.topics[1]).toBe(null);
    expect(p.topics[2]).toBe(null);
    expect(p.topics[3]).toBe(numberToHex(7n, { size: 32 }));
  });

  it('turns a speculative log into an unfinalized admit and a finalized log into a finalized one', () => {
    const seen: Array<[string, boolean, string]> = [];
    watchCheckedIn({ gateId: 7n, onVerdict: (v, h) => seen.push([v.kind, v.kind === 'admit' && v.finalized, h]) });
    const onLog = (subscribeLogs.mock.calls[0][0] as { onLog: (l: unknown) => void }).onLog;
    const data = encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint64' }], [nonceHashOf(nonce), 1_700_000_000n]);
    onLog({ topics: ['0x', '0x', '0x', numberToHex(7n, { size: 32 })], data, blockNumber: 99n, stage: 'speculative' });
    onLog({ topics: ['0x', '0x', '0x', numberToHex(7n, { size: 32 })], data, blockNumber: 99n, stage: 'finalized' });
    expect(seen).toEqual([['admit', false, keccak256(nonce)], ['admit', true, keccak256(nonce)]]);
  });

  it('nonceHash is keccak256 of the raw nonce', () => {
    expect(nonceHashOf(nonce)).toBe(keccak256(nonce));
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm vitest run apps/web/src/staff/gate/verdict.test.ts` → FAIL, `Cannot find module './verdict'`.

- [ ] **Step 3: 구현을 쓴다**

```ts
// apps/web/src/staff/gate/verdict.ts
import { decodeAbiParameters, keccak256, numberToHex, toEventSelector, type Hex } from 'viem';

import { CONTRACTS } from '@monti/shared';

import { subscribeLogs, type ChainLog, type LogSubscription } from '../../shared/chain/subscribeLogs';
import type { Verdict } from './machine';

const CHECKED_IN_TOPIC = toEventSelector('CheckedIn(uint256,uint256,uint256,bytes32,uint64)');

/** 컨트랙트가 이벤트에 싣는 값. 우리가 보낸 nonce 와 대조하는 유일한 열쇠다. */
export function nonceHashOf(nonce: Hex): Hex {
  return keccak256(nonce);
}

export interface WatchCheckedInParams {
  gateId: bigint;
  onVerdict: (verdict: Verdict, nonceHash: Hex) => void;
}

/**
 * monadLogs 로 이 게이트의 CheckedIn 만 본다. topic0 = 이벤트, topic3 = gateId(indexed).
 * 추측(speculative) 단계에서 초록을 켜고, finalized 가 같은 로그를 다시 주면 굳힌다(스펙 §7.2-8).
 */
export function watchCheckedIn(params: WatchCheckedInParams): LogSubscription {
  return subscribeLogs({
    address: CONTRACTS.ticket,
    topics: [CHECKED_IN_TOPIC, null, null, numberToHex(params.gateId, { size: 32 })],
    onLog(log: ChainLog) {
      const [nonceHash] = decodeAbiParameters([{ type: 'bytes32' }, { type: 'uint64' }], log.data) as [Hex, bigint];
      params.onVerdict(
        { kind: 'admit', blockNumber: log.blockNumber, finalized: log.stage === 'finalized' },
        nonceHash,
      );
    },
  });
}
```

- [ ] **Step 4: 통과 확인**

Run: `pnpm vitest run apps/web/src/staff/gate/verdict.test.ts` → PASS, 3 passed.

- [ ] **Step 5: 커밋**

```bash
git add apps/web/src/staff/gate/verdict.ts apps/web/src/staff/gate/verdict.test.ts
git commit -m "feat(staff): subscribe to CheckedIn for this gate and match by nonceHash"
```

---

## Task 25: 스냅샷 — 정규 JSON, `attesterSig` 검증, IndexedDB 저장과 10분 갱신

**Files:**
- Create: `apps/web/src/staff/snapshot/verify.ts`, `apps/web/src/staff/snapshot/store.ts`
- Test: `apps/web/src/staff/snapshot/verify.test.ts`, `apps/web/src/staff/snapshot/store.test.ts`

**Interfaces:**
- Consumes: `canonicalJson`·`snapshotDigest` (**02 `packages/shared/src/encoding.ts`, 로컬에 다시 구현하지 않는다**), `issueSnapshot({ eventId, gateAccount })` (02 callable, **스태프 본인 Firebase 세션으로 인증**), `getGateAddress()` (Task 13), `ATTESTER_ADDRESS` (02 상수 — 마스터 플랜 Reconciliation 이 `Identity.attester()` view 와 함께 이 상수도 규정한다. 오프라인 검증이라 상수로 읽는다), `STAFF_DB_NAME`·`SNAPSHOT_REFRESH_MS` (Task 10)
- Produces: `snapshotBody(s: SnapshotWire): Omit<SnapshotWire, 'attesterSig'>`, `verifySnapshot(s: SnapshotWire): Promise<boolean>`, `loadSnapshot(eventId: string): Promise<SnapshotWire | undefined>`, `refreshSnapshot(eventId: string, gateAccount: Address): Promise<SnapshotWire>`, `startSnapshotRefresh(eventId: string, gateAccount: Address): () => void`. `gateAccount` 는 게이트 스마트 계정 주소이고 인증 주체가 아니다 — 서버는 로그인한 스태프가 이 공연 org 의 매니저·관리자인지, 그리고 이 `gateAccount` 가 그 공연의 등록된 게이트인지를 함께 검사한다. Task 20·30이 쓴다. 스펙 §12.

- [ ] **Step 1: 검증 테스트를 쓴다**

```ts
// apps/web/src/staff/snapshot/verify.test.ts
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it, vi } from 'vitest';

const account = privateKeyToAccount(`0x${'11'.repeat(32)}`);
vi.mock('@monti/shared', async (orig) => ({ ...(await orig<Record<string, unknown>>()), ATTESTER_ADDRESS: account.address }));

import { snapshotDigest } from '@monti/shared';

import { snapshotBody, verifySnapshot } from './verify';

const body = {
  v: 1 as const, eventId: '42', eventTitle: '가을 밤 콘서트', requireKyc: true, epoch: 3, expiresAt: 2_000_000_000,
  tickets: [{ tokenId: '1', account: `0x${'aa'.repeat(20)}` as const, deviceX: `0x${'11'.repeat(32)}` as const,
    deviceY: `0x${'22'.repeat(32)}` as const, photoJpegB64: 'x', displayName: '김입장', tier: 0, checkedIn: false, tierName: '일반', seat: '' }],
};

describe('snapshot attester signature', () => {
  it('snapshotBody strips attesterSig before the digest is taken', () => {
    expect(snapshotBody({ ...body, attesterSig: '0xdeadbeef' })).toEqual(body);
    expect(snapshotDigest(snapshotBody({ ...body, attesterSig: '0xdeadbeef' }))).toBe(snapshotDigest(body));
  });

  it('the shared canonicaliser lowercases 0x strings, so hex case cannot change the digest', () => {
    const upper = { ...body, tickets: [{ ...body.tickets[0], account: `0x${'AA'.repeat(20)}` as const }] };
    expect(snapshotDigest(snapshotBody({ ...upper, attesterSig: '0x' }))).toBe(snapshotDigest(body));
  });

  it('the shared canonicaliser rejects a non-integer number rather than rounding it', () => {
    expect(() => snapshotDigest(snapshotBody({ ...body, epoch: 3.5, attesterSig: '0x' } as never))).toThrow();
  });

  it('accepts a signature by the attester and rejects anyone else', async () => {
    const signature = await account.sign({ hash: snapshotDigest(body) });
    expect(await verifySnapshot({ ...body, attesterSig: signature })).toBe(true);
    const other = privateKeyToAccount(`0x${'22'.repeat(32)}`);
    const bad = await other.sign({ hash: snapshotDigest(body) });
    expect(await verifySnapshot({ ...body, attesterSig: bad })).toBe(false);
  });

  it('rejects a snapshot whose tickets were edited after signing', async () => {
    const signature = await account.sign({ hash: snapshotDigest(body) });
    const tampered = { ...body, tickets: [{ ...body.tickets[0], checkedIn: true }], attesterSig: signature };
    expect(await verifySnapshot(tampered)).toBe(false);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm vitest run apps/web/src/staff/snapshot/verify.test.ts` → FAIL, `Cannot find module './verify'`.

- [ ] **Step 3: 정규화와 검증을 쓴다**

```ts
// apps/web/src/staff/snapshot/verify.ts
import { recoverAddress } from 'viem';

import { ATTESTER_ADDRESS, snapshotDigest, type SnapshotWire } from '@monti/shared';

/**
 * 정규화와 다이제스트는 02의 `packages/shared/src/encoding.ts` 가 소유한다.
 * 단말기가 같은 규칙을 다시 구현하면 발급자와 검증자가 조용히 갈라지므로 절대 복제하지 않는다.
 * `snapshotDigest` 는 **attesterSig 가 빠진 객체**를 받으므로 여기서 먼저 떼어 낸다.
 */
export function snapshotBody(snapshot: SnapshotWire): Omit<SnapshotWire, 'attesterSig'> {
  const { attesterSig: _drop, ...body } = snapshot;
  return body;
}

/**
 * 확인 서명 키(어테스터)의 secp256k1 서명을 복구해 주소를 대조한다.
 * 마스터 플랜 Reconciliation 이 Identity.attester() view 와 ATTESTER_ADDRESS 상수를 둘 다 규정한다. 오프라인에서도 검증해야 하므로 packages/shared 상수에서 읽는다.
 * 01이 그 view 를 추가하면 여기를 eth_call 로 바꾼다(Task 34가 확인).
 */
export async function verifySnapshot(snapshot: SnapshotWire): Promise<boolean> {
  try {
    const recovered = await recoverAddress({
      hash: snapshotDigest(snapshotBody(snapshot)),
      signature: snapshot.attesterSig,
    });
    return recovered.toLowerCase() === ATTESTER_ADDRESS.toLowerCase();
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: 저장소 테스트를 쓴다**

```ts
// apps/web/src/staff/snapshot/store.test.ts
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const issueSnapshot = vi.fn();
vi.mock('../../shared/api/functions', () => ({ issueSnapshot }));
vi.mock('./verify', async (orig) => ({ ...(await orig<Record<string, unknown>>()), verifySnapshot: async () => true }));

import { loadSnapshot, refreshSnapshot, startSnapshotRefresh } from './store';

const snap = { v: 1 as const, eventId: '42', eventTitle: '가을 밤 콘서트', requireKyc: true, epoch: 1, expiresAt: 2_000_000_000, tickets: [], attesterSig: '0x00' as const };
const GATE = `0x${'aa'.repeat(20)}` as const;

describe('snapshot store', () => {
  beforeEach(() => { vi.useFakeTimers(); issueSnapshot.mockReset().mockResolvedValue(snap); });
  afterEach(() => vi.useRealTimers());

  it('fetches, verifies and persists so a restart finds it offline', async () => {
    await refreshSnapshot('42', GATE);
    expect(await loadSnapshot('42')).toEqual(snap);
  });

  it('sends both eventId and gateAccount so the backend can authorise the staff session', async () => {
    await refreshSnapshot('42', GATE);
    expect(issueSnapshot).toHaveBeenCalledWith({ eventId: '42', gateAccount: GATE });
  });

  it('refreshes every 10 minutes and stops when disposed', async () => {
    const stop = startSnapshotRefresh('42', GATE);
    await vi.advanceTimersByTimeAsync(600_000 * 2);
    expect(issueSnapshot).toHaveBeenCalledTimes(3);
    stop();
    await vi.advanceTimersByTimeAsync(600_000 * 2);
    expect(issueSnapshot).toHaveBeenCalledTimes(3);
  });

  it('keeps the last good snapshot when a refresh fails offline', async () => {
    await refreshSnapshot('42', GATE);
    issueSnapshot.mockRejectedValueOnce(new Error('offline'));
    await expect(refreshSnapshot('42', GATE)).rejects.toThrow('offline');
    expect(await loadSnapshot('42')).toEqual(snap);
  });

  it('propagates a permission-denied from the callable instead of pretending to be offline', async () => {
    issueSnapshot.mockRejectedValueOnce(Object.assign(new Error('permission-denied'), { code: 'functions/permission-denied' }));
    await expect(refreshSnapshot('42', GATE)).rejects.toThrow('permission-denied');
  });
});
```

- [ ] **Step 5: 저장소를 쓴다**

```ts
// apps/web/src/staff/snapshot/store.ts
import { openDB, type IDBPDatabase } from 'idb';
import type { Address } from 'viem';

import type { SnapshotWire } from '@monti/shared';

import { issueSnapshot } from '../../shared/api/functions';
import { SNAPSHOT_REFRESH_MS, STAFF_DB_NAME, STAFF_DB_VERSION } from '../constants';
import { verifySnapshot } from './verify';

interface StoredSnapshot {
  eventId: string;
  snapshot: SnapshotWire;
  fetchedAt: number;
}

let dbPromise: Promise<IDBPDatabase> | null = null;

export function staffDb(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(STAFF_DB_NAME, STAFF_DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('snapshots')) db.createObjectStore('snapshots', { keyPath: 'eventId' });
        if (!db.objectStoreNames.contains('queue')) db.createObjectStore('queue', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'key' });
      },
    });
  }
  return dbPromise;
}

export async function loadSnapshot(eventId: string): Promise<SnapshotWire | undefined> {
  const row = (await (await staffDb()).get('snapshots', eventId)) as StoredSnapshot | undefined;
  return row?.snapshot;
}

export async function snapshotAgeMs(eventId: string, now = Date.now()): Promise<number> {
  const row = (await (await staffDb()).get('snapshots', eventId)) as StoredSnapshot | undefined;
  return row ? now - row.fetchedAt : Number.POSITIVE_INFINITY;
}

/**
 * 실패하면 던진다. 저장된 직전 스냅샷은 그대로 남는다(오프라인에서 계속 쓴다).
 *
 * 인증 주체는 **이 단말기에 패스키로 로그인한 스태프의 Firebase 세션**이다. 게이트 기기 계정이 아니다.
 * `gateAccount` 는 서버가 "이 게이트가 이 공연에 등록돼 있는가"를 확인하고 감사 로그에 남기기 위한
 * 값이며, 그 자체로 권한을 주지 않는다. 그래서 단말기를 훔쳐도 사진이 새어 나가지 않는다.
 * permission-denied 는 오프라인이 아니라 권한 문제이므로 그대로 올려 보낸다.
 */
export async function refreshSnapshot(eventId: string, gateAccount: Address): Promise<SnapshotWire> {
  const snapshot = await issueSnapshot({ eventId, gateAccount });
  if (!(await verifySnapshot(snapshot))) throw new Error('snapshot attester signature is invalid');
  await (await staffDb()).put('snapshots', { eventId, snapshot, fetchedAt: Date.now() } satisfies StoredSnapshot);
  return snapshot;
}

/** 게이트를 열 때 한 번, 그 뒤 10분마다(스펙 §12). */
export function startSnapshotRefresh(eventId: string, gateAccount: Address): () => void {
  void refreshSnapshot(eventId, gateAccount).catch(() => undefined);
  const timer = setInterval(
    () => { void refreshSnapshot(eventId, gateAccount).catch(() => undefined); },
    SNAPSHOT_REFRESH_MS,
  );
  return () => clearInterval(timer);
}
```

- [ ] **Step 6: 통과 확인**

```bash
pnpm --filter @monti/web add idb
pnpm --filter @monti/web add -D fake-indexeddb
pnpm vitest run apps/web/src/staff/snapshot
```

Expected: PASS — 2 files, 10 passed.

- [ ] **Step 7: 커밋**

```bash
git add apps/web/src/staff/snapshot apps/web/package.json pnpm-lock.yaml
git commit -m "feat(staff): verify the attester-signed snapshot with the shared canonicaliser and cache it"
```

---

## Task 26: 오프라인 감지

**Files:**
- Create: `apps/web/src/staff/net/online.ts`
- Test: `apps/web/src/staff/net/online.test.ts`

**Interfaces:**
- Consumes: `getPublicClient()` (03)
- Produces: `createOnlineWatcher(p?: { probeMs?: number }): { online(): boolean; subscribe(fn: (online: boolean) => void): () => void; stop(): void }`. Task 27·28·29가 쓴다. 스펙 §12, T10.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

```ts
// apps/web/src/staff/net/online.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getBlockNumber = vi.fn();
vi.mock('../../shared/chain/client', () => ({ getPublicClient: () => ({ getBlockNumber }) }));

import { createOnlineWatcher } from './online';

describe('online watcher', () => {
  beforeEach(() => { vi.useFakeTimers(); getBlockNumber.mockReset().mockResolvedValue(1n); });
  afterEach(() => vi.useRealTimers());

  it('goes offline when the RPC probe fails and back online when it recovers', async () => {
    const seen: boolean[] = [];
    const w = createOnlineWatcher({ probeMs: 5000 });
    w.subscribe((o) => seen.push(o));
    getBlockNumber.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await vi.advanceTimersByTimeAsync(5000);
    expect(w.online()).toBe(false);
    await vi.advanceTimersByTimeAsync(5000);
    expect(w.online()).toBe(true);
    expect(seen).toEqual([false, true]);
    w.stop();
  });

  it('browser offline events win immediately without waiting for a probe', () => {
    const w = createOnlineWatcher({ probeMs: 5000 });
    window.dispatchEvent(new Event('offline'));
    expect(w.online()).toBe(false);
    window.dispatchEvent(new Event('online'));
    expect(w.online()).toBe(true);
    w.stop();
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm vitest run apps/web/src/staff/net/online.test.ts` → FAIL, `Cannot find module './online'`.

- [ ] **Step 3: 구현을 쓴다**

```ts
// apps/web/src/staff/net/online.ts
import { getPublicClient } from '../../shared/chain/client';

export interface OnlineWatcher {
  online(): boolean;
  subscribe(listener: (online: boolean) => void): () => void;
  stop(): void;
}

/**
 * navigator.onLine 만으로는 부족하다. 공연장 Wi-Fi 는 붙어 있는데 RPC 만 죽는 경우가 흔하다(T10).
 * 그래서 브라우저 이벤트와 실제 getBlockNumber 프로브를 둘 다 본다.
 */
export function createOnlineWatcher(params: { probeMs?: number } = {}): OnlineWatcher {
  const probeMs = params.probeMs ?? 5000;
  let state = true;
  const listeners = new Set<(o: boolean) => void>();

  const set = (next: boolean) => {
    if (next === state) return;
    state = next;
    for (const l of listeners) l(state);
  };

  const onOffline = () => set(false);
  const onOnline = () => set(true);
  window.addEventListener('offline', onOffline);
  window.addEventListener('online', onOnline);

  const timer = setInterval(() => {
    void getPublicClient().getBlockNumber().then(() => set(true)).catch(() => set(false));
  }, probeMs);

  return {
    online: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    stop() {
      clearInterval(timer);
      window.removeEventListener('offline', onOffline);
      window.removeEventListener('online', onOnline);
      listeners.clear();
    },
  };
}
```

- [ ] **Step 4: 통과 확인**

Run: `pnpm vitest run apps/web/src/staff/net/online.test.ts` → PASS, 2 passed.

- [ ] **Step 5: 커밋**

```bash
git add apps/web/src/staff/net apps/web/src/staff/net/online.test.ts
git commit -m "feat(staff): detect offline from browser events and an RPC probe"
```

---

## Task 27: 오프라인 로컬 검증 — 스냅샷 기기 키로 P-256 확인

**Files:**
- Create: `apps/web/src/staff/snapshot/offlineVerify.ts`
- Test: `apps/web/src/staff/snapshot/offlineVerify.test.ts`

**Interfaces:**
- Consumes: `@noble/curves/p256`, `preflight` (Task 20), `SnapshotTicket` (Task 14)
- Produces: `checkInDigest(tokenId, gateId, eventId, nonce, issuedAt): Hex`, `verifyDeviceSignatureOffline(p: { ticket: SnapshotTicket; code: GateCodeWire; response: GateResponseWire }): boolean`. Task 28이 `offlineAdmit` 전에 반드시 부른다. 스펙 §12, T15.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

```ts
// apps/web/src/staff/snapshot/offlineVerify.test.ts
import { p256 } from '@noble/curves/p256';
import { bytesToHex, encodeAbiParameters, hexToBytes, sha256 } from 'viem';
import { describe, expect, it } from 'vitest';

import { checkInDigest, verifyDeviceSignatureOffline } from './offlineVerify';

const priv = hexToBytes(`0x${'77'.repeat(32)}`);
const pub = p256.getPublicKey(priv, false);
const code = { v: 1 as const, gateId: '7', eventId: '42', issuedAt: 1_700_000_000, nonce: `0x${'ab'.repeat(32)}` as const,
  kx: '0x00' as const, ky: '0x00' as const, sig: '0x00' as const };
const ticket = { tokenId: '123', account: `0x${'aa'.repeat(20)}` as const,
  deviceX: bytesToHex(pub.slice(1, 33)), deviceY: bytesToHex(pub.slice(33, 65)),
  photoJpegB64: 'x', displayName: '김입장', tier: 0, checkedIn: false, tierName: '일반', seat: '' };

function sign() {
  const sig = p256.sign(hexToBytes(checkInDigest(123n, 7n, 42n, code.nonce, 1_700_000_000)), priv, { prehash: false });
  return `0x${sig.r.toString(16).padStart(64, '0')}${sig.s.toString(16).padStart(64, '0')}` as const;
}

describe('offline device-signature verification', () => {
  it('digests exactly what the contract digests', () => {
    expect(checkInDigest(123n, 7n, 42n, code.nonce, 1_700_000_000)).toBe(
      sha256(encodeAbiParameters(
        [{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bytes32' }, { type: 'uint64' }],
        [123n, 7n, 42n, code.nonce, 1_700_000_000n],
      )),
    );
  });

  it('accepts a real signature by the snapshot device key', () => {
    expect(verifyDeviceSignatureOffline({ ticket, code, response: { v: 1, tokenId: '123', deviceSig: sign() } })).toBe(true);
  });

  it('rejects the same signature against a different device key (T15: the terminal cannot forge one)', () => {
    const otherPub = p256.getPublicKey(hexToBytes(`0x${'88'.repeat(32)}`), false);
    const wrong = { ...ticket, deviceX: bytesToHex(otherPub.slice(1, 33)), deviceY: bytesToHex(otherPub.slice(33, 65)) };
    expect(verifyDeviceSignatureOffline({ ticket: wrong, code, response: { v: 1, tokenId: '123', deviceSig: sign() } })).toBe(false);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm vitest run apps/web/src/staff/snapshot/offlineVerify.test.ts` → FAIL, `Cannot find module './offlineVerify'`.

- [ ] **Step 3: 구현을 쓴다**

```ts
// apps/web/src/staff/snapshot/offlineVerify.ts
import { p256 } from '@noble/curves/p256';
import { encodeAbiParameters, hexToBytes, sha256, type Hex } from 'viem';

import type { GateCodeWire, GateResponseWire } from '@monti/shared';

import type { SnapshotTicket } from '../types';

/** 마스터 플랜의 Ticket.checkIn 주석과 같은 순서·타입이어야 한다. */
export function checkInDigest(
  tokenId: bigint, gateId: bigint, eventId: bigint, nonce: Hex, issuedAt: number,
): Hex {
  return sha256(
    encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bytes32' }, { type: 'uint64' }],
      [tokenId, gateId, eventId, nonce, BigInt(issuedAt)],
    ),
  );
}

export interface OfflineVerifyParams {
  ticket: SnapshotTicket;
  code: GateCodeWire;
  response: GateResponseWire;
}

/**
 * 인터넷이 없을 때 컨트랙트 검사 ②를 단말기가 대신한다.
 * 큐에 쌓인 트랜잭션은 복구 후 체인이 같은 검사를 다시 하므로, 여기서 통과해도
 * 단말기 혼자서는 아무것도 위조하지 못한다(T15).
 */
export function verifyDeviceSignatureOffline({ ticket, code, response }: OfflineVerifyParams): boolean {
  try {
    const digest = hexToBytes(
      checkInDigest(BigInt(response.tokenId), BigInt(code.gateId), BigInt(code.eventId), code.nonce, code.issuedAt),
    );
    const publicKey = hexToBytes(`0x04${ticket.deviceX.slice(2)}${ticket.deviceY.slice(2)}`);
    const signature = hexToBytes(response.deviceSig);
    return p256.verify(signature, digest, publicKey, { prehash: false });
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: 통과 확인**

Run: `pnpm vitest run apps/web/src/staff/snapshot/offlineVerify.test.ts` → PASS, 3 passed.

- [ ] **Step 5: 커밋**

```bash
git add apps/web/src/staff/snapshot/offlineVerify.ts apps/web/src/staff/snapshot/offlineVerify.test.ts
git commit -m "feat(staff): verify the attendee device signature locally with noble P-256"
```

---

## Task 28: 내구 큐 — IndexedDB 저장, 재접속 시 백오프 재시도

**Files:**
- Create: `apps/web/src/staff/queue/opQueue.ts`
- Test: `apps/web/src/staff/queue/opQueue.test.ts`

**Interfaces:**
- Consumes: `staffDb()` (Task 25), `sendCheckIn` (Task 21), `QueueEntry` (Task 14), `OnlineWatcher` (Task 26)
- Produces: `enqueueCheckIn(p: { code; response; orgId }): Promise<QueueEntry>`, `pendingCount(): Promise<number>`, `drainQueue(p: { orgId: bigint; now?: number }): Promise<QueueEntry[]>`, `backoffMs(attempts: number): number`. Task 29·30이 쓴다. 스펙 §12, T9.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

```ts
// apps/web/src/staff/queue/opQueue.test.ts
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sendCheckIn = vi.fn();
vi.mock('../gate/checkInOp', () => ({ sendCheckIn }));

import { backoffMs, drainQueue, enqueueCheckIn, pendingCount } from './opQueue';

const code = { v: 1 as const, gateId: '7', eventId: '42', issuedAt: 1_700_000_000, nonce: `0x${'ab'.repeat(32)}` as const,
  kx: '0x00' as const, ky: '0x00' as const, sig: '0x00' as const };
const response = { v: 1 as const, tokenId: '123', deviceSig: `0x${'ef'.repeat(64)}` as const };

describe('durable check-in queue', () => {
  beforeEach(() => { sendCheckIn.mockReset(); });

  it('survives a reload because it lives in IndexedDB', async () => {
    await enqueueCheckIn({ code, response: { ...response, tokenId: `${Date.now()}` }, orgId: 5n });
    expect(await pendingCount()).toBeGreaterThan(0);
  });

  it('backs off exponentially and caps at 30 s', () => {
    expect(backoffMs(0)).toBe(1000);
    expect(backoffMs(3)).toBe(8000);
    expect(backoffMs(10)).toBe(30_000);
  });

  it('marks an entry confirmed when the op succeeds and leaves failures for the next drain', async () => {
    const entry = await enqueueCheckIn({ code, response: { ...response, tokenId: '777' }, orgId: 5n });
    sendCheckIn.mockResolvedValueOnce({ userOpHash: '0xfeed', wait: async (_t?: number) => ({ success: true, blockNumber: 9n, txHash: '0xabc' }) });
    const after = await drainQueue({ orgId: 5n, now: entry.nextAttemptAt });
    expect(after.find((e) => e.id === entry.id)?.status).toBe('confirmed');

    const second = await enqueueCheckIn({ code, response: { ...response, tokenId: '778' }, orgId: 5n });
    sendCheckIn.mockRejectedValueOnce(new Error('bundler unreachable'));
    const after2 = await drainQueue({ orgId: 5n, now: second.nextAttemptAt });
    const row = after2.find((e) => e.id === second.id);
    expect(row?.status).toBe('pending');
    expect(row?.attempts).toBe(1);
    expect(row?.nextAttemptAt).toBeGreaterThan(second.nextAttemptAt);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm vitest run apps/web/src/staff/queue/opQueue.test.ts` → FAIL, `Cannot find module './opQueue'`.

- [ ] **Step 3: 구현을 쓴다**

```ts
// apps/web/src/staff/queue/opQueue.ts
import type { GateCodeWire, GateResponseWire } from '@monti/shared';

import { sendCheckIn } from '../gate/checkInOp';
import { staffDb } from '../snapshot/store';
import type { QueueEntry } from '../types';

export function backoffMs(attempts: number): number {
  return Math.min(30_000, 1000 * 2 ** attempts);
}

export interface EnqueueParams {
  code: GateCodeWire;
  response: GateResponseWire;
  orgId: bigint;
}

export async function enqueueCheckIn(params: EnqueueParams): Promise<QueueEntry> {
  const now = Date.now();
  const entry: QueueEntry = {
    id: `${params.response.tokenId}-${params.code.nonce}`,
    tokenId: params.response.tokenId,
    gateCode: params.code,
    response: params.response,
    createdAt: now,
    attempts: 0,
    nextAttemptAt: now,
    status: 'pending',
  };
  await (await staffDb()).put('queue', entry);
  return entry;
}

export async function allEntries(): Promise<QueueEntry[]> {
  return (await (await staffDb()).getAll('queue')) as QueueEntry[];
}

export async function pendingCount(): Promise<number> {
  return (await allEntries()).filter((e) => e.status === 'pending').length;
}

/**
 * 재접속 시 한 번 돌린다. 한 건이라도 실패하면 그 건만 백오프를 늘리고 나머지는 계속 간다.
 * 큐의 트랜잭션에는 관객 기기 키 서명이 들어 있어, 단말기가 혼자 만들어낼 수 없다(T15).
 */
export async function drainQueue(params: { orgId: bigint; now?: number }): Promise<QueueEntry[]> {
  const now = params.now ?? Date.now();
  const db = await staffDb();
  for (const entry of await allEntries()) {
    if (entry.status !== 'pending' || entry.nextAttemptAt > now) continue;
    try {
      const handle = await sendCheckIn({ code: entry.gateCode, response: entry.response, orgId: params.orgId });
      const receipt = await handle.wait(20_000);
      await db.put('queue', {
        ...entry,
        attempts: entry.attempts + 1,
        userOpHash: handle.userOpHash,
        status: receipt.success ? 'confirmed' : 'failed',
        lastError: receipt.success ? undefined : receipt.revertReason,
      } satisfies QueueEntry);
    } catch (e) {
      const attempts = entry.attempts + 1;
      await db.put('queue', {
        ...entry,
        attempts,
        nextAttemptAt: now + backoffMs(attempts),
        lastError: e instanceof Error ? e.message : String(e),
      } satisfies QueueEntry);
    }
  }
  return allEntries();
}
```

- [ ] **Step 4: 통과 확인**

Run: `pnpm vitest run apps/web/src/staff/queue/opQueue.test.ts` → PASS, 3 passed.

- [ ] **Step 5: 커밋**

```bash
git add apps/web/src/staff/queue/opQueue.ts apps/web/src/staff/queue/opQueue.test.ts
git commit -m "feat(staff): durable IndexedDB check-in queue with exponential backoff"
```

---

## Task 29: 재전송 대사 — `ALREADY_USED` 충돌 기록과 대기 화면

**Files:**
- Create: `apps/web/src/staff/queue/reconcile.ts`, `apps/web/src/staff/queue/QueueScreen.tsx`
- Test: `apps/web/src/staff/queue/reconcile.test.ts`

**Interfaces:**
- Consumes: `drainQueue`·`allEntries` (Task 28), `mapRevertToDenyCode` (Task 22), `ticketAbi`·`CONTRACTS` (02)
- Produces: `reconcileQueue(p: { orgId: bigint }): Promise<ReconcileReport>`, `ReconcileReport = { confirmed: number; conflicts: Array<{ tokenId: string; firstGateId: string; firstTs: number }>; failed: number }`. Task 30이 화면에 띄운다. 스펙 §12("고립된 단말기끼리 이중 입장 — 수용·기록·사후 대사").

- [ ] **Step 1: 실패하는 테스트를 쓴다**

```ts
// apps/web/src/staff/queue/reconcile.test.ts
import 'fake-indexeddb/auto';
import { toFunctionSelector } from 'viem';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const drainQueue = vi.fn();
const readContract = vi.fn();
vi.mock('./opQueue', async (orig) => ({ ...(await orig<Record<string, unknown>>()), drainQueue }));
vi.mock('../../shared/chain/client', () => ({ getPublicClient: () => ({ readContract }) }));

import { reconcileQueue } from './reconcile';

const base = { gateCode: {}, response: {}, createdAt: 0, attempts: 1, nextAttemptAt: 0 } as never;

describe('queue reconciliation', () => {
  beforeEach(() => { drainQueue.mockReset(); readContract.mockReset(); });

  it('reports an ALREADY_USED replay as a conflict with the winning check-in', async () => {
    drainQueue.mockResolvedValue([
      { ...base, id: 'a', tokenId: '123', status: 'failed', lastError: `${toFunctionSelector('AlreadyCheckedIn()')}${'00'.repeat(32)}` },
      { ...base, id: 'b', tokenId: '124', status: 'confirmed' },
    ]);
    readContract.mockResolvedValue({ gateId: 9n, ts: 1_700_000_500n, nonceHash: '0x00', manual: false });
    const report = await reconcileQueue({ orgId: 5n });
    expect(report.confirmed).toBe(1);
    expect(report.conflicts).toEqual([{ tokenId: '123', firstGateId: '9', firstTs: 1_700_000_500 }]);
    expect(report.failed).toBe(0);
  });

  it('counts any other failure as failed, never as admitted', async () => {
    drainQueue.mockResolvedValue([{ ...base, id: 'c', tokenId: '125', status: 'failed', lastError: '0xdeadbeef' }]);
    const report = await reconcileQueue({ orgId: 5n });
    expect(report.failed).toBe(1);
    expect(report.conflicts).toEqual([]);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm vitest run apps/web/src/staff/queue/reconcile.test.ts` → FAIL, `Cannot find module './reconcile'`.

- [ ] **Step 3: 구현을 쓴다**

```ts
// apps/web/src/staff/queue/reconcile.ts
import { CONTRACTS, ticketAbi } from '@monti/shared';

import { getPublicClient } from '../../shared/chain/client';
import { mapRevertToDenyCode } from '../gate/denyMap';
import { staffDb } from '../snapshot/store';
import type { QueueEntry } from '../types';
import { drainQueue } from './opQueue';

export interface ReconcileReport {
  confirmed: number;
  conflicts: Array<{ tokenId: string; firstGateId: string; firstTs: number }>;
  failed: number;
}

/**
 * 고립된 두 단말기가 같은 티켓을 오프라인 승인했을 수 있다(스펙 §12는 이를 수용하고 기록하라고 한다).
 * 재전송에서 ALREADY_USED 가 나오면 체인의 checkInOf 를 읽어 "누가 먼저였는지"를 남긴다.
 * 이미 들여보낸 사람을 되돌릴 수는 없으므로, 우리가 하는 일은 정직한 기록뿐이다.
 */
export async function reconcileQueue(params: { orgId: bigint }): Promise<ReconcileReport> {
  const entries = (await drainQueue({ orgId: params.orgId })) as QueueEntry[];
  const db = await staffDb();
  const report: ReconcileReport = { confirmed: 0, conflicts: [], failed: 0 };

  for (const entry of entries) {
    if (entry.status === 'confirmed') { report.confirmed += 1; continue; }
    if (entry.status !== 'failed') continue;
    const { code } = mapRevertToDenyCode(entry.lastError as `0x${string}` | undefined);
    if (code !== 'ALREADY_USED') { report.failed += 1; continue; }
    const onChain = (await getPublicClient().readContract({
      address: CONTRACTS.ticket, abi: ticketAbi, functionName: 'checkInOf', args: [BigInt(entry.tokenId)],
    })) as { gateId: bigint; ts: bigint };
    report.conflicts.push({ tokenId: entry.tokenId, firstGateId: onChain.gateId.toString(), firstTs: Number(onChain.ts) });
    await db.put('queue', { ...entry, status: 'conflict' } satisfies QueueEntry);
  }
  return report;
}
```

```tsx
// apps/web/src/staff/queue/QueueScreen.tsx
import { useEffect, useState } from 'react';

import { allEntries } from './opQueue';
import { reconcileQueue, type ReconcileReport } from './reconcile';
import type { QueueEntry } from '../types';

export function QueueScreen() {
  const [entries, setEntries] = useState<QueueEntry[]>([]);
  const [report, setReport] = useState<ReconcileReport>();

  useEffect(() => { void allEntries().then(setEntries); }, [report]);

  return (
    <main className="staff-queue">
      <h1>대기 중인 입장 기록</h1>
      <p>대기 {entries.filter((e) => e.status === 'pending').length}건 · 기록 완료 {entries.filter((e) => e.status === 'confirmed').length}건 · 충돌 {entries.filter((e) => e.status === 'conflict').length}건</p>
      <button type="button" onClick={() => { void reconcileQueue({ orgId: 0n }).then(setReport); }}>지금 전송</button>
      {report?.conflicts.map((c) => (
        <p key={c.tokenId} className="warn">
          티켓 {c.tokenId}: 다른 게이트({c.firstGateId})가 {new Date(c.firstTs * 1000).toLocaleTimeString('ko-KR')}에 먼저 기록했습니다.
        </p>
      ))}
    </main>
  );
}
```

- [ ] **Step 4: 통과 확인**

Run: `pnpm vitest run apps/web/src/staff/queue/reconcile.test.ts` → PASS, 2 passed.

- [ ] **Step 5: 커밋**

```bash
git add apps/web/src/staff/queue/reconcile.ts apps/web/src/staff/queue/reconcile.test.ts apps/web/src/staff/queue/QueueScreen.tsx
git commit -m "feat(staff): reconcile ALREADY_USED replays and show the pending queue"
```

---

## Task 30: 게이트 화면 배선 — 수신 → 판정 → 사진, 오프라인 분기

**Files:**
- Create: `apps/web/src/staff/gate/useGate.ts`, `apps/web/src/staff/gate/GateScreen.tsx`
- Test: `apps/web/src/staff/gate/useGate.test.ts`

**Interfaces:**
- Consumes: Task 15·17·19·20·21·22·23·24·25·26·27·28 전부
- Produces: `useGate(p: { gateId: bigint; eventId: bigint; orgId: bigint; gateAccount: Address }): UseGateResult` where `UseGateResult = GateContext & { photo?: string; precheck?: PreflightResult; elapsedMs: number; entriesCount: number; admittedAt?: number; deviceChangedRecently: boolean; requireKyc: boolean; handleResponse(r: GateResponseWire): Promise<void>; retry(): void }`. `GateScreen` 이 03의 `apps/web/src/staff/components/*` 정본 props 로 그대로 넘긴다. `handleResponse` 는 NFC 와 QR(Task 31)이 공유하는 단 하나의 수신 경로다.
- **인증 경계:** 스냅샷과 사진은 스태프 본인 Firebase 세션으로 가져오고(`issueSnapshot`/`getPhotoForGate` 에 `gateAccount` 를 함께 보낸다), 체크인 유저옵은 게이트 계정이 보낸다(Task 21). 스태프가 로그아웃 상태면 두 callable 이 `permission-denied` 로 떨어지므로 게이트 화면 진입 전에 로그인 게이트를 세운다(P8).

- [ ] **Step 1: 통합 테스트를 쓴다**

```ts
// apps/web/src/staff/gate/useGate.test.ts
import { renderHook, act, waitFor } from '@testing-library/react';
import { encode as cborEncode } from 'cborg';
import { describe, expect, it, vi } from 'vitest';

import { encodeExternalRecord } from '../../shared/nfc/ndef';

const ticket = { tokenId: '123', account: `0x${'aa'.repeat(20)}` as const, deviceX: `0x${'11'.repeat(32)}` as const,
  deviceY: `0x${'22'.repeat(32)}` as const, photoJpegB64: 'PHOTO', displayName: '김입장', tier: 0, checkedIn: false, tierName: 'VIP', seat: 'A-12' };
const snapshot = { v: 1 as const, eventId: '42', eventTitle: '가을 밤 콘서트', requireKyc: true, epoch: 1, expiresAt: 2_000_000_000, tickets: [ticket], attesterSig: '0x00' as const };
const code = { v: 1 as const, gateId: '7', eventId: '42', issuedAt: Math.floor(Date.now() / 1000),
  nonce: `0x${'ab'.repeat(32)}` as const, kx: '0x00' as const, ky: '0x00' as const, sig: '0x00' as const };

let onWrite: (b: Uint8Array) => void = () => {};
let onVerdict: (v: unknown, h: string) => void = () => {};
vi.mock('./emitter', () => ({ startGateEmitter: async (p: { onWrite: (b: Uint8Array) => void }) => { onWrite = p.onWrite; return { stop: async () => {}, lastCode: () => code }; } }));
vi.mock('./verdict', async (orig) => ({ ...(await orig<Record<string, unknown>>()),
  watchCheckedIn: (p: { onVerdict: (v: unknown, h: string) => void }) => { onVerdict = p.onVerdict; return () => {}; } }));
const startSnapshotRefresh = vi.fn(() => () => {});
vi.mock('../snapshot/store', () => ({ loadSnapshot: vi.fn(async () => snapshot), snapshotAgeMs: async () => 1000, startSnapshotRefresh, staffDb: async () => ({}) }));
const getPhotoForGate = vi.fn(async () => ({ photoJpegB64: 'FETCHED', displayName: '김입장' }));
vi.mock('../../shared/api/functions', () => ({ getPhotoForGate }));
const readContract = vi.fn(async ({ functionName }: { functionName: string }) =>
  functionName === 'eventMeta' ? { requireKyc: true } : 0n);
vi.mock('../../shared/chain/client', () => ({ getPublicClient: () => ({ readContract }) }));
vi.mock('./checkInOp', () => ({ sendCheckIn: async () => ({ userOpHash: '0x1', wait: async (_t?: number) => ({ success: true, blockNumber: 9n, txHash: '0x2' }) }) }));
vi.mock('../net/online', () => ({ createOnlineWatcher: () => ({ online: () => true, subscribe: () => () => {}, stop: () => {} }) }));
vi.mock('../queue/opQueue', () => ({ enqueueCheckIn: async () => ({}), pendingCount: async () => 0, drainQueue: async () => [] }));

import { nonceHashOf } from './verdict';
import { useGate } from './useGate';

const GATE = `0x${'aa'.repeat(20)}` as const;
const params = { gateId: 7n, eventId: 42n, orgId: 5n, gateAccount: GATE };

describe('gate screen wiring', () => {
  it('refreshes the snapshot for this event and gate account', async () => {
    renderHook(() => useGate(params));
    await waitFor(() => expect(startSnapshotRefresh).toHaveBeenCalledWith('42', GATE));
  });

  it('asks for a photo with the gate account when the snapshot has none', async () => {
    const { result } = renderHook(() => useGate(params));
    await waitFor(() => expect(result.current.state).toBe('ready'));
    const ndef = encodeExternalRecord('monti.app:s', cborEncode({ v: 1, tokenId: '123', deviceSig: `0x${'ef'.repeat(64)}` }));
    await act(async () => { onWrite(ndef); });
    await act(async () => { onVerdict({ kind: 'admit', blockNumber: 9n, finalized: true }, nonceHashOf(code.nonce)); });
    await waitFor(() => expect(result.current.state).toBe('admit'));
    if (getPhotoForGate.mock.calls.length > 0) {
      expect(getPhotoForGate).toHaveBeenCalledWith({ tokenId: '123', gateAccount: GATE });
    }
  });

  it('goes received → confirming → admit with the snapshot photo', async () => {
    const { result } = renderHook(() => useGate(params));
    await waitFor(() => expect(result.current.state).toBe('ready'));
    const ndef = encodeExternalRecord('monti.app:s', cborEncode({ v: 1, tokenId: '123', deviceSig: `0x${'ef'.repeat(64)}` }));
    await act(async () => { onWrite(ndef); });
    await waitFor(() => expect(result.current.state).toBe('confirming'));
    await act(async () => { onVerdict({ kind: 'admit', blockNumber: 9n, finalized: false }, nonceHashOf(code.nonce)); });
    await waitFor(() => expect(result.current.state).toBe('admit'));
    expect(result.current.photo).toBe('PHOTO');
  });

  it('counts entries and timestamps the admit so AdmitCard can show 입장 순번', async () => {
    const { result } = renderHook(() => useGate(params));
    await waitFor(() => expect(result.current.state).toBe('ready'));
    const ndef = encodeExternalRecord('monti.app:s', cborEncode({ v: 1, tokenId: '123', deviceSig: `0x${'ef'.repeat(64)}` }));
    await act(async () => { onWrite(ndef); });
    await act(async () => { onVerdict({ kind: 'admit', blockNumber: 9n, finalized: true }, nonceHashOf(code.nonce)); });
    await waitFor(() => expect(result.current.entriesCount).toBe(1));
    expect(result.current.admittedAt).toBeGreaterThan(0);
    expect(result.current.precheck?.ok).toBe(true);
  });

  it('takes eventTitle and requireKyc from the snapshot and skips the photo call for a non-KYC event', async () => {
    getPhotoForGate.mockClear();
    readContract.mockClear();
    const noPhoto = {
      ...snapshot,
      requireKyc: false,
      tickets: [{ ...ticket, photoJpegB64: '', tierName: '자유석', seat: '' }],
    };
    vi.mocked(await import('../snapshot/store')).loadSnapshot.mockResolvedValue(noPhoto as never);
    const { result } = renderHook(() => useGate(params));
    await waitFor(() => expect(result.current.requireKyc).toBe(false));
    expect(result.current.eventTitle).toBe('가을 밤 콘서트');
    // 스냅샷이 있으므로 체인 폴백은 쓰이지 않는다
    expect(readContract.mock.calls.filter((c) => c[0].functionName === 'eventMeta')).toHaveLength(0);
    const ndef = encodeExternalRecord('monti.app:s', cborEncode({ v: 1, tokenId: '123', deviceSig: `0x${'ef'.repeat(64)}` }));
    await act(async () => { onWrite(ndef); });
    await act(async () => { onVerdict({ kind: 'admit', blockNumber: 9n, finalized: true }, nonceHashOf(code.nonce)); });
    await waitFor(() => expect(result.current.state).toBe('admit'));
    expect(result.current.photo).toBe('');
    expect(getPhotoForGate).not.toHaveBeenCalled();
  });

  it('denies an unknown token without sending anything', async () => {
    const { result } = renderHook(() => useGate(params));
    await waitFor(() => expect(result.current.state).toBe('ready'));
    const ndef = encodeExternalRecord('monti.app:s', cborEncode({ v: 1, tokenId: '999', deviceSig: `0x${'ef'.repeat(64)}` }));
    await act(async () => { onWrite(ndef); });
    await waitFor(() => expect(result.current.deny).toBe('NO_TICKET'));
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm vitest run apps/web/src/staff/gate/useGate.test.ts` → FAIL, `Cannot find module './useGate'`.

- [ ] **Step 3: 훅을 쓴다**

```ts
// apps/web/src/staff/gate/useGate.ts
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Address, Hex } from 'viem';

import { CONTRACTS, identityAbi, ticketAbi, type GateResponseWire, type SnapshotWire } from '@monti/shared';

import { getPhotoForGate } from '../../shared/api/functions';
import { getPublicClient } from '../../shared/chain/client';
import { createOnlineWatcher } from '../net/online';
import { enqueueCheckIn, pendingCount } from '../queue/opQueue';
import { loadSnapshot, snapshotAgeMs, startSnapshotRefresh } from '../snapshot/store';
import { verifyDeviceSignatureOffline } from '../snapshot/offlineVerify';
import type { GateContext, PreflightResult } from '../types';
import { sendCheckIn } from './checkInOp';
import { decodeGateResponse } from './decodeResponse';
import { mapRevertToDenyCode } from './denyMap';
import { startGateEmitter, type GateEmitter } from './emitter';
import { createGateMachine } from './machine';
import { preflight } from './preflight';
import { nonceHashOf, watchCheckedIn } from './verdict';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface UseGateParams {
  gateId: bigint;
  eventId: bigint;
  orgId: bigint;
  /** 게이트 스마트 계정 주소. 두 callable 에 함께 보내 서버가 게이트 등록 여부를 확인한다. */
  gateAccount: Address;
}

export type UseGateResult = GateContext & {
  photo?: string;
  precheck?: PreflightResult;
  elapsedMs: number;
  entriesCount: number;
  admittedAt?: number;
  deviceChangedRecently: boolean;
  /** 스냅샷의 requireKyc(1순위) 또는 Ticket.eventMeta(폴백). false 면 사진이 없는 행사다. */
  requireKyc: boolean;
  /** 스냅샷의 eventTitle. 스냅샷이 아직 없으면 빈 문자열이다. */
  eventTitle: string;
  /** NFC 와 QR 이 공유하는 단 하나의 수신 경로(Task 31). */
  handleResponse(response: GateResponseWire): Promise<void>;
  retry(): void;
};

export function useGate(params: UseGateParams): UseGateResult {
  const machine = useRef(createGateMachine(params)).current;
  const [ctx, setCtx] = useState<GateContext>(machine.snapshot());
  const [photo, setPhoto] = useState<string>();
  const [precheck, setPrecheck] = useState<PreflightResult>();
  const [elapsedMs, setElapsedMs] = useState(0);
  const [entriesCount, setEntriesCount] = useState(0);
  const [admittedAt, setAdmittedAt] = useState<number>();
  const [deviceChangedRecently, setDeviceChangedRecently] = useState(false);
  const [requireKyc, setRequireKyc] = useState(true);
  const [eventTitle, setEventTitle] = useState('');
  const expected = useRef<Hex>();
  const handlerRef = useRef<(r: GateResponseWire) => Promise<void>>(async () => {});

  useEffect(() => {
    let emitter: GateEmitter | undefined;
    const unsubscribe = machine.subscribe(setCtx);
    const online = createOnlineWatcher();
    const stopRefresh = startSnapshotRefresh(params.eventId.toString(), params.gateAccount);
    const logs = watchCheckedIn({
      gateId: params.gateId,
      onVerdict: (verdict, nonceHash) => { if (nonceHash === expected.current) machine.onVerdict(verdict); },
    });

    // 행사 성격은 스냅샷이 1순위다. 스냅샷이 아직 없는 첫 실행에서만 체인으로 떨어진다.
    // 어느 쪽이든 체크인 경로는 건드리지 않는다.
    void (async () => {
      const cached = (await loadSnapshot(params.eventId.toString())) as SnapshotWire | undefined;
      if (cached) { setEventTitle(cached.eventTitle); setRequireKyc(cached.requireKyc); return; }
      try {
        const meta = await getPublicClient().readContract({
          address: CONTRACTS.ticket, abi: ticketAbi, functionName: 'eventMeta', args: [params.eventId],
        });
        setRequireKyc((meta as { requireKyc: boolean }).requireKyc);
      } catch {
        setRequireKyc(true); // 못 읽으면 보수적으로 KYC 행사로 본다
      }
    })();

    const runResponse = async (response: GateResponseWire) => {
      machine.onResponse();
      const snapshot = (await loadSnapshot(params.eventId.toString())) as SnapshotWire | undefined;
      const code = emitter?.lastCode();
      if (!snapshot || !code) { machine.onVerdict({ kind: 'deny', code: 'TX_FAILED', detail: '스냅샷이 없습니다' }); return; }

      // 매 탭마다 최신 스냅샷의 행사 정보로 헤더를 갱신한다(10분 갱신 직후 바로 반영된다).
      setEventTitle(snapshot.eventTitle);
      setRequireKyc(snapshot.requireKyc);

      const result = preflight({ snapshot, code, response });
      setPrecheck(result);
      machine.onPreflight(result);
      if (!result.ok || !result.ticket) return;
      setPhoto(result.ticket.photoJpegB64);

      if (!online.online()) {
        if (!verifyDeviceSignatureOffline({ ticket: result.ticket, code, response })) {
          machine.onVerdict({ kind: 'deny', code: 'DEVICE_MISMATCH', detail: '기기 서명이 맞지 않습니다' });
          return;
        }
        await enqueueCheckIn({ code, response, orgId: params.orgId });
        machine.onOfflineAdmit(await pendingCount());
        return;
      }

      expected.current = nonceHashOf(code.nonce);
      machine.onSent();
      try {
        const receipt = await (await sendCheckIn({ code, response, orgId: params.orgId })).wait(20_000);
        if (!receipt.success) {
          const mapped = mapRevertToDenyCode(receipt.revertReason);
          machine.onVerdict({ kind: 'deny', code: mapped.code, detail: mapped.detail });
        }
        // 성공이면 판정은 CheckedIn 구독이 내린다. 여기서 초록을 켜지 않는다.
      } catch (e) {
        machine.onVerdict({ kind: 'deny', code: 'TX_FAILED', detail: (e as Error).message });
      }
    };

    handlerRef.current = runResponse;

    const onNdef = (ndef: Uint8Array) => {
      let response: GateResponseWire;
      try { response = decodeGateResponse(ndef); }
      catch (e) { machine.onVerdict({ kind: 'deny', code: 'TX_FAILED', detail: (e as Error).message }); return; }
      void runResponse(response);
    };

    void startGateEmitter({ gateId: params.gateId, eventId: params.eventId, onWrite: onNdef })
      .then(async (e) => {
        emitter = e;
        machine.onReady();
        setCtx({ ...machine.snapshot(), snapshotAgeMs: await snapshotAgeMs(params.eventId.toString()), pendingCount: await pendingCount() });
      });

    return () => { void emitter?.stop(); logs(); online.stop(); stopRefresh(); unsubscribe(); };
  }, [machine, params.eventId, params.gateId, params.orgId, params.gateAccount]);

  useEffect(() => {
    if (ctx.state !== 'admit' || !ctx.ticket) return;
    if (!requireKyc) { setPhoto(''); return; } // 사진이 없는 행사다. 카드가 아바타 + 닉네임으로 그린다
    if (photo) return;
    // 스냅샷에 사진이 없을 때만 서버에 묻는다. 인증은 스태프 본인 Firebase 세션이고,
    // gateAccount 는 서버가 "등록된 게이트인가"를 확인하는 값이다.
    void getPhotoForGate({ tokenId: ctx.ticket.tokenId, gateAccount: params.gateAccount })
      .then((r) => setPhoto(r.photoJpegB64))
      .catch(() => undefined);
  }, [ctx.state, ctx.ticket, photo, requireKyc, params.gateAccount]);

  // 스펙 §13: 24시간 안에 기기를 바꾼 사람이면 앰버 배너.
  useEffect(() => {
    if (ctx.state !== 'admit' || !ctx.ticket) return;
    void getPublicClient()
      .readContract({ address: CONTRACTS.identity, abi: identityAbi, functionName: 'deviceUpdatedAt', args: [ctx.ticket.account] })
      .then((at) => setDeviceChangedRecently(Date.now() - Number(at as bigint) * 1000 < DAY_MS))
      .catch(() => setDeviceChangedRecently(false));
  }, [ctx.state, ctx.ticket]);

  useEffect(() => {
    if (ctx.state !== 'admit' && ctx.state !== 'offlineAdmit') return;
    setEntriesCount((n) => n + 1);
    setAdmittedAt(Date.now());
  }, [ctx.state]);

  useEffect(() => {
    if (ctx.state !== 'confirming') { setElapsedMs(0); return undefined; }
    const started = Date.now();
    const t = setInterval(() => setElapsedMs(Date.now() - started), 100);
    return () => clearInterval(t);
  }, [ctx.state]);

  const handleResponse = useCallback((response: GateResponseWire) => handlerRef.current(response), []);

  return {
    ...ctx,
    photo,
    precheck,
    elapsedMs,
    entriesCount,
    admittedAt,
    deviceChangedRecently,
    requireKyc,
    eventTitle,
    handleResponse,
    retry: () => {
      setPhoto(undefined);
      setPrecheck(undefined);
      setDeviceChangedRecently(false);
      machine.reset();
    },
  };
}
```

```tsx
// apps/web/src/staff/gate/GateScreen.tsx
import { useEffect, useState } from 'react';

import { getStaffAccount } from '../../shared/chain/accounts';
import { useStaffSession } from '../../shared/staffSession';
import {
  AdmitCard, ConfirmingCard, DenyCard, OfflineAdmitCard, OfflineBadge,
  OverrideDialog, ReceivedCard, StaffShell, TapPrompt,
} from '../components';
import { decideOverrideRoute, submitOverride } from '../override/route';
import { useGateRegistration } from '../setup/GateSetupScreen.helpers';
import { DENY_LABELS } from './denyMap';
import { useGate } from './useGate';

const ZERO = '0x0000000000000000000000000000000000000000' as const;

export function GateScreen() {
  const session = useStaffSession();
  const reg = useGateRegistration();
  const gate = useGate({
    gateId: reg.gateId ?? 0n,
    eventId: reg.eventId ?? 0n,
    orgId: reg.orgId ?? 0n,
    gateAccount: reg.address ?? ZERO,
  });
  const [canApprove, setCanApprove] = useState(false);

  useEffect(() => {
    const orgId = reg.orgId;
    if (orgId === undefined) return;
    void getStaffAccount()
      .then((a) => decideOverrideRoute({ orgId, account: a.address }))
      .then((route) => setCanApprove(route === 'manualOverride'))
      .catch(() => setCanApprove(false));
  }, [reg.orgId]);

  const snapshotAgeSec = Math.floor(gate.snapshotAgeMs / 1000);
  const tierLabel = gate.ticket?.tierName ?? '';
  const seat = gate.ticket?.seat || undefined; // 좌석 미지정 행사는 "" 로 온다
  // photoJpegB64 가 "" 이면 카드가 아바타 + 닉네임 + "본인인증 없음 · 사진 대조 불가" 칩을 그린다.
  const photo = gate.photo ?? '';

  return (
    <StaffShell
      gateName={`게이트 #${gate.gateId}`}
      eventTitle={`${gate.eventTitle || `공연 #${gate.eventId}`} · ${gate.requireKyc ? 'KYC 행사' : '일반 행사'}`}
      staffName={session.displayName}
      chainStage={gate.finalized ? 'finalized' : 'speculative'}
      speculativeBlock={gate.blockNumber}
      finalizedBlock={gate.finalized ? gate.blockNumber : undefined}
      snapshotAgeSec={snapshotAgeSec}
      entriesCount={gate.entriesCount}
    >
      {!gate.online && <OfflineBadge snapshotAgeSec={snapshotAgeSec} queuedCount={gate.pendingCount} />}

      {gate.state === 'ready' && <TapPrompt rotating />}

      {gate.state === 'received' && (
        <ReceivedCard tokenIdMasked={`•••${gate.ticket?.tokenId.slice(-3) ?? ''}`} precheck={gate.precheck} />
      )}

      {gate.state === 'confirming' && <ConfirmingCard elapsedMs={gate.elapsedMs} />}

      {gate.state === 'admit' && (
        <AdmitCard
          photoJpegB64={photo}
          displayName={gate.ticket?.displayName ?? ''}
          tierLabel={tierLabel}
          seat={seat}
          entryNumber={gate.entriesCount}
          timestamp={gate.admittedAt ?? Date.now()}
          blockNumber={gate.blockNumber}
          deviceChangedRecently={gate.deviceChangedRecently}
          finalized={gate.finalized}
          onDone={gate.retry}
        />
      )}

      {gate.state === 'offlineAdmit' && (
        <OfflineAdmitCard
          photoJpegB64={photo}
          displayName={gate.ticket?.displayName ?? ''}
          tierLabel={tierLabel}
          seat={seat}
          queuedCount={gate.pendingCount}
          onDone={gate.retry}
        />
      )}

      {gate.state === 'deny' && (
        <DenyCard code={gate.deny!} detail={gate.denyDetail ?? DENY_LABELS[gate.deny!]} onDone={gate.retry} />
      )}

      {gate.state === 'override' && (
        <OverrideDialog
          canApprove={canApprove}
          onCancel={gate.retry}
          onSubmit={async ({ reason }: { reason: number }) => {
            const orgId = reg.orgId;
            if (!gate.ticket || orgId === undefined) return;
            const account = await getStaffAccount();
            await submitOverride({
              orgId,
              account: account.address,
              tokenId: BigInt(gate.ticket.tokenId),
              gateId: gate.gateId,
              reason,
            });
            gate.retry();
          }}
        />
      )}
    </StaffShell>
  );
}
```

`useGateRegistration` 은 Task 15에서 만든 훅이다. `GateScreen` 이 import 할 수 있도록 `apps/web/src/staff/setup/GateSetupScreen.helpers.ts` 한 줄 재수출 파일을 만든다: `export { useGateRegistration } from './useGateRegistration';`

- [ ] **Step 4: 통과 확인**

Run: `pnpm vitest run apps/web/src/staff/gate/useGate.test.ts` → PASS, 6 passed.

- [ ] **Step 5: 실기기에서 한 번 돌린다**

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/apps/web
pnpm run:staff
```

Expected: `✔ copy android`, `✔ update android`, `[capacitor] Installing app.monti.staff`, 단말기 화면에 "TAP HERE" 와 3초마다 펄스. `adb logcat -s MontiHce:*` 에 아이폰 탭 시 SELECT AID 로그.

- [ ] **Step 6: 커밋**

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI
git add apps/web/src/staff/gate/useGate.ts apps/web/src/staff/gate/useGate.test.ts apps/web/src/staff/gate/GateScreen.tsx apps/web/src/staff/setup/GateSetupScreen.helpers.ts
git commit -m "feat(staff): wire receive, preflight, check-in, chain verdict, photo and requireKyc into the gate screen"
```

---

## Task 31: QR 폴백 — `MONTI1:` 스캔

**Files:**
- Create: `apps/web/src/staff/qr/scan.ts`
- Test: `apps/web/src/staff/qr/scan.test.ts`
- Modify: `apps/web/src/staff/gate/useGate.ts` (스캔 결과를 같은 수신 경로로)

**Interfaces:**
- Consumes: `decodeQrResponse` (Task 19), `@capacitor-mlkit/barcode-scanning`
- Produces: `scanGateResponse(): Promise<GateResponseWire>` — 취소하면 `ScanCancelled` 를 던진다. `useGate` 가 `handleResponse(response)` 로 NFC 와 완전히 같은 경로에 넣는다. 스펙 §5.3 마지막 줄, §12.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

```ts
// apps/web/src/staff/qr/scan.test.ts
import { encode as cborEncode } from 'cborg';
import { describe, expect, it, vi } from 'vitest';

const scan = vi.fn();
const requestPermissions = vi.fn(async () => ({ camera: 'granted' }));
vi.mock('@capacitor-mlkit/barcode-scanning', () => ({
  BarcodeScanner: { scan, requestPermissions, checkPermissions: async () => ({ camera: 'granted' }) },
  BarcodeFormat: { QrCode: 'QR_CODE' },
}));

import { ScanCancelled, scanGateResponse } from './scan';

const wire = { v: 1, tokenId: '123', deviceSig: `0x${'ab'.repeat(64)}` };
const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

describe('QR fallback', () => {
  it('scans QR only and returns the same wire object as NFC', async () => {
    scan.mockResolvedValueOnce({ barcodes: [{ rawValue: `MONTI1:${b64url(cborEncode(wire))}` }] });
    expect(await scanGateResponse()).toEqual(wire);
    expect(scan).toHaveBeenCalledWith({ formats: ['QR_CODE'] });
  });

  it('throws ScanCancelled when the staff member closes the camera', async () => {
    scan.mockResolvedValueOnce({ barcodes: [] });
    await expect(scanGateResponse()).rejects.toThrow(ScanCancelled);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm vitest run apps/web/src/staff/qr/scan.test.ts` → FAIL, `Cannot find module './scan'`.

- [ ] **Step 3: 구현을 쓴다**

```ts
// apps/web/src/staff/qr/scan.ts
import { BarcodeFormat, BarcodeScanner } from '@capacitor-mlkit/barcode-scanning';

import type { GateResponseWire } from '@monti/shared';

import { decodeQrResponse } from '../gate/decodeResponse';

export class ScanCancelled extends Error {
  constructor() {
    super('QR scan cancelled');
    this.name = 'ScanCancelled';
  }
}

/** NFC 가 안 되는 관객(아이폰 브라우저 접속자 등)용. 이후 경로는 NFC 와 완전히 같다. */
export async function scanGateResponse(): Promise<GateResponseWire> {
  const status = await BarcodeScanner.checkPermissions();
  if (status.camera !== 'granted') {
    const asked = await BarcodeScanner.requestPermissions();
    if (asked.camera !== 'granted') throw new Error('카메라 권한이 필요합니다');
  }
  const { barcodes } = await BarcodeScanner.scan({ formats: [BarcodeFormat.QrCode] });
  const first = barcodes[0]?.rawValue;
  if (!first) throw new ScanCancelled();
  return decodeQrResponse(first);
}
```

Task 30의 `useGate` 가 이미 `handleResponse(response: GateResponseWire)` 를 내보낸다(NFC 경로는 `decodeGateResponse(ndef)` 뒤에 같은 함수를 부른다). QR 버튼은 `scanGateResponse().then(gate.handleResponse)` 로 그것을 그대로 부른다 — 상태 기계도 사전 검증도 전송도 한 벌만 존재한다. `GateScreen` 의 `ready` 분기에 QR 버튼 한 개를 더한다: `<button type="button" onClick={() => { void scanGateResponse().then(gate.handleResponse).catch(() => undefined); }}>QR로 확인</button>`.

- [ ] **Step 4: 통과 확인**

```bash
pnpm --filter @monti/web add @capacitor-mlkit/barcode-scanning
pnpm vitest run apps/web/src/staff/qr/scan.test.ts apps/web/src/staff/gate/useGate.test.ts
```

Expected: PASS — 2 files, 4 passed.

- [ ] **Step 5: 커밋**

```bash
git add apps/web/src/staff/qr apps/web/src/staff/gate/useGate.ts apps/web/package.json pnpm-lock.yaml
git commit -m "feat(staff): QR fallback scanning MONTI1 codes into the same receive path"
```

---

## Task 32: 수동 승인 — 로컬 PIN, 사유 코드, `requestOverride` vs `manualOverride`

**Files:**
- Create: `apps/web/src/staff/override/pin.ts`, `apps/web/src/staff/override/route.ts`
- Test: `apps/web/src/staff/override/pin.test.ts`, `apps/web/src/staff/override/route.test.ts`

**Interfaces:**
- Consumes: `staffDb()` (Task 25), `organizersAbi`·`ticketAbi`·`CONTRACTS`·`PERM_APPROVE_OVERRIDE = 4` (02), `sendSponsoredOp` (03), 스태프 본인 패스키 스마트 계정 `getStaffAccount()` (03)
- Produces: `setPin(pin: string): Promise<void>`, `verifyPin(pin: string): Promise<boolean>`, `OVERRIDE_REASONS`, `decideOverrideRoute(p): Promise<'manualOverride'|'requestOverride'|'denied'>`, `submitOverride(p): Promise<SponsoredOpHandle>`.

> **두 계정을 절대 섞지 않는다.** 체크인은 **게이트 계정**이 보낸다(Task 21). 수동 승인과 결재 요청은 **스태프 본인이 패스키로 로그인한 계정**이 보낸다 — 승인자 주소가 체인에 남아야 하기 때문이다(스펙 §6.3 T8, §9.4). `submitOverride` 는 `getStaffAccount()` 만 쓰고 `getGateSmartAccount()` 를 import 하지 않는다.

- [ ] **Step 1: PIN 테스트를 쓴다**

```ts
// apps/web/src/staff/override/pin.test.ts
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';

import { setPin, verifyPin } from './pin';

describe('local staff PIN', () => {
  it('accepts the right PIN and refuses the wrong one', async () => {
    await setPin('4821');
    expect(await verifyPin('4821')).toBe(true);
    expect(await verifyPin('4822')).toBe(false);
  });

  it('never stores the PIN itself', async () => {
    await setPin('4821');
    const { staffDb } = await import('../snapshot/store');
    const row = await (await staffDb()).get('settings', 'pin');
    expect(JSON.stringify(row)).not.toContain('4821');
    expect((row as { salt: string }).salt).toMatch(/^[0-9a-f]{32}$/);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm vitest run apps/web/src/staff/override/pin.test.ts` → FAIL, `Cannot find module './pin'`.

- [ ] **Step 3: PIN 을 쓴다**

```ts
// apps/web/src/staff/override/pin.ts
import { staffDb } from '../snapshot/store';

const ITERATIONS = 210_000;

interface PinRow { key: 'pin'; salt: string; hash: string }

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function derive(pin: string, saltHex: string): Promise<string> {
  const salt = new Uint8Array((saltHex.match(/../g) ?? []).map((h) => parseInt(h, 16)));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' }, key, 256));
}

/** PIN 은 단말기 밖으로 나가지 않는다. 서버도 체인도 모른다. */
export async function setPin(pin: string): Promise<void> {
  const salt = hex(crypto.getRandomValues(new Uint8Array(16)).buffer);
  await (await staffDb()).put('settings', { key: 'pin', salt, hash: await derive(pin, salt) } satisfies PinRow);
}

export async function verifyPin(pin: string): Promise<boolean> {
  const row = (await (await staffDb()).get('settings', 'pin')) as PinRow | undefined;
  if (!row) return false;
  return (await derive(pin, row.salt)) === row.hash;
}
```

- [ ] **Step 4: 라우팅 테스트를 쓴다**

```ts
// apps/web/src/staff/override/route.test.ts
import { decodeFunctionData } from 'viem';
import { describe, expect, it, vi } from 'vitest';

import { ticketAbi } from '@monti/shared';

const readContract = vi.fn();
const sendSponsoredOp = vi.fn(async () => ({ userOpHash: '0x1', wait: async (_t?: number) => ({ success: true, blockNumber: 1n, txHash: '0x2' }) }));
vi.mock('../../shared/chain/client', () => ({ getPublicClient: () => ({ readContract }) }));
vi.mock('../../shared/chain/sponsored', () => ({ sendSponsoredOp }));
vi.mock('../../shared/chain/accounts', () => ({ getStaffAccount: async () => ({ address: `0x${'bb'.repeat(20)}` }) }));

import { decideOverrideRoute, OVERRIDE_REASONS, submitOverride } from './route';

const who = { orgId: 5n, account: `0x${'bb'.repeat(20)}` as const };

describe('override routing uses the staff member own passkey account', () => {
  it('manualOverride when the manager can approve', async () => {
    readContract.mockResolvedValueOnce([true, true]);
    expect(await decideOverrideRoute(who)).toBe('manualOverride');
  });

  it('requestOverride when the manager exists but cannot approve', async () => {
    readContract.mockResolvedValueOnce([true, false]).mockResolvedValueOnce(false);
    expect(await decideOverrideRoute(who)).toBe('requestOverride');
  });

  it('manualOverride when the account is an admin holding PERM_APPROVE_OVERRIDE', async () => {
    readContract.mockResolvedValueOnce([false, false]).mockResolvedValueOnce(true);
    expect(await decideOverrideRoute(who)).toBe('manualOverride');
  });

  it('denied when neither manager nor permitted admin', async () => {
    readContract.mockResolvedValueOnce([false, false]).mockResolvedValueOnce(false);
    expect(await decideOverrideRoute(who)).toBe('denied');
  });

  it('sends manualOverride from the staff account with a listed reason code', async () => {
    readContract.mockResolvedValueOnce([true, true]);
    await submitOverride({ ...who, tokenId: 123n, gateId: 7n, reason: OVERRIDE_REASONS[0].code });
    const call = (sendSponsoredOp.mock.calls[0][0] as { calls: Array<{ data: `0x${string}` }>; account: { address: string } });
    expect(call.account.address).toBe(`0x${'bb'.repeat(20)}`);
    const { functionName, args } = decodeFunctionData({ abi: ticketAbi, data: call.calls[0].data });
    expect(functionName).toBe('manualOverride');
    expect(args).toEqual([123n, 7n, 1]);
  });
});
```

- [ ] **Step 5: 라우팅을 쓴다**

```ts
// apps/web/src/staff/override/route.ts
import { encodeFunctionData, type Address } from 'viem';

import { CONTRACTS, organizersAbi, ticketAbi } from '@monti/shared';

import { getPublicClient } from '../../shared/chain/client';
import { sendSponsoredOp, type SponsoredOpHandle } from '../../shared/chain/sponsored';
import { getStaffAccount } from '../../shared/chain/accounts';

/** Organizers.PERM_APPROVE_OVERRIDE (마스터 플랜 Shared Interfaces). */
const PERM_APPROVE_OVERRIDE = 4;

export const OVERRIDE_REASONS = [
  { code: 1, label: '기기 잠김 · 신분 확인 완료' },
  { code: 2, label: '기기 변경 7일 쿨타임' },
  { code: 3, label: 'NFC 불가 단말' },
  { code: 4, label: '현장 명단 확인' },
  { code: 5, label: '기타 · 매니저 재량' },
] as const;

export interface OverrideWho { orgId: bigint; account: Address }
export type OverrideRoute = 'manualOverride' | 'requestOverride' | 'denied';

/** 판단은 언제나 체인 직접 조회다. 인덱서도 캐시도 쓰지 않는다(스펙 §9.4). */
export async function decideOverrideRoute(who: OverrideWho): Promise<OverrideRoute> {
  const client = getPublicClient();
  const [exists, canApprove] = (await client.readContract({
    address: CONTRACTS.organizers, abi: organizersAbi, functionName: 'managerOf', args: [who.orgId, who.account],
  })) as [boolean, boolean];
  if (exists && canApprove) return 'manualOverride';
  const permitted = (await client.readContract({
    address: CONTRACTS.organizers, abi: organizersAbi, functionName: 'hasPermission',
    args: [who.orgId, who.account, PERM_APPROVE_OVERRIDE],
  })) as boolean;
  if (permitted) return 'manualOverride';
  return exists ? 'requestOverride' : 'denied';
}

export interface SubmitOverrideParams extends OverrideWho {
  tokenId: bigint;
  gateId: bigint;
  reason: number;
}

/**
 * 승인자 주소가 체인에 남아야 하므로 스태프 본인 패스키 계정으로 보낸다.
 * 게이트 계정은 여기서 쓰이지 않는다(스펙 §6.3 T8).
 */
export async function submitOverride(params: SubmitOverrideParams): Promise<SponsoredOpHandle> {
  const route = await decideOverrideRoute(params);
  if (route === 'denied') throw new Error('이 계정에는 수동 승인 권한이 없습니다');
  const account = await getStaffAccount();
  return sendSponsoredOp({
    account,
    orgId: params.orgId,
    calls: [{
      to: CONTRACTS.ticket,
      data: encodeFunctionData({ abi: ticketAbi, functionName: route, args: [params.tokenId, params.gateId, params.reason] }),
    }],
  });
}
```

- [ ] **Step 6: 통과 확인**

Run: `pnpm vitest run apps/web/src/staff/override`
Expected: PASS — 2 files, 7 passed.

- [ ] **Step 7: 커밋**

```bash
git add apps/web/src/staff/override
git commit -m "feat(staff): PIN-gated overrides routed by the staff passkey account permissions"
```

---

## Task 33: 필드 테스트 체크리스트 (스펙 §16 W3)

**Files:**
- Create: `docs/superpowers/plans/fieldtest-w3.md`, `apps/web/src/staff/log/fieldLog.ts`
- Test: `apps/web/src/staff/log/fieldLog.test.ts`

**Interfaces:**
- Consumes: `GateContext` (Task 14), `staffDb()` (Task 25)
- Produces: `logTap(entry: FieldLogEntry): Promise<void>`, `exportFieldLog(): Promise<string>` (NDJSON). `FieldLogEntry = { ts: number; runId: string; seq: number; state: GateState; deny?: DenyCode; latencyMs?: number; blockNumber?: string; finalized: boolean; online: boolean; handset: string; note?: string }`.

- [ ] **Step 1: 로그 테스트를 쓴다**

```ts
// apps/web/src/staff/log/fieldLog.test.ts
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';

import { exportFieldLog, logTap } from './fieldLog';

describe('field test log', () => {
  it('writes one NDJSON line per tap with every column the checklist needs', async () => {
    await logTap({ ts: 1_700_000_000_000, runId: 'W3-A', seq: 1, state: 'admit', latencyMs: 812,
      blockNumber: '19233', finalized: false, online: true, handset: 'iPhone 15' });
    const ndjson = await exportFieldLog();
    const row = JSON.parse(ndjson.trim().split('\n').at(-1)!);
    expect(row).toMatchObject({ runId: 'W3-A', seq: 1, state: 'admit', latencyMs: 812, handset: 'iPhone 15' });
    expect(ndjson.endsWith('\n')).toBe(true);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm vitest run apps/web/src/staff/log/fieldLog.test.ts` → FAIL, `Cannot find module './fieldLog'`.

- [ ] **Step 3: 로거를 쓴다**

```ts
// apps/web/src/staff/log/fieldLog.ts
import { staffDb } from '../snapshot/store';
import type { DenyCode, GateState } from '../types';

export interface FieldLogEntry {
  ts: number;
  runId: string;
  seq: number;
  state: GateState;
  deny?: DenyCode;
  latencyMs?: number;
  blockNumber?: string;
  finalized: boolean;
  online: boolean;
  handset: string;
  note?: string;
}

const STORE = 'settings';
const KEY = 'fieldLog';

export async function logTap(entry: FieldLogEntry): Promise<void> {
  const db = await staffDb();
  const row = ((await db.get(STORE, KEY)) as { key: string; lines: string[] } | undefined) ?? { key: KEY, lines: [] };
  row.lines.push(JSON.stringify(entry));
  await db.put(STORE, row);
}

/** 한 줄 = 한 탭. 그대로 fieldtest-w3.md 의 기록란에 붙인다. */
export async function exportFieldLog(): Promise<string> {
  const row = (await (await staffDb()).get(STORE, KEY)) as { lines: string[] } | undefined;
  return `${(row?.lines ?? []).join('\n')}\n`;
}
```

- [ ] **Step 4: 체크리스트 문서를 쓴다**

```bash
cat > /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/docs/superpowers/plans/fieldtest-w3.md <<'EOF'
# W3 실기기 필드 테스트 (스펙 §16 W3)

기기: 아이폰 2종(iOS 16+), 안드로이드 관객 1종, 안드로이드 스태프 1종(삼성이면 Secure NFC 끄기, 화면 켜짐 유지).
기록: 스태프 앱 `exportFieldLog()` 의 NDJSON 을 각 항목 아래 붙인다. 한 줄이 한 탭이다.

| # | 항목 | 절차 | 합격 기준 |
|---|---|---|---|
| F1 | 연속 50탭 | 같은 공연 티켓 50장을 한 게이트에서 연속으로 탭 | 성공 ≥ 45/50(90%). `state:"admit"` 기준. 실패는 전부 `EXPIRED_CODE` 또는 세션 만료여야 하고 오판정(`admit` 인데 체인에 없음) 0건 |
| F2 | 더블 탭 | 같은 티켓을 2초 안에 두 번 | 두 번째는 `deny:"ALREADY_USED"` + 첫 입장 시각·게이트 표시. 초록이 두 번 뜨면 실패 |
| F3 | 두 게이트 동시 | 게이트 A·B 에 같은 티켓을 같은 초에 | 정확히 한쪽만 `admit`, 다른 쪽 `ALREADY_USED`. 둘 다 초록이면 실패(T13) |
| F4 | 단말기 비행기 모드 | 스태프 단말기 비행기 모드 → 5장 탭 → 해제 | 5장 모두 `offlineAdmit`(앰버 테두리 + 사진), 해제 후 5건 모두 체인에 기록. `conflict` 0건 |
| F5 | 관객 폰 비행기 모드 | 관객 폰 비행기 모드로 10탭 | 10/10 `admit`. 관객 쪽 네트워크는 입장 경로에 없다 |
| F6 | RPC 하나 끊기 | 기본 RPC 를 방화벽으로 차단하고 10탭 | 지연 증가는 허용, 오판정 0건. 5초 초과는 `EXPIRED_CODE` 로만 떨어질 것 |
| F7 | 아이폰 간섭 | 스태프 화면 켜짐 상태에서 20탭, 잠금 상태에서 20탭 | 두 조건의 성공률을 각각 기록. 켜짐 성공률 < 70% 면 §18 완화책(폴링 설정, 재탭 UX) 재검토 |
| F8 | Apple Pay 미출현 | F1 전체에서 아이폰에 Apple Pay 화면이 떴는지 | 0회 |

## 로그 형식 (NDJSON, 한 줄 한 탭)

```
{"ts":1700000000000,"runId":"W3-F1","seq":1,"state":"admit","latencyMs":812,"blockNumber":"19233","finalized":false,"online":true,"handset":"iPhone 15"}
{"ts":1700000004120,"runId":"W3-F1","seq":2,"state":"deny","deny":"EXPIRED_CODE","latencyMs":5003,"finalized":false,"online":true,"handset":"iPhone 13 mini","note":"session expired, retapped ok"}
```

## 기록란

- F1: (붙여넣기)
- F2: (붙여넣기)
- F3: (붙여넣기)
- F4: (붙여넣기)
- F5: (붙여넣기)
- F6: (붙여넣기)
- F7: (붙여넣기)
- F8: (관찰 메모)
EOF
```

- [ ] **Step 5: 통과 확인**

Run: `pnpm vitest run apps/web/src/staff/log/fieldLog.test.ts` → PASS, 1 passed.

- [ ] **Step 6: 커밋**

```bash
git add apps/web/src/staff/log docs/superpowers/plans/fieldtest-w3.md
git commit -m "feat(staff): field test NDJSON log and the W3 checklist"
```

---

## Task 34: 인터페이스 대조 — 01~03이 만든 이름과 이 계획이 쓴 이름 diff

**Files:**
- Create: `apps/web/src/staff/interfaceContract.test.ts`

**Interfaces:**
- Consumes: `@monti/shared` 전체, `apps/web/src/shared/**`
- Produces: 없음(테스트만). 마스터 플랜 자기검토 노트의 "reviewer task at the end of sub-plan 04 diffs every ABI/function/type name used in 02–04 against `packages/shared`" 를 실행한다.

- [ ] **Step 1: 대조 테스트를 쓴다**

```ts
// apps/web/src/staff/interfaceContract.test.ts
import { describe, expect, it } from 'vitest';

import * as shared from '@monti/shared';

const TICKET_FNS = ['checkIn', 'requestOverride', 'manualOverride', 'checkInOf', 'eventOrg'];
const TICKET_ERRORS = ['AlreadyCheckedIn', 'WrongEvent', 'TicketRevoked', 'CodeExpired', 'NoSuchTicket', 'GateNotOpen', 'EventEnded', 'EventNotPublished', 'DeviceLocked', 'BadDeviceSignature'];
const ORGANIZERS_FNS = ['gateOf', 'gateInfo', 'managerOf', 'hasPermission', 'isOpenGate'];

const names = (abi: readonly unknown[], type: string) =>
  abi.filter((e) => (e as { type: string }).type === type).map((e) => (e as { name: string }).name);

describe('sub-plan 04 uses only names that sub-plans 01-03 actually produce', () => {
  it('Ticket ABI has every function this plan calls', () => {
    const have = names(shared.ticketAbi, 'function');
    expect(TICKET_FNS.filter((n) => !have.includes(n))).toEqual([]);
  });

  it('Ticket ABI has every custom error the deny map decodes', () => {
    const have = names(shared.ticketAbi, 'error');
    expect(TICKET_ERRORS.filter((n) => !have.includes(n))).toEqual([]);
  });

  it('Organizers ABI has every view this plan reads', () => {
    const have = names(shared.organizersAbi, 'function');
    expect(ORGANIZERS_FNS.filter((n) => !have.includes(n))).toEqual([]);
  });

  it('CheckedIn carries nonceHash and ts in data with gateId indexed third', () => {
    const event = shared.ticketAbi.find((e) => (e as { type: string; name?: string }).name === 'CheckedIn') as
      { inputs: Array<{ name: string; indexed: boolean; type: string }> };
    expect(event.inputs.map((i) => [i.name, i.indexed, i.type])).toEqual([
      ['tokenId', true, 'uint256'], ['eventId', true, 'uint256'], ['gateId', true, 'uint256'],
      ['nonceHash', false, 'bytes32'], ['ts', false, 'uint64'],
    ]);
  });

  it('EventMeta carries requireKyc so the gate can tell a KYC event from a plain one', () => {
    const meta = shared.ticketAbi.find((e) => (e as { name?: string }).name === 'eventMeta') as
      { outputs: Array<{ components: Array<{ name: string; type: string }> }> };
    const fields = meta.outputs[0].components.map((c) => c.name);
    expect(fields, 'EventMeta is missing requireKyc').toContain('requireKyc');
  });

  it('SnapshotWire carries the display fields the gate screen needs', () => {
    const sample: shared.SnapshotWire = {
      v: 1, eventId: '1', eventTitle: 't', requireKyc: true, epoch: 1, expiresAt: 0,
      tickets: [{ tokenId: '1', account: `0x${'aa'.repeat(20)}`, deviceX: `0x${'11'.repeat(32)}`,
        deviceY: `0x${'22'.repeat(32)}`, photoJpegB64: '', displayName: 'n', tier: 0, checkedIn: false,
        tierName: '일반', seat: '' }],
      attesterSig: '0x00',
    };
    expect(sample.eventTitle).toBe('t');
    expect(sample.tickets[0].tierName).toBe('일반');
    expect(sample.tickets[0].seat).toBe('');
  });

  it('shared encoding exposes the canonicaliser this device must not reimplement', () => {
    expect(typeof shared.canonicalJson).toBe('function');
    expect(typeof shared.snapshotDigest).toBe('function');
  });

  it('shared constants expose everything the staff device reads', () => {
    for (const key of ['ATTESTER_ADDRESS', 'CONTRACTS', 'ENTRYPOINT_V06', 'CHAIN_ID']) {
      expect(shared, `packages/shared is missing ${key}`).toHaveProperty(key);
    }
    expect(shared.ENTRYPOINT_V06).toBe('0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789');
  });

  it('web shared modules expose the signatures this plan assumed', async () => {
    const sponsored = await import('../shared/chain/sponsored');
    const logs = await import('../shared/chain/subscribeLogs');
    const key = await import('../shared/deviceKey');
    const accounts = await import('../shared/chain/accounts');
    const api = await import('../shared/api/functions');
    expect(typeof sponsored.sendSponsoredOp).toBe('function');
    expect(typeof logs.subscribeLogs).toBe('function');
    expect(typeof key.ensureDeviceKey).toBe('function');
    expect(typeof key.signWithDeviceKey).toBe('function');
    expect(typeof accounts.getStaffAccount).toBe('function');
    expect(typeof api.submitPendingGate).toBe('function');
  });
});
```

- [ ] **Step 2: 돌려서 차이를 본다**

Run: `pnpm vitest run apps/web/src/staff/interfaceContract.test.ts`
Expected: 01~03이 이 계획의 가정대로 만들었으면 PASS(9 passed). 아니면 어떤 이름이 없는지 정확히 찍힌다(예: `expect([]) - Received: ["BadDeviceSignature"]`).

- [ ] **Step 3: 차이를 고친다**

실패한 항목마다 **이 계획 쪽을 고치는 것이 원칙**이다 — 01의 컨트랙트가 진실이다. 예외는 두 가지뿐이다.
1. 01이 `CheckedIn` 의 인덱스를 다르게 만들었다면 `verdict.ts` 의 topic 위치를 바꾼다.
2. 01에 `Identity.attester()` view 가 생겼다면 `snapshot/verify.ts` 의 상수 읽기를 `eth_call` 로 바꾸고, 이 파일의 `ATTESTER_ADDRESS` 기대를 지운다.

고친 뒤 영향받은 태스크의 테스트를 다시 돌린다.

- [ ] **Step 4: 전체 스위트를 돌린다**

Run: `pnpm vitest run apps/web/src/staff apps/web/src/shared/chain apps/web/src/shared/nfc plugins/hce-android`
Expected: PASS — 모든 파일 초록, 실패 0.

- [ ] **Step 5: 안드로이드 유닛 테스트도 돌린다**

Run: `cd plugins/hce-android/android && ./gradlew test`
Expected: PASS — `BUILD SUCCESSFUL`, 36 tests, 0 failures.

- [ ] **Step 6: 커밋**

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI
git add apps/web/src/staff/interfaceContract.test.ts
git commit -m "test(staff): diff every name used by sub-plan 04 against packages/shared"
```

---

## Self-Review

### 1. 스펙 커버리지

| 스펙 | 요구 | 태스크 |
|---|---|---|
| §5.7-1 | 게이트 키 생성 → 계정 주소 → 등록 신청(`submitPendingGate`) → allowlist 등록 → PIN. QR 은 폴백 | 11, 13, 15, 32 |
| §5.7-2 | "TAP HERE", 3초 회전, 읽기 모드 금지 | 17, 18, 30 |
| §5.7-3 | 서명 수신 → 체인 전송 → 이벤트로 초록·빨강 | 19, 21, 24, 30 |
| §5.7-4 | OFFLINE, 스냅샷 로컬 검증, 큐 | 25, 26, 27, 28, 29 |
| §5.7-5 | PIN + 사유 코드, 수동 승인 / 결재 요청 | 32 |
| §7.2-2 | HCE Type 4 쓰기 가능 태그, 3초 회전, 읽기 모드 안 켬 | 2, 3, 4, 5, 6, 17, 18 |
| §7.2-5 | 게이트 계정 유저옵, 페이마스터, 스냅샷 사전 검증 | 20, 21 |
| §7.2-6 | 컨트랙트 검사 ①~⑤의 로컬 사전 검증 | 20, 27 |
| §7.2-8 | 자기 요청 결과 + `monadLogs` 구독, 추측 0.7초 / 확정 +0.6초 | 24, 30 |
| §7.3 | 60초 창, 3초 회전, 2초 스피너, 5초 재탭, 소프트 승인 금지, 130B 페이로드 | 10, 16, 20, 23 |
| §9.4 | 권한은 항상 체인 직접 조회(`managerOf`, `hasPermission`) | 32 |
| §11 HCE 세부 | AID, CATEGORY_OTHER, FCI 없는 9000, CC E103, NDEF 쓰기, 읽기 모드 금지, 회전은 탭 사이에만 | 2, 3, 5, 6, 18 |
| §12 | 스냅샷 서명·만료, 로컬 검증, 큐잉, 복구 전송, QR 폴백 | 25, 27, 28, 29, 31 |
| §13 | 8개 상태 전부 + 10개 DENY 코드 + 24시간 기기 변경 앰버 배너(`deviceUpdatedAt`) + 오프라인 배지 + 입장 순번 | 14, 22, 23, 30 |
| 창업자 델타 | 스냅샷의 `eventTitle`·`requireKyc`·`tierName`·`seat` 사용. `requireKyc == false` 행사는 빈 사진 → 아바타 + 닉네임 + "본인인증 없음" 칩, 헤더에 제목 + "KYC 행사 / 일반 행사" | 30 |
| §16 W3 | 50탭·더블탭·두 게이트·비행기 모드·RPC 차단 | 33 |
| §18 | 스태프 단말기 간섭(읽기 모드 금지, 재탭 UX, 성공률 측정) | 18, 23, 33 |

### 2. 위협 모델 대응

| # | 위협 | 이 계획에서 막는 곳 |
|---|---|---|
| T2 | 태그 복제 | Task 16 — 매 3초 새 128비트 난수 nonce, Task 20 — 60초 창 밖이면 `EXPIRED_CODE`. 고정 페이로드가 존재하지 않는다 |
| T9 | 공연장 인터넷 다운 | Task 25(서명된 스냅샷), 27(로컬 P-256 검증), 28(내구 큐), 29(복구 후 대사) |
| T10 | RPC·번들러 지연 | Task 26(RPC 프로브로 오프라인 판정), 23(5초 초과는 `EXPIRED_CODE`, 절대 admit 아님), 28(백오프 재시도) |
| T12 | 더블 탭·재시도 | Task 23 `onResponse` 가 settled 상태에서 무시 + Task 22 `ALREADY_USED` 매핑 |
| T13 | 두 게이트 동시 | 체인이 원자적으로 하나만 통과시키고, Task 24가 자기 nonceHash 만 인정하며, Task 29가 진 쪽을 `conflict` 로 기록 |
| T14 | 가짜 게이트 | 관객 폰 쪽 방어는 03 소관. 단말기 쪽은 Task 15가 `gateOf` 가 0이 아닐 때만 게이트 화면으로 넘어가고, 폐기되면 `revoked` 로 되돌아간다 |
| T15 | 단말기 도난 후 큐 조작 | Task 27·28 — 큐 항목은 관객 기기 키 서명을 그대로 담고 있고 단말기는 그 서명을 만들 수 없다. Task 27 테스트가 다른 기기 키로는 검증이 실패함을 고정 |

### 3. 플레이스홀더 스캔

- "TBD / TODO / 나중에 / 적절히 처리" 문자열: 0. 모든 코드 스텝이 import 포함 완전 코드다.
- "Task N과 비슷하다": 0. Task 8(대안 HCE)과 Task 22·32처럼 반복되는 개념도 코드를 다시 적었다.
- 정의 없이 참조한 타입·함수: 없음. 01~03에서 와야 하는 것은 **가정한 인터페이스** 절에 시그니처를 박아 두었고 Task 34가 실제와 대조한다.
- 조건부 태스크 하나(Task 8)는 "S1c 실패 시에만"이라고 실행 조건을 명시했다. 플레이스홀더가 아니라 분기다.

### 4. 타입 일관성 (마스터 플랜 대비)

- `GateCodeWire`, `GateResponseWire`, `SnapshotWire` 필드명·타입을 그대로 썼다. `gateId`·`eventId`·`tokenId` 는 **문자열**, `issuedAt` 은 **초 단위 number**, `nonce`·`kx`·`ky`·`sig`·`deviceSig` 는 `Hex`.
- Cloud Function 이름은 `issueSnapshot`, `getPhotoForGate` 그대로. 입력은 각각 `{ eventId, gateAccount }`, `{ tokenId, gateAccount }` 이고 **인증 주체는 스태프 본인의 Firebase 세션**이다(게이트 기기 계정이 아니다). 마스터 플랜 Cloud Functions 표의 "callable (staff)" 행을 이 입력으로 갱신해야 한다.
- `Identity.register` 가 `Registered` 와 함께 `DeviceChanged` 도 내보내게 바뀌었다. 이 계획은 `CheckedIn` 만 구독하므로(Task 24) 영향이 없다. 스냅샷의 `deviceX/deviceY` 는 02가 `issueSnapshot` 발급 시점에 체인에서 읽어 넣는 값이라 중복 이벤트와 무관하다.
- 스태프 UI 상태 8개는 웹 모듈 표(`idle, ready, received, confirming, admit, offlineAdmit, deny, override`)와 순서까지 일치하며 Task 14가 테스트로 고정.
- `Ticket.checkIn(tokenId, GateCode, deviceSig)` 의 `GateCode` 필드 순서(`gateId, eventId, issuedAt, nonce`)와 서명 다이제스트 순서(`tokenId, gateId, eventId, nonce, issuedAt`)가 서로 다르다는 마스터 플랜의 사실을 Task 21과 Task 27이 각각 따로 지킨다. 둘을 섞지 않았다.
- `CODE_WINDOW = 60` (Solidity 상수) ↔ `CODE_WINDOW_SECONDS = 60` (TS 상수). 이름이 다르므로 Task 34에서 사람이 한 번 확인할 것.
- 유저옵 영수증은 03 정본 `{ success, txHash, blockNumber, revertReason? }` 와 `wait(timeoutMs?)` 로 통일했다(Task 21·28·30·32). `blockNumber` 만 마스터 플랜과 이름이 같다.
- `DenyCode` 는 스펙 §13의 9개 + `EVENT_ENDED` = 10개다. `DENY_LABELS` 의 키 개수를 Task 22가 테스트로 고정한다.
- 정규화·다이제스트는 `@monti/shared` 한 곳에만 존재한다. `apps/web/src/staff/snapshot/canonical.ts` 는 만들지 않는다.

### 5. 01~03에 없어서 이 계획이 가정한 것 (넘겨줄 목록)

1. `sendSponsoredOp({ account, calls, orgId })` — 03 `shared/chain/sponsored.ts`. 마스터 플랜 웹 모듈 표에 없다. 반환 `{ userOpHash, wait(timeoutMs?) }`, 영수증은 03 정본대로 `{ success, txHash, blockNumber, revertReason? }`. **가스 한도 ×1.075 는 이 함수 안에서 붙인다**(Global Constraints).
2. `subscribeLogs({ address, topics, onLog })` + `ChainLog.stage: 'speculative' | 'finalized'` — 마스터 플랜은 `subscribeLogs(topic)` 뿐이다. 추측·확정 구분이 없으면 Task 24의 "굳히기"가 불가능하다.
3. `ensureDeviceKey({ alias, requireAuth, strongBox })` / `signWithDeviceKey(hash, { alias })` — 마스터 플랜은 인자 없는 버전만 정의했다. 게이트 키는 **생체 없이** 3초마다 서명해야 하므로 별칭과 `requireAuth: false` 가 필수다. `signWithDeviceKey` 가 입력 해시를 다시 해시하지 않는다는 계약도 필요하다.
4. 어테스터 주소 읽는 경로 — 마스터 플랜 Reconciliation 에 `Identity.attester()` view 가 있지만 스냅샷 검증용 어테스터 주소를 `packages/shared` 의 `ATTESTER_ADDRESS` 상수에서 읽는다. 01이 view 를 추가하면 Task 34 Step 3의 지시대로 `eth_call` 로 바꾼다.
5. `SnapshotWire.attesterSig` 의 서명 방식 — 마스터 플랜은 "secp256k1 over keccak256(canonical JSON without attesterSig)" 라고만 적었다. **EIP-191 prefix 없는 raw 서명**으로 가정했다. 정규화·다이제스트는 02의 `packages/shared/src/encoding.ts`(`canonicalJson`, `snapshotDigest`)가 소유하며 이 계획은 복제하지 않는다 — `snapshotDigest` 가 `attesterSig` 없는 객체를 받는다는 계약만 지킨다(Task 25 `snapshotBody`).
6. `Ticket.sol` 커스텀 에러 8개 이름 — 01에 아직 없다. Task 22의 셀렉터 표와 Task 34의 대조 테스트가 이 이름들을 전제한다.
7. `apps/web/src/shared/api/functions.ts` 의 `issueSnapshot({ eventId, gateAccount })` / `getPhotoForGate({ tokenId, gateAccount })` / `submitPendingGate({ eventId, gateAccount, kx, ky, deviceLabel })` 래퍼 — 02가 함수를 만들고 03이 래퍼를 만든다는 전제. 두 callable 은 **스태프 본인 Firebase 세션**으로 인증되고, 서버가 ① 호출자가 그 공연 org 의 매니저·관리자인지 ② `gateAccount` 가 그 공연의 등록된 게이트인지를 검사한다. 따라서 **스태프 로그인이 게이트 화면의 선행 조건**이다(P8) — 03이 로그인 상태를 스태프 셸에서 보장해야 하고, 없으면 사진과 오프라인 스냅샷이 둘 다 막힌다.
8. `apps/web/src/staff/components/*` 컴포넌트 9개와 03 정본 props(헤더 "가정한 인터페이스" 절에 그대로 적어 두었다) — Task 30이 이 이름과 props 로 import 한다. `photoJpegB64` 가 빈 문자열일 때 `AdmitCard`·`OfflineAdmitCard` 가 아바타 플레이스홀더 + `displayName` + "본인인증 없음 · 사진 대조 불가" 칩을 그린다는 것도 03의 책임이다.
9. `getStaffAccount()` — 03 `shared/chain/accounts.ts`. 패스키 로그인이 만든 스태프 본인 스마트 계정. Task 32가 수동 승인을, Task 30이 승인 권한 판정을 여기서 한다.
9-a. `useStaffSession(): { displayName, selectedEventId? }` — 03 `shared/staffSession.ts`. `StaffShell` 의 `staffName` 과 Task 15의 등록 신청 대상 공연이 여기서 온다.
9-b. `SnapshotWire` 의 최상위 `eventTitle: string`·`requireKyc: boolean` 과 `tickets[].tierName: string`·`seat: string`, 그리고 `Ticket.EventMeta.requireKyc` — 마스터 플랜의 `SnapshotWire`·`EventMeta` 에 아직 없다(창업자 델타). Task 30은 **스냅샷을 1순위**로 읽고 스냅샷이 없는 첫 실행에서만 `eventMeta` 로 떨어진다. `requireKyc == false` 면 `photoJpegB64` 가 "" 이고 카드가 아바타 + 닉네임 + "본인인증 없음" 칩을 그린다. 헤더에는 `eventTitle` 과 "KYC 행사 / 일반 행사"가 함께 뜬다. **체크인 경로는 바뀌지 않는다.** Task 34가 타입과 ABI 양쪽을 확인한다.
9-c. `Ticket.sol` 에 `EventEnded()`·`EventNotPublished()` 커스텀 에러가 있다는 전제 — Task 22가 전자를 `EVENT_ENDED`(라벨 "행사 종료"), 후자를 상세 문구가 붙은 `TX_FAILED` 로 매핑한다.
10. `Ticket.eventOrg(eventId)` 로 얻는 `orgId` 를 게이트 화면이 언제 읽는지 — 이 계획은 `useGate` 에 `orgId` 를 props 로 받는다. 03의 스태프 부트스트랩이 `eventOrg` 를 한 번 읽어 넘겨주어야 한다.
11. Capacitor CLI 의 `--config` 플래그 지원 여부 — Task 10 Step 5에 검증과 대체 경로를 적어 두었다.
12. 루트 `pnpm vitest run <path>` 가 동작하도록 03이 vitest 를 루트에 설치했다는 전제 (Task 1 Step 1이 워크스페이스에 플러그인을 추가한다).

### 6. 범위 밖으로 둔 것

- 게이트 계정의 첫 배포(`initCode`) 비용과 파우셋 충전은 01 Task 11·12(페이마스터·팩토리)와 마스터 플랜 Task 0.6(S6)의 몫이다. 이 계획은 `sendSponsoredOp` 가 미배포 계정도 처리한다고 가정한다.
- 관객 폰 쪽 무장·읽기·쓰기(스펙 §7.2 1·3·4단계)는 03이다. 이 계획은 4단계가 만들어 낸 `monti.app:s` 를 받는 지점에서 시작한다.
- 주최자 웹의 `registerGate`·`openGate` 호출은 03의 `organizer/` 다. Task 15는 그 결과를 폴링할 뿐이다.
