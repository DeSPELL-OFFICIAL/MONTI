# MONTI 프로그래머블 정산·수익분배 — 구현 계획 (2026-10-01)

설계: `2026-10-01-monti-settlement-split-design.md`(Q1–Q8: SplitPolicy·SettlementVault 인터페이스·
입장↔정산 결합·역할·가스재원·데모·비용·컴플라이언스). 이 문서는 **배치별 번호 작업**: 파일 · 수용기준
(AC) · 테스트 · 규모(S/M/L) · 의존 · 병렬.

- **제약(공통):** web3 낱말 금지(지갑/가스/체인/토큰/NFT/코인/서명), 가스 MONTI 대납(릴레이어 단일
  지불처), 폰 우선, 데모 2026-10-13. 토큰 = **Circle 테스트 USDC(10143)
  `0x534b2f3A21130d7a60830c2Df862319e593943A3`, 6dp**(주소 설정 가능).
- **핵심 원칙:** **핵심 4 컨트랙트(Ticket/Organizers/Identity/Forwarder) 무변경** — SettlementVault
  **1개만 신규**. 금고가 `Ticket.usedAt` 를 **읽어** 분배 → 입장은 정산과 독립(절대 revert 안 됨).
- **[T0 · 착수 게이트]** ① Circle USDC(10143) faucet 수령 + `transferFrom` 1건 라이브 확인(설계
  §8 미검증 항목). ② Monad P-256(0x100)은 Phase 1/2 실측 유효(setPolicy self-verify 전제).

배치 개요: **A 컨트랙트+테스트** → (**B shared/ABI** ‖) → **C 백엔드(트레저리/정산/장부)** →
(**D 주최자 정책UI** ‖ **E 공개 정산페이지** ‖ **F 관객 결제(목)·영수증**) → **H e2e+코스트** →
**I 배포/컷오버/문서**. A→C→(D‖E‖F)→H 가 임계경로. B 는 A1 직후 병렬. **스태프(G)는 무변경 — 회귀만.**

---

## 배치 A — 컨트랙트 + 테스트 (worktree MONTI-01b, branch mvp-settle, Foundry)

### A1 · L — SettlementVault 신규
- 파일: `contracts/src/SettlementVault.sol`(신규), `src/interfaces/ISettlementVault.sol`(신규),
  기존 `interfaces/{ITicket,IOrganizers,IIdentity}.sol` 재사용(읽기 전용).
- 내용(설계 §3): `struct Recipient/SplitPolicy/Escrow`, `policyOf/escrowOf/tokenAllowed/depositor/
  owed`, `SET_POLICY_TAG`+`policyNonce`. 함수: `setPolicy`(기기서명 self-verify P256 +
  `hasPermission(eventOrg,organizer,64)` + sum==10000 검증 + 첫입금 전만 + 동결), `setPolicyDigest`
  (public view), `deposit`(onlyDepositor, SafeERC20 transferFrom, token 허용목록), `releaseOnCheckIn`
  (permissionless, `ticket.usedAt(tokenId)!=0` 확인, push 분배 + 수취인별 `owed` pull 폴백, 멱등),
  `releaseMany`, `settleNoShows`(eventStatus==Ended, 유계 배치), `refund`(해제 전; 취소행사 누구나 /
  관객취소 adapter), `withdraw`(owed pull), 운영 `setTokenAllowed/setDepositor/pause`(owner).
  ReentrancyGuard + CEI(status 선변경). 이벤트 `PolicySet/Deposited/Settled/NoShowSettled/Refunded`.
- AC: 컴파일; `setPolicyDigest` 가 설계 바이트열 일치; 유효 정책 설정·동결; deposit 이 USDC 당김;
  입장(usedAt≠0) 후에만 release; push 분배가 bps 비례 정확; 블랙리스트 수취인 → `owed` 폴백+나머지
  성공; 취소행사 refund; **Ticket/Organizers/Identity/Forwarder 코드 0 변경**.
- 테스트: `test/SettlementVault.t.sol` — setPolicy(유효/합≠10000/권한없음/동결후거부/BadNonce/
  AuthExpired/위조서명), deposit(미인가토큰/미인가adapter), release(미입장거부/정확분배/멱등/폴백),
  settleNoShows(종료전거부), refund(해제후거부/취소행사), 재진입. P256 = `vm.signP256`.
- 의존: 없음. 병렬: A2(mock)와 병렬.

### A2 · S — 테스트용 mock tUSD + 토큰 설정
- 파일: `contracts/src/mocks/MockUSD.sol`(신규, 6dp ERC-20, 테스트·데모일 보험), `test/` 헬퍼.
- 내용: OpenZeppelin ERC20(6 decimals, `mint`). **데모 기본은 실물 Circle USDC**; mock 은 유닛테스트와
  faucet 장애 시 폴백.
- AC: 6dp; mint/transfer/approve 동작. 의존: 없음. 병렬: A1.

### A3 · M — 가스 실측 + 배포 스크립트
- 파일: `test/SettlementGas.t.sol`(신규), `script/DeploySettlement.s.sol`(신규).
- 내용: setPolicy/deposit/release(push 4수취)/settleNoShows/refund 실행 gas 실측 → 릴레이어 한도
  근거(설계 §6 추정 대체). 배포 스크립트: 기존 ticket/organizers/identity **주소를 생성자 주입**,
  depositor=Treasury, tokenAllowed[USDC]=true.
- AC: `forge test` green; SettlementGas 로그 확보; 배포 드라이런 성공. 의존: A1·A2. 병렬: 불가.

### A4 · S — 테스트넷 배포 + ABI export + deployments.json
- 파일: `packages/shared/src/deployments/10143.json`(+`vault`/`usdc` 키), `script/export-abi.sh`.
- 내용: SettlementVault 배포(시크릿 `.secrets/.env`) → `10143.json` 에 `"vault"`,`"usdc"` 추가(핵심 4
  주소 불변, `previous[]` 무관 — 핵심 재배포 없음). USDC 는 Circle 공식주소 기입. ABI export.
- AC: 신 vault 주소로 `setPolicy` 라이브 1건 성공(예: 데모 행사); 핵심 4 주소 불변. 의존: A3. 병렬: 불가.

---

## 배치 B — shared / ABI (MONTI-web `packages/shared`)

### B1 · S — setPolicy 다이제스트 + vault ABI/주소
- 파일: `packages/shared/src/encoding.ts`(+테스트), `src/abi/SettlementVault.json`, `src/deployments/*`,
  `src/constants.ts`(USDC 주소·6dp·`SET_POLICY_TAG`).
- 내용: `setPolicyPreimage/Digest`(sha256, 순서=컨트랙트와 일치), vault ABI, USDC 주소·decimals 상수.
- AC: shared 다이제스트가 컨트랙트 `setPolicyDigest` 와 동일 벡터; 타입체크. 의존: A1(디지스트), A4(주소).
  병렬: A2~A3 와 병렬.

---

## 배치 C — 백엔드 (MONTI-backend, branch mvp-settle, Functions us-east1)

### C1 · L — Treasury/adapter deposit + relaySetPolicy + 정산 트리거 콜러블
- 파일: `functions/src/functions/settlement.ts`(신규), `index.ts`(export), `lib/relayTypes.ts`.
- 내용(설계 §2~§4): (1) **구매 콜러블** `purchaseTicket`(mock 결제 성공 가정 → relayClaim 민팅 →
  Treasury 가 `approve`+`deposit(tokenId)` 제출). (2) `relaySetPolicy`(resolveCaller==organizer,
  sum==10000, `setPolicy` eth_call 시뮬 후 전송, `(organizer,policyNonce)` 멱등). (3) **CheckedIn
  이벤트 → `releaseOnCheckIn` 자동 제출**(기존 릴레이어; `relays/{id}` 상태). (4) `settleNoShows`/
  `refund` 콜러블(주최자/관객 조작). Treasury 키 = `TREASURY_PK`(Secret Manager, 릴레이어와 분리).
- AC: 결제→민팅→예치 성공; 정책설정 성공·시뮬 revert 매핑; 입장 후 자동 분배; 노쇼/환불 동작;
  멱등. 테스트: 에뮬레이터 + 모의 RPC. 통합: 테스트넷 1건. 의존: B1. 병렬: C2.

### C2 · M — 정산 장부 미러(공개 페이지용) + 규칙/인덱서
- 파일: `functions/src/functions/indexSettlement.ts` 또는 인덱서 핸들러, `firestore.rules`,
  `firestore.indexes.json`.
- 내용: `Settled/Deposited/NoShowSettled/Refunded` 이벤트 → `settlements/{eventId}` 미러(공개 읽기),
  사유 **원문**(reasonHash→문자열 매핑, 주최자 설정 시 저장)·태그 포함. 공개 읽기 규칙. **인덱서는
  표시용**(권위는 체인). Envio 스키마에 vault 이벤트 추가(또는 Functions 미러).
- AC: 공개 미러가 온체인 `Settled` 와 일치; 사유 원문 keccak 대조 통과; 공개 읽기 가능. 의존: A4.
  병렬: C1 과 부분 병렬.

---

## 배치 D — 웹 주최자 정책 UI (MONTI-web, branch mvp-settle, apps/web)

### D1 · M — 정산 정책 설정 화면
- 파일: `organizer/settlement/{PolicyEditor.tsx,usePolicy.ts}`(신규), 생성/공개 플로우 연결,
  `shared/chain/buildSetPolicy.ts`(신규).
- 내용: 이해관계자 행(지급 핸들→주소 해석·지분%·사유·태그), **합계 100% 강제**, MONTI 5% 고정 라인,
  `setPolicyDigest` 기기키 서명 → `relaySetPolicy`. **공개 전 설정·동결** 카피. web3어 0.
- AC: 정책 설정·동결 성공; 합계검증; 권한자만; web3어 grep 0. 의존: B1·C1. 병렬: E·F.

---

## 배치 E — 공개 정산 현황 페이지 (MONTI-web)

### E1 · M — 정산 현황 페이지(공개 링크)
- 파일: `public/settlement/{SettlementPage.tsx,useSettlement.ts}`(신규), 라우트(비로그인 접근).
- 내용: 행사별 총 모금액·이해관계자별 지급/대기(사유·태그)·티켓별 정산 로그·노쇼·환불.
  `settlements/{eventId}` 구독 + 실시간 갱신(입장 ~1초). "누구나 열람" 공개 링크.
- AC: 입장 시 ~1초 내 분배 반영; 사유·태그 표시; 비로그인 열람; web3어 0. 의존: C2. 병렬: D·F.

---

## 배치 F — 관객 결제(목)·영수증 (MONTI-web)

### F1 · M — 카드 결제(목업) + 영수증
- 파일: `attendee/purchase/{MockCheckout.tsx,Receipt.tsx,usePurchase.ts}`(신규), claim 플로우 연결.
- 내용: 유료 행사 "구매"→**카드 결제 화면(목업)**→`purchaseTicket` 콜러블→**영수증**(금액·행사·좌석).
  발급/입장 **무변경**. web3어 0(토큰/지갑 미노출).
- AC: 구매→민팅→예치→영수증 end-to-end; 무료 행사는 기존 경로 유지; web3어 0. 의존: C1. 병렬: D·E.

---

## 배치 G — 스태프 (무변경)

### G1 · S — 회귀만
- 내용: 게이트/체크인 **코드 변경 없음**. 입장 후 정산은 백엔드 트리거라 스태프 앱 영향 0.
- AC: 기존 체크인 회귀 green. 의존: 없음. 병렬: 상시.

---

## 배치 H — e2e + 코스트 (apps/web/e2e)

### H1 · M — 데모 시나리오 e2e + 코스트
- 파일: `e2e/tests/40-settlement.spec.ts`(신규), 잔액/USDC 폴러.
- 내용(설계 §5): 정책설정→구매(목결제→예치)→입장→**~1초 분배 검증**(수취인 USDC 증가 + Settled)→
  노쇼 종료정산→행사전 환불. 릴레이어/Treasury MON·USDC 차 합산 → 100명 추정 대조(설계 §6).
- AC: 전 단계 green; 분배액 bps 정확; 공개 페이지 반영; **입장이 정산 실패와 무관함**(release 끊어도
  check-in green) 확인. 의존: C·D·E·F. 병렬: 불가.

---

## 배치 I — 배포 / 컷오버 / 문서

### I1 · S — 배포 + 문서
- 순서: mvp-settle(contracts) → backend → web → e2e → mvp. 파이프라인: vault/USDC 주소 → shared →
  Functions env(`TREASURY_PK`) → Vercel env → 웹 배포 → 인덱서/미러. **모든 env GET 실재확인 후
  설정**(교훈). Treasury 사전 충전(USDC+MON) + 잔액 경보(릴레이어 패턴).
- 문서: abi-delta(vault·USDC), device-day-runbook(Treasury 충전·정산 트리거), 본 2문서.
- AC: 전 경로 신 vault 주소 정합; 데모 행사 1건 end-to-end 라이브. 의존: H. 병렬: 문서는 상시.

---

## 병렬화 · 규모
- **임계경로:** T0 → A(1‖2→3→4) → C(1‖2) → (D‖E‖F) → H → I. B 는 A1 후. G 무변경(회귀만).
- **규모 합계:** A: L1+S2+M1 · B: S1 · C: L1+M1 · D: M1 · E: M1 · F: M1 · H: M1 · I: S1.
  ≈ **에이전트 작업 9~12일**(A1·C1 이 무거움).

## 12일 캘린더 (2026-10-01 → 10-13)
| 일자 | 작업 |
|---|---|
| D1 10-01 | **T0**(USDC faucet+transferFrom 확인), A1 착수 ‖ A2 |
| D2 10-02 | A1 완료 + 테스트, B1 병렬 |
| D3 10-03 | A3 가스실측 + 배포스크립트 |
| D4 10-04 | **A4 테스트넷 배포** + deployments.json, B1 주소동기 |
| D5 10-05 | C1 백엔드(purchase/relaySetPolicy/release 트리거) |
| D6 10-06 | C1 완료 + C2 장부미러/규칙 |
| D7 10-07 | C 통합(테스트넷 1건) + 백엔드 배포 |
| D8 10-08 | **D 정책UI ‖ E 공개페이지 ‖ F 결제·영수증**(병렬) |
| D9 10-09 | D·E·F 완료 + 배선 |
| D10 10-10 | 통합 + G 회귀 + 공개페이지 실시간 확인 |
| D11 10-11 | **H e2e 데모 시나리오 + 코스트 실측** |
| D12 10-12 | **I 배포/컷오버** + 드레스 리허설 + 버그픽스 |
| D13 10-13 | **데모일**(오전 버퍼) |

## 늦으면 자를 것 (우선순위 역순 — 핵심 스토리는 사수)
1. **settleNoShows 자동화 컷** → 수동 버튼 또는 데모서 노쇼 생략.
2. **refund 컷** → 데모서 환불 생략(또는 목업 전용).
3. **setPolicy 기기서명 컷** → 신뢰 백엔드가 설정(약함, §8 — 데모 한정 허용).
4. **pull 폴백 컷** → 순수 push(데모 수취인은 통제되어 블랙리스트 없음).
5. **공개페이지 폴리시 컷** → 최소 읽기 전용 목록.
6. **적립형 미구현**(어차피 범위 밖 — push 만).
- **절대 사수:** setPolicy + deposit + **releaseOnCheckIn(입장 시 자동 분배)** + **공개 정산 장부** +
  영수증. 이 5개가 "왜 블록체인 = 프로그래머블 정산" 스토리의 전부.

## 검증 체크리스트
- [ ] T0: Circle USDC(10143) faucet 수령 + `transferFrom` 라이브 1건; P-256(0x100) 유효.
- [ ] `forge test` green(SettlementVault + 재진입 + 폴백) + SettlementGas 실측.
- [ ] **핵심 4 컨트랙트 코드 0 변경**(git diff 0) — Ticket/Organizers/Identity/Forwarder.
- [ ] `releaseOnCheckIn` 이 `usedAt!=0` 에서만 분배 + 멱등 + bps 정확 + 블랙리스트 폴백.
- [ ] **입장이 정산과 독립**(release 콜러블 끊어도 check-in green) — 안전 결합 확인.
- [ ] setPolicy 합계 100% 강제 + 첫입금 동결 + 권한(소유자/비트64).
- [ ] 공개 정산 페이지 입장 ~1초 반영 + 사유 원문 keccak 대조 + 비로그인 열람.
- [ ] 결제(목)→민팅→예치→영수증 end-to-end; 무료 행사 기존 경로 무변경.
- [ ] 코스트: 100명 유료 추정(push ≈7.5 / 적립 ≈6.0 MON) 실측 대조; 수수료 커버 확인.
- [ ] Treasury 충전(USDC+MON) + 잔액 경보; `TREASURY_PK` 릴레이어와 분리.
- [ ] web3 금지어 grep 0(정책UI·공개페이지·결제·영수증 신규 카피).
- [ ] 토큰 주소 설정 가능(허용목록) — 원화 스테이블 추가 대비.

## 롤백 노트
핵심 4 무변경이라 **롤백 격리**: vault 만 되돌리면 됨(deployments.json 에서 `vault`/`usdc` 제거 →
결제/정산 UI 숨김 → 웹 재배포). 티켓/입장/신원은 전혀 영향 없음(정산은 독립 레이어). 데이터
마이그레이션 없음.
