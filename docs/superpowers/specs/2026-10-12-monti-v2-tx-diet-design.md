# MONTI v2 — 트랜잭션 다이어트 설계 (2026-10-12)

작성 2026-10-12 00:40 KST 이후 · 대상 Monad testnet 10143 · 하드 컷오프(v1→v2 운영 전환) **2026-10-13 09:00 KST**
구현 계획: `docs/superpowers/plans/2026-10-12-monti-v2-tx-diet-plan.md`
근거 자료(전부 실제 코드 대조): `contracts/src/*.sol`(브랜치 `mvp`), `functions/src/**`·`indexer/**`(브랜치
`mvp-settle-indexer`, 워크트리 `MONTI-backend`), `apps/web/src/**`·`apps/web/e2e/**`(브랜치 `mvp-settle-web`,
워크트리 `MONTI-web`), 런북 `docs/superpowers/plans/2026-10-13-monti-demo-runbook.md`.

> **확인 필요(창업자):** 2026-10-11 기록된 결정 메모는 이 작업을 "데모 **이후**, 데모 전 운영 변경 없음"으로
> 적고 있다. 이 문서는 오케스트레이터 지시(데모 **전** 전환, 09:00 컷오프)를 따른다. 둘이 상충하므로
> 창업자 확인을 받는다. 이 설계는 v1을 건드리지 않는 블루/그린 구조라, 확인 결과가 "데모 후"여도 그대로 쓸 수 있다.

---

## 0. 결정 요약

| # | 결정 | 한 줄 이유 |
|---|---|---|
| D1 | **원자 결제** = `SettlementVault.purchase(ClaimAuth, deviceSig, token)` 1건(트레저리 전송). 금고가 `Ticket.mintPaid`(금고 전용)를 불러 민팅하고, 같은 호출 안에서 에스크로 기록 + USDC를 당겨 온다. 티어 가격은 온체인 `Tier.priceUsdCents`가 정본이 되고, `claimFor`는 무료 티어 전용으로 남는다(기존 `PaidTiersNotEnabled` 그대로). `deposit()` 삭제 | "둘 다 되거나 둘 다 안 되거나"가 백엔드 관례가 아니라 **체인 불변식**이 된다. 유료 티켓을 돈 없이 민팅할 경로가 없어진다 |
| D2 | **공개 1건** = `Ticket.publishEvent(EventMeta, Tier[], SplitPolicy)`. Draft 상태 없이 바로 Published. 유료 티어가 있으면 같은 tx에서 `SettlementVault.setPolicyByTicket(eventId, policy, organizer)` 호출(정책은 공개 순간 동결). `createEvent`·`publishEvent(uint256)`·`updateEventMeta`·서명형 `setPolicy`·`setPolicyDigest`·`policyNonce` 삭제. **MontiForwarder 무변경** | eventId가 tx 안에서 정해지므로 범용 배치로는 "앞 호출의 반환값"을 넘길 수 없다. 전용 함수가 "유료 공개 ⇒ 권한 있는 주최자가 같은 tx에서 정책 확정"을 컨트랙트에 박는다 |
| D3 | **게이트 1건** = `Organizers.registerGate`가 **열린 상태로** 등록(`open: true` + `GateOpened` 방출). 시그니처 무변경 | 승인이 곧 개장. 함수 0개 추가, 인덱서 핸들러 무변경 |
| D4 | **초안 off-chain**: 기존 `eventDrafts/{uid}/drafts/{id}`에 가격(티어 `currency`/`amount`)과 정산 규칙(`splitJson`)을 담고, 공개 때 calldata 한 번으로 체인에 올린다. 확정 후 백엔드가 `settlements/{eventId}` 거울을 calldata에서 디코드해 쓴다 | 화면 순서(만들기 → 정산 규칙 → 공개)는 유지하고, 앞의 둘은 체인을 안 건드린다 |
| D5 | **수동 승인 요청 off-chain**: `overrideRequests/{id}`(콜러블 `requestOverride`·`listOverrideRequests`). 승인은 기존 `manualOverride` 릴레이 1건. `Ticket.requestOverride`·`OverrideRequested` 삭제 | 요청 tx는 아무도 온체인에서 읽지 않는 이벤트만 냈다(`Ticket.sol:743-759`) |
| D6 | **닉네임 off-chain**: `nicknames/{정규형}` → `{personId, account}`(콜러블 `setNickname`). `Identity`의 닉네임 저장·함수·이벤트 삭제 | 유일성은 Firestore 트랜잭션으로 충분하고, 회전 시 계정 이동도 personId로 해결된다 |
| D7 | **v2 id 오프셋**: `eventId`·`orgId`는 **1001부터** | Firestore 문서 키가 체인 id다(`settlements/{eventId}`, `orders/{account:eventId:nonce}`, `relays/{eventId:tokenId}`, `admissions/{eventId}`, `eventPrivate/{eventId}`(숨긴 장소), `eventArt/{eventId}`, `eventChats/{eventId}`, `orgProfiles/{orgId}`, `usage/org:{orgId}`). 1부터 다시 세면 v1 문서와 충돌해 멱등 로직이 v2 동작을 삼키고(예: 입장 tx 미전송) 남의 장소·그림이 보인다(§15 R4) |
| D8 | **블루/그린 전환**: 새 배포자 키 + 단일 `Deploy.s.sol`(5개 + 배선). 백엔드 v2는 **codebase `v2` + 리전 `us-east4`**로 v1(`default`/`us-east1`) 옆에 병행 배포. 웹 v2는 `v2.monti.despell.io`에서 검증 후 운영 도메인으로 전환, 롤백은 Vercel Instant Rollback | v1 컨트랙트·백엔드·웹이 전환 직전까지 손대지 않은 채 남고, 롤백이 재배포 없이 된다 |

트랜잭션 수 (전 → 후):

| 흐름 | 지금(v1) | v2 |
|---|---|---|
| 주최자 → 첫 판매까지 | 6 (`createOrganizer`, `createEvent`, `setPolicy`, `publishEvent`, `registerGate`, `openGate`) | **3** (`createOrganizer` 1회 · `publishEvent` · `registerGate` 게이트당) |
| 유료 구매 | 2 (`claimFor` 릴레이어 → `deposit` 트레저리) + "민팅됨·예치 안 됨" 상태 존재 | **1** (`purchase` 트레저리), 중간 상태 없음 |
| 수동 승인 | 1(권한자) / 2(권한 없는 매니저: `requestOverride` → `manualOverride`) | **1** (`manualOverride`), 요청은 서버 기록 |
| 닉네임 | 1 (`setNickname`) | **0** |
| 무료 받기 · 입장 · 환불 · 가입 | 1 · 1 · 1 · 1 | 변화 없음 |

---

## 1. 검증된 사실과 인벤토리 정정 (코드 대조)

| 항목 | 확인 결과 |
|---|---|
| `Ticket.claimFor` 반환값 | `returns (uint256 tokenId)` (`Ticket.sol:376-379`). 서명 검증 `_verifyClaimAuth`(`:390-401`)가 민팅 전에 nonce를 소비 |
| 유료 티어 차단 | `_claimTo`가 `t.priceUsdCents != 0`이면 `PaidTiersNotEnabled`(`:418`). 승인제 `_requestClaimFrom`도 같은 검사(`:443`) |
| 민팅 | `_mintTo`가 `_safeMint` 사용(`:459-463`). 수신 계정은 미배포(counterfactual)라 코드가 없어 `onERC721Received` 콜백이 일어나지 않는다 |
| 금고 예치 시그니처 | 인벤토리의 `deposit(tokenId)`가 아니라 **`deposit(uint256 eventId, uint256 tokenId, address token, uint128 amount)`**(`SettlementVault.sol:194`). `onlyDepositor`(`:79-82`), payer = `msg.sender`, USDC는 `safeTransferFrom(msg.sender → vault)`(`:219`) |
| 금고 정책 | 서명형 `setPolicy(eventId, policy, PolicyAuth, deviceSig)`(`:113-147`), 첫 예치가 동결(`:205-209`). 금고는 ERC-2771 대상이 아니라 자체 P-256 다이제스트를 검증 |
| `Organizers.createOrganizer` | 컨트랙트상 **누구나** 호출 가능(`Organizers.sol:78-83`). 백엔드가 어테스터 키로 보낼 뿐(`createOrganizer.ts:96-103`) |
| 게이트 | `registerGate`는 `open:false`로 등록(`Organizers.sol:133`). `checkInFor`는 open 필요, `checkInForLate`는 불필요(`Ticket.sol:666-668`) |
| 포워더 | 요청 1건 = 호출 1건(`MontiForwarder.sol:107-134`), allowlist는 ticket/organizers/identity |
| 수동 승인 "2건" | 권한자(소유자·`PERM_APPROVE_OVERRIDE` 관리자·`canApprove` 매니저)는 원래 `manualOverride` 1건. `requestOverride`는 권한 없는 매니저만 탔다(`staff/override/route.ts:97-99`). 데모 스펙 53은 1건 경로 |
| 비용 | `createEvent 0.0475`(주최자 등록 포함 실측), `setPolicy 0.0436`, `publish 0.0175`, `registerGate 0.0275`, `openGate 0.0184`, 결제 측 `0.0247`(릴레이어분), 수동승인+분배 `0.0486`(런북 §7) |
| 가격 정본 | 지금은 Firestore `settlements/{eventId}.priceUsdCentsByTier`(`settlement.ts:438-445`)이고 온체인 티어 가격은 0 → **관객이 자기 기기로 서명한 승인서를 아무 EOA(테스트넷 faucet MON)로 `claimFor`에 직접 제출하면 결제 없이 "유료" 티켓이 민팅된다**(`claimFor`는 permissionless — 현 설계의 구멍) |
| 웹 가격 표시 | `ClaimFlow.tsx:209`, `EventDetail.tsx:145`, `public/settlement/Settlement.tsx:210`이 `settlements` 거울을 읽는다 |
| 초안 | 이미 존재: `eventDrafts/{uid}/drafts/{draftId}`(클라이언트 직접 쓰기, 규칙 `firestore.rules:123-215`). 티어에 `currency`(`free|MON|USDT|USDC`)·`amount`(달러 정수) 칸과 유료 UI가 있으나 `draftRules.ts`의 `paidTier` 문제로 막혀 있다 |
| 숨은 의존 | ① `pendingGates/{account}`를 `registered`로 닫는 것은 **Tenderly 웹훅**(`tenderlyWebhook.ts:195-204`) ② 닉네임 표시는 인덱서 `IdentityAccount.nickname`을 `listAttendees`·`snapshot`·`dailyExport`·웹 `useChatNames.ts`·`queries.ts`가 읽는다 ③ 릴레이 영수증이 8초 안에 안 오면 `reconcileRelays`는 상태만 닫고 `result`(eventId)를 안 쓴다 → 웹 `usePublish`가 "실패"로 오판할 수 있다(v1에도 있는 결함) |
| 리전·키 | 함수 리전은 `@monti/shared`의 `FIREBASE_REGION='us-east1'` 상수(`config.ts:3-7`). KMS 위치는 별도 env(`kms.ts:29`), 리전 변경과 무관 |
| 로컬 체인 | `deployments/31337.json`은 페이마스터 시절 잔재. 백엔드 `loadDeployment`는 10143만 안다 → anvil 통합 환경은 **없다**. 대신 forge 내 E2E 테스트 + 테스트넷 신주소 배포를 통합 환경으로 쓴다(테스트넷 배포는 v1에 영향 없음) |

---

## 2. 아키텍처와 권한 모델

```
관객 기기키(P-256) ──ClaimAuth──▶ [트레저리 EOA] ─tx─▶ SettlementVault.purchase
                                                         ├─▶ Ticket.mintPaid (msg.sender==vault만)  → Transfer, Claimed
                                                         └─▶ escrowOf[tokenId]=HELD, USDC transferFrom(treasury→vault) → Deposited
관객 기기키 ──ClaimAuth──▶ [릴레이어] ─▶ Ticket.claimFor (무료 티어만)
주최자 기기키 ──ForwardRequest──▶ [릴레이어] ─▶ MontiForwarder.execute ─▶ Ticket.publishEvent (_msgSender()=주최자)
                                                         └─(유료면)▶ SettlementVault.setPolicyByTicket(eventId, policy, 주최자)
주최자 기기키 ──ForwardRequest──▶ [릴레이어] ─▶ Organizers.registerGate (열린 상태로)
스태프(권한자) ──ForwardRequest──▶ [릴레이어] ─▶ Ticket.manualOverride ─(확정 훅)▶ vault.release (인라인)
```

| 신뢰 관계 | 근거 |
|---|---|
| 금고 → Ticket: 읽기(`usedAt/eventOf/eventOrg/eventStatus`) + **유료 민팅 호출**(`mintPaid`) | 금고가 돈을 쥐므로 민팅 권한을 금고에만 준다(Zora 1155 "minter" 패턴: 돈 받는 계약이 토큰 계약의 mint를 부른다) |
| Ticket → 금고: **공개 시 정책 기록**(`setPolicyByTicket`)만 | 금고는 `msg.sender == ticket`만 받고, 넘겨받은 `organizer`에 대해 `PERM_MANAGE_SETTLEMENT`(64)를 **자기가 다시** 확인 |
| 금고는 ERC-2771 대상이 아니다 | 돈 계약에 "덧붙인 발신자"를 믿는 표면을 만들지 않는다. 주최자 권한은 포워더 → Ticket의 `_msgSender()` → 인자로 전달 |
| 입장 경로(`checkInFor/checkInForLate/manualOverride`)는 금고를 부르지 않는다 | "정산 때문에 입장이 실패할 일은 없다"(2026-10-01 설계 §3)를 유지 |

역할: **릴레이어** = 무료 받기·입장·포워딩(주최자/관객 동작)·release·settleNoShows. **트레저리** = 유료 구매(민팅+예치 가스 포함)·환불·USDC approve. **어테스터** = `Identity.register/setKycLevel/rotateAccount`·`createOrganizer`. 세 EOA와 키는 v1과 같다(컨트랙트 무관).

---

## 3. 설계 질문 A — 원자 결제

### 비교

| 안 | 내용 | 판정 |
|---|---|---|
| (i) 금고 → `Ticket.claimFor`(permissionless) → 예치 | 가장 적은 변경 | **기각.** `claimFor`는 가격 0 티어만 받으므로 온체인 가격이 0으로 남는다 → 누구든 관객 승인서로 `claimFor`를 직접 불러 무료 민팅 가능. "둘 다 되거나 둘 다 안 되거나"가 체인에서 보장되지 않는다 |
| **(i') 금고 → `Ticket.mintPaid`(금고 전용) → 예치** | 온체인 가격 > 0 티어는 이 경로로만 민팅 | **채택** |
| (ii) Ticket 쪽 훅이 금고를 호출 | `Ticket.purchaseFor` → `vault.depositFor` | 기각. Ticket이 토큰·지불자·allowlist를 알아야 하고 돈 로직이 두 계약에 갈라진다 |
| (iii) 별도 주변 계약(라우터) | 6번째 계약 | 기각. 배선·권한이 하나 더 늘 뿐 이점 없음(금고가 이미 에스크로 주체) |

선례: Seaport(지불과 NFT 이전을 한 tx에서 원자 처리), Zora ERC721Drop `purchase`/Zora 1155 minter(지불 받는 쪽이 mint 호출), ERC-4626 `deposit`(자산 당기기와 지분 발행을 한 호출에서 처리).

### 시그니처 (v2)

```solidity
// contracts/src/interfaces/ITicket.sol — 공유 타입(Ticket·금고·테스트가 같은 선언을 쓴다)
interface ITicket {
    struct ClaimAuth { uint256 eventId; uint8 tier; address account; uint256 nonce; uint64 deadline; }
    function eventOrg(uint256 eventId) external view returns (uint256);
    function eventOf(uint256 tokenId) external view returns (uint256);
    function isRevoked(uint256 tokenId) external view returns (bool);
}

// Ticket.sol (추가)
address public immutable deployer;            // constructor: deployer = msg.sender
address public vault;                          // setVault 1회 배선
function setVault(address vault_) external;   // deployer 전용·1회·0 금지 (Organizers.setTicket 선례)
function mintPaid(ClaimAuth calldata a, bytes calldata deviceSig)
    external returns (uint256 tokenId, uint256 priceUsdCents);   // msg.sender == vault 전용
// claimFor 는 그대로: (tokenId,) = _claimTo(a.eventId, a.tier, a.account, false)

// _claimTo(eventId, tier, to, bool paid) returns (uint256 tokenId, uint256 price)
//   기존 검사(Published·판매창·KYC·승인제 아님·티어 존재·품절·지갑 한도) + 가격 규칙:
//   paid ? (price == 0 → NotPaidTier) : (price != 0 → PaidTiersNotEnabled)

// SettlementVault.sol (추가·교체)
uint256 public constant UNITS_PER_CENT = 1e4;  // 6-decimal USD 스테이블(Circle USDC)만 allowlist
function purchase(ITicket.ClaimAuth calldata a, bytes calldata deviceSig, address token)
    external onlyDepositor whenNotPaused nonReentrant returns (uint256 tokenId);
```

`purchase` 본문 순서: `tokenAllowed[token]` 확인 → `(tokenId, price) = ticket.mintPaid(a, deviceSig)` → `amount = SafeCastLib.toUint128(price * UNITS_PER_CENT)` → `escrowOf[tokenId] = Escrow(token, amount, msg.sender, now, HELD)` → `SafeTransferLib.safeTransferFrom(token, msg.sender, address(this), amount)` → `emit Deposited(a.eventId, tokenId, token, amount, msg.sender)`.
(권장 3줄: 생성자와 `setTokenAllowed(…, true)`에서 `decimals()==6` 확인 — 18자리 토큰 오설정 시 가격이 10^12배 틀어지는 사고 차단.)

| 쟁점 | 결론 |
|---|---|
| tokenId 얻기 | `mintPaid`가 직접 반환. `_nextSerial`/`balanceOf` 차분 같은 우회 불필요 |
| 재진입 | 금고의 돈 경로(`purchase/release/releaseMany/settleNoShows/refund/withdraw`)가 전부 `nonReentrant`. `mintPaid`는 금고 전용, ClaimAuth nonce는 민팅 전에 소비. 콜백이 생겨도(배포된 계정) 금고 재진입 불가 |
| `onlyDepositor`와 자기 호출 | 자기 호출이 없다. 예치 로직을 `purchase` 안에 인라인하고 외부 `deposit()`는 삭제(남겨 두면 비동기 예치 우회로가 된다 — 창업자 금지) |
| ERC-721 수신 | `_safeMint` 유지(세 민팅 경로 공용 코어). 미배포 계정은 코드가 없어 콜백 없음, 배포된 Coinbase 계정은 수신 셀렉터 반환 |
| 이벤트 | 한 영수증에 `Transfer(0→account)` → `Claimed` → `Deposited`. 인덱서 핸들러 무변경(Claimed가 Ticket 행, Deposited가 Escrow 행) |
| 금액 결정 | 온체인 가격 × 1e4. 백엔드는 `payment.amountUsdCents == 체인 가격`만 미리 확인(친절한 오류용) |
| 가스 지불 | 유료 티켓의 민팅 가스는 이제 **트레저리**가 낸다(추정 ~0.035 MON/건, 실측 필요). 릴레이어를 지불자로 쓰려면 "금고가 트레저리 잔고를 당기는 권한"을 릴레이어에게 줘야 해서 키 침해 반경이 커진다 → 기각 |
| 실패 모드 | 트레저리 USDC/allowance 부족·품절·한도 → **전부 시뮬레이션에서 거절되거나 tx 전체 revert**. v1의 "결제창은 성공인데 영수증이 처리 중에서 멈춤"(런북 §4) 상태가 사라진다 |

### 백엔드 `purchaseTicket` (v2)

1. 요청 모양은 그대로(`eventId, tier, auth, deviceSig, payment{card-mock, amountUsdCents}`). 수령 계정은 세션 계정.
2. 사전 확인(가스 전): deadline 미래, `isMember`·`!isLocked`, `claimNonce` 재대조(`relay.ts` `runRelayClaim`의 앞부분을 `lib/claimPrecheck.ts`로 추출해 공용), 체인 `tiers(eventId)[tier].priceUsdCents > 0` 그리고 `== payment.amountUsdCents`(불일치 `PRICE_MISMATCH{expected}`).
3. 멱등: `orderId = claimRelayId(account, eventId, nonce)`(기존 규약). 기존 주문이 `deposited|released|refunded` → 되비춤, `pending|sent` → `{status:'sent'}`, `failed` → 같은 nonce로 재시도 허용(원자 revert라 nonce 미소비).
4. `ensureAllowance(vault, usdc, amount)`(기존 함수 유지, 최초 1회 approve).
5. 시뮬: 트레저리 계정으로 `estimateContractGas(vault.purchase(auth, sig, usdc))`, 디코드 ABI = vault + ticket + `error TransferFromFailed()`. 매핑: Ticket 오류는 기존 `CLAIM_CODES` + `NotPaidTier→NOT_PAID_TIER`, 금고 `Paused→PAUSED`, `NotDepositor/TokenNotAllowed→CONFIG`, `TransferFromFailed→TREASURY_FUNDS`.
6. `orders/{orderId}`(pending) + `relays/{orderId}`(kind `purchase`, pending)를 **전송 전에** 쓴다(웹이 구독) → `sendFromTreasury` → 둘 다 `sent`+txHash → 영수증 ≤8초.
7. 성공: `Claimed` 로그에서 tokenId → 주문 `deposited`(+tokenId, `depositTxHash`=이 tx), 릴레이 `confirmed`(+tokenId), `recordEventUsage(eventId,'purchase',receipt)`. revert: 둘 다 `failed`(+error). 타임아웃: `sent`로 응답, 스윕이 마무리.
8. 응답 `{ orderId, relayId: orderId, status: 'deposited' | 'sent', tokenId?, txHash? }` — `minted` 삭제.

주문 상태 기계 (`minted`·`minted-pending` 삭제, 하위 호환 없음):

```
pending ──전송──▶ sent ──영수증 성공──▶ deposited ──입장/노쇼정산──▶ released
   │               │                       └──환불──▶ refunded
   └─전송 실패─▶ failed ◀──revert / 10분 무영수증(드롭)──┘
```

스윕: `sweepMintedPending` 삭제 → `sweepSentOrders`(status `sent` & `updatedAt < now-2분`): 영수증 성공 → `deposited`+tokenId(릴레이 문서도 `confirmed`+tokenId), revert → `failed`, 영수증 없음 & 10분 경과 → `failed`. `purchase` 릴레이 문서는 이 스윕이 **유일한 소유자**(`reconcileRelays`는 kind `purchase`를 건너뜀 — tokenId를 일관되게 쓰기 위해). `sweepDeposited`·`refundOrder`·`onCheckInConfirmed`는 그대로.

---

## 4. 설계 질문 B — 주최자 배치(공개 1건·게이트 1건·정책 권한)

### 비교

| 안 | 내용 | 판정 |
|---|---|---|
| (i) `MontiForwarder.executeBatch(req{calls[]})` | 서명 1번, 내부 호출 N개 원자 실행 | **기각.** ① `setPolicy`가 쓸 eventId는 `createEvent` 안에서 정해진다 → "앞 반환값 쓰기" 템플릿(복잡) 또는 `nextEventId` 예측(같은 조직이 두 번 누르면 **다른 행사에 정책이 붙는** 경합, 충돌 시 재서명) ② 금고를 ERC-2771 대상·포워더 allowlist에 추가해야 함(돈 계약의 신뢰 표면 확대) ③ 서버 allowlist 검증이 내부 호출별로 복잡해짐 ④ 게이트도 `registerGate`가 gateId를 정하므로 같은 문제 |
| **(ii) 전용 함수** | `Ticket.publishEvent(meta, tiers, policy)` + `registerGate` 기본 개장 | **채택** |

선례: Multicall3·Uniswap `multicall`·OZ `ERC2771Forwarder.executeBatch`·EIP-5792 `wallet_sendCalls`는 모두 **호출 간 데이터 전달이 없다**. 생성 id에 의존하는 조합은 전용 "create-and-initialize" 함수로 푼다(Uniswap V3 `createAndInitializePoolIfNecessary`, Safe `createProxyWithNonce`+initializer).

### `Ticket.publishEvent`

```solidity
function publishEvent(EventMeta calldata meta, Tier[] calldata tiers_, ISettlementVault.SplitPolicy calldata policy)
    external returns (uint256 eventId);
```

1. `organizer = _msgSender()`(포워더 경유) → `organizers.hasPermission(meta.orgId, organizer, PERM_CREATE_EVENT)` 아니면 `Unauthorized`.
2. 티어 1–8개(`InvalidTiers`), 일정(`InvalidSchedule`) — 기존 `createEvent` 검사 그대로.
3. `paid = any(tier.priceUsdCents > 0)`. `paid`면: `meta.approvalRequired` 금지(`PaidApprovalUnsupported` — 승인제 경로는 가격 0만 받으므로 그런 행사는 아무도 못 받는다), `policy.recipients.length > 0` 필수(`PolicyRequired`). 무료면 `policy.recipients.length == 0` 필수(`UnexpectedPolicy`).
4. `eventId = _nextEventId++`(시작값 **1001**, D7), 메타·티어(minted=0) 저장, `_status = Published`.
5. `emit EventCreated(eventId, meta.orgId, organizer)` → `emit EventStatusChanged(eventId, 1)`.
6. `paid`면 마지막에 `ISettlementVault(vault).setPolicyByTicket(eventId, policy, organizer)`.

삭제: `createEvent`, `publishEvent(uint256)`, `updateEventMeta`(초안이 off-chain이므로 Draft 편집 대상이 없다), 이벤트 `EventMetaUpdated`, 오류 `NotDraft`. `EventStatus` enum은 번호 유지(Draft=0은 "없는 행사" 뜻으로만 남음 — 인덱서·금고·웹이 번호를 공유하므로 재번호 금지). `cancelEvent` 유지.

### `SettlementVault.setPolicyByTicket`

```solidity
function setPolicyByTicket(uint256 eventId, SplitPolicy calldata policy, address organizer) external whenNotPaused;
// msg.sender != address(ticket) → NotTicket
// orgId = ticket.eventOrg(eventId)   (Ticket이 메타를 먼저 저장했으므로 0이 아님)
// !organizers.hasPermission(orgId, organizer, PERM_MANAGE_SETTLEMENT) → NotPolicyAuthorizer
// _policyOf[eventId].version != 0 → PolicyFrozen (1회 설정)
// _validatePolicy(policy)  (기존: 합 10000·플랫폼 ≥5%·미러 일치·수취인 1–10)
// 저장, frozen = true, version = 1, emit PolicySet(eventId, organizer, hashPolicy(policy), 1)
```

정책은 **공개 순간 동결**된다(공개 후 "바꾸기" 삭제). 이유: 공개 = 공개 약속. 첫 판매 전 수정 경로를 남기면 그 경로에 권한·서명이 또 필요하다. 수정은 초안 단계에서 한다.
삭제(금고): 서명형 `setPolicy`, `setPolicyDigest`, `SETTLE_POLICY_TAG`, `PolicyAuth`, `policyNonce`, `deposit`, 생성자 인자 `identity`(서명 검증용이었음), 오류 `AuthExpired/BadNonce/BadDeviceSignature/AlreadyDeposited/ZeroAmount/NoPolicy/UnknownEvent`(도달 불가가 된 것). 유지: `hashPolicy`(PolicySet의 해시·백엔드 교차검증), `getPolicy`, `release/releaseMany/settleNoShows/refund/withdraw`, 관리 함수.

### 게이트

`Organizers.registerGate(uint256 eventId, address gateAccount, bytes32 kx, bytes32 ky) returns (uint256 gateId)` — 검사 동일, 저장 시 `open: true`, `emit GateRegistered(...)` 다음 `emit GateOpened(gateId)`. `openGate/closeGate/revokeGate` 유지(잠시 닫기용). 인덱서는 같은 tx의 두 이벤트를 순서대로 처리해 `isOpen=true`가 된다(핸들러 무변경 확인: `EventHandlers.ts` GateRegistered→false, GateOpened→true).

### 주최자 등록

`createOrganizerForMe`(어테스터 1건) 유지. 공개 버튼의 첫 단계(`usePublish.resolveOrg`)에서 필요할 때만 실행 — 1회성.

### 백엔드 `relayAction` (v2)

| 변경 | 내용 |
|---|---|
| allowlist(`lib/actionAllowlist.ts`) | 삭제: `createEvent`, `publishEvent(uint256)`, `updateEventMeta`, `requestOverride`, `setNickname`. 추가: `publishEvent((uint256,bytes32,bytes32,string,uint64,uint64,bytes32,uint64,uint64,bool,uint32,uint8,bool,uint8,bytes32,bool),(string,uint256,uint32,uint32,uint16,bool)[],((address,uint16,bytes32,bytes32)[],uint16,uint16,bool,bool,uint32))` |
| 회계 scope | `publishEvent` → `orgStruct`(args[0].orgId) |
| 시뮬 ABI | `publishEvent`일 때 forwarder + ticket + **settlementVault** ABI(금고 오류가 Ticket을 거쳐 버블되므로 이름 디코딩에 필요) |
| 요청 | `RelayActionRequest`에 선택 필드 `reasons?: string[]`(publish 전용, 각 ≤80자, 수취인 수와 같아야 함) |
| 릴레이 문서 | 모든 relayAction 문서에 `data`(calldata hex)와 `reasons?`를 저장 → 확정 훅을 **재실행 가능**하게 |
| 확정 훅(`lib/postConfirm.ts`, 멱등) | `publishEvent`: `result.eventId`(EventCreated) + 유료면 `settlements/{eventId}` 거울(calldata 디코드: 티어 가격 → `priceUsdCentsByTier`, 정책 → `policy.recipients[{account,bps,reason,tag}]`·`platformBps`·`policyHash`·`setBy`·`txHash`; reason은 `keccak256(reason)==reasonHash`일 때만 저장, 아니면 `''`). `registerGate`: `result.gateId` + `pendingGates/{gateAccount}`를 `registered`(+gateId)로(Tenderly 의존 제거). `manualOverride`: 기존 인라인 release + 같은 tokenId의 열린 `overrideRequests`를 `approved`로 |
| `reconcileRelays` | 확정으로 닫을 때 같은 훅 실행 + `result` 기록(v1의 "타임아웃 시 eventId 유실" 결함 해소). kind `purchase`는 건너뜀 |
| 삭제 | 콜러블 `relaySetPolicy`, `setPolicyRelayId`, RelayKind `setPolicy` |

---

## 5. 설계 질문 C — 초안 off-chain 흐름

| 단계 | 저장 위치 | 체인 |
|---|---|---|
| 만들기(`/org/new/:draftId`, `CreateEvent`) | `eventDrafts/{uid}/drafts/{draftId}` (기존, 2초 자동 저장). 유료 티어 허용: `currency:'USDC'`, `amount`(달러 정수) → `priceUsdCents = amount×100` | 없음 |
| 정산 규칙(새 화면 `/org/new/:draftId/publish`의 첫 카드, 유료일 때만) | 같은 초안의 **`splitJson`**(수취인 행 `[{name,account,bps,tag,platform}]`의 JSON 문자열, ≤4000자). MONTI 5% 플랫폼 행 고정(`VITE_ADDR_PLATFORM`) | 없음 |
| 공개(같은 화면의 공개하기 + 되돌릴 수 없음 확인 시트) | `usePublish`: `resolveOrg` → 포스터/메타 핀 → `sendAction('publishEvent','ticket', calldata(meta, tiers, policy), onSent, {reasons})` → `result.eventId` → 후속(`saveEventArt`, `setEventPrivate`) → 초안 삭제 → `/org/new/done/:eventId` | **1건** |

- **규칙 예산:** 초안 규칙은 표현식 1000개 한도라 티어 8칸 검사만으로 꽉 차 있다(`firestore.rules:110-120` 주석). 수취인 목록을 맵 배열로 두면 예산이 터진다 → **문자열 한 칸 `splitJson` + `capped('splitJson', 4000)`** 검사 1개로 막는다. 내용 검증은 화면(`settlementModel.validateRows`)과 금고(`_validatePolicy`)가 한다.
- **eventId 결합:** 공개 tx 확정 시 relayAction 훅이 `EventCreated`에서 eventId를 읽어 릴레이 `result`와 `settlements/{eventId}`에 쓴다. 웹은 기존처럼 `submittedRelayId`(페이지 닫힘 대비)와 `createdEventId`를 초안에 기록한다.
- **공개 전/후 화면:** 공개 전에는 eventId가 없다 → 대시보드·게이트·`/claim/<id>` 링크 없음(공개 화면에 "공개하면 링크가 생겨요"). 공개 후에는 체인이 즉시 Published → 대시보드(티어는 체인 폴백 `useEventTiersWithFallback`), 게이트 화면, 받기 링크 모두 즉시 동작. 인덱서 지연 때문에 가격 칸이 안 뜨던 v1 문제(스펙 50/50b의 최대 5분 대기)가 사라진다.
- **삭제:** `EditEvent.tsx` 경로(`/org/events/:eventId/edit`), 초안 `editingEventId`, `lifecycle.saveDraft`(updateEventMeta), `usePublish.update`, 대시보드의 발행 버튼·발행 요약 시트·편집 링크, `SettlementSection`의 확정/바꾸기·가격 입력·`buildPolicyAuth.ts`, 웹 `settlementAbi.ts`의 `policyNonce`·`setPolicyDigest`, shared의 `setPolicyPreimage/setPolicyDigest/buildPolicyDigest/SETTLE_POLICY_TAG`.
- **유지/재사용:** `settlementModel.ts`(행 검증·예시 분배), shared `toOnChainRecipients/hashPolicy/reasonHash/tagToBytes32`, `followUps.ts`, `Created.tsx`, `PendingCreateBanner`(문구만 "공개 진행 중").

---

## 6. 설계 질문 D — 수동 승인 요청 off-chain

| 구성 | 내용 |
|---|---|
| 콜러블 `requestOverride` | 입력 `{eventId, tokenId, gateId, reason(1–4), note?(≤140)}`. 세션 계정으로 체인 확인(삭제된 컨트랙트 함수와 같은 기준): `eventOrg(eventId)≠0`, `tokenId>>96 == eventId`, `gateInfo(gateId).eventId == eventId`, `managerOf(orgId, account).exists \|\| hasPermission(orgId, account, 4)` 아니면 `permission-denied` |
| 문서 `overrideRequests/{autoId}` | `{eventId, tokenId, gateId, reason, note?, requesterAccount, requesterPersonId, status:'open'\|'approved', approvedBy?, approvedTxHash?, createdAt, approvedAt?, expireAt(+24h TTL)}` |
| 콜러블 `listOverrideRequests` | `{eventId}` → 열린 요청 ≤50(최신순). 승인 권한(`hasPermission(…,4)` 또는 `canApprove` 매니저)만 |
| 승인 | 기존 `manualOverride` 릴레이(사유 코드 그대로). relayAction 확정 훅이 같은 tokenId의 `open` 요청을 `approved`로 |
| 규칙 | 읽기: `request.auth.token.personId == resource.data.requesterPersonId`, 쓰기: 서버 전용. 색인 `(eventId, status, createdAt desc)`, TTL `expireAt` |
| 웹 | 스태프 `submitOverride`의 `requestOverride` 경로를 콜러블 호출로 교체(승인 대기 화면은 기존 `watchManualOverride` 체인 로그 감시 그대로). 대시보드에 승인권자용 "입장 승인 요청" 카드(목록 + 승인 버튼 → `sendAction('manualOverride', …)`) |
| 컨트랙트 | `Ticket.requestOverride`, `OverrideRequested` 삭제. 인덱서 핸들러·config 항목 삭제, `Override.requested` 열 삭제(쓰는 곳 없음 확인) |

선례: Safe Transaction Service(제안·확인은 서버, 실행만 온체인), Snapshot(오프체인 제안 + 온체인 실행).

---

## 7. 설계 질문 E — 닉네임 off-chain

| 구성 | 내용 |
|---|---|
| 문서 `nicknames/{정규형}` | `{personId, account, updatedAt}`. 정규형 `^[a-z0-9_]{3,20}$`(기존 `normalizeNickname`과 동일). 서버 전용 |
| 콜러블 `setNickname` | 트랜잭션: 대상 문서가 남의 personId면 `NICKNAME_TAKEN` → 이전 이름 문서 삭제(내 것일 때만) → 새 문서 기록 → `users/{uid}.nickname` 미러 |
| `resolveRecipient` 닉네임 분기 | `nicknames/{n}` → `persons/{personId}.account`(현재 계정 — 회전 자동 반영) → 없으면 `NICKNAME_UNKNOWN` |
| 표시 | `lib/nicknames.ts` `nicknamesByAccount(accounts)`(Firestore `in` 30개씩) — `listAttendees`·`snapshot`·새 콜러블 `resolveNicknames`(웹 채팅 이름 `useChatNames.ts`, 승인제 신청 목록 `queries.ts` 닉네임 질의 대체) |
| 회전 | `recoverAccess` 확정 지점에서 personId의 닉네임 문서 `account` 갱신(3–5줄) |
| 삭제 | `Identity.setNickname/nicknameOwner/nicknameOf`, `_nicknameOwner/_nicknameOf`, `NicknameSet`, `NicknameTaken/NicknameHashMismatch`, `rotateAccount/cancelRotation`의 닉네임 이동 블록, `IIdentity`의 두 함수, `tenderlyWebhook`의 `NicknameSet`·`mirrorNickname`, 인덱서 `NicknameSet` 구독·핸들러, `IdentityAccount.nickname` 열(P5 완료 시), 웹 `USED_ABI`의 `nicknameOwner/setNickname` |
| 규칙 | `users/{uid}.nickname` 클라이언트 쓰기 규칙은 **전환 기간에는 그대로 둔다**(v1 웹이 같은 규칙을 공유). 데모 후 정리 항목 |

컨트랙트 삭제는 확정(창업자 E: "다른 의존이 없으면 삭제"). 남은 의존은 위 표의 소비처뿐이고 전부 이 작업에서 대체된다. 선례: Farcaster fname 서버(서버가 관리하는 유일 이름 ↔ 온체인 id), Coinbase cb.id(오프체인 DB 기반 이름 해석).

**P5를 자르면(컷 라인 1순위) 최소 조치(P5-min, 30분):** 웹 닉네임 편집 칸 숨김 + `USED_ABI` 정리, `resolveRecipient` 닉네임 분기는 `NICKNAME_UNKNOWN`, 인덱서는 `IdentityAccount.nickname` 열을 **남겨 둔다**(항상 null) → `listAttendees`·`snapshot`·채팅 이름 질의가 깨지지 않고 이름만 빈칸/번호로 보인다.

---

## 8. 컨트랙트 인터페이스 변경 전체 (ABI 동결 대상, `contracts/abi-delta-v2.md`로 고정)

| 계약 | 추가 | 삭제 | 동작 변경 |
|---|---|---|---|
| `Ticket` | `deployer`, `vault`, `setVault`, `publishEvent(meta,tiers,policy)`, `mintPaid`; 오류 `NotDeployer, VaultAlreadySet, ZeroAddress, NotVault, NotPaidTier, PolicyRequired, UnexpectedPolicy, PaidApprovalUnsupported` | `createEvent`, `publishEvent(uint256)`, `updateEventMeta`, `requestOverride`; 이벤트 `EventMetaUpdated`, `OverrideRequested`; 오류 `NotDraft` | `_nextEventId` 시작 1001; `ClaimAuth`는 `ITicket`에서 상속 |
| `SettlementVault` | `setPolicyByTicket`, `purchase`, `UNITS_PER_CENT`; 오류 `NotTicket` | `setPolicy`, `setPolicyDigest`, `SETTLE_POLICY_TAG`, `policyNonce`, `deposit`, `PolicyAuth`, 생성자 `identity`, 오류 7종(§4) | 생성자 `(ticket, organizers, initialDepositor, initialToken)`; 정책 1회·즉시 동결 |
| `Organizers` | — | — | `registerGate` 개장 등록(+`GateOpened`); `_nextOrgId` 시작 1001 |
| `Identity` | — | 닉네임 일체(§7) | — |
| `MontiForwarder` | — | — | 무변경(재배포만) |
| `ITicket` | `struct ClaimAuth` | — | — |
| `ISettlementVault`/`ITicketReader` | `mintPaid` 선언, 위 함수 선언 | 위 삭제분 | — |

배포 순서(`script/Deploy.s.sol` 단일화, `DeploySettlement.s.sol` 삭제):
`Identity(attester)` → `MontiForwarder(identity, deployer)` → `Organizers(fwd)` → `Ticket(identity, organizers, fwd)` → `SettlementVault(ticket, organizers, TREASURY_ADDRESS, USDC_ADDRESS)` → `identity.setForwarder(fwd)` → `fwd.setTargets(ticket, organizers)` → `organizers.setTicket(ticket)` → `ticket.setVault(vault)`.
기록 `deployments/10143.json` = `{chainId, block, identity, forwarder, organizers, ticket, settlementVault, usdc, attester}` — **`previous[]`·`settlementVaultBlock` 삭제**(v1 주소는 git 이력에만). 시드·측정 스크립트(`Seed.s.sol`, `SeedFinish.s.sol`, `MeasureRelayed.s.sol`)와 `test/Seed.t.sol`, `deployments/seed-10143.json` 삭제(v2 데모 행사는 앱으로 만든다; 웹 `SEEDED_EVENT_ID='1'` 기본값 제거).

---

## 9. 백엔드 변경 요약 (콜러블·Firestore)

| 콜러블 | 변경 |
|---|---|
| `purchaseTicket` | 원자 1건(§3) |
| `relayAction` | kind 목록·`reasons`·`data` 저장·재실행 가능 훅(§4) |
| `relaySetPolicy` | **삭제** |
| `requestOverride`, `listOverrideRequests` | 신규(P4) |
| `setNickname`, `resolveNicknames` | 신규(P5) |
| `resolveRecipient`, `listAttendees`, `issueSnapshot`/`getPhotoForGate` | 닉네임 출처 Firestore(P5) |
| `reconcilePending` | `settlementSweep` = `sweepSentOrders` + `sweepDeposited`; `reconcileRelays`가 훅 실행·`result` 기록 |
| `tenderlyWebhook` | `NicknameSet` 제거(나머지 유지; Tenderly 알림 재설정은 선택) |

| Firestore | 변경 |
|---|---|
| `orders/{orderId}` | 상태 `pending\|sent\|deposited\|released\|refunded\|failed`, `error?`, `depositError`·`minted*` 삭제 |
| `relays/{relayId}` | kind `+purchase −setPolicy`; relayAction 문서에 `data`, `reasons?`, `result` |
| `settlements/{eventId}` | 모양 동일, 작성자 = publish 확정 훅 |
| `eventDrafts/{uid}/drafts/{id}` | `+splitJson`(규칙 `capped('splitJson', 4000)`), `−editingEventId` |
| `pendingGates/{gateAccount}` | `registered` 전이를 relayAction 훅이 수행 |
| `overrideRequests/{id}` · `nicknames/{name}` | 신규(규칙·색인·TTL·`ALLOWED_COLLECTIONS` 추가) |
| 규칙/색인 배포 | **추가만** 한다(새 컬렉션, `splitJson` 상한, 새 색인) → 같은 프로젝트를 쓰는 v1이 그대로 동작 |

---

## 10. 웹 변경 (화면별)

| 화면 | 변경 |
|---|---|
| `/org/new/:draftId` 만들기 | 유료(USDC) 티어 허용(`paidTier` 문제 삭제), `paidApproval` 문제 추가(유료+승인제 금지), 마지막 버튼 → 저장 후 `/org/new/:draftId/publish` |
| `/org/new/:draftId/publish` (신규 `DraftPublish`) | 발행 요약(대시보드 시트에서 이동) + 유료면 정산 규칙 카드(`SplitEditor` = `SettlementSection`에서 가격·확정 제거, `splitJson` 저장) + 공개하기(`usePublish`) |
| `/org/new/done/:eventId` | 유지 |
| `/org/events/:eventId` 대시보드 | 발행·편집 제거, 정산 카드 읽기 전용(거울 + `getPolicy`, 공개 링크), 승인권자에게 "입장 승인 요청" 카드(P4), 취소 유지 |
| `/org/events/:eventId/edit` | 삭제 |
| `/org/events/:eventId/gates` | 코드 무변경(등록 즉시 열림) |
| `/claim/:eventId`, 결제 시트, 영수증 | `usePurchase`: `deposited\|sent`만, `failed` 문구("결제가 완료되지 않았어요. 청구되지 않았어요") 추가 |
| 스태프 수동 승인 | 요청 경로 → `api.requestOverride`(P4) / P4 자르면 "승인 권한자가 직접 승인해야 해요" 안내(P4-min) |
| 내 정보 닉네임 | `api.setNickname`(P5) / 숨김(P5-min) |
| 공통 | `USED_ABI`·shared ABI·주소·`DEFAULT_FUNCTIONS_REGION='us-east4'`·문구 린트(`pnpm lint:copy`) — 화면에 web3 단어 금지 |
| e2e | `utils/organizer.ts`를 초안→공개 흐름으로, 스펙 55를 v2(공개 1건·게이트 1건·결제 1건) 기준으로, 50/50b 삭제, 비용 측정에 트레저리 MON 잔고 추가 |

---

## 11. 인덱서 영향 (`indexer/`, 브랜치 v2 백엔드)

| 파일 | 변경 |
|---|---|
| `scripts/gen-config.mjs` | Identity `events`에서 `NicknameSet` 제거, Ticket `events`에서 `EventMetaUpdated`·`OverrideRequested` 제거(분류 안 된/없는 이벤트가 있으면 생성기가 던진다), SettlementVault `startBlockKey` 제거(같은 배포 블록) |
| `src/vendored/settlement-vault-abi.json` | 새 ABI로 교체(`{_comment, abi}` 형식 유지) |
| `src/EventHandlers.ts` | `NicknameSet`·`EventMetaUpdated`·`OverrideRequested` 핸들러 삭제, `ManualOverride`의 `requested` 필드 삭제 |
| `schema.graphql` | `Override.requested` 삭제, `IdentityAccount.nickname`은 P5 완료 시 삭제(아니면 유지) |
| `config.yaml`, `src/vendored/{ticket-abi,deployment}.json` | `pnpm indexer:config`로 재생성(주소·시작 블록 = v2 `block`) |
| 호스팅 | 무료 플랜은 동시에 1개만 돈다 → 창업자가 v1 배포 삭제 후 `git push origin <v2 백엔드 브랜치>:envio-release`. 새 배포 id → 백엔드 `ENVIO_GRAPHQL_URL`, 웹 `VITE_ENVIO_URL` |

같은 tx 안 이벤트 순서(`EventCreated → EventStatusChanged(1) → PolicySet`, `Transfer → Claimed → Deposited`, `GateRegistered → GateOpened`)는 기존 핸들러가 그대로 처리한다. `EventCreated` 핸들러는 블록 고정 `eventMeta/tiers` 읽기 → 같은 블록 상태라 가격·티어가 정확하다.

---

## 12. 설계 질문 F — 배포·전환 (블루/그린)

### 토폴로지

| 층 | v1 (전환 전 운영) | v2 (병행 → 전환 후 운영) |
|---|---|---|
| 컨트랙트 | 기존 주소(무변경) | 새 주소(새 배포자 키) |
| 백엔드 | codebase `default`, `us-east1` | codebase **`v2`**, **`us-east4`**(`FIREBASE_REGION` 상수 변경, `firebase.json` `"codebase":"v2"`), `DEV_ORIGINS=https://v2.monti.despell.io` |
| 웹 | `monti.despell.io`(현재 운영 배포) | 스테이징 `v2.monti.despell.io`(Vercel 브랜치 도메인 + Preview(v2) env) → 검증 후 운영 env를 같은 값으로 바꿔 `vercel --prod`/promote |
| 인덱서 | `d6a478c` | 13:00에 교체(무료 1개) |
| Firestore·Auth·시크릿·EOA | 공유 | 공유(문서 키 충돌은 D7로 방지, 규칙·색인은 추가만) |

근거: 콜러블은 리전별 자원이라 같은 이름이 다른 리전에 공존할 수 있고(Cloud Functions 이름 유일성은 리전 단위), codebase 표기가 있으면 한 codebase 배포가 다른 codebase 함수를 지우자고 하지 않는다(Firebase "Organize functions" 문서). 웹은 리전을 `VITE_FUNCTIONS_REGION`으로 고른다. 패스키 RP ID `monti.despell.io`는 하위 도메인 `v2.monti.despell.io`에서도 유효하다(RP ID = origin의 등록 가능 접미사). **같은 이름·다른 리전·다른 codebase 공존은 문서로 명시 확인되지 않았다 → 계획 O1의 탐침(probe)으로 05:00 전에 실증**, 실패 시 B안.

B안-1(탐침 성공·DNS 미준비): 백엔드는 그대로 `us-east4` 병행, 웹만 운영 도메인에 v2를 **1회** 배포해 검증하고 실패하면 Vercel Instant Rollback(재빌드 없음).
B안-2(탐침 실패): v2 백엔드를 `default`/`us-east1`에 덮어쓰는 **운영 교체**(14:00), 롤백 = v1 태그에서 재배포(~10분) + Vercel Instant Rollback.
두 경우 모두 판정 전 v2 운영 배포는 1회만 한다(Instant Rollback 대상이 v1로 남게).

### 키·역할

- **새 배포자 키 권장(기본값).** v2의 배포자는 금고 owner(일시정지·allowlist)이고 `Identity.setAttester` 권한자다(계정 탈취 경로). 10-02~10-08 설명 안 된 배포자 키 tx ~345건이 해명될 때까지 옛 키에 이 권한을 주지 않는다. 옛 키에서 10 MON 이체(배포 ~2 MON 추정 + 재배포 예비), v2 확정 후 잔액 이전·옛 키 은퇴. 옛 키 tx는 탐색기로 수신처를 확인한다(포지 브로드캐스트 기록에는 10-01 이후 `DeploySettlement` 1건뿐 — 원인 미확인).
- 배포 후 상태(모두 생성자/배선으로 설정, 추가 tx 없음): `Identity.attester = 0x6af898aA4d99375839d7069431A7019a6D84C4Ed`, `Identity.trustedForwarder = fwd`, `fwd.ticket/organizers`, `Organizers.ticket`, `Ticket.vault`, 금고 `owner = 새 배포자`, `tokenAllowed[USDC]=true`, `depositor[treasury 0xAe6D…6Bb2]=true`. 트레저리의 USDC approve는 첫 구매가 자동 처리(`ensureAllowance`) — 하니스 전에 1회 데워 둔다.
- 잔고: 트레저리 MON ≥ 1.5(유료 민팅 가스 부담으로 증가), 트레저리 USDC $72.5(§13 예산), 릴레이어 MON 8.1(충분).

### `10143.json` 갱신

`MONTI-prod/contracts/deployments/10143.json`을 배포 스크립트가 통째로 쓴다 → 같은 파일과 `packages/shared/src/abi/*.json`을 `MONTI-backend`·`MONTI-web` 워크트리의 v2 브랜치에 복사·커밋(각 패키지의 `sync:deployments`가 `contracts/deployments`에서 shared로 복사). v1 브랜치는 태그로 보존.

### 전환 순서와 롤백

1. 태그 `v1-final/{mvp,mvp-settle-indexer,mvp-settle-web}` → 각 워크트리에서 v2 브랜치 생성.
2. 컨트랙트 rc 배포(테스트넷) → cast 배선 점검.
3. 인덱서 교체(13:00, 창업자 v1 배포 삭제) → 정상 동기화 확인.
4. 백엔드 v2(codebase v2, us-east4) 배포, 규칙·색인(추가분) 배포.
5. 웹 v2 스테이징(`v2.monti.despell.io`) → 하니스.
6. **20:00 GO/NO-GO.** GO: Vercel 운영 env를 v2 값으로 + 운영 배포 → v1 `reconcilePending` 스케줄러 일시정지(`gcloud scheduler jobs pause firebase-schedule-reconcilePending-us-east1 …`; 공유 Firestore에서 v1 스윕이 v2 가입 건을 v1 Identity로 재등록하는 드문 경합 차단) → 운영 도메인 짧은 스모크. NO-GO: 운영은 v1 그대로, v2 인덱서 삭제 → v1 커밋을 `envio-release`에 재푸시 → 새 id면 v1 백엔드 env·웹 env 갱신·재배포(~30분).
7. 전환 후 롤백(09:00 전까지): `vercel rollback <v1 운영 배포>`(재빌드 없음) + v1 스케줄러 재개 + v1 인덱서 재생성. **운영 env 값은 v1 값을 `vercel env pull`로 미리 저장**해 둔다(롤백 후 재빌드가 필요할 때를 대비).
8. 데모 후 정리: v1 codebase 함수 삭제, `users.nickname` 클라이언트 쓰기 제거, 옛 금고 HELD 에스크로 회수(트레저리 `refund` 가능분), Tenderly 알림 v2 재설정.

주의: 스테이징 도메인에서 만든 계정의 기기 키는 그 origin의 브라우저 저장소에만 있다 → **무대용 계정(주최자·관객)은 전환 후 운영 도메인에서 새로 가입**한다. 네이티브 안드로이드 앱(있다면)은 v2 env로 재빌드 전까지 v2와 맞지 않는다 — 무대는 브라우저 수동 승인이므로 범위 밖.

---

## 13. 검증 매트릭스

| # | 무엇 | 도구·명령 | 번호/자원 | 합격 기준 |
|---|---|---|---|---|
| V0 | 단위 | `forge test`, 백엔드 `pnpm --filter monti-functions test`(+`test:rules`), 웹 `pnpm -F web test`·`typecheck`·`pnpm lint:copy`, `pnpm --filter monti-indexer test`·`pnpm indexer:check`, `pnpm --filter @monti/shared test` | — | 전부 green(삭제한 테스트 외 회귀 0). 기준선: 백엔드 933, 웹 2179 |
| V1 | 컨트랙트 E2E(EVM 내) | 신규 `test/V2Flow.t.sol` | — | 조직 → 유료 공개(정책 동결 v1) → 게이트(open) → purchase(Claimed+Deposited 한 tx, 금액=가격×1e4) → manualOverride(포워더) → release(60/20/15/5 정확, 먼지는 마지막) / 환불 / 노쇼 / `claimFor`로 유료 티어 민팅 시도 → `PaidTiersNotEnabled` / 금고 외 `mintPaid` → `NotVault` / USDC 부족 → 전체 revert(티켓 0) |
| V2 | 테스트넷 배선 | cast 12개 호출(계획 O3) | 새 배포자 | 전부 기대값 |
| V3 | 스테이징 스모크 | e2e `00-smoke`, `01-public-surface` (`E2E_BASE_URL=https://v2.monti.despell.io`) | 로그인 없음 | pass |
| V4 | **주 경로** | e2e `55`(v2판), `E2E_PRICE_USD=10` | 주최자 …17, 관객 A …18 | 주최자 온체인 tx = 3(`createOrganizer`·`publishEvent`·`registerGate`), 결제 1 tx(같은 영수증에 Claimed+Deposited), 결제 클릭→완료 ≤ 5초 목표, 수동 승인 ≤ 3초, 영수증 "정산 완료" ≤ 8초, 공개 정산 페이지 규칙 렌더 |
| V5 | 환불 경로 | e2e `56` | 관객 B — 번호 교체/초기화 후 1개 | 영수증 "환불됨" ≤ 6초, 에스크로 Refunded, 트레저리 USDC 원복 |
| V6 | 체인 사후 확인 | cast: `eventStatus(id)=1`, `getPolicy(id)`(합 10000·frozen·version 1), `gateInfo(gid).open`, `usedAt(tok)>0`, `escrowOf(tok).status`, `Paid` 로그 | — | 기대값 일치 |
| V7 | 인덱서 | GraphQL `chain_metadata` + 해당 행사 `Event/Tier/Ticket/Escrow/Payout/Gate` | — | `is_hyper_sync=true`, lag<100, 행 존재·`Gate.isOpen=true`, `Tier.priceUsdCents=1000` |
| V8 | P4(요청) | 백엔드 에뮬레이터 테스트 + 수동 1회(권한 없는 매니저 계정 필요 시 생략 가능) | 예비 번호 | 요청 문서 생성 → 승인 후 `approved` |
| V9 | P5(닉네임) | 단위 + 수동(닉네임 설정 → 닉네임으로 받는 사람 찾기 → 참석자 목록 표시) | 하니스 계정 재사용 | 일치 |
| V10 | 리허설 | 런북 §2 순서 그대로(운영 도메인, 전환 후) | 주최자 = 무대 관리자 폰 새 번호, 관객 = 리허설용 번호, **…20은 무대 관객용으로 끝까지 미사용** | 전 구간 통과 + 영상 백업 |

번호 예산: 미사용 …17/…18/…20 셋으로는 "하니스 주최자 + 관객 A + 관객 B + 리허설 2명 + 무대 관리자 + 무대 관객"이 안 된다. **권장:** 메모(monti-test-phone-numbers)의 절차로 Identity Platform 테스트 번호를 교체해 …17/18/20을 유지하고 …21~…27을 추가(비파괴, 10개 상한 준수, `E2E_PERSONA_OFFSET=20`). 대안: 소진 번호 …11–16·19를 `reset-persons.ts --phone`으로 개별 초기화(파괴적 — 테스트 계정만, `--all` 금지). 둘 다 불가하면 V5를 생략하고 환불은 V1·단위 테스트로만 갈음.

USDC 예산($72.5): 하니스 $10 결제(분배 후 플랫폼 5% $0.5 회수) + 환불 $10(원복) → −$9.5, 리허설 $10 → −$9.5, 무대 $30 → −$28.5 ⇒ 잔액 ≈ $25. 실패한 결제는 원자 revert라 USDC가 빠지지 않는다. 그래도 무대 전 faucet 1회 충전 권장.

---

## 14. 가스·비용 추정 (미실측 — V4에서 실측해 런북 §7 갱신)

| 단계 | v1 실측 | v2 추정 |
|---|---|---|
| 공개(생성+정책+발행) | 0.0475+0.0436+0.0175 = 0.109 (3 tx) | ~0.09–0.10 (1 tx: 기본료 2회·포워더 검증 2회·금고 P-256 검증 1회 절감) |
| 게이트(등록+열기) | 0.0275+0.0184 = 0.046 | ~0.028 |
| 유료 구매 | 0.0247(릴레이어) + ~0.0126(트레저리 예치) ≈ 0.037 | ~0.035 (1 tx, 트레저리) |
| 수동 승인+분배 | 0.0486 | 0.0486 |

100명 유료 행사(전원 수동 승인 상한): v1 ≈ 0.155 + 100×(0.037+0.0486) ≈ 8.7 MON → v2 ≈ 0.14 + 100×(0.035+0.0486) ≈ 8.5 MON(≤10 MON 충족). **v2의 이득은 비용보다 원자성·대기 단계 감소다**(창업자에게 그대로 보고).

---

## 15. 리스크·엣지케이스

| # | 리스크 | 대응 |
|---|---|---|
| R1 | 일정: 세 레인 동시 변경 + 하니스 재검증이 하루 안 | ABI 04:00 동결, 레인 간 인터페이스 선고정(계획 §인터페이스), 20:00 GO/NO-GO에서 미달이면 v1 유지(무손실) |
| R2 | 인덱서 무료 플랜 1개 제약: 13:00 이후 v1 목록 화면 중단, v2 재배포 시 URL 교체 연쇄 | 컨트랙트를 13:00 전에 확정(V1+V2 통과 후에만 교체), 하니스는 폴백으로도 통과하게 설계됨, 롤백 절차 문서화 |
| R3 | 같은 이름·다른 리전·다른 codebase 공존 미실증 | O1 탐침(10분), `--force` 금지(삭제 프롬프트가 나오면 비대화형 모드가 실패하므로 안전), 실패 시 B안 |
| R4 | Firestore id 충돌(v1 문서가 v2 멱등 로직을 삼킴: 예 `relays/{eventId:tokenId}`가 `confirmed`면 입장 tx를 안 보냄) | D7 오프셋(eventId·orgId 1001+). 계정 키 기반 문서(`relays/{account:nonce}`)는 v1 계정이 v2에서 비회원이라 실제 충돌 없음(재등록 금지) |
| R5 | 새 코드 버그(publish→금고, mintPaid, purchase) | V1 E2E + 실패 경로 테스트, 테스트넷 rc에서 cast/시뮬 확인 후 인덱서 교체 |
| R6 | v1 계정은 v2 Identity에 없다 → 기존 사용자·창업자 개인 계정은 v2에서 체인 동작 불가 | 결정 4(데이터 이전 없음)대로. 무대·검증은 새 번호. 필요 시 개별 계정만 `reset-persons --phone` 후 재가입 |
| R7 | v1 `pendingGates/{account}`가 `registered`로 남아 같은 단말이 v2에서 승인 목록에 안 뜸 | 무대 단말은 브라우저 새 키(새 계정) 사용, 또는 전환 시 해당 문서 삭제 |
| R8 | 공유 스케줄러 경합(v1 `reconcilePending`이 v2 가입을 v1 Identity로 재전송) | 전환 시 v1 스케줄러 일시정지, 롤백 시 재개 |
| R9 | 트레저리 MON/USDC 부족 | 원자 실패로 바뀌어 "멈춤" 없음. 잔고 기준(§12) 사전 충전 |
| R10 | 결정 상충(데모 후 vs 데모 전) | 창업자 확인 — 블루/그린이라 어느 쪽이든 진행 가능 |
| R11 | Vercel promote는 재빌드다(바이트 동일 아님) | 운영 env를 스테이징과 같은 값으로 맞춘 뒤 빌드, 전환 직후 스모크 |

엣지케이스: 같은 nonce 동시 구매 → 같은 orderId(멱등) / 첫 구매 두 건 동시 → approve 2회(무해) / 시뮬 후 매진 → 온체인 revert, 트레저리가 가스만 부담, 주문 `failed` / 공개 영수증 타임아웃 → 웹은 `submittedRelayId`로 재개, 훅은 `reconcileRelays`가 재실행 / 금고 일시정지 중 유료 공개 → revert(행사 미생성) / 무료 행사에 정책 첨부 → `UnexpectedPolicy` / 정책 권한 없는 관리자(비트 64 없음)가 유료 공개 → `NotPolicyAuthorizer`.

---

## 16. 설계 질문 G — 컷 라인·병렬화

병렬화: 컨트랙트(C)·백엔드+인덱서(B)·웹+e2e(W) 3레인 + 운영(O). 레인 간 계약은 계획 §1(Solidity 시그니처·콜러블 모양·Firestore 모양·설정 키)을
착수 시점에 고정하고, 컨트랙트 레인이 04:00에 실제 ABI(`contracts/abi-delta-v2.md` + `packages/shared/src/abi/*.json`)를 동결해 B·W에 복사한다.
B·W는 그 전까지 ABI 무관 작업(요청·닉네임 콜러블, 초안 공개 화면·정산 규칙 편집기)을 하고, 이후 목(mock) 체인 단위 테스트로 통합한다.
로컬 anvil 통합 환경은 없으므로(§1) 통합은 forge 내 E2E(`V2Flow.t.sol`) → 테스트넷 신주소(rc1) → 스테이징 하니스 순서다.

순서(먼저 자르는 것부터): **P5 → P4 → P3 화면 다듬기.** P1(원자 결제)·P2(공개 1건·게이트 1건)·P3 최소 흐름(초안 → 정산 규칙 → 공개 1건)은 핵심 — P3 최소가 없으면 v2에서 행사를 공개할 방법이 없다. P4·P5를 잘라도 컨트랙트에서 해당 함수는 삭제되므로 각각 최소 조치(P4-min 15분, P5-min 30분)는 필수다.

---

## 17. 확인하지 못한 것(추측)

1. 같은 함수 이름을 다른 리전·다른 codebase로 배포할 때 Firebase CLI 동작(문서 미명시) → O1 탐침.
2. Envio 호스팅 배포 id가 커밋마다 바뀌는지(관찰상 `d6a478c` = 커밋 해시 형태) → 롤백 시 URL 재설정 전제로 계획.
3. 가스 수치(§14)는 기존 실측의 합성 추정.
4. 배포자 키 tx ~345건의 원인.
5. Vercel 플랜에 따른 Instant Rollback 대상 범위(직전 운영 배포만일 수 있음) → v1 운영 배포 URL을 기록하고, 판정 전 v2 운영 배포는 1회만.
6. anvil의 P-256(0x100) 지원 — 쓰지 않으므로 무관(forge 테스트는 `evm_version=osaka`로 이미 사용 중).
7. `us-east4`에서의 Cloud Scheduler(예약 함수) 생성 — 지원 리전으로 알고 있으나 미실측. O4 배포가 실패하면 즉시 드러나며, 그때는 B안-2.
8. Ticket이 `ITicket`에서 상속한 `ClaimAuth`를 테스트가 `Ticket.ClaimAuth`로 계속 참조할 수 있는지(상속 구조체의 한정 이름) — 컴파일이 거부하면 `ITicket.ClaimAuth`로 바꾼다.
