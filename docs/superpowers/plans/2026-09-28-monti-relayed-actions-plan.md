# MONTI 관객 동작 릴레이 전환 — 구현 계획 (2026-09-28)

설계: `2026-09-28-monti-relayed-actions-design.md`(Q1–Q9 결정·근거·시그니처·다이제스트·
Firestore·콜러블·가스표). 이 문서는 **워크트리/브랜치별 번호 작업**으로만 구성. 각 작업:
파일 · 수용기준(AC) · 테스트 · 규모(S/M/L) · 의존 · 병렬 가능.

- **제약(전 작업 공통):** web3 낱말 금지, 가스는 MONTI 대납, 폰 우선, 데모 2026-10-13.
  **컨트랙트 변경 시 재배포 필수(창업자 룰)** → 신주소 파이프라인 전부 갱신.
- **[T0 · 착수 게이트]** Monad 테스트넷 P-256 precompile(0x100) 라이브 실측 통과 전에는
  어떤 작업도 병합 금지(설계 §11-1). 실패 시 계획 전면 재검토(폴백 ~330k/검증 → 목표 붕괴).

배치 개요: **A 컨트랙트+테스트** → (**B shared/ABI/배포** ‖ 준비) → **C 백엔드 콜러블/규칙/모니터**
→ (**D 웹 관객** ‖ **E 웹 스태프/안드로이드**) → **F e2e+코스트** → **G 컷오버/문서**.
A→C→(D‖E)→F가 임계경로. B는 A 직후 병렬 착수 가능.

---

## 배치 A — 컨트랙트 + 테스트 (worktree MONTI-01b, branch mvp-01b, Foundry)

### A1 · M — Ticket: claim 승인서 인프라
- 파일: `contracts/src/Ticket.sol`(+ 필요 시 `src/interfaces/ITicket.sol`).
- 내용: `struct ClaimAuth`, `CLAIM_AUTH_TAG`, `mapping(address=>uint256) public claimNonce`,
  `claimAuthDigest(ClaimAuth) public view`, `_verifyClaimAuth` private(deadline·nonce·isMember·
  !isLocked·P256 over digest·nonce++), 에러 `AuthExpired`/`BadNonce`.
- AC: 컴파일 통과; `claimAuthDigest`가 설계 §2 바이트열과 일치; ContractSize.t.sol 한도 유지.
- 테스트: `test/TicketClaimFor.t.sol`(신규) — 유효 승인 통과, 잘못된 nonce=BadNonce, 만료=
  AuthExpired, 잠금=DeviceLocked, 비멤버=NotMember, 위조 서명=BadDeviceSignature, nonce 재사용
  차단. P-256 서명은 `vm.signP256` + `test/utils/P256Vectors.sol` 확장.
- 의존: 없음. 병렬: A2와 병렬 가능(다른 함수군).

### A2 · M — Ticket: claimFor/requestClaimFor + 직접 claim 제거
- 파일: `contracts/src/Ticket.sol`.
- 내용: 기존 `claim`/`requestClaim` 본문을 `_claimTo(eventId,tier,to)`/
  `_requestClaimFrom(eventId,tier,requester)`로 추출; `claimFor`/`requestClaimFor` 추가
  (`_verifyClaimAuth` 후 내부 호출); **직접 `claim(uint256,uint8,bytes)`·`requestClaim(uint256,uint8)`
  제거.** 이벤트 Claimed/ClaimRequested 그대로.
- AC: claimFor가 Claimed(tokenId,eventId,account,tier) 방출; requestClaimFor가 ClaimRequested
  방출; 공급 예약·maxPerWallet(발급+대기 합)·승인제 분기 동작 동일; 직접 claim 심볼 부재.
- 테스트: `TicketClaimFor.t.sol` 확장(민팅·품절·한도·KYC·판매창·승인제 신청). 기존
  `TicketClaim.t.sol`은 claimFor 헬퍼로 이전(또는 대체).
- 의존: A1. 병렬: 불가(A1과 같은 파일군).

### A3 · M — Ticket: checkInFor/checkInForLate (게이트 서명 온체인 검증)
- 파일: `contracts/src/Ticket.sol`.
- 내용: `checkIn`/`checkInLate` → `checkInFor`/`checkInForLate`(gateSig 파라미터 추가).
  `_admit`에서 `isOpenGate(eventId,msg.sender)`+`gateOf(msg.sender)==g.gateId` →
  `gateInfo(g.gateId)`로 (kx,ky,open,revoked,eventId) 검증 + `sha256(abi.encode(gateId,eventId,
  issuedAt,nonce))`에 대한 gateSig P256 검증(에러 `BadGateSignature`). 나머지 `_admit` 무변경.
  CheckedIn/CheckedInLate 그대로. **Organizers.sol 무변경**(gateInfo 재사용).
- AC: 릴레이어(임의 msg.sender)가 유효 튜플로 입장 성공; 게이트 서명 위조=BadGateSignature;
  폐기 게이트=GateNotOpen(온·오프라인); late는 open 불요·revoked 금지; 1회 입장 유지.
- 테스트: `test/TicketCheckIn.t.sol`·`TicketCheckInLate.t.sol` 갱신(msg.sender=릴레이어 +
  gateSig 추가), 이중입장/폐기/신선도 케이스 유지.
- 의존: 없음(A1/A2와 독립 함수군). 병렬: A1/A2와 논리상 병렬이나 같은 파일 → 순차 편집 권장.

### A4 · M — 테스트/픽스처/가스/시드 이전
- 파일: `contracts/test/CheckInGas.t.sol`, `test/Base.t.sol`, `test/utils/P256Vectors.*`,
  `script/Seed.s.sol`, (신규) `test/ClaimGas.t.sol`.
- 내용: 픽스처의 `ticket.claim(...)` → `_claimForFixture`(ClaimAuth 서명) 헬퍼로 교체.
  CheckInGas는 checkInFor(+gateSig)로 측정, 상한 200k 유지 확인. **ClaimGas.t.sol 신규**로
  claimFor 실행 gas 실측(설계 §11-2, 한도 산정 근거). Seed를 claimFor/checkInFor로 갱신.
- AC: `forge test` 전부 green; CheckInGas < 200k; ClaimGas 로그로 claimFor 실측 확보; 금지
  심볼(직접 claim) 사용처 0.
- 테스트: 전체 스위트 + `[profile.ci] fuzz=512`.
- 의존: A1·A2·A3. 병렬: 불가.

### A5 · S — 재배포 + ABI export + 배포 파일 갱신
- 파일: `script/Deploy*.s.sol`(무변경 예상), `contracts/deployments/10143.json`,
  `contracts/deployments/seed-10143.json`, `script/export-abi.sh`.
- 내용: Monad 테스트넷 재배포(시크릿은 `.secrets/.env`만, 출력 금지) → 신주소 `10143.json`
  기록 + `previous[]`에 구주소 append. `export-abi.sh`로 `packages/shared/src/abi/*.json` 갱신.
- AC: 신주소로 checkInFor/claimFor 라이브 1건씩 성공(P-256 실측=T0 겸함); previous[] 보존.
- 의존: A4, **T0**. 병렬: 불가(임계경로).

---

## 배치 B — shared / ABI / 배포 사본 (MONTI-web `packages/shared`)

### B1 · S — shared: claim 승인서 인코딩
- 파일: `packages/shared/src/encoding.ts`(+`encoding.hash.test.ts`), `src/constants.ts`.
- 내용: `CLAIM_AUTH_TAG` 상수, `claimAuthPreimage(input)`(abi.encode: bytes32 tag, uint256
  chainId, address ticket, uint256 eventId, uint8 tier, address account, uint256 nonce, uint64
  deadline), `claimAuthHash=sha256(preimage)`. 게이트코드/deviceDigest **무변경**.
- AC: `claimAuthHash`가 컨트랙트 `claimAuthDigest`와 동일 벡터 산출(교차검증 테스트).
- 테스트: 알려진 벡터로 컨트랙트 vs shared 일치, 태그/필드 순서 회귀.
- 의존: A1(다이제스트 확정). 병렬: A2~A4와 병렬 가능.

### B2 · S — shared: ABI + 배포 주소 동기화
- 파일: `packages/shared/src/abi/*.json`, `packages/shared/src/deployments/10143.json`.
- 내용: A5 export ABI 반영, 신주소 기입. Deployment 타입/로더(`loadDeployment`) 무변경 확인.
- AC: 타입체크 통과; ticketAbi에 claimFor/requestClaimFor/checkInFor/checkInForLate/
  claimAuthDigest/claimNonce 존재, 직접 claim 부재.
- 의존: A5, B1. 병렬: 불가(주소 최종화 후).

---

## 배치 C — 백엔드 콜러블 / 규칙 / 모니터 (MONTI-backend, mvp-backend, Functions us-east1)

### C1 · S — 릴레이어 키·클라이언트·리스
- 파일: `functions/src/lib/relayer.ts`(신규: `getRelayerAccount`, `sendRelayerTx`),
  `functions/src/lib/relayerLock.ts`(신규, `attesterLock.ts` 복제·LEASE_DOC='relayer'·
  브로드캐스트 후 반납·명시 pending nonce), `functions/src/config.ts`(RELAYER_PK 파라미터),
  `.env`(참조만; 값은 `.secrets/.env`/Secret Manager).
- 내용: 어테스터와 분리된 EOA. `sendRelayerTx`는 리스 밖 estimate/simulate, 리스 안 nonce+
  sign+broadcast, `gasLimitFor`(±7.5%) + maxFee=2×base+2tip.
- AC: 단위 테스트로 리스 상호배제·nonce 명시·nonce-too-low 1회 재시도.
- 의존: A5(주소). 병렬: C2 스켈레톤과 병렬.

### C2 · L — relayClaim / relayCheckIn 콜러블
- 파일: `functions/src/functions/relay.ts`(신규), `functions/src/index.ts`(export).
- 내용: 설계 §5. relayClaim(auth+deviceSig, mode claim|request; resolveCallerAccount로
  account 일치·isMember·!isLocked·nonce 재대조·eth_call 시뮬→revert 매핑·(account,nonce) 멱등·
  브로드캐스트·relays 문서). relayCheckIn(code+response+late; nonce 일치·시뮬→DENY 매핑·
  tokenId 멱등·admissions passing 기록·브로드캐스트). 오류 코드 = 기존 deny/limit 이름.
- AC: 성공 시 relayId 반환 + relays 문서 pending→sent→confirmed; 시뮬 revert 시 미전송 +
  정확한 코드; 남의 계정 claim 거부; 중복 제출 멱등.
- 테스트: 에뮬레이터 + 모의 RPC(성공/각 revert/멱등/권한). 통합: 테스트넷 1건.
- 의존: C1, B2. 병렬: C3와 병렬.

### C3 · M — Firestore 규칙/인덱스 + 대기 테이블 + 잔액 모니터
- 파일: `functions firestore.rules`·`firestore.indexes.json`, `functions/src/functions/relayerBalance.ts`
  (신규 스케줄드), `reconcilePending.ts`(relays 타임아웃 수습 확장).
- 내용: `relays/{id}` 소유자 읽기 전용(쓰기=서버), `admissions/{eventId}/tokens/{tokenId}`
  게이트/앱 읽기(쓰기=서버). 잔액 스케줄러가 릴레이어 EOA <3 MON 시 기존 채널 경보. 확정
  admissions TTL 정리.
- AC: 규칙 테스트(관객은 자기 relays만 읽음, admissions 읽기 가능·쓰기 거부); 스케줄러가
  임계치에서 경보 1회.
- 의존: C1. 병렬: C2와 병렬.

### C4 · S — Functions 배포 + env
- 파일: 배포 파이프라인, Secret Manager(RELAYER_PK), 배포 주소 사본.
- AC: relayClaim/relayCheckIn/relayerBalance 라이브; 테스트 전화(+8210-0000-0001..10)로 claim
  1건 성공.
- 의존: C2·C3. 병렬: 불가.

---

## 배치 D — 웹 관객 (MONTI-web, mvp-web, apps/web)

### D1 · M — claim 제출을 릴레이로 교체
- 파일: `apps/web/src/attendee/claim/{Claim.tsx,ClaimFlow.tsx,claimDraft.ts}`,
  `src/shared/chain/{reads.ts}`(claimNonce 읽기), (신규) `src/attendee/claim/buildClaimAuth.ts`,
  콜러블 래퍼. `shared/chain/{sendSponsoredOp,ops}.ts`의 claim 사용 제거.
- 내용: claimNonce 읽기 → ClaimAuth 구성(deadline=now+10분) → 기기 키 서명(buildResponse
  미러) → relayClaim 호출 → `relays/{id}` 구독 → OpProgress(09-27 상태머신 이식: 저장→확인→
  완료·45초 캡·자동재전송 규약, 소스만 relay 문서). mode=request(승인제) 분기.
- AC: 무료 티켓 받기 성공·완료 카피; 사전 차단(held+pending≥maxPerWallet)·품절·승인 재폴링
  유지; web3어 0.
- 테스트: `claim.test.tsx`·`claimApprovalPoll.test.tsx` 갱신(콜러블 목·relay 구독), 재전송/멱등.
- 의존: B2, C4. 병렬: E와 병렬.

### D2 · S — 입장(enter) 흐름 확인(서명 무변경)
- 파일: `apps/web/src/attendee/enter/{buildResponse.ts,Enter.tsx,Result.tsx}`.
- 내용: **관객 서명 다이제스트 무변경** 확인/회귀 고정. 제출 주체 변경은 스태프(E)에 있음 —
  관객 측은 NFC/QR 응답 전달 그대로.
- AC: buildResponse 벡터 불변(byte-identical 테스트 유지); 관객 화면 변화 없음.
- 테스트: `buildResponse.test.ts` 유지(회귀 가드).
- 의존: 없음. 병렬: 전부와 병렬.

---

## 배치 E — 웹 스태프 + 안드로이드 (MONTI-web staff / MONTI-staff)

### E1 · M — 게이트 체크인 제출을 릴레이로 교체
- 파일: `apps/web/src/staff/gate/{checkInOp.ts,machine.ts,preflight.ts,denyMap.ts,useGate.ts}`.
- 내용: `sendCheckIn`(sendSponsoredOp) → relayCheckIn 콜러블. `getGateSmartAccount`·
  UnknownSender/paymaster 매핑 제거 → 시뮬 기반 DENY 매핑. (code+gateSig)+(response+deviceSig)
  POST. `gateCode.ts`·`gateKey.ts` **무변경**. preflight가 admissions passing 확인(교차 게이트).
- AC: 릴레이 경로로 입장 성공(PASS 먼저·relay 확정 후 반영); DENY 매핑 정확; 폐기/이중입장
  처리; web3어 0.
- 테스트: `checkInOp.test.ts`·`machine.test.ts`·`denyMap.test.ts` 갱신.
- 의존: B2, C4. 병렬: D와 병렬.

### E2 · S — 오프라인 큐 배수를 릴레이로
- 파일: `apps/web/src/staff/{offline/**,queue/**,snapshot/**}`.
- 내용: 복구 후 큐가 sendSponsoredOp(checkInLate) 대신 relayCheckIn(late=true)로 POST. 스냅샷
  검증 로직 무변경(오프라인 로컬 전용, 체인 재검증).
- AC: 오프라인 축적분이 복구 후 relay로 배수·AlreadyCheckedIn은 성공 처리.
- 테스트: `staff/queue`·`offline` 테스트 갱신.
- 의존: E1. 병렬: 불가(E1 후).

### E3 · S — 안드로이드(MONTI-staff) 상위 반영
- 파일: MONTI-staff의 `apps/web` Capacitor/Android 브리지·엔드포인트 설정.
- 내용: 콜러블 엔드포인트 웹뷰 도달(CORS/Functions), 게이트 키 Keystore/StrongBox 유지,
  번들러/paymaster 연결 제거, 재빌드. **네이티브 로직 변경 없음(웹 번들 중심).**
- AC: 안드로이드 스태프 앱에서 릴레이 체크인 성공(테스트 기기 1대).
- 의존: E1. 병렬: E2와 병렬.

---

## 배치 F — e2e 하니스 + 코스트 측정 (MONTI-e2e / MONTI-web `apps/web/e2e`)

### F1 · M — 페르소나 시나리오를 릴레이 경로로
- 파일: `apps/web/e2e/{tests,utils,fixtures}/**`(시나리오 a/b+c/d/e/f, `E2E_*`).
- 내용: claim/체크인을 콜러블 경로로(또는 직접 claimFor/checkInFor 서명 생성) 갱신. 하니스
  상태공유 취약성(기존 워커 이슈) 주의.
- AC: 시나리오 a~f green(릴레이 경로).
- 의존: C4·D1·E1. 병렬: F2 준비와 병렬.

### F2 · M — 코스트 시나리오(≤5 MON 단언)
- 파일: `apps/web/e2e/tests/cost.spec.*`(신규), `utils/`(잔액 측정).
- 내용: Monad 테스트넷에 create + publish + gate + **100 claim + 100 check-in** 실행. 릴레이어
  EOA 잔액 before/after 차 + 주최자 paymaster 소진 합산 → **assert ≤ 5 MON**. 건당 한도·실효
  gwei 로깅.
- AC: 합계 ≤ 5 MON(설계 예측 ~4.4); 초과 시 실패 + 건당 한도 리포트.
- 의존: F1. 병렬: 불가(임계 검증).

---

## 배치 G — 컷오버 / 문서

### G1 · S — 브랜치 병합 + 파이프라인 컷오버
- 순서: mvp-01b → mvp-backend → mvp-web/mvp-staff → mvp-e2e → mvp(merge-checklist 패턴).
- 파이프라인: 신주소 → shared deployments → Functions env → Vercel env → 웹 배포 →
  **인덱서 config 재생(gen-config.mjs) + envio-release(무료 플랜: 옛 배포 삭제 먼저)**.
- AC: 전 경로 신주소 정합; 인덱서가 신주소에서 Claimed/CheckedIn/… 수신.
- 의존: A5·B2·C4·D·E·F. 병렬: 불가.

### G2 · S — 문서
- 파일: `docs/`의 abi-delta, `2026-09-27-monti-device-day-runbook.md`(릴레이 경로·릴레이어
  충전/알림 절차 추가), 본 설계/계획.
- AC: abi-delta에 claimFor/requestClaimFor/checkInFor(+Late)/claimAuthDigest/claimNonce 및 직접
  claim 제거·checkIn 시그니처 변경 반영; 런북에 릴레이어 잔액 10 MON·경보 <3 MON 명시.
- 의존: A5. 병렬: 나머지와 병렬.

---

## 병렬화 요약
- **임계경로:** T0 → A(1→2/3→4→5) → C(1→2/3→4) → (D‖E) → F(1→2) → G.
- **병렬 가능:** B는 A1 후 A2~A4와 병렬. C2‖C3. D‖E(E1 후 E2‖E3). D2/G2는 초기부터 병렬.

## 규모 합계(대략)
A: S1+M4 · B: S2 · C: S3+M1+L1 · D: M1+S1 · E: M1+S2 · F: M2 · G: S2.
≈ **에이전트 작업 8~11일**(A·C·F가 무거움; T0 실측 선행).

---

## 검증 체크리스트 — "100명당 ≤ 5 MON"
- [ ] **T0:** Monad 테스트넷 P-256 precompile(0x100) 라이브 확인(없으면 전면 중단).
- [ ] `forge test` green + CheckInGas < 200k(checkInFor) + ClaimGas 실측으로 claimFor 한도 확정.
- [ ] 릴레이어 한도: claimFor ~215k / checkInFor ~167k(±7.5% 마진, ≤15% 상한 준수).
- [ ] 콜러블이 **eth_call 시뮬 후에만** 전송(revert도 한도 청구되므로 필수) — revert 시 미전송.
- [ ] F2 코스트 시나리오: create+100claim+100checkin **합계 ≤ 5 MON**(예측 ~4.4), 건당 한도 로깅.
- [ ] 릴레이어 EOA ~10 MON 충전 + 잔액 <3 MON 경보 동작.
- [ ] 인덱서 스키마 무변경(같은 이벤트) + config 재생 + envio 신규 배포 수신.
- [ ] web3 금지어 grep 0(관객·스태프 신규 카피).

## 롤백 노트
- **데이터 마이그레이션 없음** → 롤백 = 직전 배포 주소로 파이프라인 되돌리기: `10143.json`을
  `previous[]`의 직전 항목으로 복원 → shared/Functions env/Vercel env 되돌림 → 웹 재배포 →
  인덱서 config 재생 + **envio 옛 배포 삭제 후 이전 주소로 재릴리스**. 테스트 계정은 어차피
  리셋 전제라 상태 보존 불필요.
- **부분 롤백 불가 지점:** 컨트랙트는 claim/checkIn 시그니처가 바뀌므로 웹/백엔드/인덱서가
  같은 주소 세트로 원자적 정합해야 함(G1이 단일 컷오버). 혼합 상태 금지.
- 릴레이어 문제(잔액/키)만이면 컨트랙트 롤백 없이 릴레이어 EOA 재충전/키 로테이트로 처리
  (permissionless 제출이라 임시로 다른 EOA에서 제출 가능).
