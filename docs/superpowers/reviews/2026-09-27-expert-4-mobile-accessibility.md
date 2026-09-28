# UX 전문가 4 — 모바일 인터랙션 & 접근성 리뷰 (2026-09-27)

대상: MONTI-web `mvp-web` ca9c8d7 · 기준선 "중학생도 혼자 끝까지"
방법: `theme.css`·`shared/ui/**`·scene/attendee 코드 정독 + 프로덕션 `monti.despell.io` 를
Playwright 헤드리스 360/390/430px 실측(탐색·로그인, 공개 화면).

## 총평
토대는 견고하다. `--tap:44` `--t-input:16`(iOS 줌 차단) `100dvh` 폴백, safe-area 패딩,
`scroll-padding/margin`(키보드 회피), `overflow-x:hidden` 가로 스크롤 차단, reduced-motion
전역 킬스위치 + framer `reducedMotion="user"`, `:focus-visible` 링 — 대부분 이미 맞다.
실측 결과 **가로 오버플로 0, 입력 폰트 전부 16px** 로 확인됐다. 남은 문제는 (1) 홈 카드 탭
타깃, (2) 다이얼로그 최상위 레이어 일관성, (3) 시트 스크롤·비모달, (4) 캐러셀 스크롤=선택,
(5) aria-live 소음 다섯 축에 몰려 있다.

## 결함 표
| # | 심각 | 화면 | 문제 | 측정 | 고칠 것 | 위치 |
|---|---|---|---|---|---|---|
| D1 | S1 | 탐색(홈) | 카드에서 **제목 `<a>`(167×20px)만 탭 가능**, 아트·본문은 죽은 영역. 앱 1차 동선이 20px 링크 | 360/390/430 모두 h=20px (실측) | 카드 전체를 `Link`로 감싸거나 제목 링크를 블록화해 min-height 44 확보 | attendee/discover/Discover.tsx:120-135; theme.css:866-878 |
| D2 | S1 | 내 정보·계정삭제 | 삭제 확인이 `<dialog open>`(**비모달**) — 최상위 레이어 아님·포커스 트랩/`::backdrop` 없음·기본 테두리 박스로 렌더 | 코드 | `showModal()`(PosterModal 패턴) 또는 Sheet 로 전환 | attendee/me/Profile.tsx:187 |
| D3 | S2 | 모든 시트 | `.sheet{max-height:none}` + overflow 없음 → 콘텐츠가 길거나(로케일·큰 글자) 세로가 짧으면 **상단(제목·닫기)이 뷰포트 위로 잘려 도달 불가** | 발행요약=제목+5행+문단+버튼2 | `.sheet__body{max-height:calc(100dvh - var(--sat) - var(--s-5));overflow-y:auto;overscroll-behavior:contain}` | theme.css:654-673; Dashboard.tsx:238 |
| D4 | S2 | 대기(OpProgress) | 경과초 `<p>`가 `role="status" aria-live="polite"` 안에서 **매초 갱신 → 스크린리더가 매초 재낭독** | 코드 | 라이브 영역엔 단계/지연/타임아웃 문장만, 경과초는 `aria-hidden` | shared/ui/OpProgress.tsx:83-101 |
| D5 | S2 | 티켓아트 캐러셀 | **가로 스크롤 정지=선택**(IO가 `onPreset` 호출) → 훑어보려던 사용자가 아트 변경·초안 dirty. 단일선택인데 `radiogroup` 아님 | 코드 | 스냅 시 dot만 갱신·선택은 탭/화살표로만; `role=radiogroup`/`radio` | organizer/ArtPicker.tsx:141-170,176-201 |
| D6 | S2 | 종류 카드 | 가격 배지 `min-height:32px`, 편집 버튼 `height:36px` 등 **탭 타깃 < 44px** | 32/36px | 44px 확보(히트영역 확장 가능) | theme.css:761-767, 738 |
| D7 | S3 | Resume/발행 시트 | 시트 비모달·스크림 없음 → 결정 중 **뒤 화면이 계속 탭·포커스 가능**(타이핑 컨텍스트 아닌 시트) | 코드 | 타이핑 시트가 아니면 배경 `inert`+옅은 스크림 | Sheet.tsx:50-60; theme.css:654 |
| D8 | S3 | 전역 | 타입 스케일이 **전부 px(rem 아님)** + `text-size-adjust` 없음 → 브라우저 글꼴 크기·텍스트 전용 확대 미반영(WCAG 1.4.4). 페이지 줌은 정상 | theme.css:74-88 | type 토큰 rem 화 | theme.css:74-88 |
| D9 | S3 | 입력 필드 | 포커스 링이 반투명 `--brand-ring`(0.38)+`--brand` 보더 — 연보라 배경 위 대비 <3:1 우려(2.4.11) | 코드 | 링 색을 `--brand-ink`로 | theme.css:322-326 |
| D10 | S3 | 크롭 프레임 | `touch-action:none` 프레임이 세로 스크롤 폼(인라인 크로퍼) 안 → 프레임 위에선 페이지 스크롤 불가(문맥상 허용되나 큰 프레임 주의) | 코드 | 인라인 크로퍼 높이 캡·핸들 안내 | theme.css:564-568; A4Cropper.tsx |

## 모션 권고 (Toss 느낌·산만하지 않게)
**유지(그대로 좋음):** 프레스 `scale .97` snappy(520/38, 즉각) · 탭 인디케이터 `layoutId`
snappy · 라우트 전환 **240ms** ease(<300) · CSS 트랜지션 전부 **140ms(--fast)** · 시트 상승
gentle(260/30)+드래그 해제 · 성공 오버슈트 bouncy(420/22, 1회) · reduced-motion 킬스위치.
300ms 넘는 트랜지션은 없음 — 전반적으로 이미 절제돼 있다.
**다듬기(trim):**
- `LIST_STAGGER` `staggerChildren:0.03`+`delayChildren:0.02` → 10+ 리스트에서 마지막 행이
  ~300ms+ 뒤 등장해 새로고침/복귀가 늘어져 보임. **앞 6행만 스태거하거나 0.02로** (motion.tsx:68-71).
- `step-pulse` `scale(1.6)` @1.2s 무한 → 등록 화면에서 60% 확대 맥동이 과함. **scale~1.25 또는
  opacity-only** (theme.css:556-560).
- 스켈레톤 sweep 1.4s / pulse 1.3s 두 주기 혼재 → 하나로 통일(가벼운 정리).

## 상위 10개 변경 (영향순)
1. **D1** 탐색 카드 전체를 탭 타깃으로 — 홈 1차 동선의 20px 링크 제거.
2. **D2** 계정 삭제 확인을 `showModal()`/Sheet 로 — 파괴적 액션에 최상위 레이어·포커스 트랩.
3. **D3** 시트에 `max-height`+`overflow-y:auto` — 긴/확대 콘텐츠의 상단 잘림 방지.
4. **D5** 캐러셀 "스크롤=선택" 제거, 선택은 탭/화살표로 — 의도치 않은 아트 변경 차단.
5. **D4** OpProgress 경과초를 aria-live 밖으로 — 매초 재낭독 소음 제거.
6. **D6** 32/36px 탭 타깃을 44px 로 — 배지·편집 버튼 오탭 감소.
7. **D7** 결정 시트 배경 `inert`+스크림 — 뒤 화면 오탭/포커스 이탈 차단.
8. **D8** 타입 토큰 rem 화 — 브라우저 글자 확대(저시력) 존중.
9. **모션** `LIST_STAGGER` 캡 + `step-pulse` 완화 — 긴 리스트·등록 화면 체감속도 개선.
10. **D9** 필드 포커스 링을 `--brand-ink` 로 — 키보드 포커스 가시성 3:1 확보.
