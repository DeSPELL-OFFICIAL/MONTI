# MONTI Implementation Plan · 02 Backend: Firebase Functions + Envio Indexer + Shared Package

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 이 문서를 읽기 전에 `docs/superpowers/plans/2026-09-20-monti-00-master-plan.md`의 **Shared Interfaces**를 먼저 읽으세요. 그 절의 이름과 타입이 유일한 권위이며, 이 계획은 그것을 글자 그대로 씁니다.

**Goal:** 관객 개인정보를 KMS로 암호화해 보관하고, 어테스터 키로 체인에 신원을 등록하고, 스태프 단말기에 서명된 오프라인 스냅샷을 발급하고, 체인 이벤트를 인덱싱·백업하는 **백엔드 전체**(공유 패키지 + Firebase + Envio)를 만든다.

**Architecture:** 세 덩어리다. ① `packages/shared` — 웹·Functions·인덱서가 공유하는 타입, 상수, ABI, CBOR/해시/DER 인코딩, 카피 린터. 순수 TypeScript, 런타임 의존 없음. ② `functions/` — Firebase Cloud Functions v2(Node 22, asia-northeast3). 체인에 쓰는 유일한 서버 경로는 **어테스터 EOA** 하나뿐이고, 개인정보는 Cloud KMS 봉투 암호화로만 저장한다. 판정 권한은 절대 갖지 않는다. ③ `indexer/` — Envio HyperIndex. 체인 이벤트를 목록·영수증·스냅샷 재료로 정리하고, 하루 한 번 Cloud Storage와 BigQuery로 내보낸다.

**Tech Stack:** TypeScript 5.6, pnpm 9 workspaces, tsup 8, vitest 2, viem 2.x, `cbor-x` 1.6, Firebase Admin 13 + `firebase-functions` 6(v2 API), `firebase-functions-test` 3, `@firebase/rules-unit-testing` 4, `@simplewebauthn/server` 13, `@google-cloud/kms`·`@google-cloud/secret-manager`·`@google-cloud/storage`·`@google-cloud/bigquery`, Envio HyperIndex 2.x, Firebase 에뮬레이터 스위트.

**Spec:** `docs/superpowers/specs/2026-09-20-monti-nfc-ticketing-design.md` (v2.3, 확정). 특히 §5.1, §5.5, §9, §10.3–10.4, §11, §12.

**Master plan:** `docs/superpowers/plans/2026-09-20-monti-00-master-plan.md` — Shared Interfaces가 권위.

**Depends on:** 01 Contracts. 이 계획은 sub-plan 01이 `contracts/deployments/10143.json`과 `packages/shared/src/abi/*.json`을 커밋한 뒤에 시작한다. Task 2 Step 1이 그것을 확인하고, 없으면 종료 코드 1로 멈춘다.

## Global Constraints

마스터 계획에서 그대로 복사했다. 이 계획의 **모든** 작업이 암묵적으로 이 조건을 포함한다.

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

## 이 계획 전용 추가 제약

- 서버는 **절대** 관객 키, 게이트 키, 발행 권한 키를 갖지 않는다(스펙 §6.3 T11). 서버가 가진 유일한 체인 쓰기 권한은 어테스터 EOA이고 `Identity.register` / `Identity.rotateAccount` / `Identity.lockDevice` 세 개에만 쓴다.
- 스펙 §10.4 규칙 4개를 코드로 강제한다. ① 티켓 상태·권한·입장 기록을 Firestore에 쓰지 않는다. ② Firestore 문서 키는 체인 ID(`personId`, account, `tokenId`)다. ③ 체인과 DB를 함께 건드리는 작업은 `대기 → finalized → 완료` 순서이고 `personId` 기준 멱등이다. ④ 캐시에는 `block`을 붙인다.
- `persons.status` 전이는 `pending → kyc_ok → active`만 허용한다(거절은 `rejected`, 계정 교체는 `active → rotated`). 건너뛰기는 `assertStatusTransition`이 던진다.
- 어테스터 키 보관: **MVP는 Secret Manager `ATTESTER_PK`**(이 계획에서 구현), **프로덕션은 Cloud KMS `attester` 키(EC_SIGN_SECP256K1_SHA256) 비대칭 서명**(이 계획에서 `signKeccak`으로 함께 구현하되 Functions 기본 경로는 Secret Manager). 두 경로의 주소가 같지 않아도 되며, 프로덕션 전환 시 `Identity.setAttester`를 한 번 호출한다.
- 모든 Cloud Function은 `setGlobalOptions({ region: 'asia-northeast3' })` 아래에서 정의한다. 리전을 함수마다 따로 쓰지 않는다.
- 모든 체인 쓰기는 `withGasMargin(estimate)` = `estimate × 10750 / 10000`을 `gas`로 명시한다. 명시하지 않은 쓰기는 리뷰에서 반려한다.
- 테스트는 vitest만 쓴다. 순수 함수는 `pnpm --filter <pkg> exec vitest run <file> -t "<name>"`, Firestore/Auth가 필요한 테스트는 `firebase emulators:exec`로 감싼다.
- **문자(SMS)를 서버가 보내지 않는다.** 티켓 양도 초대는 보내는 사람의 폰이 자기 문자 앱(`sms:<E164>?body=…`)으로 보낸다. 서버는 문구와 URI만 만든다. 문자 발송 비용 0원, 문자 제공자 의존 0개. 이 범위를 늘리지 않는다.
- **전화번호는 평문으로 색인하지 않는다.** 회원 검색용 색인 키는 `hmacPhone = HMAC-SHA256(PHONE_INDEX_KEY, phoneE164)` 16진수 문자열이고, `PHONE_INDEX_KEY`는 Secret Manager에만 있다. 양도 커밋먼트는 `keccak256(hmacPhone 바이트)`다.
- **이벤트 채팅은 티켓 보유가 입장권이다.** `joinEventChat`이 `Ticket.balanceOfEvent(account, eventId) > 0`, `eventStatus == Published`, `eventMeta.endsAt > now`를 **eth_call로** 확인한 뒤에만 멤버 문서를 만든다. 규칙은 멤버 문서 존재 + `closed == false`만 본다.
- `users/{uid}`에서 사용자가 직접 쓸 수 있는 필드는 `nickname`, `locale`, `chatOrder` 셋뿐이고, 그 밖에 클라이언트가 쓸 수 있는 문서는 `devices/{account}.pushToken` 하나뿐이다.

---

## File Structure

| 파일 | 책임 | Task |
|---|---|---|
| `packages/shared/package.json` | `@monti/shared` 패키지 정의, tsup 빌드, `monti-copy-lint` bin | 1 |
| `packages/shared/src/types.ts` | 마스터 계획 off-chain wire 타입 + 타입 가드 | 1 |
| `packages/shared/src/constants.ts` | 체인 id·RPC·EntryPoint·프리컴파일·AID·타이밍·금지어·배포 주소 로더 | 2 |
| `packages/shared/scripts/sync-deployments.mjs` | `contracts/deployments/*.json` → `src/deployments/` 복사 | 2 |
| `packages/shared/src/abi.ts` | 백엔드가 호출하는 함수·이벤트만 담은 `as const` viem ABI | 3 |
| `packages/shared/src/encoding.ts` | sha256 해시 헬퍼, CBOR, base64url QR, r‖s ↔ DER | 4–7 |
| `packages/shared/src/encoding.ts` (canonical 절) | 범용 canonical JSON + `SnapshotWire` keccak 다이제스트 | 8 |
| `packages/shared/src/copy-lint.ts` | 금지어 스캐너 CLI(적중 시 exit 1) | 9 |
| `firebase.json` / `.firebaserc` | 프로젝트·에뮬레이터·호스팅·리전 | 10 |
| `firestore.rules` / `storage.rules` | 클라이언트 전면 차단. 예외는 `devices/{account}.pushToken`, `users/{uid}`의 세 필드, 이벤트 채팅 메시지뿐 | 11 |
| `functions/src/lib/kms.ts` | KMS 봉투 암호화 `encryptField`/`decryptField`, `signKeccak` | 12, 13 |
| `functions/src/lib/attester.ts` | Secret Manager `ATTESTER_PK` → viem 계정 | 13 |
| `functions/src/config.ts` | 리전, 파라미터, 시크릿 선언 | 14 |
| `functions/src/lib/chain.ts` | viem public/wallet 클라이언트, `withGasMargin` 쓰기, `awaitFinalized` | 14 |
| `functions/src/lib/db.ts` | Admin SDK 싱글턴, 컬렉션 상수, `assertStatusTransition` | 15 |
| `functions/src/lib/auth.ts` | `resolveCallerAccount`, `requireStaffForGate` | 15 |
| `functions/src/lib/phoneIndex.ts` | `hmacPhone`, `recipientCommitment`, `phoneIndex` 읽기·쓰기 | 24 |
| `functions/src/lib/envio.ts` | Envio GraphQL 페이지네이션 클라이언트 | 27 |
| `functions/src/functions/*.ts` | 마스터 계획 표 + 델타의 함수 하나당 파일 하나 | 16–30 |
| `functions/src/index.ts` | 모든 함수 재수출(배포 진입점) | 14, 30 |
| `indexer/config.yaml` | 네트워크 10143, 컨트랙트·이벤트, 시작 블록 | 33 |
| `indexer/schema.graphql` | 마스터 계획 + 델타 엔티티 | 34 |
| `indexer/src/EventHandlers.ts` | 모든 이벤트 핸들러 | 35, 36 |
| `apps/web/scripts/gen-wellknown.mjs` | AASA·assetlinks 생성기 | 39 |

---

## 작업 순서

```
1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9            packages/shared (순차)
10 → 11                                       Firebase 프로젝트 파일 · 보안 규칙
12 → 13                                       KMS · 어테스터
14 → 15                                       functions 공통 계층
16 … 30                                       함수 (15 이후 서로 병렬 가능)
31 → 32                                       정합성 가드 · 에뮬레이터 통합 테스트
33 → 34 → 35 → 36 → 37 → 38                   Envio 인덱서 · Tenderly 알림
39                                            Hosting · 배포 체크리스트
40 → 41                                       sub-plan 03이 요구한 callable 2종 (15 이후 언제든)
42 → 43                                       교차 리뷰가 찾아낸 03 의존 callable 3종 · pendingGates
44                                            공연별 선택 KYC (`startKyc`) — 16·17 이후
```

### Cloud Functions 전체 목록 (44개 작업이 만드는 것 · 총 29개 함수)

| 함수 | 종류 | Task | 출처 |
|---|---|---|---|
| `startSignup` | callable | 16 | 마스터 계획 |
| `diditWebhook` | HTTPS | 17 | 마스터 계획 |
| `registerPasskey` | callable | 18 | 마스터 계획 |
| `registerIdentity` | callable | 19 | 마스터 계획 |
| `loginChallenge` / `loginVerify` | callable | 20 | 마스터 계획 |
| `lockDevice` / `startDeviceChange` | callable | 21 | 마스터 계획 |
| `issueSnapshot` / `getPhotoForGate` | callable | 22 | 마스터 계획 |
| `createInvite` / `acceptInvite` | callable | 23 | 마스터 계획 |
| `resolveRecipient` | callable | 24 | 인터페이스 델타 |
| `createTransferInvite` / `pendingOffers` | callable | 25 | 인터페이스 델타 |
| `joinEventChat` / `reportMessage` / `closeEndedChats` | callable · 스케줄 10분 | 26 | 인터페이스 델타 |
| `listAttendees` | callable | 27 | 인터페이스 델타 |
| `tenderlyWebhook` | HTTPS | 28 | 마스터 계획 + 델타 |
| `reconcilePending` | 스케줄 5분 | 29 | 마스터 계획 |
| `dailyExport` | 스케줄 03:00 KST | 30 | 마스터 계획 |
| `pinMessage` | callable | 40 | sub-plan 03 |
| `requestAccountDeletion` / `processDeletions` | callable · 스케줄 매일 04:00 | 41 | sub-plan 03 |
| `getSignupStatus` | callable | 42 | 교차 리뷰(03) |
| `startKyc` | callable | 44 | 창업자 델타(공연별 선택 KYC) |
| `submitPendingGate` / `listPendingGates` | callable | 43 | 교차 리뷰(03) |

### Firestore 컬렉션 전체 목록

| 컬렉션 | 주요 필드 | 쓰는 주체 | 클라이언트 접근 | Task |
|---|---|---|---|---|
| `persons/{personId}` | `status: 'pending'\|'active'\|'rotated'`(`kyc_ok`·`rejected`는 레거시), **`kycLevel: 0\|1`**, `account: Hex`, `kyc?: { provider:'didit', sessionId, url, status:'open'\|'approved'\|'rejected', verifiedAt?, faceSearchOk?, rejectedReason?, levelTx? }`, `enc?: { name, docNumber }`, `photoEnc?`, `chain: { registerTx?, registerPending?, block? }`, `createdAt`, `updatedAt` | Functions | 없음 | 16, 44 |
| `users/{firebaseUid}` | `personId`, `phoneE164`, `nickname?`, `locale: 'en'\|'ko'`, `chatOrder: string[]`, `createdAt` | Functions + 소유자(3필드) | `nickname`·`locale`·`chatOrder`만 쓰기 | 16, 11 |
| `passkeys/{credentialId}` | `personId`, `publicKeyCose: b64`, `counter: number`, `transports: string[]`, `createdAt`, `lastUsedAt?` | Functions | 없음 | 18 |
| `devices/{account}` | `deviceX`, `deviceY`, `platform`, `pushToken?`, `updatedAt` | Functions + 소유자(`pushToken`) | `pushToken`만 쓰기 | 11, 28 |
| `invites/{inviteId}` | `orgId`, `role`, `phoneE164`, `permissionBits?`, `canApprove?`, `status`, `acceptedAccount?` | Functions | 없음 | 23 |
| `kycSessions/{sessionId}` | `personId`, `status`, `decision`, `raw`(레닥션됨), `receivedAt` | `diditWebhook` | 없음 | 17 |
| `authChallenges/{challenge}` | `purpose: 'login'\|'register'`, `expiresAt: number`(epoch 초), `createdAt`, `usedAt?` | Functions | 없음 | 20 |
| `phoneIndex/{hmacPhone}` | `personId` | Functions | 없음 | 24 |
| `transferInvites/{inviteId}` | `tokenId`, `fromAccount`, `hmacPhone`, `commitment`, `status: 'sent'\|'accepted'\|'expired'`, `createdAt`, `expiresAt` | Functions | 없음 | 25 |
| `eventChats/{eventId}` | `closed: boolean`, `endsAt`, `orgId` | Functions | 읽기(멤버) | 26 |
| `eventChats/{eventId}/members/{uid}` | `account`, `joinedAt` | Functions | 읽기(멤버) | 26 |
| `eventChats/{eventId}/messages/{msgId}` | `uid`, `text`(≤500), `createdAt`, `reported: number`, `pinned?: boolean`(**서버만**) | 멤버 클라이언트 + Functions | 읽기·생성(멤버, 채팅 열림). `pinned` 쓰기 불가 | 26, 11, 40 |
| `deletionRequests/{personId}` | `personId`, `account`, `reason?`, `requestedAt`, `scheduledFor`(epoch 초), `status: 'scheduled'\|'done'\|'blocked'` | Functions | 없음 | 41 |
| `pendingGates/{gateAccount}` | `eventId`, `orgId`, `kx: Hex`, `ky: Hex`, `deviceLabel: string`, `submittedBy: personId`, `createdAt`, `status: 'pending'\|'registered'\|'rejected'` | Functions | 없음 | 43 |

**`authChallenges/{challenge}`는 마스터 계획 표에 없는 추가 컬렉션이다.** 문서 id가 WebAuthn 챌린지(base64url 32바이트) 자체이고, `loginChallenge`가 만들고 `registerPasskey`/`loginVerify`가 `usedAt`을 찍어 **1회만** 소비한다. `expiresAt`은 발급 후 300초(`AUTH_CHALLENGE_TTL_SECONDS`)다. 클라이언트는 읽지도 쓰지도 못한다.

---

## Task 1: `packages/shared` 패키지 뼈대와 `types.ts`

**Files:**
- Create: `packages/shared/package.json`
- Create: `packages/shared/tsconfig.json`
- Create: `packages/shared/tsup.config.ts`
- Create: `packages/shared/vitest.config.ts`
- Create: `packages/shared/src/types.ts`
- Create: `packages/shared/src/index.ts`
- Test: `packages/shared/src/types.test.ts`

**Interfaces:**
- Consumes: 없음(이 계획의 첫 작업).
- Produces: `type Hex = \`0x${string}\``, `interface GateCodeWire`, `interface GateResponseWire`, `interface SnapshotTicket`, `interface SnapshotWire`, `type PersonStatus`, `function isHex32(v: unknown): v is Hex`, `function isHex64(v: unknown): v is Hex`, `function isGateCodeWire(v: unknown): v is GateCodeWire`, `function isGateResponseWire(v: unknown): v is GateResponseWire`. 모든 후속 작업(및 sub-plan 03·04)이 `@monti/shared`에서 이 이름들을 import 한다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`packages/shared/src/types.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  EVENT_STATUS_BY_CODE,
  SUPPORTED_LOCALES,
  isGateCodeWire,
  isGateResponseWire,
  isHex32,
  isHex64,
  type GateCodeWire,
  type GateResponseWire,
} from './types.js';

const B32 = ('0x' + '11'.repeat(32)) as `0x${string}`;
const B64 = ('0x' + '22'.repeat(64)) as `0x${string}`;

const validGateCode: GateCodeWire = {
  v: 1,
  gateId: '3',
  eventId: '11',
  issuedAt: 1789862400,
  nonce: B32,
  kx: B32,
  ky: B32,
  sig: B64,
};

const validResponse: GateResponseWire = { v: 1, tokenId: '7', deviceSig: B64 };

describe('hex guards', () => {
  it('isHex32 accepts 32-byte hex and rejects the rest', () => {
    expect(isHex32(B32)).toBe(true);
    expect(isHex32(B64)).toBe(false);
    expect(isHex32('0x11')).toBe(false);
    expect(isHex32('11'.repeat(32))).toBe(false);
    expect(isHex32(null)).toBe(false);
  });

  it('isHex64 accepts 64-byte hex only', () => {
    expect(isHex64(B64)).toBe(true);
    expect(isHex64(B32)).toBe(false);
    expect(isHex64('0xZZ')).toBe(false);
  });
});

describe('wire guards', () => {
  it('isGateCodeWire accepts the master-plan shape', () => {
    expect(isGateCodeWire(validGateCode)).toBe(true);
  });

  it('isGateCodeWire rejects a wrong version', () => {
    expect(isGateCodeWire({ ...validGateCode, v: 2 })).toBe(false);
  });

  it('isGateCodeWire rejects a numeric gateId', () => {
    expect(isGateCodeWire({ ...validGateCode, gateId: 3 })).toBe(false);
  });

  it('isGateCodeWire rejects a short signature', () => {
    expect(isGateCodeWire({ ...validGateCode, sig: B32 })).toBe(false);
  });

  it('isGateResponseWire accepts the master-plan shape and rejects a bad deviceSig', () => {
    expect(isGateResponseWire(validResponse)).toBe(true);
    expect(isGateResponseWire({ ...validResponse, deviceSig: B32 })).toBe(false);
  });
});

describe('enumerations', () => {
  it('maps EventStatusChanged uint8 codes to names in chain order', () => {
    expect(EVENT_STATUS_BY_CODE[0]).toBe('Draft');
    expect(EVENT_STATUS_BY_CODE[1]).toBe('Published');
    expect(EVENT_STATUS_BY_CODE[2]).toBe('Cancelled');
    expect(EVENT_STATUS_BY_CODE[3]).toBe('Ended');
    expect(EVENT_STATUS_BY_CODE).toHaveLength(4);
  });

  it('supports exactly the two locales the app ships', () => {
    expect([...SUPPORTED_LOCALES]).toEqual(['en', 'ko']);
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm --filter @monti/shared exec vitest run src/types.test.ts`
Expected: FAIL — `No projects matched the filter "@monti/shared"` (패키지가 아직 없다)

- [ ] **Step 3: 패키지 설정 파일 4개를 만든다**

`packages/shared/package.json`:

```json
{
  "name": "@monti/shared",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.cjs",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js",
      "require": "./dist/index.cjs"
    },
    "./abi/*.json": "./src/abi/*.json"
  },
  "bin": {
    "monti-copy-lint": "./dist/copy-lint.js"
  },
  "files": ["dist", "src/abi"],
  "scripts": {
    "sync:deployments": "node scripts/sync-deployments.mjs",
    "prebuild": "pnpm sync:deployments",
    "pretest": "pnpm sync:deployments",
    "build": "tsup",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "cbor-x": "^1.6.0",
    "viem": "^2.21.0"
  },
  "devDependencies": {
    "@types/node": "^22.7.0",
    "tsup": "^8.3.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

`packages/shared/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022", "DOM"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "resolveJsonModule": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "outDir": "dist",
    "types": ["node"]
  },
  "include": ["src", "scripts"]
}
```

`packages/shared/tsup.config.ts`:

```ts
import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['esm', 'cjs'],
    dts: true,
    clean: true,
    sourcemap: true,
    outExtension: ({ format }) => ({ js: format === 'cjs' ? '.cjs' : '.js' }),
  },
  {
    entry: ['src/copy-lint.ts'],
    format: ['esm'],
    dts: false,
    clean: false,
    sourcemap: false,
    banner: { js: '#!/usr/bin/env node' },
    outExtension: () => ({ js: '.js' }),
  },
]);
```

`packages/shared/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
```

- [ ] **Step 4: `types.ts`와 `index.ts`를 쓴다**

`packages/shared/src/types.ts` — 마스터 계획 "Off-chain data formats"를 글자 그대로 옮기고 런타임 가드를 붙인다:

```ts
export type Hex = `0x${string}`;

/** Firestore `persons/{personId}.status`. 전이는 pending → kyc_ok → active 만 허용된다. */
export type PersonStatus = 'pending' | 'kyc_ok' | 'active' | 'rotated' | 'rejected';

export interface GateCodeWire {
  v: 1;
  gateId: string;
  eventId: string;
  issuedAt: number;
  nonce: Hex;
  kx: Hex;
  ky: Hex;
  /** r||s 64B by gate device key over sha256(abi.encode(gateId,eventId,issuedAt,nonce)) */
  sig: Hex;
}

export interface GateResponseWire {
  v: 1;
  tokenId: string;
  /** r||s 64B over sha256(abi.encode(tokenId,gateId,eventId,nonce,issuedAt)) */
  deviceSig: Hex;
}

export interface SnapshotTicket {
  tokenId: string;
  account: Hex;
  deviceX: Hex;
  deviceY: Hex;
  /** requireKyc 가 false 인 공연에서는 빈 문자열 — 스태프 화면이 아바타를 그린다 */
  photoJpegB64: string;
  /** 닉네임. 없으면 빈 문자열. 실명은 절대 들어가지 않는다 */
  displayName: string;
  tier: number;
  /** 티어 이름(예: "일반", "VIP"). Ticket.tiers(eventId)[tier].name */
  tierName: string;
  /** 좌석 표기. 좌석 지정이 아닌 티어는 빈 문자열 */
  seat: string;
  checkedIn: boolean;
}

export interface SnapshotWire {
  v: 1;
  eventId: string;
  /** IPFS 메타데이터(imageCid)에서 읽은 평문 공연 제목. 체인에는 해시만 있다 */
  eventTitle: string;
  /** eventMeta.requireKyc. false 면 tickets[].photoJpegB64 가 전부 빈 문자열이다 */
  requireKyc: boolean;
  epoch: number;
  expiresAt: number;
  tickets: SnapshotTicket[];
  /** secp256k1 over keccak256(canonical JSON without attesterSig) */
  attesterSig: Hex;
}

/** Ticket.EventStatusChanged 의 uint8 코드 순서. 인덱스가 곧 체인의 코드다. */
export const EVENT_STATUS_BY_CODE = ['Draft', 'Published', 'Cancelled', 'Ended'] as const;
export type EventStatus = (typeof EVENT_STATUS_BY_CODE)[number];

/** Firestore `transferInvites/{inviteId}.status` */
export type TransferInviteStatus = 'sent' | 'accepted' | 'expired';

/** Firestore `users/{uid}.locale` */
export const SUPPORTED_LOCALES = ['en', 'ko'] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

/** `resolveRecipient` callable 의 반환. 회원이 아니면 member=false 하나만 온다. */
export interface ResolveRecipientResult {
  member: boolean;
  account?: Hex;
  nickname?: string;
  /** keccak256(hmacPhone). 전화번호 초대용 커밋먼트. phone 조회에서만 채워진다. */
  commitment?: Hex;
}

/** `listAttendees` callable 의 행. 전화번호·실명은 절대 포함하지 않는다. */
export interface AttendeeRow {
  tokenId: string;
  nickname: string;
  checkedIn: boolean;
  tier: number;
  /** 0 = 전화번호만 확인된 계정, 1 = 신분증·얼굴 확인 완료 */
  kycLevel: 0 | 1;
}

const HEX_RE = /^0x[0-9a-fA-F]*$/;

function isHexOfBytes(value: unknown, bytes: number): value is Hex {
  return typeof value === 'string' && HEX_RE.test(value) && value.length === 2 + bytes * 2;
}

export function isHex32(value: unknown): value is Hex {
  return isHexOfBytes(value, 32);
}

export function isHex64(value: unknown): value is Hex {
  return isHexOfBytes(value, 64);
}

export function isAddressHex(value: unknown): value is Hex {
  return isHexOfBytes(value, 20);
}

function isDecimalString(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9]+$/.test(value);
}

export function isGateCodeWire(value: unknown): value is GateCodeWire {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.v === 1 &&
    isDecimalString(v.gateId) &&
    isDecimalString(v.eventId) &&
    typeof v.issuedAt === 'number' &&
    Number.isInteger(v.issuedAt) &&
    v.issuedAt > 0 &&
    isHex32(v.nonce) &&
    isHex32(v.kx) &&
    isHex32(v.ky) &&
    isHex64(v.sig)
  );
}

export function isGateResponseWire(value: unknown): value is GateResponseWire {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return v.v === 1 && isDecimalString(v.tokenId) && isHex64(v.deviceSig);
}
```

`packages/shared/src/index.ts`:

```ts
export * from './types.js';
```

- [ ] **Step 5: 워크스페이스에 설치하고 테스트를 통과시킨다**

Run:
```bash
pnpm install
pnpm --filter @monti/shared exec vitest run src/types.test.ts
```
Expected: PASS — `Test Files  1 passed (1)`, `Tests  9 passed (9)`

- [ ] **Step 6: 커밋**

```bash
git add packages/shared pnpm-lock.yaml
git commit -m "feat(shared): add off-chain wire types and runtime guards"
```

---

## Task 2: `constants.ts`와 배포 주소 로더

**Files:**
- Create: `packages/shared/scripts/sync-deployments.mjs`
- Create: `packages/shared/src/constants.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/src/constants.test.ts`

**Interfaces:**
- Consumes: Task 1의 `Hex`. sub-plan 01이 커밋한 `contracts/deployments/10143.json`.
- Produces: `MONAD_TESTNET_CHAIN_ID`, `MONAD_MAINNET_CHAIN_ID`, `DEFAULT_CHAIN_ID`, `MONAD_TESTNET_RPC_URL`, `MONAD_MAINNET_RPC_URL`, `ENTRY_POINT_V06_ADDRESS`, `P256_PRECOMPILE_ADDRESS`, `CREATE2_DEPLOYER_ADDRESS`, `GAS_LIMIT_MULTIPLIER_BPS`, `withGasMargin(estimate: bigint): bigint`, `HCE_AID`, `NDEF_GATE_TYPE`, `NDEF_RESPONSE_TYPE`, `QR_PREFIX`, `GATE_CODE_ROTATE_MS`, `CODE_WINDOW_SECONDS`, `ARM_WINDOW_SECONDS`, `ROTATION_COOLDOWN_SECONDS`, `DEVICE_COOLDOWN_SECONDS`, `DIDIT_WEBHOOK_TOLERANCE_SECONDS`, `SNAPSHOT_TTL_SECONDS`, `FIREBASE_REGION`, `BANNED_ATTENDEE_WORDS`, `interface Deployment`, `parseDeployment(raw: unknown): Deployment`, `getDeployment(chainId?: number): Deployment`.

**전제:** sub-plan 01 Task 13이 `contracts/deployments/10143.json`을 다음 모양으로 커밋해 두었다.

```json
{
  "chainId": 10143,
  "startBlock": 12345678,
  "identity": "0x0000000000000000000000000000000000000000",
  "organizers": "0x0000000000000000000000000000000000000000",
  "ticket": "0x0000000000000000000000000000000000000000",
  "paymaster": "0x0000000000000000000000000000000000000000",
  "factory": "0x0000000000000000000000000000000000000000",
  "attester": "0x0000000000000000000000000000000000000000"
}
```

(주소는 01이 실제 배포로 채운다. 이 계획은 값이 아니라 **모양**만 의존한다.)

- [ ] **Step 1: 배포 파일 동기화 스크립트를 쓴다**

`packages/shared/scripts/sync-deployments.mjs`:

```js
import { cp, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const from = join(here, '..', '..', '..', 'contracts', 'deployments');
const to = join(here, '..', 'src', 'deployments');

if (!existsSync(from)) {
  console.error(`[sync-deployments] ${from} 가 없습니다. sub-plan 01의 script/Deploy.s.sol을 먼저 실행하세요.`);
  process.exit(1);
}

await mkdir(to, { recursive: true });
let copied = 0;
for (const file of await readdir(from)) {
  if (!file.endsWith('.json')) continue;
  await cp(join(from, file), join(to, file));
  console.log(`[sync-deployments] ${file}`);
  copied += 1;
}

if (copied === 0) {
  console.error('[sync-deployments] 복사할 배포 파일이 없습니다.');
  process.exit(1);
}
```

Run: `pnpm --filter @monti/shared sync:deployments`
Expected: `[sync-deployments] 10143.json`

- [ ] **Step 2: 실패하는 테스트를 쓴다**

`packages/shared/src/constants.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  ATTESTER_ADDRESS,
  BANNED_ATTENDEE_WORDS,
  CODE_WINDOW_SECONDS,
  CREATE2_DEPLOYER_ADDRESS,
  DEVICE_COOLDOWN_SECONDS,
  ENTRY_POINT_V06_ADDRESS,
  EVENT_CHAT_MESSAGE_MAX_CHARS,
  FIREBASE_REGION,
  GATE_CODE_ROTATE_MS,
  HCE_AID,
  IDENTITY_ADDRESS,
  MONAD_TESTNET_CHAIN_ID,
  ORGANIZERS_ADDRESS,
  P256_PRECOMPILE_ADDRESS,
  QR_PREFIX,
  TICKET_ADDRESS,
  TRANSFER_INVITE_TTL_SECONDS,
  USER_WRITABLE_FIELDS,
  getDeployment,
  parseDeployment,
  withGasMargin,
} from './constants.js';

describe('chain constants', () => {
  it('pins the Monad testnet id, EntryPoint v0.6 and the P-256 precompile', () => {
    expect(MONAD_TESTNET_CHAIN_ID).toBe(10143);
    expect(ENTRY_POINT_V06_ADDRESS).toBe('0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789');
    expect(P256_PRECOMPILE_ADDRESS).toBe('0x0000000000000000000000000000000000000100');
    expect(CREATE2_DEPLOYER_ADDRESS).toBe('0x4e59b44847b379578588920cA78FbF26c0B4956C');
  });
});

describe('withGasMargin', () => {
  it('multiplies by exactly 1.075 with integer math', () => {
    expect(withGasMargin(275_000n)).toBe(295_625n);
    expect(withGasMargin(440_000n)).toBe(473_000n);
    expect(withGasMargin(0n)).toBe(0n);
    expect(withGasMargin(1n)).toBe(1n);
  });

  it('rejects a negative estimate', () => {
    expect(() => withGasMargin(-1n)).toThrow('NEGATIVE_GAS_ESTIMATE');
  });
});

describe('protocol timings', () => {
  it('matches spec §7.3', () => {
    expect(GATE_CODE_ROTATE_MS).toBe(3_000);
    expect(CODE_WINDOW_SECONDS).toBe(60);
    expect(DEVICE_COOLDOWN_SECONDS).toBe(604_800);
    expect(HCE_AID).toBe('D2760000850101');
    expect(QR_PREFIX).toBe('MONTI1:');
    expect(FIREBASE_REGION).toBe('asia-northeast3');
  });

  it('pins the social limits shared by rules and server code', () => {
    expect(EVENT_CHAT_MESSAGE_MAX_CHARS).toBe(500);
    expect(TRANSFER_INVITE_TTL_SECONDS).toBe(604_800);
    expect([...USER_WRITABLE_FIELDS]).toEqual(['nickname', 'locale', 'chatOrder']);
  });
});

describe('BANNED_ATTENDEE_WORDS', () => {
  it('is the master-plan list verbatim', () => {
    expect([...BANNED_ATTENDEE_WORDS]).toEqual([
      '지갑',
      'NFT',
      '민팅',
      '가스',
      '체인',
      '토큰',
      '트랜잭션',
      'wallet',
      'mint',
      'gas',
      'chain',
      'token',
      'transaction',
      'blockchain',
      'monad',
    ]);
  });
});

describe('deployments', () => {
  it('parses a well-formed deployment', () => {
    const parsed = parseDeployment({
      chainId: 10143,
      startBlock: 42,
      identity: '0x1111111111111111111111111111111111111111',
      organizers: '0x2222222222222222222222222222222222222222',
      ticket: '0x3333333333333333333333333333333333333333',
      paymaster: '0x4444444444444444444444444444444444444444',
      factory: '0x5555555555555555555555555555555555555555',
      attester: '0x6666666666666666666666666666666666666666',
    });
    expect(parsed.chainId).toBe(10143);
    expect(parsed.startBlock).toBe(42);
    expect(parsed.ticket).toBe('0x3333333333333333333333333333333333333333');
  });

  it('rejects a malformed address', () => {
    expect(() =>
      parseDeployment({
        chainId: 10143,
        startBlock: 1,
        identity: '0xnope',
        organizers: '0x2222222222222222222222222222222222222222',
        ticket: '0x3333333333333333333333333333333333333333',
        paymaster: '0x4444444444444444444444444444444444444444',
        factory: '0x5555555555555555555555555555555555555555',
        attester: '0x6666666666666666666666666666666666666666',
      }),
    ).toThrow('BAD_DEPLOYMENT_FIELD:identity');
  });

  it('returns the synced testnet deployment and rejects an unknown chain', () => {
    const deployment = getDeployment(10143);
    expect(deployment.chainId).toBe(10143);
    expect(deployment.startBlock).toBeGreaterThanOrEqual(0);
    expect(() => getDeployment(1)).toThrow('NO_DEPLOYMENT:1');
  });

  it('exports every contract address plus ATTESTER_ADDRESS at the top level', () => {
    const deployment = getDeployment();
    expect(ATTESTER_ADDRESS).toBe(deployment.attester);
    expect(IDENTITY_ADDRESS).toBe(deployment.identity);
    expect(ORGANIZERS_ADDRESS).toBe(deployment.organizers);
    expect(TICKET_ADDRESS).toBe(deployment.ticket);
    expect(ATTESTER_ADDRESS).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });
});
```

- [ ] **Step 3: 실패를 확인한다**

Run: `pnpm --filter @monti/shared exec vitest run src/constants.test.ts`
Expected: FAIL — `Failed to resolve import "./constants.js"`

- [ ] **Step 4: `constants.ts`를 쓴다**

```ts
import deployment10143 from './deployments/10143.json';
import type { Hex } from './types.js';

export const MONAD_TESTNET_CHAIN_ID = 10143;
export const MONAD_MAINNET_CHAIN_ID = 143;
export const MONAD_TESTNET_RPC_URL = 'https://testnet-rpc.monad.xyz';
export const MONAD_MAINNET_RPC_URL = 'https://rpc.monad.xyz';

/** 로직에 체인 id를 박지 않는다. CHAIN_ID / VITE_CHAIN_ID 하나로 메인넷으로 넘어간다. */
export const DEFAULT_CHAIN_ID = Number(
  (typeof process !== 'undefined' ? process.env?.CHAIN_ID : undefined) ?? MONAD_TESTNET_CHAIN_ID,
);

export const ENTRY_POINT_V06_ADDRESS = '0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789' as Hex;
export const P256_PRECOMPILE_ADDRESS = '0x0000000000000000000000000000000000000100' as Hex;
export const CREATE2_DEPLOYER_ADDRESS = '0x4e59b44847b379578588920cA78FbF26c0B4956C' as Hex;
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Hex;

/** Monad는 gas_limit 기준 과금이다. 모든 쓰기는 estimate × 1.075를 명시한다. */
export const GAS_LIMIT_MULTIPLIER_BPS = 10_750n;
export const BPS_DENOMINATOR = 10_000n;

export function withGasMargin(estimate: bigint): bigint {
  if (estimate < 0n) throw new Error('NEGATIVE_GAS_ESTIMATE');
  return (estimate * GAS_LIMIT_MULTIPLIER_BPS) / BPS_DENOMINATOR;
}

export const HCE_AID = 'D2760000850101';
export const NDEF_GATE_TYPE = 'monti.app:g';
export const NDEF_RESPONSE_TYPE = 'monti.app:s';
export const QR_PREFIX = 'MONTI1:';

export const GATE_CODE_ROTATE_MS = 3_000;
export const CODE_WINDOW_SECONDS = 60;
export const ARM_WINDOW_SECONDS = 60;
export const ROTATION_COOLDOWN_SECONDS = 7 * 24 * 60 * 60;
export const DEVICE_COOLDOWN_SECONDS = 7 * 24 * 60 * 60;
export const DIDIT_WEBHOOK_TOLERANCE_SECONDS = 300;
export const SNAPSHOT_TTL_SECONDS = 12 * 60 * 60;
export const AUTH_CHALLENGE_TTL_SECONDS = 300;

export const FIREBASE_REGION = 'asia-northeast3';

/**
 * 마스터 계획 Shared Interfaces의 배열을 글자 그대로 옮긴 것.
 * 마스터 계획 Global Constraints 문장은 `NFT`를 두 번 적고 `Monad`를 대문자로 적었지만,
 * 코드의 권위는 이 배열이며 비교는 대소문자를 무시한다.
 */
export const BANNED_ATTENDEE_WORDS = [
  '지갑',
  'NFT',
  '민팅',
  '가스',
  '체인',
  '토큰',
  '트랜잭션',
  'wallet',
  'mint',
  'gas',
  'chain',
  'token',
  'transaction',
  'blockchain',
  'monad',
] as const;

/** 이벤트 채팅 한 메시지 상한. Firestore 규칙과 서버가 같은 값을 쓴다. */
export const EVENT_CHAT_MESSAGE_MAX_CHARS = 500;
/** 전화번호 양도 초대 유효기간. */
export const TRANSFER_INVITE_TTL_SECONDS = 7 * 24 * 60 * 60;
/** 종료된 이벤트 채팅을 닫는 스케줄. */
export const CHAT_CLOSE_SCHEDULE = 'every 10 minutes';
/** 사용자가 직접 쓸 수 있는 유일한 필드들. Firestore 규칙과 정합성 테스트가 함께 쓴다. */
export const USER_WRITABLE_FIELDS = ['nickname', 'locale', 'chatOrder'] as const;

export interface Deployment {
  chainId: number;
  startBlock: number;
  identity: Hex;
  organizers: Hex;
  ticket: Hex;
  paymaster: Hex;
  factory: Hex;
  attester: Hex;
}

const ADDRESS_FIELDS = [
  'identity',
  'organizers',
  'ticket',
  'paymaster',
  'factory',
  'attester',
] as const;

export function parseDeployment(raw: unknown): Deployment {
  if (typeof raw !== 'object' || raw === null) throw new Error('BAD_DEPLOYMENT');
  const value = raw as Record<string, unknown>;
  if (typeof value.chainId !== 'number') throw new Error('BAD_DEPLOYMENT_FIELD:chainId');
  if (typeof value.startBlock !== 'number' || value.startBlock < 0) {
    throw new Error('BAD_DEPLOYMENT_FIELD:startBlock');
  }
  const out: Record<string, unknown> = { chainId: value.chainId, startBlock: value.startBlock };
  for (const field of ADDRESS_FIELDS) {
    const address = value[field];
    if (typeof address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
      throw new Error(`BAD_DEPLOYMENT_FIELD:${field}`);
    }
    out[field] = address as Hex;
  }
  return out as unknown as Deployment;
}

const DEPLOYMENTS: Record<number, Deployment> = {
  [MONAD_TESTNET_CHAIN_ID]: parseDeployment(deployment10143),
};

export function getDeployment(chainId: number = DEFAULT_CHAIN_ID): Deployment {
  const deployment = DEPLOYMENTS[chainId];
  if (!deployment) throw new Error(`NO_DEPLOYMENT:${chainId}`);
  return deployment;
}

/**
 * 어테스터 EOA 주소. contracts/deployments/{chainId}.json 의 `attester` 필드다.
 * 스태프 단말기(sub-plan 04)가 스냅샷 서명을 검증할 때 이 주소와 대조한다.
 */
export const ATTESTER_ADDRESS: Hex = getDeployment().attester;
export const IDENTITY_ADDRESS: Hex = getDeployment().identity;
export const ORGANIZERS_ADDRESS: Hex = getDeployment().organizers;
export const TICKET_ADDRESS: Hex = getDeployment().ticket;
export const PAYMASTER_ADDRESS: Hex = getDeployment().paymaster;
export const FACTORY_ADDRESS: Hex = getDeployment().factory;
```

`packages/shared/src/index.ts`에 한 줄 추가:

```ts
export * from './types.js';
export * from './constants.js';
```

- [ ] **Step 5: 테스트를 통과시킨다**

Run: `pnpm --filter @monti/shared exec vitest run src/constants.test.ts`
Expected: PASS — `Tests  10 passed (10)`

- [ ] **Step 6: 커밋**

```bash
git add packages/shared/src/constants.ts packages/shared/src/constants.test.ts \
        packages/shared/src/deployments packages/shared/scripts/sync-deployments.mjs \
        packages/shared/src/index.ts packages/shared/package.json
git commit -m "feat(shared): add chain, protocol and copy constants with deployment loader"
```

---

## Task 3: 타입 있는 ABI 프래그먼트(`abi.ts`)

**Files:**
- Create: `packages/shared/src/abi.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/src/abi.test.ts`

**Interfaces:**
- Consumes: sub-plan 01이 커밋한 `packages/shared/src/abi/{Identity,Organizers,Ticket,MontiPaymaster,CoinbaseSmartWalletFactory}.json`(각각 ABI 배열).
- Produces: `identityAbi`, `organizersAbi`, `ticketAbi`, `factoryAbi` — viem 추론이 살아 있는 `as const` 배열. 그리고 원본 JSON 재수출 `identityAbiJson`, `organizersAbiJson`, `ticketAbiJson`(인덱서와 웹이 쓴다).

**왜 두 벌인가:** JSON import는 `as const` 리터럴 타입을 잃어 viem의 `readContract` 반환 타입이 `unknown`이 된다. Functions는 타입이 필요하므로 **백엔드가 실제로 호출하는 함수와 구독하는 이벤트만** 손으로 옮긴 좁은 `as const` ABI를 쓴다. 전체 ABI는 인덱서·웹용으로 JSON 그대로 둔다. Task 30의 정합성 테스트가 두 벌이 어긋나지 않는지 검사한다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`packages/shared/src/abi.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  factoryAbi,
  identityAbi,
  identityAbiJson,
  organizersAbi,
  organizersAbiJson,
  ticketAbi,
  ticketAbiJson,
} from './abi.js';

type AbiItem = { type: string; name?: string; inputs?: unknown[] };

function names(abi: readonly unknown[], type: string): string[] {
  return (abi as AbiItem[]).filter((i) => i.type === type && i.name).map((i) => i.name as string);
}

describe('typed ABI fragments', () => {
  it('exposes every Identity call the backend makes', () => {
    expect(names(identityAbi, 'function')).toEqual(
      expect.arrayContaining([
        'register', 'rotateAccount', 'lockDevice', 'accountOf', 'personOf', 'isMember',
        'activeDevice', 'isLocked', 'deviceUpdatedAt', 'setNickname', 'nicknameOwner',
        'nicknameOf', 'attester', 'setKycLevel', 'kycLevelOf',
      ]),
    );
    expect(names(identityAbi, 'event')).toEqual(
      expect.arrayContaining(['Registered', 'AccountRotated', 'DeviceChanged', 'DeviceLocked', 'NicknameSet', 'KycLevelSet']),
    );
  });

  it('exposes every Organizers call the backend makes', () => {
    expect(names(organizersAbi, 'function')).toEqual(
      expect.arrayContaining(['hasPermission', 'managerOf', 'isOpenGate', 'gateOf', 'gateInfo', 'ownerOf', 'setAdmin', 'setManager']),
    );
  });

  it('exposes every Ticket call the backend makes', () => {
    expect(names(ticketAbi, 'function')).toEqual(
      expect.arrayContaining([
        'eventOf', 'eventOrg', 'ownerOf', 'checkInOf', 'tierOf', 'balanceOfEvent',
        'eventMeta', 'eventStatus', 'createOffer', 'cancelOffer', 'acceptOffer', 'offerOf',
      ]),
    );
    expect(names(ticketAbi, 'event')).toEqual(
      expect.arrayContaining([
        'CheckedIn', 'Claimed', 'Transfer', 'ManualOverride', 'EventStatusChanged',
        'OfferCreated', 'OfferCancelled', 'OfferAccepted',
      ]),
    );
  });

  it('exposes the Coinbase factory getAddress used for the counterfactual account', () => {
    expect(names(factoryAbi, 'function')).toContain('getAddress');
  });

  it('keeps every typed fragment present in the generated JSON ABI', () => {
    const pairs: Array<[readonly unknown[], readonly unknown[], string]> = [
      [identityAbi, identityAbiJson, 'Identity'],
      [organizersAbi, organizersAbiJson, 'Organizers'],
      [ticketAbi, ticketAbiJson, 'Ticket'],
    ];
    for (const [typed, json, label] of pairs) {
      for (const kind of ['function', 'event']) {
        for (const name of names(typed, kind)) {
          expect(names(json, kind), `${label}.${kind} ${name}`).toContain(name);
        }
      }
    }
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm --filter @monti/shared exec vitest run src/abi.test.ts`
Expected: FAIL — `Failed to resolve import "./abi.js"`

- [ ] **Step 3: `abi.ts`를 쓴다**

```ts
import identityAbiJsonRaw from './abi/Identity.json';
import organizersAbiJsonRaw from './abi/Organizers.json';
import ticketAbiJsonRaw from './abi/Ticket.json';
import montiPaymasterAbiJsonRaw from './abi/MontiPaymaster.json';

export const identityAbiJson = identityAbiJsonRaw as readonly unknown[];
export const organizersAbiJson = organizersAbiJsonRaw as readonly unknown[];
export const ticketAbiJson = ticketAbiJsonRaw as readonly unknown[];
export const montiPaymasterAbiJson = montiPaymasterAbiJsonRaw as readonly unknown[];

export const identityAbi = [
  {
    type: 'function',
    name: 'register',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'personId', type: 'bytes32' },
      { name: 'account', type: 'address' },
      { name: 'deviceX', type: 'bytes32' },
      { name: 'deviceY', type: 'bytes32' },
      { name: 'kycLevel', type: 'uint8' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'setKycLevel',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'personId', type: 'bytes32' },
      { name: 'level', type: 'uint8' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'kycLevelOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint8' }],
  },
  {
    type: 'function',
    name: 'rotateAccount',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'personId', type: 'bytes32' },
      { name: 'newAccount', type: 'address' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'lockDevice',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'accountOf',
    stateMutability: 'view',
    inputs: [{ name: 'personId', type: 'bytes32' }],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'personOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'bytes32' }],
  },
  {
    type: 'function',
    name: 'isMember',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'activeDevice',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [
      { name: 'x', type: 'bytes32' },
      { name: 'y', type: 'bytes32' },
    ],
  },
  {
    type: 'function',
    name: 'isLocked',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'deviceUpdatedAt',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint64' }],
  },
  {
    type: 'function',
    name: 'setNickname',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'nicknameHash', type: 'bytes32' },
      { name: 'nickname', type: 'string' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'nicknameOwner',
    stateMutability: 'view',
    inputs: [{ name: 'nicknameHash', type: 'bytes32' }],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'nicknameOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'string' }],
  },
  {
    type: 'function',
    name: 'attester',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'event',
    name: 'Registered',
    inputs: [
      { name: 'personId', type: 'bytes32', indexed: true },
      { name: 'account', type: 'address', indexed: true },
    ],
  },
  {
    type: 'event',
    name: 'AccountRotated',
    inputs: [
      { name: 'personId', type: 'bytes32', indexed: true },
      { name: 'oldAccount', type: 'address', indexed: true },
      { name: 'newAccount', type: 'address', indexed: true },
    ],
  },
  {
    type: 'event',
    name: 'DeviceChanged',
    inputs: [
      { name: 'account', type: 'address', indexed: true },
      { name: 'x', type: 'bytes32', indexed: false },
      { name: 'y', type: 'bytes32', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'DeviceLocked',
    inputs: [
      { name: 'account', type: 'address', indexed: true },
      { name: 'locked', type: 'bool', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'NicknameSet',
    inputs: [
      { name: 'account', type: 'address', indexed: true },
      { name: 'nicknameHash', type: 'bytes32', indexed: true },
      { name: 'nickname', type: 'string', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'KycLevelSet',
    inputs: [
      { name: 'account', type: 'address', indexed: true },
      { name: 'level', type: 'uint8', indexed: false },
    ],
  },
] as const;

export const organizersAbi = [
  {
    type: 'function',
    name: 'ownerOf',
    stateMutability: 'view',
    inputs: [{ name: 'orgId', type: 'uint256' }],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'hasPermission',
    stateMutability: 'view',
    inputs: [
      { name: 'orgId', type: 'uint256' },
      { name: 'account', type: 'address' },
      { name: 'bit', type: 'uint32' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'managerOf',
    stateMutability: 'view',
    inputs: [
      { name: 'orgId', type: 'uint256' },
      { name: 'account', type: 'address' },
    ],
    outputs: [
      { name: 'exists', type: 'bool' },
      { name: 'canApprove', type: 'bool' },
    ],
  },
  {
    type: 'function',
    name: 'isOpenGate',
    stateMutability: 'view',
    inputs: [
      { name: 'eventId', type: 'uint256' },
      { name: 'gateAccount', type: 'address' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'gateOf',
    stateMutability: 'view',
    inputs: [{ name: 'gateAccount', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'gateInfo',
    stateMutability: 'view',
    inputs: [{ name: 'gateId', type: 'uint256' }],
    outputs: [
      { name: 'eventId', type: 'uint256' },
      { name: 'account', type: 'address' },
      { name: 'kx', type: 'bytes32' },
      { name: 'ky', type: 'bytes32' },
      { name: 'open', type: 'bool' },
      { name: 'revoked', type: 'bool' },
    ],
  },
  {
    type: 'function',
    name: 'setAdmin',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'orgId', type: 'uint256' },
      { name: 'admin', type: 'address' },
      { name: 'permissionBits', type: 'uint32' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'setManager',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'orgId', type: 'uint256' },
      { name: 'manager', type: 'address' },
      { name: 'exists', type: 'bool' },
      { name: 'canApprove', type: 'bool' },
    ],
    outputs: [],
  },
  {
    type: 'event',
    name: 'AdminSet',
    inputs: [
      { name: 'orgId', type: 'uint256', indexed: true },
      { name: 'admin', type: 'address', indexed: true },
      { name: 'bits', type: 'uint32', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'ManagerSet',
    inputs: [
      { name: 'orgId', type: 'uint256', indexed: true },
      { name: 'manager', type: 'address', indexed: true },
      { name: 'exists', type: 'bool', indexed: false },
      { name: 'canApprove', type: 'bool', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'GateRegistered',
    inputs: [
      { name: 'gateId', type: 'uint256', indexed: true },
      { name: 'eventId', type: 'uint256', indexed: true },
      { name: 'gateAccount', type: 'address', indexed: true },
      { name: 'kx', type: 'bytes32', indexed: false },
      { name: 'ky', type: 'bytes32', indexed: false },
    ],
  },
] as const;

export const ticketAbi = [
  {
    type: 'function',
    name: 'ownerOf',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'eventOf',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'tierOf',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ name: '', type: 'uint8' }],
  },
  {
    type: 'function',
    name: 'eventOrg',
    stateMutability: 'view',
    inputs: [{ name: 'eventId', type: 'uint256' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'checkInOf',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          { name: 'gateId', type: 'uint256' },
          { name: 'ts', type: 'uint64' },
          { name: 'nonceHash', type: 'bytes32' },
          { name: 'manual', type: 'bool' },
        ],
      },
    ],
  },
  {
    type: 'function',
    name: 'balanceOfEvent',
    stateMutability: 'view',
    inputs: [
      { name: 'account', type: 'address' },
      { name: 'eventId', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'eventMeta',
    stateMutability: 'view',
    inputs: [{ name: 'eventId', type: 'uint256' }],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          { name: 'orgId', type: 'uint256' },
          { name: 'titleHash', type: 'bytes32' },
          { name: 'descHash', type: 'bytes32' },
          { name: 'imageCid', type: 'string' },
          { name: 'startsAt', type: 'uint64' },
          { name: 'endsAt', type: 'uint64' },
          { name: 'venueHash', type: 'bytes32' },
          { name: 'saleStart', type: 'uint64' },
          { name: 'saleEnd', type: 'uint64' },
          { name: 'transferable', type: 'bool' },
          { name: 'transferCutoffSeconds', type: 'uint32' },
          { name: 'maxTransfers', type: 'uint8' },
          { name: 'approvalRequired', type: 'bool' },
          { name: 'category', type: 'uint8' },
          { name: 'regionCode', type: 'bytes32' },
          { name: 'requireKyc', type: 'bool' },
        ],
      },
    ],
  },
  {
    type: 'function',
    name: 'eventStatus',
    stateMutability: 'view',
    inputs: [{ name: 'eventId', type: 'uint256' }],
    outputs: [{ name: '', type: 'uint8' }],
  },
  {
    type: 'function',
    name: 'createOffer',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'tokenId', type: 'uint256' },
      { name: 'recipientCommitment', type: 'bytes32' },
      { name: 'expiresAt', type: 'uint64' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'cancelOffer',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'acceptOffer',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'tokenId', type: 'uint256' },
      { name: 'attesterSig', type: 'bytes' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'offerOf',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [
      { name: 'from', type: 'address' },
      { name: 'recipientCommitment', type: 'bytes32' },
      { name: 'expiresAt', type: 'uint64' },
    ],
  },
  {
    type: 'event',
    name: 'Claimed',
    inputs: [
      { name: 'tokenId', type: 'uint256', indexed: true },
      { name: 'eventId', type: 'uint256', indexed: true },
      { name: 'to', type: 'address', indexed: true },
      { name: 'tier', type: 'uint8', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'EventStatusChanged',
    inputs: [
      { name: 'eventId', type: 'uint256', indexed: true },
      { name: 'status', type: 'uint8', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'OfferCreated',
    inputs: [
      { name: 'tokenId', type: 'uint256', indexed: true },
      { name: 'from', type: 'address', indexed: true },
      { name: 'recipientCommitment', type: 'bytes32', indexed: true },
      { name: 'expiresAt', type: 'uint64', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'OfferCancelled',
    inputs: [{ name: 'tokenId', type: 'uint256', indexed: true }],
  },
  {
    type: 'event',
    name: 'OfferAccepted',
    inputs: [
      { name: 'tokenId', type: 'uint256', indexed: true },
      { name: 'to', type: 'address', indexed: true },
      { name: 'recipientCommitment', type: 'bytes32', indexed: true },
    ],
  },
  {
    type: 'event',
    name: 'Transfer',
    inputs: [
      { name: 'from', type: 'address', indexed: true },
      { name: 'to', type: 'address', indexed: true },
      { name: 'tokenId', type: 'uint256', indexed: true },
    ],
  },
  {
    type: 'event',
    name: 'CheckedIn',
    inputs: [
      { name: 'tokenId', type: 'uint256', indexed: true },
      { name: 'eventId', type: 'uint256', indexed: true },
      { name: 'gateId', type: 'uint256', indexed: true },
      { name: 'nonceHash', type: 'bytes32', indexed: false },
      { name: 'ts', type: 'uint64', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'ManualOverride',
    inputs: [
      { name: 'tokenId', type: 'uint256', indexed: true },
      { name: 'gateId', type: 'uint256', indexed: true },
      { name: 'approver', type: 'address', indexed: true },
      { name: 'role', type: 'uint8', indexed: false },
      { name: 'reason', type: 'uint8', indexed: false },
    ],
  },
] as const;

export const factoryAbi = [
  {
    type: 'function',
    name: 'getAddress',
    stateMutability: 'view',
    inputs: [
      { name: 'owners', type: 'bytes[]' },
      { name: 'nonce', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'createAccount',
    stateMutability: 'payable',
    inputs: [
      { name: 'owners', type: 'bytes[]' },
      { name: 'nonce', type: 'uint256' },
    ],
    outputs: [{ name: 'account', type: 'address' }],
  },
] as const;
```

`packages/shared/src/index.ts`:

```ts
export * from './types.js';
export * from './constants.js';
export * from './abi.js';
```

- [ ] **Step 4: 테스트를 통과시킨다**

Run: `pnpm --filter @monti/shared exec vitest run src/abi.test.ts`
Expected: PASS — `Tests  5 passed (5)`

- [ ] **Step 5: 커밋**

```bash
git add packages/shared/src/abi.ts packages/shared/src/abi.test.ts packages/shared/src/index.ts
git commit -m "feat(shared): add typed viem ABI fragments for backend calls"
```

---

## Task 4: `encoding.ts` — 서명 다이제스트 헬퍼 (고정 테스트 벡터)

**Files:**
- Create: `packages/shared/src/encoding.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/src/encoding.hash.test.ts`

**Interfaces:**
- Consumes: Task 1 `Hex`.
- Produces:
  - `gateCodeHash(input: { gateId: bigint; eventId: bigint; issuedAt: bigint; nonce: Hex }): Hex` — 게이트 단말기가 서명하는 sha256. 마스터 계획 `GateCodeWire.sig` 주석의 `sha256(abi.encode(gateId,eventId,issuedAt,nonce))`.
  - `deviceSigHash(input: { tokenId: bigint; gateId: bigint; eventId: bigint; nonce: Hex; issuedAt: bigint }): Hex` — 관객 기기 키가 서명하는 sha256. `Ticket.checkIn`이 컨트랙트 안에서 다시 계산하는 값과 **바이트 단위로 같아야 한다**.
  - `normalizeNickname(raw: string): string` — NFKC 정규화 → 앞뒤 공백 제거 → 소문자.
  - `nicknameHash(raw: string): Hex` — `keccak256(utf8(normalizeNickname(raw)))`. `Identity.setNickname` / `Identity.nicknameOwner`의 인자.
  - `recipientCommitment(hmacPhoneHex: string): Hex` — `keccak256(32바이트 hmacPhone)`. `Ticket.createOffer`의 `recipientCommitment`.
  - `offerDigest(input: { tokenId: bigint; recipientCommitment: Hex; recipientAccount: Hex }): Hex` — 어테스터가 서명하는 `keccak256(abi.encode(uint256,bytes32,address))`. `Ticket.acceptOffer`가 검증한다.

- [ ] **Step 1: 실패하는 테스트를 쓴다 (고정 벡터 포함)**

`packages/shared/src/encoding.hash.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { keccak256 } from 'viem';
import {
  deviceSigHash,
  gateCodeHash,
  nicknameHash,
  normalizeNickname,
  offerDigest,
  recipientCommitment,
} from './encoding.js';
import type { Hex } from './types.js';

const NONCE = ('0x' + '11'.repeat(32)) as Hex;
const ISSUED_AT = 1_789_862_400n; // 2026-09-20T00:00:00Z

describe('gateCodeHash', () => {
  it('matches the fixed vector for gateId=3 eventId=11 issuedAt=1789862400 nonce=0x11*32', () => {
    expect(gateCodeHash({ gateId: 3n, eventId: 11n, issuedAt: ISSUED_AT, nonce: NONCE })).toBe(
      '0xb284e28bf3727ec6a13b3fd1b195cadd348b187d2e904c4013961c068cbe121d',
    );
  });

  it('changes when any field changes', () => {
    const base = gateCodeHash({ gateId: 3n, eventId: 11n, issuedAt: ISSUED_AT, nonce: NONCE });
    expect(gateCodeHash({ gateId: 4n, eventId: 11n, issuedAt: ISSUED_AT, nonce: NONCE })).not.toBe(base);
    expect(gateCodeHash({ gateId: 3n, eventId: 12n, issuedAt: ISSUED_AT, nonce: NONCE })).not.toBe(base);
    expect(gateCodeHash({ gateId: 3n, eventId: 11n, issuedAt: ISSUED_AT + 1n, nonce: NONCE })).not.toBe(base);
  });
});

describe('deviceSigHash', () => {
  it('matches the fixed vector Ticket.checkIn recomputes on chain', () => {
    expect(
      deviceSigHash({ tokenId: 7n, gateId: 3n, eventId: 11n, nonce: NONCE, issuedAt: ISSUED_AT }),
    ).toBe('0xc99dfaef599235b36414480bc53054182d5f7fc67a33c60233f3f73f7fc560c7');
  });

  it('is not the gate hash with the same inputs', () => {
    expect(deviceSigHash({ tokenId: 7n, gateId: 3n, eventId: 11n, nonce: NONCE, issuedAt: ISSUED_AT })).not.toBe(
      gateCodeHash({ gateId: 3n, eventId: 11n, issuedAt: ISSUED_AT, nonce: NONCE }),
    );
  });

  it('rejects a nonce that is not 32 bytes', () => {
    expect(() =>
      deviceSigHash({ tokenId: 7n, gateId: 3n, eventId: 11n, nonce: '0x11' as Hex, issuedAt: ISSUED_AT }),
    ).toThrow('BAD_NONCE');
  });
});

describe('nickname hashing', () => {
  it('normalizes case, width and surrounding whitespace', () => {
    expect(normalizeNickname('  ALEX  ')).toBe('alex');
    expect(normalizeNickname('ＡＬＥＸ')).toBe('alex');
    expect(nicknameHash('  ALEX  ')).toBe(nicknameHash('alex'));
  });

  it('matches keccak256(utf8("alex"))', () => {
    expect(nicknameHash('Alex')).toBe('0xb83330129510a2461236adc7254a3b4e2f2fa25457c7dcb82be80de0f8c96183');
    expect(nicknameHash('Alex')).toBe(keccak256(new TextEncoder().encode('alex')));
  });

  it('rejects an empty nickname', () => {
    expect(() => nicknameHash('   ')).toThrow('EMPTY_NICKNAME');
  });
});

describe('transfer commitments', () => {
  it('matches the fixed vector for hmacPhone 0x11*32', () => {
    expect(recipientCommitment('11'.repeat(32))).toBe(
      '0xb569321de72d0af89c2fb48a484de3fc9343f31600ae1f3e13d633cb48cbf816',
    );
  });

  it('accepts the 0x prefixed form identically', () => {
    expect(recipientCommitment('0x' + '11'.repeat(32))).toBe(recipientCommitment('11'.repeat(32)));
  });

  it('rejects a short hmacPhone', () => {
    expect(() => recipientCommitment('1111')).toThrow('BAD_HMAC_PHONE');
  });
});

describe('offerDigest', () => {
  it('matches the fixed vector the attester signs for acceptOffer', () => {
    expect(
      offerDigest({
        tokenId: 7n,
        recipientCommitment: ('0x' + '11'.repeat(32)) as Hex,
        recipientAccount: '0x0000000000000000000000000000000000000001' as Hex,
      }),
    ).toBe('0x90244cd7dea2e76fcbe10bb1f52ca2fe9bf143d9f9943bc8f792e664d052ed0a');
  });

  it('changes when the recipient account changes', () => {
    const a = offerDigest({
      tokenId: 7n,
      recipientCommitment: ('0x' + '11'.repeat(32)) as Hex,
      recipientAccount: '0x0000000000000000000000000000000000000001' as Hex,
    });
    const b = offerDigest({
      tokenId: 7n,
      recipientCommitment: ('0x' + '11'.repeat(32)) as Hex,
      recipientAccount: '0x0000000000000000000000000000000000000002' as Hex,
    });
    expect(a).not.toBe(b);
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm --filter @monti/shared exec vitest run src/encoding.hash.test.ts`
Expected: FAIL — `Failed to resolve import "./encoding.js"`

- [ ] **Step 3: `encoding.ts`의 다이제스트 부분을 쓴다**

```ts
import { encodeAbiParameters, keccak256, parseAbiParameters, sha256, stringToBytes } from 'viem';
import type { Hex } from './types.js';

function assertBytes32(value: Hex, label: string): void {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error(label);
}

/** 게이트 단말기의 게이트 키가 서명하는 값. GateCodeWire.sig 가 이 해시에 대한 r||s 다. */
export function gateCodeHash(input: {
  gateId: bigint;
  eventId: bigint;
  issuedAt: bigint;
  nonce: Hex;
}): Hex {
  assertBytes32(input.nonce, 'BAD_NONCE');
  return sha256(
    encodeAbiParameters(
      parseAbiParameters('uint256 gateId, uint256 eventId, uint64 issuedAt, bytes32 nonce'),
      [input.gateId, input.eventId, input.issuedAt, input.nonce],
    ),
  );
}

/**
 * 관객 기기 키가 서명하는 값. Ticket.checkIn 이 체인 위에서
 * sha256(abi.encode(tokenId, g.gateId, g.eventId, g.nonce, g.issuedAt)) 로 다시 계산한다.
 * 인자 순서를 바꾸면 모든 체크인이 실패한다.
 */
export function deviceSigHash(input: {
  tokenId: bigint;
  gateId: bigint;
  eventId: bigint;
  nonce: Hex;
  issuedAt: bigint;
}): Hex {
  assertBytes32(input.nonce, 'BAD_NONCE');
  return sha256(
    encodeAbiParameters(
      parseAbiParameters('uint256 tokenId, uint256 gateId, uint256 eventId, bytes32 nonce, uint64 issuedAt'),
      [input.tokenId, input.gateId, input.eventId, input.nonce, input.issuedAt],
    ),
  );
}

/** 닉네임 비교는 항상 이 정규형으로 한다. 웹·서버·인덱서가 같은 함수를 쓴다. */
export function normalizeNickname(raw: string): string {
  return raw.normalize('NFKC').trim().toLowerCase();
}

export function nicknameHash(raw: string): Hex {
  const normalized = normalizeNickname(raw);
  if (normalized.length === 0) throw new Error('EMPTY_NICKNAME');
  return keccak256(stringToBytes(normalized));
}

/**
 * hmacPhone = HMAC-SHA256(PHONE_INDEX_KEY, phoneE164) 의 32바이트를 그대로 keccak 한다.
 * 0x 접두사 유무는 무시한다. 결과가 Ticket.createOffer 의 recipientCommitment 다.
 */
export function recipientCommitment(hmacPhoneHex: string): Hex {
  const bare = hmacPhoneHex.startsWith('0x') ? hmacPhoneHex.slice(2) : hmacPhoneHex;
  if (!/^[0-9a-fA-F]{64}$/.test(bare)) throw new Error('BAD_HMAC_PHONE');
  return keccak256(`0x${bare.toLowerCase()}` as Hex);
}

/** 어테스터가 acceptOffer 용으로 서명하는 다이제스트. */
export function offerDigest(input: {
  tokenId: bigint;
  recipientCommitment: Hex;
  recipientAccount: Hex;
}): Hex {
  assertBytes32(input.recipientCommitment, 'BAD_COMMITMENT');
  if (!/^0x[0-9a-fA-F]{40}$/.test(input.recipientAccount)) throw new Error('BAD_ACCOUNT');
  return keccak256(
    encodeAbiParameters(
      parseAbiParameters('uint256 tokenId, bytes32 recipientCommitment, address recipientAccount'),
      [input.tokenId, input.recipientCommitment, input.recipientAccount],
    ),
  );
}
```

`packages/shared/src/index.ts`:

```ts
export * from './types.js';
export * from './constants.js';
export * from './abi.js';
export * from './encoding.js';
```

- [ ] **Step 4: 테스트를 통과시킨다**

Run: `pnpm --filter @monti/shared exec vitest run src/encoding.hash.test.ts`
Expected: PASS — `Tests  11 passed (11)`

- [ ] **Step 5: 고정 벡터를 체인 쪽과 맞춘다**

sub-plan 01의 Foundry 테스트에 같은 벡터가 있는지 확인한다.

Run:
```bash
grep -n "c99dfaef599235b36414480bc53054182d5f7fc67a33c60233f3f73f7fc560c7" contracts/test/*.sol || \
  echo "MISSING: sub-plan 01 Ticket.t.sol 에 같은 deviceSigHash 벡터를 추가하세요"
```
Expected: `contracts/test/Ticket.t.sol:NN:` 한 줄. 없으면 위 메시지가 뜨고, 01 담당자에게 벡터를 전달한 뒤 계속 진행한다(02를 막지는 않는다).

- [ ] **Step 6: 커밋**

```bash
git add packages/shared/src/encoding.ts packages/shared/src/encoding.hash.test.ts packages/shared/src/index.ts
git commit -m "feat(shared): add gate, device, nickname and offer signature digests"
```

---

## Task 5: `encoding.ts` — `GateCodeWire` CBOR

**Files:**
- Modify: `packages/shared/src/encoding.ts`
- Test: `packages/shared/src/encoding.gatecode.test.ts`

**Interfaces:**
- Consumes: Task 1 `GateCodeWire`, `isGateCodeWire`; Task 2 `NDEF_GATE_TYPE`.
- Produces: `encodeGateCode(wire: GateCodeWire): Uint8Array`, `decodeGateCode(bytes: Uint8Array): GateCodeWire`. sub-plan 04의 HCE 플러그인이 `encodeGateCode`의 결과를 NDEF external record `monti.app:g`의 payload로 그대로 쓴다. sub-plan 03의 관객 앱이 `decodeGateCode`를 쓴다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`packages/shared/src/encoding.gatecode.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { decodeGateCode, encodeGateCode } from './encoding.js';
import type { GateCodeWire, Hex } from './types.js';

const B32 = ('0x' + '11'.repeat(32)) as Hex;
const B64 = ('0x' + '22'.repeat(64)) as Hex;

const wire: GateCodeWire = {
  v: 1,
  gateId: '3',
  eventId: '11',
  issuedAt: 1_789_862_400,
  nonce: B32,
  kx: B32,
  ky: ('0x' + '33'.repeat(32)) as Hex,
  sig: B64,
};

describe('GateCodeWire CBOR', () => {
  it('round-trips every field', () => {
    expect(decodeGateCode(encodeGateCode(wire))).toEqual(wire);
  });

  it('fits in a Type 4 NDEF payload', () => {
    expect(encodeGateCode(wire).byteLength).toBeLessThanOrEqual(400);
  });

  it('is deterministic for the same input', () => {
    expect(Buffer.from(encodeGateCode(wire)).toString('hex')).toBe(
      Buffer.from(encodeGateCode(wire)).toString('hex'),
    );
  });

  it('refuses to encode a wire with a wrong version', () => {
    expect(() => encodeGateCode({ ...wire, v: 2 } as unknown as GateCodeWire)).toThrow('BAD_GATE_CODE');
  });

  it('refuses to decode garbage', () => {
    expect(() => decodeGateCode(new Uint8Array([0x00, 0x01, 0x02]))).toThrow('BAD_GATE_CODE');
  });

  it('refuses to decode a CBOR map that is not a gate code', () => {
    const notAGateCode = encodeGateCode(wire);
    notAGateCode[notAGateCode.length - 1] ^= 0xff;
    expect(() => decodeGateCode(notAGateCode)).toThrow('BAD_GATE_CODE');
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm --filter @monti/shared exec vitest run src/encoding.gatecode.test.ts`
Expected: FAIL — `decodeGateCode is not a function`

- [ ] **Step 3: `encoding.ts`에 CBOR 코덱을 추가한다**

파일 맨 위 import 줄을 바꾸고, 파일 끝에 코덱을 덧붙인다:

```ts
import { Encoder } from 'cbor-x';
import { encodeAbiParameters, keccak256, parseAbiParameters, sha256, stringToBytes } from 'viem';
import { isGateCodeWire, type GateCodeWire, type Hex } from './types.js';
```

```ts
/**
 * NFC로 오가는 바이트라서 옵션을 고정한다.
 * - useRecords: false  → 레코드 확장 태그를 쓰지 않는다(다른 구현이 못 읽는다)
 * - mapsAsObjects: true → 디코드 결과가 일반 객체
 * - variableMapSize: true → 길이 프리픽스를 최소 크기로
 */
const cbor = new Encoder({
  useRecords: false,
  mapsAsObjects: true,
  variableMapSize: true,
  tagUint8Array: false,
  useFloat32: 0,
});

export function encodeGateCode(wire: GateCodeWire): Uint8Array {
  if (!isGateCodeWire(wire)) throw new Error('BAD_GATE_CODE');
  return new Uint8Array(cbor.encode(wire));
}

export function decodeGateCode(bytes: Uint8Array): GateCodeWire {
  let decoded: unknown;
  try {
    decoded = cbor.decode(bytes);
  } catch {
    throw new Error('BAD_GATE_CODE');
  }
  if (!isGateCodeWire(decoded)) throw new Error('BAD_GATE_CODE');
  return decoded;
}
```

- [ ] **Step 4: 테스트를 통과시킨다**

Run: `pnpm --filter @monti/shared exec vitest run src/encoding.gatecode.test.ts`
Expected: PASS — `Tests  6 passed (6)`

- [ ] **Step 5: 커밋**

```bash
git add packages/shared/src/encoding.ts packages/shared/src/encoding.gatecode.test.ts
git commit -m "feat(shared): add CBOR codec for GateCodeWire"
```

---

## Task 6: `encoding.ts` — `GateResponseWire` CBOR와 `MONTI1:` QR 폴백

**Files:**
- Modify: `packages/shared/src/encoding.ts`
- Test: `packages/shared/src/encoding.response.test.ts`

**Interfaces:**
- Consumes: Task 1 `GateResponseWire`, `isGateResponseWire`; Task 2 `QR_PREFIX`.
- Produces: `encodeGateResponse(wire: GateResponseWire): Uint8Array`, `decodeGateResponse(bytes: Uint8Array): GateResponseWire`, `base64UrlEncode(bytes: Uint8Array): string`, `base64UrlDecode(text: string): Uint8Array`, `toQrPayload(wire: GateResponseWire): string`, `fromQrPayload(text: string): GateResponseWire`. sub-plan 03이 NFC 쓰기 payload와 QR 문자열을 만들 때, sub-plan 04가 읽을 때 쓴다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`packages/shared/src/encoding.response.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  base64UrlDecode,
  base64UrlEncode,
  decodeGateResponse,
  encodeGateResponse,
  fromQrPayload,
  toQrPayload,
} from './encoding.js';
import type { GateResponseWire, Hex } from './types.js';

const wire: GateResponseWire = {
  v: 1,
  tokenId: '7',
  deviceSig: ('0x' + '22'.repeat(64)) as Hex,
};

describe('base64url', () => {
  it('encodes without padding and without + or /', () => {
    expect(base64UrlEncode(new Uint8Array([0xa2, 0x61, 0x76, 0x01, 0xff, 0xfe, 0x00, 0x10]))).toBe('omF2Af_-ABA');
    expect(base64UrlEncode(new Uint8Array([0xfb, 0xff, 0xbf, 0x3e, 0x3f]))).toBe('-_-_Pj8');
  });

  it('round-trips arbitrary bytes', () => {
    const bytes = new Uint8Array(256).map((_, i) => i);
    expect(Array.from(base64UrlDecode(base64UrlEncode(bytes)))).toEqual(Array.from(bytes));
  });
});

describe('GateResponseWire CBOR', () => {
  it('round-trips', () => {
    expect(decodeGateResponse(encodeGateResponse(wire))).toEqual(wire);
  });

  it('stays inside the 400-byte NDEF write budget', () => {
    expect(encodeGateResponse(wire).byteLength).toBeLessThanOrEqual(400);
  });

  it('refuses a 32-byte deviceSig', () => {
    expect(() =>
      encodeGateResponse({ ...wire, deviceSig: ('0x' + '22'.repeat(32)) as Hex }),
    ).toThrow('BAD_GATE_RESPONSE');
  });
});

describe('QR fallback', () => {
  it('prefixes MONTI1: and stays URL safe', () => {
    const payload = toQrPayload(wire);
    expect(payload.startsWith('MONTI1:')).toBe(true);
    expect(payload).not.toMatch(/[+/=]/);
  });

  it('round-trips through the QR payload', () => {
    expect(fromQrPayload(toQrPayload(wire))).toEqual(wire);
  });

  it('rejects a payload without the prefix', () => {
    expect(() => fromQrPayload('MONTI2:abc')).toThrow('BAD_QR_PREFIX');
    expect(() => fromQrPayload('https://example.com')).toThrow('BAD_QR_PREFIX');
  });

  it('rejects a well-prefixed payload whose body is not a gate response', () => {
    expect(() => fromQrPayload('MONTI1:AAEC')).toThrow('BAD_GATE_RESPONSE');
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm --filter @monti/shared exec vitest run src/encoding.response.test.ts`
Expected: FAIL — `toQrPayload is not a function`

- [ ] **Step 3: `encoding.ts`에 응답 코덱과 QR 헬퍼를 추가한다**

import 줄을 다음으로 바꾼다:

```ts
import { Encoder } from 'cbor-x';
import { encodeAbiParameters, keccak256, parseAbiParameters, sha256, stringToBytes } from 'viem';
import { QR_PREFIX } from './constants.js';
import {
  isGateCodeWire,
  isGateResponseWire,
  type GateCodeWire,
  type GateResponseWire,
  type Hex,
} from './types.js';
```

파일 끝에 추가:

```ts
export function encodeGateResponse(wire: GateResponseWire): Uint8Array {
  if (!isGateResponseWire(wire)) throw new Error('BAD_GATE_RESPONSE');
  return new Uint8Array(cbor.encode(wire));
}

export function decodeGateResponse(bytes: Uint8Array): GateResponseWire {
  let decoded: unknown;
  try {
    decoded = cbor.decode(bytes);
  } catch {
    throw new Error('BAD_GATE_RESPONSE');
  }
  if (!isGateResponseWire(decoded)) throw new Error('BAD_GATE_RESPONSE');
  return decoded;
}

/** 브라우저(atob/btoa)와 Node 22 양쪽에서 같은 결과를 낸다. Buffer를 쓰지 않는다. */
export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i] as number);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlDecode(text: string): Uint8Array {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(text.length / 4) * 4, '=');
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    throw new Error('BAD_BASE64URL');
  }
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/** NFC 쓰기가 실패하는 기기(아이폰 브라우저 접속자)용 QR 문자열. */
export function toQrPayload(wire: GateResponseWire): string {
  return `${QR_PREFIX}${base64UrlEncode(encodeGateResponse(wire))}`;
}

export function fromQrPayload(text: string): GateResponseWire {
  if (!text.startsWith(QR_PREFIX)) throw new Error('BAD_QR_PREFIX');
  return decodeGateResponse(base64UrlDecode(text.slice(QR_PREFIX.length)));
}
```

- [ ] **Step 4: 테스트를 통과시킨다**

Run: `pnpm --filter @monti/shared exec vitest run src/encoding.response.test.ts`
Expected: PASS — `Tests  8 passed (8)`

- [ ] **Step 5: NDEF 페이로드 크기를 기록한다**

Run:
```bash
pnpm --filter @monti/shared exec node -e "
const { encodeGateResponse } = require('./dist/index.cjs');
console.log('GateResponseWire CBOR bytes =', encodeGateResponse({ v: 1, tokenId: '7', deviceSig: '0x' + '22'.repeat(64) }).byteLength);
" 2>/dev/null || echo 'dist 빌드는 Task 9에서 한다. 지금은 테스트 결과로 충분하다.'
```
Expected: 두 줄 중 하나. 스펙 §7.3은 약 130바이트를 예상했지만 `GateResponseWire`가 16진수 **문자열**을 쓰므로 실제로는 약 160바이트다. Type 4 CC 한도 안이므로 문제 없으며, 이 사실을 Self-Review에 적는다.

- [ ] **Step 6: 커밋**

```bash
git add packages/shared/src/encoding.ts packages/shared/src/encoding.response.test.ts
git commit -m "feat(shared): add GateResponseWire CBOR codec and MONTI1 QR fallback"
```

---

## Task 7: `encoding.ts` — r‖s ↔ DER 변환

**Files:**
- Modify: `packages/shared/src/encoding.ts`
- Test: `packages/shared/src/encoding.der.test.ts`

**Interfaces:**
- Consumes: Task 1 `Hex`.
- Produces: `splitRs(sig: Hex): { r: Hex; s: Hex }`, `joinRs(r: Hex, s: Hex): Hex`, `rsToDer(sig: Hex): Hex`, `derToRs(der: Hex): Hex`.

**왜 필요한가:** 기기 키·게이트 키 플러그인(iOS Secure Enclave, Android Keystore)과 Cloud KMS는 ECDSA 서명을 **DER**로 준다. 컨트랙트(`Ticket.checkIn`)와 wire 타입(`GateCodeWire.sig`, `GateResponseWire.deviceSig`)은 **r‖s 64바이트**를 쓴다. 이 변환이 없으면 sub-plan 03·04가 각자 구현하게 된다.

- [ ] **Step 1: 실패하는 테스트를 쓴다 (고정 벡터 3개)**

`packages/shared/src/encoding.der.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { derToRs, joinRs, rsToDer, splitRs } from './encoding.js';
import type { Hex } from './types.js';

const R1 = ('0x' + '11'.repeat(32)) as Hex;
const S1 = ('0x' + '22'.repeat(32)) as Hex;

describe('splitRs / joinRs', () => {
  it('splits a 64-byte signature in half', () => {
    expect(splitRs(joinRs(R1, S1))).toEqual({ r: R1, s: S1 });
  });

  it('rejects a signature that is not 64 bytes', () => {
    expect(() => splitRs(R1)).toThrow('BAD_RS_LENGTH');
    expect(() => joinRs(R1, ('0x' + '22'.repeat(31)) as Hex)).toThrow('BAD_RS_LENGTH');
  });
});

describe('rsToDer', () => {
  it('encodes a signature whose high bits are clear', () => {
    expect(rsToDer(joinRs(R1, S1))).toBe(
      '0x30440220' + '11'.repeat(32) + '0220' + '22'.repeat(32),
    );
  });

  it('prepends 0x00 when the high bit of r is set', () => {
    const r = '0xd47ce4c025c35ec440bc81d99834a624875161a26bf56ef7fdc0f5d52f843ad1' as Hex;
    const s = '0x44a8bcd0d3f9b1f6b8c65d5b3d8b5c4e2a1f0e9d8c7b6a594837261504f3e2d1' as Hex;
    expect(rsToDer(joinRs(r, s))).toBe(
      '0x3045022100d47ce4c025c35ec440bc81d99834a624875161a26bf56ef7fdc0f5d52f843ad1022044a8bcd0d3f9b1f6b8c65d5b3d8b5c4e2a1f0e9d8c7b6a594837261504f3e2d1',
    );
  });

  it('strips leading zero bytes', () => {
    const r = '0x00000000000000000000000000000000000000000000000000000000000000ff' as Hex;
    const s = '0x007f000000000000000000000000000000000000000000000000000000000001' as Hex;
    expect(rsToDer(joinRs(r, s))).toBe(
      '0x3025020200ff021f7f000000000000000000000000000000000000000000000000000000000001',
    );
  });
});

describe('derToRs', () => {
  it('reverses each rsToDer vector', () => {
    const pairs: Array<[Hex, Hex]> = [
      [R1, S1],
      [
        '0xd47ce4c025c35ec440bc81d99834a624875161a26bf56ef7fdc0f5d52f843ad1' as Hex,
        '0x44a8bcd0d3f9b1f6b8c65d5b3d8b5c4e2a1f0e9d8c7b6a594837261504f3e2d1' as Hex,
      ],
      [
        '0x00000000000000000000000000000000000000000000000000000000000000ff' as Hex,
        '0x007f000000000000000000000000000000000000000000000000000000000001' as Hex,
      ],
    ];
    for (const [r, s] of pairs) {
      expect(derToRs(rsToDer(joinRs(r, s)))).toBe(joinRs(r, s));
    }
  });

  it('rejects a non-SEQUENCE', () => {
    expect(() => derToRs('0x3144' as Hex)).toThrow('BAD_DER');
  });

  it('rejects a truncated body', () => {
    expect(() => derToRs('0x30440220' as Hex)).toThrow('BAD_DER');
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm --filter @monti/shared exec vitest run src/encoding.der.test.ts`
Expected: FAIL — `rsToDer is not a function`

- [ ] **Step 3: DER 변환을 구현한다**

`encoding.ts` 끝에 추가:

```ts
function hexToBytes(hex: Hex): Uint8Array {
  const bare = hex.slice(2);
  const out = new Uint8Array(bare.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(bare.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(bytes: Uint8Array): Hex {
  let out = '0x';
  for (let i = 0; i < bytes.length; i += 1) out += (bytes[i] as number).toString(16).padStart(2, '0');
  return out as Hex;
}

export function splitRs(sig: Hex): { r: Hex; s: Hex } {
  if (!/^0x[0-9a-fA-F]{128}$/.test(sig)) throw new Error('BAD_RS_LENGTH');
  return { r: `0x${sig.slice(2, 66)}` as Hex, s: `0x${sig.slice(66)}` as Hex };
}

export function joinRs(r: Hex, s: Hex): Hex {
  if (!/^0x[0-9a-fA-F]{64}$/.test(r) || !/^0x[0-9a-fA-F]{64}$/.test(s)) throw new Error('BAD_RS_LENGTH');
  return `0x${r.slice(2)}${s.slice(2)}` as Hex;
}

/** DER INTEGER 는 최소 길이 + 양수 표현이라 선행 0을 버리고 최상위 비트가 1이면 0x00을 붙인다. */
function toDerInteger(value: Uint8Array): Uint8Array {
  let start = 0;
  while (start < value.length - 1 && value[start] === 0) start += 1;
  const trimmed = value.subarray(start);
  const needsPad = ((trimmed[0] as number) & 0x80) !== 0;
  const body = needsPad ? new Uint8Array([0, ...trimmed]) : trimmed;
  return new Uint8Array([0x02, body.length, ...body]);
}

export function rsToDer(sig: Hex): Hex {
  const { r, s } = splitRs(sig);
  const rDer = toDerInteger(hexToBytes(r));
  const sDer = toDerInteger(hexToBytes(s));
  const body = new Uint8Array([...rDer, ...sDer]);
  return bytesToHex(new Uint8Array([0x30, body.length, ...body]));
}

function readDerInteger(bytes: Uint8Array, offset: number): { value: Uint8Array; next: number } {
  if (bytes[offset] !== 0x02) throw new Error('BAD_DER');
  const length = bytes[offset + 1];
  if (length === undefined || offset + 2 + length > bytes.length) throw new Error('BAD_DER');
  let value = bytes.subarray(offset + 2, offset + 2 + length);
  while (value.length > 32 && value[0] === 0) value = value.subarray(1);
  if (value.length > 32) throw new Error('BAD_DER');
  const padded = new Uint8Array(32);
  padded.set(value, 32 - value.length);
  return { value: padded, next: offset + 2 + length };
}

export function derToRs(der: Hex): Hex {
  if (!/^0x([0-9a-fA-F]{2})+$/.test(der)) throw new Error('BAD_DER');
  const bytes = hexToBytes(der);
  if (bytes[0] !== 0x30) throw new Error('BAD_DER');
  if (bytes[1] !== bytes.length - 2) throw new Error('BAD_DER');
  const r = readDerInteger(bytes, 2);
  const s = readDerInteger(bytes, r.next);
  if (s.next !== bytes.length) throw new Error('BAD_DER');
  return joinRs(bytesToHex(r.value), bytesToHex(s.value));
}
```

- [ ] **Step 4: 테스트를 통과시킨다**

Run: `pnpm --filter @monti/shared exec vitest run src/encoding.der.test.ts`
Expected: PASS — `Tests  7 passed (7)`

- [ ] **Step 5: 커밋**

```bash
git add packages/shared/src/encoding.ts packages/shared/src/encoding.der.test.ts
git commit -m "feat(shared): convert ECDSA signatures between r||s and DER"
```

---

## Task 8: `encoding.ts` — 범용 canonical JSON과 스냅샷 다이제스트

**Files:**
- Modify: `packages/shared/src/encoding.ts`
- Test: `packages/shared/src/encoding.canonical.test.ts`

**Interfaces:**
- Consumes: Task 1 `SnapshotWire`, `SnapshotTicket`, `Hex`.
- Produces:
  - `canonicalJson(value: unknown): string` — 키를 재귀적으로 사전순 정렬, 공백 없음, 숫자는 정수만, `0x…` 문자열은 소문자로 정규화. 배열 순서는 보존한다.
  - `type UnsignedSnapshot = Omit<SnapshotWire, 'attesterSig'>`
  - `snapshotDigest(snapshot: UnsignedSnapshot): Hex` — `keccak256(utf8(canonicalJson(snapshot)))`.

**서명 규약(sub-plan 04와 합의, 변경 금지):** `SnapshotWire.attesterSig`는 **EIP-191 접두사 없는 raw secp256k1 서명 65바이트 `r‖s‖v`** 이고, 대상은 `keccak256(utf8(canonicalJson(attesterSig를 뺀 스냅샷)))`이다. 02가 `account.sign({ hash })`로 만들고 04가 `recoverAddress({ hash, signature })`로 검증한다. 두 쪽이 **이 파일의 같은 함수**를 import 하므로 규약이 갈라질 수 없다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`packages/shared/src/encoding.canonical.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { canonicalJson, snapshotDigest, type UnsignedSnapshot } from './encoding.js';
import type { Hex } from './types.js';

const X = ('0x' + '11'.repeat(32)) as Hex;
const Y = ('0x' + '22'.repeat(32)) as Hex;
const ACC = '0x0000000000000000000000000000000000000001' as Hex;

const snapshot: UnsignedSnapshot = {
  v: 1,
  eventId: '11',
  eventTitle: '몬티 데모 공연',
  requireKyc: true,
  epoch: 3,
  expiresAt: 1_789_862_400,
  tickets: [
    {
      tokenId: '7',
      account: ACC,
      deviceX: X,
      deviceY: Y,
      photoJpegB64: 'AAA=',
      displayName: '홍길동',
      tier: 0,
      tierName: '일반',
      seat: '',
      checkedIn: false,
    },
  ],
};

describe('canonicalJson', () => {
  it('sorts keys recursively and emits no whitespace', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it('lowercases 0x hex strings but leaves other strings alone', () => {
    expect(canonicalJson({ k: '0xAaBb' })).toBe('{"k":"0xaabb"}');
    expect(canonicalJson({ k: 'Alex' })).toBe('{"k":"Alex"}');
  });

  it('keeps array order because it is meaningful', () => {
    expect(canonicalJson([2, 1])).toBe('[2,1]');
  });

  it('rejects a non-integer or non-finite number', () => {
    expect(() => canonicalJson({ k: 1.5 })).toThrow('NON_INTEGER_NUMBER');
    expect(() => canonicalJson({ k: Number.NaN })).toThrow('NON_INTEGER_NUMBER');
  });

  it('produces the exact snapshot string the staff device rebuilds offline', () => {
    expect(canonicalJson(snapshot)).toBe(
      `{"epoch":3,"eventId":"11","eventTitle":"몬티 데모 공연","expiresAt":1789862400,"requireKyc":true,"tickets":[{"account":"${ACC}","checkedIn":false,"deviceX":"${X}","deviceY":"${Y}","displayName":"홍길동","photoJpegB64":"AAA=","seat":"","tier":0,"tierName":"일반","tokenId":"7"}],"v":1}`,
    );
  });

  it('is independent of key insertion order', () => {
    const shuffled = {
      requireKyc: true,
      expiresAt: snapshot.expiresAt,
      tickets: [
        {
          checkedIn: false, seat: '', tier: 0, tierName: '일반', displayName: '홍길동',
          photoJpegB64: 'AAA=', deviceY: Y, deviceX: X, account: ACC, tokenId: '7',
        },
      ],
      epoch: 3,
      eventTitle: '몬티 데모 공연',
      eventId: '11',
      v: 1,
    } as UnsignedSnapshot;
    expect(canonicalJson(shuffled)).toBe(canonicalJson(snapshot));
  });
});

describe('snapshotDigest', () => {
  it('matches the fixed keccak256 vector shared with sub-plan 04', () => {
    expect(snapshotDigest(snapshot)).toBe(
      '0xeef6e400e1e294b333d2b8eacda0fddf69f580a6eb0875b07cf192ea781261a1',
    );
  });

  it('refuses a snapshot that still carries attesterSig', () => {
    expect(() =>
      snapshotDigest({ ...snapshot, attesterSig: '0xdead' } as unknown as UnsignedSnapshot),
    ).toThrow('SNAPSHOT_ALREADY_SIGNED');
  });

  it('changes when one photo changes', () => {
    const tampered: UnsignedSnapshot = {
      ...snapshot,
      tickets: [{ ...snapshot.tickets[0]!, photoJpegB64: 'BBB=' }],
    };
    expect(snapshotDigest(tampered)).not.toBe(snapshotDigest(snapshot));
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm --filter @monti/shared exec vitest run src/encoding.canonical.test.ts`
Expected: FAIL — `canonicalJson is not a function`

- [ ] **Step 3: `encoding.ts` 끝에 canonical 절을 추가한다**

import 줄에 `SnapshotWire`를 더한다:

```ts
import {
  isGateCodeWire,
  isGateResponseWire,
  type GateCodeWire,
  type GateResponseWire,
  type Hex,
  type SnapshotWire,
} from './types.js';
```

파일 끝에:

```ts
const HEX_STRING_RE = /^0x[0-9a-fA-F]+$/;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) out[key] = canonicalize(source[key]);
    return out;
  }
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new Error('NON_INTEGER_NUMBER');
  if (typeof value === 'string' && HEX_STRING_RE.test(value)) return value.toLowerCase();
  return value;
}

/**
 * 키 재귀 사전순, 공백 없음, 숫자는 안전 정수만, 0x 문자열은 소문자.
 * 02(서명)와 04(검증)가 같은 바이트열을 만들기 위한 유일한 정의다.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export type UnsignedSnapshot = Omit<SnapshotWire, 'attesterSig'>;

/** attesterSig 가 서명하는 대상. raw secp256k1 65바이트 r||s||v, EIP-191 접두사 없음. */
export function snapshotDigest(snapshot: UnsignedSnapshot): Hex {
  if ('attesterSig' in (snapshot as Record<string, unknown>)) throw new Error('SNAPSHOT_ALREADY_SIGNED');
  return keccak256(stringToBytes(canonicalJson(snapshot)));
}
```

`packages/shared/src/index.ts`는 이미 `export * from './encoding.js';` 를 갖고 있으므로 변경이 없다. 별도 `snapshot.ts` 파일은 만들지 않는다.

- [ ] **Step 4: 테스트를 통과시킨다**

Run: `pnpm --filter @monti/shared exec vitest run src/encoding.canonical.test.ts`
Expected: PASS — `Tests  9 passed (9)`

- [ ] **Step 5: 04와 규약이 같은지 확인한다**

Run:
```bash
grep -rn "canonicalJson\|snapshotDigest" packages/shared/src/encoding.ts | head -5
grep -rn "snapshotDigest" docs/superpowers/plans/2026-09-20-monti-04-staff-android.md | head -3
```
Expected: 첫 명령은 `canonicalJson`·`snapshotDigest` 정의 줄. 두 번째는 04 계획이 같은 이름을 import 하는 줄(04가 아직 없으면 출력 없음 — 정상).

- [ ] **Step 6: 커밋**

```bash
git add packages/shared/src/encoding.ts packages/shared/src/encoding.canonical.test.ts
git commit -m "feat(shared): add canonical JSON and snapshot digest shared with the staff device"
```

---

## Task 9: `copy-lint.ts` CLI와 tsup 빌드

**Files:**
- Create: `packages/shared/src/copy-lint.ts`
- Modify: `package.json` (루트 스크립트)
- Test: `packages/shared/src/copy-lint.test.ts`

**Interfaces:**
- Consumes: Task 2 `BANNED_ATTENDEE_WORDS`.
- Produces: `interface CopyLintHit { file: string; line: number; column: number; word: string; text: string }`, `scanText(file: string, text: string): CopyLintHit[]`, `scanFolder(root: string, extensions?: string[]): Promise<CopyLintHit[]>`, 그리고 실행 파일 `packages/shared/dist/copy-lint.js`(적중 시 exit 1).

**매칭 규칙 (결정):** 한글 금지어는 **부분 문자열**로, 영어 금지어는 **단어 경계**(`\bword\b`)로 대소문자 무시 매칭한다. 영어를 단어 경계로 하지 않으면 `tokenId`, `gasLimit`, `chainId` 같은 **식별자**가 전부 걸려 린터가 쓸모없어진다. 스펙 §3.2의 의도는 "관객 화면에 보이는 낱말"이지 변수명이 아니다. 한 줄에 `// copy-lint-ignore`가 있으면 그 줄을 건너뛴다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`packages/shared/src/copy-lint.test.ts`:

```ts
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { scanFolder, scanText } from './copy-lint.js';

describe('scanText', () => {
  it('flags Korean banned words anywhere in the line', () => {
    const hits = scanText('a.tsx', '<p>지갑을 연결해 주세요</p>');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ file: 'a.tsx', line: 1, word: '지갑' });
  });

  it('flags English banned words on word boundaries only', () => {
    expect(scanText('a.tsx', 'Pay the gas fee')).toHaveLength(1);
    expect(scanText('a.tsx', 'const gasLimit = withGasMargin(estimate)')).toHaveLength(0);
    expect(scanText('a.tsx', 'const tokenId = ticket.tokenId')).toHaveLength(0);
    expect(scanText('a.tsx', 'const chainId = 10143')).toHaveLength(0);
  });

  it('is case insensitive', () => {
    expect(scanText('a.tsx', 'Your WALLET is ready')).toHaveLength(1);
    expect(scanText('a.tsx', 'Minted on Monad')).toHaveLength(1);
  });

  it('reports the 1-based line and column', () => {
    const hits = scanText('a.tsx', 'line one\n  <p>NFT</p>');
    expect(hits[0]).toMatchObject({ line: 2, column: 6, word: 'NFT' });
  });

  it('skips lines marked copy-lint-ignore', () => {
    expect(scanText('a.tsx', '<p>블록체인 없음</p> // copy-lint-ignore')).toHaveLength(0);
  });

  it('finds every banned word on one line', () => {
    const hits = scanText('a.tsx', '지갑에서 토큰을 민팅합니다');
    expect(hits.map((h) => h.word).sort()).toEqual(['민팅', '지갑', '토큰']);
  });
});

describe('scanFolder', () => {
  it('walks nested folders and only the given extensions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'monti-copy-'));
    await mkdir(join(root, 'nested'), { recursive: true });
    await writeFile(join(root, 'clean.tsx'), '<p>입장하기</p>', 'utf8');
    await writeFile(join(root, 'nested', 'dirty.tsx'), '<p>가스비는 무료입니다</p>', 'utf8');
    await writeFile(join(root, 'ignored.md'), '지갑', 'utf8');

    const hits = await scanFolder(root);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.word).toBe('가스');
    expect(hits[0]!.file.endsWith('dirty.tsx')).toBe(true);
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm --filter @monti/shared exec vitest run src/copy-lint.test.ts`
Expected: FAIL — `Failed to resolve import "./copy-lint.js"`

- [ ] **Step 3: `copy-lint.ts`를 쓴다**

```ts
import { readdir, readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { BANNED_ATTENDEE_WORDS } from './constants.js';

export interface CopyLintHit {
  file: string;
  line: number;
  column: number;
  word: string;
  text: string;
}

const IGNORE_MARKER = 'copy-lint-ignore';
const IGNORED_DIRS = new Set(['node_modules', 'dist', 'build', '.git', 'organizer', 'staff']);

function escapeRegExp(word: string): string {
  return word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isAsciiWord(word: string): boolean {
  return /^[A-Za-z]+$/.test(word);
}

const PATTERNS: Array<{ word: string; regex: RegExp }> = BANNED_ATTENDEE_WORDS.map((word) => ({
  word,
  regex: isAsciiWord(word)
    ? new RegExp(`\\b${escapeRegExp(word)}\\b`, 'gi')
    : new RegExp(escapeRegExp(word), 'gi'),
}));

export function scanText(file: string, text: string): CopyLintHit[] {
  const hits: CopyLintHit[] = [];
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] as string;
    if (line.includes(IGNORE_MARKER)) continue;
    for (const { word, regex } of PATTERNS) {
      regex.lastIndex = 0;
      let match = regex.exec(line);
      while (match !== null) {
        hits.push({ file, line: index + 1, column: match.index + 1, word, text: line.trim() });
        match = regex.exec(line);
      }
    }
  }
  return hits;
}

export async function scanFolder(
  root: string,
  extensions: string[] = ['.tsx', '.ts'],
): Promise<CopyLintHit[]> {
  const hits: CopyLintHit[] = [];
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      hits.push(...(await scanFolder(full, extensions)));
      continue;
    }
    if (!extensions.includes(extname(entry.name))) continue;
    hits.push(...scanText(full, await readFile(full, 'utf8')));
  }
  return hits;
}

async function main(): Promise<void> {
  const roots = process.argv.slice(2);
  if (roots.length === 0) {
    console.error('usage: monti-copy-lint <folder> [<folder>...]');
    process.exit(2);
  }
  const hits: CopyLintHit[] = [];
  for (const root of roots) hits.push(...(await scanFolder(root)));
  for (const hit of hits) {
    console.error(`${hit.file}:${hit.line}:${hit.column}  banned word "${hit.word}"  ${hit.text}`);
  }
  if (hits.length > 0) {
    console.error(`\n${hits.length} banned word(s) in attendee copy. 스펙 §3.2 위반입니다.`);
    process.exit(1);
  }
  console.log(`copy-lint: clean (${roots.join(', ')})`);
}

const invokedDirectly =
  typeof process !== 'undefined' && process.argv[1] !== undefined && process.argv[1].includes('copy-lint');
if (invokedDirectly) {
  void main();
}
```

- [ ] **Step 4: 테스트를 통과시킨다**

Run: `pnpm --filter @monti/shared exec vitest run src/copy-lint.test.ts`
Expected: PASS — `Tests  7 passed (7)`

- [ ] **Step 5: 패키지를 빌드하고 CLI가 실제로 실패하는지 확인한다**

Run:
```bash
pnpm --filter @monti/shared build
mkdir -p /tmp/monti-lint-demo && printf '<p>%s</p>\n' '가스비 무료' > /tmp/monti-lint-demo/x.tsx
node packages/shared/dist/copy-lint.js /tmp/monti-lint-demo; echo "exit=$?"
```
Expected:
```
/tmp/monti-lint-demo/x.tsx:1:4  banned word "가스"  <p>가스비 무료</p>

1 banned word(s) in attendee copy. 스펙 §3.2 위반입니다.
exit=1
```

- [ ] **Step 6: 루트 스크립트를 연결한다**

루트 `package.json`의 `scripts`를 다음으로 만든다(마스터 계획 Task 0.1이 만든 `lint:copy` 줄을 유지·확장):

```json
{
  "name": "monti",
  "private": true,
  "packageManager": "pnpm@9",
  "scripts": {
    "build:shared": "pnpm --filter @monti/shared build",
    "lint:copy": "pnpm build:shared && node packages/shared/dist/copy-lint.js apps/web/src/attendee apps/web/src/shared",
    "test:shared": "pnpm --filter @monti/shared exec vitest run",
    "test:functions": "firebase emulators:exec --only firestore,auth,storage \"pnpm --filter monti-functions exec vitest run\"",
    "test:indexer": "pnpm --filter monti-indexer exec vitest run"
  }
}
```

Run: `pnpm lint:copy`
Expected: `copy-lint: clean (apps/web/src/attendee, apps/web/src/shared)` 또는 `apps/web/src/attendee` 폴더가 아직 없으면 `ENOENT` — sub-plan 03 전이라면 정상이며, 03 완료 후 다시 돌린다.

- [ ] **Step 7: 커밋**

```bash
git add packages/shared/src/copy-lint.ts packages/shared/src/copy-lint.test.ts package.json
git commit -m "feat(shared): add attendee copy linter CLI"
```

---

## Task 10: Firebase 프로젝트 파일과 에뮬레이터

**Files:**
- Create: `.firebaserc`, `firebase.json`, `firestore.indexes.json`, `.env.example`
- Modify: `.gitignore`

**Interfaces:**
- Produces: 에뮬레이터 포트(Auth 9099, Firestore 8080, Functions 5001, Storage 9199, Hosting 5000, Pub/Sub 8085, UI 4000)와 `firebase deploy` 타깃. 이후 모든 Task의 `firebase emulators:exec` 명령이 이 설정에 의존한다.

**사전 작업(콘솔, 1회):** 스펙 §16 S5에서 만든 Firebase 프로젝트 `monti-dev`(Blaze, 리전 **asia-northeast3**), 전화 로그인 켜짐, SMS 허용 국가 KR·US·JP·GB·DE·SG.

- [ ] **Step 1: 프로젝트 별칭을 만든다**

`.firebaserc`:

```json
{
  "projects": {
    "default": "monti-dev",
    "dev": "monti-dev",
    "prod": "monti-prod"
  }
}
```

- [ ] **Step 2: `firebase.json`을 쓴다**

```json
{
  "firestore": {
    "rules": "firestore.rules",
    "indexes": "firestore.indexes.json"
  },
  "storage": {
    "rules": "storage.rules"
  },
  "functions": [
    {
      "source": "functions",
      "codebase": "default",
      "runtime": "nodejs22",
      "predeploy": ["pnpm --filter @monti/shared build", "pnpm --filter monti-functions build"],
      "ignore": ["node_modules", ".git", "*.local", "test", "src", "vitest.config.ts"]
    }
  ],
  "hosting": {
    "public": "apps/web/dist",
    "appAssociation": "NONE",
    "cleanUrls": true,
    "ignore": ["firebase.json", "**/.*", "**/node_modules/**"],
    "headers": [
      {
        "source": "/.well-known/apple-app-site-association",
        "headers": [
          { "key": "Content-Type", "value": "application/json" },
          { "key": "Cache-Control", "value": "public, max-age=300" }
        ]
      },
      {
        "source": "/.well-known/assetlinks.json",
        "headers": [
          { "key": "Content-Type", "value": "application/json" },
          { "key": "Cache-Control", "value": "public, max-age=300" }
        ]
      }
    ],
    "rewrites": [{ "source": "**", "destination": "/index.html" }]
  },
  "emulators": {
    "auth": { "port": 9099 },
    "firestore": { "port": 8080 },
    "functions": { "port": 5001 },
    "storage": { "port": 9199 },
    "hosting": { "port": 5000 },
    "pubsub": { "port": 8085 },
    "ui": { "enabled": true, "port": 4000 },
    "singleProjectMode": true
  }
}
```

`"appAssociation": "NONE"`는 Firebase가 AASA를 **자동 생성해서 우리 파일을 덮어쓰는 것**을 막는다. 이게 없으면 패스키가 조용히 깨진다(스펙 §8.2).

- [ ] **Step 3: 인덱스와 환경 파일 견본을 만든다**

`firestore.indexes.json`:

```json
{
  "indexes": [
    {
      "collectionGroup": "transferInvites",
      "queryScope": "COLLECTION",
      "fields": [
        { "fieldPath": "hmacPhone", "order": "ASCENDING" },
        { "fieldPath": "status", "order": "ASCENDING" }
      ]
    },
    {
      "collectionGroup": "persons",
      "queryScope": "COLLECTION",
      "fields": [
        { "fieldPath": "status", "order": "ASCENDING" },
        { "fieldPath": "updatedAt", "order": "ASCENDING" }
      ]
    },
    {
      "collectionGroup": "eventChats",
      "queryScope": "COLLECTION",
      "fields": [
        { "fieldPath": "closed", "order": "ASCENDING" },
        { "fieldPath": "endsAt", "order": "ASCENDING" }
      ]
    }
  ],
  "fieldOverrides": []
}
```

`.env.example` (실제 값은 `firebase functions:secrets:set`과 `.env.monti-dev`로 넣는다):

```bash
CHAIN_ID=10143
RPC_URL=https://testnet-rpc.monad.xyz
RP_ID=monti.app
RP_NAME=MONTI
ANDROID_APK_KEY_HASH=
GCP_PROJECT_ID=monti-dev
KMS_LOCATION=asia-northeast3
KMS_KEY_RING=monti
ENVIO_GRAPHQL_URL=http://localhost:8080/v1/graphql
EXPORT_BUCKET=monti-exports
BIGQUERY_DATASET=monti
IPFS_GATEWAY=https://gateway.pinata.cloud/ipfs
```

`.gitignore`에 추가:

```
.firebase
functions/lib
functions/.env.*
!functions/.env.example
indexer/generated
```

- [ ] **Step 4: 에뮬레이터가 뜨는지 확인한다**

Run:
```bash
firebase emulators:exec --only firestore,auth,storage,pubsub "echo EMULATORS_OK"
```
Expected: 마지막 줄들에
```
✔  All emulators ready!
EMULATORS_OK
✔  Script exited successfully
```

- [ ] **Step 5: 커밋**

```bash
git add .firebaserc firebase.json firestore.indexes.json .env.example .gitignore
git commit -m "chore(firebase): add project config, indexes and emulator suite"
```

---

## Task 11: Firestore·Storage 보안 규칙과 규칙 테스트

**Files:**
- Create: `firestore.rules`, `storage.rules`
- Create: `functions/test/rules.test.ts`
- Create: `functions/package.json` (최소 devDependencies만; Task 14에서 완성)

**Interfaces:**
- Consumes: Task 10의 `firebase.json`.
- Produces: 클라이언트가 쓸 수 있는 정확한 목록 — `devices/{account}.pushToken`, `users/{uid}.{nickname,locale,chatOrder}`, `eventChats/{eventId}/messages/{msgId}` 생성. 나머지 전부 거부. Task 26·31이 이 규칙을 전제로 한다.

- [ ] **Step 1: `firestore.rules`를 쓴다**

```
rules_version = '2';

service cloud.firestore {
  match /databases/{database}/documents {

    function signedIn() {
      return request.auth != null;
    }

    function changedOnly(fields) {
      return request.resource.data.diff(resource.data).affectedKeys().hasOnly(fields);
    }

    // 푸시 토큰만 본인이 갱신한다. 문서 생성·삭제·읽기는 Functions 전용.
    match /devices/{account} {
      allow read, create, delete: if false;
      allow update: if signedIn()
        && request.auth.token.account == account
        && changedOnly(['pushToken', 'updatedAt']);
    }

    // 사용자가 직접 쓸 수 있는 유일한 세 필드.
    match /users/{uid} {
      allow read: if signedIn() && request.auth.uid == uid;
      allow create, delete: if false;
      allow update: if signedIn()
        && request.auth.uid == uid
        && changedOnly(['nickname', 'locale', 'chatOrder'])
        && (!('locale' in request.resource.data.diff(resource.data).affectedKeys())
            || request.resource.data.locale in ['en', 'ko'])
        && (!('nickname' in request.resource.data.diff(resource.data).affectedKeys())
            || (request.resource.data.nickname is string && request.resource.data.nickname.size() <= 24))
        && (!('chatOrder' in request.resource.data.diff(resource.data).affectedKeys())
            || (request.resource.data.chatOrder is list && request.resource.data.chatOrder.size() <= 200));
    }

    match /eventChats/{eventId} {
      function isChatMember() {
        return signedIn()
          && exists(/databases/$(database)/documents/eventChats/$(eventId)/members/$(request.auth.uid));
      }
      function chatOpen() {
        return get(/databases/$(database)/documents/eventChats/$(eventId)).data.closed == false;
      }

      allow read: if isChatMember();
      allow write: if false;

      match /members/{uid} {
        allow read: if isChatMember();
        allow write: if false;
      }

      match /messages/{msgId} {
        allow read: if isChatMember();
        // keys().hasOnly 가 `pinned` 를 막는다. 고정은 서버(pinMessage)만 쓴다.
        allow create: if isChatMember()
          && chatOpen()
          && request.resource.data.keys().hasOnly(['uid', 'text', 'createdAt', 'reported'])
          && request.resource.data.uid == request.auth.uid
          && request.resource.data.text is string
          && request.resource.data.text.size() > 0
          && request.resource.data.text.size() <= 500
          && request.resource.data.reported == 0;
        allow update, delete: if false;
      }
    }

    // persons, passkeys, kycSessions, invites, phoneIndex, transferInvites, authChallenges 포함 전부 거부.
    match /{document=**} {
      allow read, write: if false;
    }
  }
}
```

`storage.rules` — 얼굴 사진은 KMS로 암호화돼 있어도 클라이언트가 만질 이유가 없다:

```
rules_version = '2';

service firebase.storage {
  match /b/{bucket}/o {
    match /{allPaths=**} {
      allow read, write: if false;
    }
  }
}
```

- [ ] **Step 2: 규칙 테스트를 쓴다**

`functions/package.json` (이 단계에서는 테스트만 돌릴 최소 구성):

```json
{
  "name": "monti-functions",
  "private": true,
  "type": "module",
  "engines": { "node": "22" },
  "scripts": { "test": "vitest run" },
  "devDependencies": {
    "@firebase/rules-unit-testing": "^4.0.1",
    "@types/node": "^22.7.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

`functions/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    fileParallelism: false,
  },
});
```

`functions/test/rules.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const ACCOUNT = '0x0000000000000000000000000000000000000001';
let env: RulesTestEnvironment;

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: 'monti-rules-test',
    firestore: {
      rules: readFileSync(join(process.cwd(), '..', 'firestore.rules'), 'utf8'),
      host: '127.0.0.1',
      port: 8080,
    },
  });
});

afterAll(async () => {
  await env.cleanup();
});

beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await db.doc(`devices/${ACCOUNT}`).set({ deviceX: '0x11', deviceY: '0x22', platform: 'ios' });
    await db.doc('users/uid-1').set({ personId: '0xaa', phoneE164: '+821011112222', locale: 'ko' });
    await db.doc('persons/0xaa').set({ status: 'active' });
    await db.doc('eventChats/11').set({ closed: false, endsAt: 4102444800, orgId: '1' });
    await db.doc('eventChats/11/members/uid-1').set({ account: ACCOUNT, joinedAt: 1 });
    await db.doc('eventChats/12').set({ closed: true, endsAt: 1, orgId: '1' });
    await db.doc('eventChats/12/members/uid-1').set({ account: ACCOUNT, joinedAt: 1 });
  });
});

function owner() {
  return env.authenticatedContext('uid-1', { account: ACCOUNT }).firestore();
}

describe('deny-all baseline', () => {
  it('blocks reading persons, passkeys, kycSessions, phoneIndex and transferInvites', async () => {
    const db = owner();
    await assertFails(db.doc('persons/0xaa').get());
    await assertFails(db.doc('passkeys/cred-1').get());
    await assertFails(db.doc('kycSessions/s1').get());
    await assertFails(db.doc('phoneIndex/abc').get());
    await assertFails(db.doc('transferInvites/i1').get());
    await assertFails(db.doc('invites/i1').get());
  });
});

describe('devices/{account}.pushToken', () => {
  it('lets the owning account update only pushToken', async () => {
    await assertSucceeds(owner().doc(`devices/${ACCOUNT}`).update({ pushToken: 'fcm-token' }));
  });

  it('blocks changing the device key', async () => {
    await assertFails(owner().doc(`devices/${ACCOUNT}`).update({ deviceX: '0xff' }));
  });

  it('blocks another account', async () => {
    const other = env.authenticatedContext('uid-2', { account: '0x02' }).firestore();
    await assertFails(other.doc(`devices/${ACCOUNT}`).update({ pushToken: 'x' }));
  });
});

describe('users/{uid}', () => {
  it('lets the owner set nickname, locale and chatOrder', async () => {
    await assertSucceeds(
      owner().doc('users/uid-1').update({ nickname: 'alex', locale: 'en', chatOrder: ['11', '12'] }),
    );
  });

  it('blocks writing personId or phoneE164', async () => {
    await assertFails(owner().doc('users/uid-1').update({ personId: '0xbb' }));
    await assertFails(owner().doc('users/uid-1').update({ phoneE164: '+10000000000' }));
  });

  it('blocks an unsupported locale', async () => {
    await assertFails(owner().doc('users/uid-1').update({ locale: 'fr' }));
  });
});

describe('eventChats messages', () => {
  it('lets a member post in an open chat', async () => {
    await assertSucceeds(
      owner().collection('eventChats/11/messages').add({ uid: 'uid-1', text: '안녕하세요', createdAt: 1, reported: 0 }),
    );
  });

  it('blocks a message longer than 500 characters', async () => {
    await assertFails(
      owner().collection('eventChats/11/messages').add({ uid: 'uid-1', text: 'x'.repeat(501), createdAt: 1, reported: 0 }),
    );
  });

  it('blocks posting as somebody else', async () => {
    await assertFails(
      owner().collection('eventChats/11/messages').add({ uid: 'uid-2', text: 'hi', createdAt: 1, reported: 0 }),
    );
  });

  it('blocks posting into a closed chat', async () => {
    await assertFails(
      owner().collection('eventChats/12/messages').add({ uid: 'uid-1', text: 'hi', createdAt: 1, reported: 0 }),
    );
  });

  it('blocks a non-member from reading or posting', async () => {
    const stranger = env.authenticatedContext('uid-9', {}).firestore();
    await assertFails(stranger.collection('eventChats/11/messages').get());
    await assertFails(
      stranger.collection('eventChats/11/messages').add({ uid: 'uid-9', text: 'hi', createdAt: 1, reported: 0 }),
    );
  });

  it('blocks joining the chat from the client', async () => {
    const stranger = env.authenticatedContext('uid-9', {}).firestore();
    await assertFails(stranger.doc('eventChats/11/members/uid-9').set({ account: '0x09', joinedAt: 1 }));
  });
});
```

- [ ] **Step 3: 실패를 확인한다**

Run:
```bash
pnpm install
firebase emulators:exec --only firestore "pnpm --filter monti-functions exec vitest run test/rules.test.ts"
```
Expected: FAIL — `ENOENT: no such file or directory, open '.../firestore.rules'` (Step 1을 아직 저장하지 않았다면) 또는 규칙이 비어 있어 `assertFails`가 실패한다.

- [ ] **Step 4: 규칙 파일을 저장하고 통과시킨다**

Step 1의 두 파일을 저장한 뒤 다시 실행한다.

Run:
```bash
firebase emulators:exec --only firestore "pnpm --filter monti-functions exec vitest run test/rules.test.ts"
```
Expected: PASS — `Tests  13 passed (13)`, 마지막에 `✔  Script exited successfully`

- [ ] **Step 5: 규칙을 에뮬레이터 밖으로 배포한다**

Run:
```bash
firebase deploy --only firestore:rules,storage --project dev
```
Expected: `✔  firestore: released rules firestore.rules to cloud.firestore`, `✔  storage: released rules storage.rules to firebase.storage`

- [ ] **Step 6: 커밋**

```bash
git add firestore.rules storage.rules functions/package.json functions/vitest.config.ts functions/test/rules.test.ts pnpm-lock.yaml
git commit -m "feat(firebase): deny-all security rules with pushToken, profile and chat exceptions"
```

---

## Task 12: Cloud KMS 키 생성과 봉투 암호화 헬퍼

**Files:**
- Create: `functions/src/lib/kms.ts`
- Create: `functions/test/kms.test.ts`
- Modify: `functions/package.json`

**Interfaces:**
- Consumes: 없음.
- Produces:
  - `interface KmsCryptoClient { encrypt(req): Promise<[{ ciphertext: Uint8Array | string | null }]>; decrypt(req): Promise<[{ plaintext: Uint8Array | string | null }]> }`
  - `encryptField(plaintext: string, client?: KmsCryptoClient): Promise<string>` — base64 봉투 문자열.
  - `decryptField(envelope: string, client?: KmsCryptoClient): Promise<string>`
  - `piiKeyName(): string` — `projects/{p}/locations/asia-northeast3/keyRings/monti/cryptoKeys/pii`
  Task 16·17·22가 이름·사진을 저장·복호화할 때 쓴다.

**봉투 형식(바이트):** `0x01 | uint16BE wrappedDekLen | wrappedDek | iv(12) | tag(16) | ciphertext` 를 base64로. DEK는 매 호출 새로 만드는 AES-256-GCM 키이고, KMS는 DEK만 감싼다. 사진 한 장(수백 KB)을 KMS로 직접 보내면 64KiB 한도에 걸린다.

- [ ] **Step 1: KMS 키링과 키 두 개를 만든다 (1회)**

Run:
```bash
gcloud config set project monti-dev
gcloud services enable cloudkms.googleapis.com
gcloud kms keyrings create monti --location asia-northeast3
gcloud kms keys create pii --location asia-northeast3 --keyring monti \
  --purpose encryption --rotation-period 90d --next-rotation-time "$(date -u -v+90d +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '+90 days' +%Y-%m-%dT%H:%M:%SZ)"
gcloud kms keys create attester --location asia-northeast3 --keyring monti \
  --purpose asymmetric-signing --default-algorithm ec-sign-secp256k1-sha256
gcloud kms keys list --location asia-northeast3 --keyring monti
```
Expected: 마지막 목록에 `pii  ENCRYPT_DECRYPT` 와 `attester  ASYMMETRIC_SIGN  EC_SIGN_SECP256K1_SHA256` 두 줄.

함수 서비스 계정에 권한을 준다:
```bash
SA="monti-dev@appspot.gserviceaccount.com"
gcloud kms keys add-iam-policy-binding pii --location asia-northeast3 --keyring monti \
  --member "serviceAccount:$SA" --role roles/cloudkms.cryptoKeyEncrypterDecrypter
gcloud kms keys add-iam-policy-binding attester --location asia-northeast3 --keyring monti \
  --member "serviceAccount:$SA" --role roles/cloudkms.signerVerifier
```
Expected: 각각 `Updated IAM policy for key [...]`.

- [ ] **Step 2: 실패하는 테스트를 쓴다**

`functions/test/kms.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { decryptField, encryptField, type KmsCryptoClient } from '../src/lib/kms.js';

/** DEK를 'W' 한 바이트로 감싸는 가짜 KMS. 실제 KMS 왕복 없이 봉투 로직만 검증한다. */
const fakeKms: KmsCryptoClient = {
  async encrypt({ plaintext }) {
    return [{ ciphertext: Buffer.concat([Buffer.from('W'), Buffer.from(plaintext)]) }];
  },
  async decrypt({ ciphertext }) {
    const buf = Buffer.from(ciphertext);
    if (buf[0] !== 'W'.charCodeAt(0)) throw new Error('FAKE_KMS_BAD_WRAP');
    return [{ plaintext: buf.subarray(1) }];
  },
};

describe('envelope encryption', () => {
  it('round-trips a Korean name', async () => {
    const envelope = await encryptField('홍길동', fakeKms);
    expect(await decryptField(envelope, fakeKms)).toBe('홍길동');
  });

  it('round-trips a 300 KB photo payload', async () => {
    const photo = 'A'.repeat(300 * 1024);
    const envelope = await encryptField(photo, fakeKms);
    expect(await decryptField(envelope, fakeKms)).toBe(photo);
  });

  it('never leaks the plaintext into the envelope', async () => {
    const envelope = await encryptField('010-1234-5678', fakeKms);
    expect(Buffer.from(envelope, 'base64').toString('latin1')).not.toContain('010-1234-5678');
  });

  it('uses a fresh DEK and IV every call', async () => {
    const a = await encryptField('same', fakeKms);
    const b = await encryptField('same', fakeKms);
    expect(a).not.toBe(b);
  });

  it('rejects a tampered ciphertext', async () => {
    const envelope = await encryptField('홍길동', fakeKms);
    const bytes = Buffer.from(envelope, 'base64');
    bytes[bytes.length - 1] ^= 0xff;
    await expect(decryptField(bytes.toString('base64'), fakeKms)).rejects.toThrow();
  });

  it('rejects an unknown envelope version', async () => {
    const bytes = Buffer.from(await encryptField('x', fakeKms), 'base64');
    bytes[0] = 0x02;
    await expect(decryptField(bytes.toString('base64'), fakeKms)).rejects.toThrow('BAD_ENVELOPE_VERSION');
  });
});
```

- [ ] **Step 3: 실패를 확인한다**

Run: `pnpm --filter monti-functions exec vitest run test/kms.test.ts`
Expected: FAIL — `Failed to resolve import "../src/lib/kms.js"`

- [ ] **Step 4: `kms.ts`를 쓴다**

`functions/package.json`의 `dependencies`에 `"@google-cloud/kms": "^4.5.0"`를 추가하고 `pnpm install` 후:

```ts
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { KeyManagementServiceClient } from '@google-cloud/kms';

export interface KmsCryptoClient {
  encrypt(req: { name: string; plaintext: Buffer }): Promise<[{ ciphertext: Uint8Array | string | null }]>;
  decrypt(req: { name: string; ciphertext: Buffer }): Promise<[{ plaintext: Uint8Array | string | null }]>;
}

const ENVELOPE_VERSION = 0x01;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const DEK_BYTES = 32;

let cached: KeyManagementServiceClient | undefined;

function defaultClient(): KmsCryptoClient {
  if (!cached) cached = new KeyManagementServiceClient();
  return cached as unknown as KmsCryptoClient;
}

function projectId(): string {
  const id = process.env.GCP_PROJECT_ID ?? process.env.GCLOUD_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT;
  if (!id) throw new Error('NO_GCP_PROJECT');
  return id;
}

export function piiKeyName(): string {
  const location = process.env.KMS_LOCATION ?? 'asia-northeast3';
  const keyRing = process.env.KMS_KEY_RING ?? 'monti';
  return `projects/${projectId()}/locations/${location}/keyRings/${keyRing}/cryptoKeys/pii`;
}

export function attesterKeyName(version = '1'): string {
  const location = process.env.KMS_LOCATION ?? 'asia-northeast3';
  const keyRing = process.env.KMS_KEY_RING ?? 'monti';
  return `projects/${projectId()}/locations/${location}/keyRings/${keyRing}/cryptoKeys/attester/cryptoKeyVersions/${version}`;
}

function toBuffer(value: Uint8Array | string | null): Buffer {
  if (value === null) throw new Error('KMS_EMPTY_RESPONSE');
  return typeof value === 'string' ? Buffer.from(value, 'base64') : Buffer.from(value);
}

/** 평문 → base64 봉투. DEK는 매번 새로 만들고 KMS는 DEK만 감싼다. */
export async function encryptField(plaintext: string, client: KmsCryptoClient = defaultClient()): Promise<string> {
  const dek = randomBytes(DEK_BYTES);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', dek, iv);
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  const [wrapResponse] = await client.encrypt({ name: piiKeyName(), plaintext: dek });
  const wrapped = toBuffer(wrapResponse.ciphertext);
  if (wrapped.length > 0xffff) throw new Error('WRAPPED_DEK_TOO_LARGE');

  const header = Buffer.alloc(3);
  header[0] = ENVELOPE_VERSION;
  header.writeUInt16BE(wrapped.length, 1);
  return Buffer.concat([header, wrapped, iv, tag, body]).toString('base64');
}

export async function decryptField(envelope: string, client: KmsCryptoClient = defaultClient()): Promise<string> {
  const bytes = Buffer.from(envelope, 'base64');
  if (bytes.length < 3 + IV_BYTES + TAG_BYTES) throw new Error('BAD_ENVELOPE');
  if (bytes[0] !== ENVELOPE_VERSION) throw new Error('BAD_ENVELOPE_VERSION');

  const wrappedLength = bytes.readUInt16BE(1);
  let offset = 3;
  const wrapped = bytes.subarray(offset, offset + wrappedLength);
  offset += wrappedLength;
  const iv = bytes.subarray(offset, offset + IV_BYTES);
  offset += IV_BYTES;
  const tag = bytes.subarray(offset, offset + TAG_BYTES);
  offset += TAG_BYTES;
  const body = bytes.subarray(offset);

  const [unwrapResponse] = await client.decrypt({ name: piiKeyName(), ciphertext: Buffer.from(wrapped) });
  const dek = toBuffer(unwrapResponse.plaintext);

  const decipher = createDecipheriv('aes-256-gcm', dek, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
}
```

- [ ] **Step 5: 테스트를 통과시킨다**

Run: `pnpm --filter monti-functions exec vitest run test/kms.test.ts`
Expected: PASS — `Tests  6 passed (6)`

- [ ] **Step 6: 실제 KMS로 한 번 왕복시킨다**

Run:
```bash
GCP_PROJECT_ID=monti-dev pnpm --filter monti-functions exec tsx -e "
import { encryptField, decryptField } from './src/lib/kms.js';
const e = await encryptField('홍길동');
console.log('envelope bytes =', Buffer.from(e, 'base64').length);
console.log('roundtrip =', await decryptField(e));
"
```
Expected: `envelope bytes = ` 세 자리 수, `roundtrip = 홍길동`. (`tsx`가 없으면 `pnpm --filter monti-functions add -D tsx` 후 재실행.)

- [ ] **Step 7: 커밋**

```bash
git add functions/src/lib/kms.ts functions/test/kms.test.ts functions/package.json pnpm-lock.yaml
git commit -m "feat(functions): add Cloud KMS envelope encryption for PII fields"
```

---

## Task 13: 어테스터 키 — Secret Manager(MVP)와 KMS 서명(프로덕션)

**Files:**
- Create: `functions/src/lib/attester.ts`
- Create: `functions/test/attester.test.ts`
- Modify: `functions/src/lib/kms.ts` (`signKeccak` 추가)

**Interfaces:**
- Consumes: Task 12 `attesterKeyName`.
- Produces:
  - `getAttesterAccount(): PrivateKeyAccount` — Secret Manager `ATTESTER_PK`(0x 접두사 32바이트 hex)에서 만든 viem 계정. **MVP 기본 경로.**
  - `derSigToEthSignature(der: Hex, digest: Hex, expectedAddress: Hex): Promise<Hex>` — DER ECDSA → 65바이트 `r‖s‖v`. low-s 정규화 후 v를 27/28 중 복구되는 쪽으로 고른다.
  - `signKeccak(digest: Hex, expectedAddress: Hex, client?: KmsSignClient): Promise<Hex>` — KMS 비대칭 서명 경로. **프로덕션 전환용.**
  Task 19·21·22·25가 `getAttesterAccount()`를, Task 22가 `attesterAccount.sign({ hash })`를 쓴다.

**결정 근거:** Cloud KMS `EC_SIGN_SECP256K1_SHA256`은 다이제스트를 그대로 받으므로 keccak256 다이제스트를 `digest.sha256` 필드에 넣으면 이더리움 호환 서명이 나온다. 다만 서명마다 왕복 1회(약 40 ms)가 더 들고 nonce 관리를 위해 `walletClient`에 커스텀 account를 끼워야 한다. **해커톤 MVP는 Secret Manager 경로로 간다**(단순함 우선, 스펙 §18 "확인 서명 키 침해"는 7일 쿨타임으로 완화). `signKeccak`은 지금 구현해 두고, 프로덕션 전환 시 `Identity.setAttester(kmsAddress)` 한 번으로 바꾼다.

- [ ] **Step 1: 시크릿을 만든다**

Run:
```bash
node -e "console.log('0x' + require('node:crypto').randomBytes(32).toString('hex'))" > /tmp/attester.pk
cat /tmp/attester.pk | tr -d '\n' | firebase functions:secrets:set ATTESTER_PK --project dev --data-file -
node -e "console.log('0x' + require('node:crypto').randomBytes(32).toString('hex'))" | tr -d '\n' \
  | firebase functions:secrets:set PHONE_INDEX_KEY --project dev --data-file -
rm /tmp/attester.pk
firebase functions:secrets:access ATTESTER_PK --project dev | head -c 6
```
Expected: 마지막 줄이 `0x` 로 시작하는 6자. 이 개인키의 주소를 sub-plan 01의 `Deploy.s.sol`에 어테스터로 넣어야 한다:
```bash
pnpm --filter monti-functions exec tsx -e "
import { privateKeyToAccount } from 'viem/accounts';
console.log(privateKeyToAccount(process.argv[1] as \`0x\${string}\`).address);
" \"$(firebase functions:secrets:access ATTESTER_PK --project dev)\"
```
Expected: `0x…` 주소 한 줄. 이 값이 `contracts/deployments/10143.json`의 `attester`와 같아야 한다.

- [ ] **Step 2: 실패하는 테스트를 쓴다**

`functions/test/attester.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { keccak256, stringToBytes, recoverAddress } from 'viem';
import { privateKeyToAccount, sign } from 'viem/accounts';
import { derSigToEthSignature } from '../src/lib/attester.js';
import { rsToDer, joinRs } from '@monti/shared';
import type { Hex } from '@monti/shared';

const PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as Hex;
const account = privateKeyToAccount(PK);

describe('derSigToEthSignature', () => {
  it('reproduces the signature viem produces for the same digest', async () => {
    const digest = keccak256(stringToBytes('monti attester test'));
    const viemSig = await sign({ hash: digest, privateKey: PK, to: 'hex' });
    const der = rsToDer(joinRs(viemSig.slice(0, 66) as Hex, `0x${viemSig.slice(66, 130)}` as Hex));

    const converted = await derSigToEthSignature(der, digest, account.address as Hex);
    expect(await recoverAddress({ hash: digest, signature: converted })).toBe(account.address);
  });

  it('produces a 65-byte signature whose v is 27 or 28', async () => {
    const digest = keccak256(stringToBytes('another digest'));
    const viemSig = await sign({ hash: digest, privateKey: PK, to: 'hex' });
    const der = rsToDer(joinRs(viemSig.slice(0, 66) as Hex, `0x${viemSig.slice(66, 130)}` as Hex));
    const converted = await derSigToEthSignature(der, digest, account.address as Hex);

    expect(converted).toHaveLength(2 + 130);
    expect([27, 28]).toContain(Number.parseInt(converted.slice(130), 16));
  });

  it('throws when the signature does not recover to the expected address', async () => {
    const digest = keccak256(stringToBytes('yet another digest'));
    const viemSig = await sign({ hash: digest, privateKey: PK, to: 'hex' });
    const der = rsToDer(joinRs(viemSig.slice(0, 66) as Hex, `0x${viemSig.slice(66, 130)}` as Hex));

    await expect(
      derSigToEthSignature(der, digest, '0x000000000000000000000000000000000000dEaD' as Hex),
    ).rejects.toThrow('ATTESTER_RECOVERY_FAILED');
  });
});
```

- [ ] **Step 3: 실패를 확인한다**

Run: `pnpm --filter monti-functions exec vitest run test/attester.test.ts`
Expected: FAIL — `Failed to resolve import "../src/lib/attester.js"`

- [ ] **Step 4: `attester.ts`를 쓴다**

```ts
import { KeyManagementServiceClient } from '@google-cloud/kms';
import { recoverAddress } from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { derToRs, splitRs, joinRs, type Hex } from '@monti/shared';
import { attesterKeyName } from './kms.js';

const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const SECP256K1_HALF_N = SECP256K1_N / 2n;

export interface KmsSignClient {
  asymmetricSign(req: { name: string; digest: { sha256: Buffer } }): Promise<[{ signature: Uint8Array | string | null }]>;
}

let cachedAccount: PrivateKeyAccount | undefined;

/** MVP 경로. Secret Manager `ATTESTER_PK` 하나만 읽는다. */
export function getAttesterAccount(privateKey?: string): PrivateKeyAccount {
  const pk = (privateKey ?? process.env.ATTESTER_PK) as Hex | undefined;
  if (!pk || !/^0x[0-9a-fA-F]{64}$/.test(pk)) throw new Error('MISSING_ATTESTER_PK');
  if (!cachedAccount || cachedAccount.address === undefined) cachedAccount = privateKeyToAccount(pk);
  return cachedAccount;
}

function toLowS(s: Hex): Hex {
  const value = BigInt(s);
  if (value <= SECP256K1_HALF_N) return s;
  const flipped = SECP256K1_N - value;
  return `0x${flipped.toString(16).padStart(64, '0')}` as Hex;
}

/** DER ECDSA 서명 → 이더리움 65바이트 서명. v는 실제로 복구되는 쪽을 고른다. */
export async function derSigToEthSignature(der: Hex, digest: Hex, expectedAddress: Hex): Promise<Hex> {
  const { r, s } = splitRs(derToRs(der));
  const normalizedS = toLowS(s);
  const base = joinRs(r, normalizedS);
  for (const v of [27, 28]) {
    const candidate = `${base}${v.toString(16)}` as Hex;
    const recovered = await recoverAddress({ hash: digest, signature: candidate });
    if (recovered.toLowerCase() === expectedAddress.toLowerCase()) return candidate;
  }
  throw new Error('ATTESTER_RECOVERY_FAILED');
}

let cachedKms: KeyManagementServiceClient | undefined;

function defaultSignClient(): KmsSignClient {
  if (!cachedKms) cachedKms = new KeyManagementServiceClient();
  return cachedKms as unknown as KmsSignClient;
}

/**
 * 프로덕션 경로. KMS EC_SIGN_SECP256K1_SHA256 은 다이제스트를 검사하지 않으므로
 * keccak256 다이제스트를 sha256 필드에 그대로 넣으면 이더리움 호환 서명이 나온다.
 */
export async function signKeccak(
  digest: Hex,
  expectedAddress: Hex,
  client: KmsSignClient = defaultSignClient(),
): Promise<Hex> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(digest)) throw new Error('BAD_DIGEST');
  const [response] = await client.asymmetricSign({
    name: attesterKeyName(),
    digest: { sha256: Buffer.from(digest.slice(2), 'hex') },
  });
  if (response.signature === null) throw new Error('KMS_EMPTY_SIGNATURE');
  const der = (typeof response.signature === 'string'
    ? `0x${Buffer.from(response.signature, 'base64').toString('hex')}`
    : `0x${Buffer.from(response.signature).toString('hex')}`) as Hex;
  return derSigToEthSignature(der, digest, expectedAddress);
}
```

- [ ] **Step 5: 테스트를 통과시킨다**

Run: `pnpm --filter monti-functions exec vitest run test/attester.test.ts`
Expected: PASS — `Tests  3 passed (3)`

- [ ] **Step 6: 커밋**

```bash
git add functions/src/lib/attester.ts functions/test/attester.test.ts functions/package.json
git commit -m "feat(functions): add attester key access via Secret Manager with KMS signing path"
```

---

## Task 14: Functions 패키지 완성 — `config.ts`와 `chain.ts`

**Files:**
- Modify: `functions/package.json`, Create `functions/tsconfig.json`
- Create: `functions/src/config.ts`, `functions/src/lib/chain.ts`, `functions/src/index.ts`
- Test: `functions/test/chain.test.ts`

**Interfaces:**
- Consumes: Task 2 `getDeployment`, `withGasMargin`, `FIREBASE_REGION`; Task 3 ABI들; Task 13 `getAttesterAccount`.
- Produces:
  - `config.ts`: `REGION`, `RP_ID`, `RP_NAME`, `ANDROID_APK_KEY_HASH`, `CHAIN_ID`, `RPC_URL`, `ENVIO_GRAPHQL_URL`, `EXPORT_BUCKET`, `BIGQUERY_DATASET` (모두 `defineString`), 시크릿 `ATTESTER_PK`, `PHONE_INDEX_KEY`, `DIDIT_API_KEY`, `DIDIT_WEBHOOK_SECRET`, `DIDIT_WORKFLOW_ID`, `TENDERLY_WEBHOOK_SECRET`, 그리고 `expectedOrigins(): string[]`.
  - `chain.ts`: `monadChain`, `publicClient()`, `walletClient()`, `deployment()`, `sendAttesterTx(params): Promise<Hex>`, `awaitFinalized(blockNumber: bigint): Promise<void>`.
  Task 16~30 전부가 이 두 파일을 쓴다.

- [ ] **Step 1: 패키지와 tsconfig를 완성한다**

`functions/package.json`:

```json
{
  "name": "monti-functions",
  "private": true,
  "type": "module",
  "main": "lib/index.js",
  "engines": { "node": "22" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "deploy": "pnpm build && firebase deploy --only functions --project dev"
  },
  "dependencies": {
    "@google-cloud/bigquery": "^7.9.0",
    "@google-cloud/kms": "^4.5.0",
    "@google-cloud/storage": "^7.14.0",
    "@monti/shared": "workspace:*",
    "@simplewebauthn/server": "^13.0.0",
    "cbor-x": "^1.6.0",
    "firebase-admin": "^13.0.0",
    "firebase-functions": "^6.1.0",
    "viem": "^2.21.0"
  },
  "devDependencies": {
    "@firebase/rules-unit-testing": "^4.0.1",
    "@types/node": "^22.7.0",
    "firebase-functions-test": "^3.4.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

`functions/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2023"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "resolveJsonModule": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "lib",
    "types": ["node"]
  },
  "include": ["src"]
}
```

- [ ] **Step 2: `config.ts`를 쓴다**

```ts
import { setGlobalOptions } from 'firebase-functions/v2';
import { defineSecret, defineString } from 'firebase-functions/params';
import { FIREBASE_REGION, MONAD_TESTNET_CHAIN_ID, MONAD_TESTNET_RPC_URL } from '@monti/shared';

export const REGION = FIREBASE_REGION;

setGlobalOptions({ region: REGION, maxInstances: 20, memory: '512MiB', timeoutSeconds: 60 });

export const RP_ID = defineString('RP_ID', { default: 'monti.app' });
export const RP_NAME = defineString('RP_NAME', { default: 'MONTI' });
export const ANDROID_APK_KEY_HASH = defineString('ANDROID_APK_KEY_HASH', { default: '' });
export const CHAIN_ID = defineString('CHAIN_ID', { default: String(MONAD_TESTNET_CHAIN_ID) });
export const RPC_URL = defineString('RPC_URL', { default: MONAD_TESTNET_RPC_URL });
export const ENVIO_GRAPHQL_URL = defineString('ENVIO_GRAPHQL_URL', {
  default: 'http://127.0.0.1:8080/v1/graphql',
});
export const EXPORT_BUCKET = defineString('EXPORT_BUCKET', { default: 'monti-exports' });
export const IPFS_GATEWAY = defineString('IPFS_GATEWAY', { default: 'https://gateway.pinata.cloud/ipfs' });
export const BIGQUERY_DATASET = defineString('BIGQUERY_DATASET', { default: 'monti' });

export const ATTESTER_PK = defineSecret('ATTESTER_PK');
export const PHONE_INDEX_KEY = defineSecret('PHONE_INDEX_KEY');
export const DIDIT_API_KEY = defineSecret('DIDIT_API_KEY');
export const DIDIT_WORKFLOW_ID = defineSecret('DIDIT_WORKFLOW_ID');
export const DIDIT_WEBHOOK_SECRET = defineSecret('DIDIT_WEBHOOK_SECRET');
export const TENDERLY_WEBHOOK_SECRET = defineSecret('TENDERLY_WEBHOOK_SECRET');

/**
 * Android WebView는 origin을 `android:apk-key-hash:<base64url SHA-256>`로 보낸다.
 * 두 origin을 모두 받지 않으면 안드로이드 껍데기의 패스키가 전부 거부된다(마스터 계획 Global Constraints).
 */
export function expectedOrigins(): string[] {
  const origins = [`https://${RP_ID.value()}`];
  const hash = ANDROID_APK_KEY_HASH.value();
  if (hash) origins.push(`android:apk-key-hash:${hash}`);
  return origins;
}
```

- [ ] **Step 3: 실패하는 테스트를 쓴다**

`functions/test/chain.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { withGasMargin } from '@monti/shared';
import { monadChain, gasLimitFor } from '../src/lib/chain.js';

describe('monadChain', () => {
  it('is built from CHAIN_ID and never hardcoded in logic', () => {
    expect(monadChain().id).toBe(10143);
    expect(monadChain().nativeCurrency.symbol).toBe('MON');
  });
});

describe('gasLimitFor', () => {
  it('applies the Monad 7.5% margin', () => {
    expect(gasLimitFor(275_000n)).toBe(withGasMargin(275_000n));
    expect(gasLimitFor(275_000n)).toBe(295_625n);
  });

  it('never returns a limit below the estimate', () => {
    expect(gasLimitFor(1n)).toBeGreaterThanOrEqual(1n);
  });
});
```

Run: `pnpm --filter monti-functions exec vitest run test/chain.test.ts`
Expected: FAIL — `Failed to resolve import "../src/lib/chain.js"`

- [ ] **Step 4: `chain.ts`를 쓴다**

```ts
import { createPublicClient, createWalletClient, defineChain, http, type Abi, type Hex } from 'viem';
import { getDeployment, withGasMargin, type Deployment } from '@monti/shared';
import { getAttesterAccount } from './attester.js';
import { CHAIN_ID, RPC_URL } from '../config.js';

export function monadChain() {
  const id = Number(CHAIN_ID.value());
  return defineChain({
    id,
    name: id === 143 ? 'Monad' : 'Monad Testnet',
    nativeCurrency: { name: 'Monad', symbol: 'MON', decimals: 18 },
    rpcUrls: { default: { http: [RPC_URL.value()] } },
  });
}

export function deployment(): Deployment {
  return getDeployment(Number(CHAIN_ID.value()));
}

export function publicClient() {
  return createPublicClient({ chain: monadChain(), transport: http(RPC_URL.value()) });
}

export function walletClient() {
  return createWalletClient({
    account: getAttesterAccount(),
    chain: monadChain(),
    transport: http(RPC_URL.value()),
  });
}

/** Monad는 gas_limit 기준 과금이라 모든 쓰기가 이 함수를 통과해야 한다. */
export function gasLimitFor(estimate: bigint): bigint {
  const limit = withGasMargin(estimate);
  return limit < estimate ? estimate : limit;
}

export interface AttesterTx {
  address: Hex;
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
}

/** 어테스터 EOA로 컨트랙트 함수를 호출한다. 가스 한도를 반드시 명시한다. */
export async function sendAttesterTx(tx: AttesterTx): Promise<Hex> {
  const account = getAttesterAccount();
  const pc = publicClient();
  const estimate = await pc.estimateContractGas({
    address: tx.address,
    abi: tx.abi,
    functionName: tx.functionName,
    args: tx.args,
    account,
  });
  return walletClient().writeContract({
    address: tx.address,
    abi: tx.abi,
    functionName: tx.functionName,
    args: tx.args,
    account,
    chain: monadChain(),
    gas: gasLimitFor(estimate),
  });
}

/** 스펙 §10.4 규칙 3: 체인과 DB를 함께 건드리는 작업은 finalized 뒤에 완료 처리한다. */
export async function awaitFinalized(blockNumber: bigint, timeoutMs = 20_000): Promise<void> {
  const pc = publicClient();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const finalized = await pc.getBlock({ blockTag: 'finalized' });
    if (finalized.number !== null && finalized.number >= blockNumber) return;
    if (Date.now() > deadline) throw new Error('FINALITY_TIMEOUT');
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}
```

`functions/src/index.ts` (지금은 비어 있고 Task 16부터 채운다):

```ts
export {};
```

- [ ] **Step 5: 테스트를 통과시키고 커밋한다**

Run:
```bash
pnpm install
pnpm --filter monti-functions exec vitest run test/chain.test.ts
pnpm --filter monti-functions build
```
Expected: `Tests  3 passed (3)` 그리고 tsc 무출력.

```bash
git add functions/package.json functions/tsconfig.json functions/src/config.ts \
        functions/src/lib/chain.ts functions/src/index.ts functions/test/chain.test.ts pnpm-lock.yaml
git commit -m "feat(functions): add region config, params and gas-margined chain client"
```

---

## Task 15: `db.ts`와 `auth.ts` — 컬렉션, 상태 전이, 호출자 계정 해석

**Files:**
- Create: `functions/src/lib/db.ts`, `functions/src/lib/auth.ts`
- Test: `functions/test/db.test.ts`, `functions/test/auth.test.ts`

**Interfaces:**
- Consumes: Task 14 `publicClient`, `deployment`; Task 3 `organizersAbi`, `ticketAbi`.
- Produces:
  - `db`, `authAdmin`, `storage` (Admin SDK 싱글턴)
  - 컬렉션 상수 `PERSONS`, `USERS`, `PASSKEYS`, `DEVICES`, `INVITES`, `KYC_SESSIONS`, `AUTH_CHALLENGES`, `PHONE_INDEX`, `TRANSFER_INVITES`, `EVENT_CHATS`, 그리고 `ALLOWED_COLLECTIONS`(Task 31의 정적 스캔이 쓴다)
  - `assertStatusTransition(from: PersonStatus, to: PersonStatus): void`
  - `resolveCallerAccount(request: CallableRequest): Promise<Hex>`
  - `PERM_MANAGE_GATES = 2`, `PERM_APPROVE_OVERRIDE = 4`
  - `requireStaffForGate(eventId: bigint, callerAccount: Hex, gateAccount: Hex): Promise<void>`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`functions/test/db.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ALLOWED_COLLECTIONS, assertStatusTransition } from '../src/lib/db.js';

describe('assertStatusTransition', () => {
  it('allows pending → active, the normal signup path now that KYC is per-event', () => {
    expect(() => assertStatusTransition('pending', 'active')).not.toThrow();
  });

  it('still allows the legacy pending → kyc_ok → active path', () => {
    expect(() => assertStatusTransition('pending', 'kyc_ok')).not.toThrow();
    expect(() => assertStatusTransition('kyc_ok', 'active')).not.toThrow();
  });

  it('allows rotation from active', () => {
    expect(() => assertStatusTransition('active', 'rotated')).not.toThrow();
  });

  it('blocks going backwards and resurrecting a rejected person', () => {
    expect(() => assertStatusTransition('active', 'pending')).toThrow('BAD_STATUS_TRANSITION');
    expect(() => assertStatusTransition('rejected', 'active')).toThrow('BAD_STATUS_TRANSITION');
  });

  it('is a no-op for an identical status (idempotent replays)', () => {
    expect(() => assertStatusTransition('active', 'active')).not.toThrow();
  });
});

describe('ALLOWED_COLLECTIONS', () => {
  it('contains no chain-authoritative collection', () => {
    for (const forbidden of ['tickets', 'checkIns', 'roles', 'gates', 'events', 'admins', 'managers']) {
      expect(ALLOWED_COLLECTIONS).not.toContain(forbidden);
    }
  });
});
```

Run: `pnpm --filter monti-functions exec vitest run test/db.test.ts`
Expected: FAIL — `Failed to resolve import "../src/lib/db.js"`

- [ ] **Step 2: `db.ts`를 쓴다**

```ts
import { getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import type { PersonStatus } from '@monti/shared';

if (getApps().length === 0) initializeApp();

export const db = getFirestore();
export const authAdmin = getAuth();
export const storage = getStorage();

export const PERSONS = 'persons';
export const USERS = 'users';
export const PASSKEYS = 'passkeys';
export const DEVICES = 'devices';
export const INVITES = 'invites';
export const KYC_SESSIONS = 'kycSessions';
export const AUTH_CHALLENGES = 'authChallenges';
export const PHONE_INDEX = 'phoneIndex';
export const TRANSFER_INVITES = 'transferInvites';
export const EVENT_CHATS = 'eventChats';

/**
 * Functions가 쓸 수 있는 컬렉션의 전부. 스펙 §10.4 규칙 1에 따라
 * 티켓 상태·권한·입장 기록 컬렉션은 여기에 없고, Task 31이 소스를 스캔해 강제한다.
 */
export const ALLOWED_COLLECTIONS = [
  PERSONS,
  USERS,
  PASSKEYS,
  DEVICES,
  INVITES,
  KYC_SESSIONS,
  AUTH_CHALLENGES,
  PHONE_INDEX,
  TRANSFER_INVITES,
  EVENT_CHATS,
  'members',
  'messages',
] as const;

/**
 * KYC가 공연별·선택적으로 바뀐 뒤의 상태 기계다.
 * 가입은 본인인증 없이 끝나므로 `pending → active` 가 정상 경로이고,
 * 본인인증 통과 여부는 status가 아니라 **`kycLevel`(0 또는 1)** 이 따로 들고 있다.
 * `kyc_ok` 와 `rejected` 는 마스터 계획의 유니온을 유지하려고 남겨 둔 값이며
 * 이 계획의 어떤 함수도 더 이상 쓰지 않는다.
 */
const ALLOWED_TRANSITIONS: Record<PersonStatus, PersonStatus[]> = {
  pending: ['pending', 'active', 'kyc_ok', 'rejected'],
  kyc_ok: ['kyc_ok', 'active', 'rejected'],
  active: ['active', 'rotated'],
  rotated: ['rotated'],
  rejected: ['rejected'],
};

/** 뒤로 가거나 죽은 상태를 되살리는 전이만 막는다. */
export function assertStatusTransition(from: PersonStatus, to: PersonStatus): void {
  if (!ALLOWED_TRANSITIONS[from]?.includes(to)) {
    throw new Error(`BAD_STATUS_TRANSITION:${from}->${to}`);
  }
}
```

- [ ] **Step 3: `auth.ts`를 쓴다**

```ts
import { HttpsError, type CallableRequest } from 'firebase-functions/v2/https';
import { organizersAbi, ticketAbi, type Hex } from '@monti/shared';
import { deployment, publicClient } from './chain.js';
import { PERSONS, USERS, db } from './db.js';

/**
 * 호출자의 스마트 계정 주소.
 * 1순위: `loginVerify`가 커스텀 토큰에 넣어 준 `account` 클레임.
 * 2순위: users/{uid} → persons/{personId}.account.
 */
export async function resolveCallerAccount(request: CallableRequest): Promise<Hex> {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'AUTH_REQUIRED');

  const claim = request.auth?.token?.account;
  if (typeof claim === 'string' && /^0x[0-9a-fA-F]{40}$/.test(claim)) return claim as Hex;

  const user = await db.collection(USERS).doc(uid).get();
  const personId = user.get('personId') as string | undefined;
  if (!personId) throw new HttpsError('failed-precondition', 'NO_PERSON');

  const person = await db.collection(PERSONS).doc(personId).get();
  const account = person.get('account') as string | undefined;
  if (!account) throw new HttpsError('failed-precondition', 'NO_ACCOUNT');
  return account as Hex;
}

export const PERM_MANAGE_GATES = 2;
export const PERM_APPROVE_OVERRIDE = 4;

/**
 * `issueSnapshot` / `getPhotoForGate` 의 인가.
 *
 * **게이트 단말기 계정은 Firebase에 로그인하지 않는다.** 게이트 계정의 소유자 키는
 * 안드로이드 하드웨어 P-256 키라서 패스키 로그인을 할 수 없다. 호출자는 언제나
 * **스태프 본인의 Firebase 세션**(패스키 스마트 계정 = `persons.account`)이고,
 * 어느 게이트를 위한 요청인지는 `gateAccount` 인자로 온다.
 *
 * 두 조건을 모두 만족해야 한다.
 *  (a) 호출자가 그 공연 주최자의 **매니저**이거나 `PERM_MANAGE_GATES` 또는
 *      `PERM_APPROVE_OVERRIDE` 권한을 가진 **관리자**다.
 *  (b) `gateAccount` 가 그 공연의 **열린 게이트**이거나, 아직 열기 전이라도
 *      등록돼 있고 폐기되지 않은 같은 공연의 게이트다(사전 스냅샷 내려받기).
 *
 * 판정은 전부 eth_call 이다. 우리 DB에는 역할이 없다(스펙 §9.4).
 */
export async function requireStaffForGate(
  eventId: bigint,
  callerAccount: Hex,
  gateAccount: Hex,
): Promise<void> {
  const pc = publicClient();
  const contracts = deployment();

  const orgId = await pc.readContract({
    address: contracts.ticket,
    abi: ticketAbi,
    functionName: 'eventOrg',
    args: [eventId],
  });

  // 두 권한 비트를 각각 물어보고 OR 한다. 한 번에 마스크(2|4)를 넘기면
  // sub-plan 01 의 hasPermission 이 "모두" 로 구현됐을 때 조용히 거부된다.
  const [manager, canManageGates, canApproveOverride] = await Promise.all([
    pc.readContract({
      address: contracts.organizers, abi: organizersAbi, functionName: 'managerOf',
      args: [orgId, callerAccount],
    }),
    pc.readContract({
      address: contracts.organizers, abi: organizersAbi, functionName: 'hasPermission',
      args: [orgId, callerAccount, PERM_MANAGE_GATES],
    }),
    pc.readContract({
      address: contracts.organizers, abi: organizersAbi, functionName: 'hasPermission',
      args: [orgId, callerAccount, PERM_APPROVE_OVERRIDE],
    }),
  ]);
  if (!manager[0] && !canManageGates && !canApproveOverride) {
    throw new HttpsError('permission-denied', 'NOT_EVENT_STAFF');
  }

  const openGate = await pc.readContract({
    address: contracts.organizers, abi: organizersAbi, functionName: 'isOpenGate',
    args: [eventId, gateAccount],
  });
  if (openGate) return;

  // 공연 시작 전 스냅샷 내려받기: 등록돼 있고 폐기되지 않은 같은 공연의 게이트면 통과.
  const gateId = await pc.readContract({
    address: contracts.organizers, abi: organizersAbi, functionName: 'gateOf', args: [gateAccount],
  });
  if ((gateId as bigint) === 0n) throw new HttpsError('permission-denied', 'GATE_NOT_REGISTERED');

  const info = await pc.readContract({
    address: contracts.organizers, abi: organizersAbi, functionName: 'gateInfo', args: [gateId as bigint],
  });
  const [gateEventId, , , , , revoked] = info as readonly [bigint, Hex, Hex, Hex, boolean, boolean];
  if (revoked) throw new HttpsError('permission-denied', 'GATE_REVOKED');
  if (gateEventId !== eventId) throw new HttpsError('permission-denied', 'GATE_WRONG_EVENT');
}
```

- [ ] **Step 4: 인가 매트릭스 테스트를 쓴다**

`functions/test/auth.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const GATE = '0x00000000000000000000000000000000000000Ga'.toLowerCase() as `0x${string}`;
const STAFF = '0x9999999999999999999999999999999999999999';

const state = {
  manager: [false, false] as readonly [boolean, boolean],
  manageGates: false,
  approveOverride: false,
  openGate: false,
  gateId: 3n,
  gateInfo: [11n, GATE, `0x${'11'.repeat(32)}`, `0x${'22'.repeat(32)}`, false, false] as const,
};

vi.mock('../src/lib/chain.js', () => ({
  publicClient: () => ({
    readContract: vi.fn(async ({ functionName, args }: { functionName: string; args: readonly unknown[] }) => {
      if (functionName === 'eventOrg') return 1n;
      if (functionName === 'managerOf') return state.manager;
      if (functionName === 'hasPermission') return args[2] === 2 ? state.manageGates : state.approveOverride;
      if (functionName === 'isOpenGate') return state.openGate;
      if (functionName === 'gateOf') return state.gateId;
      return state.gateInfo;
    }),
  }),
  deployment: () => ({
    ticket: '0x3333333333333333333333333333333333333333',
    organizers: '0x2222222222222222222222222222222222222222',
  }),
}));

const { requireStaffForGate } = await import('../src/lib/auth.js');

beforeEach(() => {
  state.manager = [false, false];
  state.manageGates = false;
  state.approveOverride = false;
  state.openGate = false;
  state.gateId = 3n;
  state.gateInfo = [11n, GATE, `0x${'11'.repeat(32)}`, `0x${'22'.repeat(32)}`, false, false];
});

describe('requireStaffForGate — condition (a): the caller is event staff', () => {
  it('accepts a manager', async () => {
    state.manager = [true, false];
    state.openGate = true;
    await expect(requireStaffForGate(11n, STAFF, GATE)).resolves.toBeUndefined();
  });

  it('accepts an admin with only PERM_MANAGE_GATES', async () => {
    state.manageGates = true;
    state.openGate = true;
    await expect(requireStaffForGate(11n, STAFF, GATE)).resolves.toBeUndefined();
  });

  it('accepts an admin with only PERM_APPROVE_OVERRIDE', async () => {
    state.approveOverride = true;
    state.openGate = true;
    await expect(requireStaffForGate(11n, STAFF, GATE)).resolves.toBeUndefined();
  });

  it('rejects a caller with neither role even when the gate is open', async () => {
    state.openGate = true;
    await expect(requireStaffForGate(11n, STAFF, GATE)).rejects.toThrow('NOT_EVENT_STAFF');
  });
});

describe('requireStaffForGate — condition (b): the gate belongs to the event', () => {
  it('accepts a registered but not-yet-open gate (pre-event snapshot download)', async () => {
    state.manager = [true, false];
    await expect(requireStaffForGate(11n, STAFF, GATE)).resolves.toBeUndefined();
  });

  it('rejects an unregistered gate account', async () => {
    state.manager = [true, false];
    state.gateId = 0n;
    await expect(requireStaffForGate(11n, STAFF, GATE)).rejects.toThrow('GATE_NOT_REGISTERED');
  });

  it('rejects a revoked gate', async () => {
    state.manager = [true, false];
    state.gateInfo = [11n, GATE, `0x${'11'.repeat(32)}`, `0x${'22'.repeat(32)}`, false, true];
    await expect(requireStaffForGate(11n, STAFF, GATE)).rejects.toThrow('GATE_REVOKED');
  });

  it("rejects a gate registered to another event", async () => {
    state.manager = [true, false];
    state.gateInfo = [12n, GATE, `0x${'11'.repeat(32)}`, `0x${'22'.repeat(32)}`, false, false];
    await expect(requireStaffForGate(11n, STAFF, GATE)).rejects.toThrow('GATE_WRONG_EVENT');
  });
});
```

- [ ] **Step 5: 테스트를 통과시킨다**

Run:
```bash
pnpm --filter monti-functions exec vitest run test/db.test.ts
pnpm --filter monti-functions exec vitest run test/auth.test.ts
```
Expected: `Tests  6 passed (6)` 그리고 `Tests  8 passed (8)`

- [ ] **Step 6: 커밋**

```bash
git add functions/src/lib/db.ts functions/src/lib/auth.ts functions/test/db.test.ts functions/test/auth.test.ts
git commit -m "feat(functions): add Firestore singletons, status guard and staff-for-gate authorization"
```

---

## Task 16: `startSignup`

**Files:**
- Create: `functions/src/functions/startSignup.ts`
- Modify: `functions/src/index.ts`
- Test: `functions/test/startSignup.test.ts`

**Interfaces:**
- Consumes: Task 15 `db`, `PERSONS`, `USERS`; Task 14 `PHONE_INDEX_KEY`.
- Produces: callable `startSignup`: `{}` → `{ personId: Hex }`. `persons/{personId}` 를 `status: 'pending'`, **`kycLevel: 0`** 으로, `users/{uid}` 를 만들고 `phoneIndex`에 색인한다. `personId`는 `randomBytes(32)`이고 **어떤 것의 해시도 아니다**(마스터 계획 Global Constraints).

**본인인증은 가입에 없다(창업자 델타).** KYC는 **공연별·요청 시**로 옮겨졌다. 가입은 전화번호 인증 하나로 끝나고, 본인인증이 필요한 공연을 만나면 그때 `startKyc`(Task 44)를 부른다. 따라서 이 함수는 Didit을 호출하지 않는다. **레벨 0 계정의 유일한 중복 방지 수단은 전화번호**이고, `phoneIndex/{hmacPhone}`가 한 번호당 한 계정을 강제한다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`functions/test/startSignup.test.ts`:

```ts
import { describe, expect, it, beforeEach, vi } from 'vitest';

const { db, USERS, PERSONS, PHONE_INDEX } = await import('../src/lib/db.js');
const { startSignup } = await import('../src/functions/startSignup.js');
const functionsTest = (await import('firebase-functions-test')).default();

async function clear(): Promise<void> {
  process.env.PHONE_INDEX_KEY = 'monti-test-key';
  for (const collection of [USERS, PERSONS, PHONE_INDEX]) {
    const snap = await db.collection(collection).get();
    await Promise.all(snap.docs.map((d) => d.ref.delete()));
  }
}

beforeEach(clear);

const wrapped = functionsTest.wrap(startSignup);
const auth = { uid: 'uid-1', token: { phone_number: '+821011112222' } };

describe('startSignup', () => {
  it('creates a level-0 pending person with a random personId, a users doc and a phone index entry', async () => {
    const result = (await wrapped({ data: {}, auth } as never)) as Record<string, unknown>;

    expect(result.personId).toMatch(/^0x[0-9a-f]{64}$/);
    expect(result).not.toHaveProperty('kycUrl'); // 가입은 더 이상 본인인증을 요구하지 않는다

    const person = await db.collection(PERSONS).doc(result.personId as string).get();
    expect(person.get('status')).toBe('pending');
    expect(person.get('kycLevel')).toBe(0);
    expect(person.get('kyc')).toBeUndefined();

    const user = await db.collection(USERS).doc('uid-1').get();
    expect(user.get('personId')).toBe(result.personId);
    expect(user.get('phoneE164')).toBe('+821011112222');
    expect(user.get('locale')).toBe('ko');
    expect((await db.collection(PHONE_INDEX).get()).size).toBe(1);
  });

  it('returns the same personId when called twice (idempotent by uid)', async () => {
    const first = (await wrapped({ data: {}, auth } as never)) as { personId: string };
    const second = (await wrapped({ data: {}, auth } as never)) as { personId: string };
    expect(second.personId).toBe(first.personId);
  });

  it('refuses an unauthenticated caller and a session without a phone number', async () => {
    await expect(wrapped({ data: {} } as never)).rejects.toThrow('AUTH_REQUIRED');
    await expect(wrapped({ data: {}, auth: { uid: 'uid-2', token: {} } } as never)).rejects.toThrow('PHONE_REQUIRED');
  });
});
```

Run: `firebase emulators:exec --only firestore,auth "pnpm --filter monti-functions exec vitest run test/startSignup.test.ts"`
Expected: FAIL — `Failed to resolve import "../src/functions/startSignup.js"`

- [ ] **Step 2: `didit.ts`의 세션 생성 부분을 쓴다** (Task 44가 쓴다)

```ts
import type { Hex } from '@monti/shared';

const DIDIT_SESSION_URL = 'https://verification.didit.me/v2/session/';

export async function createDiditSession(
  personId: Hex,
  apiKey: string,
  workflowId: string,
  callbackUrl: string,
): Promise<{ sessionId: string; url: string }> {
  const response = await fetch(DIDIT_SESSION_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
    // vendor_data 는 웹훅으로 그대로 되돌아온다. personId(난수)만 넣고 개인정보는 넣지 않는다.
    body: JSON.stringify({ workflow_id: workflowId, vendor_data: personId, callback: callbackUrl }),
  });
  if (!response.ok) throw new Error(`DIDIT_SESSION_FAILED:${response.status}`);
  const body = (await response.json()) as { session_id?: string; url?: string };
  if (!body.session_id || !body.url) throw new Error('DIDIT_SESSION_MALFORMED');
  return { sessionId: body.session_id, url: body.url };
}
```

- [ ] **Step 3: `startSignup.ts`를 쓴다**

```ts
import { randomBytes } from 'node:crypto';
import { FieldValue } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import type { Hex } from '@monti/shared';
import { PHONE_INDEX_KEY } from '../config.js';
import { PERSONS, USERS, db } from '../lib/db.js';
import { upsertPhoneIndex } from '../lib/phoneIndex.js';

export const startSignup = onCall(
  { secrets: [PHONE_INDEX_KEY] },
  async (request): Promise<{ personId: Hex }> => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError('unauthenticated', 'AUTH_REQUIRED');
    const phoneE164 = request.auth?.token?.phone_number as string | undefined;
    if (!phoneE164) throw new HttpsError('failed-precondition', 'PHONE_REQUIRED');

    const userRef = db.collection(USERS).doc(uid);
    const existing = await userRef.get();
    const existingPersonId = existing.get('personId') as Hex | undefined;
    if (existingPersonId) return { personId: existingPersonId };

    // personId 는 아무 의미 없는 난수 32바이트다. 전화번호나 이름의 해시가 아니다.
    const personId = `0x${randomBytes(32).toString('hex')}` as Hex;
    await db.runTransaction(async (tx) => {
      tx.set(db.collection(PERSONS).doc(personId), {
        status: 'pending',
        kycLevel: 0, // 본인인증은 공연별로 필요할 때 startKyc 가 올린다
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      tx.set(userRef, {
        personId,
        phoneE164,
        locale: 'ko',
        chatOrder: [],
        createdAt: FieldValue.serverTimestamp(),
      });
    });

    // 레벨 0 계정의 유일한 중복 방지: 한 전화번호에 한 계정.
    await upsertPhoneIndex(phoneE164, personId, PHONE_INDEX_KEY.value());

    return { personId };
  },
);
```

`functions/src/index.ts`:

```ts
export { startSignup } from './functions/startSignup.js';
```

- [ ] **Step 4: 테스트를 통과시킨다**

Run: `firebase emulators:exec --only firestore,auth "pnpm --filter monti-functions exec vitest run test/startSignup.test.ts"`
Expected: PASS — `Tests  3 passed (3)`, `✔  Script exited successfully`

- [ ] **Step 5: 커밋**

```bash
git add functions/src/lib/didit.ts functions/src/functions/startSignup.ts functions/src/index.ts functions/test/startSignup.test.ts
git commit -m "feat(functions): add KYC-free signup with a random personId and phone index"
```

---

## Task 17: `diditWebhook` — HMAC 검증, 멱등, 원본 레닥션

**Files:**
- Modify: `functions/src/lib/didit.ts`
- Create: `functions/src/functions/diditWebhook.ts`
- Test: `functions/test/didit.test.ts`

**Interfaces:**
- Consumes: Task 2 `DIDIT_WEBHOOK_TOLERANCE_SECONDS`; Task 15 `assertStatusTransition`, `KYC_SESSIONS`, `PERSONS`.
- Produces:
  - `verifyDiditSignature(input: { raw: string; signature: string; timestamp: number; secret: string; now: number; toleranceSeconds?: number }): boolean`
  - `redactDiditPayload(input: unknown): unknown`
  - HTTPS `diditWebhook`. **`persons.status`는 건드리지 않는다.** `Approved` + Face Search `clear` → 어테스터가 `Identity.setKycLevel(personId, 1)`(가스 한도 ×1.075, `finalized` 대기)을 보내고 `persons.kycLevel = 1`, `persons.kyc = {...}` 를 쓴다. 같은 얼굴이 이미 있으면 **`kycLevel`은 0 그대로**이고 `kyc.rejectedReason = 'duplicate_face'` 만 남는다. `kycSessions/{session_id}` 기준 **멱등**.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`functions/test/didit.test.ts`:

```ts
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { redactDiditPayload, verifyDiditSignature } from '../src/lib/didit.js';

const SECRET = 'whsec-monti';
const RAW = '{"session_id":"s1","status":"Approved","vendor_data":"0xaa"}';
const NOW = 1_789_862_400;
const SIG = createHmac('sha256', SECRET).update(RAW, 'utf8').digest('hex');

describe('verifyDiditSignature', () => {
  it('accepts a correct signature inside the 300 s window', () => {
    expect(verifyDiditSignature({ raw: RAW, signature: SIG, timestamp: NOW, secret: SECRET, now: NOW })).toBe(true);
    expect(verifyDiditSignature({ raw: RAW, signature: SIG, timestamp: NOW - 299, secret: SECRET, now: NOW })).toBe(true);
  });

  it('rejects a stale or future timestamp', () => {
    expect(verifyDiditSignature({ raw: RAW, signature: SIG, timestamp: NOW - 301, secret: SECRET, now: NOW })).toBe(false);
    expect(verifyDiditSignature({ raw: RAW, signature: SIG, timestamp: NOW + 301, secret: SECRET, now: NOW })).toBe(false);
  });

  it('rejects a wrong signature, a wrong body and a wrong secret', () => {
    expect(verifyDiditSignature({ raw: RAW, signature: 'deadbeef', timestamp: NOW, secret: SECRET, now: NOW })).toBe(false);
    expect(verifyDiditSignature({ raw: `${RAW} `, signature: SIG, timestamp: NOW, secret: SECRET, now: NOW })).toBe(false);
    expect(verifyDiditSignature({ raw: RAW, signature: SIG, timestamp: NOW, secret: 'other', now: NOW })).toBe(false);
  });
});

describe('redactDiditPayload', () => {
  it('removes every PII field at any depth but keeps decision fields', () => {
    const redacted = redactDiditPayload({
      session_id: 's1',
      status: 'Approved',
      vendor_data: '0xaa',
      decision: {
        id_verification: { first_name: '길동', last_name: '홍', document_number: 'M12345678', portrait_image: 'data:...' },
        face_search: { status: 'clear', score: 0.1 },
      },
    }) as Record<string, Record<string, Record<string, unknown>>>;

    expect(redacted.decision.id_verification.first_name).toBe('[redacted]');
    expect(redacted.decision.id_verification.document_number).toBe('[redacted]');
    expect(redacted.decision.id_verification.portrait_image).toBe('[redacted]');
    expect(redacted.decision.face_search.status).toBe('clear');
    expect((redacted as unknown as { session_id: string }).session_id).toBe('s1');
  });
});
```

Run: `pnpm --filter monti-functions exec vitest run test/didit.test.ts`
Expected: FAIL — `verifyDiditSignature is not a function`

- [ ] **Step 2: `didit.ts`에 검증과 레닥션을 추가한다**

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';
import { DIDIT_WEBHOOK_TOLERANCE_SECONDS } from '@monti/shared';

export function verifyDiditSignature(input: {
  raw: string;
  signature: string;
  timestamp: number;
  secret: string;
  now: number;
  toleranceSeconds?: number;
}): boolean {
  const tolerance = input.toleranceSeconds ?? DIDIT_WEBHOOK_TOLERANCE_SECONDS;
  if (!Number.isFinite(input.timestamp) || input.timestamp <= 0) return false;
  if (Math.abs(input.now - input.timestamp) > tolerance) return false;

  const expected = createHmac('sha256', input.secret).update(input.raw, 'utf8').digest('hex');
  const provided = input.signature.trim().toLowerCase();
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(provided, 'utf8'));
}

const PII_KEYS = new Set([
  'first_name', 'last_name', 'full_name', 'date_of_birth', 'document_number', 'personal_number',
  'address', 'portrait_image', 'front_image', 'back_image', 'face_image', 'full_front_image',
  'gender', 'nationality', 'place_of_birth', 'expiration_date', 'date_of_issue', 'issuing_state',
  'phone', 'email', 'age', 'ip_address',
]);

/** 개인정보는 체인에도 로그에도 Firestore 원본에도 남기지 않는다(스펙 §10.3). */
export function redactDiditPayload(input: unknown): unknown {
  if (Array.isArray(input)) return input.map(redactDiditPayload);
  if (input !== null && typeof input === 'object') {
    const source = input as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(source)) {
      out[key] = PII_KEYS.has(key) ? '[redacted]' : redactDiditPayload(value);
    }
    return out;
  }
  return input;
}
```

- [ ] **Step 3: `diditWebhook.ts`를 쓴다**

```ts
import { FieldValue } from 'firebase-admin/firestore';
import { onRequest } from 'firebase-functions/v2/https';
import { identityAbi, type Hex } from '@monti/shared';
import { ATTESTER_PK, DIDIT_WEBHOOK_SECRET } from '../config.js';
import { awaitFinalized, deployment, publicClient, sendAttesterTx } from '../lib/chain.js';
import { KYC_SESSIONS, PERSONS, db } from '../lib/db.js';
import { redactDiditPayload, verifyDiditSignature } from '../lib/didit.js';
import { encryptField } from '../lib/kms.js';

interface DiditBody {
  session_id?: string;
  status?: string;
  vendor_data?: string;
  decision?: {
    face_search?: { status?: string };
    id_verification?: {
      first_name?: string;
      last_name?: string;
      document_number?: string;
      portrait_image?: string;
    };
  };
}

export const diditWebhook = onRequest(
  { secrets: [DIDIT_WEBHOOK_SECRET, ATTESTER_PK], cors: false, invoker: 'public', timeoutSeconds: 120 },
  async (req, res) => {
    const raw = req.rawBody?.toString('utf8') ?? '';
    const ok = verifyDiditSignature({
      raw,
      signature: String(req.get('X-Signature-V2') ?? ''),
      timestamp: Number(req.get('X-Timestamp') ?? '0'),
      secret: DIDIT_WEBHOOK_SECRET.value(),
      now: Math.floor(Date.now() / 1000),
    });
    if (!ok) {
      res.status(401).send('bad signature');
      return;
    }

    let body: DiditBody;
    try {
      body = JSON.parse(raw) as DiditBody;
    } catch {
      res.status(400).send('bad json');
      return;
    }

    const sessionId = body.session_id;
    const personId = body.vendor_data as Hex | undefined;
    if (!sessionId || !personId || !/^0x[0-9a-fA-F]{64}$/.test(personId)) {
      res.status(400).send('missing session or vendor_data');
      return;
    }

    const sessionRef = db.collection(KYC_SESSIONS).doc(sessionId);
    const duplicate = await db.runTransaction(async (tx) => {
      const current = await tx.get(sessionRef);
      if (current.exists && current.get('decision') === body.status) return true;
      tx.set(
        sessionRef,
        {
          personId,
          status: body.status ?? 'Unknown',
          decision: body.status ?? 'Unknown',
          raw: redactDiditPayload(body),
          receivedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      return false;
    });
    if (duplicate) {
      res.status(200).send('duplicate');
      return;
    }

    const terminal = ['Approved', 'Declined', 'Expired', 'Abandoned'].includes(body.status ?? '');
    if (!terminal) {
      res.status(200).send('pending');
      return;
    }

    const faceSearchOk = body.decision?.face_search?.status === 'clear';
    const approved = body.status === 'Approved' && faceSearchOk;
    const personRef = db.collection(PERSONS).doc(personId);

    // 얼굴이 이미 등록돼 있으면 레벨을 올리지 않는다. persons.status 는 건드리지 않는다.
    if (!approved) {
      await personRef.set(
        {
          kyc: {
            provider: 'didit',
            sessionId,
            status: 'rejected',
            rejectedReason: body.status === 'Approved' ? 'duplicate_face' : 'declined',
          },
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      res.status(200).send('rejected');
      return;
    }

    // 여기부터는 승인된 경우다. 개인정보를 KMS 봉투 암호화로 저장한다. 원본은 어디에도 남기지 않는다.
    {
      const identity = body.decision?.id_verification ?? {};
      const fullName = `${identity.last_name ?? ''}${identity.first_name ?? ''}`.trim();
      const portrait = identity.portrait_image ?? '';
      const [encName, encDoc, encPhoto] = await Promise.all([
        fullName ? encryptField(fullName) : Promise.resolve(''),
        identity.document_number ? encryptField(identity.document_number) : Promise.resolve(''),
        portrait ? encryptField(portrait.replace(/^data:image\/[a-z]+;base64,/, '')) : Promise.resolve(''),
      ]);
      await personRef.set(
        { enc: { name: encName, docNumber: encDoc }, photoEnc: encPhoto },
        { merge: true },
      );
    }
    // 웹훅 재시도 멱등: 이미 레벨 1이면 체인에 다시 쓰지 않는다.
    const person = await personRef.get();
    if ((person.get('kycLevel') as number | undefined) === 1) {
      res.status(200).send('already-level-1');
      return;
    }

    const txHash = await sendAttesterTx({
      address: deployment().identity,
      abi: identityAbi,
      functionName: 'setKycLevel',
      args: [personId, 1],
    });
    const receipt = await publicClient().waitForTransactionReceipt({ hash: txHash, timeout: 30_000 });
    if (receipt.status !== 'success') {
      res.status(500).send('setKycLevel reverted');
      return;
    }
    // 스펙 §10.4 규칙 3: finalized 뒤에만 DB를 완료 처리한다.
    await awaitFinalized(receipt.blockNumber);

    await personRef.set(
      {
        kycLevel: 1,
        kyc: {
          provider: 'didit',
          sessionId,
          status: 'approved',
          verifiedAt: FieldValue.serverTimestamp(),
          faceSearchOk,
          levelTx: txHash,
        },
        chain: { block: Number(receipt.blockNumber) },
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    res.status(200).send('ok');
  },
);
```

`functions/src/index.ts`에 추가: `export { diditWebhook } from './functions/diditWebhook.js';`

- [ ] **Step 4: 테스트를 통과시킨다**

Run: `pnpm --filter monti-functions exec vitest run test/didit.test.ts`
Expected: PASS — `Tests  4 passed (4)`

- [ ] **Step 5: 웹훅 URL을 Didit 콘솔에 등록한다**

Run:
```bash
pnpm --filter monti-functions build && firebase deploy --only functions:diditWebhook --project dev
firebase functions:list --project dev | grep diditWebhook
```
Expected: `diditWebhook  v2  https  asia-northeast3` 한 줄. 그 URL을 Didit 콘솔 → Webhooks에 붙이고, 같은 화면의 시크릿을 `firebase functions:secrets:set DIDIT_WEBHOOK_SECRET`으로 넣는다.

- [ ] **Step 6: 커밋**

```bash
git add functions/src/lib/didit.ts functions/src/functions/diditWebhook.ts functions/src/index.ts functions/test/didit.test.ts
git commit -m "feat(functions): verify Didit webhooks with HMAC, redact PII and stay idempotent"
```

---

## Task 18: `registerPasskey` — WebAuthn 등록 검증과 반사실적 계정 주소

**Files:**
- Create: `functions/src/lib/webauthn.ts`, `functions/src/functions/registerPasskey.ts`
- Test: `functions/test/webauthn.test.ts`

**Interfaces:**
- Consumes: Task 14 `expectedOrigins`, `RP_ID`; Task 15 `db`, `PASSKEYS`, `PERSONS`, `AUTH_CHALLENGES`.
- Produces:
  - `coseToP256(cose: Uint8Array): { x: Hex; y: Hex }` — COSE_Key(kty 2, crv P-256)에서 x·y 32바이트씩.
  - `ownerBytes(x: Hex, y: Hex): Hex` — Coinbase Smart Wallet 소유자 바이트 `x‖y` 64바이트.
  - `challengeFromClientData(clientDataJSON: string): string` — base64url 챌린지.
  - callable `registerPasskey`: `{ personId, attestation }` → `{ ok: true; account: Hex; credentialId: string }`.

**챌린지 출처:** 클라이언트는 먼저 `loginChallenge({ purpose: 'register' })`(Task 20)로 챌린지를 받아 `navigator.credentials.create`에 넣는다. `registerPasskey`는 `attestation.response.clientDataJSON`에서 챌린지를 꺼내 `authChallenges/{challenge}` 문서와 대조하고 즉시 소비한다. 마스터 계획의 입력 시그니처 `{ personId, attestation }` 는 그대로 유지된다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`functions/test/webauthn.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { Encoder } from 'cbor-x';
import { challengeFromClientData, coseToP256, ownerBytes } from '../src/lib/webauthn.js';

const encoder = new Encoder({ useRecords: false, mapsAsObjects: false, tagUint8Array: false });
const X = Buffer.alloc(32, 0x11);
const Y = Buffer.alloc(32, 0x22);

function coseKey(map: Array<[number, unknown]>): Uint8Array {
  return new Uint8Array(encoder.encode(new Map(map)));
}

describe('coseToP256', () => {
  it('extracts x and y from a P-256 COSE key', () => {
    const cose = coseKey([[1, 2], [3, -7], [-1, 1], [-2, X], [-3, Y]]);
    expect(coseToP256(cose)).toEqual({
      x: `0x${'11'.repeat(32)}`,
      y: `0x${'22'.repeat(32)}`,
    });
  });

  it('rejects a non-P-256 key and a truncated coordinate', () => {
    expect(() => coseToP256(coseKey([[1, 1], [3, -8], [-1, 6], [-2, X], [-3, Y]]))).toThrow('COSE_NOT_P256');
    expect(() => coseToP256(coseKey([[1, 2], [3, -7], [-1, 1], [-2, Buffer.alloc(31)], [-3, Y]]))).toThrow('COSE_BAD_COORDINATE');
  });
});

describe('ownerBytes', () => {
  it('concatenates x and y into 64 bytes for factory.getAddress', () => {
    expect(ownerBytes(`0x${'11'.repeat(32)}`, `0x${'22'.repeat(32)}`)).toBe(`0x${'11'.repeat(32)}${'22'.repeat(32)}`);
  });
});

describe('challengeFromClientData', () => {
  it('reads the challenge out of clientDataJSON', () => {
    const clientData = Buffer.from(
      JSON.stringify({ type: 'webauthn.create', challenge: 'abc-123_XY', origin: 'https://monti.app' }),
      'utf8',
    ).toString('base64url');
    expect(challengeFromClientData(clientData)).toBe('abc-123_XY');
  });

  it('rejects clientDataJSON without a challenge', () => {
    const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.create' }), 'utf8').toString('base64url');
    expect(() => challengeFromClientData(clientData)).toThrow('NO_CHALLENGE');
  });
});
```

Run: `pnpm --filter monti-functions exec vitest run test/webauthn.test.ts`
Expected: FAIL — `Failed to resolve import "../src/lib/webauthn.js"`

- [ ] **Step 2: `webauthn.ts`를 쓴다**

```ts
import { Encoder } from 'cbor-x';
import type { Hex } from '@monti/shared';

const decoder = new Encoder({ useRecords: false, mapsAsObjects: false, tagUint8Array: false });

function toHex32(value: unknown, label: string): Hex {
  const bytes = value instanceof Uint8Array ? value : undefined;
  if (!bytes || bytes.length !== 32) throw new Error(label);
  return `0x${Buffer.from(bytes).toString('hex')}` as Hex;
}

/** COSE_Key: 1=kty(2 EC2), 3=alg(-7 ES256), -1=crv(1 P-256), -2=x, -3=y */
export function coseToP256(cose: Uint8Array): { x: Hex; y: Hex } {
  const map = decoder.decode(cose) as Map<number, unknown>;
  if (!(map instanceof Map)) throw new Error('COSE_NOT_A_MAP');
  if (map.get(1) !== 2 || map.get(3) !== -7 || map.get(-1) !== 1) throw new Error('COSE_NOT_P256');
  return { x: toHex32(map.get(-2), 'COSE_BAD_COORDINATE'), y: toHex32(map.get(-3), 'COSE_BAD_COORDINATE') };
}

/** Coinbase Smart Wallet 은 패스키 소유자를 x||y 64바이트로 받는다. */
export function ownerBytes(x: Hex, y: Hex): Hex {
  return `0x${x.slice(2)}${y.slice(2)}` as Hex;
}

export function challengeFromClientData(clientDataJSONBase64Url: string): string {
  const json = Buffer.from(clientDataJSONBase64Url, 'base64url').toString('utf8');
  const parsed = JSON.parse(json) as { challenge?: string };
  if (!parsed.challenge) throw new Error('NO_CHALLENGE');
  return parsed.challenge;
}
```

- [ ] **Step 3: `registerPasskey.ts`를 쓴다**

```ts
import { verifyRegistrationResponse } from '@simplewebauthn/server';
import type { RegistrationResponseJSON } from '@simplewebauthn/server';
import { FieldValue } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { factoryAbi, type Hex } from '@monti/shared';
import { RP_ID, expectedOrigins } from '../config.js';
import { deployment, publicClient } from '../lib/chain.js';
import { AUTH_CHALLENGES, PASSKEYS, PERSONS, db } from '../lib/db.js';
import { challengeFromClientData, coseToP256, ownerBytes } from '../lib/webauthn.js';

export const registerPasskey = onCall(
  async (request): Promise<{ ok: true; account: Hex; credentialId: string }> => {
    if (!request.auth?.uid) throw new HttpsError('unauthenticated', 'AUTH_REQUIRED');
    const { personId, attestation } = (request.data ?? {}) as {
      personId?: Hex;
      attestation?: RegistrationResponseJSON;
    };
    if (!personId || !/^0x[0-9a-fA-F]{64}$/.test(personId)) throw new HttpsError('invalid-argument', 'BAD_PERSON_ID');
    if (!attestation?.response?.clientDataJSON) throw new HttpsError('invalid-argument', 'BAD_ATTESTATION');

    const personRef = db.collection(PERSONS).doc(personId);
    const person = await personRef.get();
    if (!person.exists) throw new HttpsError('not-found', 'PERSON_NOT_FOUND');
    // 가입에 본인인증이 없으므로 pending 이 정상 상태다. KYC 레벨은 여기서 보지 않는다.
    if (person.get('status') !== 'pending') throw new HttpsError('failed-precondition', 'BAD_SIGNUP_STATE');

    // 챌린지를 한 번만 쓰도록 트랜잭션으로 소비한다.
    const challenge = challengeFromClientData(attestation.response.clientDataJSON);
    const challengeRef = db.collection(AUTH_CHALLENGES).doc(challenge);
    await db.runTransaction(async (tx) => {
      const doc = await tx.get(challengeRef);
      if (!doc.exists) throw new HttpsError('failed-precondition', 'CHALLENGE_NOT_FOUND');
      if (doc.get('usedAt')) throw new HttpsError('failed-precondition', 'CHALLENGE_USED');
      if ((doc.get('expiresAt') as number) < Math.floor(Date.now() / 1000)) {
        throw new HttpsError('failed-precondition', 'CHALLENGE_EXPIRED');
      }
      tx.update(challengeRef, { usedAt: FieldValue.serverTimestamp() });
    });

    const verification = await verifyRegistrationResponse({
      response: attestation,
      expectedChallenge: challenge,
      expectedOrigin: expectedOrigins(),
      expectedRPID: RP_ID.value(),
      requireUserVerification: true,
    });
    if (!verification.verified || !verification.registrationInfo) {
      throw new HttpsError('permission-denied', 'ATTESTATION_REJECTED');
    }

    const credential = verification.registrationInfo.credential;
    const { x, y } = coseToP256(credential.publicKey);
    const contracts = deployment();
    const account = await publicClient().readContract({
      address: contracts.factory,
      abi: factoryAbi,
      functionName: 'getAddress',
      args: [[ownerBytes(x, y)], 0n],
    });

    await db.runTransaction(async (tx) => {
      tx.set(db.collection(PASSKEYS).doc(credential.id), {
        personId,
        publicKeyCose: Buffer.from(credential.publicKey).toString('base64'),
        counter: credential.counter,
        transports: attestation.response.transports ?? [],
        createdAt: FieldValue.serverTimestamp(),
      });
      tx.set(personRef, { account, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    });

    return { ok: true, account: account as Hex, credentialId: credential.id };
  },
);
```

`functions/src/index.ts`에 추가: `export { registerPasskey } from './functions/registerPasskey.js';`

- [ ] **Step 4: 테스트를 통과시킨다**

Run: `pnpm --filter monti-functions exec vitest run test/webauthn.test.ts`
Expected: PASS — `Tests  5 passed (5)`

- [ ] **Step 5: 커밋**

```bash
git add functions/src/lib/webauthn.ts functions/src/functions/registerPasskey.ts functions/src/index.ts functions/test/webauthn.test.ts
git commit -m "feat(functions): verify passkey registration and derive the counterfactual account"
```

---

## Task 19: `registerIdentity` — 어테스터 등록, 멱등, finalized 대기

**Files:**
- Create: `functions/src/functions/registerIdentity.ts`
- Test: `functions/test/registerIdentity.test.ts`

**Interfaces:**
- Consumes: Task 14 `sendAttesterTx`, `awaitFinalized`, `publicClient`, `deployment`; Task 15 `assertStatusTransition`.
- Produces: callable `registerIdentity`: `{ personId: Hex; deviceX: Hex; deviceY: Hex }` → `{ txHash: Hex }`. 어테스터가 `Identity.register(personId, account, deviceX, deviceY, 0)` 를 보낸다 — **다섯 번째 인자는 KYC 레벨이고 가입 시점에는 항상 0**이다(본인인증은 Task 44가 나중에 1로 올린다). **같은 `personId`로 두 번 불러도 체인 쓰기는 한 번**이다(스펙 §10.4 규칙 3).

- [ ] **Step 1: 실패하는 테스트를 쓴다 (멱등성이 핵심)**

`functions/test/registerIdentity.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sendAttesterTx = vi.fn(async () => '0xabc' as const);
const readContract = vi.fn(async () => '0x0000000000000000000000000000000000000000');
const waitForTransactionReceipt = vi.fn(async () => ({ status: 'success', blockNumber: 100n }));

vi.mock('../src/lib/chain.js', () => ({
  sendAttesterTx,
  awaitFinalized: vi.fn(async () => undefined),
  publicClient: () => ({ readContract, waitForTransactionReceipt }),
  deployment: () => ({
    chainId: 10143, startBlock: 0,
    identity: '0x1111111111111111111111111111111111111111',
    organizers: '0x2222222222222222222222222222222222222222',
    ticket: '0x3333333333333333333333333333333333333333',
    paymaster: '0x4444444444444444444444444444444444444444',
    factory: '0x5555555555555555555555555555555555555555',
    attester: '0x6666666666666666666666666666666666666666',
  }),
  monadChain: () => ({ id: 10143 }),
  gasLimitFor: (n: bigint) => n,
}));

const { db, PERSONS } = await import('../src/lib/db.js');
const { registerIdentity } = await import('../src/functions/registerIdentity.js');
const functionsTest = (await import('firebase-functions-test')).default();
const wrapped = functionsTest.wrap(registerIdentity);

const PERSON_ID = `0x${'aa'.repeat(32)}`;
const X = `0x${'11'.repeat(32)}`;
const Y = `0x${'22'.repeat(32)}`;
const auth = { uid: 'uid-1', token: {} };

beforeEach(async () => {
  sendAttesterTx.mockClear();
  const snap = await db.collection(PERSONS).get();
  await Promise.all(snap.docs.map((d) => d.ref.delete()));
  await db.collection(PERSONS).doc(PERSON_ID).set({
    status: 'pending',
    kycLevel: 0,
    account: '0x9999999999999999999999999999999999999999',
  });
});

describe('registerIdentity', () => {
  it('sends Identity.register with kycLevel 0 once and marks the person active after finality', async () => {
    const result = (await wrapped({ data: { personId: PERSON_ID, deviceX: X, deviceY: Y }, auth } as never)) as {
      txHash: string;
    };
    expect(result.txHash).toBe('0xabc');
    expect(sendAttesterTx).toHaveBeenCalledTimes(1);
    expect(sendAttesterTx.mock.calls[0]![0]).toMatchObject({ functionName: 'register' });
    expect(sendAttesterTx.mock.calls[0]![0].args).toEqual([PERSON_ID, '0x9999999999999999999999999999999999999999', X, Y, 0]);

    const person = await db.collection(PERSONS).doc(PERSON_ID).get();
    expect(person.get('status')).toBe('active');
    expect(person.get('chain.registerTx')).toBe('0xabc');
    expect(person.get('chain.block')).toBe(100);
  });

  it('is idempotent for the same personId', async () => {
    const first = (await wrapped({ data: { personId: PERSON_ID, deviceX: X, deviceY: Y }, auth } as never)) as {
      txHash: string;
    };
    const second = (await wrapped({ data: { personId: PERSON_ID, deviceX: X, deviceY: Y }, auth } as never)) as {
      txHash: string;
    };
    expect(second.txHash).toBe(first.txHash);
    expect(sendAttesterTx).toHaveBeenCalledTimes(1);
  });

  it('refuses a person whose account was rotated away', async () => {
    await db.collection(PERSONS).doc(PERSON_ID).set({ status: 'rotated' }, { merge: true });
    await expect(
      wrapped({ data: { personId: PERSON_ID, deviceX: X, deviceY: Y }, auth } as never),
    ).rejects.toThrow('BAD_SIGNUP_STATE');
    expect(sendAttesterTx).not.toHaveBeenCalled();
  });
});
```

Run: `firebase emulators:exec --only firestore,auth "pnpm --filter monti-functions exec vitest run test/registerIdentity.test.ts -t 'is idempotent for the same personId'"`
Expected: FAIL — `Failed to resolve import "../src/functions/registerIdentity.js"`

- [ ] **Step 2: `registerIdentity.ts`를 쓴다**

```ts
import { FieldValue } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { identityAbi, type Hex } from '@monti/shared';
import { ATTESTER_PK } from '../config.js';
import { awaitFinalized, deployment, publicClient, sendAttesterTx } from '../lib/chain.js';
import { PERSONS, assertStatusTransition, db } from '../lib/db.js';

const ZERO = '0x0000000000000000000000000000000000000000';

export const registerIdentity = onCall(
  { secrets: [ATTESTER_PK] },
  async (request): Promise<{ txHash: Hex }> => {
    if (!request.auth?.uid) throw new HttpsError('unauthenticated', 'AUTH_REQUIRED');
    const { personId, deviceX, deviceY } = (request.data ?? {}) as {
      personId?: Hex;
      deviceX?: Hex;
      deviceY?: Hex;
    };
    for (const [value, label] of [[personId, 'BAD_PERSON_ID'], [deviceX, 'BAD_DEVICE_X'], [deviceY, 'BAD_DEVICE_Y']] as const) {
      if (!value || !/^0x[0-9a-fA-F]{64}$/.test(value)) throw new HttpsError('invalid-argument', label);
    }

    const personRef = db.collection(PERSONS).doc(personId as Hex);
    const person = await personRef.get();
    if (!person.exists) throw new HttpsError('not-found', 'PERSON_NOT_FOUND');
    const status = person.get('status') as string;
    if (status !== 'pending' && status !== 'active') throw new HttpsError('failed-precondition', 'BAD_SIGNUP_STATE');
    const account = person.get('account') as Hex | undefined;
    if (!account) throw new HttpsError('failed-precondition', 'PASSKEY_REQUIRED');

    // 멱등 1: 이미 보낸 트랜잭션이 있으면 그대로 돌려준다.
    const existingTx = person.get('chain.registerTx') as Hex | undefined;
    if (existingTx) return { txHash: existingTx };

    // 멱등 2: 체인이 이미 알고 있으면 DB만 맞춘다.
    const contracts = deployment();
    const onChain = await publicClient().readContract({
      address: contracts.identity,
      abi: identityAbi,
      functionName: 'accountOf',
      args: [personId as Hex],
    });
    if (onChain !== ZERO) {
      await personRef.set({ status: 'active', updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      throw new HttpsError('already-exists', 'ALREADY_REGISTERED_ON_CHAIN');
    }

    // 동시 호출 잠금. Firestore 트랜잭션이 직렬화를 보장한다.
    await db.runTransaction(async (tx) => {
      const current = await tx.get(personRef);
      if (current.get('chain.registerTx')) throw new HttpsError('aborted', 'ALREADY_SENT');
      if (current.get('chain.registerPending')) throw new HttpsError('aborted', 'REGISTER_IN_FLIGHT');
      tx.set(personRef, { chain: { registerPending: true }, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    });

    let txHash: Hex;
    try {
      txHash = await sendAttesterTx({
        address: contracts.identity,
        abi: identityAbi,
        functionName: 'register',
        // 다섯 번째 인자는 KYC 레벨. 가입 시점은 언제나 0이고, 본인인증은 startKyc 가 1로 올린다.
        args: [personId as Hex, account, deviceX as Hex, deviceY as Hex, 0],
      });
    } catch (error) {
      await personRef.set({ chain: { registerPending: FieldValue.delete() } }, { merge: true });
      throw new HttpsError('internal', `REGISTER_SEND_FAILED:${(error as Error).message}`);
    }

    await personRef.set(
      { chain: { registerTx: txHash, registerPending: FieldValue.delete() }, updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );

    const receipt = await publicClient().waitForTransactionReceipt({ hash: txHash, timeout: 30_000 });
    if (receipt.status !== 'success') throw new HttpsError('internal', 'REGISTER_REVERTED');

    // 스펙 §10.4 규칙 3: finalized 뒤에만 완료 처리한다.
    await awaitFinalized(receipt.blockNumber);
    assertStatusTransition(status as 'pending' | 'active', 'active');
    await personRef.set(
      {
        status: 'active',
        chain: { registerTx: txHash, block: Number(receipt.blockNumber) },
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    return { txHash };
  },
);
```

`functions/src/index.ts`에 추가: `export { registerIdentity } from './functions/registerIdentity.js';`

- [ ] **Step 3: 멱등성 테스트를 통과시킨다**

Run: `firebase emulators:exec --only firestore,auth "pnpm --filter monti-functions exec vitest run test/registerIdentity.test.ts -t 'is idempotent for the same personId'"`
Expected: PASS — `Tests  1 passed | 2 skipped (3)`

- [ ] **Step 4: 전체 파일을 돌린다**

Run: `firebase emulators:exec --only firestore,auth "pnpm --filter monti-functions exec vitest run test/registerIdentity.test.ts"`
Expected: PASS — `Tests  3 passed (3)`

- [ ] **Step 5: 가스 한도가 실제로 붙는지 확인한다**

Run:
```bash
grep -n "gas: gasLimitFor" functions/src/lib/chain.ts
```
Expected: `sendAttesterTx` 안의 `gas: gasLimitFor(estimate),` 한 줄. 없으면 Monad에서 한도 미지정으로 과다 과금된다.

- [ ] **Step 6: 커밋**

```bash
git add functions/src/functions/registerIdentity.ts functions/src/index.ts functions/test/registerIdentity.test.ts
git commit -m "feat(functions): register identity on chain idempotently and wait for finality"
```

---

## Task 20: `loginChallenge` / `loginVerify`

**Files:**
- Create: `functions/src/functions/login.ts`
- Test: `functions/test/login.test.ts`

**Interfaces:**
- Consumes: Task 18 `challengeFromClientData`; Task 15 `AUTH_CHALLENGES`, `PASSKEYS`, `PERSONS`, `USERS`, `authAdmin`.
- Produces:
  - callable `loginChallenge`: `{ purpose?: 'login' | 'register' }` → `{ challenge: string; expiresAt: number }` (챌린지는 base64url 32바이트).
  - callable `loginVerify`: `{ assertion }` → `{ token: string; personId: Hex; account: Hex }`. 카운터가 줄거나 같으면 거부하고, Firebase 커스텀 토큰에 `personId`·`account` 클레임을 넣는다. **로그인은 패스키 전용**(스펙 §5.1).

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`functions/test/login.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const verifyAuthenticationResponse = vi.fn(async () => ({
  verified: true,
  authenticationInfo: { newCounter: 5 },
}));
vi.mock('@simplewebauthn/server', () => ({ verifyAuthenticationResponse }));

const { db, AUTH_CHALLENGES, PASSKEYS, PERSONS, USERS } = await import('../src/lib/db.js');
const { loginChallenge, loginVerify } = await import('../src/functions/login.js');
const functionsTest = (await import('firebase-functions-test')).default();
const challengeFn = functionsTest.wrap(loginChallenge);
const verifyFn = functionsTest.wrap(loginVerify);

const PERSON_ID = `0x${'aa'.repeat(32)}`;
const ACCOUNT = '0x9999999999999999999999999999999999999999';

function assertion(challenge: string) {
  return {
    id: 'cred-1',
    rawId: 'cred-1',
    type: 'public-key',
    clientExtensionResults: {},
    response: {
      clientDataJSON: Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge }), 'utf8').toString('base64url'),
      authenticatorData: 'AA',
      signature: 'BB',
    },
  };
}

beforeEach(async () => {
  verifyAuthenticationResponse.mockClear();
  for (const collection of [AUTH_CHALLENGES, PASSKEYS, PERSONS, USERS]) {
    const snap = await db.collection(collection).get();
    await Promise.all(snap.docs.map((d) => d.ref.delete()));
  }
  await db.collection(PASSKEYS).doc('cred-1').set({
    personId: PERSON_ID, publicKeyCose: Buffer.alloc(32).toString('base64'), counter: 3, transports: ['internal'],
  });
  await db.collection(PERSONS).doc(PERSON_ID).set({ status: 'active', account: ACCOUNT });
  await db.collection(USERS).doc('uid-1').set({ personId: PERSON_ID, phoneE164: '+821011112222' });
});

describe('loginChallenge', () => {
  it('issues a fresh base64url challenge without requiring auth', async () => {
    const a = (await challengeFn({ data: {} } as never)) as { challenge: string; expiresAt: number };
    const b = (await challengeFn({ data: { purpose: 'register' } } as never)) as { challenge: string };
    expect(a.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(b.challenge).not.toBe(a.challenge);
    expect((await db.collection(AUTH_CHALLENGES).doc(a.challenge).get()).get('purpose')).toBe('login');
  });
});

describe('loginVerify', () => {
  it('returns a custom token and bumps the stored counter', async () => {
    const { challenge } = (await challengeFn({ data: {} } as never)) as { challenge: string };
    const result = (await verifyFn({ data: { assertion: assertion(challenge) } } as never)) as {
      token: string; personId: string; account: string;
    };
    expect(result.personId).toBe(PERSON_ID);
    expect(result.account).toBe(ACCOUNT);
    expect(typeof result.token).toBe('string');
    expect((await db.collection(PASSKEYS).doc('cred-1').get()).get('counter')).toBe(5);
  });

  it('rejects a replayed counter', async () => {
    verifyAuthenticationResponse.mockResolvedValueOnce({ verified: true, authenticationInfo: { newCounter: 3 } });
    const { challenge } = (await challengeFn({ data: {} } as never)) as { challenge: string };
    await expect(verifyFn({ data: { assertion: assertion(challenge) } } as never)).rejects.toThrow('COUNTER_REPLAY');
  });

  it('rejects an unknown or already used challenge', async () => {
    await expect(verifyFn({ data: { assertion: assertion('unknown-challenge') } } as never)).rejects.toThrow(
      'CHALLENGE_NOT_FOUND',
    );
  });
});
```

Run: `firebase emulators:exec --only firestore,auth "pnpm --filter monti-functions exec vitest run test/login.test.ts"`
Expected: FAIL — `Failed to resolve import "../src/functions/login.js"`

- [ ] **Step 2: `login.ts`를 쓴다**

```ts
import { randomBytes } from 'node:crypto';
import { verifyAuthenticationResponse } from '@simplewebauthn/server';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import { FieldValue } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { AUTH_CHALLENGE_TTL_SECONDS, type Hex } from '@monti/shared';
import { RP_ID, expectedOrigins } from '../config.js';
import { AUTH_CHALLENGES, PASSKEYS, PERSONS, USERS, authAdmin, db } from '../lib/db.js';
import { challengeFromClientData } from '../lib/webauthn.js';

export const loginChallenge = onCall(async (request): Promise<{ challenge: string; expiresAt: number }> => {
  const purpose = ((request.data ?? {}) as { purpose?: string }).purpose === 'register' ? 'register' : 'login';
  const challenge = randomBytes(32).toString('base64url');
  const expiresAt = Math.floor(Date.now() / 1000) + AUTH_CHALLENGE_TTL_SECONDS;
  await db.collection(AUTH_CHALLENGES).doc(challenge).set({
    purpose,
    expiresAt,
    createdAt: FieldValue.serverTimestamp(),
  });
  return { challenge, expiresAt };
});

export const loginVerify = onCall(
  async (request): Promise<{ token: string; personId: Hex; account: Hex }> => {
    const { assertion } = (request.data ?? {}) as { assertion?: AuthenticationResponseJSON };
    if (!assertion?.response?.clientDataJSON) throw new HttpsError('invalid-argument', 'BAD_ASSERTION');

    const challenge = challengeFromClientData(assertion.response.clientDataJSON);
    const challengeRef = db.collection(AUTH_CHALLENGES).doc(challenge);
    await db.runTransaction(async (tx) => {
      const doc = await tx.get(challengeRef);
      if (!doc.exists) throw new HttpsError('failed-precondition', 'CHALLENGE_NOT_FOUND');
      if (doc.get('usedAt')) throw new HttpsError('failed-precondition', 'CHALLENGE_USED');
      if ((doc.get('expiresAt') as number) < Math.floor(Date.now() / 1000)) {
        throw new HttpsError('failed-precondition', 'CHALLENGE_EXPIRED');
      }
      tx.update(challengeRef, { usedAt: FieldValue.serverTimestamp() });
    });

    const credentialRef = db.collection(PASSKEYS).doc(assertion.id);
    const credential = await credentialRef.get();
    if (!credential.exists) throw new HttpsError('not-found', 'CREDENTIAL_NOT_FOUND');
    const storedCounter = (credential.get('counter') as number) ?? 0;

    const verification = await verifyAuthenticationResponse({
      response: assertion,
      expectedChallenge: challenge,
      expectedOrigin: expectedOrigins(),
      expectedRPID: RP_ID.value(),
      requireUserVerification: true,
      credential: {
        id: assertion.id,
        publicKey: Buffer.from(credential.get('publicKeyCose') as string, 'base64'),
        counter: storedCounter,
        transports: credential.get('transports') as AuthenticationResponseJSON['response']['transports'],
      },
    });
    if (!verification.verified) throw new HttpsError('permission-denied', 'ASSERTION_REJECTED');

    const newCounter = verification.authenticationInfo.newCounter;
    // 인증기가 카운터를 쓰지 않으면 항상 0이다. 0이 아닌데 늘지 않았으면 복제 신호다.
    if (newCounter !== 0 && newCounter <= storedCounter) throw new HttpsError('permission-denied', 'COUNTER_REPLAY');

    const personId = credential.get('personId') as Hex;
    const person = await db.collection(PERSONS).doc(personId).get();
    const account = person.get('account') as Hex | undefined;
    if (!account) throw new HttpsError('failed-precondition', 'NO_ACCOUNT');

    const users = await db.collection(USERS).where('personId', '==', personId).limit(1).get();
    const uid = users.docs[0]?.id;
    if (!uid) throw new HttpsError('not-found', 'USER_NOT_FOUND');

    await credentialRef.update({ counter: newCounter, lastUsedAt: FieldValue.serverTimestamp() });
    const token = await authAdmin.createCustomToken(uid, { personId, account });
    return { token, personId, account };
  },
);
```

`functions/src/index.ts`에 추가: `export { loginChallenge, loginVerify } from './functions/login.js';`

- [ ] **Step 3: 테스트를 통과시킨다**

Run: `firebase emulators:exec --only firestore,auth "pnpm --filter monti-functions exec vitest run test/login.test.ts"`
Expected: PASS — `Tests  4 passed (4)`

- [ ] **Step 4: `signalAllAcceptedCredentials`를 어디에서도 부르지 않는지 확인한다**

Run: `grep -rn "signalAllAcceptedCredentials" functions/src apps/web/src 2>/dev/null; echo "exit=$?"`
Expected: 출력 없음, `exit=1`. (iOS 26 버그, 마스터 계획 Global Constraints)

- [ ] **Step 5: 커밋**

```bash
git add functions/src/functions/login.ts functions/src/index.ts functions/test/login.test.ts
git commit -m "feat(functions): add passkey-only login challenge and verification"
```

---

## Task 21: `lockDevice`와 `startDeviceChange`

**Files:**
- Create: `functions/src/functions/device.ts`
- Test: `functions/test/device.test.ts`

**Interfaces:**
- Consumes: Task 15 `resolveCallerAccount`; Task 14 `sendAttesterTx`, `publicClient`; Task 2 `DEVICE_COOLDOWN_SECONDS`.
- Produces:
  - callable `lockDevice`: `{}` → `{ txHash: Hex }`. 어테스터가 `Identity.lockDevice(account)`를 보낸다. **Firestore에 아무것도 쓰지 않는다**(잠금 상태는 체인이 원본).
  - callable `startDeviceChange`: `{ method: 'sms' | 'kyc' }` → `{ allowedAt: number; now: number; cooldownSeconds: number; kycUrl?: string }`. 쿨타임은 `Identity.deviceUpdatedAt(account)`에서 읽는다(스펙 §9.3).

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`functions/test/device.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sendAttesterTx = vi.fn(async () => '0xlock' as const);
const readContract = vi.fn(async () => 1_789_862_400n);
vi.mock('../src/lib/chain.js', () => ({
  sendAttesterTx,
  publicClient: () => ({ readContract }),
  deployment: () => ({ identity: '0x1111111111111111111111111111111111111111' }),
}));
vi.mock('../src/lib/didit.js', () => ({
  createDiditSession: vi.fn(async () => ({ sessionId: 's2', url: 'https://verify.didit.me/s/s2' })),
}));

const { lockDevice, startDeviceChange } = await import('../src/functions/device.js');
const functionsTest = (await import('firebase-functions-test')).default();
const lock = functionsTest.wrap(lockDevice);
const change = functionsTest.wrap(startDeviceChange);

const ACCOUNT = '0x9999999999999999999999999999999999999999';
const auth = { uid: 'uid-1', token: { account: ACCOUNT, phone_number: '+821011112222', firebase: { sign_in_provider: 'phone' } } };

beforeEach(() => {
  sendAttesterTx.mockClear();
  readContract.mockClear();
});

describe('lockDevice', () => {
  it('sends Identity.lockDevice for the caller account', async () => {
    const result = (await lock({ data: {}, auth } as never)) as { txHash: string };
    expect(result.txHash).toBe('0xlock');
    expect(sendAttesterTx.mock.calls[0]![0]).toMatchObject({ functionName: 'lockDevice', args: [ACCOUNT] });
  });

  it('refuses an unauthenticated caller', async () => {
    await expect(lock({ data: {} } as never)).rejects.toThrow('AUTH_REQUIRED');
  });
});

describe('startDeviceChange', () => {
  it('returns allowedAt = deviceUpdatedAt + 7 days read from chain', async () => {
    const result = (await change({ data: { method: 'sms' }, auth } as never)) as {
      allowedAt: number; cooldownSeconds: number;
    };
    expect(result.cooldownSeconds).toBe(604_800);
    expect(result.allowedAt).toBe(1_789_862_400 + 604_800);
    expect(readContract.mock.calls[0]![0]).toMatchObject({ functionName: 'deviceUpdatedAt' });
  });

  it('opens a new Didit session for the kyc method', async () => {
    const result = (await change({ data: { method: 'kyc' }, auth } as never)) as { kycUrl?: string };
    expect(result.kycUrl).toBe('https://verify.didit.me/s/s2');
  });

  it('rejects an unknown method', async () => {
    await expect(change({ data: { method: 'email' }, auth } as never)).rejects.toThrow('BAD_METHOD');
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `firebase emulators:exec --only firestore,auth "pnpm --filter monti-functions exec vitest run test/device.test.ts"`
Expected: FAIL — `Failed to resolve import "../src/functions/device.js"`

- [ ] **Step 3: `device.ts`를 쓴다**

```ts
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { DEVICE_COOLDOWN_SECONDS, identityAbi, type Hex } from '@monti/shared';
import { ATTESTER_PK, DIDIT_API_KEY, DIDIT_WORKFLOW_ID, RP_ID } from '../config.js';
import { deployment, publicClient, sendAttesterTx } from '../lib/chain.js';
import { resolveCallerAccount } from '../lib/auth.js';
import { PERSONS, USERS, db } from '../lib/db.js';
import { createDiditSession } from '../lib/didit.js';

/** 잠금은 체인 상태다. Firestore에는 쓰지 않는다(스펙 §10.4 규칙 1). */
export const lockDevice = onCall({ secrets: [ATTESTER_PK] }, async (request): Promise<{ txHash: Hex }> => {
  const account = await resolveCallerAccount(request);
  const txHash = await sendAttesterTx({
    address: deployment().identity,
    abi: identityAbi,
    functionName: 'lockDevice',
    args: [account],
  });
  return { txHash };
});

export const startDeviceChange = onCall(
  { secrets: [DIDIT_API_KEY, DIDIT_WORKFLOW_ID] },
  async (request): Promise<{ allowedAt: number; now: number; cooldownSeconds: number; kycUrl?: string }> => {
    const { method } = (request.data ?? {}) as { method?: string };
    if (method !== 'sms' && method !== 'kyc') throw new HttpsError('invalid-argument', 'BAD_METHOD');

    const account = await resolveCallerAccount(request);
    const uid = request.auth!.uid;

    if (method === 'sms') {
      const provider = (request.auth?.token as { firebase?: { sign_in_provider?: string } })?.firebase?.sign_in_provider;
      if (provider !== 'phone') throw new HttpsError('failed-precondition', 'PHONE_REAUTH_REQUIRED');
      const stored = (await db.collection(USERS).doc(uid).get()).get('phoneE164') as string | undefined;
      const claimed = request.auth?.token?.phone_number as string | undefined;
      if (!stored || !claimed || stored !== claimed) throw new HttpsError('permission-denied', 'PHONE_MISMATCH');
    }

    const updatedAt = await publicClient().readContract({
      address: deployment().identity,
      abi: identityAbi,
      functionName: 'deviceUpdatedAt',
      args: [account],
    });

    const now = Math.floor(Date.now() / 1000);
    const allowedAt = Number(updatedAt) + DEVICE_COOLDOWN_SECONDS;

    if (method === 'kyc') {
      const personId = (await db.collection(USERS).doc(uid).get()).get('personId') as Hex | undefined;
      if (!personId) throw new HttpsError('failed-precondition', 'NO_PERSON');
      const session = await createDiditSession(
        personId,
        DIDIT_API_KEY.value(),
        DIDIT_WORKFLOW_ID.value(),
        `https://${RP_ID.value()}/kyc/callback`,
      );
      await db.collection(PERSONS).doc(personId).set(
        { kyc: { provider: 'didit', sessionId: session.sessionId } },
        { merge: true },
      );
      return { allowedAt, now, cooldownSeconds: DEVICE_COOLDOWN_SECONDS, kycUrl: session.url };
    }

    return { allowedAt, now, cooldownSeconds: DEVICE_COOLDOWN_SECONDS };
  },
);
```

`functions/src/index.ts`에 추가: `export { lockDevice, startDeviceChange } from './functions/device.js';`

- [ ] **Step 4: 테스트를 통과시킨다**

Run: `firebase emulators:exec --only firestore,auth "pnpm --filter monti-functions exec vitest run test/device.test.ts"`
Expected: PASS — `Tests  5 passed (5)`

- [ ] **Step 5: 커밋**

```bash
git add functions/src/functions/device.ts functions/src/index.ts functions/test/device.test.ts
git commit -m "feat(functions): add device lock and 7-day device change cooldown read from chain"
```

---

## Task 22: `issueSnapshot`과 `getPhotoForGate`

**Files:**
- Create: `functions/src/lib/envio.ts`, `functions/src/functions/snapshot.ts`
- Test: `functions/test/snapshot.test.ts`

**Interfaces:**
- Consumes: Task 8 `snapshotDigest`, `canonicalJson`, `UnsignedSnapshot`; Task 12 `decryptField`; Task 13 `getAttesterAccount`; Task 15 `requireStaffForGate`, `resolveCallerAccount`.
- Produces:
  - `envioQuery<T>(query: string, variables?: Record<string, unknown>): Promise<T>` — Envio GraphQL 1회 호출.
  - `envioPage<T>(entity: string, fields: string, pageSize?: number): Promise<T[]>` — id 커서 페이지네이션.
  - `eventTitleOf(imageCid: string): Promise<string>` — IPFS 메타데이터 JSON에서 평문 제목을 읽고 **프로세스 메모리에 캐시**한다(CID는 불변이라 무효화가 필요 없다).
  - callable `issueSnapshot`: `{ eventId: string; gateAccount: Hex }` → `SnapshotWire` (사진 복호화 + 어테스터 서명). 최상위에 `eventTitle`·`requireKyc`, 각 티켓에 `tierName`·`seat` 를 싣는다.
  - callable `getPhotoForGate`: `{ tokenId: string; gateAccount: Hex }` → `{ photoJpegB64: string; displayName: string }`.

**누가 호출하는가:** **스태프 본인의 Firebase 세션**이다. 게이트 단말기 계정은 Firebase에 로그인하지 않는다(그 소유자 키는 패스키가 아니라 안드로이드 하드웨어 P-256 키다). 스태프가 단말기에서 자기 패스키로 로그인하고, 어느 게이트용인지를 `gateAccount`로 넘긴다. 인가는 Task 15의 `requireStaffForGate(eventId, callerAccount, gateAccount)`가 (a) 스태프 자격과 (b) 게이트 소속을 **둘 다** 체인에서 확인한다.

**`displayName` 규칙(sub-plan 04와 합의):** `displayName`은 **닉네임**(`Identity.nicknameOf(account)`)이고, 닉네임이 없으면 **빈 문자열**이다. **실명은 어떤 응답에도 넣지 않는다.** 스태프는 사진으로 대조하고 이름은 보조 표시일 뿐이다(스펙 §13 ADMIT 화면). 암호화된 실명 `persons.enc.name`은 복호화조차 하지 않는다.

**`requireKyc` 규칙(창업자 델타):** 본인인증은 이제 **공연별**이다. `eventMeta.requireKyc === false` 인 공연은 얼굴 사진이 아예 없으므로 `tickets[].photoJpegB64` 를 **빈 문자열**로 내보내고 `displayName`(닉네임)만 싣는다. **스태프 화면은 사진 자리에 아바타 플레이스홀더를 그리고 닉네임으로 대조한다**(sub-plan 04 ADMIT 화면). `requireKyc === true` 인 공연에서만 KMS 복호화가 일어나므로 복호화 횟수도 그만큼 줄어든다.

- [ ] **Step 1: Envio 클라이언트를 쓴다**

`functions/src/lib/envio.ts`:

```ts
import { ENVIO_GRAPHQL_URL } from '../config.js';

export async function envioQuery<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const response = await fetch(ENVIO_GRAPHQL_URL.value(), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok) throw new Error(`ENVIO_HTTP_${response.status}`);
  const body = (await response.json()) as { data?: T; errors?: Array<{ message: string }> };
  if (body.errors?.length) throw new Error(`ENVIO_GRAPHQL:${body.errors[0]!.message}`);
  if (!body.data) throw new Error('ENVIO_EMPTY');
  return body.data;
}

/** Hasura 커서 페이지네이션. id 오름차순으로 끝까지 읽는다. */
export async function envioPage<T extends { id: string }>(
  entity: string,
  fields: string,
  pageSize = 500,
): Promise<T[]> {
  const out: T[] = [];
  let cursor = '';
  for (;;) {
    const query = `query Page($cursor: String!, $limit: Int!) {
      rows: ${entity}(where: {id: {_gt: $cursor}}, order_by: {id: asc}, limit: $limit) { ${fields} }
    }`;
    const data = await envioQuery<{ rows: T[] }>(query, { cursor, limit: pageSize });
    out.push(...data.rows);
    if (data.rows.length < pageSize) return out;
    cursor = data.rows[data.rows.length - 1]!.id;
  }
}
```

- [ ] **Step 2: 실패하는 테스트를 쓴다**

`functions/test/snapshot.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { recoverAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { snapshotDigest, type UnsignedSnapshot } from '@monti/shared';

const PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const;
const attester = privateKeyToAccount(PK);
const OWNER = '0x9999999999999999999999999999999999999999';

const chainState = { requireKyc: true };
vi.mock('../src/lib/chain.js', () => ({
  publicClient: () => ({
    readContract: vi.fn(async ({ functionName }: { functionName: string }) =>
      functionName === 'activeDevice' ? [`0x${'11'.repeat(32)}`, `0x${'22'.repeat(32)}`]
      : functionName === 'personOf' ? `0x${'aa'.repeat(32)}`
      : functionName === 'ownerOf' ? OWNER
      : functionName === 'nicknameOf' ? 'alex'
      : functionName === 'eventOf' ? 11n
      : functionName === 'eventMeta'
        ? { orgId: 1n, endsAt: 4102444800n, requireKyc: chainState.requireKyc, imageCid: 'bafyDemo' }
      : functionName === 'tiers' ? [{ name: '일반', seated: false }, { name: 'VIP', seated: true }]
      : 0n,
    ),
  }),
  deployment: () => ({
    identity: '0x1111111111111111111111111111111111111111',
    organizers: '0x2222222222222222222222222222222222222222',
    ticket: '0x3333333333333333333333333333333333333333',
  }),
}));
const requireStaffForGate = vi.fn(async () => undefined);
vi.mock('../src/lib/auth.js', () => ({
  resolveCallerAccount: vi.fn(async () => OWNER),
  requireStaffForGate,
}));
vi.mock('../src/lib/kms.js', () => ({ decryptField: vi.fn(async (v: string) => `plain:${v}`) }));
vi.mock('../src/lib/attester.js', () => ({ getAttesterAccount: () => attester }));
vi.mock('../src/lib/envio.js', () => ({
  envioQuery: vi.fn(async () => ({
    rows: [{ id: '7', eventId: '11', tier: 0, owner: OWNER, revoked: false, checkIn: null }],
  })),
  envioPage: vi.fn(async () => []),
}));

const { db, PERSONS } = await import('../src/lib/db.js');
const { issueSnapshot, getPhotoForGate } = await import('../src/functions/snapshot.js');
const functionsTest = (await import('firebase-functions-test')).default();
const issue = functionsTest.wrap(issueSnapshot);
const photo = functionsTest.wrap(getPhotoForGate);
const auth = { uid: 'uid-1', token: { account: OWNER } };
const GATE = '0x1234123412341234123412341234123412341234';

// IPFS 메타데이터는 네트워크를 타지 않게 가짜로 돌려준다.
vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ name: '몬티 데모 공연' }), { status: 200 })));

beforeEach(async () => {
  requireStaffForGate.mockClear();
  chainState.requireKyc = true;
  await db.collection(PERSONS).doc(`0x${'aa'.repeat(32)}`).set({
    status: 'active', account: OWNER,
    enc: { name: 'ENCNAME', docNumber: 'ENCDOC' },
    photoEnc: 'ENCPHOTO',
  });
});

describe('issueSnapshot', () => {
  it('builds a signed snapshot whose signature recovers to the attester', async () => {
    const snapshot = (await issue({ data: { eventId: '11', gateAccount: GATE }, auth } as never)) as UnsignedSnapshot & { attesterSig: `0x${string}` };
    expect(requireStaffForGate).toHaveBeenCalledWith(11n, OWNER, GATE);
    expect(snapshot.v).toBe(1);
    expect(snapshot.eventId).toBe('11');
    expect(snapshot.eventTitle).toBe('몬티 데모 공연');
    expect(snapshot.requireKyc).toBe(true);
    expect(snapshot.tickets).toHaveLength(1);
    expect(snapshot.tickets[0]).toMatchObject({
      tokenId: '7', photoJpegB64: 'plain:ENCPHOTO', displayName: 'alex', tierName: '일반', seat: '',
    });
    expect(JSON.stringify(snapshot)).not.toContain('ENCNAME');
    expect(snapshot.expiresAt).toBeGreaterThan(snapshot.epoch);

    const { attesterSig, ...unsigned } = snapshot;
    expect(await recoverAddress({ hash: snapshotDigest(unsigned), signature: attesterSig })).toBe(attester.address);
  });
});

describe('getPhotoForGate', () => {
  it('returns the decrypted photo and display name for one ticket', async () => {
    const result = (await photo({ data: { tokenId: '7', gateAccount: GATE }, auth } as never)) as {
      photoJpegB64: string; displayName: string;
    };
    expect(result).toEqual({ photoJpegB64: 'plain:ENCPHOTO', displayName: 'alex' });
    expect(requireStaffForGate).toHaveBeenCalledWith(11n, OWNER, GATE);
  });

  it('returns an empty photo for a requireKyc=false event so staff draw a placeholder', async () => {
    chainState.requireKyc = false;
    const result = (await photo({ data: { tokenId: '7', gateAccount: GATE }, auth } as never)) as {
      photoJpegB64: string; displayName: string;
    };
    expect(result).toEqual({ photoJpegB64: '', displayName: 'alex' });
  });

  it('refuses a call without a gateAccount', async () => {
    await expect(photo({ data: { tokenId: '7' }, auth } as never)).rejects.toThrow('BAD_GATE_ACCOUNT');
  });
});
```

Run: `firebase emulators:exec --only firestore,auth "pnpm --filter monti-functions exec vitest run test/snapshot.test.ts"`
Expected: FAIL — `Failed to resolve import "../src/functions/snapshot.js"`

- [ ] **Step 3: `snapshot.ts`를 쓴다**

```ts
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import {
  SNAPSHOT_TTL_SECONDS,
  identityAbi,
  snapshotDigest,
  ticketAbi,
  type Hex,
  type SnapshotTicket,
  type SnapshotWire,
  type UnsignedSnapshot,
} from '@monti/shared';
import { ATTESTER_PK, IPFS_GATEWAY } from '../config.js';
import { getAttesterAccount } from '../lib/attester.js';
import { requireStaffForGate, resolveCallerAccount } from '../lib/auth.js';
import { deployment, publicClient } from '../lib/chain.js';
import { PERSONS, db } from '../lib/db.js';
import { envioQuery } from '../lib/envio.js';
import { decryptField } from '../lib/kms.js';

interface EnvioTicketRow {
  id: string;
  eventId: string;
  tier: number;
  owner: string;
  revoked: boolean;
  checkIn: { id: string } | null;
}

/** CID는 내용 지문이라 불변이다. 한 번 읽으면 프로세스가 살아 있는 동안 다시 읽지 않는다. */
const eventTitleCache = new Map<string, string>();

export async function eventTitleOf(imageCid: string): Promise<string> {
  if (!imageCid) return '';
  const cached = eventTitleCache.get(imageCid);
  if (cached !== undefined) return cached;

  let title = '';
  try {
    const response = await fetch(`${IPFS_GATEWAY.value()}/${imageCid}`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (response.ok) {
      const metadata = (await response.json()) as { name?: string; title?: string };
      title = metadata.name ?? metadata.title ?? '';
    }
  } catch {
    // 게이트웨이가 죽어도 스냅샷 발급은 막지 않는다. 제목은 빈 문자열로 간다.
    title = '';
  }
  eventTitleCache.set(imageCid, title);
  return title;
}

/**
 * 계정 주소 → 게이트 화면에 띄울 카드.
 * 사진만 KMS로 복호화한다. 이름은 **닉네임**이고 없으면 빈 문자열이며,
 * 암호화된 실명(persons.enc.name)은 복호화하지도 반환하지도 않는다.
 */
async function personCard(
  account: Hex,
  withPhoto: boolean,
): Promise<{ displayName: string; photoJpegB64: string }> {
  const contracts = deployment();
  const pc = publicClient();
  const nickname = await pc.readContract({
    address: contracts.identity, abi: identityAbi, functionName: 'nicknameOf', args: [account],
  });
  const displayName = (nickname as string) ?? '';

  // requireKyc 가 false 인 공연에는 사진이 없다. 스태프 화면이 아바타 플레이스홀더를 그린다.
  if (!withPhoto) return { displayName, photoJpegB64: '' };

  const personId = await pc.readContract({
    address: contracts.identity, abi: identityAbi, functionName: 'personOf', args: [account],
  });
  const person = await db.collection(PERSONS).doc(personId as string).get();
  if (!person.exists) throw new HttpsError('not-found', 'PERSON_NOT_FOUND');
  const photoEnc = person.get('photoEnc') as string | undefined;
  if (!photoEnc) return { displayName, photoJpegB64: '' };
  return { displayName, photoJpegB64: await decryptField(photoEnc) };
}

export const issueSnapshot = onCall({ secrets: [ATTESTER_PK], memory: '1GiB', timeoutSeconds: 120 },
  async (request): Promise<SnapshotWire> => {
    const { eventId, gateAccount } = (request.data ?? {}) as { eventId?: string; gateAccount?: Hex };
    if (!eventId || !/^[0-9]+$/.test(eventId)) throw new HttpsError('invalid-argument', 'BAD_EVENT_ID');
    if (!gateAccount || !/^0x[0-9a-fA-F]{40}$/.test(gateAccount)) {
      throw new HttpsError('invalid-argument', 'BAD_GATE_ACCOUNT');
    }

    // 호출자는 스태프 본인의 세션이다. 게이트 단말기 계정은 Firebase에 로그인하지 않는다.
    const caller = await resolveCallerAccount(request);
    await requireStaffForGate(BigInt(eventId), caller, gateAccount);

    const [meta, tiers] = await Promise.all([
      publicClient().readContract({
        address: deployment().ticket, abi: ticketAbi, functionName: 'eventMeta', args: [BigInt(eventId)],
      }),
      publicClient().readContract({
        address: deployment().ticket, abi: ticketAbi, functionName: 'tiers', args: [BigInt(eventId)],
      }),
    ]);
    const requireKyc = (meta as { requireKyc: boolean }).requireKyc;
    const tierRows = tiers as readonly { name: string; seated: boolean }[];
    const eventTitle = await eventTitleOf((meta as { imageCid: string }).imageCid);

    const data = await envioQuery<{ rows: EnvioTicketRow[] }>(
      `query Tickets($eventId: String!) {
        rows: Ticket(where: {eventId: {_eq: $eventId}, revoked: {_eq: false}}, order_by: {id: asc}) {
          id eventId tier owner revoked checkIn { id }
        }
      }`,
      { eventId },
    );

    const tickets: SnapshotTicket[] = [];
    for (const row of data.rows) {
      const owner = row.owner as Hex;
      const [device, card] = await Promise.all([
        publicClient().readContract({
          address: deployment().identity,
          abi: identityAbi,
          functionName: 'activeDevice',
          args: [owner],
        }),
        personCard(owner, requireKyc),
      ]);
      const tierRow = tierRows[row.tier];
      tickets.push({
        tokenId: row.id,
        account: owner,
        deviceX: device[0] as Hex,
        deviceY: device[1] as Hex,
        photoJpegB64: card.photoJpegB64,
        displayName: card.displayName,
        tier: row.tier,
        tierName: tierRow?.name ?? '',
        // 좌석 배정은 MVP 밖이다(스펙 §15 Could). 좌석 티어라도 지금은 빈 문자열이다.
        seat: '',
        checkedIn: row.checkIn !== null,
      });
    }

    const epoch = Math.floor(Date.now() / 1000);
    const unsigned: UnsignedSnapshot = {
      v: 1,
      eventId,
      eventTitle,
      requireKyc,
      epoch,
      expiresAt: epoch + SNAPSHOT_TTL_SECONDS,
      tickets,
    };
    const attesterSig = await getAttesterAccount().sign({ hash: snapshotDigest(unsigned) });
    return { ...unsigned, attesterSig };
  },
);

export const getPhotoForGate = onCall(
  async (request): Promise<{ photoJpegB64: string; displayName: string }> => {
    const { tokenId, gateAccount } = (request.data ?? {}) as { tokenId?: string; gateAccount?: Hex };
    if (!tokenId || !/^[0-9]+$/.test(tokenId)) throw new HttpsError('invalid-argument', 'BAD_TOKEN_ID');
    if (!gateAccount || !/^0x[0-9a-fA-F]{40}$/.test(gateAccount)) {
      throw new HttpsError('invalid-argument', 'BAD_GATE_ACCOUNT');
    }

    const contracts = deployment();
    const eventId = await publicClient().readContract({
      address: contracts.ticket,
      abi: ticketAbi,
      functionName: 'eventOf',
      args: [BigInt(tokenId)],
    });

    const caller = await resolveCallerAccount(request);
    await requireStaffForGate(eventId as bigint, caller, gateAccount);

    const [owner, meta] = await Promise.all([
      publicClient().readContract({
        address: contracts.ticket, abi: ticketAbi, functionName: 'ownerOf', args: [BigInt(tokenId)],
      }),
      publicClient().readContract({
        address: contracts.ticket, abi: ticketAbi, functionName: 'eventMeta', args: [eventId as bigint],
      }),
    ]);
    return personCard(owner as Hex, (meta as { requireKyc: boolean }).requireKyc);
  },
);
```

`functions/src/index.ts`에 추가: `export { issueSnapshot, getPhotoForGate } from './functions/snapshot.js';`

- [ ] **Step 4: 테스트를 통과시킨다**

Run: `firebase emulators:exec --only firestore,auth "pnpm --filter monti-functions exec vitest run test/snapshot.test.ts"`
Expected: PASS — `Tests  4 passed (4)`

- [ ] **Step 5: 커밋**

```bash
git add functions/src/lib/envio.ts functions/src/functions/snapshot.ts functions/src/index.ts functions/test/snapshot.test.ts
git commit -m "feat(functions): issue attester-signed gate snapshots and per-ticket photos"
```

---

## Task 23: `createInvite` / `acceptInvite`

**Files:**
- Create: `functions/src/functions/invites.ts`
- Test: `functions/test/invites.test.ts`

**Interfaces:**
- Consumes: Task 15 `resolveCallerAccount`, `INVITES`; Task 3 `organizersAbi`.
- Produces:
  - callable `createInvite`: `{ orgId, role: 'admin'|'manager', phoneE164, permissionBits?, canApprove? }` → `{ inviteId, link }`. 호출자가 오너이거나 `PERM_MANAGE_MANAGERS(8)`를 가져야 한다(eth_call로 확인).
  - callable `acceptInvite`: `{ inviteId }` → `{ to: Hex; data: Hex; orgId: string; role: string }` — 오너가 웹에서 서명해 보낼 **calldata**. 서버는 권한을 체인에 쓰지 않는다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`functions/test/invites.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeFunctionData } from 'viem';
import { organizersAbi } from '@monti/shared';

const hasPermission = vi.fn(async () => true);
vi.mock('../src/lib/chain.js', () => ({
  publicClient: () => ({
    readContract: vi.fn(async ({ functionName }: { functionName: string }) =>
      functionName === 'ownerOf' ? '0x9999999999999999999999999999999999999999' : hasPermission(),
    ),
  }),
  deployment: () => ({ organizers: '0x2222222222222222222222222222222222222222' }),
}));
vi.mock('../src/lib/auth.js', () => ({
  resolveCallerAccount: vi.fn(async () => '0x9999999999999999999999999999999999999999'),
}));

const { db, INVITES } = await import('../src/lib/db.js');
const { createInvite, acceptInvite } = await import('../src/functions/invites.js');
const functionsTest = (await import('firebase-functions-test')).default();
const create = functionsTest.wrap(createInvite);
const accept = functionsTest.wrap(acceptInvite);
const auth = { uid: 'uid-1', token: { account: '0x9999999999999999999999999999999999999999' } };

beforeEach(async () => {
  const snap = await db.collection(INVITES).get();
  await Promise.all(snap.docs.map((d) => d.ref.delete()));
});

describe('createInvite', () => {
  it('stores a sent invite and returns a link', async () => {
    const result = (await create({
      data: { orgId: '1', role: 'manager', phoneE164: '+821011112222', canApprove: true }, auth,
    } as never)) as { inviteId: string; link: string };

    const invite = await db.collection(INVITES).doc(result.inviteId).get();
    expect(invite.get('status')).toBe('sent');
    expect(invite.get('role')).toBe('manager');
    expect(invite.get('canApprove')).toBe(true);
    expect(result.link).toContain(result.inviteId);
  });

  it('rejects an unknown role', async () => {
    await expect(create({ data: { orgId: '1', role: 'owner', phoneE164: '+8210' }, auth } as never)).rejects.toThrow('BAD_ROLE');
  });
});

describe('acceptInvite', () => {
  it('returns setManager calldata and marks the invite accepted', async () => {
    const { inviteId } = (await create({
      data: { orgId: '1', role: 'manager', phoneE164: '+821011112222', canApprove: true }, auth,
    } as never)) as { inviteId: string };

    const result = (await accept({ data: { inviteId }, auth } as never)) as { to: string; data: `0x${string}` };
    const decoded = decodeFunctionData({ abi: organizersAbi, data: result.data });
    expect(decoded.functionName).toBe('setManager');
    expect(decoded.args).toEqual([1n, '0x9999999999999999999999999999999999999999', true, true]);
    expect((await db.collection(INVITES).doc(inviteId).get()).get('status')).toBe('accepted');
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `firebase emulators:exec --only firestore,auth "pnpm --filter monti-functions exec vitest run test/invites.test.ts"`
Expected: FAIL — `Failed to resolve import "../src/functions/invites.js"`

- [ ] **Step 3: `invites.ts`를 쓴다**

```ts
import { randomUUID } from 'node:crypto';
import { FieldValue } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { encodeFunctionData, organizersAbi, type Hex } from '@monti/shared';
import { RP_ID } from '../config.js';
import { resolveCallerAccount } from '../lib/auth.js';
import { deployment, publicClient } from '../lib/chain.js';
import { INVITES, db } from '../lib/db.js';

const PERM_MANAGE_MANAGERS = 8;

export const createInvite = onCall(async (request): Promise<{ inviteId: string; link: string }> => {
  const { orgId, role, phoneE164, permissionBits, canApprove } = (request.data ?? {}) as {
    orgId?: string; role?: string; phoneE164?: string; permissionBits?: number; canApprove?: boolean;
  };
  if (!orgId || !/^[0-9]+$/.test(orgId)) throw new HttpsError('invalid-argument', 'BAD_ORG_ID');
  if (role !== 'admin' && role !== 'manager') throw new HttpsError('invalid-argument', 'BAD_ROLE');
  if (!phoneE164 || !/^\+[0-9]{7,15}$/.test(phoneE164)) throw new HttpsError('invalid-argument', 'BAD_PHONE');

  const caller = await resolveCallerAccount(request);
  const allowed = await publicClient().readContract({
    address: deployment().organizers,
    abi: organizersAbi,
    functionName: 'hasPermission',
    args: [BigInt(orgId), caller, PERM_MANAGE_MANAGERS],
  });
  if (!allowed) throw new HttpsError('permission-denied', 'NOT_ALLOWED_TO_INVITE');

  const inviteId = randomUUID();
  await db.collection(INVITES).doc(inviteId).set({
    orgId, role, phoneE164,
    permissionBits: permissionBits ?? 0,
    canApprove: canApprove ?? false,
    status: 'sent',
    createdAt: FieldValue.serverTimestamp(),
  });

  return { inviteId, link: `https://${RP_ID.value()}/org/invite/${inviteId}` };
});

/** 서버는 권한을 체인에 쓰지 않는다. 오너가 서명할 calldata만 만들어 준다. */
export const acceptInvite = onCall(
  async (request): Promise<{ to: Hex; data: Hex; orgId: string; role: string }> => {
    const { inviteId } = (request.data ?? {}) as { inviteId?: string };
    if (!inviteId) throw new HttpsError('invalid-argument', 'BAD_INVITE_ID');

    const account = await resolveCallerAccount(request);
    const inviteRef = db.collection(INVITES).doc(inviteId);
    const invite = await inviteRef.get();
    if (!invite.exists) throw new HttpsError('not-found', 'INVITE_NOT_FOUND');
    if (invite.get('status') !== 'sent') throw new HttpsError('failed-precondition', 'INVITE_NOT_OPEN');

    const orgId = invite.get('orgId') as string;
    const role = invite.get('role') as 'admin' | 'manager';
    const data =
      role === 'admin'
        ? encodeFunctionData({
            abi: organizersAbi,
            functionName: 'setAdmin',
            args: [BigInt(orgId), account, invite.get('permissionBits') as number],
          })
        : encodeFunctionData({
            abi: organizersAbi,
            functionName: 'setManager',
            args: [BigInt(orgId), account, true, invite.get('canApprove') as boolean],
          });

    await inviteRef.set(
      { status: 'accepted', acceptedAccount: account, acceptedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );

    return { to: deployment().organizers, data, orgId, role };
  },
);
```

`packages/shared/src/index.ts` 맨 아래에 viem 재수출 한 줄을 추가해 Functions가 `encodeFunctionData`를 `@monti/shared`에서 받게 한다:

```ts
export { encodeFunctionData, decodeEventLog, decodeFunctionData, keccak256 } from 'viem';
```

`functions/src/index.ts`에 추가: `export { createInvite, acceptInvite } from './functions/invites.js';`

- [ ] **Step 4: 테스트를 통과시킨다**

Run:
```bash
pnpm --filter @monti/shared build
firebase emulators:exec --only firestore,auth "pnpm --filter monti-functions exec vitest run test/invites.test.ts"
```
Expected: PASS — `Tests  3 passed (3)`

- [ ] **Step 5: 커밋**

```bash
git add functions/src/functions/invites.ts functions/src/index.ts functions/test/invites.test.ts packages/shared/src/index.ts
git commit -m "feat(functions): add organizer invites that return calldata instead of writing roles"
```

---

## Task 24: 전화번호 색인과 `resolveRecipient`

**Files:**
- Create: `functions/src/lib/phoneIndex.ts`, `functions/src/functions/resolveRecipient.ts`
- Test: `functions/test/phoneIndex.test.ts`

**Interfaces:**
- Consumes: Task 4 `nicknameHash`, `recipientCommitment`; Task 14 `PHONE_INDEX_KEY`; Task 3 `identityAbi`.
- Produces:
  - `hmacPhone(phoneE164: string, key: string): string` — 64자 소문자 hex. Firestore 문서 id.
  - `upsertPhoneIndex(phoneE164: string, personId: Hex, key: string): Promise<string>`
  - callable `resolveRecipient`: `{ type: 'phone'|'nickname'|'address', value: string }` → `ResolveRecipientResult`.

**개인정보 원칙:** 평문 전화번호는 `users/{uid}.phoneE164` 하나에만 있고, 검색용 색인은 HMAC이다. 키가 없으면 색인만 보고는 어떤 번호인지 알 수 없다. 응답에는 **전화번호도 이름도 절대 담지 않는다**.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`functions/test/phoneIndex.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { recipientCommitment } from '@monti/shared';

const nicknameOwner = vi.fn(async () => '0x0000000000000000000000000000000000000000');
const isMember = vi.fn(async () => true);
const nicknameOf = vi.fn(async () => 'alex');
vi.mock('../src/lib/chain.js', () => ({
  publicClient: () => ({
    readContract: vi.fn(async ({ functionName }: { functionName: string }) =>
      functionName === 'nicknameOwner' ? nicknameOwner()
      : functionName === 'nicknameOf' ? nicknameOf()
      : isMember(),
    ),
  }),
  deployment: () => ({ identity: '0x1111111111111111111111111111111111111111' }),
}));

const { hmacPhone } = await import('../src/lib/phoneIndex.js');
const { db, PHONE_INDEX, PERSONS } = await import('../src/lib/db.js');
const { resolveRecipient } = await import('../src/functions/resolveRecipient.js');
const functionsTest = (await import('firebase-functions-test')).default();
const resolve = functionsTest.wrap(resolveRecipient);

const KEY = 'monti-test-key';
const PERSON_ID = `0x${'aa'.repeat(32)}`;
const ACCOUNT = '0x9999999999999999999999999999999999999999';
const auth = { uid: 'uid-1', token: { account: ACCOUNT } };

beforeEach(async () => {
  process.env.PHONE_INDEX_KEY = KEY;
  const snap = await db.collection(PHONE_INDEX).get();
  await Promise.all(snap.docs.map((d) => d.ref.delete()));
  await db.collection(PERSONS).doc(PERSON_ID).set({ status: 'active', account: ACCOUNT });
});

describe('hmacPhone', () => {
  it('matches the fixed HMAC-SHA256 vector', () => {
    expect(hmacPhone('+821012345678', KEY)).toBe(
      'e3b01fa8547cd798cc330f31e3a1bad493a8d9f248d6bc34647c8e751966464e',
    );
  });

  it('rejects a non-E164 number', () => {
    expect(() => hmacPhone('010-1234-5678', KEY)).toThrow('BAD_PHONE');
  });
});

describe('resolveRecipient', () => {
  it('finds a member by phone and returns no phone number in the answer', async () => {
    const id = hmacPhone('+821012345678', KEY);
    await db.collection(PHONE_INDEX).doc(id).set({ personId: PERSON_ID });

    const result = (await resolve({ data: { type: 'phone', value: '+821012345678' }, auth } as never)) as Record<string, unknown>;
    expect(result.member).toBe(true);
    expect(result.account).toBe(ACCOUNT);
    expect(result.commitment).toBe(recipientCommitment(id));
    expect(JSON.stringify(result)).not.toContain('821012345678');
  });

  it('returns a commitment for a non-member phone so an invite can be created', async () => {
    const result = (await resolve({ data: { type: 'phone', value: '+821099998888' }, auth } as never)) as Record<string, unknown>;
    expect(result.member).toBe(false);
    expect(result.account).toBeUndefined();
    expect(result.commitment).toBe(recipientCommitment(hmacPhone('+821099998888', KEY)));
  });

  it('resolves a nickname through Identity.nicknameOwner', async () => {
    nicknameOwner.mockResolvedValueOnce(ACCOUNT);
    const result = (await resolve({ data: { type: 'nickname', value: '  ALEX ' }, auth } as never)) as Record<string, unknown>;
    expect(result).toMatchObject({ member: true, account: ACCOUNT, nickname: 'alex' });
    expect(result.commitment).toBeUndefined();
  });

  it('resolves an address through Identity.isMember', async () => {
    const result = (await resolve({ data: { type: 'address', value: ACCOUNT }, auth } as never)) as Record<string, unknown>;
    expect(result).toMatchObject({ member: true, account: ACCOUNT });
  });
});
```

Run: `firebase emulators:exec --only firestore,auth "pnpm --filter monti-functions exec vitest run test/phoneIndex.test.ts"`
Expected: FAIL — `Failed to resolve import "../src/lib/phoneIndex.js"`

- [ ] **Step 2: `phoneIndex.ts`를 쓴다**

```ts
import { createHmac } from 'node:crypto';
import type { Hex } from '@monti/shared';
import { PHONE_INDEX, db } from './db.js';

/** 평문 번호를 Firestore 문서 id로 만들지 않는다. 키 없이는 역산이 불가능하다. */
export function hmacPhone(phoneE164: string, key: string): string {
  if (!/^\+[0-9]{7,15}$/.test(phoneE164)) throw new Error('BAD_PHONE');
  if (!key) throw new Error('MISSING_PHONE_INDEX_KEY');
  return createHmac('sha256', key).update(phoneE164, 'utf8').digest('hex');
}

export async function upsertPhoneIndex(phoneE164: string, personId: Hex, key: string): Promise<string> {
  const id = hmacPhone(phoneE164, key);
  await db.collection(PHONE_INDEX).doc(id).set({ personId }, { merge: true });
  return id;
}

export async function personIdByPhone(phoneE164: string, key: string): Promise<Hex | undefined> {
  const doc = await db.collection(PHONE_INDEX).doc(hmacPhone(phoneE164, key)).get();
  return doc.exists ? (doc.get('personId') as Hex) : undefined;
}
```

`startSignup`(Task 16)은 이미 `upsertPhoneIndex` 를 부른다. 이 Task는 그 함수의 정의와 조회 경로를 채울 뿐이므로 `startSignup.ts` 는 건드리지 않는다.

- [ ] **Step 3: `resolveRecipient.ts`를 쓴다**

```ts
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import {
  identityAbi,
  nicknameHash,
  normalizeNickname,
  recipientCommitment,
  type Hex,
  type ResolveRecipientResult,
} from '@monti/shared';
import { PHONE_INDEX_KEY } from '../config.js';
import { deployment, publicClient } from '../lib/chain.js';
import { PERSONS, db } from '../lib/db.js';
import { hmacPhone } from '../lib/phoneIndex.js';

const ZERO = '0x0000000000000000000000000000000000000000';

export const resolveRecipient = onCall(
  { secrets: [PHONE_INDEX_KEY] },
  async (request): Promise<ResolveRecipientResult> => {
    if (!request.auth?.uid) throw new HttpsError('unauthenticated', 'AUTH_REQUIRED');
    const { type, value } = (request.data ?? {}) as { type?: string; value?: string };
    if (!value || typeof value !== 'string') throw new HttpsError('invalid-argument', 'BAD_VALUE');

    const contracts = deployment();
    const pc = publicClient();

    if (type === 'phone') {
      let id: string;
      try {
        id = hmacPhone(value, PHONE_INDEX_KEY.value());
      } catch {
        throw new HttpsError('invalid-argument', 'BAD_PHONE');
      }
      const commitment = recipientCommitment(id);
      const indexDoc = await db.collection('phoneIndex').doc(id).get();
      const personId = indexDoc.exists ? (indexDoc.get('personId') as Hex) : undefined;
      if (!personId) return { member: false, commitment };
      const account = (await db.collection(PERSONS).doc(personId).get()).get('account') as Hex | undefined;
      if (!account) return { member: false, commitment };
      const nickname = await pc.readContract({
        address: contracts.identity, abi: identityAbi, functionName: 'nicknameOf', args: [account],
      });
      return { member: true, account, nickname: (nickname as string) || undefined, commitment };
    }

    if (type === 'nickname') {
      const normalized = normalizeNickname(value);
      if (!normalized) throw new HttpsError('invalid-argument', 'EMPTY_NICKNAME');
      const owner = await pc.readContract({
        address: contracts.identity, abi: identityAbi, functionName: 'nicknameOwner', args: [nicknameHash(value)],
      });
      if (owner === ZERO) return { member: false };
      return { member: true, account: owner as Hex, nickname: normalized };
    }

    if (type === 'address') {
      if (!/^0x[0-9a-fA-F]{40}$/.test(value)) throw new HttpsError('invalid-argument', 'BAD_ADDRESS');
      const member = await pc.readContract({
        address: contracts.identity, abi: identityAbi, functionName: 'isMember', args: [value as Hex],
      });
      if (!member) return { member: false };
      const nickname = await pc.readContract({
        address: contracts.identity, abi: identityAbi, functionName: 'nicknameOf', args: [value as Hex],
      });
      return { member: true, account: value as Hex, nickname: (nickname as string) || undefined };
    }

    throw new HttpsError('invalid-argument', 'BAD_TYPE');
  },
);
```

`functions/src/index.ts`에 추가: `export { resolveRecipient } from './functions/resolveRecipient.js';`

- [ ] **Step 4: 테스트를 통과시킨다**

Run: `firebase emulators:exec --only firestore,auth "pnpm --filter monti-functions exec vitest run test/phoneIndex.test.ts"`
Expected: PASS — `Tests  6 passed (6)`

- [ ] **Step 5: 커밋**

```bash
git add functions/src/lib/phoneIndex.ts functions/src/functions/resolveRecipient.ts \
        functions/src/index.ts functions/test/phoneIndex.test.ts
git commit -m "feat(functions): add HMAC phone index and recipient resolution by phone, nickname or address"
```

---

## Task 25: `createTransferInvite`와 `pendingOffers`

**Files:**
- Create: `functions/src/functions/transferInvites.ts`
- Test: `functions/test/transferInvites.test.ts`

**Interfaces:**
- Consumes: Task 24 `hmacPhone`; Task 4 `recipientCommitment`, `offerDigest`; Task 13 `getAttesterAccount`.
- Produces:
  - callable `createTransferInvite`: `{ tokenId, phoneE164 }` → `{ inviteId, commitment, expiresAt, smsText, smsUri }`. **서버는 문자를 보내지 않는다.** 보내는 사람의 폰이 `smsUri`(`sms:+8210…?body=…`)로 자기 문자 앱을 연다.
  - callable `pendingOffers`: `{}` → `{ offers: Array<{ tokenId: string; attesterSig: Hex; inviteId: string }> }`. 호출자 전화번호의 `hmacPhone`과 맞는 `transferInvites`를 찾아 `Ticket.acceptOffer`용 어테스터 서명을 만들어 준다.

**검증 순서:** `createTransferInvite`는 ① 호출자가 `Ticket.ownerOf(tokenId)`인지 ② 오퍼가 이미 있지 않은지를 eth_call로 확인한 뒤 초대를 만든다. 실제 `createOffer` 트랜잭션은 관객 폰이 보낸다(서버는 티켓을 움직이지 않는다).

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`functions/test/transferInvites.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { recoverAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { offerDigest, recipientCommitment, TRANSFER_INVITE_TTL_SECONDS } from '@monti/shared';

const PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const;
const attester = privateKeyToAccount(PK);
const OWNER = '0x9999999999999999999999999999999999999999';

vi.mock('../src/lib/chain.js', () => ({
  publicClient: () => ({
    readContract: vi.fn(async ({ functionName }: { functionName: string }) =>
      functionName === 'ownerOf' ? OWNER : [ '0x0000000000000000000000000000000000000000', `0x${'00'.repeat(32)}`, 0n ],
    ),
  }),
  deployment: () => ({ ticket: '0x3333333333333333333333333333333333333333' }),
}));
vi.mock('../src/lib/auth.js', () => ({ resolveCallerAccount: vi.fn(async () => OWNER) }));
vi.mock('../src/lib/attester.js', () => ({ getAttesterAccount: () => attester }));

const { hmacPhone } = await import('../src/lib/phoneIndex.js');
const { db, TRANSFER_INVITES } = await import('../src/lib/db.js');
const { createTransferInvite, pendingOffers } = await import('../src/functions/transferInvites.js');
const functionsTest = (await import('firebase-functions-test')).default();
const create = functionsTest.wrap(createTransferInvite);
const pending = functionsTest.wrap(pendingOffers);

const KEY = 'monti-test-key';
const PHONE = '+821012345678';
const senderAuth = { uid: 'uid-1', token: { account: OWNER, phone_number: '+821000000000' } };
const receiverAuth = { uid: 'uid-2', token: { account: '0x8888888888888888888888888888888888888888', phone_number: PHONE } };

beforeEach(async () => {
  process.env.PHONE_INDEX_KEY = KEY;
  const snap = await db.collection(TRANSFER_INVITES).get();
  await Promise.all(snap.docs.map((d) => d.ref.delete()));
});

describe('createTransferInvite', () => {
  it('stores an invite with the keccak commitment and returns an sms: URI the sender opens', async () => {
    const result = (await create({ data: { tokenId: '7', phoneE164: PHONE }, auth: senderAuth } as never)) as {
      inviteId: string; commitment: string; expiresAt: number; smsText: string; smsUri: string;
    };

    expect(result.commitment).toBe(recipientCommitment(hmacPhone(PHONE, KEY)));
    expect(result.smsUri.startsWith(`sms:${PHONE}?body=`)).toBe(true);
    expect(decodeURIComponent(result.smsUri.split('?body=')[1]!)).toBe(result.smsText);
    expect(result.expiresAt - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(TRANSFER_INVITE_TTL_SECONDS);

    const invite = await db.collection(TRANSFER_INVITES).doc(result.inviteId).get();
    expect(invite.get('status')).toBe('sent');
    expect(invite.get('hmacPhone')).toBe(hmacPhone(PHONE, KEY));
    expect(invite.get('fromAccount')).toBe(OWNER);
  });

  it('refuses a token the caller does not own', async () => {
    const other = { uid: 'uid-3', token: { account: '0x7777777777777777777777777777777777777777' } };
    await expect(create({ data: { tokenId: '7', phoneE164: PHONE }, auth: other } as never)).rejects.toThrow('NOT_TOKEN_OWNER');
  });
});

describe('pendingOffers', () => {
  it('returns an attester signature that recovers for the caller account', async () => {
    const { commitment } = (await create({ data: { tokenId: '7', phoneE164: PHONE }, auth: senderAuth } as never)) as {
      commitment: `0x${string}`;
    };

    const result = (await pending({ data: {}, auth: receiverAuth } as never)) as {
      offers: Array<{ tokenId: string; attesterSig: `0x${string}` }>;
    };
    expect(result.offers).toHaveLength(1);
    expect(result.offers[0]!.tokenId).toBe('7');

    const digest = offerDigest({
      tokenId: 7n,
      recipientCommitment: commitment,
      recipientAccount: '0x8888888888888888888888888888888888888888',
    });
    expect(await recoverAddress({ hash: digest, signature: result.offers[0]!.attesterSig })).toBe(attester.address);
  });

  it('returns nothing for a phone with no invite', async () => {
    const stranger = { uid: 'uid-4', token: { account: OWNER, phone_number: '+821099990000' } };
    const result = (await pending({ data: {}, auth: stranger } as never)) as { offers: unknown[] };
    expect(result.offers).toEqual([]);
  });
});
```

Run: `firebase emulators:exec --only firestore,auth "pnpm --filter monti-functions exec vitest run test/transferInvites.test.ts"`
Expected: FAIL — `Failed to resolve import "../src/functions/transferInvites.js"`

- [ ] **Step 2: `transferInvites.ts`를 쓴다**

```ts
import { randomUUID } from 'node:crypto';
import { FieldValue } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import {
  TRANSFER_INVITE_TTL_SECONDS,
  offerDigest,
  recipientCommitment,
  ticketAbi,
  type Hex,
} from '@monti/shared';
import { ATTESTER_PK, PHONE_INDEX_KEY, RP_ID } from '../config.js';
import { getAttesterAccount } from '../lib/attester.js';
import { resolveCallerAccount } from '../lib/auth.js';
import { deployment, publicClient } from '../lib/chain.js';
import { TRANSFER_INVITES, db } from '../lib/db.js';
import { hmacPhone } from '../lib/phoneIndex.js';

export const createTransferInvite = onCall(
  { secrets: [PHONE_INDEX_KEY] },
  async (request): Promise<{
    inviteId: string; commitment: Hex; expiresAt: number; smsText: string; smsUri: string;
  }> => {
    const { tokenId, phoneE164 } = (request.data ?? {}) as { tokenId?: string; phoneE164?: string };
    if (!tokenId || !/^[0-9]+$/.test(tokenId)) throw new HttpsError('invalid-argument', 'BAD_TOKEN_ID');
    if (!phoneE164 || !/^\+[0-9]{7,15}$/.test(phoneE164)) throw new HttpsError('invalid-argument', 'BAD_PHONE');

    const caller = await resolveCallerAccount(request);
    const owner = await publicClient().readContract({
      address: deployment().ticket, abi: ticketAbi, functionName: 'ownerOf', args: [BigInt(tokenId)],
    });
    if ((owner as string).toLowerCase() !== caller.toLowerCase()) {
      throw new HttpsError('permission-denied', 'NOT_TOKEN_OWNER');
    }

    const id = hmacPhone(phoneE164, PHONE_INDEX_KEY.value());
    const commitment = recipientCommitment(id);
    const inviteId = randomUUID();
    const expiresAt = Math.floor(Date.now() / 1000) + TRANSFER_INVITE_TTL_SECONDS;

    await db.collection(TRANSFER_INVITES).doc(inviteId).set({
      tokenId,
      fromAccount: caller,
      hmacPhone: id,
      commitment,
      status: 'sent',
      createdAt: FieldValue.serverTimestamp(),
      expiresAt,
    });

    // 문자는 보내는 사람의 폰이 보낸다. 서버는 문구와 URI만 만든다(문자 비용 0원).
    const smsText = `[MONTI] 티켓을 보냈습니다. 앱에서 받기를 눌러 주세요. https://${RP_ID.value()}/t/${inviteId}`;
    const smsUri = `sms:${phoneE164}?body=${encodeURIComponent(smsText)}`;

    return { inviteId, commitment, expiresAt, smsText, smsUri };
  },
);

export const pendingOffers = onCall(
  { secrets: [PHONE_INDEX_KEY, ATTESTER_PK] },
  async (request): Promise<{ offers: Array<{ tokenId: string; attesterSig: Hex; inviteId: string }> }> => {
    const account = await resolveCallerAccount(request);
    const phoneE164 = request.auth?.token?.phone_number as string | undefined;
    if (!phoneE164) throw new HttpsError('failed-precondition', 'PHONE_REQUIRED');

    const id = hmacPhone(phoneE164, PHONE_INDEX_KEY.value());
    const now = Math.floor(Date.now() / 1000);
    const snapshot = await db
      .collection(TRANSFER_INVITES)
      .where('hmacPhone', '==', id)
      .where('status', '==', 'sent')
      .limit(50)
      .get();

    const attester = getAttesterAccount();
    const offers: Array<{ tokenId: string; attesterSig: Hex; inviteId: string }> = [];
    for (const doc of snapshot.docs) {
      if ((doc.get('expiresAt') as number) < now) {
        await doc.ref.update({ status: 'expired' });
        continue;
      }
      const tokenId = doc.get('tokenId') as string;
      const digest = offerDigest({
        tokenId: BigInt(tokenId),
        recipientCommitment: doc.get('commitment') as Hex,
        recipientAccount: account,
      });
      offers.push({ tokenId, attesterSig: await attester.sign({ hash: digest }), inviteId: doc.id });
    }
    return { offers };
  },
);
```

`functions/src/index.ts`에 추가: `export { createTransferInvite, pendingOffers } from './functions/transferInvites.js';`

- [ ] **Step 3: 테스트를 통과시킨다**

Run: `firebase emulators:exec --only firestore,auth "pnpm --filter monti-functions exec vitest run test/transferInvites.test.ts"`
Expected: PASS — `Tests  4 passed (4)`

- [ ] **Step 4: 서버가 문자를 보내지 않는지 확인한다**

Run: `grep -rniE "twilio|solapi|aligo|sendSms|messagebird" functions/src; echo "exit=$?"`
Expected: 출력 없음, `exit=1`.

- [ ] **Step 5: 커밋**

```bash
git add functions/src/functions/transferInvites.ts functions/src/index.ts functions/test/transferInvites.test.ts
git commit -m "feat(functions): add zero-cost transfer invites and attester-signed pending offers"
```

---

## Task 26: 이벤트 채팅 — `joinEventChat`, `reportMessage`, `closeEndedChats`

**Files:**
- Create: `functions/src/functions/eventChat.ts`
- Test: `functions/test/eventChat.test.ts`

**Interfaces:**
- Consumes: Task 15 `resolveCallerAccount`, `EVENT_CHATS`; Task 3 `ticketAbi`; Task 1 `EVENT_STATUS_BY_CODE`.
- Produces:
  - callable `joinEventChat`: `{ eventId }` → `{ ok: true }`. `Ticket.balanceOfEvent(account, eventId) > 0`, `eventStatus == Published`, `eventMeta.endsAt > now` 세 조건을 **eth_call**로 확인한 뒤 `eventChats/{eventId}/members/{uid}`를 만든다.
  - callable `reportMessage`: `{ eventId, msgId }` → `{ reported: number }`. `messages/{msgId}.reported`를 1 증가.
  - scheduled `closeEndedChats` (10분): `endsAt < now`인 열린 채팅을 닫는다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`functions/test/eventChat.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const balance = vi.fn(async () => 1n);
const status = vi.fn(async () => 1);
const endsAt = vi.fn(async () => BigInt(Math.floor(Date.now() / 1000) + 3600));
vi.mock('../src/lib/chain.js', () => ({
  publicClient: () => ({
    readContract: vi.fn(async ({ functionName }: { functionName: string }) =>
      functionName === 'balanceOfEvent' ? balance()
      : functionName === 'eventStatus' ? status()
      : { orgId: 1n, endsAt: await endsAt() },
    ),
  }),
  deployment: () => ({ ticket: '0x3333333333333333333333333333333333333333' }),
}));
vi.mock('../src/lib/auth.js', () => ({
  resolveCallerAccount: vi.fn(async () => '0x9999999999999999999999999999999999999999'),
}));

const { db, EVENT_CHATS } = await import('../src/lib/db.js');
const { joinEventChat, reportMessage, closeEndedChats } = await import('../src/functions/eventChat.js');
const functionsTest = (await import('firebase-functions-test')).default();
const join = functionsTest.wrap(joinEventChat);
const report = functionsTest.wrap(reportMessage);
const auth = { uid: 'uid-1', token: { account: '0x9999999999999999999999999999999999999999' } };

beforeEach(async () => {
  balance.mockResolvedValue(1n);
  status.mockResolvedValue(1);
  const snap = await db.collection(EVENT_CHATS).get();
  await Promise.all(snap.docs.map((d) => d.ref.delete()));
  await db.collection(EVENT_CHATS).doc('11').set({
    closed: false, endsAt: Math.floor(Date.now() / 1000) + 3600, orgId: '1',
  });
});

describe('joinEventChat', () => {
  it('adds a member when the caller holds a ticket for a published, unfinished event', async () => {
    await join({ data: { eventId: '11' }, auth } as never);
    const member = await db.doc(`${EVENT_CHATS}/11/members/uid-1`).get();
    expect(member.exists).toBe(true);
    expect(member.get('account')).toBe('0x9999999999999999999999999999999999999999');
  });

  it('refuses a caller with no ticket for the event', async () => {
    balance.mockResolvedValue(0n);
    await expect(join({ data: { eventId: '11' }, auth } as never)).rejects.toThrow('NO_TICKET_FOR_EVENT');
  });

  it('refuses an event that is not Published', async () => {
    status.mockResolvedValue(2);
    await expect(join({ data: { eventId: '11' }, auth } as never)).rejects.toThrow('EVENT_NOT_PUBLISHED');
  });
});

describe('reportMessage', () => {
  it('increments the report counter', async () => {
    await join({ data: { eventId: '11' }, auth } as never);
    await db.doc(`${EVENT_CHATS}/11/messages/m1`).set({ uid: 'uid-2', text: 'hi', createdAt: 1, reported: 0 });
    const result = (await report({ data: { eventId: '11', msgId: 'm1' }, auth } as never)) as { reported: number };
    expect(result.reported).toBe(1);
  });
});

describe('closeEndedChats', () => {
  it('closes chats whose event has ended', async () => {
    await db.collection(EVENT_CHATS).doc('12').set({ closed: false, endsAt: 1, orgId: '1' });
    await functionsTest.wrap(closeEndedChats)({} as never);
    expect((await db.collection(EVENT_CHATS).doc('12').get()).get('closed')).toBe(true);
    expect((await db.collection(EVENT_CHATS).doc('11').get()).get('closed')).toBe(false);
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `firebase emulators:exec --only firestore,auth "pnpm --filter monti-functions exec vitest run test/eventChat.test.ts"`
Expected: FAIL — `Failed to resolve import "../src/functions/eventChat.js"`

- [ ] **Step 3: `eventChat.ts`를 쓴다**

```ts
import { FieldValue } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { CHAT_CLOSE_SCHEDULE, EVENT_STATUS_BY_CODE, ticketAbi } from '@monti/shared';
import { resolveCallerAccount } from '../lib/auth.js';
import { deployment, publicClient } from '../lib/chain.js';
import { EVENT_CHATS, db } from '../lib/db.js';

/** 채팅 입장권은 티켓이다. 세 조건 모두 체인에서 직접 읽는다. */
export const joinEventChat = onCall(async (request): Promise<{ ok: true }> => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'AUTH_REQUIRED');
  const { eventId } = (request.data ?? {}) as { eventId?: string };
  if (!eventId || !/^[0-9]+$/.test(eventId)) throw new HttpsError('invalid-argument', 'BAD_EVENT_ID');

  const account = await resolveCallerAccount(request);
  const contracts = deployment();
  const pc = publicClient();

  const [balance, statusCode, meta] = await Promise.all([
    pc.readContract({ address: contracts.ticket, abi: ticketAbi, functionName: 'balanceOfEvent', args: [account, BigInt(eventId)] }),
    pc.readContract({ address: contracts.ticket, abi: ticketAbi, functionName: 'eventStatus', args: [BigInt(eventId)] }),
    pc.readContract({ address: contracts.ticket, abi: ticketAbi, functionName: 'eventMeta', args: [BigInt(eventId)] }),
  ]);

  if ((balance as bigint) === 0n) throw new HttpsError('permission-denied', 'NO_TICKET_FOR_EVENT');
  if (EVENT_STATUS_BY_CODE[Number(statusCode)] !== 'Published') {
    throw new HttpsError('failed-precondition', 'EVENT_NOT_PUBLISHED');
  }
  const endsAt = Number((meta as { endsAt: bigint }).endsAt);
  if (endsAt <= Math.floor(Date.now() / 1000)) throw new HttpsError('failed-precondition', 'EVENT_ENDED');

  await db.collection(EVENT_CHATS).doc(eventId).set(
    { closed: false, endsAt, orgId: String((meta as { orgId: bigint }).orgId) },
    { merge: true },
  );
  await db.doc(`${EVENT_CHATS}/${eventId}/members/${uid}`).set({
    account,
    joinedAt: FieldValue.serverTimestamp(),
  });

  return { ok: true };
});

export const reportMessage = onCall(async (request): Promise<{ reported: number }> => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'AUTH_REQUIRED');
  const { eventId, msgId } = (request.data ?? {}) as { eventId?: string; msgId?: string };
  if (!eventId || !msgId) throw new HttpsError('invalid-argument', 'BAD_ARGS');

  const member = await db.doc(`${EVENT_CHATS}/${eventId}/members/${uid}`).get();
  if (!member.exists) throw new HttpsError('permission-denied', 'NOT_A_MEMBER');

  const messageRef = db.doc(`${EVENT_CHATS}/${eventId}/messages/${msgId}`);
  return db.runTransaction(async (tx) => {
    const message = await tx.get(messageRef);
    if (!message.exists) throw new HttpsError('not-found', 'MESSAGE_NOT_FOUND');
    const reported = ((message.get('reported') as number) ?? 0) + 1;
    tx.update(messageRef, { reported });
    return { reported };
  });
});

export const closeEndedChats = onSchedule(
  { schedule: CHAT_CLOSE_SCHEDULE, timeZone: 'Asia/Seoul' },
  async () => {
    const now = Math.floor(Date.now() / 1000);
    const snapshot = await db
      .collection(EVENT_CHATS)
      .where('closed', '==', false)
      .where('endsAt', '<', now)
      .limit(200)
      .get();
    await Promise.all(snapshot.docs.map((doc) => doc.ref.update({ closed: true })));
  },
);
```

`functions/src/index.ts`에 추가: `export { joinEventChat, reportMessage, closeEndedChats } from './functions/eventChat.js';`

- [ ] **Step 4: 테스트를 통과시킨다**

Run: `firebase emulators:exec --only firestore,auth "pnpm --filter monti-functions exec vitest run test/eventChat.test.ts"`
Expected: PASS — `Tests  6 passed (6)`

- [ ] **Step 5: 커밋**

```bash
git add functions/src/functions/eventChat.ts functions/src/index.ts functions/test/eventChat.test.ts
git commit -m "feat(functions): gate event chat on chain-verified ticket ownership and close ended chats"
```

---

## Task 27: `listAttendees`

**Files:**
- Create: `functions/src/functions/listAttendees.ts`
- Test: `functions/test/listAttendees.test.ts`

**Interfaces:**
- Consumes: Task 22 `envioQuery`; Task 15 `resolveCallerAccount`; Task 3 `organizersAbi`, `ticketAbi`.
- Produces: callable `listAttendees`: `{ eventId }` → `{ attendees: AttendeeRow[] }`. 행은 `{ tokenId, nickname, checkedIn, tier, kycLevel }` 다. 관리자(`PERM_CREATE_EVENT`) 혹은 매니저만. **전화번호와 실명은 절대 포함하지 않는다.**

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`functions/test/listAttendees.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';

const hasPermission = vi.fn(async () => true);
vi.mock('../src/lib/chain.js', () => ({
  publicClient: () => ({
    readContract: vi.fn(async ({ functionName }: { functionName: string }) =>
      functionName === 'eventOrg' ? 1n
      : functionName === 'hasPermission' ? hasPermission()
      : [false, false],
    ),
  }),
  deployment: () => ({
    organizers: '0x2222222222222222222222222222222222222222',
    ticket: '0x3333333333333333333333333333333333333333',
  }),
}));
vi.mock('../src/lib/auth.js', () => ({
  resolveCallerAccount: vi.fn(async () => '0x9999999999999999999999999999999999999999'),
}));
vi.mock('../src/lib/envio.js', () => ({
  envioQuery: vi.fn(async () => ({
    rows: [
      { id: '7', tier: 0, owner: '0xaaa', revoked: false, checkIn: { id: '7' }, identity: { nickname: 'alex', kycLevel: 1 } },
      { id: '8', tier: 1, owner: '0xbbb', revoked: false, checkIn: null, identity: null },
    ],
  })),
}));

const { listAttendees } = await import('../src/functions/listAttendees.js');
const functionsTest = (await import('firebase-functions-test')).default();
const list = functionsTest.wrap(listAttendees);
const auth = { uid: 'uid-1', token: { account: '0x9999999999999999999999999999999999999999' } };

describe('listAttendees', () => {
  it('returns tokenId, nickname, checkedIn, tier and kycLevel and nothing else', async () => {
    const result = (await list({ data: { eventId: '11' }, auth } as never)) as {
      attendees: Array<Record<string, unknown>>;
    };
    expect(result.attendees).toEqual([
      { tokenId: '7', nickname: 'alex', checkedIn: true, tier: 0, kycLevel: 1 },
      { tokenId: '8', nickname: '', checkedIn: false, tier: 1, kycLevel: 0 },
    ]);
    expect(JSON.stringify(result)).not.toMatch(/phone|name|photo/i);
  });

  it('refuses a caller who is neither admin nor manager', async () => {
    hasPermission.mockResolvedValueOnce(false);
    await expect(list({ data: { eventId: '11' }, auth } as never)).rejects.toThrow('NOT_ORGANIZER');
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm --filter monti-functions exec vitest run test/listAttendees.test.ts`
Expected: FAIL — `Failed to resolve import "../src/functions/listAttendees.js"`

- [ ] **Step 3: `listAttendees.ts`를 쓴다**

```ts
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { organizersAbi, ticketAbi, type AttendeeRow, type Hex } from '@monti/shared';
import { resolveCallerAccount } from '../lib/auth.js';
import { deployment, publicClient } from '../lib/chain.js';
import { envioQuery } from '../lib/envio.js';

const PERM_CREATE_EVENT = 1;

interface Row {
  id: string;
  tier: number;
  owner: string;
  revoked: boolean;
  checkIn: { id: string } | null;
  identity: { nickname: string | null; kycLevel: number } | null;
}

export const listAttendees = onCall(async (request): Promise<{ attendees: AttendeeRow[] }> => {
  const { eventId } = (request.data ?? {}) as { eventId?: string };
  if (!eventId || !/^[0-9]+$/.test(eventId)) throw new HttpsError('invalid-argument', 'BAD_EVENT_ID');

  const caller = await resolveCallerAccount(request);
  const contracts = deployment();
  const pc = publicClient();

  const orgId = await pc.readContract({
    address: contracts.ticket, abi: ticketAbi, functionName: 'eventOrg', args: [BigInt(eventId)],
  });
  const [isAdmin, manager] = await Promise.all([
    pc.readContract({
      address: contracts.organizers, abi: organizersAbi, functionName: 'hasPermission',
      args: [orgId as bigint, caller as Hex, PERM_CREATE_EVENT],
    }),
    pc.readContract({
      address: contracts.organizers, abi: organizersAbi, functionName: 'managerOf',
      args: [orgId as bigint, caller as Hex],
    }),
  ]);
  if (!isAdmin && !(manager as readonly [boolean, boolean])[0]) {
    throw new HttpsError('permission-denied', 'NOT_ORGANIZER');
  }

  // 인덱서는 목록용이다. 여기에는 PII가 없고 닉네임만 있다.
  const data = await envioQuery<{ rows: Row[] }>(
    `query Attendees($eventId: String!) {
      rows: Ticket(where: {eventId: {_eq: $eventId}, revoked: {_eq: false}}, order_by: {id: asc}) {
        id tier owner revoked checkIn { id } identity { nickname kycLevel }
      }
    }`,
    { eventId },
  );

  return {
    attendees: data.rows.map((row) => ({
      tokenId: row.id,
      nickname: row.identity?.nickname ?? '',
      checkedIn: row.checkIn !== null,
      tier: row.tier,
      kycLevel: (row.identity?.kycLevel ?? 0) as 0 | 1,
    })),
  };
});
```

`functions/src/index.ts`에 추가: `export { listAttendees } from './functions/listAttendees.js';`

- [ ] **Step 4: 테스트를 통과시킨다**

Run: `pnpm --filter monti-functions exec vitest run test/listAttendees.test.ts`
Expected: PASS — `Tests  2 passed (2)`

- [ ] **Step 5: 커밋**

```bash
git add functions/src/functions/listAttendees.ts functions/src/index.ts functions/test/listAttendees.test.ts
git commit -m "feat(functions): list attendees by nickname for organizers only"
```

---

## Task 28: `tenderlyWebhook`

**Files:**
- Create: `functions/src/lib/tenderly.ts`, `functions/src/functions/tenderlyWebhook.ts`
- Test: `functions/test/tenderly.test.ts`

**Interfaces:**
- Consumes: Task 3 ABI들; Task 15 `db`, `DEVICES`, `PERSONS`, `TRANSFER_INVITES`, `EVENT_CHATS`.
- Produces:
  - `verifyTenderlySignature(input: { raw: string; signature: string; date: string; secret: string }): boolean` — HMAC-SHA256(secret, raw + date).
  - `decodeMontiLogs(logs: Array<{ raw: { topics: string[]; data: string } }>): Array<{ name: string; args: Record<string, unknown> }>`
  - HTTPS `tenderlyWebhook`. 처리 이벤트: `CheckedIn`(푸시 "입장 완료"), `Registered`(persons active), `AdminSet`/`ManagerSet`/`GateRegistered`(캐시 무효화 Pub/Sub), `Transfer`(보낸 사람의 채팅 멤버 제거), `OfferAccepted`(초대 accepted), `EventStatusChanged`(채팅 문서 생성·폐쇄).

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`functions/test/tenderly.test.ts`:

```ts
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { encodeEventTopics, encodeAbiParameters, parseAbiParameters } from 'viem';
import { ticketAbi } from '@monti/shared';
import { decodeMontiLogs, verifyTenderlySignature } from '../src/lib/tenderly.js';

const SECRET = 'tenderly-secret';
const RAW = '{"id":"alert-1"}';
const DATE = 'Sun, 20 Sep 2026 00:00:00 GMT';
const SIG = createHmac('sha256', SECRET).update(RAW).update(DATE).digest('hex');

describe('verifyTenderlySignature', () => {
  it('accepts the documented HMAC over body + Date header', () => {
    expect(verifyTenderlySignature({ raw: RAW, signature: SIG, date: DATE, secret: SECRET })).toBe(true);
  });

  it('rejects a wrong signature, date or secret', () => {
    expect(verifyTenderlySignature({ raw: RAW, signature: 'ff', date: DATE, secret: SECRET })).toBe(false);
    expect(verifyTenderlySignature({ raw: RAW, signature: SIG, date: 'other', secret: SECRET })).toBe(false);
    expect(verifyTenderlySignature({ raw: RAW, signature: SIG, date: DATE, secret: 'nope' })).toBe(false);
  });
});

describe('decodeMontiLogs', () => {
  it('decodes a CheckedIn log into name and args', () => {
    const topics = encodeEventTopics({
      abi: ticketAbi,
      eventName: 'CheckedIn',
      args: { tokenId: 7n, eventId: 11n, gateId: 3n },
    });
    const data = encodeAbiParameters(parseAbiParameters('bytes32 nonceHash, uint64 ts'), [
      `0x${'11'.repeat(32)}`,
      1_789_862_400n,
    ]);

    const decoded = decodeMontiLogs([{ raw: { topics, data } }]);
    expect(decoded).toHaveLength(1);
    expect(decoded[0]!.name).toBe('CheckedIn');
    expect(decoded[0]!.args.tokenId).toBe(7n);
    expect(decoded[0]!.args.gateId).toBe(3n);
  });

  it('skips logs that belong to no MONTI contract', () => {
    expect(decodeMontiLogs([{ raw: { topics: [`0x${'ab'.repeat(32)}`], data: '0x' } }])).toEqual([]);
  });
});
```

Run: `pnpm --filter monti-functions exec vitest run test/tenderly.test.ts`
Expected: FAIL — `Failed to resolve import "../src/lib/tenderly.js"`

- [ ] **Step 2: `tenderly.ts`를 쓴다**

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';
import { decodeEventLog } from 'viem';
import { identityAbi, organizersAbi, ticketAbi, type Hex } from '@monti/shared';

export function verifyTenderlySignature(input: {
  raw: string;
  signature: string;
  date: string;
  secret: string;
}): boolean {
  const expected = createHmac('sha256', input.secret).update(input.raw).update(input.date).digest('hex');
  const provided = input.signature.trim().toLowerCase();
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(provided, 'utf8'));
}

export interface TenderlyLog {
  raw: { topics: readonly string[]; data: string };
}

/** Tenderly가 붙인 이름을 믿지 않고 로그를 우리 ABI로 직접 디코드한다. */
export function decodeMontiLogs(logs: readonly TenderlyLog[]): Array<{ name: string; args: Record<string, unknown> }> {
  const out: Array<{ name: string; args: Record<string, unknown> }> = [];
  for (const log of logs) {
    for (const abi of [ticketAbi, identityAbi, organizersAbi]) {
      try {
        const decoded = decodeEventLog({
          abi,
          topics: log.raw.topics as [Hex, ...Hex[]],
          data: log.raw.data as Hex,
        });
        out.push({ name: decoded.eventName as string, args: (decoded.args ?? {}) as Record<string, unknown> });
        break;
      } catch {
        // 이 ABI의 이벤트가 아니다. 다음 ABI를 시도한다.
      }
    }
  }
  return out;
}
```

- [ ] **Step 3: `tenderlyWebhook.ts`를 쓴다**

```ts
import { getMessaging } from 'firebase-admin/messaging';
import { onRequest } from 'firebase-functions/v2/https';
import { EVENT_STATUS_BY_CODE, identityAbi, ticketAbi, type Hex } from '@monti/shared';
import { TENDERLY_WEBHOOK_SECRET } from '../config.js';
import { deployment, publicClient } from '../lib/chain.js';
import { DEVICES, EVENT_CHATS, PERSONS, TRANSFER_INVITES, db } from '../lib/db.js';
import { decodeMontiLogs, verifyTenderlySignature, type TenderlyLog } from '../lib/tenderly.js';

async function pushCheckedIn(tokenId: bigint): Promise<void> {
  const owner = await publicClient().readContract({
    address: deployment().ticket, abi: ticketAbi, functionName: 'ownerOf', args: [tokenId],
  });
  const device = await db.collection(DEVICES).doc(owner as string).get();
  const token = device.get('pushToken') as string | undefined;
  if (!token) return;
  await getMessaging().send({
    token,
    notification: { title: '입장 완료', body: '티켓이 입장 완료로 바뀌었습니다.' },
    data: { tokenId: tokenId.toString() },
  });
}

async function markRegistered(personId: Hex): Promise<void> {
  const ref = db.collection(PERSONS).doc(personId);
  const person = await ref.get();
  if (!person.exists || person.get('status') === 'active') return;
  await ref.set({ status: 'active' }, { merge: true });
}

async function dropChatMemberIfTicketless(from: Hex, tokenId: bigint): Promise<void> {
  if (from === '0x0000000000000000000000000000000000000000') return;
  const contracts = deployment();
  const eventId = await publicClient().readContract({
    address: contracts.ticket, abi: ticketAbi, functionName: 'eventOf', args: [tokenId],
  });
  const remaining = await publicClient().readContract({
    address: contracts.ticket, abi: ticketAbi, functionName: 'balanceOfEvent', args: [from, eventId as bigint],
  });
  if ((remaining as bigint) > 0n) return;
  const members = await db
    .collection(`${EVENT_CHATS}/${String(eventId)}/members`)
    .where('account', '==', from)
    .get();
  await Promise.all(members.docs.map((doc) => doc.ref.delete()));
}

export const tenderlyWebhook = onRequest(
  { secrets: [TENDERLY_WEBHOOK_SECRET], cors: false, invoker: 'public' },
  async (req, res) => {
    const raw = req.rawBody?.toString('utf8') ?? '';
    const ok = verifyTenderlySignature({
      raw,
      signature: String(req.get('X-Tenderly-Signature') ?? ''),
      date: String(req.get('Date') ?? ''),
      secret: TENDERLY_WEBHOOK_SECRET.value(),
    });
    if (!ok) {
      res.status(401).send('bad signature');
      return;
    }

    const body = JSON.parse(raw) as { transaction?: { logs?: TenderlyLog[] } };
    const events = decodeMontiLogs(body.transaction?.logs ?? []);

    for (const event of events) {
      switch (event.name) {
        case 'CheckedIn':
          await pushCheckedIn(event.args.tokenId as bigint);
          break;
        case 'Registered':
          await markRegistered(event.args.personId as Hex);
          break;
        case 'Transfer':
          await dropChatMemberIfTicketless(event.args.from as Hex, event.args.tokenId as bigint);
          break;
        case 'OfferAccepted': {
          const invites = await db
            .collection(TRANSFER_INVITES)
            .where('commitment', '==', event.args.recipientCommitment as Hex)
            .where('status', '==', 'sent')
            .get();
          await Promise.all(invites.docs.map((doc) => doc.ref.update({ status: 'accepted' })));
          break;
        }
        case 'EventStatusChanged': {
          const eventId = String(event.args.eventId as bigint);
          const status = EVENT_STATUS_BY_CODE[Number(event.args.status)];
          if (status === 'Published') {
            const meta = await publicClient().readContract({
              address: deployment().ticket, abi: ticketAbi, functionName: 'eventMeta', args: [event.args.eventId as bigint],
            });
            await db.collection(EVENT_CHATS).doc(eventId).set(
              {
                closed: false,
                endsAt: Number((meta as { endsAt: bigint }).endsAt),
                orgId: String((meta as { orgId: bigint }).orgId),
              },
              { merge: true },
            );
          } else if (status === 'Cancelled' || status === 'Ended') {
            await db.collection(EVENT_CHATS).doc(eventId).set({ closed: true }, { merge: true });
          }
          break;
        }
        case 'AdminSet':
        case 'ManagerSet':
        case 'GateRegistered':
          // 권한 판정은 항상 eth_call 이다. 여기서는 클라이언트 캐시 무효화 신호만 남긴다.
          console.log(JSON.stringify({ cacheInvalidate: event.name, args: String(event.args.orgId ?? '') }));
          break;
        default:
          break;
      }
    }

    res.status(200).send(`ok:${events.length}`);
  },
);
```

`functions/src/index.ts`에 추가: `export { tenderlyWebhook } from './functions/tenderlyWebhook.js';`
`identityAbi` import 는 `decodeMontiLogs` 쪽에서 쓰이므로 `tenderlyWebhook.ts`에서는 제거해도 된다.

- [ ] **Step 4: 테스트를 통과시킨다**

Run: `pnpm --filter monti-functions exec vitest run test/tenderly.test.ts`
Expected: PASS — `Tests  4 passed (4)`

- [ ] **Step 5: Tenderly 알림 5개를 만든다**

Tenderly 대시보드 → 프로젝트 → Alerts → New Alert. 다섯 번 반복한다.

| Alert 이름 | Trigger | Target | Destination |
|---|---|---|---|
| monti-checked-in | Event Emitted · `CheckedIn` | `Ticket` 주소 | Webhook → `tenderlyWebhook` URL |
| monti-registered | Event Emitted · `Registered` | `Identity` 주소 | 같은 URL |
| monti-admin-set | Event Emitted · `AdminSet` | `Organizers` 주소 | 같은 URL |
| monti-manager-set | Event Emitted · `ManagerSet` | `Organizers` 주소 | 같은 URL |
| monti-gate-registered | Event Emitted · `GateRegistered` | `Organizers` 주소 | 같은 URL |

추가로 델타 이벤트 두 개: `OfferAccepted`(Ticket), `EventStatusChanged`(Ticket), 그리고 `Transfer`(Ticket).

Run:
```bash
pnpm --filter monti-functions build && firebase deploy --only functions:tenderlyWebhook --project dev
firebase functions:list --project dev | grep tenderlyWebhook
```
Expected: `tenderlyWebhook  v2  https  asia-northeast3`. 그 URL을 위 Destination에 넣고, Tenderly가 보여주는 Signing Key를 `firebase functions:secrets:set TENDERLY_WEBHOOK_SECRET`으로 저장한다.

- [ ] **Step 6: 커밋**

```bash
git add functions/src/lib/tenderly.ts functions/src/functions/tenderlyWebhook.ts functions/src/index.ts functions/test/tenderly.test.ts
git commit -m "feat(functions): dispatch Tenderly alerts to push, status and chat side effects"
```

---

## Task 29: `reconcilePending` (5분 스케줄)

**Files:**
- Create: `functions/src/functions/reconcilePending.ts`
- Test: `functions/test/reconcilePending.test.ts`

**Interfaces:**
- Consumes: Task 14 `publicClient`, `deployment`; Task 15 `assertStatusTransition`.
- Produces: scheduled `reconcilePending` — `pending`/`kyc_ok`이면서 `chain.registerTx`가 2분 넘게 미해결인 문서를 체인과 대조해 고친다(스펙 §10.4 규칙 3의 "주기적 대사 함수").

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`functions/test/reconcilePending.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getTransactionReceipt = vi.fn(async () => ({ status: 'success', blockNumber: 100n }));
const getBlock = vi.fn(async () => ({ number: 200n }));
const readContract = vi.fn(async () => '0x0000000000000000000000000000000000000000');
vi.mock('../src/lib/chain.js', () => ({
  publicClient: () => ({ getTransactionReceipt, getBlock, readContract }),
  deployment: () => ({ identity: '0x1111111111111111111111111111111111111111' }),
}));

const { db, PERSONS } = await import('../src/lib/db.js');
const { reconcilePending } = await import('../src/functions/reconcilePending.js');
const functionsTest = (await import('firebase-functions-test')).default();
const run = functionsTest.wrap(reconcilePending);

const OLD = new Date(Date.now() - 5 * 60 * 1000);
const P1 = `0x${'a1'.repeat(32)}`;
const P2 = `0x${'a2'.repeat(32)}`;
const P3 = `0x${'a3'.repeat(32)}`;

beforeEach(async () => {
  getTransactionReceipt.mockResolvedValue({ status: 'success', blockNumber: 100n });
  readContract.mockResolvedValue('0x0000000000000000000000000000000000000000');
  const snap = await db.collection(PERSONS).get();
  await Promise.all(snap.docs.map((d) => d.ref.delete()));
});

describe('reconcilePending', () => {
  it('promotes a kyc_ok person whose register tx is finalized', async () => {
    await db.collection(PERSONS).doc(P1).set({ status: 'kyc_ok', chain: { registerTx: '0xaa' }, updatedAt: OLD });
    await run({} as never);
    const person = await db.collection(PERSONS).doc(P1).get();
    expect(person.get('status')).toBe('active');
    expect(person.get('chain.block')).toBe(100);
  });

  it('clears a dropped transaction so the client can retry', async () => {
    getTransactionReceipt.mockRejectedValue(new Error('not found'));
    await db.collection(PERSONS).doc(P2).set({ status: 'kyc_ok', chain: { registerTx: '0xbb' }, updatedAt: OLD });
    await run({} as never);
    const person = await db.collection(PERSONS).doc(P2).get();
    expect(person.get('status')).toBe('kyc_ok');
    expect(person.get('chain.registerTx')).toBeUndefined();
  });

  it('repairs a person the chain already knows even with no stored tx', async () => {
    readContract.mockResolvedValue('0x9999999999999999999999999999999999999999');
    await db.collection(PERSONS).doc(P3).set({ status: 'kyc_ok', updatedAt: OLD });
    await run({} as never);
    expect((await db.collection(PERSONS).doc(P3).get()).get('status')).toBe('active');
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `firebase emulators:exec --only firestore "pnpm --filter monti-functions exec vitest run test/reconcilePending.test.ts"`
Expected: FAIL — `Failed to resolve import "../src/functions/reconcilePending.js"`

- [ ] **Step 3: `reconcilePending.ts`를 쓴다**

```ts
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { identityAbi, type Hex } from '@monti/shared';
import { deployment, publicClient } from '../lib/chain.js';
import { PERSONS, assertStatusTransition, db } from '../lib/db.js';

const ZERO = '0x0000000000000000000000000000000000000000';
const STALE_MS = 2 * 60 * 1000;

export const reconcilePending = onSchedule(
  { schedule: 'every 5 minutes', timeZone: 'Asia/Seoul', timeoutSeconds: 300 },
  async () => {
    const cutoff = Timestamp.fromMillis(Date.now() - STALE_MS);
    const snapshot = await db
      .collection(PERSONS)
      .where('status', 'in', ['pending', 'kyc_ok'])
      .where('updatedAt', '<', cutoff)
      .limit(100)
      .get();

    const pc = publicClient();
    const identity = deployment().identity;

    for (const doc of snapshot.docs) {
      const status = doc.get('status') as 'pending' | 'kyc_ok';
      const txHash = doc.get('chain.registerTx') as Hex | undefined;

      if (txHash) {
        const receipt = await pc.getTransactionReceipt({ hash: txHash }).catch(() => null);
        if (!receipt) {
          // 드롭된 트랜잭션. 잠금을 풀어 클라이언트가 다시 시도할 수 있게 한다.
          await doc.ref.set(
            { chain: { registerTx: FieldValue.delete(), registerPending: FieldValue.delete() } },
            { merge: true },
          );
          continue;
        }
        if (receipt.status !== 'success') {
          await doc.ref.set(
            { chain: { registerTx: FieldValue.delete(), registerPending: FieldValue.delete(), lastFailedTx: txHash } },
            { merge: true },
          );
          continue;
        }
        const finalized = await pc.getBlock({ blockTag: 'finalized' });
        if ((finalized.number ?? 0n) < receipt.blockNumber) continue;
        if (status !== 'kyc_ok') continue;
        assertStatusTransition(status, 'active');
        await doc.ref.set(
          { status: 'active', chain: { block: Number(receipt.blockNumber) }, updatedAt: FieldValue.serverTimestamp() },
          { merge: true },
        );
        continue;
      }

      // 트랜잭션 기록이 없어도 체인이 이미 알고 있으면 DB를 맞춘다.
      if (status !== 'kyc_ok') continue;
      const onChain = await pc.readContract({
        address: identity, abi: identityAbi, functionName: 'accountOf', args: [doc.id as Hex],
      });
      if (onChain === ZERO) continue;
      assertStatusTransition(status, 'active');
      await doc.ref.set({ status: 'active', updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    }
  },
);
```

`functions/src/index.ts`에 추가: `export { reconcilePending } from './functions/reconcilePending.js';`

- [ ] **Step 4: 테스트를 통과시킨다**

Run: `firebase emulators:exec --only firestore "pnpm --filter monti-functions exec vitest run test/reconcilePending.test.ts"`
Expected: PASS — `Tests  3 passed (3)`

- [ ] **Step 5: 커밋**

```bash
git add functions/src/functions/reconcilePending.ts functions/src/index.ts functions/test/reconcilePending.test.ts
git commit -m "feat(functions): reconcile pending identity registrations against the chain every 5 minutes"
```

---

## Task 30: `dailyExport` (03:00 Asia/Seoul)

**Files:**
- Create: `functions/src/functions/dailyExport.ts`
- Test: `functions/test/dailyExport.test.ts`

**Interfaces:**
- Consumes: Task 22 `envioPage`; Task 14 `EXPORT_BUCKET`, `BIGQUERY_DATASET`.
- Produces:
  - `EXPORT_ENTITIES: ReadonlyArray<{ entity: string; fields: string }>` — 내보낼 Envio 엔티티 목록.
  - `toJsonl(rows: unknown[]): string`
  - scheduled `dailyExport` — `gs://{EXPORT_BUCKET}/{YYYY-MM-DD}/{entity}.jsonl` 저장 후 BigQuery 로드 잡(스펙 §10.4 "하루 한 번 인덱서 테이블 백업").

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`functions/test/dailyExport.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';

const save = vi.fn(async () => undefined);
const load = vi.fn(async () => [{ status: { state: 'DONE' } }]);
vi.mock('@google-cloud/storage', () => ({
  Storage: class { bucket() { return { file: () => ({ save }) }; } },
}));
vi.mock('@google-cloud/bigquery', () => ({
  BigQuery: class { dataset() { return { table: () => ({ load }) }; } },
}));
vi.mock('../src/lib/envio.js', () => ({
  envioPage: vi.fn(async (entity: string) =>
    entity === 'Ticket' ? [{ id: '7', eventId: '11', tier: 0 }] : [],
  ),
  envioQuery: vi.fn(),
}));

const { dailyExport, toJsonl, EXPORT_ENTITIES } = await import('../src/functions/dailyExport.js');
const functionsTest = (await import('firebase-functions-test')).default();

describe('toJsonl', () => {
  it('writes one compact JSON object per line with a trailing newline', () => {
    expect(toJsonl([{ a: 1 }, { b: 2 }])).toBe('{"a":1}\n{"b":2}\n');
    expect(toJsonl([])).toBe('');
  });
});

describe('EXPORT_ENTITIES', () => {
  it('covers every master-plan entity', () => {
    expect(EXPORT_ENTITIES.map((e) => e.entity).sort()).toEqual([
      'Admin', 'CheckIn', 'Event', 'Gate', 'IdentityAccount', 'Manager', 'Offer', 'Organizer', 'Override', 'Ticket', 'Tier',
    ]);
  });
});

describe('dailyExport', () => {
  it('uploads one file per entity and starts a BigQuery load job for non-empty ones', async () => {
    await functionsTest.wrap(dailyExport)({} as never);
    expect(save).toHaveBeenCalledTimes(EXPORT_ENTITIES.length);
    expect(load).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]![0]).toBeTypeOf('string');
  });
});
```

Run: `pnpm --filter monti-functions exec vitest run test/dailyExport.test.ts`
Expected: FAIL — `Failed to resolve import "../src/functions/dailyExport.js"`

- [ ] **Step 2: `dailyExport.ts`를 쓴다**

```ts
import { BigQuery } from '@google-cloud/bigquery';
import { Storage } from '@google-cloud/storage';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { BIGQUERY_DATASET, EXPORT_BUCKET } from '../config.js';
import { envioPage } from '../lib/envio.js';

export const EXPORT_ENTITIES = [
  { entity: 'Organizer', fields: 'id owner' },
  { entity: 'Admin', fields: 'id orgId account bits' },
  { entity: 'Manager', fields: 'id orgId account canApprove' },
  { entity: 'Gate', fields: 'id eventId account kx ky open revoked' },
  {
    entity: 'Event',
    fields:
      'id orgId titleHash descHash imageCid startsAt endsAt venueHash saleStart saleEnd transferable transferCutoffSeconds maxTransfers approvalRequired category regionCode requireKyc status',
  },
  { entity: 'Tier', fields: 'id eventId idx name priceUsdCents supply minted maxPerWallet seated' },
  { entity: 'Ticket', fields: 'id eventId tier owner transfers revoked' },
  { entity: 'CheckIn', fields: 'id gateId ts nonceHash manual txHash block' },
  { entity: 'Override', fields: 'id tokenId gateId approver role reason requested' },
  { entity: 'IdentityAccount', fields: 'id personId nickname kycLevel deviceX deviceY locked deviceUpdatedAt' },
  { entity: 'Offer', fields: 'id from commitment expiresAt status' },
] as const;

export function toJsonl(rows: readonly unknown[]): string {
  return rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length > 0 ? '\n' : '');
}

function today(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });
}

export const dailyExport = onSchedule(
  { schedule: '0 3 * * *', timeZone: 'Asia/Seoul', timeoutSeconds: 540, memory: '1GiB' },
  async () => {
    const date = today();
    const bucketName = EXPORT_BUCKET.value();
    const storage = new Storage();
    const bigquery = new BigQuery();

    for (const { entity, fields } of EXPORT_ENTITIES) {
      const rows = await envioPage<{ id: string }>(entity, fields);
      const path = `${date}/${entity}.jsonl`;
      await storage.bucket(bucketName).file(path).save(toJsonl(rows), {
        contentType: 'application/x-ndjson',
      });
      if (rows.length === 0) continue;

      const [job] = await bigquery
        .dataset(BIGQUERY_DATASET.value())
        .table(entity)
        .load(storage.bucket(bucketName).file(path), {
          sourceFormat: 'NEWLINE_DELIMITED_JSON',
          autodetect: true,
          writeDisposition: 'WRITE_TRUNCATE',
        });
      console.log(JSON.stringify({ entity, rows: rows.length, jobState: job.status?.state }));
    }
  },
);
```

`functions/src/index.ts`에 추가: `export { dailyExport } from './functions/dailyExport.js';`

- [ ] **Step 3: 버킷과 데이터셋을 만든다**

Run:
```bash
gcloud storage buckets create gs://monti-exports --location asia-northeast3 --uniform-bucket-level-access
bq --location=asia-northeast3 mk --dataset monti-dev:monti
gcloud storage buckets describe gs://monti-exports --format="value(location)"
```
Expected: `ASIA-NORTHEAST3`

- [ ] **Step 4: 테스트를 통과시킨다**

Run: `pnpm --filter monti-functions exec vitest run test/dailyExport.test.ts`
Expected: PASS — `Tests  3 passed (3)`

- [ ] **Step 5: 커밋**

```bash
git add functions/src/functions/dailyExport.ts functions/src/index.ts functions/test/dailyExport.test.ts
git commit -m "feat(functions): export Envio entities to Cloud Storage and BigQuery nightly"
```

---

## Task 31: 정합성 가드 — 스펙 §10.4를 테스트로 강제한다

**Files:**
- Create: `functions/test/consistency.test.ts`

**Interfaces:**
- Consumes: Task 15 `ALLOWED_COLLECTIONS`.
- Produces: 소스 정적 스캔 테스트 3개. 새 함수가 규칙을 어기면 CI가 막는다.

- [ ] **Step 1: 정적 스캔 테스트를 쓴다**

`functions/test/consistency.test.ts`:

```ts
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ALLOWED_COLLECTIONS } from '../src/lib/db.js';

const SRC = join(process.cwd(), 'src');

async function sourceFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) out.push(...(await sourceFiles(full)));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

async function readAll(): Promise<Array<{ file: string; text: string }>> {
  const files = await sourceFiles(SRC);
  return Promise.all(files.map(async (file) => ({ file, text: await readFile(file, 'utf8') })));
}

describe('spec §10.4 rule 1 — no chain state in Firestore', () => {
  it('only touches collections on the allowlist', async () => {
    const pattern = /\.collection\(\s*['"`]([^'"`]+)['"`]\s*\)/g;
    for (const { file, text } of await readAll()) {
      let match = pattern.exec(text);
      while (match !== null) {
        expect(ALLOWED_COLLECTIONS, `${file} writes to ${match[1]}`).toContain(match[1]);
        match = pattern.exec(text);
      }
      pattern.lastIndex = 0;
    }
  });

  it('never names a ticket, role or check-in collection anywhere', async () => {
    const forbidden = ['tickets', 'checkIns', 'checkins', 'roles', 'gates', 'events', 'admins', 'managers', 'organizers'];
    for (const { file, text } of await readAll()) {
      for (const name of forbidden) {
        expect(text, `${file} mentions collection "${name}"`).not.toMatch(
          new RegExp(`\\.(collection|doc)\\(\\s*['"\`]${name}[/'"\`]`),
        );
      }
    }
  });
});

describe('spec §10.4 rule 3 — active only after chain confirmation', () => {
  it("every file that sets status 'active' also proves it read the chain", async () => {
    for (const { file, text } of await readAll()) {
      if (!/status:\s*'active'/.test(text)) continue;
      const provesChain =
        text.includes('awaitFinalized') ||
        text.includes("blockTag: 'finalized'") ||
        text.includes('decodeMontiLogs') ||
        text.includes("functionName: 'accountOf'");
      expect(provesChain, `${file} sets status 'active' without a chain read`).toBe(true);
    }
  });

  it('never sets a paid-looking ticket or permission field on a Firestore document', async () => {
    for (const { file, text } of await readAll()) {
      for (const field of ['checkedIn:', 'permissionBits:', 'canApprove:']) {
        if (!text.includes(field)) continue;
        // invites 컬렉션에만 허용된다(수락 전 임시 데이터, 체인에 쓰이면 삭제 대상).
        expect(file, `${file} stores "${field}" outside invites`).toMatch(/invites\.ts$/);
      }
    }
  });
});

describe('gas discipline', () => {
  it('every chain write goes through sendAttesterTx, which always sets gas', async () => {
    for (const { file, text } of await readAll()) {
      if (file.endsWith('chain.ts')) continue;
      expect(text, `${file} calls writeContract directly`).not.toContain('writeContract(');
    }
    const chain = await readFile(join(SRC, 'lib', 'chain.ts'), 'utf8');
    expect(chain).toContain('gas: gasLimitFor(estimate)');
  });
});
```

- [ ] **Step 2: 실행해서 지금 상태를 본다**

Run: `pnpm --filter monti-functions exec vitest run test/consistency.test.ts`
Expected: 처음에는 FAIL 가능 — 예를 들어 `snapshot.ts writes to phoneIndex` 같은 메시지. `resolveRecipient.ts`가 `db.collection('phoneIndex')` 문자열 리터럴을 쓰고 있다면 상수 `PHONE_INDEX`로 바꾼다.

- [ ] **Step 3: 위반을 고친다**

`functions/src/functions/resolveRecipient.ts`에서 리터럴을 상수로 바꾼다:

```ts
import { PERSONS, PHONE_INDEX, db } from '../lib/db.js';
```
```ts
      const indexDoc = await db.collection(PHONE_INDEX).doc(id).get();
```

- [ ] **Step 4: 통과시킨다**

Run: `pnpm --filter monti-functions exec vitest run test/consistency.test.ts`
Expected: PASS — `Tests  5 passed (5)`

- [ ] **Step 5: 커밋**

```bash
git add functions/test/consistency.test.ts functions/src/functions/resolveRecipient.ts
git commit -m "test(functions): enforce spec 10.4 storage rules and gas discipline statically"
```

---

## Task 32: 에뮬레이터 통합 테스트 — 가입 체인 전체

**Files:**
- Create: `functions/test/integration/signup.int.test.ts`
- Modify: `functions/vitest.config.ts`

**Interfaces:**
- Consumes: Task 16~20의 모든 함수.
- Produces: `startSignup → diditWebhook → registerPasskey → registerIdentity → loginVerify` 한 줄 흐름이 에뮬레이터 위에서 실제 Firestore 문서와 상태 전이를 만드는지 확인하는 테스트.

- [ ] **Step 1: 통합 테스트를 쓴다**

`functions/test/integration/signup.int.test.ts`:

```ts
import { createHmac } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';

process.env.DIDIT_WEBHOOK_SECRET = 'whsec-int';
process.env.PHONE_INDEX_KEY = 'phone-int-key';

vi.mock('../../src/lib/didit.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/didit.js')>();
  return { ...actual, createDiditSession: vi.fn(async () => ({ sessionId: 'int-1', url: 'https://didit/int-1' })) };
});
vi.mock('../../src/lib/kms.js', () => ({
  encryptField: vi.fn(async (v: string) => `enc:${v}`),
  decryptField: vi.fn(async (v: string) => v.replace(/^enc:/, '')),
}));
const sendAttesterTx = vi.fn(async () => '0xdeadbeef' as const);
vi.mock('../../src/lib/chain.js', () => ({
  sendAttesterTx,
  awaitFinalized: vi.fn(async () => undefined),
  publicClient: () => ({
    readContract: vi.fn(async ({ functionName }: { functionName: string }) =>
      functionName === 'accountOf' ? '0x0000000000000000000000000000000000000000'
      : '0xAcc0000000000000000000000000000000000001',
    ),
    waitForTransactionReceipt: vi.fn(async () => ({ status: 'success', blockNumber: 42n })),
  }),
  deployment: () => ({ identity: '0x11', ticket: '0x33', organizers: '0x22', factory: '0x55' }),
  gasLimitFor: (n: bigint) => n,
}));

const { db, PERSONS, USERS, KYC_SESSIONS, PHONE_INDEX } = await import('../../src/lib/db.js');
const { verifyDiditSignature } = await import('../../src/lib/didit.js');
const { startSignup } = await import('../../src/functions/startSignup.js');
const { registerIdentity } = await import('../../src/functions/registerIdentity.js');
const functionsTest = (await import('firebase-functions-test')).default();

const auth = { uid: 'int-uid', token: { phone_number: '+821055556666' } };
let personId: string;

beforeAll(async () => {
  for (const collection of [PERSONS, USERS, KYC_SESSIONS, PHONE_INDEX]) {
    const snap = await db.collection(collection).get();
    await Promise.all(snap.docs.map((d) => d.ref.delete()));
  }
});

describe('signup chain on the emulator', () => {
  it('1. startSignup creates a level-0 pending person, a user and a phone index entry', async () => {
    const result = (await functionsTest.wrap(startSignup)({ data: {}, auth } as never)) as { personId: string };
    personId = result.personId;
    expect((await db.collection(PERSONS).doc(personId).get()).get('status')).toBe('pending');
    expect((await db.collection(PERSONS).doc(personId).get()).get('kycLevel')).toBe(0);
    expect((await db.collection(USERS).doc('int-uid').get()).get('personId')).toBe(personId);
    expect((await db.collection(PHONE_INDEX).get()).size).toBe(1);
  });

  it('2. the signature helper accepts what Didit would send for this person', () => {
    // 웹훅 자체는 체인에 setKycLevel 을 쓰므로 통합 테스트에서 호출하지 않는다(Task 17·44의 단위 테스트가 덮는다).
    const body = JSON.stringify({ session_id: 'int-1', status: 'Approved', vendor_data: personId });
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = createHmac('sha256', 'whsec-int').update(body, 'utf8').digest('hex');
    expect(
      verifyDiditSignature({ raw: body, signature, timestamp, secret: 'whsec-int', now: timestamp }),
    ).toBe(true);
  });

  it('3. registerIdentity promotes pending → active exactly once with kycLevel 0', async () => {
    await db.collection(PERSONS).doc(personId).set({ account: '0xAcc0000000000000000000000000000000000001' }, { merge: true });
    const call = { data: { personId, deviceX: `0x${'11'.repeat(32)}`, deviceY: `0x${'22'.repeat(32)}` }, auth };
    const first = (await functionsTest.wrap(registerIdentity)(call as never)) as { txHash: string };
    const second = (await functionsTest.wrap(registerIdentity)(call as never)) as { txHash: string };

    expect(second.txHash).toBe(first.txHash);
    expect(sendAttesterTx).toHaveBeenCalledTimes(1);
    expect(sendAttesterTx.mock.calls[0]![0].args[4]).toBe(0);

    const person = await db.collection(PERSONS).doc(personId).get();
    expect(person.get('status')).toBe('active');
    expect(person.get('kycLevel')).toBe(0);
  });
});
```

- [ ] **Step 2: vitest에 통합 테스트를 포함시킨다**

`functions/vitest.config.ts`의 `include`를 바꾼다:

```ts
    include: ['test/**/*.test.ts'],
    sequence: { concurrent: false },
```

- [ ] **Step 3: 실행한다**

Run:
```bash
pnpm --filter @monti/shared build && pnpm --filter monti-functions build
firebase emulators:exec --only firestore,auth,functions,storage \
  "pnpm --filter monti-functions exec vitest run test/integration/signup.int.test.ts"
```
Expected: PASS — `Tests  3 passed (3)`, `✔  Script exited successfully`

- [ ] **Step 4: 전체 테스트를 한 번에 돌린다**

Run: `pnpm test:shared && pnpm test:functions`
Expected: shared `Test Files  9 passed`, functions 전체 통과.

- [ ] **Step 5: 커밋**

```bash
git add functions/test/integration/signup.int.test.ts functions/vitest.config.ts
git commit -m "test(functions): add emulator integration test for the signup chain"
```

---

## Task 33: Envio 인덱서 뼈대와 `config.yaml`

**Files:**
- Create: `indexer/package.json`, `indexer/tsconfig.json`, `indexer/scripts/gen-config.mjs`, `indexer/config.yaml`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: `contracts/deployments/10143.json`(주소와 `startBlock`).
- Produces: Envio HyperIndex 프로젝트. `pnpm --filter monti-indexer envio codegen` 이 `indexer/generated`를 만들고, Task 35·36의 핸들러가 거기서 `Identity`, `Organizers`, `Ticket`, `TestHelpers`를 import 한다.

- [ ] **Step 1: 패키지를 만든다**

`indexer/package.json`:

```json
{
  "name": "monti-indexer",
  "private": true,
  "type": "module",
  "scripts": {
    "gen:config": "node scripts/gen-config.mjs",
    "codegen": "pnpm gen:config && envio codegen",
    "dev": "pnpm codegen && envio dev",
    "start": "envio start",
    "test": "vitest run"
  },
  "dependencies": {
    "@monti/shared": "workspace:*",
    "envio": "^2.22.0",
    "viem": "^2.21.0"
  },
  "devDependencies": {
    "@types/node": "^22.7.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

`indexer/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["src", "test", "generated"]
}
```

`indexer/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({ test: { environment: 'node', include: ['test/**/*.test.ts'] } });
```

- [ ] **Step 2: `config.yaml` 생성기를 쓴다**

`indexer/scripts/gen-config.mjs`:

```js
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const chainId = process.env.CHAIN_ID ?? '10143';
const deploymentPath = join(here, '..', '..', 'contracts', 'deployments', `${chainId}.json`);
const deployment = JSON.parse(await readFile(deploymentPath, 'utf8'));

const config = `# 생성 파일. 직접 고치지 말고 scripts/gen-config.mjs 를 고치세요.
name: monti
description: MONTI on-chain index (Monad ${chainId})
schema: schema.graphql
contracts:
  - name: Identity
    handler: src/EventHandlers.ts
    events:
      - event: Registered(bytes32 indexed personId, address indexed account)
      - event: AccountRotated(bytes32 indexed personId, address indexed oldAccount, address indexed newAccount)
      - event: DeviceChanged(address indexed account, bytes32 x, bytes32 y)
      - event: DeviceLocked(address indexed account, bool locked)
      - event: NicknameSet(address indexed account, bytes32 indexed nicknameHash, string nickname)
      - event: KycLevelSet(address indexed account, uint8 level)
  - name: Organizers
    handler: src/EventHandlers.ts
    events:
      - event: OrganizerCreated(uint256 indexed orgId, address indexed owner)
      - event: AdminSet(uint256 indexed orgId, address indexed admin, uint32 bits)
      - event: ManagerSet(uint256 indexed orgId, address indexed manager, bool exists, bool canApprove)
      - event: OwnerTransferred(uint256 indexed orgId, address indexed from, address indexed to)
      - event: GateRegistered(uint256 indexed gateId, uint256 indexed eventId, address indexed gateAccount, bytes32 kx, bytes32 ky)
      - event: GateRevoked(uint256 indexed gateId)
      - event: GateOpened(uint256 indexed gateId)
      - event: GateClosed(uint256 indexed gateId)
  - name: Ticket
    handler: src/EventHandlers.ts
    events:
      - event: EventCreated(uint256 indexed eventId, uint256 indexed orgId, address indexed creator)
      - event: EventStatusChanged(uint256 indexed eventId, uint8 status)
      - event: Claimed(uint256 indexed tokenId, uint256 indexed eventId, address indexed to, uint8 tier)
      - event: Transfer(address indexed from, address indexed to, uint256 indexed tokenId)
      - event: CheckedIn(uint256 indexed tokenId, uint256 indexed eventId, uint256 indexed gateId, bytes32 nonceHash, uint64 ts)
      - event: OverrideRequested(uint256 indexed tokenId, uint256 indexed gateId, address indexed requester, uint8 reason)
      - event: ManualOverride(uint256 indexed tokenId, uint256 indexed gateId, address indexed approver, uint8 role, uint8 reason)
      - event: Revoked(uint256 indexed tokenId, uint8 reason)
      - event: Migrated(uint256 indexed tokenId, address indexed from, address indexed to)
      - event: OfferCreated(uint256 indexed tokenId, address indexed from, bytes32 indexed recipientCommitment, uint64 expiresAt)
      - event: OfferCancelled(uint256 indexed tokenId)
      - event: OfferAccepted(uint256 indexed tokenId, address indexed to, bytes32 indexed recipientCommitment)
networks:
  - id: ${deployment.chainId}
    start_block: ${deployment.startBlock}
    contracts:
      - name: Identity
        address:
          - "${deployment.identity}"
      - name: Organizers
        address:
          - "${deployment.organizers}"
      - name: Ticket
        address:
          - "${deployment.ticket}"
`;

await writeFile(join(here, '..', 'config.yaml'), config, 'utf8');
console.log(`[gen-config] chain ${deployment.chainId}, start_block ${deployment.startBlock}`);
```

- [ ] **Step 3: 생성하고 codegen을 돌린다**

Run:
```bash
pnpm install
pnpm --filter monti-indexer gen:config
head -4 indexer/config.yaml
```
Expected:
```
[gen-config] chain 10143, start_block 12345678
# 생성 파일. 직접 고치지 말고 scripts/gen-config.mjs 를 고치세요.
name: monti
description: MONTI on-chain index (Monad 10143)
schema: schema.graphql
```

- [ ] **Step 4: `.gitignore`를 확인한다**

Run: `grep -n "indexer/generated" .gitignore`
Expected: `indexer/generated` 한 줄(Task 10에서 추가했다). `config.yaml`은 **커밋한다**(생성물이지만 배포 입력이다).

- [ ] **Step 5: 커밋**

```bash
git add indexer/package.json indexer/tsconfig.json indexer/vitest.config.ts \
        indexer/scripts/gen-config.mjs indexer/config.yaml pnpm-lock.yaml
git commit -m "chore(indexer): scaffold Envio HyperIndex with generated network config"
```

---

## Task 34: `schema.graphql`

**Files:**
- Create: `indexer/schema.graphql`
- Test: `indexer/test/schema.test.ts`

**Interfaces:**
- Consumes: 없음.
- Produces: 마스터 계획 "Envio entities" + 인터페이스 델타 필드. **PII 없음.** Task 22·27·30이 이 필드 이름으로 GraphQL을 던진다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`indexer/test/schema.test.ts`:

```ts
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const schemaPath = join(process.cwd(), 'schema.graphql');

describe('schema.graphql', () => {
  it('declares every master-plan entity', async () => {
    const schema = await readFile(schemaPath, 'utf8');
    for (const entity of [
      'Organizer', 'Admin', 'Manager', 'Gate', 'Event', 'Tier',
      'Ticket', 'CheckIn', 'Override', 'IdentityAccount', 'Offer',
    ]) {
      expect(schema).toMatch(new RegExp(`type ${entity}\\b`));
    }
  });

  it('carries the delta fields', async () => {
    const schema = await readFile(schemaPath, 'utf8');
    expect(schema).toContain('nickname: String');
    expect(schema).toContain('category: Int!');
    expect(schema).toContain('regionCode: String!');
    expect(schema).toContain('status: String!');
    expect(schema).toContain('requireKyc: Boolean!');
    expect(schema).toContain('kycLevel: Int!');
  });

  it('contains no personal data field', async () => {
    const schema = await readFile(schemaPath, 'utf8');
    for (const banned of ['phone', 'email', 'photo', 'firstName', 'lastName', 'documentNumber', 'personName']) {
      expect(schema.toLowerCase()).not.toContain(banned.toLowerCase());
    }
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm --filter monti-indexer exec vitest run test/schema.test.ts`
Expected: FAIL — `ENOENT ... schema.graphql`

- [ ] **Step 3: `schema.graphql`을 쓴다**

```graphql
type Organizer {
  id: ID!            # orgId
  owner: String!
}

type Admin {
  id: ID!            # orgId-account
  orgId: BigInt!
  account: String!
  bits: BigInt!
}

type Manager {
  id: ID!            # orgId-account
  orgId: BigInt!
  account: String!
  exists: Boolean!
  canApprove: Boolean!
}

type Gate {
  id: ID!            # gateId
  eventId: BigInt!
  account: String!
  kx: String!
  ky: String!
  open: Boolean!
  revoked: Boolean!
}

type Event {
  id: ID!            # eventId
  orgId: BigInt!
  creator: String!
  titleHash: String!
  descHash: String!
  imageCid: String!
  startsAt: BigInt!
  endsAt: BigInt!
  venueHash: String!
  saleStart: BigInt!
  saleEnd: BigInt!
  transferable: Boolean!
  transferCutoffSeconds: BigInt!
  maxTransfers: Int!
  approvalRequired: Boolean!
  category: Int!
  regionCode: String!
  status: String!    # Draft | Published | Cancelled | Ended
  requireKyc: Boolean!
}

type Tier {
  id: ID!            # eventId-idx
  eventId: BigInt!
  idx: Int!
  name: String!
  priceUsdCents: BigInt!
  supply: BigInt!
  minted: BigInt!
  maxPerWallet: BigInt!
  seated: Boolean!
}

type Ticket {
  id: ID!            # tokenId
  eventId: BigInt!
  tier: Int!
  owner: String!
  transfers: Int!
  revoked: Boolean!
  checkIn: CheckIn
  identity: IdentityAccount
}

type CheckIn {
  id: ID!            # tokenId
  gateId: BigInt!
  ts: BigInt!
  nonceHash: String!
  manual: Boolean!
  txHash: String!
  block: BigInt!
}

type Override {
  id: ID!            # txHash-logIndex
  tokenId: BigInt!
  gateId: BigInt!
  approver: String!
  role: Int!
  reason: Int!
  requested: Boolean!
}

type IdentityAccount {
  id: ID!            # account address
  personId: String!
  nickname: String
  kycLevel: Int!     # 0 = phone only, 1 = ID + face verified
  deviceX: String!
  deviceY: String!
  locked: Boolean!
  deviceUpdatedAt: BigInt!
}

type Offer {
  id: ID!            # tokenId
  from: String!
  commitment: String!
  expiresAt: BigInt!
  status: String!    # open | cancelled | accepted
}
```

- [ ] **Step 4: 테스트를 통과시키고 codegen을 돌린다**

Run:
```bash
pnpm --filter monti-indexer exec vitest run test/schema.test.ts
pnpm --filter monti-indexer codegen
ls indexer/generated/src | head -3
```
Expected: `Tests  3 passed (3)`, codegen 성공, `generated/src` 에 파일 목록.

- [ ] **Step 5: 커밋**

```bash
git add indexer/schema.graphql indexer/test/schema.test.ts
git commit -m "feat(indexer): define chain entities with no personal data"
```

---

## Task 35: `Identity`와 `Organizers` 핸들러

**Files:**
- Create: `indexer/src/EventHandlers.ts`
- Test: `indexer/test/identity.test.ts`

**Interfaces:**
- Consumes: Task 34의 생성 타입.
- Produces: `Identity.Registered`, `Identity.AccountRotated`, `Identity.DeviceChanged`, `Identity.DeviceLocked`, `Identity.NicknameSet`, `Organizers.*` 핸들러.

**주의 1:** `Registered` 이벤트는 `deviceX`·`deviceY`를 싣지 않는다. 따라서 `IdentityAccount`는 0으로 시작하고 `DeviceChanged`가 채운다. sub-plan 01이 `register()`에서 `DeviceChanged`를 함께 emit 하면 첫 블록부터 값이 맞는다(Self-Review에 기록).

**주의 2 (창업자 델타):** `register(…, kycLevel)` 의 다섯 번째 인자도 `Registered` 이벤트에 없다. **sub-plan 01이 `register()` 안에서도 `KycLevelSet(account, level)` 을 emit 하기로 했다.** 따라서 인덱서는 트랜잭션 입력을 디코드하지 않고 `KycLevelSet` 하나만 구독하면 된다. `Registered` 는 `kycLevel: 0` 으로 시작하고, 같은 트랜잭션의 `KycLevelSet` 이 즉시 실제 값으로 덮는다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`indexer/test/identity.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { Identity, Organizers, TestHelpers } from 'generated';

const { MockDb } = TestHelpers;
const ACCOUNT = '0x0000000000000000000000000000000000000001';

describe('Identity handlers', () => {
  it('creates an IdentityAccount on Registered with zero device keys', async () => {
    const mockDb = MockDb.createMockDb();
    const event = Identity.Registered.createMockEvent({ personId: `0x${'aa'.repeat(32)}`, account: ACCOUNT });
    const after = await Identity.Registered.processEvent({ event, mockDb });

    const stored = after.entities.IdentityAccount.get(ACCOUNT);
    expect(stored?.personId).toBe(`0x${'aa'.repeat(32)}`);
    expect(stored?.deviceX).toBe(`0x${'00'.repeat(32)}`);
    expect(stored?.locked).toBe(false);
    expect(stored?.nickname).toBeUndefined();
    expect(stored?.kycLevel).toBe(0);
  });

  it('raises kycLevel to 1 on KycLevelSet', async () => {
    let mockDb = MockDb.createMockDb();
    mockDb = await Identity.Registered.processEvent({
      event: Identity.Registered.createMockEvent({ personId: `0x${'aa'.repeat(32)}`, account: ACCOUNT }),
      mockDb,
    });
    const after = await Identity.KycLevelSet.processEvent({
      event: Identity.KycLevelSet.createMockEvent({ account: ACCOUNT, level: 1 }),
      mockDb,
    });
    expect(after.entities.IdentityAccount.get(ACCOUNT)?.kycLevel).toBe(1);
  });

  it('fills the device keys on DeviceChanged and records deviceUpdatedAt', async () => {
    let mockDb = MockDb.createMockDb();
    mockDb = await Identity.Registered.processEvent({
      event: Identity.Registered.createMockEvent({ personId: `0x${'aa'.repeat(32)}`, account: ACCOUNT }),
      mockDb,
    });
    const event = Identity.DeviceChanged.createMockEvent({
      account: ACCOUNT, x: `0x${'11'.repeat(32)}`, y: `0x${'22'.repeat(32)}`,
    });
    const after = await Identity.DeviceChanged.processEvent({ event, mockDb });

    const stored = after.entities.IdentityAccount.get(ACCOUNT);
    expect(stored?.deviceX).toBe(`0x${'11'.repeat(32)}`);
    expect(stored?.deviceY).toBe(`0x${'22'.repeat(32)}`);
    expect(stored?.deviceUpdatedAt).toBeGreaterThan(0n);
  });

  it('stores the nickname on NicknameSet', async () => {
    let mockDb = MockDb.createMockDb();
    mockDb = await Identity.Registered.processEvent({
      event: Identity.Registered.createMockEvent({ personId: `0x${'aa'.repeat(32)}`, account: ACCOUNT }),
      mockDb,
    });
    const after = await Identity.NicknameSet.processEvent({
      event: Identity.NicknameSet.createMockEvent({
        account: ACCOUNT, nicknameHash: `0x${'bb'.repeat(32)}`, nickname: 'alex',
      }),
      mockDb,
    });
    expect(after.entities.IdentityAccount.get(ACCOUNT)?.nickname).toBe('alex');
  });
});

describe('Organizers handlers', () => {
  it('records a gate as open only after GateOpened', async () => {
    let mockDb = MockDb.createMockDb();
    mockDb = await Organizers.GateRegistered.processEvent({
      event: Organizers.GateRegistered.createMockEvent({
        gateId: 3n, eventId: 11n, gateAccount: ACCOUNT, kx: `0x${'11'.repeat(32)}`, ky: `0x${'22'.repeat(32)}`,
      }),
      mockDb,
    });
    expect(mockDb.entities.Gate.get('3')?.open).toBe(false);

    const after = await Organizers.GateOpened.processEvent({
      event: Organizers.GateOpened.createMockEvent({ gateId: 3n }),
      mockDb,
    });
    expect(after.entities.Gate.get('3')?.open).toBe(true);
  });

  it('stores manager flags on ManagerSet', async () => {
    const mockDb = MockDb.createMockDb();
    const after = await Organizers.ManagerSet.processEvent({
      event: Organizers.ManagerSet.createMockEvent({ orgId: 1n, manager: ACCOUNT, exists: true, canApprove: true }),
      mockDb,
    });
    const stored = after.entities.Manager.get(`1-${ACCOUNT}`);
    expect(stored).toMatchObject({ orgId: 1n, account: ACCOUNT, exists: true, canApprove: true });
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm --filter monti-indexer exec vitest run test/identity.test.ts`
Expected: FAIL — 핸들러가 없어 엔티티가 `undefined`.

- [ ] **Step 3: `EventHandlers.ts`의 Identity·Organizers 절을 쓴다**

```ts
import { Identity, Organizers } from 'generated';

const ZERO32 = `0x${'00'.repeat(32)}`;

Identity.Registered.handler(async ({ event, context }) => {
  context.IdentityAccount.set({
    id: event.params.account,
    personId: event.params.personId,
    nickname: undefined,
    kycLevel: 0, // 같은 트랜잭션의 KycLevelSet 이 실제 값으로 덮는다
    deviceX: ZERO32,
    deviceY: ZERO32,
    locked: false,
    deviceUpdatedAt: 0n,
  });
});

Identity.KycLevelSet.handler(async ({ event, context }) => {
  const current = await context.IdentityAccount.get(event.params.account);
  if (!current) return;
  context.IdentityAccount.set({ ...current, kycLevel: Number(event.params.level) });
});

Identity.AccountRotated.handler(async ({ event, context }) => {
  const old = await context.IdentityAccount.get(event.params.oldAccount);
  context.IdentityAccount.set({
    id: event.params.newAccount,
    personId: event.params.personId,
    nickname: old?.nickname,
    kycLevel: old?.kycLevel ?? 0,
    deviceX: old?.deviceX ?? ZERO32,
    deviceY: old?.deviceY ?? ZERO32,
    locked: false,
    deviceUpdatedAt: BigInt(event.block.timestamp),
  });
});

Identity.DeviceChanged.handler(async ({ event, context }) => {
  const current = await context.IdentityAccount.get(event.params.account);
  if (!current) return;
  context.IdentityAccount.set({
    ...current,
    deviceX: event.params.x,
    deviceY: event.params.y,
    deviceUpdatedAt: BigInt(event.block.timestamp),
  });
});

Identity.DeviceLocked.handler(async ({ event, context }) => {
  const current = await context.IdentityAccount.get(event.params.account);
  if (!current) return;
  context.IdentityAccount.set({ ...current, locked: event.params.locked });
});

Identity.NicknameSet.handler(async ({ event, context }) => {
  const current = await context.IdentityAccount.get(event.params.account);
  if (!current) return;
  context.IdentityAccount.set({ ...current, nickname: event.params.nickname });
});

Organizers.OrganizerCreated.handler(async ({ event, context }) => {
  context.Organizer.set({ id: event.params.orgId.toString(), owner: event.params.owner });
});

Organizers.OwnerTransferred.handler(async ({ event, context }) => {
  context.Organizer.set({ id: event.params.orgId.toString(), owner: event.params.to });
});

Organizers.AdminSet.handler(async ({ event, context }) => {
  context.Admin.set({
    id: `${event.params.orgId}-${event.params.admin}`,
    orgId: event.params.orgId,
    account: event.params.admin,
    bits: BigInt(event.params.bits),
  });
});

Organizers.ManagerSet.handler(async ({ event, context }) => {
  context.Manager.set({
    id: `${event.params.orgId}-${event.params.manager}`,
    orgId: event.params.orgId,
    account: event.params.manager,
    exists: event.params.exists,
    canApprove: event.params.canApprove,
  });
});

Organizers.GateRegistered.handler(async ({ event, context }) => {
  context.Gate.set({
    id: event.params.gateId.toString(),
    eventId: event.params.eventId,
    account: event.params.gateAccount,
    kx: event.params.kx,
    ky: event.params.ky,
    open: false,
    revoked: false,
  });
});

async function setGateFlag(
  context: { Gate: { get: (id: string) => Promise<unknown>; set: (entity: unknown) => void } },
  gateId: bigint,
  patch: { open?: boolean; revoked?: boolean },
): Promise<void> {
  const current = (await context.Gate.get(gateId.toString())) as Record<string, unknown> | undefined;
  if (!current) return;
  context.Gate.set({ ...current, ...patch });
}

Organizers.GateOpened.handler(async ({ event, context }) => {
  await setGateFlag(context, event.params.gateId, { open: true });
});

Organizers.GateClosed.handler(async ({ event, context }) => {
  await setGateFlag(context, event.params.gateId, { open: false });
});

Organizers.GateRevoked.handler(async ({ event, context }) => {
  await setGateFlag(context, event.params.gateId, { revoked: true, open: false });
});
```

- [ ] **Step 4: 테스트를 통과시킨다**

Run:
```bash
pnpm --filter monti-indexer codegen
pnpm --filter monti-indexer exec vitest run test/identity.test.ts
```
Expected: PASS — `Tests  6 passed (6)`

- [ ] **Step 5: 커밋**

```bash
git add indexer/src/EventHandlers.ts indexer/test/identity.test.ts
git commit -m "feat(indexer): index identity, nickname, organizer and gate events"
```

---

## Task 36: `Ticket` 핸들러 (이벤트, 티어, 티켓, 체크인, 오퍼)

**Files:**
- Modify: `indexer/src/EventHandlers.ts`
- Test: `indexer/test/ticket.test.ts`

**Interfaces:**
- Consumes: Task 35의 같은 파일; `@monti/shared`의 `ticketAbi`, `EVENT_STATUS_BY_CODE`, `getDeployment`.
- Produces: `Ticket.EventCreated`, `EventStatusChanged`, `Claimed`, `Transfer`, `CheckedIn`, `OverrideRequested`, `ManualOverride`, `Revoked`, `Migrated`, `OfferCreated`, `OfferCancelled`, `OfferAccepted` 핸들러.

**메타데이터 조회:** `EventCreated`는 `(eventId, orgId, creator)`만 싣는다. 나머지 필드는 핸들러 안에서 viem `readContract(ticket.eventMeta)`·`ticket.tiers`로 한 번 읽는다. 이벤트 생성은 드물어 동기화 속도에 영향이 없다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`indexer/test/ticket.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { Ticket, TestHelpers } from 'generated';

const { MockDb } = TestHelpers;
const A = '0x000000000000000000000000000000000000000a';
const B = '0x000000000000000000000000000000000000000b';
const ZERO = '0x0000000000000000000000000000000000000000';

async function claimed(mockDb: ReturnType<typeof MockDb.createMockDb>) {
  return Ticket.Claimed.processEvent({
    event: Ticket.Claimed.createMockEvent({ tokenId: 7n, eventId: 11n, to: A, tier: 1 }),
    mockDb,
  });
}

describe('Ticket handlers', () => {
  it('creates a ticket on Claimed', async () => {
    const after = await claimed(MockDb.createMockDb());
    expect(after.entities.Ticket.get('7')).toMatchObject({
      eventId: 11n, tier: 1, owner: A, transfers: 0, revoked: false,
    });
  });

  it('counts a real transfer but not the mint', async () => {
    let mockDb = await claimed(MockDb.createMockDb());
    mockDb = await Ticket.Transfer.processEvent({
      event: Ticket.Transfer.createMockEvent({ from: ZERO, to: A, tokenId: 7n }),
      mockDb,
    });
    expect(mockDb.entities.Ticket.get('7')?.transfers).toBe(0);

    const after = await Ticket.Transfer.processEvent({
      event: Ticket.Transfer.createMockEvent({ from: A, to: B, tokenId: 7n }),
      mockDb,
    });
    expect(after.entities.Ticket.get('7')).toMatchObject({ owner: B, transfers: 1 });
  });

  it('records a CheckIn keyed by tokenId with tx hash and block', async () => {
    const mockDb = await claimed(MockDb.createMockDb());
    const after = await Ticket.CheckedIn.processEvent({
      event: Ticket.CheckedIn.createMockEvent({
        tokenId: 7n, eventId: 11n, gateId: 3n, nonceHash: `0x${'11'.repeat(32)}`, ts: 1_789_862_400n,
      }),
      mockDb,
    });
    const checkIn = after.entities.CheckIn.get('7');
    expect(checkIn).toMatchObject({ gateId: 3n, ts: 1_789_862_400n, manual: false });
    expect(checkIn?.txHash).toBeTypeOf('string');
    expect(after.entities.Ticket.get('7')?.checkIn_id).toBe('7');
  });

  it('tracks an offer through open → accepted', async () => {
    let mockDb = await claimed(MockDb.createMockDb());
    mockDb = await Ticket.OfferCreated.processEvent({
      event: Ticket.OfferCreated.createMockEvent({
        tokenId: 7n, from: A, recipientCommitment: `0x${'cc'.repeat(32)}`, expiresAt: 1_789_862_400n,
      }),
      mockDb,
    });
    expect(mockDb.entities.Offer.get('7')?.status).toBe('open');

    const after = await Ticket.OfferAccepted.processEvent({
      event: Ticket.OfferAccepted.createMockEvent({ tokenId: 7n, to: B, recipientCommitment: `0x${'cc'.repeat(32)}` }),
      mockDb,
    });
    expect(after.entities.Offer.get('7')?.status).toBe('accepted');
  });

  it('maps EventStatusChanged codes to names', async () => {
    let mockDb = MockDb.createMockDb();
    mockDb.entities.Event.set({
      id: '11', orgId: 1n, creator: A, titleHash: `0x${'00'.repeat(32)}`, descHash: `0x${'00'.repeat(32)}`,
      imageCid: '', startsAt: 0n, endsAt: 0n, venueHash: `0x${'00'.repeat(32)}`, saleStart: 0n, saleEnd: 0n,
      transferable: true, transferCutoffSeconds: 0n, maxTransfers: 0, approvalRequired: false,
      category: 0, regionCode: `0x${'00'.repeat(32)}`, requireKyc: false, status: 'Draft',
    });
    const after = await Ticket.EventStatusChanged.processEvent({
      event: Ticket.EventStatusChanged.createMockEvent({ eventId: 11n, status: 1 }),
      mockDb,
    });
    expect(after.entities.Event.get('11')?.status).toBe('Published');
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm --filter monti-indexer exec vitest run test/ticket.test.ts`
Expected: FAIL — 엔티티가 `undefined`.

- [ ] **Step 3: `EventHandlers.ts`에 Ticket 절을 추가한다**

파일 맨 위 import를 바꾼다:

```ts
import { Identity, Organizers, Ticket } from 'generated';
import { createPublicClient, http } from 'viem';
import { EVENT_STATUS_BY_CODE, getDeployment, ticketAbi } from '@monti/shared';
```

파일 끝에 추가:

```ts
const deployment = getDeployment(Number(process.env.CHAIN_ID ?? 10143));
const rpc = createPublicClient({
  transport: http(process.env.RPC_URL ?? 'https://testnet-rpc.monad.xyz'),
});

Ticket.EventCreated.handler(async ({ event, context }) => {
  const meta = await rpc.readContract({
    address: deployment.ticket, abi: ticketAbi, functionName: 'eventMeta', args: [event.params.eventId],
  });
  context.Event.set({
    id: event.params.eventId.toString(),
    orgId: event.params.orgId,
    creator: event.params.creator,
    titleHash: meta.titleHash,
    descHash: meta.descHash,
    imageCid: meta.imageCid,
    startsAt: meta.startsAt,
    endsAt: meta.endsAt,
    venueHash: meta.venueHash,
    saleStart: meta.saleStart,
    saleEnd: meta.saleEnd,
    transferable: meta.transferable,
    transferCutoffSeconds: BigInt(meta.transferCutoffSeconds),
    maxTransfers: meta.maxTransfers,
    approvalRequired: meta.approvalRequired,
    category: meta.category,
    regionCode: meta.regionCode,
    requireKyc: meta.requireKyc,
    status: 'Draft',
  });
});

Ticket.EventStatusChanged.handler(async ({ event, context }) => {
  const current = await context.Event.get(event.params.eventId.toString());
  if (!current) return;
  context.Event.set({ ...current, status: EVENT_STATUS_BY_CODE[Number(event.params.status)] ?? 'Draft' });
});

Ticket.Claimed.handler(async ({ event, context }) => {
  context.Ticket.set({
    id: event.params.tokenId.toString(),
    eventId: event.params.eventId,
    tier: event.params.tier,
    owner: event.params.to,
    transfers: 0,
    revoked: false,
    checkIn_id: undefined,
    identity_id: event.params.to,
  });
});

Ticket.Transfer.handler(async ({ event, context }) => {
  const current = await context.Ticket.get(event.params.tokenId.toString());
  if (!current) return; // 민팅은 Claimed 가 먼저 만든다
  const isMint = event.params.from === '0x0000000000000000000000000000000000000000';
  context.Ticket.set({
    ...current,
    owner: event.params.to,
    identity_id: event.params.to,
    transfers: isMint ? current.transfers : current.transfers + 1,
  });
});

Ticket.CheckedIn.handler(async ({ event, context }) => {
  const id = event.params.tokenId.toString();
  context.CheckIn.set({
    id,
    gateId: event.params.gateId,
    ts: event.params.ts,
    nonceHash: event.params.nonceHash,
    manual: false,
    txHash: event.transaction.hash,
    block: BigInt(event.block.number),
  });
  const ticket = await context.Ticket.get(id);
  if (ticket) context.Ticket.set({ ...ticket, checkIn_id: id });
});

Ticket.ManualOverride.handler(async ({ event, context }) => {
  const id = event.params.tokenId.toString();
  context.Override.set({
    id: `${event.transaction.hash}-${event.logIndex}`,
    tokenId: event.params.tokenId,
    gateId: event.params.gateId,
    approver: event.params.approver,
    role: event.params.role,
    reason: event.params.reason,
    requested: false,
  });
  context.CheckIn.set({
    id,
    gateId: event.params.gateId,
    ts: BigInt(event.block.timestamp),
    nonceHash: `0x${'00'.repeat(32)}`,
    manual: true,
    txHash: event.transaction.hash,
    block: BigInt(event.block.number),
  });
  const ticket = await context.Ticket.get(id);
  if (ticket) context.Ticket.set({ ...ticket, checkIn_id: id });
});

Ticket.OverrideRequested.handler(async ({ event, context }) => {
  context.Override.set({
    id: `${event.transaction.hash}-${event.logIndex}`,
    tokenId: event.params.tokenId,
    gateId: event.params.gateId,
    approver: event.params.requester,
    role: 0,
    reason: event.params.reason,
    requested: true,
  });
});

Ticket.Revoked.handler(async ({ event, context }) => {
  const current = await context.Ticket.get(event.params.tokenId.toString());
  if (!current) return;
  context.Ticket.set({ ...current, revoked: true });
});

Ticket.Migrated.handler(async ({ event, context }) => {
  const current = await context.Ticket.get(event.params.tokenId.toString());
  if (!current) return;
  context.Ticket.set({ ...current, owner: event.params.to, identity_id: event.params.to });
});

Ticket.OfferCreated.handler(async ({ event, context }) => {
  context.Offer.set({
    id: event.params.tokenId.toString(),
    from: event.params.from,
    commitment: event.params.recipientCommitment,
    expiresAt: event.params.expiresAt,
    status: 'open',
  });
});

Ticket.OfferCancelled.handler(async ({ event, context }) => {
  const current = await context.Offer.get(event.params.tokenId.toString());
  if (!current) return;
  context.Offer.set({ ...current, status: 'cancelled' });
});

Ticket.OfferAccepted.handler(async ({ event, context }) => {
  const current = await context.Offer.get(event.params.tokenId.toString());
  if (!current) return;
  context.Offer.set({ ...current, status: 'accepted' });
});
```

- [ ] **Step 4: 테스트를 통과시킨다**

Run: `pnpm --filter monti-indexer exec vitest run test/ticket.test.ts`
Expected: PASS — `Tests  5 passed (5)`

- [ ] **Step 5: 커밋**

```bash
git add indexer/src/EventHandlers.ts indexer/test/ticket.test.ts
git commit -m "feat(indexer): index events, tickets, check-ins, overrides and offers"
```

---

## Task 37: `Tier` 백필과 로컬 인덱서 실행 검증

**Files:**
- Modify: `indexer/src/EventHandlers.ts`, `packages/shared/src/abi.ts`
- Test: `indexer/test/tier.test.ts`

**Interfaces:**
- Consumes: Task 36의 `EventCreated` 핸들러.
- Produces: `Tier` 엔티티 백필(`ticket.tiers(eventId)` 한 번 읽어 `eventId-idx`로 저장). 그리고 테스트넷 대상 로컬 실행이 실제로 동기화되는지 확인.

- [ ] **Step 1: `ticketAbi`에 `tiers`를 추가한다**

`packages/shared/src/abi.ts`의 `ticketAbi` 배열에서 `eventStatus` 항목 바로 뒤에 넣는다:

```ts
  {
    type: 'function',
    name: 'tiers',
    stateMutability: 'view',
    inputs: [{ name: 'eventId', type: 'uint256' }],
    outputs: [
      {
        name: '',
        type: 'tuple[]',
        components: [
          { name: 'name', type: 'string' },
          { name: 'priceUsdCents', type: 'uint256' },
          { name: 'supply', type: 'uint32' },
          { name: 'minted', type: 'uint32' },
          { name: 'maxPerWallet', type: 'uint16' },
          { name: 'seated', type: 'bool' },
        ],
      },
    ],
  },
```

- [ ] **Step 2: 실패하는 테스트를 쓴다**

`indexer/test/tier.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';

const readContract = vi.fn(async ({ functionName }: { functionName: string }) =>
  functionName === 'eventMeta'
    ? {
        orgId: 1n, titleHash: `0x${'00'.repeat(32)}`, descHash: `0x${'00'.repeat(32)}`, imageCid: 'cid',
        startsAt: 1n, endsAt: 2n, venueHash: `0x${'00'.repeat(32)}`, saleStart: 0n, saleEnd: 0n,
        transferable: true, transferCutoffSeconds: 3600, maxTransfers: 2, approvalRequired: false,
        category: 1, regionCode: `0x${'00'.repeat(32)}`, requireKyc: true,
      }
    : [
        { name: '일반', priceUsdCents: 0n, supply: 100, minted: 0, maxPerWallet: 2, seated: false },
        { name: 'VIP', priceUsdCents: 5000n, supply: 10, minted: 0, maxPerWallet: 1, seated: true },
      ],
);
vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>();
  return { ...actual, createPublicClient: () => ({ readContract }) };
});

const { Ticket, TestHelpers } = await import('generated');
const { MockDb } = TestHelpers;

describe('Tier backfill', () => {
  it('writes one Tier entity per tier with id eventId-idx', async () => {
    const after = await Ticket.EventCreated.processEvent({
      event: Ticket.EventCreated.createMockEvent({
        eventId: 11n, orgId: 1n, creator: '0x000000000000000000000000000000000000000a',
      }),
      mockDb: MockDb.createMockDb(),
    });

    expect(after.entities.Event.get('11')).toMatchObject({ imageCid: 'cid', category: 1, requireKyc: true, status: 'Draft' });
    expect(after.entities.Tier.get('11-0')).toMatchObject({
      eventId: 11n, idx: 0, name: '일반', priceUsdCents: 0n, supply: 100n, maxPerWallet: 2n, seated: false,
    });
    expect(after.entities.Tier.get('11-1')).toMatchObject({ idx: 1, name: 'VIP', seated: true });
  });
});
```

Run: `pnpm --filter monti-indexer exec vitest run test/tier.test.ts`
Expected: FAIL — `after.entities.Tier.get('11-0')` 가 `undefined`.

- [ ] **Step 3: `EventCreated` 핸들러에 Tier 백필을 더한다**

`Ticket.EventCreated.handler` 안, `context.Event.set({...})` 뒤에 추가한다:

```ts
  const tiers = await rpc.readContract({
    address: deployment.ticket, abi: ticketAbi, functionName: 'tiers', args: [event.params.eventId],
  });
  tiers.forEach((tier, idx) => {
    context.Tier.set({
      id: `${event.params.eventId}-${idx}`,
      eventId: event.params.eventId,
      idx,
      name: tier.name,
      priceUsdCents: tier.priceUsdCents,
      supply: BigInt(tier.supply),
      minted: BigInt(tier.minted),
      maxPerWallet: BigInt(tier.maxPerWallet),
      seated: tier.seated,
    });
  });
```

- [ ] **Step 4: 테스트를 통과시킨다**

Run:
```bash
pnpm --filter @monti/shared build
pnpm --filter monti-indexer codegen
pnpm --filter monti-indexer exec vitest run
```
Expected: `Test Files  4 passed (4)` — schema, identity, ticket, tier.

- [ ] **Step 5: 테스트넷에 대고 로컬로 돌린다**

Run:
```bash
cd indexer && RPC_URL=https://testnet-rpc.monad.xyz pnpm dev
```
Expected: 로그에 `Starting Envio indexer`, 그리고 `Synced to block <n>` 가 증가. Hasura 콘솔이 `http://localhost:8080`에 뜬다.

다른 터미널에서 확인한다:
```bash
curl -s http://127.0.0.1:8080/v1/graphql -H 'content-type: application/json' \
  -d '{"query":"{ Ticket(limit: 5) { id eventId owner tier } CheckIn(limit: 5) { id gateId ts } }"}' | head -20
```
Expected: `{"data":{"Ticket":[...],"CheckIn":[...]}}`. sub-plan 01의 `Seed.s.sol`을 돌린 뒤라면 행이 있고, 아니면 빈 배열(정상).

- [ ] **Step 6: Functions가 인덱서를 읽는지 확인한다**

Run:
```bash
ENVIO_GRAPHQL_URL=http://127.0.0.1:8080/v1/graphql \
  pnpm --filter monti-functions exec tsx -e "
import { envioPage } from './src/lib/envio.js';
console.log('tickets =', (await envioPage('Ticket', 'id eventId tier owner transfers revoked')).length);
"
```
Expected: `tickets = ` 숫자 한 줄.

- [ ] **Step 7: 커밋**

```bash
git add packages/shared/src/abi.ts indexer/src/EventHandlers.ts indexer/test/tier.test.ts
git commit -m "feat(indexer): backfill tier entities from the ticket contract"
```

---

## Task 38: 인덱서 호스티드 배포와 Tenderly 알림 검증

**Files:**
- Create: `indexer/.env.example`
- Modify: `functions/.env.monti-dev`(생성), 루트 `README.md`

**Interfaces:**
- Consumes: Task 33~37의 인덱서, Task 28의 `tenderlyWebhook`.
- Produces: 호스티드 GraphQL 엔드포인트 URL과 Functions 파라미터 `ENVIO_GRAPHQL_URL`. 그리고 실제로 동작하는 Tenderly 알림 8개.

- [ ] **Step 1: 배포 환경 파일을 만든다**

`indexer/.env.example`:

```bash
CHAIN_ID=10143
RPC_URL=https://testnet-rpc.monad.xyz
ENVIO_PG_HOST=
ENVIO_PG_PORT=5432
ENVIO_PG_USER=
ENVIO_PG_PASSWORD=
ENVIO_PG_DATABASE=envio-dev
```

- [ ] **Step 2: Envio Hosted Service에 배포한다**

Run:
```bash
pnpm --filter monti-indexer exec envio login
git push origin main
```
그다음 `https://envio.dev/app/deployments` 에서 저장소를 연결하고 루트 디렉터리를 `indexer`로 지정한다. 환경변수 `CHAIN_ID=10143`, `RPC_URL=https://testnet-rpc.monad.xyz`를 넣는다.

Expected: 배포가 `Healthy` 로 바뀌고 `https://indexer.dev.envio.dev/<deployment-id>/v1/graphql` 형태의 URL이 나온다.

- [ ] **Step 3: 호스티드 엔드포인트를 확인한다**

Run:
```bash
INDEXER_URL="https://indexer.dev.envio.dev/<deployment-id>/v1/graphql"
curl -s "$INDEXER_URL" -H 'content-type: application/json' \
  -d '{"query":"{ chain_metadata { chain_id latest_processed_block } }"}'
```
Expected: `{"data":{"chain_metadata":[{"chain_id":10143,"latest_processed_block":<n>}]}}`

- [ ] **Step 4: Functions에 엔드포인트를 주입한다**

`functions/.env.monti-dev`:

```bash
CHAIN_ID=10143
RPC_URL=https://testnet-rpc.monad.xyz
RP_ID=monti.app
RP_NAME=MONTI
ANDROID_APK_KEY_HASH=<S0 스파이크에서 기록한 base64url SHA-256>
GCP_PROJECT_ID=monti-dev
KMS_LOCATION=asia-northeast3
KMS_KEY_RING=monti
ENVIO_GRAPHQL_URL=https://indexer.dev.envio.dev/<deployment-id>/v1/graphql
EXPORT_BUCKET=monti-exports
BIGQUERY_DATASET=monti
```

Run:
```bash
pnpm --filter @monti/shared build && pnpm --filter monti-functions build
firebase deploy --only functions --project dev
firebase functions:list --project dev | wc -l
```
Expected: 함수 29개 + 헤더 줄(Task 40~44까지 끝낸 경우). 모두 `asia-northeast3`.

- [ ] **Step 5: Tenderly 알림 8개가 실제로 웹훅을 때리는지 확인한다**

Task 28 Step 5에서 만든 알림 목록에 델타 3개를 더해 총 8개인지 본다: `CheckedIn`, `Registered`, `AdminSet`, `ManagerSet`, `GateRegistered`, `Transfer`, `OfferAccepted`, `EventStatusChanged`.

sub-plan 01의 시드 스크립트로 이벤트를 하나 일으킨 뒤:

Run:
```bash
gcloud functions logs read tenderlyWebhook --region asia-northeast3 --project monti-dev --limit 20 | grep -c "ok:"
```
Expected: 1 이상. 0이면 ① Tenderly Destination URL ② `TENDERLY_WEBHOOK_SECRET` ③ 알림이 `Enabled` 인지 순서로 확인한다.

- [ ] **Step 6: 커밋**

```bash
git add indexer/.env.example README.md
git commit -m "chore(indexer): document hosted deployment and wire the GraphQL endpoint into functions"
```

---

## Task 39: Firebase Hosting — AASA, assetlinks, 웹 빌드 출력

**Files:**
- Create: `apps/web/scripts/gen-wellknown.mjs`
- Create: `apps/web/public/.well-known/` (생성물)
- Test: `functions/test/wellknown.test.ts`

**Interfaces:**
- Consumes: Task 10의 `firebase.json` 호스팅 절(`appAssociation: "NONE"`, 두 헤더).
- Produces: `https://<RP_ID>/.well-known/apple-app-site-association`(확장자 없음, `application/json`)과 `/.well-known/assetlinks.json`. 패스키와 유니버설 링크의 전제조건(마스터 계획 Global Constraints, 스펙 §8.2).

- [ ] **Step 1: 생성기를 쓴다**

`apps/web/scripts/gen-wellknown.mjs`:

```js
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'public', '.well-known');

const teamId = process.env.APPLE_TEAM_ID;
const bundleId = process.env.IOS_BUNDLE_ID ?? 'app.monti';
const androidPackage = process.env.ANDROID_PACKAGE ?? 'app.monti';
const fingerprints = (process.env.ANDROID_SHA256_FINGERPRINTS ?? '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

if (!teamId) {
  console.error('[gen-wellknown] APPLE_TEAM_ID 가 필요합니다 (spikes.md 의 S0 결과).');
  process.exit(1);
}
if (fingerprints.length === 0) {
  console.error('[gen-wellknown] ANDROID_SHA256_FINGERPRINTS 가 필요합니다 (debug,release 콤마 구분).');
  process.exit(1);
}

const appId = `${teamId}.${bundleId}`;

const aasa = {
  applinks: {
    apps: [],
    details: [{ appID: appId, paths: ['/t/*', '/kyc/callback', '/org/invite/*'] }],
  },
  webcredentials: { apps: [appId] },
};

const assetlinks = [
  {
    relation: ['delegate_permission/common.handle_all_urls', 'delegate_permission/common.get_login_creds'],
    target: { namespace: 'android_app', package_name: androidPackage, sha256_cert_fingerprints: fingerprints },
  },
];

await mkdir(outDir, { recursive: true });
// 확장자가 없어야 한다. Firebase Hosting 헤더 규칙이 application/json 을 붙인다.
await writeFile(join(outDir, 'apple-app-site-association'), JSON.stringify(aasa, null, 2), 'utf8');
await writeFile(join(outDir, 'assetlinks.json'), JSON.stringify(assetlinks, null, 2), 'utf8');
console.log(`[gen-wellknown] appID=${appId}, android=${androidPackage}, fingerprints=${fingerprints.length}`);
```

- [ ] **Step 2: 실패하는 테스트를 쓴다**

`functions/test/wellknown.test.ts`:

```ts
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const wellKnown = join(process.cwd(), '..', 'apps', 'web', 'public', '.well-known');

describe('.well-known files', () => {
  it('serves AASA with webcredentials and no file extension', async () => {
    const raw = await readFile(join(wellKnown, 'apple-app-site-association'), 'utf8');
    const parsed = JSON.parse(raw) as { webcredentials: { apps: string[] }; applinks: unknown };
    expect(parsed.webcredentials.apps).toHaveLength(1);
    expect(parsed.webcredentials.apps[0]).toMatch(/^[A-Z0-9]{10}\.[a-z.]+$/);
    expect(parsed.applinks).toBeDefined();
  });

  it('serves assetlinks with both passkey and link relations', async () => {
    const raw = await readFile(join(wellKnown, 'assetlinks.json'), 'utf8');
    const parsed = JSON.parse(raw) as Array<{ relation: string[]; target: { sha256_cert_fingerprints: string[] } }>;
    expect(parsed[0]!.relation).toContain('delegate_permission/common.get_login_creds');
    expect(parsed[0]!.relation).toContain('delegate_permission/common.handle_all_urls');
    expect(parsed[0]!.target.sha256_cert_fingerprints.length).toBeGreaterThan(0);
  });

  it('firebase.json disables Firebase auto-generated AASA and pins the content type', async () => {
    const config = JSON.parse(await readFile(join(process.cwd(), '..', 'firebase.json'), 'utf8')) as {
      hosting: { appAssociation: string; headers: Array<{ source: string; headers: Array<{ key: string; value: string }> }> };
    };
    expect(config.hosting.appAssociation).toBe('NONE');
    const aasaHeader = config.hosting.headers.find((h) => h.source.endsWith('apple-app-site-association'));
    expect(aasaHeader?.headers).toContainEqual({ key: 'Content-Type', value: 'application/json' });
  });
});
```

Run: `pnpm --filter monti-functions exec vitest run test/wellknown.test.ts`
Expected: FAIL — `ENOENT ... apple-app-site-association`

- [ ] **Step 3: 파일을 생성한다**

Run:
```bash
APPLE_TEAM_ID=<spikes.md 의 Team ID> \
IOS_BUNDLE_ID=app.monti \
ANDROID_PACKAGE=app.monti \
ANDROID_SHA256_FINGERPRINTS="<debug SHA-256>,<release SHA-256>" \
  node apps/web/scripts/gen-wellknown.mjs
```
Expected: `[gen-wellknown] appID=XXXXXXXXXX.app.monti, android=app.monti, fingerprints=2`

핑거프린트를 모르면:
```bash
keytool -list -v -keystore ~/.android/debug.keystore -alias androiddebugkey -storepass android -keypass android | grep SHA256
```

- [ ] **Step 4: 테스트를 통과시키고 배포한다**

Run:
```bash
pnpm --filter monti-functions exec vitest run test/wellknown.test.ts
pnpm --filter monti-web build 2>/dev/null || mkdir -p apps/web/dist && cp -R apps/web/public/. apps/web/dist/
firebase deploy --only hosting --project dev
```
Expected: `Tests  3 passed (3)`, 그리고 `✔  hosting: release complete`.

- [ ] **Step 5: 실제 응답 헤더를 확인한다**

Run:
```bash
curl -sI https://monti.app/.well-known/apple-app-site-association | grep -i content-type
curl -s https://monti.app/.well-known/apple-app-site-association | head -c 60
curl -sI https://monti.app/.well-known/assetlinks.json | grep -i content-type
```
Expected:
```
content-type: application/json
{
  "applinks": {
content-type: application/json
```
`content-type`이 `application/octet-stream`이면 `appAssociation: "NONE"` 또는 헤더 규칙이 빠진 것이다.

- [ ] **Step 6: 안드로이드 링크 검증을 확인한다**

Run: `adb shell pm get-app-links app.monti`
Expected: `monti.app: verified`. `none`이면 최대 24시간 캐시 때문일 수 있으므로 `adb shell pm verify-app-links --re-verify app.monti` 후 재확인한다.

- [ ] **Step 7: 커밋**

```bash
git add apps/web/scripts/gen-wellknown.mjs apps/web/public/.well-known functions/test/wellknown.test.ts
git commit -m "feat(hosting): publish AASA and assetlinks with pinned JSON content type"
```

---

## Task 40: `pinMessage` — 주최자 공지 고정

**Files:**
- Create: `functions/src/functions/pinMessage.ts`
- Modify: `firestore.rules`, `functions/test/rules.test.ts`
- Test: `functions/test/pinMessage.test.ts`

**Interfaces:**
- Consumes: Task 15 `resolveCallerAccount`, `EVENT_CHATS`; Task 3 `organizersAbi`, `ticketAbi`.
- Produces:
  - callable `pinMessage`: `{ eventId: string; msgId: string; pinned: boolean }` → `{ ok: true }`. `Organizers.hasPermission(eventOrg(eventId), callerAccount, PERM_CREATE_EVENT)`(= 주최자 관리자)를 **eth_call**로 확인한 뒤 `eventChats/{eventId}/messages/{msgId}.pinned`를 쓴다.
  - Firestore 규칙: 클라이언트는 `pinned`를 **절대 쓸 수 없다**(생성 시 `keys().hasOnly([...])`가 막고, 수정은 전면 금지).

**왜 서버만 쓰는가:** `pinned`는 "주최자가 고정한 공지"라는 **권한 표현**이다. 권한은 체인에만 있고(스펙 §9.4), 클라이언트가 스스로 붙일 수 있으면 아무나 공지를 위조한다. 규칙은 권한을 알 수 없으므로 서버가 eth_call로 확인하는 경로 하나만 남긴다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`functions/test/pinMessage.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hasPermission = vi.fn(async () => true);
vi.mock('../src/lib/chain.js', () => ({
  publicClient: () => ({
    readContract: vi.fn(async ({ functionName }: { functionName: string }) =>
      functionName === 'eventOrg' ? 1n : hasPermission(),
    ),
  }),
  deployment: () => ({
    organizers: '0x2222222222222222222222222222222222222222',
    ticket: '0x3333333333333333333333333333333333333333',
  }),
}));
vi.mock('../src/lib/auth.js', () => ({
  resolveCallerAccount: vi.fn(async () => '0x9999999999999999999999999999999999999999'),
}));

const { db, EVENT_CHATS } = await import('../src/lib/db.js');
const { pinMessage } = await import('../src/functions/pinMessage.js');
const functionsTest = (await import('firebase-functions-test')).default();
const pin = functionsTest.wrap(pinMessage);
const auth = { uid: 'uid-1', token: { account: '0x9999999999999999999999999999999999999999' } };

beforeEach(async () => {
  hasPermission.mockResolvedValue(true);
  const snap = await db.collection(EVENT_CHATS).get();
  await Promise.all(snap.docs.map((d) => d.ref.delete()));
  await db.collection(EVENT_CHATS).doc('11').set({ closed: false, endsAt: 4102444800, orgId: '1' });
  await db.doc(`${EVENT_CHATS}/11/messages/m1`).set({ uid: 'uid-2', text: '공지', createdAt: 1, reported: 0 });
});

describe('pinMessage', () => {
  it('pins a message for an organizer admin', async () => {
    const result = (await pin({ data: { eventId: '11', msgId: 'm1', pinned: true }, auth } as never)) as { ok: true };
    expect(result.ok).toBe(true);
    expect((await db.doc(`${EVENT_CHATS}/11/messages/m1`).get()).get('pinned')).toBe(true);
  });

  it('unpins with pinned: false', async () => {
    await pin({ data: { eventId: '11', msgId: 'm1', pinned: true }, auth } as never);
    await pin({ data: { eventId: '11', msgId: 'm1', pinned: false }, auth } as never);
    expect((await db.doc(`${EVENT_CHATS}/11/messages/m1`).get()).get('pinned')).toBe(false);
  });

  it('refuses a caller without PERM_CREATE_EVENT', async () => {
    hasPermission.mockResolvedValue(false);
    await expect(pin({ data: { eventId: '11', msgId: 'm1', pinned: true }, auth } as never)).rejects.toThrow(
      'NOT_ORGANIZER_ADMIN',
    );
    expect((await db.doc(`${EVENT_CHATS}/11/messages/m1`).get()).get('pinned')).toBeUndefined();
  });

  it('refuses a missing message and a non-boolean pinned', async () => {
    await expect(pin({ data: { eventId: '11', msgId: 'nope', pinned: true }, auth } as never)).rejects.toThrow(
      'MESSAGE_NOT_FOUND',
    );
    await expect(pin({ data: { eventId: '11', msgId: 'm1', pinned: 'yes' }, auth } as never)).rejects.toThrow(
      'BAD_PINNED',
    );
  });
});
```

그리고 `functions/test/rules.test.ts`의 `describe('eventChats messages', …)` 안에 두 케이스를 덧붙인다:

```ts
  it('blocks a client from creating a message that carries pinned', async () => {
    await assertFails(
      owner()
        .collection('eventChats/11/messages')
        .add({ uid: 'uid-1', text: 'hi', createdAt: 1, reported: 0, pinned: true }),
    );
  });

  it('blocks a client from setting pinned on an existing message', async () => {
    await env.withSecurityRulesDisabled(async (context) => {
      await context.firestore().doc('eventChats/11/messages/m1').set({ uid: 'uid-1', text: 'hi', createdAt: 1, reported: 0 });
    });
    await assertFails(owner().doc('eventChats/11/messages/m1').update({ pinned: true }));
  });
```

- [ ] **Step 2: 실패를 확인한다**

Run: `firebase emulators:exec --only firestore,auth "pnpm --filter monti-functions exec vitest run test/pinMessage.test.ts"`
Expected: FAIL — `Failed to resolve import "../src/functions/pinMessage.js"`

- [ ] **Step 3: `pinMessage.ts`를 쓴다**

```ts
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { organizersAbi, ticketAbi, type Hex } from '@monti/shared';
import { resolveCallerAccount } from '../lib/auth.js';
import { deployment, publicClient } from '../lib/chain.js';
import { EVENT_CHATS, db } from '../lib/db.js';

const PERM_CREATE_EVENT = 1;

export const pinMessage = onCall(async (request): Promise<{ ok: true }> => {
  const { eventId, msgId, pinned } = (request.data ?? {}) as {
    eventId?: string;
    msgId?: string;
    pinned?: unknown;
  };
  if (!eventId || !/^[0-9]+$/.test(eventId)) throw new HttpsError('invalid-argument', 'BAD_EVENT_ID');
  if (!msgId || typeof msgId !== 'string') throw new HttpsError('invalid-argument', 'BAD_MSG_ID');
  if (typeof pinned !== 'boolean') throw new HttpsError('invalid-argument', 'BAD_PINNED');

  const caller = await resolveCallerAccount(request);
  const contracts = deployment();
  const pc = publicClient();

  const orgId = await pc.readContract({
    address: contracts.ticket, abi: ticketAbi, functionName: 'eventOrg', args: [BigInt(eventId)],
  });
  const isAdmin = await pc.readContract({
    address: contracts.organizers, abi: organizersAbi, functionName: 'hasPermission',
    args: [orgId as bigint, caller as Hex, PERM_CREATE_EVENT],
  });
  if (!isAdmin) throw new HttpsError('permission-denied', 'NOT_ORGANIZER_ADMIN');

  const messageRef = db.doc(`${EVENT_CHATS}/${eventId}/messages/${msgId}`);
  const message = await messageRef.get();
  if (!message.exists) throw new HttpsError('not-found', 'MESSAGE_NOT_FOUND');

  await messageRef.update({ pinned });
  return { ok: true };
});
```

`functions/src/index.ts`에 추가: `export { pinMessage } from './functions/pinMessage.js';`

- [ ] **Step 4: 규칙 테스트까지 통과시킨다**

Run:
```bash
firebase emulators:exec --only firestore,auth "pnpm --filter monti-functions exec vitest run test/pinMessage.test.ts test/rules.test.ts"
```
Expected: PASS — `Tests  19 passed (19)` (pinMessage 4 + rules 15)

- [ ] **Step 5: 정합성 가드를 다시 돌린다**

Run: `pnpm --filter monti-functions exec vitest run test/consistency.test.ts`
Expected: PASS — `Tests  5 passed (5)`. `eventChats`는 이미 허용목록에 있으므로 변경이 필요 없다.

- [ ] **Step 6: 커밋**

```bash
git add functions/src/functions/pinMessage.ts functions/src/index.ts \
        functions/test/pinMessage.test.ts functions/test/rules.test.ts firestore.rules
git commit -m "feat(functions): let organizer admins pin chat messages, server-side only"
```

---

## Task 41: `requestAccountDeletion`과 `processDeletions`

**Files:**
- Create: `functions/src/functions/accountDeletion.ts`
- Modify: `functions/src/lib/db.ts`(`DELETION_REQUESTS` 추가), `functions/src/lib/didit.ts`(`deleteDiditSession` 추가)
- Test: `functions/test/accountDeletion.test.ts`

**Interfaces:**
- Consumes: Task 15 `resolveCallerAccount`, `db`; Task 24 `hmacPhone`; Task 3 `ticketAbi`.
- Produces:
  - `DELETION_REQUESTS = 'deletionRequests'` (그리고 `ALLOWED_COLLECTIONS`에 추가)
  - `deleteDiditSession(sessionId: string, apiKey: string): Promise<void>` — Didit 세션 삭제 API를 `deletion_instruction: 'privacy erasure'`로 호출.
  - callable `requestAccountDeletion`: `{ reason?: string }` → `{ ok: true; scheduledFor: number }`. `deletionRequests/{personId}`에 `scheduledFor = now + 7일`.
  - scheduled `processDeletions` (매일 04:00 Asia/Seoul): 기한이 지난 요청 중 `Ticket.balanceOf(account) == 0`인 것만 실제로 지운다.

**무엇을 지우고 무엇을 남기는가:** `persons`, `users`, `passkeys`(그 사람 것 전부), `devices/{account}`, `phoneIndex/{hmacPhone}`, Storage의 `persons/{personId}/` 접두사 전부, 그리고 Didit 세션. **체인의 `Identity` 항목은 남는다** — `personId`는 의미 없는 난수이고 계정 주소·기기 키에는 개인정보가 없다(스펙 §10.2). 티켓을 들고 있으면 지우지 않고 `status: 'blocked'`로 두어 사람이 먼저 양도하거나 입장하게 한다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`functions/test/accountDeletion.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const balanceOf = vi.fn(async () => 0n);
vi.mock('../src/lib/chain.js', () => ({
  publicClient: () => ({ readContract: vi.fn(async () => balanceOf()) }),
  deployment: () => ({ ticket: '0x3333333333333333333333333333333333333333' }),
}));
vi.mock('../src/lib/auth.js', () => ({
  resolveCallerAccount: vi.fn(async () => '0x9999999999999999999999999999999999999999'),
}));
const deleteDiditSession = vi.fn(async () => undefined);
vi.mock('../src/lib/didit.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/didit.js')>();
  return { ...actual, deleteDiditSession };
});
const deleteFiles = vi.fn(async () => undefined);
vi.mock('../src/lib/db.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/db.js')>();
  return { ...actual, storage: { bucket: () => ({ deleteFiles }) } };
});

const { db, PERSONS, USERS, PASSKEYS, DEVICES, PHONE_INDEX, DELETION_REQUESTS } = await import('../src/lib/db.js');
const { hmacPhone } = await import('../src/lib/phoneIndex.js');
const { requestAccountDeletion, processDeletions } = await import('../src/functions/accountDeletion.js');
const functionsTest = (await import('firebase-functions-test')).default();
const request = functionsTest.wrap(requestAccountDeletion);
const process_ = functionsTest.wrap(processDeletions);

const KEY = 'monti-test-key';
const PERSON_ID = `0x${'aa'.repeat(32)}`;
const ACCOUNT = '0x9999999999999999999999999999999999999999';
const PHONE = '+821012345678';
const auth = { uid: 'uid-1', token: { account: ACCOUNT } };

async function seed(): Promise<void> {
  await db.collection(PERSONS).doc(PERSON_ID).set({
    status: 'active', account: ACCOUNT, kyc: { provider: 'didit', sessionId: 'sess-1' },
    enc: { name: 'enc:x', docNumber: 'enc:y' }, photoEnc: 'enc:z',
  });
  await db.collection(USERS).doc('uid-1').set({ personId: PERSON_ID, phoneE164: PHONE });
  await db.collection(PASSKEYS).doc('cred-1').set({ personId: PERSON_ID, counter: 0 });
  await db.collection(DEVICES).doc(ACCOUNT).set({ deviceX: '0x11', deviceY: '0x22', platform: 'ios' });
  await db.collection(PHONE_INDEX).doc(hmacPhone(PHONE, KEY)).set({ personId: PERSON_ID });
}

beforeEach(async () => {
  process.env.PHONE_INDEX_KEY = KEY;
  process.env.DIDIT_API_KEY = 'didit-key';
  balanceOf.mockResolvedValue(0n);
  deleteDiditSession.mockClear();
  deleteFiles.mockClear();
  for (const collection of [PERSONS, USERS, PASSKEYS, DEVICES, PHONE_INDEX, DELETION_REQUESTS]) {
    const snap = await db.collection(collection).get();
    await Promise.all(snap.docs.map((d) => d.ref.delete()));
  }
  await seed();
});

describe('requestAccountDeletion', () => {
  it('schedules the deletion 7 days out and is idempotent', async () => {
    const first = (await request({ data: { reason: '더 안 씀' }, auth } as never)) as { scheduledFor: number };
    const second = (await request({ data: {}, auth } as never)) as { scheduledFor: number };

    expect(second.scheduledFor).toBe(first.scheduledFor);
    expect(first.scheduledFor - Math.floor(Date.now() / 1000)).toBeGreaterThan(7 * 24 * 60 * 60 - 60);

    const stored = await db.collection(DELETION_REQUESTS).doc(PERSON_ID).get();
    expect(stored.get('status')).toBe('scheduled');
    expect(stored.get('account')).toBe(ACCOUNT);
    expect(stored.get('reason')).toBe('더 안 씀');
  });
});

describe('processDeletions', () => {
  it('erases every personal record once the grace period is over', async () => {
    await request({ data: {}, auth } as never);
    await db.collection(DELETION_REQUESTS).doc(PERSON_ID).update({ scheduledFor: 1 });

    await process_({} as never);

    expect((await db.collection(PERSONS).doc(PERSON_ID).get()).exists).toBe(false);
    expect((await db.collection(USERS).doc('uid-1').get()).exists).toBe(false);
    expect((await db.collection(PASSKEYS).doc('cred-1').get()).exists).toBe(false);
    expect((await db.collection(DEVICES).doc(ACCOUNT).get()).exists).toBe(false);
    expect((await db.collection(PHONE_INDEX).doc(hmacPhone(PHONE, KEY)).get()).exists).toBe(false);
    expect(deleteFiles).toHaveBeenCalledWith({ prefix: `persons/${PERSON_ID}/` });
    expect(deleteDiditSession).toHaveBeenCalledWith('sess-1', 'didit-key');
    expect((await db.collection(DELETION_REQUESTS).doc(PERSON_ID).get()).get('status')).toBe('done');
  });

  it('blocks deletion while the person still holds a ticket', async () => {
    balanceOf.mockResolvedValue(1n);
    await request({ data: {}, auth } as never);
    await db.collection(DELETION_REQUESTS).doc(PERSON_ID).update({ scheduledFor: 1 });

    await process_({} as never);

    expect((await db.collection(PERSONS).doc(PERSON_ID).get()).exists).toBe(true);
    expect(deleteDiditSession).not.toHaveBeenCalled();
    expect((await db.collection(DELETION_REQUESTS).doc(PERSON_ID).get()).get('status')).toBe('blocked');
  });

  it('leaves a request alone before its scheduled date', async () => {
    await request({ data: {}, auth } as never);
    await process_({} as never);
    expect((await db.collection(PERSONS).doc(PERSON_ID).get()).exists).toBe(true);
    expect((await db.collection(DELETION_REQUESTS).doc(PERSON_ID).get()).get('status')).toBe('scheduled');
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `firebase emulators:exec --only firestore,auth "pnpm --filter monti-functions exec vitest run test/accountDeletion.test.ts"`
Expected: FAIL — `Failed to resolve import "../src/functions/accountDeletion.js"`

- [ ] **Step 3: `db.ts`와 `didit.ts`를 늘린다**

`functions/src/lib/db.ts`에 상수를 더하고 허용목록에 넣는다:

```ts
export const DELETION_REQUESTS = 'deletionRequests';
```
```ts
export const ALLOWED_COLLECTIONS = [
  PERSONS,
  USERS,
  PASSKEYS,
  DEVICES,
  INVITES,
  KYC_SESSIONS,
  AUTH_CHALLENGES,
  PHONE_INDEX,
  TRANSFER_INVITES,
  EVENT_CHATS,
  DELETION_REQUESTS,
  'members',
  'messages',
] as const;
```

`functions/src/lib/didit.ts` 끝에 추가한다:

```ts
/** 개인정보 파기 요청. Didit 쪽 세션과 생체 템플릿까지 지운다(스펙 §9.2 데이터 항목). */
export async function deleteDiditSession(sessionId: string, apiKey: string): Promise<void> {
  const response = await fetch(`https://verification.didit.me/v2/session/${sessionId}/delete/`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify({ deletion_instruction: 'privacy erasure' }),
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(`DIDIT_DELETE_FAILED:${response.status}`);
  }
}
```

- [ ] **Step 4: `accountDeletion.ts`를 쓴다**

```ts
import { FieldValue } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { ticketAbi, type Hex } from '@monti/shared';
import { DIDIT_API_KEY, PHONE_INDEX_KEY } from '../config.js';
import { resolveCallerAccount } from '../lib/auth.js';
import { deployment, publicClient } from '../lib/chain.js';
import {
  DELETION_REQUESTS, DEVICES, PASSKEYS, PERSONS, PHONE_INDEX, USERS, db, storage,
} from '../lib/db.js';
import { deleteDiditSession } from '../lib/didit.js';
import { hmacPhone } from '../lib/phoneIndex.js';

const GRACE_SECONDS = 7 * 24 * 60 * 60;

export const requestAccountDeletion = onCall(
  async (request): Promise<{ ok: true; scheduledFor: number }> => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError('unauthenticated', 'AUTH_REQUIRED');
    const { reason } = (request.data ?? {}) as { reason?: string };
    if (reason !== undefined && (typeof reason !== 'string' || reason.length > 500)) {
      throw new HttpsError('invalid-argument', 'BAD_REASON');
    }

    const account = await resolveCallerAccount(request);
    const personId = (await db.collection(USERS).doc(uid).get()).get('personId') as Hex | undefined;
    if (!personId) throw new HttpsError('failed-precondition', 'NO_PERSON');

    const requestRef = db.collection(DELETION_REQUESTS).doc(personId);
    const scheduledFor = await db.runTransaction(async (tx) => {
      const current = await tx.get(requestRef);
      // 이미 예약돼 있으면 날짜를 미루지 않는다(반복 호출로 유예를 늘릴 수 없게).
      if (current.exists && current.get('status') === 'scheduled') {
        return current.get('scheduledFor') as number;
      }
      const next = Math.floor(Date.now() / 1000) + GRACE_SECONDS;
      tx.set(requestRef, {
        personId,
        account,
        reason: reason ?? null,
        requestedAt: FieldValue.serverTimestamp(),
        scheduledFor: next,
        status: 'scheduled',
      });
      return next;
    });

    return { ok: true, scheduledFor };
  },
);

export const processDeletions = onSchedule(
  {
    schedule: '0 4 * * *',
    timeZone: 'Asia/Seoul',
    timeoutSeconds: 540,
    secrets: [PHONE_INDEX_KEY, DIDIT_API_KEY],
  },
  async () => {
    const now = Math.floor(Date.now() / 1000);
    const due = await db
      .collection(DELETION_REQUESTS)
      .where('status', 'in', ['scheduled', 'blocked'])
      .where('scheduledFor', '<=', now)
      .limit(50)
      .get();

    for (const doc of due.docs) {
      const personId = doc.id as Hex;
      const account = doc.get('account') as Hex;

      // 티켓을 들고 있으면 지우지 않는다. 체인이 원본이고, 지워도 티켓은 남는다.
      const balance = await publicClient().readContract({
        address: deployment().ticket, abi: ticketAbi, functionName: 'balanceOf', args: [account],
      });
      if ((balance as bigint) > 0n) {
        await doc.ref.update({ status: 'blocked', blockedAt: FieldValue.serverTimestamp() });
        continue;
      }

      const person = await db.collection(PERSONS).doc(personId).get();
      const sessionId = person.get('kyc.sessionId') as string | undefined;

      const users = await db.collection(USERS).where('personId', '==', personId).get();
      const passkeys = await db.collection(PASSKEYS).where('personId', '==', personId).get();

      const batch = db.batch();
      batch.delete(db.collection(PERSONS).doc(personId));
      batch.delete(db.collection(DEVICES).doc(account));
      for (const user of users.docs) {
        const phoneE164 = user.get('phoneE164') as string | undefined;
        if (phoneE164) {
          batch.delete(db.collection(PHONE_INDEX).doc(hmacPhone(phoneE164, PHONE_INDEX_KEY.value())));
        }
        batch.delete(user.ref);
      }
      for (const passkey of passkeys.docs) batch.delete(passkey.ref);
      await batch.commit();

      // 암호화된 얼굴 사진 원본까지 지운다.
      await storage.bucket().deleteFiles({ prefix: `persons/${personId}/` });

      if (sessionId) await deleteDiditSession(sessionId, DIDIT_API_KEY.value());

      // 체인의 Identity 항목은 남는다: personId 는 난수이고 개인정보가 없다(스펙 §10.2).
      await doc.ref.update({ status: 'done', completedAt: FieldValue.serverTimestamp() });
    }
  },
);
```

`functions/src/index.ts`에 추가: `export { requestAccountDeletion, processDeletions } from './functions/accountDeletion.js';`

- [ ] **Step 5: 테스트를 통과시킨다**

Run: `firebase emulators:exec --only firestore,auth "pnpm --filter monti-functions exec vitest run test/accountDeletion.test.ts"`
Expected: PASS — `Tests  4 passed (4)`

- [ ] **Step 6: 정합성 가드와 전체 테스트를 다시 돌린다**

Run:
```bash
pnpm --filter monti-functions exec vitest run test/consistency.test.ts
pnpm test:functions
```
Expected: 정합성 `Tests  5 passed (5)`(`deletionRequests`가 허용목록에 들어갔다), 전체 통과.

- [ ] **Step 7: 배포하고 함수 수를 확인한다**

Run:
```bash
pnpm --filter monti-functions build && firebase deploy --only functions --project dev
firebase functions:list --project dev | grep -c asia-northeast3
```
Expected: `25`

- [ ] **Step 8: 커밋**

```bash
git add functions/src/functions/accountDeletion.ts functions/src/lib/db.ts functions/src/lib/didit.ts \
        functions/src/index.ts functions/test/accountDeletion.test.ts
git commit -m "feat(functions): add 7-day account deletion request and daily erasure job"
```

---

## Task 42: `getSignupStatus`

**Files:**
- Create: `functions/src/functions/getSignupStatus.ts`
- Test: `functions/test/getSignupStatus.test.ts`

**Interfaces:**
- Consumes: Task 15 `db`, `USERS`, `PERSONS`.
- Produces: callable `getSignupStatus`: `{}` → `{ status: PersonStatus; kycLevel: 0 | 1; account?: Hex; kycUrl?: string }`. 인증은 **Firebase 전화 사용자**(가입 도중이라 아직 패스키 세션이 없다). `users/{uid}.personId` → `persons/{personId}`를 읽는다.

**`kycUrl`은 열려 있는 Didit 세션이 있을 때만 나온다(창업자 델타).** 가입 자체에는 본인인증이 없으므로, `kycUrl`은 `startKyc`(Task 44)가 세션을 열어 `persons.kyc.status === 'open'` 인 동안에만 되돌아온다. 세션을 새로 만들지 않고 저장된 URL을 재사용하는 이유는, 새로 만들면 이미 떠 있는 브라우저 탭과 어긋나고 중복 세션이 쌓이기 때문이다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`functions/test/getSignupStatus.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';

const { db, PERSONS, USERS } = await import('../src/lib/db.js');
const { getSignupStatus } = await import('../src/functions/getSignupStatus.js');
const functionsTest = (await import('firebase-functions-test')).default();
const status = functionsTest.wrap(getSignupStatus);

const PERSON_ID = `0x${'aa'.repeat(32)}`;
const ACCOUNT = '0x9999999999999999999999999999999999999999';
const auth = { uid: 'uid-1', token: { phone_number: '+821011112222' } };

beforeEach(async () => {
  for (const collection of [PERSONS, USERS]) {
    const snap = await db.collection(collection).get();
    await Promise.all(snap.docs.map((d) => d.ref.delete()));
  }
  await db.collection(USERS).doc('uid-1').set({ personId: PERSON_ID, phoneE164: '+821011112222' });
});

describe('getSignupStatus', () => {
  it('reports a brand-new signup as pending at KYC level 0 with no link', async () => {
    await db.collection(PERSONS).doc(PERSON_ID).set({ status: 'pending', kycLevel: 0 });
    expect(await status({ data: {}, auth } as never)).toEqual({ status: 'pending', kycLevel: 0 });
  });

  it('returns the Didit link only while a session is open', async () => {
    await db.collection(PERSONS).doc(PERSON_ID).set({
      status: 'active',
      kycLevel: 0,
      account: ACCOUNT,
      kyc: { provider: 'didit', sessionId: 'sess-1', url: 'https://verify.didit.me/s/sess-1', status: 'open' },
    });
    expect(await status({ data: {}, auth } as never)).toEqual({
      status: 'active', kycLevel: 0, account: ACCOUNT, kycUrl: 'https://verify.didit.me/s/sess-1',
    });
  });

  it('drops the link once the session is approved and reports level 1', async () => {
    await db.collection(PERSONS).doc(PERSON_ID).set({
      status: 'active',
      kycLevel: 1,
      account: ACCOUNT,
      enc: { name: 'enc:x' },
      kyc: { provider: 'didit', sessionId: 'sess-1', url: 'https://verify.didit.me/s/sess-1', status: 'approved' },
    });
    const result = (await status({ data: {}, auth } as never)) as Record<string, unknown>;
    expect(result).toEqual({ status: 'active', kycLevel: 1, account: ACCOUNT });
    expect(JSON.stringify(result)).not.toContain('enc:');
  });

  it('keeps level 0 after a duplicate-face rejection and hides the spent link', async () => {
    await db.collection(PERSONS).doc(PERSON_ID).set({
      status: 'active',
      kycLevel: 0,
      account: ACCOUNT,
      kyc: { provider: 'didit', sessionId: 'sess-1', url: 'https://x', status: 'rejected', rejectedReason: 'duplicate_face' },
    });
    expect(await status({ data: {}, auth } as never)).toEqual({ status: 'active', kycLevel: 0, account: ACCOUNT });
  });

  it('refuses an unauthenticated caller and a uid with no signup', async () => {
    await expect(status({ data: {} } as never)).rejects.toThrow('AUTH_REQUIRED');
    await expect(status({ data: {}, auth: { uid: 'uid-9', token: {} } } as never)).rejects.toThrow('NO_SIGNUP');
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `firebase emulators:exec --only firestore,auth "pnpm --filter monti-functions exec vitest run test/getSignupStatus.test.ts"`
Expected: FAIL — `Failed to resolve import "../src/functions/getSignupStatus.js"`

- [ ] **Step 3: 링크를 어디서 얻는지 확인한다**

`persons.kyc.url` 과 `persons.kyc.status` 는 **Task 44의 `startKyc` 가 쓴다.** `startSignup` 은 더 이상 Didit 을 부르지 않으므로 이 Task 는 `startSignup.ts` 를 건드리지 않는다.

Run: `grep -n "kyc: { provider: 'didit'" functions/src/functions/*.ts`
Expected: `diditWebhook.ts` 와 (Task 44 이후) `startKyc.ts` 두 파일만. `startSignup.ts` 는 나오면 안 된다.

- [ ] **Step 4: `getSignupStatus.ts`를 쓴다**

```ts
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import type { Hex, PersonStatus } from '@monti/shared';
import { PERSONS, USERS, db } from '../lib/db.js';

/**
 * 가입 진행 화면이 폴링하는 유일한 읽기 경로.
 * 클라이언트는 persons 를 직접 읽지 못하므로(보안 규칙 deny-all) 이 함수가 창구다.
 * 개인정보(enc.*, photoEnc)는 절대 내보내지 않는다.
 */
export const getSignupStatus = onCall(
  async (request): Promise<{ status: PersonStatus; kycLevel: 0 | 1; account?: Hex; kycUrl?: string }> => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError('unauthenticated', 'AUTH_REQUIRED');

    const personId = (await db.collection(USERS).doc(uid).get()).get('personId') as Hex | undefined;
    if (!personId) throw new HttpsError('not-found', 'NO_SIGNUP');

    const person = await db.collection(PERSONS).doc(personId).get();
    if (!person.exists) throw new HttpsError('not-found', 'NO_SIGNUP');

    const status = (person.get('status') ?? 'pending') as PersonStatus;
    const kycLevel = (((person.get('kycLevel') as number | undefined) ?? 0) === 1 ? 1 : 0) as 0 | 1;
    const out: { status: PersonStatus; kycLevel: 0 | 1; account?: Hex; kycUrl?: string } = { status, kycLevel };

    const account = person.get('account') as Hex | undefined;
    if (account) out.account = account;

    // 열려 있는 Didit 세션이 있을 때만 링크를 돌려준다. 승인·거절된 세션은 다시 열 수 없다.
    if (person.get('kyc.status') === 'open') {
      const url = person.get('kyc.url') as string | undefined;
      if (url) out.kycUrl = url;
    }

    return out;
  },
);
```

`functions/src/index.ts`에 추가: `export { getSignupStatus } from './functions/getSignupStatus.js';`

- [ ] **Step 5: 테스트를 통과시킨다**

Run: `firebase emulators:exec --only firestore,auth "pnpm --filter monti-functions exec vitest run test/getSignupStatus.test.ts"`
Expected: PASS — `Tests  5 passed (5)`

- [ ] **Step 6: 커밋**

```bash
git add functions/src/functions/getSignupStatus.ts functions/src/index.ts functions/test/getSignupStatus.test.ts
git commit -m "feat(functions): expose signup status with KYC level and an open-session link"
```

---

## Task 43: `pendingGates` — `submitPendingGate`와 `listPendingGates`

**Files:**
- Create: `functions/src/functions/pendingGates.ts`
- Modify: `functions/src/lib/db.ts`(`PENDING_GATES`), `functions/src/functions/tenderlyWebhook.ts`(`GateRegistered` 처리)
- Test: `functions/test/pendingGates.test.ts`

**Interfaces:**
- Consumes: Task 15 `resolveCallerAccount`, `db`; Task 3 `organizersAbi`, `ticketAbi`; Task 28 `decodeMontiLogs`.
- Produces:
  - `PENDING_GATES = 'pendingGates'` (그리고 `ALLOWED_COLLECTIONS`에 추가)
  - callable `submitPendingGate`: `{ eventId, gateAccount, kx, ky, deviceLabel }` → `{ ok: true }`. 호출자는 스태프 본인 세션이고 그 공연 주최자의 **매니저이거나 `PERM_MANAGE_GATES` 관리자**여야 한다(eth_call). `pendingGates/{gateAccount}`를 upsert 한다.
  - callable `listPendingGates`: `{ eventId }` → `{ gates: Array<{ gateAccount: Hex; kx: Hex; ky: Hex; deviceLabel: string; createdAt: number; status: string }> }`. **`PERM_MANAGE_GATES` 관리자만.**
  - `tenderlyWebhook`의 `GateRegistered` 분기가 해당 `pendingGates` 문서를 `status: 'registered'`로 닫는다.

**왜 필요한가:** 스펙 §5.7은 "스태프 앱이 게이트 키를 만들고 → **게이트 계정 주소가 관리자 화면에 뜨고** → 관리자가 승인하면 체인 allowlist에 등록"이라고 적었다. 그 "관리자 화면에 뜬다"를 실어 나르는 큐가 없었다. `pendingGates`가 그 큐다. **권한은 여전히 체인에만 있고**(관리자가 `Organizers.registerGate`를 직접 서명한다), 이 컬렉션은 승인 전 제안일 뿐이라 `GateRegistered`가 올라오면 닫힌다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`functions/test/pendingGates.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = { manager: [false, false] as readonly [boolean, boolean], manageGates: false };
vi.mock('../src/lib/chain.js', () => ({
  publicClient: () => ({
    readContract: vi.fn(async ({ functionName }: { functionName: string }) =>
      functionName === 'eventOrg' ? 1n
      : functionName === 'managerOf' ? state.manager
      : state.manageGates,
    ),
  }),
  deployment: () => ({
    organizers: '0x2222222222222222222222222222222222222222',
    ticket: '0x3333333333333333333333333333333333333333',
  }),
}));
vi.mock('../src/lib/auth.js', () => ({
  resolveCallerAccount: vi.fn(async () => '0x9999999999999999999999999999999999999999'),
}));

const { db, PENDING_GATES, USERS } = await import('../src/lib/db.js');
const { submitPendingGate, listPendingGates } = await import('../src/functions/pendingGates.js');
const functionsTest = (await import('firebase-functions-test')).default();
const submit = functionsTest.wrap(submitPendingGate);
const list = functionsTest.wrap(listPendingGates);

const GATE = '0x1234123412341234123412341234123412341234';
const PERSON_ID = `0x${'aa'.repeat(32)}`;
const auth = { uid: 'uid-1', token: { account: '0x9999999999999999999999999999999999999999' } };
const payload = {
  eventId: '11', gateAccount: GATE, kx: `0x${'11'.repeat(32)}`, ky: `0x${'22'.repeat(32)}`, deviceLabel: 'A게이트 갤럭시',
};

beforeEach(async () => {
  state.manager = [false, false];
  state.manageGates = false;
  for (const collection of [PENDING_GATES, USERS]) {
    const snap = await db.collection(collection).get();
    await Promise.all(snap.docs.map((d) => d.ref.delete()));
  }
  await db.collection(USERS).doc('uid-1').set({ personId: PERSON_ID, phoneE164: '+821011112222' });
});

describe('submitPendingGate', () => {
  it('queues a gate for a manager', async () => {
    state.manager = [true, false];
    expect(await submit({ data: payload, auth } as never)).toEqual({ ok: true });

    const doc = await db.collection(PENDING_GATES).doc(GATE).get();
    expect(doc.get('status')).toBe('pending');
    expect(doc.get('eventId')).toBe('11');
    expect(doc.get('orgId')).toBe('1');
    expect(doc.get('deviceLabel')).toBe('A게이트 갤럭시');
    expect(doc.get('submittedBy')).toBe(PERSON_ID);
  });

  it('is an upsert: re-submitting the same device updates the label', async () => {
    state.manageGates = true;
    await submit({ data: payload, auth } as never);
    await submit({ data: { ...payload, deviceLabel: 'B게이트 갤럭시' }, auth } as never);
    const all = await db.collection(PENDING_GATES).get();
    expect(all.size).toBe(1);
    expect(all.docs[0]!.get('deviceLabel')).toBe('B게이트 갤럭시');
  });

  it('refuses a caller who is neither manager nor gate admin', async () => {
    await expect(submit({ data: payload, auth } as never)).rejects.toThrow('NOT_EVENT_STAFF');
  });

  it('refuses a malformed gate account or device key', async () => {
    state.manager = [true, false];
    await expect(submit({ data: { ...payload, gateAccount: '0xnope' }, auth } as never)).rejects.toThrow('BAD_GATE_ACCOUNT');
    await expect(submit({ data: { ...payload, kx: '0x11' }, auth } as never)).rejects.toThrow('BAD_DEVICE_KEY');
  });
});

describe('listPendingGates', () => {
  it('lists this event queue for a PERM_MANAGE_GATES admin', async () => {
    state.manageGates = true;
    await submit({ data: payload, auth } as never);
    await submit({ data: { ...payload, gateAccount: '0x5555555555555555555555555555555555555555' }, auth } as never);

    const result = (await list({ data: { eventId: '11' }, auth } as never)) as {
      gates: Array<Record<string, unknown>>;
    };
    expect(result.gates).toHaveLength(2);
    expect(result.gates[0]).toMatchObject({ kx: `0x${'11'.repeat(32)}`, status: 'pending' });
    expect(Object.keys(result.gates[0]!).sort()).toEqual([
      'createdAt', 'deviceLabel', 'gateAccount', 'kx', 'ky', 'status',
    ]);
  });

  it('refuses a manager without PERM_MANAGE_GATES', async () => {
    state.manager = [true, true];
    await expect(list({ data: { eventId: '11' }, auth } as never)).rejects.toThrow('NOT_GATE_ADMIN');
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `firebase emulators:exec --only firestore,auth "pnpm --filter monti-functions exec vitest run test/pendingGates.test.ts"`
Expected: FAIL — `Failed to resolve import "../src/functions/pendingGates.js"`

- [ ] **Step 3: `db.ts`에 컬렉션을 더한다**

```ts
export const PENDING_GATES = 'pendingGates';
```

`ALLOWED_COLLECTIONS` 배열에 `PENDING_GATES`를 `DELETION_REQUESTS` 뒤에 넣는다:

```ts
export const ALLOWED_COLLECTIONS = [
  PERSONS,
  USERS,
  PASSKEYS,
  DEVICES,
  INVITES,
  KYC_SESSIONS,
  AUTH_CHALLENGES,
  PHONE_INDEX,
  TRANSFER_INVITES,
  EVENT_CHATS,
  DELETION_REQUESTS,
  PENDING_GATES,
  'members',
  'messages',
] as const;
```

보안 규칙은 손대지 않는다 — 머리말 규칙의 마지막 `match /{document=**} { allow read, write: if false; }` 가 이미 클라이언트를 전면 차단한다.

- [ ] **Step 4: `pendingGates.ts`를 쓴다**

```ts
import { FieldValue } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { organizersAbi, ticketAbi, type Hex } from '@monti/shared';
import { resolveCallerAccount } from '../lib/auth.js';
import { deployment, publicClient } from '../lib/chain.js';
import { PENDING_GATES, USERS, db } from '../lib/db.js';

const PERM_MANAGE_GATES = 2;

async function orgIdOf(eventId: string): Promise<bigint> {
  const orgId = await publicClient().readContract({
    address: deployment().ticket, abi: ticketAbi, functionName: 'eventOrg', args: [BigInt(eventId)],
  });
  return orgId as bigint;
}

async function canManageGates(orgId: bigint, account: Hex): Promise<boolean> {
  const allowed = await publicClient().readContract({
    address: deployment().organizers, abi: organizersAbi, functionName: 'hasPermission',
    args: [orgId, account, PERM_MANAGE_GATES],
  });
  return allowed as boolean;
}

/** 스태프가 단말기에서 만든 게이트 계정을 관리자 화면 큐에 올린다(스펙 §5.7 1번). */
export const submitPendingGate = onCall(async (request): Promise<{ ok: true }> => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'AUTH_REQUIRED');
  const { eventId, gateAccount, kx, ky, deviceLabel } = (request.data ?? {}) as {
    eventId?: string; gateAccount?: string; kx?: string; ky?: string; deviceLabel?: string;
  };
  if (!eventId || !/^[0-9]+$/.test(eventId)) throw new HttpsError('invalid-argument', 'BAD_EVENT_ID');
  if (!gateAccount || !/^0x[0-9a-fA-F]{40}$/.test(gateAccount)) {
    throw new HttpsError('invalid-argument', 'BAD_GATE_ACCOUNT');
  }
  for (const key of [kx, ky]) {
    if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new HttpsError('invalid-argument', 'BAD_DEVICE_KEY');
  }
  if (!deviceLabel || typeof deviceLabel !== 'string' || deviceLabel.length > 60) {
    throw new HttpsError('invalid-argument', 'BAD_DEVICE_LABEL');
  }

  const caller = await resolveCallerAccount(request);
  const orgId = await orgIdOf(eventId);
  const [manager, gateAdmin] = await Promise.all([
    publicClient().readContract({
      address: deployment().organizers, abi: organizersAbi, functionName: 'managerOf', args: [orgId, caller],
    }),
    canManageGates(orgId, caller),
  ]);
  if (!(manager as readonly [boolean, boolean])[0] && !gateAdmin) {
    throw new HttpsError('permission-denied', 'NOT_EVENT_STAFF');
  }

  const personId = (await db.collection(USERS).doc(uid).get()).get('personId') as Hex | undefined;
  if (!personId) throw new HttpsError('failed-precondition', 'NO_PERSON');

  await db.collection(PENDING_GATES).doc(gateAccount).set(
    {
      eventId,
      orgId: orgId.toString(),
      kx: kx as Hex,
      ky: ky as Hex,
      deviceLabel,
      submittedBy: personId,
      createdAt: FieldValue.serverTimestamp(),
      status: 'pending',
    },
    { merge: true },
  );

  return { ok: true };
});

/** 관리자 화면이 "승인 대기 중인 단말기" 목록을 읽는다. 승인은 체인에서 직접 한다. */
export const listPendingGates = onCall(
  async (request): Promise<{
    gates: Array<{ gateAccount: Hex; kx: Hex; ky: Hex; deviceLabel: string; createdAt: number; status: string }>;
  }> => {
    const { eventId } = (request.data ?? {}) as { eventId?: string };
    if (!eventId || !/^[0-9]+$/.test(eventId)) throw new HttpsError('invalid-argument', 'BAD_EVENT_ID');

    const caller = await resolveCallerAccount(request);
    const orgId = await orgIdOf(eventId);
    if (!(await canManageGates(orgId, caller))) throw new HttpsError('permission-denied', 'NOT_GATE_ADMIN');

    const snapshot = await db
      .collection(PENDING_GATES)
      .where('eventId', '==', eventId)
      .limit(200)
      .get();

    return {
      gates: snapshot.docs.map((doc) => ({
        gateAccount: doc.id as Hex,
        kx: doc.get('kx') as Hex,
        ky: doc.get('ky') as Hex,
        deviceLabel: doc.get('deviceLabel') as string,
        createdAt: (doc.get('createdAt')?.toMillis?.() ?? 0) as number,
        status: doc.get('status') as string,
      })),
    };
  },
);
```

`functions/src/index.ts`에 추가: `export { submitPendingGate, listPendingGates } from './functions/pendingGates.js';`

- [ ] **Step 5: `tenderlyWebhook`이 큐를 닫게 한다**

`functions/src/functions/tenderlyWebhook.ts`의 import 에 `PENDING_GATES`를 더하고:

```ts
import { DEVICES, EVENT_CHATS, PENDING_GATES, PERSONS, TRANSFER_INVITES, db } from '../lib/db.js';
```

`case 'AdminSet': case 'ManagerSet': case 'GateRegistered':` 묶음에서 `GateRegistered`를 분리한다:

```ts
        case 'GateRegistered': {
          // 체인에 올라간 순간 대기열은 끝난다. 권한 판정은 여전히 eth_call 이다.
          const gateAccount = event.args.gateAccount as Hex;
          const pending = await db.collection(PENDING_GATES).doc(gateAccount).get();
          if (pending.exists) await pending.ref.update({ status: 'registered' });
          console.log(JSON.stringify({ cacheInvalidate: 'GateRegistered', gateAccount }));
          break;
        }
        case 'AdminSet':
        case 'ManagerSet':
          // 권한 판정은 항상 eth_call 이다. 여기서는 클라이언트 캐시 무효화 신호만 남긴다.
          console.log(JSON.stringify({ cacheInvalidate: event.name, args: String(event.args.orgId ?? '') }));
          break;
```

그리고 `functions/test/tenderly.test.ts`에 한 케이스를 덧붙인다:

```ts
describe('GateRegistered decoding', () => {
  it('decodes the gate account so the pending queue can be closed', async () => {
    const { organizersAbi } = await import('@monti/shared');
    const { encodeEventTopics: topicsOf, encodeAbiParameters: paramsOf, parseAbiParameters: parseOf } = await import('viem');
    const topics = topicsOf({
      abi: organizersAbi,
      eventName: 'GateRegistered',
      args: { gateId: 3n, eventId: 11n, gateAccount: '0x1234123412341234123412341234123412341234' },
    });
    const data = paramsOf(parseOf('bytes32 kx, bytes32 ky'), [`0x${'11'.repeat(32)}`, `0x${'22'.repeat(32)}`]);
    const decoded = decodeMontiLogs([{ raw: { topics, data } }]);
    expect(decoded[0]!.name).toBe('GateRegistered');
    expect(decoded[0]!.args.gateAccount).toBe('0x1234123412341234123412341234123412341234');
  });
});
```

- [ ] **Step 6: 테스트를 통과시킨다**

Run:
```bash
firebase emulators:exec --only firestore,auth "pnpm --filter monti-functions exec vitest run test/pendingGates.test.ts"
pnpm --filter monti-functions exec vitest run test/tenderly.test.ts
```
Expected: `Tests  6 passed (6)` 그리고 `Tests  5 passed (5)`

- [ ] **Step 7: 정합성 가드와 전체를 다시 돌린다**

Run:
```bash
pnpm --filter monti-functions exec vitest run test/consistency.test.ts
pnpm test:functions
```
Expected: 정합성 `Tests  5 passed (5)`(`pendingGates`가 허용목록에 들어갔다), 전체 통과.

- [ ] **Step 8: 배포하고 함수 수를 확인한다**

Run:
```bash
pnpm --filter monti-functions build && firebase deploy --only functions --project dev
firebase functions:list --project dev | grep -c asia-northeast3
```
Expected: `29`(Task 44까지 끝낸 뒤) 또는 `28`(43까지)

- [ ] **Step 9: 커밋**

```bash
git add functions/src/functions/pendingGates.ts functions/src/lib/db.ts \
        functions/src/functions/tenderlyWebhook.ts functions/src/index.ts \
        functions/test/pendingGates.test.ts functions/test/tenderly.test.ts
git commit -m "feat(functions): queue staff-created gate accounts for organizer approval"
```

---

## Task 44: `startKyc` — 공연별·요청 시 본인인증

**Files:**
- Create: `functions/src/functions/startKyc.ts`
- Test: `functions/test/startKyc.test.ts`

**Interfaces:**
- Consumes: Task 16의 `createDiditSession`; Task 15 `resolveCallerAccount`, `PERSONS`, `USERS`; Task 14 `DIDIT_API_KEY`, `DIDIT_WORKFLOW_ID`, `RP_ID`.
- Produces: callable `startKyc`: `{}` → `{ kycUrl: string; sessionId: string }`. 인증은 **활성 계정**(`persons.status === 'active'`). Didit 세션을 열고 `persons.kyc = { provider:'didit', sessionId, url, status:'open' }` 를 쓴다. 이미 열린 세션이 있으면 **새로 만들지 않고 그대로 돌려준다**. 이미 `kycLevel === 1` 이면 `ALREADY_VERIFIED` 로 거절한다.

**흐름(창업자 델타):** 가입에는 본인인증이 없다. 관객이 `requireKyc === true` 인 공연의 티켓을 받으려 할 때 03이 `getSignupStatus().kycLevel === 0` 을 보고 `startKyc` 를 부른다 → 시스템 브라우저로 Didit 링크를 연다 → 딥링크로 복귀 → `diditWebhook`(Task 17)이 승인·얼굴 중복 없음을 확인하면 어테스터가 `Identity.setKycLevel(personId, 1)` 을 보내고 `persons.kycLevel = 1` 이 된다. 03은 `getSignupStatus` 로 폴링한다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`functions/test/startKyc.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const createDiditSession = vi.fn(async () => ({ sessionId: 'sess-9', url: 'https://verify.didit.me/s/sess-9' }));
vi.mock('../src/lib/didit.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/didit.js')>();
  return { ...actual, createDiditSession };
});

const { db, PERSONS, USERS } = await import('../src/lib/db.js');
const { startKyc } = await import('../src/functions/startKyc.js');
const functionsTest = (await import('firebase-functions-test')).default();
const start = functionsTest.wrap(startKyc);

const PERSON_ID = `0x${'aa'.repeat(32)}`;
const ACCOUNT = '0x9999999999999999999999999999999999999999';
const auth = { uid: 'uid-1', token: { account: ACCOUNT } };

beforeEach(async () => {
  createDiditSession.mockClear();
  process.env.DIDIT_API_KEY = 'didit-key';
  process.env.DIDIT_WORKFLOW_ID = 'wf-1';
  for (const collection of [PERSONS, USERS]) {
    const snap = await db.collection(collection).get();
    await Promise.all(snap.docs.map((d) => d.ref.delete()));
  }
  await db.collection(USERS).doc('uid-1').set({ personId: PERSON_ID, phoneE164: '+821011112222' });
  await db.collection(PERSONS).doc(PERSON_ID).set({ status: 'active', kycLevel: 0, account: ACCOUNT });
});

describe('startKyc', () => {
  it('opens a Didit session and records it on the person', async () => {
    const result = (await start({ data: {}, auth } as never)) as { kycUrl: string; sessionId: string };
    expect(result).toEqual({ kycUrl: 'https://verify.didit.me/s/sess-9', sessionId: 'sess-9' });

    const person = await db.collection(PERSONS).doc(PERSON_ID).get();
    expect(person.get('kyc.sessionId')).toBe('sess-9');
    expect(person.get('kyc.url')).toBe('https://verify.didit.me/s/sess-9');
    expect(person.get('kyc.status')).toBe('open');
    expect(person.get('kycLevel')).toBe(0); // 레벨은 웹훅이 올린다
    expect(createDiditSession.mock.calls[0]![0]).toBe(PERSON_ID); // vendor_data = personId(난수)
  });

  it('reuses an already open session instead of burning a new one', async () => {
    const first = (await start({ data: {}, auth } as never)) as { sessionId: string };
    const second = (await start({ data: {}, auth } as never)) as { sessionId: string };
    expect(second.sessionId).toBe(first.sessionId);
    expect(createDiditSession).toHaveBeenCalledTimes(1);
  });

  it('opens a fresh session after a rejected one', async () => {
    await start({ data: {}, auth } as never);
    await db.collection(PERSONS).doc(PERSON_ID).set(
      { kyc: { status: 'rejected', rejectedReason: 'duplicate_face' } },
      { merge: true },
    );
    await start({ data: {}, auth } as never);
    expect(createDiditSession).toHaveBeenCalledTimes(2);
  });

  it('refuses a person who is already verified or not active yet', async () => {
    await db.collection(PERSONS).doc(PERSON_ID).set({ kycLevel: 1 }, { merge: true });
    await expect(start({ data: {}, auth } as never)).rejects.toThrow('ALREADY_VERIFIED');

    await db.collection(PERSONS).doc(PERSON_ID).set({ kycLevel: 0, status: 'pending' }, { merge: true });
    await expect(start({ data: {}, auth } as never)).rejects.toThrow('NOT_ACTIVE');
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `firebase emulators:exec --only firestore,auth "pnpm --filter monti-functions exec vitest run test/startKyc.test.ts"`
Expected: FAIL — `Failed to resolve import "../src/functions/startKyc.js"`

- [ ] **Step 3: `startKyc.ts`를 쓴다**

```ts
import { FieldValue } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import type { Hex } from '@monti/shared';
import { DIDIT_API_KEY, DIDIT_WORKFLOW_ID, RP_ID } from '../config.js';
import { PERSONS, USERS, db } from '../lib/db.js';
import { createDiditSession } from '../lib/didit.js';

/**
 * 본인인증은 가입이 아니라 **필요한 공연을 만났을 때** 시작한다(창업자 델타).
 * 이 함수는 세션만 연다. 레벨을 올리는 것은 diditWebhook 이고, 체인 쓰기도 거기서 한다.
 */
export const startKyc = onCall(
  { secrets: [DIDIT_API_KEY, DIDIT_WORKFLOW_ID] },
  async (request): Promise<{ kycUrl: string; sessionId: string }> => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError('unauthenticated', 'AUTH_REQUIRED');

    const personId = (await db.collection(USERS).doc(uid).get()).get('personId') as Hex | undefined;
    if (!personId) throw new HttpsError('not-found', 'NO_SIGNUP');

    const personRef = db.collection(PERSONS).doc(personId);
    const person = await personRef.get();
    if (!person.exists) throw new HttpsError('not-found', 'NO_SIGNUP');
    if (person.get('status') !== 'active') throw new HttpsError('failed-precondition', 'NOT_ACTIVE');
    if ((person.get('kycLevel') as number | undefined) === 1) {
      throw new HttpsError('already-exists', 'ALREADY_VERIFIED');
    }

    // Didit 은 완료된 세션만 과금한다. 열린 세션이 있으면 그것을 다시 쓴다.
    if (person.get('kyc.status') === 'open') {
      const url = person.get('kyc.url') as string | undefined;
      const sessionId = person.get('kyc.sessionId') as string | undefined;
      if (url && sessionId) return { kycUrl: url, sessionId };
    }

    const session = await createDiditSession(
      personId, // vendor_data = 난수 personId. 개인정보는 넣지 않는다.
      DIDIT_API_KEY.value(),
      DIDIT_WORKFLOW_ID.value(),
      `https://${RP_ID.value()}/kyc/callback`,
    );

    await personRef.set(
      {
        kyc: { provider: 'didit', sessionId: session.sessionId, url: session.url, status: 'open' },
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    return { kycUrl: session.url, sessionId: session.sessionId };
  },
);
```

`functions/src/index.ts`에 추가: `export { startKyc } from './functions/startKyc.js';`

- [ ] **Step 4: 테스트를 통과시킨다**

Run: `firebase emulators:exec --only firestore,auth "pnpm --filter monti-functions exec vitest run test/startKyc.test.ts"`
Expected: PASS — `Tests  4 passed (4)`

- [ ] **Step 5: 가입 경로에 Didit이 남아 있지 않은지 확인한다**

Run:
```bash
grep -n "createDiditSession" functions/src/functions/*.ts
```
Expected: `startKyc.ts` 와 `device.ts`(기기 교체용 재인증) 두 파일만. **`startSignup.ts` 가 나오면 델타가 덜 적용된 것이다.**

- [ ] **Step 6: 레벨 상승 전체 경로를 한 번 돌린다**

Run:
```bash
firebase emulators:exec --only firestore,auth \
  "pnpm --filter monti-functions exec vitest run test/startKyc.test.ts test/didit.test.ts test/getSignupStatus.test.ts"
```
Expected: PASS — `Tests  13 passed (13)` (startKyc 4 + didit 4 + getSignupStatus 5)

- [ ] **Step 7: 커밋**

```bash
git add functions/src/functions/startKyc.ts functions/src/index.ts functions/test/startKyc.test.ts
git commit -m "feat(functions): start per-event KYC on demand and reuse open Didit sessions"
```

---

## Self-Review

### 1. 스펙 커버리지

| 스펙 / 마스터 계획 요구 | 구현 Task | 비고 |
|---|---|---|
| §5.1 가입: 전화 → 패스키 → 계정·신원 등록 (**본인인증 없음**) | 16, 18, 19 | 창업자 델타로 KYC가 가입에서 빠졌다. 통합 테스트 32가 한 줄로 확인 |
| 창업자 델타: 공연별·요청 시 본인인증 | 44, 17 | `startKyc` → Didit → `Identity.setKycLevel(personId, 1)` |
| §5.1 "이미 계정이 있습니다"(Face Search 1:N) | 17 | 중복 얼굴이면 `kycLevel` 0 유지 + `kyc.rejectedReason='duplicate_face'` |
| 레벨 0 계정의 중복 방지 = 전화번호 | 16, 24 | `phoneIndex/{hmacPhone}` 한 번호당 한 계정 |
| §5.5 기기 잠금 / 새 기기 7일 쿨타임 | 21 | 쿨타임은 `Identity.deviceUpdatedAt`에서 읽는다 |
| §5.5 패스키 유실 → 계정 교체 | 13, 29 | `rotateAccount`는 어테스터 경로(`sendAttesterTx`)로 열려 있고, 대사는 29가 한다 |
| §9.1 전화 인증 = Firebase | 10, 16 | `request.auth.token.phone_number` |
| §9.2 Didit 웹훅 HMAC + 재시도 2회 → 대사 | 17, 29 | `X-Signature-V2`, 300 s, `kycSessions` 멱등 |
| §9.2 법적 메모(민감정보 분리 보관) | 12, 17 | KMS 봉투 암호화 + 레닥션 |
| §9.3 기기 정책 | 21 | |
| §9.4 권한 = 체인 allowlist, DB에 역할 없음 | 15, 23, 31 | `acceptInvite`는 calldata만 돌려주고 Task 31이 정적으로 강제 |
| §10.3 체인 밖 데이터 목록 전부 | 11, 12, 16~27 | 컬렉션 표(머리말)와 1:1 |
| §10.4 규칙 1 (체인 값 원본 금지) | 31 | 컬렉션 허용목록 정적 스캔 |
| §10.4 규칙 2 (문서 키 = 체인 ID) | 15, 16, 18 | `persons/{personId}`, `devices/{account}`, `CheckIn(id=tokenId)` |
| §10.4 규칙 3 (대기 → finalized → 완료, personId 멱등) | 19, 17, 29, 31 | 멱등 테스트 + `awaitFinalized` + 대사 스케줄. `setKycLevel` 도 같은 규칙을 따른다 |
| §10.4 규칙 4 (캐시에 block 표시) | 19, 29, 36 | `chain.block`, `CheckIn.block` |
| §10.4 인덱서 + 일일 백업 | 30, 33~38 | GCS JSONL + BigQuery |
| §11 아키텍처(Functions·KMS·Envio·Tenderly) | 10~14, 28, 33~38 | |
| §12 오프라인: 서명된 스냅샷 | 8, 22 | `canonicalJson` + `snapshotDigest`를 04와 공유 |
| §13 ADMIT 화면 사진 | 22 | `getPhotoForGate({ tokenId, gateAccount })`, 스태프 세션. `requireKyc=false` 공연은 빈 사진 + 아바타 플레이스홀더 |
| §9.4 스태프 인가 (매니저 또는 게이트·결재 권한 관리자) | 15 | `requireStaffForGate` 인가 매트릭스 테스트 8개 |
| 마스터 Cloud Functions 표 14행 전부 | 16~30 | 이름 그대로 |
| 마스터 Envio entities 10종 | 34~37 | + 델타 `Offer`, `Event.requireKyc`, `IdentityAccount.kycLevel` |
| 마스터 Firestore 6 컬렉션 | 11, 15~25 | + `authChallenges`, `phoneIndex`, `transferInvites`, `eventChats` |
| 인터페이스 델타: 닉네임·오퍼·카테고리·상태 | 3, 4, 24~28, 34~36 | |
| 인터페이스 델타: 채팅 3함수 + 규칙 | 11, 26 | |
| sub-plan 03: 공지 고정 `pinMessage` | 40 | 주최자 관리자만, 클라이언트는 `pinned` 쓰기 불가 |
| sub-plan 03 · 개인정보 보호법: 계정 삭제 요청 | 41 | 7일 유예, 티켓 보유 시 차단, Didit 세션 삭제까지 |
| 교차 리뷰: 가입 진행 상태 폴링 | 42 | `getSignupStatus`, `pending`이면 Didit 링크 재발급 없이 재사용 |
| 교차 리뷰 · §5.7: 게이트 등록 대기열 | 43 | `pendingGates` + `submitPendingGate` / `listPendingGates`, `GateRegistered`가 닫는다 |
| 04 합의: `attesterSig` 규약, `ATTESTER_ADDRESS`, 닉네임 `displayName` | 2, 8, 22 | |
| 04 합의: 스냅샷 `eventTitle`·`requireKyc`·`tierName`·`seat` | 1, 8, 22 | `eventTitle`은 IPFS 메타데이터에서 읽어 CID 단위로 캐시 |
| Global Constraints: 가스 한도 = estimate × 1.075 | 2, 14, 31 | `withGasMargin` + 정적 강제 |
| Global Constraints: 크립토 단어 금지 린트 | 9 | exit 1 |
| Global Constraints: AASA·assetlinks D0 게시 | 39 | `appAssociation: "NONE"` |
| Global Constraints: `signalAllAcceptedCredentials` 금지 | 20 Step 4 | grep 확인 |

**빈칸 없음.** 스펙 §8.7(결제)과 §6~7의 게이트/단말기 로직은 이 계획의 범위 밖이며 각각 "해커톤 이후"와 sub-plan 04 소관이다.

### 2. 플레이스홀더 스캔

- "TBD", "TODO", "나중에", "적절히 처리"류 문구: **0건**.
- "Task N과 같다"류 참조: **0건**. 반복되는 코드(예: Didit 세션 생성, 어테스터 서명)는 매번 전체를 실었다.
- 코드 블록 안의 `...`: **0건**. 모든 TypeScript 블록이 import 포함 완전한 파일 또는 명시된 위치의 전체 추가분이다.
- 환경 의존 값(`<TEAMID>`, `<deployment-id>`, SHA-256 핑거프린트)은 **리터럴로 박지 않고 생성 스크립트의 입력**으로 만들었다(Task 38, 39). 값 자체는 사람이 콘솔에서만 얻을 수 있다.
- 정의 없이 쓰인 타입·함수: 없음. `@monti/shared`의 모든 export는 Task 1~9에서, `functions/src/lib/*`의 모든 export는 Task 12~15에서 정의된다.

확인 명령:
```bash
grep -nE "TODO|TBD|\.\.\.$|Similar to Task|적절히|나중에 구현" docs/superpowers/plans/2026-09-20-monti-02-firebase-indexer.md | grep -v "^\s*$"
```
Expected: 출력 없음.

### 3. 타입 정합성 (마스터 계획 대비)

| 마스터 계획 이름 | 이 계획에서 | 결과 |
|---|---|---|
| `Hex`, `GateCodeWire`, `GateResponseWire`, `SnapshotWire` | Task 1 `types.ts` 그대로 | 일치 |
| `BANNED_ATTENDEE_WORDS` 배열 15개 | Task 2 `constants.ts` (마스터는 `types.ts`에 적었다) | **파일만 다름**, 이름·값 동일. 패키지 루트에서 같은 이름으로 export |
| `persons.status` | `'pending'\|'kyc_ok'\|'active'\|'rotated'\|'rejected'` | 마스터의 Firestore 표에는 `'rejected'`가 없지만 Cloud Functions 표의 `diditWebhook` 행이 `'rejected'`를 쓴다. **함수 표를 따랐고**, 머리말의 Firestore 표에 유니온 전체를 적어 두었다 |
| `Identity.*`, `Organizers.*`, `Ticket.*` 시그니처 | Task 3 `abi.ts` | 인자 이름·타입·순서 그대로 + 델타 추가분 |
| `deviceSig` 해시 = `sha256(abi.encode(tokenId, gateId, eventId, nonce, issuedAt))` | Task 4 `deviceSigHash` | 순서 그대로, 고정 벡터로 고정 |
| `GateCodeWire.sig` 해시 = `sha256(abi.encode(gateId, eventId, issuedAt, nonce))` | Task 4 `gateCodeHash` | 순서 그대로 |
| `attesterSig` = secp256k1 over `keccak256(canonical JSON without attesterSig)` | Task 8 `snapshotDigest` | 04와 합의해 **raw 65바이트 r‖s‖v, EIP-191 없음**으로 확정 |
| Cloud Functions 이름 14행 | Task 16~30 | 이름 한 글자도 바꾸지 않음. 델타 6개가 추가됨 |
| `issueSnapshot` / `getPhotoForGate` 입력 | Task 22 | 마스터 계획의 `{ eventId }` / `{ tokenId }` 에 **`gateAccount` 인자를 추가**했다(아래 §4-6) |
| Envio `Manager(id=orgId-account, canApprove)` | Task 34 | `orgId`, `account`, `exists` 필드를 **추가**했다(`ManagerSet`이 `exists`를 싣고, 해임을 표현해야 한다). id 규칙은 동일 |
| Envio `Admin(id=orgId-account, bits)` | Task 34 | `bits`를 `BigInt!`로(uint32가 GraphQL `Int`를 넘는다) |
| Envio `CheckIn(id=tokenId, …)` | Task 36 | 동일 |

**교차 확인 명령** (실행 후 두 목록이 같아야 한다):
```bash
grep -oE "^\| \`[a-zA-Z]+\` \| (callable|HTTPS|scheduled)" docs/superpowers/plans/2026-09-20-monti-00-master-plan.md | sort
grep -oE "^export (const|\{) [a-zA-Z]+" functions/src/index.ts | sort
```

### 4. 마스터 계획에서 문제가 있다고 판단했지만 **그대로 구현한** 것

실행자는 아래를 고치지 말고 그대로 두어야 한다. 바꾸려면 마스터 계획을 먼저 고친다.

1. **금지어 매칭이 식별자를 잡는다.** `token`, `gas`, `chain`을 부분 문자열로 검사하면 `tokenId`, `gasLimit`, `chainId`가 전부 걸려 린터가 무력화된다. Task 9는 **영어만 단어 경계**(`\bgas\b`)로 검사하고 한글은 부분 문자열로 둔다. 목록 자체는 손대지 않았다. 또한 Global Constraints 문장은 `NFT`를 두 번 적고 `Monad`를 대문자로 적었는데, 코드가 쓰는 배열은 `NFT` 하나와 소문자 `monad`다(비교는 대소문자 무시라 결과는 같다).
2. **`persons.status`의 `kyc_ok`·`rejected`는 창업자 델타 뒤로 죽은 값이 됐다.** 본인인증이 가입에서 빠지면서 정상 경로가 `pending → active` 하나가 되었고, 본인인증 통과 여부는 status가 아니라 **`kycLevel`(0/1)** 이 따로 들고 있다. 마스터 계획의 유니온을 깨지 않으려고 두 값과 그 전이는 `assertStatusTransition`에 남겨 두었지만 **이 계획의 어떤 함수도 더 이상 쓰지 않는다**. 03·04는 `status === 'active' && kycLevel === 1` 로 판단해야 하며 `'kyc_ok'` 를 기대하면 안 된다.
3. **`seat`은 지금 항상 빈 문자열이다.** 좌석 지정은 스펙 §15의 Could 항목이라 MVP에 배정 로직이 없다. 필드는 04와 합의한 대로 자리를 잡아 두었고, 좌석 기능이 들어오면 `Ticket` 쪽에 좌석 저장소가 생긴 뒤 여기서 읽어 채우면 된다. **`seat` 을 옵셔널로 바꾸면 `canonicalJson` 결과가 달라져 04의 서명 검증이 깨지므로 항상 존재해야 한다.**
4. **`GateResponseWire`의 CBOR이 스펙 §7.3의 "≈130 B"보다 크다.** `deviceSig`가 바이트가 아니라 130자 16진수 **문자열**이라 CBOR 페이로드가 약 160 B가 된다. Type 4 CC 한도 안이라 동작에는 문제가 없고, 타입을 바꾸면 03·04가 함께 바뀌므로 그대로 두었다. 바이트로 바꾸면 약 100 B로 줄어든다.
5. **`Identity.Registered`가 기기 키도 KYC 레벨도 싣지 않는다.** `register(personId, account, deviceX, deviceY, kycLevel)`는 다섯 인자를 받는데 이벤트는 `(personId, account)`뿐이다. 그래서 Envio `IdentityAccount`의 `deviceX/deviceY`는 0으로, `kycLevel`은 0으로 시작한다. **sub-plan 01이 `register()` 안에서 `DeviceChanged`와 `KycLevelSet`을 함께 emit 하기로 했고**(창업자 델타 6번), 인덱서는 그 두 이벤트만 구독하면 된다 — 트랜잭션 입력을 디코드하지 않는다. 01이 emit을 빠뜨리면 두 값은 다음 변경 때까지 0으로 남는다.
6. **`registerPasskey`에 챌린지 인자가 없다.** 마스터 계획의 입력은 `{ personId, attestation }`뿐인데 `@simplewebauthn/server`는 `expectedChallenge`를 요구한다. 시그니처를 바꾸지 않고, 챌린지를 `clientDataJSON`에서 꺼내 `authChallenges/{challenge}`(마스터 계획 Firestore 표에 없는 **추가 컬렉션**)와 대조해 1회 소비하도록 했다. 발급은 `loginChallenge({ purpose: 'register' })`가 한다.
7. **`issueSnapshot` / `getPhotoForGate` 의 인가 조건을 고쳤다(결정됨).** 마스터 계획은 "호출자의 스마트 계정이 `isOpenGate(eventId, account)`를 만족하거나 매니저"라고 적었지만, 게이트 계정의 소유자 키는 **패스키가 아니라 안드로이드 하드웨어 P-256 키**라서 그 계정으로는 Firebase 세션을 만들 수 없다. 확정된 규약은 이렇다. **호출자는 언제나 스태프 본인의 Firebase 세션**(패스키 스마트 계정 = `persons.account`)이고, 게이트는 `gateAccount` 인자로 넘어온다. `requireStaffForGate` 가 두 조건을 **모두** 검사한다 — (a) 호출자가 `managerOf(eventOrg(eventId), caller).exists` 이거나 `hasPermission(orgId, caller, PERM_MANAGE_GATES)` 또는 `hasPermission(orgId, caller, PERM_APPROVE_OVERRIDE)`, (b) `isOpenGate(eventId, gateAccount)` 이거나 (공연 전 스냅샷 내려받기를 위해) 그 게이트가 같은 공연에 등록돼 있고 폐기되지 않았을 것. **게이트 단말기 계정은 Firebase에 절대 로그인하지 않는다.** 권한 비트는 마스크 하나로 묶지 않고 비트별로 따로 물어 OR 한다(01의 `hasPermission` 이 "모든 비트"로 구현될 가능성에 대비). 이것이 마스터 계획 함수 표의 입력을 **바꾸는** 유일한 항목이다: `{ eventId }` → `{ eventId, gateAccount }`, `{ tokenId }` → `{ tokenId, gateAccount }`.
8. **`phoneIndex`, `transferInvites`, `eventChats`, `authChallenges`는 마스터 계획의 Firestore 표에 없다.** 인터페이스 델타와 WebAuthn 요구사항 때문에 추가했고, 머리말의 "Firestore 컬렉션 전체 목록" 표가 필드까지 포함한 최신본이다. 특히 `authChallenges/{challenge}` 는 문서 id 가 챌린지 문자열 자체이고 `{ purpose, expiresAt, createdAt, usedAt? }` 를 담으며 `loginChallenge` 가 발급하고 `registerPasskey`/`loginVerify` 가 1회 소비한다(TTL 300초). Task 31의 허용목록이 네 개를 모두 포함한다.
9. **Firestore 규칙은 `EVENT_CHAT_MESSAGE_MAX_CHARS`를 import 할 수 없다.** 규칙 파일에 `500`이 리터럴로 박힌다. Task 2의 상수 테스트가 500을 고정하고 Task 11의 규칙 테스트가 501자를 거부하는지 확인하므로, 한쪽만 바뀌면 테스트가 깨진다.

### 5. 실행자 체크리스트 (이 계획을 끝낸 뒤 참이어야 하는 것)

```bash
pnpm test:shared                                   # 9 files, 전부 통과
pnpm test:functions                                # 에뮬레이터 위에서 전부 통과
pnpm --filter monti-indexer exec vitest run        # 4 files 통과
pnpm lint:copy                                     # copy-lint: clean
firebase functions:list --project dev | grep -c asia-northeast3   # 29
curl -sI https://monti.app/.well-known/apple-app-site-association | grep -c "application/json"  # 1
```

모두 참이면 sub-plan 03과 04가 `@monti/shared`와 22개 함수, 호스티드 인덱서를 그대로 쓸 수 있다.
