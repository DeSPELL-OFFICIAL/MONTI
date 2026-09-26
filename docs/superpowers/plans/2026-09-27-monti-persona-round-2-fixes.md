# MONTI 페르소나 2차 라운드 — UX 수정 계획 (2026-09-27)

- **대상**: 프로덕션 `https://monti.despell.io`, 웹(mvp-web @ 277e2fc)·백엔드(mvp-backend), 폰 우선(390px)
- **근거**: `task-e2e-personas-report.md`("Live run 2"), `e2e/reviews/{admin,users,friction-log}.md`, 1차 계획(2026-09-26)
- **경로 표기**: 별도 명시 없으면 웹 `apps/web/src/…`, 백엔드는 `functions/src/…` 로 표기. (라이브)=실관찰 · (코드)=코드리뷰
- **제품 규칙**: 폰 우선 · web3 낱말 금지 · 가스는 MONTI 부담 · "초등학생도 만들 수 있는" 단순함 · 하위호환 불필요
- **범위 메모**: S1의 **온체인 확정 지연 자체**는 별도 에이전트가 근본원인 조사 중 — 여기서는 **UI가 절대 멈추지 않게** 하는 쪽만 설계

## 1. 마찰 트리아지

| # | 마찰(출처) | 근본원인(path:line) | 수정 | 크기 | 우선 |
|---|---|---|---|---|---|
| S1 | 행사 생성이 7~8분 "만드는 중"에 갇힘(라이브·치명) | 확정 지연 시 `usePublish.ts:499-504`가 `confirming`으로만 두고, `CreateEvent.tsx:492-496`이 무기한 info-alert+OpProgress를 겹쳐 표시. `OpProgress.tsx:29` 30s 타임아웃은 있으나 "나중에 확인" 탈출구·홈 확인 경로가 없음 | 45s 하드캡 후 **결정 블록**(다시 시도 / 나중에 확인) + 주최자 홈 배경 "확인 중" 배너로 복귀 시 자동 해소(§2a) | M | **P0** |
| S2 | 패스키 로그인 콜드 함수 간헐 실패(라이브) | `Login.tsx:52-66` 첫 실패를 즉시 오류로 표시(자동 재시도 없음). 콜드스타트 시 `loginChallenge`/`loginVerify`(백엔드 `login.ts`) 왕복이 느리거나 챌린지 만료. `config.ts:7`에 `minInstances` 없음 | 클라 자동 재시도(2회·1.5s, 일시장애만) + 다시 시도 버튼(§2b) · 백엔드 `minInstances:1`(§3) | S~M | **P0** |
| S3 | 발행 op 대기초과 → "아직 확인 중" → 새로고침 필요(라이브) | `Dashboard.tsx:172` `confirming`을 alert 한 줄로만 두고 폴링 없음. 카피 `organizer/copy.ts:75,259`가 "다시 열어/새로고침"을 지시 | 발행에도 `OpProgress`(45s캡) + 확정까지 인덱서/체인 자동 폴링, 수동 새로고침 제거(§2c) | M | **P0** |
| S4a | 이어작성 시트가 수 초 늦게 떠 입력 가림(라이브) | `useEventDraft.ts:291,464` `resumed`가 Firestore `listEventDrafts` 왕복 **후**에야 true. 로컬 미러(`opened`)가 있어도 첫 페인트엔 안 뜸 → 씬 입력은 이미 편집 가능 | 재개 결정을 **씬 렌더 전에**: 로컬 미러면 동기 표시, 네트워크 대기 중엔 스켈레톤으로 입력 잠금 후 결정(§2d) | M | P1 |
| S4b | 포스터 크롭 모달 정상 클릭 안 잡힘(라이브) | `PosterModal.tsx:73` `<dialog open>`(showModal 아님) → 톱레이어 밖, `.route-view` transform 안에 갇힘 | `dialogRef.showModal()`로 브라우저 톱레이어(백드롭 포함) — 스티키바 위 전체화면 보장(§2d) | S | P1 |
| S4c | 하단 스티키바 `행사 만들기`가 "더 설정하기"에 가려 클릭 가로채짐(라이브) | 스티키바가 `.route-view`(`router.tsx:34-43`) transform 스태킹 안. `theme.css:614` z-index 11 | 스티키바 1차 버튼을 최상단 히트타깃으로(z-index 상향 + `--sticky-bar-h` 여백 보장), 또는 크롬을 `.route-view` 밖으로(§2e) | S | P1 |
| S5 | 새로고침 후 세션 재수화 레이스 → FAB가 익명 취급/목적지 혼동(라이브) | `useOrganizerEntry.ts:59` `status==='signedIn'`만 보고 `loading`을 `!signedIn`으로 묶어 `/signup/phone`으로 보냄(`:63`). `session.ts` 상태는 `loading|anonymous|signedIn` | 세션 `loading`을 별도 처리(라우팅 보류) + `Discover.tsx:164`·`Layout.tsx:151` FAB를 `status!=='loading'`까지 스켈레톤/비활성(§2e) | S | P1 |
| R1 | FAB가 라우트 슬라이드에 함께 밀림(잔여) | `router.tsx:34-43` `.route-view`의 `transform`이 `position:fixed` FAB의 컨테이닝 블록이 됨 | FAB(및 스티키 크롬)를 `BottomTabs`처럼 애니메이션 영역 **밖**에서 렌더(§2e) | S | P1 |
| R2 | 작은 썸네일 미리보기 탭 밴드 겹침(잔여) | `TierCard.tsx:139-160` + `theme.css:743-747`: ~200px 미리보기에 44px `--tap` 바닥이 강제돼 kind/title 밴드가 겹쳐 "뒤 밴드가 이김" | 소형 미리보기에선 탭 바닥 해제(밴드 비율화) 또는 kind/title을 미리보기 하단 컨트롤 행으로 분리(§2e) | S | P1 |

## 2. 지금 실행할 설계

### (a) S1 — "만드는 중"이 절대 멈추지 않게 (`CreateEvent.tsx`, `usePublish.ts`, `Layout.tsx`)
- **하드캡**: `OpProgress`의 `OP_TIMEOUT_SECONDS`를 30→**45**로 올려(페이마스터/번들러 정상 지연 흡수) 45s에 진행 표시를 **결정 블록**으로 교체.
- **결정 블록**(create 한정): `다시 시도`(=`create` 재호출 — `submittedOpHash` 재확인이라 두 번째 `createEvent`는 절대 안 나감, `usePublish.ts:422-444`) + **`나중에 확인`**(→ `/org`로 이동, 초안·`submittedOpHash`는 `usePublish.ts:501`에서 이미 보존).
- **중복 제거**: `CreateEvent.tsx:492-496`의 info-alert + OpProgress 이중 노출을 하나로. 타임아웃 상태에선 "만드는 중" 문구를 지우고 결정 블록만.
- **홈 배경 배너 + 복귀 해소**: `OrganizerHome`(`Layout.tsx`)에서 초안에 `submittedOpHash`가 있으면 배경 "확인 중" 배너를 띄우고 `resolveSubmittedOp`(`shared/chain/ops.ts:30`)를 폴링 — 확정되면 done 화면으로, 되돌려지면 다시 시도 링크. 생성 씬이 약속한 "잠시 뒤 주최자 화면에서 확인"을 실제로 이행.

### (b) S2 — 콜드 로그인 자동 재시도 (`Login.tsx`)
- `run()`의 `api.loginChallenge`/`api.loginVerify` 호출을 **일시장애 전용 재시도**(2회·1.5s 백오프)로 감싼다. 종착 실패(`UNAVAILABLE_REASONS`, `CHALLENGE_USED`, `cancelled`, `noPasskey`)는 재시도하지 않음 — 콜드스타트/네트워크(`internal`·`deadline`·`network`)만 재시도. 챌린지는 매 시도 새로 발급되므로 멱등.
- 재시도 중엔 기존 `login.working` 유지, 최종 실패에만 `login.failed` + **다시 시도 버튼**(`common.retry`).

### (c) S3 — 발행 확정형 진행 + 자동 폴링 (`Dashboard.tsx`, `organizer/lifecycle.ts`)
- `run('publish')`가 `confirming`이면 alert 대신 **`OpProgress`(45s캡)**. 확정 전까지 인덱서/체인을 자동 폴링해 `Published`가 되면 `life.published`로 전환 — 수동 새로고침 제거. `organizer/copy.ts:75,259`의 "다시 열어/새로고침" 문구를 폴링형으로 교체.

### (d) S4a·S4b — 재개 결정 선(先)처리 + 포스터 톱레이어
- **재개(S4a)**: `useEventDraft`에서 로컬 미러(`opened`)가 있으면 `resumed`를 **동기**로 표시해 첫 페인트에 시트가 뜨게. 미러 없이 네트워크만 있는 경우엔 `loading` 동안 씬 입력을 스켈레톤/`inert`로 잠그고, `listEventDrafts` 응답 후 재개 시트 또는 빈 씬을 결정 → 타이핑 도중 시트가 덮치는 일 없음. `ResumeSheet`는 결정 전 입력을 막는 블로킹 결정.
- **포스터(S4b)**: `PosterModal.tsx:73`을 `ref`+`useEffect`의 `showModal()`로. 톱레이어라 z-index/transform과 무관하게 스티키바 위 전체화면 + `::backdrop`이 뒤 클릭 차단 → 확인 탭 빗나감 해소.

### (e) S4c·S5·잔여 — 크롬은 애니메이션 밖, 세션은 단일 출처
- **크롬 분리(S4c·R1)**: `position:fixed` FAB·스티키바가 `.route-view` transform에 갇혀 슬라이드에 밀리고 스태킹이 국소화됨. `router.tsx`에서 이 크롬을 `BottomTabs`처럼 `.route-view` **밖**에서 렌더. 임시 대안은 스티키바 z-index 상향 + 여백 보장.
- **FAB 세션 게이트(S5)**: `useOrganizerEntry.ts`에서 `session.status==='loading'`을 `isLoading:true`로 별도 처리(로그인으로 보내지 않음). `Discover.tsx:164`·`Layout.tsx:151` FAB는 `status!=='loading'`까지 비활성/스켈레톤. 세션 단일 출처는 `useSession`.
- **탭 밴드(R2)**: `theme.css:746` `.tier-preview__tap`의 `min-height:var(--tap)`를 소형 미리보기에서 해제하고 밴드를 비율로 나누거나, kind/title을 미리보기 하단 라벨 컨트롤로 옮겨 겹침 제거.

## 3. 신규/수정 카피 (한국어)
- `scene.publish.checkLater` = `'나중에 확인'`
- `scene.publish.stuck` = `'아직 확인 중이에요. 다시 시도하거나 나중에 주최자 화면에서 확인할 수 있어요'`
- `home.pendingCreate` = `'만들던 행사를 확인하고 있어요'`
- `home.pendingCreateFailed` = `'행사를 만들지 못했어요. 다시 시도해 주세요'` · `home.pendingCreateOpen` = `'이어서 확인'`
- `lifecycle.confirming` 재작성 = `'발행을 확인하고 있어요. 곧 이 화면에 반영돼요'` (기존 "다시 열어/새로고침" 삭제)
- S2 로그인·S4/S5는 신규 카피 없음(`login.failed`·`common.retry`·`op.timeout` 재사용)

## 4. 백엔드 비용 권고 — `minInstances:1` (Cloud Run 2세대, us-east1, `config.ts:7` FIREBASE_REGION 확정)
- **단가**(Tier1 us-east1, 상시 워밍 1인스턴스, 730h/월 ≈ 2,628,000s): CPU idle ≈ $0.0000025/vCPU-s, 메모리 ≈ $0.0000025/GiB-s.
  - 256MiB·1vCPU: CPU $6.6 + 메모리 $1.6 ≈ **$8/월/함수** · 512MiB: 메모리 $3.3 ≈ **$10/월/함수**.
- **범위**: 콜드 로그인은 별도 Cloud Run 서비스인 `loginChallenge`+`loginVerify` 두 개. 둘 다 워밍 필요 = **~$16/월(256MiB)**. `getSignupStatus`까지 = 3개 ≈ ~$24/월.
- **권고(최소 비용)**: ①먼저 **클라 자동 재시도(§2b, 무료)**로 대부분의 콜드 실패를 흡수(콜드 ~3s를 1.5s 백오프 재시도가 성공으로 전환). ②그래도 즉시성이 필요하면 **`loginChallenge`+`loginVerify`만 `minInstances:1`, 256MiB(≈$16/월)**. `getSignupStatus`는 가입 흐름이 이미 폴링·재시도하므로 min 0 유지(워밍 이득 낮음). 시연/런칭 직전에만 켜고 이후 되돌릴 수 있는 가역 설정.

## 5. 작업 목록 (순서)
- **R2-1 (web)**: S1 생성 무정지 UI. `CreateEvent.tsx:492-496`+`usePublish.ts`: 45s 캡 후 다시 시도/나중에 확인 결정 블록, 이중 표시 제거. 초안·opHash는 이미 보존됨.
- **R2-2 (web)**: S1 홈 "확인 중" 배너 + 복귀 해소. `Layout.tsx` OrganizerHome이 초안 `submittedOpHash`를 `resolveSubmittedOp`(`ops.ts:30`)로 폴링해 확정→done/실패→재시도.
- **R2-3 (web)**: S2 로그인 클라 자동 재시도. `Login.tsx:52-66` 일시장애 전용 2회·1.5s 재시도 + 다시 시도 버튼. 종착 실패는 재시도 안 함.
- **R2-4 (backend)**: S2 워밍. `login.ts`의 `loginChallenge`·`loginVerify`를 `onCall({minInstances:1,memory:'256MiB'}, …)`. §4 근거로 R2-3 배포 후 적용.
- **R2-5 (web)**: S3 발행 확정형 + 자동 폴링. `Dashboard.tsx:172`/`lifecycle.ts`: OpProgress(45s캡) + Published까지 인덱서 폴링, 새로고침 문구 삭제.
- **R2-6 (web)**: S4a 재개 선처리. `useEventDraft.ts:291,464` 로컬 미러는 동기 표시, 네트워크 대기엔 입력 잠금 스켈레톤; `ResumeSheet`는 결정 전 블로킹.
- **R2-7 (web)**: S4b 포스터 톱레이어. `PosterModal.tsx:73` `<dialog open>`→`showModal()`.
- **R2-8 (web)**: S4c 스티키바 최상단. `StickyBar`/`theme.css:614` z-index·여백 보장(또는 R2-10과 함께 크롬 분리).
- **R2-9 (web)**: S5 FAB 세션 게이트. `useOrganizerEntry.ts:59` loading 분리, `Discover.tsx:164`·`Layout.tsx:151` FAB 로딩 중 비활성/스켈레톤.
- **R2-10 (web)**: 잔여 R1 크롬 분리. `router.tsx:34-43` `.route-view` 밖에서 FAB/스티키 렌더(탭바와 동일 패턴).
- **R2-11 (web)**: 잔여 R2 탭 밴드. `TierCard.tsx:139-160`+`theme.css:746` 소형 미리보기 탭 바닥 해제/밴드 비율화.

## 6. P0 목록
- **P0-1** S1 생성 무정지: 45s 캡 → 다시 시도/나중에 확인(초안·opHash 보존) + 홈 "확인 중" 배너 복귀 해소 (R2-1·R2-2)
- **P0-2** S2 로그인 콜드 자동 재시도(2회·1.5s, 일시장애만) + 다시 시도 버튼 (R2-3)
- **P0-3** S3 발행 확정형 진행 + 인덱서 자동 폴링, 수동 새로고침 제거 (R2-5)
