# MONTI 페르소나 1차 라운드 — UX 수정 계획 (2026-09-26)

- **대상**: 프로덕션 `https://monti.despell.io`, 웹(mvp-web @ 1abc400), 폰 우선(390px)
- **근거**: `task-e2e-personas-report.md`, `e2e/reviews/{admin,users,friction-log}.md`
- **경로 표기**: 별도 명시 없으면 `apps/web/src/…` 기준. (라이브)=실관찰 · (코드)=코드리뷰
- **제품 규칙**: 폰 우선 · web3 단어 금지 · 가스는 MONTI 부담 · "초등학생도 만들 수 있는" 단순함

## 1. 마찰 트리아지 (전 항목)

| # | 마찰 | 출처 | 심각도 | 근본원인(path:line) | 수정 | 크기 | 우선 |
|---|---|---|---|---|---|---|---|
| 1 | 가입 첫 관문 reCAPTCHA 이미지 챌린지 | 전원(라이브) | 치명 | `shared/api/auth.ts` RecaptchaVerifier + `signup/Phone.tsx:84` | 별도 처리(테스트번호 훅+Enterprise 점수) | — | **P0(별도)** |
| 2 | 탐색 초기 로딩 느림 + 공개행사 0건 → "죽은 앱" | …04·…05·관리자(라이브) | 높음 | `discover/Discover.tsx:64,73` 스피너 1개·빈문구 1종 / `useEvents.ts:160` 스켈레톤 없음 | 스켈레톤+빈상태 CTA+인덱서다운 분리(§2a) | M | **P0** |
| 3 | 화면 제목 == 입력 라벨 중복 | 전원(라이브) | 경미 | `signup/Phone.tsx:63,74` 둘 다 `phoneTitle` | 라벨용 짧은 카피 신설(§2d) | S | P1 |
| 4 | "만들기 ≠ 발행" — 발행이 숨은 필수 2단계 | 관리자(코드) | 치명 | `scene/Created.tsx:97,117-125` 발행 CTA 없음·`manage`링크뿐 / `copy.ts:426-427` | done 1차 CTA·2단계 헤더·발행 요약 시트(§2b) | M | **P0** |
| 5 | 온체인 대기 최대 30초+ 진행률 부재 | 관리자·…06(코드) | 높음 | `scene/CreateEvent.tsx:465-470` Spinner+한줄 / `sendSponsoredOp.ts:104` 15s·`:211` / claim·publish는 Steps 미사용 | 확정형 진행 UI 공용화(§2c) | M-L | **P0** |
| 6 | 승인제 경로 전체 미구현 | …09·관리자(코드) | 높음 | `scene/TierCard` 승인칩 비활성(`copy.ts:407-409`) / `requests` 카피는 있으나(`copy.ts:240-254`) 화면 미배선·플래그 off | 01c 배포+`VITE_APPROVAL_MODES=on` 대기 | L | P1(막힘) |
| 7 | 유료 차단이 "곧 열려요"만 | 관리자(코드) | 낮음 | `copy.ts:399` paidBlocked / `copy.ts:484` paidTier | 무료 전환 원탭 버튼 병기(§2d) | S | P1 |
| 8 | 포스터 필수 + 크롭 모달 탭 증가 | 관리자(코드) | 낮음 | `scene/draftRules.ts` poster 필수 / `ui/A4Cropper.tsx` | 기본 프리셋만으로 발행 허용 검토 | M | P1 |
| 9 | "브라우저 입장 불가" 안내가 가입 중반 등장 | friction-log(코드) | 낮음 | `signup/Register.tsx:355` deviceWebNote | 앱 설치 유도를 초기(전화 단계)로(§2d) | S | P1 |
| 10 | 로그인 화면 얇음(가입 보조경로 약함) | …전반·friction-log(라이브) | 낮음 | `copy/ko.ts` login 블록 / `noPasskey`는 초기 미노출 | "처음이세요? 가입" 보조링크(§2d) | S | P1 |

## 2. 지금 실행할 설계

### (a) 탐색 로딩·빈상태·인덱서다운 3분기 — `Discover.tsx`, `useEvents.ts`
- **로딩**: `isLoading`이면 스피너 대신 **스켈레톤 카드 3~4장 즉시**(포스터 자리·2줄 회색 바). 진입 1초 내 화면이 살아 보이게. (`Discover.tsx:64` 교체)
- **빈상태 분기** (`!isLoading && !isError && items.length === 0`):
  - 데이터 자체가 0건 + 로그인: **"첫 행사를 만들어 보세요"** + 1차 버튼(기존 `discover.create`='만들기' → `organizer.to`).
  - 데이터 0건 + 비로그인: **"곧 행사가 올라와요"** (CTA 없음, 안심 톤).
  - 필터로만 0건(데이터>0): 기존 **"조건에 맞는 행사가 없어요."** 유지 + "필터 지우기".
  - 신규 카피: `discover.emptyHostCta`, `discover.emptySoon`. 기존 `discover.empty`는 `emptyFiltered`로 용도 한정.
- **인덱서 다운(구분됨)**: 이미 `isError` → `describeFailure`가 `serviceDown`('지금 정보를 가져올 수 없어요…')로 빈상태와 다른 문장 표시(`errors.ts:62`) + 기존 `common.retry` 버튼(`Discover.tsx:69`). 빈 카드가 아니라 경고 톤으로 시각 분리.

### (b) "만들기 ≠ 발행" 가시화 — `Created.tsx`, `Dashboard.tsx`, `copy.ts`
- **2단계 헤더**: 생성 씬과 done 화면 상단에 기존 `Steps` 재사용, 라벨 `['만들기','발행']`. 생성 씬 `at=0`, done 화면 `at=1`(발행이 아직 남았음을 처음부터 알림). 신규 카피 `scene.stepCreate`='만들기', `scene.stepPublish`='발행'.
- **done 1차 CTA**: `Created.tsx`의 현 `manage` 링크(=`행사 화면 열기`)를 보조로 내리고, **1차 버튼 "지금 발행하기"** 신설(`done.publishNow`='지금 발행하기') → `/org/events/:id`의 발행 시트를 바로 연다. `notYetPublic`(`copy.ts:426`) 문구는 유지.
- **발행 요약 시트**: 현재는 `lifecycle.publishConfirm` 확인창뿐. 기존 `Sheet`로 **요약 시트**를 세운다 — 제목·날짜·장소(숨김 시 지역만)·티켓 종류 수·본인확인 여부를 나열 후 기존 `lifecycle.publishConfirm`('발행하면 누구나…고칠 수 없어요') + `confirm`='네, 진행할게요' / `back`='아니요'.
- **주의(B-1 존중)**: 창업자 폰 테스트로 생성은 이미 **원스크롤·버튼 1개**(`CreateEvent.tsx:36-42`). 작업지시의 "다음: 티켓 설정 → 행사 만들기"식 버튼 재분할은 B-1 회귀이므로 **채택하지 않음**. 사용자가 놓친 진짜 단계는 이벤트↔티켓이 아니라 **만들기↔발행**이므로, 단계 표현은 위 2단계 헤더로 해결하고 생성 버튼은 `행사 만들기` 그대로 둔다.

### (c) 온체인 대기 확정형 진행 UI(공용) — 신규 `<OpProgress>` (claim·request·approve·publish·signup 공용)
- 기존 `Steps` 위에 경과초 타이머를 얹은 공용 컴포넌트. 단계 **저장 중 → 확인 중 → 완료**, 각 단계에 `{{sec}}초째` 표기. Monad 정상 3~10초.
- 신규 카피(shared): `op.saving`='저장 중', `op.confirming`='확인 중', `op.done`='완료', `op.elapsed`='{{sec}}초째'.
- 10초: 기존 `signup.registerSlow`='거의 다 됐어요. 조금만 기다려 주세요' 재사용.
- 30초 초과: `op.timeout`='시간이 조금 걸리고 있어요. 다시 시도할까요?' + `common.retry`='다시 시도'. (재시도는 기존 멱등 경로 사용 — `usePublish.ts:422-444`의 `submittedOpHash` 재확인이라 두 번 눌러도 행사 2개가 되지 않음.)
- 적용: `CreateEvent.tsx:465-470`의 Spinner+한줄을 대체. `sendSponsoredOp.ts:104`는 15s→화면에서 `confirming`으로 전환하고 30s에 timeout 카피(전송은 이미 백그라운드 안전, `confirming` 카피 존재 `copy.ts:450`).

### (d) 가입/부가 마찰 (캡차는 별도)
- **라벨 중복(#3)**: `signup.phoneLabel`='휴대폰 번호' 신설 → `Phone.tsx:74` 라벨만 교체(제목은 `phoneTitle` 유지).
- **앱 안내 시점(#9)**: `deviceWebNote`(브라우저 입장 불가)를 등록 중반이 아니라 전화 단계 초기 안내로 이동 — 웹 완주자에게 뒤늦은 통보 방지.
- **로그인 보조경로(#10)**: 로그인 화면에 `login.signupLink`='처음이세요? 가입' 보조링크 상시 노출(기존 `noPasskey`는 실패 후에만 뜸).
- **유료 되돌리기(#7)**: `paidBlocked`(`copy.ts:399`) 경고 옆에 **"무료로 바꾸기" 원탭 버튼**(가격을 free로 patch) 병기.

## 3. 자동 검증 불가 항목과 수동 커버

- **가입 완료 이후 전 구간**(잠금·휴대폰 등록·생성·발행·티켓 받기·내 티켓·한도·마감): 캡차로 라이브 미검증. → 헤디드 `E2E_MANUAL_CAPTCHA=1`로 사람이 챌린지 1회씩 풀고 나머지 자동 진행(실기기 1회 수동 통과).
- **Didit KYC**(실 신분증·얼굴): 자동 불가. → 테스트 신분증으로 실기기 수동 1회(`kyc` 블록 문구 확인).
- **NFC 입장**: 네이티브(안드로이드) 전용("입장은 앱에서 해요"). → 스태프앱+참석자앱 실기기 태깅 수동.
- **유료 결제**: 컨트랙트 차단. → 컨트랙트 개방 후 `paidBlocked`→"발행 성공"으로 검증 전환, 그 전엔 무료 경로만.
- **승인 대기 여정**: 01c 배포+`VITE_APPROVAL_MODES=on` 전. → 도착 후 `E2E_APPROVAL=1`로 시나리오 d(신청→4명/전체 승인→승인됨) 활성화.

## 4. P0 목록

- **P0-1** 탐색 스켈레톤+빈상태 CTA+인덱서다운 분리 (§2a · `Discover.tsx:64,73`)
- **P0-2** 만들기≠발행: done "지금 발행하기" 1차 CTA + 2단계 헤더 + 발행 요약 시트 (§2b · `Created.tsx:97,117`)
- **P0-3** 온체인 대기 확정형 진행 UI 공용화(저장중→확인중→완료·경과초·30s 타임아웃 재시도) (§2c · `CreateEvent.tsx:465`)
- **P0(별도)** 가입 첫 관문 reCAPTCHA — 캡차 트랙에서 처리
