# MONTI 행사 만들기 SCENE — 설계와 구현 계획

**작성** 2026-09-22 · **마감** 2026-10-13 해커톤 · **범위** 주최자가 "행사 만들기"를 눌러 행사가 만들어지기까지.
**근거 코드** 컨트랙트 `MONTI-01b`(mvp-01b, 재배포 예정본) · 웹 `MONTI-web`(mvp-web 5dfe94b) · 백엔드 `MONTI-backend`(mvp-backend 05cda50).
**제품 규칙** 관객·주최자 화면 어디에도 지갑·가스·체인·NFT 말이 없다(티켓이라고만 한다) · 수수료는 MONTI가 낸다 · 운영비 0(Pinata 무료, Firestore).

> 지금 마법사는 6단계다(`organizer/Layout.tsx:21`, `Step1Basic~Step6Review`). 단계는 URL에 없고 `useState` 하나이며(`Layout.tsx:32`), 전체가 한 번도 한눈에 보이지 않는다. 창업자가 "UI 플로우가 보기 힘들어"라고 한 지점이 이것이다.

---

## 0. 결정 요약

| # | 결정 | 근거 한 줄 |
|---|---|---|
| 1 | **6단계 → 2씬.** 스크롤 1장(행사) + 스크롤 1장(티켓) + 완료 | Luma·Eventbrite 선례. 단계가 아니라 섹션이면 전체가 보인다 |
| 2 | 하단 고정 바 `저장됨 · 방금` / `다음` | 진행 표시와 저장 상태를 한 자리에 둔다 |
| 3 | 포스터는 **A4 세로(1:√2)**, 클라이언트 크롭 후 **즉시 업로드**, 초안에는 CID만 | Firestore 문서 상한 1 MiB. 600 KB JPEG의 base64는 800 KB라 초안에 못 담는다 |
| 4 | 비공개 장소는 **Firestore `eventPrivate/{eventId}` + 콜러블**, 비공개 시각은 **클라이언트 렌더 규칙** | 규칙 파일은 체인을 못 읽는다. 시각은 이미 체인에 있으니 저장소가 필요 없다 |
| 5 | 자동 저장은 **Firestore 초안 + localStorage 사본**, blur 2초·10분·`visibilitychange` | iOS Safari는 `beforeunload`를 신뢰할 수 없다 |
| 6 | 가격은 **무료만 생성 가능**. 통화 선택은 두되 무료가 아니면 그 자리에서 막는다 | `claim`이 `priceUsdCents != 0`을 전부 거절한다(`Ticket.sol:274`) |
| 7 | 티켓 그림은 **번들 SVG 4종 + Firestore `eventArt/{eventId}`**, 공개 뒤에도 수정 가능 | `Tier`에 그림 칸이 없고(`Ticket.sol:40-47`) `updateEventMeta`는 Draft에서만 된다(`:235`) |
| 8 | 입장한 티켓은 **원본 위에 흑백 + 빨간 "사용됨" 띠**. 원본은 그대로 둔다 | 인덱서 `Ticket.checkIn`만 보면 된다. 새 데이터 0 |
| 9 | 마지막 버튼은 `행사 만들기` = `createEvent` 하나. 상태는 **Draft**, 공개는 대시보드의 별도 버튼 | 창업자의 "거기까지 하면 행사가 만들어진다"와 정확히 같고, Draft 동안은 전부 고칠 수 있다 |

---

## A. 화면 구조

### A-1. 왜 2씬인가

Luma는 만들기 전체가 **스크롤 한 장**이다(왼쪽에 포스터 고정, 오른쪽에 제목·시간·장소·설명이 세로로 이어지고, 티켓은 그 안의 한 줄을 눌러 시트로 연다). Eventbrite는 **행사 정보 한 장 → 티켓 한 장**으로 딱 한 번 끊는다. 두 선례의 공통점은 "단계 번호가 없다"이고, 차이는 티켓을 어디에 두느냐다.

폰 한 손 조작에서는 **Eventbrite 쪽**이 맞다. 티켓 설정은 종류마다 같은 블록이 반복되는 목록형이라 위 섹션들과 리듬이 다르고, 둘을 한 스크롤에 이으면 폰에서 3화면을 넘어 하단 바의 `다음`이 가리킬 곳을 잃는다.

**버린 안**: (a) Luma식 완전 1페이지 — 위 이유. (b) 지금의 6단계 유지 + 진행 막대만 추가 — 되돌아갈 때 "그 칸이 몇 단계였지"를 사람이 기억해야 한다. 원인은 표시가 아니라 단계 자체다. (c) 아코디언 — 접힌 섹션은 "안 채운 것"과 구분이 안 돼 검토 단계가 다시 필요해진다.

### A-2. SCENE 1 — 행사 만들기 `/org/new`

상단에 **미리보기 카드**가 고정으로 붙는다. 이 카드가 곧 포스터 업로드 자리다 — 미리보기와 입력이 한 부품이라 "내가 만든 게 어떻게 보이나"가 항상 켜져 있다.

| 순서 | 섹션 | 입력 | 비어 있을 때 |
|---|---|---|---|
| — | 미리보기 카드 | A4 프레임. 비면 `포스터 올리기`, 채워지면 탭해서 다시 자르기 | 회색 A4 + 카메라 아이콘 |
| 1 | 제목 | 한 줄, ≤ 60자 | `무슨 행사인가요?` |
| 2 | 태그 | 테마 칩 4개 중 1개(필수) + 자유 태그 ≤ 5개(각 ≤ 12자) | 테마 미선택 |
| 3 | 소개 | 여러 줄, ≤ 2,000자 | `어떤 행사인지 알려주세요` |
| 4 | 장소 | 지역 드롭다운(17개, `wizard/regions.ts:7-24`) + 장소 한 줄(≤ 200자) + 공개 범위 칩 `모두에게` / `티켓 받은 사람에게만` | — |
| 5 | 시간 | 시작·종료 `datetime-local` 2칸 + 공개 범위 칩(같은 두 개) | — |

하단 고정 바: 왼쪽 `저장됨 · 방금`, 오른쪽 `다음`. `다음`은 언제나 눌린다 — 못 채운 칸이 있으면 그 섹션으로 스크롤하고 칸 밑에 한 줄을 띄운다(막지 않는다). 상단 좌측 `← 나가기`는 초안을 남기고 `/org`로 간다.

**빠진 것과 그 이유**: 조직 번호 칸(`Step1Basic.tsx:43`)은 없앤다 — `/org/new?org=<id>`가 이미 채워 주고(`Layout.tsx:36-43`, `:217-221`), 주최사가 하나면 물을 것도 없다. 신청 시작·종료(`Step4Rules.tsx:14-25`)도 없앤다 — 아래 B-1의 자동 유도. 게이트 이름(`Step5Staff.tsx`)은 지금도 아무것도 하지 않는 입력이라(`buildEventMeta.ts:43-47`) 행사 화면으로 옮긴다.

### A-3. SCENE 2 — 티켓 설정 `/org/new/tickets`

티켓 종류 카드가 세로로 쌓인다. 처음엔 1개, `종류 추가`로 최대 8개(`Ticket.sol:193`이 8 초과를 `InvalidTiers`로 거절).

**종류 카드 하나**: 그림(4종 중 선택, 탭하면 시트) · 이름 · 수량 · 1인당 한도(기본 1) · 가격(통화 칩 `무료`/`MON`/`USDT`/`USDC` + 금액).

**행사 전체 규칙**(카드 아래 한 묶음): `양도 가능` 토글 → 켜지면 `양도 마감`(행사 시작 N시간 전, 기본 2) 노출 · `본인 확인한 사람만` 토글.
→ 종류 카드 안에 두지 않는다. `transferable`·`transferCutoffSeconds`·`requireKyc`는 `EventMeta`에 있고 `Tier`에 없어(`Ticket.sol:21-47`) 종류마다 다르게 둘 수 없다. 카드 안에 두면 UI가 거짓말을 한다.

하단 바: `저장됨 · 방금` / `행사 만들기`.

### A-4. SCENE 3 — 완료 `/org/new/done`

포스터와 제목을 그대로 보여주고: `링크 복사` · **QR**(`qrcode` 1.5.4가 이미 있다, `apps/web/package.json:38`) · `공개하기`(→ 대시보드) · `대시보드로`.
`공개하기`까지는 **아무도 못 본다**는 한 줄을 반드시 둔다 — `createEvent`는 Draft로 만들고(`Ticket.sol:196`) `claim`은 Published가 아니면 거절한다(`:265`).

---

## B. 필드 → 저장소 지도

| 필드 | 씬 | 체인 `EventMeta`/`Tier` | 공개 IPFS JSON | Firestore | 만든 뒤 |
|---|---|---|---|---|---|
| 주최사 | 자동 | `orgId` | — | — | 불가 |
| 제목 | 1 | `titleHash` | `name` | 초안 | Draft만 |
| 소개 | 1 | `descHash` | `description` | 초안 | Draft만 |
| 포스터 | 1 | — (JSON의 CID가 `imageCid`) | `image: ipfs://<cid>` | 초안(CID) | Draft만 |
| 테마 | 1 | `category` (uint8) | `category` (number) | 초안 | Draft만 |
| 태그 | 1 | — | **`tags: string[]`** (신설) | 초안 | Draft만 |
| 지역 | 1 | `regionCode` (해시) | `region` (`KR-11`) | 초안 | Draft만 |
| 장소 · 공개 | 1 | `venueHash` | `venue` | 초안 | Draft만 |
| 장소 · 비공개 | 1 | `venueHash`(진짜 값의 해시) | **`venue` 키 없음** + `venueHidden: true` | **`eventPrivate/{eventId}.venue`** | **언제든** |
| 시작·종료 | 1 | `startsAt`/`endsAt` (**항상 진짜 값**) | 없음(원래 없었다) | 초안 | Draft만 |
| 시간 공개 범위 | 1 | — | **`timeHidden: bool`** (신설) | 초안 | Draft만 |
| 신청 기간 | 자동 | `saleStart = 만든 시각`, `saleEnd = endsAt` | — | — | 불가 |
| 티켓 이름 | 2 | `Tier.name` | — | — | Draft만 |
| 수량 | 2 | `Tier.supply` | — | — | Draft만 |
| 1인당 한도 | 2 | `Tier.maxPerWallet` | — | — | Draft만 |
| 가격 | 2 | `Tier.priceUsdCents = 0` **고정** | — | 초안만 | — |
| **티켓 그림** | 2 | — | — | **`eventArt/{eventId}.tiers[i]`** | **언제든** |
| 양도 가능 · 마감 | 2 | `transferable`, `transferCutoffSeconds` | — | — | Draft만 |
| 본인 확인 필수 | 2 | `requireKyc` | — | — | Draft만 |
| (화면에 없음) | — | `maxTransfers = 3`, `seated = false`, **`approvalRequired = false` 강제** | — | — | — |

**"Draft만"의 뜻**: `updateEventMeta`는 `_status != Draft`면 `NotDraft`로 거절한다(`Ticket.sol:235`). 부분 세터는 없다 — `Ticket.sol`의 외부 함수 전체에 `setMetadata` 류가 없다. 그래서 `publishEvent` 뒤 체인 필드는 **전부 동결**이고, 그때부터 바꿀 수 있는 것은 Firestore에 있는 두 가지(비공개 장소, 티켓 그림)뿐이다. 이 사실이 결정 7·9의 이유 전부다.

### B-1. 티켓 소지자만 공개 — 장소와 시간은 서로 다른 문제다

**시간: 저장소도 서버도 필요 없다.** 체인의 `startsAt/endsAt`는 **언제나 진짜 값**이어야 한다 — 입장 창(`Ticket.sol:419`, `:437`)과 `Ended` 파생(`:253-258`)이 그 값을 쓴다. 그런데 시각은 원래부터 IPFS JSON에 없었고 앱은 인덱서에서 읽는다(`EventDetail.tsx:84`). 그러니 `timeHidden: true` 하나면 끝이다 — 공개 화면은 **날짜만**(`10월 13일`), 티켓 보유자 화면은 체인 값 그대로 분까지. 보유 여부는 클라이언트가 이미 안다(인덱서 `Ticket(owner: me)`). **백엔드 0줄.**
> 정직하게: 체인은 공개 원장이라 이건 암호가 아니라 **앱의 표시 규칙**이다. 탐색기를 뒤지면 시각이 보인다. 제대로 숨기려면 체인에 진짜 시각을 못 올리는데, 그러면 입장 창이 깨진다. 이 맞바꿈은 하지 않는다.

**장소: 서버 판정이 필요하다.** 장소 문자열은 공개 JSON에서 **키째로 빠지고** 진짜 값은 `eventPrivate/{eventId}`에만 있다. 읽는 길은 콜러블 하나.

```
getEventPrivate({ eventId }) -> { venue }
  1) resolveCallerAccount(request)                      // lib/auth.ts
  2) balanceOfEvent(account, eventId) > 0  → 통과       // eventChat.ts:26-48 과 같은 검사
     아니면 eventOrg(eventId) + hasPermission(orgId, caller, PERM_CREATE_EVENT) → 통과 (주최자 본인)
     둘 다 아니면 permission-denied / NO_TICKET_FOR_EVENT
saveEventPrivate({ eventId, venue })  — 주최자 판정만. 언제든 덮어쓴다.
```

**왜 Firestore 규칙이 아니라 콜러블인가.** 규칙은 체인을 읽을 수 없다. 규칙만으로 하려면 `eventChats`처럼 `members/{uid}` 거울 문서가 필요한데(`firestore.rules:44-47`), 그 문서를 써 줄 "입장" 순간이 장소에는 없다 — 채팅은 사람이 **들어가는** 동작이 있지만 행사 페이지는 그냥 열린다. 거울을 채우려면 `claim` 훅이나 Tenderly 웹훅이 필요하고, 거울은 양도 뒤 낡는다. 콜러블은 매번 체인에 묻기 때문에 **양도하면 다음 호출부터 바로 막힌다.**

**창업자 안(공개 메타데이터에 암호문) 평가 — 나란히**

*먼저 해시는 탈락이다.* `keccak256`은 단방향이라 되돌려 보여줄 수 없다. 다만 `venueHash`는 **이미 진짜 장소의 해시로 올라가고**(`buildEventMeta.ts:159-163`) 계속 그렇게 둘 것이다 — 해시가 할 수 있는 단 하나, "주최자가 처음 약속한 장소와 우리가 보여준 장소가 같다"를 증명한다. 창업자 아이디어의 쓸모 있는 절반은 이미 배포돼 있다.

|  | **Firestore 비공개 문서 (추천)** | 공개 JSON에 암호문 |
|---|---|---|
| 새 코드 | 콜러블 2개 ~70줄. 규칙 0줄(포괄 거부가 이미 막는다) | 같은 콜러블 2개 **+** KMS 키 + 암·복호 ~60줄 |
| 인가 판정 | 체인 `balanceOfEvent` 1회 | **똑같이 필요하다.** 없앨 수 없다 |
| 키 관리 | 없음 | 키 생성·권한·회전. 키가 새면 **과거 모든 행사가 소급 노출** |
| 양도 뒤 회수 | 된다 | **안 된다.** 한 번 푼 사람은 영구히 안다 |
| 공개 뒤 수정 | 된다(문서 한 줄) | **안 된다.** 암호문이 JSON에 있고 그 CID는 `publishEvent` 뒤 동결(`Ticket.sol:235`) |
| 얻는 것 | — | 이식성: MONTI가 사라져도 키를 아는 사람은 읽는다 |

암호화는 서버 판정을 **없애지 못하고 그 위에 키 관리를 얹는다.** 게다가 공개 뒤 장소를 못 고친다 — 기능이 하나 줄어든다. 이식성은 해커톤에서 값이 없다. → **Firestore + 콜러블.** 이식성이 필요해지는 날 `venueEnc`를 JSON에 **거울로** 더하고 콜러블이 평문 대신 키를 돌려주면 된다(P2, 게이트는 그대로).

**공개 화면이 대신 보여주는 것**
- 장소: `서울 · 장소는 티켓을 받으면 알려드려요` — 지역은 `regionCode`에서 오므로 늘 공개다. 비공개 장소의 **공개 대역**이 지역이다.
- 시간: `10월 13일 · 시작 시각은 티켓을 받으면 알려드려요`
- 보유자 화면: 진짜 값 + 작은 배지 `나만 보여요`

### B-2. 태그

공개 JSON에 `tags: string[]`. 클라이언트·서버 양쪽에서 같은 규칙: trim → 앞의 `#` 제거 → 빈 값·중복 제거 → 각 ≤ 12자 → 최대 5개. 체인은 안 건드린다.
탐색 카드에 최대 2개, 상세에 전부. **태그로 거르지는 않는다** — 인덱서는 JSON을 읽지 않아(`schema.graphql`의 `Event`에 태그 칸이 없다) 태그 필터는 모든 행사의 IPFS를 받아와야 한다. MVP 밖.

### B-3. 가격 — 오늘 체인이 할 수 있는 것

- `Tier.priceUsdCents`는 **USD 센트**다(`Ticket.sol:42`). 토큰 수량도 wei도 아니다.
- `claim`은 **`payable`이 아니다**(`Ticket.sol:261`). 네이티브 MON을 애초에 받을 수 없다.
- `if (t.priceUsdCents != 0 || voucher.length != 0) revert PaidTiersNotEnabled();`(`:274`) — 값이 0이 아닌 종류는 **누구도 티켓을 받을 수 없다.** ERC-20은 `Ticket.sol` 어디에도 없다.
- 즉 **오늘 강제되는 것은 무료뿐**이고 통화·금액은 전부 표시용이다. 가스는 `claim`이 대납 목록에 있어 MONTI가 낸다(`MontiPaymaster.sol:388`).

**MVP 결정: 통화 칩은 두되, 무료가 아니면 그 자리에서 막는다.**
`무료` / `MON` / `USDT` / `USDC` 중 무료가 아닌 것을 고르는 **즉시** 카드 안에 `유료 티켓은 곧 열려요. 지금은 무료로만 만들 수 있어요.`가 뜨고 `행사 만들기`가 잠긴다(사유를 그 카드에 붙인다).
→ 제안 (b)"보여주되 claim만 막기"를 버린 이유: 아무도 티켓을 못 받는 행사가 탐색 목록에 올라간다. 게다가 공개 뒤에는 `updateEventMeta`가 안 되므로(`Ticket.sol:235`) 그 행사는 **영구히 죽는다.** UI 선택이 아니라 함정이다.
→ (a)"발행 때 막기"보다 이른 시점에 막는 이유: 종류를 다 채우고 마지막에 거절당하는 게 제일 나쁘다.
→ 금액·통화는 초안에만 남고 공개 JSON에는 **안 넣는다.** 받을 수 없는 가격을 관객에게 적는 일이 없다.
> `MON`은 체인 토큰 이름이라 **주최자 화면에만** 쓴다. 관객 화면에 통화가 나가는 날의 기본 표기는 원화다.

**진짜 결제로 가는 가장 짧은 길 — 세 갈래**
1. **어테스터 바우처(권장).** 컨트랙트가 이미 그 자리를 비워 뒀다(`Ticket.sol:259-260`의 주석과 `voucher` 인자). 결제는 평범한 결제 수단에서 일어나고, 서버가 확인한 뒤 어테스터가 `sig(personId, eventId, tier, nonce, expiry)`를 서명하면 `claim`이 그걸 검증하고 발행한다. 컨트랙트 범위: `:274`의 거절을 서명 검증 + nonce 맵으로 교체(~40줄, 재배포 1회). **지갑도, approve도, 토큰 보유도 없다 — 제품 규칙을 그대로 지킨다.**
2. **네이티브 MON.** `claim`을 `payable`로. 사용자가 MON을 들고 있어야 하니 온램프가 생기고 → 지갑 화면이 생긴다(규칙 위반). 페이마스터는 **가스**를 대납하지 **금액**을 대납하지 않는다. USD 표기를 유지하려면 가격 피드도 필요하다.
3. **ERC-20 USDC/USDT.** `approve` 단계는 **숨길 수 있다** — 모든 계정이 ERC-4337 스마트 계정이라 `[approve, claim]`을 한 userOp 배치로 보내면 된다. 하지만 토큰을 **들고 있어야** 하는 벽은 2번과 같다. 그리고 Monad 테스트넷(10143)에 정식 USDC/USDT가 있는지는 **확인하지 못했다(추측 금지)**. 더 근본적으로 **테스트넷 결제는 어차피 가짜다** — 데모 가치가 1번과 같은데 일이 10배다.
→ 결론: 해커톤에는 1번을 목표로 두고, 이번엔 무료만. `priceUsdCents`가 USD 한 종류만 표현할 수 있다는 한계도 1번에서는 문제가 아니다(체인은 통화를 알 필요가 없다).

### B-4. 티켓 그림 — 기본 4종, 나중에 수정, 그리고 "사용됨"

**어디에 두나.** `Tier`에 그림 칸이 없다(`Ticket.sol:40-47`). 남는 곳은 IPFS JSON 아니면 Firestore인데, JSON은 CID가 `EventMeta.imageCid`에 박히고 `updateEventMeta`가 Draft에서만 되므로 **공개 뒤 수정 불가**다. 창업자 요구가 "나중에 수정 가능"이니 → **Firestore `eventArt/{eventId}`**, 누구나(로그인) 읽고 서버만 쓴다. `orgProfiles`와 같은 모양이다(`firestore.rules:88-92`, `lib/db.ts`의 `ORG_PROFILES`).

```
eventArt/{eventId} = { tiers: [ { design: 'aurora' } | { imageCid: 'baf…' }, … ], updatedAt }
saveEventArt({ eventId, tiers })  — 주최자 판정(listAttendees.ts:51 과 같은 방식). 언제든 덮어쓴다.
```

**기본 4종은 번들 SVG 컴포넌트다.** `shared/ui/TicketArt.tsx`가 `design` 키 하나를 받아 그라데이션 + 행사 제목 + 종류 이름을 `<text>`로 얹는다. **핀도 CID도 업로드도 없다** — Firestore에 들어가는 값은 `'aurora'` 같은 10바이트다. 직접 올린 이미지는 같은 자리의 `imageCid`로 들어오고 같은 A4 크롭기를 쓴다(C절). 티켓 비율도 A4로 맞춘다 — 크롭 부품 하나, 테스트 하나면 된다.
> 지금 티켓 목록·상세에는 **그림이 아예 없다**(앱 전체에서 `<img>`는 `EventDetail.tsx:81` 하나뿐이다). 이건 없는 걸 고치는 게 아니라 없던 걸 더하는 일이고, 데모에서 가장 크게 보이는 변화다.

**사용됨 표시 — 데이터는 이미 있다.** 인덱서 `Ticket.checkIn`과 `Ticket.revoked`로 상태가 바로 나온다(`schema.graphql`의 `type Ticket` 주석: `valid = not revoked and checkIn == null, used = checkIn != null`). 새 데이터 0, 새 콜러블 0. **P0.**
`TicketArt`가 `state: 'valid' | 'used' | 'revoked'`를 받는다. `used`면 **원본은 그대로 두고** 그 위에:
- 그림: `filter: grayscale(1) contrast(.9)`
- 띠: `position:absolute; left:-10%; right:-10%; top:46%; transform: rotate(-18deg); background:#d92d20; color:#fff; text-align:center; padding:.5rem 0; font-weight:700; letter-spacing:.3em` → `사용됨`
- `revoked`면 같은 흑백에 회색 띠 `취소됨`. `aria-label`에도 상태를 넣는다.
저장소의 원본 바이트·CID·JSON은 **하나도 바뀌지 않는다.** 붙이는 곳: 내 티켓 목록·티켓 상세·주최자 참석자 목록.

**외부 NFT 뷰어의 `tokenURI`는 손대지 않는다(해커톤 밖).** `tokenURI`는 정적 URI가 아니라 매 호출 온체인에서 조립되고 `상태` 특성은 **이미** `입장 전 → 입장 완료 → 취소됨`으로 살아 움직인다(`Ticket.sol:614-620`). 반영되지 않는 건 `"image"`뿐인데(`:639-641`) 그건 행사 단위 값 하나라 종류별·상태별로 갈라지지 않는다. 갈라지게 하려면 ① `Tier`에 CID 두 개를 얹거나(구조체 변경 → 재배포 + **페이마스터 셀렉터 문자열까지 같이 바뀐다**, `MontiPaymaster.sol:407-414`가 튜플 전체를 적고 있다) ② Solidity가 SVG를 직접 그리거나(주최자 업로드가 죽는다) ③ `image`를 우리 서버 주소로 돌려야 한다(컨트랙트가 `Ticket.sol:598-600`에서 스스로 한 "서버 없음" 약속을 깬다). MONTI 화면은 아무도 `tokenURI`를 읽지 않으므로(`EventDetail.tsx:45-54`) **P2로 기록만 한다.**
> 다만 `tokenURI`의 `image`가 **그림이 아니라 메타데이터 JSON의 CID**를 가리키는 건 사실상 버그다(`m.imageCid`는 JSON CID다 — `buildEventMeta.ts:141-145`). 고칠 수 있는 창은 **01b 배포 전까지뿐**이다. 소비자가 없으니 그대로 두기를 권하되, 이 결정이 배포와 함께 만료된다는 것은 남겨 둔다.

---

## C. 포스터 — A4 크롭

목표 **1240×1754**(A4 150dpi, 1:√2). JPEG q0.85로 굽고 600 KB를 넘으면 0.7/0.55/0.4로 내린다(`wizard/pinata.ts:33`의 `QUALITY_STEPS` 그대로). 지금의 `MAX_IMAGE_EDGE = 1600`(`:36`)은 세로 1754를 자르므로 **포스터 경로에서는 쓰지 않는다** — 크롭이 이미 치수를 확정한다.

**라이브러리 없이 ~120줄.** 저장소 어디에도 크롭 라이브러리가 없다(`apps/web/package.json` 전체와 `pnpm-lock.yaml`에 `crop` 0건). 새로 넣을 이유도 없다: A4 고정 프레임이면 자유 크롭이 아니라 **패닝 + 줌 하나**뿐이라 라이브러리 기능의 대부분이 죽는다.
- 프레임: 화면 폭 × √2 고정. 이미지는 `cover`로 채운다.
- 조작: Pointer Events 드래그 + `<input type="range">` 줌(1.0–3.0).
- 출력: `createImageBitmap` → `ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, 1240, 1754)` → `canvas.toBlob`.
- **핀치 대신 슬라이더**인 이유: 핀치는 포인터 두 개 추적 + iOS Safari 기본 확대 차단(`touch-action:none`)이 필요하고 jsdom에서 검증이 어렵다. 슬라이더는 모든 기기에서 되고 테스트가 값 하나다. 핀치는 P2.
- 카드 미리보기는 같은 원본을 `object-fit: cover`로 잘라 쓴다. 원본은 하나다.

**크롭 직후 곧바로 올린다.** 새 콜러블 `pinEventImage({ orgId, image:{base64,mime}, kind:'poster'|'ticket' }) -> { cid }`. 초안에는 CID만 남는다.
→ **왜 미룰 수 없나**: Firestore 문서 상한은 1 MiB다. 600 KB JPEG의 base64는 800 KB라 여유가 없고, 현재 상한인 2 MB(`organizer.ts:19`)면 base64 2.7 MB로 **확실히 넘는다**. 초안에 바이트를 담는 길 자체가 없다.

---

## D. 자동 저장

**`eventDrafts/{uid}/drafts/{draftId}`, 클라이언트가 직접 읽고 쓴다.** 2초 디바운스마다 콜러블을 부르면 비용도 지연도 나쁘다. 규칙은 `users/{uid}`(`firestore.rules:24-26`)와 같은 모양으로 본인 uid만 허용하고 문자열 길이 상한을 건다. 웹은 이미 `shared/api/firestore.ts` 한 곳으로만 Firestore를 쓰므로(`:9`의 "쓰기는 세 곳뿐"), 거기에 네 번째 쓰기로 추가한다.

| 언제 | 왜 |
|---|---|
| 칸에서 포커스가 빠진 뒤 2초 디바운스 | 타이핑 중에는 쓰지 않는다 |
| 10분 인터벌 | 창업자 요구. 한 칸을 오래 붙들고 있어도 남는다 |
| `visibilitychange → hidden`, `pagehide` | **iOS Safari는 `beforeunload`를 신뢰할 수 없다.** 실제 모바일에서 동작하는 건 이쪽이다 |
| `beforeunload` | 데스크톱 보조로만 |

- **즉시 사본은 `localStorage`**에 그대로 둔다(`useWizard.ts:5`의 `DRAFT_KEY`). 오프라인·로그인 만료 순간을 덮는다. Firestore는 기기 간 이어쓰기용이다.
- 표시: 하단 바 왼쪽 `저장됨 · 방금` / `저장 중…` / `저장 안 됨 · 다시 시도`. 상대 시각은 30초마다 갱신.
- 재개: 씬을 열 때 최신 초안이 있으면 **묻지 않고 이어쓴다.** 상단에 `이어서 쓰는 중 · 처음부터` 한 줄만. 모달로 묻는 건 한 번 더 누르게 만들 뿐이다.
- 이미지: CID만 들어가므로 초안 문서는 ~2 KB.
- 초안 수: 클라이언트가 5개로 유지하고 새로 만들 때 가장 오래된 것을 지운다(규칙으로는 셀 수 없다).
- 삭제: `createEvent`가 확정돼 로그에서 `eventId`를 읽은 **뒤에** 지운다. 실패하면 남겨 둔다 — 지워서 잃는 것보다 중복 하나가 낫다.

---

## E. 만들기 — 호출 순서, 대납, 오류

```
(포스터 CID는 이미 초안에 있다)
1. pinEventMetadata({ orgId, meta })            -> { metadataCid }   ※ 이미지가 아니라 imageCid 를 받도록 바뀐다
2. createEvent(EventMeta, Tier[])  대납 오퍼레이션 -> 로그에서 eventId  (shared/chain/createdEvent.ts)
3. saveEventArt({ eventId, tiers })
4. 장소 비공개면 saveEventPrivate({ eventId, venue })
5. 초안 삭제 -> 완료 화면
```

`usePublish.ts:76-99`의 `submittedOpHash` 재확인 로직은 **그대로 가져온다.** 시간 초과는 실패가 아니고, 두 번 보내면 행사가 두 개가 된다 — 이미 옳게 풀려 있다.

| 어디서 실패 | 화면 |
|---|---|
| 1 핀 | `지금은 저장할 수 없어요. 잠시 뒤 다시 시도해 주세요.` 버튼 유지, 초안 그대로 |
| 2 대납 거절(`isUnsponsored`) | 현재 문구 유지(`copy.ts:268-270`). **검증 오류처럼 보이면 안 된다** — 고칠 칸이 없다. `다시 시도` 하나만 |
| 2 시간 초과 | `만드는 중이에요.` + 해시 저장 + `화면을 나가도 돼요` |
| 2 `Unauthorized` | `이 주최사에서 행사를 만들 권한이 없어요` |
| 3·4 | **행사는 이미 있다.** 완료 화면으로 보내고 `장소 정보를 저장하지 못했어요 · 다시 저장` 한 줄. 대시보드에서도 재시도 가능 |

**대납 현황**: 01b의 페이마스터는 `createEvent`·`updateEventMeta`·`publishEvent`·`cancelEvent`를 모두 대납한다(`MONTI-01b/contracts/src/MontiPaymaster.sol:407-416`). 현재 `MONTI-prod` 소스에도 같은 줄이 있다(`:357-366`). 그런데 웹은 "01b 전에는 주최자 셀렉터가 하나도 없다"고 적어 두었다(`shared/chain/unsponsored.ts:5-9`). **둘 중 어느 쪽이 지금 배포된 바이트코드인지는 확인하지 못했다** — 배포 주소에서 `allowedSelector(createEvent…)`를 한 번 읽어 확정할 것. 어느 쪽이든 화면은 위 표대로 양쪽을 다 견딘다.

---

## F. 지금 마법사와의 차이

| # | 간극 | 파일 | 크기 | 우선 |
|---|---|---|---|---|
| E1 | **6단계가 흐름을 감춘다.** 단계가 URL에도 없다 | `Layout.tsx:28-80`, `Step1~6` | L | **P0** |
| E2 | **죽은 행사를 만드는 스위치가 화면에 있다.** `참가 승인제`를 켜면 `claim`이 전부 `ApprovalRequiredNotSupported`로 거절된다(`Ticket.sol:270`) | `Step4Rules.tsx:47-51` | S | **P0** |
| E3 | **초안이 이 기기 localStorage뿐이다**(`useWizard.ts:5`). 10분 저장 없음 | `useWizard.ts` | M | **P0** |
| E4 | **이미지가 base64로 초안에 들어간다**(`buildEventMeta.ts:18-26`). Firestore로 못 옮긴다. A4도 크롭도 없고 긴 변 1600 축소뿐(`pinata.ts:36`) | `pinata.ts`, `Step1Basic.tsx:52-59` | M | **P0** |
| E5 | **태그가 없다.** JSON에도 서버 검증에도 칸이 없다(`organizer.ts:128-140`) | `organizer.ts`, `ipfs.ts` | S | **P0** |
| E6 | **공개 범위 개념이 통째로 없다.** `venue`는 늘 공개 JSON에 들어간다(`organizer.ts:225`) | 신규 콜러블 2개, `EventDetail.tsx` | M | **P0** |
| E7 | **티켓 그림이 없다.** 앱 전체에 `<img>`가 하나뿐이다(`EventDetail.tsx:81`) | 신규 `TicketArt.tsx` | M | **P0** |
| E8 | **입장 여부가 티켓에 안 보인다.** 인덱서 `Ticket.checkIn`이 이미 있는데 안 쓴다 | `tickets/List.tsx`, `Detail.tsx` | S | **P0** |
| E9 | **가격 칸이 없고 왜 없는지 말하지 않는다.** 주최자의 첫 질문에 답이 없다 | `Step3Tiers.tsx` | S | **P0** |
| E10 | **날짜 칸이 4개다**(시작·종료·신청 시작·신청 종료). 폰에서 가장 실수가 잦다 | `Step2When.tsx`, `Step4Rules.tsx:14-25` | S | **P0** |
| E11 | **게이트 이름을 받지만 아무것도 하지 않는다**(`buildEventMeta.ts:43-47`) | `Step5Staff.tsx` | S | P1 |
| E12 | **조직 번호를 손으로 받는다**(`Step1Basic.tsx:43`) | `Step1Basic.tsx` | S | P1 |
| E13 | **만든 뒤 화면이 없다.** 공유 수단이 없다 | 신규 | S | **P0** |
| E14 | **주최자 문구는 금지어 린트 대상이 아니다**(`packages/shared/src/constants.ts:85-101`) | eslint 설정 | S | P1 |
| E15 | **`tokenURI`의 `image`가 JSON CID를 가리킨다**(`Ticket.sol:639-641`). 01b 배포 전까지만 고칠 수 있다 | `Ticket.sol` | S | P2 |

---

## G. 작업 목록

### 백엔드 (`MONTI-backend`)

**T-EV-B1 · 이미지 핀을 떼어낸다 (S, P0)**
`functions/src/functions/organizer.ts`에 `pinEventImage({ orgId, image:{base64,mime}, kind:'poster'|'ticket' }) -> { cid }`를 더한다. 인가·크기·MIME 검사는 지금 `requireImage`(`:63-86`)와 `requireOrgOrganizer`(`:155-180`)를 그대로 쓴다. 같은 파일의 `pinEventMetadata`는 `image` 대신 **`meta.imageCid`**(`CID_RE`로 검증)를 받고 `{ metadataCid }`만 돌려주도록 바꾼다 — 이미지 분기는 **지운다**(하위 호환 레이어를 만들지 않는다). 웹의 `wizard/pinata.ts:125-145`에 같은 이름의 래퍼가 있으니 그건 지우거나 이름을 바꿔 충돌을 없앤다.

**T-EV-B2 · 메타데이터 칸을 넓힌다 (S, P0)**
같은 파일 `requireMeta`(`:128-140`)에 `tags?: string[]`(≤5, 각 trim·`#` 제거 후 ≤12자, 중복 제거), `venueHidden?: boolean`, `timeHidden?: boolean`을 더한다. `name` ≤ 60자, `description` ≤ 2,000자 상한을 새로 건다(지금은 `description`에 길이 검사가 없다). `venueHidden`이 참이면 조립부(`:219-229`)에서 **`venue` 키를 넣지 않는다.** 웹의 `shared/envio/ipfs.ts:49-60` `normalizeMetadata`에 `tags`·두 플래그를 기본값과 함께 더한다.

**T-EV-B3 · 비공개 장소 (M, P0)**
`functions/src/functions/eventPrivate.ts` 신규. `saveEventPrivate({eventId, venue})`는 `Ticket.eventOrg` + `Organizers.hasPermission(PERM_CREATE_EVENT)`로 주최자를 확인하고(`listAttendees.ts:51`과 같은 방식), `getEventPrivate({eventId})`는 `balanceOfEvent(account, eventId) > 0`(`eventChat.ts:26-48`의 검사를 그대로) 또는 주최자면 `{ venue }`를 돌려준다. `lib/db.ts`의 `ALLOWED_COLLECTIONS`에 `eventPrivate`를 더한다(Task 31의 소스 스캔이 이 목록을 강제한다). `firestore.rules`는 **건드리지 않는다** — 포괄 거부(`match /{document=**}`)가 이미 클라이언트를 막고 서버만 닿는다.

**T-EV-B4 · 티켓 그림 문서 (S, P0)**
`saveEventArt({ eventId, tiers: [{design}|{imageCid}] })` 콜러블 + `ALLOWED_COLLECTIONS`에 `eventArt` 추가. `firestore.rules`에 `match /eventArt/{eventId} { allow read: if signedIn(); allow write: if false; }` — `orgProfiles`(`:88-92`)를 그대로 베낀다. 주최자 판정은 B3과 같은 함수를 공유한다. `design`은 4개 키 중 하나로, `imageCid`는 `CID_RE`로 좁힌다.

**T-EV-B5 · 초안 규칙 (S, P0)**
`firestore.rules`에 `match /eventDrafts/{uid}/drafts/{draftId}`를 더한다: `allow read, write, delete: if signedIn() && request.auth.uid == uid`. 필드 길이 상한(`title` ≤ 100, `description` ≤ 4000, `tags` 리스트 ≤ 5)을 `users/{uid}`(`:24-38`)와 같은 방식으로 건다. 서버는 이 컬렉션에 닿지 않으므로 `ALLOWED_COLLECTIONS`에는 넣지 않는다.

### 웹 (`MONTI-web/apps/web/src`)

**T-EV-W1 · A4 크롭기 (M, P0)**
`shared/ui/ImageCropper.tsx` 신규, ~120줄. C절 그대로: 1:√2 고정 프레임, Pointer Events 드래그 + range 줌, `drawImage`로 1240×1754 출력, `pinata.ts:33`의 품질 계단 재사용. 포스터와 티켓 그림이 **같은 부품**을 쓴다. `createImageBitmap`은 jsdom에 없으니 지금 `shrinkImage`가 하듯(`pinata.ts:70`) 주입 가능하게 만들어 테스트한다. 자른 결과는 곧바로 `api.pinEventImage`로 올리고 CID만 돌려준다.

**T-EV-W2 · 초안 훅 (M, P0)**
`organizer/scene/useEventDraft.ts` 신규. `shared/api/firestore.ts`에 초안 읽기·쓰기·삭제를 더하고(그 파일의 "쓰기는 세 곳뿐" 주석도 같이 고친다), D절의 네 가지 저장 시점과 `localStorage` 사본, `저장됨 · 방금` 상태를 한 훅으로 낸다. `useWizard.ts`의 `normalizeDraft`(`:52-76`) 타입 방어는 그대로 옮겨 온다 — 손으로 고친 문서가 들어와도 칸 하나만 잃는다.

**T-EV-W3 · SCENE 1 (L, P0)**
`organizer/scene/CreateEvent.tsx` + 섹션 부품들. A-2의 여섯 섹션, 상단 미리보기 카드, 하단 고정 바. **없는 부품을 같이 만든다**: `shared/ui`에는 시트·칩·토글·카드·고정 바가 없다(`shared/ui/index.ts:1-10`의 10개가 전부). 최소로 `StickyBar`, `Chip`, `Toggle` 세 개만 더하고 나머지는 기존 `Field`·`Button`·`Alert`로 짠다. 라우트는 `organizer/Layout.tsx:239`의 `new`를 이 화면으로 바꾼다.

**T-EV-W4 · SCENE 2 (M, P0)**
`organizer/scene/TicketSettings.tsx`, 라우트 `/org/new/tickets`. A-3 그대로. 통화 칩에서 무료가 아닌 것을 고르면 그 카드에 사유를 붙이고 `행사 만들기`를 잠근다(B-3). 8개 상한, 마지막 한 개는 지울 수 없음.

**T-EV-W5 · TicketArt (M, P0)**
`shared/ui/TicketArt.tsx`. `{ design, imageCid?, title, tierName, state }`를 받아 SVG 4종 중 하나(또는 올린 이미지)를 그리고, `state`가 `used`/`revoked`면 B-4의 흑백 + 띠를 얹는다. 원본은 건드리지 않는다. 4종 디자인은 순수 SVG 그라데이션 + `<text>`라 외부 자산이 0이다.

**T-EV-W6 · 만들기 경로 재작성 (M, P0)**
`organizer/scene/usePublish.ts`. E절의 5단계. `submittedOpHash` 로직(`wizard/usePublish.ts:76-99`)은 그대로 가져온다. `buildEventMeta`는 살리되 `approvalRequired: false`·`maxTransfers: 3`·`seated: false`를 **상수로 박고**, `saleStart = 지금`·`saleEnd = endsAt`로 유도한다(`Ticket.sol:194`의 `saleStart < saleEnd`를 항상 만족한다). 장소가 비공개여도 `venueHash`는 **진짜 장소**의 해시를 넣는다(`buildEventMeta.ts:159-163` 그대로).

**T-EV-W7 · 완료 화면 (S, P0)**
`organizer/scene/Created.tsx`. 포스터 + 링크 복사 + QR(`qrcode` 1.5.4, `package.json:38`) + `공개하기`(대시보드) + `아직 아무도 못 봐요` 한 줄.

**T-EV-W8 · 관객 쪽 비공개 렌더 (S, P0)**
`attendee/discover/EventDetail.tsx:84-91`. `timeHidden`이면 날짜만(`formatEventDay` 신설), `venueHidden`이면 지역 + `장소는 티켓을 받으면 알려드려요`. 보유자면 `api.getEventPrivate`로 실제 장소를 받아 지도 링크까지 그대로 그리고 `나만 보여요` 배지를 붙인다. 콜러블 콜드 스타트가 있으니 그 줄만 스켈레톤으로 둔다.

**T-EV-W9 · 티켓 화면에 상태 붙이기 (S, P0)**
`attendee/tickets/List.tsx`·`Detail.tsx`에서 인덱서의 `Ticket.checkIn`·`revoked`로 `state`를 계산해 `TicketArt`에 넘긴다. `eventArt/{eventId}`는 `shared/api/firestore.ts`에서 한 번 읽어 react-query로 캐시한다. 주최자 참석자 목록에도 같은 부품을 쓴다.

**T-EV-W10 · 죽은 길 삭제 (S, P1)** — `wizard/` 전체(`Step1~6`, `useWizard.ts`, `Layout.tsx:28-80`의 마법사 셸), `copy.ts`의 쓰이지 않게 된 `wizard.*` 키, `regions.ts`는 남긴다. 하위 호환 경로를 두지 않는다.
**T-EV-W11 · 탐색에 태그 칩 (S, P1)** — `Discover.tsx` 카드에 최대 2개, `EventDetail.tsx`에 전부. 필터는 만들지 않는다(B-2).
**T-EV-W12 · Draft 행사 수정 화면 (M, P1)** — 같은 씬을 `eventId`와 함께 열어 `updateEventMeta`로 보낸다. 공개 전에만 열린다(`Ticket.sol:235`).
**T-EV-W13 · 티켓 그림 직접 올리기 (S, P1)** — W1의 크롭기를 그대로 쓰고 `saveEventArt({tiers:[{imageCid}]})`로 보낸다. 공개 뒤에도 된다.
**T-EV-W14 · 금지어 린트 확장 (S, P1)** — `apps/web/src/organizer`를 `lint:copy` 대상에 넣는다. 기존 문구가 대량으로 걸릴 수 있으니 데모 뒤에 한다.
**T-EV-C1 · `tokenURI` 결정 (S, P2)** — B-4 마지막 문단. **01b 배포와 함께 만료되는 유일한 결정**이라 배포 전에 한 번은 답해야 한다. 권고는 "그대로 둔다".
**T-EV-B6 · 암호문 거울 (M, P2)** — 이식성이 필요해지면 B-1 표의 마지막 줄대로.

### 순서

`B1 → B2`(핀 경로 정리, 반나절) → `W1 → W2`(크롭·초안, 하루) → `W3 → W4`(두 씬, 하루 반) → `B4 → W5 → W9`(티켓 그림·사용됨, 하루) → `W6 → W7`(만들기·완료, 반나절) → `B3 → B5 → W8`(비공개 장소, 반나절).
**시간이 모자라면 `B3 + W8`을 함께 뺀다** — 장소가 항상 공개로 퇴화할 뿐 나머지는 그대로 선다. 그러면 P0이 12개가 된다.

**개수: P0 14 / P1 5 / P2 2.**
