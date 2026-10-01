# MONTI 프로그래머블 정산·수익분배 — 설계 (2026-10-01)

상태: 설계안(코드 변경 없음, 배포 없음, 커밋 없음). 현행은 Phase 2 라이브(릴레이된 일반 tx,
MontiForwarder ERC-2771 P-256, relayAction, 릴레이어 EOA 단일 지불처, 4337·페이마스터 폐기).
이 문서는 **"왜 블록체인인가 = 프로그래머블 정산"** 을 추가하는 새 레이어의 설계다: 행사별 수익분배
정책 + 입금(에스크로) + 입장 시 자동 분배 + 노쇼/환불 규칙 + 공개 정산 장부.

근거 파일(현행, MONTI-prod HEAD 031cfb5+): `contracts/src/Ticket.sol`(Tier.priceUsdCents,
`_claimTo` 가 가격≠0 이면 `PaidTiersNotEnabled` revert — 온체인 유료 티켓 미구현; `usedAt(tokenId)
public view`(0=미입장), `eventOf`/`eventOrg`/`eventStatus`, `Claimed`/`CheckedIn`), `Organizers.sol`
(orgId·owner/admin/manager, `hasPermission` 비트마스크 — 소유자는 전 비트 보유; PERM 1/2/4/8/16,
Ticket 이 32 사용 → 다음 빈 비트 64), `MontiForwarder.sol`(self-verify P-256 패턴·`setTargets` 1회
고정), 비용 실측 `.superpowers/sdd/2026-09-22-monti-01b-redeploy-bundle/task-phase2-f1-f2-report.md`
(Run 3: createEvent 0.0475 / publish 0.0175 / claim 0.0247 / request 0.0223 / approve 0.019·장 /
check-in 0.0175 MON; 100명 ≈ 4.32 MON ≈ ₩173 @ MON≈₩40), Phase 1/2 설계
(`2026-09-28-monti-relayed-actions-design.md`, `2026-09-29-monti-relayed-phase2-design.md`).

선례(새로 발명하지 않음): **0xSplits**(불변/가변 split, push vs pull, bps 지분), **Superfluid**
(스트림 — 과잉), **Stripe Connect / 토스페이먼츠 지급대행·정산대행**(라이선스 집행자, D+1),
**Eventbrite payouts**(행사 후 지급), 에스크로(배송=입장 시 해제), **ERC-20 permit/transfer**,
**Circle USDC**(Monad 테스트넷 10143 공식 테스트 USDC `0x534b2f3A21130d7a60830c2Df862319e593943A3`,
6 decimals, Circle faucet — 데모는 이 실물 테스트 USDC, 주소는 설정 가능(토큰 허용목록)).

---

## 0. 창업자용 한국어 요약 (비개발자, ≤20줄)

- **무엇을 하나.** 행사마다 "정산 정책"(누가 몇 %를, 무슨 명목(사유)·태그로 받는지)을 주최자가
  **공개 전에** 정합니다. 관객이 낸 돈은 행사용 금고(에스크로)에 잠겨 있다가, 관객이 **실제로
  입장(NFC 태그)하면 그 티켓 몫이 ~1초 안에 스테이블코인으로 자동 분배**되고, 안 온 사람(노쇼)
  몫은 **행사가 끝날 때** 정산됩니다. 누구나 보는 "정산 현황" 페이지가 사유·태그·금액을 투명하게
  보여줍니다. 이것이 "왜 블록체인인가"의 핵심 — 분배 규칙과 기록을 아무도 조작 못 하게 공개합니다.
- **데모(10-13).** 공연 1건, 이해관계자 4명(아티스트 60%·공연장 20%·기획 15%·MONTI 5%). 관객이
  카드(목업)로 결제 → 금고에 테스트 USDC 예치 → 입장 태그 → 4명 잔액이 즉시 늘고 정산 현황
  페이지에 사유와 함께 표시. 노쇼 1명은 종료 시 정산, 환불 1명은 행사 전 환불. 돈의 움직임은
  **Monad 테스트넷에서 진짜 테스트 USDC 로 실제 실행**(카드 화면만 목업).
- **가스비 누가 내나(창업자 질문 답).** 유료 행사는 **(b) MONTI 가 수수료에서 가스를 대납**하세요.
  근거: 티켓당 가스(발급+입장+예치+분배) ≈ **0.075 MON ≈ ₩3**, 수수료 **5%+₩500 ≈ ₩2,000**(₩3만
  티켓). 수수료가 가스를 **약 650배** 덮습니다. 주최자가 MON 을 들 필요 없음(방식 (a) 주최자 지갑
  가스는 web3 노출·복잡도로 기각). 무료 행사는 지금처럼 MONTI 소액 보조(100명 ≈ ₩170).
- **비용.** 100명 유료 행사: 지금 ≈ 4.32 MON + 정산(예치·분배) ≈ 3.2 MON = **약 7.5 MON ≈ ₩300**
  (즉시분배). "입장 땐 장부만 적고 종료 때 한 번에 송금"하면 ≈ **6.0 MON(₩240)**. 어느 쪽이든
  수수료(₩20만/100명)가 압도 → 비용은 제약이 아님.
- **컴플라이언스(중요).** 한국 원화 스테이블코인 법(디지털자산기본법)은 **2026-09 를 넘겼고** 국회
  논의 **11월경**, 은행 **51% 규칙도 미정** → 당분간 원화 스테이블 온체인 정산 불가. 그래서 **한국
  상용은 라이선스 PG(토스 등)·정산대행이 실제 돈을 집행**하고 MONTI 는 **정산 규칙·장부(온체인=유일
  진실원본)만 제공·지시**합니다 — 고객 돈을 직접 보관·이체하지 않아 **전자금융업 등록 없이** 운영
  (법률 자문 확인 필요). 온체인 USDC 분배는 데모/테스트넷용이고, 원화 스테이블이 합법화되면 토큰
  허용목록에 추가해 **같은 금고로 온체인 정산** 가능.
- **구현 범위(핵심 단순화).** 핵심 4개 컨트랙트(Ticket/Organizers/Identity/Forwarder) **변경 없음** —
  새 컨트랙트 **SettlementVault 1개만** 추가. 금고가 Ticket 의 `usedAt`(입장 사실)을 **읽어** 분배하므로
  **입장이 정산 때문에 실패할 일이 없습니다.** 토큰은 Circle 공식 테스트 USDC(주소 설정 가능).
- **가장 큰 위험.** ① 수취인 중 하나가 USDC 블랙리스트면 전체가 막힘 → 수취인별 "보류 후 개별
  인출" 폴백. ② 노쇼 몫 정산 vs 환불은 사업·법률 판단(소비자분쟁해결기준) → 확정 필요. ③ 전자금융업
  법률 자문 사전 확인.
- **일정 감각.** 금고+테스트 → 백엔드 트레저리/정산 콜러블+장부 → 주최자 정산정책 UI ‖ 공개
  정산현황 페이지 ‖ 관객 결제(목)·영수증 → e2e 데모 → 배포. ≈ **9~12일**(아래 계획).

---

## 1. Q1 — 수익분배 정책 모델 (SplitPolicy)

### 결정
정책은 **SettlementVault 에 행사별로** 둔다(티켓 관심사 아님 → Ticket.sol 무변경). 0xSplits 의
"불변 split" 을 기본으로, **지분은 bps(10,000=100%)**, **사유·태그는 온체인 해시 + 오프체인 원문**.

```solidity
struct Recipient {
    address account;     // 지급 주소(이해관계자의 MONTI 계정 또는 외부 지갑)
    uint16  bps;         // 지분(basis points). 모든 recipient 의 bps 합 == 10_000
    bytes32 reasonHash;  // keccak256(사유 원문) — 원문은 오프체인, 해시로 위변조 검증
    bytes32 tag;         // 짧은 분류 태그(예: "artist"/"venue") — 고정 32B, 저렴
}
struct SplitPolicy {
    Recipient[] recipients;  // MONTI 수수료도 하나의 recipient(태그 "platform")로 포함
    uint16 platformBps;      // = MONTI recipient 의 bps(검증·가시성용 미러; 아래 근거)
    uint16 reserveBps;       // 선택: 카드 환불충당 유보분(한국 카드경로). 데모 0
    bool   frozen;           // 첫 입금(첫 판매) 시 true
    uint32 version;          // 향후 합의형 변경용(데모 미사용)
}
mapping(uint256 => SplitPolicy) policyOf;   // eventId => 정책
```

### 규칙·근거
- **MONTI 수수료 = 하나의 recipient.** 0xSplits 처럼 모든 수취인을 균일하게 다룬다(특례 분기 없음).
  `platformBps` 는 그 recipient 의 bps 를 복제해 둔 **검증·공개용 미러**다: 유료 행사는 setPolicy 가
  `platformBps >= MIN_PLATFORM_BPS`(예 500=5%) 를 강제해 BM 수수료를 보장하고, 공개 정산 페이지가
  MONTI 몫을 투명하게 노출한다. **정액 ₩500/티켓** 은 bps 로 표현 불가 → **피아트/PG 계층에서
  예치 전에 차감**(예치되는 USDC 는 PG·정액수수료 차감 후 "순액"이고, bps split 은 순액에 비례
  적용). 데모는 단순화를 위해 정액 ₩500 생략(피아트 계층 항목으로 명시)하고 platformBps 만 사용.
- **사유/태그 저장 = 온체인 해시 + 오프체인 원문.** 긴 문자열 온체인 저장은 가스 과다이고 금고를
  무겁게 한다. MONTI 가 이미 쓰는 commit 패턴(titleHash/descHash/Revoke reason)과 동일: `reasonHash`
  는 `keccak256(사유)`, 원문은 Firestore + 공개 정산 페이지. `tag` 는 **bytes32 로 온체인**(저렴·고정)
  → 공개 페이지가 태그로 바로 거를 수 있다. 누구나 원문의 keccak 을 다시 계산해 해시와 대조 →
  "사유가 사후 조작되지 않았음"을 증명.
- **가변성 = 첫 판매(첫 입금) 시 동결.** 입금 전에는 정책 설정자가 자유롭게 교체, **첫 deposit 순간
  `frozen=true`**. 근거: 0xSplits 의 불변 split 이 안전 기본값 — 관객이 돈을 낸 그 정책이 바뀌면 안
  되고 이해관계자 분쟁을 막는다. 전원 합의형 버전업(`version++` + 모든 recipient 서명)은 **해커톤
  범위 밖**(구조만 남겨 둠, 데모 미사용). 권장 운영: **공개 전에** 설정 → 바로 동결.
- **검증(setPolicy).** `sum(recipients.bps) == 10_000`; `recipients.length <= 10`(유계 루프 가스);
  각 `bps > 0`·`account != 0`; 유료 행사면 MONTI recipient 존재 + `platformBps >= MIN_PLATFORM_BPS`.
  과검증 피함(사유/태그 내용은 검증 안 함 — 공개 페이지가 드러낼 뿐).
- **설정 권한 = 조직 소유자/관리자.** `Organizers.hasPermission(eventOrg(eventId), organizer,
  PERM_MANAGE_SETTLEMENT)`. **PERM_MANAGE_SETTLEMENT = 비트 64**(1/2/4/8/16 사용 중, Ticket 32 사용
  → 다음 빈 비트 64). **Organizers.sol 변경 불필요** — `hasPermission` 은 임의 비트마스크를 받고
  **소유자는 전 비트 보유**(`account==owner` 면 true)라 데모의 "소유자가 설정"은 자동 통과. 관리자
  위임이 필요하면 기존 `setAdmin(orgId, admin, 64)` 로 부여(코드 변경 없음). 설정은 **주최자 기기
  키 서명**으로 인가(§3 self-verify) → 릴레이어가 대신 제출(주최자 MON 불필요).

---

## 2. Q2 — 돈의 흐름 (데모 / 한국 상용) · push vs pull

### 핵심 결정: 티켓은 온체인 "무료 민팅" 유지, 돈은 **별도 정산 레이어**
온체인 유료 티어는 미구현(`_claimTo` 가 가격≠0 이면 `PaidTiersNotEnabled`). 이를 구현하려 Ticket.sol
(31KB, 크기 제약)을 키우지 않는다. 대신 **티켓은 지금처럼 가격 0 으로 민팅**(relayClaim 무변경)하고,
**가격·정산은 금고가 tokenId 에 묶어** 다룬다. Ticket.sol **0 변경**, 결제/정산은 깔끔히 분리된 레이어.

### 데모 흐름 (text diagram)
```
관객 폰 ──"구매"──▶ [카드 결제 화면(목업)] ──성공──▶ MONTI 백엔드
                                                   │ (1) relayClaim → 티켓 민팅(무료, tokenId 생성)
                                                   │ (2) Treasury(USDC 보유 EOA, Circle faucet 충전)가
                                                   │     vault.deposit(tokenId, USDC, 순액) 호출
                                                   ▼
                                        [SettlementVault] escrow[tokenId] = Held
관객 ──NFC 태그──▶ 게이트 ──relayCheckIn──▶ Ticket.checkInFor  (usedAt[tokenId]=now, CheckedIn 이벤트)
                                                   │ 릴레이어가 CheckedIn 이벤트 보고 즉시
                                                   ▼
                              vault.releaseOnCheckIn(tokenId)  ← Ticket.usedAt(tokenId)!=0 확인 후 분배
                                                   ▼
             아티스트/공연장/기획/MONTI 에게 USDC 전송 + Settled 이벤트 → 공개 정산 페이지 ~1초 갱신
```
**관객은 토큰을 만지지 않는다**(피아트로 내고, 영수증만 본다). USDC 는 Treasury→금고→이해관계자로만
흐른다.

### 에스크로 해제 규칙
- **입장 시 해제(기본).** 관객이 입장(usedAt≠0)하면 그 티켓 몫을 정책대로 분배. "배송 완료 시 에스크로
  해제"(Stripe/에스크로 선례)에서 **배송 = 입장**.
- **노쇼(종료 시).** 창업자 결정 "입장했거나 행사 끝날 때까지 보류 후 분배". 미입장 티켓은 **행사 종료
  (`eventStatus==Ended`, endsAt 파생) 후 `settleNoShows` 로 이해관계자에게 정산**(공연 노쇼=구매자
  귀책, 통상 무환불). `noShowRefund` 플래그로 환불 선택 가능(기본 정산). ← 사업·법률 판단 필요(§7/§8).
- **환불(해제 전).** (a) 관객이 취소창 내 취소, (b) **주최자가 행사 취소**(`eventStatus==Cancelled` →
  미입장 전 티켓 전액 환불 경로, 누구나 트리거 가능). 환불은 payer(Treasury/PG)로 반환 → PG 가 카드
  환불. **이미 입장·분배된 티켓은 환불 불가**(돈이 이미 나감).
- **차지백(카드).** 데모 N/A. 상용은 **PG 측 D+1 보류 중 처리**(에스크로 도달 전) 또는 `reserveBps`
  유보분으로 흡수.

### push(해제 시 분배) vs pull(수취인 인출) — Monad 권장
- **push 채택(수취인별 pull 폴백).** 해제 1 tx 가 N 건 ERC-20 전송. **MONTI 수취인은 알려진 스테이블
  주소**라 0xSplits 가 pull 을 기본으로 삼는 이유(미지의 수취인·ETH push 재진입/리버트 그리핑)가
  약하다. 결정적 이유: **이해관계자도 MON 을 들면 안 된다** → pull 은 수취인마다 인출 tx(또 릴레이어
  대납)가 필요해 번거롭다. **push = 릴레이어 1 tx 로 전원 지급, 무행동, "즉시".**
- **안전장치(폴백).** 한 수취인 전송 실패(USDC 블랙리스트 등)면 그 몫만 `owed[account]` 로 적립(pull)
  하고 나머지는 계속 push → **한 명이 전체를 막지 못한다**. SafeERC20 + ReentrancyGuard(§3).
- **5 수취인 가스:** 전송 4~5건 × ~30~50k + 오버헤드 ≈ **~220k gas ≈ 0.022 MON**(§6).
- **규모 레버(100명+).** 티켓마다 push = 100×0.022 ≈ 2.2 MON. 대안 **"입장 시 장부 적립(N SSTORE)
  + 종료 시 수취인별 1회 송금(sweep)"** 은 적립 ≈ 0.006 MON/티켓 + sweep 4건 → **≈ 1.7 MON 절감**,
  전송 500→104건. D+1 일괄지급(토스/Eventbrite 선례)과도 맞음. **권장: 데모·초기 상용은 push(가장
  단순·즉시, 수수료가 650배 덮음), 전송량/가스가 실제 제약이 되면 적립형으로 전환**(§6 수치).

---

## 3. Q3 — 컨트랙트 (SettlementVault): 인터페이스·입장 결합·역할·안전

### 결정: 단일 `SettlementVault`(EventEscrow + Splitter 병합) — 핵심 4 컨트랙트 무변경
`EventEscrow` + `Splitter` 로 쪼개지 않는다(해커톤엔 과분리). **금고가 Ticket/Organizers/Identity
를 읽기만** 하고, **아무도 금고를 "역호출"하지 않는다**. Ticket.sol·Organizers.sol·Identity.sol·
MontiForwarder.sol **전부 무변경 → 핵심 재배포 강제 없음**. 금고는 기존 주소를 가리키는 **독립 신규
배포**.

### 인터페이스 (신규 `contracts/src/SettlementVault.sol`)
```solidity
struct Escrow { address token; uint128 amount; address payer; uint8 status; } // 0 Held·1 Released·2 Refunded
mapping(uint256 => Escrow)   escrowOf;     // tokenId => 입금
mapping(uint256 => SplitPolicy) policyOf;  // eventId  => 정책(Q1)
mapping(address => bool) tokenAllowed;     // USDC 허용목록(원화 스테이블 추가 대비)
mapping(address => bool) depositor;        // 입금 adapter(Treasury/PG) 허용목록
mapping(address => uint256) owed;          // push 실패분 pull 폴백 잔액

ITicket     immutable ticket;      // usedAt·eventOf·eventOrg·eventStatus 읽기
IOrganizers immutable organizers;  // hasPermission 읽기
IIdentity   immutable identity;    // activeDevice 읽기(setPolicy 기기서명 검증)
bytes32 constant SET_POLICY_TAG = keccak256("MONTI:SET_POLICY:v1");
mapping(address => uint256) public policyNonce;   // 주최자별 재생방지

// 1) 정책 설정 — 주최자 기기키 서명(self-verify, claimFor 패턴). 릴레이어가 제출(permissionless).
function setPolicy(uint256 eventId, Recipient[] r, uint16 platformBps, uint16 reserveBps,
                   uint64 deadline, bytes deviceSig, address organizer) external;
function setPolicyDigest(...) external view returns (bytes32);  // 클라·백엔드 교차검증(공개 view)

// 2) 입금 — adapter 허용목록(Treasury/PG). USDC 를 금고로 transferFrom(사전 approve).
function deposit(uint256 tokenId, address token, uint128 amount, address payer) external; // onlyDepositor

// 3) 입장 시 해제 — permissionless. Ticket.usedAt(tokenId)!=0 확인 후 정책대로 분배(push/pull폴백).
function releaseOnCheckIn(uint256 tokenId) external;              // 멱등(status!=Held 면 no-op)
function releaseMany(uint256[] tokenIds) external;               // 릴레이어 배치(선택)

// 4) 노쇼 정산 — 종료 후(eventStatus==Ended). 미해제 티켓을 정책대로(또는 noShowRefund 면 환불).
function settleNoShows(uint256 eventId, uint256[] tokenIds) external;   // 유계 배치

// 5) 환불 — 해제 전. 주최자 취소행사(eventStatus==Cancelled, 누구나) 또는 adapter(관객 취소).
function refund(uint256 tokenId) external;

// 운영: setTokenAllowed/setDepositor/pause — owner(배포자). Settled/Deposited/Refunded/NoShowSettled 이벤트.
```

### 입장↔정산 결합 (가장 중요한 안전 결정)
- **금고가 Ticket 을 "읽는다"(pull), Ticket 은 금고를 "모른다".** `releaseOnCheckIn` 이
  `ticket.usedAt(tokenId) != 0`(입장 증명, 스펙 7.4 체인이 입장 권위) 를 **온체인에서 확인**한 뒤에만
  분배. **Ticket.checkInFor 에서 금고를 호출하지 않는다** → **입장이 정산 실패로 revert 될 일이 전혀
  없다**(창업자 요구 "정산 때문에 체크인이 깨지면 안 됨"을 구조로 보장).
- **자동성은 릴레이어가 준다.** 릴레이어가 `CheckedIn` 이벤트를 보고 **직후 1 tx 로
  `releaseOnCheckIn`** 제출(기존 릴레이 인프라 재사용). 사용자 체감 "입장 ~1초 후 분배"는 이 후속 tx.
  릴레이어가 실패/지연해도 체인은 안 깨지고 **누구나** 나중에 `releaseOnCheckIn` 호출 가능
  (permissionless·멱등).
- **eventId 파생.** 금고는 `ticket.eventOf(tokenId)` 로 eventId 를 얻어 정책 조회(비트레이아웃 중복
  구현 회피).

### 역할 모델
- **depositor 허용목록**(Treasury/PG adapter): `deposit`·adapter 개시 `refund` 만. owner 가 설정.
- **PERM_MANAGE_SETTLEMENT(비트 64)**: `setPolicy` — **기기 서명 self-verify**(금고가 Forwarder 대상이
  아니므로 `_msgSender()` 못 씀 → claimFor 처럼 주최자 기기키 P-256 을 직접 검증 +
  `hasPermission(eventOrg, organizer, 64)`). **Forwarder/핵심 재배포 불필요.** (대안: 금고를 Forwarder
  4번째 대상으로 — `setTargets` 는 이미 wired·immutable trustedForwarder 라 **핵심 4 재배포 강제** →
  기각, §8.)
- **release/settle/refund(취소행사) = permissionless**: 온체인 상태만 읽어 판정하므로 서명 불필요.
- **token 허용목록**: USDC(데모) → 원화 스테이블(향후). **pause**(owner): 비상 정지.

### 재진입·토큰 안전
- **CEI + ReentrancyGuard**: 분배/환불/정산 진입에 `nonReentrant`, 전송 전에 `status` 선변경(Held→
  Released). **SafeERC20**(USDC 는 bool 반환 비표준 대응). 전송 실패는 수취인별 `owed` 적립(pull 폴백).
- **token 허용목록**으로 검증된 스테이블만. `uint128 amount`(USDC 6dp, 충분). 미인가 토큰 deposit 거부.

---

## 4. Q4 — 가스 재원 결정 (창업자 질문)

### 결정: 유료 = (b) MONTI 가 수수료에서 대납 / 무료 = 현행 보조 / (c) 원화크레딧은 향후
창업자 성향("각 주최자 지갑 MON 으로, 또는 MONTI 가 수수료 떼고 대납")에 **(b) 를 권장** — 수치가
압도적이다.

### 측정 기반 수치 (Run 3 실측 + ERC-20 추정, MON≈₩40, 한도 102 gwei)
| 항목 | gas(추정) | MON | ₩ |
|---|---|---|---|
| 발급(claim, 실측) | — | 0.0247 | ₩1.0 |
| 입장(check-in, 실측) | — | 0.0175 | ₩0.7 |
| 예치(deposit, 추정) | ~100k | 0.010 | ₩0.4 |
| 분배(release push, 4수취, 추정) | ~220k | 0.022 | ₩0.9 |
| **티켓당 합(유료, push)** | | **≈ 0.075** | **≈ ₩3.0** |

- **유료 행사 커버비율.** ₩3만 티켓 수수료 = 5%×₩30,000 + ₩500 = **₩2,000**. 가스 ₩3 →
  **커버 ≈ 650배**. MON 이 10배(₩400) 올라도 가스 ₩30 → 여전히 **65배**. 즉 유료 행사 가스는
  **수수료 노이즈** 수준 → (b) 가 명백.
- **무료 행사.** 수수료·정산 없음 → 발급+입장만 ≈ 0.042 MON/명 ≈ ₩1.7. 100명 ≈ **₩170**. 현행대로
  MONTI 소액 보조.

### 옵션 비교
- **(a) 주최자 지갑 가스(조직별 GasVault, MON/USDC).** 기각. 주최자가 **MON 을 들어야** 함 → "MON
  불필요·web3 비노출" 원칙 위배. KRW "가스 크레딧" 상품을 만들면 복잡도↑ + 선불가치 보관이 **전자금융
  이슈**를 부른다. Monad 는 **한도로 과금**이라 상환도 "한도×가격"이어야 해 회계가 번거롭다. 현 가격
  구조에선 정당화 안 됨.
- **(b) MONTI 수수료 대납(현행 릴레이어 모델 확장).** **채택.** 릴레이어가 claim+check-in 에 더해
  deposit+release 도 제출. 주최자·관객·이해관계자 **아무도 MON 불필요**, web3 비노출. 수수료가 가스를
  650배 덮어 **지속가능**. 정액 ₩500 중 가스는 ₩3뿐 — 나머지는 KYC(실비)·지원·마진.
- **(c) 하이브리드(유료=b, 무료=쿼터 후 KRW 선불크레딧→usage 원장).** **향후.** 무료 행사 가스가
  실제 비용센터가 되면(MON 10~50배 급등 또는 무료 대량) 도입. 지금은 ₩170/100명이라 불필요 —
  usage 원장(Phase 2 `usage/{orgId}`)만 재사용해 집계는 해 두되 **집행·차단 안 함**.

**권장 한 줄:** 유료 행사는 **(b) MONTI 가 정산 수수료에서 claim·check-in·deposit·release 가스를
전부 대납**(커버 650배), 무료는 현행 보조 유지, (c) 는 가격/물량이 바뀔 때의 레버로만 문서화.

---

## 5. Q5 — 데모 시나리오 (10-13)

### 시나리오: 유료 공연, 이해관계자 4명
정책: 아티스트 60%(사유 "출연료", tag artist) · 공연장 20%("대관료", venue) · 기획 15%("기획비",
organizer) · MONTI 5%("플랫폼 수수료", platform). 티켓 가격 ₩30,000 ≈ 30 tUSD(6dp).

1. **주최자:** 행사 생성 → **정산 정책 설정 화면**(이해관계자 추가: 지급 핸들·지분%·사유·태그;
   합계 100% 강제; MONTI 5% 고정 라인) → 공개. **첫 판매 시 정책 동결.**
2. **관객 구매:** 행사 열기 → "구매" → **카드 결제 화면(목업)** → "결제 완료". 백엔드: (1) relayClaim
   으로 티켓 민팅(온체인 무료), (2) Treasury 가 `deposit(tokenId, tUSD, 30e6)` 로 에스크로. 관객은
   **영수증**(금액·행사·좌석) 확인 — web3 단어 없음.
3. **입장:** 관객 NFC 태그 → relayCheckIn(현행) → `CheckedIn`. 릴레이어가 즉시
   `releaseOnCheckIn(tokenId)` → **4명 USDC 잔액 ~1초 내 증가**, **공개 정산 현황 페이지**가 분배액+사유
   +태그를 실시간 표시.
4. **노쇼:** 구매했으나 미입장 1명. 데모 "행사 종료" (endsAt 도달 → `eventStatus==Ended`) 후
   `settleNoShows(eventId, [tokenId])` → 그 몫 정책대로 이해관계자 정산(장부에 "노쇼 정산" 표시).
5. **환불:** 행사 전 취소 1명(또는 주최자 행사취소) → `refund(tokenId)` → USDC Treasury 반환 → 앱
   "환불 완료"(카드 환불 목업). 장부에 "환불" 표시.

### 화면
- **주최자(신규):** 정산 정책 설정(이해관계자·지분·사유·태그, 합계 검증, MONTI 고정 라인).
- **공개(신규):** **정산 현황 페이지**(행사별: 총 모금액, 이해관계자별 지급/대기 + 사유·태그, 티켓별
  정산 로그, 노쇼 정산, 환불). **공개 링크**(누구나 열람 — "누구나 본다" 요구).
- **관객:** 기존 발급/입장 **무변경** + **카드 결제(목업)** 화면 + **영수증**.
- **스태프:** **완전 무변경**(게이트/체크인 그대로).

### 목업 vs 테스트넷 실제
- **목업:** 카드 결제 UI(실 PG 없음), Treasury 가 Circle faucet USDC 로 자동 예치, KYC 선택.
- **테스트넷 실제:** 티켓 민팅·체크인·**deposit(진짜 USDC transferFrom)**·**release/split(진짜 USDC
  전송)**·settleNoShows·refund·공개 장부(실제 온체인 `Settled` 이벤트 판독). **돈의 이동은 Monad
  테스트넷에서 진짜 테스트 USDC** — "end-to-end 테스트넷" 요구 충족.

---

## 6. Q6 — 비용 모델

> **정산 신규 op 은 추정**(측정 앵커 + ERC-20 전송 가스). 착수 시 `SettlementGas.t.sol` 로 확정(§8).
> 발급·입장·생성·공개는 Run 3 **실측**.

### 건당 (추정, MON≈₩40)
| op | gas | MON | ₩ | 전송수(USDC) |
|---|---|---|---|---|
| setPolicy(1회/행사, 4수취+P256) | ~200k | 0.020 | ₩0.8 | 0 |
| deposit | ~100k | 0.010 | ₩0.4 | 1 |
| releaseOnCheckIn(push, 4수취) | ~220k | 0.022 | ₩0.9 | 4 |
| releaseOnCheckIn(적립형, SSTORE) | ~60k | 0.006 | ₩0.2 | 0 |
| settleNoShows(티켓당, push) | ~220k | 0.022 | ₩0.9 | 4 |
| refund | ~70k | 0.007 | ₩0.3 | 1 |

### 100명 유료 행사 (전원 입장 가정)
| 구성 | push(즉시분배) | 적립형(종료 sweep) |
|---|---|---|
| 기존(create+publish+gate+100발급+100입장) | 4.32 | 4.32 |
| setPolicy | 0.02 | 0.02 |
| 100×deposit | 1.00 | 1.00 |
| 100×release(0.022) / 100×적립(0.006) | 2.20 | 0.60 |
| sweep(수취인 4건) | — | ~0.09 |
| **합계(MON / ₩)** | **≈ 7.5 / ₩300** | **≈ 6.0 / ₩240** |
| 스테이블 전송 건수 | ~500 | ~104 |

- **수수료 대비.** 100 티켓 × ₩2,000 = **₩200,000** 수입 vs 가스 ₩240~300 → **커버 ≈ 650~830배.**
  즉 push(즉시분배)의 ₩60 추가비는 "즉시·투명" 데모 가치에 비하면 무의미 → **데모·초기 상용 push,
  전송량/가스가 실제 제약일 때만 적립형 전환.**
- **노쇼·환불** 은 입장 안 한 티켓에만 → release 를 대체(추가 아님). 100명 중 입장률에 따라 합계는
  오히려 감소(분배 tx 수 = 입장 수 + 노쇼정산 수).

---

## 7. Q7 — 컴플라이언스 매핑 (한국)

> 법률 자문 전제의 설계 의견이며 법률 자문이 아니다. **한국 상용 전 전자금융거래법·자금세탁방지
> 관점 변호사 확인 필수**(§8 가정).

### 원칙: MONTI 는 "소프트웨어·장부", 돈은 "라이선스 집행자"
- **MONTI 가 하면 안 되는 것(전자금융업/자금이체 라이선스 없이).** 관객 KRW 를 **직접 보관**하거나,
  당사자 간 **본인계정으로 정산·이체**하거나, 고객 자금 **에스크로를 직접 운영**하는 것. 이를 하면
  무등록 자금이체(전자금융거래법) 리스크.
- **컴플라이언트 패턴(선례).** **라이선스 PG(토스페이먼츠 등) 결제대행 + 라이선스 정산대행(지급대행)**.
  PG 가 카드 KRW 를 수납하고, **라이선스 정산대행자가 MONTI 의 지시대로 이해관계자에게 분배**(D+1).
  MONTI 는 **정산 정책과 장부를 계산·기록·지시**할 뿐 **자금을 보유·이체하지 않는다**(Stripe Connect /
  토스 정산대행 / Eventbrite payouts 와 동형).

### 온체인 정책/장부 → PG 집행 매핑 (온체인 = 유일 진실원본)
```
온체인 SplitPolicy + Settled 장부  ──(누가·얼마·왜·입장조건)──▶  라이선스 PG/정산대행 집행기
  (불변·공개·위변조불가 = 지시 + 감사기록)         (그 기록대로 KRW 를 D+1 지급)
```
- 온체인 기록(지분·사유·태그·입장 게이팅)이 **WHO/HOW-MUCH/WHY 의 단일 진실원본**. 집행기는 그 기록을
  읽어 **KRW 를 집행**. 데모의 온체인 USDC 이동이 "집행"을 문자 그대로 보여주고, 한국 상용에선 **같은
  정책/장부가 PG 지급을 구동**(크립토 이동 없음).
- **소비자 크립토 없음.** 관객 카드 KRW 납부, 이해관계자 KRW 수취, 누구도 토큰 보유·열람 안 함.
  USDC 에스크로는 **데모/테스트넷 구성물**. 상용은 **라이선스 PG 에 KRW 보류(정산 보류=입장까지)**,
  온체인 기록의 입장 신호로 해제.

### 원화 스테이블코인이 생기면 (코디네이터 사실 반영)
- **현재:** 디지털자산기본법(원화 스테이블 법)이 **2026-09 를 넘김**, 국회 논의 **11월경 예상**, 은행
  **51% 규칙 미정** → **당분간 합법 원화 스테이블 없음**. 따라서 **한국 상용 머니레일은 당분간
  라이선스-PG 정산대행 집행기**로 간다(창업자 요약·본 절에 명시).
- **합법화 후:** 금고 **토큰 허용목록에 원화 스테이블 추가** → 같은 SettlementVault 로 **온체인 원화
  정산**(입장까지 보류·즉시 분배) 가능 → 오프체인 PG 지급 단계를 온체인 레일로 흡수. **단 라이선스
  발행자/VASP 경유 등 규제 준수 전제.** 그 전까지는 **온체인=진실원본 / 오프체인 라이선스 PG=집행**.
- **KYC(BM).** KYC 필수 행사는 KYC 실비 청구(Didit). 이해관계자 지급계좌는 정산대행자 AML 규칙상
  실명확인 필요할 수 있음.

---

## 8. Q8 — 위험 / 열린 질문

### 위험
- **분배 그리핑(수취인 리버트/블랙리스트).** USDC 블랙리스트된 수취인이 전송 리버트 → **수취인별
  `owed` pull 폴백**으로 그 몫만 보류, 나머지는 push 지속. 한 명이 전체를 못 막음.
- **노쇼: 정산 vs 환불.** 기본 "이해관계자 정산"은 사업·법률 판단(공연 **소비자분쟁해결기준**이 부분
  환불을 요구할 수 있음 — 노쇼는 통상 구매자 귀책이나 확인 필요). `noShowRefund` 플래그로 전환 가능 →
  **창업자/법률 확정 필요.**
- **정책 동결 타이밍.** 첫 입금에 동결 → 오설정 후 1장 팔리면 고착. **공개 전 설정** 운영 규칙 + 첫
  deposit 전 수정 허용으로 완화. 전원합의 버전업은 향후.
- **차지백/분배 후 환불.** 입장·분배된 티켓은 환불 불가(돈이 나감) → 분배 후 차지백은 손실 →
  `reserveBps` 유보 또는 **PG D+1 보류 중 처리**로 완화.
- **Treasury 키(USDC 보유) 침해 반경.** 전용 EOA + 소액 float + 잔액 경보(릴레이어 패턴 재사용).
- **Circle faucet 신뢰성(데모일).** faucet 한도/다운 대비 **사전 충분 충전** + **자체 배포 mock
  tUSD(6dp)를 데모일 보험으로 준비**(기본은 실물 Circle USDC, 토큰 주소 설정 가능). 이것이 원 과제의
  "mock tUSD 폴백"과 코디네이터의 "실물 USDC" 를 조화시키는 방식.
- **decimals.** USDC **6 decimals** — 전 금액 6dp, 18 가정 금지. UI 는 KRW/USD 포맷.
- **재진입/표준.** ReentrancyGuard + SafeERC20 + CEI + token 허용목록(§3).
- **릴레이어가 release 를 빠뜨림.** permissionless·멱등이라 누구나 복구 호출 가능. 체인은 안 깨짐.

### 열린 질문 (추측 명시 — 착수 시 확정)
- **정산 신규 op 가스** — **추정**(deposit ~100k·release ~220k). `SettlementGas.t.sol` 실측 필요.
- **Circle USDC(10143) faucet 한도/안정성** — 데모 전 실제 수령·transferFrom 1건 확인(**미검증**).
- **setPolicy 인가: 기기서명 self-verify vs 신뢰 백엔드** — 정확성상 기기서명 권장, 시간 부족 시
  백엔드-신뢰 폴백(백엔드가 임의 split 설정 가능 = 약함) 허용. 착수 시 택일.
- **노쇼 기본값(정산/환불)** 및 **reserveBps 사용 여부** — 사업·법률 확정.
- **전자금융거래법/AML** — 한국 상용 전 **변호사 확인 필수**(본 문서는 법률 자문 아님).
- **금고를 Forwarder 대상에 넣을지** — 넣으면 `setMessageSender` 일관성↑이나 **핵심 4 재배포 강제** →
  이번엔 self-verify 로 회피(향후 전면 재배포 시 재검토).
- **적립형 전환 시점** — 전송량/가스가 실제 제약이 되는 임계(§6) 모니터링.
