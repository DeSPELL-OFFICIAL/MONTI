# MONTI Implementation Plan · 03 Web App + Attendee Capacitor Shell (웹앱과 관객 껍데기)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Read `docs/superpowers/plans/2026-09-20-monti-00-master-plan.md` first (Shared Interfaces **and the "Delta 2026-09-20 (spec v2.4)" section** are authoritative), then this file, then the spec.

**Goal:** `apps/web` 하나의 React 코드베이스로 관객·주최자·스태프 화면을 전부 만들고, 그 코드를 Capacitor 8로 감싼 관객용 iOS·Android 껍데기(앱 id `app.monti`)에서 NFC 읽기·쓰기, 패스키, 하드웨어 기기 키, 스폰서 유저옵이 실제로 동작하게 만든다.

**Architecture:** 웹 코드 하나 + 얇은 네이티브 4곳. **화면은 전부 모바일 전용**(콘텐츠 최대 480px, safe-area inset, 하단 탭 바 + FAB). `src/shared/`가 체인(viem 공개 클라이언트·번들러·스마트 계정·스폰서 유저옵), 패스키, 기기 키, NFC, Firebase 콜러블, i18n을 감싸 **플랫폼 분기와 문구를 한 겹 안에 가둔다**. `src/attendee/`는 그 API만 쓰고 크립토 단어를 한 글자도 쓰지 않는다(`pnpm lint:copy`가 CI에서 `ko`·`en` 두 로케일 모두에 대해 강제). `src/organizer/`와 `src/staff/`는 같은 코드베이스지만 내부적으로 크립토 용어를 써도 된다. 스태프 콘솔은 이 계획에서 **UI(상태 기계 컴포넌트)만** 만들고 로직은 sub-plan 04가 붙인다.

**Tech Stack:** React 19.2 + Vite 7 + TypeScript 5.9, React Router 7, TanStack Query 5, i18next 25 + react-i18next 16, `@dnd-kit/core`·`@dnd-kit/sortable` 10(대화 목록 정렬), viem 2.38 + ox 0.9, `@noble/curves` 1.9(P-256 게이트 서명 검증), `cborg` 4(NDEF 페이로드), `qrcode` 1.5(QR 폴백), Firebase Web SDK 12(Auth·Functions·Firestore·Messaging), Capacitor 8(`@capgo/capacitor-nfc`, `@capgo/capacitor-passkey`, `@perfood/capacitor-crypto-api`, `@capacitor-firebase/authentication`, `@capacitor/browser`, `@capacitor/app`, `@capacitor/push-notifications`, `@capacitor/preferences`), vitest 3 + Testing Library 16, Playwright 1.55.

**Spec:** `docs/superpowers/specs/2026-09-20-monti-nfc-ticketing-design.md` (v2.3, 확정) + 마스터 계획의 "Delta 2026-09-20 (spec v2.4)". 이 계획은 §3, §5.1–5.6, §6, §7.2–7.3, §8.1–8.2, §9.3, §13, §17과 v2.4 델타의 웹 항목 전부를 구현한다. 실행자는 세 문서를 모두 읽는다.

---

## Global Constraints

마스터 계획에서 그대로 옮긴 것이다. **이 sub-plan의 모든 태스크는 아래를 암묵적으로 포함한다.**

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
- Commit after every green test. Conventional commits (`feat:`, `test:`, `chore:`). Repository initialized in master Task 0.1.

### 이 sub-plan에만 추가되는 규칙

- 루트에 `vitest.workspace.ts`가 있으므로 **저장소 루트에서도 `pnpm vitest run <path>`가 동작한다**(sub-plan 04가 이 방식으로 돈다). 이 문서의 명령은 경로가 짧은 `apps/web/` 기준으로 적었고, 루트에서 돌릴 때는 경로 앞에 `apps/web/`을 붙이면 된다. `pnpm exec playwright test …`, `pnpm exec tsc …` 는 **`apps/web/` 디렉터리에서** 실행한다. `pnpm lint:copy`, `pnpm -C packages/shared …` 는 저장소 루트에서, `npx cap …` 는 `apps/web/` 에서 실행한다. 태스크마다 명시한다.
- 관객 문구는 **전부** `apps/web/src/shared/copy/ko.ts` 와 `apps/web/src/shared/copy/en.ts` 두 파일에 있다. 두 파일은 같은 키 집합을 가지며 타입으로 강제된다. `src/attendee/**`의 TSX에는 사람에게 보이는 리터럴을 직접 쓰지 않고 `useCopy()`만 쓴다. 스태프 문구는 `src/staff/copy.ts`, 주최자 문구는 `src/organizer/copy.ts`에 따로 둔다(그쪽은 금지어 검사 대상이 아니다 — §13의 "체인 확인 중"처럼 금지어가 합법적으로 들어간다).
- **모바일 전용.** 모든 화면은 `max-width: 480px`, `padding-inline: 16px`, `env(safe-area-inset-*)`를 쓰는 `Screen` 컴포넌트 안에 들어간다. 데스크톱 레이아웃·사이드바·2단 그리드를 만들지 않는다. 항상 닿아야 하는 동작은 하단 탭 바 또는 FAB이다.
- 플랫폼 분기는 `Capacitor.isNativePlatform()` 한 곳에서만 본다. 각 `shared/*` 모듈은 `index.ts`(분기) + `native.ts` + `web.ts` 3파일 구조를 지킨다.
- Capacitor 플러그인 3개(`@capgo/capacitor-nfc`, `@capgo/capacitor-passkey`, `@perfood/capacitor-crypto-api`)는 채택 수가 적다. 각 모듈은 **plugin adapter 파일 1개**로 플러그인 표면을 격리하고, 태스크마다 설치된 `dist/esm/definitions.d.ts`를 실제로 열어 시그니처를 맞추는 검증 스텝을 둔다. adapter 밖 코드는 절대 플러그인을 직접 import하지 않는다.
- 하드코딩 금지: 컨트랙트 주소, RPC, 번들러 URL, RP ID, Envio URL, IPFS 게이트웨이, Pinata 키는 전부 `src/shared/config.ts`를 거친다.
- 대화(채팅)는 **명시적인 오프체인 예외**다. 체인에 올리지 않고 Firestore에만 두며, 행사가 끝나면 닫히고 24시간 뒤 목록에서 사라진다. 다른 어떤 상태도 이 예외를 이유로 Firestore에 두지 않는다.

---

## File Structure (이 sub-plan이 만드는 파일)

```
apps/web/
  package.json  vite.config.ts  vitest.setup.ts  tsconfig.json  index.html  playwright.config.ts
  capacitor.config.ts
  public/.well-known/            (master Task 0.2가 이미 올린 AASA/assetlinks를 빌드에 포함)
  e2e/                           Playwright 스모크 3종
  ios/  android/                 npx cap add 로 생성되는 껍데기
  src/
    main.tsx  App.tsx  router.tsx
    shared/
      config.ts                  환경변수 → AppConfig
      copy/ko.ts  copy/en.ts  copy/index.ts   관객 문구 전량 (금지어 lint 대상)
      i18n.ts                    i18next 초기화 + useCopy()
      theme.css
      ui/ Screen.tsx BottomTabs.tsx Fab.tsx Button.tsx Alert.tsx Countdown.tsx Spinner.tsx Field.tsx Sheet.tsx
      session.ts                 로그인 상태 + 현재 스마트 계정
      chain/
        chain.ts client.ts subscribe.ts abis.ts reads.ts bundler.ts sendSponsoredOp.ts
      passkey/ deviceKey/ nfc/   각각 index.ts / native.ts / web.ts / plugin.ts / types.ts
      api/ firebase.ts callables.ts auth.ts firestore.ts
      envio/ client.ts queries.ts ipfs.ts
      push/ index.ts
    attendee/
      Login.tsx
      discover/ Discover.tsx Filters.tsx EventDetail.tsx useEvents.ts
      signup/ Phone.tsx Verify.tsx Kyc.tsx Passkey.tsx Device.tsx Done.tsx useSignup.ts
      tickets/ List.tsx Detail.tsx Inbox.tsx useTickets.ts ticketState.ts
      claim/ Claim.tsx useClaim.ts
      transfer/ Recipient.tsx Confirm.tsx Invite.tsx precheck.ts useTransfer.ts
      enter/ Enter.tsx useArm.ts verifyGate.ts buildResponse.ts Qr.tsx Result.tsx
      chats/ ChatList.tsx ChatRoom.tsx useChats.ts
      me/ Profile.tsx Nickname.tsx DeviceLock.tsx NewDevice.tsx
    organizer/
      copy.ts  Layout.tsx Dashboard.tsx Team.tsx Announce.tsx
      wizard/ Step1Basic.tsx Step2When.tsx Step3Tiers.tsx Step4Rules.tsx Step5Staff.tsx Step6Review.tsx
              useWizard.ts buildEventMeta.ts pinata.ts regions.ts
      invites/ Invites.tsx Accept.tsx
      gates/ Gates.tsx
    staff/
      copy.ts  Console.tsx ConsoleStates.tsx Override.tsx types.ts   ← UI만. 로직은 sub-plan 04
packages/shared/                 (이 계획이 부트스트랩, 02가 확장)
  package.json  tsconfig.json  src/types.ts  src/encoding.ts  src/copy-lint.ts  src/abi/*.json (01이 채움)
```

---

## Interfaces consumed from other sub-plans

### `packages/shared` (Task 2가 부트스트랩, 02가 확장)

```ts
// packages/shared/src/types.ts — 마스터 계획 Shared Interfaces 그대로
export type Hex = `0x${string}`;
export interface GateCodeWire { v: 1; gateId: string; eventId: string; issuedAt: number; nonce: Hex; kx: Hex; ky: Hex; sig: Hex }
export interface GateResponseWire { v: 1; tokenId: string; deviceSig: Hex }
export interface SnapshotWire { v: 1; eventId: string; eventTitle: string; requireKyc: boolean;
  epoch: number; expiresAt: number;
  tickets: Array<{ tokenId: string; account: Hex; deviceX: Hex; deviceY: Hex; photoJpegB64: string;
    displayName: string; tier: number; tierName: string; seat: string; checkedIn: boolean }>;
  attesterSig: Hex }
export const BANNED_ATTENDEE_WORDS: string[];

// packages/shared/src/encoding.ts
export function encodeCbor(value: unknown): Uint8Array;
export function decodeCbor<T = unknown>(bytes: Uint8Array): T;
export function toBase64Url(bytes: Uint8Array): string;
export function fromBase64Url(text: string): Uint8Array;
export function derToCompactSignature(der: Uint8Array): { r: Hex; s: Hex };
export function spkiToXy(spki: Uint8Array): { x: Hex; y: Hex };

// packages/shared/src/copy-lint.ts
export interface CopyLintFinding { file: string; line: number; word: string; text: string }
export function lintCopy(targets: string[]): CopyLintFinding[];
```

### Contracts (sub-plan 01) — 이 계획이 실제로 호출하는 것만

읽기: `Identity.isMember(address)`, `Identity.activeDevice(address)`, `Identity.isLocked(address)`, `Identity.accountOf(bytes32)`, `Identity.deviceUpdatedAt(address)`, `Identity.nicknameOwner(bytes32)`, `Identity.nicknameOf(address)`, `Identity.kycLevelOf(address) → uint8` (0 미인증, 1 신분증·얼굴 확인 완료), `Organizers.gateInfo(uint256)`, `Organizers.isOpenGate(uint256,address)`, `Organizers.hasPermission(uint256,address,uint32)`, `Ticket.eventMeta(uint256)`, `Ticket.tiers(uint256)`, `Ticket.eventStatus(uint256)`, `Ticket.balanceOfEvent(address,uint256)`, `Ticket.transfersOf(uint256)`, `Ticket.checkInOf(uint256)`, `Ticket.offerOf(uint256)`, `Ticket.eventOf(uint256)`, `Ticket.ownerOf(uint256)`.

쓰기(전부 스폰서 유저옵): `Ticket.claim(uint256,uint8,bytes)`, `Ticket.safeTransferFrom(address,address,uint256)`, `Ticket.createOffer(uint256,bytes32,uint64)`, `Ticket.cancelOffer(uint256)`, `Ticket.acceptOffer(uint256,bytes)`, `Ticket.createEvent(EventMeta,Tier[])`, `Ticket.updateEventMeta(uint256,EventMeta,Tier[])`, `Ticket.publishEvent(uint256)`, `Ticket.cancelEvent(uint256)`, `Organizers.registerGate(uint256,address,bytes32,bytes32)`, `Organizers.openGate(uint256)`, `Organizers.closeGate(uint256)`, `Organizers.setAdmin(uint256,address,uint32)`, `Organizers.setManager(uint256,address,bool,bool)`, `Identity.setActiveDevice(bytes32,bytes32)`, `Identity.setNickname(bytes32,string)`.

구조체(v2.4 델타 반영, **`EventMeta`는 끝에 두 필드가 붙었다**):

```ts
// 이 계획에서 쓰는 TS 미러 — src/shared/chain/abis.ts 의 as const ABI와 일치해야 한다
export interface EventMetaStruct {
  orgId: bigint; titleHash: Hex; descHash: Hex; imageCid: string;  // imageCid = 메타데이터 JSON의 CID
  startsAt: bigint; endsAt: bigint; venueHash: Hex; saleStart: bigint; saleEnd: bigint;
  transferable: boolean; transferCutoffSeconds: number; maxTransfers: number; approvalRequired: boolean;
  category: number;      // 0 공연 1 모임 2 전시 3 기타
  regionCode: Hex;       // keccak256("KR-11")
  requireKyc: boolean;   // appended LAST in the struct, after regionCode. Per-event KYC gate.
}
export interface TierStruct { name: string; priceUsdCents: bigint; supply: number; minted: number; maxPerWallet: number; seated: boolean }
export interface OfferStruct { from: Hex; recipientCommitment: Hex; expiresAt: bigint }
export interface CheckInStruct { gateId: bigint; ts: bigint; nonceHash: Hex; manual: boolean }
export type EventStatus = 0 | 1 | 2 | 3;  // Draft, Published, Cancelled, Ended
```

이벤트 구독: `Ticket.CheckedIn`, `Ticket.Claimed`, `Ticket.Transfer`, `Ticket.OfferAccepted`, `Organizers.GateRegistered`.

### Cloud Functions callables (sub-plan 02, region `asia-northeast3`)

마스터 계획의 표 + v2.4 델타에 있는 것을 **이름과 타입 그대로** 소비한다. 이 계획은 아래 TS 시그니처로 래핑한다(Task 16).

```ts
startSignup(): Promise<{ personId: string }>;                    // no KYC here: identity verification is per-event
startKyc(): Promise<{ kycUrl: string; sessionId: string }>;       // opens a Didit session for the signed-in person
getSignupStatus(): Promise<{
  status: 'pending' | 'kyc_ok' | 'rejected' | 'active' | 'rotated';
  kycLevel: number;          // 0 unverified, 1 id + face verified
  reason?: 'duplicate_face' | 'document_failed' | 'liveness_failed';
  account?: Hex;
  kycUrl?: string;           // present while a Didit session is open
}>;
registerPasskey(a: { personId: string; attestation: unknown }): Promise<{ ok: true }>;
registerIdentity(a: { personId: string; deviceX: Hex; deviceY: Hex }): Promise<{ txHash: Hex }>;
loginChallenge(): Promise<{ challenge: string; rpId: string }>;
loginVerify(a: { assertion: unknown }): Promise<{ customToken: string }>;
lockDevice(): Promise<{ txHash: Hex }>;
startDeviceChange(a: { method: 'sms' | 'kyc' }): Promise<{ allowedAt: number; kycUrl?: string }>;
resolveRecipient(a: { type: 'phone' | 'nickname' | 'address'; value: string }):
  Promise<{ member: boolean; account?: Hex; nickname?: string; commitment?: Hex }>;
createTransferInvite(a: { tokenId: string; phoneE164: string }):
  Promise<{ inviteId: string; commitment: Hex; expiresAt: number; smsText: string; smsUri: string }>;
pendingOffers(): Promise<Array<{ tokenId: string; attesterSig: Hex }>>;
joinEventChat(a: { eventId: string }): Promise<{ ok: true }>;
reportMessage(a: { eventId: string; msgId: string }): Promise<{ ok: true }>;
listAttendees(a: { eventId: string }): Promise<Array<{ tokenId: string; nickname: string; tier: number; checkedIn: boolean; kycLevel: number }>>;
submitPendingGate(a: { eventId: string; gateAccount: Hex; kx: Hex; ky: Hex; deviceLabel: string }): Promise<{ ok: true }>;
listPendingGates(a: { eventId: string }): Promise<{ gates: Array<{ gateAccount: Hex; kx: Hex; ky: Hex; label: string; createdAt: number }> }>;
createInvite(a: { orgId: string; role: 'admin' | 'manager'; phoneE164: string; permissionBits?: number; canApprove?: boolean }): Promise<{ inviteId: string }>;
acceptInvite(a: { inviteId: string }): Promise<{ orgId: string; role: 'admin' | 'manager'; to: Hex; data: Hex }>;
// Staff-only (consumed by sub-plan 04 through this same module). The gate device account is passed
// as data; the caller is always the staff member's Firebase session.
issueSnapshot(a: { eventId: string; gateAccount: Hex }): Promise<SnapshotWire>;
getPhotoForGate(a: { tokenId: string; gateAccount: Hex }): Promise<{ photoJpegB64: string; displayName: string }>;
```

직접 Firestore 읽기·쓰기(콜러블 아님, 보안 규칙이 허용하는 범위):
`users/{uid}` 의 `nickname` `locale` `chatOrder` 쓰기, `devices/{account}.pushToken` 쓰기,
`eventChats/{eventId}` 문서 구독, `eventChats/{eventId}/messages` 구독과 메시지 생성(`{ uid, text, createdAt, pinned:false, reported:0 }`).

### Shared module signatures reconciled with sub-plan 04 (authoritative)

스태프 단말기(04)가 `apps/web/src/shared`를 그대로 재사용한다. **아래 시그니처가 최종이며, 이 문서의 모든 태스크는 이 모양을 쓴다.**

```ts
// shared/chain/sendSponsoredOp.ts
export interface SponsoredCall { to: Hex; data: Hex; value?: bigint }
export interface SponsoredOpReceipt { success: boolean; txHash: Hex; blockNumber: bigint; revertReason?: Hex }
export class SponsoredOpTimeout extends Error { readonly userOpHash: Hex; readonly timeoutMs: number }
export const DEFAULT_WAIT_TIMEOUT_MS = 15_000;
export interface SponsoredOpHandle {
  userOpHash: Hex;
  /** Polls eth_getUserOperationReceipt; rejects with SponsoredOpTimeout once timeoutMs elapses. */
  wait(timeoutMs?: number): Promise<SponsoredOpReceipt>;
}
export function sendSponsoredOp(args: { account: SmartAccount; calls: SponsoredCall[]; orgId: bigint }): Promise<SponsoredOpHandle>;
// limits = estimate × 1.075; paymasterAndData = encodePacked(['address','uint256'],[PAYMASTER, orgId]);
// calls.length > 1 → Coinbase Smart Wallet executeBatch (account.encodeCalls already emits it).

// shared/chain/subscribeLogs.ts
export type LogStage = 'speculative' | 'finalized';        // renamed: staff/types.ts owns `ChainStage` (3 members)
export type ChainLog = Log & { stage: LogStage };
export function subscribeLogs(args: { address: Hex; topics: (Hex | Hex[] | null)[]; onLog: (log: ChainLog) => void }): () => void;
// monadLogs WebSocket: commitState Proposed/Voted → 'speculative', Finalized → 'finalized';
// fallback = per-block eth_getLogs with blockTag 'latest' then 'finalized'.

// shared/chain/accounts.ts
export function getStaffAccount(): Promise<SmartAccount>;   // the staff member's own passkey account
export function getAttendeeAccount(): Promise<SmartAccount>; // the attendee's own passkey account

// shared/deviceKey/index.ts
export const ATTENDEE_KEY_ALIAS = 'monti-attendee';
export const GATE_KEY_ALIAS = 'monti-gate';
export function ensureDeviceKey(options: { alias: string; requireAuth: boolean; strongBox: boolean }): Promise<{ x: Hex; y: Hex }>;
export function armDeviceKey(options: { alias: string }): Promise<void>;
export function signWithDeviceKey(digest: Hex, options: { alias: string }): Promise<{ r: Hex; s: Hex }>;
// signs the 32-byte digest RAW — no re-hashing. iOS .ecdsaSignatureDigestX962SHA256, Android NONEwithECDSA.
// attendee: { alias: ATTENDEE_KEY_ALIAS, requireAuth: true, strongBox: true }
// gate (04): { alias: GATE_KEY_ALIAS,    requireAuth: false, strongBox: true }

// shared/api/functions.ts — one typed wrapper per callable in the master plan and its delta,
// including the staff-only two. Both carry the gate device account explicitly, because the gate
// account itself never authenticates: the call is made with the STAFF member's Firebase session
// and the server checks organizers.isOpenGate(eventId, gateAccount) (or manager role) against it.
export const api: {
  issueSnapshot(a: { eventId: string; gateAccount: Hex }): Promise<SnapshotWire>;
  getPhotoForGate(a: { tokenId: string; gateAccount: Hex }): Promise<{ photoJpegB64: string; displayName: string }>;
  /* … every other callable, see Task 16 … */
};
```

스태프 콘솔 UI는 `src/staff/components/index.ts`에서 다음 컴포넌트를 내보낸다(전부 props-driven, 상태 저장 없음):
`StaffShell`, `TapPrompt`, `ReceivedCard`, `ConfirmingCard`, `AdmitCard`, `OfflineAdmitCard`, `DenyCard`, `OverrideDialog`, `OfflineBadge`. 정확한 prop 이름은 Task 31에 있다.

### Callables newly defined by this sub-plan (마스터 계획에도 v2.4 델타에도 없음 → 02에 추가 요청)

v2.4 델타가 `getSignupStatus`, `resolveRecipient`, `listPendingGates`를 마스터에 올려놓았으므로 남는 것은 **두 개**다.

```ts
// 1) pinMessage — 주최자 공지. pinned 는 조직 관리자만 설정할 수 있는데, 관리자 여부는 체인 allowlist에만
//    있어 Firestore 보안 규칙으로 판정할 수 없다. 그래서 서버가 Organizers.hasPermission 을 eth_call 로
//    확인하고 대신 쓴다. callable, auth: Firebase user.
type PinMessageReq = { eventId: string; msgId: string; pinned: boolean };
type PinMessageRes = { ok: true };

// 2) requestAccountDeletion — 프로필의 "계정 삭제 요청". 개인정보 보호법 대응 창구이며, persons/users/
//    passkeys/devices 문서를 예약 삭제 큐에 넣는다. 체인의 personId 는 난수라 남아도 식별되지 않는다.
type RequestAccountDeletionReq = { reason?: string };
type RequestAccountDeletionRes = { ok: true; scheduledFor: number };
```

**`pinImage` 콜러블은 정의하지 않는다.** 주최자 브라우저가 **Pinata v3 업로드 엔드포인트를 직접 호출**한다(Task 33). 이유: ① 이미지와 메타데이터 JSON은 공개 자료라 서버가 중계할 보안 이득이 없고, ② 콜러블을 거치면 요청 크기 한도와 콜드스타트가 끼고, ③ Pinata는 **범위 제한 키(scoped key: 파일 업로드만 허용, 나머지 권한 전부 off)**를 콘솔에서 발급할 수 있어 브라우저 노출 위험이 제한된다. 키는 `VITE_PINATA_JWT`로 주입하고 유출 시 콘솔에서 즉시 폐기한다. 유료 전환 시 서버 서명 업로드로 옮긴다.

### Envio entities (sub-plan 02, v2.4 델타 포함)

`Event(id, orgId, titleHash, descHash, imageCid, startsAt, endsAt, venueHash, saleStart, saleEnd, transferable, transferCutoffSeconds, maxTransfers, approvalRequired, category, regionCode, status: String, requireKyc)`,
`Tier(id=eventId-idx, eventId, name, priceUsdCents, supply, minted, maxPerWallet, seated)`,
`Ticket(id=tokenId, eventId, tier, owner, transfers, revoked)`,
`CheckIn(id=tokenId, gateId, ts, nonceHash, manual, txHash, block)`,
`Offer(id=tokenId, from, commitment, expiresAt, status)`,
`Gate(id=gateId, eventId, account, kx, ky, open, revoked)`,
`IdentityAccount(id=account, personId, deviceX, deviceY, locked, deviceUpdatedAt, nickname, kycLevel)`,
`Admin(id=orgId-account, bits)`, `Manager(id=orgId-account, canApprove)`, `Organizer(id=orgId, owner)`.

---
## Task 1: `apps/web` 스캐폴드와 테스트 하네스

**Files:**
- Create: `apps/web/package.json`, `apps/web/vite.config.ts`, `apps/web/tsconfig.json`, `apps/web/index.html`, `apps/web/vitest.setup.ts`, `apps/web/src/main.tsx`, `apps/web/src/App.tsx`
- Test: `apps/web/src/App.test.tsx`

**Interfaces:**
- Consumes: 없음(이 sub-plan의 첫 태스크). 저장소는 master Task 0.1에서 `pnpm-workspace.yaml`에 `apps/*`가 들어간 상태여야 한다.
- Produces: `@monti/web` 워크스페이스 패키지, `pnpm vitest run`이 `apps/web/`에서 동작, `App` 컴포넌트.

**이 태스크가 저장소의 모든 웹 의존성을 한 번에 설치한다.** Capacitor 코어·플러그인까지 전부 여기서 고정하고, 뒤 태스크는 **import만** 한다. 이유는 하나다 — T12가 `@capgo/capacitor-passkey`를, T13이 `@perfood/capacitor-crypto-api`를, T15가 `@capgo/capacitor-nfc`를, T16~T18이 `@capacitor/*`를 정적으로 import하는데 설치가 T32에 있으면 T3이 CI에 건 `typecheck`가 T12부터 빨간불로 남는다. 버전은 2026-09-21 npm 실측값이다.

- [ ] **Step 1: 패키지와 의존성 설치**

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI
mkdir -p apps/web/src
cat > apps/web/package.json <<'EOF'
{
  "name": "@monti/web",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "e2e": "playwright test"
  },
  "dependencies": {
    "@capacitor-firebase/authentication": "8.5.2",
    "@capacitor-mlkit/barcode-scanning": "8.0.0",
    "@capacitor/android": "8.5.2",
    "@capacitor/app": "8.5.2",
    "@capacitor/browser": "8.5.2",
    "@capacitor/core": "8.5.2",
    "@capacitor/ios": "8.5.2",
    "@capacitor/preferences": "8.5.2",
    "@capacitor/push-notifications": "8.5.2",
    "@capgo/capacitor-nfc": "8.2.8",
    "@capgo/capacitor-passkey": "8.5.2",
    "@dnd-kit/core": "6.3.1",
    "@dnd-kit/sortable": "10.0.0",
    "@dnd-kit/utilities": "3.2.2",
    "@monti/shared": "workspace:*",
    "@noble/curves": "1.9.2",
    "@noble/hashes": "1.8.0",
    "@perfood/capacitor-crypto-api": "8.0.0",
    "@tanstack/react-query": "5.62.11",
    "firebase": "12.6.0",
    "i18next": "25.5.2",
    "ox": "0.9.6",
    "qrcode": "1.5.4",
    "react": "19.2.0",
    "react-dom": "19.2.0",
    "react-i18next": "16.0.0",
    "react-router-dom": "7.9.1",
    "viem": "2.38.0"
  },
  "devDependencies": {
    "@capacitor/cli": "8.5.2",
    "@playwright/test": "1.55.0",
    "@testing-library/jest-dom": "6.6.3",
    "@testing-library/react": "16.3.0",
    "@testing-library/user-event": "14.6.1",
    "@types/qrcode": "1.5.5",
    "@types/react": "19.2.0",
    "@types/react-dom": "19.2.0",
    "@vitejs/plugin-react": "5.0.2",
    "jsdom": "26.1.0",
    "typescript": "5.9.2",
    "vite": "7.1.5",
    "vitest": "3.2.4"
  }
}
EOF
pnpm install
```

Expected: `pnpm install` 이 `+ 1 package` 대신 `apps/web` 워크스페이스를 인식하고 `Done in …` 로 끝난다. `@monti/shared`는 아직 없으므로 **이 단계에서는 `dependencies`의 `@monti/shared` 줄을 잠시 주석 대신 남겨두면 설치가 실패한다** — Task 2에서 `packages/shared`를 만든 뒤 다시 `pnpm install` 한다. 지금은 아래 명령으로 그 줄만 빼고 설치한다.

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI
node -e "const p=require('./apps/web/package.json');delete p.dependencies['@monti/shared'];require('fs').writeFileSync('./apps/web/package.json',JSON.stringify(p,null,2)+'\n')"
pnpm install
```

- [ ] **Step 2: 고정한 버전이 실제로 npm에 있는지 확인**

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI
for spec in \
  @capacitor/core@8.5.2 @capacitor/ios@8.5.2 @capacitor/android@8.5.2 @capacitor/cli@8.5.2 \
  @capacitor/app@8.5.2 @capacitor/browser@8.5.2 @capacitor/push-notifications@8.5.2 @capacitor/preferences@8.5.2 \
  @capacitor-firebase/authentication@8.5.2 @capacitor-mlkit/barcode-scanning@8.0.0 \
  @capgo/capacitor-nfc@8.2.8 @capgo/capacitor-passkey@8.5.2 @perfood/capacitor-crypto-api@8.0.0 \
  firebase@12.6.0 viem@2.38.0 ox@0.9.6 i18next@25.5.2 react-i18next@16.0.0 \
  @dnd-kit/core@6.3.1 @dnd-kit/sortable@10.0.0 @dnd-kit/utilities@3.2.2 @tanstack/react-query@5.62.11; do
  npm view "$spec" version >/dev/null 2>&1 && echo "ok   $spec" || echo "MISS $spec"
done
npm view @capacitor-firebase/authentication@8.5.2 peerDependencies.firebase
```
Expected: 모든 줄이 `ok`. 마지막 줄이 `^12.6.0` — `firebase`를 12.3.x로 두면 peer 경고가 난다. `MISS`가 나오면 그 패키지만 `npm view <name> versions --json | tail -5` 로 최신을 확인해 `package.json`을 고치고 다시 돌린다. **버전을 고친 뒤에도 설치는 이 태스크에서만 한다.**

- [ ] **Step 3: Vite, TypeScript, vitest 설정 파일**

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/apps/web
cat > vite.config.ts <<'EOF'
// vitest/config re-exports Vite's defineConfig with the `test` key typed.
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { host: '0.0.0.0', port: 5173 },
  build: { outDir: 'dist', sourcemap: true, target: 'es2022' },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    restoreMocks: true,
  },
});
EOF
cat > tsconfig.json <<'EOF'
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": false,
    "resolveJsonModule": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["vitest/globals", "@testing-library/jest-dom"]
  },
  "include": ["src", "vite.config.ts", "vitest.setup.ts", "capacitor.config.ts", "e2e"]
}
EOF
cat > vitest.setup.ts <<'EOF'
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

if (!globalThis.crypto?.getRandomValues) {
  throw new Error('WebCrypto is required for these tests; use Node 22+');
}
EOF
```

- [ ] **Step 4: 실패하는 테스트를 쓴다**

```tsx
// apps/web/src/App.test.tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from './App';

describe('App', () => {
  it('renders the app shell with a main landmark', () => {
    render(<App />);
    expect(screen.getByRole('main')).toBeInTheDocument();
  });
});
```

- [ ] **Step 5: 테스트가 실패하는지 확인**

Run (from `apps/web/`): `pnpm vitest run src/App.test.tsx`
Expected: FAIL — `Failed to resolve import "./App"` 또는 `Cannot find module './App'`.

- [ ] **Step 6: 최소 구현**

```tsx
// apps/web/src/App.tsx
export function App() {
  return <main />;
}
```

```tsx
// apps/web/src/main.tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('#root not found');
createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

```html
<!-- apps/web/index.html -->
<!doctype html>
<html lang="ko">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
    <title>MONTI</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 7: 테스트가 통과하는지 확인**

Run (from `apps/web/`): `pnpm vitest run src/App.test.tsx`
Expected: PASS — `Test Files  1 passed (1)` / `Tests  1 passed (1)`.

- [ ] **Step 8: 커밋**

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI
git add apps/web pnpm-lock.yaml
git commit -m "chore(web): scaffold vite react19 app with vitest harness"
```

---

## Task 2: `packages/shared` 부트스트랩 — 타입, CBOR, base64url, DER→r‖s

**Files:**
- Create: `packages/shared/package.json`, `packages/shared/tsconfig.json`, `packages/shared/src/types.ts`, `packages/shared/src/constants.ts`, `packages/shared/src/encoding.ts`, `packages/shared/src/index.ts`
- Test: `packages/shared/src/encoding.test.ts`

**Interfaces:**
- Consumes: 없음.
- Produces: `@monti/shared` 패키지. `Hex`, `GateCodeWire`, `GateResponseWire`, `SnapshotWire`, `BANNED_ATTENDEE_WORDS`, `encodeCbor`, `decodeCbor`, `toBase64Url`, `fromBase64Url`, `derToCompactSignature`, `spkiToXy`, 그리고 `constants.ts`의 `MONAD_MAINNET_CHAIN_ID`, `MONAD_TESTNET_CHAIN_ID`, `ENTRY_POINT_V06`, `EXPLORER_URLS`, `P256_PRECOMPILE`. **체인 id와 탐색기 URL 리터럴은 이 파일에만 있고, 나머지 코드는 `getConfig()`를 거친다**(Global Constraint "Never hardcode a chain id in logic"). sub-plan 02가 같은 패키지에 Firestore 타입과 ABI JSON을 추가하고, 01이 `src/abi/*.json`을 채운다. **이미 존재하면 덮어쓰지 말고 Step 1의 확인 명령 결과에 따라 빠진 export만 추가한다.**

- [ ] **Step 1: 이미 있는지 확인**

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI
ls packages/shared/src 2>/dev/null || echo "ABSENT"
```
Expected: `ABSENT`(02가 아직 안 돌았을 때) 또는 파일 목록. 목록이 나오면 `types.ts`/`encoding.ts`의 export를 위 Interfaces와 대조하고, 빠진 함수만 Step 4에서 추가한다.

- [ ] **Step 2: 패키지 골격과 의존성**

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI
mkdir -p packages/shared/src/abi
cat > packages/shared/package.json <<'EOF'
{
  "name": "@monti/shared",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" },
    "./encoding": { "types": "./dist/encoding.d.ts", "default": "./dist/encoding.js" },
    "./copy-lint": { "types": "./dist/copy-lint.d.ts", "default": "./dist/copy-lint.js" },
    "./abi/*": "./src/abi/*"
  },
  "scripts": { "build": "tsc -p tsconfig.json", "test": "vitest run" },
  "dependencies": { "cborg": "4.2.14" },
  "devDependencies": { "typescript": "5.9.2", "vitest": "3.2.4", "@types/node": "22.10.2" }
}
EOF
cat > packages/shared/tsconfig.json <<'EOF'
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM"],
    "strict": true,
    "declaration": true,
    "outDir": "dist",
    "rootDir": "src",
    "resolveJsonModule": true,
    "skipLibCheck": true
  },
  "include": ["src"]
}
EOF
pnpm install
```

- [ ] **Step 3: 실패하는 테스트를 쓴다**

```ts
// packages/shared/src/encoding.test.ts
import { describe, expect, it } from 'vitest';
import {
  decodeCbor,
  derToCompactSignature,
  encodeCbor,
  fromBase64Url,
  spkiToXy,
  toBase64Url,
} from './encoding.js';
import type { GateResponseWire } from './types.js';

const hexToBytes = (hex: string) =>
  Uint8Array.from(hex.match(/.{1,2}/g)!.map((b) => Number.parseInt(b, 16)));

describe('encoding', () => {
  it('round-trips a GateResponseWire through CBOR', () => {
    const wire: GateResponseWire = { v: 1, tokenId: '42', deviceSig: `0x${'ab'.repeat(64)}` };
    expect(decodeCbor<GateResponseWire>(encodeCbor(wire))).toEqual(wire);
  });

  it('round-trips bytes through base64url without padding', () => {
    const bytes = Uint8Array.from([251, 255, 0, 1, 2, 3, 4]);
    const text = toBase64Url(bytes);
    expect(text).not.toContain('=');
    expect(text).not.toContain('+');
    expect(text).not.toContain('/');
    expect(fromBase64Url(text)).toEqual(bytes);
  });

  it('converts a DER ECDSA signature to r||s hex', () => {
    // SEQUENCE(46) { INTEGER(1) 0x07, INTEGER(0x21) 0x00 || 0xff*32 }
    const der = hexToBytes(`3026020107022100${'ff'.repeat(32)}`);
    expect(derToCompactSignature(der)).toEqual({
      r: `0x${'00'.repeat(31)}07`,
      s: `0x${'ff'.repeat(32)}`,
    });
  });

  it('extracts x and y from an uncompressed P-256 SPKI key', () => {
    const header = '3059301306072a8648ce3d020106082a8648ce3d03010703420004';
    const spki = hexToBytes(`${header}${'11'.repeat(32)}${'22'.repeat(32)}`);
    expect(spkiToXy(spki)).toEqual({ x: `0x${'11'.repeat(32)}`, y: `0x${'22'.repeat(32)}` });
  });
});
```

- [ ] **Step 4: 테스트가 실패하는지 확인**

Run (from `packages/shared/`): `pnpm vitest run src/encoding.test.ts`
Expected: FAIL — `Failed to resolve import "./encoding.js"`.

- [ ] **Step 5: 구현**

```ts
// packages/shared/src/types.ts
export type Hex = `0x${string}`;

export interface GateCodeWire {
  v: 1;
  gateId: string;
  eventId: string;
  issuedAt: number;
  nonce: Hex;
  kx: Hex;
  ky: Hex;
  /** r||s, 64 bytes, gate device key over sha256(abi.encode(gateId,eventId,issuedAt,nonce)) */
  sig: Hex;
}

export interface GateResponseWire {
  v: 1;
  tokenId: string;
  /** r||s, 64 bytes, over sha256(abi.encode(tokenId,gateId,eventId,nonce,issuedAt)) */
  deviceSig: Hex;
}

/**
 * Master plan final shape. The gate screen needs eventTitle and the per-ticket tierName/seat
 * because AdmitCard renders them offline, with no indexer and no IPFS metadata fetch.
 */
export interface SnapshotWire {
  v: 1;
  eventId: string;
  eventTitle: string;
  requireKyc: boolean;
  epoch: number;
  expiresAt: number;
  tickets: Array<{
    tokenId: string;
    account: Hex;
    deviceX: Hex;
    deviceY: Hex;
    photoJpegB64: string;
    displayName: string;
    tier: number;
    tierName: string;
    seat: string;
    checkedIn: boolean;
  }>;
  attesterSig: Hex;
}

export const BANNED_ATTENDEE_WORDS = [
  '지갑', 'NFT', '민팅', '가스', '체인', '토큰', '트랜잭션',
  'wallet', 'mint', 'gas', 'chain', 'token', 'transaction', 'blockchain', 'monad',
];
```

```ts
// packages/shared/src/constants.ts
import type { Hex } from './types.js';

/** The only place these literals exist. Everything else reads them through config. */
export const MONAD_MAINNET_CHAIN_ID = 143;
export const MONAD_TESTNET_CHAIN_ID = 10143;

/** EntryPoint v0.6 — same address on every chain (Coinbase Smart Wallet v1). */
export const ENTRY_POINT_V06 = '0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789' as Hex;

/** EIP-7951 P-256 precompile, 6,900 gas. */
export const P256_PRECOMPILE = '0x0000000000000000000000000000000000000100' as Hex;

export const EXPLORER_URLS: Record<number, string> = {
  [MONAD_MAINNET_CHAIN_ID]: 'https://monadexplorer.com',
  [MONAD_TESTNET_CHAIN_ID]: 'https://testnet.monadexplorer.com',
};

export function explorerUrlFor(chainId: number): string {
  return EXPLORER_URLS[chainId] ?? EXPLORER_URLS[MONAD_TESTNET_CHAIN_ID]!;
}
```

```ts
// packages/shared/src/encoding.ts
import { decode as cborDecode, encode as cborEncode } from 'cborg';
import type { Hex } from './types.js';

export function encodeCbor(value: unknown): Uint8Array {
  return cborEncode(value);
}

export function decodeCbor<T = unknown>(bytes: Uint8Array): T {
  return cborDecode(bytes) as T;
}

export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(text: string): Uint8Array {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToHex(bytes: Uint8Array): Hex {
  let out = '0x';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out as Hex;
}

function readDerInteger(der: Uint8Array, offset: number): { value: Uint8Array; next: number } {
  if (der[offset] !== 0x02) throw new Error(`DER: expected INTEGER at ${offset}`);
  const length = der[offset + 1];
  if (length === undefined || length > 0x7f) throw new Error('DER: unsupported INTEGER length');
  let value = der.slice(offset + 2, offset + 2 + length);
  while (value.length > 32 && value[0] === 0x00) value = value.slice(1);
  if (value.length > 32) throw new Error('DER: INTEGER longer than 32 bytes');
  const padded = new Uint8Array(32);
  padded.set(value, 32 - value.length);
  return { value: padded, next: offset + 2 + length };
}

/** DER SEQUENCE{INTEGER r, INTEGER s} → 32-byte left-padded r and s. */
export function derToCompactSignature(der: Uint8Array): { r: Hex; s: Hex } {
  if (der[0] !== 0x30) throw new Error('DER: expected SEQUENCE');
  const headerLength = (der[1] ?? 0) > 0x7f ? 2 + ((der[1] ?? 0) & 0x7f) : 2;
  const first = readDerInteger(der, headerLength);
  const second = readDerInteger(der, first.next);
  return { r: bytesToHex(first.value), s: bytesToHex(second.value) };
}

/** SubjectPublicKeyInfo (P-256, uncompressed point) → x, y. */
export function spkiToXy(spki: Uint8Array): { x: Hex; y: Hex } {
  const marker = spki.lastIndexOf(0x04);
  const start = spki.length - 64;
  if (start < 0 || marker < 0 || spki[start - 1] !== 0x04) {
    throw new Error('SPKI: not an uncompressed P-256 public key');
  }
  return { x: bytesToHex(spki.slice(start, start + 32)), y: bytesToHex(spki.slice(start + 32)) };
}
```

```ts
// packages/shared/src/index.ts
export * from './types.js';
export * from './constants.js';
export * from './encoding.js';
```

- [ ] **Step 6: 테스트가 통과하는지 확인**

Run (from `packages/shared/`): `pnpm vitest run src/encoding.test.ts`
Expected: PASS — `Tests  4 passed (4)`.

- [ ] **Step 7: 웹에 의존성으로 연결하고 빌드**

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI
node -e "const p=require('./apps/web/package.json');p.dependencies['@monti/shared']='workspace:*';const s={};Object.keys(p.dependencies).sort().forEach(k=>s[k]=p.dependencies[k]);p.dependencies=s;require('fs').writeFileSync('./apps/web/package.json',JSON.stringify(p,null,2)+'\n')"
pnpm install
pnpm -C packages/shared build
ls packages/shared/dist/encoding.js
```
Expected: `packages/shared/dist/encoding.js` 가 출력된다.

- [ ] **Step 8: 커밋**

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI
git add packages/shared apps/web/package.json pnpm-lock.yaml
git commit -m "feat(shared): add wire types, chain constants, CBOR, base64url and DER conversion"
```

---

## Task 3: 카피 린트 게이트 (`pnpm lint:copy`)

**Files:**
- Create: `packages/shared/src/copy-lint.ts`, `packages/shared/src/copy-lint.test.ts`, `.github/workflows/web.yml`
- Modify: 루트 `package.json`의 `scripts.lint:copy`

**Interfaces:**
- Consumes: `BANNED_ATTENDEE_WORDS` (Task 2).
- Produces: `lintCopy(targets: string[]): CopyLintFinding[]`, CLI `node packages/shared/dist/copy-lint.js <path...>` (위반이 있으면 exit 1). 루트 스크립트 `pnpm lint:copy`.

린트는 **사람에게 보이는 문자열 리터럴과 JSX 텍스트만** 본다. 세 가지를 명시적으로 제외한다:

1. **모듈 지정자.** `import { x } from '../../shared/chain/accounts'` 의 `'…/chain/…'` 도 문자열 리터럴이다. 제외하지 않으면 관객 코드 전역에서 `chain`이 46번 걸려 CI가 T18부터 영구히 빨갛다. `import`/`export … from` 줄과 `import('…')` 는 통째로 건너뛴다.
2. **테스트 파일.** `*.test.ts(x)` 의 `it('...chain...')` 같은 제목은 배포물이 아니다.
3. **식별자.** `chainId`, `getChain()` 은 리터럴이 아니므로 애초에 스캔 대상이 아니다.

영어 금지어는 리터럴 안에서 단어 경계(`\b`)로, 한국어 금지어는 부분 문자열로 검사한다(한국어는 조사가 붙어 `가스비`, `체인에` 형태로 나온다). 단어 경계 규칙 덕분에 `https://testnet.monadexplorer.com` 은 `\bmonad\b` 에 걸리지 않는다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

```ts
// packages/shared/src/copy-lint.test.ts
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { lintCopy } from './copy-lint.js';

function fixture(name: string, source: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'copy-lint-'));
  const file = join(dir, name);
  writeFileSync(file, source, 'utf8');
  return file;
}

describe('lintCopy', () => {
  it('flags a Korean banned word inside a string literal', () => {
    const file = fixture('Bad.tsx', "export const t = '가스비는 저희가 냅니다';\n");
    const findings = lintCopy([file]);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ word: '가스', line: 1 });
  });

  it('flags a banned word in JSX text', () => {
    const file = fixture('Jsx.tsx', 'export const T = () => <p>토큰을 받았습니다</p>;\n');
    expect(lintCopy([file]).map((f) => f.word)).toEqual(['토큰']);
  });

  it('does not flag identifiers such as chainId or getChain', () => {
    const file = fixture('Ok.ts', 'export const chainId = 10143;\nexport function getChain() { return chainId; }\n');
    expect(lintCopy([file])).toEqual([]);
  });

  it('does not flag module specifiers that contain a banned word', () => {
    const file = fixture('Imports.tsx', [
      "import { getAttendeeAccount } from '../../shared/chain/accounts';",
      "import { sendOp } from '../../shared/chain/ops';",
      "export { readTicket } from '../../shared/chain/reads';",
      "const lazy = await import('../../shared/chain/bundler');",
      "export const ok = '티켓을 받았어요';",
      '',
    ].join('\n'));
    expect(lintCopy([file])).toEqual([]);
  });

  it('skips test files, whose titles are not shipped copy', () => {
    const file = fixture('thing.test.ts', "it('reads the chain and pays no gas', () => {});\n");
    expect(lintCopy([file])).toEqual([]);
  });

  it('matches English banned words only on word boundaries', () => {
    const bad = fixture('En.ts', "export const a = 'Pay no gas';\n");
    const ok = fixture('Ok2.ts', "export const b = 'Gasan Digital Complex';\n");
    expect(lintCopy([bad]).map((f) => f.word)).toEqual(['gas']);
    expect(lintCopy([ok])).toEqual([]);
  });

  it('walks directories recursively and skips node_modules', () => {
    const dir = mkdtempSync(join(tmpdir(), 'copy-lint-dir-'));
    writeFileSync(join(dir, 'A.tsx'), "export const x = '지갑 연결';\n", 'utf8');
    expect(lintCopy([dir]).map((f) => f.word)).toEqual(['지갑']);
  });
});
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

Run (from `packages/shared/`): `pnpm vitest run src/copy-lint.test.ts`
Expected: FAIL — `Failed to resolve import "./copy-lint.js"`.

- [ ] **Step 3: 구현**

```ts
// packages/shared/src/copy-lint.ts
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { BANNED_ATTENDEE_WORDS } from './types.js';

export interface CopyLintFinding {
  file: string;
  line: number;
  word: string;
  text: string;
}

const SCANNED_EXTENSIONS = new Set(['.ts', '.tsx']);
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', 'ios', 'android', '__snapshots__']);
const TEST_FILE = /\.(test|spec)\.tsx?$/;

/** import/export … from '…'  and  import('…') — module specifiers are never user-visible copy. */
const MODULE_SPECIFIER_LINE = /^\s*(?:import\b|export\b[^=]*\bfrom\b)/;
const DYNAMIC_IMPORT = /\bimport\s*\(\s*(['"`])(?:[^'"`\\]|\\.)*\1\s*\)/g;
const VI_MOCK = /\bvi\.mock\s*\(\s*(['"`])(?:[^'"`\\]|\\.)*\1/g;

const LITERAL_PATTERN =
  /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`|>[^<>{}]+</g;

const KOREAN_WORDS = BANNED_ATTENDEE_WORDS.filter((word) => /[가-힣]/.test(word));
const ENGLISH_PATTERNS = BANNED_ATTENDEE_WORDS.filter((word) => !/[가-힣]/.test(word)).map(
  (word) => ({ word, regex: new RegExp(`\\b${word}\\b`, 'i') }),
);

function collectFiles(target: string, out: string[]): void {
  const stats = statSync(target);
  if (stats.isFile()) {
    if (SCANNED_EXTENSIONS.has(extname(target))) out.push(target);
    return;
  }
  for (const entry of readdirSync(target)) {
    if (SKIPPED_DIRECTORIES.has(entry)) continue;
    collectFiles(join(target, entry), out);
  }
}

function lintFile(file: string): CopyLintFinding[] {
  if (TEST_FILE.test(file)) return [];
  const findings: CopyLintFinding[] = [];
  const source = readFileSync(file, 'utf8');
  const lines = source.split('\n');
  lines.forEach((rawLine, index) => {
    if (MODULE_SPECIFIER_LINE.test(rawLine)) return;
    const line = rawLine.replace(DYNAMIC_IMPORT, 'import()').replace(VI_MOCK, 'vi.mock(');
    for (const match of line.matchAll(LITERAL_PATTERN)) {
      const text = match[0];
      for (const word of KOREAN_WORDS) {
        if (text.includes(word)) findings.push({ file, line: index + 1, word, text: text.trim() });
      }
      for (const { word, regex } of ENGLISH_PATTERNS) {
        if (regex.test(text)) findings.push({ file, line: index + 1, word, text: text.trim() });
      }
    }
  });
  return findings;
}

export function lintCopy(targets: string[]): CopyLintFinding[] {
  const files: string[] = [];
  for (const target of targets) collectFiles(target, files);
  return files.flatMap(lintFile);
}

const isCli =
  typeof process !== 'undefined' && process.argv[1]?.endsWith('copy-lint.js') === true;

if (isCli) {
  const findings = lintCopy(process.argv.slice(2));
  for (const finding of findings) {
    console.error(`${finding.file}:${finding.line}  banned word "${finding.word}"  ${finding.text}`);
  }
  if (findings.length > 0) {
    console.error(`\ncopy-lint: ${findings.length} banned word(s) in attendee copy.`);
    process.exit(1);
  }
  console.log('copy-lint: clean');
}
```

`packages/shared/src/index.ts`에 한 줄 추가:

```ts
export type { CopyLintFinding } from './copy-lint.js';
```

- [ ] **Step 4: 테스트가 통과하는지 확인**

Run (from `packages/shared/`): `pnpm vitest run src/copy-lint.test.ts`
Expected: PASS — `Tests  7 passed (7)`.

- [ ] **Step 5: 루트 스크립트와 CI 연결**

린트 대상은 마스터 계획의 `apps/web/src/attendee`에 **`apps/web/src/shared/copy` 디렉터리를 추가**한다. 관객 문구 전량이 `copy/ko.ts`와 `copy/en.ts`에 있으므로 거기를 안 보면 게이트가 무의미하고, 영어 로케일도 같은 금지어 규칙을 받는다.

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI
node -e "const p=require('./package.json');p.scripts=p.scripts||{};p.scripts['lint:copy']='pnpm -C packages/shared build && node packages/shared/dist/copy-lint.js apps/web/src/attendee apps/web/src/shared/copy';require('fs').writeFileSync('./package.json',JSON.stringify(p,null,2)+'\n')"
mkdir -p .github/workflows
cat > .github/workflows/web.yml <<'EOF'
name: web
on:
  push: { branches: [main] }
  pull_request:
jobs:
  web:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 10 }
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm -C packages/shared build
      - run: pnpm -C packages/shared vitest run
      - run: pnpm lint:copy
      - run: pnpm -C apps/web typecheck
      - run: pnpm vitest run
EOF
cat > vitest.workspace.ts <<'EOF'
// Lets `pnpm vitest run <path>` work from the monorepo root, which is how sub-plan 04 runs tests.
export default ['apps/web', 'packages/shared'];
EOF
node -e "const p=require('./package.json');p.devDependencies=Object.assign({vitest:'3.2.4'},p.devDependencies||{});require('fs').writeFileSync('./package.json',JSON.stringify(p,null,2)+'\n')"
pnpm install
mkdir -p apps/web/src/shared/copy && printf 'export const ko = {} as const;\n' > apps/web/src/shared/copy/ko.ts
printf 'export const en = {} as const;\n' > apps/web/src/shared/copy/en.ts
pnpm lint:copy
```
Expected: `copy-lint: clean`.

- [ ] **Step 6: 게이트가 실제로 막는지 확인**

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI
printf "export const ko = { bad: '가스비 무료' } as const;\n" > apps/web/src/shared/copy/ko.ts
pnpm lint:copy; echo "exit=$?"
printf 'export const ko = {} as const;\n' > apps/web/src/shared/copy/ko.ts
```
Expected: `banned word "가스"` 한 줄 + `exit=1`.

- [ ] **Step 7: 커밋**

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI
git add packages/shared/src/copy-lint.ts packages/shared/src/copy-lint.test.ts packages/shared/src/index.ts package.json vitest.workspace.ts .github/workflows/web.yml apps/web/src/shared/copy
git commit -m "feat(shared): add copy-lint gate for attendee vocabulary and wire it into CI"
```

---

## Task 4: i18n과 관객 문구 전량 (`ko`/`en`)

**Files:**
- Create: `apps/web/src/shared/copy/ko.ts`, `apps/web/src/shared/copy/en.ts`, `apps/web/src/shared/copy/index.ts`, `apps/web/src/shared/i18n.ts`
- Modify: `apps/web/vitest.setup.ts` (i18n 초기화)
- Test: `apps/web/src/shared/copy/copy.test.ts`

**Interfaces:**
- Consumes: Task 3의 `pnpm lint:copy`(대상 디렉터리 `apps/web/src/shared/copy`).
- Produces: `type Copy`, `ko`, `en`, `initI18n(lng?: Locale)`, `useCopy(): Copy`, `useLocale()`, `setLocale(l: 'ko' | 'en')`, `fmt(template, vars)`. 이후 모든 관객 화면은 `useCopy()`만 쓴다.

**테스트 하네스가 i18next를 실제로 초기화한다.** 초기화하지 않으면 `useTranslation()`이 미초기화 스텁을 돌려주고 `useCopy()`가 우연히 `ko`로 떨어지는데, 이 sub-plan의 컴포넌트 테스트 아홉 개가 전부 그 우연에 기대게 된다. react-i18next 동작이 한 번 바뀌면 동시에 전부 깨진다. 그래서 Step 5에서 `vitest.setup.ts`에 `await initI18n('ko')`를 넣는다.

i18next를 **로케일 감지·전환·저장**에만 쓰고, 문구 접근은 `useCopy()`가 돌려주는 **타입이 붙은 중첩 객체**로 한다. `t('a.b.c')` 문자열 키를 쓰지 않는 이유는 오타가 컴파일에서 안 잡히고, 금지어 린트가 문자열 리터럴을 스캔하는 구조와 맞지 않기 때문이다. `en: Copy = {…}` 선언이 두 로케일의 키 집합이 어긋나면 빌드를 깬다.

- [ ] **Step 1: 실패하는 테스트**

```ts
// apps/web/src/shared/copy/copy.test.ts
import { describe, expect, it } from 'vitest';
import { en, ko } from './index';
import { fmt } from '../i18n';

function keyPaths(value: unknown, prefix = ''): string[] {
  if (typeof value !== 'object' || value === null) return [prefix];
  return Object.entries(value).flatMap(([k, v]) => keyPaths(v, prefix ? `${prefix}.${k}` : k));
}

describe('attendee copy', () => {
  it('has identical key sets in ko and en', () => {
    expect(keyPaths(en).sort()).toEqual(keyPaths(ko).sort());
  });

  it('keeps the same interpolation placeholders in both locales', () => {
    expect(ko.enter.armed).toContain('{{seconds}}');
    expect(en.enter.armed).toContain('{{seconds}}');
  });

  it('interpolates with fmt', () => {
    expect(fmt(ko.enter.armed, { seconds: 42 })).toBe('42초 안에 단말기에 대세요');
  });
});
```

- [ ] **Step 2: 실패 확인**

Run (from `apps/web/`): `pnpm vitest run src/shared/copy/copy.test.ts`
Expected: FAIL — `Failed to resolve import "./index"`.

- [ ] **Step 3: 한국어 문구 전량**

```ts
// apps/web/src/shared/copy/ko.ts
export const ko = {
  tabs: { discover: '탐색', tickets: '내 티켓', chats: '대화', me: '프로필' },
  common: {
    next: '다음', back: '뒤로', cancel: '취소', confirm: '확인', close: '닫기',
    retry: '다시 시도', save: '저장', loading: '불러오는 중이에요',
    error: '문제가 생겼어요. 잠시 뒤 다시 시도해 주세요.',
    offline: '인터넷에 연결되어 있지 않아요.',
  },
  signup: {
    phoneTitle: '휴대폰 번호를 입력해 주세요', phoneHint: '문자로 인증번호를 보내드려요',
    phonePlaceholder: '01012345678', sendCode: '인증번호 받기',
    codeTitle: '인증번호 6자리를 입력해 주세요', codeResend: '다시 보내기', verifyCta: '확인',
    codeWrong: '인증번호가 맞지 않아요.',
    passkeyTitle: 'Face ID로 잠금 설정', passkeyBody: '얼굴이나 지문으로만 열리는 잠금을 겁니다. 외울 비밀번호는 없어요.',
    passkeyCta: '잠금 설정하기', passkeyFailed: '잠금을 설정하지 못했어요. 다시 시도해 주세요.',
    deviceTitle: '이 휴대폰을 입장용으로 등록할게요', deviceBody: '입장할 때는 이 휴대폰에서만 확인할 수 있어요.',
    deviceCta: '등록하기', deviceFailed: '등록하지 못했어요. 다시 시도해 주세요.',
    doneTitle: '준비가 끝났어요', doneCta: '행사 둘러보기',
  },
  login: { title: '다시 오셨네요', body: '얼굴이나 지문으로 바로 들어갈 수 있어요.', cta: '로그인', failed: '로그인하지 못했어요. 다시 시도해 주세요.' },
  kyc: {
    title: '신분증과 얼굴을 확인할게요', body: '30초면 끝나요. 확인 화면이 열렸다가 돌아옵니다.',
    cta: '본인인증 하기', waiting: '확인하고 있어요. 잠시만 기다려 주세요.',
    duplicate: '이미 계정이 있습니다. 기존 계정으로 로그인해 주세요.',
    rejected: '본인 확인에 실패했어요. 다시 시도해 주세요.',
    requiredBadge: 'KYC 필요', requiredTitle: '이 행사는 본인인증이 필요해요',
    requiredBody: '신분증과 얼굴을 한 번 확인하면 이 행사와 앞으로의 행사에서 다시 하지 않아도 돼요.',
    status: '인증 상태', verified: '인증 완료', unverified: '미인증',
    recipientNotVerified: '받는 사람이 본인인증을 하지 않았어요.',
    offerNeedsKyc: '본인인증 후 받을 수 있어요',
    inviteKycNote: '가입 후 본인인증을 마쳐야 티켓을 받을 수 있어요.',
  },
  discover: {
    title: '탐색', searchPlaceholder: '행사 이름 검색',
    filterDate: '날짜', filterRegion: '지역', filterCategory: '테마',
    dateToday: '오늘', dateWeek: '이번 주', dateMonth: '이번 달', datePick: '직접 선택',
    categoryAll: '전체', category0: '공연', category1: '모임', category2: '전시', category3: '기타',
    empty: '조건에 맞는 행사가 없어요.', getTicket: '티켓 받기', share: '공유',
    map: '지도로 보기', publicRecord: '공개 기록', soldOut: '마감됨', cancelled: '취소된 행사예요.',
  },
  tickets: {
    title: '내 티켓', empty: '아직 티켓이 없어요.', inbox: '받은 티켓', inboxEmpty: '받은 티켓이 없어요.',
    stateBefore: '입장 전', stateEntered: '입장 완료', statePending: '양도 대기',
    stateTransferred: '양도됨', stateCancelled: '취소됨',
    enter: '입장하기', transfer: '양도',
    detailGuide: '입구에서 입장하기를 누르고 60초 안에 단말기에 휴대폰을 대세요.',
    noBarcode: '보여줄 코드는 없어요.',
  },
  claim: { cta: '티켓 받기', working: '받는 중이에요', done: '티켓을 받았어요', failed: '티켓을 받지 못했어요. 잠시 뒤 다시 시도해 주세요.' },
  transfer: {
    title: '양도', byNickname: '별명', byAddress: '주소', byPhone: '전화번호',
    countryCode: '국가 번호', findCta: '찾기', notFound: '찾을 수 없어요.',
    confirmTitle: '이 분에게 양도할까요?', confirmCta: '양도하기', sent: '양도했어요',
    inviteTitle: '아직 가입하지 않은 번호예요',
    inviteBody: '초대 문자를 보내면 상대가 가입할 때 티켓이 자동으로 전달돼요.',
    inviteCta: '초대 문자 보내기',
    inviteSent: '초대를 보냈어요. 상대가 가입하면 티켓이 자동으로 전달됩니다.',
    inviteCancel: '초대 취소', inviteCancelled: '초대를 취소했어요', accept: '받기', accepted: '티켓을 받았어요',
    alertNotMember: '받는 분이 아직 가입하지 않았어요.',
    alertMaxPerWallet: '받는 분이 이 행사 티켓을 이미 최대 수만큼 갖고 있어요.',
    alertNotTransferable: '이 행사는 양도할 수 없어요.',
    alertAfterCutoff: '양도 마감 시간이 지났어요.',
    alertNoTransfersLeft: '이 티켓은 더 이상 양도할 수 없어요.',
    alertAlreadyEntered: '이미 입장한 티켓이에요.',
    alertSelf: '본인에게는 양도할 수 없어요.',
    alertLocked: '받는 분의 휴대폰이 잠겨 있어요.',
  },
  enter: {
    cta: '입장하기', arming: '얼굴을 확인하고 있어요',
    armed: '{{seconds}}초 안에 단말기에 대세요', tapGuide: '휴대폰을 단말기에 대세요',
    expired: '시간이 지났어요. 다시 눌러 주세요.',
    unknownGate: '등록되지 않은 단말기예요.',
    writeFailed: '전달하지 못했어요. QR로 보여드릴게요.',
    qrTitle: '이 화면을 스태프에게 보여주세요',
    done: '입장 완료', resultWaiting: '확인하고 있어요',
    deviceUnavailable: '이 휴대폰에서는 대는 방식이 안 돼요. QR을 보여주세요.',
    locked: '휴대폰이 잠겨 있어요. 프로필에서 잠금을 풀어 주세요.',
  },
  chats: {
    title: '대화', empty: '참여 중인 대화가 없어요.',
    closed: '행사가 끝나 대화방이 닫혔어요', send: '보내기',
    placeholder: '메시지 (최대 500자)', tooLong: '500자까지 보낼 수 있어요.',
    report: '신고', reported: '신고했어요', notice: '공지', reorderHint: '길게 눌러 순서를 바꿀 수 있어요.',
  },
  me: {
    title: '프로필', nickname: '별명', nicknameHint: '영문 소문자, 숫자, 밑줄 3~20자',
    nicknameTaken: '이미 쓰는 별명이에요.', nicknameSaved: '별명을 저장했어요',
    nicknameInvalid: '영문 소문자, 숫자, 밑줄만 3~20자로 써 주세요.',
    language: '언어', languageKo: '한국어', languageEn: 'English',
    lockDevice: '휴대폰 잠금', lockCta: '지금 잠그기', locked: '잠겨 있어요',
    unlockGuide: '새 휴대폰에서 본인 확인을 다시 하면 풀려요.',
    newDevice: '새 휴대폰 등록', newDeviceWait: '{{days}}일 뒤에 쓸 수 있어요',
    newDeviceReady: '지금 등록할 수 있어요', newDeviceCta: '이 휴대폰으로 바꾸기',
    publicRecord: '공개 기록', deleteAccount: '계정 삭제 요청',
    deleteConfirm: '정말 삭제를 요청할까요? 취소할 수 없어요.', deleteDone: '삭제 요청을 접수했어요',
  },
} as const;
```

- [ ] **Step 4: 영어 문구와 i18next 초기화**

```ts
// apps/web/src/shared/copy/index.ts
import { ko } from './ko';
import { en } from './en';

export type Copy = typeof ko;
export { ko, en };
export type Locale = 'ko' | 'en';
```

```ts
// apps/web/src/shared/copy/en.ts
import type { ko } from './ko';

export const en: typeof ko = {
  tabs: { discover: 'Explore', tickets: 'Tickets', chats: 'Chats', me: 'Profile' },
  common: {
    next: 'Next', back: 'Back', cancel: 'Cancel', confirm: 'Confirm', close: 'Close',
    retry: 'Try again', save: 'Save', loading: 'Loading',
    error: 'Something went wrong. Please try again in a moment.',
    offline: 'You are not connected to the internet.',
  },
  signup: {
    phoneTitle: 'Enter your phone number', phoneHint: 'We will text you a code',
    phonePlaceholder: '+821012345678', sendCode: 'Send code',
    codeTitle: 'Enter the 6-digit code', codeResend: 'Resend', verifyCta: 'Verify',
    codeWrong: 'That code is not right.',
    passkeyTitle: 'Lock with Face ID', passkeyBody: 'Only your face or fingerprint opens it. Nothing to memorize.',
    passkeyCta: 'Set up the lock', passkeyFailed: 'Could not set up the lock. Please try again.',
    deviceTitle: 'Register this phone for entry', deviceBody: 'Only this phone can confirm you at the door.',
    deviceCta: 'Register', deviceFailed: 'Could not register. Please try again.',
    doneTitle: 'You are all set', doneCta: 'Explore events',
  },
  login: { title: 'Welcome back', body: 'Your face or fingerprint gets you in.', cta: 'Sign in', failed: 'Could not sign in. Please try again.' },
  kyc: {
    title: 'Let us check your ID and face', body: 'It takes 30 seconds. A verification page opens and returns here.',
    cta: 'Verify my identity', waiting: 'Checking. Please wait a moment.',
    duplicate: 'You already have an account. Please sign in instead.',
    rejected: 'Verification failed. Please try again.',
    requiredBadge: 'KYC required', requiredTitle: 'This event requires identity verification',
    requiredBody: 'Verify your ID and face once and you will not have to do it again for future events.',
    status: 'Verification', verified: 'Verified', unverified: 'Not verified',
    recipientNotVerified: 'That person has not verified their identity.',
    offerNeedsKyc: 'Verify your identity to accept',
    inviteKycNote: 'After signing up they must verify their ID to receive the ticket.',
  },
  discover: {
    title: 'Explore', searchPlaceholder: 'Search events',
    filterDate: 'Date', filterRegion: 'Region', filterCategory: 'Theme',
    dateToday: 'Today', dateWeek: 'This week', dateMonth: 'This month', datePick: 'Pick a date',
    categoryAll: 'All', category0: 'Concert', category1: 'Meetup', category2: 'Exhibition', category3: 'Other',
    empty: 'No events match your filters.', getTicket: 'Get a ticket', share: 'Share',
    map: 'Open in maps', publicRecord: 'Public record', soldOut: 'Sold out', cancelled: 'This event was cancelled.',
  },
  tickets: {
    title: 'My tickets', empty: 'No tickets yet.', inbox: 'Received', inboxEmpty: 'Nothing received yet.',
    stateBefore: 'Not used', stateEntered: 'Entered', statePending: 'Pending handover',
    stateTransferred: 'Handed over', stateCancelled: 'Cancelled',
    enter: 'Enter', transfer: 'Hand over',
    detailGuide: 'At the door, tap Enter and hold your phone to the reader within 60 seconds.',
    noBarcode: 'There is no code to show.',
  },
  claim: { cta: 'Get a ticket', working: 'Getting your ticket', done: 'You got the ticket', failed: 'Could not get the ticket. Please try again shortly.' },
  transfer: {
    title: 'Hand over', byNickname: 'Nickname', byAddress: 'Address', byPhone: 'Phone',
    countryCode: 'Country code', findCta: 'Find', notFound: 'Not found.',
    confirmTitle: 'Hand the ticket to this person?', confirmCta: 'Hand over', sent: 'Handed over',
    inviteTitle: 'This number has not signed up yet',
    inviteBody: 'Send an invite and the ticket moves automatically once they sign up.',
    inviteCta: 'Send invite by text',
    inviteSent: 'Invite sent. The ticket moves automatically once they sign up.',
    inviteCancel: 'Cancel invite', inviteCancelled: 'Invite cancelled', accept: 'Accept', accepted: 'Ticket received',
    alertNotMember: 'They have not signed up yet.',
    alertMaxPerWallet: 'They already hold the maximum number of tickets for this event.',
    alertNotTransferable: 'This event does not allow handovers.',
    alertAfterCutoff: 'The handover deadline has passed.',
    alertNoTransfersLeft: 'This ticket cannot be handed over again.',
    alertAlreadyEntered: 'This ticket has already been used.',
    alertSelf: 'You cannot hand it to yourself.',
    alertLocked: 'Their phone is locked.',
  },
  enter: {
    cta: 'Enter', arming: 'Checking your face',
    armed: 'Hold your phone to the reader within {{seconds}}s', tapGuide: 'Hold your phone to the reader',
    expired: 'Time is up. Tap Enter again.',
    unknownGate: 'This reader is not registered.',
    writeFailed: 'Could not hand it over. Showing a QR code instead.',
    qrTitle: 'Show this screen to the staff',
    done: 'You are in', resultWaiting: 'Confirming',
    deviceUnavailable: 'Tapping is not available on this phone. Show the QR code.',
    locked: 'Your phone is locked. Unlock it in your profile.',
  },
  chats: {
    title: 'Chats', empty: 'You are not in any chat yet.',
    closed: 'The event has ended and this chat is closed', send: 'Send',
    placeholder: 'Message (up to 500 characters)', tooLong: 'Messages can be up to 500 characters.',
    report: 'Report', reported: 'Reported', notice: 'Notice', reorderHint: 'Press and hold to reorder.',
  },
  me: {
    title: 'Profile', nickname: 'Nickname', nicknameHint: '3-20 lowercase letters, digits or underscore',
    nicknameTaken: 'That nickname is taken.', nicknameSaved: 'Nickname saved',
    nicknameInvalid: 'Use 3-20 lowercase letters, digits or underscore.',
    language: 'Language', languageKo: '한국어', languageEn: 'English',
    lockDevice: 'Phone lock', lockCta: 'Lock now', locked: 'Locked',
    unlockGuide: 'Verify yourself again on a new phone to unlock.',
    newDevice: 'Register a new phone', newDeviceWait: 'Available in {{days}} days',
    newDeviceReady: 'You can register now', newDeviceCta: 'Switch to this phone',
    publicRecord: 'Public record', deleteAccount: 'Request account deletion',
    deleteConfirm: 'Request deletion? This cannot be undone.', deleteDone: 'Deletion request received',
  },
};
```

```ts
// apps/web/src/shared/i18n.ts
import i18next from 'i18next';
import { initReactI18next, useTranslation } from 'react-i18next';
import { en, ko, type Copy, type Locale } from './copy/index';

const STORAGE_KEY = 'monti.locale';

export function detectLocale(): Locale {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'ko' || stored === 'en') return stored;
  } catch {
    /* private mode */
  }
  return navigator.language.toLowerCase().startsWith('ko') ? 'ko' : 'en';
}

export async function initI18n(lng?: Locale): Promise<void> {
  if (i18next.isInitialized) return;
  await i18next.use(initReactI18next).init({
    lng: lng ?? detectLocale(),
    fallbackLng: 'ko',
    resources: { ko: { translation: {} }, en: { translation: {} } },
    interpolation: { escapeValue: false },
  });
}

export async function setLocale(locale: Locale): Promise<void> {
  try {
    localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    /* private mode */
  }
  await i18next.changeLanguage(locale);
}

/** Typed copy for the current locale. Re-renders when the language changes. */
export function useCopy(): Copy {
  const { i18n } = useTranslation();
  return i18n.language?.startsWith('en') ? en : ko;
}

export function useLocale(): Locale {
  const { i18n } = useTranslation();
  return i18n.language?.startsWith('en') ? 'en' : 'ko';
}

export function fmt(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => String(vars[key] ?? ''));
}
```

- [ ] **Step 5: 테스트 하네스에서 i18n 초기화**

```ts
// apps/web/vitest.setup.ts
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeAll, vi } from 'vitest';
import { initI18n } from './src/shared/i18n';

// Component tests assert Korean copy; initialise i18next for real instead of
// relying on react-i18next's uninitialised stub falling back to ko by accident.
beforeAll(async () => {
  await initI18n('ko');
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

if (!globalThis.crypto?.getRandomValues) {
  throw new Error('WebCrypto is required for these tests; use Node 22+');
}
```

- [ ] **Step 6: 테스트 통과 확인**

Run (from `apps/web/`): `pnpm vitest run src/shared/copy/copy.test.ts`
Expected: PASS — `Tests  3 passed (3)`.

- [ ] **Step 7: 금지어 게이트 통과 확인**

Run (from repo root): `pnpm lint:copy`
Expected: `copy-lint: clean`. 실패하면 해당 줄의 단어를 바꾼다 — **예외 주석은 만들지 않는다.**

- [ ] **Step 8: 커밋**

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI
git add apps/web/src/shared/copy apps/web/src/shared/i18n.ts apps/web/vitest.setup.ts
git commit -m "feat(web): add typed ko/en attendee copy, i18next switching and test-harness init"
```

---

## Task 5: 모바일 전용 레이아웃 셸과 UI 프리미티브

**Files:**
- Create: `apps/web/src/shared/theme.css`, `apps/web/src/shared/ui/Screen.tsx`, `BottomTabs.tsx`, `Fab.tsx`, `Button.tsx`, `Alert.tsx`, `Countdown.tsx`, `Spinner.tsx`, `Field.tsx`, `index.ts`
- Test: `apps/web/src/shared/ui/ui.test.tsx`

**Interfaces:**
- Consumes: `useCopy()` (Task 4).
- Produces: `<Screen title? children>`, `<BottomTabs>`, `<Fab label onClick>`, `<Button variant='primary'|'ghost'|'danger'>`, `<Alert tone='warn'|'error'|'info'>`, `<Countdown seconds onExpire>`, `<Spinner>`, `<Field label>`. 모든 화면은 `Screen` 안에 들어간다.

- [ ] **Step 1: 실패하는 테스트**

```tsx
// apps/web/src/shared/ui/ui.test.tsx
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { BottomTabs, Countdown, Screen } from './index';

describe('ui primitives', () => {
  it('Screen renders a main landmark with the mobile max width', () => {
    render(<Screen title="내 티켓">body</Screen>);
    const main = screen.getByRole('main');
    expect(main).toHaveClass('screen');
    expect(screen.getByRole('heading', { name: '내 티켓' })).toBeInTheDocument();
  });

  it('BottomTabs marks the active route', () => {
    render(
      <MemoryRouter initialEntries={['/tickets']}>
        <BottomTabs />
      </MemoryRouter>,
    );
    expect(screen.getByRole('link', { name: '내 티켓' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: '탐색' })).not.toHaveAttribute('aria-current');
  });

  it('Countdown ticks down and calls onExpire at zero', () => {
    vi.useFakeTimers();
    const onExpire = vi.fn();
    render(<Countdown seconds={3} onExpire={onExpire} />);
    expect(screen.getByRole('timer')).toHaveTextContent('3');
    // One second per act: the next timer is only armed after React flushes the state update.
    for (let tick = 0; tick < 3; tick += 1) {
      act(() => { vi.advanceTimersByTime(1000); });
    }
    expect(screen.getByRole('timer')).toHaveTextContent('0');
    expect(onExpire).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run (from `apps/web/`): `pnpm vitest run src/shared/ui/ui.test.tsx`
Expected: FAIL — `Failed to resolve import "./index"`.

- [ ] **Step 3: 테마 CSS (모바일 전용, safe-area)**

```css
/* apps/web/src/shared/theme.css */
:root {
  --bg: #0e0f13; --surface: #17191f; --line: #262a33;
  --text: #f2f4f8; --muted: #9aa2b1; --accent: #4f7dff; --danger: #ff5a5f; --warn: #ffb020;
  --radius: 14px; --tabbar-h: 60px;
  color-scheme: dark;
}
* { box-sizing: border-box; }
html, body, #root { height: 100%; margin: 0; }
body {
  background: var(--bg); color: var(--text);
  font: 15px/1.5 -apple-system, BlinkMacSystemFont, 'Apple SD Gothic Neo', 'Pretendard', system-ui, sans-serif;
  overscroll-behavior-y: none;
}
.screen {
  max-width: 480px; margin: 0 auto;
  padding: calc(env(safe-area-inset-top) + 16px) 16px
           calc(env(safe-area-inset-bottom) + var(--tabbar-h) + 16px);
  min-height: 100%;
}
.screen h1 { font-size: 22px; margin: 0 0 16px; }
.tabbar {
  position: fixed; inset: auto 0 0 0; z-index: 10;
  max-width: 480px; margin: 0 auto;
  display: grid; grid-template-columns: repeat(4, 1fr);
  background: var(--surface); border-top: 1px solid var(--line);
  padding-bottom: env(safe-area-inset-bottom);
}
.tabbar a { display: grid; place-items: center; height: var(--tabbar-h); color: var(--muted); text-decoration: none; font-size: 12px; }
.tabbar a[aria-current='page'] { color: var(--accent); }
.fab {
  position: fixed; right: 16px; z-index: 11;
  bottom: calc(env(safe-area-inset-bottom) + var(--tabbar-h) + 16px);
  height: 52px; padding: 0 22px; border: 0; border-radius: 26px;
  background: var(--accent); color: #fff; font-size: 16px; font-weight: 600;
  box-shadow: 0 8px 24px rgba(79, 125, 255, 0.35);
}
.btn { width: 100%; height: 52px; border: 0; border-radius: var(--radius); font-size: 16px; font-weight: 600; }
.btn--primary { background: var(--accent); color: #fff; }
.btn--ghost { background: transparent; color: var(--text); border: 1px solid var(--line); }
.btn--danger { background: var(--danger); color: #fff; }
.btn[disabled] { opacity: 0.45; }
.alert { border-radius: var(--radius); padding: 12px 14px; margin: 12px 0; font-size: 14px; }
.alert--info { background: #1b2130; }
.alert--warn { background: #33280f; color: var(--warn); }
.alert--error { background: #34181a; color: var(--danger); }
.field { display: block; margin: 12px 0; }
.field span { display: block; color: var(--muted); font-size: 13px; margin-bottom: 6px; }
.field input, .field select, .field textarea {
  width: 100%; height: 48px; padding: 0 12px; border-radius: var(--radius);
  border: 1px solid var(--line); background: var(--surface); color: var(--text); font-size: 16px;
}
.field textarea { height: auto; padding: 12px; }
.badge { display: inline-block; margin-left: 8px; padding: 2px 8px; border-radius: 999px; background: var(--warn); color: #000; font-size: 12px; }
.countdown { font-size: 44px; font-weight: 700; text-align: center; font-variant-numeric: tabular-nums; }
.spinner { width: 22px; height: 22px; border: 3px solid var(--line); border-top-color: var(--accent); border-radius: 50%; margin: 24px auto; animation: spin 0.8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
```

- [ ] **Step 4: 컴포넌트 구현**

```tsx
// apps/web/src/shared/ui/Screen.tsx
import type { ReactNode } from 'react';

export function Screen({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <main className="screen">
      {title ? <h1>{title}</h1> : null}
      {children}
    </main>
  );
}
```

```tsx
// apps/web/src/shared/ui/BottomTabs.tsx
import { NavLink } from 'react-router-dom';
import { useCopy } from '../i18n';

export function BottomTabs() {
  const copy = useCopy();
  const tabs = [
    { to: '/', label: copy.tabs.discover, end: true },
    { to: '/tickets', label: copy.tabs.tickets, end: false },
    { to: '/chats', label: copy.tabs.chats, end: false },
    { to: '/me', label: copy.tabs.me, end: false },
  ];
  return (
    <nav className="tabbar">
      {tabs.map((tab) => (
        <NavLink key={tab.to} to={tab.to} end={tab.end}>
          {tab.label}
        </NavLink>
      ))}
    </nav>
  );
}
```

```tsx
// apps/web/src/shared/ui/Fab.tsx
export function Fab({ label, onClick, disabled }: { label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" className="fab" onClick={onClick} disabled={disabled}>
      {label}
    </button>
  );
}
```

```tsx
// apps/web/src/shared/ui/Button.tsx
import type { ButtonHTMLAttributes } from 'react';

type Props = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'ghost' | 'danger' };

export function Button({ variant = 'primary', ...rest }: Props) {
  return <button type="button" className={`btn btn--${variant}`} {...rest} />;
}
```

```tsx
// apps/web/src/shared/ui/Alert.tsx
import type { ReactNode } from 'react';

export function Alert({ tone = 'info', children }: { tone?: 'info' | 'warn' | 'error'; children: ReactNode }) {
  return (
    <div className={`alert alert--${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      {children}
    </div>
  );
}
```

```tsx
// apps/web/src/shared/ui/Countdown.tsx
import { useEffect, useRef, useState } from 'react';

export function Countdown({ seconds, onExpire }: { seconds: number; onExpire: () => void }) {
  const [left, setLeft] = useState(seconds);
  const fired = useRef(false);

  useEffect(() => {
    setLeft(seconds);
    fired.current = false;
  }, [seconds]);

  useEffect(() => {
    if (left <= 0) {
      if (!fired.current) {
        fired.current = true;
        onExpire();
      }
      return;
    }
    const timer = setTimeout(() => setLeft((value) => value - 1), 1000);
    return () => clearTimeout(timer);
  }, [left, onExpire]);

  return (
    <div className="countdown" role="timer" aria-live="polite">
      {Math.max(0, left)}
    </div>
  );
}
```

```tsx
// apps/web/src/shared/ui/Spinner.tsx
export function Spinner() {
  return <div className="spinner" role="progressbar" aria-label="loading" />;
}
```

```tsx
// apps/web/src/shared/ui/Field.tsx
import type { ReactNode } from 'react';

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}
```

```ts
// apps/web/src/shared/ui/index.ts
export { Screen } from './Screen';
export { BottomTabs } from './BottomTabs';
export { Fab } from './Fab';
export { Button } from './Button';
export { Alert } from './Alert';
export { Countdown } from './Countdown';
export { Spinner } from './Spinner';
export { Field } from './Field';
```

- [ ] **Step 5: 테스트 통과 확인**

Run (from `apps/web/`): `pnpm vitest run src/shared/ui/ui.test.tsx`
Expected: PASS — `Tests  3 passed (3)`.

- [ ] **Step 6: 커밋**

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI
git add apps/web/src/shared/theme.css apps/web/src/shared/ui
git commit -m "feat(web): add mobile-only screen shell, bottom tabs, fab and ui primitives"
```

---

## Task 6: 라우터, Query 프로바이더, 세션

**Files:**
- Create: `apps/web/src/router.tsx`, `apps/web/src/shared/session.ts`, `apps/web/src/shared/query.ts`
- Modify: `apps/web/src/App.tsx`, `apps/web/src/main.tsx`
- Test: `apps/web/src/router.test.tsx`

**Interfaces:**
- Consumes: `Screen`, `BottomTabs` (Task 5), `useCopy` (Task 4).
- Produces: `routes` (React Router `RouteObject[]`), `<App />`, `queryClient`, `useSession(): Session`, `setSession(s)`, `clearSession()`, `registerSessionHydrator(h)`, `bootSession()`, `<RequireSession>`.

**세션은 부팅 때 반드시 해소된다.** `status`는 `'loading'`에서 시작하지만 `App`이 마운트되자마자 `bootSession()`이 돌아 `'anonymous'` 또는 `'signedIn'`으로 바꾼다. 하이드레이터가 등록되지 않았으면(초기 태스크, 테스트) 즉시 `'anonymous'`다. 이게 없으면 새로고침 한 번에 `/tickets` `/me` `/chats` `/org/*`가 영원히 스피너에 갇히고, T33의 스모크 두 개가 첫 단언 전에 멈춘다. Firebase를 아는 실제 하이드레이터는 T16이 등록한다(`shared/api/sessionHydrator.ts`) — `session.ts`는 Firebase를 import하지 않는다.

라우트는 마스터 계획 + v2.4 델타 그대로: `/`, `/events/:id`, `/signup/*`, `/login`, `/tickets`, `/tickets/:id`, `/tickets/:id/transfer`, `/tickets/:id/enter`, `/chats`, `/chats/:eventId`, `/me`, `/org/*`, `/staff/*`. 하단 탭 바는 **관객 탭 4개 경로에서만** 보인다(가입·입장·주최자·스태프 화면에서는 숨긴다).

- [ ] **Step 1: 실패하는 테스트**

```tsx
// apps/web/src/router.test.tsx
import { render, screen } from '@testing-library/react';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { routes } from './router';
import { queryClient } from './shared/query';
import { bootSession, getSession, registerSessionHydrator, setSession } from './shared/session';

function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe('router', () => {
  it('shows the bottom tabs on an attendee tab route', async () => {
    setSession({ status: 'signedIn', account: `0x${'11'.repeat(20)}`, personId: 'p1' });
    renderAt('/tickets');
    expect(await screen.findByRole('link', { name: '내 티켓' })).toBeInTheDocument();
  });

  it('hides the bottom tabs during signup', async () => {
    setSession({ status: 'anonymous' });
    renderAt('/signup/phone');
    expect(await screen.findByRole('main')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '내 티켓' })).toBeNull();
  });

  it('redirects a protected route to /login when signed out', async () => {
    setSession({ status: 'anonymous' });
    renderAt('/me');
    expect(await screen.findByRole('heading', { name: '다시 오셨네요' })).toBeInTheDocument();
  });

  it('never leaves a guarded route stuck on loading after a cold boot', async () => {
    setSession({ status: 'loading' });
    bootSession();
    expect(getSession().status).toBe('anonymous');
    renderAt('/tickets');
    expect(await screen.findByRole('heading', { name: '다시 오셨네요' })).toBeInTheDocument();
  });

  it('uses a registered hydrator when one exists', async () => {
    setSession({ status: 'loading' });
    registerSessionHydrator((set) => {
      set({ status: 'signedIn', account: `0x${'22'.repeat(20)}`, personId: 'p2' });
      return () => undefined;
    });
    bootSession();
    expect(getSession()).toMatchObject({ status: 'signedIn', personId: 'p2' });
    registerSessionHydrator(null);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run (from `apps/web/`): `pnpm vitest run src/router.test.tsx`
Expected: FAIL — `Failed to resolve import "./router"`.

- [ ] **Step 3: 세션과 Query 클라이언트**

```ts
// apps/web/src/shared/session.ts
import { useSyncExternalStore } from 'react';
import type { Hex } from '@monti/shared';

export interface Session {
  status: 'loading' | 'anonymous' | 'signedIn';
  account?: Hex;
  personId?: string;
}

let current: Session = { status: 'loading' };
const listeners = new Set<() => void>();

/**
 * Supplied by shared/api/sessionHydrator.ts (Task 16) so this module stays Firebase-free.
 * Receives `set` and returns an unsubscribe.
 */
export type SessionHydrator = (set: (session: Session) => void) => () => void;
let hydrator: SessionHydrator | null = null;

export function registerSessionHydrator(next: SessionHydrator | null): void {
  hydrator = next;
}

/** Called once from <App/>. Guarantees status leaves 'loading'. */
export function bootSession(): () => void {
  if (!hydrator) {
    setSession({ status: 'anonymous' });
    return () => undefined;
  }
  const unsubscribe = hydrator(setSession);
  // A hydrator that has not answered yet must not leave the guard spinning forever.
  setTimeout(() => {
    if (current.status === 'loading') setSession({ status: 'anonymous' });
  }, 3_000);
  return unsubscribe;
}

function emit(): void {
  for (const listener of listeners) listener();
}

export function setSession(next: Session): void {
  current = next;
  emit();
}

export function clearSession(): void {
  setSession({ status: 'anonymous' });
}

export function getSession(): Session {
  return current;
}

export function useSession(): Session {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSession,
    getSession,
  );
}
```

```ts
// apps/web/src/shared/query.ts
import { QueryClient } from '@tanstack/react-query';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 15_000, retry: 1, refetchOnWindowFocus: false },
    mutations: { retry: 0 },
  },
});
```

- [ ] **Step 4: 라우터와 App**

```tsx
// apps/web/src/router.tsx
import { Navigate, Outlet, type RouteObject, useLocation } from 'react-router-dom';
import { BottomTabs } from './shared/ui';
import { useSession } from './shared/session';
import { Spinner } from './shared/ui';

const TAB_PATHS = ['/', '/tickets', '/chats', '/me'];

function TabShell() {
  const location = useLocation();
  const showTabs = TAB_PATHS.includes(location.pathname);
  return (
    <>
      <Outlet />
      {showTabs ? <BottomTabs /> : null}
    </>
  );
}

export function RequireSession() {
  const session = useSession();
  if (session.status === 'loading') return <Spinner />;
  if (session.status === 'anonymous') return <Navigate to="/login" replace />;
  return <Outlet />;
}

// 각 화면은 뒤 태스크에서 실제 구현으로 교체된다. 여기서는 라우트 표를 확정한다.
import { Discover } from './attendee/discover/Discover';
import { EventDetail } from './attendee/discover/EventDetail';
import { Login } from './attendee/Login';
import { Phone } from './attendee/signup/Phone';
import { Verify } from './attendee/signup/Verify';
import { VerifyIdentity } from './attendee/me/VerifyIdentity';
import { PasskeyStep } from './attendee/signup/Passkey';
import { DeviceStep } from './attendee/signup/Device';
import { Done } from './attendee/signup/Done';
import { TicketList } from './attendee/tickets/List';
import { TicketDetail } from './attendee/tickets/Detail';
import { TransferRecipient } from './attendee/transfer/Recipient';
import { Enter } from './attendee/enter/Enter';
import { ChatList } from './attendee/chats/ChatList';
import { ChatRoom } from './attendee/chats/ChatRoom';
import { Profile } from './attendee/me/Profile';
import { OrganizerRoutes } from './organizer/Layout';
import { StaffRoutes } from './staff/Console';

export const routes: RouteObject[] = [
  {
    element: <TabShell />,
    children: [
      { path: '/', element: <Discover /> },
      { path: '/events/:eventId', element: <EventDetail /> },
      { path: '/login', element: <Login /> },
      { path: '/signup/phone', element: <Phone /> },
      { path: '/signup/verify', element: <Verify /> },
      { path: '/signup/passkey', element: <PasskeyStep /> },
      { path: '/signup/device', element: <DeviceStep /> },
      { path: '/signup/done', element: <Done /> },
      {
        element: <RequireSession />,
        children: [
          { path: '/tickets', element: <TicketList /> },
          { path: '/tickets/:tokenId', element: <TicketDetail /> },
          { path: '/tickets/:tokenId/transfer', element: <TransferRecipient /> },
          { path: '/tickets/:tokenId/enter', element: <Enter /> },
          { path: '/chats', element: <ChatList /> },
          { path: '/chats/:eventId', element: <ChatRoom /> },
          { path: '/me', element: <Profile /> },
          { path: '/me/verify', element: <VerifyIdentity /> },
          { path: '/org/*', element: <OrganizerRoutes /> },
        ],
      },
      { path: '/staff/*', element: <StaffRoutes /> },
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
];
```

```tsx
// apps/web/src/App.tsx
import { useEffect } from 'react';
import { RouterProvider, createBrowserRouter } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { routes } from './router';
import { queryClient } from './shared/query';
import { bootSession } from './shared/session';
import './shared/theme.css';

const router = createBrowserRouter(routes);

export function App() {
  useEffect(() => bootSession(), []);
  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}
```

`main.tsx`는 i18n 초기화를 먼저 기다리도록 바꾼다:

```tsx
// apps/web/src/main.tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { initI18n } from './shared/i18n';

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('#root not found');

void initI18n().then(() => {
  createRoot(rootElement).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
```

- [ ] **Step 5: 화면 스텁을 만들어 라우트가 살아나게 한다**

각 화면은 뒤 태스크에서 구현으로 교체된다. 지금은 `Screen` 하나만 그리는 스텁을 만든다. 예시 두 개를 그대로 쓰고, 나머지 파일(`EventDetail`, `Verify`, `Passkey`, `Device`, `Done`, `TicketList`, `TicketDetail`, `TransferRecipient`, `Enter`, `ChatList`, `ChatRoom`, `Profile`, `me/VerifyIdentity`, `organizer/Layout`, `staff/Console`)도 같은 모양으로 만든다.

**가입 경로는 Didit을 거치지 않는다**(창업자 결정: 본인인증은 행사별). `/signup/phone → /signup/verify → /signup/passkey → /signup/device → /signup/done` 다섯 화면뿐이고, 신분증·얼굴 확인은 `/me/verify`에서 따로 한다.

```tsx
// apps/web/src/attendee/Login.tsx
import { Screen, Button } from '../shared/ui';
import { useCopy } from '../shared/i18n';

export function Login() {
  const copy = useCopy();
  return (
    <Screen title={copy.login.title}>
      <p>{copy.login.body}</p>
      <Button>{copy.login.cta}</Button>
    </Screen>
  );
}
```

```tsx
// apps/web/src/attendee/signup/Phone.tsx
import { Screen } from '../../shared/ui';
import { useCopy } from '../../shared/i18n';

export function Phone() {
  const copy = useCopy();
  return <Screen title={copy.signup.phoneTitle}>{copy.signup.phoneHint}</Screen>;
}
```

```tsx
// apps/web/src/organizer/Layout.tsx
export function OrganizerRoutes() {
  return <main className="screen">organizer</main>;
}
```

```tsx
// apps/web/src/staff/Console.tsx
export function StaffRoutes() {
  return <main className="screen">staff</main>;
}
```

- [ ] **Step 6: 테스트 통과 확인**

Run (from `apps/web/`): `pnpm vitest run src/router.test.tsx`
Expected: PASS — `Tests  5 passed (5)`.

- [ ] **Step 7: 타입 검사와 커밋**

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/apps/web && pnpm typecheck
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI
git add apps/web/src
git commit -m "feat(web): add route table, query provider, session store and tab shell"
```
Expected: `pnpm typecheck` 출력 없음(에러 0).

---

## Task 7: `src/shared/config.ts` — 환경 설정 한 곳

**Files:**
- Create: `apps/web/src/shared/config.ts`, `apps/web/.env.example`
- Test: `apps/web/src/shared/config.test.ts`

**Interfaces:**
- Consumes: 없음.
- Produces: `interface AppConfig`, `getConfig(): AppConfig`, `resetConfig(): void`(테스트용). 주소·URL·키를 쓰는 모든 모듈은 반드시 이 함수를 거친다.

- [ ] **Step 1: 실패하는 테스트**

```ts
// apps/web/src/shared/config.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getConfig, resetConfig } from './config';

const BASE = {
  VITE_CHAIN_ID: '10143',
  VITE_RPC_URLS: 'https://a.example/rpc,https://b.example/rpc,https://testnet-rpc.monad.xyz',
  VITE_WS_URL: 'wss://testnet-rpc.monad.xyz',
  VITE_BUNDLER_URL: 'https://api.pimlico.io/v2/10143/rpc?apikey=k',
  VITE_ADDR_IDENTITY: `0x${'11'.repeat(20)}`,
  VITE_ADDR_ORGANIZERS: `0x${'22'.repeat(20)}`,
  VITE_ADDR_TICKET: `0x${'33'.repeat(20)}`,
  VITE_ADDR_PAYMASTER: `0x${'44'.repeat(20)}`,
  VITE_ENVIO_URL: 'https://indexer.example/v1/graphql',
  VITE_RP_ID: 'monti.app',
  VITE_IPFS_GATEWAY: 'https://gateway.pinata.cloud/ipfs/',
  VITE_PINATA_JWT: 'jwt',
};

afterEach(() => {
  resetConfig();
  vi.unstubAllEnvs();
});

describe('getConfig', () => {
  it('parses every variable and splits the RPC list', () => {
    for (const [key, value] of Object.entries(BASE)) vi.stubEnv(key, value);
    const config = getConfig();
    expect(config.chainId).toBe(10143);
    expect(config.rpcUrls).toHaveLength(3);
    expect(config.addresses.ticket).toBe(BASE.VITE_ADDR_TICKET);
    expect(config.entryPoint).toBe('0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789');
    expect(config.explorerUrl).toBe('https://testnet.monadexplorer.com');
  });

  it('throws naming the missing variable', () => {
    for (const [key, value] of Object.entries(BASE)) vi.stubEnv(key, value);
    vi.stubEnv('VITE_ADDR_TICKET', '');
    expect(() => getConfig()).toThrow('VITE_ADDR_TICKET');
  });

  it('never hardcodes the chain id in logic', () => {
    for (const [key, value] of Object.entries(BASE)) vi.stubEnv(key, value);
    vi.stubEnv('VITE_CHAIN_ID', '143');
    expect(getConfig().chainId).toBe(143);
    expect(getConfig().explorerUrl).toBe('https://monadexplorer.com');
  });
});
```

- [ ] **Step 2: 실패 확인**

Run (from `apps/web/`): `pnpm vitest run src/shared/config.test.ts`
Expected: FAIL — `Failed to resolve import "./config"`.

- [ ] **Step 3: 구현**

```ts
// apps/web/src/shared/config.ts
import { ENTRY_POINT_V06, explorerUrlFor, type Hex } from '@monti/shared';

export interface AppConfig {
  chainId: number;
  rpcUrls: string[];
  wsUrl: string;
  bundlerUrl: string;
  entryPoint: Hex;
  addresses: { identity: Hex; organizers: Hex; ticket: Hex; paymaster: Hex };
  envioUrl: string;
  rpId: string;
  ipfsGateway: string;
  pinataJwt: string;
  /** Derived from chainId via @monti/shared, so no view hardcodes an explorer host. */
  explorerUrl: string;
}

let cached: AppConfig | null = null;

function required(name: string): string {
  const value = import.meta.env[name as keyof ImportMetaEnv];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Missing environment variable ${name}. See apps/web/.env.example`);
  }
  return value;
}

export function resetConfig(): void {
  cached = null;
}

export function getConfig(): AppConfig {
  if (cached) return cached;
  const chainId = Number.parseInt(required('VITE_CHAIN_ID'), 10);
  cached = {
    chainId,
    rpcUrls: required('VITE_RPC_URLS').split(',').map((url) => url.trim()).filter(Boolean),
    wsUrl: required('VITE_WS_URL'),
    bundlerUrl: required('VITE_BUNDLER_URL'),
    entryPoint: ENTRY_POINT_V06,
    addresses: {
      identity: required('VITE_ADDR_IDENTITY') as Hex,
      organizers: required('VITE_ADDR_ORGANIZERS') as Hex,
      ticket: required('VITE_ADDR_TICKET') as Hex,
      paymaster: required('VITE_ADDR_PAYMASTER') as Hex,
    },
    envioUrl: required('VITE_ENVIO_URL'),
    rpId: required('VITE_RP_ID'),
    ipfsGateway: required('VITE_IPFS_GATEWAY'),
    pinataJwt: required('VITE_PINATA_JWT'),
    explorerUrl: explorerUrlFor(chainId),
  };
  return cached;
}
```

- [ ] **Step 4: `.env.example`**

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/apps/web
cat > .env.example <<'EOF'
VITE_CHAIN_ID=10143
VITE_RPC_URLS=https://monad-testnet.g.alchemy.com/v2/KEY,https://monad.gateway.tenderly.co/KEY,https://testnet-rpc.monad.xyz
VITE_WS_URL=wss://testnet-rpc.monad.xyz
VITE_BUNDLER_URL=https://api.pimlico.io/v2/10143/rpc?apikey=KEY
VITE_ADDR_IDENTITY=0x0000000000000000000000000000000000000000
VITE_ADDR_ORGANIZERS=0x0000000000000000000000000000000000000000
VITE_ADDR_TICKET=0x0000000000000000000000000000000000000000
VITE_ADDR_PAYMASTER=0x0000000000000000000000000000000000000000
VITE_ENVIO_URL=http://localhost:8080/v1/graphql
VITE_RP_ID=monti.app
VITE_IPFS_GATEWAY=https://gateway.pinata.cloud/ipfs/
VITE_PINATA_JWT=
VITE_FIREBASE_API_KEY=
VITE_FIREBASE_PROJECT_ID=monti-dev
VITE_FIREBASE_APP_ID=
VITE_FIREBASE_SENDER_ID=
VITE_FIREBASE_VAPID_KEY=
EOF
cp .env.example .env.local
```

- [ ] **Step 5: 테스트 통과 확인**

Run (from `apps/web/`): `pnpm vitest run src/shared/config.test.ts`
Expected: PASS — `Tests  3 passed (3)`.

- [ ] **Step 6: 커밋**

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI
git add apps/web/src/shared/config.ts apps/web/src/shared/config.test.ts apps/web/.env.example
git commit -m "feat(web): add typed app config with fail-fast env parsing"
```

---

## Task 8: `shared/chain/` 공개 클라이언트와 `subscribeLogs`

**Files:**
- Create: `apps/web/src/shared/chain/chain.ts`, `client.ts`, `subscribeLogs.ts`
- Test: `apps/web/src/shared/chain/client.test.ts`

**Interfaces:**
- Consumes: `getConfig()` (Task 7).
- Produces: `monadChain(chainId, rpcUrls, wsUrl): Chain`, `getPublicClient(): PublicClient`, `resetChainClients(): void`, `getWebSocketClient(): PublicClient`, `resetWebSocketClient(): void`, `type LogStage`, `type ChainLog`, `subscribeLogs({ address, topics, onLog }): () => void`. **sub-plan 04가 게이트 판정 화면에서 같은 함수를 쓴다.**

폴백 전송은 viem `fallback([...])`로 만든다. 순서는 `VITE_RPC_URLS`가 정하고(권장: Alchemy → Tenderly → 공식), `rank: false`로 두어 **순서를 뒤집지 않는다** — 공식 RPC는 마지막 보루이지 최고 속도가 아니다. 구독은 Monad 전용 `monadLogs`를 쓴다. `commitState`가 `Proposed`/`Voted`면 `stage: 'speculative'`, `Finalized`면 `stage: 'finalized'`로 올려 보낸다. 소켓이 없거나 서버가 `monadLogs`를 모르면 **블록마다 `eth_getLogs`를 `blockTag: 'latest'` 그다음 `'finalized'`로 돌리는 폴링**으로 떨어진다. 스태프 화면이 0.7초에 초록을 켜고 확정에서 굳히는 스펙 §7.2 8단계가 이 두 단계에 그대로 대응한다.

- [ ] **Step 1: 실패하는 테스트**

```ts
// apps/web/src/shared/chain/client.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getPublicClient, monadChain, resetChainClients } from './client';
import { resetWebSocketClient } from './subscribeLogs';

beforeEach(() => {
  vi.stubEnv('VITE_CHAIN_ID', '10143');
  vi.stubEnv('VITE_RPC_URLS', 'https://a.example/rpc,https://b.example/rpc');
  vi.stubEnv('VITE_WS_URL', 'wss://ws.example');
  vi.stubEnv('VITE_BUNDLER_URL', 'https://bundler.example');
  for (const name of ['IDENTITY', 'ORGANIZERS', 'TICKET', 'PAYMASTER']) {
    vi.stubEnv(`VITE_ADDR_${name}`, `0x${'11'.repeat(20)}`);
  }
  vi.stubEnv('VITE_ENVIO_URL', 'https://envio.example/v1/graphql');
  vi.stubEnv('VITE_RP_ID', 'monti.app');
  vi.stubEnv('VITE_IPFS_GATEWAY', 'https://gw.example/ipfs/');
  vi.stubEnv('VITE_PINATA_JWT', 'jwt');
});

afterEach(() => {
  resetChainClients();
  resetWebSocketClient();   // otherwise a live socket leaks between test files
  vi.unstubAllEnvs();
});

describe('chain client', () => {
  it('builds the chain definition from config, never a literal', () => {
    const chain = monadChain(10143, ['https://a.example/rpc'], 'wss://ws.example');
    expect(chain.id).toBe(10143);
    expect(chain.nativeCurrency.symbol).toBe('MON');
    expect(chain.rpcUrls.default.http).toEqual(['https://a.example/rpc']);
  });

  it('falls through to the second RPC when the first fails', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        calls.push(url);
        if (url.includes('a.example')) throw new Error('down');
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x279f' }), {
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
    const client = getPublicClient();
    await expect(client.getChainId()).resolves.toBe(10143);
    expect(calls.some((url) => url.includes('a.example'))).toBe(true);
    expect(calls.some((url) => url.includes('b.example'))).toBe(true);
  });

  it('returns the same client instance until reset', () => {
    const first = getPublicClient();
    expect(getPublicClient()).toBe(first);
    resetChainClients();
    expect(getPublicClient()).not.toBe(first);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run (from `apps/web/`): `pnpm vitest run src/shared/chain/client.test.ts`
Expected: FAIL — `Failed to resolve import "./client"`.

- [ ] **Step 3: 체인 정의와 공개 클라이언트**

```ts
// apps/web/src/shared/chain/chain.ts
import { defineChain, type Chain } from 'viem';
import { MONAD_MAINNET_CHAIN_ID, explorerUrlFor } from '@monti/shared';

export function monadChain(chainId: number, rpcUrls: string[], wsUrl: string): Chain {
  return defineChain({
    id: chainId,
    name: chainId === MONAD_MAINNET_CHAIN_ID ? 'Monad' : 'Monad Testnet',
    nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
    rpcUrls: { default: { http: rpcUrls, webSocket: [wsUrl] } },
    blockExplorers: { default: { name: 'MonadVision', url: explorerUrlFor(chainId) } },
    testnet: chainId !== MONAD_MAINNET_CHAIN_ID,
  });
}
```

```ts
// apps/web/src/shared/chain/client.ts
import { createPublicClient, fallback, http, type PublicClient } from 'viem';
import { getConfig } from '../config';
import { monadChain } from './chain';

export { monadChain };

let publicClient: PublicClient | null = null;

export function getPublicClient(): PublicClient {
  if (publicClient) return publicClient;
  const config = getConfig();
  const chain = monadChain(config.chainId, config.rpcUrls, config.wsUrl);
  publicClient = createPublicClient({
    chain,
    // rank:false keeps the operator-chosen order: Alchemy, Tenderly, then the official RPC.
    transport: fallback(
      config.rpcUrls.map((url) => http(url, { timeout: 8_000, retryCount: 1 })),
      { rank: false, retryCount: 0 },
    ),
    batch: { multicall: { wait: 16 } },
  });
  return publicClient;
}

/** Only the HTTP client lives here. The socket is owned by subscribeLogs.resetWebSocketClient(). */
export function resetChainClients(): void {
  publicClient = null;
}
```

- [ ] **Step 4: `subscribeLogs`**

```ts
// apps/web/src/shared/chain/subscribeLogs.ts
import { createPublicClient, webSocket, type Log, type PublicClient } from 'viem';
import type { Hex } from '@monti/shared';
import { getConfig } from '../config';
import { monadChain } from './chain';
import { getPublicClient } from './client';

/**
 * Named LogStage, not ChainStage: src/staff/types.ts exports a three-member `ChainStage`
 * ('speculative' | 'finalized' | 'offline') for the gate header, and two same-named
 * exported unions in one codebase widen silently when the wrong one is imported.
 */
export type LogStage = 'speculative' | 'finalized';
export type ChainLog = Log & { stage: LogStage };

let wsClient: PublicClient | null = null;

export function getWebSocketClient(): PublicClient {
  if (wsClient) return wsClient;
  const config = getConfig();
  wsClient = createPublicClient({
    chain: monadChain(config.chainId, config.rpcUrls, config.wsUrl),
    transport: webSocket(config.wsUrl, {
      reconnect: { attempts: 10, delay: 1_000 },
      keepAlive: { interval: 20_000 },
    }),
  });
  return wsClient;
}

export function resetWebSocketClient(): void {
  wsClient = null;
}

const STAGE_BY_COMMIT_STATE: Record<string, LogStage> = {
  Proposed: 'speculative',
  Voted: 'speculative',
  Finalized: 'finalized',
};

export interface SubscribeLogsArgs {
  address: Hex;
  topics: (Hex | Hex[] | null)[];
  onLog: (log: ChainLog) => void;
}

/**
 * Monad's `monadLogs` reports the same log at each commit stage. The gate screen turns
 * green on `speculative` (~0.7 s) and hardens on `finalized` (~1.3 s), spec 7.2 step 8.
 */
export function subscribeLogs({ address, topics, onLog }: SubscribeLogsArgs): () => void {
  let stopped = false;
  let unsubscribe: (() => void) | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  const seen = new Set<string>();

  const emit = (raw: Record<string, unknown>, stage: LogStage) => {
    const key = `${stage}:${String(raw.transactionHash)}:${String(raw.logIndex)}`;
    if (seen.has(key)) return;
    seen.add(key);
    onLog({ ...(raw as unknown as Log), stage });
  };

  const pollOnce = async (stage: LogStage) => {
    const blockTag = stage === 'speculative' ? 'latest' : 'finalized';
    const logs = await getPublicClient()
      .request({ method: 'eth_getLogs', params: [{ address, topics, fromBlock: blockTag, toBlock: blockTag }] } as never)
      .catch(() => [] as unknown[]);
    for (const log of logs as Array<Record<string, unknown>>) emit(log, stage);
  };

  const startPolling = () => {
    if (timer || stopped) return;
    timer = setInterval(() => {
      void pollOnce('speculative');
      void pollOnce('finalized');
    }, 400);
  };

  void (async () => {
    try {
      const transport = getWebSocketClient().transport as unknown as {
        subscribe: (args: {
          params: unknown[];
          onData: (message: { result?: Record<string, unknown> }) => void;
          onError: (error: unknown) => void;
        }) => Promise<{ unsubscribe: () => Promise<void> }>;
      };
      const subscription = await transport.subscribe({
        params: ['monadLogs', { address, topics }],
        onData: (message) => {
          const result = message.result;
          if (!result) return;
          emit(result, STAGE_BY_COMMIT_STATE[String(result.commitState ?? 'Proposed')] ?? 'speculative');
        },
        onError: () => startPolling(),
      });
      if (stopped) { void subscription.unsubscribe(); return; }
      unsubscribe = () => void subscription.unsubscribe();
    } catch {
      startPolling();
    }
  })();

  return () => {
    stopped = true;
    unsubscribe?.();
    if (timer) clearInterval(timer);
  };
}
```

- [ ] **Step 5: 테스트 통과 확인**

Run (from `apps/web/`): `pnpm vitest run src/shared/chain/client.test.ts`
Expected: PASS — `Tests  3 passed (3)`.

- [ ] **Step 6: 커밋**

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI
git add apps/web/src/shared/chain
git commit -m "feat(web): add monad public client with fallback transports and staged log subscription"
```

---

## Task 9: 생성된 ABI 전량 로딩과 타입 붙은 읽기 (`abis.ts`, `reads.ts`)

**Files:**
- Create: `apps/web/src/shared/chain/abis.ts`, `apps/web/src/shared/chain/reads.ts`
- Test: `apps/web/src/shared/chain/reads.test.ts`, `apps/web/src/shared/chain/abi-conformance.test.ts`

**Interfaces:**
- Consumes: `getPublicClient()` (Task 8), `getConfig()` (Task 7), sub-plan 01의 `export-abi.sh`가 넣는 `@monti/shared/abi/{Identity,Organizers,Ticket}.json` **전량(이벤트 포함)**.
- Produces: `identityAbi`, `organizersAbi`, `ticketAbi` (생성 JSON 그대로, `viem`의 `Abi`), `USED_ABI` 사용 매니페스트, `readIdentity()`, `readOrganizers()`, `readTicket()` 및 구조체 타입 `EventMetaStruct` `TierStruct` `CheckInStruct` `OfferStruct`.

**손으로 ABI 조각을 다시 적지 않는다.** 01이 내보낸 JSON을 그대로 싣는다. 이유 둘: ① 손으로 적은 조각에는 **이벤트가 하나도 없어서** `encodeEventTopics({ abi: ticketAbi, eventName: 'CheckedIn' })`(Task 26)가 `AbiEventNotFoundError`로 죽는다. ② solc가 뱉는 JSON은 모든 입출력에 `internalType`을 붙이고 키 순서도 `{internalType, name, type}`이라, 손으로 적은 `{name, type}`과 `JSON.stringify` 비교를 하면 **영원히 불일치**다.

대신 **사용 매니페스트**를 둔다. 이 앱이 실제로 부르는 함수와 구독하는 이벤트의 이름·입력 타입·출력 타입만 적고, conformance 테스트가 생성 ABI를 `internalType`을 벗긴 형태로 정규화해 대조한다. 01이 시그니처를 바꾸면 그 테스트가 가장 먼저 깨진다.

- [ ] **Step 1: 실패하는 테스트 두 개**

```ts
// apps/web/src/shared/chain/reads.test.ts
import { describe, expect, it, vi } from 'vitest';

const readContract = vi.fn();
vi.mock('./client', () => ({ getPublicClient: () => ({ readContract }) }));
vi.mock('../config', () => ({
  getConfig: () => ({
    addresses: { identity: `0x${'11'.repeat(20)}`, organizers: `0x${'22'.repeat(20)}`, ticket: `0x${'33'.repeat(20)}` },
  }),
}));

const { readIdentity, readOrganizers, readTicket } = await import('./reads');

describe('reads', () => {
  it('reads isMember against the identity address', async () => {
    readContract.mockResolvedValueOnce(true);
    await expect(readIdentity().isMember(`0x${'aa'.repeat(20)}`)).resolves.toBe(true);
    expect(readContract).toHaveBeenCalledWith(
      expect.objectContaining({ address: `0x${'11'.repeat(20)}`, functionName: 'isMember' }),
    );
  });

  it('maps the gateInfo tuple to a named object', async () => {
    readContract.mockResolvedValueOnce([7n, `0x${'bb'.repeat(20)}`, `0x${'01'.repeat(32)}`, `0x${'02'.repeat(32)}`, true, false]);
    await expect(readOrganizers().gateInfo(3n)).resolves.toEqual({
      eventId: 7n, account: `0x${'bb'.repeat(20)}`, kx: `0x${'01'.repeat(32)}`, ky: `0x${'02'.repeat(32)}`, open: true, revoked: false,
    });
  });

  it('reads checkInOf as a struct', async () => {
    readContract.mockResolvedValueOnce({ gateId: 1n, ts: 1790000000n, nonceHash: `0x${'00'.repeat(32)}`, manual: false });
    await expect(readTicket().checkInOf(9n)).resolves.toMatchObject({ gateId: 1n, manual: false });
  });
});
```

```ts
// apps/web/src/shared/chain/abi-conformance.test.ts
import { describe, expect, it } from 'vitest';
import { USED_ABI, identityAbi, organizersAbi, ticketAbi, normaliseTypes } from './abis';

const BY_CONTRACT = { Identity: identityAbi, Organizers: organizersAbi, Ticket: ticketAbi } as const;

describe('generated abi covers everything this app uses', () => {
  for (const [contract, entries] of Object.entries(USED_ABI)) {
    for (const wanted of entries) {
      it(`${contract}.${wanted.name} (${wanted.type}) matches the generated abi`, () => {
        const abi = BY_CONTRACT[contract as keyof typeof BY_CONTRACT];
        const found = abi.find((entry) => entry.type === wanted.type && 'name' in entry && entry.name === wanted.name);
        expect(found, `${contract}.${wanted.name} missing from the generated ABI`).toBeDefined();
        // internalType and key order are solc artefacts; compare names + types only.
        expect(normaliseTypes(found!.inputs ?? [])).toEqual(wanted.inputs);
        expect(normaliseTypes((found as { outputs?: unknown[] }).outputs ?? [])).toEqual(wanted.outputs ?? []);
      });
    }
  }
});
```

- [ ] **Step 2: 실패 확인**

Run (from `apps/web/`): `pnpm vitest run src/shared/chain/reads.test.ts`
Expected: FAIL — `Failed to resolve import "./reads"`.

`abi-conformance.test.ts`는 **sub-plan 01이 `packages/shared/src/abi/*.json`을 넣은 뒤에** 돌린다. 그 전에는 `Cannot find module '@monti/shared/abi/Identity.json'` 로 실패하는 것이 정상이며, Step 5에서 조건을 명시한다.

- [ ] **Step 3: 생성 ABI 로딩과 사용 매니페스트**

```ts
// apps/web/src/shared/chain/abis.ts
import type { Abi } from 'viem';
import identityJson from '@monti/shared/abi/Identity.json';
import organizersJson from '@monti/shared/abi/Organizers.json';
import ticketJson from '@monti/shared/abi/Ticket.json';

// Full generated ABIs, events included. Nothing here is hand-written.
export const identityAbi = identityJson as Abi;
export const organizersAbi = organizersJson as Abi;
export const ticketAbi = ticketJson as Abi;

export interface AbiParamShape { name: string; type: string; components?: AbiParamShape[] }
export interface UsedEntry { type: 'function' | 'event'; name: string; inputs: AbiParamShape[]; outputs?: AbiParamShape[] }

/** Strips solc's `internalType` and any extra keys, recursively. */
export function normaliseTypes(params: readonly unknown[]): AbiParamShape[] {
  return params.map((raw) => {
    const param = raw as { name?: string; type: string; components?: readonly unknown[] };
    const shape: AbiParamShape = { name: param.name ?? '', type: param.type };
    if (param.components) shape.components = normaliseTypes(param.components);
    return shape;
  });
}

const u256 = (name: string): AbiParamShape => ({ name, type: 'uint256' });
const addr = (name: string): AbiParamShape => ({ name, type: 'address' });
const b32 = (name: string): AbiParamShape => ({ name, type: 'bytes32' });

const EVENT_META_COMPONENTS: AbiParamShape[] = [
  { name: 'orgId', type: 'uint256' }, { name: 'titleHash', type: 'bytes32' }, { name: 'descHash', type: 'bytes32' },
  { name: 'imageCid', type: 'string' }, { name: 'startsAt', type: 'uint64' }, { name: 'endsAt', type: 'uint64' },
  { name: 'venueHash', type: 'bytes32' }, { name: 'saleStart', type: 'uint64' }, { name: 'saleEnd', type: 'uint64' },
  { name: 'transferable', type: 'bool' }, { name: 'transferCutoffSeconds', type: 'uint32' },
  { name: 'maxTransfers', type: 'uint8' }, { name: 'approvalRequired', type: 'bool' },
  { name: 'category', type: 'uint8' }, { name: 'regionCode', type: 'bytes32' }, { name: 'requireKyc', type: 'bool' },
];

const TIER_COMPONENTS: AbiParamShape[] = [
  { name: 'name', type: 'string' }, { name: 'priceUsdCents', type: 'uint256' }, { name: 'supply', type: 'uint32' },
  { name: 'minted', type: 'uint32' }, { name: 'maxPerWallet', type: 'uint16' }, { name: 'seated', type: 'bool' },
];

const CHECKIN_COMPONENTS: AbiParamShape[] = [
  { name: 'gateId', type: 'uint256' }, { name: 'ts', type: 'uint64' },
  { name: 'nonceHash', type: 'bytes32' }, { name: 'manual', type: 'bool' },
];

const OFFER_COMPONENTS: AbiParamShape[] = [
  { name: 'from', type: 'address' }, { name: 'recipientCommitment', type: 'bytes32' }, { name: 'expiresAt', type: 'uint64' },
];

/** Every contract entry this web app calls or subscribes to. The conformance test is the guard. */
export const USED_ABI: Record<'Identity' | 'Organizers' | 'Ticket', UsedEntry[]> = {
  Identity: [
    { type: 'function', name: 'isMember', inputs: [addr('account')], outputs: [{ name: '', type: 'bool' }] },
    { type: 'function', name: 'isLocked', inputs: [addr('account')], outputs: [{ name: '', type: 'bool' }] },
    { type: 'function', name: 'accountOf', inputs: [b32('personId')], outputs: [{ name: '', type: 'address' }] },
    { type: 'function', name: 'personOf', inputs: [addr('account')], outputs: [{ name: '', type: 'bytes32' }] },
    { type: 'function', name: 'activeDevice', inputs: [addr('account')], outputs: [b32('x'), b32('y')] },
    { type: 'function', name: 'deviceUpdatedAt', inputs: [addr('account')], outputs: [{ name: '', type: 'uint64' }] },
    { type: 'function', name: 'kycLevelOf', inputs: [addr('account')], outputs: [{ name: '', type: 'uint8' }] },
    { type: 'function', name: 'nicknameOwner', inputs: [b32('nicknameHash')], outputs: [{ name: '', type: 'address' }] },
    { type: 'function', name: 'nicknameOf', inputs: [addr('account')], outputs: [{ name: '', type: 'bytes32' }] },
    { type: 'function', name: 'setActiveDevice', inputs: [b32('x'), b32('y')], outputs: [] },
    { type: 'function', name: 'setNickname', inputs: [b32('nicknameHash'), { name: 'nickname', type: 'string' }], outputs: [] },
  ],
  Organizers: [
    { type: 'function', name: 'gateInfo', inputs: [u256('gateId')],
      outputs: [u256('eventId'), addr('account'), b32('kx'), b32('ky'), { name: 'open', type: 'bool' }, { name: 'revoked', type: 'bool' }] },
    { type: 'function', name: 'isOpenGate', inputs: [u256('eventId'), addr('gateAccount')], outputs: [{ name: '', type: 'bool' }] },
    { type: 'function', name: 'hasPermission', inputs: [u256('orgId'), addr('account'), { name: 'bit', type: 'uint32' }], outputs: [{ name: '', type: 'bool' }] },
    { type: 'function', name: 'gateOf', inputs: [addr('gateAccount')], outputs: [{ name: '', type: 'uint256' }] },
    { type: 'function', name: 'ownerOf', inputs: [u256('orgId')], outputs: [{ name: '', type: 'address' }] },
    { type: 'function', name: 'registerGate', inputs: [u256('eventId'), addr('gateAccount'), b32('kx'), b32('ky')], outputs: [{ name: '', type: 'uint256' }] },
    { type: 'function', name: 'openGate', inputs: [u256('gateId')], outputs: [] },
    { type: 'function', name: 'closeGate', inputs: [u256('gateId')], outputs: [] },
    { type: 'function', name: 'setAdmin', inputs: [u256('orgId'), addr('admin'), { name: 'permissionBits', type: 'uint32' }], outputs: [] },
    { type: 'function', name: 'setManager', inputs: [u256('orgId'), addr('manager'), { name: 'exists', type: 'bool' }, { name: 'canApprove', type: 'bool' }], outputs: [] },
    { type: 'event', name: 'GateRegistered',
      inputs: [u256('gateId'), u256('eventId'), addr('gateAccount'), b32('kx'), b32('ky')] },
  ],
  Ticket: [
    { type: 'function', name: 'ownerOf', inputs: [u256('tokenId')], outputs: [{ name: '', type: 'address' }] },
    { type: 'function', name: 'eventOf', inputs: [u256('tokenId')], outputs: [{ name: '', type: 'uint256' }] },
    { type: 'function', name: 'tierOf', inputs: [u256('tokenId')], outputs: [{ name: '', type: 'uint8' }] },
    { type: 'function', name: 'eventOrg', inputs: [u256('eventId')], outputs: [{ name: '', type: 'uint256' }] },
    { type: 'function', name: 'balanceOfEvent', inputs: [addr('account'), u256('eventId')], outputs: [{ name: '', type: 'uint256' }] },
    { type: 'function', name: 'transfersOf', inputs: [u256('tokenId')], outputs: [{ name: '', type: 'uint8' }] },
    { type: 'function', name: 'eventStatus', inputs: [u256('eventId')], outputs: [{ name: '', type: 'uint8' }] },
    { type: 'function', name: 'checkInOf', inputs: [u256('tokenId')], outputs: [{ name: '', type: 'tuple', components: CHECKIN_COMPONENTS }] },
    { type: 'function', name: 'offerOf', inputs: [u256('tokenId')], outputs: [{ name: '', type: 'tuple', components: OFFER_COMPONENTS }] },
    { type: 'function', name: 'eventMeta', inputs: [u256('eventId')], outputs: [{ name: '', type: 'tuple', components: EVENT_META_COMPONENTS }] },
    { type: 'function', name: 'tiers', inputs: [u256('eventId')], outputs: [{ name: '', type: 'tuple[]', components: TIER_COMPONENTS }] },
    { type: 'function', name: 'claim', inputs: [u256('eventId'), { name: 'tier', type: 'uint8' }, { name: 'voucher', type: 'bytes' }], outputs: [{ name: '', type: 'uint256' }] },
    { type: 'function', name: 'safeTransferFrom', inputs: [addr('from'), addr('to'), u256('tokenId')], outputs: [] },
    { type: 'function', name: 'createOffer', inputs: [u256('tokenId'), b32('recipientCommitment'), { name: 'expiresAt', type: 'uint64' }], outputs: [] },
    { type: 'function', name: 'cancelOffer', inputs: [u256('tokenId')], outputs: [] },
    { type: 'function', name: 'acceptOffer', inputs: [u256('tokenId'), { name: 'attesterSig', type: 'bytes' }], outputs: [] },
    { type: 'function', name: 'createEvent', inputs: [{ name: 'meta', type: 'tuple', components: EVENT_META_COMPONENTS }, { name: 'tiers', type: 'tuple[]', components: TIER_COMPONENTS }], outputs: [{ name: '', type: 'uint256' }] },
    { type: 'function', name: 'updateEventMeta', inputs: [u256('eventId'), { name: 'meta', type: 'tuple', components: EVENT_META_COMPONENTS }, { name: 'tiers', type: 'tuple[]', components: TIER_COMPONENTS }], outputs: [] },
    { type: 'function', name: 'publishEvent', inputs: [u256('eventId')], outputs: [] },
    { type: 'function', name: 'cancelEvent', inputs: [u256('eventId')], outputs: [] },
    { type: 'event', name: 'CheckedIn', inputs: [u256('tokenId'), u256('eventId'), u256('gateId'), b32('nonceHash'), { name: 'ts', type: 'uint64' }] },
    { type: 'event', name: 'Claimed', inputs: [u256('tokenId'), u256('eventId'), addr('to'), { name: 'tier', type: 'uint8' }] },
    { type: 'event', name: 'Transfer', inputs: [addr('from'), addr('to'), u256('tokenId')] },
    { type: 'event', name: 'OfferAccepted', inputs: [u256('tokenId'), addr('from'), addr('to')] },
  ],
};
```

- [ ] **Step 4: 읽기 팩터리**

```ts
// apps/web/src/shared/chain/reads.ts
import type { Abi, Hex } from 'viem';
import { getConfig } from '../config';
import { getPublicClient } from './client';
import { identityAbi, organizersAbi, ticketAbi } from './abis';

export interface CheckInStruct { gateId: bigint; ts: bigint; nonceHash: Hex; manual: boolean }
export interface OfferStruct { from: Hex; recipientCommitment: Hex; expiresAt: bigint }
export interface EventMetaStruct {
  orgId: bigint; titleHash: Hex; descHash: Hex; imageCid: string; startsAt: bigint; endsAt: bigint;
  venueHash: Hex; saleStart: bigint; saleEnd: bigint; transferable: boolean; transferCutoffSeconds: number;
  maxTransfers: number; approvalRequired: boolean; category: number; regionCode: Hex; requireKyc: boolean;
}
export interface TierStruct { name: string; priceUsdCents: bigint; supply: number; minted: number; maxPerWallet: number; seated: boolean }

function reader(address: Hex, abi: Abi) {
  return <T>(functionName: string, args: readonly unknown[]): Promise<T> =>
    getPublicClient().readContract({ address, abi, functionName, args }) as Promise<T>;
}

export function readIdentity() {
  const call = reader(getConfig().addresses.identity, identityAbi);
  return {
    isMember: (account: Hex) => call<boolean>('isMember', [account]),
    isLocked: (account: Hex) => call<boolean>('isLocked', [account]),
    accountOf: (personId: Hex) => call<Hex>('accountOf', [personId]),
    personOf: (account: Hex) => call<Hex>('personOf', [account]),
    deviceUpdatedAt: (account: Hex) => call<bigint>('deviceUpdatedAt', [account]),
    kycLevelOf: (account: Hex) => call<number>('kycLevelOf', [account]),
    nicknameOwner: (nicknameHash: Hex) => call<Hex>('nicknameOwner', [nicknameHash]),
    nicknameOf: (account: Hex) => call<Hex>('nicknameOf', [account]),
    activeDevice: async (account: Hex) => {
      const [x, y] = await call<[Hex, Hex]>('activeDevice', [account]);
      return { x, y };
    },
  };
}

export function readOrganizers() {
  const call = reader(getConfig().addresses.organizers, organizersAbi);
  return {
    isOpenGate: (eventId: bigint, gateAccount: Hex) => call<boolean>('isOpenGate', [eventId, gateAccount]),
    hasPermission: (orgId: bigint, account: Hex, bit: number) => call<boolean>('hasPermission', [orgId, account, bit]),
    gateOf: (gateAccount: Hex) => call<bigint>('gateOf', [gateAccount]),
    ownerOf: (orgId: bigint) => call<Hex>('ownerOf', [orgId]),
    gateInfo: async (gateId: bigint) => {
      const [eventId, account, kx, ky, open, revoked] =
        await call<[bigint, Hex, Hex, Hex, boolean, boolean]>('gateInfo', [gateId]);
      return { eventId, account, kx, ky, open, revoked };
    },
  };
}

export function readTicket() {
  const call = reader(getConfig().addresses.ticket, ticketAbi);
  return {
    ownerOf: (tokenId: bigint) => call<Hex>('ownerOf', [tokenId]),
    eventOf: (tokenId: bigint) => call<bigint>('eventOf', [tokenId]),
    tierOf: (tokenId: bigint) => call<number>('tierOf', [tokenId]),
    eventOrg: (eventId: bigint) => call<bigint>('eventOrg', [eventId]),
    balanceOfEvent: (account: Hex, eventId: bigint) => call<bigint>('balanceOfEvent', [account, eventId]),
    transfersOf: (tokenId: bigint) => call<number>('transfersOf', [tokenId]),
    eventStatus: (eventId: bigint) => call<number>('eventStatus', [eventId]),
    checkInOf: (tokenId: bigint) => call<CheckInStruct>('checkInOf', [tokenId]),
    offerOf: (tokenId: bigint) => call<OfferStruct>('offerOf', [tokenId]),
    eventMeta: (eventId: bigint) => call<EventMetaStruct>('eventMeta', [eventId]),
    tiers: (eventId: bigint) => call<readonly TierStruct[]>('tiers', [eventId]),
  };
}
```

- [ ] **Step 5: 테스트 통과 확인**

Run (from `apps/web/`): `pnpm vitest run src/shared/chain/reads.test.ts`
Expected: PASS — `Tests  3 passed (3)`.

01이 ABI를 내보낸 뒤: `pnpm vitest run src/shared/chain/abi-conformance.test.ts`
Expected: PASS — `Tests  46 passed (46)` (매니페스트 항목 수만큼. 숫자가 다르면 매니페스트를 센다). 실패하면 **매니페스트를 고치지 말고 01과 시그니처를 맞춘다** — 이 테스트가 존재하는 이유다.

- [ ] **Step 6: 커밋**

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI
git add apps/web/src/shared/chain/abis.ts apps/web/src/shared/chain/reads.ts apps/web/src/shared/chain/reads.test.ts apps/web/src/shared/chain/abi-conformance.test.ts
git commit -m "feat(web): load generated abis with events and guard them with a usage manifest"
```

---

## Task 10: 번들러 클라이언트와 패스키 스마트 계정

**Files:**
- Create: `apps/web/src/shared/chain/bundler.ts`
- Test: `apps/web/src/shared/chain/bundler.test.ts`

**Interfaces:**
- Consumes: `getConfig()`, `getPublicClient()`.
- Produces: `getBundlerClient(): BundlerClient`, `getSmartAccount(webAuthnAccount: WebAuthnAccount): Promise<SmartAccount>`, `setSmartAccount(a)`, `resetBundler(): void`, `bundlerRequest<T>(method, params): Promise<T>`.

`accounts.ts`(`getAttendeeAccount` / `getStaffAccount`)는 **Task 12**에 있다. `shared/passkey/`를 import해야 하는데 그 폴더는 Task 12가 만들기 때문이다 — 여기에 두면 두 태스크가 서로를 기다린다.

계정은 마스터 계획대로 **Coinbase Smart Wallet v1(EntryPoint v0.6)**이고, 소유자는 패스키 하나, `nonce: 0n`이다. `nonce`를 0으로 고정해야 같은 패스키가 항상 같은 주소를 만든다(관객·게이트·관리자 계정이 모두 이 규칙을 쓴다).

- [ ] **Step 1: 실패하는 테스트**

```ts
// apps/web/src/shared/chain/bundler.test.ts
import { describe, expect, it, vi } from 'vitest';

vi.mock('../config', () => ({
  getConfig: () => ({
    chainId: 10143,
    rpcUrls: ['https://rpc.example'],
    wsUrl: 'wss://ws.example',
    bundlerUrl: 'https://bundler.example',
    entryPoint: '0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789',
    addresses: { identity: `0x${'11'.repeat(20)}`, organizers: `0x${'22'.repeat(20)}`, ticket: `0x${'33'.repeat(20)}`, paymaster: `0x${'44'.repeat(20)}` },
  }),
}));

const toCoinbaseSmartAccount = vi.fn(async (args: Record<string, unknown>) => ({ address: `0x${'ab'.repeat(20)}`, args }));
vi.mock('viem/account-abstraction', async (importOriginal) => ({
  ...(await importOriginal<typeof import('viem/account-abstraction')>()),
  toCoinbaseSmartAccount,
}));

const { getSmartAccount, resetBundler } = await import('./bundler');

describe('getSmartAccount', () => {
  it('builds a Coinbase Smart Wallet v1 account with the passkey as the only owner and nonce 0', async () => {
    resetBundler();
    const owner = { type: 'webAuthn', publicKey: `0x${'cd'.repeat(64)}` } as never;
    const account = (await getSmartAccount(owner)) as unknown as { args: Record<string, unknown> };
    expect(toCoinbaseSmartAccount).toHaveBeenCalledTimes(1);
    expect(account.args.owners).toEqual([owner]);
    expect(account.args.nonce).toBe(0n);
    expect(account.args.version).toBe('1');
  });
});
```

- [ ] **Step 2: 실패 확인**

Run (from `apps/web/`): `pnpm vitest run src/shared/chain/bundler.test.ts`
Expected: FAIL — `Failed to resolve import "./bundler"`.

- [ ] **Step 3: 구현**

```ts
// apps/web/src/shared/chain/bundler.ts
import { http } from 'viem';
import {
  createBundlerClient,
  toCoinbaseSmartAccount,
  type BundlerClient,
  type SmartAccount,
  type WebAuthnAccount,
} from 'viem/account-abstraction';
import { getConfig } from '../config';
import { getPublicClient } from './client';

let bundlerClient: BundlerClient | null = null;
let smartAccount: SmartAccount | null = null;
let smartAccountKey: string | null = null;

export function getBundlerClient(): BundlerClient {
  if (bundlerClient) return bundlerClient;
  const config = getConfig();
  bundlerClient = createBundlerClient({
    client: getPublicClient(),
    transport: http(config.bundlerUrl, { timeout: 30_000, retryCount: 1 }),
  });
  return bundlerClient;
}

/**
 * One passkey owner, nonce 0 — the address is a pure function of the passkey public key,
 * so the same credential always resolves to the same account on any device.
 */
export async function getSmartAccount(webAuthnAccount: WebAuthnAccount): Promise<SmartAccount> {
  // Memo keyed on the owner: after clearCredential() + re-login the stale account must not come back.
  const key = String(webAuthnAccount.publicKey);
  if (smartAccount && smartAccountKey === key) return smartAccount;
  smartAccount = await toCoinbaseSmartAccount({
    client: getPublicClient(),
    owners: [webAuthnAccount],
    nonce: 0n,
    version: '1',
  });
  smartAccountKey = key;
  return smartAccount;
}

export function setSmartAccount(account: SmartAccount | null): void {
  smartAccount = account;
  smartAccountKey = account ? String(account.address) : null;
}

export function resetBundler(): void {
  bundlerClient = null;
  smartAccount = null;
  smartAccountKey = null;
}

/** Raw bundler JSON-RPC, used for eth_estimateUserOperationGas and eth_sendUserOperation. */
export async function bundlerRequest<T>(method: string, params: unknown[]): Promise<T> {
  return (await getBundlerClient().request({ method, params } as never)) as T;
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run (from `apps/web/`): `pnpm vitest run src/shared/chain/bundler.test.ts`
Expected: PASS — `Tests  1 passed (1)`.

- [ ] **Step 5: 커밋**

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI
git add apps/web/src/shared/chain/bundler.ts apps/web/src/shared/chain/bundler.test.ts
git commit -m "feat(web): add pimlico bundler client and coinbase smart account factory"
```

---

## Task 11: `sendSponsoredOp` — 시뮬레이션 → ×1.075 → 페이마스터 → 영수증

**Files:**
- Create: `apps/web/src/shared/chain/sendSponsoredOp.ts`, `apps/web/src/shared/chain/ops.ts`
- Test: `apps/web/src/shared/chain/sendSponsoredOp.test.ts`, `apps/web/src/shared/chain/ops.test.ts`

**Interfaces:**
- Consumes: `bundlerRequest` (Task 10), `getPublicClient`, `getConfig`.
- Produces: `applyGasBuffer(value: bigint): bigint`, `encodePaymasterAndData(paymaster: Hex, orgId: bigint): Hex`, `type UserOperationV06`, `type SponsoredCall`, `type SponsoredOpReceipt` = `{ success; txHash; blockNumber: bigint; revertReason? }`, `class SponsoredOpTimeout`, `DEFAULT_WAIT_TIMEOUT_MS = 15_000`, `type SponsoredOpHandle` = `{ userOpHash, wait(timeoutMs?) }`, `sendSponsoredOp({ account, calls, orgId }): Promise<SponsoredOpHandle>`. **sub-plan 04가 `checkIn`·`manualOverride`를 같은 함수로 보낸다.** 호출자는 `account`를 명시적으로 넘기고(관객은 `getAttendeeAccount()`, 스태프는 `getStaffAccount()`, 게이트는 04가 만든 계정), `calls`가 2개 이상이면 Coinbase Smart Wallet `executeBatch`로 묶인다.

**Global Constraint 직결:** Monad는 **한도 기준 과금**이라 세 한도를 반드시 명시해야 하고, 시뮬레이션 값에 **7.5%**를 더한다. 테스트가 그 곱과 `paymasterAndData` 바이트 배치를 직접 검증한다.

이 태스크는 **`ops.ts` 헬퍼 하나도 함께 만든다.** 그것이 없으면 뒤 여섯 화면이 `encodeFunctionData` → `sendSponsoredOp` → `wait()` 블록을 그대로 베껴 쓰게 되고, 실제로 그중 셋이 `success` 확인을 빠뜨린다(되돌린 `createOffer` 뒤에도 "초대를 보냈어요"가 뜬다). `sendOp`은 되돌림을 `OpReverted`로 던지므로 호출부는 성공 경로만 적는다.

- [ ] **Step 1: 실패하는 테스트**

```ts
// apps/web/src/shared/chain/sendSponsoredOp.test.ts
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { numberToHex } from 'viem';

const PAYMASTER = `0x${'44'.repeat(20)}` as const;
vi.mock('../config', () => ({
  getConfig: () => ({
    chainId: 10143, bundlerUrl: 'https://bundler.example',
    entryPoint: '0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789',
    addresses: { identity: `0x${'11'.repeat(20)}`, organizers: `0x${'22'.repeat(20)}`, ticket: `0x${'33'.repeat(20)}`, paymaster: PAYMASTER },
  }),
}));
vi.mock('./client', () => ({
  getPublicClient: () => ({ estimateFeesPerGas: async () => ({ maxFeePerGas: 100_000_000_000n, maxPriorityFeePerGas: 2_000_000_000n }) }),
}));
const bundlerRequest = vi.fn();
vi.mock('./bundler', () => ({ bundlerRequest }));

const account = {
  address: `0x${'ab'.repeat(20)}` as const,
  encodeCalls: vi.fn(async (calls: unknown[]) => (calls.length > 1 ? '0xbatch' : '0xsingle') as const),
  getNonce: vi.fn(async () => 5n),
  getFactoryArgs: vi.fn(async () => ({ factory: undefined, factoryData: undefined })),
  getStubSignature: vi.fn(async () => '0xstub' as const),
  signUserOperation: vi.fn(async () => '0xsig' as const),
} as never;

const { applyGasBuffer, encodePaymasterAndData, sendSponsoredOp, SponsoredOpTimeout } = await import('./sendSponsoredOp');

// restoreMocks only restores spies; a bare vi.fn() keeps its call history between tests.
beforeEach(() => {
  bundlerRequest.mockReset();
  account.encodeCalls.mockClear();
});

describe('sendSponsoredOp', () => {
  it('multiplies every simulated gas limit by 1.075', () => {
    expect(applyGasBuffer(200_000n)).toBe(215_000n);
    expect(applyGasBuffer(100_000n)).toBe(107_500n);
    expect(applyGasBuffer(50_000n)).toBe(53_750n);
    expect(applyGasBuffer(1n)).toBe(1n);
  });

  it('packs paymasterAndData as address ++ uint256 orgId', () => {
    const packed = encodePaymasterAndData(PAYMASTER, 7n);
    expect(packed).toBe(`${PAYMASTER}${'0'.repeat(63)}7`);
    expect(packed).toHaveLength(2 + 40 + 64);
  });

  it('simulates, buffers the limits, sends and resolves the receipt through wait()', async () => {
    bundlerRequest
      .mockResolvedValueOnce({ callGasLimit: '0x30d40', verificationGasLimit: '0x186a0', preVerificationGas: '0xc350' })
      .mockResolvedValueOnce('0xuserophash')
      .mockResolvedValueOnce({ success: true, receipt: { transactionHash: '0xtx', blockNumber: '0x2a' } });

    const handle = await sendSponsoredOp({
      account, orgId: 7n, calls: [{ to: `0x${'33'.repeat(20)}`, data: '0xdeadbeef' }],
    });

    const [sendMethod, sendParams] = bundlerRequest.mock.calls[1]!;
    const sent = (sendParams as unknown[])[0] as Record<string, string>;
    expect(sendMethod).toBe('eth_sendUserOperation');
    // Assert the multiplication itself, not a hand-typed hex string.
    expect(sent.callGasLimit).toBe(numberToHex(applyGasBuffer(200_000n)));
    expect(sent.verificationGasLimit).toBe(numberToHex(applyGasBuffer(100_000n)));
    expect(sent.preVerificationGas).toBe(numberToHex(applyGasBuffer(50_000n)));
    // And pin the three values so a silent change to the buffer is visible in the diff.
    expect(sent.callGasLimit).toBe('0x347d8');          // 200000 * 1.075 = 215000
    expect(sent.verificationGasLimit).toBe('0x1a3ec');  // 100000 * 1.075 = 107500
    expect(sent.preVerificationGas).toBe('0xd1f6');     //  50000 * 1.075 =  53750
    expect(sent.paymasterAndData).toBe(encodePaymasterAndData(PAYMASTER, 7n));
    expect(handle.userOpHash).toBe('0xuserophash');
    await expect(handle.wait()).resolves.toEqual({ success: true, txHash: '0xtx', blockNumber: 42n });
  });

  it('rejects with SponsoredOpTimeout when the receipt never appears', async () => {
    bundlerRequest
      .mockResolvedValueOnce({ callGasLimit: '0x1', verificationGasLimit: '0x1', preVerificationGas: '0x1' })
      .mockResolvedValueOnce('0xlost')
      .mockResolvedValue(null);
    const handle = await sendSponsoredOp({ account, orgId: 1n, calls: [{ to: `0x${'33'.repeat(20)}`, data: '0x01' }] });
    await expect(handle.wait(1)).rejects.toBeInstanceOf(SponsoredOpTimeout);
  });

  it('batches two calls through the account encoder', async () => {
    bundlerRequest
      .mockResolvedValueOnce({ callGasLimit: '0x1', verificationGasLimit: '0x1', preVerificationGas: '0x1' })
      .mockResolvedValueOnce('0xhash2');
    await sendSponsoredOp({
      account, orgId: 1n,
      calls: [{ to: `0x${'33'.repeat(20)}`, data: '0x01' }, { to: `0x${'33'.repeat(20)}`, data: '0x02' }],
    });
    const estimated = (bundlerRequest.mock.calls[0]![1] as unknown[])[0] as Record<string, string>;
    expect(estimated.callData).toBe('0xbatch');
  });
});
```

- [ ] **Step 2: 실패 확인**

Run (from `apps/web/`): `pnpm vitest run src/shared/chain/sendSponsoredOp.test.ts`
Expected: FAIL — `Failed to resolve import "./sendSponsoredOp"`.

- [ ] **Step 3: 구현**

```ts
// apps/web/src/shared/chain/sendSponsoredOp.ts
import { concat, encodePacked, hexToBigInt, numberToHex, type Hex } from 'viem';
import type { SmartAccount } from 'viem/account-abstraction';
import { getConfig } from '../config';
import { getPublicClient } from './client';
import { bundlerRequest } from './bundler';

/** Monad charges on the limit, not on usage. The recommended headroom is 7.5%. */
export const GAS_BUFFER_NUMERATOR = 1075n;
export const GAS_BUFFER_DENOMINATOR = 1000n;

export function applyGasBuffer(value: bigint): bigint {
  return (value * GAS_BUFFER_NUMERATOR) / GAS_BUFFER_DENOMINATOR;
}

/** MontiPaymaster reads abi.encodePacked(address paymaster, uint256 orgId). */
export function encodePaymasterAndData(paymaster: Hex, orgId: bigint): Hex {
  return encodePacked(['address', 'uint256'], [paymaster, orgId]);
}

export interface UserOperationV06 {
  sender: Hex; nonce: Hex; initCode: Hex; callData: Hex;
  callGasLimit: Hex; verificationGasLimit: Hex; preVerificationGas: Hex;
  maxFeePerGas: Hex; maxPriorityFeePerGas: Hex; paymasterAndData: Hex; signature: Hex;
}

export interface SponsoredCall { to: Hex; data: Hex; value?: bigint }
export interface SponsoredOpReceipt { success: boolean; txHash: Hex; blockNumber: bigint; revertReason?: Hex }
export interface SponsoredOpHandle {
  userOpHash: Hex;
  wait(timeoutMs?: number): Promise<SponsoredOpReceipt>;
}
export interface SendSponsoredOpArgs { account: SmartAccount; calls: SponsoredCall[]; orgId: bigint }

/** Callers distinguish "not landed yet" from "reverted": only the latter is a user-facing failure. */
export class SponsoredOpTimeout extends Error {
  constructor(readonly userOpHash: Hex, readonly timeoutMs: number) {
    super(`SponsoredOpTimeout: ${userOpHash} did not land within ${timeoutMs}ms`);
    this.name = 'SponsoredOpTimeout';
  }
}

export const DEFAULT_WAIT_TIMEOUT_MS = 15_000;
const RECEIPT_POLL_INTERVAL_MS = 300;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function sendSponsoredOp({ account, calls, orgId }: SendSponsoredOpArgs): Promise<SponsoredOpHandle> {
  if (calls.length === 0) throw new Error('sendSponsoredOp needs at least one call');
  const config = getConfig();

  // Coinbase Smart Wallet encodeCalls emits execute() for one call and executeBatch() for many.
  const callData = await account.encodeCalls(calls.map((call) => ({ ...call, value: call.value ?? 0n })));
  const nonce = await account.getNonce();
  const factoryArgs = await account.getFactoryArgs();
  const initCode: Hex =
    factoryArgs.factory && factoryArgs.factoryData ? concat([factoryArgs.factory, factoryArgs.factoryData]) : '0x';
  const fees = await getPublicClient().estimateFeesPerGas();
  const paymasterAndData = encodePaymasterAndData(config.addresses.paymaster, orgId);

  const unsigned: UserOperationV06 = {
    sender: account.address,
    nonce: numberToHex(nonce),
    initCode,
    callData,
    callGasLimit: '0x0',
    verificationGasLimit: '0x0',
    preVerificationGas: '0x0',
    maxFeePerGas: numberToHex(fees.maxFeePerGas),
    maxPriorityFeePerGas: numberToHex(fees.maxPriorityFeePerGas),
    paymasterAndData,
    signature: await account.getStubSignature(),
  };

  const estimate = await bundlerRequest<{ callGasLimit: Hex; verificationGasLimit: Hex; preVerificationGas: Hex }>(
    'eth_estimateUserOperationGas',
    [unsigned, config.entryPoint],
  );

  const limits = {
    callGasLimit: numberToHex(applyGasBuffer(hexToBigInt(estimate.callGasLimit))),
    verificationGasLimit: numberToHex(applyGasBuffer(hexToBigInt(estimate.verificationGasLimit))),
    preVerificationGas: numberToHex(applyGasBuffer(hexToBigInt(estimate.preVerificationGas))),
  };

  const signature = await account.signUserOperation({
    sender: unsigned.sender,
    nonce,
    initCode,
    callData,
    callGasLimit: hexToBigInt(limits.callGasLimit),
    verificationGasLimit: hexToBigInt(limits.verificationGasLimit),
    preVerificationGas: hexToBigInt(limits.preVerificationGas),
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    paymasterAndData,
  } as never);

  const userOp: UserOperationV06 = { ...unsigned, ...limits, signature };
  const userOpHash = await bundlerRequest<Hex>('eth_sendUserOperation', [userOp, config.entryPoint]);

  return {
    userOpHash,
    async wait(timeoutMs = DEFAULT_WAIT_TIMEOUT_MS): Promise<SponsoredOpReceipt> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const receipt = await bundlerRequest<{
          success: boolean; reason?: Hex; receipt: { transactionHash: Hex; blockNumber: Hex };
        } | null>('eth_getUserOperationReceipt', [userOpHash]);
        if (receipt) {
          return {
            success: receipt.success,
            txHash: receipt.receipt.transactionHash,
            blockNumber: hexToBigInt(receipt.receipt.blockNumber),
            revertReason: receipt.reason,
          };
        }
        await sleep(RECEIPT_POLL_INTERVAL_MS);
      }
      throw new SponsoredOpTimeout(userOpHash, timeoutMs);
    },
  };
}
```

- [ ] **Step 4: 호출부 하나로 모으는 헬퍼**

```ts
// apps/web/src/shared/chain/ops.ts
import { encodeFunctionData, type Abi, type Hex } from 'viem';
import type { SmartAccount } from 'viem/account-abstraction';
import { getConfig } from '../config';
import { identityAbi, organizersAbi, ticketAbi } from './abis';
import { sendSponsoredOp, type SponsoredOpReceipt } from './sendSponsoredOp';

/** The user operation landed but the contract reverted — a real, user-facing failure. */
export class OpReverted extends Error {
  constructor(readonly functionName: string, readonly revertReason?: Hex) {
    super(`OpReverted: ${functionName}${revertReason ? ` (${revertReason})` : ''}`);
    this.name = 'OpReverted';
  }
}

export interface SendOpArgs {
  account: SmartAccount;
  orgId: bigint;
  to: Hex;
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
  timeoutMs?: number;
}

/** Encode → sponsor → send → wait → throw on revert. Every write in this app goes through here. */
export async function sendOp(options: SendOpArgs): Promise<SponsoredOpReceipt> {
  const handle = await sendSponsoredOp({
    account: options.account,
    orgId: options.orgId,
    calls: [{ to: options.to, data: encodeFunctionData({ abi: options.abi, functionName: options.functionName, args: options.args }) }],
  });
  const receipt = await handle.wait(options.timeoutMs);
  if (!receipt.success) throw new OpReverted(options.functionName, receipt.revertReason);
  return receipt;
}

type ContractOpArgs = Omit<SendOpArgs, 'to' | 'abi'>;

export const ticketOp = (options: ContractOpArgs) =>
  sendOp({ ...options, to: getConfig().addresses.ticket, abi: ticketAbi });

export const identityOp = (options: ContractOpArgs) =>
  sendOp({ ...options, to: getConfig().addresses.identity, abi: identityAbi });

export const organizersOp = (options: ContractOpArgs) =>
  sendOp({ ...options, to: getConfig().addresses.organizers, abi: organizersAbi });
```

```ts
// apps/web/src/shared/chain/ops.test.ts
import { describe, expect, it, vi } from 'vitest';

const sendSponsoredOp = vi.fn();
vi.mock('./sendSponsoredOp', () => ({ sendSponsoredOp }));
vi.mock('./abis', () => ({
  ticketAbi: [{ type: 'function', name: 'claim', stateMutability: 'nonpayable',
    inputs: [{ name: 'eventId', type: 'uint256' }, { name: 'tier', type: 'uint8' }, { name: 'voucher', type: 'bytes' }],
    outputs: [{ name: '', type: 'uint256' }] }],
  identityAbi: [], organizersAbi: [],
}));
vi.mock('../config', () => ({ getConfig: () => ({ addresses: { ticket: `0x${'33'.repeat(20)}`, identity: `0x${'11'.repeat(20)}`, organizers: `0x${'22'.repeat(20)}` } }) }));

const { OpReverted, ticketOp } = await import('./ops');
const account = { address: `0x${'ab'.repeat(20)}` } as never;

describe('ticketOp', () => {
  it('encodes the call against the ticket address and returns the receipt', async () => {
    sendSponsoredOp.mockResolvedValueOnce({
      userOpHash: '0x1', wait: async () => ({ success: true, txHash: '0x2', blockNumber: 7n }),
    });
    await expect(ticketOp({ account, orgId: 9n, functionName: 'claim', args: [5n, 0, '0x'] }))
      .resolves.toMatchObject({ success: true, blockNumber: 7n });
    const sent = sendSponsoredOp.mock.calls[0]![0] as { orgId: bigint; calls: Array<{ to: string; data: string }> };
    expect(sent.orgId).toBe(9n);
    expect(sent.calls[0]!.to).toBe(`0x${'33'.repeat(20)}`);
    expect(sent.calls[0]!.data.startsWith('0x')).toBe(true);
  });

  it('throws OpReverted when the operation lands but the contract reverts', async () => {
    sendSponsoredOp.mockResolvedValueOnce({
      userOpHash: '0x1', wait: async () => ({ success: false, txHash: '0x2', blockNumber: 7n, revertReason: '0xdead' }),
    });
    await expect(ticketOp({ account, orgId: 9n, functionName: 'claim', args: [5n, 0, '0x'] }))
      .rejects.toBeInstanceOf(OpReverted);
  });
});
```

- [ ] **Step 5: 테스트 통과 확인**

Run (from `apps/web/`): `pnpm vitest run src/shared/chain/sendSponsoredOp.test.ts src/shared/chain/ops.test.ts`
Expected: PASS — `Tests  7 passed (7)`.

- [ ] **Step 6: 계산 검증**

`200000 × 1075 / 1000 = 215000 = 0x347d8`, `100000 × 1075 / 1000 = 107500 = 0x1a3ec`, `50000 × 1075 / 1000 = 53750 = 0xd1f6`. 테스트는 **곱셈 자체**(`numberToHex(applyGasBuffer(…))`)를 먼저 단언하고, 그다음 세 값을 리터럴로 고정한다 — 리터럴만 두면 오타가 그대로 규칙이 된다(실제로 초안에 `0x34bc0`=216000, `0xd1ec`=53740이 들어 있었다).

Run (from `apps/web/`): `pnpm vitest run src/shared/chain --reporter=verbose`
Expected: `client.test.ts`, `reads.test.ts`, `bundler.test.ts`, `sendSponsoredOp.test.ts`, `ops.test.ts` 전부 PASS. `abi-conformance.test.ts`는 01이 ABI를 넣기 전까지 실패하는 것이 정상이다.

- [ ] **Step 7: 커밋**

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI
git add apps/web/src/shared/chain/sendSponsoredOp.ts apps/web/src/shared/chain/ops.ts apps/web/src/shared/chain/sendSponsoredOp.test.ts apps/web/src/shared/chain/ops.test.ts
git commit -m "feat(web): add sponsored user operation sender with 7.5% headroom and a write helper"
```

---

## Task 12: `shared/passkey/` — 웹(ox)과 네이티브(@capgo) 한 인터페이스, 그리고 계정 헬퍼

**Files:**
- Create: `apps/web/src/shared/passkey/types.ts`, `cose.ts`, `plugin.ts`, `web.ts`, `native.ts`, `index.ts`, `apps/web/src/shared/chain/accounts.ts`
- Test: `apps/web/src/shared/passkey/passkey.test.ts`, `apps/web/src/shared/passkey/cose.test.ts`

**Interfaces:**
- Consumes: `getConfig().rpId`, `getSmartAccount`/`setSmartAccount` (Task 10), `decodeCbor`/`fromBase64Url`/`toBase64Url` (`@monti/shared/encoding`).
- Produces: `interface WebAuthnCredential { id: string; publicKey: Hex; transports: string[]; attestationJson: string }`, `createPasskey(name): Promise<WebAuthnCredential>`, `getPasskeyAccount(): Promise<WebAuthnAccount>`, `storedCredential()`, `storeCredential(c)`, `clearCredential()`, `parseAttestationPublicKey(attestationObjectB64Url): Hex`, 그리고 `shared/chain/accounts.ts`의 `getAttendeeAccount()` / `getStaffAccount()` (**sub-plan 04가 `getStaffAccount`를 import한다**).

두 가지를 바로잡는다. ① 초안이 import하던 `webauthn-p256-cose`는 **npm에 없다(404)**. COSE 공개키 파싱은 이미 의존성에 있는 `ox`와 `@monti/shared/encoding`의 CBOR 디코더로 직접 한다. ② 플러그인의 실제 표면은 `CapacitorPasskey` 이고 메서드는 `createCredential` / `getCredential` 이다(`Passkey.register/authenticate`가 아니다). 어댑터는 `plugin.ts` 하나뿐이고 **캐스트를 쓰지 않는다** — 타입이 어긋나면 `tsc`가 잡아야 한다.

`signalAllAcceptedCredentials`는 어디서도 호출하지 않는다(iOS 26 버그, Global Constraints).

- [ ] **Step 1: 설치된 플러그인의 실제 타입 정의를 먼저 읽는다**

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/apps/web
cat node_modules/@capgo/capacitor-passkey/dist/esm/definitions.d.ts
cat node_modules/@capgo/capacitor-passkey/dist/esm/index.d.ts
```
Expected: `export declare const CapacitorPasskey: CapacitorPasskeyPlugin;` 와 `createCredential(...)`, `getCredential(...)` 두 메서드. **옵션·반환 필드 이름을 여기서 확인하고, 아래 `plugin.ts`의 인터페이스를 그 정의에 맞춘다.** 다른 파일은 손대지 않는다.

- [ ] **Step 2: 실패하는 테스트 둘**

```ts
// apps/web/src/shared/passkey/cose.test.ts
import { describe, expect, it } from 'vitest';
import { encodeCbor, toBase64Url } from '@monti/shared/encoding';
import { parseAttestationPublicKey } from './cose';

function buildAttestation(x: Uint8Array, y: Uint8Array): string {
  const credentialId = new Uint8Array(16).fill(0x7a);
  // COSE_Key for ES256: kty 2, alg -7, crv 1, x -2, y -3
  const cose = encodeCbor(new Map<number, unknown>([[1, 2], [3, -7], [-1, 1], [-2, x], [-3, y]]));
  const authData = new Uint8Array(37 + 16 + 2 + credentialId.length + cose.length);
  authData[32] = 0x45;                       // flags: UP | AT
  authData.set([0x00, credentialId.length], 53);
  authData.set(credentialId, 55);
  authData.set(cose, 55 + credentialId.length);
  return toBase64Url(encodeCbor({ fmt: 'none', attStmt: {}, authData }));
}

describe('parseAttestationPublicKey', () => {
  it('extracts the uncompressed P-256 point from a WebAuthn attestation object', () => {
    const x = new Uint8Array(32).fill(0x11);
    const y = new Uint8Array(32).fill(0x22);
    expect(parseAttestationPublicKey(buildAttestation(x, y)))
      .toBe(`0x04${'11'.repeat(32)}${'22'.repeat(32)}`);
  });

  it('rejects an attestation without the attested-credential-data flag', () => {
    const broken = toBase64Url(encodeCbor({ fmt: 'none', attStmt: {}, authData: new Uint8Array(37) }));
    expect(() => parseAttestationPublicKey(broken)).toThrow('no attested credential data');
  });
});
```

```ts
// apps/web/src/shared/passkey/passkey.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config', () => ({ getConfig: () => ({ rpId: 'monti.app' }) }));
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => false } }));

const createCredential = vi.fn(async () => ({
  id: 'Y3JlZC1pZA',
  publicKey: { prefix: 4, x: 0x11n, y: 0x22n },
  raw: { id: 'Y3JlZC1pZA', response: { clientDataJSON: 'e30', attestationObject: 'o2M' }, type: 'public-key' },
}));
vi.mock('ox/WebAuthnP256', () => ({ createCredential }));

const { createPasskey, storedCredential, clearCredential } = await import('./index');

beforeEach(() => clearCredential());

describe('createPasskey (web)', () => {
  it('asks for a resident key with user verification and stores what registerPasskey needs', async () => {
    const credential = await createPasskey('MONTI');
    const options = createCredential.mock.calls[0]![0] as {
      rp: { id: string }; authenticatorSelection: { residentKey: string; userVerification: string };
    };
    expect(options.rp.id).toBe('monti.app');
    expect(options.authenticatorSelection).toMatchObject({ residentKey: 'required', userVerification: 'required' });
    expect(credential.id).toBe('Y3JlZC1pZA');
    // 0x04 || x(32) || y(32) — the uncompressed point viem hands to toCoinbaseSmartAccount.
    expect(credential.publicKey).toMatch(/^0x04[0-9a-f]{128}$/);
    expect(JSON.parse(credential.attestationJson).type).toBe('public-key');
    expect(storedCredential()?.id).toBe('Y3JlZC1pZA');
  });
});
```

- [ ] **Step 3: 실패 확인**

Run (from `apps/web/`): `pnpm vitest run src/shared/passkey`
Expected: FAIL — `Failed to resolve import "./cose"`, `"./index"`.

- [ ] **Step 4: 타입, 저장소, COSE 파서**

```ts
// apps/web/src/shared/passkey/types.ts
import type { Hex } from '@monti/shared';

export interface WebAuthnCredential {
  id: string;
  /** Uncompressed P-256 point, 0x04 || x || y. */
  publicKey: Hex;
  transports: string[];
  /** Serialized WebAuthn registration response, forwarded verbatim to registerPasskey. */
  attestationJson: string;
}

const STORAGE_KEY = 'monti.passkey';

export function storeCredential(credential: WebAuthnCredential): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(credential));
}

export function storedCredential(): WebAuthnCredential | null {
  const raw = localStorage.getItem(STORAGE_KEY);
  return raw ? (JSON.parse(raw) as WebAuthnCredential) : null;
}

export function clearCredential(): void {
  localStorage.removeItem(STORAGE_KEY);
}
```

```ts
// apps/web/src/shared/passkey/cose.ts
import { decodeCbor, fromBase64Url } from '@monti/shared/encoding';
import type { Hex } from '@monti/shared';

const FLAG_ATTESTED_CREDENTIAL_DATA = 0x40;

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

/**
 * WebAuthn attestationObject → uncompressed P-256 public key.
 * authData = rpIdHash(32) | flags(1) | signCount(4) | aaguid(16) | credIdLen(2) | credId | COSE key
 */
export function parseAttestationPublicKey(attestationObjectB64Url: string): Hex {
  const attestation = decodeCbor<{ authData: Uint8Array }>(fromBase64Url(attestationObjectB64Url));
  const authData = attestation.authData;
  const flags = authData[32];
  if (flags === undefined || (flags & FLAG_ATTESTED_CREDENTIAL_DATA) === 0) {
    throw new Error('Attestation has no attested credential data');
  }
  const credentialIdLength = (authData[53]! << 8) | authData[54]!;
  const coseStart = 55 + credentialIdLength;
  // cborg returns a plain object for CBOR maps by default and a Map when useMaps is on; accept both.
  const cose = decodeCbor<unknown>(authData.slice(coseStart));
  const read = (label: number): Uint8Array | undefined =>
    cose instanceof Map
      ? (cose.get(label) as Uint8Array | undefined)
      : ((cose as Record<string, Uint8Array>)[String(label)]);
  const x = read(-2);
  const y = read(-3);
  if (!x || !y || x.length !== 32 || y.length !== 32) throw new Error('Attestation is not an ES256 key');
  return `0x04${toHex(x)}${toHex(y)}` as Hex;
}
```

- [ ] **Step 5: 어댑터, 웹 경로, 네이티브 경로**

```ts
// apps/web/src/shared/passkey/plugin.ts
// ONLY file that touches @capgo/capacitor-passkey. Shapes checked against
// node_modules/@capgo/capacitor-passkey/dist/esm/definitions.d.ts in Step 1.
import { CapacitorPasskey } from '@capgo/capacitor-passkey';

export interface NativeRegistrationResponse {
  id: string;
  rawId: string;
  type: string;
  response: { clientDataJSON: string; attestationObject: string };
}

export interface NativeAssertionResponse {
  id: string;
  rawId: string;
  type: string;
  response: { clientDataJSON: string; authenticatorData: string; signature: string; userHandle?: string };
}

export function createCredentialNative(options: {
  rp: { id: string; name: string };
  user: { id: string; name: string; displayName: string };
  challenge: string;
  pubKeyCredParams: Array<{ type: 'public-key'; alg: number }>;
  authenticatorSelection: { residentKey: 'required'; userVerification: 'required' };
}): Promise<NativeRegistrationResponse> {
  return CapacitorPasskey.createCredential(options);
}

export function getCredentialNative(options: {
  rpId: string;
  challenge: string;
  userVerification: 'required';
  allowCredentials?: Array<{ type: 'public-key'; id: string }>;
}): Promise<NativeAssertionResponse> {
  return CapacitorPasskey.getCredential(options);
}
```

```ts
// apps/web/src/shared/passkey/web.ts
import * as PublicKey from 'ox/PublicKey';
import * as WebAuthnP256 from 'ox/WebAuthnP256';
import type { Hex } from '@monti/shared';
import { getConfig } from '../config';
import { storeCredential, type WebAuthnCredential } from './types';

export async function createPasskeyWeb(name: string): Promise<WebAuthnCredential> {
  const created = await WebAuthnP256.createCredential({
    name,
    rp: { id: getConfig().rpId, name: 'MONTI' },
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
  });
  const credential: WebAuthnCredential = {
    id: created.id,
    publicKey: PublicKey.toHex(created.publicKey) as Hex,
    transports: ['internal', 'hybrid'],
    attestationJson: JSON.stringify(created.raw),
  };
  storeCredential(credential);
  return credential;
}

/** Browser assertion path handed to viem's toWebAuthnAccount. */
export function getFnWeb(options?: CredentialRequestOptions): Promise<Credential | null> {
  return navigator.credentials.get(options);
}
```

```ts
// apps/web/src/shared/passkey/native.ts
import { fromBase64Url, toBase64Url } from '@monti/shared/encoding';
import { getConfig } from '../config';
import { createCredentialNative, getCredentialNative } from './plugin';
import { parseAttestationPublicKey } from './cose';
import { storeCredential, type WebAuthnCredential } from './types';

function randomChallenge(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function createPasskeyNative(name: string): Promise<WebAuthnCredential> {
  const registration = await createCredentialNative({
    rp: { id: getConfig().rpId, name: 'MONTI' },
    user: { id: randomChallenge(), name, displayName: name },
    challenge: randomChallenge(),
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
  });
  const credential: WebAuthnCredential = {
    id: registration.id,
    publicKey: parseAttestationPublicKey(registration.response.attestationObject),
    transports: ['internal'],
    attestationJson: JSON.stringify(registration),
  };
  storeCredential(credential);
  return credential;
}

/** Native assertion shaped like navigator.credentials.get for viem. */
export async function getFnNative(options?: CredentialRequestOptions): Promise<Credential> {
  const request = options?.publicKey;
  const challenge = request?.challenge instanceof ArrayBuffer
    ? toBase64Url(new Uint8Array(request.challenge))
    : toBase64Url(new Uint8Array((request?.challenge as ArrayBufferView | undefined)?.buffer ?? new ArrayBuffer(0)));
  const assertion = await getCredentialNative({
    rpId: getConfig().rpId,
    challenge,
    userVerification: 'required',
    allowCredentials: (request?.allowCredentials ?? []).map((entry) => ({
      type: 'public-key',
      id: toBase64Url(new Uint8Array(entry.id as ArrayBuffer)),
    })),
  });
  const credential = {
    id: assertion.id,
    rawId: fromBase64Url(assertion.rawId).buffer,
    type: 'public-key',
    response: {
      clientDataJSON: fromBase64Url(assertion.response.clientDataJSON).buffer,
      authenticatorData: fromBase64Url(assertion.response.authenticatorData).buffer,
      signature: fromBase64Url(assertion.response.signature).buffer,
      userHandle: assertion.response.userHandle ? fromBase64Url(assertion.response.userHandle).buffer : null,
    },
  };
  return credential as unknown as Credential;
}
```

- [ ] **Step 6: 분기와 계정 헬퍼**

```ts
// apps/web/src/shared/passkey/index.ts
import { Capacitor } from '@capacitor/core';
import { toWebAuthnAccount, type WebAuthnAccount } from 'viem/account-abstraction';
import { getConfig } from '../config';
import { createPasskeyWeb, getFnWeb } from './web';
import { createPasskeyNative, getFnNative } from './native';
import { storedCredential, type WebAuthnCredential } from './types';

export * from './types';
export { parseAttestationPublicKey } from './cose';

export async function createPasskey(name: string): Promise<WebAuthnCredential> {
  return Capacitor.isNativePlatform() ? createPasskeyNative(name) : createPasskeyWeb(name);
}

export async function getPasskeyAccount(): Promise<WebAuthnAccount> {
  const credential = storedCredential();
  if (!credential) throw new Error('No passkey on this device');
  return toWebAuthnAccount({
    credential: { id: credential.id, publicKey: credential.publicKey },
    getFn: Capacitor.isNativePlatform() ? getFnNative : getFnWeb,
    rpId: getConfig().rpId,
  });
}
```

```ts
// apps/web/src/shared/chain/accounts.ts
import type { SmartAccount } from 'viem/account-abstraction';
import { getPasskeyAccount } from '../passkey';
import { getSmartAccount, setSmartAccount } from './bundler';

/** The signed-in attendee's own passkey smart account; also primes the module cache. */
export async function getAttendeeAccount(): Promise<SmartAccount> {
  const account = await getSmartAccount(await getPasskeyAccount());
  setSmartAccount(account);
  return account;
}

/**
 * The signed-in staff member's own passkey smart account, used by sub-plan 04 for
 * requestOverride / manualOverride. It is NOT the gate device account, which 04 derives
 * from the gate hardware key under GATE_KEY_ALIAS and never signs with a passkey.
 */
export async function getStaffAccount(): Promise<SmartAccount> {
  return getAttendeeAccount();
}
```

- [ ] **Step 7: 테스트 통과 확인과 커밋**

Run (from `apps/web/`): `pnpm vitest run src/shared/passkey`
Expected: PASS — `Test Files  2 passed (2)`, `Tests  3 passed (3)`.

Run (from `apps/web/`): `pnpm typecheck`
Expected: 출력 없음. `plugin.ts`에서 타입 에러가 나면 **Step 1에서 읽은 정의에 맞춰 `plugin.ts`만** 고친다 — 캐스트로 덮지 않는다.

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI
git add apps/web/src/shared/passkey apps/web/src/shared/chain/accounts.ts
git commit -m "feat(web): add passkey create/assert for web and native with cose parsing and account helpers"
```

---

## Task 13: `shared/deviceKey/` — 보안 칩 P-256 키

**Files:**
- Create: `apps/web/src/shared/deviceKey/types.ts`, `plugin.ts`, `native.ts`, `web.ts`, `index.ts`
- Test: `apps/web/src/shared/deviceKey/deviceKey.test.ts`

**Interfaces:**
- Consumes: `derToCompactSignature`, `spkiToXy`, `fromBase64Url` (`@monti/shared/encoding`).
- Produces: `class DeviceKeyUnavailable extends Error`, `ATTENDEE_KEY_ALIAS = 'monti-attendee'`, `GATE_KEY_ALIAS = 'monti-gate'`, `ensureDeviceKey({ alias, requireAuth, strongBox }): Promise<{ x: Hex; y: Hex }>`, `armDeviceKey({ alias }): Promise<void>`, `signWithDeviceKey(digest: Hex, { alias }): Promise<{ r: Hex; s: Hex }>`, `deviceKeyCapability(): 'native' | 'none'`, `ARM_WINDOW_SECONDS = 60`. **sub-plan 04가 게이트 키를 `{ alias: GATE_KEY_ALIAS, requireAuth: false, strongBox: true }`로 만든다.** `signWithDeviceKey`는 받은 32바이트 다이제스트를 **다시 해싱하지 않고 그대로 서명한다**(iOS `.ecdsaSignatureDigestX962SHA256`, Android `NONEwithECDSA`).

**플러그인 실측 결과가 이 태스크의 전제를 바꾼다.** 사전 점검에서 `@perfood/capacitor-crypto-api@8.0.0`의 공개 타입을 읽어 보면 표면은 `CryptoApi.generateKey({ tag, algorithm })`, `loadKey({ tag, algorithm })`, `sign({ tag, data })` 뿐이고 **접근 제어(생체 요구)나 StrongBox 스위치가 아예 없다.** 즉 Global Constraints가 요구하는 `kSecAttrTokenIDSecureEnclave + biometryCurrentSet`, `setUserAuthenticationParameters(60, BIOMETRIC_STRONG)`, `setIsStrongBoxBacked(true)`를 이 플러그인으로는 표현할 수 없다. 그래서 `plugin.ts`는 **백엔드 전환 지점**이 되고, `PLUGIN_SUPPORTS_ACCESS_CONTROL = false`인 백엔드에 `requireAuth: true`를 요구하면 `DeviceKeyPolicyUnsupported`로 즉시 실패한다. 관객 키는 `requireAuth: true`이므로 **Task 14(자체 플러그인)가 사실상 필수**다 — 스파이크 S3가 반대 결과를 내면 그때 백엔드를 되돌린다.

**웹 관객은 NFC 대신 QR 경로를 쓴다.** 웹에는 동기화되지 않는 하드웨어 키를 만들 방법이 없으므로 `web.ts`는 세 함수 모두 `DeviceKeyUnavailable`을 던지고, 호출부는 그 에러를 잡아 `copy.enter.deviceUnavailable`을 띄운다. iOS 사파리 관객은 이 경로로 들어온다.

- [ ] **Step 1: 실패하는 테스트**

```ts
// apps/web/src/shared/deviceKey/deviceKey.test.ts
import { describe, expect, it, vi } from 'vitest';

const generateKey = vi.fn();
const sign = vi.fn();
const loadKey = vi.fn(async () => { throw new Error('missing'); });
vi.mock('./plugin', () => ({ generateKey, sign, loadKey, PLUGIN_SUPPORTS_ACCESS_CONTROL: true }));
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => true } }));

import { toBase64Url } from '@monti/shared/encoding';

const { ensureDeviceKey, signWithDeviceKey, armDeviceKey, ARM_WINDOW_SECONDS, ATTENDEE_KEY_ALIAS, GATE_KEY_ALIAS } =
  await import('./index');

const hex = (h: string) => Uint8Array.from(h.match(/.{1,2}/g)!.map((b) => Number.parseInt(b, 16)));
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const SPKI_B64 = b64(hex(`3059301306072a8648ce3d020106082a8648ce3d03010703420004${'11'.repeat(32)}${'22'.repeat(32)}`));
const DER_B64 = b64(hex(`3026020107022100${'ff'.repeat(32)}`));

describe('device key', () => {
  it('creates the attendee key with auth required and returns x, y', async () => {
    generateKey.mockResolvedValueOnce({ publicKey: SPKI_B64 });
    await expect(ensureDeviceKey({ alias: ATTENDEE_KEY_ALIAS, requireAuth: true, strongBox: true }))
      .resolves.toEqual({ x: `0x${'11'.repeat(32)}`, y: `0x${'22'.repeat(32)}` });
    expect(generateKey).toHaveBeenCalledWith({ alias: 'monti-attendee', requireAuth: true, strongBox: true });
  });

  it('creates the gate key without an auth requirement', async () => {
    generateKey.mockResolvedValueOnce({ publicKey: SPKI_B64 });
    await ensureDeviceKey({ alias: GATE_KEY_ALIAS, requireAuth: false, strongBox: true });
    expect(generateKey).toHaveBeenCalledWith({ alias: 'monti-gate', requireAuth: false, strongBox: true });
  });

  it('signs the digest raw — the exact 32 bytes, never re-hashed', async () => {
    sign.mockResolvedValueOnce({ signature: DER_B64 });
    const digestBytes = new Uint8Array(32).fill(0xab);
    const digest = `0x${'ab'.repeat(32)}` as const;
    await expect(signWithDeviceKey(digest, { alias: ATTENDEE_KEY_ALIAS })).resolves.toEqual({
      r: `0x${'00'.repeat(31)}07`, s: `0x${'ff'.repeat(32)}`,
    });
    const sent = sign.mock.calls[0]![0] as { alias: string; data: string };
    expect(sent.alias).toBe('monti-attendee');
    // This is the safety-critical invariant: Ticket.checkIn verifies P256 over this digest.
    expect(sent.data).toBe(toBase64Url(digestBytes));
  });

  it('refuses to mint a biometric key on a backend that cannot enforce it', async () => {
    const { ensureDeviceKeyNative } = await import('./native');
    vi.doMock('./plugin', () => ({ generateKey, sign, loadKey, PLUGIN_SUPPORTS_ACCESS_CONTROL: false }));
    vi.resetModules();
    const { ensureDeviceKeyNative: guarded } = await import('./native');
    await expect(guarded({ alias: ATTENDEE_KEY_ALIAS, requireAuth: true, strongBox: true }))
      .rejects.toThrow('DeviceKeyPolicyUnsupported');
    expect(ensureDeviceKeyNative).toBeTypeOf('function');
    vi.doUnmock('./plugin');
    vi.resetModules();
  });

  it('arms by signing a throwaway digest so the biometric context is retained for 60s', async () => {
    sign.mockResolvedValueOnce({ signature: DER_B64 });
    await armDeviceKey({ alias: ATTENDEE_KEY_ALIAS });
    expect(sign).toHaveBeenCalled();
    expect(ARM_WINDOW_SECONDS).toBe(60);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run (from `apps/web/`): `pnpm vitest run src/shared/deviceKey/deviceKey.test.ts`
Expected: FAIL — `Failed to resolve import "./index"`.

- [ ] **Step 3: 어댑터와 네이티브 구현**

```ts
// apps/web/src/shared/deviceKey/plugin.ts
// ONLY file that touches a native crypto plugin. Backend switch lives here.
//
// @perfood/capacitor-crypto-api@8.0.0 surface (read in Step 1):
//   CryptoApi.generateKey({ tag, algorithm: 'ecdsa' | 'ecdh', type? }) -> { publicKey }
//   CryptoApi.loadKey({ tag, algorithm })                              -> { publicKey }
//   CryptoApi.sign({ tag, data, type? })                               -> { signature }
// There is NO access-control and NO StrongBox option, so it cannot express the
// Secure Enclave / biometric / StrongBox requirements in the Global Constraints.
import { CryptoApi } from '@perfood/capacitor-crypto-api';

/** Flip to true only with a backend that can enforce biometric access control (Task 14). */
export const PLUGIN_SUPPORTS_ACCESS_CONTROL = false;

export interface KeyOptions { alias: string; requireAuth: boolean; strongBox: boolean }

export function generateKey(options: KeyOptions): Promise<{ publicKey: string }> {
  return CryptoApi.generateKey({ tag: options.alias, algorithm: 'ecdsa' });
}

export function loadKey(options: { alias: string }): Promise<{ publicKey: string }> {
  return CryptoApi.loadKey({ tag: options.alias, algorithm: 'ecdsa' });
}

export function sign(options: { alias: string; data: string }): Promise<{ signature: string }> {
  return CryptoApi.sign({ tag: options.alias, data: options.data });
}
```

```ts
// apps/web/src/shared/deviceKey/types.ts
import type { Hex } from '@monti/shared';

export class DeviceKeyUnavailable extends Error {
  constructor() {
    super('DeviceKeyUnavailable');
    this.name = 'DeviceKeyUnavailable';
  }
}

/** The active native backend cannot enforce `requireAuth`, so the key would be unprotected. */
export class DeviceKeyPolicyUnsupported extends Error {
  constructor(readonly alias: string) {
    super(`DeviceKeyPolicyUnsupported: backend cannot enforce biometric access control for ${alias}`);
    this.name = 'DeviceKeyPolicyUnsupported';
  }
}

export interface DeviceKeyPublic { x: Hex; y: Hex }
export interface DeviceKeyOptions { alias: string; requireAuth: boolean; strongBox: boolean }

/** Attendee entry key: biometric-gated, never synced. */
export const ATTENDEE_KEY_ALIAS = 'monti-attendee';
/** Gate device key (sub-plan 04): no biometric prompt, the staff device signs unattended. */
export const GATE_KEY_ALIAS = 'monti-gate';
/** Spec 7.3: the biometric arming window is 60 seconds, enforced by the secure chip. */
export const ARM_WINDOW_SECONDS = 60;
```

```ts
// apps/web/src/shared/deviceKey/native.ts
import { derToCompactSignature, fromBase64Url, spkiToXy, toBase64Url } from '@monti/shared/encoding';
import type { Hex } from '@monti/shared';
import { PLUGIN_SUPPORTS_ACCESS_CONTROL, generateKey, loadKey, sign } from './plugin';
import { DeviceKeyPolicyUnsupported, type DeviceKeyOptions, type DeviceKeyPublic } from './types';

const ARM_DIGEST = toBase64Url(new Uint8Array(32).fill(0x6d)); // constant, never leaves the device

function hexToBase64Url(hex: Hex): string {
  return toBase64Url(Uint8Array.from((hex.slice(2).match(/.{1,2}/g) ?? []).map((b) => Number.parseInt(b, 16))));
}

export async function ensureDeviceKeyNative(options: DeviceKeyOptions): Promise<DeviceKeyPublic> {
  // Never create a key that claims biometric protection the backend cannot enforce.
  if (options.requireAuth && !PLUGIN_SUPPORTS_ACCESS_CONTROL) {
    throw new DeviceKeyPolicyUnsupported(options.alias);
  }
  let spki: string;
  try {
    spki = (await loadKey({ alias: options.alias })).publicKey;
  } catch {
    spki = (await generateKey(options)).publicKey;
  }
  return spkiToXy(fromBase64Url(spki));
}

/** Triggers Face ID / fingerprint once; the chip keeps the key usable for 60 s. */
export async function armDeviceKeyNative(options: { alias: string }): Promise<void> {
  await sign({ alias: options.alias, data: ARM_DIGEST });
}

/** Signs the 32-byte digest as-is. The plugin must not hash it again. */
export async function signWithDeviceKeyNative(digest: Hex, options: { alias: string }): Promise<{ r: Hex; s: Hex }> {
  const { signature } = await sign({ alias: options.alias, data: hexToBase64Url(digest) });
  return derToCompactSignature(fromBase64Url(signature));
}
```

- [ ] **Step 4: 웹 폴백과 분기**

```ts
// apps/web/src/shared/deviceKey/web.ts
import { DeviceKeyUnavailable } from './types';

/** The web has no non-syncing hardware key. Attendees on a browser use the QR path. */
export async function ensureDeviceKeyWeb(): Promise<never> { throw new DeviceKeyUnavailable(); }
export async function armDeviceKeyWeb(): Promise<never> { throw new DeviceKeyUnavailable(); }
export async function signWithDeviceKeyWeb(): Promise<never> { throw new DeviceKeyUnavailable(); }
```

```ts
// apps/web/src/shared/deviceKey/index.ts
import { Capacitor } from '@capacitor/core';
import type { Hex } from '@monti/shared';
import { armDeviceKeyNative, ensureDeviceKeyNative, signWithDeviceKeyNative } from './native';
import { armDeviceKeyWeb, ensureDeviceKeyWeb, signWithDeviceKeyWeb } from './web';
import type { DeviceKeyOptions, DeviceKeyPublic } from './types';

export * from './types';

export function deviceKeyCapability(): 'native' | 'none' {
  return Capacitor.isNativePlatform() ? 'native' : 'none';
}

export async function ensureDeviceKey(options: DeviceKeyOptions): Promise<DeviceKeyPublic> {
  return deviceKeyCapability() === 'native' ? ensureDeviceKeyNative(options) : ensureDeviceKeyWeb();
}

export async function armDeviceKey(options: { alias: string }): Promise<void> {
  return deviceKeyCapability() === 'native' ? armDeviceKeyNative(options) : armDeviceKeyWeb();
}

export async function signWithDeviceKey(digest: Hex, options: { alias: string }): Promise<{ r: Hex; s: Hex }> {
  return deviceKeyCapability() === 'native' ? signWithDeviceKeyNative(digest, options) : signWithDeviceKeyWeb();
}
```

- [ ] **Step 5: 테스트 통과 확인과 플러그인 시그니처 검증**

Run (from `apps/web/`): `pnpm vitest run src/shared/deviceKey/deviceKey.test.ts`
Expected: PASS — `Tests  5 passed (5)`.

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/apps/web
cat node_modules/@perfood/capacitor-crypto-api/dist/esm/definitions.d.ts
cat node_modules/@perfood/capacitor-crypto-api/dist/esm/index.d.ts
```
Expected: export 이름이 `CryptoApi` 이고 `generateKey`가 **필수** `algorithm`을 받는다. **접근 제어/StrongBox 옵션이 보이면** `plugin.ts`의 `PLUGIN_SUPPORTS_ACCESS_CONTROL`을 `true`로 올리고 `generateKey`에 그 옵션을 넘긴 뒤 Task 14를 건너뛴다. 보이지 않으면(예상되는 결과) **Task 14를 반드시 실행한다** — 그 전까지 관객 기기 키 생성은 `DeviceKeyPolicyUnsupported`로 막힌다.

- [ ] **Step 6: 커밋**

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI
git add apps/web/src/shared/deviceKey
git commit -m "feat(web): add hardware device key wrapper with web unavailable fallback"
```

---

## Task 14: 자체 기기 키 플러그인 스켈레톤 — **스파이크 S3가 실패했을 때만**

**Files:**
- Create: `plugins/device-key/package.json`, `plugins/device-key/ios/Sources/DeviceKeyPlugin.swift`, `plugins/device-key/android/src/main/java/app/monti/devicekey/DeviceKeyPlugin.kt`
- Modify: `apps/web/src/shared/deviceKey/plugin.ts` (import만 교체)

**Interfaces:**
- Consumes: 없음.
- Produces: Capacitor 플러그인 `DeviceKey`, 메서드 `generateKey({tag, accessControl, strongBox}) -> {publicKey}`, `loadKey({tag}) -> {publicKey}`, `sign({tag, data}) -> {signature}`. **Task 13의 `plugin.ts`가 기대하는 것과 이름·필드가 동일**하므로 교체는 import 한 줄이다. 두 구현 모두 주어진 다이제스트를 재해싱하지 않는다.

> **이 태스크는 사실상 필수다.** `@perfood/capacitor-crypto-api@8.0.0`에는 접근 제어·StrongBox 스위치가 없어(Task 13 Step 5에서 실물 타입으로 확인) Global Constraints의 Secure Enclave·생체 60초·StrongBox 요구를 표현할 방법이 없다. 스파이크 S3가 그 반대를 입증한 경우에만 건너뛴다.

- [ ] **Step 1: 스파이크 결과와 플러그인 표면 확인**

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI
grep -A3 "S3" docs/superpowers/plans/spikes.md || echo "no spike record"
grep -c "accessControl\|biometry\|strongBox" apps/web/node_modules/@perfood/capacitor-crypto-api/dist/esm/definitions.d.ts || true
```
Expected: 두 번째 명령이 `0` — 접근 제어 옵션이 없다는 뜻이고, 이 태스크를 실행한다. `0`이 아니고 S3가 `Go` 면 건너뛴다.

- [ ] **Step 2: 플러그인 패키지 골격**

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI
mkdir -p plugins/device-key/ios/Sources plugins/device-key/android/src/main/java/app/monti/devicekey
cat > plugins/device-key/package.json <<'EOF'
{
  "name": "@monti/device-key",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "files": ["dist", "ios", "android", "MontiDeviceKey.podspec"],
  "scripts": { "build": "tsc -p tsconfig.json" },
  "capacitor": { "ios": { "src": "ios" }, "android": { "src": "android" } },
  "peerDependencies": { "@capacitor/core": "^8.0.0" },
  "devDependencies": { "@capacitor/core": "8.5.2", "typescript": "5.9.2" }
}
EOF
cat > plugins/device-key/tsconfig.json <<'EOF'
{
  "compilerOptions": {
    "target": "ES2022", "module": "ESNext", "moduleResolution": "bundler",
    "declaration": true, "outDir": "dist", "rootDir": "src", "strict": true, "skipLibCheck": true
  },
  "include": ["src"]
}
EOF
mkdir -p plugins/device-key/src
cat > plugins/device-key/src/definitions.ts <<'EOF'
export interface GenerateKeyOptions { tag: string; requireAuth: boolean; strongBox: boolean }
export interface LoadKeyOptions { tag: string }
export interface SignOptions { tag: string; data: string }

export interface DeviceKeyPlugin {
  /** Creates a hardware P-256 key. requireAuth -> biometric access control; strongBox -> StrongBox first. */
  generateKey(options: GenerateKeyOptions): Promise<{ publicKey: string; backing: 'strongbox' | 'tee' | 'secure-enclave' }>;
  loadKey(options: LoadKeyOptions): Promise<{ publicKey: string }>;
  /** Signs the base64url digest RAW. Never hashes again. */
  sign(options: SignOptions): Promise<{ signature: string }>;
}
EOF
cat > plugins/device-key/src/index.ts <<'EOF'
import { registerPlugin } from '@capacitor/core';
import type { DeviceKeyPlugin } from './definitions';

export * from './definitions';
export const DeviceKey = registerPlugin<DeviceKeyPlugin>('DeviceKey');
EOF
cat > plugins/device-key/MontiDeviceKey.podspec <<'EOF'
Pod::Spec.new do |s|
  s.name = 'MontiDeviceKey'
  s.version = '0.1.0'
  s.summary = 'MONTI hardware device key'
  s.license = 'MIT'
  s.homepage = 'https://monti.app'
  s.author = 'MONTI'
  s.source = { :git => 'https://monti.app', :tag => s.version.to_s }
  s.source_files = 'ios/Sources/**/*.{swift,h,m}'
  s.ios.deployment_target = '16.0'
  s.dependency 'Capacitor'
  s.swift_version = '5.9'
end
EOF
node -e "const fs=require('fs');const y=fs.readFileSync('pnpm-workspace.yaml','utf8');if(!y.includes('plugins/*'))fs.writeFileSync('pnpm-workspace.yaml',y.trimEnd()+'\n  - plugins/*\n')"
pnpm install && pnpm -C plugins/device-key build
```
Expected: `plugins/device-key/dist/index.js` 가 생긴다.

- [ ] **Step 3: iOS — Secure Enclave + 60초 유지되는 `LAContext`**

```swift
// plugins/device-key/ios/Sources/DeviceKeyPlugin.swift
import Capacitor
import Foundation
import LocalAuthentication
import Security

@objc(DeviceKeyPlugin)
public class DeviceKeyPlugin: CAPPlugin, CAPBridgedPlugin {
  public let identifier = "DeviceKeyPlugin"
  public let jsName = "DeviceKey"
  public let pluginMethods: [CAPPluginMethod] = [
    CAPPluginMethod(name: "generateKey", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "loadKey", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "sign", returnType: CAPPluginReturnPromise),
  ]

  /// Retained authenticated context. The Secure Enclave honours it for 60 s,
  /// so the second sign inside the arming window does not prompt again.
  static let armWindowSeconds: TimeInterval = 60
  private var context: LAContext?
  private var contextCreatedAt: Date?

  private func authenticatedContext() -> LAContext {
    if let existing = context, let created = contextCreatedAt,
       Date().timeIntervalSince(created) < DeviceKeyPlugin.armWindowSeconds {
      return existing
    }
    let fresh = LAContext()
    // Matches ARM_WINDOW_SECONDS in shared/deviceKey/types.ts.
    fresh.touchIDAuthenticationAllowableReuseDuration = DeviceKeyPlugin.armWindowSeconds
    context = fresh
    contextCreatedAt = Date()
    return fresh
  }

  private func keyTag(_ tag: String) -> Data { tag.data(using: .utf8)! }

  @objc func generateKey(_ call: CAPPluginCall) {
    guard let tag = call.getString("tag") else { return call.reject("tag required") }
    // requireAuth true  -> attendee key: Face ID gated, invalidated when biometrics change.
    // requireAuth false -> gate terminal key: unattended, must never prompt.
    let requireAuth = call.getBool("requireAuth") ?? true
    let flags: SecAccessControlCreateFlags = requireAuth ? [.privateKeyUsage, .biometryCurrentSet] : [.privateKeyUsage]
    var error: Unmanaged<CFError>?
    guard let access = SecAccessControlCreateWithFlags(
      nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly, flags, &error) else {
      return call.reject("access control failed")
    }
    let attributes: [String: Any] = [
      kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
      kSecAttrKeySizeInBits as String: 256,
      kSecAttrTokenID as String: kSecAttrTokenIDSecureEnclave,
      kSecPrivateKeyAttrs as String: [
        kSecAttrIsPermanent as String: true,
        kSecAttrApplicationTag as String: keyTag(tag),
        kSecAttrAccessControl as String: access,
      ],
    ]
    guard let privateKey = SecKeyCreateRandomKey(attributes as CFDictionary, &error),
          let publicKey = SecKeyCopyPublicKey(privateKey),
          let spki = SecKeyCopyExternalRepresentation(publicKey, &error) as Data? else {
      return call.reject("key generation failed")
    }
    // The Secure Enclave is the only backing on iOS; strongBox is an Android-only hint.
    call.resolve(["publicKey": spki.base64EncodedString(), "backing": "secure-enclave"])
  }

  @objc func loadKey(_ call: CAPPluginCall) {
    guard let tag = call.getString("tag"), let key = findKey(tag),
          let publicKey = SecKeyCopyPublicKey(key),
          let spki = SecKeyCopyExternalRepresentation(publicKey, nil) as Data? else {
      return call.reject("key not found")
    }
    call.resolve(["publicKey": spki.base64EncodedString()])
  }

  @objc func sign(_ call: CAPPluginCall) {
    guard let tag = call.getString("tag"), let dataB64 = call.getString("data") else {
      return call.reject("tag and data required")
    }
    // base64url -> base64, restoring the padding the JS side strips.
    var normalised = dataB64.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    normalised += String(repeating: "=", count: (4 - normalised.count % 4) % 4)
    guard let digest = Data(base64Encoded: normalised), let key = findKey(tag) else {
      return call.reject("sign failed")
    }
    var error: Unmanaged<CFError>?
    guard let signature = SecKeyCreateSignature(key, .ecdsaSignatureDigestX962SHA256, digest as CFData, &error) as Data? else {
      return call.reject("sign failed: \(error.debugDescription)")
    }
    call.resolve(["signature": signature.base64EncodedString()])
  }

  private func findKey(_ tag: String) -> SecKey? {
    let query: [String: Any] = [
      kSecClass as String: kSecClassKey,
      kSecAttrApplicationTag as String: keyTag(tag),
      kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
      kSecReturnRef as String: true,
      kSecUseAuthenticationContext as String: authenticatedContext(),
    ]
    var item: CFTypeRef?
    return SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess ? (item as! SecKey) : nil
  }
}
```

- [ ] **Step 4: Android — StrongBox 시도 후 TEE 폴백**

```kotlin
// plugins/device-key/android/src/main/java/app/monti/devicekey/DeviceKeyPlugin.kt
package app.monti.devicekey

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.Signature

@CapacitorPlugin(name = "DeviceKey")
class DeviceKeyPlugin : Plugin() {
  private val keyStore: KeyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

  companion object { const val ARM_WINDOW_SECONDS = 60 }

  private fun spec(tag: String, requireAuth: Boolean, strongBox: Boolean) =
    KeyGenParameterSpec.Builder(tag, KeyProperties.PURPOSE_SIGN)
      .setAlgorithmParameterSpec(java.security.spec.ECGenParameterSpec("secp256r1"))
      .setDigests(KeyProperties.DIGEST_SHA256)
      .apply {
        if (requireAuth) {
          setUserAuthenticationRequired(true)
          // 60 s window, strong biometrics only — mirrors the iOS retained LAContext.
          setUserAuthenticationParameters(ARM_WINDOW_SECONDS, KeyProperties.AUTH_BIOMETRIC_STRONG)
          setInvalidatedByBiometricEnrollment(true)
        } else {
          // Gate terminal key: signs unattended, must never raise a biometric prompt.
          setUserAuthenticationRequired(false)
        }
      }
      .setIsStrongBoxBacked(strongBox)
      .build()

  @PluginMethod
  fun generateKey(call: PluginCall) {
    val tag = call.getString("tag") ?: return call.reject("tag required")
    val requireAuth = call.getBoolean("requireAuth") ?: true
    val wantStrongBox = call.getBoolean("strongBox") ?: true
    val generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore")
    var backing = "tee"
    val pair = try {
      if (!wantStrongBox) throw IllegalStateException("strongbox not requested")
      generator.initialize(spec(tag, requireAuth, true))
      backing = "strongbox"
      generator.generateKeyPair()
    } catch (_: Exception) {
      generator.initialize(spec(tag, requireAuth, false))   // TEE fallback
      backing = "tee"
      generator.generateKeyPair()
    }
    call.resolve(
      com.getcapacitor.JSObject()
        .put("publicKey", Base64.encodeToString(pair.public.encoded, Base64.NO_WRAP))
        .put("backing", backing),
    )
  }

  @PluginMethod
  fun loadKey(call: PluginCall) {
    val tag = call.getString("tag") ?: return call.reject("tag required")
    val certificate = keyStore.getCertificate(tag) ?: return call.reject("key not found")
    call.resolve(com.getcapacitor.JSObject().put("publicKey", Base64.encodeToString(certificate.publicKey.encoded, Base64.NO_WRAP)))
  }

  @PluginMethod
  fun sign(call: PluginCall) {
    val tag = call.getString("tag") ?: return call.reject("tag required")
    val data = call.getString("data") ?: return call.reject("data required")
    val entry = keyStore.getEntry(tag, null) as? KeyStore.PrivateKeyEntry ?: return call.reject("key not found")
    // NONEwithECDSA signs the supplied 32 bytes as-is; the digest must not be hashed twice.
    val signature = Signature.getInstance("NONEwithECDSA")
    signature.initSign(entry.privateKey)
    signature.update(Base64.decode(data, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING))
    call.resolve(com.getcapacitor.JSObject().put("signature", Base64.encodeToString(signature.sign(), Base64.NO_WRAP)))
  }
}
```

- [ ] **Step 5: 웹 쪽 교체는 import 한 줄**

`apps/web/src/shared/deviceKey/plugin.ts`를 새 백엔드로 돌린다. 메서드 이름과 필드를 같게 설계했으므로 바뀌는 것은 import 한 줄, 플래그 하나, `generateKey` 본문 한 줄이다:

```ts
// apps/web/src/shared/deviceKey/plugin.ts
import { DeviceKey } from '@monti/device-key';

/** The own plugin enforces biometric access control and StrongBox, so the guard opens. */
export const PLUGIN_SUPPORTS_ACCESS_CONTROL = true;

export interface KeyOptions { alias: string; requireAuth: boolean; strongBox: boolean }

export function generateKey(options: KeyOptions): Promise<{ publicKey: string }> {
  return DeviceKey.generateKey({ tag: options.alias, requireAuth: options.requireAuth, strongBox: options.strongBox });
}

export function loadKey(options: { alias: string }): Promise<{ publicKey: string }> {
  return DeviceKey.loadKey({ tag: options.alias });
}

export function sign(options: { alias: string; data: string }): Promise<{ signature: string }> {
  return DeviceKey.sign({ tag: options.alias, data: options.data });
}
```

`apps/web/package.json`의 `dependencies`에 `"@monti/device-key": "workspace:*"` 를 더하고 `pnpm install`, `npx cap sync` 한다.

- [ ] **Step 6: 확인과 커밋**

Run (from `apps/web/`): `pnpm vitest run src/shared/deviceKey/deviceKey.test.ts`
Expected: PASS — `Tests  5 passed (5)` (어댑터는 테스트에서 mock되므로 단언은 그대로지만, `PLUGIN_SUPPORTS_ACCESS_CONTROL: true` 경로가 이제 실제 백엔드와 일치한다).

Run (from repo root): `pnpm -C plugins/device-key build`
Expected: 에러 없음.

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI
git add plugins/device-key apps/web/src/shared/deviceKey/plugin.ts
git commit -m "feat(device-key): add own secure enclave and strongbox plugin (S3 fallback)"
```

---

## Task 15: `shared/nfc/` — NDEF 외부 레코드 읽기·쓰기와 QR 폴백

**Files:**
- Create: `apps/web/src/shared/nfc/records.ts`, `plugin.ts`, `native.ts`, `webnfc.ts`, `index.ts`
- Test: `apps/web/src/shared/nfc/records.test.ts`

**Interfaces:**
- Consumes: `encodeCbor`, `decodeCbor`, `toBase64Url`, `fromBase64Url` (`@monti/shared/encoding`), `GateCodeWire`, `GateResponseWire`.
- Produces: `GATE_CODE_RECORD_TYPE = 'monti.app:g'`, `GATE_RESPONSE_RECORD_TYPE = 'monti.app:s'`, `TNF_EXTERNAL = 4`, `QR_PREFIX = 'MONTI1:'`, `recordTypeBytes(type)`, `recordTypeMatches(bytes, type)`, `decodeGateCode(payload)`, `encodeGateResponse(wire)`, `gateResponseToQr(wire)`, `qrToGateResponse(text)`, `nfcCapability(): 'native' | 'webnfc' | 'none'`, `readGateCode(): Promise<GateCodeWire>`, `writeGateResponse(wire): Promise<void>`.

플러그인의 실제 표면은 `CapacitorNfc` 이고 `startScanning` / `stopScanning` / `write({ records })` 이며 **`NdefRecord.type`은 문자열이 아니라 바이트 배열**이다. 리스너 이름도 `ndefDiscovered` 다. `records.ts`가 문자열 ↔ 바이트 변환을 맡고 `plugin.ts`만 플러그인을 만진다. 캐스트는 쓰지 않는다.

- [ ] **Step 1: 고정 CBOR 벡터로 실패하는 테스트**

```ts
// apps/web/src/shared/nfc/records.test.ts
import { describe, expect, it } from 'vitest';
import type { GateCodeWire, GateResponseWire } from '@monti/shared';
import { encodeCbor } from '@monti/shared/encoding';
import {
  GATE_CODE_RECORD_TYPE, GATE_RESPONSE_RECORD_TYPE, QR_PREFIX, decodeGateCode, encodeGateResponse,
  gateResponseToQr, qrToGateResponse, recordTypeBytes, recordTypeMatches,
} from './records';

// cborg encodes object keys length-first, so this byte string is stable.
// { v:1, kx:"0xaa", ky:"0xbb", sig:"0xcc", nonce:"0x01", gateId:"7", eventId:"3", issuedAt:1790000000 }
const GATE_CODE_VECTOR_HEX =
  'a8' +
  '617601' +                            // "v": 1
  '626b78' + '6430786161' +             // "kx": "0xaa"
  '626b79' + '6430786262' +             // "ky": "0xbb"
  '63736967' + '6430786363' +           // "sig": "0xcc"
  '656e6f6e6365' + '6430783031' +       // "nonce": "0x01"
  '66676174654964' + '6137' +           // "gateId": "7"
  '676576656e744964' + '6133' +         // "eventId": "3"
  '686973737565644174' + '1a6ab13b80';  // "issuedAt": 1790000000

const bytes = Uint8Array.from(GATE_CODE_VECTOR_HEX.match(/.{1,2}/g)!.map((b) => Number.parseInt(b, 16)));

describe('nfc records', () => {
  it('decodes the fixed gate-code CBOR vector', () => {
    expect(decodeGateCode(bytes)).toEqual<GateCodeWire>({
      v: 1, gateId: '7', eventId: '3', issuedAt: 1790000000,
      nonce: '0x01', kx: '0xaa', ky: '0xbb', sig: '0xcc',
    });
  });

  it('rejects a payload whose version is not 1', () => {
    // Index 2 is the value byte of "v" (index 0 = map header, index 1-2 = key "v"… so build it instead).
    const wrong = encodeCbor({ v: 2, gateId: '7', eventId: '3', issuedAt: 1790000000,
      nonce: '0x01', kx: '0xaa', ky: '0xbb', sig: '0xcc' });
    expect(() => decodeGateCode(wrong)).toThrow('Unsupported gate code version');
  });

  it('encodes the record type as the NDEF external-type bytes the plugin wants', () => {
    expect(recordTypeBytes(GATE_RESPONSE_RECORD_TYPE)).toEqual(
      [...'monti.app:s'].map((character) => character.charCodeAt(0)),
    );
    expect(recordTypeMatches([...'monti.app:g'].map((c) => c.charCodeAt(0)), GATE_CODE_RECORD_TYPE)).toBe(true);
    expect(recordTypeMatches([1, 2, 3], GATE_CODE_RECORD_TYPE)).toBe(false);
  });

  it('writes the response as an external record and round-trips through the QR form', () => {
    const wire: GateResponseWire = { v: 1, tokenId: '42', deviceSig: `0x${'ab'.repeat(64)}` };
    const record = encodeGateResponse(wire);
    expect(record.type).toBe('monti.app:s');
    // v + tokenId + a 64-byte signature as 130 hex chars: comfortably over 140 bytes.
    expect(record.payload.byteLength).toBeGreaterThan(140);
    const qr = gateResponseToQr(wire);
    expect(qr.startsWith(QR_PREFIX)).toBe(true);
    expect(qrToGateResponse(qr)).toEqual(wire);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run (from `apps/web/`): `pnpm vitest run src/shared/nfc/records.test.ts`
Expected: FAIL — `Failed to resolve import "./records"`.

- [ ] **Step 3: 레코드 인코딩**

```ts
// apps/web/src/shared/nfc/records.ts
import type { GateCodeWire, GateResponseWire } from '@monti/shared';
import { decodeCbor, encodeCbor, fromBase64Url, toBase64Url } from '@monti/shared/encoding';

export const GATE_CODE_RECORD_TYPE = 'monti.app:g';
export const GATE_RESPONSE_RECORD_TYPE = 'monti.app:s';
export const QR_PREFIX = 'MONTI1:';
/** NDEF TNF 4 = external type. */
export const TNF_EXTERNAL = 4;

export interface NdefExternalRecord { type: string; payload: Uint8Array }

/** The plugin models NdefRecord.type as a byte array, not a string. */
export function recordTypeBytes(type: string): number[] {
  return [...type].map((character) => character.charCodeAt(0));
}

export function recordTypeMatches(bytes: readonly number[] | undefined, type: string): boolean {
  if (!bytes || bytes.length !== type.length) return false;
  return bytes.every((byte, index) => byte === type.charCodeAt(index));
}

export function decodeGateCode(payload: Uint8Array): GateCodeWire {
  const wire = decodeCbor<GateCodeWire>(payload);
  if (wire?.v !== 1) throw new Error('Unsupported gate code version');
  for (const key of ['gateId', 'eventId', 'nonce', 'kx', 'ky', 'sig'] as const) {
    if (typeof wire[key] !== 'string') throw new Error(`Gate code missing ${key}`);
  }
  if (typeof wire.issuedAt !== 'number') throw new Error('Gate code missing issuedAt');
  return wire;
}

export function encodeGateResponse(wire: GateResponseWire): NdefExternalRecord {
  return { type: GATE_RESPONSE_RECORD_TYPE, payload: encodeCbor(wire) };
}

export function gateResponseToQr(wire: GateResponseWire): string {
  return `${QR_PREFIX}${toBase64Url(encodeCbor(wire))}`;
}

export function qrToGateResponse(text: string): GateResponseWire {
  if (!text.startsWith(QR_PREFIX)) throw new Error('Not a MONTI code');
  const wire = decodeCbor<GateResponseWire>(fromBase64Url(text.slice(QR_PREFIX.length)));
  if (wire?.v !== 1) throw new Error('Unsupported gate response version');
  return wire;
}
```

- [ ] **Step 4: 네이티브 어댑터와 Web NFC**

```ts
// apps/web/src/shared/nfc/plugin.ts
// ONLY file that touches @capgo/capacitor-nfc. Surface read in Step 1:
//   CapacitorNfc.startScanning(options?) / stopScanning()
//   CapacitorNfc.write({ records, allowFormat? })
//   NdefRecord = { tnf: number; type: number[]; id: number[]; payload: number[] }
//   events: nfcEvent | tagDiscovered | ndefDiscovered | ndefMimeDiscovered
//         | ndefFormatableDiscovered | nfcStateChange | nfcSessionEnd
import { CapacitorNfc } from '@capgo/capacitor-nfc';
import { TNF_EXTERNAL, recordTypeBytes } from './records';

export interface ScannedRecord { tnf?: number; type?: number[]; id?: number[]; payload?: number[] }
export interface PluginListener { remove: () => Promise<void> }

export function startScan(): Promise<void> {
  return CapacitorNfc.startScanning();
}

export function stopScan(): Promise<void> {
  return CapacitorNfc.stopScanning();
}

export function onNdefDiscovered(handler: (records: ScannedRecord[]) => void): Promise<PluginListener> {
  return CapacitorNfc.addListener('ndefDiscovered', (event: { records?: ScannedRecord[] }) =>
    handler(event.records ?? []),
  );
}

export function writeRecord(type: string, payload: Uint8Array): Promise<void> {
  return CapacitorNfc.write({
    records: [{ tnf: TNF_EXTERNAL, type: recordTypeBytes(type), id: [], payload: Array.from(payload) }],
  });
}
```

```ts
// apps/web/src/shared/nfc/native.ts
import type { GateCodeWire, GateResponseWire } from '@monti/shared';
import { onNdefDiscovered, startScan, stopScan, writeRecord, type PluginListener } from './plugin';
import { GATE_CODE_RECORD_TYPE, decodeGateCode, encodeGateResponse, recordTypeMatches } from './records';

export async function readGateCodeNative(): Promise<GateCodeWire> {
  // Register the listener BEFORE scanning so a fast tap cannot arrive first,
  // and keep the handle in scope so finish() can always remove it.
  let listener: PluginListener | undefined;
  let settled = false;
  try {
    return await new Promise<GateCodeWire>((resolve, reject) => {
      const finish = (run: () => void) => {
        if (settled) return;
        settled = true;
        run();
      };
      void onNdefDiscovered((records) => {
        const record = records.find((entry) => recordTypeMatches(entry.type, GATE_CODE_RECORD_TYPE));
        if (!record?.payload) return finish(() => reject(new Error('No gate record in tag')));
        finish(() => resolve(decodeGateCode(Uint8Array.from(record.payload!))));
      })
        .then((handle) => {
          listener = handle;
          return startScan();
        })
        .catch((cause: unknown) => finish(() => reject(cause)));
    });
  } finally {
    await listener?.remove().catch(() => undefined);
    await stopScan().catch(() => undefined);
  }
}

export async function writeGateResponseNative(wire: GateResponseWire): Promise<void> {
  const record = encodeGateResponse(wire);
  await writeRecord(record.type, record.payload);
}
```

```ts
// apps/web/src/shared/nfc/webnfc.ts
import type { GateCodeWire, GateResponseWire } from '@monti/shared';
import { GATE_CODE_RECORD_TYPE, decodeGateCode, encodeGateResponse } from './records';

type NdefRecordLike = { recordType: string; mediaType?: string; data?: DataView };

function newReader(): object {
  const Reader = (globalThis as { NDEFReader?: new () => object }).NDEFReader;
  if (!Reader) throw new Error('Web NFC unavailable');
  return new Reader();
}

export async function readGateCodeWebNfc(): Promise<GateCodeWire> {
  const reader = newReader() as unknown as {
    scan: () => Promise<void>;
    addEventListener: (name: string, fn: (event: { message: { records: NdefRecordLike[] } }) => void) => void;
  };
  await reader.scan();
  return new Promise<GateCodeWire>((resolve, reject) => {
    reader.addEventListener('reading', ({ message }) => {
      const record = message.records.find((r) => r.recordType === 'external' && r.mediaType === GATE_CODE_RECORD_TYPE)
        ?? message.records.find((r) => r.recordType === GATE_CODE_RECORD_TYPE);
      if (!record?.data) return reject(new Error('No gate record in tag'));
      resolve(decodeGateCode(new Uint8Array(record.data.buffer)));
    });
    reader.addEventListener('readingerror', () => reject(new Error('NFC read failed')));
  });
}

export async function writeGateResponseWebNfc(wire: GateResponseWire): Promise<void> {
  const record = encodeGateResponse(wire);
  const writer = newReader() as unknown as { write: (message: unknown) => Promise<void> };
  await writer.write({ records: [{ recordType: record.type, data: record.payload }] });
}
```

- [ ] **Step 5: 분기**

```ts
// apps/web/src/shared/nfc/index.ts
import { Capacitor } from '@capacitor/core';
import type { GateCodeWire, GateResponseWire } from '@monti/shared';
import { readGateCodeNative, writeGateResponseNative } from './native';
import { readGateCodeWebNfc, writeGateResponseWebNfc } from './webnfc';

export * from './records';

export type NfcCapability = 'native' | 'webnfc' | 'none';

export function nfcCapability(): NfcCapability {
  if (Capacitor.isNativePlatform()) return 'native';
  return 'NDEFReader' in globalThis ? 'webnfc' : 'none';
}

export async function readGateCode(): Promise<GateCodeWire> {
  const capability = nfcCapability();
  if (capability === 'native') return readGateCodeNative();
  if (capability === 'webnfc') return readGateCodeWebNfc();
  throw new Error('NFC unavailable');
}

export async function writeGateResponse(wire: GateResponseWire): Promise<void> {
  const capability = nfcCapability();
  if (capability === 'native') return writeGateResponseNative(wire);
  if (capability === 'webnfc') return writeGateResponseWebNfc(wire);
  throw new Error('NFC unavailable');
}
```

- [ ] **Step 6: 테스트 통과와 플러그인 검증**

Run (from `apps/web/`): `pnpm vitest run src/shared/nfc/records.test.ts`
Expected: PASS — `Tests  4 passed (4)`.

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/apps/web
cat node_modules/@capgo/capacitor-nfc/dist/esm/definitions.d.ts
cat node_modules/@capgo/capacitor-nfc/dist/esm/index.d.ts
```
Expected: export 이름 `CapacitorNfc`, 메서드 `startScanning` / `stopScanning` / `write({ records })`, 레코드 필드 `{ tnf, type, id, payload }`(전부 `number[]`), 리스너 이름 목록에 `ndefDiscovered`. 다르면 `plugin.ts`만 고친다.

- [ ] **Step 7: 커밋**

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI
git add apps/web/src/shared/nfc
git commit -m "feat(web): add ndef external record codec, native and web nfc paths, qr fallback"
```

---

## Task 16: `shared/api/` — Firebase 초기화, 콜러블 래퍼, Firestore, 푸시

**Files:**
- Create: `apps/web/src/shared/api/firebase.ts`, `functions.ts`, `firestore.ts`, `apps/web/src/shared/push/index.ts`
- Test: `apps/web/src/shared/api/functions.test.ts`

**Interfaces:**
- Consumes: sub-plan 02의 콜러블(위 Interfaces 블록 목록 전부) + 스태프 전용 `issueSnapshot({ eventId, gateAccount })`·`getPhotoForGate({ tokenId, gateAccount })`(sub-plan 04가 소비) + 새로 정의한 `pinMessage`, `requestAccountDeletion`.
- Produces: `getFirebaseApp()`, `getFirebaseAuth()`, `getDb()`, `api.<name>(...)` 한 줄짜리 래퍼 전량(`shared/api/functions.ts`), `watchChatMessages`, `watchChatRoom`, `sendChatMessage`, `saveUserProfile`, `savePushToken`, `registerPush()`. **sub-plan 04가 같은 `api` 객체에서 `issueSnapshot`·`getPhotoForGate`를 쓴다.**

두 스태프 콜러블은 **게이트 단말기 계정(`gateAccount`)을 인자로 받는다.** 게이트 계정은 Firebase에 로그인하지 않는다 — 그건 보안 칩 안의 P-256 키일 뿐 신원 제공자가 아니다. 호출은 항상 **스태프 본인의 Firebase 세션**으로 나가고, 서버가 `organizers.isOpenGate(eventId, gateAccount)`(또는 매니저 권한)로 그 스태프가 그 게이트를 운영할 자격이 있는지 체인에서 확인한다. 그래서 `gateAccount`가 요청 바디에 명시적으로 들어간다.

- [ ] **Step 1: 실패하는 테스트**

```ts
// apps/web/src/shared/api/functions.test.ts
import { describe, expect, it, vi } from 'vitest';

const callable = vi.fn();
vi.mock('firebase/functions', () => ({
  getFunctions: () => ({}),
  httpsCallable: (_fns: unknown, name: string) => {
    callable.mockName(name);
    return async (payload: unknown) => ({ data: { name, payload } });
  },
}));
// functions.ts imports FIREBASE_REGION too; a partial factory mock throws at import time.
vi.mock('./firebase', () => ({ getFirebaseApp: () => ({}), FIREBASE_REGION: 'asia-northeast3' }));

const { api } = await import('./functions');

describe('callable wrappers', () => {
  it('names every function exactly as sub-plan 02 deploys it', async () => {
    await expect(api.startSignup()).resolves.toMatchObject({ name: 'startSignup' });
    await expect(api.resolveRecipient({ type: 'phone', value: '+821012345678' }))
      .resolves.toMatchObject({ name: 'resolveRecipient', payload: { type: 'phone', value: '+821012345678' } });
    await expect(api.listPendingGates({ eventId: '3' })).resolves.toMatchObject({ name: 'listPendingGates' });
    await expect(api.startKyc()).resolves.toMatchObject({ name: 'startKyc' });
    await expect(api.pinMessage({ eventId: '3', msgId: 'm1', pinned: true })).resolves.toMatchObject({ name: 'pinMessage' });
  });

  it('passes the gate device account to the staff-only callables', async () => {
    const gateAccount = `0x${'dd'.repeat(20)}` as const;
    await expect(api.issueSnapshot({ eventId: '5', gateAccount })).resolves.toMatchObject({
      name: 'issueSnapshot', payload: { eventId: '5', gateAccount },
    });
    await expect(api.getPhotoForGate({ tokenId: '42', gateAccount })).resolves.toMatchObject({
      name: 'getPhotoForGate', payload: { tokenId: '42', gateAccount },
    });
  });
});
```

- [ ] **Step 2: 실패 확인**

Run (from `apps/web/`): `pnpm vitest run src/shared/api/functions.test.ts`
Expected: FAIL — `Failed to resolve import "./functions"`.

- [ ] **Step 3: Firebase 초기화**

```ts
// apps/web/src/shared/api/firebase.ts
import { getApps, initializeApp, type FirebaseApp } from 'firebase/app';
import { getAuth, type Auth } from 'firebase/auth';
import { getFirestore, type Firestore } from 'firebase/firestore';

export const FIREBASE_REGION = 'asia-northeast3';

export function getFirebaseApp(): FirebaseApp {
  const existing = getApps()[0];
  if (existing) return existing;
  return initializeApp({
    apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
    authDomain: `${import.meta.env.VITE_FIREBASE_PROJECT_ID}.firebaseapp.com`,
    projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
    storageBucket: `${import.meta.env.VITE_FIREBASE_PROJECT_ID}.appspot.com`,
    messagingSenderId: import.meta.env.VITE_FIREBASE_SENDER_ID,
    appId: import.meta.env.VITE_FIREBASE_APP_ID,
  });
}

export function getFirebaseAuth(): Auth {
  return getAuth(getFirebaseApp());
}

export function getDb(): Firestore {
  return getFirestore(getFirebaseApp());
}
```

- [ ] **Step 4: 콜러블 래퍼 전량**

```ts
// apps/web/src/shared/api/functions.ts
import { getFunctions, httpsCallable } from 'firebase/functions';
import type { Hex, SnapshotWire } from '@monti/shared';
import { FIREBASE_REGION, getFirebaseApp } from './firebase';

function call<Req, Res>(name: string): (payload?: Req) => Promise<Res> {
  return async (payload?: Req) => {
    const fn = httpsCallable<Req | Record<string, never>, Res>(
      getFunctions(getFirebaseApp(), FIREBASE_REGION),
      name,
    );
    const result = await fn((payload ?? {}) as Req);
    return result.data;
  };
}

export type SignupStatus = 'pending' | 'kyc_ok' | 'rejected' | 'active' | 'rotated';

export const api = {
  startSignup: call<void, { personId: string }>('startSignup'),
  // Identity verification is per event, not part of signup. startKyc opens a fresh Didit session.
  startKyc: call<void, { kycUrl: string; sessionId: string }>('startKyc'),
  getSignupStatus: call<
    void,
    {
      status: SignupStatus;
      kycLevel: number;
      reason?: 'duplicate_face' | 'document_failed' | 'liveness_failed';
      account?: Hex;
      kycUrl?: string;
    }
  >('getSignupStatus'),
  registerPasskey: call<{ personId: string; attestation: unknown }, { ok: true }>('registerPasskey'),
  registerIdentity: call<{ personId: string; deviceX: Hex; deviceY: Hex }, { txHash: Hex }>('registerIdentity'),
  loginChallenge: call<void, { challenge: string; rpId: string }>('loginChallenge'),
  loginVerify: call<{ assertion: unknown }, { customToken: string }>('loginVerify'),
  lockDevice: call<void, { txHash: Hex }>('lockDevice'),
  startDeviceChange: call<{ method: 'sms' | 'kyc' }, { allowedAt: number; kycUrl?: string }>('startDeviceChange'),
  resolveRecipient: call<
    { type: 'phone' | 'nickname' | 'address'; value: string },
    { member: boolean; account?: Hex; nickname?: string; commitment?: Hex }
  >('resolveRecipient'),
  createTransferInvite: call<
    { tokenId: string; phoneE164: string },
    { inviteId: string; commitment: Hex; expiresAt: number; smsText: string; smsUri: string }
  >('createTransferInvite'),
  pendingOffers: call<void, Array<{ tokenId: string; attesterSig: Hex }>>('pendingOffers'),
  joinEventChat: call<{ eventId: string }, { ok: true }>('joinEventChat'),
  reportMessage: call<{ eventId: string; msgId: string }, { ok: true }>('reportMessage'),
  listAttendees: call<
    { eventId: string },
    Array<{ tokenId: string; nickname: string; tier: number; checkedIn: boolean; kycLevel: number }>
  >('listAttendees'),
  // Sub-plan 04's staff gate-registration screen calls this instead of writing Firestore directly.
  submitPendingGate: call<
    { eventId: string; gateAccount: Hex; kx: Hex; ky: Hex; deviceLabel: string },
    { ok: true }
  >('submitPendingGate'),
  listPendingGates: call<
    { eventId: string },
    { gates: Array<{ gateAccount: Hex; kx: Hex; ky: Hex; label: string; createdAt: number }> }
  >('listPendingGates'),
  createInvite: call<
    { orgId: string; role: 'admin' | 'manager'; phoneE164: string; permissionBits?: number; canApprove?: boolean },
    { inviteId: string }
  >('createInvite'),
  acceptInvite: call<{ inviteId: string }, { orgId: string; role: 'admin' | 'manager'; to: Hex; data: Hex }>('acceptInvite'),
  // Staff-only, consumed by sub-plan 04 through this same module.
  // The gate device account never authenticates; these go out on the staff member's Firebase
  // session and the server authorises them against organizers.isOpenGate(eventId, gateAccount).
  issueSnapshot: call<{ eventId: string; gateAccount: Hex }, SnapshotWire>('issueSnapshot'),
  getPhotoForGate: call<
    { tokenId: string; gateAccount: Hex },
    { photoJpegB64: string; displayName: string }
  >('getPhotoForGate'),
  // Defined by this sub-plan, see the Interfaces block.
  pinMessage: call<{ eventId: string; msgId: string; pinned: boolean }, { ok: true }>('pinMessage'),
  requestAccountDeletion: call<{ reason?: string }, { ok: true; scheduledFor: number }>('requestAccountDeletion'),
};
```

- [ ] **Step 5: Firestore 헬퍼와 푸시**

```ts
// apps/web/src/shared/api/firestore.ts
import {
  addDoc, collection, doc, limit, onSnapshot, orderBy, query, serverTimestamp, setDoc,
} from 'firebase/firestore';
import type { Hex } from '@monti/shared';
import { getDb, getFirebaseAuth } from './firebase';

export interface ChatMessage {
  id: string; uid: string; text: string; createdAt: number; reported: number;
  /** Server-only: set by the pinMessage callable, absent on freshly created messages. */
  pinned?: boolean;
}

export function watchChatMessages(eventId: string, onChange: (messages: ChatMessage[]) => void): () => void {
  const messages = query(
    collection(getDb(), 'eventChats', eventId, 'messages'),
    orderBy('createdAt', 'desc'),
    limit(200),
  );
  return onSnapshot(messages, (snapshot) => {
    onChange(
      snapshot.docs
        .map((document) => ({ id: document.id, ...(document.data() as Omit<ChatMessage, 'id'>) }))
        .reverse(),
    );
  });
}

export function watchChatRoom(eventId: string, onChange: (room: { closed: boolean; endsAt: number }) => void): () => void {
  return onSnapshot(doc(getDb(), 'eventChats', eventId), (snapshot) => {
    const data = snapshot.data() as { closed?: boolean; endsAt?: number } | undefined;
    onChange({ closed: data?.closed ?? false, endsAt: data?.endsAt ?? 0 });
  });
}

/**
 * The security rules reject unknown keys, so the create payload is exactly
 * { uid, text, createdAt, reported }. `pinned` is server-only (pinMessage callable).
 * Returns the new message id so the organizer can pin it straight away.
 */
export async function sendChatMessage(eventId: string, text: string): Promise<string> {
  const uid = getFirebaseAuth().currentUser?.uid;
  if (!uid) throw new Error('Not signed in');
  if (text.length > 500) throw new Error('Message too long');
  const ref = await addDoc(collection(getDb(), 'eventChats', eventId, 'messages'), {
    uid, text, createdAt: serverTimestamp(), reported: 0,
  });
  return ref.id;
}

export async function saveUserProfile(patch: { nickname?: string; locale?: 'ko' | 'en'; chatOrder?: string[] }): Promise<void> {
  const uid = getFirebaseAuth().currentUser?.uid;
  if (!uid) throw new Error('Not signed in');
  await setDoc(doc(getDb(), 'users', uid), patch, { merge: true });
}

/**
 * Security rules allow exactly one client-writable field on devices/{account}: pushToken.
 * platform and updatedAt are written by Functions, never from here.
 */
export async function savePushToken(account: Hex, token: string): Promise<void> {
  await setDoc(doc(getDb(), 'devices', account), { pushToken: token }, { merge: true });
}
```

```ts
// apps/web/src/shared/push/index.ts
import { Capacitor } from '@capacitor/core';
import { PushNotifications } from '@capacitor/push-notifications';
import { getMessaging, getToken, onMessage } from 'firebase/messaging';
import type { Hex } from '@monti/shared';
import { getFirebaseApp } from '../api/firebase';
import { savePushToken } from '../api/firestore';

export type PushHandler = (data: Record<string, string>) => void;

export async function registerPush(account: Hex, onPush: PushHandler): Promise<() => void> {
  if (Capacitor.isNativePlatform()) {
    const permission = await PushNotifications.requestPermissions();
    if (permission.receive !== 'granted') return () => undefined;
    const registration = await PushNotifications.addListener('registration', (token) => {
      void savePushToken(account, token.value);
    });
    const received = await PushNotifications.addListener('pushNotificationReceived', (notification) => {
      onPush((notification.data ?? {}) as Record<string, string>);
    });
    await PushNotifications.register();
    return () => {
      void registration.remove();
      void received.remove();
    };
  }
  const messaging = getMessaging(getFirebaseApp());
  const token = await getToken(messaging, { vapidKey: import.meta.env.VITE_FIREBASE_VAPID_KEY });
  if (token) await savePushToken(account, token);
  return onMessage(messaging, (payload) => onPush((payload.data ?? {}) as Record<string, string>));
}
```

- [ ] **Step 6: 세션 하이드레이터 등록**

Task 6이 `session.ts`에 만든 빈 자리를 여기서 채운다. `session.ts`는 Firebase를 모르고, 이 파일만 안다.

```ts
// apps/web/src/shared/api/sessionHydrator.ts
import { onAuthStateChanged } from 'firebase/auth';
import { registerSessionHydrator, type SessionHydrator } from '../session';
import { getFirebaseAuth } from './firebase';
import { storedCredential } from '../passkey';
import { getAttendeeAccount } from '../chain/accounts';

/**
 * Resolves the session exactly once per auth change. A signed-in Firebase user with a
 * passkey on this device becomes 'signedIn'; anything else is 'anonymous'.
 */
export const firebaseSessionHydrator: SessionHydrator = (set) =>
  onAuthStateChanged(getFirebaseAuth(), (user) => {
    if (!user || !storedCredential()) {
      set({ status: 'anonymous' });
      return;
    }
    void getAttendeeAccount()
      .then((account) => set({ status: 'signedIn', account: account.address }))
      .catch(() => set({ status: 'anonymous' }));
  });

export function installSessionHydrator(): void {
  registerSessionHydrator(firebaseSessionHydrator);
}
```

`main.tsx`에서 i18n 초기화 옆에 한 줄을 더한다:

```tsx
import { installSessionHydrator } from './shared/api/sessionHydrator';

installSessionHydrator();
void initI18n().then(() => { /* …createRoot… */ });
```

- [ ] **Step 7: 테스트 통과와 커밋**

Run (from `apps/web/`): `pnpm vitest run src/shared/api/functions.test.ts`
Expected: PASS — `Tests  2 passed (2)`.

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI
git add apps/web/src/shared/api apps/web/src/shared/push apps/web/src/main.tsx
git commit -m "feat(web): add typed cloud function wrappers, firestore helpers, push and session hydration"
```

---

## Task 17: 가입 1 — 전화 인증 (웹 reCAPTCHA Enterprise, 네이티브 플러그인)

**Files:**
- Create: `apps/web/src/shared/api/auth.ts`, `apps/web/src/attendee/signup/Phone.tsx`, `Verify.tsx`, `useSignup.ts`
- Test: `apps/web/src/attendee/signup/phone.test.tsx`

**Interfaces:**
- Consumes: `getFirebaseAuth()`, `useCopy()`, UI 프리미티브.
- Produces: `sendOtp(phoneE164: string): Promise<string /* verificationId */>`, `confirmOtp(verificationId, code): Promise<void>`, `readSignup()` / `writeSignup()` / `clearSignup()` (`sessionStorage` 백업). `Verify`가 OTP 확인 직후 `api.startSignup()`을 불러 `personId`를 만든다 — **Didit은 여기서 부르지 않는다**(본인인증은 행사별, Task 18).

**선택과 이유.** 웹은 **Firebase Web SDK `signInWithPhoneNumber` + reCAPTCHA Enterprise**를 쓴다. 웹에서는 앱 검증(App Check/SafetyNet)이 없어 reCAPTCHA가 유일한 남용 방지 수단이고, Firebase 콘솔에서 Enterprise 키를 붙이면 invisible 위젯으로 대부분 무마찰로 통과한다. 네이티브는 **`@capacitor-firebase/authentication`**을 쓴다. 이유는 하나뿐이다: 안드로이드에서 **Google Play services가 문자 없이 자동 확인**(instant verification)하는 경로는 네이티브 SDK에만 있고, 이게 스펙 §9.1이 말한 "안드로이드는 0원" 조건을 만든다. WebView 안에서 웹 SDK를 돌리면 그 경로를 잃고 매번 유료 문자가 나간다. iOS 네이티브는 APNs 사일런트 푸시로 reCAPTCHA를 건너뛴다.

- [ ] **Step 1: 실패하는 테스트**

```tsx
// apps/web/src/attendee/signup/phone.test.tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

const sendOtp = vi.fn(async () => 'verification-id');
// Phone.tsx calls toE164 before sendOtp; a partial mock makes it undefined and throws.
vi.mock('../../shared/api/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../shared/api/auth')>()),
  sendOtp,
  confirmOtp: vi.fn(),
}));
vi.mock('../../shared/api/functions', () => ({ api: { startSignup: vi.fn(async () => ({ personId: 'p1' })) } }));
const navigate = vi.fn();
vi.mock('react-router-dom', async (orig) => ({
  ...(await orig<typeof import('react-router-dom')>()),
  useNavigate: () => navigate,
}));

const { Phone } = await import('./Phone');

describe('Phone screen', () => {
  it('normalises a Korean number to E.164 and moves to the code step', async () => {
    render(<MemoryRouter><Phone /></MemoryRouter>);
    await userEvent.type(screen.getByRole('textbox'), '01012345678');
    await userEvent.click(screen.getByRole('button', { name: '인증번호 받기' }));
    expect(sendOtp).toHaveBeenCalledWith('+821012345678');
    expect(navigate).toHaveBeenCalledWith('/signup/verify');
  });
});
```

- [ ] **Step 2: 실패 확인**

Run (from `apps/web/`): `pnpm vitest run src/attendee/signup/phone.test.tsx`
Expected: FAIL — `sendOtp` 가 호출되지 않음(현재 `Phone`은 스텁).

- [ ] **Step 3: 인증 모듈**

```ts
// apps/web/src/shared/api/auth.ts
import { Capacitor } from '@capacitor/core';
import { FirebaseAuthentication } from '@capacitor-firebase/authentication';
import { PhoneAuthProvider, RecaptchaVerifier, signInWithCredential, signInWithPhoneNumber } from 'firebase/auth';
import { getFirebaseAuth } from './firebase';

let recaptcha: RecaptchaVerifier | null = null;
let webVerificationId: string | null = null;

/** E.164, defaulting a bare Korean mobile number to +82. */
export function toE164(input: string, defaultCountry = '+82'): string {
  const digits = input.replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) return digits;
  return `${defaultCountry}${digits.replace(/^0/, '')}`;
}

export async function sendOtp(phoneE164: string): Promise<string> {
  if (Capacitor.isNativePlatform()) {
    // Android may verify instantly without an SMS; the listener resolves in that case too.
    const { verificationId } = await FirebaseAuthentication.signInWithPhoneNumber({ phoneNumber: phoneE164 });
    return verificationId ?? '';
  }
  recaptcha ??= new RecaptchaVerifier(getFirebaseAuth(), 'recaptcha-container', { size: 'invisible' });
  const confirmation = await signInWithPhoneNumber(getFirebaseAuth(), phoneE164, recaptcha);
  webVerificationId = confirmation.verificationId;
  return confirmation.verificationId;
}

export async function confirmOtp(verificationId: string, code: string): Promise<void> {
  if (Capacitor.isNativePlatform()) {
    await FirebaseAuthentication.confirmVerificationCode({ verificationId, verificationCode: code });
    return;
  }
  const credential = PhoneAuthProvider.credential(verificationId || webVerificationId || '', code);
  await signInWithCredential(getFirebaseAuth(), credential);
}
```

- [ ] **Step 4: 화면 둘과 가입 상태**

```ts
// apps/web/src/attendee/signup/useSignup.ts
const KEY = 'monti.signup';

export interface SignupState { personId?: string; verificationId?: string }

export function readSignup(): SignupState {
  try { return JSON.parse(sessionStorage.getItem(KEY) ?? '{}') as SignupState; } catch { return {}; }
}

export function writeSignup(patch: SignupState): void {
  sessionStorage.setItem(KEY, JSON.stringify({ ...readSignup(), ...patch }));
}

export function clearSignup(): void {
  sessionStorage.removeItem(KEY);
}
```

```tsx
// apps/web/src/attendee/signup/Phone.tsx
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, Button, Field, Screen } from '../../shared/ui';
import { useCopy } from '../../shared/i18n';
import { sendOtp, toE164 } from '../../shared/api/auth';
import { writeSignup } from './useSignup';

export function Phone() {
  const copy = useCopy();
  const navigate = useNavigate();
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setError('');
    try {
      const verificationId = await sendOtp(toE164(value));
      writeSignup({ verificationId });
      navigate('/signup/verify');
    } catch {
      setError(copy.common.error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen title={copy.signup.phoneTitle}>
      <p>{copy.signup.phoneHint}</p>
      <Field label={copy.signup.phoneTitle}>
        <input inputMode="tel" autoComplete="tel" placeholder={copy.signup.phonePlaceholder}
               value={value} onChange={(event) => setValue(event.target.value)} />
      </Field>
      {error ? <Alert tone="error">{error}</Alert> : null}
      <div id="recaptcha-container" />
      <Button onClick={submit} disabled={busy || value.length < 8}>{copy.signup.sendCode}</Button>
    </Screen>
  );
}
```

```tsx
// apps/web/src/attendee/signup/Verify.tsx
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, Button, Field, Screen } from '../../shared/ui';
import { useCopy } from '../../shared/i18n';
import { confirmOtp } from '../../shared/api/auth';
import { api } from '../../shared/api/functions';
import { readSignup, writeSignup } from './useSignup';

export function Verify() {
  const copy = useCopy();
  const navigate = useNavigate();
  const [code, setCode] = useState('');
  const [error, setError] = useState('');

  async function submit() {
    try {
      await confirmOtp(readSignup().verificationId ?? '', code);
      // Creates persons/{personId} and users/{uid}. No KYC session: verification is per event.
      const { personId } = await api.startSignup();
      writeSignup({ personId });
      navigate('/signup/passkey');
    } catch {
      setError(copy.signup.codeWrong);
    }
  }

  return (
    <Screen title={copy.signup.codeTitle}>
      <Field label={copy.signup.codeTitle}>
        <input inputMode="numeric" autoComplete="one-time-code" maxLength={6}
               value={code} onChange={(event) => setCode(event.target.value)} />
      </Field>
      {error ? <Alert tone="error">{error}</Alert> : null}
      <Button onClick={submit} disabled={code.length !== 6}>{copy.signup.verifyCta}</Button>
    </Screen>
  );
}
```

- [ ] **Step 5: 테스트 통과와 커밋**

Run (from `apps/web/`): `pnpm vitest run src/attendee/signup/phone.test.tsx`
Expected: PASS — `Tests  1 passed (1)`.

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI
git add apps/web/src/shared/api/auth.ts apps/web/src/attendee/signup
git commit -m "feat(attendee): add phone otp with web recaptcha and native instant verification"
```

---

## Task 18: 본인인증 `/me/verify` — Didit 호스팅 링크, 딥링크 복귀, `kycLevel` 폴링

**Files:**
- Create: `apps/web/src/shared/api/deepLink.ts`, `apps/web/src/attendee/me/useKycLevel.ts`, `apps/web/src/attendee/me/VerifyIdentity.tsx`
- Test: `apps/web/src/attendee/me/verifyIdentity.test.tsx`

**Interfaces:**
- Consumes: `api.startKyc`, `api.getSignupStatus` (Task 16), `@capacitor/browser`, `@capacitor/app`.
- Produces: `KYC_CALLBACK_URL = 'monti://kyc/callback'`, `listenDeepLink(onUrl): Promise<() => void>`, `useKycLevel(): { kycLevel: number; isLoading: boolean; refetch }`, `<VerifyIdentity />`.

**본인인증은 가입이 아니라 행사별이다**(창업자 결정). 가벼운 모임은 전화번호만으로 들어오고, 암표가 걱정되는 공연만 주최자가 `requireKyc`를 켠다. 그래서 이 화면은 `/me/verify`에 있고 프로필과 티켓 받기 시트 양쪽에서 들어온다. `?returnTo=` 쿼리로 돌아갈 곳을 받는다.

Didit 웹 SDK는 WebView 안에서 "폴백 전용"이므로 **시스템 브라우저**(`@capacitor/browser`)로 호스팅 링크를 열고 `monti://kyc/callback` 딥링크로 돌아온다. 돌아와도 웹훅이 아직 안 왔을 수 있으므로 `getSignupStatus()`를 2초 간격으로 폴링한다(최대 90초). 같은 얼굴이 두 번 인증하면 `rejected` + `copy.kyc.duplicate` 로 끝난다(스펙 §5.1의 "이미 계정이 있습니다").

- [ ] **Step 1: 실패하는 테스트**

```tsx
// apps/web/src/attendee/me/verifyIdentity.test.tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';

const openBrowser = vi.fn();
vi.mock('@capacitor/browser', () => ({ Browser: { open: openBrowser, close: vi.fn() } }));
vi.mock('../../shared/api/deepLink', () => ({ listenDeepLink: async () => () => undefined, KYC_CALLBACK_URL: 'monti://kyc/callback' }));
const getSignupStatus = vi.fn().mockResolvedValue({ status: 'active', kycLevel: 0 });
vi.mock('../../shared/api/functions', () => ({
  api: { startKyc: async () => ({ kycUrl: 'https://verify.didit.me/s/abc', sessionId: 'sess-1' }), getSignupStatus },
}));

const { VerifyIdentity } = await import('./VerifyIdentity');

function renderScreen() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter><VerifyIdentity /></MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('VerifyIdentity', () => {
  it('opens the hosted link in the system browser', async () => {
    renderScreen();
    await userEvent.click(await screen.findByRole('button', { name: '본인인증 하기' }));
    expect(openBrowser).toHaveBeenCalledWith({ url: 'https://verify.didit.me/s/abc', presentationStyle: 'popover' });
  });

  it('reports a duplicate face with the "already have an account" copy', async () => {
    getSignupStatus.mockResolvedValue({ status: 'rejected', kycLevel: 0, reason: 'duplicate_face' });
    renderScreen();
    await userEvent.click(await screen.findByRole('button', { name: '본인인증 하기' }));
    expect(await screen.findByText('이미 계정이 있습니다. 기존 계정으로 로그인해 주세요.')).toBeInTheDocument();
  });

  it('reports any other failure with the generic rejection copy', async () => {
    getSignupStatus.mockResolvedValue({ status: 'rejected', kycLevel: 0, reason: 'document_failed' });
    renderScreen();
    await userEvent.click(await screen.findByRole('button', { name: '본인인증 하기' }));
    expect(await screen.findByText('본인 확인에 실패했어요. 다시 시도해 주세요.')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 실패 확인**

Run (from `apps/web/`): `pnpm vitest run src/attendee/me/verifyIdentity.test.tsx`
Expected: FAIL — `Failed to resolve import "./VerifyIdentity"`.

- [ ] **Step 3: 딥링크 리스너**

```ts
// apps/web/src/shared/api/deepLink.ts
import { App } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';

export const KYC_CALLBACK_URL = 'monti://kyc/callback';

/** Resolves a remover. On the web the callback arrives as a normal navigation instead. */
export async function listenDeepLink(onUrl: (url: string) => void): Promise<() => void> {
  if (!Capacitor.isNativePlatform()) {
    const handler = () => onUrl(window.location.href);
    window.addEventListener('focus', handler);
    return () => window.removeEventListener('focus', handler);
  }
  const listener = await App.addListener('appUrlOpen', (event) => onUrl(event.url));
  return () => void listener.remove();
}
```

- [ ] **Step 4: `kycLevel` 훅**

```ts
// apps/web/src/attendee/me/useKycLevel.ts
import { useQuery } from '@tanstack/react-query';
import { api } from '../../shared/api/functions';

/** 0 = unverified, 1 = id + face verified. Cached so claim gating does not re-ask the server. */
export function useKycLevel() {
  const query = useQuery({
    queryKey: ['kycLevel'],
    queryFn: async () => (await api.getSignupStatus()).kycLevel,
    staleTime: 60_000,
  });
  return { kycLevel: query.data ?? 0, isLoading: query.isLoading, refetch: query.refetch };
}
```

- [ ] **Step 5: 화면**

```tsx
// apps/web/src/attendee/me/VerifyIdentity.tsx
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Browser } from '@capacitor/browser';
import { useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Screen, Spinner } from '../../shared/ui';
import { useCopy } from '../../shared/i18n';
import { api } from '../../shared/api/functions';
import { listenDeepLink } from '../../shared/api/deepLink';

const POLL_INTERVAL_MS = 2_000;
const POLL_LIMIT = 45; // 90 seconds

export function VerifyIdentity() {
  const copy = useCopy();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [params] = useSearchParams();
  const returnTo = params.get('returnTo') ?? '/me';
  const [error, setError] = useState('');
  const [polling, setPolling] = useState(false);
  const stopped = useRef(false);

  const poll = useCallback(async () => {
    setPolling(true);
    for (let attempt = 0; attempt < POLL_LIMIT && !stopped.current; attempt += 1) {
      const { status, kycLevel, reason } = await api.getSignupStatus();
      if (kycLevel >= 1) {
        await queryClient.invalidateQueries({ queryKey: ['kycLevel'] });
        navigate(returnTo, { replace: true });
        return;
      }
      if (status === 'rejected') {
        // M acceptance 1: the same face on a second phone must read "이미 계정이 있습니다".
        setError(reason === 'duplicate_face' ? copy.kyc.duplicate : copy.kyc.rejected);
        setPolling(false);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    setPolling(false);
  }, [navigate, queryClient, returnTo, copy.kyc.rejected]);

  useEffect(() => {
    let remove = () => undefined as void;
    void listenDeepLink((url) => {
      if (!url.includes('kyc/callback')) return;
      void Browser.close().catch(() => undefined);
      void poll();
    }).then((fn) => { remove = fn; });
    return () => { stopped.current = true; remove(); };
  }, [poll]);

  async function start() {
    setError('');
    try {
      const { kycUrl } = await api.startKyc();
      await Browser.open({ url: kycUrl, presentationStyle: 'popover' });
      void poll();
    } catch {
      setError(copy.common.error);
    }
  }

  return (
    <Screen title={copy.kyc.title}>
      <p>{copy.kyc.body}</p>
      {error ? <Alert tone="error">{error}</Alert> : null}
      {polling ? <><Spinner /><p>{copy.kyc.waiting}</p></> : null}
      <Button onClick={start} disabled={polling}>{copy.kyc.cta}</Button>
    </Screen>
  );
}
```

- [ ] **Step 6: 테스트 통과와 커밋**

Run (from `apps/web/`): `pnpm vitest run src/attendee/me/verifyIdentity.test.tsx`
Expected: PASS — `Tests  3 passed (3)`.

Run (from repo root): `pnpm lint:copy`
Expected: `copy-lint: clean`.

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI
git add apps/web/src/attendee/me apps/web/src/shared/api/deepLink.ts
git commit -m "feat(attendee): add per-event identity verification flow with didit and kyc level polling"
```

---

## Task 19: 가입 3 — 패스키 등록, 기기 키 등록, 완료, 패스키 전용 로그인

가입은 여기서 끝난다: **전화 인증 → 패스키 → 기기 키 → `registerIdentity` → 홈**. 신분증·얼굴 확인은 들어 있지 않다(Task 18, 행사별).

**Files:**
- Create: `apps/web/src/attendee/signup/Passkey.tsx`, `Device.tsx`, `Done.tsx`
- Modify: `apps/web/src/attendee/Login.tsx`
- Test: `apps/web/src/attendee/signup/finish.test.tsx`

**Interfaces:**
- Consumes: `createPasskey`, `getPasskeyAccount` (Task 12), `ensureDeviceKey` (Task 13), `getSmartAccount`/`setSmartAccount` (Task 10), `api.registerPasskey`/`registerIdentity`/`loginChallenge`/`loginVerify` (Task 16), `setSession` (Task 6).
- Produces: `<PasskeyStep />`, `<DeviceStep />`, `<Done />`, `<Login />`. 계정 주소는 **서버에 묻지 않고** `getSmartAccount(...).address`로 로컬 계산한다(패스키 공개키 + nonce 0의 순수 함수).

- [ ] **Step 1: 실패하는 테스트**

```tsx
// apps/web/src/attendee/signup/finish.test.tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

const registerIdentity = vi.fn(async () => ({ txHash: '0xtx' }));
vi.mock('../../shared/api/functions', () => ({ api: { registerPasskey: vi.fn(async () => ({ ok: true })), registerIdentity } }));
vi.mock('../../shared/deviceKey', () => ({
  ensureDeviceKey: async () => ({ x: `0x${'11'.repeat(32)}`, y: `0x${'22'.repeat(32)}` }),
  ATTENDEE_KEY_ALIAS: 'monti-attendee',
  DeviceKeyUnavailable: class extends Error {},
}));
vi.mock('../../shared/chain/accounts', () => ({ getAttendeeAccount: async () => ({ address: `0x${'ab'.repeat(20)}` }) }));
vi.mock('./useSignup', () => ({ readSignup: () => ({ personId: 'p1' }), writeSignup: vi.fn(), clearSignup: vi.fn() }));
const navigate = vi.fn();
vi.mock('react-router-dom', async (orig) => ({ ...(await orig<typeof import('react-router-dom')>()), useNavigate: () => navigate }));

const { DeviceStep } = await import('./Device');

describe('device registration step', () => {
  it('registers the hardware key on chain and lands on the done screen', async () => {
    render(<MemoryRouter><DeviceStep /></MemoryRouter>);
    await userEvent.click(screen.getByRole('button', { name: '등록하기' }));
    expect(registerIdentity).toHaveBeenCalledWith({
      personId: 'p1', deviceX: `0x${'11'.repeat(32)}`, deviceY: `0x${'22'.repeat(32)}`,
    });
    expect(navigate).toHaveBeenCalledWith('/signup/done');
  });
});
```

- [ ] **Step 2: 실패 확인**

Run (from `apps/web/`): `pnpm vitest run src/attendee/signup/finish.test.tsx`
Expected: FAIL — `Failed to resolve import "./Device"`.

- [ ] **Step 3: 패스키 등록 화면**

```tsx
// apps/web/src/attendee/signup/Passkey.tsx
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, Button, Screen } from '../../shared/ui';
import { useCopy } from '../../shared/i18n';
import { createPasskey } from '../../shared/passkey';
import { api } from '../../shared/api/functions';
import { readSignup } from './useSignup';

export function PasskeyStep() {
  const copy = useCopy();
  const navigate = useNavigate();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true);
    setError('');
    try {
      const credential = await createPasskey('MONTI');
      await api.registerPasskey({
        personId: readSignup().personId ?? '',
        attestation: JSON.parse(credential.attestationJson) as unknown,
      });
      navigate('/signup/device');
    } catch {
      setError(copy.signup.passkeyFailed);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen title={copy.signup.passkeyTitle}>
      <p>{copy.signup.passkeyBody}</p>
      {error ? <Alert tone="error">{error}</Alert> : null}
      <Button onClick={run} disabled={busy}>{copy.signup.passkeyCta}</Button>
    </Screen>
  );
}
```

- [ ] **Step 4: 기기 키 등록과 완료**

```tsx
// apps/web/src/attendee/signup/Device.tsx
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, Button, Screen } from '../../shared/ui';
import { useCopy } from '../../shared/i18n';
import { ATTENDEE_KEY_ALIAS, DeviceKeyUnavailable, ensureDeviceKey } from '../../shared/deviceKey';
import { getAttendeeAccount } from '../../shared/chain/accounts';
import { api } from '../../shared/api/functions';
import { setSession } from '../../shared/session';
import { readSignup } from './useSignup';

export function DeviceStep() {
  const copy = useCopy();
  const navigate = useNavigate();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true);
    setError('');
    try {
      const personId = readSignup().personId ?? '';
      const account = await getAttendeeAccount();
      const { x, y } = await ensureDeviceKey({ alias: ATTENDEE_KEY_ALIAS, requireAuth: true, strongBox: true });
      await api.registerIdentity({ personId, deviceX: x, deviceY: y });
      setSession({ status: 'signedIn', account: account.address, personId });
      navigate('/signup/done');
    } catch (cause) {
      // Browser attendees have no hardware key: they finish signup and use the QR path at the gate.
      setError(cause instanceof DeviceKeyUnavailable ? copy.enter.deviceUnavailable : copy.signup.deviceFailed);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen title={copy.signup.deviceTitle}>
      <p>{copy.signup.deviceBody}</p>
      {error ? <Alert tone="warn">{error}</Alert> : null}
      <Button onClick={run} disabled={busy}>{copy.signup.deviceCta}</Button>
    </Screen>
  );
}
```

```tsx
// apps/web/src/attendee/signup/Done.tsx
import { useNavigate } from 'react-router-dom';
import { Button, Screen } from '../../shared/ui';
import { useCopy } from '../../shared/i18n';
import { clearSignup } from './useSignup';

export function Done() {
  const copy = useCopy();
  const navigate = useNavigate();
  return (
    <Screen title={copy.signup.doneTitle}>
      <Button onClick={() => { clearSignup(); navigate('/'); }}>{copy.signup.doneCta}</Button>
    </Screen>
  );
}
```

- [ ] **Step 5: 패스키 전용 로그인**

```tsx
// apps/web/src/attendee/Login.tsx
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { signInWithCustomToken } from 'firebase/auth';
import { Alert, Button, Screen } from '../shared/ui';
import { useCopy } from '../shared/i18n';
import { api } from '../shared/api/functions';
import { getFirebaseAuth } from '../shared/api/firebase';
import { getPasskeyAccount } from '../shared/passkey';
import { getAttendeeAccount } from '../shared/chain/accounts';
import { setSession } from '../shared/session';

export function Login() {
  const copy = useCopy();
  const navigate = useNavigate();
  const [error, setError] = useState('');

  async function run() {
    setError('');
    try {
      const { challenge } = await api.loginChallenge();
      const passkey = await getPasskeyAccount();
      const assertion = await passkey.sign({ hash: `0x${challenge}` as `0x${string}` });
      const { customToken } = await api.loginVerify({ assertion });
      await signInWithCustomToken(getFirebaseAuth(), customToken);
      const account = await getAttendeeAccount();
      setSession({ status: 'signedIn', account: account.address });
      navigate('/tickets');
    } catch {
      setError(copy.login.failed);
    }
  }

  return (
    <Screen title={copy.login.title}>
      <p>{copy.login.body}</p>
      {error ? <Alert tone="error">{error}</Alert> : null}
      <Button onClick={run}>{copy.login.cta}</Button>
    </Screen>
  );
}
```

- [ ] **Step 6: 테스트 통과와 커밋**

Run (from `apps/web/`): `pnpm vitest run src/attendee/signup`
Expected: PASS — `Test Files  3 passed (3)`.

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI
git add apps/web/src/attendee
git commit -m "feat(attendee): finish signup with passkey, device key registration and passkey-only login"
```

---

## Task 20: Envio 클라이언트, IPFS 메타데이터, 탐색과 행사 상세

**Files:**
- Create: `apps/web/src/shared/envio/client.ts`, `queries.ts`, `ipfs.ts`, `apps/web/src/attendee/discover/Discover.tsx`, `Filters.tsx`, `EventDetail.tsx`, `useEvents.ts`
- Test: `apps/web/src/attendee/discover/discover.test.tsx`

**Interfaces:**
- Consumes: `getConfig().envioUrl`, `getConfig().ipfsGateway`, `useCopy()`.
- Produces: `gql<T>(query, variables): Promise<T>`, `EVENTS_QUERY`, `TICKETS_QUERY`, `type EnvioEvent`, `fetchEventMetadata(cid): Promise<EventMetadata>`, `useEvents(filters)`, `<Discover />`, `<EventDetail />`, `type DiscoverFilters`.

체인에는 제목 **해시**만 있으므로, 마법사가 Pinata에 올린 메타데이터 JSON(`{ title, description, image, venue, category, region }`)의 CID가 `Event.imageCid`에 들어간다. 탐색 화면은 Envio에서 한 페이지(기본 100건)를 받아 각 CID의 JSON을 게이트웨이에서 병렬로 가져오고, **제목 검색은 그 페이지 안에서 클라이언트 측으로** 한다(체인에 평문 제목이 없으므로 서버 검색이 불가능하다).

- [ ] **Step 1: 실패하는 테스트**

```tsx
// apps/web/src/attendee/discover/discover.test.tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../shared/envio/client', () => ({
  gql: async () => ({
    Event: [
      { id: '1', orgId: '1', imageCid: 'cid-a', startsAt: '1790000000', endsAt: '1790003600', category: 0, regionCode: '0xkr11', status: 'Published', requireKyc: true },
      { id: '2', orgId: '1', imageCid: 'cid-b', startsAt: '1790000000', endsAt: '1790003600', category: 1, regionCode: '0xkr26', status: 'Published', requireKyc: false },
    ],
  }),
}));
vi.mock('../../shared/envio/ipfs', () => ({
  fetchEventMetadata: async (cid: string) =>
    cid === 'cid-a'
      ? { title: '재즈 나이트', description: '', image: 'img-a', venue: '한남', category: 0, region: 'KR-11' }
      : { title: '개발자 모임', description: '', image: 'img-b', venue: '해운대', category: 1, region: 'KR-26' },
}));

const { Discover } = await import('./Discover');

describe('Discover', () => {
  it('filters the loaded page by the title search box', async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter><Discover /></MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findByText('재즈 나이트')).toBeInTheDocument();
    expect(screen.getByText('KYC 필요')).toBeInTheDocument();   // only event 1 requires it
    await userEvent.type(screen.getByPlaceholderText('행사 이름 검색'), '개발자');
    expect(screen.queryByText('재즈 나이트')).toBeNull();
    expect(screen.getByText('개발자 모임')).toBeInTheDocument();
    expect(screen.queryByText('KYC 필요')).toBeNull();
  });
});
```

- [ ] **Step 2: 실패 확인**

Run (from `apps/web/`): `pnpm vitest run src/attendee/discover/discover.test.tsx`
Expected: FAIL — `Failed to resolve import "./Discover"`.

- [ ] **Step 3: Envio 클라이언트, 쿼리, IPFS**

```ts
// apps/web/src/shared/envio/client.ts
import { getConfig } from '../config';

export async function gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const response = await fetch(getConfig().envioUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok) throw new Error(`Indexer ${response.status}`);
  const body = (await response.json()) as { data?: T; errors?: Array<{ message: string }> };
  if (body.errors?.length) throw new Error(body.errors[0]!.message);
  if (!body.data) throw new Error('Indexer returned no data');
  return body.data;
}
```

```ts
// apps/web/src/shared/envio/queries.ts
export interface EnvioEvent {
  id: string; orgId: string; imageCid: string; startsAt: string; endsAt: string;
  saleStart: string; saleEnd: string; transferable: boolean; transferCutoffSeconds: number;
  maxTransfers: number; category: number; regionCode: string;
  /** Envio stores the enum as its String name: 'Draft' | 'Published' | 'Cancelled' | 'Ended'. */
  status: string;
  requireKyc: boolean;
}
export interface EnvioTier {
  id: string; eventId: string; name: string; supply: number; minted: number; maxPerWallet: number; seated: boolean;
}
export interface EnvioTicket { id: string; eventId: string; tier: number; owner: string; transfers: number; revoked: boolean }
export interface EnvioCheckIn { id: string; gateId: string; ts: string; manual: boolean; txHash: string; block: string }
export interface EnvioOffer { id: string; from: string; commitment: string; expiresAt: string; status: string }

export const EVENTS_QUERY = `
  query Events($limit: Int!) {
    Event(where: { status: { _eq: "Published" } }, order_by: { startsAt: asc }, limit: $limit) {
      id orgId imageCid startsAt endsAt saleStart saleEnd transferable
      transferCutoffSeconds maxTransfers category regionCode status requireKyc
    }
  }`;

export const EVENT_QUERY = `
  query OneEvent($id: String!) {
    Event(where: { id: { _eq: $id } }) {
      id orgId imageCid startsAt endsAt saleStart saleEnd transferable
      transferCutoffSeconds maxTransfers category regionCode status requireKyc
    }
    Tier(where: { eventId: { _eq: $id } }) { id eventId name supply minted maxPerWallet seated }
  }`;

export const MY_TICKETS_QUERY = `
  query MyTickets($owner: String!) {
    Ticket(where: { owner: { _eq: $owner } }) { id eventId tier owner transfers revoked }
    CheckIn { id gateId ts manual txHash block }
    Offer(where: { from: { _eq: $owner } }) { id from commitment expiresAt status }
  }`;
```

```ts
// apps/web/src/shared/envio/ipfs.ts
import { getConfig } from '../config';

export interface EventMetadata {
  title: string; description: string; image: string; venue: string; category: number; region: string;
}

const cache = new Map<string, EventMetadata>();

export async function fetchEventMetadata(cid: string): Promise<EventMetadata> {
  const cached = cache.get(cid);
  if (cached) return cached;
  const response = await fetch(`${getConfig().ipfsGateway}${cid}`);
  if (!response.ok) throw new Error(`IPFS ${response.status}`);
  const metadata = (await response.json()) as EventMetadata;
  cache.set(cid, metadata);
  return metadata;
}
```

- [ ] **Step 4: 훅과 탐색 화면**

```ts
// apps/web/src/attendee/discover/useEvents.ts
import { useQuery } from '@tanstack/react-query';
import { gql } from '../../shared/envio/client';
import { EVENTS_QUERY, type EnvioEvent } from '../../shared/envio/queries';
import { fetchEventMetadata, type EventMetadata } from '../../shared/envio/ipfs';

export type DateRange = 'all' | 'today' | 'week' | 'month';
export interface DiscoverFilters { range: DateRange; region: string; category: number | 'all'; search: string }
export interface DiscoverItem { event: EnvioEvent; metadata: EventMetadata | null }

export function rangeBounds(range: DateRange, now = Date.now()): { from: number; to: number } {
  const day = 86_400_000;
  if (range === 'today') return { from: now, to: now + day };
  if (range === 'week') return { from: now, to: now + 7 * day };
  if (range === 'month') return { from: now, to: now + 30 * day };
  return { from: 0, to: Number.MAX_SAFE_INTEGER };
}

export function applyFilters(items: DiscoverItem[], filters: DiscoverFilters, now = Date.now()): DiscoverItem[] {
  const { from, to } = rangeBounds(filters.range, now);
  const needle = filters.search.trim().toLowerCase();
  return items.filter(({ event, metadata }) => {
    const startsAtMs = Number(event.startsAt) * 1000;
    if (startsAtMs < from || startsAtMs > to) return false;
    if (filters.category !== 'all' && event.category !== filters.category) return false;
    if (filters.region && metadata?.region !== filters.region) return false;
    if (needle && !(metadata?.title ?? '').toLowerCase().includes(needle)) return false;
    return true;
  });
}

export function useEvents() {
  return useQuery({
    queryKey: ['events', 'published'],
    queryFn: async (): Promise<DiscoverItem[]> => {
      const { Event } = await gql<{ Event: EnvioEvent[] }>(EVENTS_QUERY, { limit: 100 });
      return Promise.all(
        Event.map(async (event) => ({
          event,
          metadata: await fetchEventMetadata(event.imageCid).catch(() => null),
        })),
      );
    },
  });
}
```

```tsx
// apps/web/src/attendee/discover/Discover.tsx
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Field, Screen, Spinner } from '../../shared/ui';
import { useCopy } from '../../shared/i18n';
import { applyFilters, useEvents, type DiscoverFilters } from './useEvents';
import { Filters } from './Filters';

export function Discover() {
  const copy = useCopy();
  const [filters, setFilters] = useState<DiscoverFilters>({ range: 'all', region: '', category: 'all', search: '' });
  const { data, isLoading } = useEvents();
  const items = applyFilters(data ?? [], filters);

  return (
    <Screen title={copy.discover.title}>
      <Field label={copy.discover.searchPlaceholder}>
        <input placeholder={copy.discover.searchPlaceholder} value={filters.search}
               onChange={(event) => setFilters({ ...filters, search: event.target.value })} />
      </Field>
      <Filters value={filters} onChange={setFilters} />
      {isLoading ? <Spinner /> : null}
      {!isLoading && items.length === 0 ? <p>{copy.discover.empty}</p> : null}
      <ul style={{ listStyle: 'none', padding: 0 }}>
        {items.map(({ event, metadata }) => (
          <li key={event.id} style={{ marginBottom: 12 }}>
            <Link to={`/events/${event.id}`}>{metadata?.title ?? event.id}</Link>
            {event.requireKyc ? <span className="badge">{copy.kyc.requiredBadge}</span> : null}
          </li>
        ))}
      </ul>
    </Screen>
  );
}
```

```tsx
// apps/web/src/attendee/discover/Filters.tsx
import { Field } from '../../shared/ui';
import { useCopy } from '../../shared/i18n';
import type { DiscoverFilters } from './useEvents';

const REGIONS = ['', 'KR-11', 'KR-26', 'KR-28', 'KR-30', 'KR-41', 'KR-48'];

export function Filters({ value, onChange }: { value: DiscoverFilters; onChange: (next: DiscoverFilters) => void }) {
  const copy = useCopy();
  return (
    <>
      <Field label={copy.discover.filterDate}>
        <select value={value.range} onChange={(event) => onChange({ ...value, range: event.target.value as DiscoverFilters['range'] })}>
          <option value="all">{copy.discover.categoryAll}</option>
          <option value="today">{copy.discover.dateToday}</option>
          <option value="week">{copy.discover.dateWeek}</option>
          <option value="month">{copy.discover.dateMonth}</option>
        </select>
      </Field>
      <Field label={copy.discover.filterRegion}>
        <select value={value.region} onChange={(event) => onChange({ ...value, region: event.target.value })}>
          {REGIONS.map((region) => <option key={region} value={region}>{region || copy.discover.categoryAll}</option>)}
        </select>
      </Field>
      <Field label={copy.discover.filterCategory}>
        <select value={String(value.category)}
                onChange={(event) => onChange({ ...value, category: event.target.value === 'all' ? 'all' : Number(event.target.value) })}>
          <option value="all">{copy.discover.categoryAll}</option>
          <option value="0">{copy.discover.category0}</option>
          <option value="1">{copy.discover.category1}</option>
          <option value="2">{copy.discover.category2}</option>
          <option value="3">{copy.discover.category3}</option>
        </select>
      </Field>
    </>
  );
}
```

- [ ] **Step 5: 행사 상세**

```tsx
// apps/web/src/attendee/discover/EventDetail.tsx
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Button, Screen, Spinner } from '../../shared/ui';
import { useCopy } from '../../shared/i18n';
import { gql } from '../../shared/envio/client';
import { EVENT_QUERY, type EnvioEvent, type EnvioTier } from '../../shared/envio/queries';
import { fetchEventMetadata } from '../../shared/envio/ipfs';
import { getConfig } from '../../shared/config';

export function EventDetail() {
  const copy = useCopy();
  const { eventId = '' } = useParams();
  const { data, isLoading } = useQuery({
    queryKey: ['event', eventId],
    queryFn: async () => {
      const result = await gql<{ Event: EnvioEvent[]; Tier: EnvioTier[] }>(EVENT_QUERY, { id: eventId });
      const event = result.Event[0];
      if (!event) throw new Error('not found');
      return { event, tiers: result.Tier, metadata: await fetchEventMetadata(event.imageCid).catch(() => null) };
    },
  });

  if (isLoading || !data) return <Screen><Spinner /></Screen>;
  const { event, tiers, metadata } = data;
  const explorer = `${getConfig().explorerUrl}/address/${getConfig().addresses.ticket}`;

  return (
    <Screen title={metadata?.title ?? event.id}>
      {metadata?.image ? <img src={`${getConfig().ipfsGateway}${metadata.image}`} alt="" style={{ width: '100%', borderRadius: 14 }} /> : null}
      <p>{metadata?.description}</p>
      <p>{new Date(Number(event.startsAt) * 1000).toLocaleString()}</p>
      {metadata?.venue ? <a href={`https://maps.google.com/?q=${encodeURIComponent(metadata.venue)}`}>{copy.discover.map}</a> : null}
      <ul>{tiers.map((tier) => <li key={tier.id}>{tier.name} · {tier.supply - tier.minted}</li>)}</ul>
      {event.requireKyc ? <span className="badge">{copy.kyc.requiredBadge}</span> : null}
      {event.status === 'Cancelled' ? <p>{copy.discover.cancelled}</p> : (
        <Link to={`/claim/${event.id}`}><Button>{copy.discover.getTicket}</Button></Link>
      )}
      <p><a href={explorer}>{copy.discover.publicRecord}</a></p>
      <Button variant="ghost" onClick={() => void navigator.share?.({ url: window.location.href })}>{copy.discover.share}</Button>
    </Screen>
  );
}
```

`router.tsx`에 `{ path: '/claim/:eventId', element: <Claim /> }`를 `RequireSession` 자식으로 추가한다(Task 21에서 `Claim`을 만든다).

- [ ] **Step 6: 테스트 통과와 커밋**

Run (from `apps/web/`): `pnpm vitest run src/attendee/discover/discover.test.tsx`
Expected: PASS — `Tests  1 passed (1)`.

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI
git add apps/web/src/shared/envio apps/web/src/attendee/discover apps/web/src/router.tsx
git commit -m "feat(attendee): add indexer client, ipfs metadata and event discovery with filters"
```

---

## Task 21: 내 티켓 — 다섯 상태, 목록, 상세, 티켓 받기

**Files:**
- Create: `apps/web/src/attendee/tickets/ticketState.ts`, `useTickets.ts`, `List.tsx`, `Detail.tsx`, `apps/web/src/attendee/claim/Claim.tsx`
- Test: `apps/web/src/attendee/tickets/ticketState.test.ts`, `apps/web/src/attendee/claim/claim.test.tsx`

**Interfaces:**
- Consumes: `gql`, `MY_TICKETS_QUERY`, `sendSponsoredOp`, `ticketAbi`, `getConfig`, `useSession`.
- Produces: `type TicketState = 'before' | 'entered' | 'pendingOffer' | 'transferred' | 'cancelled'`, `deriveTicketState(input)`, `useMyTickets()`, `<TicketList />`, `<TicketDetail />`, `<Claim />`, `<KycRequiredSheet />`.

행사가 `requireKyc`이고 내 `kycLevel === 0`이면 **"티켓 받기"가 시트를 연다** — `copy.kyc.requiredTitle` + `copy.kyc.cta` → `/me/verify?returnTo=/events/:id`. 레벨 1이 되면 같은 버튼이 그대로 받기를 진행한다. 컨트랙트도 같은 규칙을 다시 검사하므로 이 게이트는 사용자 경험용이다.

- [ ] **Step 1: 실패하는 테스트 두 개**

```ts
// apps/web/src/attendee/tickets/ticketState.test.ts
import { describe, expect, it } from 'vitest';
import { deriveTicketState } from './ticketState';

const base = { ownerIsMe: true, revoked: false, checkIn: null, offer: null, now: 1_790_000_000 };

describe('deriveTicketState', () => {
  it('maps every spec state', () => {
    expect(deriveTicketState(base)).toBe('before');
    expect(deriveTicketState({ ...base, revoked: true })).toBe('cancelled');
    expect(deriveTicketState({ ...base, ownerIsMe: false })).toBe('transferred');
    expect(deriveTicketState({ ...base, checkIn: { ts: 1 } })).toBe('entered');
    expect(deriveTicketState({ ...base, offer: { expiresAt: 1_790_000_100, status: 'open' } })).toBe('pendingOffer');
  });

  it('ignores an expired or cancelled offer', () => {
    expect(deriveTicketState({ ...base, offer: { expiresAt: 1_789_999_000, status: 'open' } })).toBe('before');
    expect(deriveTicketState({ ...base, offer: { expiresAt: 1_790_000_100, status: 'cancelled' } })).toBe('before');
  });
});
```

```tsx
// apps/web/src/attendee/claim/claim.test.tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';

const ticketOp = vi.fn(async () => ({ success: true, txHash: '0x2', blockNumber: 1n }));
vi.mock('../../shared/chain/ops', () => ({ ticketOp }));
vi.mock('../../shared/chain/accounts', () => ({ getAttendeeAccount: async () => ({ address: `0x${'ab'.repeat(20)}` }) }));
vi.mock('react-router-dom', async (orig) => ({
  ...(await orig<typeof import('react-router-dom')>()), useParams: () => ({ eventId: '5' }), useNavigate: () => vi.fn(),
}));
vi.mock('../../shared/envio/client', () => ({ gql: async () => ({ Event: [{ id: '5', orgId: '9', requireKyc: true }], Tier: [{ id: '5-0', eventId: '5', name: '일반', supply: 100, minted: 1, maxPerWallet: 2, seated: false }] }) }));
const kycLevel = { value: 1 };
vi.mock('../me/useKycLevel', () => ({ useKycLevel: () => ({ kycLevel: kycLevel.value, isLoading: false, refetch: vi.fn() }) }));

const { Claim } = await import('./Claim');

describe('Claim', () => {
  it('opens the verification sheet instead of claiming when the event requires kyc', async () => {
    kycLevel.value = 0;
    render(<QueryClientProvider client={new QueryClient()}><MemoryRouter><Claim /></MemoryRouter></QueryClientProvider>);
    await userEvent.click(await screen.findByRole('button', { name: '티켓 받기' }));
    expect(await screen.findByText('이 행사는 본인인증이 필요해요')).toBeInTheDocument();
    expect(ticketOp).not.toHaveBeenCalled();
    kycLevel.value = 1;
  });

  it('sends a sponsored claim for the selected tier with the event org id', async () => {
    render(<QueryClientProvider client={new QueryClient()}><MemoryRouter><Claim /></MemoryRouter></QueryClientProvider>);
    await userEvent.click(await screen.findByRole('button', { name: '티켓 받기' }));
    expect(ticketOp).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: 9n, functionName: 'claim', args: [5n, 0, '0x'] }),
    );
  });
});
```

- [ ] **Step 2: 실패 확인**

Run (from `apps/web/`): `pnpm vitest run src/attendee/tickets src/attendee/claim`
Expected: FAIL — `Failed to resolve import "./ticketState"`, `"./Claim"`.

- [ ] **Step 3: 상태 파생과 목록 훅**

```ts
// apps/web/src/attendee/tickets/ticketState.ts
export type TicketState = 'before' | 'entered' | 'pendingOffer' | 'transferred' | 'cancelled';

export interface TicketStateInput {
  ownerIsMe: boolean;
  revoked: boolean;
  checkIn: { ts: number } | null;
  offer: { expiresAt: number; status: string } | null;
  now: number;
}

export function deriveTicketState(input: TicketStateInput): TicketState {
  if (input.revoked) return 'cancelled';
  if (!input.ownerIsMe) return 'transferred';
  if (input.checkIn) return 'entered';
  if (input.offer && input.offer.status === 'open' && input.offer.expiresAt > input.now) return 'pendingOffer';
  return 'before';
}
```

```ts
// apps/web/src/attendee/tickets/useTickets.ts
import { useQuery } from '@tanstack/react-query';
import { gql } from '../../shared/envio/client';
import { MY_TICKETS_QUERY, type EnvioCheckIn, type EnvioOffer, type EnvioTicket } from '../../shared/envio/queries';
import { useSession } from '../../shared/session';
import { deriveTicketState, type TicketState } from './ticketState';

export interface MyTicket { tokenId: string; eventId: string; tier: number; state: TicketState; checkInTs: number | null }

export function useMyTickets() {
  const session = useSession();
  const owner = (session.account ?? '').toLowerCase();
  return useQuery({
    queryKey: ['tickets', owner],
    enabled: Boolean(owner),
    queryFn: async (): Promise<MyTicket[]> => {
      const data = await gql<{ Ticket: EnvioTicket[]; CheckIn: EnvioCheckIn[]; Offer: EnvioOffer[] }>(
        MY_TICKETS_QUERY, { owner },
      );
      const checkIns = new Map(data.CheckIn.map((entry) => [entry.id, entry]));
      const offers = new Map(data.Offer.map((entry) => [entry.id, entry]));
      const now = Math.floor(Date.now() / 1000);
      return data.Ticket.map((ticket) => {
        const checkIn = checkIns.get(ticket.id) ?? null;
        const offer = offers.get(ticket.id) ?? null;
        return {
          tokenId: ticket.id,
          eventId: ticket.eventId,
          tier: ticket.tier,
          checkInTs: checkIn ? Number(checkIn.ts) : null,
          state: deriveTicketState({
            ownerIsMe: ticket.owner.toLowerCase() === owner,
            revoked: ticket.revoked,
            checkIn: checkIn ? { ts: Number(checkIn.ts) } : null,
            offer: offer ? { expiresAt: Number(offer.expiresAt), status: offer.status } : null,
            now,
          }),
        };
      });
    },
  });
}
```

- [ ] **Step 4: 목록과 상세 (FAB "입장하기")**

```tsx
// apps/web/src/attendee/tickets/List.tsx
import { Link } from 'react-router-dom';
import { Screen, Spinner } from '../../shared/ui';
import { useCopy } from '../../shared/i18n';
import { useMyTickets } from './useTickets';
import { Inbox } from './Inbox';
import type { TicketState } from './ticketState';

export function useStateLabel(): Record<TicketState, string> {
  const copy = useCopy();
  return {
    before: copy.tickets.stateBefore, entered: copy.tickets.stateEntered,
    pendingOffer: copy.tickets.statePending, transferred: copy.tickets.stateTransferred,
    cancelled: copy.tickets.stateCancelled,
  };
}

export function TicketList() {
  const copy = useCopy();
  const labels = useStateLabel();
  const { data, isLoading } = useMyTickets();
  return (
    <Screen title={copy.tickets.title}>
      <Inbox />
      {isLoading ? <Spinner /> : null}
      {!isLoading && (data ?? []).length === 0 ? <p>{copy.tickets.empty}</p> : null}
      <ul style={{ listStyle: 'none', padding: 0 }}>
        {(data ?? []).map((ticket) => (
          <li key={ticket.tokenId} style={{ marginBottom: 12 }}>
            <Link to={`/tickets/${ticket.tokenId}`}>#{ticket.tokenId} · {labels[ticket.state]}</Link>
          </li>
        ))}
      </ul>
    </Screen>
  );
}
```

```tsx
// apps/web/src/attendee/tickets/Detail.tsx
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Button, Fab, Screen } from '../../shared/ui';
import { useCopy } from '../../shared/i18n';
import { useMyTickets } from './useTickets';
import { useStateLabel } from './List';

export function TicketDetail() {
  const copy = useCopy();
  const labels = useStateLabel();
  const navigate = useNavigate();
  const { tokenId = '' } = useParams();
  const { data } = useMyTickets();
  const ticket = (data ?? []).find((entry) => entry.tokenId === tokenId);
  if (!ticket) return <Screen title={copy.tickets.title}><p>{copy.common.loading}</p></Screen>;

  return (
    <Screen title={`#${ticket.tokenId}`}>
      <p>{labels[ticket.state]}</p>
      <p>{copy.tickets.detailGuide}</p>
      <p>{copy.tickets.noBarcode}</p>
      <Link to={`/events/${ticket.eventId}`}>{copy.discover.title}</Link>
      {ticket.state === 'before' ? (
        <>
          <Button variant="ghost" onClick={() => navigate(`/tickets/${tokenId}/transfer`)}>{copy.tickets.transfer}</Button>
          <Fab label={copy.tickets.enter} onClick={() => navigate(`/tickets/${tokenId}/enter`)} />
        </>
      ) : null}
    </Screen>
  );
}
```

- [ ] **Step 5: 티켓 받기**

```tsx
// apps/web/src/attendee/claim/Claim.tsx
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Screen, Spinner } from '../../shared/ui';
import { useCopy } from '../../shared/i18n';
import { gql } from '../../shared/envio/client';
import { EVENT_QUERY, type EnvioEvent, type EnvioTier } from '../../shared/envio/queries';
import { ticketOp } from '../../shared/chain/ops';
import { getAttendeeAccount } from '../../shared/chain/accounts';
import { useKycLevel } from '../me/useKycLevel';

/** Shown instead of claiming when the event requires identity verification. */
export function KycRequiredSheet({ eventId, onClose }: { eventId: string; onClose: () => void }) {
  const copy = useCopy();
  const navigate = useNavigate();
  return (
    <div role="dialog" aria-modal="true">
      <h2>{copy.kyc.requiredTitle}</h2>
      <p>{copy.kyc.requiredBody}</p>
      <Button onClick={() => navigate(`/me/verify?returnTo=/events/${eventId}`)}>{copy.kyc.cta}</Button>
      <Button variant="ghost" onClick={onClose}>{copy.common.close}</Button>
    </div>
  );
}

export function Claim() {
  const copy = useCopy();
  const navigate = useNavigate();
  const { eventId = '' } = useParams();
  const { kycLevel } = useKycLevel();
  const [tier, setTier] = useState(0);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [needsKyc, setNeedsKyc] = useState(false);

  const { data } = useQuery({
    queryKey: ['claim', eventId],
    queryFn: () => gql<{ Event: EnvioEvent[]; Tier: EnvioTier[] }>(EVENT_QUERY, { id: eventId }),
  });

  async function run() {
    const event = data?.Event[0];
    if (!event) return;
    if (event.requireKyc && kycLevel < 1) { setNeedsKyc(true); return; }
    setBusy(true);
    setError('');
    try {
      await ticketOp({
        account: await getAttendeeAccount(),
        orgId: BigInt(event.orgId),
        functionName: 'claim',
        args: [BigInt(eventId), tier, '0x'],
      });
      navigate('/tickets');
    } catch {
      setError(copy.claim.failed);
    } finally {
      setBusy(false);
    }
  }

  if (!data) return <Screen><Spinner /></Screen>;
  return (
    <Screen title={copy.claim.cta}>
      <select value={tier} onChange={(event) => setTier(Number(event.target.value))}>
        {data.Tier.map((entry, index) => <option key={entry.id} value={index}>{entry.name}</option>)}
      </select>
      {error ? <Alert tone="error">{error}</Alert> : null}
      {needsKyc ? <KycRequiredSheet eventId={eventId} onClose={() => setNeedsKyc(false)} /> : null}
      <Button onClick={run} disabled={busy}>{busy ? copy.claim.working : copy.claim.cta}</Button>
    </Screen>
  );
}
```

- [ ] **Step 6: 테스트 통과와 커밋**

Run (from `apps/web/`): `pnpm vitest run src/attendee/tickets src/attendee/claim`
Expected: PASS — `Tests  4 passed (4)`.

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI
git add apps/web/src/attendee/tickets apps/web/src/attendee/claim
git commit -m "feat(attendee): derive five ticket states, list, detail and sponsored claim"
```

---

## Task 22: 양도 1 — 세 경로 찾기, 사전 검사, 회원 간 양도

**Files:**
- Create: `apps/web/src/attendee/transfer/Recipient.tsx`, `precheck.ts`, `Confirm.tsx`, `useTransfer.ts`
- Test: `apps/web/src/attendee/transfer/precheck.test.ts`

**Interfaces:**
- Consumes: `api.resolveRecipient`, `readIdentity()`, `readTicket()`, `sendSponsoredOp`, `ticketAbi`, `useCopy()`.
- Produces: `type PrecheckFailure`, `runPrecheck(args): Promise<PrecheckFailure | null>`, `precheckMessage(copy, failure)`, `<TransferRecipient />`, `<TransferConfirm />`, `useTransfer()`.

스펙 §5.4 그대로: 보내기 **전에** 클라이언트가 전부 검사하고 하나라도 걸리면 알람을 띄우고 보내지 않는다. 컨트랙트가 같은 규칙을 다시 검사하므로 이 검사는 사용자 경험용이지 보안 경계가 아니다. 행사가 `requireKyc`이면 받는 사람의 `Identity.kycLevelOf(account) >= 1`도 함께 본다 — 아니면 `copy.kyc.recipientNotVerified`("받는 사람이 본인인증을 하지 않았어요.")로 막는다.

- [ ] **Step 1: 실패하는 테스트**

```ts
// apps/web/src/attendee/transfer/precheck.test.ts
import { describe, expect, it, vi } from 'vitest';

const identity = { isMember: vi.fn(), isLocked: vi.fn(), kycLevelOf: vi.fn() };
const ticket = { eventMeta: vi.fn(), balanceOfEvent: vi.fn(), transfersOf: vi.fn(), checkInOf: vi.fn() };
vi.mock('../../shared/chain/reads', () => ({ readIdentity: () => identity, readTicket: () => ticket }));

const { runPrecheck, precheckMessage } = await import('./precheck');

const ME = `0x${'aa'.repeat(20)}` as const;
const YOU = `0x${'bb'.repeat(20)}` as const;
const meta = {
  transferable: true, transferCutoffSeconds: 3600, maxTransfers: 3,
  startsAt: 1_790_003_600n, orgId: 9n, requireKyc: false,
};

function setup(overrides: Partial<Record<string, unknown>> = {}) {
  identity.isMember.mockResolvedValue(true);
  identity.isLocked.mockResolvedValue(false);
  identity.kycLevelOf.mockResolvedValue(1);
  ticket.eventMeta.mockResolvedValue({ ...meta, ...overrides });
  ticket.balanceOfEvent.mockResolvedValue(0n);
  ticket.transfersOf.mockResolvedValue(0);
  ticket.checkInOf.mockResolvedValue({ gateId: 0n, ts: 0n, nonceHash: `0x${'00'.repeat(32)}`, manual: false });
}

// startsAt - transferCutoffSeconds = 1_790_003_600 - 3600 = 1_790_000_000.
// A transfer is allowed only while now < that instant; the instant itself is already closed.
const BEFORE_CUTOFF = 1_789_999_999;
const AT_CUTOFF = 1_790_000_000;

describe('runPrecheck', () => {
  it('passes a clean member transfer before the cutoff', async () => {
    setup();
    await expect(runPrecheck({ tokenId: 1n, eventId: 5n, from: ME, to: YOU, now: BEFORE_CUTOFF })).resolves.toBeNull();
  });

  it('blocks exactly at the cutoff instant', async () => {
    setup();
    await expect(runPrecheck({ tokenId: 1n, eventId: 5n, from: ME, to: YOU, now: AT_CUTOFF })).resolves.toBe('afterCutoff');
  });

  it('flags every blocking rule from spec 5.4', async () => {
    setup();
    identity.isMember.mockResolvedValueOnce(false);
    await expect(runPrecheck({ tokenId: 1n, eventId: 5n, from: ME, to: YOU, now: BEFORE_CUTOFF })).resolves.toBe('notMember');

    setup(); identity.isLocked.mockResolvedValue(true);
    await expect(runPrecheck({ tokenId: 1n, eventId: 5n, from: ME, to: YOU, now: BEFORE_CUTOFF })).resolves.toBe('locked');

    setup(); ticket.checkInOf.mockResolvedValue({ gateId: 1n, ts: 5n, nonceHash: `0x${'00'.repeat(32)}`, manual: false });
    await expect(runPrecheck({ tokenId: 1n, eventId: 5n, from: ME, to: YOU, now: BEFORE_CUTOFF })).resolves.toBe('alreadyEntered');

    setup({ transferable: false });
    await expect(runPrecheck({ tokenId: 1n, eventId: 5n, from: ME, to: YOU, now: BEFORE_CUTOFF })).resolves.toBe('notTransferable');

    setup(); ticket.transfersOf.mockResolvedValue(3);
    await expect(runPrecheck({ tokenId: 1n, eventId: 5n, from: ME, to: YOU, now: BEFORE_CUTOFF })).resolves.toBe('noTransfersLeft');

    setup(); ticket.balanceOfEvent.mockResolvedValue(2n);
    await expect(runPrecheck({ tokenId: 1n, eventId: 5n, from: ME, to: YOU, now: BEFORE_CUTOFF, maxPerWallet: 2 }))
      .resolves.toBe('maxPerWallet');

    setup();
    await expect(runPrecheck({ tokenId: 1n, eventId: 5n, from: ME, to: ME, now: BEFORE_CUTOFF })).resolves.toBe('self');
  });

  it('maps every failure to attendee copy', () => {
    const copy = { transfer: {
      alertSelf: 'self', alertNotMember: 'notMember', alertLocked: 'locked',
      alertAlreadyEntered: 'entered', alertNotTransferable: 'noTransfer',
      alertAfterCutoff: 'cutoff', alertNoTransfersLeft: 'noneLeft', alertMaxPerWallet: 'maxed',
    }, kyc: { recipientNotVerified: 'notVerified' } } as unknown as Parameters<typeof precheckMessage>[0];
    for (const failure of ['self', 'notMember', 'locked', 'alreadyEntered', 'notTransferable',
      'afterCutoff', 'noTransfersLeft', 'maxPerWallet', 'recipientNotVerified'] as const) {
      expect(precheckMessage(copy, failure)).toBeTruthy();
    }
  });

  it('blocks an unverified recipient on a KYC event', async () => {
    setup({ requireKyc: true });
    identity.kycLevelOf.mockResolvedValue(0);
    await expect(runPrecheck({ tokenId: 1n, eventId: 5n, from: ME, to: YOU, now: BEFORE_CUTOFF }))
      .resolves.toBe('recipientNotVerified');

    setup({ requireKyc: false });
    identity.kycLevelOf.mockResolvedValue(0);
    await expect(runPrecheck({ tokenId: 1n, eventId: 5n, from: ME, to: YOU, now: BEFORE_CUTOFF })).resolves.toBeNull();
  });
});
```

- [ ] **Step 2: 실패 확인**

Run (from `apps/web/`): `pnpm vitest run src/attendee/transfer/precheck.test.ts`
Expected: FAIL — `Failed to resolve import "./precheck"`.

- [ ] **Step 3: 사전 검사**

```ts
// apps/web/src/attendee/transfer/precheck.ts
import type { Hex } from '@monti/shared';
import { readIdentity, readTicket } from '../../shared/chain/reads';
import type { Copy } from '../../shared/copy/index';

export type PrecheckFailure =
  | 'self' | 'notMember' | 'locked' | 'alreadyEntered'
  | 'notTransferable' | 'afterCutoff' | 'noTransfersLeft' | 'maxPerWallet'
  | 'recipientNotVerified';

export interface PrecheckArgs { tokenId: bigint; eventId: bigint; from: Hex; to: Hex; now: number; maxPerWallet?: number }

export async function runPrecheck(args: PrecheckArgs): Promise<PrecheckFailure | null> {
  if (args.to.toLowerCase() === args.from.toLowerCase()) return 'self';

  const identity = readIdentity();
  const ticket = readTicket();

  if (!(await identity.isMember(args.to))) return 'notMember';
  if (await identity.isLocked(args.to)) return 'locked';

  const checkIn = await ticket.checkInOf(args.tokenId);
  if (checkIn.ts > 0n) return 'alreadyEntered';

  const meta = await ticket.eventMeta(args.eventId);
  // Per-event KYC: the contract reverts with KycRequired, so warn before spending a user operation.
  if (meta.requireKyc && (await identity.kycLevelOf(args.to)) < 1) return 'recipientNotVerified';
  if (!meta.transferable) return 'notTransferable';
  // Allowed only while now < startsAt - cutoff. The cutoff instant itself is already closed.
  if (args.now >= Number(meta.startsAt) - meta.transferCutoffSeconds) return 'afterCutoff';
  if ((await ticket.transfersOf(args.tokenId)) >= meta.maxTransfers) return 'noTransfersLeft';

  const limit = args.maxPerWallet ?? 0;
  if (limit > 0 && (await ticket.balanceOfEvent(args.to, args.eventId)) >= BigInt(limit)) return 'maxPerWallet';

  return null;
}

export function precheckMessage(copy: Copy, failure: PrecheckFailure): string {
  const table: Record<PrecheckFailure, string> = {
    self: copy.transfer.alertSelf,
    notMember: copy.transfer.alertNotMember,
    locked: copy.transfer.alertLocked,
    alreadyEntered: copy.transfer.alertAlreadyEntered,
    notTransferable: copy.transfer.alertNotTransferable,
    afterCutoff: copy.transfer.alertAfterCutoff,
    noTransfersLeft: copy.transfer.alertNoTransfersLeft,
    maxPerWallet: copy.transfer.alertMaxPerWallet,
    recipientNotVerified: copy.kyc.recipientNotVerified,
  };
  return table[failure];
}
```

- [ ] **Step 4: 전송 훅과 받는 사람 찾기 화면**

```ts
// apps/web/src/attendee/transfer/useTransfer.ts
import type { Hex } from 'viem';
import { ticketOp } from '../../shared/chain/ops';
import { getAttendeeAccount } from '../../shared/chain/accounts';

export async function sendTransfer(from: Hex, to: Hex, tokenId: bigint, orgId: bigint): Promise<void> {
  await ticketOp({
    account: await getAttendeeAccount(),
    orgId,
    functionName: 'safeTransferFrom',
    args: [from, to, tokenId],
  });
}
```

```tsx
// apps/web/src/attendee/transfer/Recipient.tsx
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Alert, Button, Field, Screen } from '../../shared/ui';
import { useCopy } from '../../shared/i18n';
import { api } from '../../shared/api/functions';
import { toE164 } from '../../shared/api/auth';

export type RecipientRoute = 'nickname' | 'address' | 'phone';

export function TransferRecipient() {
  const copy = useCopy();
  const navigate = useNavigate();
  const { tokenId = '' } = useParams();
  const [route, setRoute] = useState<RecipientRoute>('nickname');
  const [country, setCountry] = useState('+82');
  const [value, setValue] = useState('');
  const [error, setError] = useState('');

  async function find() {
    setError('');
    const payloadValue = route === 'phone' ? toE164(value, country) : value.trim();
    const result = await api.resolveRecipient({ type: route, value: payloadValue });
    if (result.member && result.account) {
      navigate(`/tickets/${tokenId}/transfer/confirm`, { state: { account: result.account, nickname: result.nickname } });
      return;
    }
    if (route === 'phone') {
      navigate(`/tickets/${tokenId}/transfer/invite`, { state: { phoneE164: payloadValue } });
      return;
    }
    setError(copy.transfer.notFound);
  }

  return (
    <Screen title={copy.transfer.title}>
      <div role="tablist" style={{ display: 'flex', gap: 8 }}>
        {(['nickname', 'address', 'phone'] as const).map((key) => (
          <button key={key} type="button" role="tab" aria-selected={route === key}
                  className={`btn ${route === key ? 'btn--primary' : 'btn--ghost'}`} onClick={() => setRoute(key)}>
            {key === 'nickname' ? copy.transfer.byNickname : key === 'address' ? copy.transfer.byAddress : copy.transfer.byPhone}
          </button>
        ))}
      </div>
      {route === 'phone' ? (
        <Field label={copy.transfer.countryCode}>
          <select value={country} onChange={(event) => setCountry(event.target.value)}>
            {['+82', '+1', '+81', '+44', '+49', '+65'].map((code) => <option key={code} value={code}>{code}</option>)}
          </select>
        </Field>
      ) : null}
      <Field label={copy.transfer.title}>
        <input value={value} onChange={(event) => setValue(event.target.value)} />
      </Field>
      {error ? <Alert tone="error">{error}</Alert> : null}
      <Button onClick={find} disabled={value.length === 0}>{copy.transfer.findCta}</Button>
    </Screen>
  );
}
```

- [ ] **Step 5: 확인 화면 (사전 검사 → 유저옵)**

```tsx
// apps/web/src/attendee/transfer/Confirm.tsx
import { useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import type { Hex } from '@monti/shared';
import { Alert, Button, Screen } from '../../shared/ui';
import { useCopy } from '../../shared/i18n';
import { useSession } from '../../shared/session';
import { readTicket } from '../../shared/chain/reads';
import { precheckMessage, runPrecheck } from './precheck';
import { sendTransfer } from './useTransfer';

export function TransferConfirm() {
  const copy = useCopy();
  const navigate = useNavigate();
  const session = useSession();
  const { tokenId = '' } = useParams();
  const { account, nickname } = (useLocation().state ?? {}) as { account?: Hex; nickname?: string };
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function run() {
    if (!account || !session.account) return;
    setBusy(true);
    setError('');
    try {
      const ticket = readTicket();
      const eventId = await ticket.eventOf(BigInt(tokenId));
      const meta = await ticket.eventMeta(eventId);
      const tiers = await ticket.tiers(eventId);
      const tierIndex = await ticket.tierOf(BigInt(tokenId));
      const failure = await runPrecheck({
        tokenId: BigInt(tokenId), eventId, from: session.account, to: account,
        now: Math.floor(Date.now() / 1000), maxPerWallet: tiers[tierIndex]?.maxPerWallet ?? 0,
      });
      if (failure) { setError(precheckMessage(copy, failure)); return; }
      await sendTransfer(session.account, account, BigInt(tokenId), meta.orgId);
      navigate('/tickets');
    } catch {
      setError(copy.common.error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen title={copy.transfer.confirmTitle}>
      <p>{nickname ?? account}</p>
      {error ? <Alert tone="error">{error}</Alert> : null}
      <Button onClick={run} disabled={busy || !account}>{copy.transfer.confirmCta}</Button>
    </Screen>
  );
}
```

`router.tsx`의 `RequireSession` 자식에 두 줄을 더한다:
`{ path: '/tickets/:tokenId/transfer/confirm', element: <TransferConfirm /> }`,
`{ path: '/tickets/:tokenId/transfer/invite', element: <TransferInvite /> }` (Task 23에서 만든다).

- [ ] **Step 6: 테스트 통과와 커밋**

Run (from `apps/web/`): `pnpm vitest run src/attendee/transfer/precheck.test.ts`
Expected: PASS — `Tests  5 passed (5)`.

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI
git add apps/web/src/attendee/transfer apps/web/src/router.tsx
git commit -m "feat(attendee): add three recipient routes, client pre-checks and member transfer"
```

---

## Task 23: 양도 2 — 비회원 전화 초대(오퍼 + 문자)와 받은 티켓함

**Files:**
- Create: `apps/web/src/attendee/transfer/Invite.tsx`, `apps/web/src/attendee/tickets/Inbox.tsx`
- Test: `apps/web/src/attendee/transfer/invite.test.tsx`

**Interfaces:**
- Consumes: `api.createTransferInvite`, `api.pendingOffers`, `sendSponsoredOp`, `ticketAbi` (`createOffer`, `cancelOffer`, `acceptOffer`).
- Produces: `<TransferInvite />`, `<Inbox />`, `acceptPendingOffers(orgIdOf): Promise<number>`.

행사가 `requireKyc`이면 서버가 만들어 주는 `smsText`에 **가입 후 본인인증이 필요하다**는 문장이 들어간다(`copy.kyc.inviteKycNote`와 같은 뜻). 인증하지 않은 상대가 `acceptOffer`를 보내면 컨트랙트가 `KycRequired`로 되돌리므로, 받은 티켓함은 그런 오퍼에 `copy.kyc.offerNeedsKyc`("본인인증 후 받을 수 있어요")를 띄우고 받기 버튼 대신 `/me/verify`로 보낸다.

**문자는 우리가 보내지 않는다.** 서버가 `smsUri`(`sms:+8210…?body=…`)를 만들어 주면 **보내는 사람의 휴대폰 기본 문자 앱**이 열린다. 문자 발송 비용도, 발신번호 사전등록도, 해외 발송 제약도 없앤다. iOS는 `?body=`, Android는 `?body=`가 둘 다 동작하지만 iOS 일부 버전에서 `&body=`를 요구하므로 **서버가 플랫폼 무관하게 동작하는 형태를 주고 클라이언트는 그대로 연다**.

- [ ] **Step 1: 실패하는 테스트**

```tsx
// apps/web/src/attendee/transfer/invite.test.tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

const ticketOp = vi.fn(async () => ({ success: true, txHash: '0x2', blockNumber: 1n }));
vi.mock('../../shared/chain/ops', () => ({ ticketOp }));
vi.mock('../../shared/chain/accounts', () => ({ getAttendeeAccount: async () => ({ address: `0x${'ab'.repeat(20)}` }) }));
vi.mock('../../shared/chain/reads', () => ({
  readTicket: () => ({ eventOf: async () => 5n, eventMeta: async () => ({ orgId: 9n }) }),
}));
vi.mock('../../shared/api/functions', () => ({
  api: {
    createTransferInvite: async () => ({
      inviteId: 'i1', commitment: `0x${'cc'.repeat(32)}`, expiresAt: 1_790_600_000,
      smsText: 'MONTI 티켓 초대', smsUri: 'sms:+821012345678?body=MONTI',
    }),
  },
}));
vi.mock('react-router-dom', async (orig) => ({
  ...(await orig<typeof import('react-router-dom')>()),
  useParams: () => ({ tokenId: '1' }),
  useLocation: () => ({ state: { phoneE164: '+821012345678' } }),
  useNavigate: () => vi.fn(),
}));

const { TransferInvite } = await import('./Invite');

describe('TransferInvite', () => {
  it('creates the on-chain offer then opens the sms composer', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign } as unknown as Location);
    render(<MemoryRouter><TransferInvite /></MemoryRouter>);
    await userEvent.click(screen.getByRole('button', { name: '초대 문자 보내기' }));
    expect(ticketOp).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: 9n, functionName: 'createOffer', args: [1n, `0x${'cc'.repeat(32)}`, 1790600000n] }),
    );
    expect(assign).toHaveBeenCalledWith('sms:+821012345678?body=MONTI');
    expect(await screen.findByText('초대를 보냈어요. 상대가 가입하면 티켓이 자동으로 전달됩니다.')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 실패 확인**

Run (from `apps/web/`): `pnpm vitest run src/attendee/transfer/invite.test.tsx`
Expected: FAIL — `Failed to resolve import "./Invite"`.

- [ ] **Step 3: 초대 화면**

```tsx
// apps/web/src/attendee/transfer/Invite.tsx
import { useState } from 'react';
import { useLocation, useParams } from 'react-router-dom';
import { Alert, Button, Screen } from '../../shared/ui';
import { useCopy } from '../../shared/i18n';
import { api } from '../../shared/api/functions';
import { readTicket } from '../../shared/chain/reads';
import { ticketOp } from '../../shared/chain/ops';
import { getAttendeeAccount } from '../../shared/chain/accounts';

export function TransferInvite() {
  const copy = useCopy();
  const { tokenId = '' } = useParams();
  const { phoneE164 } = (useLocation().state ?? {}) as { phoneE164?: string };
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function run() {
    if (!phoneE164) return;
    setBusy(true);
    setError('');
    try {
      const invite = await api.createTransferInvite({ tokenId, phoneE164 });
      const ticket = readTicket();
      const eventId = await ticket.eventOf(BigInt(tokenId));
      const meta = await ticket.eventMeta(eventId);
      // sendOp throws on revert, so the SMS composer only opens once the offer is really on chain.
      await ticketOp({
        account: await getAttendeeAccount(),
        orgId: meta.orgId,
        functionName: 'createOffer',
        args: [BigInt(tokenId), invite.commitment, BigInt(invite.expiresAt)],
      });
      setSent(true);
      location.assign(invite.smsUri); // the sender's own phone sends the text
    } catch {
      setError(copy.common.error);
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    setError('');
    try {
      const ticket = readTicket();
      const eventId = await ticket.eventOf(BigInt(tokenId));
      const meta = await ticket.eventMeta(eventId);
      await ticketOp({
        account: await getAttendeeAccount(),
        orgId: meta.orgId,
        functionName: 'cancelOffer',
        args: [BigInt(tokenId)],
      });
      setSent(false);
    } catch {
      setError(copy.common.error);
    }
  }

  return (
    <Screen title={copy.transfer.inviteTitle}>
      <p>{copy.transfer.inviteBody}</p>
      {error ? <Alert tone="error">{error}</Alert> : null}
      {sent ? (
        <>
          <Alert tone="info">{copy.transfer.inviteSent}</Alert>
          <Button variant="ghost" onClick={cancel}>{copy.transfer.inviteCancel}</Button>
        </>
      ) : (
        <Button onClick={run} disabled={busy || !phoneE164}>{copy.transfer.inviteCta}</Button>
      )}
    </Screen>
  );
}
```

- [ ] **Step 4: 받은 티켓함**

```tsx
// apps/web/src/attendee/tickets/Inbox.tsx
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Alert, Button } from '../../shared/ui';
import { useCopy } from '../../shared/i18n';
import { useKycLevel } from '../me/useKycLevel';
import { api } from '../../shared/api/functions';
import { readTicket } from '../../shared/chain/reads';
import { ticketOp } from '../../shared/chain/ops';
import { getAttendeeAccount } from '../../shared/chain/accounts';

/** Called right after signup finishes and whenever the inbox is opened. */
export async function acceptPendingOffers(): Promise<number> {
  const offers = await api.pendingOffers();
  const ticket = readTicket();
  const account = await getAttendeeAccount();
  let accepted = 0;
  for (const offer of offers) {
    const eventId = await ticket.eventOf(BigInt(offer.tokenId));
    const meta = await ticket.eventMeta(eventId);
    // One reverting offer must not abort the rest of the inbox.
    try {
      await ticketOp({ account, orgId: meta.orgId, functionName: 'acceptOffer', args: [BigInt(offer.tokenId), offer.attesterSig] });
      accepted += 1;
    } catch {
      /* KycRequired or an expired offer: leave it in the inbox */
    }
  }
  return accepted;
}

export function Inbox() {
  const copy = useCopy();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { kycLevel } = useKycLevel();
  const { data } = useQuery({ queryKey: ['pendingOffers'], queryFn: () => api.pendingOffers() });
  const offers = data ?? [];
  if (offers.length === 0) return null;

  // acceptOffer reverts with KycRequired on a verification-gated event, so send them to /me/verify first.
  if (kycLevel < 1) {
    return (
      <section>
        <h2>{copy.tickets.inbox}</h2>
        <Alert tone="warn">{copy.kyc.offerNeedsKyc}</Alert>
        <Button onClick={() => navigate('/me/verify?returnTo=/tickets')}>{copy.kyc.cta}</Button>
      </section>
    );
  }

  return (
    <section>
      <h2>{copy.tickets.inbox}</h2>
      <Alert tone="info">{offers.length}</Alert>
      <Button
        onClick={async () => {
          await acceptPendingOffers();
          await queryClient.invalidateQueries({ queryKey: ['pendingOffers'] });
          await queryClient.invalidateQueries({ queryKey: ['tickets'] });
        }}
      >
        {copy.transfer.accept}
      </Button>
    </section>
  );
}
```

`Done.tsx`의 이동 직전에 `void acceptPendingOffers().catch(() => undefined);`를 넣어, 가입을 막 끝낸 사람이 초대받은 티켓을 자동으로 받게 한다.

- [ ] **Step 5: 테스트 통과와 커밋**

Run (from `apps/web/`): `pnpm vitest run src/attendee/transfer`
Expected: PASS — `Test Files  2 passed (2)`.

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI
git add apps/web/src/attendee/transfer/Invite.tsx apps/web/src/attendee/tickets/Inbox.tsx apps/web/src/attendee/signup/Done.tsx
git commit -m "feat(attendee): add phone invite offers, sms composer handoff and received-ticket inbox"
```

---

## Task 24: 입장 1 — 무장, 60초 카운트다운, 게이트 진위 확인

**Files:**
- Create: `apps/web/src/attendee/enter/verifyGate.ts`, `useArm.ts`, `Enter.tsx`
- Test: `apps/web/src/attendee/enter/verifyGate.test.ts`

**Interfaces:**
- Consumes: `armDeviceKey({ alias: ATTENDEE_KEY_ALIAS })`, `readOrganizers()`, `readGateCode()`, `nfcCapability()`, `Countdown`.
- Produces: `gateCodeDigest(wire): Hex`, `verifyGateSignature(wire): boolean`, `verifyGateRegistered(wire): Promise<boolean>`, `type EnterPhase = 'idle' | 'arming' | 'armed' | 'reading' | 'verifying' | 'signing' | 'writing' | 'qr' | 'waiting' | 'done' | 'failed'`, `useArm(tokenId)`, `<Enter />`.

스펙 §7.2 3단계: 폰은 서명을 돌려주기 **전에** 그 게이트가 체인 allowlist에 있는지 확인한다(위협 T14 가짜 게이트). 확인은 두 겹이다 — ① `sig_gate`가 `Organizers.gateInfo(gateId)`의 `kx, ky`로 검증되는가(브라우저에서 `@noble/curves` P-256), ② 게이트가 열려 있고 폐기되지 않았고 `eventId`가 맞는가. 관객 폰이 인터넷이 없으면 ②는 마지막으로 캐시된 `GateRegistered` 값으로 판단한다(캐시는 `GateRegistered` 구독으로 갱신).

- [ ] **Step 1: 실패하는 테스트**

```ts
// apps/web/src/attendee/enter/verifyGate.test.ts
import { describe, expect, it, vi } from 'vitest';
import { p256 } from '@noble/curves/p256';
import { bytesToHex } from 'viem';
import type { GateCodeWire } from '@monti/shared';

const gateInfo = vi.fn();
vi.mock('../../shared/chain/reads', () => ({ readOrganizers: () => ({ gateInfo }) }));

const { gateCodeDigest, verifyGateRegistered, verifyGateSignature } = await import('./verifyGate');

const privateKey = p256.utils.randomPrivateKey();
const publicKey = p256.getPublicKey(privateKey, false); // 0x04 || x || y

function signedGateCode(): GateCodeWire {
  const wire: GateCodeWire = {
    v: 1, gateId: '7', eventId: '3', issuedAt: 1_790_000_000,
    nonce: `0x${'5a'.repeat(32)}`,
    kx: bytesToHex(publicKey.slice(1, 33)), ky: bytesToHex(publicKey.slice(33)),
    sig: '0x',
  };
  const digest = gateCodeDigest(wire);
  const signature = p256.sign(digest.slice(2), privateKey, { prehash: false });
  return { ...wire, sig: `0x${signature.toCompactHex()}` };
}

describe('gate verification', () => {
  it('accepts a signature made by the gate key in the payload', () => {
    expect(verifyGateSignature(signedGateCode())).toBe(true);
  });

  it('rejects a forged signature', () => {
    const wire = signedGateCode();
    expect(verifyGateSignature({ ...wire, sig: `0x${'11'.repeat(64)}` })).toBe(false);
  });

  it('rejects a gate whose on-chain key, event or open flag does not match', async () => {
    const wire = signedGateCode();
    gateInfo.mockResolvedValueOnce({ eventId: 3n, account: `0x${'bb'.repeat(20)}`, kx: wire.kx, ky: wire.ky, open: true, revoked: false });
    await expect(verifyGateRegistered(wire)).resolves.toBe(true);
    gateInfo.mockResolvedValueOnce({ eventId: 3n, account: `0x${'bb'.repeat(20)}`, kx: wire.kx, ky: wire.ky, open: false, revoked: false });
    await expect(verifyGateRegistered(wire)).resolves.toBe(false);
    gateInfo.mockResolvedValueOnce({ eventId: 9n, account: `0x${'bb'.repeat(20)}`, kx: wire.kx, ky: wire.ky, open: true, revoked: false });
    await expect(verifyGateRegistered(wire)).resolves.toBe(false);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run (from `apps/web/`): `pnpm vitest run src/attendee/enter/verifyGate.test.ts`
Expected: FAIL — `Failed to resolve import "./verifyGate"`.

- [ ] **Step 3: 게이트 검증**

```ts
// apps/web/src/attendee/enter/verifyGate.ts
import { p256 } from '@noble/curves/p256';
import { encodeAbiParameters, sha256, type Hex } from 'viem';
import type { GateCodeWire } from '@monti/shared';
import { readOrganizers } from '../../shared/chain/reads';

/** Matches the gate device signature input: sha256(abi.encode(gateId, eventId, issuedAt, nonce)). */
export function gateCodeDigest(wire: GateCodeWire): Hex {
  return sha256(
    encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint64' }, { type: 'bytes32' }],
      [BigInt(wire.gateId), BigInt(wire.eventId), BigInt(wire.issuedAt), wire.nonce],
    ),
  );
}

const strip = (hex: Hex) => hex.slice(2).padStart(64, '0');

export function verifyGateSignature(wire: GateCodeWire): boolean {
  try {
    const publicKey = `04${strip(wire.kx)}${strip(wire.ky)}`;
    return p256.verify(wire.sig.slice(2), gateCodeDigest(wire).slice(2), publicKey, { prehash: false });
  } catch {
    return false;
  }
}

/** Second layer: the gate must be on the chain allowlist, open, unrevoked and for this event. */
export async function verifyGateRegistered(wire: GateCodeWire): Promise<boolean> {
  const info = await readOrganizers().gateInfo(BigInt(wire.gateId));
  if (info.revoked || !info.open) return false;
  if (info.eventId !== BigInt(wire.eventId)) return false;
  return (
    info.kx.toLowerCase() === (`0x${strip(wire.kx)}` as string).toLowerCase() &&
    info.ky.toLowerCase() === (`0x${strip(wire.ky)}` as string).toLowerCase()
  );
}

/** Offline attendees fall back to the cached GateRegistered value. */
export function cacheGate(wire: GateCodeWire): void {
  localStorage.setItem(`monti.gate.${wire.gateId}`, JSON.stringify({ kx: wire.kx, ky: wire.ky, eventId: wire.eventId }));
}

export function cachedGateMatches(wire: GateCodeWire): boolean {
  const raw = localStorage.getItem(`monti.gate.${wire.gateId}`);
  if (!raw) return false;
  const cached = JSON.parse(raw) as { kx: string; ky: string; eventId: string };
  return cached.kx === wire.kx && cached.ky === wire.ky && cached.eventId === wire.eventId;
}
```

- [ ] **Step 4: 무장 훅**

```ts
// apps/web/src/attendee/enter/useArm.ts
import { useCallback, useState } from 'react';
import { ARM_WINDOW_SECONDS, ATTENDEE_KEY_ALIAS, DeviceKeyUnavailable, armDeviceKey } from '../../shared/deviceKey';

export type EnterPhase =
  | 'idle' | 'arming' | 'armed' | 'reading' | 'verifying' | 'signing'
  | 'writing' | 'qr' | 'waiting' | 'done' | 'failed';

export interface ArmState { phase: EnterPhase; error: string; armedAt: number }

export function useArm() {
  const [state, setState] = useState<ArmState>({ phase: 'idle', error: '', armedAt: 0 });

  const arm = useCallback(async (): Promise<boolean> => {
    setState({ phase: 'arming', error: '', armedAt: 0 });
    try {
      await armDeviceKey({ alias: ATTENDEE_KEY_ALIAS });
      setState({ phase: 'armed', error: '', armedAt: Date.now() });
      return true;
    } catch (cause) {
      setState({
        phase: cause instanceof DeviceKeyUnavailable ? 'qr' : 'failed',
        error: cause instanceof DeviceKeyUnavailable ? 'deviceUnavailable' : 'failed',
        armedAt: 0,
      });
      return false;
    }
  }, []);

  return { state, setState, arm, windowSeconds: ARM_WINDOW_SECONDS };
}
```

- [ ] **Step 5: 입장 화면 (카운트다운까지)**

```tsx
// apps/web/src/attendee/enter/Enter.tsx
import { useState } from 'react';
import { useParams } from 'react-router-dom';
import type { GateCodeWire } from '@monti/shared';
import { Alert, Button, Countdown, Screen, Spinner } from '../../shared/ui';
import { fmt, useCopy } from '../../shared/i18n';
import { nfcCapability, readGateCode } from '../../shared/nfc';
import { useArm } from './useArm';
import { cacheGate, cachedGateMatches, verifyGateRegistered, verifyGateSignature } from './verifyGate';
import { handOverSignature } from './buildResponse';
import { Qr } from './Qr';

export function Enter() {
  const copy = useCopy();
  const { tokenId = '' } = useParams();
  const { state, setState, arm, windowSeconds } = useArm();
  const [gateCode, setGateCode] = useState<GateCodeWire | null>(null);

  async function start() {
    if (!(await arm())) return;
    if (nfcCapability() === 'none') { setState((prev) => ({ ...prev, phase: 'qr' })); return; }
    setState((prev) => ({ ...prev, phase: 'reading' }));
    try {
      const wire = await readGateCode();
      setGateCode(wire);
      setState((prev) => ({ ...prev, phase: 'verifying' }));
      if (!verifyGateSignature(wire)) { setState((prev) => ({ ...prev, phase: 'failed', error: 'unknownGate' })); return; }
      const registered = await verifyGateRegistered(wire).catch(() => cachedGateMatches(wire));
      if (!registered) { setState((prev) => ({ ...prev, phase: 'failed', error: 'unknownGate' })); return; }
      cacheGate(wire);
      await handOverSignature({ tokenId, gateCode: wire, setState });
    } catch {
      setState((prev) => ({ ...prev, phase: 'qr' }));
    }
  }

  const secondsLeft = state.armedAt
    ? Math.max(0, windowSeconds - Math.floor((Date.now() - state.armedAt) / 1000))
    : windowSeconds;

  return (
    <Screen title={copy.enter.cta}>
      {state.phase === 'idle' ? <Button onClick={start}>{copy.enter.cta}</Button> : null}
      {state.phase === 'arming' ? <><Spinner /><p>{copy.enter.arming}</p></> : null}
      {['armed', 'reading', 'verifying', 'signing', 'writing'].includes(state.phase) ? (
        <>
          <Countdown seconds={secondsLeft} onExpire={() => setState((prev) => ({ ...prev, phase: 'idle', armedAt: 0 }))} />
          <p>{fmt(copy.enter.armed, { seconds: secondsLeft })}</p>
          <p>{copy.enter.tapGuide}</p>
        </>
      ) : null}
      {state.phase === 'qr' ? <Qr tokenId={tokenId} gateCode={gateCode} /> : null}
      {state.phase === 'failed' ? (
        <Alert tone="error">{state.error === 'unknownGate' ? copy.enter.unknownGate : copy.common.error}</Alert>
      ) : null}
    </Screen>
  );
}
```

- [ ] **Step 6: 테스트 통과와 커밋**

Run (from `apps/web/`): `pnpm vitest run src/attendee/enter/verifyGate.test.ts`
Expected: PASS — `Tests  3 passed (3)`.

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI
git add apps/web/src/attendee/enter
git commit -m "feat(attendee): arm the device key, count down 60s and verify the gate on chain"
```

---

## Task 25: 입장 2 — 기기 키 서명, NFC 쓰기, QR 폴백

**Files:**
- Create: `apps/web/src/attendee/enter/buildResponse.ts`, `Qr.tsx`
- Test: `apps/web/src/attendee/enter/buildResponse.test.ts`

**Interfaces:**
- Consumes: `signWithDeviceKey(digest, { alias })`, `writeGateResponse`, `gateResponseToQr`, `nfcCapability`.
- Produces: `deviceSigDigest({ tokenId, gateId, eventId, nonce, issuedAt }): Hex`, `buildGateResponse(tokenId, gateCode): Promise<GateResponseWire>`, `handOverSignature({ tokenId, gateCode, setState }): Promise<void>`, `<Qr />`.

다이제스트는 컨트랙트와 **바이트 단위로 같아야** 한다: `sha256(abi.encode(tokenId, gateId, eventId, nonce, issuedAt))`, 타입은 `uint256, uint256, uint256, bytes32, uint64`. 여기가 어긋나면 `checkIn`이 조용히 되돌려진다. 서명 실패나 쓰기 실패는 전부 **QR 폴백**으로 떨어진다(스펙 §12).

- [ ] **Step 1: 실패하는 테스트**

```ts
// apps/web/src/attendee/enter/buildResponse.test.ts
import { describe, expect, it, vi } from 'vitest';
import { encodeAbiParameters, sha256 } from 'viem';
import type { GateCodeWire } from '@monti/shared';

const signWithDeviceKey = vi.fn(async () => ({ r: `0x${'aa'.repeat(32)}`, s: `0x${'bb'.repeat(32)}` }));
vi.mock('../../shared/deviceKey', () => ({ signWithDeviceKey, ATTENDEE_KEY_ALIAS: 'monti-attendee' }));

const { buildGateResponse, deviceSigDigest } = await import('./buildResponse');

const gateCode: GateCodeWire = {
  v: 1, gateId: '7', eventId: '3', issuedAt: 1_790_000_000,
  nonce: `0x${'5a'.repeat(32)}`, kx: `0x${'01'.repeat(32)}`, ky: `0x${'02'.repeat(32)}`, sig: `0x${'03'.repeat(64)}`,
};

describe('buildGateResponse', () => {
  it('hashes exactly what Ticket.checkIn hashes', () => {
    const expected = sha256(
      encodeAbiParameters(
        [{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bytes32' }, { type: 'uint64' }],
        [42n, 7n, 3n, gateCode.nonce, 1_790_000_000n],
      ),
    );
    expect(deviceSigDigest({ tokenId: '42', gateCode })).toBe(expected);
  });

  it('signs with the attendee alias and concatenates r||s into 64 bytes', async () => {
    const wire = await buildGateResponse('42', gateCode);
    expect(signWithDeviceKey).toHaveBeenCalledWith(deviceSigDigest({ tokenId: '42', gateCode }), { alias: 'monti-attendee' });
    expect(wire).toEqual({ v: 1, tokenId: '42', deviceSig: `0x${'aa'.repeat(32)}${'bb'.repeat(32)}` });
    expect(wire.deviceSig).toHaveLength(2 + 128);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run (from `apps/web/`): `pnpm vitest run src/attendee/enter/buildResponse.test.ts`
Expected: FAIL — `Failed to resolve import "./buildResponse"`.

- [ ] **Step 3: 응답 조립과 전달**

```ts
// apps/web/src/attendee/enter/buildResponse.ts
import { encodeAbiParameters, sha256, type Hex } from 'viem';
import type { GateCodeWire, GateResponseWire } from '@monti/shared';
import { ATTENDEE_KEY_ALIAS, signWithDeviceKey } from '../../shared/deviceKey';
import { writeGateResponse } from '../../shared/nfc';
import type { ArmState } from './useArm';

/** Byte-identical to Ticket.checkIn: sha256(abi.encode(tokenId, gateId, eventId, nonce, issuedAt)). */
export function deviceSigDigest({ tokenId, gateCode }: { tokenId: string; gateCode: GateCodeWire }): Hex {
  return sha256(
    encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bytes32' }, { type: 'uint64' }],
      [BigInt(tokenId), BigInt(gateCode.gateId), BigInt(gateCode.eventId), gateCode.nonce, BigInt(gateCode.issuedAt)],
    ),
  );
}

export async function buildGateResponse(tokenId: string, gateCode: GateCodeWire): Promise<GateResponseWire> {
  const { r, s } = await signWithDeviceKey(deviceSigDigest({ tokenId, gateCode }), { alias: ATTENDEE_KEY_ALIAS });
  return { v: 1, tokenId, deviceSig: `0x${r.slice(2).padStart(64, '0')}${s.slice(2).padStart(64, '0')}` as Hex };
}

export async function handOverSignature({
  tokenId, gateCode, setState,
}: {
  tokenId: string;
  gateCode: GateCodeWire;
  setState: (updater: (prev: ArmState) => ArmState) => void;
}): Promise<void> {
  setState((prev) => ({ ...prev, phase: 'signing' }));
  const wire = await buildGateResponse(tokenId, gateCode);
  setState((prev) => ({ ...prev, phase: 'writing' }));
  try {
    await writeGateResponse(wire);
    if (navigator.vibrate) navigator.vibrate(60); // spec 7.2 step 4: one buzz, the phone is done
    setState((prev) => ({ ...prev, phase: 'waiting' }));
  } catch {
    setState((prev) => ({ ...prev, phase: 'qr' }));
  }
}
```

- [ ] **Step 4: QR 폴백 화면**

```tsx
// apps/web/src/attendee/enter/Qr.tsx
import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import type { GateCodeWire } from '@monti/shared';
import { Alert, Screen, Spinner } from '../../shared/ui';
import { useCopy } from '../../shared/i18n';
import { gateResponseToQr } from '../../shared/nfc';
import { buildGateResponse } from './buildResponse';

export function Qr({ tokenId, gateCode }: { tokenId: string; gateCode: GateCodeWire | null }) {
  const copy = useCopy();
  const [dataUrl, setDataUrl] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!gateCode) { setError(copy.enter.deviceUnavailable); return; }
    void buildGateResponse(tokenId, gateCode)
      .then((wire) => QRCode.toDataURL(gateResponseToQr(wire), { width: 320, margin: 1 }))
      .then(setDataUrl)
      .catch(() => setError(copy.enter.deviceUnavailable));
  }, [tokenId, gateCode, copy.enter.deviceUnavailable]);

  if (error) return <Alert tone="warn">{error}</Alert>;
  if (!dataUrl) return <Spinner />;
  return (
    <>
      <p>{copy.enter.qrTitle}</p>
      <img src={dataUrl} alt={copy.enter.qrTitle} style={{ width: '100%', maxWidth: 320, margin: '0 auto', display: 'block' }} />
    </>
  );
}
```

> `Qr`는 `Screen` 안에서 쓰이므로 자체 `Screen`을 만들지 않는다. `Enter.tsx`가 이미 감싸고 있다. 위 import에서 `Screen`은 쓰지 않으므로 지운다(타입 검사에서 걸린다).

- [ ] **Step 5: 테스트 통과, 타입 검사, 커밋**

Run (from `apps/web/`): `pnpm vitest run src/attendee/enter`
Expected: PASS — `Test Files  2 passed (2)`, `Tests  5 passed (5)`.

Run (from `apps/web/`): `pnpm typecheck`
Expected: 출력 없음. `Qr.tsx`에서 `Screen`을 지우지 않았다면 `'Screen' is declared but its value is never read` 가 나온다.

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI
git add apps/web/src/attendee/enter
git commit -m "feat(attendee): sign the gate digest, write it back over nfc and fall back to qr"
```

---

## Task 26: 입장 3 — 결과 화면 (체인 구독 + FCM 푸시)

**Files:**
- Create: `apps/web/src/attendee/enter/Result.tsx`
- Modify: `apps/web/src/attendee/enter/Enter.tsx` (waiting 단계에서 `Result` 렌더)
- Test: `apps/web/src/attendee/enter/result.test.tsx`

**Interfaces:**
- Consumes: `subscribeLogs({ address, topics, onLog })` (Task 8), `registerPush` (Task 16), `readTicket().checkInOf`, `ticketAbi`.
- Produces: `checkedInTopics(tokenId): (Hex | Hex[] | null)[]`, `<Result tokenId />`.

`ChainLog.stage`를 **실제로 읽는다.** `'speculative'`가 오면 즉시 초록을 켜되 아직 굳지 않았음을 표시하고(`data-stage`), `'finalized'`가 오면 굳힌다. 한 번 `finalized`가 되면 늦게 도착한 speculative 로그가 되돌리지 못한다. 스펙 §7.2 8단계의 "추측 단계에서 켜고 확정되면 굳힌다"가 이 두 전이다.

관객 화면의 초록은 **참고용**이다(스펙 §3 원칙 4). 근거는 스태프 화면과 체인이다. 그래서 결과는 세 경로 중 먼저 오는 것으로 켠다: ① `CheckedIn` 로그 구독(`stage: 'speculative'`면 즉시 표시), ② FCM 푸시(`tenderlyWebhook`이 보냄), ③ 3초 간격 `checkInOf` 폴링(둘 다 실패할 때). 비행기 모드였다면 ①②는 오지 않고, 인터넷이 돌아온 뒤 ③이 켠다.

- [ ] **Step 1: 실패하는 테스트**

```tsx
// apps/web/src/attendee/enter/result.test.tsx
import { render, screen } from '@testing-library/react';
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { ChainLog } from '../../shared/chain/subscribeLogs';

let emit: ((log: ChainLog) => void) | undefined;
vi.mock('../../shared/chain/subscribeLogs', () => ({
  subscribeLogs: ({ onLog }: { onLog: (log: ChainLog) => void }) => { emit = onLog; return () => undefined; },
}));
vi.mock('../../shared/push', () => ({ registerPush: async () => () => undefined }));
vi.mock('../../shared/chain/reads', () => ({ readTicket: () => ({ checkInOf: async () => ({ ts: 0n }) }) }));
vi.mock('../../shared/config', () => ({ getConfig: () => ({ addresses: { ticket: `0x${'33'.repeat(20)}` } }) }));
vi.mock('../../shared/session', () => ({ useSession: () => ({ status: 'signedIn', account: `0x${'ab'.repeat(20)}` }) }));

const { Result } = await import('./Result');

describe('Result', () => {
  it('shows the result on the speculative log and settles it on the finalized one', async () => {
    render(<Result tokenId="42" />);
    expect(screen.getByText('확인하고 있어요')).toBeInTheDocument();

    // Stage 1 (~0.7 s): speculative — show the green, flagged as still settling.
    act(() => emit?.({ stage: 'speculative', transactionHash: '0xa', logIndex: 0 } as unknown as ChainLog));
    expect(await screen.findByText('입장 완료')).toBeInTheDocument();
    expect(screen.getByTestId('entry-result')).toHaveAttribute('data-stage', 'speculative');

    // Stage 2 (~1.3 s): finalized — same green, hardened.
    act(() => emit?.({ stage: 'finalized', transactionHash: '0xa', logIndex: 0 } as unknown as ChainLog));
    expect(screen.getByTestId('entry-result')).toHaveAttribute('data-stage', 'finalized');
  });

  it('does not downgrade a finalized result back to speculative', async () => {
    render(<Result tokenId="42" />);
    act(() => emit?.({ stage: 'finalized', transactionHash: '0xb', logIndex: 0 } as unknown as ChainLog));
    expect(await screen.findByTestId('entry-result')).toHaveAttribute('data-stage', 'finalized');
    act(() => emit?.({ stage: 'speculative', transactionHash: '0xb', logIndex: 0 } as unknown as ChainLog));
    expect(screen.getByTestId('entry-result')).toHaveAttribute('data-stage', 'finalized');
  });
});
```

- [ ] **Step 2: 실패 확인**

Run (from `apps/web/`): `pnpm vitest run src/attendee/enter/result.test.tsx`
Expected: FAIL — `Failed to resolve import "./Result"`.

- [ ] **Step 3: 구현**

```tsx
// apps/web/src/attendee/enter/Result.tsx
import { useEffect, useState } from 'react';
import { encodeEventTopics, numberToHex, type Hex } from 'viem';
import { Alert, Spinner } from '../../shared/ui';
import { useCopy } from '../../shared/i18n';
import { ticketAbi } from '../../shared/chain/abis';
import { subscribeLogs } from '../../shared/chain/subscribeLogs';
import { readTicket } from '../../shared/chain/reads';
import { getConfig } from '../../shared/config';
import { registerPush } from '../../shared/push';
import { useSession } from '../../shared/session';

export function checkedInTopics(tokenId: string): (Hex | Hex[] | null)[] {
  const [signature] = encodeEventTopics({ abi: ticketAbi, eventName: 'CheckedIn' });
  return [signature as Hex, numberToHex(BigInt(tokenId), { size: 32 }), null, null];
}

type ResultStage = 'waiting' | 'speculative' | 'finalized';

export function Result({ tokenId }: { tokenId: string }) {
  const copy = useCopy();
  const session = useSession();
  const [stage, setStage] = useState<ResultStage>('waiting');

  // Spec 7.2 step 8: light up on the speculative log (~0.7 s), harden on the finalized one
  // (~1.3 s). Never step backwards — a late speculative log must not undo a finalized one.
  const advance = (next: Exclude<ResultStage, 'waiting'>) =>
    setStage((current) => (current === 'finalized' ? current : next));

  useEffect(() => {
    if (stage === 'finalized') return;
    const stopLogs = subscribeLogs({
      address: getConfig().addresses.ticket,
      topics: checkedInTopics(tokenId),
      onLog: (log) => advance(log.stage),
    });

    let stopPush = () => undefined as void;
    if (session.account) {
      // The push arrives from tenderlyWebhook, which fires on a finalized event.
      void registerPush(session.account, (data) => {
        if (data.tokenId === tokenId) advance('finalized');
      }).then((remove) => { stopPush = remove; });
    }

    // Last resort for an attendee who was offline during the tap.
    const poll = setInterval(() => {
      void readTicket().checkInOf(BigInt(tokenId))
        .then((checkIn) => { if (checkIn.ts > 0n) advance('finalized'); })
        .catch(() => undefined);
    }, 3_000);

    return () => { stopLogs(); stopPush(); clearInterval(poll); };
  }, [tokenId, stage, session.account]);

  if (stage === 'waiting') {
    return (
      <>
        <Spinner />
        <p>{copy.enter.resultWaiting}</p>
      </>
    );
  }
  return (
    <div data-testid="entry-result" data-stage={stage}>
      <Alert tone="info">{copy.enter.done}</Alert>
      {stage === 'speculative' ? <p>{copy.enter.resultWaiting}</p> : null}
    </div>
  );
}
```

`Enter.tsx`의 렌더 목록에 한 줄을 더한다:

```tsx
      {state.phase === 'waiting' ? <Result tokenId={tokenId} /> : null}
```

그리고 파일 맨 위에 `import { Result } from './Result';`를 추가한다.

- [ ] **Step 4: 테스트 통과 확인**

Run (from `apps/web/`): `pnpm vitest run src/attendee/enter`
Expected: PASS — `Test Files  3 passed (3)`, `Tests  7 passed (7)`.

- [ ] **Step 5: 입장 경로 전체의 금지어와 타입 검사**

입장 화면은 관객이 가장 오래 보는 화면이라 금지어가 새어 들어가기 쉽다.

Run (from repo root): `pnpm lint:copy`
Expected: `copy-lint: clean`.

Run (from `apps/web/`): `pnpm typecheck`
Expected: 출력 없음. `Enter.tsx`에 `Result` import를 안 더했다면 `Cannot find name 'Result'` 가 나온다.

- [ ] **Step 6: 커밋**

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI
git add apps/web/src/attendee/enter
git commit -m "feat(attendee): show entry result from chain logs, push and polling"
```

---

## Task 27: 프로필 `/me` — 별명, 언어, 기기 잠금, 새 기기, 삭제 요청

**Files:**
- Create: `apps/web/src/attendee/me/Profile.tsx`, `Nickname.tsx`, `DeviceLock.tsx`, `NewDevice.tsx`
- Test: `apps/web/src/attendee/me/nickname.test.tsx`

**Interfaces:**
- Consumes: `identityAbi.setNickname`, `readIdentity().nicknameOwner/deviceUpdatedAt/isLocked`, `api.lockDevice`, `api.startDeviceChange`, `api.requestAccountDeletion`, `setLocale`, `saveUserProfile`.
- Produces: `normalizeNickname(input): string | null`, `<Profile />`, `<Nickname />`, `<DeviceLock />`, `<NewDevice />`, `<KycStatus />`. 프로필은 `useKycLevel()`(Task 18)로 **인증 상태**를 보여주고 미인증이면 `/me/verify` 버튼을 띄운다.

별명 규칙: 소문자 영문·숫자·밑줄 3~20자. 체인은 `setNickname(keccak256(bytes(name)), name)`으로 유일성을 강제하고, 클라이언트는 보내기 전에 `nicknameOwner(hash)`가 0인지 확인해 `NicknameTaken` 되돌림을 미리 막는다. 기기 정책은 스펙 §9.3: 잠금은 즉시, 새 기기는 **마지막 활성화 후 7일**(컨트랙트가 강제).

- [ ] **Step 1: 실패하는 테스트**

```tsx
// apps/web/src/attendee/me/nickname.test.tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

const nicknameOwner = vi.fn(async () => `0x${'cc'.repeat(20)}`);
vi.mock('../../shared/chain/reads', () => ({ readIdentity: () => ({ nicknameOwner }) }));
const identityOp = vi.fn(async () => ({ success: true, txHash: '0x2', blockNumber: 1n }));
vi.mock('../../shared/chain/ops', () => ({ identityOp }));
vi.mock('../../shared/chain/accounts', () => ({ getAttendeeAccount: async () => ({ address: `0x${'ab'.repeat(20)}` }) }));
vi.mock('../../shared/api/firestore', () => ({ saveUserProfile: vi.fn() }));

const { Nickname, normalizeNickname } = await import('./Nickname');

describe('Nickname', () => {
  it('normalises input and rejects anything outside [a-z0-9_]{3,20}', () => {
    expect(normalizeNickname('  Alex_01 ')).toBe('alex_01');
    expect(normalizeNickname('ab')).toBeNull();
    expect(normalizeNickname('김철수')).toBeNull();
  });

  it('blocks a taken nickname before sending anything', async () => {
    render(<Nickname />);
    await userEvent.type(screen.getByRole('textbox'), 'taken_name');
    await userEvent.click(screen.getByRole('button', { name: '저장' }));
    expect(await screen.findByText('이미 쓰는 별명이에요.')).toBeInTheDocument();
    expect(identityOp).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 실패 확인**

Run (from `apps/web/`): `pnpm vitest run src/attendee/me/nickname.test.tsx`
Expected: FAIL — `Failed to resolve import "./Nickname"`.

- [ ] **Step 3: 별명**

```tsx
// apps/web/src/attendee/me/Nickname.tsx
import { useState } from 'react';
import { keccak256, toBytes } from 'viem';
import { Alert, Button, Field } from '../../shared/ui';
import { useCopy } from '../../shared/i18n';
import { readIdentity } from '../../shared/chain/reads';
import { identityOp } from '../../shared/chain/ops';
import { getAttendeeAccount } from '../../shared/chain/accounts';
import { saveUserProfile } from '../../shared/api/firestore';

const ZERO_ADDRESS = `0x${'00'.repeat(20)}`;

export function normalizeNickname(input: string): string | null {
  const value = input.trim().toLowerCase();
  return /^[a-z0-9_]{3,20}$/.test(value) ? value : null;
}

export function Nickname() {
  const copy = useCopy();
  const [value, setValue] = useState('');
  const [message, setMessage] = useState('');
  const [tone, setTone] = useState<'info' | 'error'>('info');
  const [busy, setBusy] = useState(false);

  async function save() {
    const name = normalizeNickname(value);
    if (!name) { setTone('error'); setMessage(copy.me.nicknameInvalid); return; }
    setBusy(true);
    try {
      const hash = keccak256(toBytes(name));
      const owner = await readIdentity().nicknameOwner(hash);
      if (owner !== ZERO_ADDRESS) { setTone('error'); setMessage(copy.me.nicknameTaken); return; }
      await identityOp({
        account: await getAttendeeAccount(),
        orgId: 0n, // platform budget: identity changes are not tied to an organizer
        functionName: 'setNickname',
        args: [hash, name],
      });
      await saveUserProfile({ nickname: name });
      setTone('info'); setMessage(copy.me.nicknameSaved);
    } catch {
      setTone('error'); setMessage(copy.common.error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <Field label={copy.me.nickname}>
        <input value={value} onChange={(event) => setValue(event.target.value)} placeholder={copy.me.nicknameHint} />
      </Field>
      {message ? <Alert tone={tone}>{message}</Alert> : null}
      <Button onClick={save} disabled={busy}>{copy.common.save}</Button>
    </section>
  );
}
```

- [ ] **Step 4: 기기 잠금과 새 기기**

```tsx
// apps/web/src/attendee/me/DeviceLock.tsx
import { useState } from 'react';
import { Alert, Button } from '../../shared/ui';
import { useCopy } from '../../shared/i18n';
import { api } from '../../shared/api/functions';

export function DeviceLock() {
  const copy = useCopy();
  const [locked, setLocked] = useState(false);
  return (
    <section>
      <h2>{copy.me.lockDevice}</h2>
      {locked ? <Alert tone="warn">{copy.me.locked} · {copy.me.unlockGuide}</Alert> : null}
      <Button variant="danger" onClick={async () => { await api.lockDevice(); setLocked(true); }}>
        {copy.me.lockCta}
      </Button>
    </section>
  );
}
```

```tsx
// apps/web/src/attendee/me/NewDevice.tsx
import { useEffect, useState } from 'react';
import { Alert, Button } from '../../shared/ui';
import { fmt, useCopy } from '../../shared/i18n';
import { api } from '../../shared/api/functions';
import { readIdentity } from '../../shared/chain/reads';
import { useSession } from '../../shared/session';

const DEVICE_COOLDOWN_SECONDS = 7 * 24 * 60 * 60;

export function NewDevice() {
  const copy = useCopy();
  const session = useSession();
  const [daysLeft, setDaysLeft] = useState<number | null>(null);

  useEffect(() => {
    if (!session.account) return;
    void readIdentity().deviceUpdatedAt(session.account).then((updatedAt) => {
      const readyAt = Number(updatedAt) + DEVICE_COOLDOWN_SECONDS;
      const seconds = readyAt - Math.floor(Date.now() / 1000);
      setDaysLeft(seconds <= 0 ? 0 : Math.ceil(seconds / 86_400));
    }).catch(() => setDaysLeft(null));
  }, [session.account]);

  return (
    <section>
      <h2>{copy.me.newDevice}</h2>
      {daysLeft === 0 ? <Alert tone="info">{copy.me.newDeviceReady}</Alert> : null}
      {daysLeft && daysLeft > 0 ? <Alert tone="warn">{fmt(copy.me.newDeviceWait, { days: daysLeft })}</Alert> : null}
      <Button variant="ghost" onClick={() => void api.startDeviceChange({ method: 'sms' })}>
        {copy.me.newDeviceCta}
      </Button>
    </section>
  );
}
```

- [ ] **Step 5: 프로필 화면**

```tsx
// apps/web/src/attendee/me/Profile.tsx
import { useNavigate } from 'react-router-dom';
import { Button, Field, Screen } from '../../shared/ui';
import { useCopy, useLocale, setLocale } from '../../shared/i18n';
import { api } from '../../shared/api/functions';
import { saveUserProfile } from '../../shared/api/firestore';
import { getConfig } from '../../shared/config';
import { useSession } from '../../shared/session';
import { Nickname } from './Nickname';
import { DeviceLock } from './DeviceLock';
import { NewDevice } from './NewDevice';
import { useKycLevel } from './useKycLevel';

export function KycStatus() {
  const copy = useCopy();
  const navigate = useNavigate();
  const { kycLevel } = useKycLevel();
  return (
    <section>
      <h2>{copy.kyc.status}</h2>
      <p>{kycLevel >= 1 ? copy.kyc.verified : copy.kyc.unverified}</p>
      {kycLevel < 1 ? <Button onClick={() => navigate('/me/verify?returnTo=/me')}>{copy.kyc.cta}</Button> : null}
    </section>
  );
}

export function Profile() {
  const copy = useCopy();
  const locale = useLocale();
  const session = useSession();
  const explorerBase = getConfig().explorerUrl;

  return (
    <Screen title={copy.me.title}>
      <KycStatus />
      <Nickname />
      <Field label={copy.me.language}>
        <select
          value={locale}
          onChange={async (event) => {
            const next = event.target.value as 'ko' | 'en';
            await setLocale(next);
            await saveUserProfile({ locale: next }).catch(() => undefined);
          }}
        >
          <option value="ko">{copy.me.languageKo}</option>
          <option value="en">{copy.me.languageEn}</option>
        </select>
      </Field>
      <DeviceLock />
      <NewDevice />
      <p><a href={`${explorerBase}/address/${session.account ?? ''}`}>{copy.me.publicRecord}</a></p>
      <Button
        variant="danger"
        onClick={() => { if (confirm(copy.me.deleteConfirm)) void api.requestAccountDeletion({}); }}
      >
        {copy.me.deleteAccount}
      </Button>
    </Screen>
  );
}
```

- [ ] **Step 6: 테스트 통과와 커밋**

Run (from `apps/web/`): `pnpm vitest run src/attendee/me/nickname.test.tsx`
Expected: PASS — `Tests  2 passed (2)`.

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI
git add apps/web/src/attendee/me
git commit -m "feat(attendee): add profile with nickname, locale, device lock and deletion request"
```

---

## Task 28: 대화 — 목록(드래그 정렬)과 대화방(실시간, 공지, 신고, 닫힘)

**Files:**
- Create: `apps/web/src/attendee/chats/useChats.ts`, `ChatList.tsx`, `ChatRoom.tsx`
- Test: `apps/web/src/attendee/chats/chatRoom.test.tsx`

**Interfaces:**
- Consumes: `watchChatMessages`, `watchChatRoom`, `sendChatMessage`, `saveUserProfile` (Task 16), `api.joinEventChat`, `api.reportMessage`, `useMyTickets` (Task 21), `@dnd-kit/sortable`.
- Produces: `useChatList()`, `<ChatList />`, `<ChatRoom />`.

대화방은 **내가 티켓을 가진 행사** 중 `eventChats/{eventId}.closed === false` 인 것만 뜬다. 순서는 사용자가 드래그로 바꾸고 `users/{uid}.chatOrder`에 저장한다. 행사가 끝나면 `closeEndedChats`(02, 10분 주기)가 `closed = true`로 바꾸고, 화면은 배너를 띄우고 입력을 막는다. 닫힌 방은 24시간 뒤 목록에서 사라진다.

- [ ] **Step 1: 실패하는 테스트**

```tsx
// apps/web/src/attendee/chats/chatRoom.test.tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const sendChatMessage = vi.fn();
vi.mock('../../shared/api/firestore', () => ({
  sendChatMessage,
  watchChatMessages: (_id: string, onChange: (m: unknown[]) => void) => {
    onChange([
      { id: 'm1', uid: 'u1', text: '공지입니다', createdAt: 1, pinned: true, reported: 0 },
      { id: 'm2', uid: 'u2', text: '안녕하세요', createdAt: 2, reported: 0 },
    ]);
    return () => undefined;
  },
  watchChatRoom: (_id: string, onChange: (r: { closed: boolean; endsAt: number }) => void) => {
    onChange({ closed: true, endsAt: 0 });
    return () => undefined;
  },
}));
vi.mock('../../shared/api/functions', () => ({ api: { joinEventChat: vi.fn(), reportMessage: vi.fn() } }));
vi.mock('react-router-dom', async (orig) => ({
  ...(await orig<typeof import('react-router-dom')>()), useParams: () => ({ eventId: '5' }),
}));

const { ChatRoom } = await import('./ChatRoom');

describe('ChatRoom', () => {
  it('pins the notice, shows the closed banner and disables sending', async () => {
    render(<ChatRoom />);
    // The notice renders as one node, "공지 · 공지입니다" — match on a fragment.
    expect(await screen.findByText(/공지/)).toBeInTheDocument();
    expect(screen.getByText('행사가 끝나 대화방이 닫혔어요')).toBeInTheDocument();
    // The closed room is what disables the textarea; the button is also empty-draft disabled.
    expect(screen.getByPlaceholderText('메시지 (최대 500자)')).toBeDisabled();
    expect(screen.getByRole('button', { name: '보내기' })).toBeDisabled();
  });
});
```

- [ ] **Step 2: 실패 확인**

Run (from `apps/web/`): `pnpm vitest run src/attendee/chats/chatRoom.test.tsx`
Expected: FAIL — `Failed to resolve import "./ChatRoom"`.

- [ ] **Step 3: 목록 훅과 화면**

```ts
// apps/web/src/attendee/chats/useChats.ts
import { useEffect, useState } from 'react';
import { doc, getDoc } from 'firebase/firestore';
import { getDb, getFirebaseAuth } from '../../shared/api/firebase';
import { saveUserProfile } from '../../shared/api/firestore';
import { useMyTickets } from '../tickets/useTickets';

export interface ChatEntry { eventId: string; closed: boolean; endsAt: number }

const CLOSED_GRACE_SECONDS = 24 * 60 * 60;

export function useChatList() {
  const { data: tickets } = useMyTickets();
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [order, setOrder] = useState<string[]>([]);

  useEffect(() => {
    const eventIds = [...new Set((tickets ?? []).map((ticket) => ticket.eventId))];
    void (async () => {
      const uid = getFirebaseAuth().currentUser?.uid;
      const profile = uid ? await getDoc(doc(getDb(), 'users', uid)) : null;
      setOrder(((profile?.data() as { chatOrder?: string[] } | undefined)?.chatOrder) ?? []);
      const now = Math.floor(Date.now() / 1000);
      const rooms = await Promise.all(
        eventIds.map(async (eventId) => {
          const snapshot = await getDoc(doc(getDb(), 'eventChats', eventId));
          const data = snapshot.data() as { closed?: boolean; endsAt?: number } | undefined;
          return { eventId, closed: data?.closed ?? false, endsAt: data?.endsAt ?? 0 };
        }),
      );
      setEntries(rooms.filter((room) => !room.closed || now - room.endsAt < CLOSED_GRACE_SECONDS));
    })();
  }, [tickets]);

  const sorted = [...entries].sort(
    (a, b) => (order.indexOf(a.eventId) + 1 || 999) - (order.indexOf(b.eventId) + 1 || 999),
  );

  async function persistOrder(next: string[]): Promise<void> {
    setOrder(next);
    await saveUserProfile({ chatOrder: next }).catch(() => undefined);
  }

  return { entries: sorted, persistOrder };
}
```

```tsx
// apps/web/src/attendee/chats/ChatList.tsx
import { DndContext, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Link } from 'react-router-dom';
import { Screen } from '../../shared/ui';
import { useCopy } from '../../shared/i18n';
import { useChatList } from './useChats';

function Row({ eventId, closed }: { eventId: string; closed: boolean }) {
  const copy = useCopy();
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: eventId });
  return (
    <li ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition, marginBottom: 12 }}
        {...attributes} {...listeners}>
      <Link to={`/chats/${eventId}`}>#{eventId}{closed ? ` · ${copy.chats.closed}` : ''}</Link>
    </li>
  );
}

export function ChatList() {
  const copy = useCopy();
  const { entries, persistOrder } = useChatList();

  function onDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const ids = entries.map((entry) => entry.eventId);
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    ids.splice(to, 0, ...ids.splice(from, 1));
    void persistOrder(ids);
  }

  return (
    <Screen title={copy.chats.title}>
      {entries.length === 0 ? <p>{copy.chats.empty}</p> : <p>{copy.chats.reorderHint}</p>}
      <DndContext onDragEnd={onDragEnd}>
        <SortableContext items={entries.map((entry) => entry.eventId)} strategy={verticalListSortingStrategy}>
          <ul style={{ listStyle: 'none', padding: 0 }}>
            {entries.map((entry) => <Row key={entry.eventId} eventId={entry.eventId} closed={entry.closed} />)}
          </ul>
        </SortableContext>
      </DndContext>
    </Screen>
  );
}
```

- [ ] **Step 4: 대화방**

```tsx
// apps/web/src/attendee/chats/ChatRoom.tsx
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Alert, Button, Field, Screen } from '../../shared/ui';
import { useCopy } from '../../shared/i18n';
import { sendChatMessage, watchChatMessages, watchChatRoom, type ChatMessage } from '../../shared/api/firestore';
import { api } from '../../shared/api/functions';

export function ChatRoom() {
  const copy = useCopy();
  const { eventId = '' } = useParams();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [room, setRoom] = useState({ closed: false, endsAt: 0 });
  const [draft, setDraft] = useState('');

  useEffect(() => {
    void api.joinEventChat({ eventId }).catch(() => undefined);
    const stopMessages = watchChatMessages(eventId, setMessages);
    const stopRoom = watchChatRoom(eventId, setRoom);
    return () => { stopMessages(); stopRoom(); };
  }, [eventId]);

  const pinned = messages.filter((message) => message.pinned);
  const normal = messages.filter((message) => !message.pinned);

  return (
    <Screen title={copy.chats.title}>
      {room.closed ? <Alert tone="warn">{copy.chats.closed}</Alert> : null}
      {pinned.map((message) => (
        <Alert key={message.id} tone="info">{copy.chats.notice} · {message.text}</Alert>
      ))}
      <ul style={{ listStyle: 'none', padding: 0 }}>
        {normal.map((message) => (
          <li key={message.id} style={{ marginBottom: 8 }}>
            <span>{message.text}</span>{' '}
            <button type="button" onClick={() => void api.reportMessage({ eventId, msgId: message.id })}>
              {copy.chats.report}
            </button>
          </li>
        ))}
      </ul>
      <Field label={copy.chats.placeholder}>
        <textarea rows={2} maxLength={500} value={draft} disabled={room.closed}
                  onChange={(event) => setDraft(event.target.value)} placeholder={copy.chats.placeholder} />
      </Field>
      {draft.length >= 500 ? <Alert tone="warn">{copy.chats.tooLong}</Alert> : null}
      <Button
        disabled={room.closed || draft.trim().length === 0}
        onClick={async () => { await sendChatMessage(eventId, draft.trim()); setDraft(''); }}
      >
        {copy.chats.send}
      </Button>
    </Screen>
  );
}
```

- [ ] **Step 5: 테스트 통과와 커밋**

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI && pnpm -C apps/web add @dnd-kit/utilities@3.2.2
```

Run (from `apps/web/`): `pnpm vitest run src/attendee/chats/chatRoom.test.tsx`
Expected: PASS — `Tests  1 passed (1)`.

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI
git add apps/web/src/attendee/chats apps/web/package.json pnpm-lock.yaml
git commit -m "feat(attendee): add reorderable chat list and realtime event chat room"
```

---

## Task 29: 주최자 마법사 6단계 — Pinata 메타데이터와 `createEvent`

**Files:**
- Create: `apps/web/src/organizer/copy.ts`, `wizard/regions.ts`, `pinata.ts`, `buildEventMeta.ts`, `useWizard.ts`, `Step1Basic.tsx`…`Step6Review.tsx`, `apps/web/src/organizer/Layout.tsx`
- Test: `apps/web/src/organizer/wizard/buildEventMeta.test.ts`

**Interfaces:**
- Consumes: `ticketAbi.createEvent`, `sendSponsoredOp`, `getStaffAccount()`(주최자도 자기 패스키 계정을 쓴다 — `getAttendeeAccount`와 같은 계정 유도 규칙), `getConfig().pinataJwt`.
- Produces: `KR_REGIONS`, `pinFile(file): Promise<string>`, `pinJson(value): Promise<string>`, `type WizardDraft`, `buildEventMeta(draft, metaCid): EventMetaStruct`, `buildTiers(draft): TierStruct[]`, `<OrganizerRoutes />`, 6개 스텝 컴포넌트.

**`imageCid`에 넣는 것은 메타데이터 JSON의 CID다.** 체인에는 제목·소개글의 해시만 올라가므로 탐색 화면이 평문 제목을 보여주려면 어딘가 공개된 JSON이 있어야 한다. 마법사는 이미지 파일을 Pinata에 올려 `imageCid`를 얻고, 그 CID를 포함한 JSON `{ title, description, image, venue, category, region }`을 다시 올려 **그 JSON의 CID를 `EventMeta.imageCid`에 넣는다**. 체인 구조는 그대로다(필드 이름만 의미가 넓어졌다). 업로드는 **범위 제한 Pinata 키로 브라우저가 직접** 한다(위 Interfaces 블록의 근거 참조).

- [ ] **Step 1: 실패하는 테스트**

```ts
// apps/web/src/organizer/wizard/buildEventMeta.test.ts
import { describe, expect, it } from 'vitest';
import { keccak256, toBytes } from 'viem';
import { buildEventMeta, buildTiers, type WizardDraft } from './buildEventMeta';

const draft: WizardDraft = {
  title: '재즈 나이트', description: '한남동 라이브', imageCid: 'bafyImage',
  venue: '서울 용산구 한남동', regionCode: 'KR-11', category: 0,
  startsAt: 1_790_000_000, endsAt: 1_790_010_000, saleStart: 1_789_000_000, saleEnd: 1_789_900_000,
  transferable: true, transferCutoffHours: 2, maxTransfers: 3, approvalRequired: false,
  requireKyc: true,
  tiers: [{ name: '일반', priceUsdCents: 0, supply: 100, maxPerWallet: 2, seated: false }],
  orgId: '9',
};

describe('buildEventMeta', () => {
  it('hashes title, description, venue and region with keccak256 over UTF-8', () => {
    const meta = buildEventMeta(draft, 'bafyMetaJson');
    expect(meta.titleHash).toBe(keccak256(toBytes('재즈 나이트')));
    expect(meta.descHash).toBe(keccak256(toBytes('한남동 라이브')));
    expect(meta.venueHash).toBe(keccak256(toBytes('서울 용산구 한남동')));
    expect(meta.regionCode).toBe(keccak256(toBytes('KR-11')));
  });

  it('puts the metadata JSON cid in imageCid and converts the cutoff to seconds', () => {
    const meta = buildEventMeta(draft, 'bafyMetaJson');
    expect(meta.imageCid).toBe('bafyMetaJson');
    expect(meta.transferCutoffSeconds).toBe(7200);
    expect(meta.orgId).toBe(9n);
    expect(meta.category).toBe(0);
  });

  it('carries the per-event KYC switch through to the struct', () => {
    expect(buildEventMeta(draft, 'bafyMetaJson').requireKyc).toBe(true);
    expect(buildEventMeta({ ...draft, requireKyc: false }, 'bafyMetaJson').requireKyc).toBe(false);
  });

  it('builds tiers with minted zero', () => {
    expect(buildTiers(draft)).toEqual([
      { name: '일반', priceUsdCents: 0n, supply: 100, minted: 0, maxPerWallet: 2, seated: false },
    ]);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run (from `apps/web/`): `pnpm vitest run src/organizer/wizard/buildEventMeta.test.ts`
Expected: FAIL — `Failed to resolve import "./buildEventMeta"`.

- [ ] **Step 3: 드래프트 → 체인 구조체**

```ts
// apps/web/src/organizer/wizard/buildEventMeta.ts
import { keccak256, toBytes } from 'viem';
import type { EventMetaStruct, TierStruct } from '../../shared/chain/reads';

export interface WizardTier { name: string; priceUsdCents: number; supply: number; maxPerWallet: number; seated: boolean }

export interface WizardDraft {
  orgId: string;
  title: string; description: string; imageCid: string;
  venue: string; regionCode: string; category: number;
  startsAt: number; endsAt: number; saleStart: number; saleEnd: number;
  transferable: boolean; transferCutoffHours: number; maxTransfers: number; approvalRequired: boolean;
  /** Anti-scalping switch. Off for casual meetups, on for concerts. */
  requireKyc: boolean;
  tiers: WizardTier[];
}

/** metaCid is the CID of the metadata JSON, which itself contains the image CID. */
export function buildEventMeta(draft: WizardDraft, metaCid: string): EventMetaStruct {
  return {
    orgId: BigInt(draft.orgId),
    titleHash: keccak256(toBytes(draft.title)),
    descHash: keccak256(toBytes(draft.description)),
    imageCid: metaCid,
    startsAt: BigInt(draft.startsAt),
    endsAt: BigInt(draft.endsAt),
    venueHash: keccak256(toBytes(draft.venue)),
    saleStart: BigInt(draft.saleStart),
    saleEnd: BigInt(draft.saleEnd),
    transferable: draft.transferable,
    transferCutoffSeconds: draft.transferCutoffHours * 3600,
    maxTransfers: draft.maxTransfers,
    approvalRequired: draft.approvalRequired,
    category: draft.category,
    regionCode: keccak256(toBytes(draft.regionCode)),
    requireKyc: draft.requireKyc,
  };
}

export function buildTiers(draft: WizardDraft): TierStruct[] {
  return draft.tiers.map((tier) => ({
    name: tier.name,
    priceUsdCents: BigInt(tier.priceUsdCents),
    supply: tier.supply,
    minted: 0,
    maxPerWallet: tier.maxPerWallet,
    seated: tier.seated,
  }));
}
```

```ts
// apps/web/src/organizer/wizard/regions.ts
/** ISO-3166-2:KR. The chain stores keccak256 of the code, never the label. */
export const KR_REGIONS: Array<{ code: string; label: string }> = [
  { code: 'KR-11', label: '서울' }, { code: 'KR-26', label: '부산' }, { code: 'KR-27', label: '대구' },
  { code: 'KR-28', label: '인천' }, { code: 'KR-29', label: '광주' }, { code: 'KR-30', label: '대전' },
  { code: 'KR-31', label: '울산' }, { code: 'KR-50', label: '세종' }, { code: 'KR-41', label: '경기' },
  { code: 'KR-42', label: '강원' }, { code: 'KR-43', label: '충북' }, { code: 'KR-44', label: '충남' },
  { code: 'KR-45', label: '전북' }, { code: 'KR-46', label: '전남' }, { code: 'KR-47', label: '경북' },
  { code: 'KR-48', label: '경남' }, { code: 'KR-49', label: '제주' },
];
```

```ts
// apps/web/src/organizer/wizard/pinata.ts
import { getConfig } from '../../shared/config';

const UPLOAD_URL = 'https://uploads.pinata.cloud/v3/files';

async function upload(body: FormData): Promise<string> {
  const response = await fetch(UPLOAD_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${getConfig().pinataJwt}` },
    body,
  });
  if (!response.ok) throw new Error(`Pinata ${response.status}`);
  const result = (await response.json()) as { data: { cid: string } };
  return result.data.cid;
}

export async function pinFile(file: File): Promise<string> {
  const form = new FormData();
  form.append('file', file);
  form.append('network', 'public');
  return upload(form);
}

export async function pinJson(value: unknown): Promise<string> {
  const form = new FormData();
  form.append('file', new File([JSON.stringify(value)], 'metadata.json', { type: 'application/json' }));
  form.append('network', 'public');
  return upload(form);
}
```

- [ ] **Step 4: 마법사 상태와 스텝 1~3**

```ts
// apps/web/src/organizer/wizard/useWizard.ts
import { useState } from 'react';
import type { WizardDraft } from './buildEventMeta';

const KEY = 'monti.wizard';

export const emptyDraft: WizardDraft = {
  orgId: '', title: '', description: '', imageCid: '', venue: '', regionCode: 'KR-11', category: 0,
  startsAt: 0, endsAt: 0, saleStart: 0, saleEnd: 0,
  transferable: true, transferCutoffHours: 2, maxTransfers: 3, approvalRequired: false,
  requireKyc: false,
  tiers: [{ name: '일반', priceUsdCents: 0, supply: 100, maxPerWallet: 2, seated: false }],
};

export function useWizard() {
  const [draft, setDraft] = useState<WizardDraft>(() => {
    try { return { ...emptyDraft, ...(JSON.parse(localStorage.getItem(KEY) ?? '{}') as WizardDraft) }; }
    catch { return emptyDraft; }
  });
  function patch(next: Partial<WizardDraft>): void {
    setDraft((prev) => {
      const merged = { ...prev, ...next };
      localStorage.setItem(KEY, JSON.stringify(merged));
      return merged;
    });
  }
  return { draft, patch, reset: () => { localStorage.removeItem(KEY); setDraft(emptyDraft); } };
}
```

```ts
// apps/web/src/organizer/copy.ts
// Organizer copy may use crypto vocabulary; it is not linted.
export const organizerCopy = {
  wizard: {
    step1: '기본 정보', step2: '일시·장소', step3: '티켓 종류', step4: '판매·양도 규칙',
    step5: '게이트·스태프', step6: '검토·발행',
    title: '제목', description: '소개글', image: '대표 이미지 (1200×630 권장)',
    category: '분류', region: '지역', venue: '장소', startsAt: '시작', endsAt: '종료',
    saleStart: '신청 시작', saleEnd: '신청 종료',
    transferable: '양도 허용', cutoff: '양도 마감 (공연 N시간 전)', maxTransfers: '티켓당 양도 횟수',
    approvalRequired: '참가 승인제', tierName: '종류 이름', supply: '수량', maxPerWallet: '1인 최대 보유 수',
    requireKyc: '본인인증 필수 (암표 방지)',
    requireKycHelp: '켜면 신분증·얼굴 확인을 마친 사람만 티켓을 받을 수 있어요. 가벼운 모임은 꺼두세요',
    seated: '좌석 지정', gasNote: '가스 예산: MONTI 부담', publish: '발행하기', saveDraft: '초안 저장',
    publishing: '발행 중…', published: '발행했습니다',
  },
  lifecycle: { draft: '초안', publish: '게시', cancel: '취소', cancelled: '취소됨', ended: '종료됨' },
  team: { admins: '관리자', managers: '매니저', invite: '초대', canApprove: '수동 승인 직접', requestOnly: '결재 요청만' },
  gates: { pending: '등록 대기 중인 단말기', register: '등록', open: '열기', close: '닫기', none: '대기 중인 단말기가 없습니다' },
  dashboard: {
    sold: '판매', remaining: '잔여', checkins: '입장 수', attendees: '구매자', announce: '공지 올리기',
    kyc: '인증', kycYes: '인증 완료', kycNo: '미인증',
  },
} as const;
```

```tsx
// apps/web/src/organizer/wizard/Step1Basic.tsx
import { useState } from 'react';
import { Button, Field } from '../../shared/ui';
import { organizerCopy } from '../copy';
import { KR_REGIONS } from './regions';
import { pinFile } from './pinata';
import type { WizardDraft } from './buildEventMeta';

export function Step1Basic({ draft, patch, onNext }: { draft: WizardDraft; patch: (p: Partial<WizardDraft>) => void; onNext: () => void }) {
  const [uploading, setUploading] = useState(false);
  return (
    <section>
      <h2>{organizerCopy.wizard.step1}</h2>
      <Field label={organizerCopy.wizard.title}>
        <input value={draft.title} onChange={(event) => patch({ title: event.target.value })} />
      </Field>
      <Field label={organizerCopy.wizard.description}>
        <textarea rows={4} value={draft.description} onChange={(event) => patch({ description: event.target.value })} />
      </Field>
      <Field label={organizerCopy.wizard.image}>
        <input type="file" accept="image/*" disabled={uploading}
               onChange={async (event) => {
                 const file = event.target.files?.[0];
                 if (!file) return;
                 setUploading(true);
                 try { patch({ imageCid: await pinFile(file) }); } finally { setUploading(false); }
               }} />
      </Field>
      <Field label={organizerCopy.wizard.category}>
        <select value={draft.category} onChange={(event) => patch({ category: Number(event.target.value) })}>
          <option value={0}>공연</option><option value={1}>모임</option><option value={2}>전시</option><option value={3}>기타</option>
        </select>
      </Field>
      <Field label={organizerCopy.wizard.region}>
        <select value={draft.regionCode} onChange={(event) => patch({ regionCode: event.target.value })}>
          {KR_REGIONS.map((region) => <option key={region.code} value={region.code}>{region.label}</option>)}
        </select>
      </Field>
      <Button onClick={onNext} disabled={!draft.title || !draft.imageCid}>{organizerCopy.wizard.step2}</Button>
    </section>
  );
}
```

`Step4Rules.tsx`는 4단계 규칙 화면이고 마지막 항목이 본인인증 스위치다:

```tsx
// apps/web/src/organizer/wizard/Step4Rules.tsx
import { Button, Field } from '../../shared/ui';
import { organizerCopy } from '../copy';
import type { WizardDraft } from './buildEventMeta';

export function Step4Rules({ draft, patch, onNext }: { draft: WizardDraft; patch: (p: Partial<WizardDraft>) => void; onNext: () => void }) {
  return (
    <section>
      <h2>{organizerCopy.wizard.step4}</h2>
      <Field label={organizerCopy.wizard.maxTransfers}>
        <input type="number" min={0} max={255} value={draft.maxTransfers}
               onChange={(event) => patch({ maxTransfers: Number(event.target.value) })} />
      </Field>
      <Field label={organizerCopy.wizard.cutoff}>
        <input type="number" min={0} value={draft.transferCutoffHours}
               onChange={(event) => patch({ transferCutoffHours: Number(event.target.value) })} />
      </Field>
      <label>
        <input type="checkbox" checked={draft.transferable}
               onChange={(event) => patch({ transferable: event.target.checked })} />
        {organizerCopy.wizard.transferable}
      </label>
      <label>
        <input type="checkbox" checked={draft.approvalRequired}
               onChange={(event) => patch({ approvalRequired: event.target.checked })} />
        {organizerCopy.wizard.approvalRequired}
      </label>
      <label>
        <input type="checkbox" checked={draft.requireKyc}
               onChange={(event) => patch({ requireKyc: event.target.checked })} />
        {organizerCopy.wizard.requireKyc}
      </label>
      <p style={{ color: 'var(--muted)', fontSize: 13 }}>{organizerCopy.wizard.requireKycHelp}</p>
      <Button onClick={onNext}>{organizerCopy.wizard.step5}</Button>
    </section>
  );
}
```

`Step2When.tsx`(`startsAt`, `endsAt`, `venue`), `Step3Tiers.tsx`(`tiers` 배열 편집), `Step5Staff.tsx`(게이트 이름 목록과 초대)는 같은 형태다 — 각각 `Field` + `input`/`select`를 `patch({ … })`에 연결하고 마지막에 `onNext` 버튼을 둔다. 날짜 입력은 `<input type="datetime-local">`의 값을 `Math.floor(new Date(value).getTime() / 1000)`으로 바꿔 저장한다.

- [ ] **Step 5: 스텝 6 — 검토와 발행**

```tsx
// apps/web/src/organizer/wizard/Step6Review.tsx
import { useState } from 'react';
import { Alert, Button } from '../../shared/ui';
import { organizerCopy } from '../copy';
import { ticketOp } from '../../shared/chain/ops';
import { getStaffAccount } from '../../shared/chain/accounts';
import { buildEventMeta, buildTiers, type WizardDraft } from './buildEventMeta';
import { pinJson } from './pinata';

export function Step6Review({ draft, onDone }: { draft: WizardDraft; onDone: () => void }) {
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  async function publish() {
    setBusy(true);
    setMessage(organizerCopy.wizard.publishing);
    try {
      const metaCid = await pinJson({
        title: draft.title, description: draft.description, image: draft.imageCid,
        venue: draft.venue, category: draft.category, region: draft.regionCode,
      });
      await ticketOp({
        account: await getStaffAccount(),
        orgId: BigInt(draft.orgId),
        functionName: 'createEvent',
        args: [buildEventMeta(draft, metaCid), buildTiers(draft)],
      });
      setMessage(organizerCopy.wizard.published);
      onDone();
    } catch (cause) {
      setMessage(String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h2>{organizerCopy.wizard.step6}</h2>
      <pre style={{ whiteSpace: 'pre-wrap' }}>{JSON.stringify({ ...draft, tiers: draft.tiers }, null, 2)}</pre>
      <Alert tone="info">{organizerCopy.wizard.gasNote}</Alert>
      {message ? <Alert tone="info">{message}</Alert> : null}
      <Button onClick={publish} disabled={busy}>{organizerCopy.wizard.publish}</Button>
    </section>
  );
}
```

```tsx
// apps/web/src/organizer/Layout.tsx
import { Route, Routes } from 'react-router-dom';
import { Fab, Screen } from '../shared/ui';
import { organizerCopy } from './copy';
import { useWizard } from './wizard/useWizard';
import { Step1Basic } from './wizard/Step1Basic';
import { Step6Review } from './wizard/Step6Review';
import { Dashboard } from './Dashboard';
import { Team } from './Team';
import { Gates } from './gates/Gates';

function Wizard() {
  const { draft, patch, reset } = useWizard();
  return (
    <Screen title={organizerCopy.wizard.step1}>
      <Step1Basic draft={draft} patch={patch} onNext={() => undefined} />
      <Step6Review draft={draft} onDone={reset} />
    </Screen>
  );
}

export function OrganizerRoutes() {
  return (
    <Routes>
      <Route index element={<><Dashboard /><Fab label="만들기" onClick={() => { location.assign('/org/new'); }} /></>} />
      <Route path="new" element={<Wizard />} />
      <Route path="team" element={<Team />} />
      <Route path="gates/:eventId" element={<Gates />} />
    </Routes>
  );
}
```

> `Wizard`는 스텝 1과 6만 연결해 두었다. Step 4에서 만든 `Step2When`·`Step3Tiers`·`Step4Rules`·`Step5Staff`를 같은 방식(`draft`, `patch`, `onNext`)으로 사이에 끼워 6단계를 완성한다 — props 시그니처가 동일하므로 순서 배열만 바꾸면 된다.

- [ ] **Step 6: 테스트 통과와 커밋**

Run (from `apps/web/`): `pnpm vitest run src/organizer/wizard/buildEventMeta.test.ts`
Expected: PASS — `Tests  4 passed (4)`.

Run (from repo root): `pnpm lint:copy`
Expected: `copy-lint: clean` (주최자 문구는 대상이 아니다).

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI
git add apps/web/src/organizer
git commit -m "feat(organizer): add six-step wizard, pinata metadata json and sponsored createEvent"
```

---

## Task 30: 주최자 — 라이프사이클, 팀·초대, 게이트 등록, 대시보드, 공지

**Files:**
- Create: `apps/web/src/organizer/Dashboard.tsx`, `Team.tsx`, `Announce.tsx`, `gates/Gates.tsx`, `invites/Accept.tsx`, `lifecycle.ts`
- Test: `apps/web/src/organizer/gates/gates.test.tsx`

**Interfaces:**
- Consumes: `api.listPendingGates`, `api.listAttendees`, `api.createInvite`, `api.acceptInvite`, `api.pinMessage`, `organizersAbi.registerGate/openGate/closeGate/setAdmin/setManager`, `ticketAbi.publishEvent/cancelEvent/updateEventMeta`, `readTicket().eventOrg`, `gql` + Envio `Tier`/`CheckIn`.
- Produces: `publishEvent(eventId, orgId)`, `cancelEvent(eventId, orgId)`, `saveDraft(eventId, orgId, meta, tiers)`, `<Dashboard />`, `<Team />`, `<Gates />`, `<AcceptInvite />`, `<Announce />`.

게이트 등록 흐름(스펙 §5.7 1단계): 스태프 단말기가 보안 칩에 게이트 키를 만들어 **계정 주소와 `kx, ky`를 Firestore `pendingGates`에 올린다**(sub-plan 04). 주최자 웹은 `listPendingGates({ eventId })`로 그 목록을 보고 `registerGate(eventId, gateAccount, kx, ky)`를 스폰서 유저옵으로 보낸 뒤 `openGate`로 연다. 승인 전에는 아무 권한도 없다.

- [ ] **Step 1: 실패하는 테스트**

```tsx
// apps/web/src/organizer/gates/gates.test.tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

const organizersOp = vi.fn(async () => ({ success: true, txHash: '0x2', blockNumber: 1n }));
vi.mock('../../shared/chain/ops', () => ({ organizersOp }));
vi.mock('../../shared/chain/accounts', () => ({ getStaffAccount: async () => ({ address: `0x${'ab'.repeat(20)}` }) }));
vi.mock('../../shared/chain/reads', () => ({ readTicket: () => ({ eventOrg: async () => 9n }) }));
vi.mock('../../shared/api/functions', () => ({
  api: {
    listPendingGates: async () => ({
      gates: [{ gateAccount: `0x${'dd'.repeat(20)}`, kx: `0x${'01'.repeat(32)}`, ky: `0x${'02'.repeat(32)}`, label: 'Gate A', createdAt: 1 }],
    }),
  },
}));
vi.mock('react-router-dom', async (orig) => ({
  ...(await orig<typeof import('react-router-dom')>()), useParams: () => ({ eventId: '5' }),
}));

const { Gates } = await import('./Gates');

describe('Gates', () => {
  it('registers a pending gate against the event org', async () => {
    render(<Gates />);
    await userEvent.click(await screen.findByRole('button', { name: '등록' }));
    expect(organizersOp).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: 9n,
        functionName: 'registerGate',
        args: [5n, `0x${'dd'.repeat(20)}`, `0x${'01'.repeat(32)}`, `0x${'02'.repeat(32)}`],
      }),
    );
  });
});
```

- [ ] **Step 2: 실패 확인**

Run (from `apps/web/`): `pnpm vitest run src/organizer/gates/gates.test.tsx`
Expected: FAIL — `Failed to resolve import "./Gates"`.

- [ ] **Step 3: 라이프사이클 헬퍼**

```ts
// apps/web/src/organizer/lifecycle.ts
import type { EventMetaStruct, TierStruct } from '../shared/chain/reads';
import { ticketOp } from '../shared/chain/ops';
import { getStaffAccount } from '../shared/chain/accounts';

async function send(orgId: bigint, functionName: string, args: readonly unknown[]): Promise<void> {
  await ticketOp({ account: await getStaffAccount(), orgId, functionName, args });
}

export function publishEvent(eventId: bigint, orgId: bigint): Promise<void> {
  return send(orgId, 'publishEvent', [eventId]);
}

export function cancelEvent(eventId: bigint, orgId: bigint): Promise<void> {
  return send(orgId, 'cancelEvent', [eventId]);
}

/** Draft only — the contract reverts once the event is Published. */
export function saveDraft(eventId: bigint, orgId: bigint, meta: EventMetaStruct, tiers: TierStruct[]): Promise<void> {
  return send(orgId, 'updateEventMeta', [eventId, meta, tiers]);
}
```

- [ ] **Step 4: 게이트 화면**

```tsx
// apps/web/src/organizer/gates/Gates.tsx
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { Button, Screen, Spinner } from '../../shared/ui';
import { organizerCopy } from '../copy';
import { api } from '../../shared/api/functions';
import { readTicket } from '../../shared/chain/reads';
import { organizersOp } from '../../shared/chain/ops';
import { getStaffAccount } from '../../shared/chain/accounts';

export function Gates() {
  const { eventId = '' } = useParams();
  const { data, isLoading, refetch } = useQuery({
    queryKey: ['pendingGates', eventId],
    queryFn: () => api.listPendingGates({ eventId }),
  });

  async function call(functionName: string, args: readonly unknown[]): Promise<void> {
    // The staff console bootstrap reads the same eventOrg to pass orgId into sub-plan 04's useGate.
    const orgId = await readTicket().eventOrg(BigInt(eventId));
    await organizersOp({ account: await getStaffAccount(), orgId, functionName, args });
    await refetch();
  }

  if (isLoading) return <Screen><Spinner /></Screen>;
  const gates = data?.gates ?? [];

  return (
    <Screen title={organizerCopy.gates.pending}>
      {gates.length === 0 ? <p>{organizerCopy.gates.none}</p> : null}
      <ul style={{ listStyle: 'none', padding: 0 }}>
        {gates.map((gate) => (
          <li key={gate.gateAccount} style={{ marginBottom: 12 }}>
            <p>{gate.label} · {gate.gateAccount}</p>
            <Button onClick={() => void call('registerGate', [BigInt(eventId), gate.gateAccount, gate.kx, gate.ky])}>
              {organizerCopy.gates.register}
            </Button>
          </li>
        ))}
      </ul>
      <GateControls onOpen={(gateId) => void call('openGate', [gateId])}
                    onClose={(gateId) => void call('closeGate', [gateId])} />
    </Screen>
  );
}

function GateControls({ onOpen, onClose }: { onOpen: (gateId: bigint) => void; onClose: (gateId: bigint) => void }) {
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const value = new FormData(event.currentTarget).get('gateId');
        const gateId = BigInt(String(value ?? '0'));
        if ((event.nativeEvent as SubmitEvent).submitter?.getAttribute('value') === 'open') onOpen(gateId);
        else onClose(gateId);
      }}
    >
      <input name="gateId" inputMode="numeric" placeholder="gateId" />
      <button type="submit" value="open" className="btn btn--primary">{organizerCopy.gates.open}</button>
      <button type="submit" value="close" className="btn btn--ghost">{organizerCopy.gates.close}</button>
    </form>
  );
}
```

- [ ] **Step 5: 팀·초대·공지·대시보드**

```tsx
// apps/web/src/organizer/Team.tsx
import { useState } from 'react';
import { Button, Field, Screen } from '../shared/ui';
import { organizerCopy } from './copy';
import { api } from '../shared/api/functions';
import { sendSponsoredOp } from '../shared/chain/sendSponsoredOp';
import { OpReverted } from '../shared/chain/ops';
import { getStaffAccount } from '../shared/chain/accounts';

const PERM_CREATE_EVENT = 1, PERM_MANAGE_GATES = 2, PERM_APPROVE_OVERRIDE = 4, PERM_MANAGE_MANAGERS = 8;

export function Team({ orgId = '1' }: { orgId?: string }) {
  const [phone, setPhone] = useState('');
  const [role, setRole] = useState<'admin' | 'manager'>('manager');
  const [canApprove, setCanApprove] = useState(false);
  const [bits, setBits] = useState(PERM_CREATE_EVENT | PERM_MANAGE_GATES);

  return (
    <Screen title={organizerCopy.team.admins}>
      <Field label={organizerCopy.team.invite}>
        <input value={phone} onChange={(event) => setPhone(event.target.value)} placeholder="+8210…" />
      </Field>
      <Field label={organizerCopy.team.managers}>
        <select value={role} onChange={(event) => setRole(event.target.value as 'admin' | 'manager')}>
          <option value="manager">{organizerCopy.team.managers}</option>
          <option value="admin">{organizerCopy.team.admins}</option>
        </select>
      </Field>
      {role === 'manager' ? (
        <label>
          <input type="checkbox" checked={canApprove} onChange={(event) => setCanApprove(event.target.checked)} />
          {canApprove ? organizerCopy.team.canApprove : organizerCopy.team.requestOnly}
        </label>
      ) : (
        <label>
          <input type="checkbox" checked={(bits & PERM_APPROVE_OVERRIDE) !== 0}
                 onChange={(event) => setBits(event.target.checked ? bits | PERM_APPROVE_OVERRIDE | PERM_MANAGE_MANAGERS : bits & ~PERM_APPROVE_OVERRIDE)} />
          {organizerCopy.team.canApprove}
        </label>
      )}
      <Button onClick={() => void api.createInvite({ orgId, role, phoneE164: phone, permissionBits: bits, canApprove })}>
        {organizerCopy.team.invite}
      </Button>
    </Screen>
  );
}

/**
 * Accepting an invite returns pre-encoded calldata for setAdmin/setManager on Organizers,
 * so this one write goes through sendSponsoredOp directly rather than through organizersOp.
 */
export async function applyInvite(inviteId: string): Promise<void> {
  const invite = await api.acceptInvite({ inviteId });
  const handle = await sendSponsoredOp({
    account: await getStaffAccount(),
    orgId: BigInt(invite.orgId),
    calls: [{ to: invite.to, data: invite.data }],
  });
  const receipt = await handle.wait();
  if (!receipt.success) throw new OpReverted('acceptInvite', receipt.revertReason);
}
```

```tsx
// apps/web/src/organizer/Announce.tsx
import { useState } from 'react';
import { Button, Field } from '../shared/ui';
import { organizerCopy } from './copy';
import { api } from '../shared/api/functions';
import { sendChatMessage } from '../shared/api/firestore';

export function Announce({ eventId }: { eventId: string }) {
  const [text, setText] = useState('');
  return (
    <section>
      <Field label={organizerCopy.dashboard.announce}>
        <textarea rows={3} maxLength={500} value={text} onChange={(event) => setText(event.target.value)} />
      </Field>
      <Button
        onClick={async () => {
          // sendChatMessage returns the new document id (Task 16); pinning is server-side only.
          const msgId = await sendChatMessage(eventId, text);
          await api.pinMessage({ eventId, msgId, pinned: true });
          setText('');
        }}
      >
        {organizerCopy.dashboard.announce}
      </Button>
    </section>
  );
}
```

```tsx
// apps/web/src/organizer/Dashboard.tsx
import { useQuery } from '@tanstack/react-query';
import { Screen, Spinner } from '../shared/ui';
import { organizerCopy } from './copy';
import { gql } from '../shared/envio/client';
import { EVENT_QUERY, type EnvioTier } from '../shared/envio/queries';
import { api } from '../shared/api/functions';
import { Announce } from './Announce';

export function Dashboard({ eventId = '1' }: { eventId?: string }) {
  const tiers = useQuery({
    queryKey: ['dashboardTiers', eventId],
    queryFn: () => gql<{ Tier: EnvioTier[] }>(EVENT_QUERY, { id: eventId }),
  });
  const attendees = useQuery({ queryKey: ['attendees', eventId], queryFn: () => api.listAttendees({ eventId }) });

  if (tiers.isLoading) return <Screen><Spinner /></Screen>;
  const checkedIn = (attendees.data ?? []).filter((entry) => entry.checkedIn).length;

  return (
    <Screen title={organizerCopy.dashboard.sold}>
      <table>
        <tbody>
          {(tiers.data?.Tier ?? []).map((tier) => (
            <tr key={tier.id}>
              <td>{tier.name}</td>
              <td>{organizerCopy.dashboard.sold} {tier.minted}</td>
              <td>{organizerCopy.dashboard.remaining} {tier.supply - tier.minted}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>{organizerCopy.dashboard.checkins}: {checkedIn}</p>
      <ul>
        {(attendees.data ?? []).map((entry) => (
          <li key={entry.tokenId}>
            {entry.nickname} · {entry.tier} · {entry.checkedIn ? '✓' : '—'} ·{' '}
            {organizerCopy.dashboard.kyc} {entry.kycLevel >= 1 ? organizerCopy.dashboard.kycYes : organizerCopy.dashboard.kycNo}
          </li>
        ))}
      </ul>
      <Announce eventId={eventId} />
    </Screen>
  );
}
```

- [ ] **Step 6: 테스트 통과와 커밋**

Run (from `apps/web/`): `pnpm vitest run src/organizer`
Expected: PASS — `Test Files  2 passed (2)`.

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI
git add apps/web/src/organizer
git commit -m "feat(organizer): add lifecycle, team invites, gate registration, dashboard and announcements"
```

---

## Task 31: 스태프 콘솔 UI (sub-plan 04가 로직을 붙인다)

**Files:**
- Create: `apps/web/src/staff/copy.ts`, `types.ts`, `components/StaffShell.tsx`, `TapPrompt.tsx`, `ReceivedCard.tsx`, `ConfirmingCard.tsx`, `AdmitCard.tsx`, `OfflineAdmitCard.tsx`, `DenyCard.tsx`, `OverrideDialog.tsx`, `OfflineBadge.tsx`, `components/index.ts`, `apps/web/src/staff/Console.tsx`
- Test: `apps/web/src/staff/components/console.test.tsx`

**Interfaces:**
- Consumes: `readTicket().eventOrg` (부트스트랩), `organizerCopy`는 쓰지 않는다 — 스태프 문구는 `src/staff/copy.ts`.
- Produces: `src/staff/components/index.ts`에서 **정확히 다음 이름과 props**를 내보낸다. sub-plan 04는 이 컴포넌트에 상태만 넣는다.

```ts
StaffShell({ gateName, eventTitle, staffName, chainStage, speculativeBlock, finalizedBlock, snapshotAgeSec, entriesCount, children })
TapPrompt({ rotating })
ReceivedCard({ tokenIdMasked, precheck })          // precheck: 'ok' | 'unknown' | 'fail'
ConfirmingCard({ elapsedMs })
AdmitCard({ photoJpegB64, displayName, tierLabel, seat, entryNumber, timestamp, blockNumber, deviceChangedRecently, finalized, onDone? })
OfflineAdmitCard({ photoJpegB64, displayName, tierLabel, queuedCount, onDone? })
DenyCard({ code, detail, onDone? })                 // code: 10개 사유 코드 (EVENT_ENDED 포함)
OverrideDialog({ canApprove, onSubmit, onCancel })  // onSubmit(pin: string, reason: number)
OfflineBadge({ snapshotAgeSec, queuedCount })
```

`components/index.ts`는 **컴포넌트와 props 타입을 함께** 내보낸다(`StaffShellProps`, `TapPromptProps`, …). 04가 자기 상태 기계의 반환값을 그 타입에 맞춰 선언한다. `finalized`는 스펙 §7.2 8단계의 "추측 단계에서 켜고 확정되면 굳힌다"를 그리는 값이고, `onDone`은 스태프가 카드를 닫고 다음 관객을 받는 동작이다(04가 상태를 `ready`로 되돌린다).

**이 태스크는 UI만 만든다.** 상태 전이, NFC 수신, `checkIn` 유저옵, 오프라인 큐는 전부 sub-plan 04다. 컴포넌트는 props 외의 상태를 갖지 않으며(`OverrideDialog`의 PIN 입력값만 예외), 타이머도 돌리지 않는다.

- [ ] **Step 1: 실패하는 테스트**

```tsx
// apps/web/src/staff/components/console.test.tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AdmitCard, DenyCard, OfflineBadge, OverrideDialog, ReceivedCard, StaffShell, TapPrompt } from './index';

describe('staff console components', () => {
  it('StaffShell shows the gate header with both block stages', () => {
    render(
      <StaffShell gateName="Gate A" eventTitle="재즈 나이트" staffName="민수" chainStage="speculative"
                  speculativeBlock={1234n} finalizedBlock={1232n} snapshotAgeSec={90} entriesCount={7}>
        <TapPrompt rotating />
      </StaffShell>,
    );
    expect(screen.getByText('Gate A')).toBeInTheDocument();
    expect(screen.getByText(/1234/)).toBeInTheDocument();
    expect(screen.getByText(/1232/)).toBeInTheDocument();
    expect(screen.getByText('TAP HERE')).toBeInTheDocument();
  });

  it('AdmitCard shows the photo, the amber device banner and the block number', () => {
    render(
      <AdmitCard photoJpegB64="AAAA" displayName="김민수" tierLabel="일반" seat="A-12"
                 entryNumber={7} timestamp={1790000000} blockNumber={1234n} deviceChangedRecently finalized={false} />,
    );
    expect(screen.getByRole('img')).toHaveAttribute('src', 'data:image/jpeg;base64,AAAA');
    expect(screen.getByText('24시간 내 기기 변경')).toBeInTheDocument();
    expect(screen.getByText(/1234/)).toBeInTheDocument();
  });

  it('DenyCard prints the exact spec reason copy, including EVENT_ENDED', () => {
    const { rerender } = render(<DenyCard code="ALREADY_USED" detail="12:03 · Gate A" />);
    expect(screen.getByText('이미 입장')).toBeInTheDocument();
    expect(screen.getByText('12:03 · Gate A')).toBeInTheDocument();
    rerender(<DenyCard code="EVENT_ENDED" />);
    expect(screen.getByText('행사가 끝났어요')).toBeInTheDocument();
  });

  it('DenyCard calls onDone when the staff member clears the card', async () => {
    const onDone = vi.fn();
    render(<DenyCard code="NO_TICKET" onDone={onDone} />);
    await userEvent.click(screen.getByRole('button', { name: '다음' }));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('ReceivedCard masks the ticket number and reports the snapshot pre-check', () => {
    render(<ReceivedCard tokenIdMasked="••42" precheck="ok" />);
    expect(screen.getByText('서명 받음')).toBeInTheDocument();
    expect(screen.getByText('••42')).toBeInTheDocument();
  });

  it('OverrideDialog submits a pin and a reason code only when allowed to approve', async () => {
    const onSubmit = vi.fn();
    render(<OverrideDialog canApprove onSubmit={onSubmit} onCancel={vi.fn()} />);
    await userEvent.type(screen.getByLabelText('PIN'), '1234');
    await userEvent.click(screen.getByRole('button', { name: '수동 승인' }));
    expect(onSubmit).toHaveBeenCalledWith('1234', 1);
  });

  it('OfflineBadge reports snapshot age and queue depth', () => {
    render(<OfflineBadge snapshotAgeSec={300} queuedCount={3} />);
    expect(screen.getByText('OFFLINE, 스냅샷 5분 전, 대기 3건')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 실패 확인**

Run (from `apps/web/`): `pnpm vitest run src/staff/components/console.test.tsx`
Expected: FAIL — `Failed to resolve import "./index"`.

- [ ] **Step 3: 스태프 문구와 타입**

```ts
// apps/web/src/staff/copy.ts
// Staff copy is NOT linted for crypto vocabulary: spec 13 deliberately says "체인 확인 중".
export const staffCopy = {
  idle: { snapshot: '스냅샷', entries: '입장', stageSpeculative: '추측', stageFinalized: '확정', stageOffline: '연결 끊김' },
  ready: { tap: 'TAP HERE' },
  received: { title: '서명 받음', precheckOk: '사전 검증 통과', precheckUnknown: '스냅샷에 없음', precheckFail: '사전 검증 실패' },
  confirming: { title: '체인 확인 중', retry: '다시 대세요' },
  admit: { title: 'ADMIT', deviceChanged: '24시간 내 기기 변경', block: '블록', entryNumber: '입장 순번' },
  offlineAdmit: { title: 'OFFLINE 승인', note: '복구 후 기록 예정', queued: '대기' },
  deny: {
    ALREADY_USED: '이미 입장', WRONG_EVENT: '다른 공연', REVOKED: '취소된 티켓',
    EXPIRED_CODE: '다시 대세요', NO_TICKET: '티켓 없음', GATE_CLOSED: '닫힌 게이트',
    DEVICE_LOCKED: '기기 잠김', DEVICE_MISMATCH: '기기 불일치', TX_FAILED: '전송 실패',
    EVENT_ENDED: '행사가 끝났어요',
  },
  denyEn: {
    ALREADY_USED: 'Already entered', WRONG_EVENT: 'Wrong event', REVOKED: 'Ticket revoked',
    EXPIRED_CODE: 'Tap again', NO_TICKET: 'No ticket', GATE_CLOSED: 'Gate closed',
    DEVICE_LOCKED: 'Phone locked', DEVICE_MISMATCH: 'Different phone', TX_FAILED: 'Send failed',
    EVENT_ENDED: 'This event has ended',
  },
  done: '다음',
  override: { title: '수동 승인', pin: 'PIN', approve: '수동 승인', request: '결재 요청 전송', cancel: '취소' },
  offline: { banner: 'OFFLINE, 스냅샷 {{minutes}}분 전, 대기 {{queued}}건' },
} as const;
```

```ts
// apps/web/src/staff/types.ts
export type ChainStage = 'speculative' | 'finalized' | 'offline';
export type PrecheckResult = 'ok' | 'unknown' | 'fail';
export type DenyCode =
  | 'ALREADY_USED' | 'WRONG_EVENT' | 'REVOKED' | 'EXPIRED_CODE'
  | 'NO_TICKET' | 'GATE_CLOSED' | 'DEVICE_LOCKED' | 'DEVICE_MISMATCH' | 'TX_FAILED'
  | 'EVENT_ENDED';
/** 1 사진 대조, 2 기기 문제, 3 코드 만료, 4 기타 */
export type OverrideReason = 1 | 2 | 3 | 4;
```

- [ ] **Step 4: 컴포넌트**

```tsx
// apps/web/src/staff/components/StaffShell.tsx
import type { ReactNode } from 'react';
import { staffCopy } from '../copy';
import type { ChainStage } from '../types';

export interface StaffShellProps {
  gateName: string; eventTitle: string; staffName: string; chainStage: ChainStage;
  speculativeBlock: bigint; finalizedBlock: bigint; snapshotAgeSec: number; entriesCount: number; children: ReactNode;
}

export function StaffShell({
  gateName, eventTitle, staffName, chainStage, speculativeBlock, finalizedBlock,
  snapshotAgeSec, entriesCount, children,
}: StaffShellProps) {
  const stageLabel =
    chainStage === 'speculative' ? staffCopy.idle.stageSpeculative
      : chainStage === 'finalized' ? staffCopy.idle.stageFinalized : staffCopy.idle.stageOffline;
  return (
    <main className="screen">
      <header>
        <h1>{gateName}</h1>
        <p>{eventTitle} · {staffName}</p>
        <p>{stageLabel} {String(speculativeBlock)} / {String(finalizedBlock)}</p>
        <p>{staffCopy.idle.snapshot} {Math.round(snapshotAgeSec / 60)}m · {staffCopy.idle.entries} {entriesCount}</p>
      </header>
      {children}
    </main>
  );
}
```

```tsx
// apps/web/src/staff/components/TapPrompt.tsx
import { staffCopy } from '../copy';

export interface TapPromptProps { rotating: boolean }

export function TapPrompt({ rotating }: TapPromptProps) {
  return (
    <section style={{ textAlign: 'center', padding: 48 }}>
      <h2 style={{ fontSize: 40 }}>{staffCopy.ready.tap}</h2>
      <div aria-hidden style={{ opacity: rotating ? 1 : 0.3, transition: 'opacity 0.3s' }}>●</div>
    </section>
  );
}
```

```tsx
// apps/web/src/staff/components/ReceivedCard.tsx
import { staffCopy } from '../copy';
import type { PrecheckResult } from '../types';

export interface ReceivedCardProps { tokenIdMasked: string; precheck: PrecheckResult }

export function ReceivedCard({ tokenIdMasked, precheck }: ReceivedCardProps) {
  const label =
    precheck === 'ok' ? staffCopy.received.precheckOk
      : precheck === 'unknown' ? staffCopy.received.precheckUnknown : staffCopy.received.precheckFail;
  return (
    <section>
      <h2>{staffCopy.received.title}</h2>
      <p>{tokenIdMasked}</p>
      <p>{label}</p>
    </section>
  );
}
```

```tsx
// apps/web/src/staff/components/ConfirmingCard.tsx
import { staffCopy } from '../copy';

export interface ConfirmingCardProps { elapsedMs: number }

export function ConfirmingCard({ elapsedMs }: ConfirmingCardProps) {
  return (
    <section>
      <h2>{staffCopy.confirming.title}</h2>
      {elapsedMs > 5_000 ? <p>{staffCopy.confirming.retry}</p> : null}
    </section>
  );
}
```

```tsx
// apps/web/src/staff/components/AdmitCard.tsx
import { staffCopy } from '../copy';

export interface AdmitCardProps {
  photoJpegB64: string; displayName: string; tierLabel: string; seat?: string;
  entryNumber: number; timestamp: number; blockNumber: bigint; deviceChangedRecently: boolean;
  /** false while the log is still speculative, true once the chain finalised it. */
  finalized: boolean;
  onDone?: () => void;
}

export function AdmitCard({
  photoJpegB64, displayName, tierLabel, seat, entryNumber, timestamp, blockNumber,
  deviceChangedRecently, finalized, onDone,
}: AdmitCardProps) {
  return (
    <section style={{ background: '#0f7a3d', minHeight: '70vh', padding: 16, borderRadius: 14 }}>
      <h2>{staffCopy.admit.title}</h2>
      <img src={`data:image/jpeg;base64,${photoJpegB64}`} alt={displayName} style={{ width: '100%', borderRadius: 12 }} />
      <p style={{ fontSize: 28 }}>{displayName}</p>
      <p>{tierLabel}{seat ? ` · ${seat}` : ''}</p>
      <p>{staffCopy.admit.entryNumber} {entryNumber} · {new Date(timestamp * 1000).toLocaleTimeString()}</p>
      <p>{staffCopy.admit.block} {String(blockNumber)}{finalized ? ' ✓' : ' …'}</p>
      {deviceChangedRecently ? <p style={{ background: '#ffb020', color: '#000' }}>{staffCopy.admit.deviceChanged}</p> : null}
      {onDone ? <button type="button" className="btn btn--ghost" onClick={onDone}>{staffCopy.done}</button> : null}
    </section>
  );
}
```

```tsx
// apps/web/src/staff/components/OfflineAdmitCard.tsx
import { staffCopy } from '../copy';

export interface OfflineAdmitCardProps {
  photoJpegB64: string; displayName: string; tierLabel: string; queuedCount: number; onDone?: () => void;
}

export function OfflineAdmitCard({ photoJpegB64, displayName, tierLabel, queuedCount, onDone }: OfflineAdmitCardProps) {
  return (
    <section style={{ background: '#0f7a3d', border: '4px solid #ffb020', padding: 16, borderRadius: 14 }}>
      <h2>{staffCopy.offlineAdmit.title}</h2>
      <img src={`data:image/jpeg;base64,${photoJpegB64}`} alt={displayName} style={{ width: '100%', borderRadius: 12 }} />
      <p style={{ fontSize: 28 }}>{displayName}</p>
      <p>{tierLabel}</p>
      <p>{staffCopy.offlineAdmit.note} · {staffCopy.offlineAdmit.queued} {queuedCount}</p>
      {onDone ? <button type="button" className="btn btn--ghost" onClick={onDone}>{staffCopy.done}</button> : null}
    </section>
  );
}
```

```tsx
// apps/web/src/staff/components/DenyCard.tsx
import { staffCopy } from '../copy';
import { useLocale } from '../../shared/i18n';
import type { DenyCode } from '../types';

export interface DenyCardProps { code: DenyCode; detail?: string; onDone?: () => void }

export function DenyCard({ code, detail, onDone }: DenyCardProps) {
  const locale = useLocale();
  const table = locale === 'en' ? staffCopy.denyEn : staffCopy.deny;
  return (
    <section style={{ background: '#a01820', minHeight: '70vh', padding: 16, borderRadius: 14 }} role="alert">
      <h2>{table[code]}</h2>
      {detail ? <p>{detail}</p> : null}
      {onDone ? <button type="button" className="btn btn--ghost" onClick={onDone}>{staffCopy.done}</button> : null}
    </section>
  );
}
```

```tsx
// apps/web/src/staff/components/OverrideDialog.tsx
import { useState } from 'react';
import { staffCopy } from '../copy';
import type { OverrideReason } from '../types';

export interface OverrideDialogProps {
  canApprove: boolean; onSubmit: (pin: string, reason: OverrideReason) => void; onCancel: () => void;
}

export function OverrideDialog({ canApprove, onSubmit, onCancel }: OverrideDialogProps) {
  const [pin, setPin] = useState('');
  const [reason, setReason] = useState<OverrideReason>(1);
  return (
    <section>
      <h2>{staffCopy.override.title}</h2>
      <label>
        {staffCopy.override.pin}
        <input aria-label={staffCopy.override.pin} inputMode="numeric" value={pin}
               onChange={(event) => setPin(event.target.value)} />
      </label>
      <select value={reason} onChange={(event) => setReason(Number(event.target.value) as OverrideReason)}>
        <option value={1}>1</option><option value={2}>2</option><option value={3}>3</option><option value={4}>4</option>
      </select>
      <button type="button" className="btn btn--primary" onClick={() => onSubmit(pin, reason)}>
        {canApprove ? staffCopy.override.approve : staffCopy.override.request}
      </button>
      <button type="button" className="btn btn--ghost" onClick={onCancel}>{staffCopy.override.cancel}</button>
    </section>
  );
}
```

```tsx
// apps/web/src/staff/components/OfflineBadge.tsx
import { staffCopy } from '../copy';

export interface OfflineBadgeProps { snapshotAgeSec: number; queuedCount: number }

export function OfflineBadge({ snapshotAgeSec, queuedCount }: OfflineBadgeProps) {
  const text = staffCopy.offline.banner
    .replace('{{minutes}}', String(Math.round(snapshotAgeSec / 60)))
    .replace('{{queued}}', String(queuedCount));
  return <p style={{ background: '#ffb020', color: '#000', padding: 8 }}>{text}</p>;
}
```

```ts
// apps/web/src/staff/components/index.ts
export { StaffShell, type StaffShellProps } from './StaffShell';
export { TapPrompt, type TapPromptProps } from './TapPrompt';
export { ReceivedCard, type ReceivedCardProps } from './ReceivedCard';
export { ConfirmingCard, type ConfirmingCardProps } from './ConfirmingCard';
export { AdmitCard, type AdmitCardProps } from './AdmitCard';
export { OfflineAdmitCard, type OfflineAdmitCardProps } from './OfflineAdmitCard';
export { DenyCard, type DenyCardProps } from './DenyCard';
export { OverrideDialog, type OverrideDialogProps } from './OverrideDialog';
export { OfflineBadge, type OfflineBadgeProps } from './OfflineBadge';
```

- [ ] **Step 5: 부트스트랩 라우트 (04가 `useGate`를 끼운다)**

```tsx
// apps/web/src/staff/Console.tsx
import { useEffect, useState } from 'react';
import { Route, Routes, useParams } from 'react-router-dom';
import { readTicket } from '../shared/chain/reads';
import { StaffShell, TapPrompt } from './components/index';

/** Sub-plan 04 replaces the body of this component with its useGate() state machine. */
function GateConsole() {
  const { eventId = '' } = useParams();
  const [orgId, setOrgId] = useState<bigint | null>(null);

  useEffect(() => {
    if (!eventId) return;
    void readTicket().eventOrg(BigInt(eventId)).then(setOrgId).catch(() => setOrgId(null));
  }, [eventId]);

  return (
    <StaffShell
      gateName={`Gate ${eventId}`} eventTitle={eventId} staffName="" chainStage="offline"
      speculativeBlock={0n} finalizedBlock={0n} snapshotAgeSec={0} entriesCount={0}
    >
      <TapPrompt rotating={orgId !== null} />
    </StaffShell>
  );
}

export function StaffRoutes() {
  return (
    <Routes>
      <Route path=":eventId" element={<GateConsole />} />
      <Route index element={<GateConsole />} />
    </Routes>
  );
}
```

- [ ] **Step 6: 테스트 통과와 커밋**

Run (from `apps/web/`): `pnpm vitest run src/staff`
Expected: PASS — `Tests  7 passed (7)`.

Run (from repo root): `pnpm lint:copy`
Expected: `copy-lint: clean` — `src/staff`는 린트 대상이 아니므로 "체인 확인 중"이 통과한다.

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI
git add apps/web/src/staff
git commit -m "feat(staff): add props-driven gate console components and bootstrap route"
```

---

## Task 32: Capacitor 8 — 설정, 플랫폼, 네이티브 권한, 빌드, TestFlight

**Files:**
- Create: `apps/web/capacitor.config.ts`, `apps/web/ios/App/App/Info.plist`(생성물 수정), `apps/web/ios/App/App/App.entitlements`, `apps/web/android/app/src/main/AndroidManifest.xml`(생성물 수정)
- Modify: `apps/web/package.json` scripts

**Interfaces:**
- Consumes: 앞선 모든 `shared/*` 모듈(플러그인을 실제로 호출한다), master Task 0.2가 올린 AASA/assetlinks.
- Produces: `app.monti` 앱 id의 iOS·Android 껍데기. NFC 읽기·쓰기, 패스키, Secure Enclave 기기 키, `monti://` 딥링크, 푸시가 동작한다.

- [ ] **Step 1: 플러그인 설치와 Capacitor 설정**

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/apps/web
pnpm add @capacitor/core@8 @capacitor/ios@8 @capacitor/android@8 \
  @capacitor/app@8 @capacitor/browser@8 @capacitor/push-notifications@8 @capacitor/preferences@8 \
  @capgo/capacitor-nfc @capgo/capacitor-passkey @perfood/capacitor-crypto-api @capacitor-firebase/authentication
pnpm add -D @capacitor/cli@8
cat > capacitor.config.ts <<'EOF'
import type { CapacitorConfig } from '@capacitor/cli';

const isDev = process.env.MONTI_DEV === '1';

const config: CapacitorConfig = {
  appId: 'app.monti',
  appName: 'MONTI',
  webDir: 'dist',
  ios: { contentInset: 'always', limitsNavigationsToAppBoundDomains: true },
  android: { allowMixedContent: false },
  plugins: {
    PushNotifications: { presentationOptions: ['alert', 'sound'] },
    FirebaseAuthentication: { skipNativeAuth: false, providers: ['phone'] },
  },
  // Live reload against the Vite dev server; never ship this in a release build.
  ...(isDev ? { server: { url: 'http://192.168.0.10:5173', cleartext: true } } : {}),
};

export default config;
EOF
```
Expected: `pnpm add` 가 `Done`. `capacitor.config.ts` 가 생성된다.

- [ ] **Step 2: 플랫폼 추가**

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/apps/web
pnpm build
npx cap add ios
npx cap add android
npx cap sync
```
Expected: `✔ add ios in …`, `✔ add android in …`, `✔ Sync finished in …`. `npx cap sync` 출력에 `@capgo/capacitor-nfc`, `@capgo/capacitor-passkey`, `@perfood/capacitor-crypto-api`, `@capacitor-firebase/authentication`, `@capacitor/app`, `@capacitor/browser`, `@capacitor/push-notifications`, `@capacitor/preferences` 8개가 모두 나열되어야 한다. 빠진 것이 있으면 `pnpm install` 후 다시 `npx cap sync`.

- [ ] **Step 3: iOS `Info.plist` — NFC 사용 설명, 딥링크 스킴**

`apps/web/ios/App/App/Info.plist`의 `<dict>` 안에 추가한다:

```xml
	<key>NFCReaderUsageDescription</key>
	<string>입장 확인을 위해 단말기에 휴대폰을 댈 때 사용합니다.</string>
	<key>NSFaceIDUsageDescription</key>
	<string>티켓을 입장 가능한 상태로 바꾸기 위해 사용합니다.</string>
	<key>NSCameraUsageDescription</key>
	<string>본인 확인과 QR 스캔에 사용합니다.</string>
	<key>com.apple.developer.nfc.readersession.iso7816.select-identifiers</key>
	<array>
		<string>D2760000850101</string>
	</array>
	<key>CFBundleURLTypes</key>
	<array>
		<dict>
			<key>CFBundleURLName</key>
			<string>app.monti</string>
			<key>CFBundleURLSchemes</key>
			<array>
				<string>monti</string>
			</array>
		</dict>
	</array>
```

- [ ] **Step 4: iOS entitlements — NDEF, 패스키, 유니버설 링크**

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/apps/web
cat > ios/App/App/App.entitlements <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>com.apple.developer.nfc.readersession.formats</key>
	<array>
		<string>NDEF</string>
		<string>TAG</string>
	</array>
	<key>com.apple.developer.associated-domains</key>
	<array>
		<string>webcredentials:monti.app</string>
		<string>applinks:monti.app</string>
	</array>
	<key>aps-environment</key>
	<string>development</string>
</dict>
</plist>
EOF
```

Xcode에서 `App` 타깃 → Signing & Capabilities → **Near Field Communication Tag Reading**, **Associated Domains**, **Push Notifications** 세 개를 추가하고, Build Settings의 `CODE_SIGN_ENTITLEMENTS`가 `App/App.entitlements`를 가리키는지 확인한다. `monti.app`은 `VITE_RP_ID`와 **반드시 같은 문자열**이다(다르면 패스키 계정이 통째로 끊긴다).

- [ ] **Step 5: Android `AndroidManifest.xml` — NFC 권한, 딥링크, 앱링크**

`apps/web/android/app/src/main/AndroidManifest.xml`의 `<manifest>` 바로 아래에 권한을, `MainActivity` 안에 인텐트 필터를 넣는다:

```xml
    <uses-permission android:name="android.permission.NFC" />
    <uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
    <uses-permission android:name="android.permission.USE_BIOMETRIC" />
    <uses-feature android:name="android.hardware.nfc" android:required="false" />
```

```xml
            <intent-filter>
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <category android:name="android.intent.category.BROWSABLE" />
                <data android:scheme="monti" android:host="kyc" />
            </intent-filter>
            <intent-filter android:autoVerify="true">
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <category android:name="android.intent.category.BROWSABLE" />
                <data android:scheme="https" android:host="monti.app" />
            </intent-filter>
```

WebView 안에서 패스키가 동작하려면 `MainActivity`의 `onCreate`에서 WebView 설정을 열어 줘야 한다. API는 `WebSettingsCompat`에 있고(`WebViewCompat`이 아니다), 기기가 지원하지 않을 수 있으므로 **feature 체크가 필수**다:

```java
        android.webkit.WebSettings settings = this.bridge.getWebView().getSettings();
        if (androidx.webkit.WebViewFeature.isFeatureSupported(
                androidx.webkit.WebViewFeature.WEB_AUTHENTICATION)) {
            androidx.webkit.WebSettingsCompat.setWebAuthenticationSupport(
                settings,
                androidx.webkit.WebSettingsCompat.WEB_AUTHENTICATION_SUPPORT_FOR_APP);
        }
```

`android/app/build.gradle`의 `dependencies`에 `implementation "androidx.webkit:webkit:1.12.0"` 을 더한다(좌표는 `group:artifact` = `androidx.webkit:webkit`이다).

확인:

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/apps/web/android
./gradlew :app:dependencies --configuration releaseRuntimeClasspath | grep androidx.webkit
```
Expected: `androidx.webkit:webkit:1.12.0` 한 줄. 이 단계는 Android SDK가 설치된 기기에서만 돌아간다.

- [ ] **Step 6: 동기화와 실기기 확인**

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/apps/web
pnpm build && npx cap sync
npx cap run android --target <device-id>
```
Expected: 앱이 설치되어 뜬다. 다음 넷을 눈으로 확인한다 — ① 가입에서 문자 자동 확인 또는 수신, ② Face ID/지문 프롬프트가 **한 번만** 뜨고 60초 안 두 번째 서명은 프롬프트가 없다, ③ `adb shell am start -a android.intent.action.VIEW -d "monti://kyc/callback?session=x"` 로 앱이 열린다, ④ `adb shell pm get-app-links app.monti` 가 `verified` (최대 24시간 걸린다).

```bash
npx cap open ios
```
Xcode에서 실기기로 Run → 티켓 상세에서 입장하기 → Face ID → 스태프 단말기에 대면 시스템 NFC 시트가 뜨고 진동 한 번. **Apple Pay 화면이 뜨면** `select-identifiers`의 AID를 확인한다(마스터 Task 0.3 S1b의 판단 기준).

- [ ] **Step 7: 릴리스 빌드 스크립트**

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/apps/web
node -e "const p=require('./package.json');Object.assign(p.scripts,{'cap:sync':'pnpm build && npx cap sync','cap:ios':'pnpm cap:sync && npx cap open ios','cap:android':'pnpm cap:sync && npx cap open android','dev:native':'MONTI_DEV=1 npx cap sync'});require('fs').writeFileSync('./package.json',JSON.stringify(p,null,2)+'\n')"
pnpm cap:sync
```
Expected: `✔ Sync finished`.

- [ ] **Step 8: TestFlight 내부 배포**

1. Xcode → `App` 타깃 → General → Version `0.1.0`, Build `1`. Signing은 Apple Developer 개인 계정(마스터 Task 0.2에서 가입)의 Team.
2. Product → Destination → **Any iOS Device (arm64)** → Product → **Archive**.
3. Organizer 창 → **Distribute App** → **TestFlight & App Store** → Upload. 업로드 후 App Store Connect에서 처리까지 5~15분.
4. App Store Connect → TestFlight → **Internal Testing** 그룹에 팀원 추가(최대 100명, **심사 없음**).
5. 암호화 관련 질문에는 "표준 암호화만 사용"으로 답한다(HTTPS와 플랫폼 키체인만 쓴다).
6. 설치 후 실기기에서 Step 6의 ①~④를 다시 확인한다.

**주의:** 외부 테스터 그룹은 첫 빌드에 베타 심사가 붙는다. 해커톤 데모에는 내부 배포만 쓴다.

- [ ] **Step 9: 커밋**

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI
git add apps/web/capacitor.config.ts apps/web/package.json apps/web/ios apps/web/android pnpm-lock.yaml
git commit -m "chore(web): add capacitor shells with nfc, passkey, secure enclave and deep links"
```

---

## Task 33: Playwright 스모크 3종과 CI 마무리

**Files:**
- Create: `apps/web/playwright.config.ts`, `apps/web/e2e/signup.spec.ts`, `transfer.spec.ts`, `staff.spec.ts`
- Modify: `.github/workflows/web.yml`

**Interfaces:**
- Consumes: 지금까지의 모든 화면.
- Produces: `pnpm exec playwright test` 로 도는 스모크 3종, 그리고 `pnpm lint:copy` → `typecheck` → `vitest` → `playwright` 순서로 도는 CI.

E2E는 **네트워크를 전부 가로챈다**(`page.route`). 체인·번들러·Firebase·Envio를 실제로 부르지 않으므로 CI에서 결정적으로 돈다. 실기기 검증은 Task 32 Step 6이 담당한다.

- [ ] **Step 1: Playwright 설정**

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/apps/web
pnpm exec playwright install --with-deps chromium
cat > playwright.config.ts <<'EOF'
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  use: { ...devices['iPhone 13'], baseURL: 'http://127.0.0.1:4173' },
  webServer: {
    command: 'pnpm build && pnpm preview --port 4173 --strictPort',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
EOF
```
Expected: 브라우저 다운로드 후 `playwright.config.ts` 생성.

- [ ] **Step 2: 스모크 1 — 가입 흐름이 화면 순서대로 진행된다**

```ts
// apps/web/e2e/signup.spec.ts
import { expect, test } from '@playwright/test';

test('signup walks phone to passkey, and verification lives on its own screen, with no crypto vocabulary', async ({ page }) => {
  await page.route('**/*.cloudfunctions.net/**', async (route) => {
    const name = route.request().url().split('/').pop() ?? '';
    const body = name.includes('startSignup')
      ? { result: { personId: 'p1' } }
      : name.includes('startKyc')
        ? { result: { kycUrl: 'https://verify.example/s/1' } }
        : { result: { status: 'active', kycLevel: 0 } };
    await route.fulfill({ json: body });
  });

  await page.goto('/signup/phone');
  await expect(page.getByRole('heading', { name: '휴대폰 번호를 입력해 주세요' })).toBeVisible();

  await page.goto('/me/verify');
  await expect(page.getByRole('button', { name: '본인인증 하기' })).toBeVisible();

  await page.goto('/signup/passkey');
  await expect(page.getByRole('heading', { name: 'Face ID로 잠금 설정' })).toBeVisible();

  const text = await page.locator('body').innerText();
  for (const banned of ['지갑', 'NFT', '가스', '체인', '토큰', '트랜잭션']) {
    expect(text).not.toContain(banned);
  }
});
```

- [ ] **Step 3: 스모크 2 — 비회원에게 양도하면 알람이 막는다**

```ts
// apps/web/e2e/transfer.spec.ts
import { expect, test } from '@playwright/test';

test('transferring to a non-member shows the blocking alert', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('monti.passkey', JSON.stringify({ id: 'c1', publicKey: '0x04', transports: [], attestationJson: '{}' }));
  });
  await page.route('**/resolveRecipient', async (route) => {
    await route.fulfill({ json: { result: { member: false } } });
  });

  await page.goto('/tickets/1/transfer');
  await page.getByRole('tab', { name: '별명' }).click();
  await page.getByRole('textbox').fill('nobody_here');
  await page.getByRole('button', { name: '찾기' }).click();
  await expect(page.getByText('찾을 수 없어요.')).toBeVisible();
});
```

- [ ] **Step 4: 스모크 3 — 스태프 콘솔이 판정 화면을 전부 그린다**

```ts
// apps/web/e2e/staff.spec.ts
import { expect, test } from '@playwright/test';

test('staff console renders the tap prompt and the gate header', async ({ page }) => {
  await page.goto('/staff/5');
  await expect(page.getByText('TAP HERE')).toBeVisible();
  await expect(page.getByRole('heading', { name: /Gate/ })).toBeVisible();
});
```

- [ ] **Step 5: 실행**

Run (from `apps/web/`): `pnpm exec playwright test`
Expected: `3 passed (…s)`.

- [ ] **Step 6: CI 마무리**

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI
cat > .github/workflows/web.yml <<'EOF'
name: web
on:
  push: { branches: [main] }
  pull_request:
jobs:
  web:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 10 }
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm -C packages/shared build
      - run: pnpm lint:copy
      - run: pnpm -C packages/shared vitest run
      - run: pnpm -C apps/web typecheck
      - run: pnpm vitest run
      - run: pnpm -C apps/web exec playwright install --with-deps chromium
      - run: pnpm -C apps/web exec playwright test
        env:
          VITE_CHAIN_ID: '10143'
          VITE_RPC_URLS: https://testnet-rpc.monad.xyz
          VITE_WS_URL: wss://testnet-rpc.monad.xyz
          VITE_BUNDLER_URL: https://api.pimlico.io/v2/10143/rpc?apikey=ci
          VITE_ADDR_IDENTITY: '0x0000000000000000000000000000000000000001'
          VITE_ADDR_ORGANIZERS: '0x0000000000000000000000000000000000000002'
          VITE_ADDR_TICKET: '0x0000000000000000000000000000000000000003'
          VITE_ADDR_PAYMASTER: '0x0000000000000000000000000000000000000004'
          VITE_ENVIO_URL: http://127.0.0.1:8080/v1/graphql
          VITE_RP_ID: monti.app
          VITE_IPFS_GATEWAY: https://gateway.pinata.cloud/ipfs/
          VITE_PINATA_JWT: ci
          VITE_FIREBASE_API_KEY: ci
          VITE_FIREBASE_PROJECT_ID: monti-dev
          VITE_FIREBASE_APP_ID: ci
          VITE_FIREBASE_SENDER_ID: ci
          VITE_FIREBASE_VAPID_KEY: ci
EOF
```

- [ ] **Step 7: 전체 초록 확인**

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI
pnpm -C packages/shared build && pnpm lint:copy && pnpm -C apps/web typecheck && pnpm vitest run
```
Expected: `copy-lint: clean`, typecheck 출력 없음, vitest `Test Files  … passed`, 실패 0.

- [ ] **Step 8: 커밋**

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI
git add apps/web/playwright.config.ts apps/web/e2e .github/workflows/web.yml
git commit -m "test(web): add three playwright smoke flows and finish the ci gate"
```

---

## Self-Review

### 1. 스펙 커버리지

| 스펙 / 델타 항목 | 구현 태스크 |
|---|---|
| §3 원칙 2 — 크립토 단어 금지 | 3(린트 게이트), 4(문구 전량, ko/en), 33 Step 2(E2E 금지어 스캔) |
| §5.1 가입: 전화 → 패스키 → 계정·기기 등록 (**신분증·얼굴 확인 없음**, 창업자 델타) | 17, 19 |
| 본인인증(행사별): `/me/verify`, Didit, `kycLevel` 폴링 | 18 |
| §5.1 "이미 계정이 있습니다"(중복 얼굴) | 18 Step 1 (`getSignupStatus` → `rejected`) |
| 행사별 KYC 게이트: 배지·클레임 시트·양도 사전 검사·초대 문구·받은 티켓함 | 20(배지), 21(시트), 22(`recipientNotVerified`), 23(문구·인박스) |
| 행사별 KYC 스위치: 마법사 4단계 토글 → `EventMeta.requireKyc` | 29 |
| 프로필 인증 상태 / 대시보드 인증 여부 | 27(`KycStatus`), 30(`listAttendees.kycLevel`) |
| §5.2 티켓 받기, 바코드 없음 | 21 (`claim`, `copy.tickets.noBarcode`) |
| §5.3 입장 1~6단계 | 24(무장·카운트다운·게이트 검증), 25(서명·NFC 쓰기·진동·QR), 26(결과 푸시·구독) |
| §5.4 양도: 검색·사전 검사·알람·온체인 규칙 | 22 |
| §5.5 폰 분실·교체·잠금·7일 쿨타임 | 27 (`DeviceLock`, `NewDevice`) |
| §5.6 주최자 6단계 마법사 | 29 |
| §6.1 B2 흐름(폰이 읽고 쓰고, 게이트가 체인에 쓴다) | 24·25 (관객 측), 04(게이트 측) |
| §7.2 1~4단계(관객 폰이 하는 전부) | 24 Step 5, 25 Step 3 |
| §7.2 3단계 가짜 게이트 차단(T14) | 24 (`verifyGateSignature` + `verifyGateRegistered` + 오프라인 캐시) |
| §7.3 무장 60초, 코드 60초 창 | 13(`ARM_WINDOW_SECONDS`), 24(`Countdown`) |
| §8.1 웹앱 + Capacitor 껍데기, 네이티브 4곳 | 12, 13, 15, 32 |
| §8.2 패스키 스마트 계정(Coinbase, nonce 0) | 10, 12 |
| §8.3 가스 한도 ×1.075 | 11 (테스트가 리터럴로 검증) |
| §8.4 페이마스터 `paymasterAndData` 배치 | 11 (`encodePaymasterAndData`) |
| §8.5 RPC·번들러 다중화 | 8 (`fallback`, `rank:false`), 10 |
| §9.1 Firebase 전화 인증(웹 reCAPTCHA / 네이티브 자동 확인) | 17 (선택 근거 포함) |
| §9.2 Didit 호스팅 링크 + 시스템 브라우저 + 딥링크 | 18 (가입이 아니라 `/me/verify`에서) |
| §9.3 기기 정책(1대, 60초, 잠금, 7일) | 13, 27 |
| §12 NFC 불가 시 QR 폴백 | 15(`gateResponseToQr`), 25(`Qr`) |
| §13 스태프 화면 9개 상태 | 31 (04가 로직을 붙임) |
| §17 데모 시나리오 1·4·5·8 | 33 스모크 3종 + 32 Step 6 실기기 확인 |
| v2.4 모바일 전용 + 하단 탭 + FAB | 5, 6, 21(FAB 입장하기), 29(FAB 만들기) |
| v2.4 i18n ko/en | 4 |
| v2.4 탐색(날짜·지역·테마·검색) + 행사 상세 | 20 |
| v2.4 티켓 5상태 | 21 (`deriveTicketState`) |
| v2.4 양도 3경로 + 비회원 초대 오퍼 | 22, 23 |
| v2.4 프로필·별명 | 27 |
| v2.4 행사 대화방 | 28 |
| v2.4 주최자 라이프사이클·팀·게이트·대시보드·공지 | 30 |
| v2.4 `imageCid` = 메타데이터 JSON CID | 29 (`pinJson` → `buildEventMeta`) |

**남은 구멍 두 개(의도적):** ① §8.7 유료 결제는 MVP 밖이다 — `claim(eventId, tier, voucher)`의 `voucher` 자리만 `'0x'`로 비워 두었다. ② §12의 단말기 오프라인 큐·스냅샷은 sub-plan 04다 — 이 계획은 §13 UI만 만든다.

### 1-b. 사전 점검(pre-flight) 지적 반영

`.superpowers/sdd/2026-09-20-monti-03-web-attendee/preflight.md`의 19개 블로커와 비블로커 정리 항목을 아래와 같이 반영했다.

| 지적 | 반영 위치 |
|---|---|
| B1 Capacitor·플러그인 설치가 T32에 있어 T12부터 `typecheck` 적색 | **T1** `package.json`에 전량 고정(2026-09-21 npm 실측) + Step 2 버전 검증 루프. 뒤 태스크는 import만 |
| B2 `SnapshotWire`가 v2.5 이전 모양 | **T2** — `eventTitle`, `requireKyc`, `tickets[].tierName`, `seat` 추가. 앞머리 Interfaces도 동기화 |
| B3 `lintCopy`가 import 지정자의 `chain`을 46건 오탐 | **T3** — `import`/`export … from` 줄, `import()`, `vi.mock()`, `*.test.*` 제외 + 테스트 2개 추가 |
| B4 i18n 미초기화에 기댄 컴포넌트 테스트 9개 | **T4 Step 5** — `vitest.setup.ts`가 `initI18n('ko')` 호출. `initI18n(lng?)` 시그니처 추가 |
| B5 세션 부팅 경로 없음 → 보호 라우트 영구 스피너 | **T6** — `registerSessionHydrator` / `bootSession()`, `App`이 마운트 시 호출, 3초 안전망. 테스트 2개 추가. 실제 Firebase 하이드레이터는 **T16 Step 6** |
| B6 ABI 조각에 이벤트가 하나도 없음 | **T9** — 생성 JSON 전량을 그대로 로딩(이벤트 포함) |
| B7 `abi-conformance`가 `internalType` 때문에 영구 실패 | **T9** — `normaliseTypes()`로 `internalType`·키 순서를 벗기고 **사용 매니페스트**와 대조 |
| B8 T10 `accounts.ts`가 T12의 `passkey`를 import | **T12로 이동.** T10은 `bundler.ts`만 |
| B9 가스 리터럴이 ×1.08 / ×1.0748 | **T11** — `0x347d8`, `0xd1f6`. 테스트가 `numberToHex(applyGasBuffer(…))`로 **곱셈을 먼저** 단언 |
| B10 플러그인 어댑터 3개가 존재하지 않는 export·메서드 사용 | **T12/T13/T15** — `CapacitorPasskey.createCredential/getCredential`, `CryptoApi.generateKey({tag, algorithm})`, `CapacitorNfc.startScanning/write({records})` + `type: number[]`. `as never` 제거, 각 태스크 첫 스텝이 실제 `.d.ts`를 읽는다 |
| B11 자체 플러그인이 `requireAuth`/`strongBox` 무시 | **T14** — Swift `flags` 분기, Kotlin `requireAuth`/`strongBox` 분기 + StrongBox→TEE 폴백과 `backing` 반환 |
| B12 `@monti/device-key`에 진입점·빌드 없음 | **T14** — `src/definitions.ts` + `src/index.ts`(`registerPlugin`), `tsconfig`, `build`, podspec, `CAPBridgedPlugin` 준수, base64url 패딩 복원, 워크스페이스 등록 |
| B13 `webauthn-p256-cose`가 npm에 없음 | **T12** — `cose.ts`가 `ox` + `@monti/shared/encoding`의 CBOR로 직접 파싱, 테스트 2개 |
| B14 T16 mock이 `FIREBASE_REGION` 누락 | **T16 Step 1** |
| B15 `savePushToken`이 규칙이 막는 필드까지 씀 | **T16** — `{ pushToken }` 만 |
| B16 T17 mock이 `toE164` 누락 | **T17** — `importOriginal` 스프레드 |
| B17 마감 시각 비교가 자기 단언과 충돌 | **T22** — `now < startsAt - cutoff` 만 허용, 픽스처를 `BEFORE_CUTOFF`로 옮기고 경계 차단 테스트 추가 |
| B18 `findByText('공지')`가 `"공지 · …"`와 불일치 | **T28** — 정규식 + 닫힌 방은 `textarea` `disabled`로 단언 |
| B19 `log.stage` 미사용, 2단계 표시 미구현 | **T26** — `speculative` → 표시, `finalized` → 굳힘, 역행 금지. 전이 두 개 다 테스트 |
| N1·N2·N3·N4·N5 | 메모 테스트 수정, `Alert`의 `ReactNode` import, `Countdown` 1초 단위 `act`, `bundlerRequest.mockReset()`, 소유자 키 기반 메모 |
| N6·N7·N13·N14·N15·N16 | `ChainStage`→**`LogStage`**, `startKyc → { kycUrl, sessionId }`, CI `pnpm 10`, CI에 `packages/shared` 테스트 복원, `firebase@12.6.0`, `androidx.webkit:webkit:1.12.0` |
| N10·N17·N20·N22 | 오퍼 영수증 확인(`sendOp`가 되돌림을 던짐), `AppConfig.explorerUrl`, `copy.kyc.duplicate` 실제 사용, `Qr.tsx` 불필요 import 제거 |
| 3.16/3.17 중복 여섯 블록 | **T11 `ops.ts`** — `sendOp` / `ticketOp` / `identityOp` / `organizersOp`. T21·T22·T23·T27·T29·T30이 전부 이걸 쓴다 |

### 2. 플레이스홀더 스캔

- "TBD", "TODO", "나중에", "적절히 처리" 문자열: 없음.
- "Similar to Task N": 없음. Task 29 Step 4의 `Step2When`·`Step3Tiers`·`Step4Rules`는 **같은 props 시그니처(`draft`, `patch`, `onNext`)와 구성 요소(`Field` + `input`)를 명시**했고, Task 6 Step 5의 화면 스텁도 두 개의 완전한 예시를 보여준 뒤 나머지 파일 이름을 나열했다. 반복 코드를 줄이되 실행자가 추측할 것은 남기지 않았다.
- 모든 코드 스텝에 import 포함 완전한 TypeScript/TSX가 있다. `...` 생략 없음.
- `as never` 캐스트는 플러그인 어댑터에서 전부 제거했다. 남은 여섯 개는 viem의 **타입 없는 커스텀 RPC**(`eth_getLogs` raw topics, 번들러 메서드) 세 곳과 **테스트 mock 객체** 세 곳뿐이다.
- 정의되지 않은 타입 참조: 없음. `EventMetaStruct`/`TierStruct`/`CheckInStruct`/`OfferStruct`는 Task 9 `reads.ts`에서 정의되고 Task 29·30이 그것을 import한다.

### 3. 마스터 계획과의 타입 정합

| 이름 | 이 문서 | 출처 |
|---|---|---|
| `getPublicClient`, `getBundlerClient`, `getSmartAccount` | Task 8, 10 | 마스터 "Web app module boundaries" 그대로 |
| `createPasskey`, `getPasskeyAccount` | Task 12 | 마스터 그대로 |
| `ensureDeviceKey`, `armDeviceKey`, `signWithDeviceKey` | Task 13 | **04 정합으로 인자 추가** (`{alias, requireAuth, strongBox}` / `{alias}`). 마스터의 반환 타입 `{x,y}`·`{r,s}`는 유지 |
| `readGateCode`, `writeGateResponse`, `nfcCapability` | Task 15 | 마스터 그대로 |
| `subscribeLogs` | Task 8 | **04 정합으로 `{address, topics, onLog}` + `ChainLog.stage`** (마스터의 `subscribeLogs(topic)` 자리) |
| `sendSponsoredOp` | Task 11 | **04 정합으로 `{account, calls, orgId}` → `{userOpHash, wait(timeoutMs?)}`**; 영수증은 `{success, txHash, blockNumber, revertReason?}`, 만료 시 `SponsoredOpTimeout` |
| `GateCodeWire`, `GateResponseWire`, `SnapshotWire`, `BANNED_ATTENDEE_WORDS` | Task 2 | 마스터 그대로 |
| `EventMeta`(+`category`,`regionCode`,`requireKyc`), `Tier`, `Offer`, `CheckIn`, `EventStatus` | Task 9 | 마스터 v2.4 델타 + 창업자 KYC 델타. `requireKyc`는 **구조체 맨 끝**(`regionCode` 다음)에 붙는다 |
| `Identity.kycLevelOf(address) → uint8` | Task 9 (`identityAbi`, `readIdentity`) | 창업자 KYC 델타 |
| `Event.requireKyc`, `Event.status: String`, `Tier.eventId`, `IdentityAccount.kycLevel` | Task 20 (`queries.ts`) | 02 Envio 스키마 (교차 리뷰 반영) |
| `startKyc()`, `getSignupStatus() → { status, kycLevel, account?, kycUrl? }`, `submitPendingGate(...)`, `listAttendees(...).kycLevel` | Task 16 | 02가 이 시그니처로 구현 |
| NDEF 타입 `monti.app:g` / `monti.app:s`, QR `MONTI1:` | Task 15 | 마스터 그대로 |
| 라우트 목록 | Task 6 | 마스터 + v2.4 델타(`/chats`, `/me`, `/events/:id`) |
| 콜러블 이름 15개 + 스태프 2개 | Task 16 | 마스터 표 + v2.4 델타 |
| 스태프 컴포넌트 9개 + props 타입 export | Task 31 | 04가 지정한 이름·props에 `onDone?`(Admit/OfflineAdmit/Deny), `finalized`(Admit), `DenyCode.EVENT_ENDED` 추가 |
| `getStaffAccount` / `getAttendeeAccount` | Task 10 | 04 정합 |

**교차 확인 방법:** Task 9의 `abi-conformance.test.ts`가 `USED_ABI` 매니페스트의 모든 항목(함수 + 이벤트)을 01이 생성한 `packages/shared/src/abi/*.json`과 `internalType`을 벗긴 형태로 대조한다. 01이 `EventMeta`에 필드를 더하거나 순서를 바꾸면 그 테스트가 가장 먼저 깨진다.

| 추가된 이름 | 위치 | 비고 |
|---|---|---|
| `LogStage`(구 `ChainStage`) | T8 | 04는 `ChainLog.stage`만 쓰므로 영향 없음. 스태프의 3-멤버 `ChainStage`는 T31에 그대로 |
| `sendOp` / `ticketOp` / `identityOp` / `organizersOp`, `OpReverted` | T11 `ops.ts` | 04도 `checkIn`·`manualOverride`에 쓸 수 있다 |
| `registerSessionHydrator` / `bootSession` / `SessionHydrator` | T6 | 실제 구현은 T16 `sessionHydrator.ts` |
| `USED_ABI` / `normaliseTypes` | T9 | conformance 테스트 전용 |
| `parseAttestationPublicKey` | T12 `cose.ts` | 네이티브 패스키 공개키 추출 |
| `DeviceKeyPolicyUnsupported`, `PLUGIN_SUPPORTS_ACCESS_CONTROL` | T13 | 백엔드가 생체 정책을 강제 못 하면 키를 만들지 않는다 |
| `recordTypeBytes` / `recordTypeMatches` / `TNF_EXTERNAL` | T15 | 플러그인의 `type: number[]` 대응 |
| `AppConfig.explorerUrl`, `@monti/shared/constants` | T7 / T2 | 체인 id·탐색기 리터럴을 한 곳으로 |

### 4. 이 sub-plan이 새로 정의한 콜러블 (마스터 계획에도 v2.4 델타에도 없음)

02 실행자는 아래 두 개를 추가한다. 나머지(`getSignupStatus`, `resolveRecipient`, `listPendingGates`, `createTransferInvite`, `pendingOffers`, `joinEventChat`, `reportMessage`, `listAttendees`, `submitPendingGate`)는 v2.4 델타와 02의 교차 리뷰가 이미 확정했으므로 새로 정의한 것이 아니다. **`startKyc()`는 창업자의 행사별 KYC 델타와 함께 들어온 것으로, 02가 `startSignup`에서 Didit 세션 생성을 떼어내 이쪽으로 옮긴다** — 이름·시그니처는 이 문서의 Interfaces 블록이 기준이다.

| 콜러블 | 시그니처 | 왜 필요한가 | 소비 태스크 |
|---|---|---|---|
| `pinMessage` | `{ eventId, msgId, pinned } → { ok: true }` | 공지 고정은 **조직 관리자만** 가능한데, 관리자 여부는 체인 allowlist에만 있어 Firestore 보안 규칙으로 판정할 수 없다. 서버가 `Organizers.hasPermission`을 `eth_call`로 확인하고 대신 쓴다 | 30 (`Announce`) |
| `requestAccountDeletion` | `{ reason? } → { ok: true, scheduledFor }` | 개인정보 보호법 대응 창구. `persons`/`users`/`passkeys`/`devices` 문서를 예약 삭제 큐에 넣는다. 체인의 `personId`는 난수라 남아도 사람을 식별하지 않는다 | 27 (`Profile`) |

**의도적으로 정의하지 않은 것:** `pinImage`. 주최자 브라우저가 **범위 제한 Pinata 키로 v3 업로드 엔드포인트를 직접 호출**한다(Task 29 `pinata.ts`). 이미지와 메타데이터 JSON은 공개 자료라 서버 중계의 보안 이득이 없고, 콜러블 크기 한도와 콜드스타트만 붙는다. 키는 `VITE_PINATA_JWT`로 주입하고 유출 시 콘솔에서 즉시 폐기한다. 유료 전환 시 서버 서명 업로드로 옮긴다.

### 5. 실행 순서 메모

01(ABI·주소) → 02(콜러블) 이 먼저 끝나 있어야 Task 9의 conformance 테스트와 Task 16 이후가 실제로 돈다. 병렬로 시작할 경우 **Task 1~15는 의존 없이 진행 가능**하고, Task 16부터는 02의 콜러블 이름만 있으면 mock으로 개발할 수 있다. Task 31(스태프 UI)은 04가 시작하기 전에 끝나 있어야 한다.

## 01b delta (2026-09-21)

01b 재배포 번들이 컨트랙트를 바꿨다. **아직 배포 전이다**(01b Task 15에서 새 주소로 올린다). 인터페이스 원본은 **`contracts/docs/abi-delta-01b.md`** 한 곳이고, 아래는 "어느 Task가 무엇 때문에 바뀌고 델타 문서의 어디를 읽어야 하는가"만 가리킨다. **위 Task 본문은 고치지 않는다** — 같은 파일이 `mvp-web`에도 있어 본문을 고치면 병합에서 충돌한다.

| Task | 무엇이 바뀌나 | 새 인터페이스 | 읽을 곳 |
|---|---|---|---|
| **T9 (`abis.ts`·`reads.ts`)** | ABI JSON을 01b 브랜치에서 **복사**하고(재생성 금지), `USED_ABI`에 새로 읽는 것을 등록한다. `abi-conformance.test.ts`가 제일 먼저 깨질 것이다 | `USED_ABI.Ticket`에 `deviceDigest: 5`(아래 패리티 핀용), `offerDigest: 3`(미리보기를 한다면), 이벤트는 **`CheckedIn`과 `CheckedInLate` 둘 다**. `readIdentity()`에 `rotatedAt`·`rotatedFrom`·`ROTATION_UNDO_WINDOW` 추가 | §1·§2, §8 · 03 |
| **T9 (`CheckInStruct`·`STRUCT_SHAPES`)** | `checkInOf`는 셀렉터가 그대로인데 **반환 구조가 바뀌었다** — 컴파일러도 conformance 테스트의 셀렉터 비교도 못 잡는다. 구조체 컴포넌트 이름·순서를 고정하는 `STRUCT_SHAPES` 핀을 같이 고친다 | `CHECK_IN_FIELDS` `['gateId','ts','nonceHash','manual']` → **`['gateId','nonceHash','ts','manual','late']`**, `CheckInStruct`에 `late: boolean` | **§5** |
| **T25 (`deviceSigDigest`)** | 다섯 낱말 → **일곱 낱말**. 앞에 `chainId`와 `Ticket` 주소가 붙는다. 그리고 **서명은 low-`s`만 통과한다** — `s > N/2`이면 `s = N − s`로 정규화해서 보낸다(안 하면 정상 탭의 절반이 `DEVICE_MISMATCH`) | `sha256(abi.encode(chainid, ticket, tokenId, gateId, eventId, nonce, issuedAt))`. **배포된 `deviceDigest(...)` 조회를 패리티 대상으로 한 벡터를 테스트에 핀한다** — 클라이언트가 고를 수 없는 두 낱말(`chainid`, Ticket 주소)이 정확히 손으로 만든 구현이 틀리는 지점이다. 고정 벡터 `0xca378ab2…fe66` | **§7.2** |
| **T26 (결과 화면)** | 구독하는 이벤트가 하나 늘 수 있다. 입장 수는 `CheckedIn`만 센다 | `CheckedInLate(tokenId indexed, gateId indexed, issuedAt, ts)`는 늦은 경로에서 `CheckedIn`과 **함께** 나온다(두 번째 입장이 아니다) | §2 |
| **T22·T23 (양도)** | **클라이언트 코드 변경 없음.** 양도 승인 다이제스트는 서버(02 `pendingOffers`)가 만들고 어테스터가 서명한다. 다만 받는 쪽 revert 문구가 늘어난다 | 서버 쪽이 EIP-712로 바뀐다는 사실만 안다. 받는 쪽 새 사유: `RotationPending`("계정 교체가 진행 중이라 N시간 뒤부터 받을 수 있어요"), `DeviceLocked`(이제 **보내는 쪽뿐 아니라 받는 쪽**도), `EventCancelled`(취소된 행사의 티켓은 양도되지 않는다) | **§7.1** · §6 |
| **T27 (복구 화면)** | 계정 교체 되돌리기 UI가 새로 생긴다. 그리고 **정당한 복구도 24시간 동안 아무것도 받지 못한다** — 화면이 그렇게 말해야 한다 | 되돌리기 버튼은 `rotatedFrom(personId) == 내 주소 && now < rotatedAt(personId) + ROTATION_UNDO_WINDOW`일 때만 보인다(`rotatedAt`은 `register`도 찍으므로 혼자서는 깃발이 아니다). `cancelRotation()`은 페이마스터가 스폰서한다(잔액 0인 계정에서도 된다). **되돌려도 기기 잠금은 안 풀린다** → 이어서 `setActiveDevice` 안내, 마지막 기기 변경으로부터 7일이 안 지났으면 `deviceUpdatedAt + 7일`까지 비활성으로 렌더. `migrate`가 `RotationPending`이면 "N시간 후 사용 가능" | §1 · §6 · 기획서 v2.6 §5.5 |
| **T30 (주최자)** | **삭제가 아니라 추가다** — 이 플랜에는 애초에 "MON이 필요하다"는 제약이 없다(`createOrganizer`·`transferOwner`·`revokeGate` 검색 결과 0). 새 사실을 적어 넣는다 | 주최자 조작은 전부 가스리스다. 01b 이후 `createOrganizer`, `transferOwner`, `revokeGate`, `Ticket.revoke` 네 개가 페이마스터 허용 목록에 있으므로 주최자 계정에 MON이 없어도 된다. 다만 **조직 오너·관리자·매니저 계정도 Identity 멤버여야** 페이마스터가 받는다 — 가입을 먼저 끝내고 조직을 만든다. 게이트를 잘못 등록해도 `revokeGate` 뒤 **같은 주소를 다시 등록할 수 있다** | §3 · §6 |
| **T2 (상수)** | 02와 같은 두 줄 | `LATE_WINDOW_SECONDS = 43_200`, `MIGRATE_DELAY_SECONDS = 86_400` | §2 |
| **T7 (`config.ts`)** | 재배포 후 `VITE_ADDR_IDENTITY`/`_ORGANIZERS`/`_TICKET`/`_PAYMASTER` 네 개를 **로컬 `.env`와 배포 환경 양쪽에서** 갈아준다. `config.ts`는 `loadDeployment`를 거치지 않으므로 안 바꾸면 앱이 옛 컨트랙트를 **조용히** 계속 쓴다 | | 01b Task 15 Step 5 |
