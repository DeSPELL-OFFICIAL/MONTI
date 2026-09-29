# MONTI 릴레이 전환 Phase 2 — 구현 계획 (2026-09-29)

설계: `2026-09-29-monti-relayed-phase2-design.md`(Q1–Q8 결정·Forwarder 인터페이스·다이제스트·
`_msgSender` 지점·relayAction 콜러블·회계·가스표). 이 문서는 **워크트리/브랜치별 번호 작업**.
각 작업: 파일 · 수용기준(AC) · 테스트 · 규모(S/M/L) · 의존 · 병렬.

- **제약(공통):** web3 낱말 금지, 가스는 MONTI 대납(릴레이어 단일 지불처), 폰 우선, 데모 2026-10-13.
  **컨트랙트 변경 → 재배포 필수** → 신주소 파이프라인 전부 갱신.
- **[T0 · 착수 게이트]** Monad P-256 precompile(0x100)은 Phase 1 에서 실측 확인됨(설계 §11-1) →
  재확인만. Forwarder 는 같은 `P256.verifySignature` 를 쓰므로 전제 유효.
- **핵심 원칙:** Phase 1 발급/입장 경로는 **건드리지 않는다**(하이브리드). Phase 2 는 나머지
  스폰서드 op 만 Forwarder 로 옮기고 4337 을 전면 폐기.

배치 개요: **A 컨트랙트+테스트** → (**B shared/ABI** ‖) → **C 백엔드 relayAction/회계/규칙** →
(**D 웹 주최자** ‖ **E 웹 관객 양도** ‖ **H 스태프**) → **F e2e+코스트+4337-0** → **G 컷오버/문서**.
A→C→(D‖E‖H)→F 가 임계경로. B 는 A1 직후 병렬.

---

## 배치 A — 컨트랙트 + 테스트 (worktree MONTI-01b, branch mvp-01b, Foundry)

### A1 · M — MontiForwarder 신규
- 파일: `contracts/src/MontiForwarder.sol`(신규), `src/interfaces/IIdentity.sol`(재사용).
- 내용: `struct ForwardRequest`, `FORWARD_REQUEST_TAG`, `mapping(address=>uint256) public
  forwarderNonce`, `forwardDigest(...) public view`, `execute(req, deviceSig)`(deadline·대상
  allowlist·nonce·isMember·!isLocked·P256 over digest·nonce++·`to.call(data‖from)`·revert 버블).
  immutable identity/ticket/organizers(생성자 주입; ticket/organizers 는 setTargets 1회 대안 가능).
  에러 `AuthExpired`/`BadNonce`/`TargetNotAllowed`.
- AC: 컴파일; `forwardDigest` 가 설계 §1 바이트열과 일치; 유효 요청이 대상 함수 실행·nonce 증가;
  대상 revert 가 원문 그대로 버블.
- 테스트: `test/Forwarder.t.sol`(신규) — 유효/BadNonce/AuthExpired/TargetNotAllowed/DeviceLocked/
  NotMember/위조서명/nonce 재사용/버블. P-256 = `vm.signP256` + `P256Vectors` 확장.
- 의존: 없음. 병렬: A2 와 병렬(다른 파일).

### A2 · L — Ticket/Organizers/Identity ERC-2771 인지 + `_msgSender()` 치환
- 파일: `contracts/src/{Ticket.sol,Organizers.sol,Identity.sol}`.
- 내용: OZ `ERC2771Context` 상속(trustedForwarder immutable). 설계 §2 라인의 `msg.sender` →
  `_msgSender()`(Ticket 12지점군, Organizers 5지점군, Identity 3지점군). **raw 유지: Organizers
  setTicket=deployer, Identity onlyAttester·attester 분기.** `_msgSender/_msgData/_contextSuffixLength`
  다중상속 override(Context↔ERC2771Context, Ticket 은 ERC721+EIP712 와 함께).
- AC: 기존 권한 검사가 Forwarder 경유 시 `_msgSender()==from` 으로 통과; 직접 호출 시 그대로;
  ERC721 approve/transferFrom/_update 가 `_msgSender()` 반영; **ContractSize.t.sol 한도 통과**.
- 테스트: 각 함수 Forwarder 경유 성공 + 권한 없는 from 거절; `_msgData` 직접 파싱처 부재 회귀.
- 의존: A1. 병렬: 불가(대상 3파일 동시 편집, 순차 권장).

### A3 · M — MontiPaymaster 폐기 + 배포 스크립트
- 파일: `contracts/src/MontiPaymaster.sol`(삭제), `script/Deploy*.s.sol`, `script/Seed.s.sol`.
- 내용: paymaster 배포/자금/ArgKind 제거. 배포 순서 = Identity→Forwarder→Organizers→Ticket→
  Forwarder.setTargets→setTicket(설계 §8). Seed 를 Forwarder.execute(테스트 P-256) 경로로.
  (§12 슬림 저장은 **이미 09-29 배포에 반영·라이브** — 추가 작업 없음. 기존 TicketPacking/ClaimGas
  스위트가 계속 green 이어야 한다.)
- AC: paymaster 심볼 0; deploy 스크립트가 신 순서로 성공; 기존 슬림 저장 스위트 green.
- 테스트: 배포 드라이런; TicketPacking/TicketClaimFor/CheckIn 스위트 green.
- 의존: A1·A2. 병렬: 불가.

### A4 · M — 가스 실측 + 전체 스위트
- 파일: `test/ForwardGas.t.sol`(신규), `test/ClaimGas.t.sol`, `test/CheckInGas.t.sol`.
- 내용: 대표 이관 함수(createEvent/approveClaims/acceptOffer)의 Forwarder 경유 실행 gas 실측 →
  릴레이어 한도 산정 근거. claim/checkIn 은 라이브 실측(0.0268/0.0175)을 기준값으로 유지.
- AC: `forge test` 전부 green; ForwardGas 로그 확보; 금지 심볼(paymaster/직접 4337) 0.
- 의존: A1·A2·A3. 병렬: 불가.

### A5 · S — 재배포 + ABI export + 배포 파일
- 파일: `deployments/*.json`, `script/export-abi.sh`.
- 내용: 재배포(시크릿 `.secrets/.env` 만) → 신주소 + `previous[]` append. ABI export.
- AC: 신주소로 Forwarder.execute 라이브 1건(예: setNickname) 성공; previous[] 보존.
- 의존: A4. 병렬: 불가(임계경로).

---

## 배치 B — shared / ABI (MONTI-web `packages/shared`)

### B1 · S — Forwarder 인코딩 + 다이제스트
- 파일: `packages/shared/src/encoding.ts`(+테스트), `src/constants.ts`.
- 내용: `FORWARD_REQUEST_TAG`, `forwardRequestPreimage(input)`(abi.encode 순서=설계 §1),
  `forwardDigest=sha256(preimage)`. 발급/입장 인코딩 무변경.
- AC: shared 다이제스트가 컨트랙트 `forwardDigest` 와 동일 벡터.
- 의존: A1. 병렬: A2~A4 와 병렬.

### B2 · S — ABI + 주소 동기화 + paymaster 제거
- 파일: `packages/shared/src/abi/*.json`, `src/deployments/*.json`.
- 내용: Forwarder ABI 추가, MontiPaymaster ABI 삭제, 신주소. `USED_ABI` 에 이관 함수 selector 유지.
- AC: 타입체크; ticket/organizers/identity ABI 에 이관 함수 존재, paymaster 부재.
- 의존: A5, B1. 병렬: 불가.

---

## 배치 C — 백엔드 (MONTI-backend, mvp-backend, Functions us-east1)

### C1 · L — relayAction 콜러블 + selector allowlist + 회계
- 파일: `functions/src/functions/relay.ts`(추가), `functions/src/index.ts`(export),
  `functions/src/lib/relayTypes.ts`(RelayKind 확장).
- 내용: 설계 §4. resolveCallerAccount==from · target/selector allowlist(23개) · forwarderNonce
  재대조 · `forwarder.execute` eth_call 시뮬→revert 매핑 · `sendRelayed` 전송 · `relays/{id}`(kind) ·
  `(from,nonce)` 멱등 · uid/orgId 레이트리밋 · `usage/{orgId}` 원장 increment.
- AC: 성공 시 relayId + relays pending→sent→confirmed; 시뮬 revert 시 미전송+정확 코드; 남의
  from 거부; 중복 멱등; usage 누적.
- 테스트: 에뮬레이터 + 모의 RPC(성공/각 revert/멱등/권한/레이트리밋). 통합: 테스트넷 1건.
- 의존: B2. 병렬: C2 와 병렬.

### C2 · M — Firestore 규칙/인덱스 + paymaster 참조 제거 + 배포
- 파일: `firestore.rules`·`firestore.indexes.json`, `relayerBalance.ts`(임계 검토),
  paymaster/번들러 참조 제거, 배포 파이프라인.
- 내용: `usage/{orgId}` 소유 읽기·서버 쓰기, `relays` 규칙 확장(kind). 잔액 경보 유지.
- AC: 규칙 테스트(조직은 자기 usage 만); relayAction 라이브; 잔액 경보 동작.
- 의존: C1. 병렬: C1 과 부분 병렬(규칙은 선행 가능).

---

## 배치 D — 웹 주최자 (MONTI-web, mvp-web, apps/web)

### D1 · M — 주최자 씬/승인/게이트/팀을 relayAction 으로
- 파일: `organizer/scene/{usePublish.ts,useEventDraft.ts,Created.tsx,TicketSection.tsx}`,
  `organizer/lifecycle.ts`, `organizer/requests/Requests.tsx`, `organizer/gates/Gates.tsx`,
  `organizer/Team.tsx`, (신규) `shared/chain/buildForwardRequest.ts`, 콜러블 래퍼.
- 내용: createEvent/publish/update/cancel/revoke/approveClaims/rejectClaims/register|open|close|
  revokeGate/setAdmin/setManager → buildForwardRequest+relayAction. `relays/{id}` 구독+OpProgress
  이식(45초 캡·재폴링). `ticketOp/organizersOp` import 제거.
- AC: 각 동작 성공·완료 카피; 만들기 재폴링 유지; web3어 0.
- 테스트: 해당 스위트 갱신(콜러블 목·relay 구독).
- 의존: B2, C2. 병렬: E·H 와 병렬.

---

## 배치 E — 웹 관객 양도/기타 (MONTI-web, mvp-web)

### E1 · M — 양도/신청취소/닉네임/migrate 를 relayAction 으로
- 파일: `attendee/transfer/{useInvite.ts,useTransfer.ts,offers.ts}`, `attendee/tickets/Inbox.tsx`,
  `attendee/claim/ClaimFlow.tsx`(cancelRequest), `attendee/me/{Nickname.tsx,NewDevice.tsx}`.
- 내용: createOffer/cancelOffer/acceptOffer/safeTransferFrom/cancelRequest/setNickname/
  cancelRotation/migrate → relayAction. acceptOffer 의 attesterSig 는 data 포함. recipientCommitment/
  offerDigest 무변경.
- AC: 양도 보내기/취소/받기 성공; 신청취소/닉네임 성공; web3어 0.
- 테스트: transfer/offers/inbox 스위트 갱신.
- 의존: B2, C2. 병렬: D·H 와 병렬.

---

## 배치 H — 스태프 + 안드로이드 (MONTI-web staff / MONTI-staff)

### H1 · S — 오버라이드를 relayAction 으로 + 4337 연결 제거
- 파일: `staff/override/route.ts`(requestOverride/manualOverride), 스태프 공용 chain 배선.
- 내용: 오버라이드 제출 → relayAction. 게이트 체크인(relayCheckIn)·gateKey/gateCode 무변경.
  번들러/paymaster 연결 제거.
- AC: 오버라이드 릴레이 성공; 체크인 무변경 회귀 green.
- 의존: B2, C2. 병렬: D·E 와 병렬.

### H2 · S — 안드로이드 재빌드
- 파일: MONTI-staff Capacitor/엔드포인트.
- 내용: relayAction 도달(CORS), 번들러/paymaster 제거, 재빌드. 게이트 키 Keystore 유지.
- AC: 안드로이드에서 오버라이드/체크인 성공(기기 1대).
- 의존: H1. 병렬: 없음.

---

## 배치 F — e2e + 코스트 + 4337-0 (MONTI-e2e / apps/web/e2e)

### F1 · M — 시나리오 릴레이 경로 갱신
- 파일: `apps/web/e2e/{tests,utils,fixtures}/**`.
- 내용: 주최자/양도/신청취소를 relayAction 경로로. 발급/입장(Phase1)은 유지. 하니스 상태공유
  취약성 주의(F1 기존 이슈).
- AC: 전 시나리오 green.
- 의존: C2·D1·E1·H1. 병렬: F2 준비와 병렬.

### F2 · M — 코스트 + 4337 코드 0
- 파일: `apps/web/e2e/tests/cost.spec.*`, `utils/`(잔액), 리포 grep 검사.
- 내용: create+publish+gate + 100발급 + 100입장 실행 → 릴레이어 잔액 차 합산 → **assert ≤ 4.7
  MON(예상 4.5~4.6; 4.1 은 이 구조로 불가 — 설계 §6 정정)**. **4337 grep 0** 확인.
- AC: 합계 ≤ 4.7 (현행 4.9 대비 개선 확인); grep 히트 0.
- 의존: F1. 병렬: 불가.

---

## 배치 G — 컷오버 / 문서

### G1 · S — 병합 + 파이프라인 컷오버 + 인출
- 순서: mvp-01b → mvp-backend → mvp-web/mvp-staff → mvp-e2e → mvp.
- 파이프라인: 신주소 → shared → Functions env → Vercel env → 웹 배포 → 인덱서 config 재생 +
  Envio(옛 배포 삭제 먼저). **모든 env GET 실재 확인 후 설정/삭제**(교훈). **paymaster 예치/스테이크
  인출**. 번들러 계약 종료.
- AC: 전 경로 신주소 정합; 인덱서 신주소 수신; paymaster 잔액 회수.
- 의존: A5·B2·C2·D·E·H·F. 병렬: 불가.

### G2 · S — 문서
- 파일: `docs/` abi-delta, device-day-runbook(릴레이어 단일 지불처·충전/알림·인출 절차), 본 2문서.
- AC: abi-delta 에 Forwarder/ERC2771/이관 함수·paymaster 삭제·사전배포 제거 반영.
- 의존: A5. 병렬: 초기부터.

---

## 병렬화 요약
- **임계경로:** T0 → A(1‖2→3→4→5) → C(1‖2) → (D‖E‖H) → F(1→2) → G.
- **병렬:** B 는 A1 후. C1‖C2. D‖E‖H. G2 초기부터.

## 규모 합계
A: M2+L1+S1(≈A1M,A2L,A3M,A4M,A5S) · B: S2 · C: L1+M1 · D: M1 · E: M1 · H: S2 · F: M2 · G: S2.
≈ **에이전트 작업 6~9일**(A2·C1 이 무거움).

---

## 검증 체크리스트 — "100명당 ≤ 4.7 MON(예상 4.5~4.6) + 4337 코드 0"
- [ ] T0: Monad P-256(0x100) 재확인(Phase1 실측 유효).
- [ ] `forge test` green + ContractSize 한도 통과(ERC2771Context 추가 후) + ForwardGas 실측.
- [ ] 릴레이어 한도 = est×(1.075), ≤15% 상한; Forwarder 홉 포함 실측 기반.
- [ ] relayAction 이 **eth_call 시뮬 후에만** 전송(revert 도 한도 과금) — revert 미전송.
- [ ] F2 코스트: create+100발급+100입장 **≤ 4.7**(예상 4.5~4.6).
- [ ] **4337 코드 0 grep(전 리포):** `sendSponsoredOp` · `bundler` · `encodePaymasterAndData` ·
      `UserOperationV06` · `MIN_VERIFICATION_GAS` · `VITE_BUNDLER_URL` · `paymasterAndData` ·
      `entryPoint` · `MontiPaymaster` · `ArgKind` · (스마트계정 **배포** 호출) → 전부 0.
- [ ] 스마트계정 사전배포 제거(가입에 배포 tx 없음); 주소 파생만 유지.
- [ ] usage/{orgId} 원장 누적 동작(집행 없음).
- [ ] 릴레이어 ~10~15 MON 충전 + <3 MON 경보; paymaster 예치/스테이크 인출 완료.
- [ ] 인덱서 스키마 무변경 + config 재생 + Envio 신규 수신.
- [ ] web3 금지어 grep 0(주최자·양도·스태프 신규 카피).
- [ ] 모든 env GET 실재 확인 후 컷오버(신주소·RELAYER_PK; 삭제 대상도 GET 후 제거).

## 롤백 노트
데이터 마이그레이션 없음 → `deployments/*.json` 을 `previous[]` 직전으로 복원 → shared/Functions/
Vercel env 되돌림 → 웹 재배포 → 인덱서 config 재생 + Envio 옛 배포 삭제 후 이전 주소 재릴리스.
컨트랙트 시그니처 변경으로 **부분 롤백 불가**(단일 컷오버). 릴레이어 문제만이면 컨트랙트 롤백 없이
EOA 재충전/키 로테이트(permissionless 라 임시 타 EOA 제출 가능). **주의: 4337 을 지웠으므로 롤백은
paymaster/번들러/사전배포 복원까지 포함** — 직전 배포 커밋 전체를 되돌리는 방식이 안전.
