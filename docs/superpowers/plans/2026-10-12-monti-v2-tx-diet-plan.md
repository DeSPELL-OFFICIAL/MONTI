# MONTI v2 트랜잭션 다이어트 — 구현 계획 (2026-10-12)

설계: `docs/superpowers/specs/2026-10-12-monti-v2-tx-diet-design.md`(D1–D8 결정, 시그니처, 상태 기계, 검증 매트릭스).
이 문서는 **레인별 번호 작업**이다. 각 작업: 규모(S ≤45분 · M ≤1.5시간 · L ≤2시간) · 파일 · 테스트 먼저(TDD) ·
명령 · 수용기준(AC) · 의존 · 병렬.

- **공통 제약:** 화면에 web3 낱말 금지(`pnpm lint:copy`), 가스는 MONTI 부담, 하위 호환·폴백 추가 금지(안 쓰는 경로는
  삭제), 이미 있는 라이브러리 사용(viem·solady·OZ). v1 운영(컨트랙트·`us-east1` 함수·`monti.despell.io` 배포)은
  O8 전환 전까지 **건드리지 않는다**.
- **Node:** `fnm exec --using=22 …` · **Firebase 배포:** `GOOGLE_APPLICATION_CREDENTIALS=/Users/moomi/Downloads/z03.Vibe_Coding/MONTI/.secrets/monti-deployer.json`
  접두, **`--force` 금지**(삭제 프롬프트가 뜨면 멈추는 것이 안전장치다) · **비밀값은 출력·커밋 금지.**
- **커밋:** conventional commits, 메시지 끝에 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **브랜치/워크트리:** C = `MONTI-prod`(`v2/contracts` ← `mvp`), B = `MONTI-backend`(`v2/backend` ← `mvp-settle-indexer`),
  W = `MONTI-web`(`v2/web` ← `mvp-settle-web`), O = 오케스트레이터 + runner + 창업자.

---

## 0. 타임라인과 체크포인트 (KST)

| 시각 | 체크포인트 | 합격 조건 | 담당 |
|---|---|---|---|
| 10-12 00:40–01:00 | **K0 착수** | v1 태그·v2 브랜치 생성, 레인 브리핑(§1 인터페이스 배포) | O |
| 04:00 | **K1 ABI 동결** | `contracts/abi-delta-v2.md` + `packages/shared/src/abi/*.json` 커밋, B·W 워크트리에 복사 | C, O |
| 05:00 | **K2 배포 구조 탐침** | O1 통과(같은 이름·`us-east4`·codebase 분리 공존) — 실패 시 B안 확정 | O |
| 08:30 | **K3 테스트넷 rc1** | `forge test` 전부 green, rc1 배포, cast 배선 12개 OK, `10143.json` 전파 | C, O |
| 10:00 | **K4 로컬 통합** | 백엔드·웹·인덱서·shared 단위 전부 green(rc1 ABI/주소), 백엔드 `functions:v2` 스테이징 배포 성공 | B, W, O |
| 12:00 | **K5 스테이징 준비** | `v2.monti.despell.io` DNS·Vercel 도메인·Firebase 승인 도메인 | 창업자, O |
| 13:00–13:30 | **K6 인덱서 교체** | 창업자가 v1 Envio 배포 삭제 → v2 푸시 → `is_hyper_sync=true`, lag<100 | 창업자, O |
| 14:00 | **K7 하니스 시작** | 스테이징 웹 v2 빌드(인덱서 URL 포함), V3 스모크 통과 | W, O |
| 20:00 | **K8 GO/NO-GO** | V4·V5(또는 승인된 대체)·V6·V7 통과 → 전환 / 아니면 v1 유지 | O + 창업자 |
| 20:00–23:00 | K9 전환 + 무대 준비 | 운영 도메인 v2, 무대 행사 생성(3 tx), 잔고 충전 | O, 창업자 |
| 23:00–10-13 02:00 | **K10 리허설 + 런북** | V10 통과, 런북 갱신, 백업 영상 | O, 창업자 |
| 02:00–09:00 | 버퍼 | 08:00 T-30 점검(런북 §3-15, v2 주소) | O |
| 09:00 | **하드 컷오프** | 이후 운영 전환·롤백 금지(그때 살아 있는 쪽으로 데모) | — |

레인 병렬: C1–C3은 순차(같은 파일, **시그니처 우선** — 본문과 핵심 테스트만 하고 C4에서 04:00 동결, 전체 테스트 이식은 C5),
B1·B2·W1은 ABI 무관이라 K0 직후 시작, B3–B7·W2–W8은 K1 이후. 1인 기준 B ≈ 12시간, W ≈ 10.5시간이라 K4·K7을 맞추려면
**권장 인력 = C 1 + B 2 + W 2 (+ runner)**.
나누는 법: **B-a(B3·B4·B7 정산/인덱서) / B-b(B1·B2·B5·B6 릴레이/요청/닉네임/규칙)**, **W-a(W1–W3·W7 주최자·e2e) /
W-b(W4–W6·W8 관객/스태프/빌드)** — 파일이 겹치지 않는다(공유하는 `shared/api/functions.ts`는 W2가 §1.2 타입만 먼저 커밋).

---

## 1. 인터페이스 동결 (K0에 배포, 레인이 서로를 기다리지 않게)

### 1.1 Solidity (설계 §8 그대로; K1에 실제 ABI JSON으로 확정)

```solidity
// ITicket
struct ClaimAuth { uint256 eventId; uint8 tier; address account; uint256 nonce; uint64 deadline; }
// Ticket
function publishEvent(EventMeta calldata meta, Tier[] calldata tiers_, ISettlementVault.SplitPolicy calldata policy) external returns (uint256 eventId);
function mintPaid(ClaimAuth calldata a, bytes calldata deviceSig) external returns (uint256 tokenId, uint256 priceUsdCents); // vault only
function setVault(address vault_) external;  address public vault;  address public immutable deployer;
// SettlementVault
constructor(address ticket_, address organizers_, address initialDepositor, address initialToken);
function purchase(ITicket.ClaimAuth calldata a, bytes calldata deviceSig, address token) external returns (uint256 tokenId);
function setPolicyByTicket(uint256 eventId, SplitPolicy calldata policy, address organizer) external; // ticket only
uint256 public constant UNITS_PER_CENT = 1e4;
// Organizers.registerGate: 시그니처 동일, open:true + GateOpened
// 삭제: Ticket.createEvent/publishEvent(uint256)/updateEventMeta/requestOverride, EventMetaUpdated, OverrideRequested, NotDraft;
//       SettlementVault.setPolicy/setPolicyDigest/policyNonce/deposit/SETTLE_POLICY_TAG/PolicyAuth;
//       Identity.setNickname/nicknameOwner/nicknameOf/NicknameSet/NicknameTaken/NicknameHashMismatch
// id 시작값: Ticket._nextEventId = 1001, Organizers._nextOrgId = 1001
```

### 1.2 콜러블 (web ↔ backend)

```ts
// purchaseTicket — 요청 모양 그대로
type PurchaseTicketResponse = { orderId: string; relayId: string; status: 'deposited' | 'sent'; tokenId?: string; txHash?: Hex };
// relayAction — 요청에 선택 필드 하나 추가
type RelayActionRequest = { req: ForwardRequestWire; deviceSig: Hex; kind: string; reasons?: string[] }; // reasons: kind 'publishEvent' 전용
// result: publishEvent → { eventId }, registerGate → { gateId } (기존 규약)
// P4
requestOverride: { eventId: string; tokenId: string; gateId: string; reason: 1|2|3|4; note?: string } → { requestId: string }
listOverrideRequests: { eventId: string } → { requests: Array<{ id; tokenId; gateId; reason; note?; requesterAccount; createdAt: number }> }
// P5
setNickname: { nickname: string } → { nickname: string }
resolveNicknames: { accounts: string[] /* ≤100 */ } → { names: Record<string /* lowercase account */, string> }
// 삭제: relaySetPolicy
```

오류 코드(`details.code`): purchase = `AUTH_EXPIRED, BAD_NONCE{nonce}, NOT_MEMBER, DEVICE_LOCKED, BAD_DEVICE_SIG, KYC_REQUIRED,
NOT_ON_SALE, SOLD_OUT, LIMIT, UNKNOWN_TIER, NOT_PUBLISHED, EVENT_ENDED, APPROVAL_REQUIRED, NOT_PAID_TIER, PRICE_MISMATCH{expected},
TREASURY_FUNDS, PAUSED, CONFIG, SEND_FAILED, REVERTED, TOO_MANY_PENDING` · publish(relayAction 버블) = Solidity 이름 그대로
(`PolicyRequired, UnexpectedPolicy, PaidApprovalUnsupported, NotPolicyAuthorizer, BadSplitSum, PlatformShareTooLow, PlatformMirrorMismatch,
InvalidRecipients, ZeroRecipient, ZeroBps, Unauthorized, InvalidTiers, InvalidSchedule`) · requestOverride = `UNKNOWN_EVENT, WRONG_EVENT,
GATE_MISMATCH, NOT_ALLOWED` · setNickname = `NICKNAME_INVALID, NICKNAME_TAKEN, NO_PERSON`.

### 1.3 Firestore 모양

```ts
orders/{account:eventId:nonce}   { personId, account, eventId, tier, amountUsdCents, method:'card-mock',
                                   status:'pending'|'sent'|'deposited'|'released'|'refunded'|'failed',
                                   txHash?, tokenId?, depositTxHash?, releaseTxHash?, refundTxHash?, error?:{code}, createdAt, updatedAt }
relays/{id}                      kind += 'purchase' (−'setPolicy'); relayAction 문서에 data: Hex, reasons?: string[], result?
overrideRequests/{autoId}        { eventId, tokenId, gateId, reason, note?, requesterAccount, requesterPersonId,
                                   status:'open'|'approved', approvedBy?, approvedTxHash?, createdAt, approvedAt?, expireAt }
nicknames/{name}                 { personId, account, updatedAt }
eventDrafts/{uid}/drafts/{id}    + splitJson: string  // JSON.stringify(Array<{name,account,bps,tag,platform}>), ≤4000자
                                 − editingEventId; tiers[].currency 'USDC' + amount(달러 정수) 허용
settlements/{eventId}            (모양 동일) 작성자 = relayAction publish 확정 훅
```

### 1.4 설정 키

백엔드 v2: `FIREBASE_REGION='us-east4'`(shared 상수), `firebase.json` `"codebase": "v2"`, `functions/.env`
`DEV_ORIGINS=https://v2.monti.despell.io`, `ENVIO_GRAPHQL_URL=<v2 id>`. 웹 v2: `VITE_FUNCTIONS_REGION=us-east4`,
`VITE_ADDR_{IDENTITY,ORGANIZERS,TICKET,FORWARDER,SETTLEMENT_VAULT}`=rc1, `VITE_ADDR_USDC`·`VITE_ADDR_PLATFORM` 그대로,
`VITE_ENVIO_URL=<v2 id>`, `VITE_RP_ID=monti.despell.io`.

---

## Lane C — 컨트랙트 (MONTI-prod/contracts, `v2/contracts`)

공통 명령: `cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/MONTI-prod/contracts && forge test` (개별: `--match-path test/X.t.sol -vvv`).
순서 원칙: C1–C3은 **시그니처·본문 + 핵심 테스트**만(04:00 동결이 목표), 기존 스위트 전면 이식은 C5.

### C1 · M — Ticket: 공개 1건 + 배선 + id 오프셋 (01:00–02:00)
- 파일: `src/Ticket.sol`, `src/interfaces/ITicket.sol`, `test/Base.t.sol`, `test/TicketPublish.t.sol`(신규).
- 테스트 먼저:
  1. `Base.t.sol`: `_deployMonti()`가 `MockUSD`와 `SettlementVault(ticket, organizers, TREASURY, usd)`를 배포하고 `ticket.setVault(vault)`까지
     한다(`TREASURY` 상수는 Base로 이동). `_event()`는 `ticket.publishEvent(m, t, emptyPolicy)`(ORG_OWNER prank),
     `_paidEvent(orgId, priceCents, policy)` 추가.
  2. `TicketPublish.t.sol`: 무료 공개 → `eventStatus==1`, 첫 id 1001, `EventCreated`+`EventStatusChanged(1)` / 무료+정책 → `UnexpectedPolicy` /
     유료+정책 없음 → `PolicyRequired` / 유료+`approvalRequired` → `PaidApprovalUnsupported` / 유료+정책 → `getPolicy(id)` frozen·version 1·`PolicySet` /
     비주최자 → `Unauthorized` / 포워더 경유(주최자 기기키) 성공 / `setVault` 배포자 1회(`NotDeployer`, `VaultAlreadySet`, `ZeroAddress`).
  3. 실행해 빨강 확인.
- 구현: 설계 §4 본문 순서. `createEvent`·`publishEvent(uint256)`·`updateEventMeta`·`EventMetaUpdated`·`NotDraft` 삭제. `ClaimAuth`는 `ITicket`으로
  이동(Ticket이 상속). 이 단계에서 금고 쪽 `setPolicyByTicket`는 C2와 함께 들어가므로 C1·C2를 한 커밋 묶음으로 끝내도 된다.
- AC: `TicketPublish` green(나머지 스위트의 빨강은 C5에서 정리). 의존: 없음.

### C2 · M — 원자 결제: `Ticket.mintPaid` + `SettlementVault.purchase/setPolicyByTicket` (02:00–03:15)
- 파일: `src/Ticket.sol`, `src/SettlementVault.sol`, `src/interfaces/ISettlementVault.sol`, `test/SettlementPurchase.t.sol`(신규, 핵심만).
- 테스트 먼저(픽스처 `_purchase(account, tier)` = TREASURY prank로 `vault.purchase(auth, sig, usd)`):
  성공(같은 tx에 `Claimed`·`Deposited`, `escrowOf(tok)` = {usd, price×1e4, TREASURY, HELD}, `ownerOf(tok)==ALICE`) / `claimFor`로 유료 티어 →
  `PaidTiersNotEnabled` / `purchase`로 무료 티어 → `NotPaidTier` / 금고 아닌 `mintPaid` → `NotVault` / 비예치자 → `NotDepositor` /
  **원자성**(allowance 0 또는 잔고 부족 → revert, `balanceOf(ALICE)==0`, `claimNonce` 불변) / `setPolicyByTicket` 비Ticket → `NotTicket`,
  비트 64 없는 관리자 유료 공개 → `NotPolicyAuthorizer`.
- 구현: 설계 §3. `_claimTo(…, bool paid) returns (tokenId, price)`, `SafeCastLib.toUint128`. 금고에서 서명형 `setPolicy`·`setPolicyDigest`·
  `SETTLE_POLICY_TAG`·`PolicyAuth`·`policyNonce`·`deposit`·생성자 `identity`·도달 불가 오류 삭제(**`hashPolicy`는 유지**).
  (권장) 생성자·`setTokenAllowed(…, true)`에서 `decimals()==6` 확인.
- AC: `SettlementPurchase` green. 의존: C1.

### C3 · S — Organizers 개장 등록 + 삭제(`requestOverride`, Identity 닉네임) (03:15–03:45)
- 파일: `src/Organizers.sol`, `src/Ticket.sol`, `src/Identity.sol`, `src/interfaces/IIdentity.sol`, `test/OrganizersGates.t.sol`(개장 테스트 추가).
- 테스트 먼저: 등록 직후 `gateInfo(id).open==true`, `GateRegistered` 다음 `GateOpened`, `openGate` 없이 `checkInFor` 성공, 첫 orgId 1001.
- 구현: `open: true` + `emit GateOpened(gateId)`, `_nextOrgId = 1001`; `requestOverride`·`OverrideRequested` 삭제; 설계 §7 닉네임 삭제 목록
  (회전·취소의 닉네임 이동 블록 포함).
- AC: `grep -rn "requestOverride\|OverrideRequested\|Nickname" src` → 0건, `forge build` 성공. 의존: C2.

### C4 · S — **ABI 동결 (K1, 03:45–04:00)**
- 파일: `packages/shared/src/abi/*.json`(생성), `contracts/abi-delta-v2.md`(신규).
- 명령: `forge build && ./script/export-abi.sh`; 셀렉터
  `cast sig 'publishEvent((uint256,bytes32,bytes32,string,uint64,uint64,bytes32,uint64,uint64,bool,uint32,uint8,bool,uint8,bytes32,bool),(string,uint256,uint32,uint32,uint16,bool)[],((address,uint16,bytes32,bytes32)[],uint16,uint16,bool,bool,uint32))'`,
  `cast sig 'purchase((uint256,uint8,address,uint256,uint64),bytes,address)'`.
- `abi-delta-v2.md`: 추가/삭제 함수·이벤트·오류, 셀렉터, 생성자 인자, 배포 JSON 키, id 오프셋, "registerGate는 열린 상태".
- AC: 커밋 `feat(contracts): v2 ABI freeze`; O2가 B·W로 복사. **이후 시그니처 변경은 오케스트레이터 승인 필수.**

### C5 · L — 기존 스위트 이식 (04:00–06:00)
- 파일: `test/SettlementVault.t.sol`(서명형 정책·`deposit` 테스트 → `_paidEvent`+`_purchase` 기반으로; release/releaseMany/settleNoShows/
  refund/withdraw/재진입/일시정지 유지), `test/TicketEvent.t.sol`(publishEvent 기준), `test/TicketOverride.t.sol`(요청 테스트 삭제),
  `test/IdentityNickname.t.sol`(삭제), `test/Identity.t.sol`·`test/TicketMigrate.t.sol`(닉네임 단언 삭제), `test/TicketClaimFor.t.sol`,
  `test/Organizers.t.sol`, `test/SettlementGas.t.sol`, `test/ForwardGas.t.sol`, `test/ClaimGas.t.sol`(publishEvent·registerGate·purchase 가스 로그),
  그 밖에 `_event`/`createEvent` 참조 스위트.
- AC: `forge test` 전부 green(삭제 테스트 목록 기록). 의존: C4.

### C6 · M — 배포 스크립트 단일화 (06:00–07:00)
- 파일: `script/Deploy.s.sol`, `test/Deploy.t.sol`, `test/ContractSize.t.sol`; 삭제 `script/DeploySettlement.s.sol`, `script/Seed.s.sol`,
  `script/SeedFinish.s.sol`, `script/MeasureRelayed.s.sol`, `test/Seed.t.sol`, `deployments/seed-10143.json`.
- 테스트 먼저(`Deploy.t.sol`): 배선(`ticket.vault()==vault`, `vault.ticket()==ticket`, `tokenAllowed`, `depositor`, forwarder 대상,
  `organizers.ticket()`), 기록 JSON 키 = `{chainId, block, identity, forwarder, organizers, ticket, settlementVault, usdc, attester}`, `previous` 없음.
  `ContractSize.t.sol`에 금고 크기 로그.
- 구현: 설계 §8 순서. 입력 env `DEPLOYER_PK, ATTESTER_ADDRESS, TREASURY_ADDRESS, USDC_ADDRESS`.
- AC: green; `forge script script/Deploy.s.sol` 드라이런(브로드캐스트 없이) 성공. 의존: C5.

### C7 · M — EVM 내 E2E + 마감 (07:00–08:00)
- 파일: `test/V2Flow.t.sol`(신규).
- 테스트: 설계 §13 V1 시나리오 전부(조직 → 유료 공개 → 게이트 → 구매 → 포워더 `manualOverride` → release 60/20/15/5·먼지 마지막; 환불; 노쇼;
  무료 민팅 우회 차단; USDC 부족 원자 revert).
- 명령: `forge fmt --check && forge test && forge test --match-contract ContractSize -vv`.
- AC: 전부 green, Ticket 런타임 < 131,072, 가스 값을 `abi-delta-v2.md` 하단에 기록. 의존: C6. → O3(08:00).

---

## Lane B — 백엔드 + 인덱서 (MONTI-backend, `v2/backend`)

공통 명령: `cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/MONTI-backend && fnm exec --using=22 pnpm --filter monti-functions test`
(규칙: `… test:rules`, 인덱서: `pnpm indexer:check && pnpm --filter monti-indexer test`).

### B0 · S — 브랜치·리전·codebase 설정 (배포는 O1 이후)
- 파일: `packages/shared/src/constants.ts`(`FIREBASE_REGION='us-east4'`), `packages/shared/src/constants.test.ts`, `firebase.json`
  (`"codebase": "v2"`), `functions/.env`(`DEV_ORIGINS=https://v2.monti.despell.io`).
- AC: 기준선 테스트 수 기록(933), 변경 후 green. 의존: O0.

### B1 · M — P4 수동 승인 요청 (ABI 무관)
- 파일: `functions/src/functions/overrideRequests.ts`(신규), `functions/src/index.ts`, `functions/src/lib/db.ts`(`OVERRIDE_REQUESTS`,
  `ALLOWED_COLLECTIONS`), `firestore.rules`, `firestore.indexes.json`(복합 색인 + `expireAt` TTL, `relays` 선례 따라),
  `functions/test/overrideRequests.test.ts`(신규), `functions/test/rules.test.ts`.
- 테스트 먼저: 미인증 거절 / `eventOrg==0` → `UNKNOWN_EVENT` / `tokenId>>96 != eventId` → `WRONG_EVENT` / 게이트 행사 불일치 →
  `GATE_MISMATCH` / 매니저도 권한자도 아니면 `NOT_ALLOWED` / 성공 시 문서 모양(§1.3) / `listOverrideRequests`는 승인권자만·open만·최신순·≤50 /
  규칙: 요청자 본인만 읽기, 클라이언트 쓰기 거부.
- AC: green, `consistency.test.ts` green. 의존: B0. 병렬: B2와 가능.

### B2 · M — P5 닉네임 (ABI 무관) — 컷 1순위
- 파일: `functions/src/functions/nickname.ts`(신규: `setNickname`, `resolveNicknames`), `functions/src/lib/nicknames.ts`(신규:
  `nicknamesByAccount`), `functions/src/functions/{resolveRecipient,listAttendees,snapshot,dailyExport,tenderlyWebhook,recoverAccess}.ts`,
  `lib/db.ts`(`NICKNAMES`), `firestore.rules`, 대응 테스트 파일.
- 테스트 먼저: 정규화(대문자·공백·길이·문자셋) / 남이 쓰는 이름 `NICKNAME_TAKEN` / 이름 변경 시 이전 문서 해제 / `users.nickname` 미러 /
  `resolveRecipient` 닉네임 분기가 Firestore→`persons.account` / `listAttendees`·`snapshot` 이름이 Firestore에서 / `tenderly`에
  `NicknameSet` 케이스 없음 / `recoverAccess` 후 닉네임 문서 account 갱신.
- AC: green. 의존: B0. **P5-min(자를 때):** `resolveRecipient` 닉네임 분기 → `NICKNAME_UNKNOWN`, `tenderlyWebhook` `NicknameSet` 제거만.

### B3 · S — ABI 동기화 + allowlist (K1 이후)
- 파일: `packages/shared/src/abi/*.json`(O2 복사), `functions/src/lib/actionAllowlist.ts`, `functions/src/lib/relayTypes.ts`,
  `functions/test/{actionAllowlist,settlementAbi}.test.ts`.
- 테스트 먼저: allowlist에 v2 `publishEvent` 셀렉터 존재(`abi-delta-v2.md` 값과 일치), `createEvent/publishEvent(uint256)/updateEventMeta/
  requestOverride/setNickname` 부재 / settlementAbi 참조 목록 = v2(`purchase, setPolicyByTicket` 有, `deposit, setPolicy, policyNonce` 無) /
  RelayKind `purchase` 有, `setPolicy` 無.
- AC: green. 의존: C4(ABI 동결), O2.

### B4 · L — P1 원자 `purchaseTicket` + 주문 상태 기계 + 스윕
- 파일: `functions/src/lib/claimPrecheck.ts`(신규, `relay.ts` 앞부분 추출), `functions/src/functions/relay.ts`,
  `functions/src/functions/settlement.ts`, `functions/src/index.ts`(`relaySetPolicy` export 삭제), `functions/test/settlement.test.ts`(재작성),
  `functions/test/relay.test.ts`.
- 테스트 먼저(체인·DB 목, 기존 패턴 그대로):
  1. 확정: 주문 `deposited`+tokenId(`Claimed` 로그)+`depositTxHash`, 릴레이 `purchase` 문서 `confirmed`+tokenId, `recordEventUsage` 호출.
  2. 사전 거절: 체인 가격 0 → `NOT_PAID_TIER`, 금액 불일치 → `PRICE_MISMATCH{expected}`, nonce 불일치 → `BAD_NONCE{nonce}`.
  3. 시뮬 매핑: `SoldOut→SOLD_OUT`, `TransferFromFailed→TREASURY_FUNDS`, `Paused→PAUSED`, `NotDepositor→CONFIG`.
  4. 타임아웃 → `sent`, revert 영수증 → 주문·릴레이 `failed`.
  5. 멱등: `deposited` 되비춤 / `sent` 되비춤 / `failed`면 같은 nonce 재시도.
  6. `sweepSentOrders`: 성공 → `deposited`+tokenId(릴레이도) / revert → `failed` / 영수증 없음 10분↑ → `failed`.
  7. `onCheckInConfirmed`·`refundOrder`·`sweepDeposited` 기존 테스트 유지 green. `relaySetPolicy`·`minted-pending` 테스트 삭제.
- 구현: 설계 §3 단계 1–8. `depositForOrder`·`sweepMintedPending`·`claimedTokenIdOf`·`relaySetPolicy`·`sanitizePrices` 삭제(가격 정본은 체인).
- AC: green. 의존: B3.

### B5 · L — P2 `relayAction` 공개 + 재실행 가능한 확정 훅
- 파일: `functions/src/lib/postConfirm.ts`(신규), `functions/src/functions/relayAction.ts`, `functions/src/functions/reconcileRelays.ts`,
  `functions/test/{relayAction,reconcileRelays}.test.ts`.
- 테스트 먼저:
  1. `publishEvent` 허용, scope `org:{meta.orgId}`, 릴레이 문서에 `data`·`reasons` 저장.
  2. 확정 시 `result.eventId`(EventCreated) + 유료면 `settlements/{eventId}` = 디코드한 `priceUsdCentsByTier`·수취인(account/bps/tag 문자열)·
     `platformBps`·`policyHash`·`setBy`·`txHash`, reason은 해시 일치분만(변조 → `''`). 무료면 거울 없음.
  3. 시뮬 revert가 금고 오류일 때 이름 디코딩(`BadSplitSum` 등) — simAbi에 금고 ABI 포함.
  4. `registerGate` 확정 → `pendingGates/{account}` `registered`+gateId.
  5. `manualOverride` 확정 → 인라인 release(기존) + 같은 tokenId의 open 요청 `approved`(P4 미완이면 컬렉션 비어 무해).
  6. `reconcileRelays`: 타임아웃 후 확정으로 닫을 때 같은 훅 실행 + `result` 기록, kind `purchase`는 건너뜀.
- AC: green. 의존: B3(+B1 문서 모양).

### B6 · S — 규칙·색인 마감
- 파일: `firestore.rules`(초안 `capped('splitJson', 4000)`, `nicknames` 서버 전용, `overrideRequests`), `firestore.indexes.json`.
- 명령: `fnm exec --using=22 pnpm --filter monti-functions test:rules`.
- AC: 규칙 테스트 green(초안 8티어 + splitJson 저장이 예산 안에서 통과), **추가만**(기존 규칙·색인 삭제 0). 의존: B1, B2.

### B7 · M — 인덱서 v2
- 파일: `indexer/scripts/gen-config.mjs`(Identity `NicknameSet`, Ticket `EventMetaUpdated`·`OverrideRequested` 제거, SettlementVault
  `startBlockKey` 제거), `indexer/src/vendored/settlement-vault-abi.json`(새 ABI, `{_comment, abi}` 유지), `indexer/src/EventHandlers.ts`
  (세 핸들러·`requested` 삭제), `indexer/schema.graphql`(`Override.requested` 삭제; `IdentityAccount.nickname`은 B2 완료 시에만 삭제),
  `indexer/test/*.test.ts`.
- 테스트 먼저: 핸들러 테스트에서 세 이벤트 케이스 삭제, `GateRegistered→GateOpened` 같은 tx 처리 시 `isOpen=true` 테스트 추가, gen-config
  테스트에 v2 배포 JSON(금고 같은 블록) 픽스처.
- 명령(O3 이후 주소 반영): `cp ../MONTI-prod/contracts/deployments/10143.json contracts/deployments/ && pnpm indexer:config && pnpm indexer:check && pnpm --filter monti-indexer test`.
- AC: green, `config.yaml`에 v2 주소·`start_block = block`. 의존: C4(코드), O3(주소).

### B8 · S — 빌드 + 스테이징 배포 준비
- 명령: `fnm exec --using=22 pnpm --filter @monti/shared build && fnm exec --using=22 pnpm --filter monti-functions build:deploy`.
- AC: 빌드 성공, 번들 안 `10143.json`이 rc1 주소. → O4.

---

## Lane W — 웹 + e2e (MONTI-web, `v2/web`)

공통 명령: `cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/MONTI-web && fnm exec --using=22 pnpm -F web test && fnm exec --using=22 pnpm -F web typecheck && fnm exec --using=22 pnpm lint:copy`.

### W0 · S — 브랜치·리전
- 파일: `apps/web/src/shared/api/firebase.ts`(`DEFAULT_FUNCTIONS_REGION='us-east4'`) + 테스트, `apps/web/.env.example`(리전).
- AC: 기준선 2179 기록, green.

### W1 · L — 초안 공개 화면 + 정산 규칙 편집기 (ABI 무관)
- 파일: `apps/web/src/organizer/scene/DraftPublish.tsx`(신규) + `draftPublish.test.tsx`, `apps/web/src/organizer/Layout.tsx`(라우트
  `new/:draftId/publish`), `apps/web/src/organizer/settlement/SplitEditor.tsx`(신규, `SettlementSection`의 행 편집·검증·예시 분배만,
  저장 = 초안 `splitJson`) + 테스트, `apps/web/src/shared/api/firestore.ts`(`EventDraft.splitJson`, `editingEventId` 삭제),
  `apps/web/src/organizer/useEventDraft.ts`(+테스트), `apps/web/src/organizer/scene/draftRules.ts`(`paidTier` 삭제, `paidApproval` 추가,
  `priceUsdCentsOf(tier)=amount×100`) + 테스트, `apps/web/src/organizer/scene/CreateEvent.tsx`(마지막 버튼 → 저장 후 공개 화면) + 테스트,
  `apps/web/src/organizer/copy.ts`.
- 테스트 먼저: 유료 티어 초안이 문제 없이 통과 / 유료+승인제 → `paidApproval` / 편집기: 플랫폼 행 고정·합 100%·플랫폼 ≥5% 검증, 저장 시
  `splitJson` 직렬화·복원 / 공개 화면: 무료면 정산 카드 없음, 유료면 규칙 유효해야 공개 버튼 활성 / 만들기 버튼이 체인 호출 없이 이동.
- AC: green, 화면 문구 web3 낱말 0. 의존: W0. 병렬: W4–W6.

### W2 · M — `usePublish` v2 (K1 이후)
- 파일: `apps/web/src/organizer/scene/usePublish.ts`, `apps/web/src/organizer/scene/buildEventMeta.ts`, `apps/web/src/shared/relay/sendAction.ts`
  (마지막 인자 `extra?: { reasons?: string[] }`), `apps/web/src/shared/api/functions.ts`(§1.2 타입, `RelaySetPolicy*` 삭제),
  `apps/web/src/shared/chain/reads.ts`(`SplitPolicyStruct`), 테스트 `scenePublish.test.tsx`·`buildEventMeta.test.ts`·`sendAction.test.ts`.
- 테스트 먼저: calldata를 `decodeFunctionData`하면 `publishEvent(meta, tiers(가격 포함), policy)` / 무료 → 빈 정책 / 유료 → `toOnChainRecipients(splitJson)`·
  `platformBps`·`reserveBps 0`·`noShowRefund false` / `reasons`가 `relayAction` 본문에 실림 / `submittedRelayId` 재개 경로 유지 /
  `REVERT_PROBLEMS`에 정책 오류 문구 매핑 / `update` 경로 삭제.
- AC: green. 의존: C4(ABI 동결), O2, W1.

### W3 · M — 대시보드 정리 + 삭제 + ABI 매니페스트
- 파일: `apps/web/src/organizer/Dashboard.tsx`(발행·편집·요약 시트 제거, 정산 읽기 전용), `apps/web/src/organizer/settlement/SettlementSection.tsx`
  → 읽기 전용 요약(거울 + `readChainPolicy`, 공개 링크), 삭제 `organizer/settlement/buildPolicyAuth.ts`·`organizer/scene/EditEvent.tsx`(+라우트,
  `eventToDraft.ts`가 편집 전용이면 함께)·`lifecycle.ts`의 `publishEvent/saveDraft`, `apps/web/src/shared/chain/settlementAbi.ts`(`getPolicy`만),
  `apps/web/src/shared/chain/abis.ts`(`USED_ABI` Ticket −`createEvent` −`publishEvent:1` −`updateEventMeta` −`requestOverride` +`publishEvent:3`;
  Identity −`nicknameOwner` −`setNickname`), `apps/web/src/staff/constants.ts`(`SEEDED_EVENT_ID` 제거), shared ABI(O2), shared `settlement.ts`의
  `SETTLE_POLICY_TAG/setPolicyPreimage/setPolicyDigest/buildPolicyDigest` 삭제(+테스트).
- AC: green(`abis.test.ts`가 v2 JSON과 대조). 의존: W2.

### W4 · S — 구매 상태
- 파일: `apps/web/src/attendee/purchase/{usePurchase.ts,Receipt.tsx,purchaseErrors.ts}`, `apps/web/src/shared/api/firestore.ts`(`OrderView.status`).
- 테스트 먼저: `deposited` → 완료, `sent` → 릴레이 문서 추적(kind `purchase`), `failed` → "결제가 완료되지 않았어요. 청구되지 않았어요",
  새 코드(`TREASURY_FUNDS`, `NOT_PAID_TIER`, `PAUSED`) 문구.
- AC: green. 의존: W0(타입은 W2와 합의된 §1.2).

### W5 · M — P4 UI (컷 2순위)
- 파일: `apps/web/src/staff/override/route.ts`(요청 경로 → `api.requestOverride`), `apps/web/src/organizer/OverrideRequests.tsx`(신규,
  대시보드 카드: 승인권자만, 5초 폴링, 승인 = `sendAction('manualOverride', …)`) + 테스트.
- 테스트 먼저: 권한 없는 매니저 → 콜러블 호출(체인 tx 없음) 후 "요청했어요" / 승인권자 목록·승인 시 `manualOverride` calldata.
- **P4-min(15분):** 요청 경로를 "승인 권한자가 직접 승인해야 해요" 안내로 바꾸고 `requestOverride` 인코딩 제거.
- AC: green. 의존: W2(타입).

### W6 · M — P5 UI (컷 1순위)
- 파일: `apps/web/src/attendee/me/Nickname.tsx`(→ `api.setNickname`), `apps/web/src/attendee/chats/useChatNames.ts`,
  `apps/web/src/shared/envio/queries.ts`(닉네임 질의 → `api.resolveNicknames`) + 테스트.
- **P5-min(20분):** 닉네임 편집 칸 숨김, 체인 닉네임 호출 제거(인덱서 닉네임 질의는 열이 남으므로 그대로).
- AC: green. 의존: W2(타입).

### W7 · L — e2e 하니스 v2
- 파일: `apps/web/e2e/utils/organizer.ts`(`createDraftAndPublish(page, spec)` → 초안 작성 → 공개 화면 → 정산 규칙 입력 → 공개하기 → eventId 반환),
  `apps/web/e2e/tests/55-settlement-chain.spec.ts`(v2: 공개 1건·게이트 등록만(열기 버튼은 있으면 누르는 관용 유지)·결제·수동 승인·영수증,
  트레저리 MON 잔고 델타 기록, 주최자 온체인 tx 수 기록), 삭제 `50-settlement.spec.ts`·`50b-settlement-finish.spec.ts`, `apps/web/e2e/README.md`(v2 절).
- 명령: `fnm exec --using=22 pnpm -F web exec playwright test --list`(컴파일 확인, 라이브 실행은 O7).
- AC: 목록 컴파일 OK, 스펙이 `E2E_BASE_URL`·`E2E_PERSONA_OFFSET`·`E2E_PRICE_USD`를 따른다. 의존: W1·W2(셀렉터 문구).

### W8 · S — 환경·빌드
- 파일: `apps/web/.env.example`(rc1 주소, 리전), `packages/shared/src/deployments/10143.json`(O2).
- 명령: `fnm exec --using=22 pnpm -F web build`(스테이징 값으로) && `pnpm lint:copy`.
- AC: 빌드 성공. 의존: O3, W3. → O5.

---

## Lane O — 운영·배포·검증 (오케스트레이터 + runner + 창업자)

환경: `export R=https://testnet-rpc.monad.xyz`. 키는 `.secrets/.env`를 셸 변수로만 불러온다(`set -a; source …; set +a`, 출력 금지).

### O0 · S — 태그·브랜치·v1 백업 (00:40)
```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/MONTI-prod    && git tag v1-final/mvp mvp                               && git switch -c v2/contracts
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/MONTI-backend && git tag v1-final/mvp-settle-indexer mvp-settle-indexer && git switch -c v2/backend
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/MONTI-web     && git tag v1-final/mvp-settle-web mvp-settle-web         && git switch -c v2/web
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/MONTI-web && vercel ls --prod --scope despells-projects | head -5   # v1 운영 배포 URL 기록
vercel env pull /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/.secrets/vercel-production-v1.env --environment=production --scope despells-projects
```
AC: 태그 3개, v1 운영 배포 URL을 진행 원장에 기록, env 백업 파일 존재(내용 출력 금지).

### O1 · S — 배포 구조 탐침 (K2, 05:00)
1. 저장소 밖 임시 디렉터리에 codebase `probe` 함수 패키지(이름이 운영에 이미 있는 무해한 콜러블 `listPinned`, 리전 `us-east4`, `{probe:true}` 반환).
2. `GOOGLE_APPLICATION_CREDENTIALS=… fnm exec --using=22 firebase deploy --only functions:probe --project mon-ti` (**`--force` 없이**).
3. 확인: 출력에 `default` codebase 함수 삭제 제안 없음, `gcloud functions list --regions=us-east1,us-east4 --project mon-ti`에 두 `listPinned` 공존, v1 `listPinned`(us-east1, 대화방 고정 메시지) 응답 정상.
4. 정리: `firebase functions:delete listPinned --region us-east4 --project mon-ti` — **`--region` 생략 금지(생략하면 모든 리전의 같은 이름이 지워진다).**
- 실패 시: B안 확정(설계 §12) — B0의 리전 변경을 되돌리고 O8에서 운영 교체 방식으로 간다.

### O2 · S — ABI·주소 전파 (K1·K3 직후)
```bash
P=/Users/moomi/Downloads/z03.Vibe_Coding/MONTI
for W in MONTI-backend MONTI-web; do cp $P/MONTI-prod/packages/shared/src/abi/*.json $P/$W/packages/shared/src/abi/; done
# K3 이후 주소:
for W in MONTI-backend MONTI-web; do cp $P/MONTI-prod/contracts/deployments/10143.json $P/$W/contracts/deployments/10143.json \
  && (cd $P/$W && fnm exec --using=22 pnpm --filter @monti/shared sync:deployments); done
```
AC: 각 v2 브랜치에 `chore: sync v2 ABIs/addresses` 커밋.

### O3 · M — 새 배포자 키 + 테스트넷 rc1 배포 (K3, 08:00–08:30)
1. (창업자 기본 승인) `cast wallet new` → 개인키를 `.secrets/.env`의 `DEPLOYER_PK_V2`로 기록(chmod 600, 출력 금지). 주소만 원장에 기록.
2. 자금: 옛 배포자 → 새 배포자 10 MON, 옛 배포자 → 트레저리 `0xAe6D18fA7dC1e2512a2dC7DaE1d4640D7D786Bb2` 1 MON(유료 민팅 가스).
   `cast send <NEW> --value 10ether --private-key $DEPLOYER_PK --rpc-url $R`
3. 배포:
```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/MONTI-prod/contracts
DEPLOYER_PK=$DEPLOYER_PK_V2 ATTESTER_ADDRESS=0x6af898aA4d99375839d7069431A7019a6D84C4Ed \
TREASURY_ADDRESS=0xAe6D18fA7dC1e2512a2dC7DaE1d4640D7D786Bb2 USDC_ADDRESS=0x534b2f3A21130d7a60830c2Df862319e593943A3 \
forge script script/Deploy.s.sol --rpc-url $R --broadcast
```
4. 배선 점검(전부 기대값): `ticket.vault()`, `vault.ticket()`, `vault.organizers()`, `vault.owner()`(=새 배포자), `vault.tokenAllowed(USDC)`,
   `vault.depositor(treasury)`, `identity.attester()`, `identity.trustedForwarder()`, `forwarder.ticket()`·`organizers()`, `organizers.ticket()`,
   `ticket.trustedForwarder()`·`organizers.trustedForwarder()` — 예: `cast call $TICKET "vault()(address)" --rpc-url $R`.
5. 커밋 `chore(contracts): deploy v2 rc1 (…)` → O2.
- AC: 12개 점검 통과. **K6(인덱서 교체) 이후 컨트랙트 재배포는 오케스트레이터 승인 사항**(인덱서·env 연쇄 재설정).

### O4 · S — 백엔드 v2 스테이징 배포 (K4, 10:00)
```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/MONTI-backend
GOOGLE_APPLICATION_CREDENTIALS=/Users/moomi/Downloads/z03.Vibe_Coding/MONTI/.secrets/monti-deployer.json fnm exec --using=22 firebase deploy --only functions:v2 --project mon-ti
GOOGLE_APPLICATION_CREDENTIALS=… fnm exec --using=22 firebase deploy --only firestore:rules,firestore:indexes --project mon-ti
gcloud functions list --regions=us-east4 --project mon-ti --format="table(name,state)"
```
AC: `us-east4` 함수 ACTIVE, `us-east1` 함수 목록·상태 불변, 규칙·색인 삭제 0(프롬프트 없음).

### O5 · S — 스테이징 웹 (K5, 12:00)
1. **창업자:** DNS에 `v2.monti` CNAME → `cname.vercel-dns.com`.
2. Vercel: 도메인 `v2.monti.despell.io`를 브랜치 `v2/web`에 연결, Preview env를 브랜치 `v2/web` 범위로 §1.4 값 입력(`vercel env add <KEY> preview v2/web`).
3. Firebase Auth 승인 도메인에 `v2.monti.despell.io` 추가(콘솔 또는 Identity Platform admin API GET→PATCH, 기존 목록 보존).
4. `cd MONTI-web && vercel deploy --scope despells-projects` → 필요 시 `vercel alias set <url> v2.monti.despell.io --scope despells-projects`.
- AC: `curl -sI https://v2.monti.despell.io` 200, 로그인 화면 표시. DNS 미준비면 B안(O8에서 운영 배포 1회 후 검증).

### O6 · S — 인덱서 교체 (K6, 13:00)
1. **창업자:** Envio 대시보드에서 v1 배포(`d6a478c`) 삭제(무료 플랜 1개 규칙 — 옛 것을 지워야 새 것이 시작).
2. `cd MONTI-backend && git fetch origin envio-release && git push origin v2/backend:envio-release --force-with-lease`
3. 정상 확인(90초 동안 3회): `curl -s "https://indexer.dev.hyperindex.xyz/$ID/v1/graphql" -H 'content-type: application/json' -d '{"query":"{ chain_metadata { block_height latest_processed_block is_hyper_sync } }"}'` vs `cast block-number --rpc-url $R`.
4. 새 id → 백엔드 `functions/.env` `ENVIO_GRAPHQL_URL` → `firebase deploy --only functions:v2`; Vercel Preview(v2) `VITE_ENVIO_URL` → 스테이징 재배포.
- AC: `is_hyper_sync=true`, lag<100 꾸준히 전진.

### O7 · L — 하니스 실행 (K7→K8, 14:00–20:00)
- 번호 준비(창업자 승인 후): Identity Platform 테스트 번호에 …17/18/20 유지 + …21–27 추가(메모 `monti-test-phone-numbers` 절차),
  하니스 `E2E_PERSONA_OFFSET` 10(…17·…18)/20(…21+). 대안: `reset-persons.ts --phone`으로 …11 등 개별 초기화(`--all` 금지).
- 순서: V3 `E2E_BASE_URL=https://v2.monti.despell.io pnpm -F web e2e e2e/tests/00-smoke.spec.ts e2e/tests/01-public-surface.spec.ts`
  → 트레저리 approve 데우기(안 하면 첫 구매가 approve tx를 먼저 보내 지연이 늘어난다):
    `cast send 0x534b2f3A21130d7a60830c2Df862319e593943A3 "approve(address,uint256)" $VAULT $(cast max-uint) --private-key "$(cat /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/.secrets/treasury.key)" --rpc-url $R`(키 출력 금지)
  → V4 `E2E_ADMIN=07 E2E_USER_FROM=08 E2E_PRICE_USD=10 pnpm -F web e2e e2e/tests/55-settlement-chain.spec.ts`
  → V5 `E2E_PERSONA_OFFSET=20 E2E_ADMIN=10 E2E_USER_FROM=01 E2E_PRICE_USD=10 EVENT_ID=<V4 행사> pnpm -F web e2e e2e/tests/56-settlement-refund.spec.ts`
  (56은 `USERS[0]`만 쓰고 관리자 인덱스는 사용자 풀에서 빠지므로, 관리자를 56이 안 쓰는 인덱스로 둬야 관객 B가 …21이 된다)
  → V6 cast 사후 확인 → V7 인덱서 질의 → V8/V9(P4/P5가 들어갔을 때만).
  모든 하니스 명령은 `fnm exec --using=22` 접두 + `E2E_BASE_URL=https://v2.monti.despell.io`(스테이징; B안이면 생략 = 운영 도메인).
- 기록: 단계별 지연(결제·승인·정산 완료·환불), 주최자 온체인 tx 수, 릴레이어·트레저리 MON 델타, tx 해시 → 런북 §7 초안.
- 실패 처리: 백엔드·웹은 수정 후 재배포(빠름), 컨트랙트 수정은 O3 재실행 + O6 재실행(오케스트레이터 승인).

### O8 · S — GO/NO-GO + 전환 (K8, 20:00)
- **GO 조건:** V3·V4·V6·V7 통과, V5 통과(또는 창업자가 승인한 대체), V0 전부 green, 잔고 기준 충족.
- GO 절차: Vercel Production env를 §1.4 값으로(스테이징과 동일 값) → `cd MONTI-web && vercel --prod --scope despells-projects`
  → `gcloud scheduler jobs pause firebase-schedule-reconcilePending-us-east1 --location=us-east1 --project=mon-ti`
  → 운영 스모크: `curl -sI https://monti.despell.io`, 로그인 화면, 공개 정산 페이지.
- NO-GO 절차: 운영은 v1 그대로. v2 인덱서 삭제 → `git push origin v1-final/mvp-settle-indexer:envio-release --force-with-lease`
  → 새 id면 v1 백엔드(`MONTI-backend`를 v1 태그로 체크아웃한 임시 워크트리) `ENVIO_GRAPHQL_URL` 갱신·재배포(codebase `default`) + Vercel
  운영 `VITE_ENVIO_URL` 갱신·`vercel --prod`(백업 env 기준) → 런북 v1 T-30 점검.
- 전환 후 롤백(09:00 전): `vercel rollback <O0에 기록한 v1 운영 배포 URL> --scope despells-projects` + 스케줄러 resume + 위 인덱서 절차.

### O9 · M — 무대 준비 (K9, 20:30–23:00)
- 창업자 관리자 폰으로 **운영 도메인에서** 새 번호 가입(스테이징 계정은 기기 키가 다른 origin에 있어 못 쓴다) → 주최자 등록 → 초안($30,
  아티스트60/공연장20/기획15 + MONTI 5%) → 공개 1건 → 브라우저 스태프 화면에서 게이트 신청 → 승인 1건(즉시 열림) → PIN 설정.
- 잔고: 트레저리 USDC ≥ $60(faucet, 창업자), 트레저리 MON ≥ 1, 릴레이어 MON ≥ 5. …20은 무대 관객용으로 미사용 유지.
- AC: `/settlement/<id>` 규칙 렌더, `eventStatus=1`, `getPolicy` 합 10000·frozen.

### O10 · M — 리허설 + 런북 (K10, 23:00–02:00)
- 런북 §2 순서 그대로 1회(관객 = 리허설 번호, $30 또는 예산 시 $10) + 백업 영상.
- `docs/superpowers/plans/2026-10-13-monti-demo-runbook.md` 갱신: §0 주소·잔고·인덱서 id, §3 점검 명령(v2 주소·`purchase`), §4 장애 표
  ("결제 후 처리 중(minted-pending)" 삭제 → "결제 실패 = 티켓 미발급·청구 없음", 금고 USDC 부족 시 결제창에서 즉시 실패), 롤백 절차,
  §7 tx·가스 표(V4 실측).
- AC: 리허설 통과, 런북 커밋.

### O11 — 버퍼·T-30 (02:00–09:00)
08:00 런북 §3-15 읽기 전용 점검(v2 주소). 09:00 이후 전환·롤백 금지.

---

## 컷 절차

| 순위 | 자를 것 | 대신 반드시 할 것 | 절약 |
|---|---|---|---|
| 1 | P5 전체(B2·W6) | B2의 P5-min(`resolveRecipient` 닉네임 → `NICKNAME_UNKNOWN`, `tenderlyWebhook` 정리), W6의 P5-min(편집 칸 숨김), B7에서 `IdentityAccount.nickname` 열 **유지** | ~3시간 |
| 2 | P4 전체(B1·W5) | W5의 P4-min(요청 경로 안내 문구), B5 훅의 요청 갱신은 컬렉션이 비어 무해 | ~2.5시간 |
| 3 | P3 다듬기 | W1의 공개 화면 디자인·요약 시트 이동·이어쓰기 시트 문구 개선을 뒤로(초안 → 정산 규칙 → 공개 1건의 기능 경로는 유지) | ~1시간 |

판단 시점: 12:00(K5)에 B·W 진척이 K4 기준 2시간 이상 밀리면 1순위, 16:00에 V4가 안 돌았으면 2순위.
P1·P2·P3 최소 흐름·O 레인은 자르지 않는다 — 시간이 모자라면 **v1 유지**가 답이다(K8 NO-GO).

---

## 완료 정의

- [ ] V0 전 스위트 green(기준선 대비 회귀 0, 삭제 테스트 목록은 PR 본문에)
- [ ] `contracts/abi-delta-v2.md` 커밋, 세 워크트리 ABI·주소 일치(`shasum`)
- [ ] V1–V7 통과 기록(진행 원장에 tx 해시·지연·가스)
- [ ] 주최자 온체인 tx 3건, 결제 1건, 수동 승인 1건 실측 확인
- [ ] 전환 또는 v1 유지 결정이 20:00에 기록됨, 롤백 절차 리허설(최소 명령 확인)
- [ ] 런북 갱신·리허설·백업 영상
