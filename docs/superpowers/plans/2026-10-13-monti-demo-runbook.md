# MONTI 데모 데이 런북 — Monad Metropolis 발표 (2026-10-13)

작성 2026-10-09 (D-4) · v2 개정 2026-10-12 오전 · **영어 UI + open 모드 개정 2026-10-12 밤** · 대상 체인 Monad testnet(10143) · RPC `https://testnet-rpc.monad.xyz` · 웹 `https://monti.despell.io`

> **이 판 읽는 법 (2026-10-12 밤).** v2는 **10-12 14:45–14:50에 GO 완료**(운영 = v2, 인덱서 `1b4098c`). 그 뒤 해커톤 제출용으로
> 운영이 두 가지 바뀌었다. ① **화면이 전부 영어**(언어 고정 en, 언어 선택 없음) ② **"open" 인증 모드** — 전화번호·문자 코드·패스키가
> 없고, **"Get started" 한 번**(약 6–7초)이면 가입이 끝나 홈으로 간다. 그래서 이 문서의 무대 대본(§1·§2)·점검표(§3)·한계(§4)를
> 이 기준으로 다시 썼다. 대표가 읽는 멘트는 **한국어 그대로**, 화면 버튼은 **영어 표기 그대로** 인용한다(예: "**Get started**를 누릅니다").
> 버튼 영어↔한국어 대조는 **부록 B**, 심사위원 안내문(영어 원문)은 **부록 A**.
>
> - 옛 "전화번호로 새로 가입" 단계는 전부 **Get started**로 바뀌었다. 테스트 번호(…20 무대 전용 등)는 **무대에 더 이상 필요 없다.**
> - v1·"v1 유지 시"·NO-GO 내용은 **기록(historical)** 으로만 남겼다. **무대의 대안은 v1이 아니라 지금 v2 빌드 그대로**다.
>   `scripts/ops/go-switch.sh rollback`은 비상용으로 남아 있지만, 실행하면 **한국어·전화번호 모드의 v1**이 돌아온다(§3 롤백).
> - 하드 컷오프 **10-13 09:00 KST** — 그 뒤로는 배포·전환·롤백을 하지 않고, 그때 살아 있는 쪽으로 시연한다.

> 누가 무엇을: **대표**(=창업자) = 무대 발표·폰 조작·승인 담당(비개발자). **보조**(=운영 에이전트) =
> 맥북에서 명령 실행·잔액/인덱서 모니터·장애 복구 담당. 이 문서는 대표가 무대에서 그대로 따라 읽는 용도다.
> 비밀값(키)은 어떤 화면·발표·커밋에도 절대 띄우지 않는다.

---

## 0. 한눈 요약 · 고정 정보(주소·잔액·현재 상태)

**이 데모의 핵심 한 문장:** "관객이 입장하는 순간, 티켓값이 1초 안에 정해 둔 비율대로 자동으로 나뉘어 들어가고,
누구나 공개 페이지에서 그 분배를 실시간으로 확인한다."

**지금 운영 상태 (2026-10-12 20:15 기준)**

| 항목 | 값 |
|---|---|
| 웹 배포 | `monti-o8nqte5wu` (entry `index-O7hZzO-m.js`, 20:15 배포). 직전 통과 배포: `monti-l2x6rn00p`(18:45, open+영어 Run 2 ALL PASS) |
| 화면 언어 | **영어만**(`<html lang="en">`, 언어 고정, 선택 메뉴 없음) |
| 인증 | **open 모드** — 웹 `VITE_AUTH_MODE=open`, 백엔드 `AUTH_MODE=open`(functions:v2, 16:40 배포). 전화번호·문자 코드·패스키 없음 |
| 가입 | `monti.despell.io` → **Get started** → 약 6–7초 → 홈. 그 브라우저에 로그인이 유지된다(새로고침·브라우저 재시작 후에도) |
| 옛 주소 | `/login`, `/signup/*` → 전부 `/start`로 넘어간다 |
| 계정 복구 | **없음.** 브라우저 데이터를 지우거나 다른 브라우저·시크릿 창을 쓰면 **새 사람**이 된다 |
| 데모 행사 | **1004 "Monad Metropolis Demo Night"** (주최자 Organizer 1004) — **General 무료 ×200**, **Supporter $1 ×50**, 분배 **MONTI 5% / 주최자 95%**. 공개 tx `0x9c116fc4…` |
| 행사 링크 | `https://monti.despell.io/events/1004` · `/claim/1004` · `/settlement/1004` |
| 숨긴 행사 | 1001–1003(한국어 리허설 행사)은 홈 목록에서 숨김(`VITE_HIDDEN_EVENT_IDS=1001,1002,1003`). 직접 주소로는 열린다 |
| 인덱서 | Envio `1b4098c`(v2, 1004 반영됨) |
| 함수 | codebase `v2`, us-east4, 최소 인스턴스 1(15개 서비스, 16:40 재적용) |
| 심사위원 | **행사 1004**를 쓴다(부록 A 안내문). 무대는 1004를 쓰거나 대표 폰에서 **새 행사를 그 자리에서 공개**(예열 상태 약 7초) |

**오늘 잰 시간 (예열 상태, 10-12 저녁 운영)**

| 동작 | 시간 |
|---|---|
| Get started → 홈 | **6.2–7.0초** |
| 무료 받기(Get a ticket) | **1.8초** |
| $1 결제(Pay $1 → 완료) | **2.8초** |
| 행사 공개(Publish → Your event is live) | **6.6초** |
| 수동 승인 | **약 2–3초** (낮 v2 Run 2 2.96초 — 한국어 화면 기준) |
| 환불(Get a refund → Refunded) | **약 4초** (낮 v2 Run 2 4.0초 — 한국어 화면 기준) |

**고정 주소 (Monad testnet 10143)**

v2는 시작 블록 **70161104** 에서 배포됐고(커밋 `130f425`, 배선 점검 19/19 OK), 행사·주최자 번호는 **1001부터**다. **운영 = v2 열.** v1 열은 기록용.

| 이름 | **v2 (운영)** | v1 (기록 — 롤백 시에만) | 용도 |
|---|---|---|---|
| Identity | `0x1EDFE1BC63e4239e8fB1c62249a33B78BAFC4B27` | `0x10Fa9977363c40240381BEEfFc2D997BC9Edcd6b` | 신원 |
| Organizers | `0x18134b640912A6f54e83B30DD079039627173dca` | `0xAF80CbfDD08284E3aae67FFaaf20A27E281C360A` | 주최자/권한 |
| Ticket | `0x8544c531A3EF7f702fe3A64Ff20D57bA774d9edC` | `0x7E1fdfCB3688C5b0539101cEAE6a7Ee5bD9b51Cf` | 티켓·입장(usedAt) |
| Forwarder | `0xcE6DC3040A500545604d0Bb6c594493d4Bd1ddbb` | `0xb19c37374f9aAf8b0A0a4499080369E93AFB4B5F` | 릴레이 위임전송(ERC-2771 P-256) |
| **SettlementVault(금고)** | `0xDC3DDd274bb22a112ba8A120De471037aeE52925` | `0xA84FDb64C9DDc3B25eF8BDeA58561BDbE53ABD69` | 정산 정책·에스크로·분배 (v2: 결제 `purchase` = 발급+보관 1건) |
| USDC(Circle 테스트, 6dp) | `0x534b2f3A21130d7a60830c2Df862319e593943A3` | 동일 | 분배에 쓰는 실제 테스트 스테이블 |
| Treasury(전송/예치 + 플랫폼 5% 수취) | `0xAe6D18fA7dC1e2512a2dC7DaE1d4640D7D786Bb2` | 동일 | USDC 예치자. `VITE_ADDR_PLATFORM` 과 동일. **v2: 유료 발급 가스도 트레저리가 냄** |
| Relayer(릴레이어, 가스 지불처) | `0xFA93A9dB40a4396a8CdcF63991FA8615d1A35fFd` | 동일 | 무료 받기·입장·주최자 동작 릴레이 가스 |
| **Attester(가입 가스)** | `0x6af898aA4d99375839d7069431A7019a6D84C4Ed` | 동일 | 가입(`Identity.register`)·주최자 등록 가스. **open 모드에선 Get started 1번 ≈ 0.02 MON** |
| Deployer(운영 지갑) | `0x74f75f4Dce3b04ea18f73E862b5a009781cE4eA2` (deployer-v2, 금고 owner, **충전 재원**) | `0x509ed82E0FCaE0c8A6cdE6Ddeb12eb5dc836BCf3` (옛 키 — 키가 `.secrets`에 없음) | 배포·충전 재원 |

**잔액 — 최근 기록 (보조가 T-30에 재확인, §3-15)**

| 항목 | 목표 | 최근 기록 | 상태 |
|---|---|---|---|
| 트레저리 MON (유료 발급·환불 가스) | **≥ 1** | **3.387** (Run 2 후, 10-12 저녁) | OK |
| 릴레이어 MON | ≥ 5 | **7.417** (Run 2 후) | OK |
| **attester MON** (Get started 1번 ≈ 0.02) | **≥ 1.5** | **3.68** (10-12 19:00; 18:40 +1.5 충전) | OK — 심사위원·관객 가입이 몰리면 빠르게 준다(3.68 ≈ 가입 180번). **T-30 점검 항목** |
| deployer-v2 MON (충전 재원) | ≥ 3 | 12:10 기록 4.82 → 18:40 attester +1.5 충전 후 약 3.3 추정 | T-30 재확인 |
| **트레저리 USDC** | **≥ $60** | **$52.5** (10-12 19:00; $1 결제 1건이 금고에 보관 중 $1.00) | **모자람 — 대표 faucet 충전 요청 중**(`faucet.circle.com` → Monad Testnet → Treasury) |
| USDC 허용량 트레저리 → v2 금고 | 최대값(max) | approve 완료(tx `0xfbf5a4d5…f2bd`) | §3-15에서 재확인 |
| v2 금고 `tokenAllowed(USDC)` / `depositor(treasury)` | true / true | 점검 19/19 OK | OK |
| **인덱서(Envio)** | `1b4098c` Active · `is_hyper_sync=true` · lag<100 | 1004·티켓 3장 반영(Run 2) | T-30 재확인 |

> $1 티켓은 결제 1건에 USDC $1만 쓴다. "$60 이상"은 무대 + 심사위원 결제 여유분 기준이다(옛 "$30 × (건수 + 2)" 공식은 $30 티켓 시절 기록).

**지금 상태 요약 (10-12 저녁):** open+영어 빌드에서 **Run 2 ALL PASS** — 행사 1004 공개 6.6초 → 심사위원 경로(spec 59) 2/2
(새로 Get started → 새로고침해도 로그인 유지 → 무료 받기 → Tickets에 표시; 공유 링크 `/claim/1004` → Get started → 다시 받기 화면) →
**$1 Supporter 결제 2.8초**(영수증 "Payment held · paid out when you check in", 분배 예시 $0.05 / $0.95) → 화면 15개 한글 0·금지어 0·콘솔 오류 0.
**수동 승인 → 자동 분배 → 환불은 오늘 낮 v2 Run 1·Run 2(한국어 화면, 행사 1001–1003)에서 통과**했고, 영어+open 빌드에서는 **오늘 밤 리허설(§3 D-1 9번)에서 처음 다시 돌린다.**

### 0-H. (기록) v1 시절 잔액·검증 — 무대에서 쓰지 않음

> 아래는 10-09–10-12 오전 v1/전화번호 모드 시절 기록이다. 숫자·번호·행사 14–16번은 지금 운영과 무관하다.
> 롤백(§3)으로 v1을 다시 띄울 때만 참고한다.

**잔액/배선 — 2026-10-10 Run 7(최종 리허설) 직후 라이브 확인값** (보조가 당일 아침 재확인, §3 T-30 점검):

| 항목 | 목표 | 10-09 (Run 5 후) | **10-10 (Run 7 후)** | 상태 |
|---|---|---|---|---|
| 체인 head | — | 69,526,441 | — | — |
| 릴레이어 MON | ≥ 5 | 8.67 | **8.394** (Run 7 전체 0.249 사용) | OK |
| 금고(treasury) MON | ≥ 0.5 | 1.000 → 0.917 | **0.804** | OK(데모 몇 건 충분) |
| 운영(deployer) MON | ≥ 3 | 49.08 | **44.7** | OK |
| **금고 USDC** | **≥ $30 × (구매 예정 건수 + 2)** | $51.5 | **$42.0** → Run 8 후 $32.5 → **$72.5**(10-11 충전 후 $72.5 = $30 결제 2건분) | **충전 완료 — 그래도 무대 전 faucet 1회 더 충전 권장(§3·§4)** |
| vault `tokenAllowed(USDC)` | true | true | true | OK |
| vault `depositor(treasury)` | true | true | true | OK |
| **인덱서(Envio)** | 1개 Active · `is_hyper_sync=true` · lag<100 | 동결 — 폴백으로 Run 5 통과 | 새 인덱서(d6a478c) 정상 | 당일 아침 재확인 — §3·§4 |

**지금 상태 요약:** 핵심 돈의 흐름 전체가 **2026-10-09 운영(production)에서 끝까지 라이브 검증됨**
(행사 14번, 한 세션): 정산 규칙 확정 → **$30 결제** → **입장(수동 승인)** → **약 1초 안에 자동 분배**
(아티스트 18 / 공연장 6 / 기획 4.5 / MONTI 1.5 USDC, **정확히 일치**) → 영수증 **"정산 완료"**.
환불도 관객 화면에서 끝까지 검증됨(10-10 Run 6b, 행사 14번: 결제 → 티켓 상세 "보관 중" → **환불받기**
→ **환불됨** 2.5초, 재무 USDC 51.5→21.5→51.5 복귀, 새로고침 후에도 환불됨 유지; 환불 tx `0x6ca038cb…693082`).
인덱서는 10-09 검증 내내 **동결**이었는데도 폴백으로 전 과정 통과(§4); 10-10부터 새 인덱서(d6a478c) 정상. tx·가스 실측은 §7.
**10-10 Run 7 최종 리허설 PASS**(운영, 행사 15번, $10 등급, 테스트 번호 …11/…12/…13): 결제 확정 9.45초 →
수동 승인 3.03초 → **같은 초에 자동 분배** → 영수증 "정산 완료"(승인 클릭 후 7.57초), 분배
MONTI 0.5 / 아티스트 6 / 공연장 2 / 기획 1.5, 환불 구간도 화면에서 5.98초에 "환불됨". 세부는 §7.

> **위 검증 전부는 v1 기준이다.** v2 전환 시에는 컨트랙트가 새로 배포됐으므로 같은 흐름(공개 1건 → 결제 1건 →
> 수동 승인 → 자동 분배 → 환불)을 스테이징 하니스(V4·V5)와 운영 도메인 리허설(V10)로 다시 통과시켜야 한다.
> **v2 Run 1 결과 (10-12 10:04–10:11 KST, 운영 도메인, 행사 1001, $10 등급, V3·V4·V5 모두 첫 시도 PASS):**
> 결제 클릭→완료 **7.36초**(서버 첫 호출 — 콜드 스타트 4.3초 포함) / **2.20초**(두 번째, 예열 상태) · 수동 승인 **3.02초**
> (하니스 폴링 기준; 서버 처리 실측 1.8–2.1초) · 영수증 "정산 완료" 승인 후 **약 6–7초**(스크린샷 기준, 미검증) ·
> 환불됨 **6.77초**(확인 시트 포함, 하니스 관측 9.0초) · 첫 공개 **38초**(콜드 스타트 5회 = 24.5초).
> 느린 구간은 전부 **us-east4 함수 콜드 스타트**가 원인 → §3 "T-30 / T-10 예열"(최소 인스턴스 1 + 예열 루프)로 막는다.
> tx 수·가스·잔액은 §7 "v2 Run 1". **무대 리허설(V10)은 아직** — GO 후 운영 도메인에서 따로 돌린다.

**무엇이 라이브로 검증됐나 (settle-h Run 5, 행사 14, 운영):**
- 정산 규칙 확정(아티스트60/공연장20/기획15 + MONTI5%) → 온체인 `getPolicy` v1(합 100%) → 공개 → 공개 `/settlement/:id` 규칙 렌더 **PASS**.
- $30 결제 → 영수증 **"보관 중"** → **수동 승인** 입장 → **인라인 자동 분배 ~1초** → 영수증 **"정산 완료"** **PASS**.
- 분배 금액 **18 / 6 / 4.5 / 1.5 USDC**(60/20/15/5%) 온체인 `Paid` 로그로 정확히 일치 **PASS**.
- 환불: 금고 HELD→Refunded, 받은 돈 원복 **PASS(온체인)**.

**아직 미검증 / 확인 필요 — 데모 전:**
- ~~관객 "환불받기" 버튼 UI 한 구간~~ → **10-10 Run 6b 통과**(환불받기 → 환불됨 2.5초, 온체인 환불 확인).
- 검증용 테스트 번호는 10-10에 `+821000000011…20`(코드 123456)으로 교체됨(옛 01~10은 소진).
  **사용한 번호: …11–…16 및 …19, 그리고 10-12 v2 Run 1에서 …17(주최자)·…18(관객 A)·…21(관객 B). …11은 Run 1 스모크에서 로그인만(가입 없음).
  남은(미사용) 번호: …20(무대 관객 전용, 끝까지 미사용), …22–…27.**
  리허설·데모는 반드시 미사용 번호로 — 이미 쓴 번호는 `/recover`(재설정, 하루 한도)로 빠진다.
  **v2 전환 시:** 미사용 …17, …18, **…20(= 무대 관객 전용, 끝까지 미사용)**, 그리고 하니스용 신규 **…21–27**
  (`E2E_PERSONA_OFFSET=20` → persona-01…07). **무대 계정(주최자·관객)은 전환 후 운영 도메인에서 새로 가입**해야 한다 —
  v1 계정과 스테이징 도메인 계정은 v2에서 쓸 수 없다(기기 키가 다른 곳에 있고 v2 신원 장부에도 없음).
  **주의(10-12 확인):** v1에서 가입한 계정은 v2에서 **로그인은 되지만** 첫 결제·입장에서 일반 오류로 실패하고 `/recover`도 막힌다.
  창업자 실번호처럼 v2에서도 써야 하는 번호는 **GO 전에 `reset-persons --phone`으로 초기화**한다(§3 GO 절차 1번).
- **금고 USDC $72.5**(10-11 충전 후 $72.5 = $30 결제 2건분; 10-10 Run 7 후 $42.0 → Run 8 후 $32.5 → 충전). 무대 전에 대표가 `faucet.circle.com`에서 한 번 더 충전하는 것을 권장(§3 "반드시 지킬 4가지" 3번).
- **Run 8(10-10, 수정 후 회귀) PASS**(행사 16, $10 등급, 테스트 번호 …14/15/16): 결제 확정 7.36초(Run 7의 9.45초에서 단축), 영수증 "정산 완료"는 승인 클릭 후 7.56초, 환불 구간 화면 6.53초. 세부는 §7.
- **분배 트리거(옛 gap 4) 해소됨:** 수동 승인 확정 시 백엔드가 **인라인으로 바로 분배**(5분 주기 sweep은 백업). 10-09 실측 ~1초.
- **주최자 "열기(게이트)" 목록**은 인덱서 동결 시 안 뜸(폴백 없음) — **오늘 수정 중** → §4·§3 "확인 필요".
---

## 1. 데모 스토리 (3분 버전 / 7분 버전)

### 3분 버전 (피치 핵심)
1. **문제.** 공연 티켓 시장은 ① 암표(남의 티켓을 비싸게 되팖)와 ② 불투명한 정산(돈이 누구에게
   얼마씩 가는지 아무도 못 봄)으로 망가져 있다.
2. **MONTI.** 티켓을 **본인에게 묶고**(이 기기·이 사람에게 귀속 → 자유 재판매 불가), 수익 분배 규칙을
   **공개 전에 못 박아** 누구나 볼 수 있는 공개 장부에 올린다. 관객에게는 **어려운 기술 용어가 전혀 안
   보인다** — 버튼 하나(**Get started**)로 시작하고, 카드 결제 화면과 영수증만 본다.
3. **하이라이트 장면.** 관객이 **입장하는 순간 1초 안에** 티켓값이 정해 둔 비율대로 **자동 분배**되고,
   **누구나 공개 페이지**에서 "누가 무슨 명목으로 얼마 받았는지" 실시간 확인한다. 조작이 불가능한
   공개 장부 — 이것이 "왜 이렇게 만들었나"의 답이다.

### 7분 버전 (3분 + 아래 보강)
4. **왜 이 기반(Monad)인가.** ① **0.3초 만에 확정** → 입장과 동시에 분배가 체감상 즉시 끝난다.
   ② 기기 안에 만든 키로 본인 확인을 싸고 빠르게 처리 → 비밀번호도 복구 문구도 필요 없다.
   ③ 처리 비용을 "쓴 만큼"이 아니라 **정해 둔 한도로 매기는 특성** 때문에, 값비싼 대리 결제 장치를
   버리고 **우리 서버가 대신 내주는 단순한 방식**으로 정리했다. 외부 중개 서버·예치금·사전 준비
   작업이 전부 사라졌다.
5. **비용/수익으로 못 박기.** 유료 티켓 1장(결제 + 입장 + 분배) 처리 비용 ≈ **₩4**(10-12 v2 실측).
   수수료는 **5% + ₩500 ≈ ₩2,000**(₩3만 티켓) → 수수료가 처리 비용을 **약 500배** 덮는다.
   "비용은 제약이 아니다. 투명성과 즉시성이 가치다." (v1 시절 기록: ₩3, 약 650배.)
6. **한국 상용 경로(규제).** 원화 스테이블 법이 아직 없어, 한국에서는 **라이선스 PG(토스 등)·정산
   대행이 실제 돈을 집행**하고 MONTI는 **정산 규칙·공개 장부(조작 불가한 유일한 원본)만** 제공한다.
   고객 돈을 직접 보관·이체하지 않아 전자금융업 등록 없이 운영(법률 자문 확인 중). 오늘 시연의
   분배는 **테스트용 달러 스테이블로 실제 실행**되는 데모이며, 원화 스테이블이 합법화되면 같은
   금고에 원화 수단만 추가하면 된다.
7. **(질문 나오면) 오늘은 왜 전화번호가 없나.** "해커톤 심사위원이 2분 안에 직접 써 보도록 가입을 버튼 하나로
   줄였습니다. 실제 서비스에서는 전화번호와 본인 확인을 다시 켭니다(설정 하나로 전환)." (§4 open 모드 한계)

> 말투 팁: 어려운 단어("에스크로·bps·ERC-2771·지갑·토큰·가스")는 입에 올리지 말 것. "금고에 잠긴다 / 지분 % /
> 대신 내주는 전송" 으로 말한다. 화면 버튼은 영어로 읽는다(부록 B 대조표).

---

## 2. 무대 장면 순서와 클릭 경로 (영어 화면 · open 모드)

### 2-0. 기기 배치 — "한 사람 = 한 기기(브라우저)"

**한 사람은 한 행사에서 티켓 1장만** 가진다. 같은 사람이 General(무료)을 받은 뒤 Supporter($1)를 사려 하면
"You already have your tickets for this event. Check My tickets."가 뜨고 결제 버튼이 꺼진다. 그래서 무대는 기기를 나눈다.

| 기기 | 역할 | 준비(오늘 밤 리허설에서 끝내 둠) |
|---|---|---|
| **폰 A (대표 폰)** | 주최자 + 스태프(게이트 단말기) + 수동 승인 | Get started 완료. 이 폰으로 **무대 행사 S를 공개**하고, 같은 폰에서 게이트 단말기 등록·승인·PIN 설정까지 |
| **기기 B (두 번째 폰 또는 노트북 브라우저)** | 관객 — **Supporter $1 결제 → 입장 → 분배** | 무대에서 처음 Get started 해도 된다(6–7초). 미리 해 뒀다면 **같은 브라우저 그대로** |
| (옵션) **기기 C = 노트북의 새 시크릿 창** | 관객 2 — **환불 장면** | 시크릿 창은 열 때마다 **새 사람**이다. 환불 장면에만 쓰고 창을 닫지 않는다 |
| 노트북 미러링 | 공개 정산 페이지 `/settlement/<S>` | 탭 열어 두기 |

> **왜 행사 1004가 아니라 무대 행사 S인가.** 1004의 주최자(Organizer 1004)는 검증용 브라우저 프로필 안에만 있다
> (open 모드는 복구가 없어 대표 폰으로 옮길 수 없다). 그래서 **수동 승인(주최자 권한) 장면은 1004로 못 한다.**
> 1004는 **심사위원용**(부록 A)으로 두고, 무대는 **대표 폰에서 공개한 행사 S**로 한다.
> 수동 승인 없이 "결제 → 영수증 → 공개 페이지 규칙"만 보일 거라면 1004로도 된다(분배 MONTI 5% / 주최자 95%).

**무대 행사 S(오늘 밤 폰 A에서 공개):** 이름 예 "MONTI Stage Demo", 티켓 종류 **Supporter $1**(필요하면 General 무료도),
**Revenue split** = 아티스트 60 / 공연장 20 / 기획 15 / MONTI 5%(MONTI 줄은 자동, Total 100% 강제).
아티스트·공연장·기획 줄의 **Set payout account**에는 데모용 테스트 수령 주소(`0x1111…`, `0x2222…`, `0x3333…` — 기존 리허설과 같은 값)를
보조가 미리 넣는다(0x 주소가 보이는 칸이라 **무대에서 열지 않는다**). $1 기준 분배 = **$0.60 / $0.20 / $0.15 / MONTI $0.05**.
수령 주소 입력이 번거로우면 1004처럼 **MONTI 5% / 주최자 95%**(기본값)로 공개해도 이야기는 성립한다($0.05 / $0.95).

### 2-1. 장면표

| # | 장면 | 화면(기기) | 누르는 버튼(화면 그대로 영어) | 예상 대기 | 무대 멘트(한국어) |
|---|---|---|---|---|---|
| 1 | 공개 정산 페이지 | 노트북 미러링 `/settlement/<S>` | (없음, 열어두기) | 즉시 | "공연 하나를 미리 열어뒀습니다. 수익은 아티스트 60·공연장 20·기획 15·MONTI 5%로 나뉜다고 **공개 전에** 못 박았고, 지금 이 페이지는 누구나 봅니다." (화면 제목 "How this event's revenue is split") |
| 1b | (옵션) 공개 한 번 | 폰 A, 미리 만든 **두 번째 초안** | **Publish** → 확인 시트 **Yes, publish it** → **Your event is live** | **약 7초** | "행사를 여는 데 버튼 한 번이면 됩니다. 분배 비율은 이 순간 고정되고, 그 뒤로는 아무도 못 바꿉니다." (공개 주소가 생김. 이 행사로는 결제를 하지 않는다 — 결제·입장은 S로) |
| 2 | 관객 시작 | 기기 B, `monti.despell.io` | **Get started** | **약 6–7초** → 홈(Explore) | "관객은 버튼 하나로 시작합니다. 가입 양식도, 비밀번호도, 설치할 앱도 없습니다." (이미 시작해 둔 브라우저면 이 장면 생략 — 바로 홈이 뜬다) |
| 3 | 행사 열기 | 기기 B, 홈 → 행사 S 카드 (또는 주소창 `/events/<S>`) | **Supporter · $1** 줄을 탭 | 즉시 | "티켓 종류를 고릅니다." (종류 줄을 누르면 그 종류가 골라진 채 받기 화면이 열린다. **Get a ticket** 버튼은 첫 종류(General)로 열린다) |
| 4 | 결제 | 기기 B, 받기 화면 | **Buy for $1** → **Card payment** 시트 → **Pay $1** (**한 번만**) | **약 3초**(2.8초 실측) → "Paid · your ticket is ready" | "테스트 결제로 1달러를 냅니다. 화면에도 '테스트 결제, 실제 돈은 안 나간다'고 떠요. 티켓이 나오고, 낸 돈은 **행사 금고에 잠깁니다**." |
| 5 | 영수증(보관 중) | 기기 B, **See receipt** (또는 **Tickets** 탭 → 티켓) | (자동 표시) | 즉시 | "영수증에 '**Payment held · paid out when you check in**' — 아직 아무에게도 안 갔고, 입장하는 순간 나뉩니다." 티켓 화면의 **No. xx-xxxx**(짧은 번호) 끝 4자리를 대표가 본다 |
| 6 | 입장(수동 승인) | 폰 A, 스태프 게이트 화면 | **Approve by hand** → 검색칸(Name or ticket number)에 **끝 4자리** → 사람 선택 → 사유(예: Phone trouble) → PIN → **Approve manually** → "They are in." | **약 2–3초** | "입장합니다. 스태프가 티켓을 확인하고 들여보내는 순간—" (브라우저 게이트는 NFC·QR을 못 읽는다. 처음부터 수동 승인으로) |
| 7 | **자동 분배** | 노트북 `/settlement/<S>` | (자동 갱신, 5초마다) | 승인 후 **약 1–5초** | "보세요, 방금 자동으로 나뉘어 들어갔습니다. 아티스트 60센트, 공연장 20센트, 기획 15센트, MONTI 5센트. 명목까지 다 공개됩니다." ("Latest payouts" 줄, "Paid out after check-in" 숫자) |
| 8 | 영수증 "분배 완료" | 기기 B, 영수증 | (자동) | 수 초 | "관객 영수증도 '**Paid out · split by the agreed shares**'로 바뀌고, 티켓은 **Checked in**입니다." |
| 9 | (옵션) 환불 | 기기 C(새 시크릿 창): Get started → S → **Supporter · $1** → **Buy for $1** → **Pay $1** → 영수증 **Get a refund** → **Refund this ticket?** → **Refund** | 시작 6–7초 + 결제 3초 + 환불 **약 4초** → **Refunded** | "입장 전이면 환불됩니다. 금고에 잠겨 있던 돈이 그대로 돌아가요. 이미 입장해서 나뉜 돈은 환불이 안 됩니다." (시간이 모자라면 말로만) |
| 10 | (옵션) 노쇼 설명 | 말로 | — | — | "안 온 사람(노쇼) 몫은 **행사 끝날 때** 정산합니다." |

> 1004로 진행할 때(수동 승인 장면 없음): 장면 1의 주소를 `/settlement/1004`로, 멘트를 "MONTI 5%, 주최자 95%"로 바꾸고
> 장면 6–8은 "입장하는 순간 이 비율로 나뉩니다"라고 말로 설명한다.

> **무대 원칙 5개** (무대 위에선 이것만 기억)
> 1. **시작한 그 기기·그 브라우저만 쓴다.** open 모드엔 복구가 없다 — 홈화면 앱으로 전환·다른 브라우저·시크릿 창을 쓰면
>    **다른 사람**이 된다(티켓도 주최자 권한도 안 보임). 무대 전 브라우저 데이터 지우기 금지.
> 2. **"Pay $1"은 한 번만 누른다.** "The payment didn't go through · nothing was charged"가 뜨면 티켓도 청구도 없는 것이니
>    **다시 눌러도 된다.** 아무 문구 없이 20초 넘게 멈춰 있을 때만 다시 누르지 말고 **Tickets** 탭을 먼저 확인.
> 3. **입장은 수동 승인으로**(티켓 화면 **No. xx-xxxx**의 끝 4자리로 검색).
> 4. **한 사람 한 장.** 무료를 받은 사람은 같은 행사의 유료를 못 산다 — 유료 장면은 처음부터 **Supporter**를 고른다.
> 5. **한 번에 한 사람만 조작.** 서버 예열은 보조가 §3 "T-30 / T-10 예열"로 해 둔다. 대표는 따로 할 일 없음.
>    목록(홈·Tickets)이 안 뜨면 **직접 주소**로 연다 — `/events/<id>`, `/claim/<id>`, `/tickets/<티켓번호>`, `/settlement/<id>`.

**핵심 사수 5개**(이것만 되면 스토리 완성): 분배 규칙 공개 → 결제(금고 보관) → **입장 시 자동 분배** →
**공개 정산 장부** → 영수증. 나머지(노쇼 자동화·환불 라이브)는 말로 설명해도 된다.

**결제 디테일 (보조 메모 — 기술 용어 허용, 무대에서 읽지 않음):** $1 = 1 USDC(6dp). 카드 UI만 목업이고, **돈의 이동(보관·분배·환불)은 Monad
테스트넷에서 진짜 테스트 USDC로 실제 실행**된다. 분배 수취인은 데모용 테스트 주소
(아티스트 `0x1111…`, 공연장 `0x2222…`, 기획 `0x3333…`), 플랫폼 5%는 Treasury `0xAe6D…6Bb2`.
정책 배열에서 **플랫폼 라인이 첫 번째**(row 0)임에 유의(화면엔 "MONTI platform"으로 표기).
주최자 화면은 이제 **행사 이름**을 보여 주고, 참석자 줄은 **닉네임** 또는 **"Guest · xxxx…xxxx"** 로 보인다.

---

## 3. 사전 체크리스트 (오늘 밤 리허설 / 당일 아침 / T-30)

### 반드시 지킬 5가지 (open 모드 기준 — 오늘 밤과 당일 아침에 각각 재확인)
1. **인덱서 `1b4098c` Active + 동기화.** `chain_metadata` 에서 **`is_hyper_sync: true`**,
   **lag(head − latest_processed_block) < 100 블록**(§3-15 4번).
2. **무대 기기는 "그 브라우저 그대로".** open 모드엔 복구가 없다. 폰 A(주최자·스태프)·기기 B(관객)는 오늘 밤 Get started 한
   브라우저를 그대로 들고 간다 — 브라우저 데이터 삭제·앱 재설치·다른 브라우저 금지. (옛 "미사용 테스트 번호" 규칙은 open 모드에선 해당 없음.)
3. **트레저리 USDC ≥ $60.** 지금 $52.5 → **대표 faucet 충전 요청 중**. 모자라면 결제창이 **즉시 실패**한다
   ("Payments aren't available right now…", 티켓·청구 없음). 트레저리 → v2 금고 **USDC 허용량 최대값**도 함께 본다(§3-15 2b).
4. **attester MON ≥ 1.5.** open 모드에선 **Get started 1번마다 ≈ 0.02 MON**이 attester에서 나간다(심사위원·관객 누구나 가입 가능).
   모자라면 deployer-v2에서 충전(§3-15 1b).
5. **MON: 릴레이어 ≥ 5, 트레저리 ≥ 1**(v2: 유료 발급·환불 가스를 트레저리가 냄). 부족하면 deployer-v2(`0x74f7…4eA2`)에서 충전.

> (기록) 10-09 v1 라이브 런에서 나온 원래 4가지는 "인덱서 1개만 Active", "새 번호로 가입(재설정 하루 한도)", "USDC ≥ $30×(건수+2)",
> "릴레이어 ≥ 5"였다. 번호 규칙은 open 모드로 없어졌고, 인덱서는 10-12 확인 결과 지금 플랜이 **동시 배포 3개까지** 허용한다
> (13:35 Envio 화면 "Active Commits (2/3)") — "1개만 돈다"는 옛 무료 플랜 기록이다.

### 준비 명령 공통 (보조)
```bash
export R=https://testnet-rpc.monad.xyz
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/MONTI-prod
```

### D-3 (10-10) — 인프라·잔액 확보 — **(기록: 완료, v1 시절 절차)**
1. **인덱서 1개만 Active + 동기화 lag < 10 블록** (가장 중요).
   - 현재 활성 0개. **보조**가 `mvp-settle-indexer`(커밋 9626cd6, SettlementVault 엔티티 포함)로
     hosted 빌드를 트리거(`git push origin mvp-settle-indexer:envio-release`), **대표**가 Envio
     대시보드에서 **빌드 초록 되면 오래된 배포부터 삭제**하고 새 id를 보조에게 전달.
   - **철칙(검증된 규칙):** 무료 플랜은 **한 번에 인덱서 1개만** 실제로 돈다. 죽은/멈춘 옛 배포가
     새 배포 시작을 막는다 → **옛 것을 먼저 삭제**하면 새 것이 보통 **20초 안에** 동기화를 시작한다.
   - 동기화 확인(새 id 넣어 실행):
     ```bash
     ID=<새_인덱서_id>
     curl -s "https://indexer.dev.hyperindex.xyz/$ID/v1/graphql" \
       -H 'content-type: application/json' \
       -d '{"query":"{ chain_metadata { chain_id block_height latest_processed_block num_events_processed is_hyper_sync } }"}'
     cast block-number --rpc-url $R     # 체인 head
     ```
     합격: `is_hyper_sync=true`, `num_events_processed>0`, **head − latest_processed_block < 100**.
     (무료 플랜은 stall-then-burst 가능 → **90초간 2~3회 샘플**해서 꾸준히 전진하는지 본다.)
   - 새 id 받으면 보조가 `functions/.env` `ENVIO_URL` + Vercel `VITE_ENVIO_URL`(prod+preview)에
     넣고 재배포. URL 형식 `https://indexer.dev.hyperindex.xyz/<id>/v1/graphql`.
2. **금고 USDC ≥ $30 × (구매 예정 건수 + 2)** (데모 1건 $90 / 2건 $120; **현재 $72.5 — 10-11 충전 후 $72.5 = $30 결제 2건분**, 무대 전 1회 더 충전 권장). 모자라면 **대표**가 `faucet.circle.com` → **Monad Testnet** 선택 →
   Treasury `0xAe6D18fA7dC1e2512a2dC7DaE1d4640D7D786Bb2` 로 수령(1회 한도면 여러 번/여러 날).
   확인: `cast call 0x534b2f3A21130d7a60830c2Df862319e593943A3 "balanceOf(address)(uint256)" 0xAe6D18fA7dC1e2512a2dC7DaE1d4640D7D786Bb2 --rpc-url $R` (6dp, 200000000 = $200).
3. **전송(릴레이어) MON ≥ 5 / 금고 MON ≥ 0.5 / 운영(deployer) MON ≥ 3.**
   ```bash
   cast balance 0xFA93A9dB40a4396a8CdcF63991FA8615d1A35fFd --rpc-url $R --ether   # 릴레이어 ≥5
   cast balance 0xAe6D18fA7dC1e2512a2dC7DaE1d4640D7D786Bb2 --rpc-url $R --ether   # 금고 ≥0.5
   cast balance 0x509ed82E0FCaE0c8A6cdE6Ddeb12eb5dc836BCf3 --rpc-url $R --ether   # 운영 ≥3
   ```
   부족하면 운영 지갑에서 충전(키는 화면에 안 띄움). MON faucet 도 Monad testnet 공식.
4. **금고 배선 확인:** `tokenAllowed(USDC)=true`, `depositor(treasury)=true` (10-09 둘 다 true).
5. **예치→입장→분배 라이브 1회 리허설**(지금껏 미검증 핵심). 금고 USDC 들어온 뒤 테스트 번호로
   결제→입장→공개 페이지 갱신까지 **실제로 한 번 돌려 본다.** 여기서 `deposit`/`release` 가스도
   첫 실측(설계 추정 deposit ~0.010 / release(4수취) ~0.022 MON 대조).

### D-1 (10-12 밤) — 오늘 밤 리허설 · 무대 행사 준비 (open 모드)

6. **(기록) 테스트 계정 초기화** — 전화번호 모드 시절 절차. open 모드에선 하지 않는다(초기화할 번호가 없고, 새 사람은 Get started로 만든다).
   `reset-persons.ts`는 phone 모드로 되돌릴 때만 쓴다(§4 "phone 모드로 되돌리기").
7. **무대 행사 S 공개 (폰 A, 대표가 직접).**
   - 폰 A로 `monti.despell.io` → **Get started** → 홈. 이 브라우저가 무대 내내 **주최자 + 스태프**다.
   - 홈 **Create an event** → 초안(이름·날짜·장소, 티켓 종류 **Supporter $1**(+ 원하면 General 무료)) →
     **Revenue split**: 아티스트 60 / 공연장 20 / 기획 15 (+ MONTI 5% 자동, Total 100%). 각 줄 **Set payout account**는 보조가
     테스트 주소(`0x1111…`, `0x2222…`, `0x3333…`)로 채운다(0x 주소 화면 — 미러링 금지). → **Publish** → **Yes, publish it** →
     **Your event is live**(약 7초; 첫 공개 땐 주최자 등록 1건이 앞서 붙음). 행사 번호 S(1005 이상)를 이 문서 첫 장에 적는다.
   - 확인: `/settlement/<S>` 에 규칙 렌더 + `getPolicy(<S>)` 합 10000·고정 + `eventStatus(<S>)=1`(§3-15).
   - (옵션, 장면 1b용) **두 번째 초안**을 하나 더 만들어 Publish 직전까지 채워 둔다(공개하지 않음).
8. **게이트 단말기 + PIN (폰 A).** 스태프 화면(`/staff/setup`) → **Register this gate device** → Event number에 S →
   **Request registration for this event** → 주최자 화면 `/org/events/<S>/gates` **Gate devices** → 대기 카드(**Gate device**) **Approve** →
   스태프 화면이 **Registered** → **Manual approval PIN** 설정(**Save PIN**).
   - 단말기 카드의 **Details**(Device ID / Check value X/Y)는 열지 않는다(기술 값).
   - 확인할 것(낮 Run 2에서 미확인): 등록 직후 주최자 게이트 목록에 단말기가 보이는지(인덱서 기반 — 안 보여도 입장은 된다).
   - 같은 폰 브라우저 하나가 주최자 + 게이트 단말기를 겸하는지 실제로 확인(v2 Run 1은 같은 계정으로 통과).
9. **드레스 리허설 full run (영어+open 빌드에서 처음):** §2 장면 2–9를 그대로 1회. 기기 B로 Supporter $1 결제 → 폰 A **Approve by hand** →
   공개 페이지 분배 → 영수증 "Paid out…" → 기기 C(시크릿 창)로 결제 → **Get a refund** → **Refunded**. 시간을 재서 §0 표와 비교.
   - 수동 승인·분배·환불은 오늘 낮(한국어 화면, 행사 1001–1003)에서만 통과했다 — **영어 문구·open 계정으로는 이 리허설이 첫 확인**이다.
   - 보조는 분배 누락 시 수동 `release` / 스케줄러 강제 실행(§4)을 손에 익힌다.
   - 리허설에 쓴 기기 B 계정은 이미 S의 티켓이 있으므로 **무대에서 S를 다시 살 수 없다.** 무대 관객은 ① 새 브라우저(새 Get started) 또는
     ② 리허설용과 다른 행사를 쓴다. 가장 단순: 리허설은 기기 B의 **다른 브라우저**로 하고, 무대용 브라우저는 Get started만 해 둔다.
10. **심사위원 경로 확인(행사 1004):** 새 시크릿 창에서 부록 A 안내문 그대로 1–3번(Get started → 1004 → Get a ticket → Tickets) 한 번.
11. **백업 영상 촬영**: 리허설 성공분(영어 화면)을 통째로 녹화.
12. **폰·네트워크·미러링**: 발표 기기 완충, 핫스팟(장내 와이파이 백업), 미러링 2분할(관객 기기 + 공개 정산 페이지) 테스트.

### 당일 아침 (10-13)
13. §0 잔액표 **재확인**(트레저리 USDC ≥ $60, MON 4종: 릴레이어 ≥5 · 트레저리 ≥1 · **attester ≥1.5** · deployer-v2 ≥3), 인덱서 lag<100.
14. 무대 행사 S·1004 **상태 재확인**: `/settlement/<id>` 렌더 + `Ticket.eventStatus(<id>)=1`.
15. **T-30 읽기 전용 점검**(보조, 아무것도 바꾸지 않는 조회만 — 충전 1b만 예외):
    ```bash
    export R=https://testnet-rpc.monad.xyz EV=<무대 행사 S>   # 심사위원 행사는 1004 — 두 번 돌린다
    export USDC=0x534b2f3A21130d7a60830c2Df862319e593943A3 TREASURY=0xAe6D18fA7dC1e2512a2dC7DaE1d4640D7D786Bb2
    export TICKET=0x8544c531A3EF7f702fe3A64Ff20D57bA774d9edC VAULT=0xDC3DDd274bb22a112ba8A120De471037aeE52925
    export ATTESTER=0x6af898aA4d99375839d7069431A7019a6D84C4Ed DEPLOYER_V2=0x74f75f4Dce3b04ea18f73E862b5a009781cE4eA2
    # 1) MON 잔액 — 릴레이어 ≥5, 트레저리 ≥1, attester ≥1.5, deployer-v2 ≥3
    cast balance 0xFA93A9dB40a4396a8CdcF63991FA8615d1A35fFd --rpc-url $R --ether
    cast balance $TREASURY --rpc-url $R --ether
    cast balance $ATTESTER --rpc-url $R --ether      # open 모드: Get started 1번 ≈ 0.02 MON
    cast balance $DEPLOYER_V2 --rpc-url $R --ether
    # 1b) attester < 1.5 이면 deployer-v2에서 충전(이 점검에서 유일한 쓰기). 키는 .secrets/deployer-v2.json 에서
    #     셸 변수로만 불러온다 — 파일 내용·키 값은 절대 출력하지 않는다(echo·cat 금지).
    #   cast send $ATTESTER --value 1.5ether --rpc-url $R --private-key "$DEPLOYER_V2_PK"
    # 2) 트레저리 USDC — ≥ 60e6 ($60)   (6dp: 60000000 = $60)
    cast call $USDC "balanceOf(address)(uint256)" $TREASURY --rpc-url $R
    # 2b) 트레저리 → 금고 USDC 허용량 — 최대값이어야 함 (115792089237316195423570985008687907853269984665640564039457584007913129639935)
    cast call $USDC "allowance(address,address)(uint256)" $TREASURY $VAULT --rpc-url $R
    # 3) 릴레이어 nonce — 두 값이 같아야 함(다르면 막힌 전송이 있음)
    cast nonce 0xFA93A9dB40a4396a8CdcF63991FA8615d1A35fFd --rpc-url $R
    cast nonce 0xFA93A9dB40a4396a8CdcF63991FA8615d1A35fFd --rpc-url $R --block pending
    # 4) 인덱서 1b4098c lag < 100 — 90초 동안 3번 샘플
    curl -s "https://indexer.dev.hyperindex.xyz/1b4098c/v1/graphql" -H 'content-type: application/json' \
      -d '{"query":"{ chain_metadata { chain_id block_height latest_processed_block num_events_processed is_hyper_sync } }"}'
    cast block-number --rpc-url $R
    # 5) 행사 상태 = 1
    cast call $TICKET "eventStatus(uint256)(uint8)" $EV --rpc-url $R
    # 5b) 금고 배선 — 둘 다 true
    cast call $VAULT "tokenAllowed(address)(bool)" $USDC --rpc-url $R
    cast call $VAULT "depositor(address)(bool)" $TREASURY --rpc-url $R
    # 6) 정산 문서
    curl -s "https://firestore.googleapis.com/v1/projects/mon-ti/databases/(default)/documents/settlements/$EV" | head -c 600
    # 7) 백엔드 함수·스케줄러·최근 오류 — 함수 us-east4(codebase v2). 스케줄러: v1(us-east1) 4개 PAUSED, v2(us-east4) 4개 ENABLED
    #    (relayerHealth 는 두 리전 다 ENABLED 일 수 있음 — 정상)
    gcloud functions list --regions=us-east4 --project=mon-ti --format="table(name,state)"
    gcloud scheduler jobs list --location=us-east4 --project=mon-ti --format="table(name,state)"
    gcloud scheduler jobs list --location=us-east1 --project=mon-ti --format="table(name,state)"
    gcloud logging read 'severity>=ERROR' --freshness=30m --project=mon-ti --limit=20
    # 8) 웹 응답 + 라이브 번들(영어·open)
    curl -sI https://monti.despell.io | head -1
    curl -s https://monti.despell.io | grep -o '<html lang="[a-z]*"\|index-[A-Za-z0-9_-]*\.js' | sort -u   # lang="en", index-O7hZzO-m.js (그 뒤 재배포 없었다면)
    scripts/ops/go-switch.sh status    # v2 주소 · us-east4 · envio 1b4098c
    # 9) 메타데이터 게이트웨이 — 200, <1 s 정상 (행사 제목·홈 목록용)
    curl -s -o /dev/null -w '%{http_code} %{time_total}' https://olive-high-octopus-713.mypinata.cloud/ipfs/bafkreidwm5mmjfpzfsqqlhcde4iawvzihl6y6ui7z6ixsyvoi2kqpsgw3a
    ```
    **브라우저 점검 2개(대표 또는 보조, 노트북):**
    - **새 시크릿 창에서 `https://monti.despell.io/start`** → **Get started** → **10초 안에 홈(Explore)** 이 뜨는지. (이 점검으로 가입 1건 ≈ 0.02 MON이 나간다.)
    - 그 홈 목록에 **행사 1004 "Monad Metropolis Demo Night"(+ 무대 행사 S, 장면 1b용으로 공개한 행사)만** 보이는지. 한국어 제목 행사(1001–1003)가 보이면 `VITE_HIDDEN_EVENT_IDS`가 빠진 배포다 → 보조에게.
    - 다 보면 시크릿 창을 닫는다(무대 기기 아님).

    합격: MON 4종 기준 충족 · USDC ≥ $60 · 허용량 최대값 · nonce 두 값 같음 · lag<100 꾸준히 전진 · `eventStatus=1` ·
    금고 배선 true/true · 정산 문서 존재 · 함수 ACTIVE · 스케줄러 상태가 위 기대와 일치 · 최근 30분 ERROR 없음(또는 설명 가능) ·
    `HTTP/2 200` · `lang="en"` · Get started < 10초 · 홈엔 1004(+S)만.
16. 폰 A·기기 B를 열어 **로그인이 그대로인지**(홈이 바로 뜨는지) 확인. 폰 A는 주최자 화면 `/org`에 S가 **이름으로** 보이는지, 스태프 게이트 화면이 열리는지.
17. 미러링·소리·백업 영상 파일 열어두기.

### T-30 / T-10 예열 — 보조 전용 (현재 운영)

**왜:** 10-12 v2 Run 1의 느린 구간(첫 공개 38초, 첫 결제 7.36초, 환불 6.77초)은 **전부 us-east4 함수 콜드 스타트**였다
(공개 = 콜드 5회 24.5초: createOrganizerForMe 3.75 · pinEventImage 6.69 · pinEventMetadata 3.66 · relayAction 5.55 · saveEventArt 4.87초;
결제 = purchaseTicket 콜드 4.28초, 예열 후 2.2초; 환불 = refundOrder 콜드 4.45초, 예열 후 ≈2.3초 추정). 코드 수정 없이 아래 두 겹으로 막는다.
인스턴스는 **약 15분 쉬면 내려간다.** 영수증 폴링(1초)·확정 리스너는 지연 원인이 아님(영수증은 전송 후 13–190 ms).

**(b) 최소 인스턴스 1 — 1차 방어 (지금 설정돼 있음: 10-12 14:40 설정, 16:40 functions:v2 재배포 뒤 재적용·15개 확인. 데모 끝나면 반드시 0으로)**
- 순서: **`firebase deploy --only functions:v2`를 할 때마다 → 그 다음에** 아래 명령. 배포가 새 리비전을 만들면서 최소 인스턴스를 **0으로 되돌리기** 때문에
  순서가 바뀌면 효과가 없다(배포를 다시 했으면 이 명령도 다시).
- 비용: 서비스당 하루 약 **$0.32**(1 vCPU, 512 Mi 대기) × 15개 ≈ 하루 $5 — 리허설+데모 창에만.
```bash
export CLOUDSDK_AUTH_ACCESS_TOKEN=$(GOOGLE_APPLICATION_CREDENTIALS=/Users/moomi/Downloads/z03.Vibe_Coding/MONTI/.secrets/monti-deployer.json gcloud auth application-default print-access-token)
STAGE="loginchallenge loginverify getsignupstatus startsignup registerpasskey registeridentity createorganizerforme pineventimage pineventmetadata relayaction saveeventart purchaseticket refundorder relaycheckin issuesnapshot"
for S in $STAGE; do
  gcloud run services update $S --min-instances 1 --region us-east4 --project mon-ti --quiet
done
# 확인 — 각 서비스에 minScale '1' 이 보여야 함
for S in $STAGE; do
  echo "$S $(gcloud run services describe $S --region us-east4 --project mon-ti --format='value(spec.template.metadata.annotations)' | grep -o "minScale[^;,]*")"
done
```
(Cloud Run 서비스 이름은 함수 이름의 **소문자**다. 토큰 값은 출력하지 않는다 — `export`만 하고 `echo` 금지.)
open 모드의 Get started 경로(`startsignup`·`registeridentity`·`getsignupstatus`)는 이 15개에 들어 있다. `loginchallenge`·`loginverify`·`registerpasskey`는
open 모드에선 안 쓰지만 phone 모드 복귀 대비로 그대로 둔다. 무료 받기(`relayClaim`)는 15개에 없고 아래 예열 루프에만 있다(예열 상태 1.8초 실측).

**(a) OPTIONS 예열 루프 — 2차 방어 (T-30에 1회, T-10에 1회, 무대 중엔 5분마다)**
OPTIONS 사전 요청(preflight)은 부작용 없이 인스턴스만 깨운다(로그인·결제 등 실제 동작 없음).
```bash
FNS="loginChallenge loginVerify getSignupStatus startSignup registerPasskey registerIdentity pendingOffers createOrganizerForMe pinEventImage pinEventMetadata relayAction saveEventArt setEventPrivate listAttendees listPinned purchaseTicket refundOrder submitPendingGate listPendingGates issueSnapshot listOverrideRequests relayCheckIn relayClaim"
warm() {
  for F in $FNS; do
    curl -s -o /dev/null -w "%{http_code} %{time_total}s $F\n" -X OPTIONS "https://us-east4-mon-ti.cloudfunctions.net/$F" \
      -H 'Origin: https://monti.despell.io' -H 'Access-Control-Request-Method: POST' \
      -H 'Access-Control-Request-Headers: authorization,content-type'
  done
}
warm; warm                                   # 첫 바퀴는 콜드면 3–7초씩, 두 번째 바퀴가 판정용
# 무대 동안 별도 터미널에서 5분마다(인스턴스는 ~15분 쉬면 내려감):
while :; do warm; sleep 300; done
```
합격: **전부 `204`**, **두 번째 바퀴는 모두 < 0.6초**. 204가 아니거나 두 번째 바퀴도 느리면 그 함수 이름으로
`gcloud functions describe <이름> --region us-east4 --project mon-ti`(ACTIVE인지) 확인.

**데모 후 정리 (체크리스트 — 빠뜨리면 하루 약 $5씩 계속 나감)**
- [ ] 최소 인스턴스 0으로 되돌리기(같은 `CLOUDSDK_AUTH_ACCESS_TOKEN` 준비 후):
  `for S in $STAGE; do gcloud run services update $S --min-instances 0 --region us-east4 --project mon-ti --quiet; done`
  (이후 `firebase deploy --only functions:v2`를 한 번 더 해도 0으로 돌아간다.)
- [ ] 예열 루프(`while :`) 터미널 종료(Ctrl-C).

### (기록) v2 전환(GO) — **10-12 14:45–14:50 실행 완료** · 보조 전용

> GO는 끝났다(`go-switch.sh go 1b4098c`, 세 번째 시도에 성공 — 스크립트 수정 2건은 커밋됨). 지금 운영 = v2 + 인덱서 `1b4098c`.
> 아래 GO 순서는 기록으로 남긴다. 그 뒤 16:40(백엔드 open 모드), 17:35·18:45·20:15(웹 영어·open·주최자 화면 정리)에 재배포가 있었다.
> 1번(계정 초기화)과 6번(새 가입)은 open 모드에선 해당 없음 — 새 사람은 Get started로 만든다.

**전제 — K6(인덱서 교체) 전에는 GO 불가.** 홈(둘러보기)·내 티켓 목록·주최자 대시보드(내 주최사 목록)는 **v2 인덱서에서만**
읽고 체인 폴백이 없다(10-12 확인). v1 인덱서(`d6a478c`)를 단 채로 전환하면 이 화면들이 비거나 v1 행사를 보여 준다.

**GO 순서 (기록) — 위에서 아래로, 건너뛰지 않는다:**
0. **K6 완료 확인:** 창업자가 Envio에서 v1 배포 삭제 → v2 푸시 → 새 id에서 `is_hyper_sync=true`, lag<100(§3 D-3 GraphQL).
1. **계정 초기화(웹 전환 전에):** 창업자 실번호, 그리고 v1에서 가입했는데 v2에서도 써야 하는 번호를 하나씩 지운다.
   **왜:** v1 계정은 v2에서 로그인은 되지만(서버가 체인을 안 봄) 첫 결제·입장에서 일반 오류로 실패하고, `/recover`도
   막힌다(v2 신원 장부에 없어서 재설정이 거절됨) — 새로 가입시키는 것 말고 길이 없다.
   ```bash
   cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/MONTI-backend
   export GOOGLE_APPLICATION_CREDENTIALS=/Users/moomi/Downloads/z03.Vibe_Coding/MONTI/.secrets/monti-deployer.json
   export DIDIT_API_KEY=$(firebase functions:secrets:access DIDIT_API_KEY --project mon-ti)     # 출력 금지
   fnm exec --using=22 pnpm --filter monti-functions exec tsx scripts/reset-persons.ts --phone +8210XXXXXXXX        # 드라이런(대상만 출력, 번호는 가려져 나옴)
   fnm exec --using=22 pnpm --filter monti-functions exec tsx scripts/reset-persons.ts --phone +8210XXXXXXXX --yes  # 실제 삭제
   ```
   - **`--all` 절대 금지**(단건 `--phone`만). 지우는 것: users·passkeys·devices·phoneIndex·Firebase Auth 사용자·행사 초안, persons는
     개인정보만 비우고 `deleted` 표시. 체인은 건드리지 않는다.
   - (같은 스크립트를 `cd MONTI-backend/functions && fnm exec --using=22 npx tsx scripts/reset-persons.ts …`로 돌려도 된다 — tsx가 로컬에 설치돼 있음.)
   - …17·…18·…20·…21–27은 v2에서 처음 가입했거나 미사용이라 초기화가 필요 없다.
2. **백엔드를 v2 인덱서로:** `MONTI-backend/functions/.env`의 `ENVIO_GRAPHQL_URL` = `https://indexer.dev.hyperindex.xyz/<v2 id>/v1/graphql`(값 출력 금지) →
   ```bash
   cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/MONTI-backend
   GOOGLE_APPLICATION_CREDENTIALS=/Users/moomi/Downloads/z03.Vibe_Coding/MONTI/.secrets/monti-deployer.json fnm exec --using=22 firebase deploy --only functions:v2 --project mon-ti
   ```
   (`--force` 금지 — 삭제 프롬프트가 뜨면 멈춘다.)
3. **최소 인스턴스 1:** §3 "T-30 / T-10 예열" (b) — **반드시 2번 배포 뒤에.**
4. **웹·스케줄러 전환:** `scripts/ops/go-switch.sh go <ENVIO_V2_ID>` (MONTI-prod 루트에서, id만 넣는다). 하는 일:
   - Vercel **저장된 Production env**를 v2 값으로 PATCH — `VITE_ADDR_{IDENTITY,ORGANIZERS,TICKET,FORWARDER,SETTLEMENT_VAULT}`(§0 v2 주소),
     `VITE_FUNCTIONS_REGION=us-east4`, **`VITE_ENVIO_URL`=v2 인덱서** — 후 저장값 대조(OK/BAD).
   - `MONTI-web`(브랜치 `v2/web`)에서 `vercel --prod` → 몇 초 뒤 **라이브 번들 점검**(v1 Ticket 0 · v2 Ticket >0 · us-east4 >0 · us-east1 0 · envio = v2 id).
   - 스케줄러 4개(reconcilePending·dailyExport·processDeletions·closeEndedChats): **v1(us-east1) 일시정지 / v2(us-east4) 재개**.
     relayerHealth는 손대지 않는다(5개 전부 멈추려면 아래 수동 명령).
   - 비밀값은 출력하지 않는다. `MONTI-web`이 `v2/web` 최신 커밋인지 스크립트 출력 첫 줄(`git log -1`)로 확인.
5. **확인:** `scripts/ops/go-switch.sh status`(라이브 번들 + 두 리전 스케줄러 상태) → 운영 스모크(`curl -sI https://monti.despell.io`, 로그인 화면,
   공개 정산 페이지) → §3 T-30 점검을 v2 주소로.
6. **새 가입:** (기록) phone 모드 시절엔 전환 후 `/signup/phone`에서 새로 가입했다. **지금은 open 모드 — Get started.** 옛 계정은 v2에서 쓰지 않는다.

수동 대안(스크립트가 중간에 실패했을 때만) — 스케줄러 5개 전부:
```bash
P=mon-ti
for J in reconcilePending dailyExport processDeletions closeEndedChats relayerHealth; do
  gcloud scheduler jobs pause firebase-schedule-$J-us-east1 --location=us-east1 --project=$P; done
for J in reconcilePending dailyExport processDeletions closeEndedChats; do
  gcloud scheduler jobs resume firebase-schedule-$J-us-east4 --location=us-east4 --project=$P; done
gcloud scheduler jobs list --location=us-east4 --project=$P --format="table(name,state)"   # 실제 job 이름 확인
```
웹 수동: Vercel Production env를 위 값으로 바꾼 뒤 `cd MONTI-web && vercel --prod --scope despells-projects`.


**대안·롤백 (09:00 이전에만) — 먼저 "무엇으로 돌아갈지"부터**

무대의 대안은 **지금 v2 빌드**다. 문제가 생기면 아래 순서로 가장 작은 조치부터 쓴다.

1. **웹만 이상할 때(20:15 배포 `monti-o8nqte5wu` 이후 회귀):** 직전에 ALL PASS한 v2 open+영어 배포 `monti-l2x6rn00p`(18:45)로 되돌린다 —
   `cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/MONTI-web && vercel promote https://monti-l2x6rn00p-despells-projects.vercel.app --scope despells-projects --yes`
   (Hobby 플랜은 `vercel rollback`이 직전 배포까지만 돼서 `promote`를 쓴다. 배포 URL은 Vercel 대시보드에서 한 번 확인. 이 배포엔 주최자 화면 정리
   (행사 이름·참석자 라벨·종류 줄 탭)가 없다 — 종류는 받기 화면의 **Ticket type** 선택칸으로 고른다.)
2. **가입(Get started)이 계속 실패할 때:** §4 "phone 모드로 되돌리기"(웹+백엔드 둘 다, 20–30분). 테스트 번호가 다시 필요해진다.
3. **v2 전체를 포기할 때(최후 수단):** `scripts/ops/go-switch.sh rollback`. **한국어 화면 + 전화번호 모드의 v1**이 돌아온다
   (영어·open 모드·행사 1004·심사위원 안내문 전부 무효가 된다). 하는 일:
   - `vercel promote https://monti-93g8r25jw-despells-projects.vercel.app`(v1 운영 배포, 재빌드 없음).
   - 저장된 Production env 7개를 `.secrets/vercel-production-v1.env` 백업값으로 복원(값은 출력하지 않고 OK/BAD만) → 라이브 번들 점검.
     (주의: `VITE_AUTH_MODE`·`VITE_HIDDEN_EVENT_IDS`는 백업 7개에 없다 — v1 번들은 이 값을 읽지 않으므로 무해.)
   - 스케줄러 4개: v2(us-east4) 일시정지 / v1(us-east1) 재개.
   - 그 뒤 최소 인스턴스 0(§3 예열 "데모 후 정리"), 인덱서는 v1(`d6a478c`)이 아직 Active인지 확인(지금 플랜은 동시 3개까지 허용 — 13:35 확인),
     §3 T-30 점검을 **v1 주소**로(§0 v1 열). 무대 계정은 v1에서 전화번호로 새로 가입해야 한다(남은 테스트 번호 …20, …28–…35).
4. 09:00 이후에는 배포·전환·롤백을 하지 않는다 — 막히면 백업 영상.

---

## 4. 장애 시나리오와 대처

| 증상 | 즉시 대처 | 멘트/대안 |
|---|---|---|
| **인덱서 멈춤/지연** | 발급·입장·정책·분배는 **체인 직접 읽기(chain fallback)로 계속 동작**(웹에 내장). 목록·공개 타일만 지연 | 공개 페이지 대신 **Monad 탐색기**에서 분배 tx(금고 `Payout`/`Settled` 이벤트) 링크로 보여주기. "장부는 체인에 이미 적혔고, 보기 화면만 잠깐 느립니다." |
| 인덱서가 아예 꺼짐 | **옛 배포 먼저 삭제 → 새 것 20초 내 시작**(§3-1). 그래도 -1이면 재빌드(README bump → envio-release) | 백업 영상 |
| **릴레이어 MON 부족** | deployer-v2(`0x74f75f4Dce3b04ea18f73E862b5a009781cE4eA2`)에서 `cast send <릴레이어> --value <N>ether`로 충전(키는 셸 변수로만) | — |
| **트레저리(금고) MON 부족** | 유료 발급·환불 가스를 트레저리가 냄 → 트레저리 MON ≥ 1 유지(10-12 저녁 3.39). 부족하면 deployer-v2(`0x74f75f4Dce3b04ea18f73E862b5a009781cE4eA2`)→트레저리 충전. 그 사이 결제는 실패(티켓·청구 없음). (기록: v1은 운영→금고 MON 충전, 예치는 금고가 서명) | — |
| **faucet 고갈/한도** | 미리 여러 날 나눠 채움. USDC는 Circle faucet, MON은 Monad faucet. 데모는 구매 1~2건이면 충분 | — |
| **결제 실패** (v2: 발급과 보관이 한 번에 처리되므로 "발급은 됐는데 돈만 처리 중" 상태가 없다) | 화면에 "**The payment didn't go through · nothing was charged. Please try again**" → **티켓 미발급·청구 없음, Pay $1을 다시 누르면 된다.** 반복되면 아래 "USDC 부족" 행과 트레저리 MON(≥1)을 점검 | "한 번 더 눌러 볼게요." |
| **금고(트레저리) USDC 부족** | 결제창에서 **즉시 실패**한다(화면: "**Payments aren't available right now. Please try again in a moment**"). 티켓도 청구도 없고 멈춤 상태도 없음. 충전 후 다시 누르면 됨. 예방: 트레저리 USDC **≥ $60** + 허용량(allowance) 최대값 유지(§3-15). 충전 경로: `faucet.circle.com` → **Monad Testnet** → Treasury `0xAe6D18fA7dC1e2512a2dC7DaE1d4640D7D786Bb2`. 10-12 19:00 **$52.5** → 대표 충전 요청 중. (기록: v1은 USDC가 모자라면 결제창은 성공으로 보이고 영수증이 "처리 중이에요"에서 영원히 멈췄다) | 충전 후 재시도, 안 되면 백업 영상 |
| **결제 확정이 느림/멈춘 것 같음** | 약 **20초** 동안 변화가 없으면 새로고침 → **Tickets** 탭(또는 `/tickets/<티켓번호>`)을 연다. (화면 문구 "This is taking a while. Your payment is going through…") 실패 문구가 뜨기 전까지는 **다시 결제하지 않는다**(이미 처리됐을 수 있음). v2는 이때 주문이 "전송됨(sent)" 상태로 남고 5분 주기 점검이 마무리한다 | "확정되는 데 몇 초 걸립니다." |
| **입장(NFC)** | 브라우저 게이트는 NFC·QR을 못 읽음(네이티브 스태프 앱 전용) → **처음부터 수동 승인(티켓 번호 검색)으로 진행** | — |
| **권한 없는 스태프의 "요청"(Send for approval)이 승인자 화면(Approval requests)에 안 뜸** | 요청은 서버에 기록되고 승인자(주최자) 화면에 **5초마다** 갱신되어 뜬다. 10초 기다린 뒤에도 없으면 새로고침. 그래도 없으면 **권한자가 티켓 번호로 직접 승인**(승인 1건이면 입장+자동 분배) | "승인 확인 중입니다." |
| **분배가 공개 페이지에 안 뜸** | ① 인덱서 지연이면 탐색기 tx로 대체 ② 분배 자체가 누락이면 아래 **수동 release** 또는 **스케줄러 강제 실행** | "지금 분배를 확정합니다"(탐색기로 전환) |
| **행사 제목이 안 뜸(영어 화면: "Loading the title…"가 오래 남음 등) / 홈 목록 비어 보임** (원인: 메타데이터 게이트웨이 지연) | `curl -s -o /dev/null -w '%{http_code} %{time_total}' https://olive-high-octopus-713.mypinata.cloud/ipfs/bafkreidwm5mmjfpzfsqqlhcde4iawvzihl6y6ui7z6ixsyvoi2kqpsgw3a` 로 확인(200, <1 s 정상). 느리면 Pinata 대시보드 Gateways 상태 확인; 무대는 직접 URL(`/claim/<id>`, `/tickets/<id>`, `/settlement/<id>`)로 진행 — 결제·입장·정산은 게이트웨이와 무관 | 제목·목록만 늦을 뿐 돈의 흐름은 그대로. (제목은 전용 Pinata 게이트웨이 `https://olive-high-octopus-713.mypinata.cloud/ipfs/`로 읽음 — Vercel `VITE_IPFS_GATEWAY`(prod+preview), 백엔드 `functions/.env` `IPFS_GATEWAY` (Picnic 플랜은 게이트웨이 1개 포함 — 2개째는 월 $5 초과 과금이므로 추가 게이트웨이는 만들지 말 것); 공용 `gateway.pinata.cloud`는 5–7초·타임아웃, 전용은 ~0.3초) |
| **Get started가 10초 넘게 안 끝남 / 오류 문구** | 한 번 더 누른다(이미 시작한 사람이면 토큰만 새로 받고 넘어간다). 반복되면 보조: attester MON(≥1.5), `startSignup`·`registerIdentity` 로그(§3-15 7번), 예열 루프 | "잠깐 서버를 깨우는 중입니다." 이미 시작해 둔 기기 B로 진행 |
| **attester MON 부족** (open 모드: Get started 1번 ≈ 0.02 MON) | deployer-v2(`0x74f7…4eA2`)에서 `cast send 0x6af898aA4d99375839d7069431A7019a6D84C4Ed --value 1.5ether`(키는 셸 변수로만, 출력 금지). 그 사이 새 가입만 실패하고 이미 시작한 사람은 영향 없음 | — |
| **"You already have your tickets for this event."** | 한 사람 한 장 규칙(정상). 같은 사람으로 다른 종류를 사려 한 것 → **다른 기기/새 시크릿 창(= 다른 사람)** 으로 진행 | "한 사람당 한 장만 받을 수 있게 막아 둔 겁니다 — 암표 방지예요." |
| **로그인이 풀려 Get started 화면이 다시 뜸** (브라우저 데이터 삭제·다른 브라우저·홈화면 앱) | open 모드엔 복구가 없다 → **새 사람**이 된다(티켓·주최자 권한 없음). 관객 기기면 그냥 Get started 후 계속. **폰 A(주최자)면** 수동 승인이 불가 → 승인 장면은 말로 + 백업 영상 | "새 기기로 바꾸면 새 사람이 됩니다 — 오늘은 데모 모드라서요." |
| **화면 공유/미러링 실패** | 즉시 **백업 영상** 재생으로 전환 | "미리 녹화해 둔 실제 실행 영상입니다." |

> **분배 누락 시 보조 조치(운영자 전용, 기술 용어 허용).** `settlementSweep` 콜러블은 **존재하지 않는다**
> (백엔드가 내보내는 건 `purchaseTicket/refundOrder` 등이고[v1은 `relaySetPolicy`도 있었음], sweep은 내부 예약 함수
> `reconcilePending`, 5분 주기). 실제로 쓸 수 있는 두 가지:
> 1. **수동 release(즉시).** 금고의 `release`는 누구나 호출 가능(permissionless). `.secrets/.env`의 키를
>    셸 변수로만 불러 두고(**절대 출력 금지**):
>    ```bash
>    # [v2 운영] 키는 v2 배포자(0x74f7…4eA2)용이 아니어도 무방 — release는 누구나 호출 가능
>    cast send 0xDC3DDd274bb22a112ba8A120De471037aeE52925 "release(uint256)" <tokenId> --rpc-url $R --private-key $DEPLOYER_PK
>    # [기록: v1] cast send 0xA84FDb64C9DDc3B25eF8BDeA58561BDbE53ABD69 "release(uint256)" <tokenId> --rpc-url $R --private-key $DEPLOYER_PK
>    ```
>    주문 기록(order)은 다음 sweep 때 스스로 맞춰진다.
> 2. **스케줄러 강제 실행.**
>    ```bash
>    # [v2 운영] (job 이름은 `gcloud scheduler jobs list --location=us-east4`로 확인)
>    gcloud scheduler jobs run firebase-schedule-reconcilePending-us-east4 --location=us-east4 --project=mon-ti
>    # [기록: v1]
>    gcloud scheduler jobs run firebase-schedule-reconcilePending-us-east1 --location=us-east1 --project=mon-ti
>    ```
>    sweep은 **최근 2분 안에 갱신된 주문은 건너뛰므로** 수동 승인 후 **2분 이상 지나서** 돌려야 의미가 있다.
>
> 입장 자체는 정산과 **독립** — release가 실패해도 입장 기록(usedAt)은 남는다.
>
> **운영자 팁 (phone 모드로 되돌렸을 때만) — 테스트 번호 가입 시 그림 퍼즐(reCAPTCHA) 건너뛰기.** 무대 폰에서 **테스트 번호**로 가입할
> 때, 가입 전에 브라우저 콘솔에서 `localStorage['monti:e2e']='1'` 을 넣어 두면 이미지 퍼즐이 안 뜬다.
> Firebase 테스트 번호에만 적용되고, 실제 번호는 여전히 퍼즐이 나온다.

### 인덱서(목록 서버) 멈춤 대비 — 되는 것 / 안 되는 것 / 무대 우회

이번 주 호스티드 인덱서가 **두 번 얼어붙었다(동결).** 10-09 데모 리허설은 인덱서가 멈춘 채로도
핵심 경로가 전부 돌았다 — 아래를 외워 두면 무대에서 인덱서가 죽어도 그대로 진행한다.

**인덱서 없이도 되는 것(체인 직접 읽기 폴백):**
- 주최자 **정산 설정의 가격 입력** 필드(행사 티어를 체인에서 읽음)
- 관객 **티켓 받기** 페이지(`/claim/<id>`) — 행사 소개 대신 **이 주소를 쓴다**
- 스태프 게이트 **등록·열기·PIN**(원래 체인만 읽음)
- **수동 승인** — 관객 티켓 상세에 적힌 **티켓 번호를 입력해 검색**(이름 아님)
- **티켓 상세 / 영수증 / 환불** — **직접 링크**(`/tickets/<tokenId>`)로 열면 뜸
- 공개 정산 페이지의 **분배 규칙**(`/settlement/<id>` 상단 "이렇게 나뉩니다")

**인덱서 없으면 안 되는 것(폴백 없음 → 우회 필요):**
- **둘러보기(Discover) 목록**, **내 티켓 목록 `/tickets`**(목록엔 폴백 없음)
- **행사 소개 페이지 `/events/<id>`**(인덱서에서만 읽음 → 대신 `/claim/<id>`)
- 게스트 명단 **이름 검색**(번호 검색은 됨)
- 공개 정산 페이지의 **실시간 타일 / 분배 내역**(0으로 뜸 → 탐색기 tx로 대체)
- [ ] 주최자 **등록된 게이트 목록 / "열기" 버튼** — 인덱서 동결 시 안 뜸(폴백 없음).
  **오늘 수정 중** → **확인 필요**: 당일 아침에 폴백 배포됐는지 체크(§3), 안 됐으면 백업 영상.
  **v2(운영):** 게이트는 신청→승인 1번에 바로 열려 "열기" 버튼 자체가 없다(닫은 뒤의 "다시 열기"만 남음). 10-12 Run 1은
  v2 데이터가 없는 v1 인덱서 상태에서 **신청 카드 표시 → 승인 → 등록·열림(4.73초)** 까지 통과했다(신청 목록은 서버에서 읽음).
  등록이 끝난 뒤 단말기 목록이 인덱서 없이 보이는지는 Run 1 기록에 없음 — **미확인**, 무대 리허설에서 확인.

**무대 우회(핵심):** 목록이 안 뜨면 **화면을 직접 주소로 연다** —
행사 `/claim/<id>`(`/events/<id>`는 인덱서 없으면 안 뜸), 티켓/영수증 `/tickets/<tokenId>`(체인 폴백으로 뜸),
공개 정산 `/settlement/<id>`.
입장(**수동 승인**)은 관객 티켓 상세에 보이는 **티켓 번호로 검색**해서 처리한다.
멘트: "장부는 체인에 이미 적혔고, 보기 화면(목록)만 잠깐 느립니다."

### 알려진 한계 / 데모 중 하지 말 것 (v2 운영, 운영자용)

- **환불한 티켓은 체인에서 무효화되지 않는다.** v2 금고의 `refund`는 돈만 돌려주고 티켓을 revoke하지 않는다(Run 1: 환불 후에도
  `isRevoked=false`, 소유자 그대로). 계약은 입장 때 보관 상태를 보지 않으므로 막는 건 앱·백엔드 몫이다.
  - **백엔드 가드 배포됨**(10-12 12:45, `8d8ba7e`; 낮 Run 2에서 환불 티켓 수동 승인 거절 확인): 게이트 입장(`relayCheckIn`)·수동 승인(`relayAction manualOverride`)·선물(`createOffer`)이 환불된 티켓을 거절하고,
    오프라인 명단(`issueSnapshot`)에서도 빠진다(2중 방어 — 명단 필터는 라이브 미검증). 계약 수준 수정(환불 → revoke)은 데모 후.
  - 관객 화면은 환불 티켓에 "**Refunded ticket · it can't be used to enter**"를 띄우고 **Enter** 버튼을 숨긴다. `/tickets/<id>/enter`·`/transfer` 주소를 직접 열어도 웹 가드가 막는다(7aedce1, 낮 Run 2 확인).
  - **무대에서 하지 말 것:** 환불한 티켓으로 입장·수동 승인·선물을 시연하지 않는다. 환불 시연은 "환불됨" 화면까지만.
- **오프라인 게이트 명단 창:** 단말기가 환불 **전에** 받아 둔 명단에는 그 티켓이 남아 있다 — 명단을 새로 받기(새로고침) 전까지 오프라인 확인에서 통과할 수 있다.
  환불을 시연했다면 그 뒤 게이트 화면에서 명단을 한 번 새로 받는다.
- **목록 화면은 v2 인덱서 필수:** 홈(Explore)·Tickets 목록·주최자 대시보드는 체인 폴백이 없다(인덱서 `1b4098c` 정상, K6 완료).
  인덱서가 멈추면 직접 주소(`/claim/<id>`, `/tickets/<id>`, `/settlement/<id>`)로 진행한다.
- **공개 시간:** 예열 상태 **6.6초**(10-12 저녁 Run 2), 콜드면 38초(10-12 오전 Run 1). 무대에서 공개(§2 장면 1b)하려면 T-10 예열 루프가 돌고 있어야 한다. 결제·입장을 할 행사 S는 미리 공개(§3 D-1 7번).
- **화면에 기술 값이 보이는 곳(무대에서 열지 말 것):** 기술 값은 이제 **Details** 접기 안에만 있다(10-12 11:15 숨김 작업 배포) — 스태프 `/staff/setup`·주최자 게이트 카드의
  **Details**(Device ID / Check value X/Y), Revenue split의 **Set payout account**(0x 주소), 티켓 상세 **Details**(전체 티켓 번호), 공개 정산 **Technical details**. 이 접기는 무대에서 펼치지 않는다.
- **영어 화면이 아닌 데이터:** 화면 문구는 전부 영어지만, 행사 제목·장소·분배 줄 이름은 주최자가 쓴 그대로 나온다. 무대 행사 S는 **영어로** 적는다.

### open 모드 한계 (해커톤 빌드) · phone 모드로 되돌리기

**한계 — 알고 쓴다:**
- **복구 없음.** 신원은 그 브라우저 안의 기기 키에 묶인다. 브라우저 데이터 삭제·다른 브라우저·시크릿 창·홈화면 앱 = **새 사람**.
  `/recover`는 "Start again on this device"(그 기기 키를 지우고 새로 시작)뿐이다. 옛 티켓·주최자 권한은 돌아오지 않는다.
- **누구나 신원을 만들 수 있다.** 전화번호·본인 확인이 없으니 한 사람이 브라우저를 바꿔 가며 여러 신원을 만들 수 있다
  → "한 사람 한 장"은 **신원(브라우저) 기준**이지 실제 사람 기준이 아니다. 가입마다 attester MON ≈ 0.02가 나간다(3.68 MON ≈ 180번).
  심사 질문에는 "데모 모드 — 실서비스는 전화번호 + 본인 확인을 켠다"로 답한다.
- **전화번호로 선물하기 불가.** **Give to a friend**의 전화번호(Phone) 방식·초대 수락·전화번호로 받는 사람 찾기는 phone 모드 전용이다.
  open 사용자끼리는 Nickname / Address 방식만 남는다(무대에선 선물 장면을 하지 않는다).
- **한 사람 한 행사 한 장.** General 무료를 받은 사람은 같은 행사의 Supporter를 못 산다(§2-0). 두 종류를 다 보이려면 두 기기.
- 아직 전화번호 전용인 백엔드 경로: 계정 재설정(`recoverAccess`), 문자 기반 기기 변경, 초대 수락(`acceptInvite`), 전화번호 선물 초대·수령인 검색.
- 스태프 등록 화면에서 로그인이 안 된 상태면 "Sign in with a phone number" 버튼이 보일 수 있다 → 무시하고 먼저 **Get started**.

**phone 모드로 되돌리기 (대안 — 계획 아님, 보조 전용, 09:00 이전에만):**
1. 웹: Vercel Production env `VITE_AUTH_MODE` → `phone`(또는 삭제 — 기본값이 phone) → `cd MONTI-web && vercel --prod --scope despells-projects` →
   `vercel promote <새 배포 URL> --yes`(도메인이 자동으로 안 붙는 경우가 있음, 10-12 확인).
2. 백엔드: `MONTI-backend/functions/.env`의 `AUTH_MODE=phone`(값 출력 금지) →
   `GOOGLE_APPLICATION_CREDENTIALS=/Users/moomi/Downloads/z03.Vibe_Coding/MONTI/.secrets/monti-deployer.json fnm exec --using=22 firebase deploy --only functions:v2 --project mon-ti`
3. **배포가 최소 인스턴스를 0으로 되돌리므로** §3 "T-30 / T-10 예열" (b)를 다시 실행(15개 확인).
4. 무대 계정은 전화번호로 새로 가입(남은 테스트 번호 …20, …28–…35, 코드 123456; 메모리 `monti-test-phone-numbers`). 테스트 번호 퍼즐 건너뛰기 팁은 아래 운영자 팁.
5. 부록 A 심사위원 안내문의 1번("no sign-up form")이 더 이상 맞지 않는다 → 대표에게 알린다.
- open 모드에서 만든 신원이 phone 모드에서 어떻게 보이는지는 **검증 안 됨** — 되돌리면 무대 기기도 새로 가입한다고 가정한다.


---

## 5. 심사위원 예상 질문 12개와 답

1. **왜 블록체인인가 / 왜 Monad인가?**
   분배 규칙과 기록을 **아무도 조작 못 하게 공개**하는 "프로그래머블 정산"이 본질. Monad는 ① 0.3초
   확정(입장=즉시 분배 체감) ② P-256 서명 가속기(폰 기기키 서명이 싸고 빠름) ③ 가스를 한도로
   과금하는 특성 — 이 교훈으로 비싼 페이마스터를 버리고 릴레이어 위임전송으로 단순화.
2. **가스 비용은?** 티켓 1장 전체 ≈ 0.075 MON ≈ **₩3**(발급+입장+예치+분배). 무료 행사 100명 ≈
   4.32 MON ≈ ₩173. 수수료가 가스를 ~650배 덮어 **비용은 제약이 아님**. (v1 실측 기준. **v2(운영)** 주최자 쪽 tx가
   6→3건, 유료 구매가 2→1건으로 줄었다. 10-12 v2 라이브 실측(102 gwei): 유료 티켓 1장(결제+입장 승인+분배) ≈ **0.096 MON**,
   환불 1장 ≈ 0.065 MON, 유료 행사 공개+게이트 1개 ≈ 0.114 MON(첫 공개 때 주최자 등록 +0.007), 가입 1건 ≈ 0.021 MON — §7.
   오늘 데모 빌드는 누구나 버튼 하나로 가입하므로 가입 비용(≈0.02 MON)을 우리가 낸다 — 실서비스는 전화번호 확인 뒤에만.)
3. **보안은?** 서명은 **기기 안에서 만든 P-256 기기키**로만(오늘 데모 빌드는 브라우저 안의 기기 키, 실서비스 phone 모드는 패스키 + 폰 보안 칩). 릴레이어는
   **가스만 대신 낼 뿐 발신자를 위조 못 함**(ERC-2771 신뢰 포워더 + 대상 allowlist). 릴레이어가
   모든 가스의 단일 지불처라 키·잔액 관리를 집중(향후 KMS 서명으로 강화).
4. **규제(한국)는?** 원화 스테이블 법이 2026-09를 넘겨 국회 11월경, 은행 51% 규칙도 미정 →
   당분간 원화 온체인 정산 불가. 그래서 **라이선스 PG(토스 등)·정산대행이 실제 돈을 집행**하고
   MONTI는 **규칙·장부(온체인=유일 진실원본)만** 제공 → 고객 돈 직접 보관·이체 안 함 →
   **전자금융업 등록 없이** 운영(법률 자문 확인 중).
5. **확장성은?** 데모·초기엔 입장마다 즉시 분배(push, 가장 단순). 전송량·가스가 실제 제약이 되면
   **"입장 시 장부 적립 + 종료 시 수취인별 1회 송금(sweep)"** 적립형으로 전환(100명 7.5→6.0 MON,
   전송 500→104건). D+1 일괄지급(토스/Eventbrite) 선례와 일치.
6. **수익 모델은?** 티켓당 **5% + ₩500 ≈ ₩2,000**(₩3만 기준). 정산 정책에 **MONTI 5% 고정 라인**으로
   온체인 자동 집행 — 수취 과정도 투명.
7. **암표는 어떻게 막나?** 티켓은 **본인 귀속**(기기키·신원에 묶임) → 자유 재판매 불가. 양도는
   온체인에 추적되는 명시적 동작뿐. 관객에겐 지갑·web3 단어가 안 보여 진입장벽도 없음.
   (오늘 데모 빌드는 전화번호 없이 시작하므로 "한 사람 한 장"은 브라우저 신원 기준이다 — 실서비스는 전화번호 + 본인 확인으로 한 사람을 묶는다. §4 open 모드 한계.)
8. **환불·노쇼는?** 입장 전 취소/주최자 행사취소 → payer(PG)로 **환불**. 미입장(노쇼)은 **행사
   종료 시** `settleNoShows`로 이해관계자에게 정산(공연 노쇼=구매자 귀책, 통상 무환불);
   `noShowRefund` 플래그로 환불 선택도 가능. 이미 입장·분배된 건 환불 불가. (소비자분쟁해결기준·
   법률 판단 영역.)
9. **다음 단계는?** ① **홀더 인증**(지갑 연결 + 토큰 게이트 행사) ② **KMS 릴레이어 서명**(키 보안)
   ③ **안드로이드 스태프 앱**(현장 NFC 전용). 한국 상용은 PG 집행 연동.
10. **이 데모는 진짜 온체인인가?** **카드 UI만 목업**이고, 예치·분배·환불 등 **돈의 이동은 Monad
    테스트넷에서 진짜 Circle 테스트 USDC로 실제 실행**된다. 핵심 4개 컨트랙트는 무변경, 금고 1개만
    추가했고 금고가 입장 사실(`usedAt`)을 **읽어** 분배하므로 **입장이 정산 때문에 실패할 일이 없다**.
    **[v2 운영]** 컨트랙트 5개를 새 주소로 다시 배포했고(§0), 결제는 금고가 티켓 발급과 대금 보관을 **한 번에**
    처리해 "둘 다 되거나 둘 다 안 되거나"가 체인 규칙으로 보장된다(유료 티켓을 돈 없이 발급할 길이 없음).
    입장 경로는 여전히 금고를 부르지 않아 정산 때문에 입장이 실패하지 않는다.
11. **입장 처리 후 분배가 얼마나 빨리 되나?** 입장이 확정되는 **즉시 약 1초 안에** 백엔드가 분배를
    바로 실행한다(인라인 릴리스 — 10-09 실측: 온체인 지연 ~1초, 관객 영수증은 ~4초 안에 "정산
    완료"로 바뀜). 혹시 그 즉시 실행이 누락돼도 **5분 주기 자동 정산(sweep)** 이 받쳐주므로 분배가
    빠지는 일이 없다.
12. **인덱서(목록 서버)가 멈추면 데모가 되나?** 된다. 발급·결제·정책 확정·입장·분배·영수증·환불
    같은 **핵심 경로는 체인을 직접 읽는 폴백으로 그대로 동작**하고, 10-09엔 실제로 인덱서가 멈춘
    채로 전 과정을 라이브로 통과했다. 둘러보기·내 티켓 **목록**과 실시간 타일만 지연되는데, 그때는
    **화면을 직접 주소로 열고**(행사/티켓/정산 링크), 수동 승인은 **티켓 번호로 검색**한다(§4 참조).

---

## 6. 당일 타임라인 · 역할 · 비상 연락

**역할**
- **대표**: 무대 발표, 폰 2대 조작(관객/관리자), 기기 서명·승인, 스토리 전달.
- **보조**: 맥북에서 잔액·인덱서 실시간 모니터, 장애 시 충전/수동 `release`·스케줄러 강제 실행(§4)/탐색기 전환,
  백업 영상 재생 대기.

**발표 전 90분 (분 단위)**

| 시각(T-) | 작업 | 담당 |
|---|---|---|
| T-90 | 잔액 재확인(트레저리 USDC ≥ $60 · 릴레이어 ≥5 · 트레저리 MON ≥1 · **attester ≥1.5** · USDC 허용량 최대값) + 인덱서 `1b4098c` lag<100 | 보조 |
| T-75 | 무대 행사 S·1004 상태 확인(`/settlement/<id>` 렌더 + `eventStatus=1`) | 보조 |
| T-60 | 폰 A·기기 B 로그인 유지 확인(열면 홈이 바로 뜨는지, 폰 A `/org`에 S, 스태프 게이트 화면 열림). **브라우저 데이터 지우기 금지** | 대표 |
| T-45 | 미러링 2분할·소리·네트워크(핫스팟 백업) 점검 | 둘 다 |
| T-30 | **T-30 점검**(§3-15: 잔액·attester·`/start` 시크릿 창 Get started <10초·홈엔 1004(+S)만) + 백업 영상 파일 열어두기, 공개 페이지 탭 준비. §3 "T-30 / T-10 예열": 최소 인스턴스 1 확인 + 예열 루프 2바퀴(전부 204, 2바퀴째 <0.6초) → 5분 주기 루프 시작 | 보조 |
| T-15 | 폰 완충·알림 끄기(방해금지), 대본 최종 리딩 | 대표 |
| T-10 | 보조가 예열 루프 1바퀴 더(2바퀴째 <0.6초 확인). 대표는 할 일 없음(무대 기기로 미리 결제하지 않는다 — 한 사람 한 장) | 보조 |
| T-5 | 인덱서 lag 마지막 확인, 릴레이어 잔액 마지막 확인 | 보조 |
| 0 | **발표 시작**(§1 스토리 → §2 라이브 시연) | 대표 |
| 발표 중 | 라이브 장애 시 §4 즉시 대처, 안 되면 백업 영상 | 보조 |

**비상 연락/채널**
- 운영 에이전트(보조) — 맥북 상주, 명령 즉시 실행.
- Monad Metropolis 지원 채널(해커톤 Discord/운영) — 장내 네트워크·미러링 하드웨어 이슈.
- Envio 대시보드(대표 계정) — 인덱서 배포 삭제/재빌드.
- Circle faucet(`faucet.circle.com`, Monad Testnet) / Monad MON faucet — 당일 긴급 충전.

> 무대 황금률: **막히면 멈추지 말고 백업 영상으로 전환**하고 스토리를 계속한다. 데모의 메시지는
> "입장 순간 자동·공개 분배"이지, 라이브 그 자체가 아니다.

---
## 7. 기술 부록 — 2026-10-09 라이브 런(Run 5) · 2026-10-10 최종 리허설(Run 7) tx 해시·가스 실측 (v1) · 2026-10-12 v2 forge 가스 + v2 Run 1 라이브 실측

> 무대용이 아니라 **보조·심사 질의용** 기록이다(기술 용어는 여기서만). 모두 Monad testnet 10143,
> RPC `https://testnet-rpc.monad.xyz`. 돈의 흐름 전체가 **행사 14번**에서 한 세션에 통과, 환불은
> **행사 13번** 금고로 증명됨. 인덱서는 이 내내 동결이라 전부 `cast` 로 체인에서 직접 읽었다.

**단계별 가스(릴레이어 EOA, MON) — 행사 14 실측:**

| 단계 | MON | 종류 |
|---|---|---|
| 행사 생성(createEvent, 주최자 등록 포함) | 0.0475 | 1회성 |
| 정산 규칙 확정(setPolicy) | 0.0436 | 1회성 |
| 공개(publish) | 0.0175 | 1회성 |
| 게이트 등록(registerGate) | 0.0275 | 1회성(게이트당) |
| 게이트 열기(openGate) | 0.0184 | 1회성(게이트당) |
| 결제+예치(purchase+deposit) | 0.0247 | 관객 1인당 |
| 입장 수동 승인 + **인라인 분배** | 0.0486 | 관객 1인당 |
| 환불(금고 키, 행사 13) | 0.0827 (릴레이어 아님, 금고 MON) | — |

- **100명 유료 정산 행사 ≈ 7.5 MON** = 1회성 ≈0.155 + 100 × (0.0247 결제 + 0.0486 입장+분배).
  설계 추정치 ≈7.5 MON과 일치. (QR 입장이면 수동 승인보다 조금 더 쌈 — 위 수동 승인 값은 상한.)
- 릴레이어 잔액 9.0315 → 8.6676 MON(Run 5 전체), 금고 MON 1.0 → 0.917(환불 1건).

**분배 금액(행사 14, 6dp 정확히 일치):** 아티스트 `0x1111…` +18(60%) · 공연장 `0x2222…` +6(20%) ·
기획 `0x3333…` +4.5(15%) · MONTI(플랫폼=금고) +1.5(5%) = 30 USDC. 온체인 `Paid` 로그 4건으로 확인
(수취 주소가 공유 테스트 주소라 잔액 증분이 아니라 로그로 증명).

**tx 해시(행사 14, 환불만 행사 13):**

| 단계 | tx 해시 | 비고 |
|---|---|---|
| 예치(deposit) | `0x8a54a059803f5c37842d4507f623783948b90ad22289c002ac618bd977a4d4a2` | 금고 USDC 30 HELD, payer=금고(treasury) |
| 입장 수동 승인(override) | `0xc38ef3d5be3ffd2b5db778cd075b9097c166ca36066c20270b6449c8e3bee3ba` | `usedAt` 기록(block 69550550) |
| **인라인 분배(release)** | `0x7a30e332433cde801cc94f7477246c2f1dccd905d11c47aa15876942fb4c3a59` | block 69550553 → override 대비 **~1초** |
| 환불(refund, 행사 13) | `0x6e0f9cacf36a48a6c70b5534ba0795f030dbb2c70688c0817a3a053fe4e9f1ce` | HELD→Refunded, 금고 USDC 30 원복 |

> 참고: 행사 14의 createEvent/setPolicy/publish tx 해시는 Run 5 보고서에 가스값만 있고 해시는
> 미기재(행사 9의 동일 단계 해시는 Run 3에 있음). 위 표는 이번에 처음 라이브로 증명된
> 예치→입장→분배→환불 4개 핵심 tx를 기록한다.

### Run 7 — 2026-10-10 최종 리허설 PASS (운영, 행사 15, $10 등급)

페르소나 테스트 번호 `+821000000011/12/13`. 웹 화면 클릭 기준 지연 포함.

| 단계 | tx 해시 | 지연 |
|---|---|---|
| 예치(deposit) | `0x9679d51114c1b8ccc1e9b82dfba2171a3bca9aa22649b956eed3d70f00662e4d` | 클릭→확정 9.45초 |
| 입장 수동 승인(override) | `0xa8b17b63d5246f29c1f3ccbb3dd03fa12f284670ee151d0f240f46f09c44bdbf` | 3.03초 |
| **인라인 분배(release)** | `0xcd4be9f593f9bef864a5addb778c27c6b55b8b11c083ae307ff5b99e786b61a4` | override와 **같은 초**; 영수증 "정산 완료"는 승인 클릭 후 7.57초 |
| 환불 구간 예치 | `0x7805d8dc3effad472737f3be44d67adfea8729079c76ee00c19911898769f294` | — |
| 환불(refund) | `0xdfe52e6a0b1519f9f603d6f49cc250a26ac70f80a72fee4e03f2032053d7bcf2` | 화면 "환불됨" 5.98초 |

- **분배 금액($10):** 플랫폼(MONTI) +0.5 · 아티스트 +6 · 공연장 +2 · 기획 +1.5 USDC.
- **Run 7 후 잔액:** 금고 USDC **$42.0**, 금고 MON 0.804, 릴레이어 MON 8.394, 운영(deployer) MON 44.7.
  릴레이어 MON 사용량(Run 7 전체) **0.249**.

### Run 8 — 2026-10-10 수정 후 회귀 PASS (운영, 행사 16, $10 등급)

페르소나 테스트 번호 `+821000000014/15/16`. 웹 화면 클릭 기준 지연 포함.

| 단계 | tx 해시 | 지연 |
|---|---|---|
| 예치(deposit, 본 구간) | `0xf0cb3d1cc23dbdae9061571a347f74531d2a41807afda5cb2ef1f56787625cfb` | 구매 클릭→확정 7.36초(Run 7 9.45초에서 단축) |
| 입장 수동 승인(override) | `0xbd1cdb0b736410b17d22d049fd2d57dcf7e845018ff6293ff96ed770d88e933c` | 2.99초 |
| **인라인 분배(release)** | `0x8e6350dc58a568b855c42947b696a9adaa55d4e0747a34c823249d9278cacb01` | 영수증 "정산 완료"는 클릭 후 7.56초 |
| 환불 구간 예치 | `0xeec51ae21364d191c1c3f32b7e98f0b0cd2f620c7e4992a4e86227eaeec993ec` | — |
| 환불(refund) | `0x124dec02b0fb95a68f3f992f0ed1e7584b0abae8fdb8679e02de9c8e081ebc35` | 화면 6.53초(새 확인 시트 포함) |

- **Run 8 후 잔액:** 릴레이어 MON 8.143, 금고 MON 0.735, 금고 USDC $32.5 → 10-11 faucet 충전 후 **$72.5**.

### v2 (10-12) — 트랜잭션 다이어트 rc1

> 위 Run 5/7/8은 모두 **v1** 기록이다. 아래는 v2 rc1의 forge 단위 가스(상태 변경 호출 1건당 gas)와 배포 기록,
> 그리고 테스트넷 라이브 실측(**v2 Run 1**, 맨 아래)이다. 구성 변경: 주최자 첫 판매까지 6→3건(`createOrganizer` 1회 · `publishEvent` 1건 ·
> `registerGate` 게이트당), 유료 구매 2→1건(`purchase`, 트레저리 전송), 수동 승인 권한자 1건, 닉네임 0건(서버 기록).

**배포 기록 (Monad testnet 10143, 시작 블록 70161104, 커밋 `130f425`, `Verify.s.sol` 19/19 OK):** Identity `0x1EDFE1BC…4B27` ·
Organizers `0x18134b64…3dca` · Ticket `0x8544c531…9edC` · Forwarder `0xcE6DC304…ddbb` · SettlementVault `0xDC3DDd27…2925`
(전체 주소는 §0). 새 배포자 `0x74f75f4D…4eA2`에 10 MON 이체(tx `0xf57fa8aa91f59534f4111502f3b5b763c3f74dda50a00049599f4ed80a27bef1`),
트레저리에 3 MON 이체(tx `0xa142dd93bc75e7c8d530116df46d5e3acc49d8b2159b9c154712e24f12502926`, 트레저리 3.73 MON),
트레저리 → v2 금고 USDC approve(max) tx `0xfbf5a4d52dcfa207ad8ec4412cef8f2a014d4c8dd2c5a4e49fd3e52c76d0f2bd`. 배포 9건에 약 1.7 MON 사용.

**forge 가스 표 (gas, MON 환산은 실측 후):**

| 단계 | forge gas | 누가 내나 | 메모 |
|---|---|---|---|
| 유료 행사 공개(`publishEvent`, 포워더 경유: 행사 생성 + 정산 규칙 + 공개) | **705k** | 릴레이어 | v1은 createEvent + setPolicy + publish 3건 |
| 무료 행사 공개(포워더 경유) | **348k** | 릴레이어 | 정산 규칙 없음 |
| 게이트 등록(`registerGate`, 열린 상태로 등록) | **210k** | 릴레이어 | v1은 registerGate + openGate 2건 |
| 유료 구매(`purchase` = 발급 + 보관) — 정상 상태 | **213k** | 트레저리 | 같은 영수증에 발급·보관 이벤트 |
| 유료 구매 — 첫 구매 | **300.5k** | 트레저리 | 첫 구매가 정상 상태보다 큼 |
| 입장(`checkInFor`) | **110.5k** | 릴레이어 | |
| 분배(`release`, 수취 4행) | **185k** | 릴레이어(인라인) | 수동 승인 확정 직후 같은 흐름에서 실행 |
| 환불(`refund`) | **57k** | 트레저리 | |

- 비교: v1의 유료 구매는 발급(mint) + 예치(deposit) 합계 약 411k였고, v2 첫 구매 300.5k는 그보다 작다(원장 기록 K1 시점 forge 비교).
- 위 값은 forge 기준이다. **라이브 gasUsed는 전 항목에서 forge보다 크다**(공개 830.6k vs 705k, 첫 구매 482.3k vs 300.5k, 게이트 288.4k vs 210k,
  분배 237.1k vs 185k, 환불 170.9k vs 57k) — MON 환산은 아래 라이브 표를 쓴다.
- **라이브 기준 MON 환산(102 gwei):** 유료 행사 1개 주최자 쪽(공개 + 게이트 1) ≈ **0.114 MON**(첫 공개 때 주최자 등록 +0.007) ·
  입장한 유료 티켓 1장(결제 + 수동 승인 + 분배) ≈ **0.096 MON** · 환불 티켓 1장(결제 + 환불) ≈ **0.065 MON** · 가입 1건 ≈ 0.021 MON.
  **100명 유료 행사 ≈ 0.121 + 100 × 0.096 ≈ 9.7 MON**(가입 제외, 계산값; 가입까지 치면 +2.1 MON). 원화는 §1의 v1 환산 비율(₩40/MON 상당)로 티켓 1장 ≈ ₩4.

### v2 Run 1 — 2026-10-12 라이브 실측 PASS (운영 도메인, 행사 1001, $10 등급)

B안-early: 스테이징 DNS가 없어 운영 `monti.despell.io`에 v2 웹(배포 `monti-3guo3as49`, entry `index-CdXsRmiB.js`)을 잠시 올려
하니스 V3(스모크)·V4(55 유료 본 구간)·V5(56 환불)를 돌리고 10:25에 v1(`monti-93g8r25jw`)로 되돌렸다. 01:04:44Z–01:11:03Z(10:04–10:11 KST),
블록 70261661–70262916, **세 구간 모두 첫 시도 PASS, 재실행 없음.** 이 구간에 다른 v2 tx 없음(v2 주소 5개 전수 확인).
인덱서는 v1(`d6a478c`) 그대로라 대시보드·공개 정산 실시간 타일·홈 목록은 비거나 v1 데이터(예상된 WARN).

**흐름별 tx·가스·지연** (전부 status 1, gasPrice 102 gwei, gasLimit = gasUsed → 수수료 = gasUsed × 102 gwei).
지연 열: **cold** = 이번 실측(함수 콜드 스타트 포함), **warm** = 예열 상태(실측이면 "실측", 아니면 콜드 스타트 시간을 뺀 **추정**).

| 흐름 | tx 수 | gasUsed | 수수료(MON) | 누가 내나 | 지연 cold | 지연 warm |
|---|---|---|---|---|---|---|
| 가입(`Identity.register`) ×3 | 1씩 | 209,254 / 209,241 / 209,267 | 0.02134 (각) | attester | 시작하기→준비 끝 **~15초**(첫 가입) | **~3초**(실측, 2·3번째 가입) |
| 주최자 등록(`createOrganizer`, 첫 공개 때 1회) | 1 | 68,196 | 0.006956 | **attester**(릴레이어 아님) | 공개 탭 후 ~4초에 확정(공개 흐름 안) | — |
| 행사 공개(`publishEvent`, 포워더 경유) | 1 | 830,596 | 0.084721 | 릴레이어 | "네, 공개할게요"→완료 화면 **38.0초**(주최자 등록 포함, 콜드 5회 24.5초) | **≈ 9–14초(추정)** |
| 결제 A(`Vault.purchase`, 첫 구매) | 1 | 482,309 | 0.049196 | 트레저리 | 결제하기→결제 완료 **7.36초**(purchaseTicket 콜드 4.28초) | — |
| 결제 B(`Vault.purchase`) | 1 | 464,660 | 0.047395 | 트레저리 | — | **2.20초(실측)** |
| 게이트 등록(`registerGate`, 열린 채 등록·`openGate` 없음) | 1 | 288,408 | 0.029418 | 릴레이어 | 등록→완료 **4.73초** | (relayAction은 이미 warm이었음) |
| 수동 승인(`manualOverride`, 포워더 경유) | 1 | 221,879 | 0.022632 | 릴레이어 | 승인→들여보냈어요 **3.02초**(하니스 폴링 기준) | 서버 처리 **1.8–2.1초**(로그 실측) |
| 인라인 분배(`Vault.release`, 백엔드) | 1 | 237,138 | 0.024188 | 릴레이어 | 승인과 **같은 초**에 확정; 영수증 "정산 완료" 승인 후 **~6–7초**(스크린샷 기준, 미검증) | — |
| 환불 B(`Vault.refund`) | 1 | 170,920 | 0.017434 | 트레저리 | 환불받기→tx **6.77초**(확인 시트 포함, refundOrder 콜드 4.45초; 하니스 관측 "환불됨" 9.0초) | **≈ 2.3초 + 확인 시트(추정)** |

- 결제 영수증 1건 안에 발급(ERC721 Transfer)·`Claimed`·USDC Transfer·`Deposited`가 함께 있다 — 발급만 되고 보관 안 된 상태가 없음.
- 주최자 온체인 쓰기: `createOrganizer, publishEvent, registerGate, manualOverride`, `organizerTxCount = 3`(설계 목표 충족; 주최자 등록은 1회성).
- 목표 대비: 결제 ≤5초 → cold **미달**(7.36) / warm 충족(2.20) · 수동 승인 ≤3초 → 3.02(하니스 폴링 탓, 서버 실측 충족) ·
  정산 완료 ≤8초 → 충족 추정 · 환불됨 ≤6초 → **미달**(6.77–9.0). 원인 = 콜드 스타트 → §3 "T-30 / T-10 예열".

**tx 해시:**

| 단계 | tx 해시 | 블록 |
|---|---|---|
| 가입 …17(주최자) | `0x7fb295cd23bfc831adebdb8c4afb532c7b975c58f8d0cf2fa42b8b0267fa9ca4` | 70261974 |
| 가입 …18(관객 A) | `0x67b3f716c36b72fe7c71cf58b5b7c917039105ae02113e92cb508adbeedf302f` | 70262268 |
| 가입 …21(관객 B) | `0x4fa7f73e3e3710638f365322332f45721d75ace0f7c72f95f435f192083349ee` | 70262613 |
| 주최자 등록(`createOrganizer`) | `0x4a6033b66f4749020d42f41f26c5995e9848c62472413a3879f7f59b177104d4` | 70262107 |
| 행사 공개(`publishEvent`) | `0x5823a824f7a5d50cbd0c9c939beaef7660b0a1103de7c6387477051e3871d9ef` | 70262186 |
| 결제 A(`purchase`) | `0x5999b516984e3c5f6c53e117145fc40333de5a3de03765957e2fc38f8082838e` | 70262346 |
| 게이트 등록(`registerGate`) | `0x47475a94a01b0a15832e7ef960d963a5bf410582d2c80ac181f252c329a6cfb9` | 70262422 |
| 수동 승인(`manualOverride`) | `0x60561fdcfd5d1e4c027bb21fd28ff7800e5524733283c1953baa60cad549d431` | 70262457 |
| **인라인 분배(`release`)** | `0xbce7ed238daf2253bb8036fc134808662e8ddd30d876f63a5c44c6e22340b36e` | 70262459 |
| 결제 B(`purchase`) | `0x825ed41e93ab2056e3658ab6d37808761d4df69c58b7750bd110173c36c54c1d` | 70262651 |
| 환불 B(`refund`) | `0x9e1ad57b7f8a409ee45d0d467eb3647b172a0422ff572892d59bc7a03c3f37e3` | 70262686 |

**행사·티켓:**
- **행사 1001** "정산 데모 공연 v2"(v2 첫 행사 번호). 등급 VIP: 1000 cents($10), 수량 50, 발급 2, `eventStatus = 1`.
- 정책 `getPolicy(1001)`: 플랫폼(트레저리) 500 bps `platform` · `0x1111` 6000 `artist` · `0x2222` 2000 `venue` · `0x3333` 1500 `planning`, frozen = true, version 1.
- 분배(release) 정확히 일치: 트레저리 +0.50 · `0x1111` +6.00 · `0x2222` +2.00 · `0x3333` +1.50 USDC.
- 게이트 **1**: `gateInfo(1)` = (행사 1001, 단말기 계정 `0xa88FF4423777c69408c71FeBb9b40FB21a473741`, open = true, revoked = false).
- 티켓 A `79307390676778601931137494286337`(serial 1): 관객 A 소유, `usedAt = 1791767325`, 보관 상태 **2 Released**.
- 티켓 B `79307390676778601931137494286338`(serial 2): 관객 B 소유, 보관 상태 **3 Refunded**, **`isRevoked = false`**(§4 "알려진 한계").

**사용한 번호(새 가입):** …17 = 주최자+스태프(주최자 계정 `0x940328f4A3bC5A895Bc9E4fd133f52863c8BdD8D`) · …18 = 관객 A(`0x6496199F7B18f13640CEF78354cb1dB42c58E7be`) ·
…21 = 관객 B(`0x3a41f56132Dd6e8ba26967D3aF45De59be4F0828`). …11은 스모크에서 기존 패스키 로그인만(tx 0). **미사용: …20(무대 관객 전용), …22–…27.**

**Run 1 잔액·사용량 (cast):**

| 계정 | 전 (01:04:44Z) | 후 (01:11:03Z) | 변화 |
|---|---|---|---|
| 릴레이어 `0xFA93…5fFd` MON | 5.921917 | **5.760959** | −0.160958 (공개 + 게이트 + 승인 + 분배, 정확히 일치) |
| 트레저리 `0xAe6D…6Bb2` MON | 3.725756 | **3.611731** | −0.114025 (결제 2 + 환불 1) |
| attester `0x6af8…C4Ed` MON | (직접 읽지 않음, 역산 1.533146) | **1.462158** | −0.070988 (가입 3 + 주최자 등록, 영수증 합) |
| 트레저리 USDC | 72.50 | **63.00** | **−9.50** (−10 A, −10 B, +10 환불, +0.50 플랫폼 몫) |
| 금고(v2 vault) USDC | 0 | 0 | 0 (A 분배 완료, B 환불, 보관 중 없음) |

- **Run 1 1회 비용: 0.345970536 MON**(릴레이어 0.160958 + 트레저리 0.114025 + attester 0.070988) + **USDC $9.5**(관객 결제 $10 2건 중 1건 환불, 플랫폼 몫 $0.5는 트레저리로 돌아옴).
- 다음 리허설·무대 전 기준: 릴레이어 5.76은 ≥5 기준에 근접 → 충전 권장. 트레저리 USDC $63은 "$30 × (구매 예정 + 2)" 공식(1건 $90)에 모자람.

### open + 영어 빌드 — 2026-10-12 저녁 라이브 검증 (운영 도메인)

**Run 1 (17:35 배포 `monti-6ubqnz0hl`) — BLOCKER, 수정 후 재배포.** open 모드에서 기기 서명이 필요한 쓰기(공개·무료 받기·결제·닉네임)가 전부
`NoPasskeyOnDevice`로 네트워크 요청 전에 실패 → 공개 화면 "Could not publish the event…". 둘째로 공유 링크(`/claim/<id>`) → Get started 뒤
홈으로 튕김. 통과: 리다이렉트(`/login`·`/signup/phone` → `/start`), Get started 4.8–6.6초, 로그인 유지(새로고침 3번 + 브라우저 재시작, 같은 계정),
UI 한글 0(옛 행사 1001–1003 데이터만 한국어). 부수 효과: **Organizer 1004 "Monad Metropolis"** 생성, 초안 b6432edc 저장.
수정(18:40, `v2/web`): 계정을 세션 claim에서 읽음(60b3b05), 퇴장 화면이 위치를 다시 읽던 문제(3ccc074), 숨김 행사 필터(a5c1f7d) → 18:45 배포 `monti-l2x6rn00p`.

**Run 2 (18:45 배포 `monti-l2x6rn00p`) — ALL PASS.**

| 단계 | 결과 |
|---|---|
| 홈 | 1001–1003 숨김, 공개 후 "Monad Metropolis Demo Night"만 |
| 공개(초안 b6432edc → **행사 1004**) | Publish → Yes, publish it → Your event is live **6.6초**, tx `0x9c116fc41dd43b3bff074034f61203c85dd4187e71f32e3a0b5c83d1dc7de09c`(block 70336556) |
| spec 59(심사위원 경로) | 2/2 — 새 Get started → 새로고침 유지 → 무료 받기(tx `0x2aa41a21…`) → Tickets; `/claim/1004` 로그아웃 상태 → Get started → 받기 화면 복귀 |
| 시간 | Get started **6.2초 / 7.0초**, 무료 받기 **1.8초**(tx `0xbff72974…`) |
| 유료 | Supporter **Buy for $1 → Card payment → Pay $1 → "Paid · your ticket is ready" 2.8초**, tx `0xfb19a20d58e0c2f8f208ba10f5914e63fda0b3793daadd04ebdae03f40cc6ec5`; 영수증 "$1 · Payment held · paid out when you check in", 분배 MONTI $0.05 / Organizer $0.95 |
| 영어 점검 | 화면 15개 한글 0 · 금지어 0(wallet/blockchain/crypto/NFT/token/gas/mint/web3/on-chain/smart contract/seed phrase) · 콘솔 오류 0 |
| 잔액 변화 | attester 3.684 → 3.599(−0.085, 신원 4개) · 릴레이어 7.543 → 7.417(−0.126, 공개+받기 3) · 트레저리 MON 3.435 → 3.387(−0.047) · 트레저리 USDC $53.5 → **$52.5**(금고에 $1.00 보관 중 — 입장 때 $0.05/$0.95로 나뉨) |

**20:10 주최자 화면 정리 → 20:15 배포 `monti-o8nqte5wu`(entry `index-O7hZzO-m.js`):** 주최자 목록·행사 화면에 **행사 이름**, 참석자 줄 **닉네임 또는 "Guest · 7954…7350"**,
대시보드 로딩 분리(공지 로더가 멈춘 것처럼 보이던 문제), 행사 화면 **티켓 종류 줄 탭 → 그 종류로 받기 화면**, 티켓 상세 하단 Enter 바가 입장 안내를 가리지 않음.

**아직 영어+open 빌드에서 안 돌린 것:** 수동 승인 · 자동 분배 · 환불 · 게이트 등록(낮 v2 Run 1·2에서는 한국어 화면으로 통과: 승인 2.96초, 환불 4.0초, 게이트 4.3초) → §3 D-1 9번 리허설.

---

## 부록 A. 심사위원 안내문 (영어 원문 그대로 — 대표에게 전달됨)

```
How to try MONTI (2 minutes, no sign-up form)
1. Open https://monti.despell.io on your phone or laptop and tap "Get started". Your pass is created on this device in a few seconds. You stay signed in on that browser.
2. Open "Monad Metropolis Demo Night" and tap "Get a ticket" (free), or pick "Supporter" ($1 test payment, no real money).
3. Your ticket appears under Tickets with a short ticket number. Open it to see the door instructions and Details.
4. Want to run your own event? Tap Create on the home screen: publish takes one tap, and the revenue split is set up front.
Notes: one ticket per person per event (use a second browser to try both ticket types). Payments are test funds held until check-in and then split automatically. All of this runs on Monad testnet; see Details on any screen for the technical record.
```

> 보조 메모(안내문은 고치지 않는다): 홈 화면 버튼의 실제 글자는 **"Create an event"** 다(안내문은 "Create"). 행사 1004의 링크:
> `https://monti.despell.io/events/1004` · `/claim/1004` · `/settlement/1004`.

## 부록 B. 화면 버튼 대조표 (옛 한국어 → 지금 영어)

무대에서 대표가 보는 글자는 오른쪽 열이다. 왼쪽은 이전 리허설·옛 런북에 나오던 한국어.

| 옛 한국어 화면 | 지금 영어 화면 | 어디서 |
|---|---|---|
| 시작하기 (전화번호·코드·패스키) | **Get started** | `/start` (가입 = 이 버튼 하나) |
| 탐색(둘러보기) / 행사 만들기 | **Explore** / **Create an event** | 홈 |
| 내 티켓 (탭 / 화면 제목) | **Tickets** (탭) / **My tickets** (제목) | 아래 탭 |
| 티켓 받기 | **Get a ticket** | 행사 화면·받기 화면 (무료, 첫 종류로 열림) |
| 티켓 종류 | **Ticket type** (예: **General**, **Supporter · $1**) | 받기 화면 / 행사 화면 종류 줄(탭 가능) |
| 결제하고 받기 $30.00 | **Buy for $1** | 받기 화면(유료) |
| 카드 결제 | **Card payment** | 결제 시트 |
| $30 결제하기 | **Pay $1** | 결제 시트 |
| 결제 완료 · 티켓을 받았어요 | **Paid · your ticket is ready** | 결제 완료 |
| 결제 금액 보관 중 · 입장하면 자동으로 나눠 보내요 | **Payment held · paid out when you check in** | 영수증 |
| 정산 완료 · 정해진 비율대로 나눠 보냈어요 | **Paid out · split by the agreed shares** | 영수증 |
| 티켓 번호 …(끝 4자리 굵게) | **No. xx-xxxx** (짧은 번호, 끝 4자리 = 수동 승인 검색값) | 티켓 상세 |
| 입장하기 | **Enter** | 티켓 상세 하단 |
| 입장 완료 | **You are in** (입장 화면) / **Checked in** (티켓 상태) | 관객 |
| 친구에게 주기 | **Give to a friend** | 티켓 상세 |
| 환불받기 | **Get a refund** → **Refund this ticket?** → **Refund** | 영수증 |
| 환불했어요 / 환불됨 | **Refunded** | 영수증·공개 정산 |
| 공개하기 / 네, 공개할게요 | **Publish** / **Yes, publish it** | 주최자 초안 |
| 행사를 공개했어요 | **Your event is live** | 공개 직후 |
| 정산(정산 규칙) / 수령 계정 정하기 | **Revenue split** / **Set payout account** | 주최자 초안 |
| 단말기 / 입구 단말기 / 게이트 단말기 등록 | **Gate device** / **Gate devices** / **Register this gate device** | 주최자 `/org/events/<id>/gates`, 스태프 `/staff/setup` |
| 단말기 식별값 / 확인값 X·Y | **Device ID** / **Check value X/Y** (Details 안 — 무대에서 열지 않음) | 스태프·주최자 |
| 이 행사에 등록 요청 / 등록 | **Request registration for this event** / **Approve** | 스태프 / 주최자 |
| 수동 승인 | **Manual approval** (화면 제목) | 스태프 게이트 화면 |
| 수동 승인하기 / 수동 승인(확정 버튼) | **Approve by hand** / **Approve manually** → "They are in." | 스태프 게이트 화면 |
| 공개 정산 페이지 "이렇게 나뉩니다" | **How this event's revenue is split** / **Latest payouts** / **Paid out after check-in** | `/settlement/<id>` |
