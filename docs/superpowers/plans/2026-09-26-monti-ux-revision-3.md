# MONTI 웹 UX 3차 개정 — 창업자 피드백(2026-09-26) 반영

**작성** 2026-09-26 · **마감** 2026-10-13 해커톤 · **범위** 무료/유료 세그먼트 · 승인제(신청→승인) · 소개 필수 · 티켓 그림 캐러셀 · 애니메이션 프리셋 · "미리보기가 곧 폼" 에디터 · 토스식 모션·비주얼.
**근거 코드** 웹 `MONTI-web`(mvp-web 8a8fcd5) · 컨트랙트 `MONTI-prod/contracts`(mvp) · 인덱서 `MONTI-backend/indexer`(mvp-backend).
**제품 규칙** 관객·주최자 화면에 지갑·가스·체인·NFT 말이 없다 · 수수료는 MONTI가 낸다 · 무료 한도만 쓴다(Pinata·Firestore) · 폰 우선 360–430px · CSP상 외부 폰트·스크립트 금지(번들만) · `prefers-reduced-motion` 존중.
**선행 계획** `2026-09-22-monti-event-creation-scene.md` · `2026-09-24-monti-ux-revision-2.md` — 이 문서는 그 위에 얹는다.

---

## 0. 결정 요약

| # | 결정 | 근거 한 줄 |
|---|---|---|
| 1 | **무료 \| 유료** 세그먼트를 티어 카드 상단에 **항상** 노출. `더 설정하기` 접힘 제거 | 지금은 통화·한도·가격이 `<details open={paid}>` 안에 숨어 있다(`TierCard.tsx:110-143`) |
| 2 | **승인제 = 컨트랙트로 구현**(추천). `requestClaim → approveClaims/rejectClaims`. 오프체인 대체안은 기각 | Monad 한도 131,072B에 여유 ~104KB(`ContractSize.t.sol:28,38-39`), `requestOverride`/`manualOverride` 선례가 그대로 있다(`Ticket.sol:498-554`) |
| 3 | **유료는 UI만 완성, 발행은 계속 차단**(정직한 문구) | `claim` 이 `priceUsdCents != 0` 를 되돌린다(`Ticket.sol:274`) — 결제 경로는 v3 범위 밖 |
| 4 | 1인당 구매 한도는 **유료일 때만** 노출 + 툴팁, 기본 1 | 창업자: "유료를 선택하면 그제서야". 무료는 `maxPerWallet=1` 로 고정(어뷰징 방어, `useEventDraft.ts:58`) |
| 5 | **소개(설명) 항상 노출 + 최소 10자 + 카운터** | 지금은 씬 `더 설정하기` 안이고 선택값이다(`CreateEvent.tsx:333-347`, `draftRules.ts:112-113`) |
| 6 | 티켓 그림 = **가로 스냅 캐러셀 + 실제 미리보기 + 점 + 직접 올리기 타일** | 지금은 이름만 찍힌 텍스트 칩 줄이라 화면이 깨진다(`ArtPicker.tsx:54-68`) |
| 7 | 프리셋에 **CSS 키프레임 애니메이션**(transform/opacity, ≤2레이어, 화면밖 정지) | 라이브러리 없이 인라인 SVG에 `<style>` 주입, 리스트에선 정적 |
| 8 | 티켓 에디터 = **"미리보기가 곧 폼"** + 한 탭 프리셋 + 고급 아이콘 줄 | 항목이 많다는 불만 → 개수는 유지하되 편집 표면을 미리보기로 옮긴다(Toss/Luma/Apple Wallet 선례) |
| 9 | 모션 라이브러리 = **`motion`(framer-motion) LazyMotion+`m`+domAnimation, ~18KB gz** | 드래그 닫기·공유 레이아웃·AnimatePresence는 CSS로 손수 짜기가 더 복잡하다(원칙 6). 마이크로 인터랙션은 기존 CSS 토큰 유지 |

---

## A. 티켓 설정 재구성 (항목 1·3·4·5)

**A-1 · 세그먼트 컨트롤을 카드 상단에.** `TierCard.tsx:110` 의 `<details open={paid}>` 를 없앤다. 카드는 위에서부터: ①**무료 \| 유료** 세그먼트(항상), ②그림 캐러셀(§C), ③종류 이름·수량, ④분기 블록. 통화 칩 4개(`TierCard.tsx:121-130`)는 세그먼트가 대체 — `무료` = `currency:'free'`, `유료` = `MON`(기본). `EventDraftCurrency`(`firestore.ts:289`)·`amount`·`maxPerWallet` 필드는 그대로 쓴다.

**A-2 · 무료 → 승인 방식(§B).** `무료` 선택 시 세그먼트 아래에 **받는 방식** 2분기(창업자의 3단어를 다음처럼 정리): `선착순(바로 받기)` = `approvalRequired:false`(오늘의 `claim`) · `관리자 승인(신청 후)` = `approvalRequired:true`. 창업자의 "순차적으로 모두 승인 / 관리자가 선택 승인 / 전체 승인"에서 첫째는 `선착순`, 나머지 둘은 **승인제의 관리 화면 액션**(선택 승인·전체 승인·거절, §B-4)으로 매핑한다. `approvalRequired` 는 이벤트 단위(하나)라 첫 카드에만 그린다.

**A-3 · 유료 → 가격·통화·한도.** `유료` 선택 시에만: `금액`(`amount`) + 통화 칩(`MON/USDT/USDC`) + `1인당 구매 한도`(`maxPerWallet`, 기본 1) + **툴팁** 그리고 발행 차단 경고. 툴팁 문구(신규 `copy.tiers.limitTip`): `예매하는 본인도 1명으로 포함돼요. 가족·동행 표를 함께 사게 하려면 2 이상, 1인 1매로 막으려면 1로 두세요.` 발행 차단은 기존대로 — `Alert tone="warn"` 에 `paidBlocked`(`유료 티켓은 곧 열려요. 지금은 무료로만 만들 수 있어요`, `copy.ts:379`), `paidTiers`/`tierProblems`(`draftRules.ts:174,196`)·`blocked` 버튼 비활성(`CreateEvent.tsx:474`) 그대로.

**A-4 · 소개 항상 노출 + 최소 10자.** `CreateEvent.tsx:333-347` 의 소개 섹션을 `더 설정하기` 밖 독립 `<Card id="scene-body">` 로 올린다. 새 규칙 `MIN_BODY_CHARS = 10` 과 `EventProblem 'bodyTooShort'` 추가(`draftRules.ts:19-29,112-113`), `PROBLEM_SECTION.bodyTooShort='body'`. 카운터는 기존 `copy.count` 재사용, 문구 `bodyTooShort='소개를 10자 이상 적어 주세요'`. 서버는 빈 소개를 허용하므로(`organizer.ts:206-212`) 이는 클라이언트만의 더 엄격한 규칙 — 안전.

**A-5 · 드래프트/발행 배선.** `EventDraft`(`firestore.ts:308+`)에 `approvalRequired:boolean` 추가, 기본 `false`(`useEventDraft.ts:64`). `usePublish.ts:74` 의 상수 `APPROVAL_REQUIRED=false` 를 지우고 `:146` 를 `approvalRequired: draft.approvalRequired` 로. `buildEventMeta.ts:60` 은 이미 `draft.approvalRequired` 를 읽으므로 무변경. `buildTiers` 의 `priceUsdCents:0n`(`buildEventMeta.ts:70`)는 유지(유료 발행 차단이므로).

---

## B. 승인제 — 컨트랙트로 구현 (항목 2)

**결정: 컨트랙트 기능(추천). 오프체인 대체안 기각.**

**B-1 · 왜 컨트랙트인가.** 오프체인(파이어스토어) 승인은 **게이트가 성립하지 않는다**: 관객이 티켓을 받으려면 `approvalRequired:false` 여야 하는데(`claim` 이 `true` 면 `ApprovalRequiredNotSupported` 로 되돌림, `Ticket.sol:268`), 그러면 아무나 `claim` 을 직접 불러 파이어스토어 "승인"을 우회한다. 스폰서십으로만 막는 변형은 신원·가스 규칙은 지키지만 보안 규칙을 백엔드 스폰서 정책에 밀어넣고 자가 가스로 여전히 우회 가능해 장기적으로 더 나쁘다(원칙 8). 창업자가 재배포를 허용("업데이트마다 재배포")하고, 크기 여유가 크며(§B-5), 선례가 있어 **컨트랙트가 정직·강제 가능한 유일한 안**이다.

**B-2 · 컨트랙트 추가**(`Ticket.sol`, 선례 `requestOverride:498-514`/`manualOverride:523-554` 를 그대로 모방).
```solidity
struct ClaimRequest { uint256 eventId; address requester; uint8 tier; uint8 status; } // 0 pending·1 approved·2 rejected
event ClaimRequested(uint256 indexed requestId, uint256 indexed eventId, address indexed requester, uint8 tier);
event ClaimApproved (uint256 indexed requestId, uint256 indexed eventId, uint256 tokenId);
event ClaimRejected (uint256 indexed requestId, uint256 indexed eventId);
function requestClaim(uint256 eventId, uint8 tier) external returns (uint256 requestId); // Published·member·approvalRequired==true, (eventId,requester) 중복 방지, mint 없음
function approveClaims(uint256 eventId, uint256[] calldata requestIds) external; // PERM_APPROVE 보유자, 각 요청을 claim 내부(281-284 재사용)로 민팅, maxPerWallet/SoldOut 재검사
function rejectClaims (uint256 eventId, uint256[] calldata requestIds) external;
```
`claim` 의 `:268` 되돌림은 **유지**(승인제 이벤트는 직접 `claim` 불가 → 신청 경로 강제). `createEvent`/`publishEvent` 는 이미 `approvalRequired` 를 막지 않으므로(저장만, `:197`) 이벤트 생성·발행은 무변경. `Claimed`(`:133`)는 승인 민팅에서도 그대로 발생시켜 인덱서의 `Ticket` 행이 정상 생성되게 한다.

**B-3 · 페이마스터 허용 목록**(`MontiPaymaster.sol`, 재배포 불필요). 배포자가 `setAllowed(selector, kind, word)`(`:271-292`)로 3개 추가: `requestClaim(uint256,uint8)`→`ArgKind.EventId` word 0(`:388` `claim` 과 동일 규약), `approveClaims`/`rejectClaims`→**첫 인자를 스칼라 `uint256 eventId`(word 0)로 두고** `ArgKind.EventId`(동적 배열 뒤 워드는 오프셋이라 디코딩 불가 — `createEvent` 가 `Platform` 인 이유, `:407-410`). `Deploy.s.sol` 수정 없음(셀렉터는 페이마스터 생성자에서 씨딩, `Deploy.s.sol:24-26`).

**B-4 · 인덱서**(`schema.graphql`·`EventHandlers.ts`, GraphQL enum 없음 → status는 `String`).
```graphql
type ClaimRequest { id: ID! eventId: BigInt! @index tier: Int! requester: String! @index
  status: String! @index  requestedAt: BigInt!  resolvedAt: BigInt  txHash: String!  block: BigInt! }
```
`Ticket`(`:101-110`)·`CheckIn`(`:118-127`) 규약 모방. 핸들러 3개를 `EventHandlers.ts` Ticket 구역(`:234` 이후, `Claimed:482-498` 옆)에 추가: `ClaimRequested`→`status:'pending'`, `requestedAt=block.timestamp`, `txHash=event.transaction.hash`(감사행 선례 `OverrideRequested:604-614`); `ClaimApproved`/`ClaimRejected`→행을 `get()` 후 `status`·`resolvedAt` 패치(offer 패턴 `:667-682`). ABI에 이벤트 3개 추가(`packages/shared/src/abi/*.json`) → `pnpm indexer:config`(`config.yaml:39-52` 재생성) → Envio codegen → `test/ticket.test.ts` 케이스.

**B-5 · 크기·가스.** Ticket 런타임 ≈26,351B, Monad 한도 131,072B(`ContractSize.t.sol:28`) 대비 여유 ~104KB — 함수 3개·매핑·이벤트를 넣어도 테스트(`:38-39`)는 그대로 통과. (EIP-170 24,576B는 CI에서 미적용.) 신청 스팸은 `(eventId,requester)` 중복 방지 + 관객 1기기 1패스키로 억제, 스폰서 가스는 MONTI 부담(기존 정책).

**B-6 · 관객·주최자 화면.**
- 관객: `Claim.tsx:100-118` 를 `event.approvalRequired` 로 분기 — `false` 면 `claim`(현행), `true` 면 `ticketOp({functionName:'requestClaim', args:[BigInt(eventId), tier]})`. 상태 문구: `신청 완료`(pending)·`승인됐어요, 티켓이 발급됐어요`(approved→`/tickets`)·`이번엔 승인되지 않았어요`(rejected). `EventDetail.tsx:183` CTA 라벨을 승인제면 `신청하기`.
- 주최자: 신규 화면 `/org/events/:eventId/requests` **신청 관리** — `ClaimRequest`(status:pending) 목록을 인덱서에서 읽어 **선택 승인 / 전체 승인 / 거절** 버튼(`approveClaims`/`rejectClaims`). 권한은 `Manager.canApprove`(`schema.graphql:33`, `Team.tsx:313` 의 `grantCanApprove`)로 게이트. `Dashboard.tsx:150,215` 옆에 링크 `신청 관리`.

---

## C. 티켓 그림 캐러셀 (항목 5)

**C-1 · 가로 스냅 캐러셀.** `ArtPicker.tsx:50-77` 의 텍스트 칩 줄(`chip-row--art`, `theme.css:388-394`)을 **실제 미리보기 타일**로 교체. 각 타일 = `buildTicketSvg({preset, title, tierName})` 로 그린 축소 티켓(§E 재사용). `scroll-snap-type:x mandatory`, 각 타일 `scroll-snap-align:center`, 뷰포트를 넘는 것 없음(`overflow-x:auto` 한 줄). 마지막 타일 = **직접 올리기**(현행 `A4Cropper` 유지, `ArtPicker.tsx:69-74`).

**C-2 · 큰 미리보기 + 점.** 캐러셀 위 한 장 큰 미리보기(현 `tier-card__art`, `TierCard.tsx:70-78`)는 캐러셀 선택을 그대로 반영. 아래 **점 인디케이터** — `IntersectionObserver` 로 중앙 타일을 감지해 현재 점 활성. 이름 라벨(`오로라·잉걸…`, `copy.ts:371-374`)은 타일 캡션으로 축소 유지. `onPreset`/`onUploaded` 콜백 계약(`ArtPicker.tsx:20-22`) 무변경.

---

## D. 애니메이션 프리셋 (항목 6)

**D-1 · 어떻게.** `presets.ts:36`(`TICKET_BACKDROPS`)의 각 백드롭에 선택 필드 `anim?:string`(CSS 키프레임+규칙, id는 `ta-<letter>-*` 접두). `buildTicketSvg`(`:222-298`)에 `animated?:boolean` 입력 — 참이고 `backdrop.anim` 있으면 `<defs>`(`:252-258`) 뒤에 `<style>${backdrop.anim}</style>` 주입. **transform/opacity만**, 프리셋당 **≤2 레이어**. 예: `a 오로라`(veil `translateX` 표류)·`c 청록`(rings `scale` 맥동)·`g 물결`(waves `translateX`)·`e 네온`(shimmer opacity)·`i 안개`(drift)·`k 점묘`(particles).

**D-2 · 정지·접근성.** `TicketArt.tsx:52-75` 를 `IntersectionObserver` 로 감싸 화면 밖이면 `.ticket-art` 에 `animation-play-state:paused` 클래스. `prefers-reduced-motion` 은 기존 전역 킬스위치(`theme.css:686`, `*` 셀렉터라 SVG DOM에도 적용)가 잡는다 — SMIL 대신 **CSS 키프레임**을 쓰는 이유. **리스트/썸네일은 `animated=false`**(정적), 큰 미리보기·상세만 애니메이션.

---

## E. "미리보기가 곧 폼" 에디터 (항목 7)

**E-1 · 미리보기의 탭 영역이 폼.** 큰 티켓 미리보기(`buildTicketSvg`, 1000×1600) 위에 투명 히트 영역을 얹어 각 부분을 직접 편집: 제목 영역(`TITLE_BASELINE` 부근, `buildTicketSvg.ts:45`) 탭 → 제목 인풋 포커스, 그림 탭 → §C 캐러셀 시트, 종류 이름(`TIER_GAP`, `:50`) 탭 → 이름 인풋, 스텁(`PERFORATION_Y`, `:63`) 탭 → 날짜/설정. 항목 수는 그대로, **편집 표면만** 미리보기로 이동. 선례: **Apple Wallet**(패스 자체가 편집면), **Luma**(이벤트 카드 인라인 편집), **Toss**(카드가 곧 컨트롤).

**E-2 · 한 탭 프리셋 + 제로탭 유효 기본값.** 카드 맨 위 **빠른 시작** 세그먼트: `무료 선착순` / `무료 관리자 승인` / `유료 일반` — 각 탭이 `currency`·`approvalRequired`·`maxPerWallet`·`amount` 를 한 번에 세팅. 기본 드래프트(`emptyEventDraftTier`, `useEventDraft.ts:57-60`)가 이미 유효(무료 선착순·수량 100·한도 1·이름 `일반`)하므로 아무 것도 안 만져도 발행 가능.

**E-3 · 고급은 아이콘 한 줄.** `TicketExtras`(`TicketSection.tsx:82-122`)의 양도·양도 마감·본인 확인을 **아이콘 토글 한 줄**로 접어 카드 하단에. `requireKycHelp`(`copy.ts:387`) 등 기존 문구·필드(`EventMeta` 소속, `buildEventMeta.ts:57-63`) 재사용.

---

## F. 모션 + 비주얼 언어 (항목 8)

**F-1 · 라이브러리 결정 = `motion`(framer-motion).** `LazyMotion` + `m` + `domAnimation`(~18KB gz)로 트리셰이크. CSP는 번들 의존성엔 무관(런타임 외부 fetch 없음). `useReducedMotion()` + 전역 CSS 킬스위치(`theme.css:686`)로 접근성. 마이크로 인터랙션(눌림 `scale`·글래스)은 기존 토큰 유지(`theme.css:98-100` `--ease/--fast/--slow`, `:250-264`). 드래그 닫기·`layoutId` 공유 레이아웃·`AnimatePresence` 는 손수 짜기보다 라이브러리가 단순·안정(원칙 6). 팔레트는 이미 보라(Monad `#836EF9`, `theme.css:18`) — 신규 색 없이 **투명도·모션**으로 "센세이션"을 만든다.

**F-2 · 스프링 토큰.** `--spring-snappy`(stiffness 520, damping 30, mass 1) 버튼·칩 · `--spring-smooth`(300/34) 시트·페이지 · `--spring-bouncy`(420/22) 성공 모프. `motion` 설정으로도 동일 수치 공유.

**F-3 · 컴포넌트별 모션 인벤토리.**

| 컴포넌트(파일) | 모션 | 감소모드 |
|---|---|---|
| 페이지 전환(라우터) | `AnimatePresence` 슬라이드/페이드(smooth) | 즉시 교체 |
| 버튼·칩(`Button.tsx`·`Chip.tsx`) | 눌림 `scale`(snappy) — 기존 `:active` 확장(`theme.css:264,407`) | 없음 |
| 시트(`Sheet.tsx`) | 상승 + **드래그로 닫기** `drag="y"`(현재 `dialog open`, 드래그 없음 `:16-18`) | 상승만/버튼 |
| 리스트(탐색·티켓·신청 관리) | 진입 stagger(smooth) | 즉시 |
| 스켈레톤 | 로딩 시 shimmer(현재 `Spinner`만, `theme.css:437`) | 정적 회색 |
| 숫자(잔여 수량·신청 수) | number ticker(`useSpring`) | 최종값 |
| 성공(발행·승인) | 체크 모프(bouncy) | 정적 체크 |
| FAB→화면(`Fab.tsx`) | `layoutId` 공유 레이아웃 전환 | 즉시 |
| 탭 인디케이터(`BottomTabs.tsx`) | 활성 밑줄 `layoutId` 슬라이드 | 즉시 색 전환 |

**F-4 · 비주얼.** 포인트 = `--brand-ink`/`--brand-grad`(`theme.css:19,27`), 표면은 글래스(`--glass-bg` 0.62, `:51`) 투명도 강화, 타이포 리듬은 기존 스케일 유지(title22/head17/body15, `theme.css:76-83`) — 색·크기 신설 없이 **모든 액션 animated**로 토스 감성.

---

## G. 작업 목록 (T-UX3-n)

선행(컨트랙트·인덱서) → 웹 순.

| ID | 크기 | 우선 | 작업 · 한 문단 브리프 |
|---|---|---|---|
| **T-UX3-1** | L | P0 | **컨트랙트 승인제.** `requestClaim`/`approveClaims`/`rejectClaims` + `ClaimRequest` 저장 + 이벤트 3개. `requestOverride`/`manualOverride`(`Ticket.sol:498-554`)·`claim` 내부 민팅(`:281-284`) 재사용, `claim:268` 되돌림 유지, `(eventId,requester)` 중복 방지·`approveClaims` 에서 `maxPerWallet`/`SoldOut` 재검사. Foundry 테스트. |
| **T-UX3-2** | S | P0 | **페이마스터·ABI.** `setAllowed` 로 셀렉터 3개 등록(§B-3, `MontiPaymaster.sol:271`), `packages/shared/src/abi` 이벤트/함수 추가, 웹 `shared/chain/abis.ts`·`UsedFunction` 확장. |
| **T-UX3-3** | S | P0 | **재배포.** 새 컨트랙트 배포 + `deployments/*.json` 갱신 + `ContractSize.t.sol` 그린 확인. |
| **T-UX3-4** | M | P0 | **인덱서.** `ClaimRequest` 엔티티(`schema.graphql`) + 핸들러 3개(`EventHandlers.ts:234` 이후) + `pnpm indexer:config` + codegen + `test/ticket.test.ts`. |
| **T-UX3-5** | S | P0 | **웹 쿼리.** `ClaimRequest` GraphQL 쿼리(`shared/envio/queries.ts`) + 이벤트별 pending 목록·관객 내 신청 상태. |
| **T-UX3-6** | M | P0 | **티어 카드 재구성(§A).** `TierCard.tsx` 의 `<details>` 제거, `무료\|유료` 세그먼트 상단 고정, 유료→가격·통화·한도+툴팁, 무료→받는 방식 2분기. `EventDraft.approvalRequired` 추가, `usePublish.ts:74,146` 배선, 발행 차단 유지. |
| **T-UX3-7** | S | P0 | **소개 필수(§A-4).** 소개를 `더 설정하기` 밖으로, `MIN_BODY_CHARS=10`·`bodyTooShort`·카운터(`draftRules.ts`·`CreateEvent.tsx`·`copy.ts`). |
| **T-UX3-8** | M | P0 | **그림 캐러셀(§C).** `ArtPicker.tsx` 를 실제 미리보기 스냅 캐러셀 + 점 + 직접 올리기 타일로 교체, 콜백 계약 유지. |
| **T-UX3-9** | M | P0 | **관객 신청 흐름(§B-6).** `Claim.tsx`·`EventDetail.tsx` 를 `approvalRequired` 분기, `requestClaim` 호출, 신청 완료/승인됨/거절됨 상태. |
| **T-UX3-10** | M | P0 | **주최자 신청 관리(§B-6).** `/org/events/:eventId/requests` 화면 — 목록·선택/전체 승인·거절, `canApprove` 게이트, `Dashboard` 링크. |
| **T-UX3-11** | M | P1 | **애니메이션 프리셋(§D).** `presets.ts` `anim` + `buildTicketSvg` `<style>` 주입 + `IntersectionObserver` 정지 + 감소모드 + 리스트 정적. |
| **T-UX3-12** | M | P1 | **모션 기반(§F).** `motion` 도입 + `MotionConfig`/`useReducedMotion` + 스프링 토큰 + 페이지 전환 + 눌림 인터랙션. |
| **T-UX3-13** | M | P1 | **시트·리스트(§F).** `Sheet` 드래그 닫기 + 리스트 stagger + 스켈레톤 shimmer. |
| **T-UX3-14** | L | P1 | **미리보기=폼 에디터(§E).** 탭 영역 편집 + 빠른 시작 프리셋 + 고급 아이콘 줄. |
| **T-UX3-15** | S | P2 | **모션 마감(§F).** number ticker + 성공 모프 + FAB→화면 공유 레이아웃 + 탭 인디케이터. |
| **T-UX3-16** | S | P2 | **비주얼 폴리시(§F-4).** 보라 포인트·투명도·타이포 리듬 감사 및 정리. |

**순서** T-UX3-1→2→3→4→5(체인 준비) → 6·7·8(티어·소개·그림, 병렬 가능) → 9·10(승인 UX) → 11·12·13·14(애니메이션·모션·에디터) → 15·16(마감). **개수: P0 10 / P1 4 / P2 2 · 합계 16.**
